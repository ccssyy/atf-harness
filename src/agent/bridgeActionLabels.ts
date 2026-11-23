/**
 * E8b·H3 D152——桥接工具业务动作名单源（卡面零内部工具名：atf_* 名只进日志与审计面）。
 *
 * E8c 起提升为本文件双侧可达单源：消费方＝packages/atf-tools bridgeFace（桥接通用
 * 审批卡 action）与 src/webui gpuQueue（GPU 队列命中确认卡 estimate）——两侧 import
 * 方向各自合法（packages→src/agent、webui→src/agent），禁再建第二套文案表。
 * 映射缺项不冒充具体动作：D318 起 buildApprovalReason 对泛化 fallback fail-fast
 * （生产端闸——零决策内容的泛化审批卡不可发），映射缺项=调用点按语义重定性。
 */
export const BRIDGE_ACTION_LABELS: Readonly<Record<string, string>> = {
  atf_workspace_status: "查看训练工作区状态",
  atf_admit_data: "登记训练数据集",
  atf_label_qc_inspect: "抽检标注质量",
  atf_gate: "调用流程闸门核验",
  atf_launch_execute: "启动训练编排",
  atf_create_experiment: "创建训练实验",
  atf_rebind_workspace: "变更会话工作区绑定",
};
