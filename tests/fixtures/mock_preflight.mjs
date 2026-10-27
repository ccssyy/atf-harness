/**
 * F1 测试夹具——内核 tools/training_preflight.py 的 mock 对端（固定 schema 单源
 * 对 schema 开发：内核脚本落地前以本形态驱动 harness 消费面）。
 *
 * 行为：
 * - 无 --apply：输出「缺预算（依赖 provider）＋坐标 pending＋分组未定」三态样例
 *   （对齐授权件 §三 验收锚场景：missing 1／derivable 2／needs_confirm 1）。
 * - --apply：derivable 项已执行（预算生成、坐标整批重试清零），missing/needs_confirm
 *   原样保留（apply 只做 derivable——§一.1）。
 * - --run-dir 缺失或值空：exit 2（参数面健壮性——harness 侧对账）。
 * 输出形态与授权件 §一.1 固定 schema 逐键一致。
 */
const args = process.argv.slice(2);
const runDirAt = args.indexOf("--run-dir");
if (runDirAt < 0 || (args[runDirAt + 1] ?? "") === "") {
  process.stderr.write("mock_preflight: --run-dir <abs> required\n");
  process.exit(2);
}
const apply = args.includes("--apply");

const beforeApply = {
  generated_at: "2026-10-24T08:00:00Z",
  items: [
    { id: "token_provider", state: "missing", detail: "token provider 未配置（内置/显式/缺——当前缺）", action: "预检 --apply 启用内置 CPU 计量，或显式配置 token provider", depends_on: [] },
    { id: "token_budget", state: "derivable", detail: "prep/token_budget.json 缺失", action: "--apply 用内置 provider 计量生成（TokenBudget/v1 口径）", depends_on: ["token_provider"] },
    { id: "coordinate_pending", state: "derivable", detail: "坐标换算 pending 3 对（原因：像素对变更后未重算）", action: "--apply 整批重试（retry_only）", depends_on: [] },
    { id: "grouping_preset", state: "needs_confirm", detail: "分组 preset 决策状态：未定", action: "确认分组方案 A（3 组·按单据层级）或 B（2 组·单据级 vs 条目级）", depends_on: [] },
  ],
  order: ["token_provider", "token_budget", "coordinate_pending", "grouping_preset"],
  summary: { missing: 1, derivable: 2, confirm: 1 },
  decisions: {
    schema_version: "DecisionGate/v1",
    access_mode: "limited",
    auto: 0,
    ask: 2,
    entries: [
      { schema_version: "DecisionGate/v1", question_id: "token_provider", kind: "policy", mode: "ask", decision: null, basis: "内置计量脚本不在场，显式路径也没给", evidence: [], reason: "no_evidence" },
      { schema_version: "DecisionGate/v1", question_id: "grouping", kind: "policy", mode: "ask", decision: null, basis: "分组必须用户确认——agent 给出的只是候选", evidence: [], reason: "limited_access" },
    ],
  },
};
const afterApply = {
  generated_at: "2026-10-24T08:01:00Z",
  items: [
    beforeApply.items[0],
    beforeApply.items[3],
  ],
  order: ["token_provider", "grouping_preset"],
  summary: { missing: 1, derivable: 0, confirm: 1 },
};

process.stdout.write(`${JSON.stringify(apply ? afterApply : beforeApply, null, 1)}\n`);
