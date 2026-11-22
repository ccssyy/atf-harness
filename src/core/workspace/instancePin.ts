/**
 * 内核目录解析单源（G7／D9 裁定：pin 树退役——本模块不再含任何 pin 概念）。
 *
 * 沿革：本文件原为「批㊶-ISO-2 S1 实例 pin 根单源」——读实例 pin 根 env、缺省回退仓内
 * 共享 pin worktree（`.atf-pinned`），并供 boot preflight 做 pin 树 worktree 实锚校验。
 * D9 裁定「pin 树承认退役（dev 实际跑主仓 main）」后：pin 树不再是加载源，实例 env 的
 * pin 根声明、仓内共享 pin 回退、pin tag↔版本串一致性门一并退役（G7 执行本批）。
 *
 * 现行职责只剩一件：内核目录怎么定。
 *   ATF_DSH_KERNEL_DIR ＞ ATF_CLI_PATH ＞ ATF_KERNEL_SOURCE ＞ 兄弟目录缺省
 *   （<repoRoot>/../AgenticTrainingFlow，双仓同父布局）；都没有＝空串。
 *
 * 为什么空串而不是拼一个猜测路径：空串会被 boot preflight 的 hasKernelDir 判假并
 * L2 fail-fast（指名缺哪个 env）——「解析不到就报错」比「静默指向一个多半不存在的
 * 目录」可诊断得多。pin 时代的 `.atf-pinned` 回退恰好属于后者（目录常在、内容可旧），
 * 是 1109 假绿事故的温床，本次一并消失。
 *
 * 兼容面（不动）：packages/extensions/** 属工具面，本批禁改，仍按原 import 路径引用
 * resolveInstanceKernelDir／resolveInstancePinRoot。二者语义在此降级为内核目录别名，
 * 实现零 pin——命名残留（函数名带 Pin）留待扩展面可改时清理，见 G7 交付报告未处理项。
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** 内核目录 env 链（顺序即优先级；前两项为既有消费轴，第三项为 #22 单源根）。 */
export const KERNEL_DIR_ENV = "ATF_DSH_KERNEL_DIR";
export const CLI_PATH_ENV = "ATF_CLI_PATH";
export const KERNEL_SOURCE_ENV = "ATF_KERNEL_SOURCE";

/** 兄弟目录缺省（双仓同父布局：harness 仓与内核仓位于同一父目录下）。 */
export const KERNEL_SIBLING_DIRNAME = "AgenticTrainingFlow";

/** 内核目录解析：env 链优先，缺省兄弟目录（须实存），都不可得＝空串（调用方 fail-closed）。 */
export const resolveKernelDir = (env: Readonly<Record<string, string | undefined>>, repoRoot: string): string => {
  for (const key of [KERNEL_DIR_ENV, CLI_PATH_ENV, KERNEL_SOURCE_ENV]) {
    const value = env[key]?.trim() ?? "";
    if (value !== "") return resolve(value);
  }
  const sibling = resolve(join(repoRoot, "..", KERNEL_SIBLING_DIRNAME));
  return existsSync(sibling) ? sibling : "";
};

/** kernelDir 消费链单源（atf-tools Config／atf-ui 徽标面／agent 装配共用，防各处回退分叉）。 */
export const resolveInstanceKernelDir = (env: Readonly<Record<string, string | undefined>>, repoRoot: string): string =>
  resolveKernelDir(env, repoRoot);

/** 已退役的 pin 根解析（packages/extensions 既有 import 路径的兼容壳）。
 *  @deprecated pin 树已退役（D9）——本函数不再读任何 pin env，返回值即内核目录，
 *  source 恒 "env"（无「回退共享态」一说）。新调用方一律用 resolveKernelDir。 */
export const resolveInstancePinRoot = (
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
): { root: string; source: "env" | "fallback"; note: string | null } => ({
  root: resolveKernelDir(env, repoRoot),
  source: "env",
  note: null,
});
