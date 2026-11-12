// -*- coding: utf-8 -*-
// D279/D277 行为面 L2 eval 驱动 v2——sessionManager 装配直驱（headless 拓扑，
// 无浏览器/无交互面；§4.5 载体纠正批）。判据=docs/testing/eval-l2-adjudication-behavior-20261111.md。
// 用法（A800，vendor dsh 根）：source 密钥 env+dev.env → ATF_V1_REAL_LLM_AUTHORIZED=1 →
//   node --import tsx/esm <本脚本> ；轨迹与断言输出落 /tmp/l2-eval-v2-*.log 与 docs/verdicts/。
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBridgeDeployment } from "../../src/bridge/bridgeCommand.js";
import { loadLlmProviderConfig } from "../../src/llm/providerConfig.js";
import { WebUiSessionManager } from "../../src/webui/sessionManager.js";

const WS_ROOT = "/data/atf/dev/eval-ws/label-qc-eval2-ws";
const SOURCE_ROOT = `${WS_ROOT}/batch`;
const RUN_ID = `v1-eval-${Date.now()}`;

const resolved = await loadLlmProviderConfig(process.env);
if (!resolved.ok) {
  console.error(`[eval] GLM 配置解析失败: ${resolved.error.message}`);
  process.exit(1);
}
const pc = resolved.value;
console.log(`[eval] provider=${pc.provider_id} model=${pc.model}`);

const runsRoot = join(WS_ROOT, "runs");
mkdirSync(runsRoot, { recursive: true });
const sessionsRoot = mkdtempSync(join(tmpdir(), "eval2-sessions-"));

const manager = new WebUiSessionManager({
  runsRoot,
  sessionsRoot,
  bridgeCommand: (() => {
    // D276-eval:同源解析（resolveBridgeDeployment 处理 PYTHONPATH= 前缀拆解——
    // 裸 split 把 env 前缀当 argv[0] 导致 spawn 可执行文件不存在而挂,1111 首跑实锚）
    const deployment = resolveBridgeDeployment({
      commandValue: process.env.ATF_DSH_BRIDGE_COMMAND ?? "python3 -m agentic_training_flow serve",
      kernelDir: process.env.ATF_KERNEL_SOURCE ?? "/data/sam/AgenticTrainingFlow",
      env: process.env,
    });
    return { argv: deployment.argv, ...(deployment.childEnv && Object.keys(deployment.childEnv).length > 0 ? { env: deployment.childEnv } : {}) };
  })(),
  providerConfig: { provider_id: pc.provider_id, model: pc.model, base_url: pc.base_url, api_key: pc.api_key },
  kernelDir: process.env.ATF_KERNEL_SOURCE ?? "/data/sam/AgenticTrainingFlow",
});

const id = manager.createSession();
const instruction = [
  `对本工作区做数据登记（register）与标签质检（label_qc 段）：`,
  `workspace_path=${WS_ROOT}；source_root=${SOURCE_ROOT}；doc_type=bl；run_id=${RUN_ID}；experiment=bl-qc-eval2。`,
  `批内有 3 页航空提单标注（图片与 json 成对）。`,
  `label_qc 双通道走完（机械检测+看图核查）：逐页看图核对框位/值/归属，写 LabelQcVisualCheck/v1 核查件后带 --visual-check 重跑；`,
  `核查发现的标注抄录误差类 issue 在核查件条目带 resolution（action=set_value+field/page/old_value/new_value/basis 看图依据）交内核自动修正；`,
  `机械冲突裁决项在全部检查完成后汇总为一次 atf_label_qc_resolve 提交。`,
  `段 ok 后输出结论：每页发现什么问题、怎么处置的。`,
].join("\n");

const internal = manager;
await internal.postUserMessage(id, instruction);

// 轮询驱动：pending 卡自动回填（字段/prompt 问卡=文本「按建议」；确认卡=answerConfirm）
// + 完成检测（state 回 idle 且无 pending）+ 轨迹留痕。
const deadline = Date.now() + 15 * 60 * 1000;
const answeredSeqs = new Set();
let lastSeq = 0;
  let sawActive = false;
const trajectory = [];
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const events = manager.eventsSince(id, lastSeq);
  for (const e of events) {
    lastSeq = Math.max(lastSeq, e.seq);
    trajectory.push(e);
  }
  const session = internal.sessions.get(id);
  if (session === undefined) break;
  const pending = session.pending;
  if (pending !== undefined && !answeredSeqs.has(pending.seq)) {
    answeredSeqs.add(pending.seq);
    console.log(`[eval] 确认卡出现（cardType=${pending.cardType}）——自动确认`);
    await manager.answerConfirm(id, { action: "confirm", via: "button" });
  }
  // question 卡（字段清单/prompt 选择）走 postUserMessage 文本应答——通过 events 观察
  // ask 等待态：session.state 停留 + 最近事件含问卡标题 → 按建议回复。
  const recent = trajectory.slice(-6).map((e) => e.text ?? "").join(" ");
  if (recent.includes("字段清单要全用它吗") && !answeredSeqs.has("fields")) {
    answeredSeqs.add("fields");
    console.log("[eval] 字段清单卡——文本回复「全部字段训练」");
    await internal.postUserMessage(id, "全部 6 个字段都训练");
  } else if (recent.includes("训练 prompt 用哪套") && !answeredSeqs.has("prompt")) {
    answeredSeqs.add("prompt");
    console.log("[eval] prompt 模板卡——文本回复「用产品内置模板」");
    await internal.postUserMessage(id, "用产品内置模板");
  }
  // 完成判定：曾进入 running/waiting 且回 idle（createSession 初始即 idle,不可作完成信号）
  if (session.state === "running" || session.state === "waiting") sawActive = true;
  if (sawActive && session.state === "idle" && pending === undefined) {
    console.log("[eval] agent 收尾（state 回 idle）——驱动结束");
    break;
  }
}

// 轨迹与断言素材落盘
import { writeFileSync } from "node:fs";

// ── C3.2（批次任务书子切片 3）：D276 并行判据 P1 轨迹断言 ──
// 判据文件=内核仓 docs/testing/eval-l2-parallel-dispatch-20261112.md（两载体共用）。
// 条件化：夹具页数 <8（工单 <2 片）→ P1: SKIP（不触发并行要求，不误红）。
const __assertP1 = (toolCalls, workorderCount) => {
  if (workorderCount === null) {
    console.log("[eval] P1: SKIP（qc-parallel-workorders.json 不在场——夹具未达并行判定面）");
    return 0;
  }
  if (workorderCount < 2) {
    console.log(`[eval] P1: SKIP（工单 ${String(workorderCount)} 片 <2——页数未达 8 页阈值）`);
    return 0;
  }
  const hits = toolCalls.filter((n) => String(n).startsWith("dispatch_parallel"));
  const pass = hits.length >= 1;
  console.log(`[eval] P1: ${pass ? "PASS" : "FAIL"}（工单 ${String(workorderCount)} 片≥2，dispatch_parallel* 调用数=${String(hits.length)}——判据 eval-l2-parallel-dispatch-20261112.md）`);
  return pass ? 0 : 3;
};

const session = internal.sessions.get(id);
const out = {
  run_id: RUN_ID,
  session_id: id,
  subagent_enabled: session?.subagentEnabled ?? false,
  state: session?.state,
  events: manager.eventsSince(id, 0),
};
writeFileSync("/tmp/l2-eval-v2-trajectory.json", JSON.stringify(out, null, 1));
console.log(`[eval] 轨迹已落 /tmp/l2-eval-v2-trajectory.json（events=${out.events.length}，state=${out.state}）`);
const __toolCalls = out.events
  .filter((e) => e.type === "tool/call")
  .map((e) => e.data?.name ?? "");
const __woGlob = __importSync("node:fs").readdirSync("/data/atf/dev/eval-ws/label-qc-eval2-ws/datasets", { withFileTypes: true });
let __woCount = null;
for (const ent of __woGlob) {
  try {
    const wo = JSON.parse(__importSync("node:fs").readFileSync(
      __importSync("node:path").join("/data/atf/dev/eval-ws/label-qc-eval2-ws/datasets", ent.name, "qc-parallel-workorders.json"), "utf8"));
    __woCount = (wo.workorders ?? []).length;
    break;
  } catch { /* 该 dataset 无工单，继续找 */ }
}
const __p1Code = __assertP1(__toolCalls, __woCount);
process.exit(__p1Code !== 0 ? __p1Code : 0);
