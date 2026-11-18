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

  it("权限三档传导下传（D317 档位闸——内核按档放行修正自决）", async () => {
    const ran = await runPipeline("bash", ["-c", 'printf %s "$ATF_PERMISSION_TIER"'], 10_000,
      { ATF_PERMISSION_TIER: "unattended" });
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe("unattended");
  });
});

describe("D317——exec_source 拦截码人话（改法按执行主体分档）", () => {
  it("闭集在案+人话指向升级（不留自查/绕行空间）", async () => {
    const { humanizeKernelError, KERNEL_ERROR_FACE_CODES } = await import("../../src/core/workspace/kernelErrorFace.js");
    expect(KERNEL_ERROR_FACE_CODES.has("exec_source_unmarked")).toBe(true);
    expect(KERNEL_ERROR_FACE_CODES.has("exec_source_invalid")).toBe(true);
    const unmarked = humanizeKernelError("exec_source_unmarked");
    expect(unmarked).toContain("请升级用户处理");
    expect(unmarked).toContain("不要自查内核源码");
    const invalid = humanizeKernelError("exec_source_invalid");
    expect(invalid).toContain("请升级用户处理");
  });
});

describe("D317 补——--source-root 段×参数矩阵跨仓连接断言", () => {
  it("harness 组装段闭集与内核消费面对齐（链首三段+register；源码文本锚）", async () => {
    // D318 M2/M4：生成物承载（内核 stage_registry 唯一源 codegen 派生）——手写闭集
    // 与跨仓文本锚双退役（文本锚=脆弱且不拦新断裂，由生成物对账替代）。
    const { SOURCE_ROOT_ARGV_STAGES } = await import("../../packages/extensions/atf-tools/src/pipelineFace.js");
    const { STAGE_MATRIX } = await import("../../src/core/generated/stageMatrix.js");
    // 期望闭集字面量=单源对账锚（内核矩阵变更不重新生成→prebuild 红——M3 演练留证）
    for (const stage of ["register", "contract", "ingest", "inspect"]) {
      expect(SOURCE_ROOT_ARGV_STAGES.has(stage)).toBe(true);
    }
    // 闭集外段不组装（label_qc 等经内核登记件 refs 再水合，组装反而越权）
    expect(SOURCE_ROOT_ARGV_STAGES.has("label_qc")).toBe(false);
    expect(SOURCE_ROOT_ARGV_STAGES.has("snapshot")).toBe(false);
    // 生成物与两态闭集自洽（explicit ∩ recoverable=∅，并集=消费段全集）
    expect(STAGE_MATRIX.source_root_explicit.length).toBe(4);
    expect(STAGE_MATRIX.source_root_recoverable.length).toBe(5);
    for (const stage of STAGE_MATRIX.source_root_explicit) {
      expect(STAGE_MATRIX.source_root_recoverable).not.toContain(stage);
    }
  });
});

describe("D317b 补——contract_candidate 工具通道断言", () => {
  it("contract 段候选信封路径通道在参数面在场（跨仓文本锚：内核指路可执行）", async () => {
    const { readFileSync } = await import("node:fs");
    const face = readFileSync(new URL("../../packages/extensions/atf-tools/src/pipelineFace.ts", import.meta.url), "utf-8");
    // 工具参数面声明+argv 组装两处在场
    expect(face).toContain("contract_candidate: {");
    expect(face).toContain('argv.push("--contract-candidate"');
    // D318 M4：内核指路可执行性由 M1 单源承载（段参数面矩阵化后，信封通道=contract
    // 段参数声明的一部分，契约级追溯归 stage_registry 段定义；此处保留工具面两处在场）
  });
});

describe("D318——user_decision 审批卡双卡冗余修复", () => {
  it("裁决落账类直通到 B 层确认卡（宿主泛化面板不再拦）；governance 照旧", async () => {
    const { exemptOutcomeOf } = await import("../../packages/extensions/atf-tools/src/approvalExempt.js");
    // user_decision 类：直通（basis=bridge-confirm——放行到 B 层逐项确认卡）
    expect(exemptOutcomeOf({ toolName: "atf_label_qc_resolve" }))
      .toEqual({ outcome: "allowed-once", basis: "bridge-confirm" });
    // governance 类（launch）：不直通——宿主面板照旧（治理点双保险不动）
    expect(exemptOutcomeOf({ toolName: "atf_launch_execute" })).toBeNull();
    // 其余 atf_* 契约工具：照旧 null（next()——chainTools 清单命中才直通）
    expect(exemptOutcomeOf({ toolName: "atf_workspace_status" })).toBeNull();
  });
  it("bridgeFace 卡面终点：user_decision 不落泛化审批卡（源码结构锚）", async () => {
    const { readFileSync } = await import("node:fs");
    const face = readFileSync(new URL("../../packages/extensions/atf-tools/src/bridgeFace.ts", import.meta.url), "utf-8");
    expect(face).toContain("user_decision 的卡面");
    expect(face).toContain('} else if (definition.name === "atf_launch_execute") {');
  });
});
