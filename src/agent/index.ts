/**
 * src/agent——ATF KIE Training Agent 新进程（方案丙，批 P）。
 *
 * 门 1a spike 面：faux streamFn／DeepSeek 装配（一期 wire 经验复用）／工具挂接（单源投影
 * 经桥）／审批 before_tool hook（账本闸继承）／session 树镜像与孤儿恢复／场景驱动。
 * 依赖方向：agent → {core/tools, bridge, llm}（与三外壳同级——core 的消费者，core 不反依）。
 */
export { createFauxStreamFn, fauxAssistantMessage, fauxFinalAnswer, fauxMessageWithToolCalls, type FauxStreamFn } from "./fauxStream.js";
export { assembleDeepSeekModel, createDeepSeekStreamFn, type DeepSeekStreamFnConfig } from "./deepseekStreamFn.js";
export { buildSpikeAgentTools, spikeToolDefinitions, SPIKE_TOOL_NAMES, toAtfAgentTool, spikeRequiresApproval, type AtfAgentToolDeps, type SpikeBridgeTransport } from "./atfAgentTools.js";
export { createApprovalBeforeToolCall, type ApprovalAuditEntry, type ApprovalHookDeps } from "./approvalHook.js";
export {
  NodeFsAdapter,
  createJsonlSessionRepo,
  detectOrphanTip,
  mirrorEvidenceEvent,
  mirrorMessage,
  readBranchEntries,
  recoverFromOrphan,
  transcriptFromEntries,
  type EvidenceEventStub,
  type SessionLike,
} from "./sessionMirror.js";
export { runGate1aSpike, type SpikeDeps, type SpikeResult } from "./spike.js";
