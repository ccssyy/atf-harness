/**
 * D82 harness 侧测试锚——pl 绑定清除（指令《ATF_指令_D82_pl绑定清除_20261023》
 * sha ad7d61c72c86 §一.3/§一.6；逐点口径＝审计件《ATF_审计_产品预设单据类型与字段配置
 * _20261023》§二 harness 条目）。内核侧默认值清除与资产删除属内核会话窗口，不入本锚。
 *
 * §一.3 透传覆盖：
 *   doc_type/lane_suffix/field_config 三件——显式给 → argv 含对应旗标；不给/空串 →
 *   argv 不含（缺省不上送）；与既有段特定追加逻辑并存零回归（register --source-root／
 *   training_prep --base-model／family_split --auto-style-cluster＋开关）；参数 schema
 *   三件在位；工具描述含「不传 doc_type 内核按数据/登记面推断，无法确定即 blocked」句。
 * §一.6 中性化锚覆盖（文件级 grep，文案级零行为变更）：
 *   三文件源码无「装箱单」残留；client.js 新 placeholder 在位（data-joint-doczh「单据
 *   中文名」／data-joint-doctype 无 pl 举例）；倍率示例无 {"pl":1,"swb":2}；
 *   导入示例 JSON document_zh＝中性「单据A」；trainingFace doc_type 描述保中性缺省语义。
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPipelineTool } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

interface DshToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}
const tempRoots: string[] = [];
const envPinned: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "d82-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of envPinned.splice(0)) delete process.env[key];
});

const fakeExec = { agent: undefined, callId: "d82-call", signal: undefined };
const approvalCtx = (record: string[]): { get(service: string): unknown } => ({
  get: (service: string) => (service === "approval" ? { request: async () => { record.push("ok"); return "allowed-once"; } } : undefined),
});
const ARGV_MOCK = join(import.meta.dirname, "..", "fixtures", "mock_pipeline_argv.mjs");
const CLUSTER_MOCK = join(import.meta.dirname, "..", "fixtures", "mock_pipeline_style_cluster.mjs");
const toolOf = (mock: string): DshToolLike =>
  buildPipelineTool(approvalCtx([]), `node ${mock}`, 30_000) as unknown as DshToolLike;

const summaryArgv = (result: unknown): string[] =>
  ((result as { summary?: { argv?: string[] } }).summary?.argv ?? []);

describe("D82 §一.3——atf_pipeline_stage 单据类型三件透传", () => {
  it("显式给三件 → argv 含 --doc-type／--lane-suffix／--field-config（label_qc 段）", async () => {
    const result = await toolOf(ARGV_MOCK).execute(
      {
        stage: "label_qc",
        run_id: "d82-given",
        workspace_path: tempRoot(),
        doc_type: "bill_of_lading",
        lane_suffix: "goods",
        field_config: "/tmp/d82-field-config.json",
      },
      fakeExec,
    );
    expect((result as Record<string, unknown>)["ok"]).toBe(true);
    const argv = summaryArgv(result);
    expect(argv[argv.indexOf("--doc-type") + 1]).toBe("bill_of_lading");
    expect(argv[argv.indexOf("--lane-suffix") + 1]).toBe("goods");
    expect(argv[argv.indexOf("--field-config") + 1]).toBe("/tmp/d82-field-config.json");
  });
  it("不给三件 → argv 不含三旗标（缺省不上送——内核自行推断，推断不出即 blocked）", async () => {
    const result = await toolOf(ARGV_MOCK).execute(
      { stage: "label_qc", run_id: "d82-omit", workspace_path: tempRoot() },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv).not.toContain("--doc-type");
    expect(argv).not.toContain("--lane-suffix");
    expect(argv).not.toContain("--field-config");
  });
  it("给空串/纯空白 → 同缺省不上送（trim 非空才追加）", async () => {
    const result = await toolOf(ARGV_MOCK).execute(
      { stage: "label_qc", run_id: "d82-blank", workspace_path: tempRoot(), doc_type: "  ", lane_suffix: "", field_config: "\t" },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv).not.toContain("--doc-type");
    expect(argv).not.toContain("--lane-suffix");
    expect(argv).not.toContain("--field-config");
  });
  it("并存零回归·register：--source-root 与三件同 argv（既有段特定追加逻辑零触碰）", async () => {
    const root = tempRoot();
    const result = await toolOf(ARGV_MOCK).execute(
      {
        stage: "register",
        run_id: "d82-reg",
        workspace_path: root,
        source_root: join(root, "src-docs"),
        doc_type: "bill_of_lading",
        lane_suffix: "goods",
        field_config: "/tmp/d82-field-config.json",
      },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv[argv.indexOf("--source-root") + 1]).toBe(join(root, "src-docs"));
    expect(argv).toContain("--doc-type");
    expect(argv).toContain("--lane-suffix");
    expect(argv).toContain("--field-config");
  });
  it("并存零回归·training_prep：--base-model 与 --doc-type 同 argv", async () => {
    const result = await toolOf(ARGV_MOCK).execute(
      {
        stage: "training_prep",
        run_id: "d82-tp",
        workspace_path: tempRoot(),
        base_model_path: join(tempRoot(), "model-dir"),
        doc_type: "bill_of_lading",
      },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv).toContain("--base-model");
    expect(argv[argv.indexOf("--doc-type") + 1]).toBe("bill_of_lading");
  });
  it("并存零回归·family_split：缺省 auto 显式上线与三件同 argv（E10b 语义不变）", async () => {
    process.env["MOCK_CLUSTER_STATE"] = "already_clustered";
    envPinned.push("MOCK_CLUSTER_STATE");
    const result = await toolOf(CLUSTER_MOCK).execute(
      {
        stage: "family_split",
        run_id: "d82-fs",
        workspace_path: tempRoot(),
        doc_type: "bill_of_lading",
        lane_suffix: "goods",
        field_config: "/tmp/d82-field-config.json",
      },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv[argv.indexOf("--auto-style-cluster") + 1]).toBe("auto");
    expect(argv).toContain("--doc-type");
    expect(argv).toContain("--lane-suffix");
    expect(argv).toContain("--field-config");
  });
  it("参数 schema：三件 string 可缺省在位；工具描述含「推断/blocked」指路句", () => {
    const tool = toolOf(ARGV_MOCK);
    const props = (tool.parameters as { properties?: Record<string, { type?: string }> }).properties ?? {};
    for (const key of ["doc_type", "lane_suffix", "field_config"]) {
      expect(props[key]?.type).toBe("string");
    }
    expect(tool.description).toContain("不传 doc_type 时内核按数据/登记面推断");
    expect(tool.description).toContain("无法确定即 blocked");
  });
});

describe("D82 §一.6——非行为面中性化锚（文件级 grep，审计件 §二 harness 条目）", () => {
  const clientSource = (): string => readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
  const pipelineSource = (): string => readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-tools/src/pipelineFace.ts"), "utf8");
  const trainingSource = (): string => readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-tools/src/trainingFace.ts"), "utf8");

  it("三文件源码无「装箱单」残留（历史定案说明类同口径清零）", () => {
    expect(clientSource()).not.toContain("装箱单");
    expect(pipelineSource()).not.toContain("装箱单");
    expect(trainingSource()).not.toContain("装箱单");
  });
  it("E8 后字段编辑面退役：doczh/doctype 锚清零（中性化语义随面退役成立——举例词零回归）", () => {
    const source = clientSource();
    expect(source).not.toContain("data-joint-doczh");
    expect(source).not.toContain("data-joint-doctype");
    expect(source).not.toContain("（如 装箱单）");
    expect(source).not.toContain("（如 pl）");
  });
  it("E8 后倍率/导入示例零残留（导入面退役——字段规格槽位登记不由卡面收集）", () => {
    const source = clientSource();
    expect(source).not.toContain('{"pl":1,"swb":2}');
    expect(source).not.toContain("data-joint-import");
    expect(source).not.toContain("reader.readAsText");
    expect(source).not.toContain("field_specs: fieldSpecs");
  });
  it("client.js :2795 胶囊注释去 pl 举例、保留「取 title 首段短名」语义", () => {
    const source = clientSource();
    expect(source).toContain("「继续训练：<单据短名> N类」");
    expect(source).toContain("title 首段短名，防止超长");
  });
  it("trainingFace doc_type 描述去「如 装箱单」、保留中性缺省「单据」语义", () => {
    expect(trainingSource()).toContain('单据类型名（缺省沿脚本中性缺省「单据」）');
  });
});
