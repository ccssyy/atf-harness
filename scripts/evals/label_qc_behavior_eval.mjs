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
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
console.log(`[eval] headless 退出码=${String(code)}`);
process.exit(code);
