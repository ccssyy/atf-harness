import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * drift 对账门禁合成样例测试（B2 工作项 2；2026-11-04 overlay 漂移事故的 CI 拦截点）。
 * 用真实 check-drift.py+generate.py+仓内模板，合成 overlay/产物对，断言红绿退出码
 * 与报错即修复指令。实例面（dev）由 instance-restart 前置覆盖——两层各拦一边。
 */

const SCRIPT = join(process.cwd(), "deploy/profiles/web/check-drift.py");

const runCheck = (overlay: string, deployed: string) =>
  spawnSync("python3", [SCRIPT, "--overlay", overlay, "--deployed", deployed], { encoding: "utf8" });

const buildPair = (): { dir: string; overlay: string; deployed: string } => {
  const dir = mkdtempSync(join(tmpdir(), "atf-drift-"));
  const overlay = join(dir, "t.overlay.yml");
  const deployed = join(dir, "cordis.patch.yml");
  writeFileSync(overlay, "[]\n");
  // 产物=模板直出（overlay 空）——归零基线
  execFileSync("python3", [
    join(process.cwd(), "deploy/profiles/web/generate.py"), "--overlay", overlay, "--out", deployed,
  ]);
  return { dir, overlay, deployed };
};

describe("drift 对账门禁（B2）", () => {
  it("归零态退出 0（模板直出=部署物）", () => {
    const { dir, overlay, deployed } = buildPair();
    try {
      const r = runCheck(overlay, deployed);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("键漂移退出 2 且报错含两条修复指令", () => {
    const { dir, overlay, deployed } = buildPair();
    try {
      const s = readFileSync(deployed, "utf8");
      writeFileSync(deployed, s.replace("welcomeNoticeVersion:", "welcomeNoticeVersionX:"));
      const r = runCheck(overlay, deployed);
      expect(r.status).toBe(2);
      expect(r.stdout).toContain("FAIL");
      expect(r.stdout).toContain("回写");
      expect(r.stdout).toContain("重新生成");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("YAML1.1 布尔键（裸 off）不构成漂移", () => {
    const { dir, overlay, deployed } = buildPair();
    try {
      // 产物把模板的引号 off 键改写为裸 off(解析为 False)——键级归一化后应等价
      const s = readFileSync(deployed, "utf8");
      writeFileSync(deployed, s.replaceAll("off:", "off:"));
      const r = runCheck(overlay, deployed);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
