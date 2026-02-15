/* chat.js — Fightzone realtime chat (Supabase)
   - Reads last messages
   - Subscribes to new messages via Realtime (postgres_changes)
   - Allows sending only for authenticated users
*/

/* 1) CONFIG
   Use the SAME project URL + anon key as in auth.js.
   If your auth.js already creates window.sb, chat will reuse it.
*/
const CHAT_SUPABASE_URL = "https://ghvcxourgfbjdtzxqkox.supabase.co";
const CHAT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdodmN4b3VyZ2ZiamR0enhxa294Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA1NTIxMDMsImV4cCI6MjA4NjEyODEwM30.V1xKeI68xXRAEjfhMobNQH_1KQOzh1vLojSw6LnmsAc";

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

// ===== Rooms (per-stream chat) =====
let ACTIVE_ROOM = "global";
let realtimeChannel = null;

// keep last room (optional)
const ROOM_KEY = "fz_chat_room";

// Chat client holder
let CHAT_SB = null;
// If setChatRoom called before init finishes
let PENDING_ROOM = null;

function normalizeRoom(roomId){
  const r = String(roomId || "").trim();
  return r ? r : "global";
}

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
    .select("id, created_at, user_id, username, content, room")
    .eq("room", ACTIVE_ROOM)
    .order("created_at", { ascending: true })
    .limit(60);

  if (error) {
    console.error("[Chat] loadRecent error:", error?.message || error);
    chatBody.innerHTML = '<div class="chat-sys">Chat is not available yet.</div>';
    return;
  }

  // No messages — это НЕ ошибка
  if (!data || data.length === 0) {
    chatBody.innerHTML = '<div class="chat-sys">No messages yet.</div>';
    return;
  }

  chatBody.innerHTML = "";
  for (const msg of data) {
    chatBody.appendChild(renderMessageRow(msg));
  }
  scrollToBottom(chatBody);
}

async function startRealtime(sb){
  if (!sb) return;

  // remove previous subscription (if any)
  if (realtimeChannel) {
    try { await sb.removeChannel(realtimeChannel); } catch(_e) {}
    realtimeChannel = null;
  }

  // Subscribe only to this room
  realtimeChannel = sb.channel("fightzone-chat-" + ACTIVE_ROOM);

  realtimeChannel.on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: CHAT_TABLE,
      filter: `room=eq.${ACTIVE_ROOM}`
    },
    (payload) => {
      if (!payload?.new || !chatBody) return;

      // If currently showing "No messages yet." -> clear it
      if (chatBody.firstElementChild && chatBody.firstElementChild.classList.contains("chat-sys")) {
        chatBody.innerHTML = "";
      }

      const shouldStick = isNearBottom(chatBody);
      chatBody.appendChild(renderMessageRow(payload.new));

      // максимум 60 сообщений
      while (chatBody.children.length > 60) {
        chatBody.removeChild(chatBody.firstElementChild);
      }

      if (shouldStick) scrollToBottom(chatBody);
    }
  );

  const { error } = await realtimeChannel.subscribe();
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
    .insert([{ content, username, user_id: user.id, room: ACTIVE_ROOM }]);

  if (error) {
    console.error("[Chat] insert error:", error);
    alert(error.message || "Failed to send message");
    return;
  }

  chatMessage.value = "";
}

// ====== PUBLIC API: change room (called from index.html) ======
async function switchRoom(roomId){
  const next = normalizeRoom(roomId);

  // avoid useless reload
  if (next === ACTIVE_ROOM && CHAT_SB) return;

  ACTIVE_ROOM = next;
  try { localStorage.setItem(ROOM_KEY, ACTIVE_ROOM); } catch(_e) {}

  if (!CHAT_SB) return;

  // reload messages + resubscribe realtime
  await loadRecent(CHAT_SB);
  await startRealtime(CHAT_SB);
}

// expose globally
window.setChatRoom = function(roomId){
  PENDING_ROOM = roomId;
  // if already initialized — switch now
  if (CHAT_SB) return switchRoom(roomId);
};

(async function initChat(){
  // restore last room (optional)
  try {
    const saved = localStorage.getItem(ROOM_KEY);
    if (saved) ACTIVE_ROOM = normalizeRoom(saved);
  } catch(_e) {}

  const sb = await getClient();
  if (!sb) return;

  CHAT_SB = sb;

  await setupAuth(sb);

  // if a room was requested before init finished — use it
  if (PENDING_ROOM) {
    ACTIVE_ROOM = normalizeRoom(PENDING_ROOM);
    try { localStorage.setItem(ROOM_KEY, ACTIVE_ROOM); } catch(_e) {}
  }

  await loadRecent(sb);
  await startRealtime(sb);

  if (chatForm) {
    chatForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await sendMessage(sb);
    });
  }
})();
