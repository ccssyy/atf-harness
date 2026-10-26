/**
 * 训练预设识别面（Agent 预设轴）——owner 2026-10-26 裁定：全自动训练的识别单源。
 *
 * 历史（批㊶-Q）：同一意图曾做成权限档 `auto_training`（permission.presets 第四档），
 * 三重错位——语义（权限档写成角色）、归属（让用户在权限菜单选产品形态）、传导
 * （ATF 用「当前权限档」决定业务流程，权限与预设两轴纠缠）。本文件为退役后的替代：
 * 识别只读 **Agent 预设**（会话投影 `agentPreset`，见 vendor agent-preset-registry
 * session.ts），权限档只回答「能碰多远」，不再回答「我是谁」。
 *
 * 两轴交汇规则（owner 裁定）：预设声明 + 完全权限**同时成立**才视为自动驾驶。
 * 豁免是便利、权限是授权——预设不得在用户未给完全权限时自行放大能力，否则即
 * agent 越过用户自我提权。故任一轴缺席一律回落人工面板（fail-closed 语义不变）。
 */
/** 训练预设 machine id（profile 层 preset 注册同名 id）。 */
export const ATF_TRAINING_PRESET = "atf-training";

/** 完全权限档的 sandbox 值（判据＝sandbox 值而非档位名——档位名可改、语义不可改）。 */
export const DANGER_FULL_ACCESS_SANDBOX = "danger-full-access";

/** ctx 取服务形态（结构类型零 import——与 vendor 实现解耦）。 */
export interface ServiceCtxFace {
  get(service: string): unknown;
}

/** exec 的最小交集：agent.session 是两轴读取点（agent 形态在两侧装配面并不统一，运行时收窄）。 */
export interface ExecSessionFace {
  readonly agent?: unknown;
}

interface PermissionPresetsFace {
  current?: (session: unknown) => string;
  resolve?: (name: string) => { sandbox?: unknown };
}

interface SessionProjectionsFace {
  stateOf?: (session: unknown, key: string) => unknown;
}

const sessionOf = (exec: ExecSessionFace): unknown => {
  const agent = exec?.agent;
  if (agent === null || typeof agent !== "object") return undefined;
  return (agent as { readonly session?: unknown }).session;
};

/** 当前会话的 Agent 预设 id（投影为准——创建头只记初值，切预设后投影才是真值）。 */
export const agentPresetOf = (ctx: ServiceCtxFace, exec: ExecSessionFace): string | null => {
  try {
    const session = sessionOf(exec);
    if (session === undefined) return null;
    const projections = ctx.get("sessionProjections") as SessionProjectionsFace | undefined;
    if (projections === undefined || typeof projections.stateOf !== "function") return null;
    const value = projections.stateOf(session, "agentPreset");
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
};

/** 当前会话的沙箱档（sandbox 值：权限档经 permissionPresets 解析，缺席回落会话投影）。 */
export const sandboxModeOf = (ctx: ServiceCtxFace, exec: ExecSessionFace): string | null => {
  const session = sessionOf(exec);
  if (session === undefined) return null;
  try {
    const presets = ctx.get("permissionPresets") as PermissionPresetsFace | undefined;
    if (presets !== undefined && typeof presets.current === "function" && typeof presets.resolve === "function") {
      const spec = presets.resolve(presets.current(session));
      const sandbox = spec?.sandbox;
      if (typeof sandbox === "string" && sandbox !== "") return sandbox;
    }
  } catch { /* 档位非预设派生（custom）——回落投影 */ }
  try {
    const projections = ctx.get("sessionProjections") as SessionProjectionsFace | undefined;
    const value = projections?.stateOf?.(session, "sandboxMode");
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
};

/** 两轴交汇判据（预设 id 由调用方给出——配置声明的预设不写死在判据里）。 */
export const isPresetAutopilot = (ctx: ServiceCtxFace, exec: ExecSessionFace, preset: string): boolean =>
  preset !== "" && agentPresetOf(ctx, exec) === preset
  && sandboxModeOf(ctx, exec) === DANGER_FULL_ACCESS_SANDBOX;

/** 训练自动驾驶是否成立：预设 = 训练预设 **且** 权限档 = 完全权限（两轴齐备）。 */
export const isTrainingAutopilot = (ctx: ServiceCtxFace, exec: ExecSessionFace): boolean =>
  isPresetAutopilot(ctx, exec, ATF_TRAINING_PRESET);
