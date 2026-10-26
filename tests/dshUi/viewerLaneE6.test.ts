/**
 * E6 真机产物回归锚（lane 形态：`analysis/<lane>/viewer/`）。
 *
 * 现场有 uat 实件时（`/data/atf/uat/runs/awb_r1/analysis/chain/viewer/`，76 图）跑真盘断言；
 * 现场无该目录（CI/他机）自动跳过——纯函数形态由 atfUi.test.ts 的三形态用例覆盖。
 * 本用例价值：旧规则（只认一层 analysis*）在该实件上解析为空＝双 404 的根因，作为对照。
 */
import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { discoverViewerDirs, resolveViewerRequest, VIEWER_ROUTE_PREFIX } from "../../packages/extensions/atf-ui/src/server.js";

const runsRoot = "/data/atf/uat/runs";
const runId = "awb_r1";
const runDir = `${runsRoot}/${runId}`;
const live = existsSync(`${runDir}/analysis/chain/viewer/viewer.html`);

describe.skipIf(!live)("E6 真机：analysis/<lane>/viewer 实件（awb_r1/analysis/chain）", () => {
  it("发现清单含 lane 变体；裸 URL / 显式 lane / lane 图片均可解析", () => {
    const viewers = discoverViewerDirs(runDir);
    expect(viewers).toContain("analysis/chain");
    expect(resolveViewerRequest(runsRoot, `${VIEWER_ROUTE_PREFIX}/${runId}/`, viewers)?.type).toContain("text/html");
    expect(resolveViewerRequest(runsRoot, `${VIEWER_ROUTE_PREFIX}/${runId}/analysis/chain/`, viewers)?.abs)
      .toBe(`${runDir}/analysis/chain/viewer/viewer.html`);
    const image = readdirSync(`${runDir}/analysis/chain/viewer/images`).find((name) => name.endsWith(".png"));
    expect(image).toBeDefined();
    expect(resolveViewerRequest(runsRoot, `${VIEWER_ROUTE_PREFIX}/${runId}/analysis/chain/images/${String(image)}`, viewers)?.type)
      .toBe("image/png");
  });
  it("对照：旧规则（只认一层 analysis*）在同一实件上解析为空", () => {
    const oneLevel = readdirSync(runDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("analysis") && !entry.name.includes(".bak"))
      .map((entry) => entry.name);
    expect(resolveViewerRequest(runsRoot, `${VIEWER_ROUTE_PREFIX}/${runId}/`, oneLevel)).toBeNull();
  });
});
