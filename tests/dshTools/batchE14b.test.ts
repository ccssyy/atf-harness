/**
 * A-E14b 测试锚——atf_pipeline_stage 增 base_model_path（案 a 配合 K-E14a 语义拆分）。
 *
 * 覆盖（指令件 §二）：
 *   参数面——training_prep 缺参卡前快败（base_model_path_missing，指路 ATF_MODEL_ROOT，
 *   不触审批面板）；传家族名（非绝对路径）harness 层 fail-closed（不等内核 exit 2）；
 *   其它段忽略该参（缺参不报错、给参不下传）。
 *   argv 断言——`--base-model` 只在 training_prep 出现（mock 回显夹具）。
 *   base_model_source 对账——显式值优先（explicit）；对端摘要携带 source 时透传
 *   （kernel_rehydrated 词汇，纯函数直测）。
 *   既有八段用例零回归——PIPELINE_STAGES 闭集与 atfTools.test.ts 既有链不受影响。
 * 真实环境验收（真内核 training_prep exit 0＋负例）随批执行报告，不入本锚。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPipelineTool, PIPELINE_STAGES, baseModelPathGuidance, baseModelSourceOf } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

interface DshToolLike {
  name: string;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}
const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "e14b-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeExec = { agent: undefined, callId: "e14b-call", signal: undefined };
const approvalCtx = (record: string[]): { get(service: string): unknown } => ({
  get: (service: string) => (service === "approval" ? { request: async (req: { reason: string }) => { record.push(req.reason); return "allowed-once"; } } : undefined),
});
const toolOf = (ctx: { get(service: string): unknown }): DshToolLike =>
  ({ name: "atf_pipeline_stage", execute: (buildPipelineTool(ctx, `node ${join(import.meta.url.replace("file://", ""), "..", "..", "..", "tests", "fixtures", "mock_pipeline_argv.mjs")}`, 30_000) as unknown as DshToolLike).execute });

describe("A-E14b——training_prep base_model_path 参数面（卡前快败）", () => {
  it("缺参 → base_model_path_missing 指路 ATF_MODEL_ROOT＋清单；审批零触达", async () => {
    const approvals: string[] = [];
    const result = (await toolOf(approvalCtx(approvals)).execute(
      { stage: "training_prep", run_id: "e14b-a", workspace_path: tempRoot() },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("base_model_path_missing");
    expect(String(result["note"])).toContain("ATF_MODEL_ROOT");
    expect(String(result["note"])).toContain("不可当路径用");
    expect(approvals).toHaveLength(0); // 不触审批面板
  });
  it("传家族名（qwen3_vl）→ harness 层 base_model_path_not_absolute；审批零触达", async () => {
    const approvals: string[] = [];
    const result = (await toolOf(approvalCtx(approvals)).execute(
      { stage: "training_prep", run_id: "e14b-b", workspace_path: tempRoot(), base_model_path: "qwen3_vl" },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("base_model_path_not_absolute");
    expect(String(result["note"])).toContain("不可当路径用");
    expect(approvals).toHaveLength(0);
  });
  it("指路文案：ATF_MODEL_ROOT 在位时附真实清单（scanLocalModels 单源）；缺时只指路 env", () => {
    const root = tempRoot();
    mkdirSync(join(root, "Qwen3-VL-32B-Instruct"), { recursive: true });
    const withRoot = baseModelPathGuidance({ ATF_MODEL_ROOT: root });
    expect(withRoot).toContain("Qwen3-VL-32B-Instruct");
    expect(withRoot).toContain("ATF_MODEL_ROOT");
    const withoutRoot = baseModelPathGuidance({});
    expect(withoutRoot).toContain("ATF_MODEL_ROOT");
    expect(withoutRoot).not.toContain("前三");
  });
});

describe("A-E14b——argv 断言与其它段忽略", () => {
  it("training_prep 显式传值 → argv 追加 --base-model <绝对路径>；段成功 exit 0", async () => {
    const modelDir = join(tempRoot(), "Qwen3-VL-32B-Instruct");
    mkdirSync(modelDir, { recursive: true });
    const approvals: string[] = [];
    const result = (await toolOf(approvalCtx(approvals)).execute(
      { stage: "training_prep", run_id: "e14b-c", workspace_path: tempRoot(), base_model_path: modelDir },
      fakeExec,
    )) as Record<string, unknown>;
    expect(approvals).toHaveLength(1); // 显式值先进审批
    expect(result["ok"]).toBe(true);
    expect(result["exit_code"]).toBe(0);
    expect(result["base_model_source"]).toBe("explicit"); // 显式值优先——对账值 explicit
    const argv = (result as { summary?: { argv?: string[] } }).summary?.argv ?? [];
    expect(argv).toContain("--base-model");
    expect(argv.indexOf("--base-model")).toBeGreaterThanOrEqual(0);
    expect(argv[argv.indexOf("--base-model") + 1]).toBe(modelDir);
  });
  it("其它段忽略该参：缺参不报错；给参也不下传（argv 无 --base-model）", async () => {
    const approvals: string[] = [];
    const missing = (await toolOf(approvalCtx(approvals)).execute(
      { stage: "label_qc", run_id: "e14b-d", workspace_path: tempRoot() },
      fakeExec,
    )) as Record<string, unknown>;
    expect(missing["ok"]).toBe(true); // 缺参不报错——training_prep 之外的段不消费
    expect(missing["base_model_source"]).toBeUndefined();
    const given = (await toolOf(approvalCtx(approvals)).execute(
      { stage: "label_qc", run_id: "e14b-e", workspace_path: tempRoot(), base_model_path: "/tmp/ignored" },
      fakeExec,
    )) as Record<string, unknown>;
    expect(given["ok"]).toBe(true);
    const argv = (given as { summary?: { argv?: string[] } }).summary?.argv ?? [];
    expect(argv).not.toContain("--base-model"); // 给参也不下传——argv 仅 training_prep 追加
    expect(given["base_model_source"]).toBeUndefined();
  });
  it("八段闭集零变化（A2.2b 落点单源不回退）", () => {
    expect(PIPELINE_STAGES).toEqual(["register", "label_qc", "experiment_setup", "candidate_build", "publish", "family_split", "admission", "training_prep"]);
  });
});

describe("A-E14b——base_model_source 对账值（纯函数）", () => {
  it("显式优先；对端摘要携带 source 透传（kernel_rehydrated 词汇）；缺省 undefined", () => {
    expect(baseModelSourceOf(true, { base_model_source: "kernel_rehydrated" })).toBe("explicit"); // 显式值优先
    expect(baseModelSourceOf(true, null)).toBe("explicit");
    expect(baseModelSourceOf(false, { base_model_source: "kernel_rehydrated" })).toBe("kernel_rehydrated"); // 对端回流
    expect(baseModelSourceOf(false, { base_model_source: "explicit" })).toBe("explicit");
    expect(baseModelSourceOf(false, {})).toBeUndefined();
    expect(baseModelSourceOf(false, null)).toBeUndefined();
    expect(baseModelSourceOf(false, { base_model_source: "bogus" })).toBeUndefined(); // 闭集外不透传
  });
});
