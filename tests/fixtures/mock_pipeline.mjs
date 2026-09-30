#!/usr/bin/env node
/**
 * walkthrough_pipeline 段触发 mock 对端（M1 测试/验收基建，非内核代码）：
 * `node mock_pipeline.mjs --stage <段名>` → stdout 输出该段结构化摘要 JSON（成功路径）。
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
process.stdout.write(
  `${JSON.stringify({
    stage,
    started: true,
    ok: true,
    note: "mock 单段触发（M1 验收；真内核经 ATF_DSH_PIPELINE_COMMAND 注入）",
    segment_card: { stage, state: "done", interactive_point: null },
  })}\n`,
);
