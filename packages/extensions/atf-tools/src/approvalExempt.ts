/**
 * ADR-0022 直通留痕器（原批㊶-F-H 项 1 审批豁免 answerer——「豁免拦截」语义随工具执行
 * 审批拦截退役，平移为「直通留痕」：水瀑（approval/request waterfall）头部 prepend 原位
 * 不变，敏感闭集命中写 exemptions.jsonl 留痕后放行；非敏感闭集 next() 交回后链
 * （atf_* 契约工具的业务确认卡照常出卡，B 层不经过本面）。
 *
 * 留痕闭集（ADR-0022 实施批决策点 4，owner 确认敏感闭集方案）：
 *   - bash/write/edit 三件（vendor 面——批㊶-E-H 342 次弹卡教训的审计面延续）；
 *   - chainTools（overlay 配置 approvalPolicy.chainTools 显式清单——训练链留痕）。
 * 原 D90 双轴（预设声明+完全权限档）与 D284 headless env basis（审批轴）随档位审批
 * 退役——直通形态无轴，命中即留痕放行。
 *
 * 留账纪律（ADR-0019 底线不破）：写账失败＝stderr 告警后照常放行（直通形态下无
 * 「不放行」语义可回退——决策点 8 裁定 fail-open+告警；账本面故障经启动校验
 * checkApprovalLedgerStartup fail-fast 兜底）。
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * bash/write 类工具名（vendor 面：tool-bash=bash；tool-fs 写类=write/edit）。
 *
 * ⚠ atf_bash 不在此集合（owner 2026-10-26 裁定）：A7 治理面把 bash 换成了 atf_bash
 * （fileGuardFace：白名单守卫＋命令串扫描），它的确认面是**独立**的——破坏性命令
 * （D23 递归删除）经 requestApproval 出卡，且必须以「逐次人工确认」结案（B 层，
 * ADR-0022 不动）。故此处只收 vendor 三名。
 */
export const BASH_WRITE_APPROVAL_TOOLS: ReadonlySet<string> = new Set(["bash", "write", "edit"]);

/** atf_* 前缀＝契约工具全体（治理点/裁决确认卡）——永远 next() 人工面板，B 层语义零变化。 */
export const isAtfContractTool = (toolName: string): boolean => toolName.startsWith("atf_");

export const isBashWriteClass = (toolName: string): boolean => BASH_WRITE_APPROVAL_TOOLS.has(toolName);

/**
 * 训练链留痕声明（overlay 侧 atf-tools config.approvalPolicy——预设声明 + 工具白名单）。
 * `preset`＝声明该链的 Agent 预设 id；`chainTools`＝显式工具名清单（禁前缀/通配）。
 * 两者皆由 profile 配置给出，代码零硬编码工具名——ADR-0022 后 preset 仅作声明留痕
 * （exemptions 行的 preset 字段），不再参与放行判定（直通无轴）。
 */
export interface ApprovalExemptPolicy {
  readonly preset?: string;
  readonly chainTools?: readonly string[];
}

/** ApprovalRequest 的消费面（结构类型——与 DSH ApprovalRequestEvent 最小交集）。 */
interface ExemptRequest {
  toolName?: unknown;
  reason?: unknown;
}

type Answerer = (request: ExemptRequest, next: () => Promise<string>) => Promise<string>;

/** 直通放行可见性（放行必留痕纪律的 stderr 半边——非隔离执行事实随放行落 stderr）。 */
const warnDirect = (toolName: string, reason: unknown, basis: "bash-write" | "chain"): void => {
  const brief = typeof reason === "string" && reason !== "" ? `；${reason.slice(0, 100)}` : "";
  const basisText = basis === "bash-write" ? "bash/write 类" : "训练链";
  process.stderr.write(`[atf-approval] ${toolName} 直通放行（${basisText}留痕，ADR-0022）${brief}\n`);
};

/**
 * 直通留痕判定单源（ADR-0022）：
 * - bash/write 类：留痕闭集（原语义不看档位）；
 * - chainTools 显式清单命中：留痕闭集（原双轴判定随档位审批退役）；
 * - atf_* 契约工具：null（next()——业务确认卡保护，B 层不经本面）；
 * - 其余：null（next()——vendor 面板兜底）。
 */
export const exemptOutcomeOf = (
  request: ExemptRequest,
  deps: { policy?: ApprovalExemptPolicy } = {},
): { outcome: "allowed-once"; basis: "bash-write" | "chain" } | null => {
  const toolName = typeof request?.toolName === "string" ? request.toolName : "";
  if (isAtfContractTool(toolName)) return null;
  if (isBashWriteClass(toolName)) return { outcome: "allowed-once", basis: "bash-write" };
  const chainTools = deps.policy?.chainTools ?? [];
  if (chainTools.includes(toolName)) return { outcome: "allowed-once", basis: "chain" };
  return null;
};

/**
 * 直通留痕（ADR-0019 决定 1 语义平移）：敏感闭集命中 append Approval Ledger 同目录的
 * exemptions.jsonl（append-only 一行一 JSON：ts/tool/basis/preset）。写账失败＝stderr
 * 告警后照常放行（直通形态 fail-open——决策点 8；启动校验 fail-fast 兜底账本面故障）。
 */
export const appendExemptionRecord = async (
  toolName: string,
  basis: "bash-write" | "chain",
  preset?: string,
): Promise<boolean> => {
  try {
    const dir = join(homedir(), ".atf", "approval-ledger");
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), tool: toolName, basis, ...(preset ? { preset } : {}) }) + "\n";
    await appendFile(join(dir, "exemptions.jsonl"), line, "utf8");
    return true;
  } catch {
    return false;
  }
};

/**
 * 直通留痕器工厂（waterfall 头部形态——挂载位与签名原位平移）：deps 携带 overlay 声明。
 */
export const makeApprovalExemptAnswerer = (
  deps: { policy?: ApprovalExemptPolicy } = {},
): Answerer => async (request, next) => {
  const hit = exemptOutcomeOf(request, deps);
  if (hit === null) return next();
  const toolName = typeof request?.toolName === "string" ? request.toolName : "";
  // 直通留痕先行：写账失败 stderr 告警（fail-open——直通无「不放行」可回退）
  const recorded = await appendExemptionRecord(toolName, hit.basis, deps.policy?.preset);
  if (!recorded) {
    console.warn(`[atf-tools] 直通留痕写账失败，${toolName} 照常放行（fail-open 告警，ADR-0019 审计缺口如实暴露）`);
  }
  warnDirect(toolName, request.reason, hit.basis);
  return "allowed-once";
};

/** 无装配面直接调用形态（bash/write 类语义单源；训练链判定需 policy，故此处仅前一类）。 */
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
  ctx.on("approval/request", makeApprovalExemptAnswerer({ policy }), { prepend: true });
  return true;
};
