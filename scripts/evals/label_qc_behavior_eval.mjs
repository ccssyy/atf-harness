// -*- coding: utf-8 -*-
// D279/D277 行为面 L2 eval 驱动（headless 段级——eval-spec §4.5 载体纠正批落地件，
// 兼「行为段缺 headless 段级 eval 驱动入口」改进项的载体第一步）。
// 用法（A800，ATF-Harness 根）：
//   set -a; source deploy/instances/dev.env; set +a
//   export ATF_V1_REAL_LLM_AUTHORIZED=1
//   node --import tsx/esm scripts/evals/label_qc_behavior_eval.mjs
// 判据：docs/testing/eval-l2-adjudication-behavior-20261111.md（J1/J2/J3，载体=本脚本轨迹+盘面）。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/agent/index.js";

const WS_ROOT = "/data/atf/dev/eval-ws/label-qc-eval2-ws";
const RUN_ID = `eval-l2-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
const SOURCE_ROOT = `${WS_ROOT}/batch`;

const instruction = [
  `对本工作区做段级登记与标签质检（两段都用 atf_pipeline_stage 段级入口——不要用 atf_admit_data，那是准入段，本场景不需要）：`,
  `① register 段：--stage register --source-root ${SOURCE_ROOT} --doc-type bl --run-id ${RUN_ID} --experiment bl-qc-eval2（workspace_path=${WS_ROOT}）；`,
  `② label_qc 段：--stage label_qc 同参重跑。批内 3 页航空提单标注（图片与 json 成对）。`,
  `label_qc 双通道走完（机械检测+看图核查）：逐页看图核对框位/值/归属，写 LabelQcVisualCheck/v1 核查件后带 --visual-check 重跑；`,
  `核查发现的标注抄录误差类 issue 在核查件条目带 resolution（action=set_value+field/page/old_value/new_value/basis 看图依据）交内核自动修正；`,
  `机械冲突裁决项在全部检查完成后汇总为一次 atf_label_qc_resolve 提交。`,
  `段 ok 后输出结论：每页发现什么问题、怎么处置的。`,
].join("\n");


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
const __toolLines = [];
const code = await runCli({
  argv: [
    "--instruction", instruction,
    "--peer", "real",
    "--llm", "config",
    "--ws-root", WS_ROOT,
    "--fs-root", SOURCE_ROOT,
    "--max-turns", "40",
    "--approval", "headless",
  ],
  env: {
    ...process.env,
    ATF_V1_REAL_LLM_AUTHORIZED: "1",
  },
  out: (line) => { console.log(line); __toolLines.push(line); },
  err: (line) => console.error(line),
});
console.log(`[eval] headless 退出码=${String(code)}`);
const __toolCalls = __toolLines
  .filter((l) => l.includes("tool/call") || l.includes("\"name\": \"atf_") || /\b(atf_[a-z_]+|dispatch_parallel[a-z_]*)\(/.test(l))
  .map((l) => (l.match(/\b((?:atf|dispatch)[a-z_]*)\s*\(/) ?? [])[1] ?? "")
  .filter((n) => n !== "");
let __woCount = null;
try {
  const fs1 = await import("node:fs");
  const path1 = await import("node:path");
  for (const ent of fs1.readdirSync(`${WS_ROOT}/datasets`, { withFileTypes: true })) {
    try {
      const wo = JSON.parse(fs1.readFileSync(path1.join(`${WS_ROOT}/datasets`, ent.name, "qc-parallel-workorders.json"), "utf8"));
      __woCount = (wo.workorders ?? []).length;
      break;
    } catch { /* 该 dataset 无工单 */ }
  }
} catch { /* datasets 缺席 */ }
const __p1Code = __assertP1(__toolCalls, __woCount);
process.exit(__p1Code !== 0 ? __p1Code : code);
