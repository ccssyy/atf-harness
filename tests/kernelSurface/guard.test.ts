/**
 * D94-harness 六类护栏——真快照对账（指令《ATF_指令_窗口B6_20261024》sha b24fa77d9c68
 * L-H3；护栏纯函数见 ./guard.ts，事实采集见 ./guardFixture.ts，阴性对照见
 * ./guard.negative.test.ts）。
 *
 * 快照 ↔ 内核真源对账：ATF_KERNEL_DIR 在场时断言快照与 <dir>/tools/argparse_surface.json
 * deep-equal（re-pin 后忘更新快照即红）；缺席时快照自承载（结构性 env 前提，同
 * realPeer 的 ATF_CLI_PATH 形态——六类护栏全部照跑快照，对账缺席不构成失败兜底）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAllGuards, type SurfaceSnapshot } from "./guard.js";
import { collectArgvTokens, factsOf, snapshotOf } from "./guardFixture.js";

const snapshot = snapshotOf();

describe("D94-harness 六类护栏（真快照对账）", () => {
  it("行为面采集：四段大满贯 mock 实跑回显非空（护栏事实面自检）", async () => {
    const argvTokens = await collectArgvTokens();
    expect(argvTokens.length).toBeGreaterThan(20);
    expect(argvTokens).toContain("--negative-ratio-target");
    expect(argvTokens).toContain("--grouping-preset");
    expect(argvTokens).toContain("--base-model");
  });

  it("六类护栏全绿（参数面／段清单／九要素键／闭集／文档实现／形态假设）", async () => {
    const argvTokens = await collectArgvTokens();
    const violations = runAllGuards(snapshot, factsOf(argvTokens));
    expect(
      violations,
      `护栏违例（能修当场修，修不了登记豁免——禁 skip/禁放宽）：\n${violations.map((v) => `[${v.kind}] ${v.detail}`).join("\n")}`,
    ).toEqual([]);
  });

  it("快照 ↔ 内核真源对账（ATF_KERNEL_DIR 在场时；缺席＝快照自承载，六类护栏照跑）", () => {
    const kernelDir = process.env["ATF_KERNEL_DIR"];
    if (kernelDir === undefined || kernelDir === "") {
      expect(snapshot.length).toBeGreaterThan(0);
      return;
    }
    const upstream = JSON.parse(
      readFileSync(join(kernelDir, "tools", "argparse_surface.json"), "utf8"),
    ) as SurfaceSnapshot;
    expect(snapshot).toEqual(upstream);
  });
});
