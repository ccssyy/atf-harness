/**
 * T5 预检卡面回归锚（内核 141a5dec 三节 schema）。
 *
 * 锚点：
 *  ① 三节在场即按「该问的／能推的／推不动的」渲染，缺席回落旧三态清单（向后兼容）；
 *  ② must_ask 逐项业务话（内核 question/why_not_derivable 原样，不改写成参数名），
 *     卡面字段 label＝问句、hint＝为什么推不出来，**零内部键名**；
 *  ③ derivable 折成一行「已按数据自动带入 N 项」＋缩进展开值/依据，不逐项占主视线；
 *  ④ degraded 显式列出并给「原因」；内部断点（step）不上用户面；
 *  ⑤ must_ask > 3 时卡顶提示，原因取内核并清洗掉 must_ask=N / R8 这类内部记号。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { businessOverflowReason, parsePreflightReport, renderPreflightFace } from "../../src/core/workspace/trainingPreflight.js";
import { buildPreflightTool, type PreflightDeps } from "../../packages/extensions/atf-tools/src/preflightFace.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const mockT5 = `node ${join(repoRoot, "tests", "fixtures", "mock_preflight_t5.mjs")}`;
const mockLegacy = `node ${join(repoRoot, "tests", "fixtures", "mock_preflight.mjs")}`;

const tempRoots: string[] = [];
const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const INTERNAL_TOKENS = ["grouping_preset", "token_budget", "preset=", "must_ask", "derivable", "FieldSpec"];

/** 直接跑 mock 拿报告（走真实解析面，保证 schema 与解析同步演进）。 */
const reportOf = async (command: string): Promise<{ dir: string; text: string }> => {
  const dir = join(tempRoot("t5-"), "run-t5");
  mkdirSync(dir, { recursive: true });
  const { execFileSync } = await import("node:child_process");
  const stdout = execFileSync("node", [command.replace(/^node /, ""), "--run-dir", dir], { encoding: "utf8" });
  const parsed = parsePreflightReport(stdout);
  if (!parsed.ok) throw new Error(`报告解析失败：${parsed.error}`);
  return { dir, text: renderPreflightFace(parsed.report) };
};

describe("T5 三节卡面", () => {
  it("must_ask 逐项业务话＋为什么推不出来；derivable 折一行＋展开依据；degraded 给原因", async () => {
    const { text } = await reportOf(mockT5);
    // ① 该问的：业务问句逐条（内核文案原样）
    expect(text).toContain("【需要你确认的（4）】");
    expect(text).toContain("1. 这批训练素材（图片 + 同名标注文件）放在哪个目录？");
    expect(text).toContain("为什么推不出来：run 内没有可用的数据集登记件（登记段未完成或注册引用缺失）");
    expect(text).toContain("4. 训练样本怎么分组？（按单据层级分成一组，还是按必带条目分组）");
    // ② 能推的：一行摘要＋缩进展开（值＋依据），不逐项占主视线
    expect(text).toContain("【已按数据自动带入（2）】已按数据自动带入 2 项（1 项默认生效、1 项待执行）——展开核对：");
    expect(text).toContain("· 9000 tokens（来自实验门确认值） —— 依据：实验门已确认的预算");
    expect(text).toContain("· 待执行 —— 依据：预算就绪后整批重算");
    // ③ 推不动的：显式列出＋原因
    expect(text).toContain("【本来能自动推、但推不出来的（1）】");
    expect(text).toContain("1. 每类样本的归属没读出来");
    expect(text).toContain("原因：准入 lane 事实要读的那份标注清单不在场");
    // ④ 软上限提示在卡顶，原因已业务化（内部记号清零）
    expect(text.split("\n")[0]).toContain("这次需要你确认的项偏多（4 项）");
    expect(text).toContain("这些项互不替代");
  });

  it("用户面零内部键名/内部断点：问题项 id、must_ask=N、R8、step 一律不出现", async () => {
    const { text } = await reportOf(mockT5);
    for (const token of INTERNAL_TOKENS) expect(text, token).not.toContain(token);
    expect(text).not.toContain("must_ask=4");
    expect(text).not.toContain("R8");
    expect(text).not.toContain("registry:DatasetRegistration");
    expect(text).not.toContain("preset=B");
  });

  it("旧内核（无三节）报告回落三态清单（向后兼容，不因缺节拒收）", async () => {
    const { text } = await reportOf(mockLegacy);
    expect(text).toContain("【derivable——可自动执行（2）】");
    expect(text).toContain("【needs_confirm——业务确认（1）】");
    expect(text).not.toContain("【已按数据自动带入");
  });

  it("overflow 原因清洗单源：去 must_ask=N 前缀与 R8 括注，保留业务解释", () => {
    const cleaned = businessOverflowReason(
      "must_ask=5 超过软上限 3:这些项互不替代,合并提问会丢业务取舍(R8 软上限,非硬拒绝)",
    );
    expect(cleaned).toBe("这些项互不替代,合并提问会丢业务取舍");
    expect(businessOverflowReason(undefined)).toBe("");
    expect(businessOverflowReason("这些项互不替代")).toBe("这些项互不替代");
  });
});

describe("T5 预检卡装配（问句即业务话，apply 行为业务话）", () => {
  const ctxWithAsk = (asked: Array<Record<string, unknown>>) => ({
    get: (service: string) => {
      if (service === "userQuestions") {
        return {
          ask: async (request: Record<string, unknown>) => {
            asked.push(request);
            return { answers: [{ id: "preflight-t5", selected: [] }] };
          },
        };
      }
      if (service === "approval") return { request: async () => "allowed-once" };
      return undefined;
    },
  });

  it("卡面：label＝问句、hint＝为什么推不出来、apply 行不列内部 id", async () => {
    const root = tempRoot("t5-card-");
    const asks: Array<Record<string, unknown>> = [];
    const deps: PreflightDeps = { command: mockT5, timeoutMs: 20_000, runsRoot: root, ctx: ctxWithAsk(asks) as unknown as PreflightDeps["ctx"] };
    const tool = buildPreflightTool(deps) as unknown as { execute: (a: unknown, e: unknown) => Promise<unknown> };
    const runId = "run-t5-card";
    mkdirSync(join(root, runId), { recursive: true });
    writeFileSync(join(root, runId, "run.json"), "{}");
    const result = (await tool.execute({ run_id: runId }, { agent: { session: { id: "s" } }, callId: "t5", signal: undefined })) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(asks).toHaveLength(1);
    const question = (asks[0]!["questions"] as Array<{ id: string; detail?: string; intent?: { fields?: Array<{ key: string; label: string; hint?: string; placeholder?: string }> } }>)[0]!;
    const fields = question.intent?.fields ?? [];
    // 问句即业务话（label），key 只作结构化回传不显示
    expect(fields.map((field) => field.label)).toContain("这批训练素材（图片 + 同名标注文件）放在哪个目录？");
    expect(fields.map((field) => field.label)).toContain("训练样本怎么分组？（按单据层级分成一组，还是按必带条目分组）");
    const grouping = fields.find((field) => field.label.includes("训练样本怎么分组"))!;
    expect(grouping.hint).toContain("为什么推不出来：分组必须用户确认");
    // apply 行：业务话，不列内部 id
    const apply = fields.find((field) => field.key === "apply_derivables")!;
    expect(apply.label).toContain("把能自动算的 1 项一并算好");
    expect(apply.placeholder ?? "").not.toContain("coordinate_pending");
    // 卡面 detail 同样零内部键名
    const detail = String(question.detail ?? "");
    for (const token of INTERNAL_TOKENS) expect(detail, token).not.toContain(token);
    expect(detail).toContain("这次需要你确认的项偏多（4 项）");
  });

  it("apply=true：派生项执行后卡面转为已生效（待执行清零）", async () => {
    const root = tempRoot("t5-apply-");
    const asks: Array<Record<string, unknown>> = [];
    const deps: PreflightDeps = { command: mockT5, timeoutMs: 20_000, runsRoot: root, ctx: ctxWithAsk(asks) as unknown as PreflightDeps["ctx"] };
    const tool = buildPreflightTool(deps) as unknown as { execute: (a: unknown, e: unknown) => Promise<unknown> };
    const runId = "run-t5-apply";
    mkdirSync(join(root, runId), { recursive: true });
    writeFileSync(join(root, runId, "run.json"), "{}");
    const result = (await tool.execute({ run_id: runId, apply: true }, { agent: { session: { id: "s" } }, callId: "t5a", signal: undefined })) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["applied"]).toBe(true);
    const checklist = String(result["checklist"]);
    expect(checklist).toContain("已按数据自动带入 2 项（已全部默认生效）");
  });
});
