/**
 * 全自动档的提问面守卫（D90 第三档）。
 *
 * 档位语义（见 permissionTier.ts）：全自动档「不弹任何卡」——审批卡由 approvalExempt
 * 放行，问题卡由本守卫接住。接法不是替用户乱选一个答案，而是**把决定权交回 agent**：
 * 抛一条可读错误，明确告诉它「没人可以问，请自己判断并继续，并在结论里说明哪些是
 * 你代为决定的」。
 *
 * 为什么不是自动选第一项：那会伪造一个「用户选择」的事实，比不问更坏——账本会记成
 * 用户选的。本档只允许 `decided_by: agent`，所以答案只能由 agent 产生。
 *
 * 与 approvalExempt 对称：两者都挂在 waterfall 头部（prepend），都只对全自动档生效，
 * 别的档位一律 next()——排队在后面的原生面板照常弹。
 */
import { permissionTierOf, type PermissionTier } from "./permissionTier.js";
import type { ExecSessionFace, ServiceCtxFace } from "./trainingPreset.js";

/** 全自动档拒绝提问时给模型的行为指引（业务无关，禁出现档位内部名）。 */
export const UNATTENDED_DECIDE_MESSAGE =
  "当前会话处于全自动模式，没有可询问的用户。不要等待答复："
  + "请你自行作出判断并继续执行，在你给用户的结论里明确说明本次哪些决定是你代为做出的、依据是什么。"
  + "禁止把未确认当成已确认，也不得声称用户已同意。";

interface QuestionRequest extends ExecSessionFace {
  readonly questions?: readonly unknown[];
}

type Answerer = (request: QuestionRequest, next: () => Promise<unknown>) => Promise<unknown>;

/** 判定单源（导出以便测试：tier 由注入的 ctx 决定，不读全局状态）。 */
export const unattendedDecideOutcomeOf = (
  request: QuestionRequest,
  deps: { ctx?: ServiceCtxFace },
): boolean => {
  if (deps.ctx === undefined) return false;
  const tier: PermissionTier = permissionTierOf(deps.ctx, request);
  return tier === "unattended";
};

/** answerer 工厂：全自动档 → 抛行为指引；其它档 → next()（原生面板照常）。 */
export const makeUnattendedQuestionAnswerer = (
  deps: { ctx?: ServiceCtxFace } = {},
): Answerer => async (request, next) => {
  if (!unattendedDecideOutcomeOf(request, deps)) return next();
  const count = Array.isArray(request.questions) ? request.questions.length : 0;
  process.stderr.write(`[atf-approval] 全自动档：拒发问题卡（${String(count)} 问）——交回模型自行判断\n`);
  throw new Error(UNATTENDED_DECIDE_MESSAGE);
};

/**
 * 宿主级注册（atf-tools apply() 调用）：prepend 抢 `user-questions/request` waterfall 头部。
 * @returns 注册是否发生（ctx.on 缺席的裸装配面跳过——返回 false）。
 */
export const registerUnattendedQuestionGuard = (ctx: {
  on?: (event: string, listener: Answerer, options?: { prepend?: boolean }) => unknown;
  get?: (service: string) => unknown;
}): boolean => {
  if (typeof ctx.on !== "function") return false;
  const serviceCtx: ServiceCtxFace | undefined =
    typeof ctx.get === "function" ? { get: (service: string): unknown => ctx.get?.(service) } : undefined;
  ctx.on("user-questions/request", makeUnattendedQuestionAnswerer({ ctx: serviceCtx }), { prepend: true });
  return true;
};
