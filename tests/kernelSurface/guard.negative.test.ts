/**
 * D94-harness 护栏阴性对照（授权件 §一 L-H3：「阴性对照演练——故意注入偏差必红」）：
 * 对六类护栏逐类注入变异（篡改快照或事实面），断言对应类违例必现——护栏失明（变异
 * 不红）即护栏本身失效。全部在内存变异，零真文件改动。
 */
import { describe, expect, it } from "vitest";
import {
  guardClosedSets,
  guardDocImplementation,
  guardNineFactorKeys,
  guardParamsFace,
  guardShapeAssumptions,
  guardStageList,
  type HarnessSurfaceFactsWithMock,
  type SurfaceSnapshot,
} from "./guard.js";
import { factsOf, snapshotOf } from "./guardFixture.js";

const base = (): { snapshot: SurfaceSnapshot; facts: HarnessSurfaceFactsWithMock } => ({
  snapshot: snapshotOf(),
  facts: factsOf([]) as HarnessSurfaceFactsWithMock,
});

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("D94 阴性对照——六类护栏故意注入偏差必红", () => {
  it("参数面：行为面注入内核未声明旗标 → 必红且 kind=参数面", () => {
    const { snapshot, facts } = base();
    const mutated: HarnessSurfaceFactsWithMock = {
      ...facts,
      argvTokens: [...facts.argvTokens, "--not-a-kernel-flag"],
    };
    const violations = guardParamsFace(snapshot, mutated);
    expect(violations.some((v) => v.kind === "参数面" && v.detail.includes("--not-a-kernel-flag"))).toBe(true);
  });

  it("参数面：choices 同源断裂（内核 --grouping-preset choices 改动）→ 必红", () => {
    const { facts } = base();
    const snapshot = deepClone(snapshotOf());
    const entry = snapshot.find((script) => script.script === "tools/walkthrough_pipeline.py");
    const arg = entry?.args.find((item) => item.option === "--grouping-preset");
    if (arg !== undefined) arg.choices = ["A", "B", "C"];
    const violations = guardParamsFace(snapshot, facts);
    expect(violations.some((v) => v.kind === "参数面" && v.detail.includes("--grouping-preset"))).toBe(true);
  });

  it("参数面：前瞻豁免边界——豁免集外未声明旗标仍红（行为面/映射面）；豁免退役（空集）后豁免键红（行为面＋映射面）", () => {
    const { snapshot, facts } = base();
    // 豁免集外：未声明旗标参数键照红（豁免不是放宽断言——仅登记键免单项）
    const outsideWaiver: HarnessSurfaceFactsWithMock = {
      ...facts,
      toolParamKeys: [...facts.toolParamKeys, "unwaived_future_key"],
      flagByParam: { ...facts.flagByParam, unwaived_future_key: "--not-a-kernel-flag" },
    };
    const outsideViolations = guardParamsFace(snapshot, outsideWaiver);
    expect(outsideViolations.some((v) => v.kind === "参数面" && v.detail.includes("unwaived_future_key"))).toBe(true);
    // 豁免退役（re-pin b10 后空集）：豁免键恢复全对账，b9 快照下必红——行为面旗标
    // 与映射面旗标两项都红（退役动作有测试锚；行为面注入 token 模拟下传在场面）
    const retired: HarnessSurfaceFactsWithMock = { ...facts, paramFaceWaivers: new Set<string>(), argvTokens: [...facts.argvTokens, "--training-overrides"] };
    const retiredViolations = guardParamsFace(snapshot, retired);
    expect(retiredViolations.some((v) => v.kind === "参数面" && v.detail.includes("工具参数键 training_overrides"))).toBe(true);
    expect(retiredViolations.some((v) => v.kind === "参数面" && v.detail.includes("行为面下传旗标 --training-overrides"))).toBe(true);
    // 豁免在位（现状）：豁免键免「旗标落声明面」单项＋行为面旗标跳过——零参数面违例
    const withWaivedToken: HarnessSurfaceFactsWithMock = { ...facts, argvTokens: [...facts.argvTokens, "--training-overrides"] };
    expect(guardParamsFace(snapshot, withWaivedToken).some((v) => v.detail.includes("training_overrides") || v.detail.includes("--training-overrides"))).toBe(false);
  });

  it("段清单：--stage choices 表达式漂移 → 必红；mock 段闭集漂移 → 必红", () => {
    const { facts } = base();
    const snapshot = deepClone(snapshotOf());
    const entry = snapshot.find((script) => script.script === "tools/walkthrough_pipeline.py");
    const stageArg = entry?.args.find((item) => item.option === "--stage");
    if (stageArg !== undefined) stageArg.choices = "<expr:list(STAGE_ORDER_V2)>";
    const violations = guardStageList(snapshot, facts);
    expect(violations.some((v) => v.kind === "段清单" && v.detail.includes("STAGE_ORDER_V2"))).toBe(true);

    const mockMutated: HarnessSurfaceFactsWithMock = {
      ...facts,
      mockKnownStages: [...facts.mockKnownStages.slice(0, -1)],
    };
    const mockViolations = guardStageList(snapshotOf(), mockMutated);
    expect(mockViolations.some((v) => v.kind === "段清单" && v.detail.includes("mock"))).toBe(true);
  });

  it("九要素键：消费点断路（内核删除 --negative-ratio-target）→ 必红；新可编辑键漏登记 → 必红", () => {
    const { facts } = base();
    const snapshot = deepClone(snapshotOf());
    for (const entry of snapshot) {
      entry.args = entry.args.filter((arg) => arg.option !== "--negative-ratio-target");
    }
    const violations = guardNineFactorKeys(snapshot, facts);
    expect(violations.some((v) => v.kind === "九要素键" && v.detail.includes("negative_ratio_target"))).toBe(true);

    const unregistered: HarnessSurfaceFactsWithMock = {
      ...facts,
      configConfirmKeys: [...facts.configConfirmKeys, "brand_new_key"],
    };
    const regViolations = guardNineFactorKeys(snapshotOf(), unregistered);
    expect(regViolations.some((v) => v.kind === "九要素键" && v.detail.includes("brand_new_key"))).toBe(true);
  });

  it("闭集：错误码闭集与文案 case 集脱钩 → 必红", () => {
    const { snapshot, facts } = base();
    const mutated: HarnessSurfaceFactsWithMock = {
      ...facts,
      kernelErrorFaceCodes: [...facts.kernelErrorFaceCodes, "future_new_code"],
    };
    const violations = guardClosedSets(snapshot, mutated);
    expect(violations.some((v) => v.kind === "闭集" && v.detail.includes("future_new_code"))).toBe(true);
  });

  it("文档实现：接口契约文档段删旗标记载 → 必红；pin 段形态破坏 → 必红", () => {
    const { snapshot, facts } = base();
    const docMutated: HarnessSurfaceFactsWithMock = {
      ...facts,
      docContractText: facts.docContractText.split("--negative-ratio-target").join("negative-ratio-flag-removed"),
    };
    const violations = guardDocImplementation(snapshot, docMutated);
    expect(violations.some((v) => v.kind === "文档实现" && v.detail.includes("--negative-ratio-target"))).toBe(true);

    const pinMutated: HarnessSurfaceFactsWithMock = {
      ...facts,
      bridgeContractText: facts.bridgeContractText.replace(/^ {2}commit_sha: [0-9a-f]{40}$/m, "  commit_sha: short"),
    };
    const pinViolations = guardDocImplementation(snapshotOf(), pinMutated);
    expect(pinViolations.some((v) => v.kind === "文档实现" && v.detail.includes("pin 段"))).toBe(true);
  });

  it("形态假设：内核脚本引用悬空 → 必红；store_true 携值 → 必红；摘要模板缺失 → 必红", () => {
    const { snapshot, facts } = base();
    const scriptMutated: HarnessSurfaceFactsWithMock = {
      ...facts,
      kernelScriptRefs: [...facts.kernelScriptRefs, "renamed_away_script.py"],
    };
    const violations = guardShapeAssumptions(snapshot, scriptMutated);
    expect(violations.some((v) => v.kind === "形态假设" && v.detail.includes("renamed_away_script.py"))).toBe(true);

    const storeTrueMutated: HarnessSurfaceFactsWithMock = {
      ...facts,
      argvTokens: ["--train-all", "true", "--actor", "x"],
    };
    const stViolations = guardShapeAssumptions(snapshotOf(), storeTrueMutated);
    expect(stViolations.some((v) => v.kind === "形态假设" && v.detail.includes("--train-all"))).toBe(true);

    const tplMutated: HarnessSurfaceFactsWithMock = {
      ...facts,
      summaryPathTemplateLiteral: "no template here",
    };
    const tplViolations = guardShapeAssumptions(snapshotOf(), tplMutated);
    expect(tplViolations.some((v) => v.kind === "形态假设" && v.detail.includes("模板"))).toBe(true);
  });
});
