/* auth.js — Fightzone (Supabase Auth)
   Connects to existing UI in your index.html:
   - Header buttons: #btnLogin, #btnRegister
   - Modal: #authModal
   - Cards: #authLoginCard, #authRegisterCard
   - Forms: #loginForm, #registerForm
   - Inputs: #loginEmail, #loginPassword, #regEmail, #regPassword, #regPassword2, #regUsername
   - Switch link: #btnBackToLogin
   - Discord buttons: #btnLoginDiscord, #btnRegisterDiscord (or any .auth-oauth__btn--discord)

   Requirements in index.html (before this file):
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
   <script src="./auth.js"></script>
*/

(() => {
  // ====== CONFIG ======
  const SUPABASE_URL = "https://ghvcxourgfbjdtzxqkox.supabase.co";
  const SUPABASE_ANON_KEY ="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdodmN4b3VyZ2ZiamR0enhxa294Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA1NTIxMDMsImV4cCI6MjA4NjEyODEwM30.V1xKeI68xXRAEjfhMobNQH_1KQOzh1vLojSw6LnmsAc";

  const USERNAME_MAX_LEN = 12;

  // ====== SUPABASE INIT ======
  function ensureSupabaseSDK() {
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      throw new Error(
        "Supabase SDK not found. Add <script src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'></script> BEFORE auth.js"
      );
    }
  }

  ensureSupabaseSDK();
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  // expose for other modules (chat.js etc.)
  window.sb = sb;

  // ====== DOM HELPERS ======
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function setButtonTextSafe(btn, txt) {
    if (!btn) return;
    btn.textContent = txt;
  }

  function disableButton(btn, disabled) {
    if (!btn) return;
    btn.disabled = !!disabled;
    btn.style.opacity = disabled ? "0.6" : "";
    btn.style.cursor = disabled ? "not-allowed" : "";
  }

  function createInlineMsgEl(form) {
    if (!form) return null;

    let el = form.querySelector(".auth-inline-msg");
    if (el) return el;

    el = document.createElement("div");
    el.className = "auth-inline-msg";
    el.style.marginTop = "12px";
    el.style.fontSize = "13px";
    el.style.lineHeight = "1.35";
    el.style.color = "rgba(234,240,255,.75)";
    form.appendChild(el);
    return el;
  }

  function setInlineMsg(form, text, isError = false) {
    const el = createInlineMsgEl(form);
    if (!el) return;
    el.textContent = text || "";
    el.style.color = isError ? "#ff7b7b" : "rgba(167,255,176,.95)";
  }

  function normalizeUsername(raw) {
    return String(raw || "").trim();
  }

  // ====== AUTH MODAL CONTROL (works with your existing modal markup) ======
  function getModalParts() {
    return {
      modal: $("#authModal"),
      loginCard: $("#authLoginCard"),
      registerCard: $("#authRegisterCard"),
    };
  }

  function showAuthCard(mode) {
    const { loginCard, registerCard } = getModalParts();
    if (!loginCard || !registerCard) return;

    const isLogin = mode === "login";
    loginCard.hidden = !isLogin;
    registerCard.hidden = isLogin;
  }

  function openAuthModal(mode) {
    const { modal } = getModalParts();
    if (!modal) return;

    showAuthCard(mode || "login");
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("is-modal-open");
  }

  function closeAuthModal() {
    const { modal } = getModalParts();
    if (!modal) return;

    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("is-modal-open");
  }

  window.openAuthModal = openAuthModal;
  window.closeAuthModal = closeAuthModal;

  // ====== HEADER UI STATE ======
  function getNicknameFromUser(user) {
  const meta = user?.user_metadata || {};

  // 1) Discord Display Name (global_name) — то, что видно в Discord
  let nick = (meta.custom_claims?.global_name || "").trim();

  // 2) Discord username (fallback)
  if (!nick) nick = (meta.full_name || "").trim();

  // 3) Твой username из email-регистрации (fallback)
  if (!nick) nick = (meta.username || "").trim();

  // 4) Final fallback
  if (!nick) nick = "Account";

  // limit (у тебя 12)
  return nick.slice(0, USERNAME_MAX_LEN);
}



  function applyHeaderAuthState(user) {
    const btnLogin = $("#btnLogin");
    const btnRegister = $("#btnRegister");
    if (!btnLogin || !btnRegister) return;

    if (user) {
      setButtonTextSafe(btnLogin, getNicknameFromUser(user));
      // show a clear logout action
      setButtonTextSafe(btnRegister, "Logout");
      btnLogin.dataset.mode = "account";
      btnRegister.dataset.mode = "logout";
      btnRegister.hidden = false;
      btnLogin.classList.add("is-logged-in");
      btnRegister.classList.add("is-logout");
    } else {
      setButtonTextSafe(btnLogin, "Login");
      setButtonTextSafe(btnRegister, "Sign up");
      btnLogin.dataset.mode = "login";
      btnRegister.dataset.mode = "register";
      btnRegister.hidden = false;
      btnLogin.classList.remove("is-logged-in");
      btnRegister.classList.remove("is-logout");
    }
  }

  // ====== AUTH ACTIONS ======
  async function authGetUser() {
    const { data, error } = await sb.auth.getUser();
    if (error) throw error;
    return data.user || null;
  }

  async function authSignIn(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  async function authSignUp(email, password, username) {
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: {
        data: { username },
      },
    });
    if (error) throw error;
    return data;
  }

  async function authSignOut() {
    const { error } = await sb.auth.signOut();
    if (error) throw error;
    return true;
  }

  async function authDiscordOAuth() {
    // OAuth flow: Discord will create user if not exists, or sign in if exists
    await sb.auth.signInWithOAuth({
      provider: "discord",
      options: {
        redirectTo: window.location.origin,
      },
    });
  }

  window.FZAuth = {
    sb,
    authGetUser,
    authSignIn,
    authSignUp,
    authSignOut,
    authDiscordOAuth,
  };

  // ====== WIRE UI EVENTS ======
  function wireHeaderButtons() {
    const btnLogin = $("#btnLogin");
    const btnRegister = $("#btnRegister");

    if (btnLogin) {
      btnLogin.addEventListener("click", () => {
        const mode = btnLogin.dataset.mode || "login";

        // ✅ If logged in: do nothing (no login modal)
        if (mode === "account") return;

        openAuthModal("login");
      });
    }

    if (btnRegister) {
      btnRegister.addEventListener("click", async () => {
        const mode = btnRegister.dataset.mode || "register";

        if (mode === "logout") {
          disableButton(btnRegister, true);
          try {
            await authSignOut();
            applyHeaderAuthState(null);
          } catch (e) {
            console.error(e);
          } finally {
            disableButton(btnRegister, false);
          }
          return;
        }

        openAuthModal("register");
      });
    }
  }

  function wireModalClose() {
    const modal = $("#authModal");
    if (!modal) return;

    modal.querySelectorAll("[data-auth-close]").forEach((el) => {
      el.addEventListener("click", closeAuthModal);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAuthModal();
    });

    const btnBackToLogin = $("#btnBackToLogin");
    if (btnBackToLogin) {
      btnBackToLogin.addEventListener("click", (e) => {
        e.preventDefault();
        showAuthCard("login");
      });
    }
  }

  function wireDiscordButtons() {
    // ✅ Works with:
    // - #btnLoginDiscord
    // - #btnRegisterDiscord
    // - any .auth-oauth__btn--discord (fallback)
    const buttons = [
      ...$$('#btnLoginDiscord'),
      ...$$('#btnRegisterDiscord'),
      ...$$('.auth-oauth__btn--discord'),
    ];

    // remove duplicates (if same element collected multiple times)
    const uniqueButtons = Array.from(new Set(buttons)).filter(Boolean);

    uniqueButtons.forEach((btn) => {
      btn.addEventListener("click", async () => {
        // show small feedback inside the closest form/card if possible
        const form = btn.closest("form");
        if (form) setInlineMsg(form, "Redirecting to Discord...", false);

        disableButton(btn, true);
        try {
          await authDiscordOAuth();
          // redirect happens; code after may not run
        } catch (e) {
          console.error("Discord OAuth error:", e);
          if (form) setInlineMsg(form, e?.message || "Discord login failed.", true);
          disableButton(btn, false);
        }
      });
    });
  }

  function wireLoginForm() {
    const form = $("#loginForm");
    if (!form) return;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const email = ($("#loginEmail")?.value || "").trim();
      const password = $("#loginPassword")?.value || "";

      setInlineMsg(form, "", false);

      if (!email || !password) {
        setInlineMsg(form, "Enter email and password.", true);
        return;
      }

      const btn = form.querySelector("button[type='submit']");
      disableButton(btn, true);

      try {
        const res = await authSignIn(email, password);
        applyHeaderAuthState(res?.user ?? res?.session?.user ?? null);
        setInlineMsg(form, "Logged in.", false);
        closeAuthModal();
      } catch (err) {
        console.error(err);
        setInlineMsg(form, err?.message || "Login failed.", true);
      } finally {
        disableButton(btn, false);
      }
    });
  }

  function wireRegisterForm() {
    const form = $("#registerForm");
    if (!form) return;

    const userInput = $("#regUsername");
    if (userInput) userInput.maxLength = USERNAME_MAX_LEN;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const username = normalizeUsername($("#regUsername")?.value || "");
      const email = ($("#regEmail")?.value || "").trim();
      const password = $("#regPassword")?.value || "";
      const password2 = $("#regPassword2")?.value || "";

      setInlineMsg(form, "", false);

      if (!username) {
        setInlineMsg(form, "Enter a username.", true);
        return;
      }
      if (username.length > USERNAME_MAX_LEN) {
        setInlineMsg(form, `Username must be max ${USERNAME_MAX_LEN} characters.`, true);
        return;
      }
      if (!email) {
        setInlineMsg(form, "Enter an email.", true);
        return;
      }
      if (!password) {
        setInlineMsg(form, "Enter a password.", true);
        return;
      }
      if (password.length < 6) {
        setInlineMsg(form, "Password must be at least 6 characters.", true);
        return;
      }
      if (password !== password2) {
        setInlineMsg(form, "Passwords do not match.", true);
        return;
      }

      const btn = form.querySelector("button[type='submit']");
      disableButton(btn, true);

      try {
        await authSignUp(email, password, username);
        setInlineMsg(form, "Registered. You can sign in now.", false);
        showAuthCard("login");

        const loginEmail = $("#loginEmail");
        if (loginEmail) loginEmail.value = email;
      } catch (err) {
        console.error(err);
        setInlineMsg(form, err?.message || "Register failed.", true);
      } finally {
        disableButton(btn, false);
      }
    });
  }

  // ====== BOOTSTRAP ======
  async function bootstrap() {
    wireHeaderButtons();
    wireModalClose();
    wireDiscordButtons();
    wireLoginForm();
    wireRegisterForm();

    let user = null;
    try {
      user = await authGetUser();
    } catch (e) {
      console.error(e);
    }
    applyHeaderAuthState(user);

    sb.auth.onAuthStateChange((_event, session) => {
      applyHeaderAuthState(session?.user ?? null);
    });

    /* FZ auth UI fallback sync */
    let syncTries = 0;
    const syncTimer = setInterval(async () => {
      syncTries += 1;
      try {
        const { data } = await sb.auth.getSession();
        applyHeaderAuthState(data?.session?.user ?? null);
      } catch (_e) {}
      if (syncTries >= 10) clearInterval(syncTimer);
    }, 1200);

  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
