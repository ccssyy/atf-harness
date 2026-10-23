#!/usr/bin/env node
/**
 * walkthrough_pipeline 段触发 mock 对端（D89/D93 等参数面测试基建，非内核代码）：
 * 与 mock_pipeline_argv.mjs 同「stdout JSON 摘要＋argv 回显」语义，段闭集按内核八段
 * （experiment_setup 在位——grouping_preset 透传断言面；旧 mock_pipeline_argv.mjs 的
 * KNOWN 仍是旧六段名，不含 experiment_setup，故本夹具单列）。恒 exit 0＋run_id/stage
 * 携带（走既有 stdout 摘要回读面）；summary.argv 回显完整下传参数（argv 断言面）。
 */
const argv = process.argv.slice(2);
const stageIndex = argv.indexOf("--stage");
const stage = stageIndex >= 0 ? argv[stageIndex + 1] : undefined;
const runIdIndex = argv.indexOf("--run-id");
const runId = runIdIndex >= 0 ? argv[runIdIndex + 1] : "";
const KNOWN = ["register", "label_qc", "experiment_setup", "candidate_build", "publish", "family_split", "admission", "training_prep"];
if (typeof stage !== "string" || !KNOWN.includes(stage)) {
  console.error(`unknown or missing --stage: ${String(stage)}`);
  process.exit(2);
}
process.stdout.write(
  `${JSON.stringify({
    schema_version: "WalkthroughPipelineReport/v1",
    mode: "stage",
    stage,
    run_id: runId,
    exit_code: 0,
    ok: true,
    note: "mock 单段触发（D89/D93 argv 回显面）",
    argv,
  })}\n`,
);
