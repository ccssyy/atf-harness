/**
 * A2 透传回归（2026-11-22）：用户在构造参数卡上的作答原文必须出现在
 * atf_pipeline_stage(experiment_setup) 的返回体（construction_card_answers）。
 *
 * 背景：B3c 把作答原文放进 decideConstructionParams 返回的 card_answers，
 * 但 pipelineFace 消费时丢弃（只落 construction-choice.json 账本）——
 * agent 在任何工具返回面都看不到用户说了什么，B3c 目标在该链路断裂。
 * 本测试经 buildPipelineTool 黑盒真执行 experiment_setup（完全权限档＋
 * visual_readings 在场以进构造闸），锁接通后的行为。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPipelineTool } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

interface DshToolLike {
  name: string;
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>;
}

const tempRoots: string[] = [];
const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  mkdirSync(join(root, "runs"), { recursive: true });
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** experiment_setup 前置：字段确认放行门（run 双形态落 field-choice，同 groupingProposal 测试）。 */
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

const MOCK_OK = "process.stdout.write(JSON.stringify({ schema_version: 'WalkthroughPipelineReport/v1', mode: 'stage', stage: 'experiment_setup', run_id: '', exit_code: 0, ok: true, argv: process.argv.slice(2) }) + '\\n');\n";

const mockOf = (body: string): string => {
  const dir = tempRoot("a2-mock-");
  const path = join(dir, "mock_pipeline.mjs");
  writeFileSync(path, body);
  return path;
};

/** 每问的手打原文（question id 含 augment/targeted/cutoff 时用对应句，否则随口句）。 */
const CUSTOMS: ReadonlyArray<[string, string]> = [
  ["augment", "两倍就行"],
  ["targeted", "智能推导那个"],
  ["cutoff", "9000 吧"],
];

const ctxOfCard = (asked: Array<Record<string, unknown>>): { get(service: string): unknown } => ({
  get(service: string) {
    if (service === "approval") {
      return { request: async () => "allowed-once" };
    }
    if (service === "permissionPresets") {
      return {
        current: () => "danger-full-access",
        resolve: () => ({ sandbox: "danger-full-access" }),
      };
    }
    if (service === "userQuestions") {
      return {
        ask: async (request: Record<string, unknown>) => {
          asked.push(request);
          const questions = request["questions"] as Array<{ id: string; options?: Array<{ label: string }> }>;
          return {
            answers: questions.map((question) => {
              // 分组卡：点选首个候选（让分组面干净落定 user_selected，不干扰本测试焦点）
              if (question.id.startsWith("grouping-")) {
                const label = question.options?.[0]?.label ?? "";
                return { id: question.id, selected: label === "" ? [] : [label] };
              }
              // 构造卡：三问全手打原文（本测试的焦点面）
              const custom = CUSTOMS.find(([key]) => question.id.includes(key))?.[1] ?? "随口一句";
              return { id: question.id, selected: [], custom };
            }),
          };
        },
      };
    }
    return undefined;
  },
});

/** 字段集与 confirmFields 一致的两候选（首候选 recommended——满足出卡构造硬规则）。 */
const PROPOSAL = {
  schema_version: "GroupingProposal/v1",
  candidates: [
    {
      name: "按单据/明细两层",
      recommended: true,
      reason: "单据头和明细分开",
      groups: [
        { name: "单据级", fields: ["doc_identifier", "page_summary"] },
        { name: "明细级", fields: ["goods_name"] },
      ],
    },
    {
      name: "全部平铺成一组",
      recommended: false,
      reason: "不分层",
      groups: [{ name: "平铺", fields: ["doc_identifier", "page_summary", "goods_name"] }],
    },
  ],
};

describe("A2 构造卡作答原文透传（construction_card_answers 进返回体）", () => {
  it("experiment_setup：三问手打原文逐条出现在返回体，不落黑盒", async () => {
    const ws = tempRoot("a2-card-");
    confirmFields(ws, "a2run");
    const asked: Array<Record<string, unknown>> = [];
    const tool = buildPipelineTool(ctxOfCard(asked), "node " + mockOf(MOCK_OK), 30_000) as unknown as DshToolLike;
    const result = await tool.execute(
      { stage: "experiment_setup", run_id: "a2run", workspace_path: ws, visual_readings: { fields: {} }, grouping_proposal: PROPOSAL },
      fakeExec,
    );

    // 构造闸确实弹过卡（三问一屏）
    const constructionAsk = asked.find((request) =>
      ((request["questions"] as Array<{ id: string }>)[0]?.id ?? "").includes("construction-"));
    expect(constructionAsk, "experiment_setup 应弹出构造参数卡").toBeDefined();

    // 透传断言：原文进返回体（此前只落账本，agent 看不到）
    const card = result["construction_card_answers"] as Array<{ field: string; said: string }> | undefined;
    expect(Array.isArray(card), "construction_card_answers 必须在返回体——用户作答原话不得只落账本").toBe(true);
    const saidAll = (card ?? []).map((item) => item.said).join("|");
    expect(saidAll).toContain("两倍就行");
    expect(saidAll).toContain("智能推导那个");
    expect(saidAll).toContain("9000 吧");
    // 决定者凭据同在（既有行为不回归）
    expect(result["construction_decided_by"]).toBe("user");
  });
});
