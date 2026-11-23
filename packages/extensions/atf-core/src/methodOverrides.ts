/**
 * 工具名 → RPC 方法映射单源（批㊶-H 丙线共享内核收口·镜像面①；owner 会话 10-06
 * 19:46 定案，门 2 工单前置落地）。
 *
 * 收口前形态（批㊲ 实锚）：core/tools/executor.ts 与 agent/atfAgentTools.ts 各持一份
 * 同表 TOOL_METHOD_OVERRIDES（各自 rpcMethodFor 折叠），同表漂移风险＝新增点号方法时
 * 改一漏一。本模块为唯一表源——两线统一 import 本出口，守护测试
 * （tests/tools/methodOverrides.test.ts）锚两线发射一致性＋静态防再分叉。
 */

/** 模型面工具名 → 桥接 RPC 方法的显式映射（R1 D-1，2026-09-20）：模型面工具名不允许
 *  "."，点号方法经此表映射；未注册项恒等映射（既有工具零行为变化）。
 *  K-Gap-2 接线批（2026-09-21）增两项（方法面 10→12）。
 *  R-3 接线批（2026-09-23）增两项（方法面 12→14，内核 §13.13/§13.14）。 */
export const TOOL_METHOD_OVERRIDES: Readonly<Record<string, string>> = {
  atf_data_admission_request: "atf_data_admission.request",
  atf_preparation_propose: "atf_preparation.propose",
  atf_style_cluster_execute: "atf_style_cluster.execute",
  atf_label_qc_inspect: "atf_label_qc.inspect",
  atf_label_qc_resolve: "atf_label_qc.resolve",
};

/** 折叠单源（甲线 executor 与丙线 atfAgentTools 同一出口消费；未注册项恒等映射）。 */
export const rpcMethodFor = (toolName: string): string => TOOL_METHOD_OVERRIDES[toolName] ?? toolName;
