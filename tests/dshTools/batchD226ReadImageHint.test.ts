/** D226 锚:read_image 目标缺席近似名纠错(报错即修复指令)。
 * 真机实锚 11-06:看图清单文件名正确(CMFFS32680 Invoice#... Air Waybill_02.jpg),
 * agent 转录臆造(Air Wayb 0001.jpg),vendor 裸 FS_NOT_FOUND 零指引——用户看到
 * 「说不存在其实存在」。修复=守卫层对白名单内缺席目标给同目录近似名 top-3+两条改法。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readImageAbsentHintOf, READ_IMAGE_TARGET_ABSENT } from "../../packages/extensions/atf-tools/src/fileGuardFace.js";

describe("D226——read_image 缺席近似名纠错", () => {
  const dir = join(tmpdir(), `atf-d226-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const realName = "CMFFS32680 Invoice#54,#60,#90-91,#137,#143-144,Cargo Receipt, Air Waybill_02.jpg";
  writeFileSync(join(dir, realName), "x");
  writeFileSync(join(dir, "1c436619-d33c-4bf5-9987-c71f42f9c550_00_[00].jpg"), "x");

  it("目标存在→放行(null,不干扰正常读图)", () => {
    expect(readImageAbsentHintOf(join(dir, realName))).toBeNull();
  });
  it("臆造名(真机形态)→deny 文案含真名候选与两条改法", () => {
    const hint = readImageAbsentHintOf(join(dir, "CMFFS32680 Invoice#54,#60,#90-91,#137,#143-144,Cargo Receipt, Air Wayb 0001.jpg"));
    expect(hint).not.toBeNull();
    expect(hint).toContain(READ_IMAGE_TARGET_ABSENT);
    expect(hint).toContain(realName);
    expect(hint).toContain("改法");
    expect(hint).toContain("①");
    expect(hint).toContain("②");
  });
  it("完全无关名→仍报缺席+目录计数(不臆造候选)", () => {
    const hint = readImageAbsentHintOf(join(dir, "zzz-nonexistent.jpg"));
    expect(hint).toContain(READ_IMAGE_TARGET_ABSENT);
    expect(hint).toContain("个图片文件");
  });

  it("目录不存在→回落 null(交 vendor 原生报错,不越权造报文)", () => {
    expect(readImageAbsentHintOf(join(dir, "no-such-dir", "a.jpg"))).toBeNull();
  });

  it.runIf(process.env.CI !== undefined)("清理", () => rmSync(dir, { recursive: true, force: true }));
});
