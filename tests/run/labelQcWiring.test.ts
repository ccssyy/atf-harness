/**
 * R-3 接线批（2026-09-23）接线测试：工具面 7→9——① 审批策略矩阵（inspect/resolve 均须
 * 审批）；② executor 点号方法显式映射（atf_label_qc.inspect／atf_label_qc.resolve）；
 * ③ canonical output 校验（内核 §13.13/§13.14 返回面形态；坏形态 → failed(schema_violation)）；
 * ④ 入参闭集（action/disposition 枚举越界 → input_violation）。
 * 桩 transport 记录 method 名；账本查询返回空链＋问答轨 handler 放行（granted）——
 * 第二道人审的放行语义由桩承载，此处只验证接线，不验证 CAS（既有 executor 测试面覆盖）。
 */
import { describe, expect, it } from "vitest";
import { err, ok, type Result } from "../../src/bridge/index.js";
import type { BridgeError } from "../../src/bridge/errors.js";
import { requiresApprovalFor, ToolExecutor, ToolRegistry, type ApprovalGate, type BridgeTransport } from "../../src/core/tools/index.js";
import type { ScopeRef } from "../../src/core/tools/approvalKey.js";

const SCOPE_REF: ScopeRef = { project_id: "proj", scope_type: "run", scope_id: "run", scope_mode: "headless" };

const INSPECT_RESULT = {
  ok: true,
  dataset_id: "ds-3b7551bca6ec",
  pin: "5fe2a8c9a98b",
  report_ref: "datasets/ds-3b7551bca6ec@5fe2a8c9a98b/label-qc-report.json",
  report_file_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  report_digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  counts: { total_items: 1, pending: 1, resolved: 0, by_check_class: { q2_same_box_same_value_diff_field: 1 } },
  human_summary: { headline: "x", sections: [], metrics: [], actions: [], pending_confirmations: [], notes: [] },
};

const RESOLVE_RESULT = {
  ok: true,
  dataset_id: "ds-3b7551bca6ec",
  pin: "5fe2a8c9a98b",
  resolved_count: 1,
  pending_count: 0,
  decisions_ref: "datasets/ds-3b7551bca6ec@5fe2a8c9a98b/label-qc-decisions.json",
  decisions_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  human_summary: { headline: "x", sections: [], metrics: [], actions: [], pending_confirmations: [], notes: [] },
};

/** 桩 transport：ledger_query → 空链（走问答轨）；label_qc 方法 → 记 method 名并返回样本结果。 */
const makeStubTransport = (response: unknown, methods: string[]): BridgeTransport => ({
  request: async (method: string): Promise<Result<unknown, BridgeError>> => {
    if (method === "ledger_query") return ok({ ok: true, records: [] });
    methods.push(method);
    return ok(response);
  },
});

const grantedGate: ApprovalGate = {
  handler: async () => ({ kind: "granted" }),
};

const execute = async (transport: BridgeTransport, tool: string, params: unknown): Promise<Awaited<ReturnType<ToolExecutor["execute"]>>> => {
  const executor = new ToolExecutor(transport, ToolRegistry.createDefault(), SCOPE_REF);
  return executor.execute(tool, params, grantedGate);
};

describe("审批策略矩阵：label_qc 两工具均须审批（写动作）", () => {
  it("inspect/resolve requires_approval=true（requiresApprovalFor 单一出口）", () => {
    const registry = ToolRegistry.createDefault();
    const inspect = registry.get("atf_label_qc_inspect");
    const resolve = registry.get("atf_label_qc_resolve");
    expect(inspect.ok && requiresApprovalFor(inspect.value, { dataset_id: "ds" })).toBe(true);
    expect(resolve.ok && requiresApprovalFor(resolve.value, { dataset_id: "ds", actor: "a", report_digest: "d", decisions: [] })).toBe(true);
  });
});

describe("executor 显式映射与 canonical 校验", () => {
  it("atf_label_qc_inspect → atf_label_qc.inspect；成功形态过 canonical", async () => {
    const methods: string[] = [];
    const outcome = await execute(makeStubTransport(INSPECT_RESULT, methods), "atf_label_qc_inspect", { dataset_id: "ds-3b7551bca6ec" });
    expect(methods).toEqual(["atf_label_qc.inspect"]);
    expect(outcome.kind).toBe("executed");
  });

  it("atf_label_qc_resolve → atf_label_qc.resolve；decisions 逐字透传", async () => {
    const methods: string[] = [];
    const params = {
      dataset_id: "ds-3b7551bca6ec",
      actor: "tui-operator",
      decided_at: "2026-09-23T00:00:00Z",
      report_digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      decisions: [
        { item_id: "qc-q2-aaaaaaaaaaaa", action: "modify", disposition: "keep_both", reason_text: "两条都保留" },
        { item_id: "qc-q4-bbbbbbbbbbbb", action: "reject" },
      ],
    };
    const outcome = await execute(makeStubTransport(RESOLVE_RESULT, methods), "atf_label_qc_resolve", params);
    expect(methods).toEqual(["atf_label_qc.resolve"]);
    expect(outcome.kind).toBe("executed");
  });

  it("返回面缺字段（human_summary 缺席）→ failed(schema_violation)（E3 结构性区分）", async () => {
    const methods: string[] = [];
    const broken = { ...INSPECT_RESULT } as Record<string, unknown>;
    delete broken["human_summary"];
    const outcome = await execute(makeStubTransport(broken, methods), "atf_label_qc_inspect", { dataset_id: "ds" });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.error.code).toBe("schema_violation");
  });

  it("入参闭集：action 越界 → input_violation（未触桥接）；report_digest 缺席 → input_violation", async () => {
    const methods: string[] = [];
    const badAction = await execute(makeStubTransport(RESOLVE_RESULT, methods), "atf_label_qc_resolve", {
      dataset_id: "ds",
      actor: "a",
      report_digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      decisions: [{ item_id: "i", action: "purge" }],
    });
    expect(badAction.kind).toBe("input_violation");
    expect(methods).toEqual([]); // 入参校验在桥接前
    const missingDigest = await execute(makeStubTransport(INSPECT_RESULT, methods), "atf_label_qc_resolve", {
      dataset_id: "ds",
      actor: "a",
      decisions: [{ item_id: "i", action: "reject" }],
    });
    expect(missingDigest.kind).toBe("input_violation");
  });

  it("qc_params 未知键拒绝（键闭集）→ input_violation", async () => {
    const methods: string[] = [];
    const outcome = await execute(makeStubTransport(INSPECT_RESULT, methods), "atf_label_qc_inspect", {
      dataset_id: "ds",
      qc_params: { normalization: "0-1000" }, // 无坐标制参数——非闭集键
    });
    expect(outcome.kind).toBe("input_violation");
  });
});

describe("stub 自检", () => {
  it("err/ok 导出形状（防桩误用）", () => {
    expect(err({ code: "x", message: "y" }).ok).toBe(false);
    expect(ok(1).ok).toBe(true);
  });
});
