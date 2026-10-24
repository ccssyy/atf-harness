/**
 * F1 测试夹具——schema 不符对端：输出缺 summary 键的畸形报告（harness 侧
 * fail-closed 校验锚：固定 schema 不符即结构化拒绝，不猜不修）。
 */
process.stdout.write(`${JSON.stringify({ generated_at: "2026-10-24T08:00:00Z", items: [], order: [] }, null, 1)}\n`);
