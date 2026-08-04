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
  toast: document.querySelector("#toast"),
};

let username = localStorage.getItem("global-chat-name") || "";
let client = null;
let roomChannel = null;
let sending = false;
let toastTimer = null;
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
  if (!message?.id || renderedMessages.has(message.id)) return;
  renderedMessages.add(message.id);
  elements.emptyState.hidden = true;

  const article = document.createElement("article");
  article.className = "message";
  article.dataset.username = message.username;
  if (message.username === username) article.classList.add("is-mine");
  if (!animate) article.style.animation = "none";

  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.textContent = message.username.charAt(0).toUpperCase();
  avatar.style.setProperty("--avatar", avatarColor(message.username));

  const content = document.createElement("div");
  const head = document.createElement("div");
  head.className = "message-head";
  const author = document.createElement("strong");
  author.textContent = message.username;
  author.dir = "auto";
  const time = document.createElement("time");
  time.dateTime = message.created_at;
  time.textContent = messageTime(message.created_at);
  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = message.content;
  body.dir = "auto";

  head.append(author, time);
  content.append(head, body);
  article.append(avatar, content);
  elements.messages.append(article);
}

function scrollToLatest(behavior = "smooth") {
  elements.messages.scrollTo({ top: elements.messages.scrollHeight, behavior });
}

async function loadMessages() {
  const { data, error } = await client
    .from("messages")
    .select("id, username, content, created_at")
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
  const content = elements.input.value.trim();
  if (!content || !client || sending) return;

  sending = true;
  elements.send.disabled = true;
  const draft = elements.input.value;
  elements.input.value = "";
  resizeInput();

  const { data, error } = await client
    .from("messages")
    .insert({ username, content })
    .select("id, username, content, created_at")
    .single();

  sending = false;
  elements.send.disabled = false;
  if (error) {
    console.error(error);
    elements.input.value = draft;
    resizeInput();
    showToast("لم تُرسل الرسالة. حاول مرة أخرى.");
    return;
  }

  createMessage(data);
  scrollToLatest();
  elements.input.focus();
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
