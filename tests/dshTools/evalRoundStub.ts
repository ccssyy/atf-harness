import { join } from "node:path";

/** F2 测试用轮号 stub：不依赖真实内核进程。
 *
 *  语义与内核一致的最小形态——同 run 固定第一轮目录（`eval/1-<日期>`）。
 *  注入的是"轮目录来源"，不是轮号推导：harness 侧已无任何本地推导实现（F2）。
 */
export const stubEvalRound = async (
  runDir: string,
): Promise<{ ok: true; roundDir: string }> => ({
  ok: true,
  roundDir: join(runDir, "eval", "1-20261028"),
});
