/** 批0测试锚:e2e 轮 harness 侧热修正式化(D198/D199)——无机检不立规补锚。
 *
 * 三组锚:
 * 1. D199 兜底:canonicalRunDirOf 同名多根命中时优先「带数据槽位」的活 run
 *    (data/variants/<doc>/train.jsonl);空壳(仅 run.json)不抢先——真机曾发生
 *    default-workspace 空壳挡住工作区真 run 致 multiDoc 判 false。
 * 2. D198①:evaluate start 多类 run(槽位>1)不传 eval_assets_dir 不再报
 *    eval_assets_dir_missing(逐类输入由内核按槽位派生);单类仍必填。
 * 3. D198②:源码面 grep 锚——field-config 空串不传(旧形态 `?? ""` 会让内核
 *    argparse 收到空串、Path('')→'.' 崩)。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalRunDirOf } from "../../src/core/workspace/runLayout.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "b0-evalhard-"));

const writeRunJson = (runDir: string): void => {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: "run-x", schema_version: "RunRecord/v1" }));
};

const writeSlot = (runDir: string, doc: string): void => {
  const slot = join(runDir, "data", "variants", doc);
  mkdirSync(slot, { recursive: true });
  writeFileSync(join(slot, "train.jsonl"), "{}\n");
};

describe("批0 D199——canonicalRunDirOf 活 run 优先(同名多根)", () => {
  it("空壳在前、活 run 在后 → 返回活 run(带 train.jsonl 槽位)", () => {
    const root = tempRoot();
    try {
      const shellDir = join(root, "wsA", "experiments", "adhoc", "run-x");
      const liveDir = join(root, "wsB", "experiments", "exp", "run-x");
      writeRunJson(shellDir);
      writeRunJson(liveDir);
      writeSlot(liveDir, "bl");
      const hit = canonicalRunDirOf([join(root, "wsA"), join(root, "wsB")], "run-x");
      expect(hit).toBe(liveDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("只有空壳 → 回落返回壳(不 null,保持旧行为可用)", () => {
    const root = tempRoot();
    try {
      const shellDir = join(root, "wsA", "experiments", "adhoc", "run-x");
      writeRunJson(shellDir);
      expect(canonicalRunDirOf([join(root, "wsA")], "run-x")).toBe(shellDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("全缺 → null(不变)", () => {
    const root = tempRoot();
    try {
      expect(canonicalRunDirOf([root], "run-none")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("批0 D198①——源码面 grep 锚:eval_assets_dir 多类豁免在位", () => {
  it("豁免前缀在位且旧无条件必填形态退役", () => {
    const src = readFileSync(
      join(process.cwd(), "packages/extensions/atf-tools/src/trainingFace.ts"),
      "utf8",
    );
    // 新形态:单类才必填(多类逐类输入由内核按槽位派生,真机 e2e 轮死锁的修复)
    expect(src).toContain("!multiDoc && (typeof args.eval_assets_dir !== \"string\"");
    // 旧形态(无条件必填——带参说歧义、不带说缺参死锁)不得回归
    expect(src).not.toMatch(/if \(typeof args\.eval_assets_dir !== "string" \|\| args\.eval_assets_dir\.trim\(\) === ""\) \{\s*\n\s*return asToolValue\(\{ started: false, error: "eval_assets_dir_missing"/);
  });
});

describe("批0 D198②——源码面 grep 锚:field-config 空串不传给内核 prelaunch", () => {
  it("展开形态在场且旧 `?? \"\"` 形态退役", () => {
    const src = readFileSync(
      join(process.cwd(), "packages/extensions/atf-tools/src/trainingFace.ts"),
      "utf8",
    );
    // 新形态:仅 fieldConfigPath 真值时展开 --field-config
    expect(src).toContain('...(fieldConfigPath ? ["--field-config", fieldConfigPath] : [])');
    // 旧形态(空串直传,内核 Path('') → '.' 崩)不得回归
    expect(src).not.toContain('"--field-config", fieldConfigPath ?? ""');
  });
});
