/**
 * 批次 R H1 测试锚（TokenBudget 九要素卡＋别名退役＋错误回流，2026-10-22）：
 *   H1-1 三要素渲染｜两条不变式关系校验（不成立禁确认）｜不同步须理由｜无 65536 预填
 *        （confirmFace 卡面＋atf-ui web 面双处同源断言）；
 *   H1-2 TRAINING_PIN_CONSTANTS 改值 9000（惯例基线 owner 2026-10-22）＋cutoff/max_model_len
 *        单源独立扩展；agentRecommend 推荐路径钉住（正整数/带理由/不夹取）；
 *        max_model_token 别名退役 grep 锚（源码面零命中）；
 *   H1-3 内核错误码人话回流（四码映射纯函数＋pipelineFace 构造段接线——内核 v0.7.24b0
 *        未发版，测试以构造错误对象驱动展示层）。
 * 常量/键面锚与 tests/dshTools/batchW.test.ts F1 同步（改值同批）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TRAINING_PIN_CONSTANTS, checkTokenBudget } from "../../src/core/workspace/smartDefaults.js";
import {
  CONFIG_CONFIRM_KEYS,
  buildConfigConfirmFields,
  renderPixelPairRows,
  renderTokenBudgetRows,
  thousandsOf,
  tokenBudgetSourceNoteOf,
  TOKEN_BUDGET_KEYS,
} from "../../src/webui/configConfirm.js";
import { evalAgentRecommend } from "../../src/core/workspace/agentRecommend.js";
import { configFormFieldsOf, domainHintOf, pixelPairChangeNoteOf, pixelPairViolationNoteOf, tokenBudgetCheckOf, tokenBudgetFaceText, type ConfigConfirmField } from "../../packages/extensions/atf-tools/src/confirmFace.js";
import { buildConfirmTools } from "../../packages/extensions/atf-tools/src/confirmFace.js";
import { buildLaunchSurface } from "../../packages/extensions/atf-ui/src/server.js";
import { humanizeKernelError, scanKernelErrorFace, KERNEL_ERROR_FACE_CODES } from "../../src/core/workspace/kernelErrorFace.js";
import { buildPipelineTool } from "../../packages/extensions/atf-tools/src/pipelineFace.js";
import { buildEvalTools } from "../../packages/extensions/atf-tools/src/trainingFace.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "h1-tbc-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- H1-1 关系校验（纯函数单源）

describe("批次 R H1-1——checkTokenBudget 两条不变式＋同步理由校验", () => {
  it("基线惯例值 9000/9000/12800 恒通过（violations 空、无需理由）", () => {
    const check = checkTokenBudget({ maxTotalTokens: "9000", cutoffLen: "9000", maxModelLen: "12800" });
    expect(check.violations).toEqual([]);
    expect(check.needsSync).toBe(false);
  });
  it("预算 > cutoff → 「预算超过训练截断，训练会截断样本」红字（指令原句）", () => {
    const check = checkTokenBudget({ maxTotalTokens: "10000", cutoffLen: "9000", maxModelLen: "12800" });
    expect(check.violations.some((v) => v.includes("预算超过训练截断，训练会截断样本"))).toBe(true);
    expect(check.violations.some((v) => v.includes("10000") && v.includes("9000"))).toBe(true);
  });
  it("预算 > max_model_len → 「预算超过推理窗口」红字", () => {
    const check = checkTokenBudget({ maxTotalTokens: "20000", cutoffLen: "20000", maxModelLen: "12800" });
    expect(check.violations.some((v) => v.includes("预算超过推理窗口"))).toBe(true);
  });
  it("预算 ≠ cutoff（小于侧）：无理由＝禁确认；填理由＝通过（同步是用户动作不自动）", () => {
    const noReason = checkTokenBudget({ maxTotalTokens: "8000", cutoffLen: "9000", maxModelLen: "12800" });
    expect(noReason.needsSync).toBe(true);
    expect(noReason.violations.some((v) => v.includes("不等") && v.includes("理由"))).toBe(true);
    const withReason = checkTokenBudget({ maxTotalTokens: "8000", cutoffLen: "9000", maxModelLen: "12800" }, { syncReason: "窗口余量试验" });
    expect(withReason.violations).toEqual([]);
  });
  it("值缺失/非法＝fail-closed violation（不猜）", () => {
    for (const bad of ["", "0", "-5", "1.5", undefined] as const) {
      const check = checkTokenBudget({ maxTotalTokens: bad, cutoffLen: "9000", maxModelLen: "12800" });
      expect(check.violations.some((v) => v.includes("须为正整数"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- H1-1 三要素区渲染（单源）

describe("批次 R H1-1——renderTokenBudgetRows 三行同屏渲染（卡面/web 面单源）", () => {
  const rowsOf = (overrides: Partial<Record<"max_total_tokens" | "cutoff_len" | "max_model_len", { value: string; tag?: string }>>): string[] => {
    const base: ConfigConfirmField[] = TOKEN_BUDGET_KEYS.map((key) => ({
      key,
      value: overrides[key]?.value ?? ({ max_total_tokens: "9000", cutoff_len: "9000", max_model_len: "12800" })[key],
      tag: (overrides[key]?.tag ?? "default_used") as ConfigConfirmField["tag"],
    }));
    return renderTokenBudgetRows(base);
  };
  it("三行：预算可编辑/惯例基线、cutoff 只读/= 预算、推理窗口只读/独立取值（9000/9000/12800）", () => {
    const rows = rowsOf({});
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("单样本 token 预算");
    expect(rows[0]).toContain("max_total_tokens");
    expect(rows[0]).toContain("可编辑");
    expect(rows[0]).toContain("9000");
    expect(rows[0]).toContain("[惯例基线（owner 2026-10-22）]");
    expect(rows[1]).toContain("训练截断 cutoff");
    expect(rows[1]).toContain("只读");
    expect(rows[1]).toContain("[= 预算]");
    expect(rows[2]).toContain("推理窗口");
    expect(rows[2]).toContain("max_model_len");
    expect(rows[2]).toContain("12800");
    expect(rows[2]).toContain("[独立取值]");
    // 无 65536 预填（三要素区任何行不出现 65536）
    expect(rows.some((row) => row.includes("65536"))).toBe(false);
  });
  it("来源标注：用户改值（need_confirm）＝用户指定；等值破坏时 cutoff 行标「≠ 预算（须同步 cutoff 或填理由）」", () => {
    const rows = rowsOf({ max_total_tokens: { value: "10000", tag: "need_confirm" } });
    expect(rows[0]).toContain("[用户指定]");
    expect(rows[1]).toContain("≠ 预算（须同步 cutoff 或填理由）");
    expect(tokenBudgetSourceNoteOf("agent_recommend")).toContain("agent 推荐");
  });
  it("tokenBudgetFaceText：三要素区文本含红字 ⚠ violations 行（confirmFace 卡面/审批卡/pending 共用）", () => {
    const fields: ConfigConfirmField[] = [
      { key: "max_total_tokens", value: "10000", tag: "need_confirm" },
      { key: "cutoff_len", value: "9000", tag: "default_used" },
      { key: "max_model_len", value: "12800", tag: "default_used" },
    ];
    const check = tokenBudgetCheckOf(fields, "");
    expect(check.violations.length).toBeGreaterThan(0);
    const text = tokenBudgetFaceText(fields, check.violations);
    expect(text).toContain("TokenBudget（三要素）:");
    expect(text).toContain("单样本 token 预算");
    expect(text.split("\n").some((line) => line.startsWith("⚠ ") && line.includes("预算超过训练截断"))).toBe(true);
  });
});

// ---------------------------------------------------------------- H1-2 键面与 grep 锚

describe("批次 R H1-2——键面：三键入卡＋无 65536 预填＋表单卡只读面", () => {
  it("buildConfigConfirmFields 缺省面：max_total_tokens=9000（非空非 65536）；max_model_len=12800", () => {
    const byKey = Object.fromEntries(buildConfigConfirmFields({}, {}).map((f) => [f.key, f]));
    expect(byKey["max_total_tokens"]).toMatchObject({ value: String(TRAINING_PIN_CONSTANTS.max_total_tokens), tag: "default_used" });
    expect(byKey["max_total_tokens"]?.value).not.toBe("65536");
    expect(byKey["cutoff_len"]?.value).toBe("9000");
    expect(byKey["max_model_len"]?.value).toBe("12800");
    expect(CONFIG_CONFIRM_KEYS.some((entry) => entry.key === "max_model_len")).toBe(true);
  });
  it("configFormFieldsOf：max_model_len 只读无输入框；理由行不入配置键集", () => {
    const fields: ConfigConfirmField[] = buildConfigConfirmFields({}, {}) as ConfigConfirmField[];
    const rows = configFormFieldsOf(fields, null);
    expect(rows.some((row) => row.key === "max_model_len")).toBe(false);
    expect(rows.some((row) => row.key === "max_total_tokens")).toBe(true);
  });
});

describe("批次 R H1-2——别名退役与 65536 退役 grep 锚（源码面）", () => {
  /** 配置链源码面（live 文件集——confirmFace 卡面/configConfirm 键表/smartDefaults 单源/
   *  agentRecommend 护栏/atf-ui server web 面/client 渲染/kernelErrorFace 错误回流）。 */
  const faces = [
    "src/webui/configConfirm.ts",
    "src/core/workspace/smartDefaults.ts",
    "src/core/workspace/agentRecommend.ts",
    "src/core/workspace/kernelErrorFace.ts",
    "packages/extensions/atf-tools/src/confirmFace.ts",
    "packages/extensions/atf-ui/src/server.ts",
    "packages/extensions/atf-ui/client.js",
  ].map((rel) => join(import.meta.dirname, "../..", rel));
  it("max_model_token 别名零命中（F21 别名退役——UI/工具只认 max_total_tokens）", () => {
    for (const file of faces) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/max_model_token/);
    }
  });
  it("max_total_tokens 与 65536 不共存于任何一行（65536 域参考值全链退役；像素 65536 无关行不受限）", () => {
    for (const file of faces) {
      const src = readFileSync(file, "utf8");
      for (const line of src.split("\n")) {
        if (line.includes("max_total_tokens")) {
          expect(line, `${file}: ${line}`).not.toMatch(/65536|65_536/);
        }
      }
    }
  });
});

// ---------------------------------------------------------------- H1-2 agentRecommend 钉住

describe("批次 R H1-2——agentRecommend cutoff/max_total_tokens 推荐路径钉住（正整数/带理由/不夹取）", () => {
  it("cutoff_len：域内正整数原样采纳（不夹取）；越界（>12800）/非整数拦截回退＋可读理由", () => {
    const ok = evalAgentRecommend("cutoff_len", "10000", "9000", "长样本试验");
    expect(ok.accepted).toBe(true);
    expect(ok.terminal).toBe("10000"); // 不 Math.min/max 静默收窄
    expect(ok.source).toContain("default:agent-recommend:");
    expect(ok.source).toContain("长样本试验");
    const over = evalAgentRecommend("cutoff_len", 20000, "9000", "r");
    expect(over.accepted).toBe(false);
    expect(over.terminal).toBe("9000"); // 回退基线建议（非夹取值）
    expect(over.note).toContain("cutoff ≤ 12800");
    expect(evalAgentRecommend("cutoff_len", "1.5", "9000").accepted).toBe(false);
  });
  it("max_total_tokens：正整数原样采纳（无上限夹取——关系校验归 checkTokenBudget 终检）；非正整数拦截", () => {
    const big = evalAgentRecommend("max_total_tokens", "30000", "9000", "大预算");
    expect(big.accepted).toBe(true);
    expect(big.terminal).toBe("30000"); // 推荐层不做关系夹取（20000>12800 也不收窄——不静默）
    expect(evalAgentRecommend("max_total_tokens", "0", "9000").accepted).toBe(false);
    expect(evalAgentRecommend("max_total_tokens", "2.5", "9000").accepted).toBe(false);
    expect(evalAgentRecommend("max_total_tokens", "abc", "9000").accepted).toBe(false);
    // 无理由如实标注（briefOf「未附理由」）
    expect(evalAgentRecommend("max_total_tokens", "9000", "9000").source).toContain("未附理由");
  });
});

// ---------------------------------------------------------------- H1-1 confirmFace 手动档集成（禁确认/理由）

describe("批次 R H1-1——confirmFace 手动档：关系不成立禁确认＋不同步须填理由（服务端闸）", () => {
  /** 表单卡假件（可编程应答序列＋请求捕获——末次 ASK_CANCELLED 退出循环）。 */
  const formCtx = (scripted: string[][]) => {
    const asks: Array<{ detail?: string; fields?: Array<{ key: string }> }> = [];
    let calls = 0;
    return {
      asks,
      ctx: {
        get: (service: string) => {
          if (service === "approval") return { request: async () => "allowed-once" };
          if (service === "userQuestions") {
            return {
              ask: async (req: { questions?: Array<{ id?: string; intent?: { fields?: Array<{ key: string }> }; detail?: string }> }) => {
                // 形态分流：决策卡不占表单卡脚本步
                if ((req.questions ?? []).every((item) => item.intent === undefined)) {
                  // 决策卡不记入 asks（asks 是表单卡日志——索引断言按表单卡计数）
                  return { answers: (req.questions ?? []).map((item) => ({ id: item.id ?? "choice", selected: [] })) };
                }
                calls += 1;
                const question = req.questions?.[0];
                asks.push({ detail: question?.detail, fields: question?.intent?.fields });
                if (calls > scripted.length) throw Object.assign(new Error("cancelled by user"), { code: "ASK_CANCELLED" });
                return { answers: [{ id: "config-confirm-x", selected: scripted[calls - 1] ?? [] }] };
              },
            };
          }
          return undefined;
        },
      },
    };
  };
  const execTool = async (ctx: { get: (s: string) => unknown }, args: Record<string, unknown>) => {
    const root = tempRoot();
    const tools = buildConfirmTools({ runsRoot: root, ctx, gpuProbe: () => 8 }) as Array<{ name: string; execute: (a: unknown, e: unknown) => Promise<unknown> }>;
    const tool = tools.find((t) => t.name === "atf_config_confirm")!;
    const result = (await tool.execute(args, { agent: undefined, callId: "h1-c1", signal: undefined })) as Record<string, unknown>;
    return { root, result };
  };
  const snapshotOf = (root: string): Record<string, string> | null =>
    existsSync(join(root, "run-tb", "webui", "config-snapshot.json"))
      ? ((JSON.parse(readFileSync(join(root, "run-tb", "webui", "config-snapshot.json"), "utf8")) as { confirmed: Record<string, string> }).confirmed)
      : null;

  it("预算 20000 > cutoff 9000：表单卡红字重呈（detail 含指令原句）＋不进审批＝快照不落盘", async () => {
    const face = formCtx([["max_total_tokens=20000"]]);
    const { root, result } = await execTool(face.ctx, { action: "present", run_id: "run-tb" });
    expect(result).toMatchObject({ error: "approval_denied", outcome: "cancelled" }); // 红字重呈后用户取消＝结构化退出
    expect(snapshotOf(root)).toBeNull(); // 禁确认：快照未落盘
    // 第二轮表单卡 detail 含红字（第一轮提交 20000 → violations → continue 重呈）
    expect(face.asks.length).toBe(2);
    expect(face.asks[1]?.detail ?? "").toContain("预算超过训练截断，训练会截断样本");
    expect(face.asks[1]?.detail ?? "").toContain("TokenBudget（三要素）:");
    // 三要素区行在 detail 同屏（三项渲染）
    expect(face.asks[1]?.detail ?? "").toContain("单样本 token 预算");
    expect(face.asks[1]?.detail ?? "").toContain("推理窗口");
  });
  it("预算 8000 ≠ cutoff 9000 无理由＝禁确认；补理由＝放行落快照（理由不落配置键）", async () => {
    const denied = formCtx([["max_total_tokens=8000"]]);
    const d = await execTool(denied.ctx, { action: "present", run_id: "run-tb" });
    expect(d.result).toMatchObject({ error: "approval_denied", outcome: "cancelled" });
    expect(denied.asks[1]?.detail ?? "").toContain("不等");
    expect(snapshotOf(d.root)).toBeNull();
    const allowed = formCtx([["max_total_tokens=8000", "token_budget_sync_reason=窗口余量试验"]]);
    const a = await execTool(allowed.ctx, { action: "present", run_id: "run-tb" });
    expect(a.result).toMatchObject({ ok: true, confirmed: true });
    const snap = snapshotOf(a.root);
    expect(snap?.["max_total_tokens"]).toBe("8000");
    expect(snap && "token_budget_sync_reason" in snap).toBe(false); // 理由是校验输入，不是配置键
  });
  it("预算 20000 超 cutoff：即使填理由也不放行（不变式违反红字优先，理由救不了）", async () => {
    const face = formCtx([["max_total_tokens=20000", "token_budget_sync_reason=就想试试"]]);
    const { root, result } = await execTool(face.ctx, { action: "present", run_id: "run-tb" });
    expect(result).toMatchObject({ error: "approval_denied", outcome: "cancelled" });
    expect(face.asks[1]?.detail ?? "").toContain("预算超过训练截断");
    expect(snapshotOf(root)).toBeNull();
  });
});

// ---------------------------------------------------------------- H1-1 全自动档终检

describe("批次 R H1-1——confirmFace 全自动档：落快照前 TokenBudget 终检（fail-closed）", () => {
  // 训练自动驾驶＝两轴齐备（预设 atf-training ＋ 权限档 danger-full-access）
  const autoCtx = (service: string): unknown => {
    if (service === "permissionPresets") return { current: () => "danger-full-access", resolve: () => ({ sandbox: "danger-full-access" }) };
    if (service === "sessionProjections") return { stateOf: (_s: unknown, key: string) => (key === "agentPreset" ? "atf-training" : undefined) };
    return undefined;
  };
  const execAuto = async (recommend: Record<string, unknown>) => {
    const root = tempRoot();
    const tools = buildConfirmTools({ runsRoot: root, ctx: { get: autoCtx }, gpuProbe: () => 8 }) as Array<{ name: string; execute: (a: unknown, e: unknown) => Promise<unknown> }>;
    const tool = tools.find((t) => t.name === "atf_config_confirm")!;
    const result = (await tool.execute(
      { action: "present", run_id: "run-tb", recommend },
      { agent: { session: { id: "sess-auto" } }, callId: "h1-c2", signal: undefined },
    )) as Record<string, unknown>;
    return { root, result };
  };
  it("推荐 max_total_tokens=20000（>cutoff）→ 拒绝落快照（token_budget_invariant_violated）", async () => {
    const { root, result } = await execAuto({ max_total_tokens: 20000, reason: "大预算" });
    expect(result).toMatchObject({ ok: false, error: "token_budget_invariant_violated" });
    expect(String(result.note)).toContain("预算超过训练截断");
    expect(existsSync(join(root, "run-tb", "webui", "config-snapshot.json"))).toBe(false);
  });
  it("推荐 max_total_tokens=8000（≠cutoff）带理由 → 放行落快照（reason 兼作不同步理由）", async () => {
    const { root, result } = await execAuto({ max_total_tokens: 8000, reason: "小预算试验" });
    expect(result).toMatchObject({ ok: true, auto: true });
    const snap = JSON.parse(readFileSync(join(root, "run-tb", "webui", "config-snapshot.json"), "utf8")) as { confirmed: Record<string, string> };
    expect(snap.confirmed["max_total_tokens"]).toBe("8000");
  });
});

// ---------------------------------------------------------------- H1-1 atf-ui web 面

describe("批次 R H1-1——atf-ui web 面：buildLaunchSurface token_budget 三要素＋前端校验", () => {
  const seedRun = (training: Record<string, unknown>): string => {
    const root = tempRoot();
    const runDir = join(root, "run-w");
    mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
    writeFileSync(join(runDir, "prep", "iteration-config", "iteration-config.json"), JSON.stringify({ training }));
    return root;
  };
  it("缺省面：三行（9000/9000/12800，惯例基线标注）＋violations 空", () => {
    const root = seedRun({ cutoff_len: 9000 });
    const surface = buildLaunchSurface(join(root, "run-w"));
    expect(surface.token_budget.rows).toHaveLength(3);
    expect(surface.token_budget.rows[0]).toContain("9000");
    expect(surface.token_budget.rows[0]).toContain("[惯例基线（owner 2026-10-22）]");
    expect(surface.token_budget.rows[2]).toContain("12800");
    expect(surface.token_budget.violations).toEqual([]);
    // 摘要行同屏：max_model_len 入 IterationConfig 摘要（web 面三键齐）
    const keys = surface.summary.map((row) => row.key);
    for (const key of TOKEN_BUDGET_KEYS) expect(keys).toContain(key);
  });
  it("登记值 20000 > cutoff 9000 → 前端校验红字（violations 非空——确认卡侧同源禁确认）", () => {
    const root = seedRun({ max_total_tokens: 20000, cutoff_len: 9000 });
    const surface = buildLaunchSurface(join(root, "run-w"));
    expect(surface.token_budget.violations.some((v) => v.includes("预算超过训练截断，训练会截断样本"))).toBe(true);
  });
  it("client.js 渲染面：TokenBudget 区块与红字样式类在位", () => {
    const source = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    expect(source).toContain("launch.token_budget");
    expect(source).toContain("atf-train-budget-viol");
    expect(source).toContain("TokenBudget 三要素");
  });
});

// ---------------------------------------------------------------- H1-3 错误回流人话

describe("批次 R H1-3——kernelErrorFace 人话映射（提前接线；D98 扩五码）", () => {
  it("闭集文案：既有四码要点＋下一步指引；D98 run 落点非空文案零内部码；未知码 null（不猜）", () => {
    expect(humanizeKernelError("token_budget_missing")).toContain("预算文件缺失，先确认实验配置");
    expect(humanizeKernelError("token_budget_missing")).toContain("下一步");
    const inconsistent = humanizeKernelError("token_budget_inconsistent:cutoff_len_mismatch:8000≠9000");
    expect(inconsistent).toContain("8000≠9000"); // 展示两值
    expect(inconsistent).toContain("max_total_tokens / cutoff_len / max_model_len"); // 指到对应字段
    expect(humanizeKernelError("token_gate_not_configured")).toContain("数据构造未配置 token 审计，已拒绝构造");
    expect(humanizeKernelError("token_gate_not_configured")).toContain("--token-provider");
    const gpu = humanizeKernelError("gpu_capacity_insufficient", { gpuFreeRows: ["GPU 0: util 5%, mem 1024/81920 MiB, free 80896 MiB"] });
    expect(gpu).toContain("每卡 free");
    expect(gpu).toContain("GPU 0");
    expect(gpu).toContain("不自动降档");
    const notEmpty = humanizeKernelError("walkthrough_run_dir_not_empty");
    expect(notEmpty).toContain("登记被拒");
    // E8b H1（内核 b13 起）：本码收缩为「非空但缺合法 run.json」兜底——指补齐 run.json，不引导换 run
    expect(notEmpty).toContain("run.json");
    expect(notEmpty).toContain("同一 run 继续登记其它单据是被允许的");
    expect(notEmpty).not.toContain("换一个新 run 标识"); // 旧口径（N+1 诱因）不回流
    expect(notEmpty).not.toContain("walkthrough_run_dir_not_empty"); // B6 锚：拒绝文案无内部码
    expect(humanizeKernelError("some_unknown_code")).toBeNull();
    expect(KERNEL_ERROR_FACE_CODES.size).toBe(5); // D98：四码→五码
  });
  it("scanKernelErrorFace：错误文本（构造的错误对象串）命中带 detail 码；未命中 null", () => {
    const hit = scanKernelErrorFace(['{"error": "token_gate_not_configured"}']);
    expect(hit?.code).toBe("token_gate_not_configured");
    expect(hit?.note).toContain("数据构造未配置 token 审计");
    const detailed = scanKernelErrorFace(["stderr: token_budget_inconsistent:max_total_tokens 20000 > cutoff_len 9000"]);
    expect(detailed?.code.startsWith("token_budget_inconsistent:")).toBe(true);
    expect(detailed?.note).toContain("max_total_tokens 20000 > cutoff_len 9000");
    expect(scanKernelErrorFace(["Traceback (most recent call last): boom"])).toBeNull();
    expect(scanKernelErrorFace([])).toBeNull();
  });
  it("pipelineFace 接线：构造段失败输出含已知码 → note 人话＋返回体零码（D77；未命中 note 不变）", async () => {
    const root = tempRoot();
    const fakeKernel = join(root, "fake_kernel.py");
    writeFileSync(fakeKernel, [
      "import sys",
      "sys.stderr.write('{\"error\": \"token_gate_not_configured\"}')",
      "sys.exit(2)",
      "",
    ].join("\n"));
    const ctx = { get: (s: string) => (s === "approval" ? { request: async () => "allowed-once" } : undefined) };
    const tool = buildPipelineTool(ctx, `python3 ${fakeKernel}`, 30_000) as { execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>> };
    const result = (await tool.execute({ stage: "register", run_id: "r1", workspace_path: root, source_root: join(root, "src") }, { agent: undefined, callId: "h1-c3", signal: undefined })) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    // D77：完整码不进模型可见返回体（键移除；码原文不随返回体回流）
    expect("kernel_error" in result).toBe(false);
    expect(String(result["note"])).toContain("数据构造未配置 token 审计，已拒绝构造");
    // 未命中面：普通失败 note 保持既有形态（不覆盖）
    const fakePlain = join(root, "fake_plain.py");
    writeFileSync(fakePlain, "import sys\nsys.stderr.write('boom')\nsys.exit(2)\n");
    const plainTool = buildPipelineTool(ctx, `python3 ${fakePlain}`, 30_000) as { execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>> };
    const plain = (await plainTool.execute({ stage: "register", run_id: "r1", workspace_path: root, source_root: join(root, "src") }, { agent: undefined, callId: "h1-c4", signal: undefined })) as Record<string, unknown>;
    expect(plain["kernel_error"]).toBeUndefined();
    expect(String(plain["note"])).not.toContain("token 审计");
  }, 30_000);
  it("eval 面接线（R-H 实锚）：缺预算 run 的服务件生成失败 → note 人话＋无 stderr_tail（未命中保持 machine_facts_missing）", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-h1e");
    // 夹具 run：缺 prep/token_budget.json；adapter 固定编号＋safetensors 在场；eval 资产三件
    mkdirSync(join(runDir, "models", "checkpoint-100"), { recursive: true });
    writeFileSync(join(runDir, "models", "checkpoint-100", "adapter_model.safetensors"), "");
    mkdirSync(join(runDir, "eval-assets"), { recursive: true });
    writeFileSync(join(runDir, "eval-assets", "eval_labels.jsonl"), '{"labels": {"f1": "x"}}\n');
    writeFileSync(join(runDir, "eval-assets", "test_images.json"), '{"images": []}\n');
    // D91：lane 任务事实在位（恰一 lane——不传 lane 走 task_fact 判定，不再缺省 goods）
    mkdirSync(join(runDir, "l1"), { recursive: true });
    writeFileSync(join(runDir, "l1", "training-data-manifest.json"), JSON.stringify({ schema_version: "TrainingDataArtifact/v1", lanes: { goods: {} } }));
    const serviceConfig = join(runDir, "eval-assets", "service-config.json");
    writeFileSync(serviceConfig, JSON.stringify({ schema_version: "EvalServiceConfig/v1", run_id: "run-h1e", port: 8210, tensor_parallel_size: 1, max_num_seqs: 8, adapters: [{ name: "ckpt100", path: join(runDir, "models", "checkpoint-100") }] }));
    const fieldConfig = join(runDir, "eval-assets", "field-config.json");
    writeFileSync(fieldConfig, JSON.stringify({ fields: [{ field_id: "f1" }] }));
    // mock pin：generate_eval_service 输出 token_budget_missing traceback 后退出 1；其余四脚本占位
    const scripts = join(root, "pin", "skills", "atf-evaluate-checkpoints", "scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "generate_eval_service.py"), [
      "import sys",
      `sys.stderr.write('Traceback (most recent call last):\\nValueError: token_budget_missing:${runDir}/prep/token_budget.json(预算文件缺;旧 run 只读兼容不回填)\\n')`,
      "sys.exit(1)",
      "",
    ].join("\n"));
    for (const name of ["build_service_prelaunch_report.py", "generate_checkpoint_plan.py", "generate_eval_orchestration.py", "run_formal_eval.py"]) {
      writeFileSync(join(scripts, name), "# placeholder\n");
    }
    const tools = buildEvalTools({ get: () => undefined }, { runsRoot: root, logDir: root, kernelDir: join(root, "pin") });
    const evaluate = tools.find((t) => (t as { name: string }).name === "atf_evaluate") as { execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>> };
    const args = {
      action: "start", run_id: "run-h1e", adapter_path: join(runDir, "models", "checkpoint-100"),
      eval_assets_dir: join(runDir, "eval-assets"), service_config: serviceConfig,
      env_profile: "a800-local", field_config: fieldConfig, assets_external_confirm: true,
    };
    const result = await evaluate.execute(args, { agent: undefined, callId: "h1-e1", signal: undefined });
    expect(result["started"]).toBe(false);
    expect(result["error"]).toBe("token_budget_missing"); // base 码（不带路径 detail——既有错误分类键）
    // D77：完整码（code:detail）不进模型可见返回体
    expect("kernel_error" in result).toBe(false);
    expect(String(result["note"])).toContain("预算文件缺失，先确认实验配置");
    expect(String(result["note"])).toContain("下一步");
    expect(result["stderr_tail"]).toBeUndefined(); // traceback 原文不回流
    // 未命中面：普通失败保持既有 machine_facts_missing 形态（含 stderr_tail——不回归）
    writeFileSync(join(scripts, "generate_eval_service.py"), "import sys\nsys.stderr.write('boom')\nsys.exit(2)\n");
    const plain = await evaluate.execute(args, { agent: undefined, callId: "h1-e2", signal: undefined });
    expect(plain["error"]).toBe("machine_facts_missing");
    expect(plain["kernel_error"]).toBeUndefined();
    expect(String(plain["stderr_tail"])).toContain("boom");
  }, 30_000);
});

// ---------------------------------------------------------------- b5 像素对复用补丁（2026-10-22）

describe("b5 像素对——renderPixelPairRows 单源渲染（web 摘要与确认卡面共用）", () => {
  const baseRows = [
    { key: "image_min_pixels", value: "65536" },
    { key: "image_max_pixels", value: "802816" },
  ];
  it("默认态：两行千分位＋[默认]＋候选档；无推荐行；无警示；用户面零内部键名", () => {
    const face = renderPixelPairRows(baseRows);
    expect(face.rows).toHaveLength(2);
    expect(face.rows[0]).toContain("最小像素");
    expect(face.rows[0]).toContain("65,536");
    expect(face.rows[0]).toContain("[默认]");
    expect(face.rows[1]).toContain("最大像素");
    expect(face.rows[1]).toContain("802,816");
    expect(face.rows[1]).toContain("候选 1,605,632");
    expect(face.rows.join("\n")).not.toContain("image_min_pixels");
    expect(face.rows.join("\n")).not.toContain("image_max_pixels");
    expect(face.rows.some((line) => line.startsWith("Agent 推荐"))).toBe(false);
    expect(face.violations).toEqual([]);
  });
  it("用户改值态：来源标注[用户]（need_confirm），未改侧保持[默认]", () => {
    const face = renderPixelPairRows([
      { key: "image_min_pixels", value: "65536" },
      { key: "image_max_pixels", value: "1605632", tag: "need_confirm" },
    ]);
    expect(face.rows[1]).toContain("1,605,632");
    expect(face.rows[1]).toContain("[用户]");
    expect(face.rows[0]).toContain("[默认]");
  });
  it("agent 推荐态：推荐行＝值＋理由（值与理由来自快照 sources 单源，渲染层不生成不硬编码）", () => {
    const face = renderPixelPairRows(baseRows, { recommend: { value: "1605632", brief: "p95长边3240量子4.4px" } });
    expect(face.rows).toHaveLength(3);
    expect(face.rows[2]).toContain("Agent 推荐：1,605,632 —— p95长边3240量子4.4px");
  });
  it("min ≥ max → 关系警示（只提示不阻塞——独立于 token_budget.violations 禁确认语义）", () => {
    const face = renderPixelPairRows([
      { key: "image_min_pixels", value: "1605632" },
      { key: "image_max_pixels", value: "802816" },
    ]);
    expect(face.violations).toHaveLength(1);
    expect(face.violations[0]).toContain("最小像素须小于最大像素");
  });
  it("值非纯数字原样（千分位跳过）；键缺席＝空面（不渲染）", () => {
    expect(thousandsOf("abc")).toBe("abc");
    expect(renderPixelPairRows([{ key: "learning_rate", value: "2e-4" }]).rows).toEqual([]);
  });
});

describe("b5 像素对——buildLaunchSurface token_budget.pixel_pair（additive 键，既有三行零回归）", () => {
  const seedWithSnapshot = (opts: { confirmed?: Record<string, string>; sources?: Record<string, string> } = {}): string => {
    const root = tempRoot();
    const runDir = join(root, "run-w");
    mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
    writeFileSync(join(runDir, "prep", "iteration-config", "iteration-config.json"), JSON.stringify({ training: { cutoff_len: 9000 } }));
    if (opts.confirmed !== undefined) {
      mkdirSync(join(runDir, "webui"), { recursive: true });
      writeFileSync(join(runDir, "webui", "config-snapshot.json"), JSON.stringify({
        schema_version: "WebUiConfigSnapshot/v1",
        confirmed: opts.confirmed,
        ...(opts.sources !== undefined ? { sources: opts.sources } : {}),
      }));
    }
    return root;
  };
  it("无快照＝默认态：两行[默认]无推荐行；既有 token_budget.rows 仍三行", () => {
    const surface = buildLaunchSurface(join(seedWithSnapshot(), "run-w"));
    expect(surface.token_budget.rows).toHaveLength(3);
    expect(surface.token_budget.pixel_pair.rows.some((line) => line.startsWith("Agent 推荐"))).toBe(false);
    expect(surface.token_budget.pixel_pair.rows[0]).toContain("[默认]");
    expect(surface.token_budget.pixel_pair.violations).toEqual([]);
  });
  it("快照 sources 带 agent-recommend → Agent 推荐行（值取 confirmed，理由取来源标注简据）", () => {
    const surface = buildLaunchSurface(join(seedWithSnapshot({
      confirmed: { image_max_pixels: "1605632" },
      sources: { image_max_pixels: "default:agent-recommend:p95长边3240" },
    }), "run-w"));
    expect(surface.token_budget.pixel_pair.rows.some((line) => line.includes("Agent 推荐：1,605,632 —— p95长边3240"))).toBe(true);
    expect(surface.token_budget.pixel_pair.rows[1]).toContain("[用户]"); // 快照确认值＝用户面确认
  });
  it("快照 sources 非 agent-recommend（user-specified）→ 无推荐行", () => {
    const surface = buildLaunchSurface(join(seedWithSnapshot({
      confirmed: { image_max_pixels: "1605632" },
      sources: { image_max_pixels: "user-specified" },
    }), "run-w"));
    expect(surface.token_budget.pixel_pair.rows.some((line) => line.startsWith("Agent 推荐"))).toBe(false);
  });
  it("登记值 min ≥ max → pixel_pair.violations 警示（不进 budget.violations——不阻塞）", () => {
    const surface = buildLaunchSurface(join(seedWithSnapshot({
      confirmed: { image_min_pixels: "1605632", image_max_pixels: "802816" },
    }), "run-w"));
    expect(surface.token_budget.pixel_pair.violations[0]).toContain("最小像素须小于最大像素");
    expect(surface.token_budget.violations).toEqual([]);
  });
});

describe("b5 像素对——表单卡呈现（中文呈现名＋来源标注＋max 变更提示＋min<max 警示不阻塞）", () => {
  it("configFormFieldsOf：像素对两键呈现名中文（零内部键名）＋域提示＋来源标注", () => {
    const fields = buildConfigConfirmFields({}, {}) as ConfigConfirmField[];
    const rows = configFormFieldsOf(fields, null);
    const minRow = rows.find((row) => row.key === "image_min_pixels");
    const maxRow = rows.find((row) => row.key === "image_max_pixels");
    // 六区块：标签带区块业务标题前缀（长度与预算），像素对仍中文呈现名（零内部键名）
    expect(minRow?.label).toBe("长度与预算｜最小像素");
    expect(maxRow?.label).toBe("长度与预算｜最大像素");
    expect(minRow?.label ?? "").not.toContain("image_min_pixels");
    expect(minRow?.hint).toContain("65,536");
    expect(minRow?.hint).toContain("（来源：默认）");
    expect(maxRow?.hint).toContain("802,816");
    expect(maxRow?.hint).toContain("1,605,632");
    expect(maxRow?.hint).toContain("（来源：默认）");
    // 结构化回传面不变：key 仍是内部键（协议零改动）
    expect(minRow?.key).toBe("image_min_pixels");
  });
  it("domainHintOf：min 域提示（同一对值）；max 含两档与变更影响提示（指令 b5 §三）", () => {
    expect(domainHintOf("image_min_pixels", null)).toContain("同一对值");
    expect(domainHintOf("image_max_pixels", null)).toContain("802,816");
    expect(domainHintOf("image_max_pixels", null)).toContain("将影响坐标换算与 token");
  });
  it("pixelPairChangeNoteOf：值与基线不同才提示；基线缺省＝惯例档位首值", () => {
    const fields = buildConfigConfirmFields({ image_max_pixels: "1605632" }, {}) as ConfigConfirmField[];
    expect(pixelPairChangeNoteOf(fields, {})).toContain("将影响坐标换算与 token");
    const untouched = buildConfigConfirmFields({}, {}) as ConfigConfirmField[];
    expect(pixelPairChangeNoteOf(untouched, {})).toBeUndefined();
    expect(pixelPairChangeNoteOf(untouched, { image_max_pixels: "802816" })).toBeUndefined();
  });
  it("pixelPairViolationNoteOf：min ≥ max 警示；关系成立 undefined", () => {
    const bad = buildConfigConfirmFields({ image_min_pixels: "999999999" }, {}) as ConfigConfirmField[];
    expect(pixelPairViolationNoteOf(bad)).toContain("最小像素须小于最大像素");
    const good = buildConfigConfirmFields({}, {}) as ConfigConfirmField[];
    expect(pixelPairViolationNoteOf(good)).toBeUndefined();
  });
});

describe("b5 像素对——confirmFace 手动档链（变更提示上卡面；min<max 只提示不阻塞）", () => {
  const formCtx = (scripted: string[][]) => {
    // fields 元素类型与生产 FormAskService 字段面对齐（confirmFace formAskQuestion——value 预填在位）
    const asks: Array<{ detail?: string; fields?: Array<{ key: string; label?: string; value?: string; hint?: string }> }> = [];
    const approvals: string[] = [];
    let calls = 0;
    return {
      asks,
      approvals,
      ctx: {
        get: (service: string) => {
          if (service === "approval") return { request: async (_req: { reason?: string }) => { approvals.push(_req?.reason ?? ""); return "allowed-once"; } };
          if (service === "userQuestions") {
            return {
              ask: async (req: { questions?: Array<{ id?: string; intent?: { fields?: Array<{ key: string; label?: string; value?: string; hint?: string }> }; detail?: string }> }) => {
                // 形态分流：决策卡（无 intent 的选项卡）只记形态、不占表单卡脚本步
                if ((req.questions ?? []).every((item) => item.intent === undefined)) {
                  // 决策卡不记入 asks（asks 是表单卡日志——索引断言按表单卡计数）
                  return { answers: (req.questions ?? []).map((item) => ({ id: item.id ?? "choice", selected: [] })) };
                }
                calls += 1;
                const question = req.questions?.[0];
                asks.push({ detail: question?.detail, fields: question?.intent?.fields });
                if (calls > scripted.length) throw Object.assign(new Error("cancelled by user"), { code: "ASK_CANCELLED" });
                return { answers: [{ id: "config-confirm-x", selected: scripted[calls - 1] ?? [] }] };
              },
            };
          }
          return undefined;
        },
      },
    };
  };
  const execTool = async (ctx: { get: (s: string) => unknown }, args: Record<string, unknown>) => {
    const root = tempRoot();
    const tools = buildConfirmTools({ runsRoot: root, ctx, gpuProbe: () => 8 }) as Array<{ name: string; execute: (a: unknown, e: unknown) => Promise<unknown> }>;
    const tool = tools.find((t) => t.name === "atf_config_confirm")!;
    const result = (await tool.execute(args, { agent: undefined, callId: "b5-c1", signal: undefined })) as Record<string, unknown>;
    return { root, result };
  };
  it("进卡：像素对两键呈现名中文＋来源标注默认（卡面零内部键名）", async () => {
    const face = formCtx([[]]);
    await execTool(face.ctx, { action: "present", run_id: "run-tb" });
    const minRow = face.asks[0]?.fields?.find((row) => row.key === "image_min_pixels");
    // 六区块：标签前缀＝区块业务标题（长度与预算），呈现名仍中文（零内部键名）
    expect(minRow?.label).toBe("长度与预算｜最小像素");
    expect(minRow?.label ?? "").not.toContain("image_min_pixels");
    expect(minRow?.hint).toContain("（来源：默认）");
  });
  it("改 max 提交：变更提示上审批卡（不重呈不阻塞——快照照落）", async () => {
    const face = formCtx([["image_max_pixels=1605632"]]);
    const { root, result } = await execTool(face.ctx, { action: "present", run_id: "run-tb" });
    expect(result).toMatchObject({ ok: true, confirmed: true }); // 不阻塞：变更提示后仍走完审批落快照
    expect(face.asks).toHaveLength(1); // 不重呈（无 violations）——提示在审批卡面
    expect(face.approvals[0]).toContain("将影响坐标换算与 token");
    const snap = JSON.parse(readFileSync(join(root, "run-tb", "webui", "config-snapshot.json"), "utf8")) as { confirmed: Record<string, string> };
    expect(snap.confirmed["image_max_pixels"]).toBe("1605632");
  });
  it("改 max 后审批 Reject → 回表单卡：变更提示在 detail 可见（带上次值）", async () => {
    const face = formCtx([["image_max_pixels=1605632"], []]);
    const verdicts = ["rejected", "allowed-once"];
    let n = 0;
    const { result } = await execTool({
      get: (service: string) => {
        if (service === "approval") return { request: async (req: { reason?: string }) => { face.approvals.push(req?.reason ?? ""); return verdicts[n++] ?? "allowed-once"; } };
        return face.ctx.get(service);
      },
    }, { action: "present", run_id: "run-tb" });
    expect(result).toMatchObject({ ok: true, confirmed: true });
    expect(face.asks[1]?.detail ?? "").toContain("将影响坐标换算与 token");
    // 闭集键（像素上限）已改由决策卡 options 收集——表单卡不再生成同键输入框（不重复收）
    expect(face.asks[1]?.fields?.find((row) => row.key === "image_max_pixels")).toBeUndefined();
  });
  it("min ≥ max 提交：警示上审批卡但不停链；Reject 回卡后警示在 detail（不阻塞语义）", async () => {
    const face = formCtx([["image_min_pixels=999999999"], []]);
    const verdicts = ["rejected", "allowed-once"];
    let n = 0;
    const { root, result } = await execTool({
      get: (service: string) => {
        if (service === "approval") return { request: async (req: { reason?: string }) => { face.approvals.push(req?.reason ?? ""); return verdicts[n++] ?? "allowed-once"; } };
        return face.ctx.get(service);
      },
    }, { action: "present", run_id: "run-tb" });
    expect(result).toMatchObject({ ok: true, confirmed: true });
    expect(face.approvals[0]).toContain("最小像素须小于最大像素"); // 首轮提交即警示（不阻塞、不重呈）
    expect(face.asks[1]?.detail ?? "").toContain("最小像素须小于最大像素"); // Reject 回卡后警示在卡面
    const snap = JSON.parse(readFileSync(join(root, "run-tb", "webui", "config-snapshot.json"), "utf8")) as { confirmed: Record<string, string> };
    expect(snap.confirmed["image_min_pixels"]).toBe("999999999");
  });
});

describe("b5 像素对——confirmFace 全自动档（recommend 采纳＋通报变更提示）", () => {
  // 训练自动驾驶＝两轴齐备（预设 atf-training ＋ 权限档 danger-full-access）
  const autoCtx = (service: string): unknown => {
    if (service === "permissionPresets") return { current: () => "danger-full-access", resolve: () => ({ sandbox: "danger-full-access" }) };
    if (service === "sessionProjections") return { stateOf: (_s: unknown, key: string) => (key === "agentPreset" ? "atf-training" : undefined) };
    return undefined;
  };
  const execAuto = async (args: Record<string, unknown>) => {
    const root = tempRoot();
    const tools = buildConfirmTools({ runsRoot: root, ctx: { get: autoCtx }, gpuProbe: () => 8 }) as Array<{ name: string; execute: (a: unknown, e: unknown) => Promise<unknown> }>;
    const tool = tools.find((t) => t.name === "atf_config_confirm")!;
    const result = (await tool.execute(
      { action: "present", run_id: "run-tb", ...args },
      { agent: { session: { id: "sess-auto" } }, callId: "b5-c2", signal: undefined },
    )) as Record<string, unknown>;
    return { root, result };
  };
  it("recommend 像素两档带理由 → 采纳落快照 sources=default:agent-recommend:*；notification 含变更提示", async () => {
    const { root, result } = await execAuto({ recommend: { image_max_pixels: 1605632, reason: "p95长边3240量子4.4px" } });
    expect(result).toMatchObject({ ok: true, auto: true });
    const snap = JSON.parse(readFileSync(join(root, "run-tb", "webui", "config-snapshot.json"), "utf8")) as { confirmed: Record<string, string>; sources?: Record<string, string> };
    expect(snap.confirmed["image_max_pixels"]).toBe("1605632");
    expect(snap.sources?.["image_max_pixels"] ?? "").toContain("default:agent-recommend:");
    expect(snap.sources?.["image_max_pixels"] ?? "").toContain("p95长边3240量子4.4px".replace(/\s+/g, "").slice(0, 24));
    expect(String(result.notification)).toContain("将影响坐标换算与 token");
  });
});

describe("b5 像素对——client.js 渲染锚（页面区块与样式类在位）", () => {
  it("client.js：视觉像素对区块渲染＋violations 红字样式＋additive 键读取", () => {
    const source = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    expect(source).toContain("budget.pixel_pair");
    expect(source).toContain("视觉像素对");
    expect(source).toContain("atf-train-pixels");
    expect(source).toContain("pixel-viol-");
  });
});
