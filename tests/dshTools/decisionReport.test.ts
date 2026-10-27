/**
 * 询问闸（DecisionGate/v1）harness 半的接线测试：
 * ① 会话权限档经 env 下传给内核子进程（逐调用追加、不污染 process.env）；
 * ② 段回执的判定报告键取自内核段摘要（措辞内核单源，harness 零复制、不造假空报告）。
 *
 * 目的：证明「完全访问档自动推进 / 受限档停下来问」这条判定链在 harness 侧不漏传导，
 * 且旧内核（无 decisions 块）走零键降级、不报错。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { decisionReportKeys, runPipeline } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

const echoScript = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "atf-env-"));
  const path = join(dir, "echo-env.mjs");
  writeFileSync(path, "console.log(JSON.stringify({mode: process.env.ATF_ACCESS_MODE ?? null}));\n", "utf8");
  return path;
};

describe("询问闸：权限档经 env 下传", () => {
  it("显式追加 ATF_ACCESS_MODE=full：子进程读得到，父进程 env 不被污染", async () => {
    const script = echoScript();
    const before = process.env.ATF_ACCESS_MODE;
    const result = await runPipeline(`${process.execPath} ${script}`, [], 10_000, { ATF_ACCESS_MODE: "full" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ mode: "full" });
    expect(process.env.ATF_ACCESS_MODE).toBe(before);
  });

  it("不传额外 env：子进程看到父进程原值（零隐式放大）", async () => {
    const script = echoScript();
    const before = process.env.ATF_ACCESS_MODE;
    delete process.env.ATF_ACCESS_MODE;
    try {
      const result = await runPipeline(`${process.execPath} ${script}`, [], 10_000);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ mode: null });
    } finally {
      if (before !== undefined) process.env.ATF_ACCESS_MODE = before;
    }
  });
});

describe("询问闸：段回执判定报告", () => {
  it("内核摘要带 decisions 块：报告文本与计数原样透出", () => {
    const keys = decisionReportKeys({
      decisions: {
        access_mode: "full",
        auto: 1,
        ask: 0,
        report: "本轮自动按产品默认推进 1 项、询问你 0 项：\n- 自动：版式聚类要不要按版式特征自动补齐？ → on（依据：同版式同侧防泄漏）",
      },
    });
    expect(keys).toEqual({
      decision_report: expect.stringContaining("自动按产品默认推进 1 项"),
      decisions_auto: 1,
      decisions_ask: 0,
      decisions_access_mode: "full",
    });
  });

  it("旧内核无 decisions 块（或块内无 report）：零键降级，不造假空报告", () => {
    expect(decisionReportKeys(null)).toEqual({});
    expect(decisionReportKeys({})).toEqual({});
    expect(decisionReportKeys({ decisions: {} })).toEqual({});
    expect(decisionReportKeys({ decisions: { auto: 0, ask: 2 } })).toEqual({});
  });
});
