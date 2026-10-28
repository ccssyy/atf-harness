/**
 * F1.1-3 锚：iteration-config 记了 dataset.digest_provenance.template_sha256 时，对实际
 * field_config 的 template 实算 sha256 比对——不一致 fail-closed（eval_template_drift）；
 * 显式传 field_config 且带 accept_template_drift 才放行并标 template_drift_accepted；
 * 老 run 无该键不比对（template_sha256_source=absent，零回归）。
 *
 * 摘要口径独立复算（不调被测函数）：内核 json.dumps(ensure_ascii=False, sort_keys=True,
 * separators=(",", ":")) ＋ "\n" 的 utf-8 sha256。
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEvalFieldConfig } from "../../packages/extensions/atf-tools/src/trainingFace.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const TEMPLATE = { schema: "PromptTemplate/v1", fields: [{ field_id: "a" }, { field_id: "b" }] };
const TEMPLATE_CANONICAL = '{"fields":[{"field_id":"a"},{"field_id":"b"}],"schema":"PromptTemplate/v1"}';
const sha256Of = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** 造 run：field-config（含 template）＋iteration-config（可选 template 记录）。 */
const seedRun = (opts: { templateSha?: string | null; recordFieldConfigSha?: boolean }): { runDir: string; fieldConfig: string } => {
  const runDir = mkdtempSync(join(tmpdir(), "f11-template-"));
  roots.push(runDir);
  mkdirSync(join(runDir, "experiment-setup"), { recursive: true });
  mkdirSync(join(runDir, "prep"), { recursive: true });
  const fieldConfig = join(runDir, "experiment-setup", "field-config.json");
  writeFileSync(fieldConfig, `${JSON.stringify({ fields: [], template: TEMPLATE }, null, 1)}\n`, "utf8");
  const prov: Record<string, string> = {};
  if (opts.templateSha !== undefined && opts.templateSha !== null) prov["template_sha256"] = opts.templateSha;
  if (opts.recordFieldConfigSha !== false) prov["field_config_sha256"] = sha256Of(readFileSync(fieldConfig, "utf8"));
  writeFileSync(join(runDir, "prep", "iteration-config.json"), JSON.stringify({ dataset: { digest_provenance: prov } }, null, 1), "utf8");
  return { runDir, fieldConfig };
};

describe("F1.1 模板指纹漂移：fail-closed 与显式放行", () => {
  it("一致（内核口径 sha256 实算对得上）→ 通过并标 verified", () => {
    const { runDir } = seedRun({ templateSha: sha256Of(`${TEMPLATE_CANONICAL}\n`) });
    const resolved = resolveEvalFieldConfig(runDir);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.template_sha256_source).toBe("verified");
    expect(resolved.template_drift_accepted).toBeUndefined();
  });

  it("不一致且未显式传 field_config → eval_template_drift（fail-closed）", () => {
    const { runDir } = seedRun({ templateSha: sha256Of("another template\n") });
    const resolved = resolveEvalFieldConfig(runDir);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe("eval_template_drift");
    expect(resolved.note).toContain("模板骨架");
    expect(resolved.note).not.toContain(runDir); // 不吐内部路径
  });

  it("不一致＋显式传 field_config 但无开关 → 仍 eval_template_drift", () => {
    const { runDir, fieldConfig } = seedRun({ templateSha: sha256Of("another template\n") });
    const resolved = resolveEvalFieldConfig(runDir, fieldConfig);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe("eval_template_drift");
    expect(resolved.note).toContain("accept_template_drift");
  });

  it("不一致＋显式传＋acceptTemplateDrift → 放行并标 template_drift_accepted", () => {
    const { runDir, fieldConfig } = seedRun({ templateSha: sha256Of("another template\n") });
    const resolved = resolveEvalFieldConfig(runDir, fieldConfig, undefined, { acceptTemplateDrift: true });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.template_sha256_source).toBe("drift_accepted");
    expect(resolved.template_drift_accepted).toBe(true);
  });

  it("老 run 无 template_sha256 键 → 不比对、不报错，标 absent（零回归）", () => {
    const { runDir } = seedRun({ templateSha: null });
    const resolved = resolveEvalFieldConfig(runDir);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.template_sha256_source).toBe("absent");
  });

  it("记录有指纹但文件无 template 键 → 视为不同源（fail-closed）", () => {
    const runDir = mkdtempSync(join(tmpdir(), "f11-template-notpl-"));
    roots.push(runDir);
    mkdirSync(join(runDir, "experiment-setup"), { recursive: true });
    mkdirSync(join(runDir, "prep"), { recursive: true });
    const fieldConfig = join(runDir, "experiment-setup", "field-config.json");
    writeFileSync(fieldConfig, JSON.stringify({ fields: [] }), "utf8");
    writeFileSync(join(runDir, "prep", "iteration-config.json"), JSON.stringify({
      dataset: { digest_provenance: { template_sha256: sha256Of("x\n"), field_config_sha256: sha256Of(readFileSync(fieldConfig, "utf8")) } },
    }), "utf8");
    const resolved = resolveEvalFieldConfig(runDir);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe("eval_template_drift");
  });
});
