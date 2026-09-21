import { describe, expect, it } from "vitest";
import { adaptProjectionToMessages, expandModelResponse } from "../../src/llm/index.js";
import { type LlmContextEvent } from "../../src/core/session/index.js";

/**
 * 切片 2 · VERIFY 1（B1 adapter 映射）＋ A3 多工具展开（任务书 §3.1/§3.2 上半）。
 *
 * B1：映射纯函数（同输入同输出）、顺序稳定、fail-closed（未声明事件类型/字段拒绝）、
 *     不含预算/治理内部字段（模型不可见延续）。
 * A3：一次模型响应含 N 个工具 → 展开为 N 个顺序 LlmDecision（loop 一次决策一个工具）。
 */

const event = (id: number, type: LlmContextEvent["type"], payload: unknown): LlmContextEvent => ({
  id,
  ts: "2026-09-14T00:00:00Z",
  type,
  payload,
});

describe("切片 2 · VERIFY 1 B1 adapter 映射", () => {
  it("四类语义内容 + 审批事件 → 消息序列（顺序稳定、source_event_id 回填）", () => {
    const context: LlmContextEvent[] = [
      event(1, "turn/start", { scenario_id: "s" }),
      event(2, "user/message", { text: "触发指令" }),
      event(3, "assistant/message", { text: "我来处理" }),
      event(4, "tool/call", { tool: "atf_gate", params: { gate: "G1", action: "query" } }),
      event(5, "tool/result", { tool: "atf_gate", ok: true, result: { status: "pass" }, call_ref: 4 }),
      event(6, "approval/request", { tool: "atf_admit_data", question: "是否准入?" }),
      event(7, "approval/response", { verdict: "denied", actor: "host" }),
      event(8, "turn/end", { reason: "completed" }),
    ];
    const first = adaptProjectionToMessages(context);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 顺序稳定：结构标记（turn/*）声明为 skip，其余按事件流顺序一一对应
    expect(first.value.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant_tool_call",
      "tool_result",
      "approval",
      "approval",
    ]);
    expect(first.value.map((message) => message.source_event_id)).toEqual([2, 3, 4, 5, 6, 7]);
    // 纯函数：同输入同输出
    expect(adaptProjectionToMessages(context)).toEqual(first);
  });

  it("fail-closed：未声明事件类型 / 未声明字段 / payload 非对象 → 整体拒绝", () => {
    // 真正未声明的形态（事件流 12 类之外）：fail-closed 拒绝
    const unknownType = adaptProjectionToMessages([event(1, "memory/read" as LlmContextEvent["type"], { x: 1 })]);
    expect(unknownType.ok).toBe(false);
    if (!unknownType.ok) expect(unknownType.error.message).toContain("未声明的事件类型");
    // 已声明为 skip 的结构标记不产生消息（非遗漏）
    const undeclaredField = adaptProjectionToMessages([event(1, "user/message", { text: "x", budget: 32 })]);
    expect(undeclaredField.ok).toBe(false);
    if (!undeclaredField.ok) expect(undeclaredField.error.message).toContain("未声明字段");
    const badPayload = adaptProjectionToMessages([event(1, "tool/call", "not-an-object")]);
    expect(badPayload.ok).toBe(false);
  });

  it("映射结果不含预算/治理内部字段（模型不可见延续）", () => {
    const context: LlmContextEvent[] = [
      event(1, "user/message", { text: "hi" }),
      event(2, "tool/result", { tool: "atf_gate", ok: false, reason: "blocked", call_ref: 1 }),
    ];
    const mapped = adaptProjectionToMessages(context);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const serialized = JSON.stringify(mapped.value);
    for (const forbidden of ["budget", "max_steps", "max_turns", "stop_reason", "approval_key", "params_digest"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("D-f 补正批（B2/B4）：tool/result 附注白名单＋摘要化定向扩展", () => {
  const GUIDANCE = "【invalid_params】参数形态或互斥约束不合法。缺：符合工具 schema 的参数。按 detail 修正后重试";
  const NUDGE = "控制面提示：该调用与此前调用重复且无新信息。";

  it("用例 1：ok:false ＋ guidance → summary 含 reason 且含 guidance 文案（内容断言）", () => {
    const mapped = adaptProjectionToMessages([
      event(1, "tool/result", {
        tool: "atf_admit_data", ok: false, reason: "invalid_params", call_ref: 1,
        block: { reason: "invalid_params", message: "x", tool: "atf_admit_data", exit_code: 1 },
        detail: { code: "invalid_params" }, guidance: GUIDANCE,
      }),
    ]);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const toolResult = mapped.value.find((message) => message.role === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.role !== "tool_result") return;
    expect(toolResult.summary).toContain("invalid_params");
    expect(toolResult.summary).toContain(GUIDANCE);
    // 顺序：reason 主体在前、附注在后（旧信息超集语义）
    expect(toolResult.summary.indexOf("invalid_params")).toBeLessThan(toolResult.summary.indexOf(GUIDANCE));
  });

  it("用例 2（零回归硬要求）：两字段缺省时 ok:false summary 与现状逐字节一致", () => {
    const payload = { tool: "atf_gate", ok: false, reason: "unknown_gate", call_ref: 1, detail: { code: "unknown_gate" } };
    const mapped = adaptProjectionToMessages([event(1, "tool/result", payload)]);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const toolResult = mapped.value[0];
    if (toolResult?.role !== "tool_result") throw new Error("unreachable");
    expect(toolResult.summary).toBe("unknown_gate"); // 逐字节一致（非 contains）
  });

  it("用例 3：ok:true ＋ nudge → summary 含 readableSummary(result) 且含 nudge（runner.ts:1224 注入点）", () => {
    const result = { ok: true, count: 0, facts: [] };
    const mapped = adaptProjectionToMessages([
      event(1, "tool/result", { tool: "atf_fact_scan", ok: true, result, call_ref: 1, nudge: NUDGE }),
    ]);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const toolResult = mapped.value[0];
    if (toolResult?.role !== "tool_result") throw new Error("unreachable");
    expect(toolResult.summary).toContain(JSON.stringify(result));
    expect(toolResult.summary).toContain(NUDGE);
  });

  it("用例 4（零回归硬要求）：ok:true 无 nudge → summary 与现状逐字节一致", () => {
    const result = { ok: true, count: 0, facts: [] }; // 短载荷（readableSummary 160 截断内）
    const mapped = adaptProjectionToMessages([event(1, "tool/result", { tool: "atf_fact_scan", ok: true, result, call_ref: 1 })]);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const toolResult = mapped.value[0];
    if (toolResult?.role !== "tool_result") throw new Error("unreachable");
    expect(toolResult.summary).toBe(JSON.stringify(result)); // 逐字节一致
  });

  it("用例 5（反向）：未声明字段仍被拦（白名单未被放宽）", () => {
    const mapped = adaptProjectionToMessages([
      event(1, "tool/result", { tool: "atf_gate", ok: false, reason: "blocked", call_ref: 1, budget: 32 }),
    ]);
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) expect(mapped.error.message).toContain("未声明字段");
    if (mapped.ok) throw new Error("unreachable");
    expect(mapped.error.message).toContain("budget");
  });

  it("ok:false 双附注顺序 = [reason, guidance, nudge]；缺省段滤除", () => {
    const mapped = adaptProjectionToMessages([
      event(1, "tool/result", { tool: "atf_fact_scan", ok: false, reason: "blocked", call_ref: 1, nudge: NUDGE }),
    ]);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const toolResult = mapped.value[0];
    if (toolResult?.role !== "tool_result") throw new Error("unreachable");
    expect(toolResult.summary).toBe(`blocked｜${NUDGE}`); // guidance 缺省 → 段滤除，不产生空段
  });
});

describe("切片 2 · A3 多工具展开（一次响应 → N 个顺序决策）", () => {
  it("message + N 工具 → N+1 个顺序决策（message 先行、工具按声明序）", () => {
    const expanded = expandModelResponse({
      message: "依次执行两项准入动作",
      tool_calls: [
        { tool: "atf_admit_data", params: { dataset_id: "ds-1" } },
        { tool: "atf_admit_data", params: { dataset_id: "ds-2" } },
      ],
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.value).toHaveLength(3);
    expect(expanded.value[0]).toEqual({ type: "assistant_message", text: "依次执行两项准入动作" });
    expect(expanded.value[1]).toEqual({ type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-1" } });
    expect(expanded.value[2]).toEqual({ type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-2" } });
  });

  it("final_answer 单独 → 1 个决策；final_answer 与 tool_calls 并存 → 拒绝（终止与待执行冲突）", () => {
    const finalOnly = expandModelResponse({ final_answer: "done" });
    expect(finalOnly).toEqual({ ok: true, value: [{ type: "final_answer", text: "done" }] });
    const conflict = expandModelResponse({
      final_answer: "done",
      tool_calls: [{ tool: "atf_gate", params: {} }],
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.message).toContain("并存");
  });

  it("fail-closed：空响应 / 未声明字段 / 缺 params → 拒绝", () => {
    expect(expandModelResponse({}).ok).toBe(false);
    expect(expandModelResponse({ message: "x", budget: 32 }).ok).toBe(false);
    expect(expandModelResponse({ tool_calls: [{ tool: "atf_gate" }] }).ok).toBe(false);
    expect(expandModelResponse("not-an-object").ok).toBe(false);
  });
});
