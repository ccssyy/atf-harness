/**
 * 审批请求人读文案映射（R1 接线批 D-4，2026-09-20；R3 产品语言联动）。
 *
 * 按工具名取产品语言文案，替代机制态的原始参数 JSON 展示（机制词 gates/summary_sha256 等
 * 不向用户暴露）；未登记映射的工具返回 null——呈现层维持既有渲染（零行为变化）。
 * 本映射只影响**呈现**，不触碰 B8/CAS 判定流（问答轨编排、账本轨、verdict 语义零改动）。
 */

type ApprovalCopyBuilder = (params: unknown) => string;

const paramString = (params: unknown, key: string): string => {
  if (typeof params === "object" && params !== null && key in params) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "（未提供）";
};

/** D-4 文案映射（现仅 R1/K-Gap-2 新工具；存量工具的产品语言改造归 L1c/R3，不在本批）。
 *  K-Gap-2（2026-09-21）：准入申请文案在携带确认态 split_policy 时显式标注（放行已定
 *  动作——弹窗呈现的即用户已确认的策略，含修改）；聚类执行新增人读文案。 */
const APPROVAL_COPY: Readonly<Record<string, ApprovalCopyBuilder>> = {
  atf_data_admission_request: (params) => {
    const base = `数据准入申请：对数据集 ${paramString(params, "dataset_id")} 执行真实数据校验并落盘判定结果（可能因标注冲突需要人工裁决）`;
    const policy = (params as { split_policy?: unknown } | null)?.split_policy;
    return typeof policy === "object" && policy !== null ? `${base}；划分方式按你已确认的策略执行（可在放行前继续修改）` : base;
  },
  atf_style_cluster_execute: (params) =>
    `版式聚类执行：对数据集 ${paramString(params, "dataset_id")} 按你确认的聚类参数执行确定性聚类并落盘产物（结果将用于后续数据划分的版式分层）`,
};

export const approvalCopyFor = (input: { tool: string; params: unknown }): string | null => {
  const builder = APPROVAL_COPY[input.tool];
  if (builder === undefined) return null;
  return builder(input.params);
};
