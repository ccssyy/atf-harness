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

  it("参数面：choices 同源断裂（内核 --auto-style-cluster choices 改动）→ 必红", () => {
    // G2 退役 --grouping-preset 的词表对账（取值集合归内核），本类阴性对照改用仍在册的
    // auto-style-cluster 词汇闭集——护栏能力不因退役而丢失。
    const { facts } = base();
    const snapshot = deepClone(snapshotOf());
    const entry = snapshot.find((script) => script.script === "tools/walkthrough_pipeline.py");
    const arg = entry?.args.find((item) => item.option === "--auto-style-cluster");
    expect(arg).toBeDefined();
    const before = [...((arg?.choices ?? []) as string[])];
    arg!.choices = [...before.filter((value) => value !== before[0]), "injected-drift"];
    const violations = guardParamsFace(snapshot, facts);
    expect(violations.some((v) => v.kind === "参数面" && v.detail.includes("--auto-style-cluster"))).toBe(true);
  });

  it("参数面：豁免退役后全对账——b9-like 快照缺旗标必红（行为面/映射面两项，禁以 waiver 过关）；b10 现状零违例", () => {
    const { snapshot, facts } = base();
    // 豁免集外（现状恒空集）：未声明旗标参数键照红（豁免退役不是放宽断言）
    const outsideWaiver: HarnessSurfaceFactsWithMock = {
      ...facts,
      toolParamKeys: [...facts.toolParamKeys, "unwaived_future_key"],
      flagByParam: { ...facts.flagByParam, unwaived_future_key: "--not-a-kernel-flag" },
    };
    const outsideViolations = guardParamsFace(snapshot, outsideWaiver);
    expect(outsideViolations.some((v) => v.kind === "参数面" && v.detail.includes("unwaived_future_key"))).toBe(true);
    // b9-like 快照（深拷贝后从 walkthrough 的 args 删 --training-overrides——E5·H1
    // D139 豁免退役后的阴性锚：快照缺旗标时行为面与映射面两项都红，无豁免可过关
    // （退役动作有测试锚；重生成快照缺该旗标＝快照漂移，护栏必红）
    const b9like = deepClone(snapshotOf());
    const walkthrough = b9like.find((s) => s.script === "tools/walkthrough_pipeline.py");
    if (walkthrough !== undefined) walkthrough.args = walkthrough.args.filter((arg) => arg.option !== "--training-overrides");
    const withToken: HarnessSurfaceFactsWithMock = { ...facts, argvTokens: [...facts.argvTokens, "--training-overrides"] };
    const b9Violations = guardParamsFace(b9like, withToken);
    expect(b9Violations.some((v) => v.kind === "参数面" && v.detail.includes("工具参数键 training_overrides"))).toBe(true);
    expect(b9Violations.some((v) => v.kind === "参数面" && v.detail.includes("行为面下传旗标 --training-overrides"))).toBe(true);
    // b10 现状（快照含声明面＋豁免空集）：旗标下传零违例——全对账常态
    expect(guardParamsFace(snapshot, withToken).some((v) => v.detail.includes("training_overrides") || v.detail.includes("--training-overrides"))).toBe(false);
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
