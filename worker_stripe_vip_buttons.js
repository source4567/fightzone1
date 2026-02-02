/**
 * Fightzone Stripe Access Worker (Payment Links + Subscriptions + Lifetime VIP)
 *
 * This Worker does 2 jobs:
 *  1) Receives Stripe webhooks and stores access in KV
 *  2) Lets the website verify a Checkout session_id and get current access
 *
 * REQUIRED (Cloudflare Worker secrets):
 *  - STRIPE_SECRET_KEY        (secret)  sk_live_...
 *  - STRIPE_WEBHOOK_SECRET    (secret)  whsec_...
 *
 * REQUIRED (KV binding):
 *  - ACCESS_KV (KV namespace)
 *
 * OPTIONAL (vars):
 *  - ALLOW_ORIGIN (e.g. "https://your-site.com")  -> for CORS
 *
 * Endpoints:
 *  - POST /api/webhook
 *  - GET  /api/verify?session_id=cs_test_... (or cs_live_...)
 *
 * Stored keys (KV):
 *  - session:{session_id} -> JSON { email, tier, expiresAt }  (expiresAt unix seconds or null for VIP)
 *  - email:{email}        -> JSON { tier, expiresAt }         (same)
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

// --------- helpers ---------
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "*";
  const allowOrigin = env?.ALLOW_ORIGIN || origin || "*";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type, stripe-signature",
    "access-control-max-age": "86400",
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function bad(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Very small tier inference for your current pricing:
// Basic  €5/month  -> 500 cents
// Premium €10/month -> 1000 cents
// VIP    €25 lifetime -> 2500 cents
function inferTierFromAmount(amountTotal, currency) {
  const amt = Number(amountTotal || 0);
  const cur = String(currency || "").toLowerCase();
  // Only map for EUR; otherwise fall back to unknown
  if (cur && cur !== "eur") return "basic"; // safe default: least privilege
  if (amt === 500) return "basic";
  if (amt === 1000) return "premium";
  if (amt === 2500) return "vip";
  // fallback: least privilege
  return "basic";
}

async function stripeRequest(env, path, opts = {}) {
  const url = "https://api.stripe.com/v1" + path;
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
    ...opts.headers,
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || `Stripe error (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// Verify Stripe webhook signature (HMAC SHA256) using Web Crypto
async function verifyStripeSignature(rawBody, sigHeader, webhookSecret) {
  if (!sigHeader) throw new Error("Missing Stripe-Signature header");
  const parts = sigHeader.split(",").map(s => s.trim());
  const tPart = parts.find(p => p.startsWith("t="));
  const v1Part = parts.find(p => p.startsWith("v1="));
  if (!tPart || !v1Part) throw new Error("Bad Stripe-Signature header");
  const timestamp = tPart.slice(2);
  const v1 = v1Part.slice(3);

  const signedPayload = `${timestamp}.${rawBody}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedPayload)
  );

  const hex = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, "0")).join("");

  // constant time compare
  if (hex.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

async function writeAccess(env, { sessionId, email, tier, expiresAt }) {
  const e = normalizeEmail(email);
  if (!e) return;

  const record = { tier, expiresAt: expiresAt ?? null };

  // Save by email (main lookup)
  await env.ACCESS_KV.put(`email:${e}`, JSON.stringify(record));

  // Save session mapping (for quick verify)
  if (sessionId) {
    await env.ACCESS_KV.put(
      `session:${sessionId}`,
      JSON.stringify({ email: e, ...record })
    );
  }
}

function isActiveRecord(rec) {
  if (!rec || !rec.tier) return false;
  if (rec.tier === "vip") return true;
  if (rec.expiresAt == null) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return Number(rec.expiresAt) > nowSec;
}

// --------- handlers ---------
async function handleWebhook(request, env) {
  const sig = request.headers.get("Stripe-Signature");
  const rawBody = await request.text();

  if (!env.STRIPE_WEBHOOK_SECRET) return bad("Missing STRIPE_WEBHOOK_SECRET", 500);

  const ok = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return bad("Invalid webhook signature", 400);

  let event;
  try { event = JSON.parse(rawBody); } catch { return bad("Invalid JSON", 400); }

  const type = event?.type || "";
  const obj = event?.data?.object || {};

  // 1) Checkout completed (works for Payment Links)
  if (type === "checkout.session.completed") {
    const sessionId = obj?.id;
    const email = obj?.customer_details?.email || obj?.customer_email;
    const mode = obj?.mode; // "subscription" or "payment"
    const amountTotal = obj?.amount_total;
    const currency = obj?.currency;

    let tier = inferTierFromAmount(amountTotal, currency);
    let expiresAt = null;

    // VIP = lifetime (mode: "payment" + amount 2500)
    if (tier === "vip") {
      expiresAt = null;
    } else if (mode === "subscription" && obj?.subscription) {
      // fetch subscription to get current_period_end
      try {
        const sub = await stripeRequest(env, `/subscriptions/${obj.subscription}`);
        if (sub?.status === "active" || sub?.status === "trialing") {
          expiresAt = sub?.current_period_end ?? null;
        } else {
          // not active -> no access
          expiresAt = 0;
        }
      } catch (e) {
        // If Stripe fetch fails, still store minimal access for a short time (10 minutes)
        // so user can watch while we fix; least surprise.
        expiresAt = Math.floor(Date.now() / 1000) + 600;
      }
    } else {
      // For safety: if we don't know, do not grant long access
      expiresAt = Math.floor(Date.now() / 1000) + 600;
    }

    await writeAccess(env, { sessionId, email, tier, expiresAt });
    return json({ ok: true });
  }

  // 2) Subscription updated/deleted/payment failed (keeps access in sync)
  if (
    type === "customer.subscription.created" ||
    type === "customer.subscription.updated" ||
    type === "customer.subscription.deleted"
  ) {
    const customer = obj?.customer;
    let email = null;

    // get customer email
    if (customer) {
      try {
        const cust = await stripeRequest(env, `/customers/${customer}`);
        email = cust?.email;
      } catch (e) {
        // ignore
      }
    }

    if (email) {
      // We don't know if it's Basic or Premium from subscription alone reliably without metadata.
      // We'll keep current tier if already stored; otherwise default to basic.
      const eKey = `email:${normalizeEmail(email)}`;
      const existing = await env.ACCESS_KV.get(eKey, { type: "json" });

      const tier = existing?.tier || "basic";
      const status = obj?.status;
      const expiresAt =
        (status === "active" || status === "trialing")
          ? (obj?.current_period_end ?? null)
          : 0;

      await writeAccess(env, { email, tier, expiresAt });
    }

    return json({ ok: true });
  }

  if (type === "invoice.payment_failed") {
    const customer = obj?.customer;
    let email = null;
    if (customer) {
      try {
        const cust = await stripeRequest(env, `/customers/${customer}`);
        email = cust?.email;
      } catch (e) {}
    }
    if (email) {
      const existing = await env.ACCESS_KV.get(`email:${normalizeEmail(email)}`, { type: "json" });
      const tier = existing?.tier || "basic";
      await writeAccess(env, { email, tier, expiresAt: 0 });
    }
    return json({ ok: true });
  }

  // ignore other events
  return json({ ok: true, ignored: true });
}

async function handleVerify(request, env, url) {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) return bad("Missing session_id");

  // Try KV first
  const cached = await env.ACCESS_KV.get(`session:${sessionId}`, { type: "json" });
  if (cached && isActiveRecord(cached)) {
    return json({ ok: true, active: true, tier: cached.tier, expiresAt: cached.expiresAt ?? null, email: cached.email });
  }

  // If not in KV, ask Stripe directly (lets user get instant access even if webhook delayed)
  try {
    const s = await stripeRequest(env, `/checkout/sessions/${sessionId}`);
    const email = s?.customer_details?.email || s?.customer_email;
    const mode = s?.mode;
    const amountTotal = s?.amount_total;
    const currency = s?.currency;

    let tier = inferTierFromAmount(amountTotal, currency);
    let expiresAt = null;

    if (tier === "vip") {
      expiresAt = null;
    } else if (mode === "subscription" && s?.subscription) {
      const sub = await stripeRequest(env, `/subscriptions/${s.subscription}`);
      const status = sub?.status;
      expiresAt = (status === "active" || status === "trialing") ? (sub?.current_period_end ?? null) : 0;

      // If we already stored "premium" for this email earlier, keep it
      const existing = email ? await env.ACCESS_KV.get(`email:${normalizeEmail(email)}`, { type: "json" }) : null;
      if (existing?.tier === "premium") tier = "premium";
    } else {
      expiresAt = Math.floor(Date.now() / 1000) + 600;
    }

    await writeAccess(env, { sessionId, email, tier, expiresAt });

    const active = (tier === "vip") || (expiresAt && Number(expiresAt) > Math.floor(Date.now() / 1000));
    return json({ ok: true, active, tier, expiresAt: expiresAt ?? null });
  } catch (e) {
    return json({ ok: true, active: false, error: String(e?.message || e) });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // OPTIONS
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request, env) });
    }

    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    try {
      if (url.pathname === "/api/webhook") {
        if (request.method !== "POST") return bad("Method not allowed", 405);
        const res = await handleWebhook(request, env);
        // no CORS needed for Stripe -> but harmless to add
        return new Response(await res.text(), {
          status: res.status,
          headers: { ...Object.fromEntries(res.headers), ...corsHeaders(request, env) },
        });
      }

      if (url.pathname === "/api/verify") {
        if (request.method !== "GET") return bad("Method not allowed", 405);
        const res = await handleVerify(request, env, url);
        return new Response(await res.text(), {
          status: res.status,
          headers: { ...Object.fromEntries(res.headers), ...corsHeaders(request, env) },
        });
      }

      return bad("Unknown endpoint", 404);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 500, corsHeaders(request, env));
    }
  },
};
