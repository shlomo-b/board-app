const boardSelect = document.getElementById("board-select");
const boardEl = document.getElementById("board");
const statusEl = document.getElementById("status");
const createCardBtn = document.getElementById("create-card");
const createBoardBtn = document.getElementById("create-board");
const deleteBoardBtn = document.getElementById("delete-board");
const modal = document.getElementById("modal");
const modalForm = document.getElementById("modal-form");
const modalTitle = document.getElementById("modal-title");
const modalFields = document.getElementById("modal-fields");
const modalDelete = document.getElementById("modal-delete");
const modalCancel = document.getElementById("modal-cancel");
const themeToggle = document.getElementById("theme-toggle");

let boards = [];
let current = null;
let modalMode = null;
let editingCard = null;
let suppressClick = false;

function timeRow(label, iso) {
  const when = formatTime(iso);
  if (!when) return null;
  const row = document.createElement("div");
  row.className = "card-time";
  const name = document.createElement("span");
  name.className = "card-time-label";
  name.textContent = label;
  const value = document.createElement("span");
  value.className = "card-time-value";
  value.textContent = when;
  row.append(name, value);
  return row;
}

function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function uid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const rnd = Math.random() * 16 | 0;
    const value = ch === "x" ? rnd : (rnd & 0x3) | 0x8;
    return value.toString(16);
  });
}

function applyTheme(dark) {
  document.documentElement.classList.toggle("dark", dark);
  localStorage.setItem("board-theme", dark ? "dark" : "light");
  themeToggle.checked = dark;
}

applyTheme(localStorage.getItem("board-theme") === "dark");
themeToggle.addEventListener("change", () => applyTheme(themeToggle.checked));

function showStatus(message) {
  statusEl.hidden = !message;
  statusEl.textContent = message || "";
}

const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
function renderMongoStatus(mongo) {
  const el = document.getElementById("mongo-status");
  const info = mongo || {};
  const name = info.name === "mongodb-atlas" ? "mongodb-atlas" : "mongodb";
  const connected = Boolean(info.connected);
  el.textContent = `${name}: ${connected ? "Connected" : "Disconnected"}`;
  el.classList.toggle("down", !connected);
}

function showLogin() {
  loginScreen.hidden = false;
  appScreen.hidden = true;
}

function showApp(user, mongo) {
  loginScreen.hidden = true;
  appScreen.hidden = false;
  document.getElementById("welcome-user").textContent = user ? `Welcome, ${user}` : "";
  renderMongoStatus(mongo);
  startIdleWatch();
}

const AUTO_LOGOUT_TIME = 3 * 60 * 1000;
const WARNING_TIME = 30 * 1000;
const idle = { timer: null, warningTimer: null, lastActivity: Date.now(), warningOpen: false, running: false };

function openIdleWarning() {
  idle.warningOpen = true;
  closeModal();
  const dialog = document.getElementById("idle-dialog");
  if (!dialog.open) dialog.showModal();
}

function closeIdleWarning() {
  const dialog = document.getElementById("idle-dialog");
  if (dialog.open) dialog.close();
}

function stopIdleWatch() {
  idle.running = false;
  idle.warningOpen = false;
  clearTimeout(idle.timer);
  clearTimeout(idle.warningTimer);
  closeIdleWarning();
  window.removeEventListener("mousemove", onActivity);
  window.removeEventListener("keydown", onActivity);
  window.removeEventListener("mousedown", onActivity);
  window.removeEventListener("touchstart", onActivity);
  window.removeEventListener("scroll", onActivity);
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("focus", onFocus);
}

function idleExpired() {
  return Date.now() - idle.lastActivity >= AUTO_LOGOUT_TIME;
}

function resetIdleTimer() {
  if (!idle.running) return;
  idle.lastActivity = Date.now();
  clearTimeout(idle.timer);
  clearTimeout(idle.warningTimer);
  if (idle.warningOpen) {
    idle.warningOpen = false;
    closeIdleWarning();
  }
  idle.timer = setTimeout(leaveApp, AUTO_LOGOUT_TIME);
  idle.warningTimer = setTimeout(openIdleWarning, AUTO_LOGOUT_TIME - WARNING_TIME);
}

function onActivity() {
  resetIdleTimer();
}

function onVisibility() {
  if (document.visibilityState !== "visible") return;
  if (idleExpired()) leaveApp();
  else resetIdleTimer();
}

function onFocus() {
  if (idleExpired()) leaveApp();
  else resetIdleTimer();
}

function startIdleWatch() {
  stopIdleWatch();
  idle.running = true;
  window.addEventListener("mousemove", onActivity);
  window.addEventListener("keydown", onActivity);
  window.addEventListener("mousedown", onActivity);
  window.addEventListener("touchstart", onActivity);
  window.addEventListener("scroll", onActivity);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  resetIdleTimer();
}

async function leaveApp() {
  stopIdleWatch();
  closeModal();
  try {
    await api("/api/logout", { method: "POST" });
  } catch (_err) {
    /* already signed out */
  }
  current = null;
  document.getElementById("username").value = "";
  document.getElementById("password").value = "";
  document.getElementById("welcome-user").textContent = "";
  showLogin();
}

async function api(path, options) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (response.status === 401 && path !== "/api/login") {
    showLogin();
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = body.detail || detail;
    } catch (_err) {
      /* keep status text */
    }
    throw new Error(detail);
  }
  if (response.status === 204) return null;
  return response.json();
}

function fillSelect() {
  boardSelect.innerHTML = "";
  if (!boards.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No boards yet";
    boardSelect.appendChild(option);
    return;
  }
  for (const board of boards) {
    const option = document.createElement("option");
    option.value = board.id;
    option.textContent = board.name;
    if (current && board.id === current.id) option.selected = true;
    boardSelect.appendChild(option);
  }
}

function render() {
  boardEl.innerHTML = "";
  createCardBtn.disabled = !current;
  deleteBoardBtn.hidden = !current;
  if (!current) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Create a board to start.";
    boardEl.appendChild(empty);
    return;
  }
  current.columns.forEach((column, columnIndex) => {
    const columnEl = document.createElement("section");
    columnEl.className = "column";
    columnEl.dataset.index = String(columnIndex);

    const head = document.createElement("div");
    head.className = "column-head";
    const name = document.createElement("h2");
    name.className = "column-name";
    name.textContent = column.name;
    const pencil = document.createElement("button");
    pencil.className = "icon-btn";
    pencil.type = "button";
    pencil.title = "Rename column";
    pencil.setAttribute("aria-label", `Rename ${column.name}`);
    pencil.textContent = "✎";
    pencil.addEventListener("click", () => startRename(columnIndex, head, name, pencil));
    head.append(name, pencil);

    const cards = document.createElement("div");
    cards.className = "cards";
    cards.addEventListener("dragover", (event) => {
      event.preventDefault();
      columnEl.classList.add("over");
    });
    cards.addEventListener("dragleave", () => columnEl.classList.remove("over"));
    cards.addEventListener("drop", (event) => onDrop(event, columnIndex));

    column.cards.forEach((card, cardIndex) => {
      const cardEl = document.createElement("article");
      cardEl.className = "card";
      cardEl.draggable = true;
      const times = document.createElement("div");
      times.className = "card-times";
      const opened = timeRow("Opened", card.createdAt);
      if (opened) times.appendChild(opened);
      if (times.childElementCount) cardEl.appendChild(times);
      const titleEl = document.createElement("div");
      titleEl.className = "card-title";
      titleEl.textContent = card.title;
      cardEl.appendChild(titleEl);
      if (card.task) {
        const taskEl = document.createElement("div");
        taskEl.className = "card-task";
        const label = document.createElement("span");
        label.className = "card-kicker";
        label.textContent = "Task";
        const value = document.createElement("span");
        value.className = "card-task-value";
        value.textContent = card.task;
        taskEl.append(label, value);
        cardEl.appendChild(taskEl);
      }
      const actions = document.createElement("div");
      actions.className = "card-actions";
      actions.append(
        cardAction("Edit", () => openCard(columnIndex, cardIndex)),
        cardAction("Clone", () => cloneCard(columnIndex, cardIndex)),
      );
      cardEl.appendChild(actions);
      cardEl.addEventListener("dragstart", (event) => {
        suppressClick = true;
        cardEl.classList.add("dragging");
        event.dataTransfer.setData("text/plain", `${columnIndex}:${cardIndex}`);
        event.dataTransfer.effectAllowed = "move";
      });
      cardEl.addEventListener("dragend", () => cardEl.classList.remove("dragging"));
      cardEl.addEventListener("click", () => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        openCard(columnIndex, cardIndex);
      });
      cards.appendChild(cardEl);
    });

    columnEl.append(head, cards);
    boardEl.appendChild(columnEl);
  });
}

function startRename(columnIndex, head, nameEl, pencil) {
  const input = document.createElement("input");
  input.className = "column-name-input";
  input.value = current.columns[columnIndex].name;
  input.maxLength = 60;
  nameEl.replaceWith(input);
  pencil.hidden = true;
  input.focus();
  input.select();

  const finish = async (save) => {
    input.removeEventListener("blur", onBlur);
    input.removeEventListener("keydown", onKey);
    const next = input.value.trim();
    if (save && next && next !== current.columns[columnIndex].name) {
      current.columns[columnIndex].name = next;
      const ok = await persist();
      if (!ok) return;
    }
    render();
  };
  const onBlur = () => finish(true);
  const onKey = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      finish(false);
    }
  };
  input.addEventListener("blur", onBlur);
  input.addEventListener("keydown", onKey);
}

async function onDrop(event, targetColumn) {
  event.preventDefault();
  const raw = event.dataTransfer.getData("text/plain");
  const [fromColumn, fromCard] = raw.split(":").map(Number);
  document.querySelectorAll(".column.over").forEach((el) => el.classList.remove("over"));
  if (Number.isNaN(fromColumn) || Number.isNaN(fromCard)) return;
  const [card] = current.columns[fromColumn].cards.splice(fromCard, 1);
  if (!card) return;
  current.columns[targetColumn].cards.push(card);
  render();
  await persist();
}

async function persist() {
  try {
    current = await api(`/api/boards/${current.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: current.name, columns: current.columns }),
    });
    showStatus("");
    return true;
  } catch (err) {
    showStatus(`Could not save to Atlas: ${err.message}`);
    await loadBoard(current.id);
    return false;
  }
}

async function loadBoards(selectId) {
  boards = await api("/api/boards");
  if (selectId) {
    await loadBoard(selectId);
  } else if (boards.length) {
    await loadBoard(boards[0].id);
  } else {
    current = null;
    fillSelect();
    render();
  }
}

async function loadBoard(id) {
  current = await api(`/api/boards/${id}`);
  fillSelect();
  render();
}

function field(label, id, tag, value, extra) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const lab = document.createElement("label");
  lab.htmlFor = id;
  lab.textContent = label;
  const input = document.createElement(tag);
  input.id = id;
  input.value = value || "";
  Object.assign(input, extra);
  wrap.append(lab, input);
  return wrap;
}

function openModal({ title, mode, card, allowDelete, values }) {
  modalMode = mode;
  editingCard = card || null;
  modalTitle.textContent = title;
  modalFields.innerHTML = "";
  const data = values || {};
  if (mode === "board") {
    modalFields.appendChild(field("Board name", "field-name", "input", data.name, { required: true, maxLength: 80, autocomplete: "off" }));
  } else {
    const times = document.createElement("div");
    times.className = "card-times";
    const opened = timeRow("Opened", data.createdAt);
    if (opened) times.appendChild(opened);
    if (times.childElementCount) modalFields.appendChild(times);
    modalFields.appendChild(field("Title", "field-title", "input", data.title, { required: true, maxLength: 200, autocomplete: "off" }));
    modalFields.appendChild(field("Task", "field-task", "input", data.task, { maxLength: 200, autocomplete: "off" }));
  }
  modalDelete.hidden = !allowDelete;
  modal.hidden = false;
  modalFields.querySelector("input, textarea").focus();
}

function closeModal() {
  modal.hidden = true;
  modalMode = null;
  editingCard = null;
}

createBoardBtn.addEventListener("click", () => {
  openModal({ title: "Create board", mode: "board" });
});

createCardBtn.addEventListener("click", () => {
  if (!current) return;
  openModal({ title: "Create", mode: "card" });
});

deleteBoardBtn.addEventListener("click", async () => {
  if (!current) return;
  if (!confirm(`Delete board “${current.name}”?`)) return;
  try {
    await api(`/api/boards/${current.id}`, { method: "DELETE" });
    current = null;
    await loadBoards();
  } catch (err) {
    showStatus(err.message);
  }
});

function cardAction(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-action";
  button.textContent = label;
  button.draggable = false;
  button.addEventListener("mousedown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    suppressClick = false;
    onClick();
  });
  return button;
}

async function cloneCard(columnIndex, cardIndex) {
  const card = current.columns[columnIndex].cards[cardIndex];
  const copy = { id: uid(), title: card.title, task: card.task || "", createdAt: new Date().toISOString() };
  current.columns[columnIndex].cards.splice(cardIndex + 1, 0, copy);
  render();
  await persist();
}

async function openCard(columnIndex, cardIndex) {
  let card = current.columns[columnIndex].cards[cardIndex];
  if (!card.createdAt) {
    card.createdAt = new Date().toISOString();
    const ok = await persist();
    if (!ok) return;
    card = current.columns[columnIndex].cards[cardIndex];
    render();
  }
  openModal({
    title: "Edit task",
    mode: "edit-card",
    values: card,
    card: { columnIndex, cardIndex },
    allowDelete: true,
  });
}

modalCancel.addEventListener("click", closeModal);
modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});

modalDelete.addEventListener("click", async () => {
  if (!editingCard) return;
  current.columns[editingCard.columnIndex].cards.splice(editingCard.cardIndex, 1);
  closeModal();
  render();
  await persist();
});

modalForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (modalMode === "board") {
      const name = document.getElementById("field-name").value.trim();
      if (!name) return;
      const created = await api("/api/boards", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      closeModal();
      await loadBoards(created.id);
      return;
    }
    const title = document.getElementById("field-title").value.trim();
    const task = document.getElementById("field-task").value.trim();
    if (!title) return;
    const now = new Date().toISOString();
    if (modalMode === "card") {
      current.columns[0].cards.push({ id: uid(), title, task, createdAt: now });
    } else if (modalMode === "edit-card" && editingCard) {
      const target = current.columns[editingCard.columnIndex].cards[editingCard.cardIndex];
      target.title = title;
      target.task = task;
      delete target.updatedAt;
      if (!target.createdAt) target.createdAt = now;
      delete target.description;
    }
    closeModal();
    render();
    await persist();
  } catch (err) {
    showStatus(err.message);
  }
});

boardSelect.addEventListener("change", () => {
  if (boardSelect.value) loadBoard(boardSelect.value).catch((err) => showStatus(err.message));
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.getElementById("username").value,
        password: document.getElementById("password").value,
      }),
    });
    showApp(data.user, data.mongodb);
    await loadBoards();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  }
});

document.getElementById("logout").addEventListener("click", () => leaveApp());
document.getElementById("idle-stay").addEventListener("click", () => resetIdleTimer());
document.getElementById("idle-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  resetIdleTimer();
});

function showSamlLogin(enabled) {
  document.getElementById("saml-login").hidden = !enabled;
  document.getElementById("login-or").hidden = !enabled;
}

if (new URLSearchParams(window.location.search).get("sso") === "success") {
  window.history.replaceState({}, document.title, window.location.pathname);
}

fetch("/remote/saml/status")
  .then((res) => res.json())
  .then((data) => showSamlLogin(Boolean(data.enabled)))
  .catch(() => showSamlLogin(false));

api("/api/me")
  .then(async (me) => {
    showApp(me.user, me.mongodb);
    await loadBoards();
  })
  .catch(() => showLogin());
