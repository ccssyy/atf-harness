/**
 * 批㊶-F-H 项 1——bash/write 类审批豁免 answerer（两案侦察后择案 A）。
 *
 * 弹卡根因（批㊶-E-H 实证）：bash-sandbox 三后端全断（容器 seccomp 禁命名空间＋内核
 * 5.4 无 Landlock）→ 每条 bash 先 SANDBOX_UNAVAILABLE → 模型带 sandbox_permissions
 * 重试 → 升级审批 ask → 人工面板逐次弹卡（同事 342 次）。分级原则（owner 裁）：
 * 读=免、写=会话信任、高危治理点=每次必弹——bash/write 类经本 answerer 自动
 * allowed-once，高危治理点（atf_* 契约工具全体：登记/训练/发布/config/评估 release/
 * gate）不进类 → next() 原路人工面板，审批语义零变化。
 *
 * 择案依据（报告同步）：案 B 所指 approvalHook（src/core/tools 审批判定面）不在该弹卡
 * 链路上——bash 卡走 DSH ApprovalService waterfall（'approval/request' 事件）至 client
 * 面板，不经 atf approvalHook；故豁免必须落 waterfall 头部（案 A）。案 A 亦无需逐会话
 * seed 机制：宿主级 listener 覆盖进程内全部会话，prepend 保证先于 api-remotes 的
 * client 转发桥（其 apply 先于 profile patch insert 行执行）。
 */
/** bash/write 类工具名（本部署 preset 实际挂载面：tool-bash='bash'；tool-fs 写类='write'/'edit'）。 */
export const BASH_WRITE_APPROVAL_TOOLS: ReadonlySet<string> = new Set(["bash", "write", "edit"]);

/** atf_* 前缀＝契约工具全体（高危治理点）——永远 next() 人工面板，语义零变化。 */
export const isAtfContractTool = (toolName: string): boolean => toolName.startsWith("atf_");

export const isBashWriteClass = (toolName: string): boolean => BASH_WRITE_APPROVAL_TOOLS.has(toolName);

/** ApprovalRequest 的消费面（结构类型——与 DSH ApprovalRequestEvent 最小交集）。 */
interface ExemptRequest {
  toolName?: unknown;
  reason?: unknown;
}

type Answerer = (request: ExemptRequest, next: () => Promise<string>) => Promise<string>;

/** 免审放行可见性（指令约束：stderr 告警保留——非隔离执行事实随放行落 stderr；asked/decided 审计对由审批服务照常落账）。 */
const warnExempt = (toolName: string, reason: unknown): void => {
  const what = toolName === "bash" ? "bash 以无隔离模式执行（免审）" : `${toolName} 以无隔离模式执行（免审）`;
  const brief = typeof reason === "string" && reason !== "" ? `；${reason.slice(0, 100)}` : "";
  process.stderr.write(`[atf-approval] 沙箱不可用，${what}${brief}\n`);
};

/**
 * 豁免 answerer（'approval/request' waterfall 头部形态）：
 * bash/write 类 → 返回 'allowed-once'（不调 next——审批请求不产生、面板不见）；
 * 其余（atf_* 全体与其余工具）→ next() 原路（人工面板／后续 answerer 语义零变化）。
 */
export const approvalExemptAnswerer: Answerer = async (request, next) => {
  const toolName = typeof request?.toolName === "string" ? request.toolName : "";
  if (!isBashWriteClass(toolName)) return next();
  warnExempt(toolName, request.reason);
  return "allowed-once";
};

/**
 * 宿主级注册（atf-tools apply() 调用）：prepend 抢 waterfall 头部——先于 api-remotes
 * 的 client 转发桥（后者 apply 更早，普通 on 会排在桥后致面板先弹）。
 * @returns 注册是否发生（ctx.on 缺席的裸装配面跳过——返回 false）。
 */
export const registerApprovalExempt = (ctx: {
  on?: (event: string, listener: Answerer, options?: { prepend?: boolean }) => unknown;
}): boolean => {
  if (typeof ctx.on !== "function") return false;
  ctx.on("approval/request", approvalExemptAnswerer, { prepend: true });
  return true;
};
