/**
 * C2 分组四态回归锚（参数面＋卡面＋回执）。
 *
 * 真实契约（内核 skills/atf-admit-training-data/scripts/grouping_proposal.py）：
 *   {schema_version:"GroupingProposal/v1",
 *    candidates:[{name, recommended?, groups:[{name, fields:[]}], reason}]}
 *   校验返回 {ok, errors, recommended:<索引>}，不抛异常。
 *
 * 锚点（owner 裁定 §8-1-A：full 档自动选定、不问）：
 *  ① `user_provided`：字段配置自带 group＝用户已给 → 不出卡、不下传候选，回执一句话；
 *  ② `proposal`：给了合法候选 → 出原生选项卡（每候选一项，标题＝候选 name，描述＝组名×字段数＋reason），
 *     选定后回执 `grouping_source=proposal`／`grouping_decision=user_selected`＋所选候选 name，
 *     内核拿到的 recommended 旗标挪到用户选的那个；
 *  ③ `policy_auto`：完全权限档＋候选 → 不出卡，直接取 candidates[recommended]，
 *     回执 `grouping_source=policy_auto`／`grouping_decision=auto`＋候选摘要；
 *  ④ `none`：都没有 → 平铺，回执 `grouping_source=none`，不假装有分组；
 *  ⑤ 建议形状不合格＝逐条 errors（harness 侧或内核侧都原样透出，不压成一句话）；
 *  ⑥ 两档都有 `grouping_report` markdown 表（分组｜字段数｜字段），agent 可原样贴；
 *  ⑦ 用户可见面零内部词（lane／A、B 预设／批次号）；
 *  ⑧ F6：回执带 user_summary 三句话，连续失败 ≥2 升级到用户。
 */
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPipelineTool } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

interface DshToolLike {
  name: string;
  description: string;
  parameters: unknown;
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>;
}

const tempRoots: string[] = [];
const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  // D133:段入口拒裸目录 workspace——fixture 建已初始化形态(runs/ 标记)。
  mkdirSync(join(root, "runs"), { recursive: true });
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** ci-bl-1103 字段确认放行门:experiment_setup 前置——run 双形态落 field-choice。 */
const confirmFields = (ws: string, runId: string): void => {
  const runDir = join(ws, "runs", runId);
  if (!existsSync(join(runDir, "run.json"))) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: runId, experiment_id: "exp-ut" }), "utf-8");
  }
  for (const rel of ["runtime/webui", "webui"]) {
    mkdirSync(join(runDir, rel), { recursive: true });
    writeFileSync(
      join(runDir, rel, "field-choice.json"),
      JSON.stringify({ schema_version: "FieldChoice/v1", run_id: runId, confirmed_fields: ["doc_identifier", "page_summary", "goods_name"], all_fields: true, total_fields: 3, decided_at: new Date().toISOString(), source: "user_confirmed" }),
      "utf-8",
    );
  }
};

const fakeExec = { agent: { session: { id: "h2-card" } }, callId: "h2-card-1", signal: undefined };

/** 段命令 mock：回显 argv 与分组建议原文（读文件内容，证明真落盘且内容正确）。 */
const MOCK_OK = `import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const read = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const index = argv.indexOf("--grouping-proposal");
let proposal = null;
if (index >= 0) {
  try { proposal = JSON.parse(readFileSync(argv[index + 1], "utf8")); } catch { proposal = "unreadable"; }
}
process.stdout.write(JSON.stringify({
  schema_version: "WalkthroughPipelineReport/v1",
  mode: "stage",
  stage: read("--stage"),
  run_id: read("--run-id") ?? "",
  exit_code: 0,
  ok: true,
  argv,
  grouping_proposal_echo: proposal,
}) + "\\n");
`;

/** 段命令 mock：内核判候选不合格（{ok:false, errors, recommended} 形态，不抛异常）。 */
const MOCK_INVALID = `process.stdout.write(JSON.stringify({
  schema_version: "WalkthroughPipelineReport/v1",
  mode: "stage",
  stage: "experiment_setup",
  run_id: "",
  ok: false,
  errors: ["candidates[1].groups 须为非空数组", "recommended 须恰好一个候选为 true"],
  recommended: -1,
}) + "\\n");
process.exit(2);
`;

const mockOf = (body: string): string => {
  const dir = tempRoot("h2-mock-");
  const path = join(dir, "mock_pipeline.mjs");
  writeFileSync(path, body);
  return path;
};

/** 审批＋权限档＋问题卡三服务桩（full=true 走完全权限档，否则人工档）。 */
const ctxOf = (input: {
  full?: boolean;
  asked?: Array<Record<string, unknown>>;
  approvals?: string[];
  choose?: (labels: string[]) => string;
  custom?: string;
}): { get(service: string): unknown } => ({
  get(service: string) {
    if (service === "approval") {
      return {
        request: async (request: { reason: string }) => {
          input.approvals?.push(request.reason);
          return "allowed-once";
        },
      };
    }
    if (service === "permissionPresets") {
      return {
        current: () => (input.full === true ? "danger-full-access" : "manual"),
        resolve: () => ({ sandbox: input.full === true ? "danger-full-access" : "workspace-write" }),
      };
    }
    if (service === "userQuestions") {
      return {
        ask: async (request: Record<string, unknown>) => {
          input.asked?.push(request);
          const question = (request["questions"] as Array<{ id: string; options?: Array<{ label: string }> }>)[0]!;
          const labels = (question.options ?? []).map((option) => option.label);
          const picked = input.choose === undefined ? labels[0]! : input.choose(labels);
          const custom = typeof (input as { custom?: string }).custom === "string" ? (input as { custom: string }).custom : undefined;
          return { answers: [{ id: question.id, selected: picked === "" ? [] : [picked], ...(custom !== undefined ? { custom } : {}) }] };
        },
      };
    }
    return undefined;
  },
});

const toolOf = (ctx: { get(service: string): unknown }, mock: string): DshToolLike =>
  buildPipelineTool(ctx, `node ${mock}`, 30_000) as unknown as DshToolLike;

const argvOf = (result: Record<string, unknown>): string[] =>
  ((result["summary"] as { argv?: string[] } | undefined)?.argv ?? []) as string[];

/** 真实契约形态的两候选（第一候选 recommended:true）。 */
const PROPOSAL = {
  schema_version: "GroupingProposal/v1",
  candidates: [
    {
      name: "按单据/明细两层",
      recommended: true,
      reason: "单据头和明细分开，样本按组各一条",
      groups: [
        { name: "单据级", fields: ["doc_identifier", "page_summary"] },
        { name: "明细级", fields: ["goods_name"] },
      ],
    },
    {
      name: "全部平铺成一组",
      reason: "字段少时平铺更省事",
      groups: [{ name: "全部字段", fields: ["doc_identifier", "page_summary", "goods_name"] }],
    },
  ],
};

const FIELD_CONFIG_WITH_GROUP = {
  fields: [
    { field_id: "doc_identifier", zh: "单据标识", group: "单据级" },
    { field_id: "page_summary", zh: "页级汇总", group: "单据级" },
    { field_id: "goods_name", zh: "货名", group: "明细级" },
  ],
};

const seedFieldConfig = (ws: string): string => {
  const path = join(ws, "field-config.json");
  writeFileSync(path, JSON.stringify(FIELD_CONFIG_WITH_GROUP));
  return path;
};

describe("C2 分组四态", () => {
  it("配置自带 group → 仍出卡确认（W4：五项必问）；卡通道缺席 → 不替选、回执带分组表", async () => {
    const ws = tempRoot("c2-own-");
    confirmFields(ws, "own");
    const fieldConfig = seedFieldConfig(ws);
    const asked: Array<Record<string, unknown>> = [];
    const result = await toolOf(ctxOf({ asked }), mockOf(MOCK_OK)).execute(
      { stage: "experiment_setup", run_id: "own", workspace_path: ws, field_config: fieldConfig },
      fakeExec,
    );
    // P1-6b 新合同:配置自带分组未确认→合成单候选**必出原生分组卡**(asked=1,
    // 候选=配置自带分组);用户卡上确认/改,不再要求 agent 先口头问再传候选重推。
    expect(asked).toHaveLength(1);
    expect(result["grouping_source"]).toBe("proposal");
    // P1-6b:卡上用户选定配置自带那套→decision=user_selected(凭据成立)
    expect(result["grouping_decision"]).toBe("user_selected");
    expect(result["grouping_candidate_name"]).toBe("配置自带分组");
    const report = String(result["grouping_report"]);
    expect(report).toContain("| 分组 | 字段数 |");
  });

  it("proposal：出原生选项卡（标题＝候选 name，描述＝组名×字段数＋reason），用户选定后内核拿到他选的那套", async () => {
    const ws = tempRoot("c2-card-");
    confirmFields(ws, "pick");
    const asked: Array<Record<string, unknown>> = [];
    const result = await toolOf(ctxOf({ asked, choose: () => "全部平铺成一组" }), mockOf(MOCK_OK)).execute(
      { stage: "experiment_setup", run_id: "pick", workspace_path: ws, grouping_proposal: PROPOSAL },
      fakeExec,
    );
    expect(asked).toHaveLength(1);
    const question = (asked[0]!["questions"] as Array<{
      intent?: unknown;
      multiSelect?: boolean;
      options?: Array<{ label: string; description?: string }>;
    }>)[0]!;
    expect(question.intent).toBeUndefined();
    expect(question.multiSelect).toBe(false);
    expect(question.options?.map((option) => option.label)).toEqual(["按单据/明细两层", "全部平铺成一组"]);
    expect(question.options?.[0]?.description).toBe("2 组：单据级 × 2 个字段、明细级 × 1 个字段；理由：单据头和明细分开，样本按组各一条");
    expect(result["grouping_source"]).toBe("proposal");
    expect(result["grouping_decision"]).toBe("user_selected");
    expect(result["grouping_candidate_name"]).toBe("全部平铺成一组");
    const argv = argvOf(result);
    const index = argv.indexOf("--grouping-proposal");
    expect(index).toBeGreaterThanOrEqual(0);
    // 用户选的那套进了内核：recommended 旗标挪到他选的那个（内核只认 recommended:true）
    const echo = (result["summary"] as {
      grouping_proposal_echo?: { candidates?: Array<{ name?: string; recommended?: boolean }> };
    }).grouping_proposal_echo;
    expect(echo?.candidates?.map((candidate) => [candidate.name, candidate.recommended])).toEqual([
      ["按单据/明细两层", false],
      ["全部平铺成一组", true],
    ]);
    // 临时件退出即删
    expect(existsSync(argv[index + 1]!)).toBe(false);
    // 分组表按用户所选
    expect(String(result["grouping_report"])).toContain("| 全部字段 | 3 |");
  });

  it("完全权限档也必须出卡：传了候选＝在征求用户意见，不得替他静默选定（owner 2026-10-28 改口径）", async () => {
    // 旧口径（§8-1-A：full 档自动选定、不问）已被推翻：
    // 传候选这个动作本身就是「请人来选」，按档位静默替他选，用户连有第二套方案都不知道。
    const ws = tempRoot("c2-auto-");
    confirmFields(ws, "auto");
    const asked: Array<Record<string, unknown>> = [];
    const result = await toolOf(ctxOf({ full: true, asked }), mockOf(MOCK_OK)).execute(
      { stage: "experiment_setup", run_id: "auto", workspace_path: ws, grouping_proposal: PROPOSAL },
      fakeExec,
    );
    // full 档也问分组候选卡（传候选＝请人来选，本次就是它在问选哪套）。
    // ②D90 增强倍数卡的 ask 契约已被 45d705f2 段序修正改写:构造参数卡前有分析
    //   完整性检查,判读缺席/风险件 pending 即跳卡(内核门槛接管指引,分析完整后
    //   下一次调用卡才弹)——本用例 mock 无风险信号/判读,故只有分组卡这一问;
    //   增强卡双态/选项锚在 batch1D210final(判读在场形态)。
    expect(asked).toHaveLength(1);
    const askedHeaders = asked.map(
      (entry) => (entry["questions"] as Array<{ header?: string; options?: Array<{ label: string }> }>)[0]!,
    );
    expect(askedHeaders.map((question) => question.header)).toEqual(["分组"]);
    expect(result["grouping_source"]).toBe("proposal");
    expect(result["grouping_decision"]).toBe("user_selected");
    // 本次 mock 未选任何项 → 落到推荐候选（内核只认 recommended:true）
    expect(result["grouping_candidate_name"]).toBe("按单据/明细两层");
    const evidence = result["grouping_evidence"] as {
      candidate_count: number;
      recommended_index: number;
      recommended_name: string;
      candidates: Array<{ name: string; recommended: boolean; group_count: number }>;
    };
    expect(evidence.candidate_count).toBe(2);
    expect(evidence.recommended_index).toBe(0);
    expect(evidence.recommended_name).toBe("按单据/明细两层");
    expect(evidence.candidates[1]).toEqual({ name: "全部平铺成一组", recommended: false, group_count: 1 });
    expect(String(result["grouping_report"])).toContain("| 单据级 | 2 |");
    expect(argvOf(result)).toContain("--grouping-proposal");
  });

  it("D173 必分组:无候选无分组 → 拦截指路(grouping_candidates_missing),不静默平铺", async () => {
    const ws = tempRoot("c2-none-");
    confirmFields(ws, "plain");
    const asked: Array<Record<string, unknown>> = [];
    const result = await toolOf(ctxOf({ asked }), mockOf(MOCK_OK)).execute(
      { stage: "experiment_setup", run_id: "plain", workspace_path: ws },
      fakeExec,
    );
    // D173 必分组:无候选无分组不再静默平铺——段闸拦截指路提候选
    expect(asked).toHaveLength(0);
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("grouping_candidates_missing");
    expect(String(result["note"])).toContain("必须分组");
    expect(String(result["note"])).toContain("2-3 组");
  });

  it("invalid（harness 侧）：候选形状不合格＝逐条 errors 原样回执，且不触发审批", async () => {
    const ws = tempRoot("c2-bad-");
    confirmFields(ws, "bad");
    const approvals: string[] = [];
    const result = await toolOf(ctxOf({ approvals }), mockOf(MOCK_OK)).execute(
      {
        stage: "experiment_setup",
        run_id: "bad",
        workspace_path: ws,
        grouping_proposal: { schema_version: "GroupingProposal/v1", candidates: [{ name: "空候选", groups: [] }] },
      },
      fakeExec,
    );
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("grouping_proposal_invalid");
    const errors = result["errors"] as string[];
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((line) => line.includes("groups 须为非空数组"))).toBe(true);
    expect(errors.some((line) => line.includes("recommended 缺失"))).toBe(true);
    expect(approvals).toHaveLength(0); // 坏参数不消耗放行
  });

  it("invalid（内核侧）：{ok:false,errors} 的 errors 原样进回执（不压成一句话）", async () => {
    const ws = tempRoot("c2-kbad-");
    confirmFields(ws, "kbad");
    const result = await toolOf(ctxOf({}), mockOf(MOCK_INVALID)).execute(
      { stage: "experiment_setup", run_id: "kbad", workspace_path: ws, grouping_proposal: PROPOSAL },
      fakeExec,
    );
    expect(result["ok"]).toBe(false);
    expect(result["exit_code"]).toBe(2);
    expect(result["grouping_errors"]).toEqual(["candidates[1].groups 须为非空数组", "recommended 须恰好一个候选为 true"]);
  });
});

describe("C2 用户可见面纪律", () => {
  it("工具描述／参数描述／卡面文案零内部词（lane／A、B 预设／批次号）", async () => {
    const tool = toolOf(ctxOf({}), mockOf(MOCK_OK));
    expect(tool.description.toLowerCase()).not.toContain("lane");
    for (const word of ["归组", "货描", "非货描"]) expect(tool.description).not.toContain(word);
    const props = (tool.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
    for (const [key, param] of Object.entries(props)) {
      const description = String(param.description ?? "");
      expect(description.toLowerCase(), `${key} 描述含 lane`).not.toContain("lane");
    }
    // 参数面确实新增了候选位，描述按真实契约（name／recommended／groups[].fields／reason）
    const proposalDescription = String(props["grouping_proposal"]?.description ?? "");
    for (const key of ["name", "recommended", "groups", "fields", "reason"]) {
      expect(proposalDescription, `契约键 ${key} 不在描述里`).toContain(key);
    }
    expect(proposalDescription).not.toContain("candidate_id");
    expect(proposalDescription).not.toContain("recommended_candidate_id");
    const confirm = String(props["grouping_confirm"]?.description ?? "");
    expect(confirm.toLowerCase()).not.toContain("lane");
    expect(confirm).not.toContain("A/B");
    expect(confirm).not.toContain("批次");
    // 分组确认仍按原语义（不传＝未确认，本轮不生成分组样本）——且**用业务话术表述**：
    // 描述里出现内部代号（mode0/mode1/mode5/targeted）模型就会原样复述到用户面（10-29 现场）。
    expect(confirm).toContain("不给＝未确认，本轮不生成分组样本");
    expect(confirm).not.toMatch(/mode[015]|targeted/i);

    // 卡面：审批卡文案也不许出现内部词
    const ws = tempRoot("c2-words-");
    confirmFields(ws, "words");
    const approvals: string[] = [];
    await toolOf(ctxOf({ approvals, choose: (labels) => labels[0]! }), mockOf(MOCK_OK)).execute(
      { stage: "experiment_setup", run_id: "words", workspace_path: ws, grouping_proposal: PROPOSAL },
      fakeExec,
    );
    expect(approvals).toHaveLength(1);
    const reason = approvals[0]!;
    expect(reason.toLowerCase()).not.toContain("lane");
    expect(reason).toContain("分组来源：你在候选里选定的「按单据/明细两层」");
  });
});

describe("F6 回执用户面摘要（atf_pipeline_stage）", () => {
  it("成功回执带 user_summary 三句话（业务语言，不念内部段名）", async () => {
    const ws = tempRoot("f6-ok-");
    confirmFields(ws, "sum");
    const result = await toolOf(ctxOf({}), mockOf(MOCK_OK)).execute(
      { stage: "experiment_setup", run_id: "sum", workspace_path: ws, grouping_proposal: PROPOSAL },
      fakeExec,
    );
    const summary = result["user_summary"] as { conclusion: string; stage: string; next: string };
    expect(summary.conclusion).toBe("实验配置跑完了");
    for (const text of [summary.conclusion, summary.stage, summary.next]) expect(text).not.toContain("experiment_setup");
  });

  it("连续两次失败：第二次带 escalate_to_user 与 failure_count（要用户介入）", async () => {
    const ws = tempRoot("f6-fail-");
    confirmFields(ws, "f6a");
    const bad = { schema_version: "GroupingProposal/v1", candidates: [{ name: "空", groups: [] }] };
    const first = await toolOf(ctxOf({}), mockOf(MOCK_OK)).execute(
      { stage: "experiment_setup", run_id: "f6a", workspace_path: ws, grouping_proposal: bad },
      fakeExec,
    );
    expect(first["ok"]).toBe(false);
    expect(first["escalate_to_user"]).toBeUndefined();
    expect((first["user_summary"] as { conclusion: string }).conclusion).toBe("实验配置没跑成");

    const second = await toolOf(ctxOf({}), mockOf(MOCK_OK)).execute(
      { stage: "experiment_setup", run_id: "f6b", workspace_path: ws, grouping_proposal: bad },
      fakeExec,
    );
    expect(second["escalate_to_user"]).toBe(true);
    expect(second["failure_count"]).toBe(2);
    expect(String((second["user_summary"] as { next: string }).next)).toContain("需要你介入");
  });
});

describe('ci-bl-1103 组数指令闭环（防循环确认）', () => {
  it('custom「分3组」→ 结构化 regroup_request + run 级 marker 落盘 + 强指令 note', async () => {
    const ws = tempRoot('c2-n3-');
    confirmFields(ws, 'n3run');
    const asked: Array<Record<string, unknown>> = [];
    const result = await toolOf(ctxOf({ asked, choose: () => '', custom: '分3组' }), mockOf(MOCK_OK)).execute(
      { stage: 'experiment_setup', run_id: 'n3run', workspace_path: ws, grouping_proposal: PROPOSAL },
      fakeExec,
    );
    expect(asked).toHaveLength(1);
    expect(result['grouping_decision']).toBe('regroup_request');
    expect(JSON.stringify(result)).toContain('必须恰好3组');
    const marker = JSON.parse(readFileSync(join(ws, 'runs', 'n3run', 'runtime', 'webui', 'grouping-request.json'), 'utf8')) as { requested_group_count: number };
    expect(marker.requested_group_count).toBe(3);
  });

  it('marker 在场且候选组数不符 → 拒绝出卡（regroup_required），不再循环确认', async () => {
    const ws = tempRoot('c2-n3b-');
    confirmFields(ws, 'n3gate');
    mkdirSync(join(ws, 'runs', 'n3gate', 'runtime', 'webui'), { recursive: true });
    writeFileSync(join(ws, 'runs', 'n3gate', 'runtime', 'webui', 'grouping-request.json'),
      JSON.stringify({ requested_group_count: 3, raw_text: '分3组', at: new Date().toISOString() }), 'utf-8');
    const asked: Array<Record<string, unknown>> = [];
    const result = await toolOf(ctxOf({ asked }), mockOf(MOCK_OK)).execute(
      { stage: 'experiment_setup', run_id: 'n3gate', workspace_path: ws, grouping_proposal: PROPOSAL },
      fakeExec,
    );
    expect(asked).toHaveLength(0);
    expect(result['grouping_decision']).toBe('regroup_required');
    expect(JSON.stringify(result)).toContain('拒绝出卡');
  });
});
