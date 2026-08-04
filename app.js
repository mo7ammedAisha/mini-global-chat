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
  closeCommandDialog: document.querySelector("#closeCommandDialog"),
  toast: document.querySelector("#toast"),
};

let username = localStorage.getItem("global-chat-name") || "";
let client = null;
let roomChannel = null;
let sending = false;
let toastTimer = null;
let adminSecret = sessionStorage.getItem("chat-admin-secret") || "";
const renderedMessages = new Set();
const sessionId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;

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
  content.append(head, body);
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

async function loadMessages() {
  const { data, error } = await client
    .from("messages")
    .select("id, username, content, kind, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  data.reverse().forEach((message) => createMessage(message, false));
  scrollToLatest("instant");
}

function connectRealtime() {
  roomChannel = client
    .channel("global-room", { config: { presence: { key: sessionId } } })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
      const nearBottom =
        elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 120;
      createMessage(payload.new);
      if (nearBottom || payload.new.username === username) scrollToLatest();
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, (payload) => {
      removeMessage(payload.old.id);
    })
    .on("presence", { event: "sync" }, () => {
      const state = roomChannel.presenceState();
      elements.onlineCount.textContent = Object.values(state).flat().length;
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        setConnection("online", "متصل الآن");
        await roomChannel.track({ name: username, joinedAt: new Date().toISOString() });
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
    await loadMessages();
    connectRealtime();
  } catch (error) {
    console.error(error);
    setConnection("error", "تعذر الاتصال");
    showToast("تعذر تحميل الرسائل. تحقق من إعداد Supabase.");
  }
}

async function sendMessage() {
  const rawContent = elements.input.value.trim();
  if (!rawContent || !client || sending) return;

  if (rawContent.startsWith("/")) {
    elements.input.value = "";
    resizeInput();
    await executeCommand(rawContent);
    elements.input.focus();
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
    p_username: username,
    p_content: content,
    p_kind: kind,
  });

  sending = false;
  elements.send.disabled = false;
  if (error) {
    console.error(error);
    if (kind === "message") elements.input.value = draft;
    resizeInput();
    const locked = error.message?.includes("CHAT_LOCKED");
    showToast(locked ? "المحادثة مقفلة حاليًا بواسطة المدير." : "لم تُرسل الرسالة. حاول مرة أخرى.");
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
    username = newName;
    localStorage.setItem("global-chat-name", username);
    updateIdentity();
    if (roomChannel) await roomChannel.track({ name: username, joinedAt: new Date().toISOString() });
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
    showToast("تم تفعيل صلاحيات المدير لهذه الجلسة.");
    return;
  }

  if (command === "/logout") {
    adminSecret = "";
    sessionStorage.removeItem("chat-admin-secret");
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
    if (result.ok) showToast(locked ? "تم قفل المحادثة." : "تم فتح المحادثة.");
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

  showToast("أمر غير معروف. استخدم /help");
}

function resizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 130)}px`;
  elements.remaining.textContent = String(500 - elements.input.value.length);
}

elements.nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const chosenName = normalizeName(elements.nameInput.value);
  if (chosenName.length < 2) {
    elements.nameError.textContent = "اكتب اسمًا من حرفين على الأقل.";
    return;
  }

  username = chosenName;
  localStorage.setItem("global-chat-name", username);
  updateIdentity();
  elements.nameDialog.close();
  if (roomChannel) roomChannel.track({ name: username, joinedAt: new Date().toISOString() });
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
elements.input.addEventListener("input", resizeInput);
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

updateIdentity();
resizeInput();
if (!username) askForName();
startChat();
