/**
 * 根治刀（1113）测试锚——experiment_setup 返回体透传内核 grouping_template。
 *
 * 内核＝proposal_template 机械生成单源（CI 轮漏 shipper 根治：agent 只照抄改归属，
 * 字段罗列动作消失）；harness 只透传不拼装：summary 带则原样透传（experiment_setup
 * 段 gate），不带不造键（不造缺省模板），其它段带也不透传。
 * mock 对端＝内联脚本（stdout JSON report 可控，与 mock_pipeline_params.mjs 同形态）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPipelineTool } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

interface DshToolLike {
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

const TEMPLATE = {
  schema_version: "GroupingProposal/v1",
  candidates: [
    {
      name: "示例候选（照抄后按业务改名）",
      recommended: true,
      reason: "示例：说明该候选的分组依据（按版式或业务语义）",
      groups: [
        { name: "示例组A（照抄后改分组归属）", fields: ["f1", "f2"] },
        { name: "示例组B（照抄后改分组归属）", fields: ["f3"] },
      ],
    },
  ],
};

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "rootcut-tpl-"));
  tempRoots.push(root);
  mkdirSync(join(root, "runs"), { recursive: true });
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeExec = { agent: undefined, callId: "rootcut-call", signal: undefined };
const approvalCtx = (): { get(service: string): unknown } => ({
  get: (service: string) =>
    (service === "approval"
      ? { request: async () => "allowed-once" }
      : undefined),
});

/** 内联 mock：stdout report 恒带 grouping_template（段 gate 由 harness 侧负责）。 */
const mockScriptOf = (withTemplate: boolean): string => {
  const script = join(mkdtempSync(join(tmpdir(), "rootcut-mock-")), "mock.mjs");
  writeFileSync(script, [
    "#!/usr/bin/env node",
    "const argv = process.argv.slice(2);",
    "const stage = argv[argv.indexOf('--stage') + 1];",
    "const runId = argv[argv.indexOf('--run-id') + 1] ?? '';",
    `const TEMPLATE = ${JSON.stringify(TEMPLATE)};`,
    `const WITH_TPL = ${withTemplate ? "true" : "false"};`,
    "const report = { schema_version: 'WalkthroughPipelineReport/v1', mode: 'stage', stage, run_id: runId, exit_code: 0, ok: true, argv };",
    "if (WITH_TPL) report.grouping_template = TEMPLATE;",
    "console.log(JSON.stringify(report));",
  ].join("\n"), "utf-8");
  return script;
};

const withFieldChoice = (ws: string, runId: string): string => {
  mkdirSync(join(ws, "runs", runId, "webui"), { recursive: true });
  writeFileSync(join(ws, "runs", runId, "webui", "field-choice.json"),
    JSON.stringify({ schema_version: "FieldChoice/v1", confirmed_fields: ["f1", "f2"] }));
  return ws;
};

const toolOf = (mock: string): DshToolLike =>
  buildPipelineTool(approvalCtx(), `node ${mock}`, 30_000) as unknown as DshToolLike;

/** D173 必分组闸（harness 侧先于内核）：experiment_setup 用例统一带分组候选过闸。 */
const D173_PROPOSAL = {
  schema_version: "GroupingProposal/v1",
  candidates: [
    {
      name: "两层", recommended: true, reason: "单据头/明细分开",
      groups: [{ name: "单据级", fields: ["f1", "f2"] }, { name: "明细级", fields: ["f3"] }],
    },
  ],
};

describe("根治刀——grouping_template 透传（experiment_setup 段）", () => {
  it("内核 summary 带模板 → 返回体逐字透传", async () => {
    const result = (await toolOf(mockScriptOf(true)).execute(
      { stage: "experiment_setup", run_id: "rootcut-tpl-on", grouping_proposal: D173_PROPOSAL, workspace_path: withFieldChoice(tempRoot(), "rootcut-tpl-on") },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["grouping_template"]).toEqual(TEMPLATE);
  });

  it("内核 summary 不带 → 返回体无 grouping_template 键（不造缺省模板）", async () => {
    const result = (await toolOf(mockScriptOf(false)).execute(
      { stage: "experiment_setup", run_id: "rootcut-tpl-off", grouping_proposal: D173_PROPOSAL, workspace_path: withFieldChoice(tempRoot(), "rootcut-tpl-off") },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect("grouping_template" in result).toBe(false);
  });

  it("其它段（register）内核带模板也不透传（段 gate）", async () => {
    const ws = tempRoot();
    const result = (await toolOf(mockScriptOf(true)).execute(
      { stage: "register", run_id: "rootcut-tpl-reg", source_root: ws, workspace_path: ws },
      fakeExec,
    )) as Record<string, unknown>;
    expect("grouping_template" in result).toBe(false);
  });
});
