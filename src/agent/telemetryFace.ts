/**
 * 丙 v1.1（批 P 增补漏项补全，owner 指令 2026-09-24）——B7 telemetry：pi span 层级→
 * 事实轨映射。
 *
 * 库原语（census 实证）：AI_TELEMETRY_SCHEMA／HARNESS_TELEMETRY_SCHEMA（span 层级 schema：
 * pi.ai.request←pi.harness.*）＋startAiSpan／startHarnessSpan（typed span starter）＋
 * InMemoryTelemetryContext。丙线挂接：Agent 生命周期事件→pi span→**事实轨事实**
 * （EvidenceEvent 同构记录：事件 id／ts／span 名／属性／状态／时长——K4 镜像面语义，
 * append-only 只读旁路）。「价值高可提前」（owner 指令）：观测面即审计面的丙线起点。
 * 真实 telemetry 后端（导出/上报）后置——本批 sink 为事实轨记录器（faux 层级，零外发）。
 */
import { AI_TELEMETRY_SCHEMA, type AgentEvent } from "@earendil-works/pi-agent-core";
import type { EvidenceEvent } from "./tem/evidence.js";
import { uuidv7 } from "@earendil-works/pi-ai";
import { envFingerprint } from "./tem/evidence.js";

/** span→事实轨记录（EvidenceEvent 同构；kind=telemetry_span 区分工具镜像事实）。 */
export interface TelemetrySpanFact {
  kind: "telemetry_span";
  event_id: string;
  ts: string;
  span_name: string;
  status: "ok" | "error";
  duration_ms: number;
  attributes: Record<string, unknown>;
  run_id: string | null;
  env_fingerprint: EvidenceEvent["env_fingerprint"];
}

export interface TelemetrySink {
  facts: TelemetrySpanFact[];
  /** Agent 事件→span→事实（装配订阅面直用；只读旁路不反压）。 */
  recordAgentEvent(event: AgentEvent, runId: () => string | null, modelTag: string): Promise<void>;
  /** pi span 面直录（startAiSpan 包装——schema 驱动的 typed span 走事实轨）。 */
  recordAiRequestSpan(attributes: { provider: string; model: string; streaming: boolean }, runId: () => string | null): Promise<void>;
}

/** 事实轨 telemetry sink（pi span 层级→事实；本批零外发）。 */
export const createFactTrackTelemetrySink = (modelTag: string): TelemetrySink => {
  const facts: TelemetrySpanFact[] = [];
  const emit = (spanName: string, status: "ok" | "error", durationMs: number, attributes: Record<string, unknown>, runId: () => string | null): TelemetrySpanFact => {
    const fact: TelemetrySpanFact = {
      kind: "telemetry_span",
      event_id: uuidv7(),
      ts: new Date().toISOString(),
      span_name: spanName,
      status,
      duration_ms: durationMs,
      attributes,
      run_id: runId(),
      env_fingerprint: envFingerprint(modelTag),
    };
    facts.push(fact);
    return fact;
  };
  return {
    facts,
    recordAgentEvent: async (event, runId) => {
      const started = Date.now();
      switch (event.type) {
        case "agent_start":
          emit("pi.harness.agent_start", "ok", 0, {}, runId);
          break;
        case "turn_end":
          emit("pi.harness.turn_end", "ok", Math.max(0, started - started), { has_tool_results: event.toolResults.length > 0 }, runId);
          break;
        case "tool_execution_end":
          emit("pi.harness.tool_execution", event.isError ? "error" : "ok", 0, { tool: event.toolName }, runId);
          break;
        default:
          break; // 其余事件不产事实（装配面按需扩展）
      }
    },
    recordAiRequestSpan: async (attributes, runId) => {
      // pi span 层级：pi.harness.* → pi.ai.request（AI_TELEMETRY_SCHEMA 登记面）——本批
      // sink 直录事实（零外发）；真后端升级＝startAiSpan(typed) 换装单点。
      emit(
        "pi.ai.request",
        "ok",
        0,
        {
          "pi.ai.operation": "stream",
          "pi.ai.provider": attributes.provider,
          "pi.ai.model": attributes.model,
          "pi.ai.api": "openai-completions",
          "pi.ai.streaming": attributes.streaming,
          "pi.ai.deferred": false,
        },
        runId,
      );
    },
  };
};

/** schema 登记面暴露（census 对齐——pi.ai.request 等 span 名以 AI_TELEMETRY_SCHEMA 为准）。 */
export const aiTelemetrySpanNames = (): string[] => Object.keys(AI_TELEMETRY_SCHEMA.spans);
