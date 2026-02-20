/* Fightzone Paywall (overlay on top of stream)
   - requires window.supabaseClient (from auth.js)
   - checks access via RPC: has_access(p_event_id)
   - purchase flow (CORRECT):
       button -> POST WORKER /api/checkout with Authorization Bearer (supabase access token)
       worker -> creates Stripe Checkout Session with metadata { user_id, plan, event_id }
       browser -> redirect to Stripe session url
*/

(function () {
  // твой домен воркера
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
    const sb = window.supabaseClient;
    if (!sb) console.warn("[paywall] window.supabaseClient not found (auth.js not loaded yet?)");
    return sb;
  }

  async function getAccessToken() {
    const sb = getSb();
    if (!sb) return null;

    const { data, error } = await sb.auth.getSession();
    if (error) {
      console.warn("[paywall] getSession error:", error);
      return null;
    }
    return data?.session?.access_token || null;
  }

  async function checkAccess(eventId) {
    const sb = getSb();
    if (!sb) return false;

    // if not logged in -> no access
    const { data: auth } = await sb.auth.getUser();
    if (!auth?.user) return false;

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
    // если вернулись после оплаты (worker добавляет paid=1)
    const url = new URL(window.location.href);
    const paid = url.searchParams.get("paid");
    if (paid !== "1") return;

    // пробуем несколько раз, потому что вебхук может записать не мгновенно
    for (let i = 0; i < 12; i++) {
      await refresh();
      const visible = _overlayEl?.classList.contains("is-visible");
      if (!visible) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    // убрать paid=1 из URL
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

      // one_time требует event_id
      const eventId = String(eventIdMaybe || "").trim();
      if (planNorm === "one_time" && !eventId) {
        alert("Открой событие (стрим) и покупай one-time доступ там.");
        return;
      }

      const token = await getAccessToken();
      if (!token) {
        alert("Please login first.");
        return;
      }

      // UI hint если это overlay покупка
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

      if (planNorm === "one_time") {
        body.event_id = eventId;
      }

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

      // редирект на Stripe Checkout
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
    // VIP page buttons: require data-plan="pass|elite|one_time"
    const vipPage = document.getElementById("page-vip");
    if (!vipPage) return;

    vipPage.addEventListener("click", async (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(".vip-btn[data-plan]") : null;
      if (!btn) return;

      e.preventDefault();
      e.stopPropagation();

      const plan = btn.getAttribute("data-plan");

      // one_time from VIP page needs event opened
      if (plan === "one_time") {
        await startCheckout("one_time", _currentEventId);
        return;
      }

      if (plan === "pass" || plan === "elite") {
        await startCheckout(plan);
        return;
      }

      alert("Unknown plan: " + plan);
    }, true);
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

    // update paywall on auth changes
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
    startCheckout, // optional, if you want to call manually
  };
})();
