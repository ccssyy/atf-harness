#!/usr/bin/env node
/**
 * walkthrough_pipeline 段触发 mock 对端（A-E14b 测试基建，非内核代码）：
 * 与 mock_pipeline.mjs 同成功路径语义，另回显完整 argv（summary.argv——下传参数断言面）；
 * env MOCK_BASE_MODEL_SOURCE 非空时在 summary 携带 base_model_source（对端如实回流面）。
 * 未知段 → 非零退出＋stderr（fail-closed 反例面）。
 */
const argv = process.argv.slice(2);
const stageIndex = argv.indexOf("--stage");
const stage = stageIndex >= 0 ? argv[stageIndex + 1] : undefined;
const KNOWN = ["register", "split", "label_qc", "candidate", "publish", "training_prep"];
if (typeof stage !== "string" || !KNOWN.includes(stage)) {
  console.error(`unknown or missing --stage: ${String(stage)}`);
  process.exit(2);
}
const source = process.env["MOCK_BASE_MODEL_SOURCE"] ?? "";
process.stdout.write(
  `${JSON.stringify({
    stage,
    started: true,
    ok: true,
    note: "mock 单段触发（A-E14b argv 回显面）",
    argv,
    ...(source !== "" ? { base_model_source: source } : {}),
    segment_card: { stage, state: "done", interactive_point: null },
  })}\n`,
);
