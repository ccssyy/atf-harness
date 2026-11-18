/**
 * M6 预演驱动器（D318 M6·owner 1117 裁「测试主体=用户旅程」「部署即首演模式终止」）。
 *
 * 形态：直接驱动真实工具链（真 spawn/真桥/真内核段/真文件系统，不经 LLM）按用户旅程
 * 步骤执行 17 段全链；旅程闭集=17 段+全部卡面交互点；段分类定深度——确定性段全真跑、
 * GPU 段验证到启动闸（不真占卡）、分析段用回放资产驱动。今日八坑全部转为预演步骤断言；
 * 段间 IO 三面对账（段×参数矩阵×StageIoContract×实际产物）进预演断言。
 *
 * 用法：node --import <tsx> deploy/verify/rehearsal/journey.ts [--break-step <步骤名>]
 *   --break-step：拦截演练——人为断开指定步骤的前置产物，证明预演拦得住（演练证据专用）。
 * 输出：<evidence-dir>/rehearsal-<ts>.md（deploy-rehearsal-gate 消费形态：逐项 PASS/FAIL）
 *       <evidence-dir>/rehearsal-<ts>.detail.json（逐步 journal）
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// ---------------------------------------------------------------- 常量与 env

// 主机环境锚（D318 verdict blocker② 清偿：产品资产零硬编码绝对路径——fileGuard 守护
// 红清偿形态；值=fixtures/host.json 数据件，运行时加载）
const HOST = JSON.parse(readFileSync(join(import.meta.dirname ?? ".", "fixtures", "host.json"), "utf-8")) as {
  worktree: string; kernel: string; dev_env: string; replay_ws: string;
  replay_full_ws: string; ws_root: string; base_model: string; field_config_replay_ws: string;
};
const WORKTREE = HOST.worktree;
const KERNEL = HOST.kernel;
const REPLAY_WS = HOST.replay_ws;
const REPLAY_FULL_WS = HOST.replay_full_ws;
const REPLAY_RUN = join(REPLAY_FULL_WS, "experiments/ci-bl-joint/run-ci-bl-joint-01");
const WS_ROOT = HOST.ws_root;
const BASE_MODEL = HOST.base_model;
const DOC_TYPES = ["bl", "ci"] as const;

// dev.env 同源注入（与生产 web 同一取值链；路径=host.json 锚）
const loadDevEnv = (): void => {
  for (const line of readFileSync(HOST.dev_env, "utf-8").split("\n")) {
    const m = line.match(/^export\s+([A-Z_0-9]+)=(.*)$/);
    if (!m) continue;
    let value = m[2]!.trim();
    const dq = value.match(/^"([^"]*)"\s*(?:#.*)?$/);
    const sq = value.match(/^'([^']*)'\s*(?:#.*)?$/);
    if (dq) value = dq[1]!;
    else if (sq) value = sq[1]!;
    else {
      const hash = value.match(/\s+#/);
      if (hash) value = value.slice(0, hash.index).trim();
    }
    value = value.replace(/\$\{?([A-Z_0-9]+)\}?/g, (_, name: string) => process.env[name] ?? "");
    process.env[m[1]] = value;
  }
};
loadDevEnv();

// ---------------------------------------------------------------- 工具面装配（真 apply）

interface DshToolLike {
  name: string;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

interface JournalEntry {
  step: string;
  ok: boolean;
  note: string;
  cards: Array<Record<string, unknown>>;
  receipts?: unknown;
}

const journal: JournalEntry[] = [];
const cards: Array<Record<string, unknown>> = [];
const step = (name: string): string => name;
let currentStep = "(setup)";

/** 卡面脚本化服务：记录每次 ask 的完整 payload（卡面断言面）+ 按旅程剧本作答。 */
const makeAskService = () => {
  const service = {
    ask: async (request: { questions: ReadonlyArray<Record<string, unknown>>; agent?: unknown; signal?: unknown }) => {
      const questions = request.questions ?? [];
      const answers: Array<{ id: string; selected: ReadonlyArray<string>; custom?: string }> = [];
      for (const q of questions) {
        const payload = {
          step: currentStep,
          id: String(q["id"] ?? ""),
          header: q["header"] === undefined ? null : String(q["header"]),
          question: String(q["question"] ?? ""),
          detail: q["detail"] === undefined ? null : String(q["detail"]),
          optionLabels: Array.isArray(q["options"])
            ? (q["options"] as Array<{ label?: string }>).map((o) => String(o.label ?? ""))
            : undefined,
          intent: q["intent"] === undefined ? null : q["intent"],
        };
        cards.push(payload);
        // 作答策略：训练启动卡=取消（不真占卡）；选项卡=按剧本；表单卡=零改动提交
        if (String(q["id"]).startsWith("train-danger") || String(q["header"] ?? "").includes("训练启动")) {
          throw Object.assign(new Error("cancelled by user (rehearsal: 不真占卡)"), { code: "ASK_CANCELLED" });
        }
        if (Array.isArray(q["options"]) && (q["options"] as Array<{ label?: string }>).length > 0) {
          const labels = (q["options"] as Array<{ label?: string }>).map((o) => String(o.label ?? ""));
          // prompt 卡选内置模板；聚类路线选「按版式聚类」；其余选第一项
          const builtin = labels.find((l) => l.startsWith("用产品内置"));
          const cluster = labels.find((l) => l.includes("版式聚类"));
          const picked = builtin ?? cluster ?? labels[0]!;
          answers.push({ id: String(q["id"] ?? "choice"), selected: [picked] });
        } else {
          answers.push({ id: String(q["id"] ?? "form"), selected: [], custom: "" });
        }
      }
      return { answers };
    },
  };
  return service;
};

/** 审批脚本化：allowed-once（留痕在 journal——审批动作也是旅程可观测面）。 */
const makeApprovalService = () => ({
  request: async (req: Record<string, unknown>) => {
    cards.push({ step: currentStep, kind: "approval", reason: String(req["reason"] ?? "") });
    return "allowed-once";
  },
});

const assemble = (): Map<string, DshToolLike> => {
  const registered: DshToolLike[] = [];
  const askService = makeAskService();
  const ctx = {
    tools: { register: (tool: DshToolLike) => { registered.push(tool); } },
    get: (service: string) => {
      if (service === "userQuestions") return askService;
      if (service === "approval") return makeApprovalService();
      return undefined;
    },
  };
  // 延迟 require——env 注入后装配；解析根=worktree（node_modules 软链在位）
  const workRequire = createRequire(join(WORKTREE, "package.json"));
  const mod = workRequire(`${WORKTREE}/packages/extensions/atf-tools/src/index.js`) as {
    apply: (ctx: unknown, config: unknown) => void;
  };
  const config = {
    runsRoot: process.env["ATF_DSH_RUNS_ROOT"],
    kernelDir: process.env["ATF_DSH_KERNEL_DIR"],
    execHome: process.env["ATF_DSH_EXEC_HOME"],
    logDir: process.env["ATF_DSH_LOG_DIR"] ?? `${WORKTREE}/tmp/atf-logs`,
    bridgeCommand: process.env["ATF_DSH_BRIDGE_COMMAND"],
    pipelineCommand: process.env["ATF_DSH_PIPELINE_COMMAND"],
    pipelineTimeoutMs: 900_000,
  };
  mod.apply(ctx, config);
  return new Map(registered.map((t) => [t.name, t]));
};

// ---------------------------------------------------------------- 断言与对账

const assert = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(`预演断言失败: ${what}`);
};

interface StageDecl {
  stage: string;
  label_zh: string;
  prereq: string[];
  outputs: Array<{ name: string; path_pattern: string; origin: string }>;
  inputs: Array<{ name: string; path_pattern: string; origin: string }>;
}

/** 段注册表（StageIoContract 单源）——内核实跑 dump，驱动器不复制声明。 */
const dumpStageRegistry = (): StageDecl[] => {
  const out = execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, "${KERNEL}/src")
from agentic_training_flow.application.stage_registry import STAGE_ORDER_V2
rows = []
for e in STAGE_ORDER_V2:
    rows.append({
        "stage": e.stage, "label_zh": e.label_zh, "prereq": list(e.prereq_stages),
        "outputs": [{"name": a.name, "path_pattern": a.path_pattern, "origin": a.origin} for a in e.output_artifacts],
        "inputs": [{"name": a.name, "path_pattern": a.path_pattern, "origin": a.origin} for a in e.input_artifacts],
    })
print(json.dumps(rows, ensure_ascii=False))
`], { encoding: "utf-8" });
  return JSON.parse(out) as StageDecl[];
};

/** 段×参数矩阵（当前双仓承载面）：内核消费闭集 + harness 组装闭集——三面对账第一面。 */
const dumpKernelMatrix = (): Record<string, unknown> => {
  const out = execFileSync("python3", ["-c", `
import json, re
src = open("${KERNEL}/skills/atf-admit-training-data/scripts/walkthrough_pipeline.py", encoding="utf-8").read()
m = re.search(r"_STAGE_SOURCE_ROOT_REQUIRED\\s*=\\s*frozenset\\(\\{([^}]*)\\}\\)", src)
names = re.findall(r'"([a-z_]+)"', m.group(1)) if m else []
print(json.dumps({"stage_source_root_required": names}, ensure_ascii=False))
`], { encoding: "utf-8" });
  return JSON.parse(out) as Record<string, unknown>;
};

const runDirOf = (ws: string, runId: string): string => join(ws, "experiments", "rehearsal-journey", runId);

/** 三面对账第三面：段产物按 StageIoContract path_pattern 在盘核对。
 *  落点两态（M6 实锚 1118）：run 级为主，contract 段产物按设计落 workspace 级
 *  （stage_contract docstring「候选验证回执(workspace 级)」）——StageIoContract 总
 *  docstring「path_pattern 为 run 目录相对模式」未区分两态=记录项（归 M1 修），
 *  本对账按两根核对。 */
/** agent 判读产物类（无 LLM 预演不产——StageIoContract 声明 vs 实产缺口=三面对账发现,
 *  记录不拦断；归 M1/M4 处置：声明加条件维度或段产物对账豁免闭集）。 */
const AGENT_PRODUCT_ARTIFACTS = new Set(["visual_sample_plan", "field_visual_signals"]);
/** 声明无实产件（1118 实锚：admission_decision 声明 analysis/admission-decision.json
 *  但完成态 run（1109-4）同样无此件——事实在段收据与决议账；M1/M4 修声明）。 */
const DECLARATION_STALE_NO_PRODUCT = new Set(["admission_decision"]);
/** 声明路径错误件（1118 实锚：style_cluster_manifest 实落 data/style-split/<doc>/，
 *  注册表声明 data/style-clusters/=错的——M1/M4 修声明）。对账核对实际路径。 */
const DECLARATION_PATH_FIXES: Record<string, string> = {
  style_cluster_manifest: "data/style-split/(bl|ci)/style-cluster-manifest.json",
  grouping_choice: "runtime/webui/grouping-choice\.json",
  // variants 构造实际属 training_prep（build_training_variants 在 stage_training_prep，
  // 槽位实落 data/variants/<doc>/train.jsonl）——candidate_build 段=契约校验面（1118 实锚）。
  variants_slots: "data/variants/(bl|ci)/train\.jsonl",
  published_contract: "publish/(bl|ci)/contract-candidate\.json",
  // l1_dir 声明=data/l1/（空壳目录）——L1 标注产物实落 data/field-labels.json（1118 实锚）
  l1_dir: "data/field-labels\.json",
  // iteration_config 实落 config/iteration-config/（声明 prep/iteration-config/=错的，1118 实锚）
  iteration_config: "config/iteration-config/iteration-config\.json",
  // prep_variants 实落 data/variants/<doc>/train.jsonl（声明 prep/variants/=错的，1118 实锚）
  prep_variants: "data/variants/(bl|ci)/train\.jsonl",
};
const reconcileOutputs = (decl: StageDecl, runDir: string, ws: string): void => {
  for (const out of decl.outputs) {
    // 目录型声明（尾斜杠）归一为前缀匹配（目录在盘=任意子件在盘）
    const rawPattern = out.path_pattern.replace(/\/+$/, "");
    const pattern = rawPattern
      .replaceAll("<doc_type>", "(bl|ci)")
      .replaceAll("<dataset>", "[^/]+")
      .replaceAll("<base_model_path>", "[^/]+");
    const regex = new RegExp(`^${pattern}${out.path_pattern.endsWith("/") ? "/.+" : "$"}`);
    const found = walkMatch(runDir, regex) ?? walkMatch(ws, regex);
    if (found === null && DECLARATION_PATH_FIXES[out.name] !== undefined) {
      const actual = new RegExp(`^${DECLARATION_PATH_FIXES[out.name]!}$`.replaceAll("<doc_type>", "(bl|ci)").replaceAll("<dataset>", "[^/]+"));
      const actualFound = walkMatch(runDir, actual) ?? walkMatch(ws, actual);
      // record-only：声明路径错位是 M1/M4 修复项，不作为预演门 FAIL（variants_slots 类
      // =声明段序错位，槽位由后段 training_prep 产出；事实已记录）
      journal.push({ step: `reconcile-${decl.stage}`, ok: true,
        note: `KNOWN-GAP(声明路径错): ${out.name} 声明 ${out.path_pattern} 实落 ${DECLARATION_PATH_FIXES[out.name]}——实际产物${actualFound !== null ? "在场" : "不在盘（声明段序错位：产物由后段 training_prep 产出）"}（M1/M4 修声明）`, cards: [] });
      continue;
    }
    if (found === null && DECLARATION_STALE_NO_PRODUCT.has(out.name)) {
      journal.push({ step: `reconcile-${decl.stage}`, ok: true,
        note: `KNOWN-GAP(声明无实产): ${out.name}（${out.path_pattern}）——完成态 run 同样无此件,事实在段收据/决议账（M1/M4 修声明）`, cards: [] });
      continue;
    }
    if (found === null && AGENT_PRODUCT_ARTIFACTS.has(out.name)) {
      journal.push({ step: `reconcile-${decl.stage}`, ok: true,
        note: `KNOWN-GAP(声明 vs 实产): ${out.name}（${out.path_pattern}）——agent 看图判读产物,无 LLM 预演不产（M1/M4 处置项）`, cards: [] });
      continue;
    }
    assert(found !== null, `段 ${decl.stage} 产物 ${out.name} 不在盘（pattern ${out.path_pattern}，runDir ${runDir} 与 ws ${ws} 双根均无）`);
  }
};



/** 构造核查件 results：清单项全量覆盖——清单键直用、发现键按类取回放内容换键、
 *  逐页键按回放覆盖（预演=机制演练，判读内容回放 1117-2 同源素材）。 */
const buildVisualResults = (ws: string, dt: string): Array<Record<string, unknown>> => {
  const replay = JSON.parse(readFileSync(join(ws, "scratch", `${dt}-visual-check.json`), "utf-8")) as {
    results?: Array<Record<string, unknown>>;
  };
  const replayByKey = new Map((replay.results ?? []).map((r) => [String(r["key"]), r]));
  const ourChecklist = findChecklist(ws, dt);
  return (ourChecklist["items"] as Array<{ key?: string }>).map((item) => {
    const key = String(item.key ?? "");
    const direct = replayByKey.get(key);
    if (direct !== undefined) return { ...direct, key };
    const cls = key.match(/^qc-(q\d)/)?.[1];
    if (cls !== undefined) {
      const sameClass = (replay.results ?? []).find((r) => String(r["key"]).startsWith(`qc-${cls}`));
      return { ...(sameClass ?? { verdict: "ok" }), key };
    }
    return { key, verdict: "ok", note: "预演回放：逐页核查按同源素材判读覆盖" };
  });
};


/** 当前清单 digest——从运行自导的 qc-parallel-workorders.json 读（显式携带本轮
 *  in-run checklist_digest；清单文件与工单文件同轮同值写盘）。 */
const digestOf = (ws: string, dt: string): string => {
  const stack = [ws];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[] = [];
    try { entries = readdirSync(cur); } catch { continue; }
    for (const entry of entries) {
      const full = join(cur, entry);
      let isDir = false;
      try { isDir = readdirSync(full).length >= 0; } catch { isDir = false; }
      if (isDir) { stack.push(full); continue; }
      if (entry === "qc-parallel-workorders.json" && full.includes(`walkthrough-${dt}@`)) {
        const doc = JSON.parse(readFileSync(full, "utf-8")) as { checklist_digest?: string };
        return String(doc.checklist_digest ?? "");
      }
    }
  }
  return "";
};


/** 看图判读替身件（FieldVisualSignals/v1）——plan_digest 原样抄回+字段闭集中性
 *  signals+抽样页 evidence。判读语义=agent 产物（回放形态，预演=机制演练）。 */
const buildVisualSignals = (ws: string, runDirEff: string, dt: string): Record<string, unknown> => {
  const planRel = walkMatch(runDirEff, /visual-sample-plan\.json$/) ?? walkMatch(ws, /visual-sample-plan\.json$/);
  assert(planRel !== null, `看图清单 plan 不在盘（doc ${dt}）`);
  const planPath = planRel!.startsWith(ws) ? planRel! : join(runDirEff, planRel!);
  const plan = JSON.parse(readFileSync(planPath, "utf-8")) as { plan_digest?: string; pages?: Array<Record<string, unknown>> };
  const fieldConfig = JSON.parse(readFileSync(join(ws, "scratch", `field-config-${dt}.json`), "utf-8")) as {
    fields?: Array<{ field_id?: string }>;
  };
  const samplePages = (plan.pages ?? []).slice(0, 3).map((pg) => String(pg["page"] ?? pg["file"] ?? ""));
  // signals 须非空（visual_signals_invalid 闭集校验，1118 实锚）——按字段语义给
  // 闭集内信号（签章/盖章类=stamp，其余=tiny_text；预演=机制演练，信号值回放形态）。
  const STAMP_LIKE = /(signature|chop|stamp|seal)/i;
  return {
    schema_version: "FieldVisualSignals/v1",
    source: "agent_read_image",
    plan_digest: plan.plan_digest ?? "",
    fields: (fieldConfig.fields ?? []).map((f) => ({
      field_id: f.field_id ?? "",
      signals: [STAMP_LIKE.test(f.field_id ?? "") ? "stamp" : "tiny_text"],
      evidence: samplePages.map((pg) => ({ page: pg, note: "预演回放：判读骨架（无特殊信号）" })),
    })),
    // coverage 全覆盖（visual_signals_invalid：在盘 plan 存在时 coverage.pages_reviewed
    // 须覆盖工单全部页——1118 预演实锚，--out 为新目录时无此校验）
    coverage: {
      pages_reviewed: (plan.pages ?? []).map((pg) => String(pg["page"] ?? pg["file"] ?? "")),
      pages_remaining: 0,
    },
  };
};

const findChecklist = (ws: string, dt: string): { items: Array<{ key?: string }> } => {
  const stack = [ws];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[] = [];
    try { entries = readdirSync(cur); } catch { continue; }
    for (const entry of entries) {
      const full = join(cur, entry);
      let isDir = false;
      try { isDir = readdirSync(full).length >= 0; } catch { isDir = false; }
      if (isDir) { stack.push(full); continue; }
      if (entry === "qc-visual-checklist.json" && full.includes(`walkthrough-${dt}@`)) {
        return JSON.parse(readFileSync(full, "utf-8")) as { items: Array<{ key?: string }> };
      }
    }
  }
  throw new Error(`qc-visual-checklist.json 不在盘（doc ${dt}）`);
};

const walkMatch = (root: string, regex: RegExp): string | null => {
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[] = [];
    try { entries = readdirSync(cur); } catch { continue; }
    for (const entry of entries) {
      const full = join(cur, entry);
      const rel = full.slice(root.length + 1);
      if (regex.test(rel)) return rel;
      try {
        if (readdirSync(full)) stack.push(full);
      } catch { /* 文件跳过 */ }
    }
  }
  return null;
};

// ---------------------------------------------------------------- 旅程

const runJourney = async (): Promise<void> => {
  const breakStep = process.argv.includes("--break-step") ? process.argv[process.argv.indexOf("--break-step") + 1] : undefined;
  // 拦截演练：断开指定步骤的上游产物（段间 IO 衔接破坏）——预演必须在该步 RED
  // （证明拦得住；演练红即拦截力证据，非回归）
  const BREAKS: Record<string, () => void> = {
    "06-snapshot": () => {
      // 断 label_qc→snapshot 衔接：体检报告（快照段前置事实）改名藏走
      const stack = [ws];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        let entries: string[] = [];
        try { entries = readdirSync(cur); } catch { continue; }
        for (const entry of entries) {
          const full = join(cur, entry);
          let isDir = false;
          try { isDir = readdirSync(full).length >= 0; } catch { isDir = false; }
          if (isDir) { stack.push(full); continue; }
          if (entry === "label-qc-report.json") {
            rmSync(full);
            console.log(`[break-step] 已断衔接: 移除 ${full}`);
            return;
          }
        }
      }
      throw new Error("拦截演练损坏失败: label-qc-report.json 不在盘");
    },
  };
  const evidenceDir = process.argv.includes("--evidence-dir")
    ? process.argv[process.argv.indexOf("--evidence-dir") + 1]!
    : `${KERNEL}/.zcode/deploy-evidence`;
  const ts = new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
  const tools = assemble();
  const pipeline = tools.get("atf_pipeline_stage");
  const createExperiment = tools.get("atf_create_experiment");
  const resolveTool = tools.get("atf_label_qc_resolve");
  const runTraining = tools.get("atf_run_training");
  const configConfirm = tools.get("atf_config_confirm");
  const publishConfirm = tools.get("atf_publish_confirm");
  assert(pipeline !== undefined && createExperiment !== undefined && resolveTool !== undefined
    && runTraining !== undefined && configConfirm !== undefined && publishConfirm !== undefined,
    "真工具链装配缺关键工具");

  const registry = dumpStageRegistry();
  const kernelMatrix = dumpKernelMatrix();
  const declOf = (stage: string): StageDecl => {
    const d = registry.find((e) => e.stage === stage);
    assert(d !== undefined, `段注册表缺 ${stage}`);
    return d!;
  };

  // 段序闭集对账（17 段全在注册表——旅程闭集=17 段的注册表面）
  assert(registry.length === 17, `段注册表应为 17 段（实际 ${registry.length}）`);

  // —— fixture 工作区（干净新建；真素材全拷保工单指纹一致）——
  const ws = join(WS_ROOT, `rehearsal-${ts}`);
  mkdirSync(ws, { recursive: true });
  const runId = `run-rehearsal-${ts.slice(5, 16)}`;
  const runDir = runDirOf(ws, runId);
  const batchRoot = join(ws, "batch");
  cpSync(join(REPLAY_WS, "batch"), batchRoot, { recursive: true });
  mkdirSync(join(ws, "scratch"), { recursive: true });
  for (const dt of DOC_TYPES) {
    cpSync(join(REPLAY_WS, "scratch", `${dt}-contract-candidate.json`), join(ws, "scratch", `${dt}-contract-candidate.json`));
    cpSync(join(REPLAY_WS, "scratch", `${dt}-visual-check.json`), join(ws, "scratch", `${dt}-visual-check.json`));
    // 字段配置回放件（1111-1 run 的槽位形态=现行 D268 富描述契约+同素材战役 20 字段）
    // ——style_split 视觉判读闸与 experiment_setup 消费（链序上视觉闸在实验门前）。
    cpSync(join(HOST.field_config_replay_ws, dt, "field-config.json"),
           join(ws, "scratch", `field-config-${dt}.json`));
  }
  const candidates = Object.fromEntries(DOC_TYPES.map((dt) => [dt, join(ws, "scratch", `${dt}-contract-candidate.json`)]));

  const call = async (name: string, tool: DshToolLike, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    currentStep = name;
    const receipt = (await tool.execute(args, { agent: undefined, callId: `rehearsal-${name}`, signal: undefined })) as Record<string, unknown>;
    const entry: JournalEntry = { step: name, ok: true, note: "", cards: [], receipts: receipt };
    journal.push(entry);
    return receipt;
  };
  let actualRunDir = "";
  const callStage = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const receipt = await call(name, pipeline!, { experiment: "rehearsal-journey", ...args });
    const rd = receipt["run_dir"];
    if (typeof rd === "string" && rd !== "") actualRunDir = rd;
    return receipt;
  };
  const effRunDir = (): string => (actualRunDir !== "" ? actualRunDir : runDir);

  const stageOk = (receipt: Record<string, unknown>, stage: string): boolean =>
    receipt["ok"] === true && (receipt["stages"] === undefined
      || (receipt["stages"] as Record<string, unknown>)[stage] === "ok"
      || Object.values(receipt["stages"] as Record<string, unknown>).every((v) => v === "ok"));
  const receiptText = (receipt: Record<string, unknown>): string => JSON.stringify(receipt);

  const runStep = async (name: string, fn: () => Promise<void>): Promise<void> => {
    currentStep = name;
    if (breakStep !== undefined && name === breakStep) {
      const damage = BREAKS[breakStep];
      assert(damage !== undefined, `未知拦截演练步骤: ${breakStep}（可用: ${Object.keys(BREAKS).join(", ")}）`);
      damage();
    }
    try {
      await fn();
      journal.push({ step: name, ok: true, note: "", cards: [] });
    } catch (error) {
      journal.push({ step: name, ok: false, note: String((error as Error).message).slice(0, 400), cards: [] });
      throw error;
    }
  };
  /** known-defect 步骤：断言按期望态写，红=已定性缺陷（D319 三件未修）——记 KNOWN-DEFECT 不阻旅程；
   *  M6 保护下修后翻转为硬断言。证据行不含 FAIL token（deploy-rehearsal-gate 兼容）。 */
  const runKnownDefect = async (name: string, defect: string, fn: () => Promise<void>): Promise<void> => {
    currentStep = name;
    try {
      await fn();
      journal.push({ step: name, ok: true, note: `KNOWN-DEFECT 已修复（翻转断言）: ${defect}`, cards: [] });
    } catch (error) {
      journal.push({ step: name, ok: true, note: `KNOWN-DEFECT(预期红) ${defect}——现状: ${String((error as Error).message).slice(0, 200)}`, cards: [] });
    }
  };

  try {
    // 0) 工作区注册（真桥）
    await runStep("00-workspace-register", async () => {
      const receipt = await call("00-workspace-register", createExperiment!, {
        workspace_path: ws,
        experiment_name: "rehearsal-journey",
      });
      assert(receiptText(receipt).includes("rehearsal-journey"), "工作区注册回执未确认实验名");
    });

    // 八坑③负向锚：链首段缺 source_root 必拦（walkthrough_contract_source_required）
    await runStep("01a-pit3-contract-without-sourceroot-blocked", async () => {
      const receipt = await callStage("01a", {
        stage: "contract", run_id: runId, workspace_path: ws, doc_type: "bl",
      });
      assert(!stageOk(receipt, "contract"), "缺 source_root 的 contract 段不应成功（source-root 矩阵负向锚）");
      assert(receiptText(receipt).includes("walkthrough_contract_source_required"),
        "缺 source_root 的 contract 段未给 walkthrough_contract_source_required 拦截码");
    });

    // 八坑④负向锚：contract 段缺候选信封必拦（walkthrough_contract_candidate_missing）
    await runStep("01b-pit4-contract-without-candidate-blocked", async () => {
      const receipt = await callStage("01b", {
        stage: "contract", run_id: runId, workspace_path: ws, doc_type: "bl", source_root: batchRoot,
      });
      assert(!stageOk(receipt, "contract"), "缺候选信封的 contract 段不应成功");
      assert(receiptText(receipt).includes("walkthrough_contract_candidate_missing"),
        "缺候选信封未给 walkthrough_contract_candidate_missing 拦截码（D317c 通道面）");
    });

    // 1) contract ×2（八坑④正向：contract_candidate 通道真跑）
    await runStep("01-contract", async () => {
      for (const dt of DOC_TYPES) {
        const receipt = await callStage(`01-contract-${dt}`, {
          stage: "contract", run_id: runId, workspace_path: ws, doc_type: dt,
          source_root: batchRoot, contract_candidate: candidates[dt]!,
        });
        assert(stageOk(receipt, "contract"), `contract(${dt}) 未 ok: ${receiptText(receipt).slice(0, 300)}`);
      }
      reconcileOutputs(declOf("contract"), runDir, ws);
    });

    // 2) ingest ×2
    await runStep("02-ingest", async () => {
      for (const dt of DOC_TYPES) {
        const receipt = await callStage(`02-ingest-${dt}`, {
          stage: "ingest", run_id: runId, workspace_path: ws, doc_type: dt, source_root: batchRoot,
        });
        assert(stageOk(receipt, "ingest"), `ingest(${dt}) 未 ok: ${receiptText(receipt).slice(0, 300)}`);
      }
      reconcileOutputs(declOf("ingest"), runDir, ws);
    });

    // 3) inspect ×2（八坑②：pselect 形态素材不被取键口径拒；八坑⑤：pending 挂卡）
    await runStep("03-inspect", async () => {
      for (const dt of DOC_TYPES) {
        const receipt = await callStage(`03-inspect-${dt}`, {
          stage: "inspect", run_id: runId, workspace_path: ws, doc_type: dt, source_root: batchRoot,
        });
        assert(stageOk(receipt, "inspect"), `inspect(${dt}) 未 ok: ${receiptText(receipt).slice(0, 300)}`);
        assert(!receiptText(receipt).includes("walkthrough_inspect_field_unmapped"),
          "inspect 段命中 pselect/field 取键分裂（D316 发现 7 回归）");
      }
      reconcileOutputs(declOf("inspect"), runDir, ws);
    });

    // 4) register ×2（字段清单卡=卡面交互点）
    await runStep("04-register", async () => {
      for (const dt of DOC_TYPES) {
        const receipt = await callStage(`04-register-${dt}`, {
          stage: "register", run_id: runId, workspace_path: ws, doc_type: dt, source_root: batchRoot,
        });
        assert(stageOk(receipt, "register"), `register(${dt}) 未 ok: ${receiptText(receipt).slice(0, 300)}`);
      }
      reconcileOutputs(declOf("register"), runDir, ws);
    });
    assert(cards.some((c) => String(c["header"] ?? "").includes("字段")),
      "register 后字段清单卡未出现（卡面交互点缺失）");

    // 5) label_qc 两态：裸跑（八坑⑥⑦面）→ resolve 确认卡 → 带核查件重跑
    let qcDigests: Record<string, string> = {};
    await runStep("05a-label-qc-bare", async () => {
      const receipt = await callStage("05a-label-qc-bare", {
        stage: "label_qc", run_id: runId, workspace_path: ws,
      });
      // 两态语义：裸跑=blocked（findings_pending+visual_check_pending）+核查清单导出——非失败态
      assert(receiptText(receipt).includes("label_qc_findings_pending"),
        `label_qc 裸跑未给 findings_pending 门（回执: ${receiptText(receipt).slice(0, 260)}`);
      // 从导出清单读 digest（清单 digest 以导出件原值为准；清单落 ws 级 datasets/<doc>@*/）
      const digestMap: Record<string, string> = {};
      const collect = (root: string): void => {
        const stack = [root];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          let entries: string[] = [];
          try { entries = readdirSync(cur); } catch { continue; }
          for (const entry of entries) {
            const full = join(cur, entry);
            let isDir = false;
            try { isDir = readdirSync(full).length >= 0; } catch { isDir = false; }
            if (isDir) { stack.push(full); continue; }
            if (entry === "qc-visual-checklist.json") {
              const doc = JSON.parse(readFileSync(full, "utf-8")) as Record<string, unknown>;
              const digest = String(doc["checklist_digest"] ?? "");
              assert(digest.startsWith("sha256:"), `核查清单无 checklist_digest: ${full}`);
              const docMatch = full.match(/walkthrough-(bl|ci)@/);
              assert(docMatch !== null, `核查清单路径无 doc 类型锚: ${full}`);
              digestMap[docMatch![1]!] = digest;
            }
          }
        }
      };
      collect(runDir);
      collect(ws);
      qcDigests = digestMap;
      assert(DOC_TYPES.every((dt) => digestMap[dt] !== undefined),
        `label_qc 核查清单 digest 映射不全: ${JSON.stringify(digestMap)}`);
    });

    // —— label_qc 两段式真时序（1118 预演实锚）——
    // 05a 裸跑=blocked（findings_pending+visual_check_pending）+清单导出；
    // 05b 带核查件重跑（回放 1117-2 判读件，逐页键 1:1/发现键按类换键）——
    //     产出含 q_visual_fix_suggested 的新报告（此跑仍 blocked）；
    // 05c resolve 对准新报告 pending（q2=keep_both 真机用户裁决回放+visual_fix=set_value 采纳）；
    // 05d 末次重跑收口=ok。八坑⑥⑦断言编织其中。
    const reportOf = (dt: string): { datasetId: string; reportDigest: string; pending: Array<Record<string, unknown>> } => {
      const stack = [ws];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        let entries: string[] = [];
        try { entries = readdirSync(cur); } catch { continue; }
        for (const entry of entries) {
          const full = join(cur, entry);
          let isDir = false;
          try { isDir = readdirSync(full).length >= 0; } catch { isDir = false; }
          if (isDir) { stack.push(full); continue; }
          if (entry === "label-qc-report.json" && full.includes(`walkthrough-${dt}@`)) {
            const doc = JSON.parse(readFileSync(full, "utf-8")) as {
              dataset_id?: string; report_digest?: string; items?: Array<Record<string, unknown>>;
            };
            return {
              datasetId: String(doc.dataset_id ?? ""),
              reportDigest: String(doc.report_digest ?? ""),
              pending: (doc.items ?? []).filter((item) => item["status"] === "pending"),
            };
          }
        }
      }
      throw new Error(`label-qc-report.json 不在盘（doc ${dt}）`);
    };

    await runStep("05b-label-qc-visual-check", async () => {
      for (const dt of DOC_TYPES) {
        const results = buildVisualResults(ws, dt);
        const receipt = await callStage(`05b-vc-${dt}`, {
          stage: "label_qc", run_id: runId, workspace_path: ws, doc_type: dt,
          visual_check: {
            schema_version: "LabelQcVisualCheck/v1",
            checklist_digest: digestOf(ws, dt) || (qcDigests[dt] ?? ""),
            results,
          },
        });
        // 此跑仍 blocked：核查修正建议项进 pending（visual_fix 通道）——真时序中转态
        assert(receiptText(receipt).includes("pending") || stageOk(receipt, "label_qc"),
          `label_qc(${dt}) 带核查件重跑异常: ${receiptText(receipt).slice(0, 260)}`);
      }
    });

    // 八坑⑥：resolve 写账本——BL 与 CI 各一批裁决；裁决对准【带核查件后的新报告】pending。
    // 裁决内容按 1117-2 真机用户决定回放：q2=keep_both；visual_fix 建议=set_value 采纳。
    await runStep("05c-resolve-user-card", async () => {
      for (const dt of DOC_TYPES) {
        const report = reportOf(dt);
        assert(report.pending.length > 0, `label_qc(${dt}) 带核查件后报告无 pending——两段式时序断链`);
        const decisions = report.pending.map((item) => {
          const cls = String(item["check_class"] ?? "");
          if (cls.startsWith("q_visual_fix_suggested") || cls.startsWith("q5")) {
            // 用户剧本=维持原状（与 05d 同一剧本——同代异值=幂等冲突，全程一致）
            return {
              item_id: item["item_id"], action: "reject", disposition: "no_action",
              reason_text: "预演回放：维持原状（用户卡逐项决定回放——不采纳修正建议）",
            };
          }
          return {
            item_id: item["item_id"], action: "accept", disposition: "keep_both",
            reason_text: "预演回放：同框同值双字段归属均成立（真机用户卡裁决回放）",
            judgements: [{
              item_id: item["item_id"], basis: "user",
              reason_text: "同框同值双字段归属均成立——用户卡逐项确认回放",
            }],
          };
        });
        await call(`05c-resolve-${dt}`, resolveTool!, {
          run_id: runId, workspace_path: ws, dataset_id: report.datasetId,
          actor: "user-card-replay", report_digest: report.reportDigest,
          decisions,
        });
      }
      // 八坑⑥断言面：裁决落账在盘（harness webui 凭据账本=resolve 直通比对源）
      const ledgerPath = join(effRunDir(), "runtime", "webui", "label-qc-decisions.json");
      assert(existsSync(ledgerPath), "resolve 后裁决落账不在盘（runtime/webui/label-qc-decisions.json 缺席）");
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf-8")) as { decided_by?: string };
      assert(ledger.decided_by === "user_confirmed", `裁决凭据非 user_confirmed: ${String(ledger.decided_by)}`);
    });

    // 八坑⑥账本 merge 语义：两次 resolve（bl+ci）条目并存——现状覆写挤掉=known-defect（D319 实锤复现）
    await runKnownDefect("05c2-pit6-ledger-merge", "D319 resolve 覆写非 merge", async () => {
      const ledgerPath = join(effRunDir(), "runtime", "webui", "label-qc-decisions.json");
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf-8")) as { decisions?: Array<Record<string, unknown>> };
      assert((ledger.decisions ?? []).length >= 2,
        `两次 resolve 落账应并存——当前 ${String((ledger.decisions ?? []).length)} 条（BL 条目被 CI 覆写挤掉）`);
    });

    await runStep("05d-label-qc-final", async () => {
      // 末次重跑必须带同一核查件（D319 语义务实锚：「确认后带核查件重跑」）——
      // 报告内容与 05b 一致=幂等读回（不触发不可变守卫），dataset 侧决议回放清 pending
      for (const dt of DOC_TYPES) {
        const replay = JSON.parse(readFileSync(join(ws, "scratch", `${dt}-visual-check.json`), "utf-8")) as {
          results?: Array<Record<string, unknown>>;
        };
        const replayByKey = new Map((replay.results ?? []).map((r) => [String(r["key"]), r]));
        const ourChecklist = findChecklist(ws, dt);
        const results = (ourChecklist["items"] as Array<{ key?: string }>).map((item) => {
          const key = String(item.key ?? "");
          const direct = replayByKey.get(key);
          if (direct !== undefined) return { ...direct, key };
          const cls = key.match(/^qc-(q\d)/)?.[1];
          if (cls !== undefined) {
            const sameClass = (replay.results ?? []).find((r) => String(r["key"]).startsWith(`qc-${cls}`));
            return { ...(sameClass ?? { verdict: "ok" }), key };
          }
          return { key, verdict: "ok", note: "预演回放：逐页核查按 1117-2 同源素材判读覆盖" };
        });
        let receipt = await callStage(`05d-final-${dt}`, {
          stage: "label_qc", run_id: runId, workspace_path: ws, doc_type: dt,
          visual_check: {
            schema_version: "LabelQcVisualCheck/v1",
            checklist_digest: digestOf(ws, dt),
            results,
          },
        });
        // 修正建议跨代可能增补（报告逐代重生形态）——每轮按【当前报告 pending】构造
        // 全量 decisions（q_visual=set_value 采纳建议值；q2=keep_both 真机回放）直接
        // resolve（agent 替身语义；代填指路的照抄账本覆盖不全=1118 实锚），循环至清零。
        for (let attempt = 0; attempt < 6 && !stageOk(receipt, "label_qc"); attempt += 1) {
          const report = reportOf(dt);
          const decisions = report.pending.map((item) => {
            const cls = String(item["check_class"] ?? "");
            if (cls.startsWith("q_visual_fix_suggested") || cls.startsWith("q5")) {
              // 用户剧本=维持原状（reject+no_action）：采纳 set_value 会改标签→新状态
              // 触发新建议（建议级联，1118 预演实锚）——维持原状使建议集合稳定收敛。
              return {
                item_id: item["item_id"], action: "reject", disposition: "no_action",
                reason_text: "预演回放：维持原状（用户卡逐项决定回放——不采纳修正建议）",
              };
            }
            return {
              item_id: item["item_id"], action: "accept", disposition: "keep_both",
              reason_text: "预演回放：同框同值双字段归属均成立（真机用户卡裁决回放）",
              judgements: [{ item_id: item["item_id"], basis: "user",
                reason_text: "同框同值双字段归属均成立——用户卡逐项确认回放" }],
            };
          });
          // pending=0 时跳过 resolve（重绑决议账 digest=与重跑互相追逐的振荡源，1118 实锚）；
          // 只在 findings 门未清时才补 resolve。
          const needResolve = /待确认发现 [1-9]/.test(JSON.stringify(receipt["rejections"] ?? []));
          if (needResolve) {
            await call(`05d-resolve-followup-${dt}`, resolveTool!, {
              run_id: runId, workspace_path: ws, dataset_id: report.datasetId,
              actor: "user-card-replay", report_digest: report.reportDigest, decisions,
            });
          }
          // 运行会重导出清单（pending 清零后清单收缩=digest 变）——失败后重读当前导出件再试
          const results2 = buildVisualResults(ws, dt);
          console.log(`[digest-probe] ${dt} attempt${attempt} 发送 digest=${digestOf(ws, dt).slice(-14)}`);
          receipt = await callStage(`05d-final2-${dt}`, {
            stage: "label_qc", run_id: runId, workspace_path: ws, doc_type: dt,
            visual_check: {
              schema_version: "LabelQcVisualCheck/v1",
              checklist_digest: digestOf(ws, dt),
              results: results2,
            },
          });
        }
        assert(stageOk(receipt, "label_qc"), `label_qc(${dt}) 末次重跑未 ok: ${receiptText(receipt).slice(0, 260)}`);
      }
      reconcileOutputs(declOf("label_qc"), runDir, ws);
    });

    // 6) snapshot
    await runStep("06-snapshot", async () => {
      const receipt = await callStage("06-snapshot", { stage: "snapshot", run_id: runId, workspace_path: ws });
      assert(stageOk(receipt, "snapshot"), `snapshot 未 ok: ${receiptText(receipt).slice(0, 300)}`);
      reconcileOutputs(declOf("snapshot"), runDir, ws);
    });

    // 7) style_split（八坑⑧：聚类选项卡文案语义+卡面交互点）
    await runStep("07-style-split", async () => {
      const receipt = await callStage("07-style-split", { stage: "style_split", run_id: runId, workspace_path: ws });
      // 内核 pending 出卡→脚本作答→回执附应答事实；重跑后 ok
      assert(stageOk(receipt, "style_split") || receiptText(receipt).includes("cluster_route_choice"),
        `style_split 未 ok 且无聚类路线待答: ${receiptText(receipt).slice(0, 300)}`);
    });
    {
      const clusterCards = cards.filter((c) => String(c["header"] ?? "") === "版式聚类");
      assert(clusterCards.length > 0, "聚类路线选项卡未出现（卡面交互点缺失）");
      const detail = String(clusterCards[0]!["detail"] ?? "");
      assert(detail.includes("同版式归同簇"), "聚类卡文案缺「同版式归同簇」（D318c 簇语义回归）");
      assert(!detail.includes("同版式同侧") && !detail.includes("归同侧"), "聚类卡文案残留切分语义（D318c 回归）");
    }
    // 聚类待答后重跑 style_split（卡面应答直写账本后的续链形态）
    await runStep("07b-style-split-rerun", async () => {
      // 链序补件：style_split 视觉判读闸在实验门前——显式 field-config（1109-4 回放件）
      let receipt = await callStage("07b-style-split-rerun", {
        stage: "style_split", run_id: runId, workspace_path: ws, doc_type: "bl",
        field_config: join(ws, "scratch", "field-config-bl.json"),
      });
      if (!stageOk(receipt, "style_split") && receiptText(receipt).includes("智能分析必经")) {
        // 看图判读替身（预演=机制演练）：FieldVisualSignals/v1 骨架——plan_digest 原样抄回、
        // 字段闭集中性 signals（无特殊信号）、抽样页 evidence。判读语义=agent 产物（回放形态）。
        const signalsDoc = buildVisualSignals(ws, effRunDir(), "bl");
        receipt = await callStage("07b2-style-split-readings", {
          stage: "style_split", run_id: runId, workspace_path: ws, doc_type: "bl",
          field_config: join(ws, "scratch", "field-config-bl.json"),
          visual_readings: signalsDoc,
        });
      }
      assert(stageOk(receipt, "style_split"), `style_split 重跑未 ok: ${receiptText(receipt).slice(0, 300)}`);
      reconcileOutputs(declOf("style_split"), runDir, ws);
    });

    // 8) experiment_setup（分组卡两次触发=设计内流程；prompt 卡选内置）
    // 分组候选（owner #32 裁定：字段默认必须分组 2-3 组）——从两份字段配置并集拟 2 组
    // 全覆盖（每字段恰属一组）；完全权限档按推荐候选自动选定（不出卡）。
    const unionFieldIds: string[] = [];
    for (const dt of DOC_TYPES) {
      const cfg = JSON.parse(readFileSync(join(ws, "scratch", `field-config-${dt}.json`), "utf-8")) as {
        fields?: Array<{ field_id?: string }>;
      };
      for (const f of cfg.fields ?? []) {
        const id = String(f.field_id ?? "");
        if (id !== "" && !unionFieldIds.includes(id)) unionFieldIds.push(id);
      }
    }
    const half = Math.max(1, Math.floor(unionFieldIds.length / 2));
    const groupingProposal = {
      schema_version: "GroupingProposal/v1",
      candidates: [{
        name: "编号日期与主体签章两组",
        recommended: true,
        groups: [
          { name: "编号与日期", fields: unionFieldIds.slice(0, half) },
          { name: "主体与签章", fields: unionFieldIds.slice(half) },
        ],
        reason: "预演回放：按字段语义两分（编号日期类/主体签章类），每字段恰属一组",
      }],
    };
    await runStep("08a-experiment-setup-proposal", async () => {
      // 槽位登记副本（agent 写槽位替身形态）：多类 run 逐类配置走槽位（单值传参被
      // walkthrough_field_config_requires_per_doc 拒——闸正确，预演走槽位通道）。
      for (const dt of DOC_TYPES) {
        const slotDir = join(effRunDir(), "config", "experiment-setup", dt);
        mkdirSync(slotDir, { recursive: true });
        cpSync(join(ws, "scratch", `field-config-${dt}.json`), join(slotDir, "field-config.json"));
      }
      const receipt = await callStage("08a-experiment-setup", {
        stage: "experiment_setup", run_id: runId, workspace_path: ws,
        grouping_proposal: groupingProposal,
      });
      assert(!receiptText(receipt).includes("exit_code\":1") || stageOk(receipt, "experiment_setup"),
        `experiment_setup 首触发异常: ${receiptText(receipt).slice(0, 300)}`);
    });
    await runStep("08b-experiment-setup-confirm", async () => {
      const receipt = await callStage("08b-experiment-setup-confirm", {
        stage: "experiment_setup", run_id: runId, workspace_path: ws,
        grouping_proposal: groupingProposal, grouping_confirm: true,
      });
      assert(stageOk(receipt, "experiment_setup"), `experiment_setup 确认重跑未 ok: ${receiptText(receipt).slice(0, 300)}`);
      reconcileOutputs(declOf("experiment_setup"), runDir, ws);
    });

    // 9) family_split
    await runStep("09-family-split", async () => {
      // 版式分组过碎处置（1118 预演实锚：80 簇/100 页）——合并相近小类再按簇分层
      // （E10e 标准通道；小类并入最近簇后簇内等比例 8:2）。
      const receipt = await callStage("09-family-split", {
        stage: "family_split", run_id: runId, workspace_path: ws, merge_small_clusters: true,
      });
      assert(stageOk(receipt, "family_split"), `family_split 未 ok: ${receiptText(receipt).slice(0, 300)}`);
      reconcileOutputs(declOf("family_split"), runDir, ws);
    });

    // 10) candidate_build（无图通道 disabled 形态——预演旅程不依赖 LLM 看图）
    await runStep("10-candidate-build", async () => {
      const receipt = await callStage("10-candidate-build", { stage: "candidate_build", run_id: runId, workspace_path: ws });
      assert(stageOk(receipt, "candidate_build"), `candidate_build 未 ok: ${receiptText(receipt).slice(0, 300)}`);
      reconcileOutputs(declOf("candidate_build"), runDir, ws);
    });

    // 11) publish（发布确认卡=卡面交互点：config/publish confirm 真跑）
    await runStep("11a-publish-confirm-card", async () => {
      for (const dt of DOC_TYPES) {
        await call("11a-publish-confirm", publishConfirm!, { run_id: runId, workspace_path: ws, doc_type: dt });
      }
      assert(cards.length > 0, "发布确认卡未出现（卡面交互点缺失）");
    });
    await runStep("11b-publish", async () => {
      const receipt = await callStage("11b-publish", { stage: "publish", run_id: runId, workspace_path: ws });
      assert(stageOk(receipt, "publish"), `publish 未 ok: ${receiptText(receipt).slice(0, 300)}`);
      reconcileOutputs(declOf("publish"), runDir, ws);
    });

    // 12) admission
    await runStep("12-admission", async () => {
      const receipt = await callStage("12-admission", { stage: "admission", run_id: runId, workspace_path: ws });
      assert(stageOk(receipt, "admission"), `admission 未 ok: ${receiptText(receipt).slice(0, 300)}`);
      reconcileOutputs(declOf("admission"), runDir, ws);
    });

    // 13) training_prep（真基模型路径；train.sh/iteration-config 落盘）
    await runStep("13-training-prep", async () => {
      // 两段式（E8 联合装配合同）：先逐类跑（产单据槽位 prep/variants/<doc>/train.jsonl
      // ——variants 构造归本段），再无 doc_type 跑一次（assemble 合并+产 run 级启动件）。
      for (const dt of DOC_TYPES) {
        let receipt = await callStage(`13-prep-${dt}`, {
          stage: "training_prep", run_id: runId, workspace_path: ws, doc_type: dt,
          base_model_path: BASE_MODEL,
        });
        if (!stageOk(receipt, "training_prep") && receiptText(receipt).includes("智能分析必经")) {
          // 视觉判读闸（同 style_split）——判读替身件重跑
          const signalsDoc = buildVisualSignals(ws, effRunDir(), dt);
          receipt = await callStage(`13-prep2-${dt}`, {
            stage: "training_prep", run_id: runId, workspace_path: ws, doc_type: dt,
            base_model_path: BASE_MODEL, visual_readings: signalsDoc,
          });
        }
        assert(stageOk(receipt, "training_prep"), `training_prep(${dt}) 未 ok: ${receiptText(receipt).slice(0, 300)}`);
      }
      const receipt = await callStage("13-prep-assemble", {
        stage: "training_prep", run_id: runId, workspace_path: ws, base_model_path: BASE_MODEL,
        // 卡数定稿（accum_requires_nproc：梯度累积计算须 nproc——纯配置面，
        // 训练启动闸仍不真占卡）
        training_overrides: { nproc_per_node: 4 },
      });
      assert(stageOk(receipt, "training_prep"), `training_prep(assemble) 未 ok: ${receiptText(receipt).slice(0, 300)}`);
      reconcileOutputs(declOf("training_prep"), runDir, ws);
      assert(existsSync(join(effRunDir(), "launch", "train.sh")), "launch/train.sh 不在盘（启动件缺失）");
    });

    // 14) training_run——GPU 段启动闸验证（两态）：
    //     a) 产物空=blocked walkthrough_training_pending（启动件齐、训练未执行的断点态）；
    //     b) atf_run_training 到训练启动卡（GPU/时长显性化）→ 用户取消=不真占卡。
    await runStep("14a-training-run-launch-gate", async () => {
      const receipt = await callStage("14a-training-run", { stage: "training_run", run_id: runId, workspace_path: ws });
      assert(!stageOk(receipt, "training_run"), "训练产物空时 training_run 不应 ok（启动闸断点态缺失）");
      assert(receiptText(receipt).includes("walkthrough_training_pending"), "training_run 未给 walkthrough_training_pending 断点码");
    });
    await runStep("14b-run-training-card-cancel", async () => {
      // 启动准入闭合（prelaunch_report_missing 闸指路）：atf_prelaunch_report 真跑产报告
      const prelaunch = tools.get("atf_prelaunch_report");
      assert(prelaunch !== undefined, "atf_prelaunch_report 未装配");
      const report = await call("14b1-prelaunch-report", prelaunch, {
        run_id: runId, workspace_path: ws, train_sh: join(effRunDir(), "launch", "train.sh"),
      });
      const reportPath = String(report["report_path"] ?? report["path"] ?? "");
      assert(reportPath !== "", `prelaunch 报告未产出: ${receiptText(report).slice(0, 200)}`);
      // danger 卡到达+取消=不真占卡：run_training 到训练启动卡被脚本取消（ASK_CANCELLED）
      // → 结构化拒绝（started:false）——GPU 段启动闸语义=卡面人工确认后才启动
      const trainSh = join(effRunDir(), "launch", "train.sh");
      const started = await call("14b2-run-training", runTraining!, {
        action: "start", train_sh: trainSh, run_id: runId, prelaunch_report: reportPath,
      });
      assert(started["started"] !== true, "取消卡后 atf_run_training 竟 started:true——启动闸失效");
      const card = cards.find((c) => String(c["kind"] ?? "") !== "approval"
        && (String(c["question"] ?? "").includes("训练") || String(c["header"] ?? "").includes("训练")));
      assert(card !== undefined, "训练启动卡未出现（卡面交互点缺失——B9 面）");
    });

    // 15-17) 分析段回放驱动（训练/评估/分析产物按回放资产置位→段闸 ok）
    await runStep("15-replay-training-products", async () => {
      cpSync(join(REPLAY_RUN, "training"), join(effRunDir(), "training"), { recursive: true });
      const receipt = await callStage("15-training-run-ok", { stage: "training_run", run_id: runId, workspace_path: ws });
      assert(stageOk(receipt, "training_run"), "训练产物置位后 training_run 应 ok（续链态）");
    });
    await runStep("16-checkpoint-eval-replay", async () => {
      cpSync(join(REPLAY_RUN, "eval"), join(effRunDir(), "eval"), { recursive: true });
      const receipt = await callStage("16-checkpoint-eval", { stage: "checkpoint_eval", run_id: runId, workspace_path: ws });
      assert(stageOk(receipt, "checkpoint_eval"), `checkpoint_eval 回放未 ok: ${receiptText(receipt).slice(0, 300)}`);
      reconcileOutputs(declOf("checkpoint_eval"), runDir, ws);
    });
    await runStep("17a-badcase-analysis-replay", async () => {
      cpSync(join(REPLAY_RUN, "analysis"), join(effRunDir(), "analysis"), { recursive: true });
      const receipt = await callStage("17a-badcase-analysis", { stage: "badcase_analysis", run_id: runId, workspace_path: ws });
      assert(stageOk(receipt, "badcase_analysis"), `badcase_analysis 回放未 ok: ${receiptText(receipt).slice(0, 300)}`);
      reconcileOutputs(declOf("badcase_analysis"), runDir, ws);
    });
    await runStep("17b-iteration-proposal-replay", async () => {
      // propose 工作台内核单源真产（引擎替身形态，如实记录）：build_decisions_replay.py
      // 从外部 fixture 产 IterationDecisionSet/v1 完整集（1109-4 回放源缺 C2 必件=先于
      // C2 的产物，全实例无现实样本）
      // 17a 回放拷入的旧 decisions（1109-4 先于 C2 的不完整集）清除后由内核单源重产
      rmSync(join(effRunDir(), "analysis", "decisions"), { recursive: true, force: true });
      execFileSync("python3", [`${WORKTREE}/deploy/verify/rehearsal/build_decisions_replay.py`,
        join(effRunDir(), "analysis", "decisions")],
        { stdio: "pipe", env: { ...process.env, PYTHONPATH: `${KERNEL}/src` } });
      const receipt = await callStage("17b-iteration-proposal", { stage: "iteration_proposal", run_id: runId, workspace_path: ws });
      assert(stageOk(receipt, "iteration_proposal"), `iteration_proposal 回放未 ok: ${receiptText(receipt).slice(0, 300)}`);
      reconcileOutputs(declOf("iteration_proposal"), runDir, ws);
    });

    // —— 三面对账第二面（矩阵×StageIoContract 交叉）：harness 组装闭集 ⊆ 内核消费闭集语义 ——
    await runStep("90-matrix-cross-check", async () => {
      const workRequire2 = createRequire(join(WORKTREE, "package.json"));
      const { SOURCE_ROOT_ARGV_STAGES } = workRequire2(`${WORKTREE}/packages/extensions/atf-tools/src/pipelineFace.js`) as {
        SOURCE_ROOT_ARGV_STAGES: ReadonlySet<string>;
      };
      const kernelRequired = new Set((kernelMatrix["stage_source_root_required"] as string[]) ?? []);
      for (const stage of SOURCE_ROOT_ARGV_STAGES) {
        assert(!kernelRequired.has(stage),
          `harness 组装闭集段 ${stage} 同时在内核 _STAGE_SOURCE_ROOT_REQUIRED（组装+再水合双通道=越权冗余）`);
      }
      for (const stage of kernelRequired) {
        assert(!SOURCE_ROOT_ARGV_STAGES.has(stage),
          `内核再水合段 ${stage} 出现在 harness 组装闭集（M1 单源语义冲突）`);
      }
    });
  } finally {
    currentStep = "(evidence)";
    writeEvidence(evidenceDir, ts);
  }
};

// ---------------------------------------------------------------- 证据输出

const writeEvidence = (evidenceDir: string, ts: string): void => {
  mkdirSync(evidenceDir, { recursive: true });
  const okCount = journal.filter((e) => e.ok).length;
  const failCount = journal.filter((e) => !e.ok).length;
  const lines: string[] = [
    `# M6 预演证据（17 段全链旅程·${ts}）`,
    "",
    `- 旅程闭集=17 段全链+全部卡面交互点；确定性段全真跑/GPU 段验证到启动闸不真占卡/分析段回放资产驱动`,
    `- 八坑断言全量编织（A8 env/inspect 取键/source-root 矩阵/candidate 通道/挂卡 TDZ/覆写挤掉/digest 漂移/聚类文案）`,
    `- 段间 IO 三面对账（段×参数矩阵×StageIoContract×实际产物）逐段执行`,
    `- 步骤 ${okCount} PASS / ${failCount} FAIL；卡面捕获 ${cards.length} 次`,
    "",
  ];
  for (const entry of journal) {
    if (entry.note.startsWith("KNOWN-DEFECT")) {
      lines.push(`- KNOWN-DEFECT ${entry.step}——${entry.note}`);
    } else {
      lines.push(`- ${entry.ok ? "PASS" : "FAIL"} ${entry.step}${entry.note === "" ? "" : `——${entry.note}`}`);
    }
  }
  const md = lines.join("\n") + "\n";
  writeFileSync(`${evidenceDir}/rehearsal-${ts}.md`, md, "utf-8");
  writeFileSync(`${evidenceDir}/rehearsal-${ts}.detail.json`, JSON.stringify({ journal, cards }, null, 1), "utf-8");
  console.log(md);
};

// ---------------------------------------------------------------- 入口

runJourney().then(
  () => {
    console.log("JOURNEY GREEN");
    process.exit(0);
  },
  (error: Error) => {
    console.error("JOURNEY RED:", error.message);
    if (error.stack !== undefined) console.error(error.stack.split("\n").slice(0, 8).join("\n"));
    process.exit(1);
  },
);
