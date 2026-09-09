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
 *   --contract-version=N       握手返回的 contract_version（默认 1；用于版本不一致反例）
 *   --emit-ready-event         首个响应前先发一条 atf.ready event 帧
 *   --crash-on-second-request  第二个 request 到达时写 stderr 并以退出码 3 崩溃（模拟意外退出）
 *   --bad-line-after-handshake 首个响应后再发一行非法文本（协议违规反例）
 *
 * S3 扩展（bridge.contract.yaml methods 工具面 + ledger 方法面的 mock 承载）：
 *   四个工具方法返回 canonical output；MockLedger（进程内账本）承载
 *   ledger_record（预录，测试 setup 基建）/ ledger_query（查询）/ ledger_consume（消费，
 *   一次性语义在对端强制：重复消费 = ok:false/already_consumed）。
 *   工具内状态：admit_data 登记事实 → surface_scan / workspace_status / gate(advance) 读取。
 *   --corrupt-output=METHOD    指定方法响应剔除一个 required 字段（canonical 校验失败反例）
 *   --reject-method=METHOD     指定方法响应 ok=false/gate_rejected（对端业务拒绝反例，结构化回填路径）
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
const contractVersion = findNum("contract-version") ?? 1;
const corruptOutput = findOpt("corrupt-output") ?? "";
const rejectMethod = findOpt("reject-method") ?? "";
const flags = new Set(process.argv.slice(2));
const emitReadyEvent = flags.has("--emit-ready-event");
const crashOnSecond = flags.has("--crash-on-second-request");
const badLineAfterHandshake = flags.has("--bad-line-after-handshake");

// 审批键 digest：sha256(stableParamsJson)，与 harness 侧同构（契约登记，防漂移）
const stableStringify = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
};
const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------- MockLedger（进程内账本；一次性消费语义在对端强制） ----------------
const ledger = new Map(); // record_id → { record_id, tool, params_digest, consumed }
let recordSeq = 0;

const ledgerRecord = (params) => {
  recordSeq += 1;
  const record = {
    record_id: `rec-${String(recordSeq).padStart(3, "0")}`,
    tool: params.tool,
    params_digest: params.params_digest,
    consumed: false,
  };
  ledger.set(record.record_id, record);
  return { ok: true, record_id: record.record_id };
};

const ledgerQuery = (params) => {
  const entries = [];
  for (const record of ledger.values()) {
    if (record.tool === params.tool && record.params_digest === params.params_digest) {
      entries.push({ ...record });
    }
  }
  return { ok: true, entries };
};

const ledgerConsume = (params) => {
  const record = ledger.get(params.record_id);
  if (record === undefined) {
    return { error: { code: "record_not_found", message: `账本无此记录: ${params.record_id}` } };
  }
  if (record.consumed) {
    return { error: { code: "already_consumed", message: `记录已消费（一次性语义）: ${params.record_id}` } };
  }
  record.consumed = true;
  return { ok: true, record_id: record.record_id, consumed: true };
};

// ---------------- 工具内状态与四个工具方法（canonical output 见契约 methods 段） ----------------
const admittedFacts = [];

const corrupt = (method, result) => {
  if (corruptOutput !== method) return result;
  const clone = { ...result };
  delete clone.ok; // 剔除必有的 ok 字段 → canonical 校验必失败
  return clone;
};

const toolAdmitData = (params) => {
  const factId = `fact-${String(params.dataset_id)}`;
  const digest = sha256Hex(stableStringify({ dataset_id: params.dataset_id }));
  admittedFacts.push({ journal_type: "run_journal", fact_id: factId, sha256_digest: digest });
  return { ok: true, journal_type: "run_journal", fact_id: factId, sha256_digest: digest, dataset_id: params.dataset_id };
};

const toolGate = (params) => {
  if (params.action === "advance") {
    const hasEvidence = admittedFacts.length > 0 || (Array.isArray(params.evidence_refs) && params.evidence_refs.length > 0);
    if (!hasEvidence) {
      return { ok: true, gate: String(params.gate), status: "blocked", reason: "evidence_missing", missing: ["admitted_fact"] };
    }
    return { ok: true, gate: String(params.gate), status: "pass" };
  }
  return { ok: true, gate: String(params.gate), status: "pass" };
};

const toolSurfaceScan = () => ({
  ok: true,
  surface: admittedFacts.map((fact) => ({ ...fact })),
  count: admittedFacts.length,
});

const toolWorkspaceStatus = () => ({
  ok: true,
  run_id: "mock-run-1",
  admitted_count: admittedFacts.length,
});

const METHODS = {
  ledger_record: ledgerRecord,
  ledger_query: ledgerQuery,
  ledger_consume: ledgerConsume,
  atf_admit_data: toolAdmitData,
  atf_gate: toolGate,
  atf_surface_scan: toolSurfaceScan,
  atf_workspace_status: toolWorkspaceStatus,
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
