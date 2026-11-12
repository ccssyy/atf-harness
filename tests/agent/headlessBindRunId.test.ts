// -*- coding: utf-8 -*-
/** D276-eval/D284:headless real 链 bind run_id 形态锚（内核闭集=小写字母数字连字符）。
 *
 * RED 史实：原 ISO 形态（2026-11-11T15:28:36.420Z → 含大写 T/Z）被内核 bind_run
 * 校验拒（internal_error:ValueError，_is_safe_component 语义）——headless real 链
 * 首次真跑暴露。本测试按内核 _is_safe_component 语义断言：小写字母数字连字符闭集。
 */
import { describe, expect, it } from "vitest";
import { headlessBindRunIdOf } from "../../src/agent/cli.js";

describe("headlessBindRunIdOf（bind run_id 内核闭集锚）", () => {
  it("输出只含小写字母/数字/连字符（_is_safe_component 语义——大写或冒号即 kernel ValueError）", () => {
    const id = headlessBindRunIdOf(new Date("2026-11-11T15:28:36.420Z"));
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(id).not.toContain("T");
    expect(id).not.toContain("Z");
    expect(id).not.toContain(":");
  });

  it("v1 前缀+日期时间形状（可与 1109-7 真机 run_id 闭集对账）", () => {
    const id = headlessBindRunIdOf(new Date("2026-11-11T15:28:36.420Z"));
    expect(id).toBe("v1-2026-11-11-15-28-36-420");
  });

  it("同输入幂等（确定性——xDist/重放一致）", () => {
    const d = new Date("2026-11-12T08:00:00.000Z");
    expect(headlessBindRunIdOf(d)).toBe(headlessBindRunIdOf(d));
  });
});
