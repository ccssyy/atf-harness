/** G1 拆解单元③最小单测（批㉞H-H3）：toolResultPayload.ts——守卫管道回填构造面独立可测锚。
 *  钉三调用点（主循环/resume 重派/确认直填）收口单源后的五类 kind 分流与附注纪律。 */
import { describe, expect, it } from "vitest";
import { buildToolResultPayload, gateFor } from "../../src/core/run/toolResultPayload.js";
import type { ToolCallOutcome } from "../../src/core/tools/index.js";

const EVENTS: never[] = []; // 确认凭据并入径不在本锚覆盖（findExistingCredential 空序列恒 null——原样透传）

describe("G1 单元③ toolResultPayload（守卫管道·回填构造）", () => {
  it("五类 kind 分流：executed 带 result／rejected·input_violation 带 detail／failed reason=failed 带 error／blocked 带 block", () => {
    const executed = buildToolResultPayload({ tool: "t", callRef: 7, events: EVENTS, result: { kind: "executed", result: { a: 1 } } as ToolCallOutcome });
    expect(executed).toEqual({ tool: "t", ok: true, result: { a: 1 }, call_ref: 7 });
    const rejected = buildToolResultPayload({ tool: "t", callRef: 7, events: EVENTS, result: { kind: "rejected", reason: "dataset_missing", detail: { x: 1 } } as ToolCallOutcome });
    expect(rejected).toEqual({ tool: "t", ok: false, reason: "dataset_missing", call_ref: 7, detail: { x: 1 } });
    const violation = buildToolResultPayload({ tool: "t", callRef: 7, events: EVENTS, result: { kind: "input_violation", reason: "schema", detail: "d" } as ToolCallOutcome });
    expect(violation).toMatchObject({ ok: false, reason: "schema", detail: "d" });
    const failed = buildToolResultPayload({ tool: "t", callRef: 7, events: EVENTS, result: { kind: "failed", error: { message: "boom" } } as ToolCallOutcome });
    expect(failed).toEqual({ tool: "t", ok: false, reason: "failed", call_ref: 7, detail: { message: "boom" } });
    const blocked = buildToolResultPayload({ tool: "t", callRef: 7, events: EVENTS, result: { kind: "blocked", block: { reason: "approval_denied", message: "m" } } as ToolCallOutcome });
    expect(blocked).toEqual({ tool: "t", ok: false, reason: "approval_denied", call_ref: 7, block: { reason: "approval_denied", message: "m" } });
  });
  it("附注纪律：nudge 附 executed/rejected/input_violation/blocked 不附 failed；guidance 附 rejected/input_violation；executedGuidance 附 executed", () => {
    const base = { tool: "t", callRef: 1, events: EVENTS, nudge: "n", guidance: "g", executedGuidance: "eg" } as const;
    expect(buildToolResultPayload({ ...base, result: { kind: "executed", result: 1 } as ToolCallOutcome })).toMatchObject({ nudge: "n", guidance: "eg" });
    expect(buildToolResultPayload({ ...base, result: { kind: "rejected", reason: "r" } as ToolCallOutcome })).toMatchObject({ nudge: "n", guidance: "g" });
    expect(buildToolResultPayload({ ...base, result: { kind: "input_violation", reason: "r" } as ToolCallOutcome })).toMatchObject({ nudge: "n", guidance: "g" });
    expect(buildToolResultPayload({ ...base, result: { kind: "blocked", block: { reason: "b", message: "m" } } as ToolCallOutcome })).toMatchObject({ nudge: "n" });
    const failed = buildToolResultPayload({ ...base, result: { kind: "failed", error: {} } as ToolCallOutcome });
    expect("nudge" in failed).toBe(false); // failed 径恒不附 nudge（主循环既有语义）
    expect("guidance" in failed).toBe(false);
  });
  it("gateFor：handler 缺席 undefined；在场 → gate 回调回填 tool_call_id（凭据配对键）", async () => {
    expect(gateFor(undefined, 5)).toBeUndefined();
    const seen: number[] = [];
    const handler = (async (input: { tool_call_id: number }) => {
      seen.push(input.tool_call_id);
      return { kind: "granted" } as never;
    }) as never;
    const gate = gateFor(handler, 42)!;
    const verdict = await gate.handler({ tool: "t", params: {}, approval_key: "k" } as never);
    expect(seen).toEqual([42]);
    expect(verdict).toBeDefined();
  });
});
