/* chat.js — Fightzone realtime chat (Supabase)
   - Reads last messages
   - Subscribes to new messages via Realtime (postgres_changes)
   - Allows sending only for authenticated users
*/

/* 1) CONFIG
   Use the SAME project URL + anon key as in auth.js.
   If your auth.js already creates window.sb, chat will reuse it.
*/
const CHAT_SUPABASE_URL = "PASTE_YOUR_SUPABASE_PROJECT_URL";
const CHAT_SUPABASE_ANON_KEY = "PASTE_YOUR_SUPABASE_ANON_PUBLIC_KEY";

// Table name
const CHAT_TABLE = "chat_messages";

// Nickname color palette (stable per account via user_id hash)
const NAME_COLORS = [
  "#FF0000", // Red
  "#005BFF", // Electric blue
  "#00FF00", // Neon green
  "#FFD700", // Bright yellow
  "#FF00FF", // Fuchsia
  "#7A00FF", // Purple
  "#FF7A00", // Orange
  "#00FFFF", // Cyan / aqua
  "#B6FF00", // Lime
  "#001AFF"  // Royal blue
];

function hashStringToInt(str){
  let h = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++){
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0; // 32-bit
  }
  return Math.abs(h);
}

function getNameColor(msg){
  // Prefer user_id (stable), fallback to username
  const key = msg?.user_id || msg?.username || "";
  const idx = hashStringToInt(key) % NAME_COLORS.length;
  return NAME_COLORS[idx];
}

// UI
const chatBody = document.getElementById("chatBody");
const chatForm = document.getElementById("chatForm");
const chatMessage = document.getElementById("chatMessage");
const chatHint = document.getElementById("chatHint");

function esc(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

function isNearBottom(el){
  return (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
}

function scrollToBottom(el){
  el.scrollTop = el.scrollHeight;
}

function getDisplayName(user){
  const md = user?.user_metadata || {};
  // Common fields (based on your Discord OAuth logic)
  const custom = md?.custom_claims || md?.customClaims || md?.custom_claim || null;
  const globalName = custom?.global_name || md?.global_name || null;

  const name =
    globalName ||
    md?.username ||
    md?.full_name ||
    md?.name ||
    md?.preferred_username ||
    "User";

  return String(name).slice(0, 24);
}

async function getClient(){
  // Reuse existing client if your auth.js exposes one
  if (window.sb && window.sb.auth) return window.sb;

  // Fallback: create our own
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    console.error("[Chat] Supabase JS not loaded.");
    return null;
  }
  if (!CHAT_SUPABASE_URL.startsWith("http")) {
    console.warn("[Chat] Set CHAT_SUPABASE_URL / CHAT_SUPABASE_ANON_KEY in chat.js");
  }
  return window.supabase.createClient(CHAT_SUPABASE_URL, CHAT_SUPABASE_ANON_KEY);
}

function renderMessageRow(msg){
  const time = msg.created_at ? new Date(msg.created_at) : null;
  const hhmm = time ? time.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) : "";
  const name = msg.username || "User";
  const text = msg.content || "";

  const row = document.createElement("div");
  row.className = "chat-msg";
  row.innerHTML = `
    <div class="chat-msg__meta">
      <span class="chat-msg__name" style="color:${esc(getNameColor(msg))}">${esc(name)}</span>
      <span class="chat-msg__time">${esc(hhmm)}</span>
    </div>
    <div class="chat-msg__text">${esc(text)}</div>
  `;
  return row;
}

function setChatEnabled(enabled){
  if (!chatMessage || !chatForm) return;
  chatMessage.disabled = !enabled;
  chatMessage.placeholder = enabled ? "Type a message…" : "Login to chat…";
  if (chatHint) chatHint.style.display = enabled ? "none" : "block";
  const btn = document.getElementById("chatSend");
  if (btn) btn.disabled = !enabled;
}

async function loadRecent(sb){
  if (!sb || !chatBody) return;

  const { data, error } = await sb
    .from(CHAT_TABLE)
    .select("id, created_at, user_id, username, content")
    .order("created_at", { ascending: true })
    .limit(60);

  if (error) {
    console.error("[Chat] loadRecent error:", error);
    chatBody.innerHTML = '<div class="chat-sys">Chat is not available yet.</div>';
    return;
  }

  chatBody.innerHTML = "";
  for (const msg of (data || [])) {
    chatBody.appendChild(renderMessageRow(msg));
  }
  scrollToBottom(chatBody);
}

async function startRealtime(sb){
  if (!sb) return;

  // Subscribe to inserts
  const channel = sb.channel("fightzone-chat");

  channel.on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: CHAT_TABLE },
    (payload) => {
      if (!payload?.new || !chatBody) return;

      const shouldStick = isNearBottom(chatBody);
      chatBody.appendChild(renderMessageRow(payload.new));

      if (shouldStick) scrollToBottom(chatBody);
    }
  );

  const { error } = await channel.subscribe();
  if (error) console.error("[Chat] subscribe error:", error);
}

async function setupAuth(sb){
  // Determine initial state
  const { data } = await sb.auth.getSession();
  setChatEnabled(!!data?.session);

  // Listen to changes
  sb.auth.onAuthStateChange((_event, session) => {
    setChatEnabled(!!session);
  });
}

async function sendMessage(sb){
  const { data } = await sb.auth.getUser();
  const user = data?.user;
  if (!user) {
    setChatEnabled(false);
    return;
  }

  const text = (chatMessage?.value || "").trim();
  if (!text) return;

  // Simple anti-spam / size
  const content = text.slice(0, 300);
  const username = getDisplayName(user);

  const { error } = await sb
    .from(CHAT_TABLE)
    .insert([{ content, username, user_id: user.id }]);

  if (error) {
    console.error("[Chat] insert error:", error);
    alert(error.message || "Failed to send message");
    return;
  }

  chatMessage.value = "";
}

(async function initChat(){
  const sb = await getClient();
  if (!sb) return;

  await setupAuth(sb);
  await loadRecent(sb);
  await startRealtime(sb);

  if (chatForm) {
    chatForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await sendMessage(sb);
    });
  }
})();
