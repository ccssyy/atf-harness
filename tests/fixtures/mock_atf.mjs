#!/usr/bin/env node
/**
 * 契约忠实 mock 对端（bridge.contract.yaml 的内核侧实现）——仅 harness 测试基建，非内核代码。
 * 行为：stdin 逐行读 request 帧 → 回 response 帧（id 回显）；atf.version 返回握手结果，
 * 其他未登记方法一律 ok=false / method_not_found；stdin 关闭 → 退出码 0（配合优雅关闭语义）。
 *
 * S1 行为注入旗标（全部可选，供测试制造分帧/合包/反例；不加旗标 = 行为不变）：
 *   --chunk=N                  每次仅异步写 N 字节，模拟输出被字节级分帧
 *   --flush-delay=MS           每个响应延迟 MS 再写，使多个响应合包到达
 *   --delay-response=MS        收到请求后延迟 MS 再响应（配合超时用例）
 *   --contract-version=N       握手返回的 contract_version（默认 1 = 会话协议版本轴，与内核
 *                              SESSION_CONTRACT_VERSION 同源；注入 2 等用于版本不一致反例——
 *                              双轴口径见 bridge.contract.yaml「版本轴注记」与 connection.ts 常量注释）
 *   --emit-ready-event         首个响应前先发一条 atf.ready event 帧
 *   --crash-on-second-request  第二个 request 到达时写 stderr 并以退出码 3 崩溃（模拟意外退出）
 *   --bad-line-after-handshake 首个响应后再发一行非法文本（协议违规反例）
 *
 * S3 扩展（bridge.contract.yaml methods 工具面 + ledger 方法面的 mock 承载；
 * 契约 v2 2026-09-13：MockLedger 重做为内核审批链形态——
 *   ledger_record（预录，测试 setup 基建；params = {scope_ref, tool, params_digest}，
 *     tool/params_digest 为审计检索辅助，不再是账本键）/ ledger_query（scope_ref(+operation_id)
 *     查询，默认只返回可消费记录）/ ledger_consume（{approval_ref, record_id} 逐值一致消费，
 *     一次性语义在对端强制：重复消费 = approval_already_consumed，不匹配 =
 *     approval_record_mismatch，不存在 = not_found）。
 *   工具内状态：admit_data 登记事实（dataset-registry / <dataset_id>@<pin>）→
 *     fact_scan / workspace_status / gate(advance) 读取。
 *   --corrupt-output=METHOD    指定方法响应剔除一个 required 字段（canonical 校验失败反例）
 *   --reject-method=METHOD     指定方法响应 ok=false/gate_rejected（对端业务拒绝反例，结构化回填路径）
 *   --invalid-params-on-path-dataset-id  atf_admit_data 的 dataset_id 含 "/" 时回
 *                              invalid_params（快修批 D-a 2026-09-20；复刻走查 S1 实况；缺省关）
 *
 * 契约 v2 方法面补登（2026-09-13，B1–B4）：会话级 run 绑定——
 *   atf.bind_run（B1）：params {run_id} → result {ok, run_id, scope_ref}；重复绑定允许覆盖，
 *     覆盖时先发 event session/run-bound（payload {from,to}）再回 response（B4 留痕）。
 *   run 解析（B2）：显式 params.run_id 优先于会话绑定；未绑定且未显式 → no_run_bound
 *     （fail-closed，连接保持）；run_id 不存在/不可解析 → unknown_run（连接保持）。
 *   mock 口径注记（与真实内核的差异面，真实对端以内核批次二实现为准）：
 *     - run 存在性 = auto-registry：除 --unknown-run=ID 注定的不可解析值外，显式 run_id
 *       首个引用即登记为已知 run（mock 无内核 run 注册表，自动登记保住多场景可解析）；
 *     - 会话绑定默认启动即绑定 mock-run-1（批次一隐含"当前 run"口径的兼容承载，
 *       既有用例零回归）；--no-auto-bind 时严格启动（无绑定），供 no_run_bound 反例与新口径用例。
 *   --no-auto-bind             会话启动不绑定任何 run（严格口径；默认绑定 mock-run-1）
 *   --unknown-run=ID           指定该 run_id 为不可解析（unknown_run 反例注入）
 */
import readline from "node:readline";
import { createHash } from "node:crypto";

const findOpt = (name) => {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
};

const findNum = (name) => {
  const v = findOpt(name);
  return v === undefined ? undefined : Number(v);
};

const chunkBytes = findNum("chunk") ?? 0;
const flushDelayMs = findNum("flush-delay") ?? 0;
const delayResponseMs = findNum("delay-response") ?? 0;
const contractVersion = findNum("contract-version") ?? 1; // 会话协议版本轴（双轴修正 2026-09-13；握手默认与内核一致回 1）
const corruptOutput = findOpt("corrupt-output") ?? "";
const rejectMethod = findOpt("reject-method") ?? "";
const unknownRunId = findOpt("unknown-run") ?? "";
const flags = new Set(process.argv.slice(2));
const emitReadyEvent = flags.has("--emit-ready-event");
const crashOnSecond = flags.has("--crash-on-second-request");
const badLineAfterHandshake = flags.has("--bad-line-after-handshake");
// 快修批 D-a（2026-09-20）：opt-in 行为注入——atf_admit_data 的 dataset_id 含 "/"（路径形态）
// 时回 invalid_params（内核同码），复刻走查 S1 实况供回流链用例/证据；缺省关 = 既有行为零变化。
const invalidParamsOnPathDatasetId = flags.has("--invalid-params-on-path-dataset-id");

// 审批键 digest：sha256(stableParamsJson)，与 harness 侧同构（契约登记，防漂移）
const stableStringify = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
};
const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------- MockLedger（进程内账本；契约 v2 审批链形态，一次性消费语义在对端强制） ----------------
// 内部记录 = { record_id, approval_id, sequence, state, scope_ref, tool, params_digest, ... }；
// scope_ref 为查询定位键，tool/params_digest 仅为审计检索辅助（契约 v2：不再是账本键），
// 线缆 result 只回契约登记字段（approval 链五项 + 可选明细）。
const ledger = new Map();
let recordSeq = 0;

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const sameScopeRef = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ledgerWireRecord = (record) => {
  const wire = {
    record_id: record.record_id,
    approval_id: record.approval_id,
    sequence: record.sequence,
    state: record.state,
  };
  for (const key of ["command_id", "actor", "operation_id", "attempt_id", "evidence_refs"]) {
    if (record[key] !== undefined) wire[key] = record[key];
  }
  return wire;
};

// re-pin R2（v0.7.1b0）wire 切换：ledger_record 按 K4 §13.8 形态——
// params {scope_ref, command_id, actor, operation_id, attempt_id, subject_ref, evidence_refs[, run_id]}；
// 同 command_id 同内容重放幂等（不追加新行）；不同内容 = approval_command_conflict；
// run 解析＝显式 run_id 优先于会话绑定（§13.0 覆盖口径），未绑定且未显式 = no_run_bound。
const ledgerRecord = (params) => {
  if (!isPlainObject(params.scope_ref)) {
    return { error: { code: "invalid_params", message: "ledger_record 需要 scope_ref（契约 v2 审批链定位）" } };
  }
  for (const key of ["command_id", "actor", "operation_id", "attempt_id", "subject_ref", "evidence_refs"]) {
    if (params[key] === undefined) {
      return { error: { code: "invalid_params", message: `ledger_record 缺 ${key}（§13.8 形态）` } };
    }
  }
  const resolved = resolveRun(params);
  if (resolved.error !== undefined) return { error: resolved.error };
  const contentKey = JSON.stringify([params.actor, params.operation_id, params.attempt_id, params.subject_ref, params.evidence_refs]);
  const existing = [...ledger.values()].find((r) => r.command_id === params.command_id);
  if (existing !== undefined) {
    // 幂等：同 command_id 同内容重放 → 原记录原样返回（不追加）
    if (JSON.stringify([existing.actor, existing.operation_id, existing.attempt_id, existing.subject_ref, existing.evidence_refs]) === contentKey) {
      return { ok: true, command_id: existing.command_id, record_id: existing.record_id, state: "recorded" };
    }
    return { error: { code: "approval_command_conflict", message: "同 command_id 不同内容（§13.8）" } };
  }
  recordSeq += 1;
  const record = {
    record_id: `approval-record:${params.subject_ref}:${String(recordSeq).padStart(3, "0")}`,
    approval_id: `apr-${String(recordSeq).padStart(3, "0")}`,
    sequence: recordSeq,
    state: "approved",
    scope_ref: params.scope_ref,
    run_id: resolved.runId,
    command_id: params.command_id,
    actor: params.actor,
    operation_id: params.operation_id,
    attempt_id: params.attempt_id,
    subject_ref: params.subject_ref,
    evidence_refs: params.evidence_refs,
  };
  ledger.set(record.record_id, record);
  return { ok: true, command_id: params.command_id, record_id: record.record_id, state: "recorded" };
};

const ledgerQuery = (params) => {
  if (!isPlainObject(params.scope_ref)) {
    return { error: { code: "invalid_params", message: "ledger_query 需要 scope_ref（契约 v2 审批链定位）" } };
  }
  const includeConsumed = params.include_consumed === true;
  const records = [];
  for (const record of ledger.values()) {
    if (!sameScopeRef(record.scope_ref, params.scope_ref)) continue;
    if (params.operation_id !== undefined && record.operation_id !== params.operation_id) continue;
    if (params.state !== undefined) {
      if (record.state !== params.state) continue;
    } else if (!includeConsumed && record.state !== "approved") {
      // 默认只返回可消费记录（state=approved 且未 consumed）
      continue;
    }
    records.push(ledgerWireRecord(record));
  }
  return { ok: true, records };
};

const ledgerConsume = (params) => {
  const record = ledger.get(params.record_id);
  if (record === undefined) {
    return { error: { code: "not_found", message: `账本无此记录: ${params.record_id}` } };
  }
  if (record.approval_id !== params.approval_ref) {
    return { error: { code: "approval_record_mismatch", message: `approval_ref 与 record_id 不匹配: ${params.approval_ref} / ${params.record_id}` } };
  }
  if (record.state === "consumed") {
    return { error: { code: "approval_already_consumed", message: `记录已消费（一次性语义）: ${params.record_id}` } };
  }
  record.state = "consumed";
  return { ok: true, record_id: record.record_id, state: "consumed" };
};

// ---------------- 工具内状态与四个工具方法（canonical output 见契约 methods 段 v2） ----------------
// 契约 v2（变更 #7）：admit_data 三元组 = dataset-registry / <dataset_id>@<pin> / 登记记录 digest；
// pin 以 dataset_id 的 sha256 前 12 位确定性派生（mock 语义，真实 pin 来源由批次二任务书明确）。
const admittedFacts = [];

// ---------------- 会话 run 绑定（契约 v2 方法面补登 2026-09-13，B1–B4） ----------------
// 解析顺序：显式 params.run_id → 会话绑定 → no_run_bound（B2/B3）；留痕见 sessionBindRun（B4）。
const scopeRefFor = (runId) => ({ project_id: "mock-project", scope_type: "run", scope_id: runId, scope_mode: "headless" });
const noAutoBind = flags.has("--no-auto-bind");
let boundRunId = noAutoBind ? null : "mock-run-1"; // 默认绑定 = 批次一隐含"当前 run"口径的兼容承载（见头部注记）
const knownRuns = new Set(["mock-run-1"]);

const isResolvableRun = (runId) => runId !== unknownRunId; // auto-registry：除注定不可解析值外均可登记

const resolveRun = (params) => {
  const explicit = isPlainObject(params) && typeof params.run_id === "string" && params.run_id.length > 0 ? params.run_id : undefined;
  if (explicit !== undefined) {
    if (!isResolvableRun(explicit)) {
      return { error: { code: "unknown_run", message: `run_id 不存在/不可解析: ${explicit}` } };
    }
    knownRuns.add(explicit);
    return { runId: explicit };
  }
  if (boundRunId === null) {
    return { error: { code: "no_run_bound", message: "会话未绑定 run 且未显式给 run_id（fail-closed，契约补登 B3）" } };
  }
  return { runId: boundRunId };
};

const sessionBindRun = (params) => {
  const runId = isPlainObject(params) ? params.run_id : undefined;
  if (typeof runId !== "string" || runId.length === 0) {
    return { error: { code: "invalid_params", message: "atf.bind_run 需要非空 run_id（契约补登 B1）" } };
  }
  if (!isResolvableRun(runId)) {
    return { error: { code: "unknown_run", message: `run_id 不存在/不可解析: ${runId}` } };
  }
  const from = boundRunId;
  knownRuns.add(runId);
  boundRunId = runId;
  if (from !== null && from !== runId) {
    // 绑定留痕（B4）：覆盖绑定先发 event 再回 response（单向通知，不影响 id 配对）；
    // 经 writeChain 串行写出，与 response 的先后次序有保证。
    sendFrame({ type: "event", name: "session/run-bound", payload: { from, to: runId } });
  }
  return { ok: true, run_id: runId, scope_ref: scopeRefFor(runId) };
};

const corrupt = (method, result) => {
  if (corruptOutput !== method) return result;
  const clone = { ...result };
  delete clone.ok; // 剔除必有的 ok 字段 → canonical 校验必失败
  return clone;
};

const toolAdmitData = (params) => {
  if (invalidParamsOnPathDatasetId && String(params.dataset_id ?? "").includes("/")) {
    return {
      error: {
        code: "invalid_params",
        message: `dataset_id 须为注册标识符（形如 ds-<slug>-<date>），非文件路径: ${String(params.dataset_id)}`,
      },
    };
  }
  const pin = sha256Hex(String(params.dataset_id)).slice(0, 12);
  const factId = `${String(params.dataset_id)}@${pin}`;
  const digest = sha256Hex(stableStringify({ dataset_id: String(params.dataset_id), pin }));
  admittedFacts.push({ journal_type: "dataset-registry", fact_id: factId, sha256_digest: digest });
  return { ok: true, journal_type: "dataset-registry", fact_id: factId, sha256_digest: digest, dataset_id: params.dataset_id };
};

const toolGate = (params) => {
  if (params.action === "advance") {
    const hasEvidence = admittedFacts.length > 0 || (Array.isArray(params.evidence_refs) && params.evidence_refs.length > 0);
    if (!hasEvidence) {
      return { ok: true, gate: String(params.gate), status: "blocked", reason_codes: ["evidence_missing"], missing: ["admitted_fact"] };
    }
    return { ok: true, gate: String(params.gate), status: "pass" };
  }
  return { ok: true, gate: String(params.gate), status: "pass" };
};

const toolFactScan = (params) => {
  const resolved = resolveRun(params);
  if (resolved.error !== undefined) return resolved;
  return {
    ok: true,
    facts: admittedFacts.map((fact) => ({ ...fact })),
    count: admittedFacts.length,
  };
};

const toolWorkspaceStatus = (params) => {
  const resolved = resolveRun(params);
  if (resolved.error !== undefined) return resolved;
  return {
    ok: true,
    run_id: resolved.runId,
    admitted_count: admittedFacts.length,
    scope_ref: scopeRefFor(resolved.runId),
  };
};

// re-pin R2 wire 切换：atf_flow_anchor（K3 §13.9）流程位置纯读出口——三态 current/stale/missing。
// mock 承载：锚 = 进程内 Map（bind 时写锚为 current；--stale-anchor=RUN 可注入 stale 形态）；
// 纯读纪律（不重算、不写锚）与三态形状按契约条目；显式 run_id 优先于会话绑定。
const anchorStore = new Map(); // runId -> { document, as_of_digest }
const flowAnchor = (params) => {
  const resolved = resolveRun(params);
  if (resolved.error !== undefined) return { error: resolved.error };
  const anchor = anchorStore.get(resolved.runId);
  if (anchor === undefined) {
    return { ok: true, run_id: resolved.runId, anchor_status: "missing" };
  }
  if (anchor.stale === true) {
    return {
      ok: true,
      run_id: resolved.runId,
      anchor_status: "stale",
      anchor_phase: anchor.document.phase,
      as_of_digest: anchor.recomputedDigest,
      expected_as_of_digest: anchor.document.as_of_digest,
    };
  }
  return { ok: true, run_id: resolved.runId, anchor_status: "current", anchor: anchor.document.raw };
};

const METHODS = {
  ledger_record: ledgerRecord,
  ledger_query: ledgerQuery,
  ledger_consume: ledgerConsume,
  "atf.bind_run": sessionBindRun,
  atf_admit_data: toolAdmitData,
  atf_gate: toolGate,
  atf_fact_scan: toolFactScan,
  atf_workspace_status: toolWorkspaceStatus,
  atf_flow_anchor: flowAnchor,
};

// 响应写出经串行链，保证分片模式下不同响应的字节不交错（对端自身的帧完整性义务）
let writeChain = Promise.resolve();
const writeRaw = (text) => {
  writeChain = writeChain.then(async () => {
    if (chunkBytes > 0) {
      for (let i = 0; i < text.length; i += chunkBytes) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        process.stdout.write(text.slice(i, i + chunkBytes));
      }
    } else {
      if (flushDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, flushDelayMs));
      process.stdout.write(text);
    }
  });
  return writeChain;
};

const sendFrame = (frame) => writeRaw(`${JSON.stringify(frame)}\n`);

const respondTo = (req, servedCount) => {
  // atf.ready 语义 = 版本交换（第 1 个请求即握手）完成后对端就绪；此时 TS 侧监听器已可挂载
  if (emitReadyEvent && servedCount === 2) {
    sendFrame({ type: "event", name: "atf.ready", payload: { peer: "mock" } });
  }
  if (req.method === "atf.version") {
    sendFrame({
      type: "response",
      id: req.id,
      ok: true,
      result: { name: "atf", version: "v0.2.0b7-mock", contract_version: contractVersion },
    });
    return;
  }
  const handler = METHODS[req.method];
  if (rejectMethod !== "" && req.method === rejectMethod) {
    sendFrame({
      type: "response",
      id: req.id,
      ok: false,
      error: { code: "gate_rejected", message: `对端业务拒绝（注入反例）: ${req.method}` },
    });
    return;
  }
  if (handler === undefined) {
    sendFrame({
      type: "response",
      id: req.id,
      ok: false,
      error: { code: "method_not_found", message: `未知方法: ${req.method}` },
    });
    return;
  }
  const outcome = handler(req.params ?? {});
  if (outcome.error !== undefined) {
    sendFrame({ type: "response", id: req.id, ok: false, error: outcome.error });
    return;
  }
  sendFrame({ type: "response", id: req.id, ok: true, result: corrupt(req.method, outcome) });
};

let served = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stderr.write(`mock: 非法请求行: ${line.slice(0, 80)}\n`);
    process.exit(2);
  }
  if (request === null || typeof request !== "object" || request.type !== "request" || !Number.isInteger(request.id)) {
    process.stderr.write("mock: 请求帧不符合契约（缺 type=request 或 id）\n");
    process.exit(2);
  }
  served += 1;
  if (crashOnSecond && served >= 2) {
    process.stderr.write("mock: crash-on-second-request 触发，进程退出(3)\n");
    process.exit(3);
  }
  const respond = () => {
    respondTo(request, served);
    if (badLineAfterHandshake && served === 1) writeRaw("这不是合法JSON帧\n");
  };
  if (delayResponseMs > 0) setTimeout(respond, delayResponseMs);
  else respond();
});
rl.on("close", () => {
  process.exit(0);
});
