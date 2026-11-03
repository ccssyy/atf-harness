/**
 * ci-bl-1103 修复锚：prompt 确认卡 run 级去重。
 *
 * 现场症状（dev ci-bl-test-1103 第二轮真机验证）：CI+BL 联合训练逐类 register，
 * 每类 register 成功都进 prompt 确认块且无 prior 检查——用户被问两次「训练 prompt
 * 用哪套」。owner 裁定 prompt 全局一套（含评估），决策是 run 级一次；字段清单卡
 * 已有 prior 去重（readFieldChoice），prompt 卡补同款。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readInputsPromptResolvedVia } from "../../packages/extensions/atf-tools/src/promptChoiceIo.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const makeRun = (prompt: unknown): string => {
  const runDir = mkdtempSync(join(tmpdir(), "prompt-dedup-"));
  dirs.push(runDir);
  mkdirSync(join(runDir, "config"), { recursive: true });
  if (prompt !== undefined) {
    writeFileSync(join(runDir, "config", "inputs.json"), JSON.stringify({ prompt }), "utf8");
  }
  return runDir;
};

describe("prompt 决策 run 级去重", () => {
  it("已落账 resolved_via 的 run 读出非空（第二类 register 进块时不弹卡）", () => {
    expect(readInputsPromptResolvedVia(makeRun({ resolved_via: "builtin_default" }))).toBe("builtin_default");
    expect(readInputsPromptResolvedVia(makeRun({ resolved_via: "user_stated" }))).toBe("user_stated");
  });

  it("未决/缺文件/损坏形态返回 null（首类 register 照常弹卡，不误吞用户决策）", () => {
    expect(readInputsPromptResolvedVia(makeRun(undefined))).toBeNull();
    expect(readInputsPromptResolvedVia(makeRun({}))).toBeNull();
    expect(readInputsPromptResolvedVia(makeRun({ resolved_via: "" }))).toBeNull();
  });
});
