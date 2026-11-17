// C2 parity 独立校验件（D313 挂账清偿）：kernel-stage-arg-surface.json（段级派生快照）
// ← 内核 argparse_surface.json walkthrough 条目重摘对账——独立于 stageParamsWiring
// （生成物↔手写面）与 kernelArgAlignment（锚点↔内核 CLI）之外的第三道：直接校验
// 「快照=源 surface 的忠实派生」（option 清单+源 sha256 双对账）。手改快照/源变更
// 未重摘 → 本锚红（env-gated：ATF_KERNEL_SOURCE 未设如实 skip）。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const kernelRoot = process.env.ATF_KERNEL_SOURCE ?? "";

interface SurfaceEntry {
  script: string;
  args: { option: string }[];
}

const loadSnapshot = (): { note: string; source_surface_sha256: string; options: string[] } => {
  const doc = JSON.parse(
    readFileSync(resolve(process.cwd(), "tests/fixtures/kernel-stage-arg-surface.json"), "utf-8"),
  ) as { note: string; source_surface_sha256: string; options: string[] };
  expect(doc.options.length, "快照 options 非空").toBeGreaterThan(0);
  return doc;
};

const deriveFromSource = (): { options: string[]; sourceSha: string } => {
  const surface = JSON.parse(
    readFileSync(resolve(kernelRoot, "tools/argparse_surface.json"), "utf-8"),
  ) as SurfaceEntry[];
  const entry = surface.find((e) => e.script.endsWith("walkthrough_pipeline.py"));
  expect(entry, "内核 surface 缺 walkthrough_pipeline 条目").toBeTruthy();
  const options = entry!.args.map((a) => a.option);
  const sourceSha = createHash("sha256")
    .update(readFileSync(resolve(kernelRoot, "tools/argparse_surface.json")))
    .digest("hex");
  return { options, sourceSha };
};

describe("C2 段级快照 parity（独立校验件）", () => {
  it.runIf(kernelRoot)("快照 options = 源 surface walkthrough 条目 option 清单（diff=0）", () => {
    const snapshot = loadSnapshot();
    const { options } = deriveFromSource();
    expect(snapshot.options).toEqual(options);
  });

  it.runIf(kernelRoot)("快照 source_surface_sha256 = 源 surface 文件实算 sha256", () => {
    const snapshot = loadSnapshot();
    const { sourceSha } = deriveFromSource();
    expect(snapshot.source_surface_sha256).toBe(sourceSha);
  });

  it("快照在场且声明摘自源（守卫标识）", () => {
    const snapshot = loadSnapshot();
    expect(snapshot.note).toContain("摘自内核仓");
  });
});
