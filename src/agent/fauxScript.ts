/**
 * 丙 v1（批 P）——faux 脚本加载（headless CLI 测试/演示径；零真实模型调用）。
 *
 * 脚本形态（JSON）：数组，每元素 = {"text": "...", "toolCalls": [{"id","name","arguments"}]}
 * （message＋tool_calls 形）或 {"final": "..."}（final_answer 形）。顺序即模型请求序。
 */
import { readFile } from "node:fs/promises";
import type { JsonObject } from "@earendil-works/pi-ai";
import { createFauxStreamFn, fauxFinalAnswer, fauxMessageWithToolCalls, type FauxStreamFn } from "./fauxStream.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export interface FauxScriptStep {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  final?: string;
}

export const parseFauxScript = (raw: string): AssistantMessage[] => {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("faux 脚本须为 JSON 数组（fail-closed）");
  return (parsed as FauxScriptStep[]).map((step) => {
    if (typeof step.final === "string") return fauxFinalAnswer(step.final);
    if (Array.isArray(step.toolCalls) && step.toolCalls.length > 0) {
      return fauxMessageWithToolCalls(
        typeof step.text === "string" ? step.text : "",
        step.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments as JsonObject })),
      );
    }
    throw new Error("faux 脚本元素须含 final 或非空 toolCalls（fail-closed）");
  });
};

export const loadFauxScript = async (path: string): Promise<AssistantMessage[]> => parseFauxScript(await readFile(path, "utf8"));

export const createScriptedStreamFn = (script: readonly AssistantMessage[]): FauxStreamFn => createFauxStreamFn(script);
