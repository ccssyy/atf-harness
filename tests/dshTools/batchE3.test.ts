/**
 * E3（微批·三处缺口修复 20261024）测试锚——owner 指令《ATF_指令_微批E3_桥接三缺口_
 * 20261024》（授权件 4c5b37eee25a v2）三处改动的验收锚：
 *
 *   1. pipelineFace 预算三参：atf_pipeline_stage 增 max_total_tokens／image_min_pixels／
 *      image_max_pixels（仅 experiment_setup 段追加 argv；显式 > run 目录
 *      webui/config-snapshot.json 确认快照兜底 > unspecified 不下传）；来源逐参标注
 *      user_specified|config_snapshot|unspecified（审批卡与返回体均呈现终值与来源）；
 *      像素对成对校验先于审批——单端即拒（内核 b8 main() 参数形状层同款口径：
 *      --max-total-tokens(int)／--image-min-pixels／--image-max-pixels，只给一端
 *      parser.error 业务中文）＋两端在场 min<max（判据单源 pixelPairViolationOf）。
 *   2. trainingPreflight 对账放宽：order ⊇ items.id（内核 b7 实锚——dev 直跑
 *      u1-accept-swb：exit 1＋stdout 完整 JSON＋stderr 空，order 恒为依赖链全量
 *      七件、items 只含问题项〔就绪项不进 items〕，order 7／items 5）；渲染按
 *      order 序过滤 items；order 内未知项/重复项仍拒（闭集 PREFLIGHT_KNOWN_ITEM_IDS）。
 *   3. confirmFace 落点三级单源（缺口 D）：config_confirm／publish_confirm 复用 E2
 *      resolvePreflightRunDir（workspace_path > 会话工作区事实 > 实例 runsRoot 兜底）；
 *      对外参数增 workspace_path；返回体带 run_dir/run_dir_source；写面语义＝目录
 *      不存在不拒（显式落点创建/现状桶落点——新建 run 零破坏）；symlink/非绝对拒。
 *
 * mock 对端＝tests/fixtures/mock_pipeline_params.mjs（argv 回显）；
 * b7 真实输出骨架＝dev 侧直跑 .atf-pinned/tools/training_preflight.py 的实测形态
 * （2026-10-24，run u1-accept-swb；脱敏 run_dir）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePreflightReport, renderPreflightChecklist, PREFLIGHT_KNOWN_ITEM_IDS } from "../../src/core/workspace/trainingPreflight.js";
import {
  buildPipelineTool,
  experimentTokenApprovalLine,
  resolveExperimentTokenParams,
} from "../../packages/extensions/atf-tools/src/pipelineFace.js";
import { buildConfirmTools } from "../../packages/extensions/atf-tools/src/confirmFace.js";
import { resolvePreflightRunDir as resolvePreflightRunDirForE3 } from "../../packages/extensions/atf-tools/src/preflightFace.js";

/** resolvePreflightRunDir 直测桩（E3 补：wp 显式 canonical 优先口径）。 */
const plainExecForE3 = (): object => ({ agent: { session: { id: "sess-e3-pf" } }, callId: "e3-pf", signal: undefined });

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

// ══ 1. 预算三参（pipelineFace）══

const fakeExec = { agent: undefined, callId: "e3-call", signal: undefined };
const approvalCtx = (record: string[]): { get(service: string): unknown } => ({
  get: (service: string) =>
    (service === "approval"
      ? { request: async (req: { reason: string }) => { record.push(req.reason); return "allowed-once"; } }
      : undefined),
});
const MOCK = join(import.meta.dirname, "..", "fixtures", "mock_pipeline_params.mjs");
const toolOf = (record: string[] = []): DshToolLike =>
  buildPipelineTool(approvalCtx(record), `node ${MOCK}`, 30_000) as unknown as DshToolLike;

const summaryArgv = (result: unknown): string[] =>
  ((result as { summary?: { argv?: string[] } }).summary?.argv ?? []);

/** 落九要素形态确认快照（confirmed 值全字符串面——与 saveConfigSnapshot 落盘形态同源）。 */
const writeSnapshot = (runDir: string, confirmed: Record<string, string>): void => {
  mkdirSync(join(runDir, "webui"), { recursive: true });
  writeFileSync(join(runDir, "webui", "config-snapshot.json"), `${JSON.stringify({ schema_version: "ConfigSnapshot/v1", confirmed }, null, 1)}\n`, "utf8");
};

describe("E3-1 预算三参（experiment_setup 段专属）", () => {
  it("显式三参透传：argv 含三 flag 与值；返回体终值＋source=user_specified", async () => {
    const ws = tempRoot("e3-ws-");
    const result = await toolOf().execute(
      { stage: "experiment_setup", run_id: "e3-explicit", workspace_path: ws, max_total_tokens: 9000, image_min_pixels: 65536, image_max_pixels: 1605632 },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv).toContain("--max-total-tokens");
    expect(argv).toContain("9000");
    expect(argv).toContain("--image-min-pixels");
    expect(argv).toContain("65536");
    expect(argv).toContain("--image-max-pixels");
    expect(argv).toContain("1605632");
    expect((result as Record<string, unknown>)["max_total_tokens"]).toBe(9000);
    expect((result as Record<string, unknown>)["max_total_tokens_source"]).toBe("user_specified");
    expect((result as Record<string, unknown>)["image_min_pixels_source"]).toBe("user_specified");
    expect((result as Record<string, unknown>)["image_max_pixels_source"]).toBe("user_specified");
  });

  it("未显式传 → 读 <runDir>/webui/config-snapshot.json 兜底：argv 下传快照值＋source=config_snapshot", async () => {
    const ws = tempRoot("e3-ws-");
    writeSnapshot(join(ws, "runs", "e3-snap"), { max_total_tokens: "9000", image_min_pixels: "65536", image_max_pixels: "1605632" });
    const result = await toolOf().execute(
      { stage: "experiment_setup", run_id: "e3-snap", workspace_path: ws },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv).toContain("--max-total-tokens");
    expect(argv).toContain("9000");
    expect(argv).toContain("--image-min-pixels");
    expect(argv).toContain("65536");
    expect(argv).toContain("--image-max-pixels");
    expect(argv).toContain("1605632");
    expect((result as Record<string, unknown>)["max_total_tokens"]).toBe(9000);
    expect((result as Record<string, unknown>)["max_total_tokens_source"]).toBe("config_snapshot");
    expect((result as Record<string, unknown>)["image_min_pixels_source"]).toBe("config_snapshot");
    expect((result as Record<string, unknown>)["image_max_pixels_source"]).toBe("config_snapshot");
  });

  it("逐参独立来源：max 显式＋像素对来自快照（混合形态各自标注）", async () => {
    const ws = tempRoot("e3-ws-");
    writeSnapshot(join(ws, "runs", "e3-mix"), { max_total_tokens: "9000", image_min_pixels: "65536", image_max_pixels: "1605632" });
    const result = await toolOf().execute(
      { stage: "experiment_setup", run_id: "e3-mix", workspace_path: ws, max_total_tokens: 8000 },
      fakeExec,
    );
    expect((result as Record<string, unknown>)["max_total_tokens"]).toBe(8000);
    expect((result as Record<string, unknown>)["max_total_tokens_source"]).toBe("user_specified");
    expect((result as Record<string, unknown>)["image_min_pixels"]).toBe(65536);
    expect((result as Record<string, unknown>)["image_min_pixels_source"]).toBe("config_snapshot");
    const argv = summaryArgv(result);
    expect(argv).toContain("8000"); // 显式值压过快照值
    expect(argv).toContain("65536");
  });

  it("皆无（无参无快照）：argv 无三 flag；返回体值 null＋source=unspecified（缺省不静默）", async () => {
    const result = await toolOf().execute(
      { stage: "experiment_setup", run_id: "e3-none", workspace_path: tempRoot("e3-ws-") },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv).not.toContain("--max-total-tokens");
    expect(argv).not.toContain("--image-min-pixels");
    expect(argv).not.toContain("--image-max-pixels");
    expect((result as Record<string, unknown>)["max_total_tokens"]).toBeNull();
    expect((result as Record<string, unknown>)["max_total_tokens_source"]).toBe("unspecified");
    expect((result as Record<string, unknown>)["image_min_pixels_source"]).toBe("unspecified");
    expect((result as Record<string, unknown>)["image_max_pixels_source"]).toBe("unspecified");
  });

  it("非 experiment_setup 段传三参：argv 不下传、返回体零键（段专属）", async () => {
    const result = await toolOf().execute(
      { stage: "family_split", run_id: "e3-other", workspace_path: tempRoot("e3-ws-"), max_total_tokens: 9000, image_min_pixels: 65536, image_max_pixels: 1605632 },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv).not.toContain("--max-total-tokens");
    expect(argv).not.toContain("--image-min-pixels");
    expect(argv).not.toContain("--image-max-pixels");
    expect((result as Record<string, unknown>)["max_total_tokens"]).toBeUndefined();
    expect((result as Record<string, unknown>)["max_total_tokens_source"]).toBeUndefined();
    expect((result as Record<string, unknown>)["image_max_pixels_source"]).toBeUndefined();
  });

  it("像素对只给一端（显式）：卡前快败 pixel_pair_half_given，业务文案、不进审批（零放行消耗）", async () => {
    const approvals: string[] = [];
    const result = await toolOf(approvals).execute(
      { stage: "experiment_setup", run_id: "e3-half", workspace_path: tempRoot("e3-ws-"), image_min_pixels: 65536 },
      fakeExec,
    );
    expect((result as Record<string, unknown>)["ok"]).toBe(false);
    expect((result as Record<string, unknown>)["error"]).toBe("pixel_pair_half_given");
    const note = String((result as Record<string, unknown>)["note"]);
    expect(note).toContain("成对提供");
    expect(note).toContain("半新半旧");
    expect(note).not.toContain("pixel_pair_half_given"); // 内部码不进文案
    expect(approvals).toHaveLength(0); // 先于审批——坏值不消耗放行
  });

  it("快照像素对只有一端（历史残缺快照＋无显式）：同样卡前快败（终值口径统一校验）", async () => {
    const ws = tempRoot("e3-ws-");
    writeSnapshot(join(ws, "runs", "e3-half-snap"), { max_total_tokens: "9000", image_min_pixels: "65536" });
    const approvals: string[] = [];
    const result = await toolOf(approvals).execute(
      { stage: "experiment_setup", run_id: "e3-half-snap", workspace_path: ws },
      fakeExec,
    );
    expect((result as Record<string, unknown>)["ok"]).toBe(false);
    expect((result as Record<string, unknown>)["error"]).toBe("pixel_pair_half_given");
    expect(approvals).toHaveLength(0);
  });

  it("像素对两端 min≥max：卡前快败 pixel_pair_violation，文案单源 pixelPairViolationOf（业务语言）", async () => {
    const approvals: string[] = [];
    const result = await toolOf(approvals).execute(
      { stage: "experiment_setup", run_id: "e3-minmax", workspace_path: tempRoot("e3-ws-"), image_min_pixels: 2000000, image_max_pixels: 802816 },
      fakeExec,
    );
    expect((result as Record<string, unknown>)["ok"]).toBe(false);
    expect((result as Record<string, unknown>)["error"]).toBe("pixel_pair_violation");
    const note = String((result as Record<string, unknown>)["note"]);
    expect(note).toContain("最小像素须小于最大像素");
    expect(note).not.toContain("pixel_pair_violation");
    expect(approvals).toHaveLength(0);
  });

  it("显式非法值（0／负数／小数）：卡前快败 <key>_invalid（安全正整数口径）", async () => {
    for (const bad of [0, -5, 1.5]) {
      const result = await toolOf().execute(
        { stage: "experiment_setup", run_id: `e3-bad-${String(bad).replace(/[-.]/g, "_")}`, workspace_path: tempRoot("e3-ws-"), max_total_tokens: bad },
        fakeExec,
      );
      expect((result as Record<string, unknown>)["ok"]).toBe(false);
      expect((result as Record<string, unknown>)["error"]).toBe("max_total_tokens_invalid");
    }
  });

  it("审批卡：预算三参行仅 experiment_setup 段呈现（终值与来源双双上卡；unspecified 明示）", async () => {
    const ws = tempRoot("e3-ws-");
    writeSnapshot(join(ws, "runs", "e3-card"), { image_min_pixels: "65536", image_max_pixels: "1605632" });
    const record: string[] = [];
    await toolOf(record).execute(
      { stage: "experiment_setup", run_id: "e3-card", workspace_path: ws, max_total_tokens: 9000 },
      fakeExec,
    );
    expect(record[0]).toContain("预算三参（实验门）");
    expect(record[0]).toContain("max_total_tokens=9000（用户指定）");
    expect(record[0]).toContain("image_min_pixels=65536（确认快照）");
    expect(record[0]).toContain("image_max_pixels=1605632（确认快照）");
    const recordNone: string[] = [];
    await toolOf(recordNone).execute(
      { stage: "experiment_setup", run_id: "e3-card-none", workspace_path: tempRoot("e3-ws-") },
      fakeExec,
    );
    expect(recordNone[0]).toContain("max_total_tokens=未定（未指定——内核按缺省处理）");
    const recordOther: string[] = [];
    await toolOf(recordOther).execute(
      { stage: "label_qc", run_id: "e3-card-lq", workspace_path: tempRoot("e3-ws-"), max_total_tokens: 9000 },
      fakeExec,
    );
    expect(recordOther[0]).not.toContain("预算三参");
  });

  it("参数 schema：三参 number 型＋description 提及快照兜底与成对口径", () => {
    const tool = toolOf();
    const props = (tool.parameters as { properties?: Record<string, { type?: string; description?: string }> }).properties ?? {};
    for (const key of ["max_total_tokens", "image_min_pixels", "image_max_pixels"]) {
      expect(props[key]?.["type"]).toBe("number");
      expect(String(props[key]?.["description"])).toContain("确认快照");
    }
    expect(String(props["max_total_tokens"]?.["description"])).toContain("config-snapshot.json");
    expect(String(props["image_min_pixels"]?.["description"])).toContain("成对提供");
    expect(String(tool.description)).toContain("max_total_tokens");
  });

  it("纯函数直测：experimentTokenApprovalLine 文案与 resolveExperimentTokenParams 三态", () => {
    expect(experimentTokenApprovalLine({ max_total_tokens: 9000 }, { max_total_tokens: "user_specified", image_min_pixels: "unspecified", image_max_pixels: "unspecified" }))
      .toContain("max_total_tokens=9000（用户指定）");
    const resolved = resolveExperimentTokenParams({ image_min_pixels: 65536, image_max_pixels: 802816 }, "/nonexistent-e3");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.sources["max_total_tokens"]).toBe("unspecified");
    expect(resolved.sources["image_min_pixels"]).toBe("user_specified");
  });

  it("E3 补·canonical 落点：run 在 <wp>/workspace/runs/<id>（内核 RunLayout v1）→ 快照兜底命中 canonical 树＋run_dir_layout=canonical", async () => {
    const ws = tempRoot("e3-ws-");
    // canonical 形态（上次八段实锚布局：workspace 根下 datasets/splits 与 workspace/runs 并存）
    const canonicalRun = join(ws, "workspace", "runs", "e3-canon");
    writeSnapshot(canonicalRun, { max_total_tokens: "9000", image_min_pixels: "65536", image_max_pixels: "1605632" });
    const result = await toolOf().execute(
      { stage: "experiment_setup", run_id: "e3-canon", workspace_path: ws },
      fakeExec,
    );
    expect((result as Record<string, unknown>)["ok"]).toBe(true);
    expect((result as Record<string, unknown>)["run_dir"]).toBe(canonicalRun);
    expect((result as Record<string, unknown>)["run_dir_layout"]).toBe("canonical");
    // 快照兜底从 canonical 树读到（来源=config_snapshot）
    expect((result as Record<string, unknown>)["max_total_tokens"]).toBe(9000);
    expect((result as Record<string, unknown>)["max_total_tokens_source"]).toBe("config_snapshot");
    expect((result as Record<string, unknown>)["image_max_pixels_source"]).toBe("config_snapshot");
  });

  it("E3 补·canonical 软链拒：<wp>/workspace/runs/<id> 为软链 → run_dir_symlink_rejected（先于审批）", async () => {
    const ws = tempRoot("e3-ws-");
    const realRun = join(ws, "real-run");
    mkdirSync(realRun, { recursive: true });
    mkdirSync(join(ws, "workspace", "runs"), { recursive: true });
    symlinkSync(realRun, join(ws, "workspace", "runs", "e3-canon-link"));
    const approvals: string[] = [];
    const result = await toolOf(approvals).execute(
      { stage: "experiment_setup", run_id: "e3-canon-link", workspace_path: ws },
      fakeExec,
    );
    expect((result as Record<string, unknown>)["ok"]).toBe(false);
    expect((result as Record<string, unknown>)["error"]).toBe("run_dir_symlink_rejected");
    expect(approvals).toHaveLength(0);
  });

  it("E3 补·legacy 零变化：run 不在 canonical 位（含新建 run）→ run_dir 仍 <wp>/runs/<id>＋layout=legacy", async () => {
    const ws = tempRoot("e3-ws-");
    writeSnapshot(join(ws, "runs", "e3-legacy"), { max_total_tokens: "9000" });
    const result = await toolOf().execute(
      { stage: "experiment_setup", run_id: "e3-legacy", workspace_path: ws },
      fakeExec,
    );
    expect((result as Record<string, unknown>)["run_dir"]).toBe(join(ws, "runs", "e3-legacy"));
    expect((result as Record<string, unknown>)["run_dir_layout"]).toBe("legacy");
    expect((result as Record<string, unknown>)["max_total_tokens_source"]).toBe("config_snapshot");
    const fresh = await toolOf().execute(
      { stage: "experiment_setup", run_id: "e3-fresh-new", workspace_path: ws },
      fakeExec,
    );
    expect((fresh as Record<string, unknown>)["run_dir"]).toBe(join(ws, "runs", "e3-fresh-new"));
    expect((fresh as Record<string, unknown>)["max_total_tokens_source"]).toBe("unspecified");
  });
});

// ══ 2. 预检 schema 对账放宽（trainingPreflight）══

/** 内核 b7 真实输出骨架（dev 直跑 u1-accept-swb 实测 2026-10-24：exit 1＋stderr 空＋
 *  stdout 完整 JSON——order 恒七件全量、items 只含 5 个问题项；就绪项 field_config
 *  与 lane_facts 不进 items。脱敏 run_dir，detail 节选实测原文）。 */
const B7_REAL_REPORT_JSON = `{
  "schema_version": "TrainingPreflight/v1",
  "generated_at": "2026-10-24T09:50:07+00:00",
  "run_dir": "<ws>/runs/u1-accept-swb",
  "items": [
    {"id": "source_pairs", "state": "missing", "detail": "未提供素材来源根(--source-root),源配对未检查", "action": "传 --source-root <素材目录> 后重跑预检", "depends_on": []},
    {"id": "token_provider", "state": "derivable", "detail": "未显式指定 provider;内置 CPU 计量脚本可用(零第三方依赖,文本为保守上偏估算):<pinned>/token_meter_cpu.py", "action": "构造训练变体时显式传 --token-provider <pinned>/token_meter_cpu.py(需要精确计量时改用 token_audit_provider.py 真算)", "depends_on": []},
    {"id": "token_budget", "state": "missing", "detail": "预算文件未落盘且实验门预算值未确认(构造上限与视觉像素对须成组确认);预算落盘前构造与训练准备不会放行", "action": "在实验门完成预算确认后重跑预检", "depends_on": ["token_provider"]},
    {"id": "coordinate_pending", "state": "missing", "detail": "待处理 50 张(pixel_budget_missingx50);整批重试依赖 token 预算的像素对——待依赖:token 预算未就绪,重试不可执行", "action": "先解决 token_budget 项,预算落盘后重跑预检再整批重试", "depends_on": ["token_budget"]},
    {"id": "grouping_preset", "state": "needs_confirm", "detail": "分组预设为 agent 建议(未确认):preset=B(2 组·单据级 vs 条目级)——分组方式影响每图样本形态,须业务确认", "action": "在实验门确认卡确认分组预设(维持或改选)后重跑预检", "depends_on": []}
  ],
  "order": ["source_pairs", "field_config", "token_provider", "token_budget", "coordinate_pending", "lane_facts", "grouping_preset"],
  "summary": {"missing": 3, "derivable": 1, "confirm": 1}
}`;

describe("E3-2 预检 schema 对账放宽——order ⊇ items.id（内核 b7 实锚）", () => {
  it("b7 真实形态解析通过：order 7 件全量／items 5 个问题项（就绪项不进 items）", () => {
    const parsed = parsePreflightReport(B7_REAL_REPORT_JSON);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.order).toHaveLength(7);
    expect(parsed.report.items).toHaveLength(5);
    expect(parsed.report.order).toEqual([...PREFLIGHT_KNOWN_ITEM_IDS]);
    expect(parsed.report.summary).toEqual({ missing: 3, derivable: 1, confirm: 1 });
  });

  it("渲染按 order 序过滤 items：就绪项（field_config/lane_facts）零呈现；组内序＝依赖链序非字典序", () => {
    const parsed = parsePreflightReport(B7_REAL_REPORT_JSON);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const text = renderPreflightChecklist(parsed.report);
    expect(text).not.toContain("field_config");
    expect(text).not.toContain("lane_facts");
    // missing 组按 order 序：source_pairs → token_budget → coordinate_pending
    // （字典序则是 coordinate_pending < source_pairs < token_budget——order 序锚）
    const idxSource = text.indexOf("source_pairs");
    const idxBudget = text.indexOf("token_budget");
    const idxCoord = text.indexOf("coordinate_pending");
    expect(idxSource).toBeGreaterThan(-1);
    expect(idxSource).toBeLessThan(idxBudget);
    expect(idxBudget).toBeLessThan(idxCoord);
    // 就绪项被过滤后 5 项全呈现（问题项一个不少）；derivable 组在场（b7 输出中唯一
    // derivable 项 token_provider 依赖为空——无待依赖行，如实不标）
    for (const id of ["source_pairs", "token_provider", "token_budget", "coordinate_pending", "grouping_preset"]) {
      expect(text).toContain(id);
    }
    expect(text).toContain("derivable——可自动执行");
    expect(text).toContain("共 5 项待处理：missing 3／derivable 1／needs_confirm 1");
  });

  it("旧形态（order 恰等 items）仍解析通过——存量输出零破坏", () => {
    const base = JSON.parse(B7_REAL_REPORT_JSON) as Record<string, unknown>;
    base["order"] = ["source_pairs", "token_provider", "token_budget", "coordinate_pending", "grouping_preset"];
    expect(parsePreflightReport(JSON.stringify(base)).ok).toBe(true);
  });

  it("order 内未知项仍拒（闭集外 id——错乱输出不采纳）", () => {
    const base = JSON.parse(B7_REAL_REPORT_JSON) as Record<string, unknown>;
    (base["order"] as string[])[1] = "rogue_item";
    const parsed = parsePreflightReport(JSON.stringify(base));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("未知检查项");
    expect(parsed.error).toContain("rogue_item");
  });

  it("order 重复项仍拒", () => {
    const base = JSON.parse(B7_REAL_REPORT_JSON) as Record<string, unknown>;
    (base["order"] as string[])[1] = "source_pairs";
    expect(parsePreflightReport(JSON.stringify(base)).ok).toBe(false);
  });

  it("items 含 order 外的项仍拒（问题项不在依赖序——渲染序错乱）", () => {
    const base = JSON.parse(B7_REAL_REPORT_JSON) as Record<string, unknown>;
    (base["items"] as Array<Record<string, unknown>>).push({ id: "rogue_item", state: "missing", detail: "d", action: "a", depends_on: [] });
    expect(parsePreflightReport(JSON.stringify(base)).ok).toBe(false);
  });
});

// ══ 3. confirmFace 落点三级单源（缺口 D）══

const confirmExec = { agent: { session: { id: "sess-e3-test" } }, callId: "e3-confirm-1", signal: undefined };
const cwdExec = (cwd: string): object => ({ agent: { session: { id: "sess-e3-cwd", header: { cwd } } }, callId: "e3-confirm-2", signal: undefined });

/** ctx 桩：手动档 permissionPresets＋approval（记录 reason）＋userQuestions（提交 max_total_tokens=9000 过预算闸）。 */
const manualCtx = (askLog: string[], approvals: string[], approvalOutcome = "allowed-once") => ({
  get: (service: string) => {
    if (service === "permissionPresets") {
      return {
        current: () => "danger-full-access",
        defaultPreset: "danger-full-access",
        catalog: () => ({ options: [{ value: "danger-full-access", name: "Full access" }], defaultPreset: "danger-full-access" }),
      };
    }
    if (service === "approval") {
      return { request: async (req: { reason: string }) => { approvals.push(req.reason); return approvalOutcome; } };
    }
    if (service === "userQuestions") {
      return {
        ask: async (req: { questions: ReadonlyArray<{ id: string }> }): Promise<{ answers: ReadonlyArray<{ id: string; selected: ReadonlyArray<string> }> }> => {
          const question = req.questions[0];
          if (question === undefined) throw new Error("ask 桩收到空问题集");
          askLog.push(question.id);
          return { answers: [{ id: question.id, selected: ["max_total_tokens=9000"] }] };
        },
      };
    }
    return undefined;
  },
});

const confirmTools = (runsRoot: string, askLog: string[], approvals: string[]) =>
  buildConfirmTools({ runsRoot, ctx: manualCtx(askLog, approvals) }) as unknown as DshToolLike[];

/** atf_config_confirm 工具定位（tsc 严格面——非空不落解构）。 */
const configToolOf = (runsRoot: string, askLog: string[], approvals: string[]): DshToolLike => {
  const tool = confirmTools(runsRoot, askLog, approvals).find((entry) => entry.name === "atf_config_confirm");
  if (tool === undefined) throw new Error("atf_config_confirm 未注册");
  return tool;
};

const confirmedOf = (runDir: string): Record<string, string> => {
  const parsed = JSON.parse(readFileSync(join(runDir, "webui", "config-snapshot.json"), "utf8")) as { confirmed: Record<string, string> };
  return parsed.confirmed;
};

describe("E3-3 confirmFace 落点三级单源（缺口 D——快照与内核读点同棵树）", () => {
  it("E3 补·resolvePreflightRunDir wp 显式 canonical 优先：真树在场时不落 legacy 假树（快照/回写与 training_prep 同树）", () => {
    const ws = tempRoot("e3-ws-");
    const canonicalRun = join(ws, "workspace", "runs", "e3-wp-canon");
    mkdirSync(canonicalRun, { recursive: true });
    // legacy 假树同 run_id 在场（仅 webui 绑定形态——历史上抢先命中的形态）
    mkdirSync(join(ws, "runs", "e3-wp-canon"), { recursive: true });
    const resolved = resolvePreflightRunDirForE3({ command: "", timeoutMs: 0, runsRoot: tempRoot("e3-runs-"), ctx: { get: () => undefined } }, { runId: "e3-wp-canon", apply: false, workspacePath: ws }, plainExecForE3());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.runDir).toBe(canonicalRun);
    expect(resolved.source).toBe("workspace_path");
  });

  it("E3 补·resolvePreflightRunDir wp 显式 legacy 零变化：canonical 缺席时仍 legacy 公式（存量/新建形态）", () => {
    const ws = tempRoot("e3-ws-");
    mkdirSync(join(ws, "runs", "e3-wp-legacy"), { recursive: true });
    const resolved = resolvePreflightRunDirForE3({ command: "", timeoutMs: 0, runsRoot: tempRoot("e3-runs-"), ctx: { get: () => undefined } }, { runId: "e3-wp-legacy", apply: false, workspacePath: ws }, plainExecForE3());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.runDir).toBe(join(ws, "runs", "e3-wp-legacy"));
  });

  it("workspace_path 给定（run 在场）：快照落 <ws>/runs/<id>；返回体 run_dir＋run_dir_source=workspace_path", async () => {
    const ws = tempRoot("e3-ws-");
    mkdirSync(join(ws, "runs", "e3-wp-confirm"), { recursive: true });
    const askLog: string[] = [];
    const approvals: string[] = [];
    const configConfirm = configToolOf(tempRoot("e3-runs-"), askLog, approvals);
    const result = (await configConfirm.execute({ action: "present", run_id: "e3-wp-confirm", workspace_path: ws }, confirmExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["run_dir"]).toBe(join(ws, "runs", "e3-wp-confirm"));
    expect(result["run_dir_source"]).toBe("workspace_path");
    const runDir = join(ws, "runs", "e3-wp-confirm");
    expect(existsSync(join(runDir, "webui", "config-snapshot.json"))).toBe(true);
    expect(confirmedOf(runDir)["max_total_tokens"]).toBe("9000");
  });

  it("workspace_path 给定（run 不存在）：写面在显式落点创建（快照落新树）；不静默改道", async () => {
    const ws = tempRoot("e3-ws-");
    const askLog: string[] = [];
    const approvals: string[] = [];
    const configConfirm = configToolOf(tempRoot("e3-runs-"), askLog, approvals);
    const result = (await configConfirm.execute({ action: "present", run_id: "e3-wp-new", workspace_path: ws }, confirmExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["run_dir_source"]).toBe("workspace_path");
    const runDir = join(ws, "runs", "e3-wp-new");
    expect(existsSync(join(runDir, "webui", "config-snapshot.json"))).toBe(true);
  });

  it("会话工作区事实命中 <cwd>/runs/<id>：source=session_fact，快照落工作区树（非实例 runsRoot）", async () => {
    const ws = tempRoot("e3-ws-");
    const runDir = join(ws, "runs", "e3-sf-confirm");
    mkdirSync(runDir, { recursive: true });
    const askLog: string[] = [];
    const approvals: string[] = [];
    const configConfirm = configToolOf(tempRoot("e3-runs-"), askLog, approvals);
    const result = (await configConfirm.execute({ action: "present", run_id: "e3-sf-confirm" }, cwdExec(ws))) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["run_dir_source"]).toBe("session_fact");
    expect(result["run_dir"]).toBe(runDir);
    expect(existsSync(join(runDir, "webui", "config-snapshot.json"))).toBe(true);
  });

  it("新建 run（无 wp 无 cwd 命中）：现状桶落点零破坏——source=instance_runs_root，快照落 runsRoot 树", async () => {
    const runsRoot = tempRoot("e3-runs-");
    const askLog: string[] = [];
    const approvals: string[] = [];
    const configConfirm = configToolOf(runsRoot, askLog, approvals);
    const result = (await configConfirm.execute({ action: "present", run_id: "e3-fresh" }, confirmExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["run_dir_source"]).toBe("instance_runs_root");
    expect(result["run_dir"]).toBe(join(runsRoot, "e3-fresh"));
    expect(existsSync(join(runsRoot, "e3-fresh", "webui", "config-snapshot.json"))).toBe(true);
  });

  it("落点为软链：拒（run_dir_symlink_rejected）——确认值永不落镜像位，零快照写入", async () => {
    const realWs = tempRoot("e3-real-");
    const realRunDir = join(realWs, "runs", "e3-link-confirm");
    mkdirSync(realRunDir, { recursive: true });
    const linkWs = tempRoot("e3-link-");
    mkdirSync(join(linkWs, "runs"), { recursive: true });
    symlinkSync(realRunDir, join(linkWs, "runs", "e3-link-confirm"));
    const askLog: string[] = [];
    const approvals: string[] = [];
    const configConfirm = configToolOf(tempRoot("e3-runs-"), askLog, approvals);
    const result = (await configConfirm.execute({ action: "present", run_id: "e3-link-confirm", workspace_path: linkWs }, confirmExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("run_dir_symlink_rejected");
    expect(String(result["note"])).toContain("不接受镜像/软链");
    expect(existsSync(join(realRunDir, "webui", "config-snapshot.json"))).toBe(false);
    expect(askLog).toHaveLength(0); // 不进卡
  });

  it("workspace_path 非绝对路径：拒（文案对齐预检/段工具同名错误形态）", async () => {
    const askLog: string[] = [];
    const approvals: string[] = [];
    const configConfirm = configToolOf(tempRoot("e3-runs-"), askLog, approvals);
    const result = (await configConfirm.execute({ action: "present", run_id: "e3-rel", workspace_path: "relative/ws" }, confirmExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("workspace_path_not_absolute");
    expect(askLog).toHaveLength(0);
  });

  it("workspace_path 携非法 runId（路径穿越形态）：拒绝在显式落点创建目录", async () => {
    const ws = tempRoot("e3-ws-");
    const askLog: string[] = [];
    const approvals: string[] = [];
    const configConfirm = configToolOf(tempRoot("e3-runs-"), askLog, approvals);
    const result = (await configConfirm.execute({ action: "present", run_id: "../../etc-e3", workspace_path: ws }, confirmExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("run_id_invalid");
    expect(existsSync(join(ws, "runs", ".."))).toBe(true); // 目录系统事实——未被创建穿越目录
  });

  it("publish_confirm 同源：带 workspace_path 读工作区树契约件，返回体带 run_dir_source", async () => {
    const ws = tempRoot("e3-ws-");
    const runDir = join(ws, "runs", "e3-pub");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "contract-candidate.json"), `${JSON.stringify({ digest: "sha256-e3-pub" }, null, 1)}\n`, "utf8");
    const askLog: string[] = [];
    const approvals: string[] = [];
    const tools = confirmTools(tempRoot("e3-runs-"), askLog, approvals);
    const publishConfirm = tools.find((tool) => tool.name === "atf_publish_confirm");
    if (publishConfirm === undefined) throw new Error("atf_publish_confirm 未注册");
    const result = (await publishConfirm.execute({ run_id: "e3-pub", workspace_path: ws }, confirmExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["digest"]).toBe("sha256-e3-pub");
    expect(result["run_dir_source"]).toBe("workspace_path");
    expect(result["run_dir"]).toBe(runDir);
  });
});
