/**
 * D3 测试锚——training_prep 的启动件可发现性 + 多单据槽位自动联合装配。
 *
 * 现场依据（2026-10-28 dev）：八段链跑完 training_prep 后 launch/、training/、
 * config/iteration-config 三个目录都是空的——内核 manual 档只产数据面，启动件归 assemble；
 * 而 assemble 缺省不传、回执不提，agent 只能 ls 才发现，随后 atf_joint_train 又无参数无法补。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleDecisionOf, launchArtifactsOf, slotDocCountOf } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "assemble-decision-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("D3 assembleDecisionOf（联合装配判定）", () => {
  it("显式 true 恒装配（用户说了算，与槽位数无关）", () => {
    expect(assembleDecisionOf(true, 0)).toEqual({ assemble: true, source: "explicit_on" });
    expect(assembleDecisionOf(true, 5)).toEqual({ assemble: true, source: "explicit_on" });
  });

  it("未给且多单据槽位 → 自动联合装配（多类不装配等于产不出启动件）", () => {
    expect(assembleDecisionOf(undefined, 2, true)).toEqual({ assemble: true, source: "multi_doc_slots" });
    expect(assembleDecisionOf(undefined, 9, true)).toEqual({ assemble: true, source: "multi_doc_slots" });
  });

  it("给了 doc_type 且单类/零槽位 → 保持旧行为（不装配，但回执会明示启动件缺席）", () => {
    expect(assembleDecisionOf(undefined, 1, true)).toEqual({ assemble: false, source: "single_doc" });
    expect(assembleDecisionOf(undefined, 0, true)).toEqual({ assemble: false, source: "single_doc" });
  });

  it("没给 doc_type → 自动装配（没有单类入口，不装配就产不出启动件）", () => {
    expect(assembleDecisionOf(undefined, 1)).toEqual({ assemble: true, source: "no_doc_type" });
    expect(assembleDecisionOf(undefined, 0)).toEqual({ assemble: true, source: "no_doc_type" });
  });

  it("显式 false 压过自动推断（用户说不要，工具不得替他改主意）", () => {
    expect(assembleDecisionOf(false, 3)).toEqual({ assemble: false, source: "explicit_off" });
  });
});

describe("D3 slotDocCountOf（槽位探测两布局都认）", () => {
  it("data/prep/variants/<doc> 与 data/variants/<doc> 都计入，取较大者", () => {
    const runDir = tempRoot();
    mkdirSync(join(runDir, "data", "prep", "variants", "awb"), { recursive: true });
    writeFileSync(join(runDir, "data", "prep", "variants", "awb", "train.jsonl"), "{}\n", "utf8");
    mkdirSync(join(runDir, "data", "variants", "swb"), { recursive: true });
    writeFileSync(join(runDir, "data", "variants", "swb", "train.jsonl"), "{}\n", "utf8");
    mkdirSync(join(runDir, "data", "variants", "pl"), { recursive: true });
    writeFileSync(join(runDir, "data", "variants", "pl", "train.jsonl"), "{}\n", "utf8");
    expect(slotDocCountOf(runDir)).toBe(2);
  });

  it("目录缺席/不可读按 0（保守：不误判成多类）", () => {
    expect(slotDocCountOf(join(tempRoot(), "nope"))).toBe(0);
  });

  it("文件不算槽位（只认目录）", () => {
    const runDir = tempRoot();
    const variants = join(runDir, "data", "variants");
    mkdirSync(variants, { recursive: true });
    writeFileSync(join(variants, "readme.txt"), "x", "utf8");
    expect(slotDocCountOf(runDir)).toBe(0);
  });

  it("只认含 train.jsonl 的单据目录——images/ 不算（现场实测：1 个单据曾被算成 2 个）", () => {
    const runDir = tempRoot();
    const variants = join(runDir, "data", "variants");
    mkdirSync(join(variants, "awb"), { recursive: true });
    writeFileSync(join(variants, "awb", "train.jsonl"), "{}\n", "utf8");
    mkdirSync(join(variants, "images"), { recursive: true });
    writeFileSync(join(variants, "images", "a.png"), "x", "utf8");
    expect(slotDocCountOf(runDir)).toBe(1);
  });
});

describe("D3 launchArtifactsOf（启动件在场判定）", () => {
  it("v3 树两件齐备 → present 且给相对路径（回执只进相对，不外泄绝对路径）", () => {
    const runDir = tempRoot();
    // 布局身份单源＝run.json 的 layout_version（不按目录名猜）；v3 树的迭代配置在 config/ 下
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ layout_version: "RunLayout/v3" }), "utf8");
    mkdirSync(join(runDir, "launch"), { recursive: true });
    mkdirSync(join(runDir, "config", "iteration-config"), { recursive: true });
    writeFileSync(join(runDir, "launch", "train.sh"), "#!/usr/bin/env bash\n", "utf8");
    writeFileSync(join(runDir, "config", "iteration-config", "iteration-config.json"), "{}", "utf8");
    const artifacts = launchArtifactsOf(runDir);
    expect(artifacts.present).toBe(true);
    expect(artifacts.train_sh).toBe("launch/train.sh");
    expect(artifacts.iteration_config).toBe("config/iteration-config/iteration-config.json");
    expect(artifacts.reason).toBeNull();
  });

  it("v2 存量树同口径识别（迭代配置在 prep/ 下）——布局知识走单源，不在这里复制", () => {
    const runDir = tempRoot();
    mkdirSync(join(runDir, "launch"), { recursive: true });
    mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
    writeFileSync(join(runDir, "launch", "train.sh"), "#!/usr/bin/env bash\n", "utf8");
    writeFileSync(join(runDir, "prep", "iteration-config", "iteration-config.json"), "{}", "utf8");
    const artifacts = launchArtifactsOf(runDir);
    expect(artifacts.present).toBe(true);
    expect(artifacts.iteration_config).toBe("prep/iteration-config/iteration-config.json");
  });

  it("两件都缺 → present=false 且 reason=assemble_not_requested（现场即此形态）", () => {
    const artifacts = launchArtifactsOf(tempRoot());
    expect(artifacts.present).toBe(false);
    expect(artifacts.train_sh).toBeNull();
    expect(artifacts.iteration_config).toBeNull();
    expect(artifacts.reason).toBe("assemble_not_requested");
  });

  it("只产一半 → assemble_incomplete（说清是装配没跑完，不是没跑）", () => {
    const runDir = tempRoot();
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ layout_version: "RunLayout/v3" }), "utf8");
    mkdirSync(join(runDir, "launch"), { recursive: true });
    writeFileSync(join(runDir, "launch", "train.sh"), "#!/usr/bin/env bash\n", "utf8");
    const artifacts = launchArtifactsOf(runDir);
    expect(artifacts.present).toBe(false);
    expect(artifacts.train_sh).toBe("launch/train.sh");
    expect(artifacts.reason).toBe("assemble_incomplete");
  });
});
