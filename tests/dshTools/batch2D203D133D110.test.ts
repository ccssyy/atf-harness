/** 批2 锚: D203(放行账本对账)/D133(workspace 入口拒绝)/D110(负样本域闭集单源)。
 *
 * 源码面 grep 锚(同批1惯例):
 * - D203: --record-eval-release 落账后、启动编排前回读 service_manifest 对账——
 *   record 写的 subject SHA 与编排闸将核对的 config_sha256 不一致即
 *   eval_release_ledger_mismatch + started:false(不盲启编排;两轮 waiting_for_start
 *   复现的根因=放行前 service_config 被重生成)。
 * - D133: 显式 workspace_path 合法性拦截——描述面早有标记集声明,拦截面缺位致
 *   错路径静默建旁支骨架树(my-zito 双旁支实锚);标记覆盖三代布局。
 * - D110: 卡面域/示例文本与内核闭集带 (0.02,0.05) 单源——示例不得再教 0.03,0.06。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TRAINING = join(process.cwd(), "packages/extensions/atf-tools/src/trainingFace.ts");
const PIPELINE = join(process.cwd(), "packages/extensions/atf-tools/src/pipelineFace.ts");
const SMART = join(process.cwd(), "src/core/workspace/smartDefaults.ts");
const KB = join(process.cwd(), "../AgenticTrainingFlow/skills/atf-admit-training-data/scripts/kb_contract.py");

describe("批2-D203——放行后账本对账(不盲启编排)", () => {
  it("对账拦截码在场", () => {
    const src = readFileSync(TRAINING, "utf8");
    expect(src).toContain("eval_release_ledger_mismatch");
  });
  it("对账失败阻断编排启动(started:false + 双 SHA 呈现)", () => {
    const src = readFileSync(TRAINING, "utf8");
    // 同一 return 语句内 started:false 与错误码共存(单一命中=拦截态,非描述文本)
    expect(src).toContain('started: false, error: "eval_release_ledger_mismatch"');
    expect(src).toContain("manifest_sha");
    expect(src).toContain("recorded_sha");
  });
  it("对账对象=编排闸同一真相(service_manifest.config_sha256 vs record subject)", () => {
    const src = readFileSync(TRAINING, "utf8");
    const idx = src.indexOf("eval_release_ledger_mismatch");
    const window = src.slice(Math.max(0, idx - 900), idx);
    expect(window).toContain("service_manifest.json");
    expect(window).toContain("config_sha256");
    expect(window).toContain("subject_sha256");
  });
});

describe("批2-D133——workspace 入口拒绝(不在错路径静默建骨架)", () => {
  it("拦截码在场", () => {
    const src = readFileSync(PIPELINE, "utf8");
    expect(src).toContain("workspace_path_invalid");
  });
  it("标记集覆盖三代布局(身份件/datasets+splits/runs/experiments)", () => {
    const src = readFileSync(PIPELINE, "utf8");
    const idx = src.indexOf("workspace_path_invalid");
    expect(idx).toBeGreaterThan(-1);
    const window = src.slice(Math.max(0, idx - 1600), idx + 400);
    expect(window).toContain("workspace.json");
    expect(window).toContain("datasets");
    expect(window).toContain("experiments");
  });
  it("报文带修复指令(产品入口/核对拼写)", () => {
    const src = readFileSync(PIPELINE, "utf8");
    // 锚在拦截 return 的错误码上(描述文本同名提及不作数)
    const idx = src.indexOf('error: "workspace_path_invalid"');
    expect(idx).toBeGreaterThan(-1);
    const window = src.slice(idx, idx + 900);
    expect(window).toContain("how_to_fix");
  });
});

describe("批2-D110——负样本域闭集单源(卡域=内核带,示例不带越界值)", () => {
  it("卡面示例不再教 0.03,0.06(越上限示例退役)", () => {
    const src = readFileSync(PIPELINE, "utf8");
    expect(src).not.toContain("0.03,0.06");
  });
  it("harness 卡域与内核闭集带逐值一致", () => {
    const smart = readFileSync(SMART, "utf8");
    const m = smart.match(/negative_ratio:\s*\{\s*min:\s*([\d.]+),\s*max:\s*([\d.]+)\s*\}/);
    expect(m).not.toBeNull();
    const kb = readFileSync(KB, "utf8");
    const k = kb.match(/NEGATIVE_RATIO_CONSTRUCTION_BAND\s*=\s*\(([\d.]+),\s*([\d.]+)\)/);
    expect(k).not.toBeNull();
    expect(m![1]).toBe(k![1]);
    expect(m![2]).toBe(k![2]);
  });
});
