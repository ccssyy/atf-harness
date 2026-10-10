/**
 * 批㊶-Q 段1/段2——全自动训练档识别面（DSH permissionPresets 体系新档 auto_training）。
 *
 * 档位注册在部署 profile 层（poc/dsh-home/profiles/web/cordis.patch.yml——dev；spec＝
 * sandbox danger-full-access＋approval ask＋name 全自动训练），复用原生选择器/徽章 UI；
 * 「自动确认」语义在 ATF 工具层实现：训练链工具（atf_config_confirm／atf_run_training）
 * 在当前会话档位＝auto_training 时不走 requestApproval 阻塞，改走自动装配＋通报呈现
 * （alerts.json＋告警行）。档位/审批面变更仍须经用户界面人工操作（无静默边界＝裁定 2a）。
 *
 * fail-closed：permissionPresets 服务缺席/取态失败一律按手动档（阻塞审批语义不变）。
 */

/** 全自动训练档 machine key（profile 层注册同名键）。 */
export const AUTO_TRAINING_PRESET = "auto_training";

/** ctx 取 permissionPresets 服务的形态（vendor @deepseek-ai/dsh-permission-presets——结构类型零 import）。 */
export interface PermissionPresetsFace {
  current?: (session: unknown) => string;
  defaultPreset?: string;
  catalog?: () => { options: Array<{ value: string; name?: string }>; defaultPreset: string };
}

/** 当前会话生效档位 key（服务缺席/会话缺席/取态异常 → null，调用方回落手动语义）。 */
export const currentPresetKey = (ctx: { get(service: string): unknown }, exec: { agent?: unknown }): string | null => {
  try {
    const service = ctx.get("permissionPresets") as PermissionPresetsFace | undefined;
    if (service === undefined || typeof service.current !== "function") return null;
    const session = (exec as { agent?: { session?: unknown } }).agent?.session;
    if (session === undefined) return null;
    const key = service.current(session);
    return typeof key === "string" && key !== "" ? key : null;
  } catch {
    return null;
  }
};

/** 当前会话是否处于全自动训练档。 */
export const isAutoTrainingTier = (ctx: { get(service: string): unknown }, exec: { agent?: unknown }): boolean =>
  currentPresetKey(ctx, exec) === AUTO_TRAINING_PRESET;
