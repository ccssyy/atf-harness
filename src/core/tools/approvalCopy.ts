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

/** 聚类参数呈现层标签表（L1c 提前批 A2，2026-09-22；批 2.5 §三.2 增 values 闭集值域）——
 *  **单源落此**：ui/confirmCard 从本表导入（core 不 import 外壳，边界守卫方向下唯一合法落位）；
 *  文案不是第二权威，值闭集零复制——values 为 bridge.contract.yaml 已登记闭集的呈现层引用，
 *  漂移由内核 invalid_params fail-closed 拦截如实暴露。 */
export const CLUSTER_PARAM_LABELS: Readonly<Record<string, { label: string; meaning: string; values?: readonly string[] }>> = {
  algorithm_version: { label: "算法版本", meaning: "聚类算法的确定版本", values: ["bbox_layout_v1"] },
  granularity: { label: "分组粒度", meaning: "以什么为单位聚类（如按页）", values: ["page"] },
  metric: { label: "相似度量", meaning: "判断两页版式是否相似所用的度量", values: ["cosine"] },
  linkage: { label: "合并方式", meaning: "相似页归并成组的方式", values: ["average"] },
  threshold: { label: "相似阈值", meaning: "多相似才算同类", values: ["auto_candidates"] },
  min_cluster_size: { label: "最小组容量", meaning: "一组至少含多少样本", values: ["1"] },
};

/** 逐参数中文回显实际提交值（确认保真三道防线之三的呈现半边——漂移在审批弹窗被看见；
 *  只提示不拦截，拦截归内核闭集校验）。 */
const clusterParamsEcho = (params: unknown): string => {
  const cluster = (params as { cluster_params?: unknown } | null)?.cluster_params;
  if (typeof cluster !== "object" || cluster === null || Array.isArray(cluster)) return "";
  const entries = Object.entries(cluster as Record<string, unknown>);
  if (entries.length === 0) return "";
  const parts = entries.map(([key, value]) => {
    const known = CLUSTER_PARAM_LABELS[key];
    return `${known?.label ?? key}=${JSON.stringify(value) ?? "（不可显示）"}`;
  });
  return `实际提交参数——${parts.join("、")}`;
};

const ratioPercentText = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([, item]) => typeof item === "number")) return null;
  return entries.map(([key, item]) => `${key} ${String(Math.round((item as number) * 100))}%`).join("／");
};

/** D-4 文案映射（现仅 R1/K-Gap-2 新工具；存量工具的产品语言改造归 L1c/R3，不在本批）。
 *  K-Gap-2（2026-09-21）：准入申请文案在携带确认态 split_policy 时显式标注（放行已定
 *  动作——弹窗呈现的即用户已确认的策略，含修改）；聚类执行新增人读文案。
 *  L1c 提前批 A2（2026-09-22）：聚类执行升级逐参数中文回显；准入申请补划分比例回显。 */
const APPROVAL_COPY: Readonly<Record<string, ApprovalCopyBuilder>> = {
  atf_data_admission_request: (params) => {
    const base = `数据准入申请：对数据集 ${paramString(params, "dataset_id")} 执行真实数据校验并落盘判定结果（可能因标注冲突需要人工裁决）`;
    const policy = (params as { split_policy?: unknown } | null)?.split_policy;
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return base;
    const ratio = ratioPercentText((policy as Record<string, unknown>)["target_ratios"]);
    return `${base}；划分方式按你已确认的策略执行${ratio !== null ? `（划分比例 ${ratio}）` : ""}（可在放行前继续修改）`;
  },
  atf_style_cluster_execute: (params) => {
    const base = `版式聚类执行：对数据集 ${paramString(params, "dataset_id")} 按你确认的聚类参数执行确定性聚类并落盘产物（结果将用于后续数据划分的版式分层）`;
    const echo = clusterParamsEcho(params);
    return echo !== "" ? `${base}。${echo}` : base;
  },
  // 批 3「创作执行面」（2026-09-22）：工作区工具审批人读文案。
  atf_scratch_exec: (params) => {
    const argv = (params as { argv?: unknown } | null)?.argv;
    const commandText = Array.isArray(argv) && argv.every((part) => typeof part === "string")
      ? (argv as string[]).join(" ")
      : "（argv 非法）";
    return `受控执行：在本次运行的工作区 scratch 内执行命令「${commandText}」（工作目录限 scratch、环境白名单、输出上限与超时保护；产物只落 scratch）`;
  },
  atf_launch_execute: (params) => {
    const launchSh = paramString(params, "launch_sh");
    const config = paramString(params, "config");
    const configNote = config !== "（未提供）" ? `；按配置 ${config} 登记放行记录` : "；未附配置（不登记放行记录，按账本现状执行）";
    return `训练启动放行：执行 ${launchSh}${configNote}——确认后训练进程即被启动（此为真实执行点）`;
  },
};

export const approvalCopyFor = (input: { tool: string; params: unknown }): string | null => {
  const builder = APPROVAL_COPY[input.tool];
  if (builder === undefined) return null;
  return builder(input.params);
};
