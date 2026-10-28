/**
 * E10b/E10d 测试锚——atf_pipeline_stage 版式聚类三态透传＋拒绝面业务化（内核 main
 * E10a/E10e/E10f 命令面；指令件 E10b 7a0dcece／E10d e9e7464f）。
 *
 * E10b 覆盖（§二）：
 *   参数面——缺省 auto／三值枚举逐值透传／非法值框架层拒（ToolArgsError，审批零触达）；
 *   argv 断言——`--auto-style-cluster` 仅 family_split 出现（缺省也显式上线解析值）；
 *   证据透传——summary 携带 results[].raw_response.style_cluster_state 时回传
 *   {state,pages_total,pages_with_cluster} 三键；八段闭集零回归；落盘摘要回读（双对账）。
 * E10d 覆盖（§二）：
 *   user_message 逐字透传（不加工不拼接）；内核未带 → 业务兜底文案＋user_message_source=
 *   "fallback"；note 文案＝「原样告知用户」版（不含面向用户的枚举指令）；allow_small_cluster_
 *   test 缺省不出现在 argv、true 时仅 family_split 追加；description 业务语言句在位；
 *   E10e/E10f 语义翻新——off×未聚类＝style_cluster_declared_but_absent（矛盾拒绝），
 *   on×全小簇×strict＝split_partition_empty:test＋user_message（note/fallback 不触发，
 *   user_message 照常透传）。
 * 真实环境验收随批执行报告/取证，不入本锚。
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
  userMessageOf,
  STYLE_CLUSTER_REJECTION_NOTE,
  STYLE_CLUSTER_USER_MESSAGE_FALLBACK,
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
    // D24h 翻锚：放行三参随段下传（session 缺失→actor=unattributed）
    expect(summaryArgv(result)).toEqual([
      "--workspace", expect.any(String), "--run-id", "e10b-a", "--stage", "family_split", "--auto-style-cluster", "auto",
      "--actor", "unattributed", "--approval-mode", "ui", "--round-dir", expect.any(String),
    ]);
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

describe("E10b/E10d——聚类状态拒绝回流（E10f 形态：user_message＋「原样告知」note）", () => {
  it("auto × 未聚类 → exit 2＋内核 user_message 逐字透传（无 source 标注）＋note=原样告知版；零写入", async () => {
    const approvals: string[] = [];
    const result = (await toolOf(approvalCtx(approvals), { MOCK_CLUSTER_STATE: "not_clustered" }).execute(
      { stage: "family_split", run_id: "e10b-nc", workspace_path: tempRoot() },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["exit_code"]).toBe(2);
    expect(result["segment_fact_recorded"]).toBe(false);
    // E10d §二.1：user_message 逐字一致（不加工不拼接）；内核带 → 无 fallback 标注
    expect(result["user_message"]).toBe(
      "这批数据没有找到版式分组信息（共 6 页，0 页带分组），因此没有继续切分。" +
      "如果数据确实分过组：请提供带分组信息的数据文件；如果没分过组：可以改为先分组、再切分。",
    );
    expect(result["user_message_source"]).toBeUndefined();
    // E10d §二.3：note＝「原样告知」版——不含面向用户的枚举指令
    const note = String(result["note"]);
    expect(note).toContain("原样告知用户");
    expect(note).toContain("已分组→直接分层；未分组→先分组再分层");
    expect(note).toContain("不要向用户展示 auto/on/off 等内部选项名");
    expect(note).not.toContain("重跑");
    expect(result["style_cluster_state"]).toEqual({ state: "not_clustered", pages_total: 6, pages_with_cluster: 0 });
    expect(approvals).toHaveLength(1);
  });
  it("auto × 状态不明 → exit 2 style_cluster_state_ambiguous＋user_message 逐字＋note 原样告知版", async () => {
    const result = (await toolOf(approvalCtx([]), { MOCK_CLUSTER_STATE: "ambiguous" }).execute(
      { stage: "family_split", run_id: "e10b-am", workspace_path: tempRoot() },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["exit_code"]).toBe(2);
    expect(result["user_message"]).toBe(
      "这批数据里只有部分页带版式分组（6 页中 3 页），无法判断是否已分好组。" +
      "请确认后重试：已分好组请提供完整分组；未分过组可先分组再切分。",
    );
    expect(String(result["note"])).toContain("原样告知用户");
    expect(result["style_cluster_state"]).toEqual({ state: "ambiguous", pages_total: 6, pages_with_cluster: 3 });
  });
  it("off × 未聚类（E10e 矛盾拒绝）→ exit 2 style_cluster_declared_but_absent＋user_message 逐字＋note 原样告知版", async () => {
    const result = (await toolOf(approvalCtx([]), { MOCK_CLUSTER_STATE: "not_clustered" }).execute(
      { stage: "family_split", run_id: "e10b-off", workspace_path: tempRoot(), auto_style_cluster: "off" },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["exit_code"]).toBe(2);
    expect(JSON.stringify(result["rejections"])).toContain("style_cluster_declared_but_absent");
    expect(result["user_message"]).toBe(
      "这批数据没有找到版式分组信息（共 6 页，0 页带分组），与“已分组”的选择不一致。" +
      "请确认：如果分过组，请提供带分组信息的数据；如果没有，可以改为先分组再切分。",
    );
    expect(String(result["note"])).toContain("原样告知用户");
  });
});

describe("E10d——user_message 兜底与小簇拒绝面", () => {
  it("内核未带 user_message → 业务兜底文案＋user_message_source=fallback（not_clustered 与 off 矛盾两形态）", async () => {
    for (const extra of [{}, { auto_style_cluster: "off" }]) {
      const result = (await toolOf(approvalCtx([]), { MOCK_CLUSTER_STATE: "not_clustered", MOCK_NO_USER_MESSAGE: "1" }).execute(
        { stage: "family_split", run_id: "e10b-fb", workspace_path: tempRoot(), ...extra },
        fakeExec,
      )) as Record<string, unknown>;
      expect(result["user_message"]).toBe(STYLE_CLUSTER_USER_MESSAGE_FALLBACK);
      expect(result["user_message"]).toBe("这批数据的版式分组状态无法确认，请确认数据是否已按版式分组后再试。");
      expect(result["user_message_source"]).toBe("fallback");
      expect(String(result["note"])).toContain("原样告知用户");
    }
  });
  it("on × 全小簇 × strict（E10f D3）→ exit 2 split_partition_empty:test＋user_message 逐字；note/fallback 标注不触发", async () => {
    const result = (await toolOf(approvalCtx([]), { MOCK_CLUSTER_STATE: "not_clustered", MOCK_SMALL_CLUSTER: "1" }).execute(
      { stage: "family_split", run_id: "e10b-sc", workspace_path: tempRoot(), auto_style_cluster: "on" },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["exit_code"]).toBe(2);
    expect(JSON.stringify(result["rejections"])).toContain("split_partition_empty:test");
    expect(result["user_message"]).toBe(
      "这批数据的版式分组都太小（每类不足 5 页），无法留出测试集。" +
      "可以把相近的小类合并后再试，或声明全部用于训练，" +
      "也可以选择让每个小类各留 1 页做测试（测试样本会很少）。",
    );
    expect(result["user_message_source"]).toBeUndefined(); // 内核带 → 无兜底标注
    expect(result["note"]).toBeUndefined(); // 小簇码不在聚类状态 note 闭集
  });
  it("on × 全小簇 × allow 开关 → exit 0＋警告行＋Manifest 行（E10f 锚⑤形态）", async () => {
    const result = (await toolOf(approvalCtx([]), { MOCK_CLUSTER_STATE: "not_clustered", MOCK_SMALL_CLUSTER: "1" }).execute(
      { stage: "family_split", run_id: "e10b-sc2", workspace_path: tempRoot(), auto_style_cluster: "on", allow_small_cluster_test: true },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(JSON.stringify(summaryOf(result)["results"])).toContain("小类测试仅 1 页，指标参考性有限");
    expect(JSON.stringify(summaryOf(result)["results"])).toContain("StyleClusterManifest/v1");
  });
});

describe("E10d——allow_small_cluster_test 参数面与 argv 断言", () => {
  it("缺省 → argv 不含 --allow-small-cluster-test；true 且 family_split → 追加开关", async () => {
    const approvals: string[] = [];
    const def = await toolOf(approvalCtx(approvals), { MOCK_CLUSTER_STATE: "already_clustered" }).execute(
      { stage: "family_split", run_id: "e10d-def", workspace_path: tempRoot() },
      fakeExec,
    );
    expect(summaryArgv(def)).not.toContain("--allow-small-cluster-test");
    const on = await toolOf(approvalCtx([]), { MOCK_CLUSTER_STATE: "already_clustered" }).execute(
      { stage: "family_split", run_id: "e10d-on", workspace_path: tempRoot(), allow_small_cluster_test: true },
      fakeExec,
    );
    expect(summaryArgv(on)).toContain("--allow-small-cluster-test");
    expect(summaryArgv(on).filter((a) => a === "--allow-small-cluster-test")).toHaveLength(1);
  });
  it("true 且非 family_split → 其它段忽略（argv 不出现，不报错）", async () => {
    const result = await toolOf(approvalCtx([])).execute(
      { stage: "label_qc", run_id: "e10d-lq", workspace_path: tempRoot(), allow_small_cluster_test: true },
      fakeExec,
    );
    expect((result as Record<string, unknown>)["ok"]).toBe(true);
    expect(summaryArgv(result)).not.toContain("--allow-small-cluster-test");
  });
  it("description：参数说明保留枚举并增业务语言句（不要念枚举值）；allow 用业务语言不带内部键名", () => {
    const tool = toolOf(approvalCtx([]));
    const schema = tool.parameters as { properties?: Record<string, { description?: string }> };
    const autoDesc = String(schema.properties?.["auto_style_cluster"]?.description);
    expect(autoDesc).toContain("auto");
    expect(autoDesc).toContain("不要念枚举值");
    expect(autoDesc).toContain("这批数据是否已经按版式分好组");
    const allowDesc = String(schema.properties?.["allow_small_cluster_test"]?.description);
    expect(allowDesc).toContain("版式分组都太小");
    expect(allowDesc).toContain("每个小类只留 1 页，测试样本很少");
    expect(allowDesc).not.toContain("small_cluster_policy");
    expect(allowDesc).not.toContain("split_partition_empty");
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
    expect(result["user_message"]).toBeUndefined(); // 成功面无拒绝文案
  });
  it("工具 description 三态指引（含 E10e 新码；用户表述业务语言句在位）", () => {
    const tool = toolOf(approvalCtx([]));
    const text = tool.description;
    expect(text).toContain("auto_style_cluster");
    expect(text).toContain("先检测");
    expect(text).toContain("style_cluster_state_not_clustered");
    expect(text).toContain("style_cluster_state_ambiguous");
    expect(text).toContain("style_cluster_declared_but_absent");
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

  it("stdout 无 JSON → 回读内核缺省落盘摘要：rejections＋证据＋兜底文案（落盘件未带 user_message）", async () => {
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
    expect(result["user_message"]).toBe(STYLE_CLUSTER_USER_MESSAGE_FALLBACK);
    expect(result["user_message_source"]).toBe("fallback");
    expect(String(result["note"])).toContain("原样告知用户");
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
    expect(result["user_message"]).toBeUndefined();
    expect(String(result["note"])).toContain("没拿到可采纳的摘要");
    expect(result["kernel_stderr"]).toBeDefined();
  });
});

describe("E10b/E10d——纯函数直测（summary 缺失/畸形一律 undefined，不猜值）", () => {
  it("styleClusterStateOf：正常三键提取；results 缺失/非数组/证据形态非法 → undefined", () => {
    const summary = { results: [{ raw_response: { style_cluster_state: { state: "not_clustered", pages_total: 6, pages_with_cluster: 0, manifest_present: false, requested_auto_style_cluster: "auto", effective_auto_style_cluster: null } } }] };
    expect(styleClusterStateOf(summary)).toEqual({ state: "not_clustered", pages_total: 6, pages_with_cluster: 0 });
    expect(styleClusterStateOf(null)).toBeUndefined();
    expect(styleClusterStateOf({})).toBeUndefined();
    expect(styleClusterStateOf({ results: "not-array" })).toBeUndefined();
    expect(styleClusterStateOf({ results: [{ raw_response: {} }] })).toBeUndefined();
    expect(styleClusterStateOf({ results: [{ raw_response: { style_cluster_state: { state: 3, pages_total: "x", pages_with_cluster: null } } }] })).toBeUndefined();
  });
  it("userMessageOf：首条拒绝的 user_message 原样取出；缺失/非串 → undefined", () => {
    const summary = { results: [{ raw_response: { user_message: "业务文案原文" } }, { raw_response: { user_message: "第二条不取" } }] };
    expect(userMessageOf(summary)).toBe("业务文案原文");
    expect(userMessageOf(null)).toBeUndefined();
    expect(userMessageOf({})).toBeUndefined();
    expect(userMessageOf({ results: [{ raw_response: { user_message: 3 } }] })).toBeUndefined();
    expect(userMessageOf({ results: [{ raw_response: { user_message: "" } }] })).toBeUndefined();
  });
  it("styleClusterRejectionOf：聚类状态三码命中（含 E10e 矛盾码）；数组/单对象两形态；无关码 false", () => {
    expect(styleClusterRejectionOf([{ stage: "family_split", reason_codes: ["style_cluster_state_not_clustered"] }])).toBe(true);
    expect(styleClusterRejectionOf([{ reason_codes: ["style_cluster_state_ambiguous"] }])).toBe(true);
    expect(styleClusterRejectionOf({ reason_codes: ["style_cluster_declared_but_absent"] })).toBe(true);
    expect(styleClusterRejectionOf([{ reason_codes: ["walkthrough_upstream_not_ok"] }, { reason_codes: ["style_cluster_state_ambiguous"] }])).toBe(true);
    expect(styleClusterRejectionOf(null)).toBe(false);
    expect(styleClusterRejectionOf([{ reason_codes: ["split_partition_empty:test"] }])).toBe(false);
    expect(styleClusterRejectionOf([{ reason_codes: ["split_recompute_cluster_required"] }])).toBe(false);
    expect(styleClusterRejectionOf([{ missing: ["no codes"] }])).toBe(false);
  });
  it("E10d 回流 note 与兜底文案闭集：含「原样告知用户」与内部选项名禁令；不含面向用户的枚举重跑指令", () => {
    expect(STYLE_CLUSTER_REJECTION_NOTE).toContain("原样告知用户");
    expect(STYLE_CLUSTER_REJECTION_NOTE).toContain("已分组→直接分层；未分组→先分组再分层");
    expect(STYLE_CLUSTER_REJECTION_NOTE).toContain("不要向用户展示 auto/on/off 等内部选项名");
    expect(STYLE_CLUSTER_REJECTION_NOTE).not.toContain("重跑");
    expect(STYLE_CLUSTER_USER_MESSAGE_FALLBACK).toBe("这批数据的版式分组状态无法确认，请确认数据是否已按版式分组后再试。");
  });
});
