/**
 * 批㊶-ISO-2 S1——实例 pin 根单源（共用面彻底隔离：pin 分实例）。
 *
 * 审计实锚（门1件 §一.S1）：dev.env 与 uat.env 的 pin 消费点逐字指向同一仓内共享 pin
 * worktree——PIN 刷新即全局生效，"UAT 维持旧态"只对常驻进程成立（walkthrough/评估等按次
 * 拉起的子命令已被劫持到新 pin）。收口＝路径消费单源化：
 *   resolveInstancePinRoot()＝ATF_INSTANCE_PIN_ROOT（实例显式 pin——生效段各实例独立 pin
 *   树落盘后指向各自 worktree，re-pin 按实例）＞ 兼容回退 <repoRoot>/.atf-pinned（共享态
 *   ——boot preflight 留痕「pin 路径：回退共享态」，ISO-2 生效段前全实例走此态）。
 * kernelDir 消费链保持既有覆盖轴在前：ATF_DSH_KERNEL_DIR ＞ ATF_CLI_PATH ＞ 本单源。
 * 生产面禁止裸写 .atf-pinned 路径字面量（fence 锚防回潮——本模块 LEGACY_PIN_ROOT_RELPATH
 * 是全仓生产面唯一字面量落点）。
 */
import { join } from "node:path";

/** 实例 pin 根 env（ISO-2 生效段：dev/uat.env 六项显式化之一）。 */
export const INSTANCE_PIN_ROOT_ENV = "ATF_INSTANCE_PIN_ROOT";
/** 兼容回退：仓内共享 pin worktree（唯一字面量落点——fence 锚白名单仅本文件）。 */
export const LEGACY_PIN_ROOT_RELPATH = ".atf-pinned";

export interface InstancePinResolution {
  root: string;
  /** env＝实例显式 pin；fallback＝仓内共享态（boot preflight 留痕）。 */
  source: "env" | "fallback";
  /** boot 留痕文案（fallback 非 null——「pin 路径：回退共享态」）。 */
  note: string | null;
}

/** 实例 pin 根解析（单源——env 显式值优先，未设回退仓内共享态并带留痕）。 */
export const resolveInstancePinRoot = (
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
): InstancePinResolution => {
  const explicit = env[INSTANCE_PIN_ROOT_ENV]?.trim() ?? "";
  if (explicit !== "") return { root: explicit, source: "env", note: null };
  return {
    root: join(repoRoot, LEGACY_PIN_ROOT_RELPATH),
    source: "fallback",
    note: `pin 路径：回退共享态（${LEGACY_PIN_ROOT_RELPATH}）——实例 pin 未配置（${INSTANCE_PIN_ROOT_ENV}，ISO-2 生效段切实例 pin）`,
  };
};

/** kernelDir 消费链单源（ATF_DSH_KERNEL_DIR ＞ ATF_CLI_PATH ＞ 实例 pin 根）——
 *  atf-tools Config／atf-ui 徽标面／agent spike 装配共用，防各处回退分叉。 */
export const resolveInstanceKernelDir = (env: Readonly<Record<string, string | undefined>>, repoRoot: string): string => {
  const dshKernel = env["ATF_DSH_KERNEL_DIR"]?.trim() ?? "";
  if (dshKernel !== "") return dshKernel;
  const cliPath = env["ATF_CLI_PATH"]?.trim() ?? "";
  if (cliPath !== "") return cliPath;
  return resolveInstancePinRoot(env, repoRoot).root;
};
