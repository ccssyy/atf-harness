/**
 * D246/D247 boot 健康门：atf 扩展装配活性断言（纯逻辑，可测核心）。
 *
 * 背景（台账 D246/D247）：atf-tools 扩展装配 fatal 时只杀扩展、server 照起、
 * WebUI 零告警——agent 无工具面裸奔手搓假产物（1109 实锚整轮假链路）；
 * 且 tmux 直启 `dsh web` 不过 restart 外壳机检，静默降级无守卫。
 *
 * 语义：loader 全树 settle 后，检查治理面扩展（atf-tools/atf-continuation）的
 * loader fiber 活性——`fiber === undefined` 即未装配成功（vendor inactiveEntries
 * 同款判据）。任一治理面扩展死 → 调用方应 fail-fast（process.exit），宁可
 * server 起不来也不静默裸奔。
 */

/** 治理面扩展 id 清单（缺一即裸奔——工具面/续写面）。 */
export const ATF_REQUIRED_EXTENSION_IDS = ["atf-tools", "atf-continuation"] as const;

/** cordis loader entry 的最小观测面（仅用 options.id 与 fiber 活性）。 */
export interface LoaderEntryLike {
  options?: { id?: string };
  fiber?: { state?: unknown } | undefined;
}

/** cordis context 的最小观测面。 */
export interface LoaderCtxLike {
  loader?: {
    entries(): Iterable<LoaderEntryLike>;
    await?(): Promise<void>;
  };
}

/**
 * 找出治理面扩展中未装配成功的 id。
 *
 * :param ctx: cordis context（loader 面可选——缺席返回空，调用方兜底）。
 * :return: 死亡扩展 id 列表（空=全部存活）。
 */
export function findDeadAtfExtensions(ctx: LoaderCtxLike | undefined): string[] {
  const entries = ctx?.loader?.entries?.() ?? [];
  const dead: string[] = [];
  for (const entry of entries) {
    const id = entry.options?.id;
    if (id === undefined) continue;
    if ((ATF_REQUIRED_EXTENSION_IDS as readonly string[]).includes(id) && entry.fiber === undefined) {
      dead.push(id);
    }
  }
  return dead;
}
