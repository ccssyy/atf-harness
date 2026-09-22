/**
 * L1c 提前批 A3（2026-09-22）：completed turn 产品化摘要——轻量三段确定性推导。
 * 对称性：failure 有 failure_summary/collapseLines；completed 由本模块补齐（账本轨零新增，
 * 纯由已落盘事件推导）。
 */
import { describe, expect, it } from "vitest";
import { completedSummaryLines } from "../../src/ui/completedSummary.js";
import { type SessionEvent } from "../../src/core/session/index.js";

let seq = 0;
const ev = (type: SessionEvent["type"], payload: unknown): SessionEvent => {
  seq += 1;
  return { id: seq, ts: "2026-09-22T00:00:00Z", type, payload, projection: { evidence_event: null } };
};
const call = (tool: string): SessionEvent => ev("tool/call", { tool, params: {} });
const okResult = (tool: string, result: unknown): SessionEvent => ev("tool/result", { tool, ok: true, result, call_ref: 1 });

const PROPOSE_SUMMARY = {
  headline: "数据集 ds-3b7551bca6ec@5fe2a8c9a98b 尚无版式聚类料，需要先确认聚类参数并执行聚类。",
  sections: [], metrics: [],
  actions: [{ title: "确认聚类参数", detail: "确认聚类参数后调用 atf_style_cluster.execute。", needs_decision: false }],
  pending_confirmations: [], notes: [],
};

describe("A3 completed turn 三段摘要", () => {
  it("三段齐备：做了什么（产品名＋headline 代机名＋×N 聚合）／产生了什么／下一步建议", () => {
    const events: SessionEvent[] = [
      ev("turn/start", { scenario_id: "s", branch_id: "b" }),
      ev("user/message", { text: "把数据登记并做好聚类" }),
      call("atf_workspace_status"),
      okResult("atf_workspace_status", { ok: true, admitted_count: 1, human_summary: { headline: "工作区已登记 1 批数据集", sections: [], metrics: [], actions: [], pending_confirmations: [], notes: [] } }),
      call("atf_workspace_status"),
      okResult("atf_workspace_status", { ok: true, admitted_count: 1, human_summary: { headline: "工作区已登记 1 批数据集", sections: [], metrics: [], actions: [], pending_confirmations: [], notes: [] } }),
      call("atf_admit_data"),
      okResult("atf_admit_data", { journal_type: "dataset", fact_id: "ds-3b7551bca6ec@5fe2a8c9a98b", sha256_digest: "a".repeat(64) }),
      call("atf_preparation_propose"),
      okResult("atf_preparation_propose", { ok: true, stage: "cluster_confirmation", cluster_params_template: {}, human_summary: PROPOSE_SUMMARY }),
      ev("turn/end", { reason: "completed", stop_reason: "final_answer" }),
    ];
    const text = completedSummaryLines(events).join("\n");
    expect(text).toContain("──── 本轮小结 ────");
    expect(text).toContain("做了什么：");
    expect(text).toContain("工作区已登记 1 批数据集 ×2"); // 同 headline 聚合 ×N
    expect(text).toContain("登记数据"); // admit 无 headline → 产品名
    expect(text).toContain("产生了什么：");
    expect(text).toContain("登记身份：ds-3b7551bca6ec@5fe2a8c9a98b");
    expect(text).toContain("下一步建议：");
    expect(text).toContain("确认聚类参数后调用 atf_style_cluster.execute。"); // 内核 human 层直渲染
  });

  it("聚类产物：assignment_ref＋簇数进「产生了什么」；准入判定 status 同", () => {
    const events: SessionEvent[] = [
      ev("turn/start", { scenario_id: "s", branch_id: "b" }),
      call("atf_style_cluster_execute"),
      okResult("atf_style_cluster_execute", { ok: true, assignment_ref: "l1/ds-x@pin/style-cluster-assignment.json", cluster_count: 3 }),
      call("atf_data_admission_request"),
      okResult("atf_data_admission_request", { ok: true, status: "admitted", human_summary: { headline: "h", sections: [], metrics: [], actions: [], pending_confirmations: [], notes: [] } }),
      ev("turn/end", { reason: "completed" }),
    ];
    const text = completedSummaryLines(events).join("\n");
    expect(text).toContain("聚类产物：l1/ds-x@pin/style-cluster-assignment.json（3 簇）");
    expect(text).toContain("准入判定：admitted");
  });

  it("无动作／无产物／无下一动作 → 兜底行；「下一步」段整段不出现（没内容就不出行）", () => {
    const events: SessionEvent[] = [
      ev("turn/start", { scenario_id: "s", branch_id: "b" }),
      ev("user/message", { text: "你好" }),
      ev("assistant/message", { text: "你好！" }),
      ev("turn/end", { reason: "completed", stop_reason: "final_answer" }),
    ];
    const text = completedSummaryLines(events).join("\n");
    expect(text).toContain("（本 turn 无工具动作）");
    expect(text).toContain("无新产物");
    expect(text).not.toContain("下一步建议");
  });

  it("末 turn 切片：上一 turn 的动作不进本轮摘要", () => {
    const events: SessionEvent[] = [
      ev("turn/start", { scenario_id: "s", branch_id: "b" }),
      call("atf_admit_data"),
      okResult("atf_admit_data", { journal_type: "dataset", fact_id: "ds-old@pin", sha256_digest: "b".repeat(64) }),
      ev("turn/end", { reason: "completed" }),
      ev("turn/start", { scenario_id: "s", branch_id: "b" }),
      ev("user/message", { text: "继续" }),
      ev("turn/end", { reason: "completed", stop_reason: "final_answer" }),
    ];
    const text = completedSummaryLines(events).join("\n");
    expect(text).not.toContain("ds-old@pin");
    expect(text).toContain("（本 turn 无工具动作）");
  });
});
