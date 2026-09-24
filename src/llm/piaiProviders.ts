/**
 * pi-ai provider 目录工厂（批 P 增补 §一「GLM 目录参数化」，指令 56170242）——
 * 两线同路径：runner 线 PiAiLlmProvider 与丙线 providerStreamFn 共用本单点。
 *
 * 参数化口径：按 config.provider_id 查目录（zai-coding-cn／deepseek／后续 provider 均走
 * 同一工厂），目录未含时 fail-closed（不猜、不回退 deepseek）。
 *
 * compat 地板（provider 级不可开启项）：zai-coding-cn 走 thinkingFormat=zai（思考由
 * 对端内建，reasoning effort 参数不下发）——supports_reasoning_effort 地板为 false，
 * 与用户 compat 取交集（false 不可被配置开启）。GLM 非推理路径（glm-5.3-flash）由此
 * 保证零 effort 下发。
 */
import type { Provider } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";

/** 参数化闭集（pi-ai 目录内建 provider；新增经本表显式登记）。 */
export const PIAI_PROVIDER_IDS: readonly string[] = ["deepseek", "zai-coding-cn"];

/** provider 级 compat 地板（false 不可被配置开启；true 不干预）。 */
export const PIAI_PROVIDER_COMPAT_FLOOR: Readonly<Record<string, { supports_reasoning_effort?: boolean }>> = {
  "zai-coding-cn": { supports_reasoning_effort: false },
};

/** provider_id → pi-ai Provider 实例（未知 id fail-closed throw——构造期拒绝，不回退）。 */
export const piaiProviderFactory = (providerId: string): Provider => {
  switch (providerId) {
    case "deepseek":
      return deepseekProvider();
    case "zai-coding-cn":
      return zaiCodingCnProvider();
    default:
      throw new Error(
        `pi-ai provider 目录未含 ${JSON.stringify(providerId)}（fail-closed；已登记：${PIAI_PROVIDER_IDS.join("/")}——新增 provider 走 piaiProviders.ts 显式登记）`,
      );
  }
};

/** compat 地板应用（用户 compat 与 provider 地板取交集；false 恒胜出）。 */
export const applyPiaiCompatFloor = (
  providerId: string,
  compat: { supports_developer_role: boolean; supports_reasoning_effort: boolean },
): { supports_developer_role: boolean; supports_reasoning_effort: boolean } => {
  const floor = PIAI_PROVIDER_COMPAT_FLOOR[providerId];
  if (floor?.supports_reasoning_effort === true) return compat;
  return {
    supports_developer_role: compat.supports_developer_role,
    supports_reasoning_effort: floor?.supports_reasoning_effort === false ? false : compat.supports_reasoning_effort,
  };
};
