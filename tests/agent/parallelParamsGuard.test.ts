// -*- coding: utf-8 -*-
/** D276 对抗③+B 批对抗段:parseParallelParams 守卫测试(超上限拒绝/边界形态)。 */
import { describe, expect, it } from "vitest";
import { DISPATCH_PARALLEL_MAX_SUBTASKS, parseParallelParams } from "../../src/agent/subagent.js";

const mkSubtasks = (n: number): Array<{ label: string; instruction: string }> =>
  Array.from({ length: n }, (_, i) => ({ label: `s${String(i + 1)}`, instruction: `指令 ${String(i + 1)}` }));

describe("parseParallelParams 对抗守卫(D276)", () => {
  it(`subtasks=${String(DISPATCH_PARALLEL_MAX_SUBTASKS + 1)} 超上限→拒绝且报错含上限值`, () => {
    const parsed = parseParallelParams({ subtasks: mkSubtasks(DISPATCH_PARALLEL_MAX_SUBTASKS + 1) });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(String(DISPATCH_PARALLEL_MAX_SUBTASKS));
  });

  it(`subtasks=${String(DISPATCH_PARALLEL_MAX_SUBTASKS)} 恰在上限→接受`, () => {
    const parsed = parseParallelParams({ subtasks: mkSubtasks(DISPATCH_PARALLEL_MAX_SUBTASKS) });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.subtasks).toHaveLength(DISPATCH_PARALLEL_MAX_SUBTASKS);
  });

  it("单 subtask→恰 1 项(无空片形态)", () => {
    const parsed = parseParallelParams({ subtasks: mkSubtasks(1) });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.subtasks).toHaveLength(1);
  });

  it("空数组→拒绝", () => {
    expect(parseParallelParams({ subtasks: [] }).ok).toBe(false);
  });

  it("max_concurrency 越界→拒绝", () => {
    expect(parseParallelParams({ subtasks: mkSubtasks(2), max_concurrency: 0 }).ok).toBe(false);
    expect(parseParallelParams({ subtasks: mkSubtasks(2), max_concurrency: 99 }).ok).toBe(false);
  });
});
