/* Fightzone Paywall (overlay on top of stream)
   - works with either window.supabaseClient OR window.supabase (fallback)
   - checks access via RPC: has_access(p_event_id)
   - purchase flow:
       button -> POST WORKER /api/checkout with Authorization Bearer (supabase access token)
       worker -> creates Stripe Checkout Session with metadata { user_id, plan, event_id }
       browser -> redirect to Stripe session url
*/

(function () {
  const WORKER_BASE = "https://fightzone2.godzilammd.workers.dev";
  const CHECKOUT_ENDPOINT = `${WORKER_BASE}/api/checkout`;

  let _container = null;
  let _overlayEl = null;
  let _currentEventId = null;
  let _authUnsub = null;
  let _isBuying = false;

  function ensureOverlay(containerEl) {
    const st = getComputedStyle(containerEl);
    if (st.position === "static") containerEl.style.position = "relative";

    let el = containerEl.querySelector(".fz-paywall");
    if (el) return el;

    el = document.createElement("div");
    el.className = "fz-paywall";
    el.innerHTML = `
      <div class="fz-paywall__card" role="dialog" aria-modal="true">
        <h3 class="fz-paywall__title">Access required</h3>
        <p class="fz-paywall__text">
          In order to view this event you have to have <b>One time</b>, <b>Pass</b> or <b>Elite Pass</b>.
        </p>
        <div class="fz-paywall__actions">
          <button class="fz-paywall__btn fz-paywall__btn--primary" type="button" data-fz-purchase="one_time">
            Purchase access
          </button>
        </div>
        <p class="fz-paywall__hint" data-fz-hint style="margin:10px 0 0; opacity:.8; font-size:12px; display:none;">
          Redirecting to checkout…
        </p>
      </div>
    `;

    el.querySelector("[data-fz-purchase]")?.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await startCheckout("one_time", _currentEventId);
    });

    containerEl.appendChild(el);
    return el;
  }

  function getSb() {
    // ✅ fallback: some projects use window.supabase instead of window.supabaseClient
    const sb = window.supabaseClient || window.supabase;
    if (!sb) {
      console.warn("[paywall] Supabase client not found. Expected window.supabaseClient OR window.supabase");
    }
    return sb;
  }

  async function getAccessToken() {
    const sb = getSb();
    if (!sb) return null;

    try {
      const { data, error } = await sb.auth.getSession();
      if (error) {
        console.warn("[paywall] getSession error:", error);
        return null;
      }
      return data?.session?.access_token || null;
    } catch (e) {
      console.warn("[paywall] getSession threw:", e);
      return null;
    }
  }

  async function isLoggedIn() {
    const sb = getSb();
    if (!sb) return false;

    try {
      const { data, error } = await sb.auth.getUser();
      if (error) return false;
      return !!data?.user;
    } catch {
      return false;
    }
  }

  async function checkAccess(eventId) {
    const sb = getSb();
    if (!sb) return false;

    const ok = await isLoggedIn();
    if (!ok) return false;

    const { data, error } = await sb.rpc("has_access", { p_event_id: eventId });
    if (error) {
      console.warn("[paywall] has_access error:", error);
      return false;
    }
    return !!data;
  }

  async function refresh() {
    if (!_overlayEl || !_currentEventId) return;
    const allowed = await checkAccess(_currentEventId);
    _overlayEl.classList.toggle("is-visible", !allowed);
  }

  async function pollAfterReturnIfNeeded() {
    const url = new URL(window.location.href);
    const paid = url.searchParams.get("paid");
    if (paid !== "1") return;

    for (let i = 0; i < 12; i++) {
      await refresh();
      const visible = _overlayEl?.classList.contains("is-visible");
      if (!visible) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    url.searchParams.delete("paid");
    window.history.replaceState({}, "", url.toString());
  }

  async function startCheckout(plan, eventIdMaybe) {
    if (_isBuying) return;
    _isBuying = true;

    try {
      const planNorm = String(plan || "").trim();
      if (!planNorm) {
        alert("No plan");
        return;
      }

      const eventId = String(eventIdMaybe || "").trim();
      if (planNorm === "one_time" && !eventId) {
        alert("Открой событие (стрим) и покупай one-time доступ там.");
        return;
      }

      const token = await getAccessToken();
      if (!token) {
        // ✅ более понятная диагностика
        const sbExists = !!(window.supabaseClient || window.supabase);
        console.warn("[paywall] Missing access token. sb exists:", sbExists);
        alert("Please login first (token not found). Try logout/login once.");
        return;
      }

      const hint = _overlayEl?.querySelector("[data-fz-hint]");
      const overlayBtn = _overlayEl?.querySelector("[data-fz-purchase]");
      if (hint) hint.style.display = "block";
      if (overlayBtn && planNorm === "one_time") overlayBtn.disabled = true;

      const baseUrl = window.location.href.split("#")[0];
      const returnTo = baseUrl + "#vip";

      const body = {
        plan: planNorm,
        return_to: returnTo,
      };

      if (planNorm === "one_time") body.event_id = eventId;

      const res = await fetch(CHECKOUT_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn("[paywall] checkout error:", data);
        alert(data?.error || "Checkout error");
        return;
      }

      if (!data?.url) {
        alert("No checkout URL returned");
        return;
      }

      window.location.href = data.url;
    } catch (e) {
      console.warn("[paywall] startCheckout failed:", e);
      alert(String(e?.message || e));
    } finally {
      const hint = _overlayEl?.querySelector("[data-fz-hint]");
      const overlayBtn = _overlayEl?.querySelector("[data-fz-purchase]");
      if (hint) hint.style.display = "none";
      if (overlayBtn) overlayBtn.disabled = false;
      _isBuying = false;
    }
  }

  function bindVipButtons() {
    const vipPage = document.getElementById("page-vip");
    if (!vipPage) return;

    vipPage.addEventListener(
      "click",
      async (e) => {
        const btn = e.target?.closest?.(".vip-btn[data-plan]");
        if (!btn) return;

        e.preventDefault();
        e.stopPropagation();

        const plan = btn.getAttribute("data-plan");

        if (plan === "one_time") {
          await startCheckout("one_time", _currentEventId);
          return;
        }

        if (plan === "pass" || plan === "elite") {
          await startCheckout(plan);
          return;
        }

        alert("Unknown plan: " + plan);
      },
      true
    );
  }

  function initPaywall(options = {}) {
    _container =
      document.querySelector(options.containerSelector || ".stream-player-box") ||
      document.querySelector(".stream-player-box");

    if (!_container) {
      console.warn("[paywall] container not found:", options.containerSelector);
      return;
    }

    _overlayEl = ensureOverlay(_container);
    _overlayEl.classList.remove("is-visible");

    const sb = getSb();
    if (sb && !_authUnsub) {
      const { data } = sb.auth.onAuthStateChange(() => {
        refresh();
      });
      _authUnsub = data?.subscription || true;
    }

    bindVipButtons();
  }

  async function showForEvent(eventId) {
    _currentEventId = (eventId || "").trim();
    if (!_currentEventId) {
      console.warn("[paywall] showForEvent called without eventId");
      return;
    }

    if (!_overlayEl) {
      initPaywall({ containerSelector: ".stream-player-box" });
    }

    await refresh();
    await pollAfterReturnIfNeeded();
  }

  window.FZPaywall = {
    initPaywall,
    showForEvent,
    startCheckout,
  };
})();
