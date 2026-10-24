/**
 * E2 测试夹具——内核 training_preflight.py 的「有缺项」退出形态 mock（UAT 实测：
 * 对有缺项的 run 报 exit 1、stderr 空、stdout 为完整合法 TrainingPreflight/v1 JSON）。
 * 驱动 harness 侧退出码语义修正锚：exit≠0 先解析 stdout——报告可用即 degraded
 * 返回（三态清单不丢、exit_code 如实透传）。报告体与 mock_preflight.mjs 的
 * 无 --apply 形态逐键同源（三态各就位）。
 * 退出用 process.exitCode（自然退出——stdout 先行冲刷干净，不用 process.exit
 * 截断管道写）。
 */
const args = process.argv.slice(2);
const runDirAt = args.indexOf("--run-dir");
if (runDirAt < 0 || (args[runDirAt + 1] ?? "") === "") {
  process.stderr.write("mock_preflight_exit1: --run-dir <abs> required\n");
  process.exitCode = 2;
} else {
  const report = {
    generated_at: "2026-10-24T08:00:00Z",
    items: [
      { id: "token_provider", state: "missing", detail: "token provider 未配置（内置/显式/缺——当前缺）", action: "预检 --apply 启用内置 CPU 计量，或显式配置 token provider", depends_on: [] },
      { id: "token_budget", state: "derivable", detail: "prep/token_budget.json 缺失", action: "--apply 用内置 provider 计量生成（TokenBudget/v1 口径）", depends_on: ["token_provider"] },
      { id: "coordinate_pending", state: "derivable", detail: "坐标换算 pending 3 对（原因：像素对变更后未重算）", action: "--apply 整批重试（retry_only）", depends_on: [] },
      { id: "grouping_preset", state: "needs_confirm", detail: "分组 preset 决策状态：未定", action: "确认分组方案 A（3 组·按单据层级）或 B（2 组·单据级 vs 条目级）", depends_on: [] },
    ],
    order: ["token_provider", "token_budget", "coordinate_pending", "grouping_preset"],
    summary: { missing: 1, derivable: 2, confirm: 1 },
  };
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  // 有缺项 → 退出码 1（stderr 空——UAT 现场实测形态）
  process.exitCode = 1;
}
