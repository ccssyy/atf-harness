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
 * 链路上——bash 卡走 DSH ApprovalService waterfall（approval/request 事件）至 client
 * 面板，不经 atf approvalHook；故豁免必须落 waterfall 头部（案 A）。案 A 亦无需逐会话
 * seed 机制：宿主级 listener 覆盖进程内全部会话，prepend 保证先于 api-remotes 的
 * client 转发桥（其 apply 先于 profile patch insert 行执行）。
 *
 * owner 2026-10-26 裁定（两轴改造）：本 answerer 由「只认工具名」改为「档位 + 预设
 * 双感知」。训练链工具（43/43 段调用 100% 弹卡实测）在
 *   ①预设声明该工具 ∈ chainTools 且 ②用户权限档 = danger-full-access
 * 同时成立时免审；任一不成立一律 next()。理由：豁免是便利、权限是授权——用户没给完全
 * 权限时预设不得自行放大能力，否则是 agent 越过用户自我提权。
 * 命中判定显式列举工具名（**禁 atf_ 前缀匹配**：前缀会把训练启动/发布/评估 release
 * 等治理点一起放掉）。治理点（atf_run_training／atf_publish_*／atf_launch_execute／
 * atf_joint_train／atf_gate／atf_admit_data／atf_scratch_exec）永不出现在 chainTools。
 */
import { ATF_TRAINING_PRESET, isPresetAutopilot, type ExecSessionFace, type ServiceCtxFace } from "./trainingPreset.js";

/**
 * bash/write 类工具名（vendor 面：tool-bash=bash；tool-fs 写类=write/edit）。
 *
 * ⚠ atf_bash 不在此集合（owner 2026-10-26 裁定）：A7 治理面把 bash 换成了 atf_bash
 * （fileGuardFace：白名单守卫＋命令串扫描），它的审批面是**独立**的——只在破坏性命令
 * （D23 递归删除）时经 requestApproval 出卡，且必须以「逐次人工确认」结案。若把 atf_bash
 * 并进本集合，等于把递归删除卡也变成免审，与 D23 裁定冲突。故此处只收 vendor 三名，
 * atf_bash 恒走 next()（是裁定，不是漏配）。 */
export const BASH_WRITE_APPROVAL_TOOLS: ReadonlySet<string> = new Set(["bash", "write", "edit"]);

/** atf_* 前缀＝契约工具全体（高危治理点）——永远 next() 人工面板，语义零变化。 */
export const isAtfContractTool = (toolName: string): boolean => toolName.startsWith("atf_");

export const isBashWriteClass = (toolName: string): boolean => BASH_WRITE_APPROVAL_TOOLS.has(toolName);

/**
 * 训练链豁免声明（overlay 侧 atf-tools config.approvalPolicy——预设声明 + 工具白名单）。
 * `preset`＝声明该链的 Agent 预设 id；`chainTools`＝显式工具名清单（禁前缀/通配）。
 * 两者皆由 profile 配置给出，代码零硬编码工具名——预设间的工具集差异只落配置。
 */
export interface ApprovalExemptPolicy {
  readonly preset?: string;
  readonly chainTools?: readonly string[];
}

/** ApprovalRequest 的消费面（结构类型——与 DSH ApprovalRequestEvent 最小交集）。 */
interface ExemptRequest extends ExecSessionFace {
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

/** 训练链工具命中的事实通报（与 bash 类告警同纪律：放行必留痕，且带上放行依据两轴）。 */
const warnChainExempt = (toolName: string, preset: string): void => {
  process.stderr.write(`[atf-approval] 训练链工具 ${toolName} 免审放行（预设=${preset}／权限档=danger-full-access）\n`);
};

/**
 * 豁免判定单源（档位 + 预设双感知）：
 * - bash/write 类：原有语义不变（不看档位/预设，恒 allowed-once）；
 * - 训练链工具：预设声明 ∈ chainTools **且** isTrainingAutopilot 才放行；
 *   其余（含全部治理点）→ next()。
 * @returns allowed-once 表示免审放行，null 表示交给 waterfall 后续 answerer。
 */
export const exemptOutcomeOf = (
  request: ExemptRequest,
  deps: { ctx?: ServiceCtxFace; policy?: ApprovalExemptPolicy },
): { outcome: "allowed-once"; basis: "bash-write" | "chain" } | null => {
  const toolName = typeof request?.toolName === "string" ? request.toolName : "";
  if (isBashWriteClass(toolName)) return { outcome: "allowed-once", basis: "bash-write" };
  const { ctx, policy } = deps;
  if (ctx === undefined || policy === undefined) return null;
  const chainTools = policy.chainTools ?? [];
  // 显式列举命中（禁前缀匹配——前缀会连带放行训练启动/发布/release 等治理点）
  if (!chainTools.includes(toolName)) return null;
  // 两轴齐备：配置声明的预设 = 当前会话预设（声明漂移即不放行）且权限档 = 完全权限。
  if (!isPresetAutopilot(ctx, request, policy.preset ?? ATF_TRAINING_PRESET)) return null;
  return { outcome: "allowed-once", basis: "chain" };
};

/**
 * answerer 工厂（approval/request waterfall 头部形态）：deps 携带 ctx 与 overlay 声明，
 * 缺省（无 ctx／无声明）＝仅 bash/write 类豁免，其余一律 next()。
 */
export const makeApprovalExemptAnswerer = (
  deps: { ctx?: ServiceCtxFace; policy?: ApprovalExemptPolicy } = {},
): Answerer => async (request, next) => {
  const hit = exemptOutcomeOf(request, deps);
  if (hit === null) return next();
  const toolName = typeof request?.toolName === "string" ? request.toolName : "";
  if (hit.basis === "bash-write") warnExempt(toolName, request.reason);
  else warnChainExempt(toolName, deps.policy?.preset ?? "");
  return "allowed-once";
};

/** 无装配面直接调用形态（bash/write 类语义单源；训练链判定需 ctx，故此处仅前一类）。 */
export const approvalExemptAnswerer: Answerer = makeApprovalExemptAnswerer();

/**
 * 宿主级注册（atf-tools apply() 调用）：prepend 抢 waterfall 头部——先于 api-remotes
 * 的 client 转发桥（后者 apply 更早，普通 on 会排在桥后致面板先弹）。
 * @returns 注册是否发生（ctx.on 缺席的裸装配面跳过——返回 false）。
 */
export const registerApprovalExempt = (
  ctx: {
    on?: (event: string, listener: Answerer, options?: { prepend?: boolean }) => unknown;
    get?: (service: string) => unknown;
  },
  policy?: ApprovalExemptPolicy,
): boolean => {
  if (typeof ctx.on !== "function") return false;
  const serviceCtx = typeof ctx.get === "function" ? { get: (service: string): unknown => ctx.get?.(service) } : undefined;
  ctx.on("approval/request", makeApprovalExemptAnswerer({ ctx: serviceCtx, policy }), { prepend: true });
  return true;
};
