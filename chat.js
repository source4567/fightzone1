/* chat.js — Fightzone realtime chat (Supabase)
   - Reads last messages
   - Subscribes to new messages via Realtime (postgres_changes)
   - Also broadcasts new messages for instant updates across tabs/users
   - Allows sending only for authenticated users
*/

const CHAT_SUPABASE_URL = "https://ghvcxourgfbjdtzxqkox.supabase.co";
const CHAT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdodmN4b3VyZ2ZiamR0enhxa294Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA1NTIxMDMsImV4cCI6MjA4NjEyODEwM30.V1xKeI68xXRAEjfhMobNQH_1KQOzh1vLojSw6LnmsAc";

const CHAT_TABLE = "chat_messages";

const NAME_COLORS = [
  "#FF0000", "#005BFF", "#00FF00", "#FFD700", "#FF00FF",
  "#7A00FF", "#FF7A00", "#00FFFF", "#B6FF00", "#001AFF"
];

function hashStringToInt(str) {
  let h = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}
function getNameColor(msg) {
  const key = msg?.user_id || msg?.username || "";
  return NAME_COLORS[hashStringToInt(key) % NAME_COLORS.length];
}
function esc(s) {
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}
function isNearBottom(el) {
  return (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
}
function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

// UI
const chatBody = document.getElementById("chatBody");
const chatForm = document.getElementById("chatForm");
const chatMessage = document.getElementById("chatMessage");
const chatHint = document.getElementById("chatHint");

// Rooms
let ACTIVE_ROOM = "global";
let realtimeChannel = null;

// Current user + dedupe
let CURRENT_USER_ID = null;
let LAST_SENT = null; // { room, content, atMs }

// Helper
function normalizeRoom(roomId) {
  const r = String(roomId || "").trim();
  return r ? r : "global";
}
function getDisplayName(user) {
  const md = user?.user_metadata || {};
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

async function getClient() {
  if (window.sb && window.sb.auth) return window.sb;
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    console.error("[Chat] Supabase JS not loaded.");
    return null;
  }
  return window.supabase.createClient(CHAT_SUPABASE_URL, CHAT_SUPABASE_ANON_KEY);
}

function renderMessageRow(msg) {
  const time = msg.created_at ? new Date(msg.created_at) : null;
  const hhmm = time ? time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
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

function setChatEnabled(enabled) {
  if (!chatMessage || !chatForm) return;
  chatMessage.disabled = !enabled;
  chatMessage.placeholder = enabled ? "Type a message…" : "Login to chat…";
  if (chatHint) chatHint.style.display = enabled ? "none" : "block";
  const btn = document.getElementById("chatSend");
  if (btn) btn.disabled = !enabled;
}

function clearSysIfNeeded() {
  if (!chatBody) return;
  if (chatBody.firstElementChild && chatBody.firstElementChild.classList.contains("chat-sys")) {
    chatBody.innerHTML = "";
  }
}
function showEmptyState() {
  if (!chatBody) return;
  chatBody.innerHTML = '<div class="chat-sys">No messages yet.</div>';
}

function appendMessageToUI(msg) {
  if (!chatBody) return;

  // room guard
  if (msg?.room && msg.room !== ACTIVE_ROOM) return;

  clearSysIfNeeded();

  const shouldStick = isNearBottom(chatBody);
  chatBody.appendChild(renderMessageRow(msg));

  while (chatBody.children.length > 60) {
    chatBody.removeChild(chatBody.firstElementChild);
  }

  if (shouldStick) scrollToBottom(chatBody);
}

async function loadRecent(sb) {
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

  if (!data || data.length === 0) {
    showEmptyState();
    return;
  }

  chatBody.innerHTML = "";
  for (const msg of data) chatBody.appendChild(renderMessageRow(msg));
  scrollToBottom(chatBody);
}

async function startRealtime(sb) {
  if (!sb) return;

  // remove previous
  if (realtimeChannel) {
    try { await sb.removeChannel(realtimeChannel); } catch (_e) {}
    realtimeChannel = null;
  }

  const roomAtSubscribe = ACTIVE_ROOM;
  realtimeChannel = sb.channel("fightzone-chat-" + roomAtSubscribe);

  // 1) Postgres changes (best case)
  realtimeChannel.on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: CHAT_TABLE,
      filter: `room=eq.${roomAtSubscribe}`
    },
    (payload) => {
      if (!payload?.new) return;
      if (roomAtSubscribe !== ACTIVE_ROOM) return;

      const n = payload.new;

      // dedupe (if we already rendered our optimistic message)
      if (
        LAST_SENT &&
        CURRENT_USER_ID &&
        n.user_id === CURRENT_USER_ID &&
        n.room === LAST_SENT.room &&
        n.content === LAST_SENT.content &&
        (Date.now() - LAST_SENT.atMs) < 15000
      ) {
        return;
      }

      appendMessageToUI(n);
    }
  );

  // 2) Broadcast fallback (works even if postgres_changes is late on some clients)
  realtimeChannel.on(
    "broadcast",
    { event: "new_msg" },
    ({ payload }) => {
      if (!payload) return;
      if (roomAtSubscribe !== ACTIVE_ROOM) return;

      // dedupe for sender
      if (
        LAST_SENT &&
        CURRENT_USER_ID &&
        payload.user_id === CURRENT_USER_ID &&
        payload.room === LAST_SENT.room &&
        payload.content === LAST_SENT.content &&
        (Date.now() - LAST_SENT.atMs) < 15000
      ) {
        return;
      }

      appendMessageToUI(payload);
    }
  );

  const { error } = await realtimeChannel.subscribe();
  if (error) console.error("[Chat] subscribe error:", error);
}

async function setupAuth(sb) {
  const { data } = await sb.auth.getSession();
  CURRENT_USER_ID = data?.session?.user?.id || null;
  setChatEnabled(!!data?.session);

  sb.auth.onAuthStateChange((_event, session) => {
    CURRENT_USER_ID = session?.user?.id || null;
    setChatEnabled(!!session);
  });
}

async function sendMessage(sb) {
  const { data } = await sb.auth.getUser();
  const user = data?.user;
  if (!user) {
    setChatEnabled(false);
    return;
  }

  const text = (chatMessage?.value || "").trim();
  if (!text) return;

  const content = text.slice(0, 300);
  const username = getDisplayName(user);

  const row = {
    created_at: new Date().toISOString(),
    user_id: user.id,
    username,
    content,
    room: ACTIVE_ROOM
  };

  const { error } = await sb.from(CHAT_TABLE).insert([{
    content,
    username,
    user_id: user.id,
    room: ACTIVE_ROOM
  }]);

  if (error) {
    console.error("[Chat] insert error:", error);
    alert(error.message || "Failed to send message");
    return;
  }

  // ✅ show instantly for sender
  LAST_SENT = { room: ACTIVE_ROOM, content, atMs: Date.now() };
  appendMessageToUI(row);

  // ✅ broadcast to everyone in the room (instant, no refresh)
  try {
    if (realtimeChannel) {
      await realtimeChannel.send({
        type: "broadcast",
        event: "new_msg",
        payload: row
      });
    }
  } catch (e) {
    // not fatal
    console.warn("[Chat] broadcast send failed:", e?.message || e);
  }

  chatMessage.value = "";
}

// Public API for stream overlay
window.setChatRoom = async function(roomId) {
  const next = normalizeRoom(roomId);
  if (next === ACTIVE_ROOM) return;

  ACTIVE_ROOM = next;

  const sb = await getClient();
  if (!sb) return;

  await loadRecent(sb);
  await startRealtime(sb);
};

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
