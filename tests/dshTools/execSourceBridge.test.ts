/**
 * A8 执行来源标记传导锚（1117 真机发现 1 修复）：
 *   runPipeline 子进程 env 单源注入 ATF_EXEC_SOURCE=bridge（真 spawn 断言——非 mock）；
 *   extraEnv 显式值可覆盖（逃生语义归用户显式动作，不经本通道——覆盖能力仅留给
 *   未来受控扩展点，现无调用方使用）。
 * 背景：bootPreflight L1 补齐写 preflightEnv 局部束（不写 process.env），对段执行
 * 链不可达——此前段子进程无标记被内核闸 exec_source_unmarked 拦死（真机首跑实锚）。
 */
import { describe, expect, it } from "vitest";
import { runPipeline } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

describe("runPipeline 执行来源标记传导（A8 桥形态）", () => {
  it("子进程 env 恒含 ATF_EXEC_SOURCE=bridge（真 spawn 回读）", async () => {
    const ran = await runPipeline("bash", ["-c", 'printf %s "$ATF_EXEC_SOURCE"'], 10_000);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe("bridge");
  });

  it("extraEnv 显式值覆盖默认 bridge", async () => {
    const ran = await runPipeline("bash", ["-c", 'printf %s "$ATF_EXEC_SOURCE"'], 10_000,
      { ATF_EXEC_SOURCE: "direct-escape" });
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe("direct-escape");
  });

  it("权限档传导键照旧下传（ATF_ACCESS_MODE 同通道回归）", async () => {
    const ran = await runPipeline("bash", ["-c", 'printf %s "$ATF_ACCESS_MODE"'], 10_000,
      { ATF_ACCESS_MODE: "limited" });
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe("limited");
  });
});
