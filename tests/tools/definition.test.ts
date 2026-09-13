import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkSchema, validateCanonicalOutput, type SchemaNode } from "../../src/tools/canonical.js";
import { ToolRegistry, toModelVisible } from "../../src/tools/index.js";
import { TOOL_DEFINITIONS } from "../../src/tools/toolDefinition.js";
import { approvalParamsDigest, stableStringify } from "../../src/tools/approvalKey.js";

/**
 * S3 验收（schema 用例）——ToolDefinition 序列化后不含 timeout 等内部字段；
 * canonical 校验器方言与审批键 digest 算法（与 mock 对端同构）单测。
 */

describe("S3 验收（schema 用例）——模型可见白名单，内部字段一律不发", () => {
  it("4 个工具的模型可见投影仅含 { name, description, parameters }", () => {
    const registry = ToolRegistry.createDefault();
    const visible = registry.modelVisible();
    expect(visible.map((tool) => tool.name)).toEqual([
      "atf_admit_data",
      "atf_gate",
      "atf_fact_scan",
      "atf_workspace_status",
    ]);
    for (const tool of visible) {
      expect(Object.keys(tool).sort()).toEqual(["description", "name", "parameters"]);
    }
  });

  it("序列化产物不含内部字段（timeout / canonical_output / requires_approval / method 等）", () => {
    const serialized = JSON.stringify(ToolRegistry.createDefault().modelVisible());
    for (const forbidden of ["timeout", "canonical_output", "requires_approval", "method", "connection", "execute", "ledger"]) {
      expect(serialized, `模型可见形态不得包含 "${forbidden}"`).not.toContain(forbidden);
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
