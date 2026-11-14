/**
 * A 面构造参数通道锚（至少可表达）：atf_pipeline_stage 的 experiment_setup 段
 * 增四条参数——grouping_confirm／mode5_random／mode5_advice_stats／targeted_advice。
 *
 * 背景：`grouping_confirm`、`mode5_random`、`mode5_advice_stats`、`targeted_advice`
 * 此前在 harness 侧**没有任何通道**（全仓 TS 对 construction/mode5/targeted 零命中），
 * 于是「分组未确认 → mode1 不生成 → 行数少」这条链上，模型连表达确认与建议的入口
 * 都没有，只能把执行推回 operator。本文件锁四件事：
 *
 * 1. 四条参数逐条落到内核 argv（含内联对象落 <run>/prep 后传路径）；
 * 2. 未给时一律不下传（不给缺省值、不冒充用户指定）；
 * 3. 审批卡呈现「构造参数确认」段，三行如实标注确认态（未确认即明说对应 kind 不生成）；
 * 4. 风险信号在场才自动带 `--risk-signals`（targeted evidence 出处校验要用）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPipelineTool, constructionParamsApprovalLines } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

interface DshToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

const tempRoots: string[] = [];
const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeExec = { agent: undefined, callId: "a-call", signal: undefined };
const approvalCtx = (record: string[]): { get(service: string): unknown } => ({
  get: (service: string) =>
    service === "approval"
      ? { request: async (req: { reason: string }) => { record.push(req.reason); return "allowed-once"; } }
      : undefined,
});
const MOCK = join(import.meta.dirname, "..", "fixtures", "mock_pipeline_params.mjs");
/** 夹具包装：执行前按 args 的 workspace_path／run_id 落位 run 目录（管道只定位不建树；
 *  advice 写面在 run 未创建时会拒 run_not_created——夹具先让 run 在场）。 */
const seedRunOf = <T extends { execute: (a: Record<string, unknown>, e: unknown) => Promise<unknown> }>(tool: T): T => ({
  ...tool,
  execute: async (args: Record<string, unknown>, exec: unknown) => {
    const ws = typeof args["workspace_path"] === "string" ? (args["workspace_path"] as string) : "";
    const runId = typeof args["run_id"] === "string" ? (args["run_id"] as string) : "";
    if (ws !== "" && runId !== "") mkdirSync(join(ws, "runs", runId), { recursive: true });
    return tool.execute(args, exec) as Promise<unknown>;
  },
}) as T;

const toolOf = (record: string[] = []): DshToolLike =>
  seedRunOf(buildPipelineTool(approvalCtx(record), `node ${MOCK}`, 30_000) as unknown as DshToolLike);

/** 带 userQuestions 的 ctx（采纳卡应答桩）：answer 非空即模拟在卡上填了该值。 */
const toolWithAsk = (record: string[], answer: string): DshToolLike =>
  seedRunOf(buildPipelineTool(
    {
      get: (service: string) => {
        if (service === "approval") {
          return { request: async (req: { reason: string }) => { record.push(req.reason); return "allowed-once"; } };
        }
        if (service === "userQuestions") {
          return {
            ask: async () => ({ answers: [{ id: "construction", selected: [`targeted_accept=${answer}`] }] }),
          };
        }
        return undefined;
      },
    },
    `node ${MOCK}`,
    30_000,
  ) as unknown as DshToolLike);

const summaryArgv = (result: unknown): string[] =>
  ((result as { summary?: { argv?: string[] } }).summary?.argv ?? []);

/** run 落点双形态（canonical <ws>/workspace/runs/<id> 与 legacy <ws>/runs/<id>）——
 *  测试不去猜解析器，按两处查文件是否存在。 */
const candidates = (ws: string, runId: string): string[] => [
  join(ws, "workspace", "runs", runId),
  join(ws, "runs", runId),
];

/** ci-bl-1103 字段确认放行门:experiment_setup 前置——落一份 field-choice 过门用。 */
const confirmFields = (ws: string, runId: string, doc?: string): void => {
  const runDir = candidates(ws, runId)[0] as string;
  // F1 命中口径要求合法 run.json——测试 run 目录一并造全
  if (!existsSync(join(runDir, "run.json"))) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: runId, experiment_id: "exp-ut" }), "utf-8");
  }
  // 双落 v3(runtime/webui)与 v2(webui)两形态——readFieldChoice 按树形态取其一
  for (const rel of ["runtime/webui", "webui"]) {
    mkdirSync(join(runDir, rel), { recursive: true });
    writeFileSync(
      join(runDir, rel, doc !== undefined && doc !== "" ? `field-choice.${doc}.json` : "field-choice.json"),
      JSON.stringify({ schema_version: "FieldChoice/v1", run_id: runId, confirmed_fields: ["f1", "f2"], all_fields: true, total_fields: 1, decided_at: new Date().toISOString(), source: "user_confirmed" }),
      "utf-8",
    );
  }
};

const findUnderRun = (ws: string, runId: string, rel: string): string | undefined =>
  candidates(ws, runId).map((r) => join(r, rel)).find((p) => existsSync(p));

const ADVICE = {
  schema_version: "TargetedRulesAdvice/v1",
  suggested_carry_fields: ["goods_name"],
  suggested_min_fields: 2,
  suggested_max_fields: 6,
  reason: "container_no 出现率低，同组需带 goods_name 作锚点。",
  evidence: ["container_no:occurrence_rate"],
  effective: false,
};

/** D173 必分组(1106 晚机检):experiment_setup 用例统一带分组候选过闸。 */
const D173_PROPOSAL = {
  schema_version: "GroupingProposal/v1",
  candidates: [
    { name: "两层", recommended: true, reason: "单据头/明细分开", groups: [{ name: "单据级", fields: ["f1"] }, { name: "明细级", fields: ["f2"] }] },
  ],
  recommended_index: 0,
};

describe("A-1 构造参数四通道（experiment_setup 段专属）", () => {
  it("四条全给：argv 逐条带上，内联对象落 <run>/prep 后传路径", async () => {
    const ws = tempRoot("a-ws-");
    confirmFields(ws, "a-full");
    const record: string[] = [];
    const result = await toolOf(record).execute(
      {
        stage: "experiment_setup",
        grouping_proposal: D173_PROPOSAL,
        run_id: "a-full",
        workspace_path: ws,
        grouping_confirm: true,
        mode5_random: 3,
        mode5_advice_stats: { schema_version: "Mode5AdviceStats/v1", images: 10, full_field_baseline_rows: 10 },
        targeted_advice: ADVICE,
      },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv).toContain("--grouping-confirm");
    expect(argv).toContain("--mode5-random");
    expect(argv).toContain("3");

    // 建议对象落盘（模型不必自己写文件），argv 传的是真实存在路径
    const statsPath = findUnderRun(ws, "a-full", join("prep", "mode5-advice-stats.json"));
    const advicePath = findUnderRun(ws, "a-full", join("prep", "targeted-advice.json"));
    expect(statsPath, "mode5 建议统计未落盘").toBeTruthy();
    expect(advicePath, "targeted 建议未落盘").toBeTruthy();
    expect(argv[argv.indexOf("--mode5-advice-stats") + 1]).toBe(statsPath);
    expect(argv[argv.indexOf("--targeted-advice") + 1]).toBe(advicePath);

    const written = JSON.parse(readFileSync(advicePath as string, "utf-8")) as Record<string, unknown>;
    expect(written["suggested_carry_fields"]).toEqual(["goods_name"]);
    expect(written["evidence"]).toEqual(["container_no:occurrence_rate"]);
    expect(written["effective"]).toBe(false);
  });

  it("都不给：四条 flag 一律不下传（不设缺省、不冒充用户指定）", async () => {
    const ws = tempRoot("a-ws-");
    confirmFields(ws, "a-none");
    const result = await toolOf().execute(
      { stage: "experiment_setup", grouping_proposal: D173_PROPOSAL, run_id: "a-none", workspace_path: ws },
      fakeExec,
    );
    const argv = summaryArgv(result);
    for (const flag of ["--grouping-confirm", "--mode5-random", "--mode5-advice-stats", "--targeted-advice"]) {
      expect(argv, `${flag} 不应出现在 argv`).not.toContain(flag);
    }
  });

  it("构造参数行纯函数（ADR-0022 段审批卡退役，原卡面断言转纯函数锚）：未确认项明说对应 kind 不生成", () => {
    // P1-5 新合同:run 无风险件(分析未完成)时倍数行不得预设「默认生成」——
    // 呈现「图像分析未完成,本轮不确认倍数」并指路看图(分析先于确认卡)。
    const reason = constructionParamsApprovalLines({
      groupingConfirm: false,
      mode5Random: undefined,
      targetedAdvice: { carry: ["goods_name"], min: 2, max: 6, reason: "container_no 出现率低", evidence: ["container_no:occurrence_rate"], evidenceStatus: "provided" },
      analysisReady: false,
    });
    expect(reason).toContain("分组方案：待定——分组候选上卡后由用户选定（2-3 组优先，上限 5），未选定前不生成分组样本");
    expect(reason).toContain("随机子集增强：**图像分析未完成——本轮不确认倍数**");
    expect(reason).not.toContain("按建议倍数额度默认生成");
    // 建议值/理由/出处态一起呈现（建议不自动生效）
    expect(reason).toContain("goods_name");
    expect(reason).toContain("建议未自动生效");
    expect(reason).toContain("container_no 出现率低");

    // 调用方给了建议倍数且分析在场时，行内显示该数字（据实呈现，不写死）
    const withSuggestion = constructionParamsApprovalLines({
      groupingConfirm: false,
      mode5Random: undefined,
      mode5Suggested: 3,
      targetedAdvice: undefined,
      analysisReady: true,
    });
    expect(withSuggestion).toContain("（建议 3 倍）");
    // 分析未完成时即使有建议值也不出确认形态(卡时机断言)
    const noAnalysis = constructionParamsApprovalLines({
      groupingConfirm: false,
      mode5Random: undefined,
      mode5Suggested: 3,
      targetedAdvice: undefined,
      analysisReady: false,
    });
    expect(noAnalysis).not.toContain("（建议 3 倍）");
  });

  it("已确认与给定值：纯函数标注已确认／用户指定（显式值先于分析门槛呈现）", () => {
    const reason = constructionParamsApprovalLines({
      groupingConfirm: true,
      mode5Random: 0,
      targetedAdvice: undefined,
      analysisReady: false,
    });
    expect(reason).toContain("分组：按分组生成（产品默认，必分组不提问）");
    // P1-5:显式值(含 0=明确关停)是用户已做的决定,先于分析门槛呈现
    expect(reason).toContain("随机子集增强：0 倍（显式不启用）");
  });

  it("风险信号在场才自动带 --risk-signals（供 evidence 出处校验）", async () => {
    const ws = tempRoot("a-ws-");
    const runId = "a-risk";
    confirmFields(ws, runId, "do");  // D191:段带 doc_type,账本 per-doc
    const runDir = candidates(ws, runId)[0] as string;
    mkdirSync(join(runDir, "prep", "risk-signals", "do"), { recursive: true });
    writeFileSync(
      join(runDir, "prep", "risk-signals", "do", "field_risk_signals.json"),
      JSON.stringify({ schema_version: "FieldRiskSignals/v1", field_signals: { container_no: { occurrence_rate: 0.06 } } }),
      "utf-8",
    );
    const result = await toolOf().execute(
      { stage: "experiment_setup", grouping_proposal: D173_PROPOSAL, run_id: runId, workspace_path: ws, doc_type: "do", targeted_advice: ADVICE },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv).toContain("--risk-signals");
    expect(argv[argv.indexOf("--risk-signals") + 1]).toContain("field_risk_signals.json");
  });
});

describe("A-2 采纳卡退场（建议默认生效，唯一确认面=构造确认卡）", () => {
  it("给了建议 → argv 带 --targeted-advice、永不带 --targeted-accept（建议默认生效——ADR-0022 后原审批卡生效提示行随卡退役）", async () => {
    const ws = tempRoot("a-ws-");
    confirmFields(ws, "a-accept");
    const result = await toolWithAsk([], "yes").execute(
      { stage: "experiment_setup", grouping_proposal: D173_PROPOSAL, run_id: "a-accept", workspace_path: ws, targeted_advice: ADVICE },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv).toContain("--targeted-advice");
    expect(argv).not.toContain("--targeted-accept");
  });

  it("无 userQuestions 服务 → 建议仍默认生效（不弹卡不阻塞，不假装走过确认卡）", async () => {
    const ws = tempRoot("a-ws-");
    confirmFields(ws, "a-degrade");
    const record: string[] = [];
    const result = await toolOf(record).execute(
      { stage: "experiment_setup", grouping_proposal: D173_PROPOSAL, run_id: "a-degrade", workspace_path: ws, targeted_advice: ADVICE },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv).toContain("--targeted-advice");
    expect(argv).not.toContain("--targeted-accept");
  });

  it("没给建议 → 不带建议参数、回执无生效提示", async () => {
    const ws = tempRoot("a-ws-");
    confirmFields(ws, "a-noadvice");
    const record: string[] = [];
    const result = await toolWithAsk(record, "yes").execute(
      { stage: "experiment_setup", grouping_proposal: D173_PROPOSAL, run_id: "a-noadvice", workspace_path: ws },
      fakeExec,
    );
    expect(summaryArgv(result)).not.toContain("--targeted-accept");
    expect(record.join("\n")).not.toContain("建议已默认写入构造规则");
  });
});

// ── N5 回归锁：augmentFromText 解析（WebUI selected 回传整行曾把「2 倍」吞成不增强）──
import { augmentFromText } from "../../packages/extensions/atf-tools/src/constructionGate.js";

describe("augmentFromText（custom 自由输入通道；N5 更正：不做回传形态猜测）", () => {
  it("label 等值命中", () => {
    expect(augmentFromText("2 倍")).toBe(2);
    expect(augmentFromText("3 倍")).toBe(3);
    expect(augmentFromText("不增强")).toBe(0);
  });
  it("custom 自由输入：数字与否定", () => {
    expect(augmentFromText("3")).toBe(3);
    expect(augmentFromText("不要")).toBe(0);
  });
  it("认不出按未答处理（不猜）", () => {
    expect(augmentFromText("")).toBeUndefined();
    expect(augmentFromText("随便说说")).toBeUndefined();
  });
});