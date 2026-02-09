/* auth.js — Fightzone Supabase Auth + Discord + Password Reset
   Works with your current index.html structure (auth modal + cards + btnRecover).
*/

(() => {
  // ================================
  // 1) SUPABASE CONFIG — PUT YOUR KEYS HERE
  // ================================
  const SUPABASE_URL = "https://ghvcxourgfbjdtzxqkox.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdodmN4b3VyZ2ZiamR0enhxa294Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA1NTIxMDMsImV4cCI6MjA4NjEyODEwM30.V1xKeI68xXRAEjfhMobNQH_1KQOzh1vLojSw6LnmsAc";

  if (!SUPABASE_URL || SUPABASE_URL.includes("PASTE_") || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes("PASTE_")) {
    console.warn("[Auth] Supabase keys are not set in auth.js");
  }

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ================================
  // 2) DOM HELPERS
  // ================================
  const $ = (sel) => document.querySelector(sel);

  const modal = $("#authModal");
  const loginCard = $("#authLoginCard");
  const registerCard = $("#authRegisterCard");

  const btnLogin = $("#btnLogin");
  const btnRegister = $("#btnRegister");

  const btnBackToLogin = $("#btnBackToLogin");
  const btnRecover = $("#btnRecover");

  const btnLoginDiscord = $("#btnLoginDiscord");
  const btnRegisterDiscord = $("#btnRegisterDiscord");

  const loginForm = $("#loginForm");
  const registerForm = $("#registerForm");

  function openModal(show = "login") {
    if (!modal) return;
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("is-open");
    document.body.style.overflow = "hidden";
    showAuthCard(show);
  }

  function closeModal() {
    if (!modal) return;
    modal.setAttribute("aria-hidden", "true");
    modal.classList.remove("is-open");
    document.body.style.overflow = "";
  }

  function showAuthCard(which) {
    if (loginCard) loginCard.hidden = (which !== "login");
    if (registerCard) registerCard.hidden = (which !== "register");

    // hide recovery card if exists
    const recoveryCard = $("#authRecoveryCard");
    if (recoveryCard) recoveryCard.hidden = (which !== "recovery");

    // hide set-new-password card if exists
    const newPassCard = $("#authNewPassCard");
    if (newPassCard) newPassCard.hidden = (which !== "newpass");
  }

  function safeAlert(msg) {
    alert(String(msg || "Something went wrong"));
  }

  // ================================
  // 3) BUILD UI FOR RECOVERY + NEW PASSWORD (injected)
  // ================================
  function ensureRecoveryCards() {
    const dialog = modal?.querySelector(".auth-modal__dialog");
    if (!dialog) return;

    // A) "Send reset link" card
    if (!$("#authRecoveryCard")) {
      const card = document.createElement("div");
      card.className = "auth-card";
      card.id = "authRecoveryCard";
      card.hidden = true;

      card.innerHTML = `
        <div class="auth-card__head">
          <h2 class="auth-card__title">Reset password</h2>
          <div class="auth-card__sub">We will email you a reset link</div>
        </div>

        <div class="auth-card__body">
          <form id="recoveryForm" autocomplete="on">
            <div class="auth-field">
              <label class="auth-label" for="recoveryEmail">Email</label>
              <div class="auth-input">
                <span class="auth-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M4 6.5h16v11H4v-11Z" stroke="currentColor" stroke-width="2" />
                    <path d="M4 7l8 6 8-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </span>
                <input id="recoveryEmail" type="email" placeholder="you@example.com" autocomplete="email" required />
              </div>
              <div style="margin-top:10px;font-size:12px;opacity:.75;">
                After you open the link from email, you’ll be asked to set a new password.
              </div>
            </div>

            <button class="auth-primary" type="submit">Send reset link</button>
          </form>

          <div class="auth-foot" style="margin-top:14px;">
            <a class="auth-link" href="#" id="btnRecoveryBack">Back to login</a>
          </div>
        </div>
      `;

      dialog.appendChild(card);
    }

    // B) "Set new password" card
    if (!$("#authNewPassCard")) {
      const card = document.createElement("div");
      card.className = "auth-card";
      card.id = "authNewPassCard";
      card.hidden = true;

      card.innerHTML = `
        <div class="auth-card__head">
          <h2 class="auth-card__title">Set new password</h2>
          <div class="auth-card__sub">Enter a new password for your account</div>
        </div>

        <div class="auth-card__body">
          <form id="newPassForm" autocomplete="on">
            <div class="auth-field">
              <label class="auth-label" for="newPass1">New password</label>
              <div class="auth-input">
                <span class="auth-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M7 10V8a5 5 0 0 1 10 0v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <path d="M6.5 10.5h11V20h-11v-9.5Z" stroke="currentColor" stroke-width="2"/>
                  </svg>
                </span>
                <input id="newPass1" type="password" placeholder="••••••••" autocomplete="new-password" required />
              </div>
            </div>

            <div class="auth-field">
              <label class="auth-label" for="newPass2">Repeat new password</label>
              <div class="auth-input">
                <span class="auth-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M7 10V8a5 5 0 0 1 10 0v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <path d="M6.5 10.5h11V20h-11v-9.5Z" stroke="currentColor" stroke-width="2"/>
                  </svg>
                </span>
                <input id="newPass2" type="password" placeholder="••••••••" autocomplete="new-password" required />
              </div>
              <div style="margin-top:10px;font-size:12px;opacity:.75;">
                Minimum 6 characters (Supabase default).
              </div>
            </div>

            <button class="auth-primary" type="submit">Update password</button>
          </form>

          <div class="auth-foot" style="margin-top:14px;">
            <a class="auth-link" href="#" id="btnNewPassBack">Back to login</a>
          </div>
        </div>
      `;

      dialog.appendChild(card);
    }
  }

  // ================================
  // 4) AUTH ACTIONS
  // ================================
  async function loginWithEmail(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  async function registerWithEmail(email, password, username) {
    // Username goes to user_metadata (optional)
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { username: username || "" }
      }
    });
    if (error) throw error;
  }

  async function loginWithDiscord() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "discord",
      options: {
        // for single-page: return to same page
        redirectTo: window.location.origin
      }
    });
    if (error) throw error;
  }

  async function sendResetLink(email) {
    // IMPORTANT: redirectTo must be allowed in Supabase Redirect URLs
    // We keep it same page, and Supabase will append #type=recovery... to URL
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin
    });
    if (error) throw error;
  }

  async function setNewPassword(pass1, pass2) {
    if (String(pass1 || "").length < 6) throw new Error("Password must be at least 6 characters.");
    if (pass1 !== pass2) throw new Error("Passwords do not match.");

    const { error } = await supabase.auth.updateUser({ password: pass1 });
    if (error) throw error;
  }

  // ================================
  // 5) RECOVERY FLOW HANDLING
  // ================================
  function urlHasRecoveryHash() {
    const h = String(window.location.hash || "");
    // Supabase reset link typically includes: #access_token=...&type=recovery...
    return h.includes("type=recovery") || h.includes("type=invite") || h.includes("type=magiclink");
  }

  async function handleIncomingRecoveryLink() {
    if (!urlHasRecoveryHash()) return;

    // Ensure cards exist and open modal in "new password" mode
    ensureRecoveryCards();
    openModal("newpass");

    // Supabase-js v2 generally picks up session from the hash automatically.
    // We "touch" session to be safe.
    const { data, error } = await supabase.auth.getSession();
    if (error) console.warn("[Auth] getSession error", error);

    // If session is missing, user can't update password
    if (!data?.session) {
      safeAlert("Reset link was not recognized. Please request a new reset email.");
      showAuthCard("recovery");
      return;
    }

    // Optional: clean hash (cosmetic)
    // (Keep it simple; if you want, we can replaceState to remove tokens)
  }

  // ================================
  // 6) WIRE UP UI EVENTS
  // ================================
  function bindModalClose() {
    if (!modal) return;
    modal.addEventListener("click", (e) => {
      const t = e.target;
      if (!t) return;
      if (t.matches("[data-auth-close]")) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });
  }

  function bindTopButtons() {
    if (btnLogin) btnLogin.addEventListener("click", () => openModal("login"));
    if (btnRegister) btnRegister.addEventListener("click", () => openModal("register"));
  }

  function bindLoginRegisterSwitch() {
    if (btnBackToLogin) {
      btnBackToLogin.addEventListener("click", (e) => {
        e.preventDefault();
        showAuthCard("login");
      });
    }
  }

  function bindEmailForms() {
    if (loginForm) {
      loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = ($("#loginEmail")?.value || "").trim();
        const pass = $("#loginPassword")?.value || "";
        try {
          await loginWithEmail(email, pass);
          closeModal();
        } catch (err) {
          safeAlert(err?.message || err);
        }
      });
    }

    if (registerForm) {
      registerForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const username = ($("#regUsername")?.value || "").trim();
        const email = ($("#regEmail")?.value || "").trim();
        const pass1 = $("#regPassword")?.value || "";
        const pass2 = $("#regPassword2")?.value || "";

        if (pass1 !== pass2) return safeAlert("Passwords do not match.");

        try {
          await registerWithEmail(email, pass1, username);
          safeAlert("Check your email to confirm registration (if enabled). Then login.");
          showAuthCard("login");
        } catch (err) {
          safeAlert(err?.message || err);
        }
      });
    }
  }

  function bindDiscordButtons() {
    if (btnLoginDiscord) {
      btnLoginDiscord.addEventListener("click", async () => {
        try {
          await loginWithDiscord();
        } catch (err) {
          safeAlert(err?.message || err);
        }
      });
    }

    if (btnRegisterDiscord) {
      btnRegisterDiscord.addEventListener("click", async () => {
        try {
          await loginWithDiscord();
        } catch (err) {
          safeAlert(err?.message || err);
        }
      });
    }
  }

  function bindRecoveryFlow() {
    ensureRecoveryCards();

    // Open "Send reset link" card when user clicks "Reset password"
    if (btnRecover) {
      btnRecover.addEventListener("click", (e) => {
        e.preventDefault();
        ensureRecoveryCards();
        showAuthCard("recovery");
        // prefill with login email if present
        const loginEmail = ($("#loginEmail")?.value || "").trim();
        const inp = $("#recoveryEmail");
        if (inp && loginEmail) inp.value = loginEmail;
      });
    }

    // Back links inside injected cards
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!t) return;

      if (t.id === "btnRecoveryBack" || t.id === "btnNewPassBack") {
        e.preventDefault();
        showAuthCard("login");
      }
    });

    // Recovery form submit -> send email
    document.addEventListener("submit", async (e) => {
      const form = e.target;
      if (!form) return;

      if (form.id === "recoveryForm") {
        e.preventDefault();
        const email = ($("#recoveryEmail")?.value || "").trim();
        if (!email) return safeAlert("Enter your email.");

        try {
          await sendResetLink(email);
          safeAlert("Reset link sent. Check your email (and Spam).");
          showAuthCard("login");
        } catch (err) {
          safeAlert(err?.message || err);
        }
      }

      if (form.id === "newPassForm") {
        e.preventDefault();
        const p1 = $("#newPass1")?.value || "";
        const p2 = $("#newPass2")?.value || "";

        try {
          await setNewPassword(p1, p2);
          safeAlert("Password updated. You can sign in now.");
          // After updating password, user might already be signed in.
          // We can keep them in, or sign out. We'll keep it simple:
          showAuthCard("login");
          // optional: clean hash so tokens aren't visible
          try { history.replaceState(null, "", window.location.pathname + window.location.search); } catch (_) {}
        } catch (err) {
          safeAlert(err?.message || err);
        }
      }
    });
  }

  // ================================
  // 7) INIT
  // ================================
  document.addEventListener("DOMContentLoaded", async () => {
    bindModalClose();
    bindTopButtons();
    bindLoginRegisterSwitch();
    bindEmailForms();
    bindDiscordButtons();
    bindRecoveryFlow();

    // If opened from reset email — show "set new password"
    await handleIncomingRecoveryLink();
  });
})();
