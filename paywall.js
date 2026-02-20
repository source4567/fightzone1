/* Fightzone Paywall (overlay on top of stream)
   - uses Supabase session access_token to call Worker /api/checkout
   - robust against "logged in but token not found" by retrying + refreshSession()

   Requires:
   - auth.js exposes window.supabaseClient or window.sb
   - RPC: has_access(p_event_id)

   Worker:
   - https://fightzone2.godzilammd.workers.dev/api/checkout
*/

(function () {
  const WORKER_BASE = "https://fightzone2.godzilammd.workers.dev";
  const CHECKOUT_ENDPOINT = `${WORKER_BASE}/api/checkout`;

  let _container = null;
  let _overlayEl = null;
  let _currentEventId = null;
  let _authUnsub = null;
  let _isBuying = false;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function getSb() {
    // robust: support both exports
    const sb = window.supabaseClient || window.sb || window.supabase;
    if (!sb || !sb.auth) {
      console.warn("[paywall] Supabase client not ready. Expected window.supabaseClient or window.sb");
      return null;
    }
    return sb;
  }

  async function getAccessToken() {
    const sb = getSb();
    if (!sb) return null;

    try {
      // 1) normal read
      let { data, error } = await sb.auth.getSession();
      if (error) console.warn("[paywall] getSession error:", error);
      let token = data?.session?.access_token || null;
      if (token) return token;

      // 2) sometimes session is not restored yet right after page load
      await sleep(150);
      ({ data, error } = await sb.auth.getSession());
      if (error) console.warn("[paywall] getSession retry error:", error);
      token = data?.session?.access_token || null;
      if (token) return token;

      // 3) if user exists but session null -> refresh
      const u = await sb.auth.getUser();
      const user = u?.data?.user || null;
      if (!user) return null;

      if (typeof sb.auth.refreshSession === "function") {
        const rr = await sb.auth.refreshSession();
        if (rr?.error) console.warn("[paywall] refreshSession error:", rr.error);
      }

      ({ data, error } = await sb.auth.getSession());
      if (error) console.warn("[paywall] getSession after refresh error:", error);
      return data?.session?.access_token || null;
    } catch (e) {
      console.warn("[paywall] getAccessToken threw:", e);
      return null;
    }
  }

  async function checkAccess(eventId) {
    const sb = getSb();
    if (!sb) return false;

    const { data: authData } = await sb.auth.getUser();
    if (!authData?.user) return false;

    const { data, error } = await sb.rpc("has_access", { p_event_id: eventId });
    if (error) {
      console.warn("[paywall] has_access error:", error);
      return false;
    }
    return !!data;
  }

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

  async function refresh() {
    if (!_overlayEl || !_currentEventId) return;
    const allowed = await checkAccess(_currentEventId);
    _overlayEl.classList.toggle("is-visible", !allowed);
  }

  async function pollAfterReturnIfNeeded() {
    const url = new URL(window.location.href);
    const paid = url.searchParams.get("paid");
    if (paid !== "1") return;

    // allow webhook time to write
    for (let i = 0; i < 12; i++) {
      await refresh();
      const visible = _overlayEl?.classList.contains("is-visible");
      if (!visible) break;
      await sleep(1000);
    }

    url.searchParams.delete("paid");
    window.history.replaceState({}, "", url.toString());
  }

  async function startCheckout(plan, eventIdMaybe) {
    if (_isBuying) return;
    _isBuying = true;

    const hint = _overlayEl?.querySelector("[data-fz-hint]");
    const overlayBtn = _overlayEl?.querySelector("[data-fz-purchase]");

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

      if (hint) hint.style.display = "block";
      if (overlayBtn && planNorm === "one_time") overlayBtn.disabled = true;

      const token = await getAccessToken();
      if (!token) {
        alert("Please login first (token not found). Try logout/login once.");
        return;
      }

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
      if (!res.ok || !data?.url) {
        console.warn("[paywall] checkout error:", data);
        alert(data?.error || "Checkout error");
        return;
      }

      window.location.href = data.url;
    } catch (e) {
      console.warn("[paywall] startCheckout failed:", e);
      alert(String(e?.message || e));
    } finally {
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
    _overlayEl.classList.remove("is-visible"); // hidden until we know eventId

    const sb = getSb();
    if (sb && !_authUnsub) {
      const { data } = sb.auth.onAuthStateChange(() => {
        refresh();
      });
      _authUnsub = data?.subscription || true;
    }

    bindVipButtons();

    // if user returned from Stripe, attempt refresh
    pollAfterReturnIfNeeded();
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
