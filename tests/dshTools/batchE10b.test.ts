/**
 * E10b 测试锚——atf_pipeline_stage 增 auto_style_cluster（family_split 段版式聚类
 * 三态透传，内核 main E10a 命令面；指令件 §二）。
 *
 * 覆盖：
 *   参数面——缺省 auto／三值枚举逐值透传／非法值框架层拒（ToolArgsError，审批零触达）；
 *   argv 断言——`--auto-style-cluster` 仅 family_split 出现（缺省也显式上线解析值；
 *   其它段给参不下传不报错）；
 *   拒绝回流——style_cluster_state_not_clustered／style_cluster_state_ambiguous 两码
 *   可识别且带「先问用户」指引；off 在未聚类目录保持内核既有 split_recompute_cluster_required
 *   阻断（语义不变，无聚类问询 note）；
 *   证据透传——summary 携带 results[].raw_response.style_cluster_state 时回传
 *   {state,pages_total,pages_with_cluster} 三键（不携带/形态非法＝undefined 不造默认）；
 *   八段闭集零回归（PIPELINE_STAGES 既有闭集不回退）。
 * 真实环境验收（真内核 main E10a × 未聚类证据三跳）随批执行报告，不入本锚。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPipelineTool,
  PIPELINE_STAGES,
  AUTO_STYLE_CLUSTER_VALUES,
  styleClusterStateOf,
  styleClusterRejectionOf,
  STYLE_CLUSTER_REJECTION_NOTE,
} from "../../packages/extensions/atf-tools/src/pipelineFace.js";

interface DshToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}
const tempRoots: string[] = [];
const envPinned: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "e10b-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of envPinned.splice(0)) delete process.env[key];
});

const fakeExec = { agent: undefined, callId: "e10b-call", signal: undefined };
const approvalCtx = (record: string[]): { get(service: string): unknown } => ({
  get: (service: string) => (service === "approval" ? { request: async (req: { reason: string }) => { record.push(req.reason); return "allowed-once"; } } : undefined),
});
const MOCK = join(import.meta.url.replace("file://", ""), "..", "..", "fixtures", "mock_pipeline_style_cluster.mjs");
const toolOf = (ctx: { get(service: string): unknown }, env: Record<string, string> = {}): DshToolLike => {
  const tool = buildPipelineTool(ctx, `node ${MOCK}`, 30_000) as unknown as DshToolLike;
  // env 注入经命令行前缀不可行（execFile 无 shell），mock 态经 process.env 传递（afterEach 还原）
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
    envPinned.push(key);
  }
  return tool;
};

const summaryArgv = (result: unknown): string[] =>
  ((result as { summary?: { argv?: string[] } }).summary?.argv ?? []);
const summaryOf = (result: unknown): Record<string, unknown> =>
  ((result as { summary?: Record<string, unknown> }).summary ?? {});

describe("E10b——参数面（缺省 auto／三值枚举／非法值拒）", () => {
  it("缺省 → auto 显式上线：argv 含 --auto-style-cluster auto；参数 schema enum 闭集在位", async () => {
    const approvals: string[] = [];
    const tool = toolOf(approvalCtx(approvals), { MOCK_CLUSTER_STATE: "already_clustered" });
    const result = await tool.execute(
      { stage: "family_split", run_id: "e10b-a", workspace_path: tempRoot() },
      fakeExec,
    );
    expect(summaryArgv(result)).toEqual(["--workspace", expect.any(String), "--run-id", "e10b-a", "--stage", "family_split", "--auto-style-cluster", "auto"]);
    const schema = tool.parameters as { properties?: Record<string, { enum?: string[] }> };
    expect(schema.properties?.["auto_style_cluster"]?.enum).toEqual(["auto", "on", "off"]);
    expect(AUTO_STYLE_CLUSTER_VALUES).toEqual(["auto", "on", "off"]);
    expect(approvals).toHaveLength(1); // 审批先行
  });
  it("三值枚举逐值透传：on/off/auto 原样上线", async () => {
    for (const value of AUTO_STYLE_CLUSTER_VALUES) {
      const approvals: string[] = [];
      const result = await toolOf(approvalCtx(approvals), { MOCK_CLUSTER_STATE: "already_clustered" }).execute(
        { stage: "family_split", run_id: `e10b-${value}`, workspace_path: tempRoot(), auto_style_cluster: value },
        fakeExec,
      );
      const argv = summaryArgv(result);
      expect(argv[argv.indexOf("--auto-style-cluster") + 1]).toBe(value);
    }
  });
  it("非法值 → 框架参数校验层拒（ToolArgsError，审批零触达）", async () => {
    const approvals: string[] = [];
    await expect(
      toolOf(approvalCtx(approvals)).execute(
        { stage: "family_split", run_id: "e10b-bad", workspace_path: tempRoot(), auto_style_cluster: "maybe" },
        fakeExec,
      ),
    ).rejects.toThrow(/auto_style_cluster/);
    expect(approvals).toHaveLength(0); // 坏参数不消耗放行
  });
});

describe("E10b——argv 仅 family_split 出现（其它段忽略不报错不下传）", () => {
  it("label_qc 给参 → argv 无 --auto-style-cluster 且 ok；缺参同样不报错", async () => {
    const approvals: string[] = [];
    const given = await toolOf(approvalCtx(approvals)).execute(
      { stage: "label_qc", run_id: "e10b-lq1", workspace_path: tempRoot(), auto_style_cluster: "on" },
      fakeExec,
    );
    expect((given as Record<string, unknown>)["ok"]).toBe(true);
    expect(summaryArgv(given)).not.toContain("--auto-style-cluster");
    const missing = await toolOf(approvalCtx(approvals)).execute(
      { stage: "label_qc", run_id: "e10b-lq2", workspace_path: tempRoot() },
      fakeExec,
    );
    expect((missing as Record<string, unknown>)["ok"]).toBe(true);
    expect(summaryArgv(missing)).not.toContain("--auto-style-cluster");
  });
  it("八段闭集零回归（A2.2b 落点单源不回退；本批零增删改序）", () => {
    expect(PIPELINE_STAGES).toEqual(["register", "label_qc", "experiment_setup", "candidate_build", "publish", "family_split", "admission", "training_prep"]);
  });
});

describe("E10b——两条聚类拒绝码的回流指引（先问用户，禁止自行猜值）", () => {
  it("auto × 未聚类 → exit 2 style_cluster_state_not_clustered；note 含「先问用户」与 on 指路；证据三键透传；零写入", async () => {
    const approvals: string[] = [];
    const result = (await toolOf(approvalCtx(approvals), { MOCK_CLUSTER_STATE: "not_clustered" }).execute(
      { stage: "family_split", run_id: "e10b-nc", workspace_path: tempRoot() },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["exit_code"]).toBe(2);
    expect(result["segment_fact_recorded"]).toBe(false);
    const note = String(result["note"]);
    expect(note).toContain("这批数据做过版式聚类吗");
    expect(note).toContain("on");
    expect(note).toContain("禁止不问用户自行猜值重跑");
    expect(result["style_cluster_state"]).toEqual({ state: "not_clustered", pages_total: 6, pages_with_cluster: 0 });
    expect(approvals).toHaveLength(1);
  });
  it("auto × 状态不明 → exit 2 style_cluster_state_ambiguous；note 含「先问用户」与 on/off 二选一指路", async () => {
    const result = (await toolOf(approvalCtx([]), { MOCK_CLUSTER_STATE: "ambiguous" }).execute(
      { stage: "family_split", run_id: "e10b-am", workspace_path: tempRoot() },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["exit_code"]).toBe(2);
    const note = String(result["note"]);
    expect(note).toContain("这批数据做过版式聚类吗");
    expect(note).toContain("\"on\"");
    expect(note).toContain("\"off\"");
    expect(result["style_cluster_state"]).toEqual({ state: "ambiguous", pages_total: 6, pages_with_cluster: 3 });
  });
  it("负例：off × 未聚类 → 保持内核既有 split_recompute_cluster_required 阻断（无聚类问询 note）", async () => {
    const result = (await toolOf(approvalCtx([]), { MOCK_CLUSTER_STATE: "not_clustered" }).execute(
      { stage: "family_split", run_id: "e10b-off", workspace_path: tempRoot(), auto_style_cluster: "off" },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["exit_code"]).toBe(2);
    expect(JSON.stringify(result["rejections"])).toContain("split_recompute_cluster_required");
    expect(result["note"]).toBeUndefined(); // 既有闸语义——不加聚类问询
  });
});

describe("E10b——证据透传与 description 三态指引", () => {
  it("auto × 已聚类 → exit 0 不复聚；证据三键透传（state=already_clustered＝「为什么没开」的解释面）", async () => {
    const result = (await toolOf(approvalCtx([]), { MOCK_CLUSTER_STATE: "already_clustered" }).execute(
      { stage: "family_split", run_id: "e10b-ac", workspace_path: tempRoot() },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["exit_code"]).toBe(0);
    expect(result["segment_fact_recorded"]).toBe(true);
    expect(result["style_cluster_state"]).toEqual({ state: "already_clustered", pages_total: 6, pages_with_cluster: 6 });
    expect(String((summaryOf(result)["results"] as { missing: string[] }[])?.[0]?.missing?.[0])).toContain("生效 auto_style_cluster=False");
  });
  it("description 写清三态与行动指引（先问用户／on-off 语义／禁止猜值）", () => {
    const tool = toolOf(approvalCtx([]));
    const text = tool.description;
    expect(text).toContain("auto_style_cluster");
    expect(text).toContain("先检测");
    expect(text).toContain("style_cluster_state_not_clustered");
    expect(text).toContain("style_cluster_state_ambiguous");
    expect(text).toContain("这批数据做过版式聚类吗");
    expect(text).toContain("禁止在 auto 被拒后自行猜一个值重跑");
  });
  it("on → exit 0 且证据如实在记 not_clustered（生效 True）＋产出 Manifest 指引行", async () => {
    const result = (await toolOf(approvalCtx([]), { MOCK_CLUSTER_STATE: "not_clustered" }).execute(
      { stage: "family_split", run_id: "e10b-on", workspace_path: tempRoot(), auto_style_cluster: "on" },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["style_cluster_state"]).toEqual({ state: "not_clustered", pages_total: 6, pages_with_cluster: 0 });
    expect(String((summaryOf(result)["results"] as { missing: string[] }[])?.[0]?.missing?.[0])).toContain("生效 auto_style_cluster=True");
    expect(JSON.stringify(summaryOf(result)["results"])).toContain("StyleClusterManifest/v1");
  });
});

describe("E10b——落盘摘要回读（真内核段模式摘要不落 stdout；run_id/stage 双对账）", () => {
  const SILENT_SCRIPT = (root: string): string => {
    const path = join(root, "silent.mjs");
    writeFileSync(path, "process.exit(2)\n", "utf8");
    return path;
  };
  const writeDiskSummary = (ws: string, runId: string, body: Record<string, unknown>): void => {
    mkdirSync(join(ws, "runs", runId), { recursive: true });
    writeFileSync(join(ws, "runs", runId, "stage-family_split.summary.json"), JSON.stringify(body), "utf8");
  };
  const diskBody = (runId: string): Record<string, unknown> => ({
    schema_version: "WalkthroughPipelineReport/v1", mode: "stage", stage: "family_split", run_id: runId, exit_code: 2,
    rejections: [{ stage: "family_split", reason_codes: ["style_cluster_state_not_clustered"], missing: ["确认后用 on 重跑"] }],
    results: [{ stage: "family_split", status: "blocked", reason_codes: ["style_cluster_state_not_clustered"], missing: [], raw_response: { style_cluster_state: { state: "not_clustered", pages_total: 5, pages_with_cluster: 0, manifest_present: false, requested_auto_style_cluster: "auto", effective_auto_style_cluster: null } } }],
  });

  it("stdout 无 JSON → 回读内核缺省落盘摘要：rejections＋聚类证据透传＋问询 note 在位", async () => {
    const approvals: string[] = [];
    const ws = tempRoot();
    writeDiskSummary(ws, "run-disk", diskBody("run-disk"));
    const result = (await (buildPipelineTool(approvalCtx(approvals), `node ${SILENT_SCRIPT(tempRoot())}`, 30_000) as unknown as DshToolLike).execute(
      { stage: "family_split", run_id: "run-disk", workspace_path: ws },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["exit_code"]).toBe(2);
    expect(JSON.stringify(result["rejections"])).toContain("style_cluster_state_not_clustered");
    expect(result["style_cluster_state"]).toEqual({ state: "not_clustered", pages_total: 5, pages_with_cluster: 0 });
    expect(String(result["note"])).toContain("这批数据做过版式聚类吗");
  });
  it("落盘件 run_id 不匹配（陈旧/他 run 件）→ 不采纳：summary null＋generic note", async () => {
    const approvals: string[] = [];
    const ws = tempRoot();
    writeDiskSummary(ws, "run-other", diskBody("run-other"));
    const result = (await (buildPipelineTool(approvalCtx(approvals), `node ${SILENT_SCRIPT(tempRoot())}`, 30_000) as unknown as DshToolLike).execute(
      { stage: "family_split", run_id: "run-mine", workspace_path: ws },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["exit_code"]).toBe(2);
    expect(result["summary"]).toBeUndefined();
    expect(result["style_cluster_state"]).toBeUndefined();
    expect(String(result["note"])).toContain("摘要未含 rejections 原文");
  });
});

describe("E10b——纯函数直测（summary 缺失/畸形一律 undefined，不猜值）", () => {
  it("styleClusterStateOf：正常三键提取；results 缺失/非数组/证据形态非法 → undefined", () => {
    const summary = { results: [{ raw_response: { style_cluster_state: { state: "not_clustered", pages_total: 6, pages_with_cluster: 0, manifest_present: false, requested_auto_style_cluster: "auto", effective_auto_style_cluster: null } } }] };
    expect(styleClusterStateOf(summary)).toEqual({ state: "not_clustered", pages_total: 6, pages_with_cluster: 0 });
    expect(styleClusterStateOf(null)).toBeUndefined();
    expect(styleClusterStateOf({})).toBeUndefined();
    expect(styleClusterStateOf({ results: "not-array" })).toBeUndefined();
    expect(styleClusterStateOf({ results: [{ raw_response: {} }] })).toBeUndefined();
    expect(styleClusterStateOf({ results: [{ raw_response: { style_cluster_state: { state: 3, pages_total: "x", pages_with_cluster: null } } }] })).toBeUndefined();
  });
  it("styleClusterRejectionOf：数组与单对象两形态都认；无码/无关码 → undefined", () => {
    expect(styleClusterRejectionOf([{ stage: "family_split", reason_codes: ["style_cluster_state_not_clustered"] }])).toBe("style_cluster_state_not_clustered");
    expect(styleClusterRejectionOf([{ stage: "family_split", reason_codes: ["walkthrough_upstream_not_ok"] }, { reason_codes: ["style_cluster_state_ambiguous"] }])).toBe("style_cluster_state_ambiguous");
    expect(styleClusterRejectionOf({ reason_codes: ["style_cluster_state_ambiguous"] })).toBe("style_cluster_state_ambiguous");
    expect(styleClusterRejectionOf(null)).toBeUndefined();
    expect(styleClusterRejectionOf([{ reason_codes: ["split_recompute_cluster_required"] }])).toBeUndefined();
    expect(styleClusterRejectionOf([{ missing: ["no codes"] }])).toBeUndefined();
  });
  it("两条回流 note 闭集：都含「先问用户」与禁止猜值；not_clustered 指 on、ambiguous 指 on/off", () => {
    expect(STYLE_CLUSTER_REJECTION_NOTE.style_cluster_state_not_clustered).toContain("这批数据做过版式聚类吗");
    expect(STYLE_CLUSTER_REJECTION_NOTE.style_cluster_state_not_clustered).toContain("\"on\"");
    expect(STYLE_CLUSTER_REJECTION_NOTE.style_cluster_state_not_clustered).not.toContain("\"off\"");
    expect(STYLE_CLUSTER_REJECTION_NOTE.style_cluster_state_ambiguous).toContain("\"on\"");
    expect(STYLE_CLUSTER_REJECTION_NOTE.style_cluster_state_ambiguous).toContain("\"off\"");
    for (const note of Object.values(STYLE_CLUSTER_REJECTION_NOTE)) {
      expect(note).toContain("禁止不问用户自行猜值重跑");
    }
  });
});
