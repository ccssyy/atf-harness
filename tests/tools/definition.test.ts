import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkSchema, validateCanonicalOutput, type SchemaNode } from "../../src/core/tools/canonical.js";
import { ToolRegistry, toModelVisible, WORKSPACE_TOOL_DEFINITIONS, requiresApprovalFor } from "../../src/core/tools/index.js";
import { TOOL_DEFINITIONS } from "../../src/core/tools/toolDefinition.js";
import { spikeRequiresApproval } from "../../src/agent/atfAgentTools.js";
import { approvalParamsDigest, stableStringify } from "../../src/core/tools/approvalKey.js";

/**
 * S3 验收（schema 用例）——ToolDefinition 序列化后不含 timeout 等内部字段；
 * canonical 校验器方言与审批键 digest 算法（与 mock 对端同构）单测。
 */

describe("S3 验收（schema 用例）——模型可见白名单，内部字段一律不发", () => {
  it("9 个工具的模型可见投影仅含 { name, description, parameters }（R1 扩 5；K-Gap-2 扩 7；R-3 接线批扩 9）", () => {
    const registry = ToolRegistry.createDefault();
    const visible = registry.modelVisible();
    expect(visible.map((tool) => tool.name)).toEqual([
      "atf_admit_data",
      "atf_data_admission_request",
      "atf_preparation_propose",
      "atf_style_cluster_execute",
      "atf_label_qc_inspect",
      "atf_label_qc_resolve",
      "atf_gate",
      "atf_fact_scan",
      "atf_workspace_status",
    ]);
    for (const tool of visible) {
      expect(Object.keys(tool).sort()).toEqual(["description", "name", "parameters"]);
    }
  });

  it("序列化产物不含内部字段键（timeout / canonical_output / requires_approval / method 等）", () => {
    const serialized = JSON.stringify(ToolRegistry.createDefault().modelVisible());
    // 以 JSON 键形态断言（"execute" 现为冻结工具名 atf_style_cluster_execute 的组成部分，
    // 子串断言不再适用；内部字段若泄漏必以键形态出现）
    for (const forbidden of ['"timeout":', '"canonical_output":', '"requires_approval":', '"method":', '"connection":', '"execute":', '"ledger":']) {
      expect(serialized, `模型可见形态不得包含内部字段键 "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("toModelVisible 是纯投影：原始定义的内部字段保留在 harness 侧", () => {
    const admit = TOOL_DEFINITIONS[0];
    expect(admit).toBeDefined();
    if (admit === undefined) return;
    expect(admit.requires_approval).toBe(true);
    expect(admit.canonical_output).toBeDefined();

    const visible = toModelVisible(admit);
    expect("requires_approval" in visible).toBe(false);
    expect("canonical_output" in visible).toBe(false);
  });

  it("审批要求按动作性质分流：写动作/闸门须预录，只读免审批", () => {
    const byName = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
    expect(byName.get("atf_admit_data")?.requires_approval).toBe(true);
    expect(byName.get("atf_gate")?.requires_approval).toBe(true);
    expect(byName.get("atf_fact_scan")?.requires_approval).toBe(false);
    expect(byName.get("atf_workspace_status")?.requires_approval).toBe(false);
  });
});

describe("canonical 校验器方言", () => {
  const schema: SchemaNode = {
    type: "object",
    required: ["ok", "name"],
    properties: {
      ok: { const: true },
      name: { type: "string" },
      level: { type: "integer" },
      mode: { enum: ["fast", "slow"] },
      tags: { type: "array", items: { type: "string" } },
      digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    },
  };

  const valid = { ok: true, name: "x", level: 3, mode: "fast", tags: ["a"], digest: "a".repeat(64) };

  it("合法值通过（未声明字段不校验值域，声明字段逐项检查）", () => {
    expect(checkSchema(valid, schema, "t")).toBeNull();
    expect(checkSchema({ ok: true, name: "x" }, schema, "t")).toBeNull(); // 可选字段缺省
  });

  it("缺 required / 类型错 / const 违反 / enum 违反 / pattern 违反 / 额外字段均被拒", () => {
    expect(checkSchema({ name: "x" }, schema, "t")).toContain('"ok"');
    expect(checkSchema({ ...valid, name: 1 }, schema, "t")).toContain("类型非法");
    expect(checkSchema({ ...valid, ok: false }, schema, "t")).toContain("const");
    expect(checkSchema({ ...valid, mode: "turbo" }, schema, "t")).toContain("枚举");
    expect(checkSchema({ ...valid, digest: "XYZ" }, schema, "t")).toContain("pattern");
    expect(checkSchema({ ...valid, extra_field: 1 }, schema, "t")).toContain("额外字段");
    expect(checkSchema("not-an-object", schema, "t")).toContain("类型非法");
    expect(checkSchema({ ...valid, tags: [1] }, schema, "t")).toContain("tags[0]");
  });

  it("validateCanonicalOutput 折算 err(schema_violation)（owner 口径 #4）", () => {
    const outcome = validateCanonicalOutput("atf_demo", schema, { ok: false, name: "x" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("schema_violation");
      expect(outcome.error.message).toContain("atf_demo");
    }
  });

  it("integer 类型：整数通过、非整数拒绝", () => {
    expect(checkSchema({ ...valid, level: 3.0 }, schema, "t")).toBeNull();
    expect(checkSchema({ ...valid, level: 3.5 }, schema, "t")).toContain("integer");
  });
});

describe("审批键 digest——harness 侧算法与契约登记同构（stable stringify + sha256 小写 hex）", () => {
  it("键序无关：同一 params 的不同键序产出同一 digest", () => {
    const a = approvalParamsDigest({ dataset_id: "d1", source: "s" });
    const b = approvalParamsDigest({ source: "s", dataset_id: "d1" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("与手工 stable stringify + sha256 一致（防算法漂移的锚点断言）", () => {
    const params = { gate: "G2", action: "advance", evidence_refs: ["f1", "f2"] };
    const manual =
      createHash("sha256")
        .update('{"action":"advance","evidence_refs":["f1","f2"],"gate":"G2"}', "utf8")
        .digest("hex");
    expect(stableStringify(params)).toBe('{"action":"advance","evidence_refs":["f1","f2"],"gate":"G2"}');
    expect(approvalParamsDigest(params)).toBe(manual);
  });

  it("数组序与值类型参与 digest；null / 嵌套对象稳定", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify([1, 2])).toBe("[1,2]");
    expect(stableStringify({ a: { c: 1, b: 2 } })).toBe('{"a":{"b":2,"c":1}}');
    expect(approvalParamsDigest({ x: [2, 1] })).not.toBe(approvalParamsDigest({ x: [1, 2] }));
  });
});

describe("三件小批 D-2：atf_gate 描述轻补（合法清单展开）", () => {
  it("atf_gate description 含勿猜测句与合法 GateId 清单（GATE_LEGAL_IDS 单源）", () => {
    const visible = ToolRegistry.createDefault().modelVisible();
    const gate = visible.find((tool) => tool.name === "atf_gate");
    expect(gate?.description).toContain("完整性 GateId 非序号顺延，勿猜测");
    expect(gate?.description).toContain("extraction-contract-valid");
    expect(gate?.description).toContain("evaluation-evidence-valid");
    expect(gate?.description).toContain("G1–G4");
  });
});

describe("re-pin v0.7.7b0 投影用例——K1-K3 伴随件三字段 wire 形态（§13.10，零契约面变更）", () => {
  const admissionDefinition = TOOL_DEFINITIONS.find((definition) => definition.name === "atf_data_admission_request");
  const gateDefinition = TOOL_DEFINITIONS.find((definition) => definition.name === "atf_gate");
  const validate = (name: string, value: unknown) => {
    const definition = TOOL_DEFINITIONS.find((entry) => entry.name === name) as NonNullable<ReturnType<typeof TOOL_DEFINITIONS.find>>;
    return validateCanonicalOutput(name, definition.canonical_output, value);
  };

  it("admission 现代形态：gates 变长（缺闸省略）逐闸 evaluated:true 通过", () => {
    expect(admissionDefinition).toBeDefined();
    const outcome = validate("atf_data_admission_request", {
      ok: true,
      run_id: "run-1",
      dataset_id: "ds-x@p1",
      pin: "p1",
      fact_id: "ds-x@p1",
      status: "adjudicated",
      summary_ref: "runs/run-1/l1/ds-x@p1/source-backed-admission-summary.json",
      summary_sha256: "a".repeat(64),
      gates: [
        { gate_id: "extraction-contract-valid", verdict: "pass", reason_codes: [], evaluated: true },
        { gate_id: "split-integrity-valid", verdict: "warn", reason_codes: ["minor"], evaluated: true },
      ],
    });
    expect(outcome.ok).toBe(true);
  });

  it("admission K3 短路形态：status=blocked＋summary_ref/sha256=null＋单闸 evaluated＋g1_short_circuit=true 通过", () => {
    const outcome = validate("atf_data_admission_request", {
      ok: true,
      run_id: "run-1",
      dataset_id: "ds-x@p1",
      pin: "p1",
      fact_id: "ds-x@p1",
      status: "blocked",
      g1_short_circuit: true,
      summary_ref: null,
      summary_sha256: null,
      gates: [{ gate_id: "extraction-contract-valid", verdict: "block", reason_codes: ["extraction_contract_bundle_missing"], evaluated: true }],
      policy: { source: null, digest: null, deviation: null },
      style_cluster_source: null,
      allocation_unit_source: null,
      partition_counts: null,
    });
    expect(outcome.ok).toBe(true);
  });

  it("admission 旧形态守卫：gates 无 evaluated 标记拒绝（新面标记存在必须 true——fail-closed 对齐）", () => {
    const outcome = validate("atf_data_admission_request", {
      ok: true,
      run_id: "run-1",
      dataset_id: "ds-x@p1",
      pin: "p1",
      fact_id: "ds-x@p1",
      status: "adjudicated",
      summary_ref: "runs/run-1/l1/x.json",
      summary_sha256: "a".repeat(64),
      gates: [{ gate_id: "G1", verdict: "pass", reason_codes: [] }],
    });
    expect(outcome.ok).toBe(false); // required evaluated 缺失 → schema_violation
  });

  it("atf_gate summary_format=legacy（K3 历史兼容标记）通过；缺省形态零回归", () => {
    expect(gateDefinition).toBeDefined();
    expect(validate("atf_gate", { ok: true, gate: "G1", status: "pass", summary_format: "legacy" }).ok).toBe(true);
    expect(validate("atf_gate", { ok: true, gate: "G1", status: "blocked", reason_codes: ["x"], reason: "x" }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F5 改动二同步（2026-09-26，投影三同步之一·canonical 白名单）：atf_gate guidance 容
// 结构化三段式对象（类型让渡内核，同 summary_ref 先例）——字符串既有形态零回归。
// ---------------------------------------------------------------------------
describe("F5 白名单同步：atf_gate guidance 容结构化三段式对象", () => {
  const validate = (name: string, value: unknown) => {
    const definition = TOOL_DEFINITIONS.find((entry) => entry.name === name) as NonNullable<ReturnType<typeof TOOL_DEFINITIONS.find>>;
    return validateCanonicalOutput(name, definition.canonical_output, value);
  };

  it("guidance=字符串（v0.7.5b0 K1 形态）通过——零回归", () => {
    expect(validate("atf_gate", { ok: true, gate: "G1", status: "blocked", guidance: "按指引补齐后重试" }).ok).toBe(true);
  });

  it("guidance=结构化对象（F5 改动二：当前流程节点/前序缺失/合法取得路径）通过", () => {
    const outcome = validate("atf_gate", {
      ok: true,
      gate: "extraction-contract-valid",
      status: "blocked",
      reason_codes: ["contract_experiment_gate_required"],
      guidance: {
        current_node: "发布受理（publish_contract）",
        missing: ["实验门产物标记（gate_produced/field_config_sha/setup 报告 ref）"],
        legal_path: "先跑 build_experiment_setup.py 经用户确认，再重试发布",
      },
    });
    expect(outcome.ok).toBe(true);
  });

  it("guidance 缺省形态零回归", () => {
    expect(validate("atf_gate", { ok: true, gate: "G1", status: "pass" }).ok).toBe(true);
  });
});

describe("批㊶-F2 审批标注增补（转派记录——免审清单/高危清单/两线一致性）", () => {
  const contractByName = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
  const workspaceByName = new Map(WORKSPACE_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
  const byName = (name: string) => contractByName.get(name) ?? workspaceByName.get(name);

  it("免审清单逐值 false（任意 params）＋两线（executor/atfAgentTools）全工具面 requiresApprovalFor 逐工具相等", () => {
    // 免审清单（批㊶-F2 改 scratch_exec/label_qc_inspect；fact_scan/workspace_status/preparation_propose 既有 false 确认维持）
    for (const name of ["atf_scratch_exec", "atf_label_qc_inspect", "atf_fact_scan", "atf_workspace_status", "atf_preparation_propose"]) {
      const definition = byName(name);
      expect(definition, name).toBeDefined();
      expect(requiresApprovalFor(definition!, {})).toBe(false);
      expect(requiresApprovalFor(definition!, {任意: "params"})).toBe(false);
    }
    // 两线一致性：甲线消费点（executor import 的 requiresApprovalFor）≡ 丙线消费点
    // （atfAgentTools spikeRequiresApproval）——全工具面（9 契约＋scratch 线 5）逐工具相等，
    // 防未来任一线另立本地判定分叉（沿 methodOverrides 静态防分叉先例）。
    expect(TOOL_DEFINITIONS).toHaveLength(9);
    expect(WORKSPACE_TOOL_DEFINITIONS).toHaveLength(5);
    for (const definition of [...TOOL_DEFINITIONS, ...WORKSPACE_TOOL_DEFINITIONS]) {
      for (const params of [{}, { action: "query" }, { action: "advance" }, {任意: 1}]) {
        expect(spikeRequiresApproval(definition, params)).toBe(requiresApprovalFor(definition, params));
      }
    }
  });

  it("高危清单逐值 true＋atf_gate 谓词三态（advance→true／query→false／缺失→true fail-closed 不回退）", () => {
    for (const name of ["atf_admit_data", "atf_data_admission_request", "atf_style_cluster_execute", "atf_label_qc_resolve", "atf_launch_execute"]) {
      const definition = byName(name);
      expect(definition, name).toBeDefined();
      expect(requiresApprovalFor(definition!, {})).toBe(true);
    }
    const gate = byName("atf_gate");
    expect(gate).toBeDefined();
    expect(requiresApprovalFor(gate!, { action: "advance" })).toBe(true);
    expect(requiresApprovalFor(gate!, { action: "query" })).toBe(false);
    expect(requiresApprovalFor(gate!, {})).toBe(true);
    expect(requiresApprovalFor(gate!, { action: "非法值" })).toBe(true);
  });
});
