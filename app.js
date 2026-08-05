const config = window.CHAT_CONFIG || {};
const configured =
  config.supabaseUrl?.startsWith("https://") &&
  !config.supabaseUrl.includes("YOUR_") &&
  config.supabaseAnonKey &&
  !config.supabaseAnonKey.includes("YOUR_");

const elements = {
  messages: document.querySelector("#messages"),
  emptyState: document.querySelector("#emptyState"),
  form: document.querySelector("#messageForm"),
  lockedComposer: document.querySelector("#lockedComposer"),
  input: document.querySelector("#messageInput"),
  send: document.querySelector("#sendButton"),
  remaining: document.querySelector("#characterCount"),
  connection: document.querySelector("#connectionStatus"),
  setupNotice: document.querySelector("#setupNotice"),
  onlineCount: document.querySelector("#onlineCount"),
  changeName: document.querySelector("#changeNameButton"),
  sideUsername: document.querySelector("#sideUsername"),
  sideAvatar: document.querySelector("#sideAvatar"),
  nameDialog: document.querySelector("#nameDialog"),
  nameForm: document.querySelector("#nameForm"),
  nameInput: document.querySelector("#nameInput"),
  accessCodeField: document.querySelector("#accessCodeField"),
  accessCodeInput: document.querySelector("#accessCodeInput"),
  nameError: document.querySelector("#nameError"),
  commandDialog: document.querySelector("#commandDialog"),
  closeCommandDialog: document.querySelector("#closeCommandDialog"),
  typingIndicator: document.querySelector("#typingIndicator"),
  typingText: document.querySelector("#typingText"),
  toast: document.querySelector("#toast"),
};

let username = localStorage.getItem("global-chat-name") || "";
let client = null;
let roomChannel = null;
let sending = false;
let toastTimer = null;
let adminSecret = sessionStorage.getItem("chat-admin-secret") || "";
let roomAccessCode = sessionStorage.getItem("chat-room-access") || "";
let chatSessionToken = sessionStorage.getItem("chat-session-token") || "";
let accessVerified = false;
let realtimeSigningKey = null;
let chatLocked = true;
let pollingTimer = null;
let notificationsEnabled = localStorage.getItem("chat-notifications") === "true";
let soundEnabled = localStorage.getItem("chat-sound") === "true";
let audioContext = null;
let unreadCount = 0;
let typingStopTimer = null;
let lastTypingBroadcast = 0;
let typingBroadcastActive = false;
const remoteTypingUsers = new Map();
const renderedMessages = new Set();
const sessionId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const visitorId = localStorage.getItem("chat-visitor-id") || crypto.randomUUID?.() || sessionId;
localStorage.setItem("chat-visitor-id", visitorId);

function normalizeName(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, 24);
}

function avatarColor(name) {
  const colors = ["#c8f560", "#ff8a51", "#68d8d6", "#d9a7ff", "#ffd166", "#7ea8ff"];
  const hash = [...name].reduce((total, character) => total + character.codePointAt(0), 0);
  return colors[hash % colors.length];
}

async function getRealtimeSigningKey() {
  if (realtimeSigningKey) return realtimeSigningKey;
  realtimeSigningKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(roomAccessCode),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return realtimeSigningKey;
}

async function signRealtimeValue(value) {
  const key = await getRealtimeSigningKey();
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyRealtimeValue(value, signature) {
  if (!signature || !roomAccessCode) return false;
  const bytes = signature.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16));
  if (!bytes) return false;
  const key = await getRealtimeSigningKey();
  return crypto.subtle.verify("HMAC", key, new Uint8Array(bytes), new TextEncoder().encode(value));
}

async function countOnlineVisitors(state) {
  const visitors = new Set();
  const presences = Object.values(state).flat();
  await Promise.all(
    presences.map(async (presence) => {
      const signedValue = `${presence.visitorId}|${presence.name}`;
      if (!(await verifyRealtimeValue(signedValue, presence.signature))) return;
      const normalizedName = presence.name?.trim().toLocaleLowerCase();
      visitors.add(normalizedName ? `name:${normalizedName}` : `visitor:${presence.visitorId}`);
    }),
  );
  return visitors.size;
}

function updateIdentity() {
  const initial = username.trim().charAt(0).toUpperCase() || "؟";
  elements.sideUsername.textContent = username || "زائر";
  elements.sideAvatar.textContent = initial;
  elements.sideAvatar.style.setProperty("--avatar", avatarColor(username || "زائر"));
  document.querySelectorAll(".message").forEach((message) => {
    message.classList.toggle("is-mine", message.dataset.username === username);
  });
}

function askForName() {
  elements.nameInput.value = username;
  const needsAccessCode = !accessVerified;
  elements.accessCodeField.hidden = !needsAccessCode;
  elements.accessCodeInput.required = needsAccessCode;
  elements.accessCodeInput.value = "";
  elements.nameError.textContent = "";
  if (!elements.nameDialog.open) elements.nameDialog.showModal();
  requestAnimationFrame(() => elements.nameInput.focus());
}

function setConnection(state, label) {
  elements.connection.dataset.state = state;
  elements.connection.querySelector("b").textContent = label;
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function messageTime(timestamp) {
  return new Intl.DateTimeFormat("ar", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

async function playMessageSound() {
  if (!soundEnabled) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  audioContext ||= new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();

  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(660, audioContext.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(880, audioContext.currentTime + 0.08);
  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.12, audioContext.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.16);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.17);
}

function notifyIncomingMessage(message) {
  if (message.username === username) return;
  playMessageSound().catch(console.error);

  if (document.hidden) {
    unreadCount += 1;
    document.title = `(${unreadCount}) جمعة | Global Chat`;
  }

  if (!notificationsEnabled || !("Notification" in window) || Notification.permission !== "granted") return;
  const notification = new Notification(`${message.username} أرسل رسالة`, {
    body: message.content,
    icon: "icon.svg",
    tag: `chat-message-${message.id}`,
    silent: soundEnabled,
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

async function enableNotifications() {
  soundEnabled = true;
  localStorage.setItem("chat-sound", "true");
  await playMessageSound();

  if (!("Notification" in window)) {
    showToast("تم تفعيل الصوت. هذا المتصفح لا يدعم إشعارات النظام.");
    return;
  }

  const permission = await Notification.requestPermission();
  notificationsEnabled = permission === "granted";
  localStorage.setItem("chat-notifications", String(notificationsEnabled));
  showToast(
    notificationsEnabled
      ? "تم تفعيل إشعارات الرسائل والصوت."
      : "تم تفعيل الصوت فقط؛ إذن الإشعارات مرفوض.",
  );
}

function disableNotifications() {
  notificationsEnabled = false;
  soundEnabled = false;
  localStorage.setItem("chat-notifications", "false");
  localStorage.setItem("chat-sound", "false");
  showToast("تم كتم الإشعارات والصوت.");
}

function renderTypingIndicator() {
  const names = [...new Set([...remoteTypingUsers.values()].map((entry) => entry.username))];
  elements.typingIndicator.classList.toggle("active", names.length > 0);

  if (names.length === 1) {
    elements.typingText.textContent = `${names[0]} يكتب الآن`;
  } else if (names.length === 2) {
    elements.typingText.textContent = `${names[0]} و${names[1]} يكتبان الآن`;
  } else if (names.length > 2) {
    elements.typingText.textContent = `${names[0]} و${names.length - 1} آخرون يكتبون الآن`;
  } else {
    elements.typingText.textContent = "";
  }
}

async function receiveTypingStatus(payload) {
  if (!payload?.sessionId || payload.sessionId === sessionId) return;
  const signedValue = `${payload.sessionId}|${payload.username}|${payload.isTyping}|${payload.timestamp}`;
  if (Math.abs(Date.now() - payload.timestamp) > 5000) return;
  if (!(await verifyRealtimeValue(signedValue, payload.signature))) return;
  const previous = remoteTypingUsers.get(payload.sessionId);
  if (previous) clearTimeout(previous.timer);

  if (!payload.isTyping) {
    remoteTypingUsers.delete(payload.sessionId);
    renderTypingIndicator();
    return;
  }

  const timer = setTimeout(() => {
    remoteTypingUsers.delete(payload.sessionId);
    renderTypingIndicator();
  }, 1900);
  remoteTypingUsers.set(payload.sessionId, { username: payload.username, timer });
  renderTypingIndicator();
}

async function broadcastTyping(isTyping) {
  if (!roomChannel || !accessVerified) return;
  const timestamp = Date.now();
  const signedValue = `${sessionId}|${username}|${isTyping}|${timestamp}`;
  const signature = await signRealtimeValue(signedValue);
  roomChannel
    .send({
      type: "broadcast",
      event: "typing",
      payload: { sessionId, username, isTyping, timestamp, signature },
    })
    .catch(console.error);
}

async function trackPresence() {
  if (!roomChannel || !accessVerified) return;
  const signature = await signRealtimeValue(`${visitorId}|${username}`);
  await roomChannel.track({ visitorId, name: username, signature, joinedAt: new Date().toISOString() });
}

function setChatAccess(enabled) {
  accessVerified = enabled;
  applyLockState(chatLocked);
}

function applyLockState(locked) {
  chatLocked = locked;
  const canUseComposer = accessVerified && (!locked || Boolean(adminSecret));
  elements.input.disabled = !canUseComposer;
  elements.send.disabled = !canUseComposer;
  elements.form.classList.toggle("is-locked", locked);
  elements.lockedComposer.hidden = !locked || Boolean(adminSecret) || !accessVerified;
  elements.input.placeholder = locked
    ? adminSecret
      ? "المحادثة مقفلة؛ اكتب /unlock لفتحها..."
      : "المحادثة مقفلة بواسطة المدير"
    : "اكتب شيئًا للمجموعة...";

  if (locked) {
    stopTyping();
    remoteTypingUsers.forEach((entry) => clearTimeout(entry.timer));
    remoteTypingUsers.clear();
    renderTypingIndicator();
  }
}

async function validateStoredSession() {
  const { data, error } = await client.rpc("validate_chat_session", { p_session_token: chatSessionToken });
  if (error) throw error;
  return data;
}

async function openChatSession(chosenName, accessCode) {
  const { data, error } = await client.rpc("open_chat_session", {
    p_access_code: accessCode,
    p_username: chosenName,
    p_visitor_id: visitorId,
  });
  if (error) throw error;
  chatSessionToken = data;
  roomAccessCode = accessCode;
  realtimeSigningKey = null;
  sessionStorage.setItem("chat-session-token", chatSessionToken);
  sessionStorage.setItem("chat-room-access", roomAccessCode);
}

async function enterChat(chosenName, accessCode) {
  await openChatSession(chosenName, accessCode);
  username = chosenName;
  localStorage.setItem("global-chat-name", username);
  setChatAccess(true);
  updateIdentity();
  await loadMessages({ forceScroll: true });
  connectRealtime();
  startPolling();
  return true;
}

function updateLocalTyping() {
  const isTyping = Boolean(elements.input.value.trim());
  clearTimeout(typingStopTimer);

  if (!isTyping) {
    stopTyping();
    return;
  }

  const now = Date.now();
  if (!typingBroadcastActive || now - lastTypingBroadcast > 800) {
    broadcastTyping(true);
    typingBroadcastActive = true;
    lastTypingBroadcast = now;
  }
  typingStopTimer = setTimeout(stopTyping, 1300);
}

function stopTyping() {
  clearTimeout(typingStopTimer);
  typingStopTimer = null;
  if (typingBroadcastActive) broadcastTyping(false);
  typingBroadcastActive = false;
  lastTypingBroadcast = 0;
}

function createMessage(message, animate = true) {
  const messageId = String(message?.id || "");
  if (!messageId || renderedMessages.has(messageId)) return;
  renderedMessages.add(messageId);
  elements.emptyState.hidden = true;

  const article = document.createElement("article");
  article.className = "message";
  article.dataset.id = messageId;
  article.dataset.username = message.username;
  article.classList.toggle("is-action", message.kind === "action");
  article.classList.toggle("is-announcement", message.kind === "announcement");
  if (message.username === username) article.classList.add("is-mine");
  if (!animate) article.style.animation = "none";

  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.textContent = message.username.charAt(0).toUpperCase();
  avatar.style.setProperty("--avatar", avatarColor(message.username));

  const content = document.createElement("div");
  content.className = "message-content";
  const head = document.createElement("div");
  head.className = "message-head";
  const author = document.createElement("strong");
  author.textContent = message.username;
  author.dir = "auto";
  const time = document.createElement("time");
  time.dateTime = message.created_at;
  time.textContent = messageTime(message.created_at);
  const messageNumber = document.createElement("span");
  messageNumber.className = "message-id";
  messageNumber.textContent = `#${messageId}`;
  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = message.kind === "action" ? `${message.username} ${message.content}` : message.content;
  body.dir = "auto";

  head.append(author, time, messageNumber);
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.append(head, body);
  content.append(bubble);
  article.append(avatar, content);
  elements.messages.append(article);
}

function removeMessage(messageId) {
  const normalizedId = String(messageId || "");
  const message = [...elements.messages.querySelectorAll(".message")].find(
    (item) => item.dataset.id === normalizedId,
  );
  if (message) message.remove();
  renderedMessages.delete(normalizedId);
  elements.emptyState.hidden = Boolean(elements.messages.querySelector(".message"));
}

function clearRenderedMessages() {
  elements.messages.querySelectorAll(".message").forEach((message) => message.remove());
  renderedMessages.clear();
  elements.emptyState.hidden = false;
}

function scrollToLatest(behavior = "smooth") {
  elements.messages.scrollTo({ top: elements.messages.scrollHeight, behavior });
}

async function loadMessages({ notifyNew = false, forceScroll = false } = {}) {
  const { data, error } = await client.rpc("get_chat_messages", {
    p_session_token: chatSessionToken,
    p_limit: 100,
  });

  if (error) throw error;
  const nearBottom =
    elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 120;
  const serverIds = new Set(data.map((message) => String(message.id)));
  elements.messages.querySelectorAll(".message").forEach((message) => {
    if (!serverIds.has(message.dataset.id)) removeMessage(message.dataset.id);
  });
  let receivedNewMessage = false;
  data.forEach((message) => {
    const isNew = !renderedMessages.has(String(message.id));
    createMessage(message, false);
    if (isNew) {
      receivedNewMessage = true;
      if (notifyNew) notifyIncomingMessage(message);
    }
  });
  if (forceScroll || (nearBottom && receivedNewMessage)) scrollToLatest(forceScroll ? "instant" : "smooth");
}

async function refreshChatStatus() {
  if (!accessVerified || !chatSessionToken) return;
  const { data, error } = await client.rpc("get_chat_status", { p_session_token: chatSessionToken });
  if (error) {
    if (error.message?.includes("SESSION_INVALID")) {
      setChatAccess(false);
      sessionStorage.removeItem("chat-session-token");
      chatSessionToken = "";
      askForName();
    }
    return;
  }
  applyLockState(data === true);
}

function startPolling() {
  clearInterval(pollingTimer);
  refreshChatStatus();
  pollingTimer = setInterval(async () => {
    if (!accessVerified) return;
    try {
      await Promise.all([loadMessages({ notifyNew: true }), refreshChatStatus()]);
    } catch (error) {
      console.error(error);
    }
  }, 2500);
}

function connectRealtime() {
  roomChannel = client
    .channel("global-room", { config: { presence: { key: visitorId } } })
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      receiveTypingStatus(payload);
    })
    .on("presence", { event: "sync" }, async () => {
      const state = roomChannel.presenceState();
      elements.onlineCount.textContent = await countOnlineVisitors(state);
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        setConnection("online", "متصل الآن");
        await trackPresence();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setConnection("error", "انقطع الاتصال");
      }
    });
}

async function startChat() {
  if (!configured) {
    elements.setupNotice.hidden = false;
    elements.input.disabled = true;
    elements.send.disabled = true;
    setConnection("error", "يلزم الإعداد");
    return;
  }

  try {
    client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    setChatAccess(false);
    if (username && roomAccessCode && chatSessionToken) {
      const sessionUsername = await validateStoredSession();
      if (!sessionUsername) throw new Error("SESSION_INVALID");
      username = sessionUsername;
      setChatAccess(true);
      updateIdentity();
      await loadMessages({ forceScroll: true });
      connectRealtime();
      startPolling();
    } else {
      roomAccessCode = "";
      chatSessionToken = "";
      sessionStorage.removeItem("chat-room-access");
      sessionStorage.removeItem("chat-session-token");
      askForName();
    }
  } catch (error) {
    console.error(error);
    if (error.message?.includes("SESSION_INVALID")) {
      roomAccessCode = "";
      chatSessionToken = "";
      sessionStorage.removeItem("chat-room-access");
      sessionStorage.removeItem("chat-session-token");
      setChatAccess(false);
      askForName();
    } else {
      setConnection("error", "تعذر الاتصال");
      showToast("تعذر تحميل الرسائل. تحقق من إعداد Supabase.");
    }
  }
}

async function sendMessage() {
  const rawContent = elements.input.value.trim();
  if (!rawContent || !client || sending) return;
  stopTyping();

  if (rawContent.startsWith("/") || rawContent.startsWith("\\")) {
    elements.input.value = "";
    resizeInput();
    const normalizedCommand = rawContent.startsWith("\\") ? `/${rawContent.slice(1)}` : rawContent;
    await executeCommand(normalizedCommand);
    elements.input.focus();
    return;
  }

  if (chatLocked) {
    showToast("المحادثة مقفلة. استخدم /unlock إذا كنت المدير.");
    return;
  }

  await publishMessage(rawContent);
}

async function publishMessage(content, kind = "message") {
  if (!content || !client || sending) return;

  sending = true;
  elements.send.disabled = true;
  const draft = elements.input.value;
  elements.input.value = "";
  resizeInput();

  const { data, error } = await client.rpc("send_chat_message", {
    p_session_token: chatSessionToken,
    p_content: content,
    p_kind: kind,
  });

  sending = false;
  elements.send.disabled = false;
  if (error) {
    console.error(error);
    if (kind === "message") elements.input.value = draft;
    resizeInput();
    const message = error.message || "";
    if (message.includes("CHAT_LOCKED")) {
      showToast("المحادثة مقفلة حاليًا بواسطة المدير.");
    } else if (message.includes("SLOW_DOWN") || message.includes("RATE_LIMIT")) {
      showToast("أنت ترسل بسرعة كبيرة. انتظر قليلًا.");
    } else if (message.includes("ACCESS_DENIED")) {
      setChatAccess(false);
      sessionStorage.removeItem("chat-room-access");
      showToast("تغيّر رمز الغرفة. أدخله مجددًا.");
      askForName();
    } else if (message.includes("SESSION_INVALID")) {
      setChatAccess(false);
      chatSessionToken = "";
      sessionStorage.removeItem("chat-session-token");
      showToast("انتهت جلسة المحادثة. أدخل رمز الغرفة مجددًا.");
      askForName();
    } else {
      showToast("لم تُرسل الرسالة. حاول مرة أخرى.");
    }
    return;
  }

  createMessage(data);
  scrollToLatest();
  elements.input.focus();
}

async function callAdmin(functionName, parameters = {}) {
  if (!adminSecret) {
    showToast("استخدم /admin PASSWORD أولًا.");
    return { ok: false, data: null };
  }

  const { data, error } = await client.rpc(functionName, {
    p_secret: adminSecret,
    ...parameters,
  });
  if (error) {
    console.error(error);
    if (error.message?.includes("INVALID_ADMIN_SECRET")) {
      adminSecret = "";
      sessionStorage.removeItem("chat-admin-secret");
      showToast("انتهت صلاحية الإدارة أو كلمة السر غير صحيحة.");
    } else {
      showToast("تعذر تنفيذ الأمر الإداري.");
    }
    return { ok: false, data: null };
  }
  return { ok: true, data };
}

async function executeCommand(rawCommand) {
  const separator = rawCommand.indexOf(" ");
  const command = (separator === -1 ? rawCommand : rawCommand.slice(0, separator)).toLowerCase();
  const argument = separator === -1 ? "" : rawCommand.slice(separator + 1).trim();

  if (command === "/help") {
    elements.commandDialog.showModal();
    return;
  }

  if (command === "/name") {
    const newName = normalizeName(argument);
    if (newName.length < 2) {
      showToast("الاستخدام: /name NAME");
      return;
    }
    const { error } = await client.rpc("rename_chat_session", {
      p_session_token: chatSessionToken,
      p_username: newName,
    });
    if (error) return showToast("تعذر تغيير الاسم.");
    username = newName;
    localStorage.setItem("global-chat-name", username);
    updateIdentity();
    if (roomChannel) await trackPresence();
    showToast(`أصبح اسمك ${username}`);
    return;
  }

  if (command === "/me") {
    if (!argument) return showToast("الاستخدام: /me TEXT");
    await publishMessage(argument, "action");
    return;
  }

  if (command === "/shrug") {
    await publishMessage(`${argument}${argument ? " " : ""}¯\\_(ツ)_/¯`);
    return;
  }

  if (command === "/users") {
    showToast(`${elements.onlineCount.textContent} متصل الآن`);
    return;
  }

  if (command === "/notify") {
    await enableNotifications();
    return;
  }

  if (command === "/mute") {
    disableNotifications();
    return;
  }

  if (command === "/sound") {
    if (argument !== "on" && argument !== "off") return showToast("الاستخدام: /sound on أو /sound off");
    soundEnabled = argument === "on";
    localStorage.setItem("chat-sound", String(soundEnabled));
    if (soundEnabled) await playMessageSound();
    showToast(soundEnabled ? "تم تشغيل صوت الرسائل." : "تم إيقاف صوت الرسائل.");
    return;
  }

  if (command === "/admin") {
    if (!argument) return showToast("الاستخدام: /admin PASSWORD");
    const { data, error } = await client.rpc("admin_auth", { p_secret: argument });
    if (error || !data) {
      console.error(error);
      showToast("كلمة الإدارة غير صحيحة.");
      return;
    }
    adminSecret = argument;
    sessionStorage.setItem("chat-admin-secret", adminSecret);
    applyLockState(chatLocked);
    showToast("تم تفعيل صلاحيات المدير لهذه الجلسة.");
    return;
  }

  if (command === "/logout") {
    adminSecret = "";
    sessionStorage.removeItem("chat-admin-secret");
    applyLockState(chatLocked);
    showToast("تم إنهاء صلاحية المدير.");
    return;
  }

  if (command === "/clear") {
    if (!window.confirm("حذف المحادثة كاملة؟ لا يمكن التراجع.")) return;
    const result = await callAdmin("admin_clear_chat");
    if (result.ok) {
      clearRenderedMessages();
      showToast(`حُذفت ${result.data} رسالة.`);
    }
    return;
  }

  if (command === "/delete") {
    if (!/^\d+$/.test(argument)) return showToast("الاستخدام: /delete ID");
    const result = await callAdmin("admin_delete_message", { p_message_id: Number(argument) });
    if (result.ok) {
      removeMessage(argument);
      showToast(result.data ? "حُذفت الرسالة." : "لم يُعثر على الرسالة.");
    }
    return;
  }

  if (command === "/lock" || command === "/unlock") {
    const locked = command === "/lock";
    const result = await callAdmin("admin_set_lock", { p_locked: locked });
    if (result.ok) {
      applyLockState(locked);
      showToast(locked ? "تم قفل المحادثة." : "تم فتح المحادثة.");
    }
    return;
  }

  if (command === "/announce") {
    if (!argument) return showToast("الاستخدام: /announce TEXT");
    const result = await callAdmin("admin_announce", { p_content: argument });
    if (result.ok) {
      createMessage(result.data);
      scrollToLatest();
    }
    return;
  }

  if (command === "/access") {
    if (argument.length < 20) return showToast("رمز الغرفة الجديد يجب أن يكون 20 محرفًا على الأقل.");
    const result = await callAdmin("admin_set_access_code", { p_access_code: argument });
    if (result.ok) {
      await openChatSession(username, argument);
      if (roomChannel) await client.removeChannel(roomChannel);
      roomChannel = null;
      connectRealtime();
      showToast("تم تغيير رمز الغرفة لهذا التبويب. شاركه بأمان مع المجموعة.");
    }
    return;
  }

  if (command === "/purgebots") {
    if (!window.confirm("حذف جميع الرسائل التي أُرسلت بأسماء تبدأ بـ Bot_؟")) return;
    const result = await callAdmin("admin_purge_bot_messages");
    if (result.ok) {
      clearRenderedMessages();
      await loadMessages({ forceScroll: true });
      showToast(`حُذفت ${result.data} رسالة آلية.`);
    }
    return;
  }

  showToast("أمر غير معروف. استخدم /help");
}

function resizeInput() {
  const trimmedStart = elements.input.value.trimStart();
  const isCommand = trimmedStart.startsWith("/") || trimmedStart.startsWith("\\");
  elements.input.classList.toggle("is-command", isCommand);
  elements.input.dir = isCommand ? "ltr" : "auto";
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 130)}px`;
  elements.remaining.textContent = String(500 - elements.input.value.length);
}

elements.nameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const chosenName = normalizeName(elements.nameInput.value);
  if (chosenName.length < 2) {
    elements.nameError.textContent = "اكتب اسمًا من حرفين على الأقل.";
    return;
  }

  if (!accessVerified) {
    const accessCode = elements.accessCodeInput.value;
    try {
      await enterChat(chosenName, accessCode);
    } catch (error) {
      console.error(error);
      elements.nameError.textContent = error.message?.includes("ACCESS_DENIED")
        ? "رمز الغرفة غير صحيح."
        : "تعذر إنشاء جلسة آمنة.";
      return;
    }
  } else {
    username = chosenName;
    localStorage.setItem("global-chat-name", username);
    updateIdentity();
    if (roomChannel) await trackPresence();
  }
  elements.nameDialog.close();
  elements.input.focus();
});

elements.nameDialog.addEventListener("cancel", (event) => {
  if (!username) event.preventDefault();
});

elements.changeName.addEventListener("click", askForName);
elements.lockedComposer.addEventListener("click", async () => {
  const password = window.prompt("أدخل كلمة الإدارة لفك القفل أو تنفيذ الأوامر:");
  if (!password) return;
  const { data, error } = await client.rpc("admin_auth", { p_secret: password });
  if (error || !data) {
    showToast("كلمة الإدارة غير صحيحة.");
    return;
  }
  adminSecret = password;
  sessionStorage.setItem("chat-admin-secret", adminSecret);
  applyLockState(chatLocked);
  elements.input.focus();
  showToast("صلاحية الإدارة مفعلة. استخدم /unlock لفتح المحادثة.");
});
elements.closeCommandDialog.addEventListener("click", () => elements.commandDialog.close());
elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});
elements.input.addEventListener("input", () => {
  resizeInput();
  updateLocalTyping();
});
elements.input.addEventListener("blur", stopTyping);
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopTyping();
  if (!document.hidden) {
    unreadCount = 0;
    document.title = "جمعة | Global Chat";
  }
});

updateIdentity();
setChatAccess(false);
resizeInput();
startChat();
