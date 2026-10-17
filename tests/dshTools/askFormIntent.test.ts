/**
 * A1 回归断言——form intent 入参经 UserQuestionService 校验不抛。
 *
 * 背景：vendor user-questions 的 ask() 入口对带 intent 的问题做校验；上游 pristine
 * 形态对 form 意图按通用分支要求「approve label ∈ options」，表单卡必抛
 * BAD_INTENT（"approve label undefined names none of its options"——2026-10-17
 * dev 现场 3 连败同文，真实环境复现存档于 docs/_owner 取证目录）。
 * 本断言用真实调用面构造器（confirmFace.formAskQuestion／configFormFieldsOf——
 * confirmFace 与 trainingFace 双调用面的单源）驱动 vendor 校验：vendor 源码回退
 * （patch 未重放）或构建产物错位（lib 未随重建）任一复发，本文件即红——
 * vendor/dsh/LOCK.md「锁 commit＋patch 已应用」修改态的回归钉。
 *
 * 校验通过的判据＝ask() 越过入参校验抵达应答瀑布（裸根 ctx 无应答者→NO_PROVIDER，
 * 而非 BAD_INTENT）；负锚同法反证 BAD_INTENT 语义在位（不放宽）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAskFailureDiagnostic, ASK_DIAGNOSTICS_RELPATH } from "../../packages/extensions/atf-tools/src/askDiagnostics.js";
import { configFormFieldsOf, domainHintOf, formAskQuestion } from "../../packages/extensions/atf-tools/src/confirmFace.js";
import type { ConfigConfirmField } from "../../packages/extensions/atf-tools/src/confirmFace.js";

const vendorRoot = join(import.meta.dirname, "../../vendor/dsh/deepseek-harness");

/** 形态面（any 装载——变量路径动态导入：tsc 免 untyped-js 报错；vitest 运行时解析
 *  经 vitest.config alias 链解其裸导入）。 */
interface VendorUserQuestions {
  default: new (ctx: unknown) => { ask(request: { questions: ReadonlyArray<unknown> }): Promise<unknown> };
}

const loadVendorUserQuestions = async (): Promise<VendorUserQuestions> =>
  (await import(join(vendorRoot, "packages/interaction/user-questions/lib/index.js"))) as VendorUserQuestions;

/** 裸根 cordis Context（真实构造面——Service 接线需 reflect/registry/events；
 *  无任何 user-questions 应答者：校验通过即 NO_PROVIDER，校验不过即 BAD_INTENT）。 */
const makeService = async () => {
  const cordis = (await import(join(vendorRoot, "vendor/cordis/lib/index.js"))) as { Context: new () => unknown };
  const { default: UserQuestionService } = await loadVendorUserQuestions();
  return new UserQuestionService(new cordis.Context());
};

/** 确认卡十五键采样（键集与真机表单一致；tag 三态在位）。 */
const SAMPLE_FIELDS: ConfigConfirmField[] = [
  { key: "learning_rate", value: "1e-4", tag: "need_confirm" },
  { key: "nproc_per_node", value: "8", tag: "from_registry" },
  { key: "base_model_path", value: "/data/LLM_model/Qwen3-VL-32B-Instruct", tag: "from_registry" },
  { key: "num_train_epochs", value: "3", tag: "default_used" },
  { key: "per_device_train_batch_size", value: "1", tag: "default_used" },
  { key: "gradient_accumulation_steps", value: "16", tag: "from_registry" },
  { key: "cutoff_len", value: "9000", tag: "default_used" },
  { key: "deepspeed", value: "ds_z3_offload_config.json", tag: "from_registry" },
  { key: "lora_rank", value: "32", tag: "default_used" },
  { key: "lora_alpha", value: "64", tag: "default_used" },
  { key: "dataset_keys", value: "（由登记面推导）", tag: "default_used" },
  { key: "max_total_tokens", value: "", tag: "default_used" },
  { key: "image_min_pixels", value: "65536", tag: "default_used" },
  { key: "image_max_pixels", value: "802816", tag: "default_used" },
  { key: "negative_ratio_target", value: "0.02,0.05", tag: "default_used" },
];

describe("A1——form intent 入参经 UserQuestionService 校验不抛", () => {
  it("vendor 形态锚：源码与构建产物均含 form 校验分支（patch 已应用＋重建态）", () => {
    expect(existsSync(join(vendorRoot, "packages/client/ui-user-questions/src/client/FormPanel.tsx"))).toBe(true);
    const src = readFileSync(join(vendorRoot, "packages/interaction/user-questions/src/index.ts"), "utf8");
    expect(src).toContain("kind === 'form'");
    expect(src).toContain("fields are empty or malformed");
    const lib = readFileSync(join(vendorRoot, "packages/interaction/user-questions/lib/index.js"), "utf8");
    expect(lib).toContain("fields are empty or malformed");
  });

  it("确认卡表单问题（十五键·configFormFieldsOf 单源）越过校验抵达应答瀑布（NO_PROVIDER≠BAD_INTENT）", async () => {
    const svc = await makeService();
    await expect(svc.ask({
      questions: [formAskQuestion({
        id: "config-confirm-r1",
        question: "九要素训练配置确认 — r1",
        header: "训练配置",
        detail: "改参：在输入框改值后提交",
        fields: configFormFieldsOf(SAMPLE_FIELDS, 8),
        submitLabel: "确认并继续",
      })],
    })).rejects.toThrow("no user-questions answerer accepted the request");
  });

  it("双启请示表单问题（单键 proceed 形态·trainingFace 同构）同样越过校验", async () => {
    const svc = await makeService();
    await expect(svc.ask({
      questions: [formAskQuestion({
        id: "double-launch-r1",
        question: "训练会话已存在（run r1）——是否清理旧会话并重启？",
        header: "双启确认",
        detail: "同 run_id 的训练会话已在场。proceed 填 yes 才重启；留空/no/其他＝取消。",
        fields: [{ key: "proceed", label: "proceed（是否清理重启）", value: "no", hint: "仅接受 yes；no/留空＝取消本次启动" }],
        submitLabel: "提交",
      })],
    })).rejects.toThrow("no user-questions answerer accepted the request");
  });

  it("负锚：畸形 form fields（空数组）仍被 vendor 校验拒绝——BAD_INTENT 语义在位不放宽", async () => {
    const svc = await makeService();
    await expect(svc.ask({
      questions: [{ id: "bad", question: "x", intent: { kind: "form", fields: [], submitLabel: "s" } }],
    })).rejects.toThrow("fields are empty or malformed");
  });

  it("configFormFieldsOf：max_total_tokens 空值＝required＋placeholder（必填拦空兜底单源）", () => {
    const rows = configFormFieldsOf(SAMPLE_FIELDS, 8);
    const tokenRow = rows.find((row) => row.key === "max_total_tokens");
    expect(tokenRow?.required).toBe(true);
    expect(tokenRow?.placeholder).toContain("必填");
    const hintRow = rows.find((row) => row.key === "learning_rate");
    expect(hintRow?.hint).toBe(domainHintOf("learning_rate", 8));
  });
});

describe("A1 伴生缺陷收口——卡通道失败诊断落盘", () => {
  it("ask 失败写 diagnostics/user-questions.log（JSONL：at/tool/question/error）且返回相对路径", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-diag-"));
    try {
      const rel = appendAskFailureDiagnostic(root, "atf_config_confirm", "config-confirm-r1", Object.assign(new Error("boom"), { code: "BAD_INTENT" }));
      expect(rel).toBe(ASK_DIAGNOSTICS_RELPATH);
      const line = JSON.parse(readFileSync(join(root, rel), "utf8").trim()) as Record<string, string>;
      expect(line.tool).toBe("atf_config_confirm");
      expect(line.question).toBe("config-confirm-r1");
      expect(line.code).toBe("BAD_INTENT");
      expect(line.error).toContain("boom");
      expect(typeof line.at).toBe("string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fail-open：诊断写失败（目录不可写）不抛、仍返回相对路径", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-diag-ro-"));
    try {
      const blocker = join(root, "diagnostics");
      writeFileSync(blocker, "not a directory\n", "utf8");
      chmodSync(blocker, 0o444);
      const rel = appendAskFailureDiagnostic(root, "atf_run_training", "double-launch-r1", new Error("x"));
      expect(rel).toBe(ASK_DIAGNOSTICS_RELPATH);
    } finally {
      try { chmodSync(join(root, "diagnostics"), 0o644); } catch { /* 已只读则由 rmSync force 兜底 */ }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
