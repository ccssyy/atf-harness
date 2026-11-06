/** D226b 锚:@plan 确定性引用(读图文件名不手抄的根治)。
 * owner 质询:visual-sample-plan.json 里 path/page 本就是确定性真名,近似名 top3
 * 是给手抄兜底=遮掩式。根治=引用语法 @plan:<清单>#<序号|页名>,守卫解析真名
 * 改写参数,agent 永不接触文件名字符串;解析失败给确定性错误。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePlanRef } from "../../packages/extensions/atf-tools/src/fileGuardFace.js";

describe("D226b——@plan 确定性引用", () => {
  const dir = join(tmpdir(), `atf-d226b-${Date.now()}`);
  mkdirSync(join(dir, "risk-signals"), { recursive: true });
  const plan = join(dir, "risk-signals", "visual-sample-plan.json");
  writeFileSync(plan, JSON.stringify({
    schema_version: "VisualSamplePlan/v1",
    pages: [
      { page: "CMFFS32680 Invoice#54,#60,#90-91,#137,#143-144,Cargo Receipt, Air Waybill_02.jpg", path: join(dir, "CMFFS32680 Invoice#54,#60,#90-91,#137,#143-144,Cargo Receipt, Air Waybill_02.jpg"), fields: ["invoice_no"] },
      { page: "1c436619-uuid_00_[00].jpg", path: join(dir, "1c436619-uuid_00_[00].jpg"), fields: ["buyer"] },
    ],
  }));

  it("序号引用解析出确定性真名(含 #/逗号/空格的长名)", () => {
    const r = resolvePlanRef(`@plan:${plan}#0`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toContain("Air Waybill_02.jpg");
  });
  it("页名引用同样解析(按 page 字段精确匹配)", () => {
    const r = resolvePlanRef(`@plan:${plan}#1c436619-uuid_00_[00].jpg`);
    expect(r.ok).toBe(true);
  });
  it("越界/错名:确定性错误带清单页数与可用引用格式", () => {
    const r = resolvePlanRef(`@plan:${plan}#99`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("共 2 页");
      expect(r.reason).toContain("0-1");
      expect(r.reason).toContain("改法");
    }
  });
  it("清单不可读:错误带两条改法", () => {
    const r = resolvePlanRef(`@plan:${join(dir, "no-such.json")}#0`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("核对清单绝对路径");
  });
  it("非引用形态:reason 为空(守卫不处理,走原路径)", () => {
    const r = resolvePlanRef("/plain/abs/path.jpg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("");
  });
});
