#!/usr/bin/env node
/**
 * 内核量化 CLI mock 对端（E1b 测试基建，非内核代码）：与 tools/quantize_annotations.py
 * 同退出码语义（0 成功／2 退化未放行／3 环境错），另回显完整 argv（summary.argv——下传
 * 参数断言面）。env 控制：MOCK_QUANTIZE_EXIT=0|2|3（缺省 0）；MOCK_QUANTIZE_COUNTERS=
 * JSON 覆盖 stdout 计数投影。exit 0 时非 dry-run 在 <out>/quantize-summary.json 落占位
 * summary（与内核缺省落盘位一致）；exit 2 逐框行打 stderr（零写入）；exit 3 打 env 错。
 */
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = argOf("--out") ?? "/tmp/mock-quantize-out";
const dryRun = argv.includes("--dry-run");
const exit = Number(process.env["MOCK_QUANTIZE_EXIT"] ?? "0");

if (exit === 2) {
  const degenCount = Number(process.env["MOCK_QUANTIZE_DEGEN_COUNT"] ?? "3");
  const files = ["a.json", "b.json"];
  for (let i = 0; i < degenCount; i += 1) {
    const file = files[i % files.length];
    process.stderr.write(`degenerate_box: ${file} 字段=box 框序号=${i} 宽 1.2→1 高 0.4→0(量化后≤0,未放行)\n`);
  }
  process.stderr.write(`退化框 ${degenCount} 个分布于 ${files.length} 个文件;零写入;放行请加 --allow-degenerate\n`);
  process.exit(2);
}
if (exit === 3) {
  process.stderr.write("quantize_env_error:源目录不可读（或无成对标注）\n");
  process.exit(3);
}
const counters = JSON.parse(process.env["MOCK_QUANTIZE_COUNTERS"] ?? JSON.stringify({
  files_total: 2,
  total_values: 16,
  marks_passthrough: 1,
  degenerate_boxes: 0,
  degenerate_files: 0,
  float_remaining: 0,
}));
if (dryRun) {
  process.stdout.write(`${JSON.stringify({ ...counters, mode: argOf("--mode") ?? "round", dry_run: true, degenerate: [] })}\n`);
  process.exit(0);
}
const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/quantize-summary.json`, `${JSON.stringify({ ...counters, argv })}\n`);
process.stdout.write(`${JSON.stringify(counters)}\n`);
