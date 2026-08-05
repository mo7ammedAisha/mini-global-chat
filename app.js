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
  nameError: document.querySelector("#nameError"),
  commandDialog: document.querySelector("#commandDialog"),
  commandOutput: document.querySelector("#commandOutput"),
  closeCommandDialog: document.querySelector("#closeCommandDialog"),
  typingIndicator: document.querySelector("#typingIndicator"),
  typingText: document.querySelector("#typingText"),
  toast: document.querySelector("#toast"),
};

let username = localStorage.getItem("global-chat-name") || "";
let client = null;
let sending = false;
let toastTimer = null;
let adminSecret = sessionStorage.getItem("chat-admin-secret") || "";
let chatSessionToken = sessionStorage.getItem("chat-session-token") || "";
let accessVerified = false;
let chatLocked = true;
let whitelistEnabled = true;
let sessionAllowed = false;
let sessionIsAdmin = false;
let sessionShortId = "";
let commandOnlyMode = true;
let pollingTimer = null;
let notificationsEnabled = localStorage.getItem("chat-notifications") === "true";
let soundEnabled = localStorage.getItem("chat-sound") === "true";
let audioContext = null;
let unreadCount = 0;
let typingStopTimer = null;
let lastTypingBroadcast = 0;
let typingBroadcastActive = false;
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

function renderTypingIndicator(typingNames = []) {
  const names = [...new Set(typingNames)].filter((name) => name !== username);
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

async function broadcastTyping(isTyping) {
  if (!accessVerified || !chatSessionToken || !sessionAllowed || chatLocked) return;
  const { error } = await client.rpc("set_chat_typing", {
    p_session_token: chatSessionToken,
    p_is_typing: isTyping,
  });
  if (error && !error.message?.includes("SESSION_NOT_ALLOWED")) console.error(error);
}

function setChatAccess(enabled) {
  accessVerified = enabled;
  applyPermissionState();
}

function applyPermissionState() {
  const canRead = accessVerified && (sessionIsAdmin || !whitelistEnabled || sessionAllowed);
  commandOnlyMode = accessVerified && ((chatLocked && !sessionIsAdmin) || !canRead);
  elements.input.disabled = !accessVerified;
  elements.send.disabled = !accessVerified;
  elements.form.classList.toggle("is-locked", chatLocked || !canRead);

  if (!canRead) {
    elements.input.placeholder = `بانتظار الموافقة (${sessionShortId || "..."}) — الأوامر فقط مثل /admin`;
  } else if (chatLocked && !sessionIsAdmin) {
    elements.input.placeholder = "المحادثة مقفلة — الأوامر فقط مثل /admin أو /unlock";
  } else if (chatLocked && sessionIsAdmin) {
    elements.input.placeholder = "وضع المدير — المحادثة مقفلة أمام المستخدمين";
  } else {
    elements.input.placeholder = "اكتب شيئًا للمجموعة...";
  }

  if (chatLocked || !canRead) {
    stopTyping();
    renderTypingIndicator([]);
  }
}

function applyLockState(locked) {
  chatLocked = locked;
  applyPermissionState();
}

async function validateStoredSession() {
  const { data, error } = await client.rpc("validate_chat_session", { p_session_token: chatSessionToken });
  if (error) throw error;
  return data;
}

async function openChatSession(chosenName) {
  const { data, error } = await client.rpc("open_chat_session", {
    p_username: chosenName,
    p_visitor_id: visitorId,
  });
  if (error) throw error;
  chatSessionToken = data.token;
  sessionShortId = data.short_id;
  sessionStorage.setItem("chat-session-token", chatSessionToken);
}

async function enterChat(chosenName) {
  await openChatSession(chosenName);
  username = chosenName;
  localStorage.setItem("global-chat-name", username);
  setChatAccess(true);
  updateIdentity();
  await refreshChatState();
  if (sessionAllowed || !whitelistEnabled) await loadMessages({ forceScroll: true });
  startPolling();
  return true;
}

function updateLocalTyping() {
  if (commandOnlyMode) {
    stopTyping();
    return;
  }
  const isTyping = Boolean(elements.input.value.trim());
  clearTimeout(typingStopTimer);

  if (!isTyping) {
    stopTyping();
    return;
  }

  const now = Date.now();
  if (!typingBroadcastActive || now - lastTypingBroadcast > 900) {
    broadcastTyping(true).catch(console.error);
    typingBroadcastActive = true;
    lastTypingBroadcast = now;
  }
  typingStopTimer = setTimeout(stopTyping, 1600);
}

function stopTyping() {
  clearTimeout(typingStopTimer);
  typingStopTimer = null;
  if (typingBroadcastActive) broadcastTyping(false).catch(console.error);
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

async function refreshChatState() {
  if (!accessVerified || !chatSessionToken) return;
  const { data, error } = await client.rpc("get_chat_state", { p_session_token: chatSessionToken });
  if (error) {
    if (error.message?.includes("SESSION_INVALID")) {
      setChatAccess(false);
      sessionStorage.removeItem("chat-session-token");
      chatSessionToken = "";
      askForName();
    }
    return;
  }
  const wasAllowed = sessionAllowed || !whitelistEnabled;
  chatLocked = data.locked === true;
  whitelistEnabled = data.whitelist_enabled === true;
  sessionAllowed = data.allowed === true;
  sessionIsAdmin = data.is_admin === true;
  sessionShortId = data.short_id || sessionShortId;
  elements.onlineCount.textContent = data.active_names?.length || 0;
  renderTypingIndicator(data.typing_names || []);
  applyPermissionState();

  if (!wasAllowed && sessionAllowed) {
    await loadMessages({ forceScroll: true });
    showToast("وافق المدير على جلستك. يمكنك استخدام المحادثة الآن.");
  }
  setConnection("online", whitelistEnabled && !sessionAllowed ? "بانتظار الموافقة" : "متصل الآن");
}

function startPolling() {
  clearInterval(pollingTimer);
  refreshChatState();
  pollingTimer = setInterval(async () => {
    if (!accessVerified) return;
    try {
      await refreshChatState();
      if (sessionAllowed || !whitelistEnabled) await loadMessages({ notifyNew: true });
    } catch (error) {
      console.error(error);
    }
  }, 2500);
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
    if (username && chatSessionToken) {
      const sessionInfo = await validateStoredSession();
      if (!sessionInfo) throw new Error("SESSION_INVALID");
      username = sessionInfo.username;
      sessionAllowed = sessionInfo.allowed === true;
      sessionIsAdmin = sessionInfo.is_admin === true;
      sessionShortId = sessionInfo.short_id || "";
      setChatAccess(true);
      updateIdentity();
      await refreshChatState();
      if (sessionAllowed || !whitelistEnabled) await loadMessages({ forceScroll: true });
      startPolling();
    } else {
      chatSessionToken = "";
      sessionStorage.removeItem("chat-session-token");
      askForName();
    }
  } catch (error) {
    console.error(error);
    if (error.message?.includes("SESSION_INVALID")) {
      chatSessionToken = "";
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

  if ((chatLocked && !sessionIsAdmin) || (whitelistEnabled && !sessionAllowed && !sessionIsAdmin)) {
    showToast(chatLocked ? "المحادثة مقفلة." : "بانتظار موافقة المدير على جلستك.");
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
    } else if (message.includes("SESSION_NOT_ALLOWED")) {
      sessionAllowed = false;
      applyPermissionState();
      showToast("هذه الجلسة غير مسموح لها بالكتابة.");
    } else if (message.includes("SESSION_INVALID")) {
      setChatAccess(false);
      chatSessionToken = "";
      sessionStorage.removeItem("chat-session-token");
      showToast("انتهت جلسة المحادثة. ادخل باسمك مجددًا.");
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

function showCommandOutput(title, lines) {
  elements.commandOutput.textContent = `${title}\n${"-".repeat(Math.min(title.length, 36))}\n${lines.join("\n")}`;
  elements.commandOutput.hidden = false;
  if (!elements.commandDialog.open) elements.commandDialog.showModal();
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
    const { data, error } = await client.rpc("admin_elevate_session", {
      p_secret: argument,
      p_session_token: chatSessionToken,
    });
    if (error || !data) {
      console.error(error);
      showToast("كلمة الإدارة غير صحيحة.");
      return;
    }
    adminSecret = argument;
    sessionIsAdmin = true;
    sessionAllowed = true;
    sessionStorage.setItem("chat-admin-secret", adminSecret);
    applyPermissionState();
    showToast("تم تفعيل صلاحيات المدير لهذه الجلسة.");
    return;
  }

  if (command === "/logout") {
    await client.rpc("admin_demote_session", { p_session_token: chatSessionToken });
    adminSecret = "";
    sessionIsAdmin = false;
    sessionStorage.removeItem("chat-admin-secret");
    applyPermissionState();
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

  if (command === "/white") {
    if (argument !== "on" && argument !== "off") return showToast("الاستخدام: /white on أو /white off");
    const enabled = argument === "on";
    const result = await callAdmin("admin_set_whitelist", { p_enabled: enabled });
    if (result.ok) {
      whitelistEnabled = enabled;
      await refreshChatState();
      showToast(enabled ? "تم تفعيل القائمة البيضاء." : "تم السماح لجميع الجلسات.");
    }
    return;
  }

  if (command === "/active") {
    const result = await callAdmin("admin_list_active_sessions");
    if (result.ok) {
      const lines = result.data.length
        ? result.data.map((session) => `${session.short_id}  ${session.allowed ? "ALLOW" : "WAIT "}  ${session.username}`)
        : ["No active sessions"];
      showCommandOutput("ACTIVE SESSIONS", lines);
    }
    return;
  }

  if (command === "/allowed") {
    const result = await callAdmin("admin_list_allowed_sessions");
    if (result.ok) {
      const lines = result.data.length
        ? result.data.map((session) => `${session.short_id}  ${session.username}`)
        : ["No allowed sessions"];
      showCommandOutput("ALLOWED SESSIONS", lines);
    }
    return;
  }

  if (command === "/allow" || command === "/revoke") {
    if (!argument) return showToast(`الاستخدام: ${command} ID`);
    const allow = command === "/allow";
    const result = await callAdmin("admin_set_session_allowed", {
      p_identifier: argument,
      p_allowed: allow,
    });
    if (result.ok) {
      await refreshChatState();
      showToast(result.data ? (allow ? "تم السماح للجلسة." : "تم سحب السماح.") : "لم توجد جلسة مطابقة.");
    }
    return;
  }

  if (command === "/allowall" || command === "/revokeall") {
    const allow = command === "/allowall";
    const result = await callAdmin("admin_set_all_sessions_allowed", { p_allowed: allow });
    if (result.ok) {
      await refreshChatState();
      showToast(`${allow ? "سُمح" : "سُحب السماح من"} ${result.data} جلسة.`);
    }
    return;
  }

  if (command === "/clearrequests") {
    if (!window.confirm("حذف جميع جلسات الانتظار؟ قد تنتهي جلستك إن لم تكن مسموحة.")) return;
    const result = await callAdmin("admin_clear_pending_sessions");
    if (result.ok) showToast(`حُذفت ${result.data} جلسة انتظار.`);
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
    try {
      await enterChat(chosenName);
    } catch (error) {
      console.error(error);
      elements.nameError.textContent = error.message?.includes("SESSION_CREATION_LIMIT")
        ? "طلبات الدخول كثيرة حاليًا. حاول بعد دقيقة."
        : "تعذر إنشاء جلسة آمنة.";
      return;
    }
  } else {
    const { error } = await client.rpc("rename_chat_session", {
      p_session_token: chatSessionToken,
      p_username: chosenName,
    });
    if (error) {
      elements.nameError.textContent = "تعذر تغيير الاسم.";
      return;
    }
    username = chosenName;
    localStorage.setItem("global-chat-name", username);
    updateIdentity();
  }
  elements.nameDialog.close();
  elements.input.focus();
});

elements.nameDialog.addEventListener("cancel", (event) => {
  if (!username) event.preventDefault();
});

elements.changeName.addEventListener("click", askForName);
elements.closeCommandDialog.addEventListener("click", () => elements.commandDialog.close());
elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});
elements.input.addEventListener("input", () => {
  const value = elements.input.value.trimStart();
  if (commandOnlyMode && value && !value.startsWith("/") && !value.startsWith("\\")) {
    elements.input.value = "";
    showToast("وضع الأوامر فقط: ابدأ بـ / مثل /admin");
  }
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
