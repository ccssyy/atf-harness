/* 批⑬ v2 WebUI 前端（零依赖 vanilla；渲染树来自服务端纯函数单源 renderChatEvent）。 */
const state = { sessions: [], current: null, cursor: 0, pendingCardSeq: null };

const $ = (selector) => document.querySelector(selector);

async function api(path, options) {
  const res = await fetch(path, options);
  return res.json();
}

function renderSessionList() {
  const list = $("#session-list");
  list.innerHTML = "";
  for (const session of state.sessions) {
    const item = document.createElement("div");
    item.className = "session-item" + (session.id === state.current ? " active" : "");
    const stateText = session.state === "running" ? "训练中…" : session.state === "completed" ? "已完成" : session.state === "awaiting_confirm" ? "待确认" : "已暂停";
    item.innerHTML = `<div>${session.title}</div><div class="state-line">${stateText}</div>` +
      (session.resultSummary !== undefined ? `<div class="result-line">${session.resultSummary}</div>` : "");
    item.onclick = () => selectSession(session.id);
    list.appendChild(item);
  }
}

function selectSession(id) {
  state.current = id;
  state.cursor = 0;
  $("#chat").innerHTML = "";
  renderSessionList();
  pollEvents();
}

async function pollEvents() {
  if (state.current === null) return;
  const data = await api(`/api/sessions/${state.current}/events?since=${String(state.cursor)}`);
  const chat = $("#chat");
  for (const event of data.events) {
    state.cursor = Math.max(state.cursor, event.seq);
    const wrap = document.createElement("div");
    wrap.innerHTML = event.html;
    const node = wrap.firstElementChild;
    if (node !== null) {
      wireButtons(node);
      chat.appendChild(node);
      chat.scrollTop = chat.scrollHeight;
      if (node.classList.contains("confirm_card") && node.querySelector("[data-action='confirm']") !== null) state.pendingCardSeq = event.seq;
    }
  }
  refreshSessions();
}

async function refreshSessions() {
  const data = await api("/api/sessions");
  state.sessions = data.sessions;
  renderSessionList();
}

function wireButtons(node) {
  for (const button of node.querySelectorAll("button[data-action]")) {
    button.onclick = async () => {
      if (state.current === null) return;
      const action = button.dataset.action;
      if (action === "confirm" || action === "danger-confirm") {
        await api(`/api/sessions/${state.current}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: action === "danger-confirm" ? "confirm" : "confirm" }) });
      } else if (action === "danger-deny") {
        await api(`/api/sessions/${state.current}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "deny" }) });
      } else {
        await api(`/api/sessions/${state.current}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "edit" }) });
      }
      pollEvents();
    };
  }
}

async function sendText() {
  const input = $("#input");
  const text = input.value.trim();
  if (text === "" || state.current !== null) {
    if (text !== "") {
      await api(`/api/sessions/${state.current}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      input.value = "";
      $("#intent-panel").classList.add("hidden");
      pollEvents();
    }
    return;
  }
}

async function newTask() {
  const data = await api("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  await refreshSessions();
  selectSession(data.id);
}

async function refreshGpu() {
  const data = await api("/api/gpu");
  const gpu = data.gpu;
  const dot = $("#gpu-dot");
  const text = $("#gpu-text");
  if (gpu === null || gpu.gpu_offline === true) {
    dot.className = "dot red";
    text.textContent = "离线";
  } else {
    dot.className = "dot green";
    text.textContent = `${gpu.utilization} · ${gpu.memoryUsed}/${gpu.memoryTotal}`;
  }
}

$("#new-task").onclick = newTask;
$("#input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendText();
  }
});
$("#input").addEventListener("input", (event) => {
  const value = event.target.value;
  if (value === "/") $("#intent-panel").classList.remove("hidden");
  else $("#intent-panel").classList.add("hidden");
});
for (const item of document.querySelectorAll(".intent-item")) {
  item.onclick = () => {
    $("#input").value = item.dataset.fill;
    $("#intent-panel").classList.add("hidden");
    $("#input").focus();
  };
}

setInterval(pollEvents, 3_000);
setInterval(refreshGpu, 30_000);
void newTask().then(() => {
  refreshGpu();
  refreshSessions();
});
