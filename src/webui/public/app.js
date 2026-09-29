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
  rebuildMetrics();
  void refreshSelector(); // 选择器随会话切换刷新（模型清单随 provider）
}

async function pollEvents() {
  if (state.current === null) return;
  const data = await api(`/api/sessions/${state.current}/events?since=${String(state.cursor)}`);
  const chat = $("#chat");
  for (const event of data.events) {
    state.cursor = Math.max(state.cursor, event.seq);
    applyStreamingEvent(chat, event);
  }
  refreshSessions();
}

/** 批⑯prime B：流式事件增量渲染——思考灰字区逐段追加（完成后折叠）、正文增量、
 *  工具 live 卡两段式（start 建 live 卡→end 更新完成）。历史重放走同一函数（按 seq 顺序）。 */
function applyStreamingEvent(chat, event) {
  const kind = event.html.match(/class="msg (\w+)/)?.[1] ?? "";
  // —— 流式追加类：合并进既有流块而非新节点 ——
  if (kind === "thinking_delta") {
    let block = document.getElementById("live-thinking");
    if (block === null) {
      block = document.createElement("div");
      block.id = "live-thinking";
      block.className = "msg thinking_delta streaming";
      block.innerHTML = `<div class="thinking-block"><span class="thinking-label">思考中…</span> <span class="thinking-body"></span></div>`;
      chat.appendChild(block);
    }
    block.querySelector(".thinking-body").textContent += extractText(event.html);
    chat.scrollTop = chat.scrollHeight;
    return;
  }
  if (kind === "thinking_done") {
    const block = document.getElementById("live-thinking");
    if (block !== null) {
      const chars = (event.html.match(/已思考 (\d+) 字/) ?? [])[1] ?? "0";
      block.className = "msg thinking_done collapsed";
      block.innerHTML = `<div class="thinking-block folded">已思考 ${chars} 字 ▸</div>`;
      block.id = "folded-thinking-" + String(event.seq);
      block.onclick = () => block.classList.toggle("collapsed");
    }
    return;
  }
  if (kind === "text_delta") {
    let block = document.getElementById("live-text");
    if (block === null) {
      block = document.createElement("div");
      block.id = "live-text";
      block.className = "msg text_delta streaming";
      block.innerHTML = `<div class="text"></div>`;
      chat.appendChild(block);
    }
    block.querySelector(".text").textContent += extractText(event.html);
    chat.scrollTop = chat.scrollHeight;
    return;
  }
  // —— 工具两段式：start 建 live 卡；end 更新并解除 live ——
  if (kind === "tool_start") {
    const wrap = document.createElement("div");
    wrap.innerHTML = event.html;
    const node = wrap.firstElementChild;
    if (node !== null) {
      node.dataset.live = "1";
      chat.appendChild(node);
      chat.scrollTop = chat.scrollHeight;
    }
    return;
  }
  if (kind === "tool_end") {
    const live = chat.querySelector(".tool_card.live") ?? chat.querySelector(".tool_card");
    if (live !== null) {
      const title = live.querySelector(".card-title");
      if (title !== null) {
        const badge = event.html.includes("失败") ? `<span class="badge red">失败</span>` : `<span class="badge done-badge">完成</span>`;
        title.innerHTML = `${title.textContent?.split("⚙ tool:")[1]?.trim().split(" 运行中")[0] ?? ""} `.replace(/^\s+/, "⚙ tool: ") + badge;
        title.innerHTML = `⚙ tool: ${live.dataset.tool ?? ""} ${badge}`;
      }
      live.classList.remove("live");
      const result = document.createElement("div");
      result.className = "result";
      result.textContent = event.html.match(/<div class="result">([\s\S]*?)<\/div>/)?.[1] ?? "完成";
      live.appendChild(result);
      chat.scrollTop = chat.scrollHeight;
      return;
    }
  }
  // —— 其余组件：整卡渲染（既有路径） ——
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

function extractText(html) {
  const body = html.match(/<span class="thinking-body">([\s\S]*?)<\/span>/);
  if (body !== null) return body[1];
  const textDiv = html.match(/<div class="text">([\s\S]*?)<\/div>/);
  return textDiv?.[1] ?? "";
}

async function refreshSessions() {
  const data = await api("/api/sessions");
  // 批⑮：结果摘要行接真数据（atf_run_list 产物摘要——只读枚举，展示层拼接）
  try {
    const runs = (await api("/api/runs")).runs ?? [];
    for (const session of data.sessions) {
      const run = runs.find((candidate) => candidate.run_id === session.boundRunId);
      if (run !== undefined) session.resultSummary = (run.artifacts ?? []).slice(0, 2).join(" · ") || session.resultSummary;
    }
  } catch { /* runs 枚举失败不阻塞会话列表 */ }
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
      const monitor = $("#train-monitor");
      if (monitor !== null) monitor.classList.remove("hidden"); // 训练段起：切换到训练监控视图
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


// ---- 批⑭：选择器行 / 设置页五区 / 档位徽标 ----
const settingsState = { providers: [], defaultProvider: "", policy: null, profile: null, contextWindow: 200000, sessionModels: [] };

async function refreshSelector() {
  const data = await api("/api/settings/providers");
  settingsState.providers = data.providers;
  settingsState.defaultProvider = data.default_provider;
  const provider = data.providers.find((p) => p.id === data.default_provider) ?? data.providers[0];
  const select = $("#model-select");
  if (provider === undefined || select === null) return;
  settingsState.sessionModels = provider.models.map((m) => m.id);
  settingsState.contextWindow = (provider.models.find((m) => m.id === provider.default_model) ?? provider.models[0])?.context_window ?? 200000;
  select.innerHTML = "";
  for (const model of provider.models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.id;
    select.appendChild(option);
  }
  // 批⑯prime A：选择器会话创建即常显（用户第一句话前就要选模型——原 cursor>0 条件删除）
  $("#selector-row").classList.remove("hidden");
}

async function refreshContext() {
  if (state.current === null) return;
  const usage = await api(`/api/sessions/${state.current}/context`);
  const meter = $("#context-meter");
  if (meter === null || usage.used_tokens === undefined) return;
  const remainK = Math.round(usage.remaining_tokens / 1000);
  meter.textContent = `上下文: 剩余 ${String(remainK)}k`;
  $("#selector-row").classList.toggle("low", usage.low === true);
  if (usage.low === true) meter.textContent += "（建议新开会话或压缩）";
}

function renderProfileBadge() {
  const badge = $("#profile-badge");
  const labels = { first_train: "首训档", walkthrough: "走查档", demo: "演示档" };
  if (badge !== null && settingsState.profile !== null) badge.textContent = labels[settingsState.profile] ?? String(settingsState.profile);
}

async function openSettings() {
  $("#settings-view").classList.remove("hidden");
  const data = await api("/api/settings/providers");
  settingsState.providers = data.providers;
  settingsState.defaultProvider = data.default_provider;
  const approval = await api("/api/settings/approval");
  settingsState.policy = approval.approval_policy;
  const profileData = await api("/api/settings/profile");
  settingsState.profile = profileData.profile;
  const envData = await api("/api/settings/env-profile");
  renderProfileBadge();
  // 区 1 providers（key 只显 env 变量名＋尾4位）
  const list = $("#provider-list");
  list.innerHTML = "";
  for (const provider of data.providers) {
    const row = document.createElement("div");
    row.className = "provider-row";
    row.innerHTML = `<b>${provider.name}</b>（${provider.id}）· ${provider.base_url} · key: <code>${provider.api_key_env}</code>` +
      (provider.key_tail !== null ? `（尾4位 ${provider.key_tail}）` : "（未设 env）") +
      ` · 模型: ${provider.models.map((m) => m.id).join(", ")} ` +
      `<button class="btn" data-test="${provider.id}">[测试连接]</button>`;
    list.appendChild(row);
  }
  for (const button of list.querySelectorAll("button[data-test]")) {
    button.onclick = async () => {
      button.textContent = "测试中…";
      const result = await api(`/api/settings/providers/${button.dataset.test}/test`, { method: "POST" });
      const resultData = result.result;
      button.textContent = resultData.ok === true ? `✓ ${String(resultData.models.length)} 个模型` : `✗ ${resultData.reason}`;
    };
  }
  const defaultSelect = $("#default-provider");
  defaultSelect.innerHTML = "";
  for (const provider of data.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name;
    if (provider.id === data.default_provider) option.selected = true;
    defaultSelect.appendChild(option);
  }
  // 区 2 审批三档
  const policyList = $("#policy-list");
  policyList.innerHTML = "";
  for (const policy of approval.policies) {
    const row = document.createElement("div");
    row.className = "policy-row";
    row.innerHTML = `<input type="radio" name="policy" value="${policy.id}" ${policy.id === approval.approval_policy ? "checked" : ""}/> <b>${policy.label}</b> — ${policy.behavior}`;
    policyList.appendChild(row);
  }
  // 区 3 env-profile
  $("#env-train").value = envData.env_profile.train_env ?? "";
  $("#env-eval").value = envData.env_profile.eval_env ?? "";
  $("#env-gpu").value = envData.env_profile.gpu_visible_devices ?? "auto";
  $("#env-port").value = envData.env_profile.master_port ?? 29517;
  $("#env-model-dir").value = envData.env_profile.base_model_dir ?? "";
  $("#env-result").textContent = `回写路径: ${envData.write_path}`;
  // 区 4 profiles
  const profileList = $("#profile-list");
  profileList.innerHTML = "";
  for (const profile of profileData.profiles) {
    const row = document.createElement("div");
    row.className = "profile-row";
    row.innerHTML = `<input type="radio" name="profile" value="${profile.id}" ${profile.id === profileData.profile ? "checked" : ""}/> <b>${profile.label}</b><span class="profile-badge-current">${profile.notes}</span>`;
    profileList.appendChild(row);
  }
}

async function saveSettings() {
  const policy = document.querySelector("input[name='policy']:checked")?.value;
  if (policy !== undefined) await api("/api/settings/approval", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ approval_policy: policy }) });
  const profile = document.querySelector("input[name='profile']:checked")?.value;
  if (profile !== undefined) await api("/api/settings/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile }) });
  await api("/api/settings/providers", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ default_provider: $("#default-provider").value, providers: settingsState.providers }) });
  await refreshSelector();
  renderProfileBadge();
}

async function saveEnvProfile() {
  const result = await api("/api/settings/env-profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
    train_env: $("#env-train").value,
    eval_env: $("#env-eval").value,
    gpu_visible_devices: $("#env-gpu").value,
    master_port: Number($("#env-port").value),
    base_model_dir: $("#env-model-dir").value,
  }) });
  $("#env-result").textContent = `已保存（回写路径: ${result.written_path ?? result.env_profile.train_env}）——下次 run 生效`;
}

$("#open-settings").onclick = () => void openSettings();
$("#close-settings").onclick = () => { $("#settings-view").classList.add("hidden"); };
$("#env-save").onclick = () => void saveEnvProfile();
$("#env-test").onclick = () => { $("#env-result").textContent = "探测 venv python 可执行性——需 --peer real 环境（M1/M2 批接线）；当前为档案保存面。"; };
$("#model-select").onchange = () => {
  if (state.current === null) return;
  void api(`/api/sessions/${state.current}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `/model ${$("#model-select").value} effort ${$("#effort-select").value}` }) });
};
// /model 指令（服务端 system_notice 留痕）
const originalPoll = pollEvents;
setInterval(() => { if (settingsState.providers.length > 0) { refreshContext().catch(() => undefined); } }, 5_000);


// ---- 批⑯：监控数据面（文件重建 + SSE metrics_delta 增量）与 GPU 排队语义展示 ----
const metricsState = { points: [], tab: "loss" };

function renderLossChart() {
  const svg = document.getElementById("loss-svg");
  const legend = document.getElementById("loss-legend");
  if (svg === null) return;
  const points = metricsState.points;
  const series = metricsState.tab === "grad"
    ? [{ key: "grad_norm", color: "#16a34a", dash: "" }]
    : [
        { key: "train_loss", color: "#1d4ed8", dash: "" },
        { key: "eval_loss", color: "#94a3b8", dash: "3 2" },
      ];
  let html = "";
  for (const s of series) {
    const pts = points.filter((p) => p[s.key] !== undefined);
    if (pts.length === 0) continue;
    const values = pts.map((p) => p[s.key]);
    const max = Math.max(...values), min = Math.min(...values);
    const range = max - min || 1;
    const path = pts.map((p, i) => `${i === 0 ? "" : " "}${(i / Math.max(1, pts.length - 1)) * 100},${38 - ((p[s.key] - min) / range) * 34 - 2}`).join(" ");
    html += `<polyline points="${path}" fill="none" stroke="${s.color}" stroke-width="1.2"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`;
  }
  svg.innerHTML = html === "" ? `<text x="50" y="22" text-anchor="middle" font-size="4" fill="#94a3b8">等待训练日志…</text>` : html;
  legend.innerHTML = series.map((s) => `<span><span class="swatch" style="background:${s.color}"></span>${s.key}${s.dash ? "（虚线）" : ""}</span>`).join("");
  // KPI 卡随最新行刷新
  const last = points[points.length - 1];
  if (last !== undefined) {
    const set = (id, v) => { const el = document.getElementById(id); if (el !== null) el.textContent = v; };
    set("kpi-train", last.train_loss !== undefined ? String(last.train_loss) : "—");
    set("kpi-eval", last.eval_loss !== undefined ? String(last.eval_loss) : "—");
    set("kpi-lr", last.learning_rate !== undefined ? String(last.learning_rate) : "—");
  }
}

async function rebuildMetrics() {
  if (state.current === null) return;
  const data = await api(`/api/sessions/${state.current}/metrics`);
  metricsState.points = data.points ?? [];
  renderLossChart();
}

for (const tab of document.querySelectorAll(".loss-tab")) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll(".loss-tab")) t.classList.remove("active");
    tab.classList.add("active");
    metricsState.tab = tab.dataset.tab;
    renderLossChart();
  };
}

setInterval(pollEvents, 3_000);
setInterval(refreshGpu, 30_000);
setInterval(() => { if (state.current !== null) rebuildMetrics(); }, 5_000);
void refreshSelector().then(() => undefined); // 批⑯prime A：启动即渲染选择器行（常显）
void newTask().then(() => {
  refreshGpu();
  refreshSessions();
});
