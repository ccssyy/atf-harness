/**
 * 批⑱-M2——确认卡工具面（ui-atf-confirm 的数据与语义源）。
 *
 * atf_config_confirm：九要素训练配置确认卡——构造/改参/重呈/快照全链复用手搓
 * src/webui/configConfirm.ts（buildConfigConfirmFields/saveConfigSnapshot——逻辑零重写）。
 * 批㊶-W F5 合并版表单化（R2）：第一段改参收集＝DSH 原生问题卡 form intent 表单卡
 * （vendor patch 0003——逐键输入框＋现值预填＋clamp 域提示；结构化 key=value selected 回传，
 * 协议零改动）；第二段授权＝审批卡 Allow once（账本留痕不变）。审批卡 Reject → 回表单卡
 * （带上次值）循环；纯文字 amend 解析链退役（工具链零文字解析引用——自由文本
 * 永不直达生成面，agent 语义理解走结构化 edits 参数）。
 * atf_publish_confirm：发布确认 digest 卡（契约件 digest 凭据同构）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { buildConfigConfirmFields, saveConfigSnapshot } from "../../../../src/webui/configConfirm.js";

/** 卡面字段（buildConfigConfirmFields 返回形态——本地结构类型；批㊶-Q 增第四态 agent_recommend，
 *  仅全自动档采纳 agent 参数推荐时由本文件后处理标注，buildConfigConfirmFields 不产出该态）。
 *  A1 导出：configFormFieldsOf／回归断言共用。 */
export type ConfigConfirmField = { key: string; value: string; tag: "need_confirm" | "from_registry" | "default_used" | "agent_recommend" };
import { approvalDeniedResult, requestApproval } from "./approvalFace.js";
import { appendAskFailureDiagnostic } from "./askDiagnostics.js";
import { appendSegmentFact } from "../../../../src/core/workspace/segmentFacts.js";
import { appendNotification } from "../../../../src/core/workspace/trainProbe.js";
import { evalAgentRecommend, type RecommendVerdict } from "../../../../src/core/workspace/agentRecommend.js";
import { isAutoTrainingTier, AUTO_TRAINING_PRESET } from "./autoTrainingTier.js";
import {
  FIXED_SMART_DEFAULTS,
  CLAMP_DOMAINS,
  TRAINING_PIN_CONSTANTS,
  deriveGradAccum,
  clampLearningRate,
  clampEpochs,
  clampLoraRank,
  loraAlphaFor,
  clampCutoffLen,
  clampImageMaxPixels,
  clampNegativeRatio,
  SMART_DEEPSPEED_DEFAULT,
  applyConfirmedToIterationConfig,
  detectAvailableGpuCount,
  guardNprocAntiPatterns,
  defaultBaseModelPath,
} from "../../../../src/core/workspace/smartDefaults.js";
import { appendBinding } from "../../../../src/core/workspace/runFacts.js";
import { resolveRunDir, sessionWorkspaceSlug } from "../../../../src/core/workspace/runLayout.js";
import { openSettingsStore } from "../../../../src/webui/settings.js";
import { instanceSettingsPath } from "../../../../src/webui/storageSettings.js";

/** 批㊶-N N-5：会话身份提取（exec.agent.session.id；取不到＝undefined 如实跳过）。 */
const sessionIdOfExec = (exec: unknown): string | undefined => {
  const id = (exec as { agent?: { session?: { id?: unknown } } }).agent?.session?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
};
import { asToolValue } from "./schemaTranslate.js";

/** DSH user-questions 服务消费面（结构类型——零 import；plan-mode 同款直调 ask() 通道）。
 *  批㊶-P1 S3：导出共享——atf_run_training 双启请示闸同走本通道（请示是一等工具）。 */
export interface FormAskService {
  ask(request: {
    questions: ReadonlyArray<{
      id: string;
      question: string;
      header?: string;
      detail?: string;
      intent: {
        kind: "form";
        fields: ReadonlyArray<{ key: string; label: string; value?: string; placeholder?: string; hint?: string; required?: boolean }>;
        submitLabel?: string;
      };
    }>;
    agent?: unknown;
    signal?: unknown;
  }): Promise<{ answers: ReadonlyArray<{ id: string; selected: ReadonlyArray<string>; custom?: string }> }>;
}

/** 表单卡问题对象单源（A1：confirmFace/trainingFace 两调用面与源面回归断言
 *  tests/dshTools/askFormIntent.test.ts 同构——intent 形态漂移即测试红）。
 *  可选键条件 spread（typert lossless 拒绝嵌套 undefined——批㊶-W 真机修正同纪律）。 */
export const formAskQuestion = (q: {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  fields: ReadonlyArray<{ key: string; label: string; value?: string; placeholder?: string; hint?: string; required?: boolean }>;
  submitLabel: string;
}): {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  intent: { kind: "form"; fields: ReadonlyArray<{ key: string; label: string; value?: string; placeholder?: string; hint?: string; required?: boolean }>; submitLabel: string };
} => ({
  id: q.id,
  question: q.question,
  ...(q.header !== undefined ? { header: q.header } : {}),
  ...(q.detail !== undefined ? { detail: q.detail } : {}),
  intent: { kind: "form", fields: q.fields, submitLabel: q.submitLabel },
});

/** 确认卡字段 → 表单卡逐键输入行（label＝键名·现值预填·clamp 域 hint；max_total_tokens
 *  空值＝必填拦空兜底）。A1：与回归断言单源。 */
export const configFormFieldsOf = (fields: ConfigConfirmField[], gpuCount: number | null) =>
  fields.map((field) => {
    const hint = domainHintOf(field.key, gpuCount);
    return {
      key: field.key,
      label: field.key,
      value: field.value,
      ...(hint !== undefined ? { hint } : {}),
      ...(field.key === "max_total_tokens" && field.value.trim() === ""
        ? { required: true, placeholder: "必填（token 上限缺省已退役——填正整数，单源参考 65536）" }
        : {}),
    };
  });

/** 表单卡答案 → 结构化 edits（selected 逐条 `key=value`——首个 = 拆分；结构化解析，
 *  非自由文本正则——批㊶-W F5 文字解析链退役后的唯一回传面）。 */
export const editsFromFormAnswers = (answers: { answers: ReadonlyArray<{ id: string; selected: ReadonlyArray<string> }> }): Record<string, string> => {
  const edits: Record<string, string> = {};
  for (const item of answers.answers) {
    for (const entry of item.selected) {
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      const key = entry.slice(0, eq).trim();
      if (key !== "") edits[key] = entry.slice(eq + 1).trim();
    }
  }
  return edits;
};

/** clamp 域提示（表单卡逐键 hint——min/max 可读；数值全部单源派生零硬编码）。 */
export const domainHintOf = (key: string, gpuCount: number | null): string | undefined => {
  switch (key) {
    case "learning_rate":
      return `域 [${CLAMP_DOMAINS.lr.min.toExponential().replace("e-", "e-")}, ${CLAMP_DOMAINS.lr.max.toExponential()}]（LoRA 惯用科学计数法）`;
    case "num_train_epochs":
      return `域 [${CLAMP_DOMAINS.epochs.min}, ${CLAMP_DOMAINS.epochs.max}] 整数`;
    case "lora_rank":
      return `档位 {${CLAMP_DOMAINS.lora_rank.join(", ")}}（alpha=2×rank 联动）`;
    case "cutoff_len":
      return `≤ ${CLAMP_DOMAINS.cutoff_len.max}`;
    case "image_max_pixels":
      return `两档 {${(CLAMP_DOMAINS.image_max_pixels as number[]).join(", ")}}`;
    case "negative_ratio_target":
      return `构造带 [${CLAMP_DOMAINS.negative_ratio.min}, ${CLAMP_DOMAINS.negative_ratio.max}]`;
    case "nproc_per_node":
      return gpuCount !== null ? `[1, 可用卡数 ${gpuCount}]` : "须为本机可用卡数内（机器事实）";
    case "max_total_tokens":
      return `正整数（单源参考 ${TRAINING_PIN_CONSTANTS.max_total_tokens}）`;
    default:
      return undefined;
  }
};

/** 三态标记（卡面文本化：⚠ 已用缺省／◆ 来自登记／? 需确认——与手搓批⑮三态标签同源语义）。
 *  批㊶-Q 增第四态：◇ agent 推荐（全自动档采纳的 agent 参数推荐——来源标注进 sources/通报）。 */
const TAG_MARK: Record<ConfigConfirmField["tag"], string> = {
  default_used: "已用缺省 ⚠",
  from_registry: "来自登记 ◆",
  need_confirm: "需确认 ?",
  agent_recommend: "agent 推荐 ◇",
};

const renderFields = (fields: ConfigConfirmField[]): string =>
  fields.map((field) => `  ${field.key}: ${field.value}（${TAG_MARK[field.tag]}）`).join("\n");

const cardBlocks = (title: string, fields: ConfigConfirmField[], note: string) => [
  { type: "text" as const, text: `${title}\n${renderFields(fields)}\n${note}` },
];

interface ConfirmDeps {
  runsRoot: string;
  ctx: { get(service: string): unknown };
  /** 批㊶R前置：可用卡数探测注入（vitest 假件；缺省＝真实机器事实通道 nvidia-smi/CUDA_VISIBLE_DEVICES）。 */
  gpuProbe?: () => number | null;
}

/** pending 卡落盘（刷新重建源：<runDir>/webui/pending-confirm.json——runDir 双形态解析归调用方）。 */
const writePending = (runDir: string, payload: Record<string, unknown>): void => {
  const dir = join(runDir, "webui");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pending-confirm.json"), `${JSON.stringify(payload, null, 1)}\n`, "utf8");
};

/** 批㊶Q增补二3：pending 卡清理（确认/放行完成后——备份先行改名 .answered.<毫秒戳>.json，
 *  审计留存；文件缺席/改名失败静默 fail-open）。残留实证：P 批 run-regress-large-pl 确认
 *  完成后卡文件留存 8h＋，UI 持续渲染待确认态。批㊶Q增补三段4.2：存量残留在同步器侧
 *  sweepAnsweredPendings 兜底（完成证据判据），本函数只管本 run 完成即清。 */
const clearPending = (runDir: string): void => {
  try {
    const path = join(runDir, "webui", "pending-confirm.json");
    if (!existsSync(path)) return;
    renameSync(path, `${path}.answered.${Date.now()}.json`);
  } catch { /* fail-open */ }
};


/** 批㊶-U §五：双段式共用 helper（问题卡收改参→amend 校验 clamp 重呈→审批卡落闸）。
 *  四张确认卡统一复用（九要素/评估 EVAL_RELEASE/凭据卡退化/S1 publish_model 随后）——
 *  禁每卡手搓。批㊶-W F5：第一段指引改表单卡语义（改参在表单卡改值提交；纯文字应答
 *  通道退役）；第二段授权仍走审批卡 Allow once（账本留痕不变）。凭据卡（amendable=false）
 *  退化形式：仅统一卡面说明＋复核通道，不虚构可调参数（诚实呈现原则）。 */
export const dualStageNote = (cardLabel: string, opts?: { amendable?: boolean; amendNote?: string; extra?: string }): string => {
  const amendable = opts?.amendable !== false;
  const head = amendable
    ? `${cardLabel}（双段式：改参在表单卡改值提交；不改直接提交表单，再于审批卡点 Allow once）`
    : `${cardLabel}（凭据确认卡：无可调参数；如对凭据有疑义请回复说明，复核通道＝聊天重呈）`;
  const tail = [opts?.amendNote, opts?.extra].filter((x): x is string => typeof x === "string" && x !== "");
  return [head, ...tail].join("｜");
};

/** 批㊶-S1 门2修复：atf_bash 围栏可写根注入（run 绑定处写入——随 run 切换更新；
 *  进程级 env last-write-wins，并发会话互踩局限执行报告如实登记）。 */
export const injectBashRunWorkspace = (runDir: string): void => {
  process.env["ATF_BASH_RUN_WORKSPACE"] = runDir;
};

export const buildConfirmTools = (deps: ConfirmDeps): unknown[] => {
  const { ctx } = deps;
  // 批㊶R前置②：可用卡数机器事实（建卡期一次探测；null＝缺失→建卡时按 machine-facts 停下问）
  const gpuCount = detectAvailableGpuCount(process.env, deps.gpuProbe);

  const configTool = defineTool({
    name: "atf_config_confirm",
    description:
      "九要素训练配置确认卡：action=present 构造/重呈九要素卡（overrides 传显式覆盖值）；action=amend 应用结构化改参（edits 传键值对象）后重呈。合并版双段式编排（present/amend 同链）：第一段改参收集——工具内部直接以 DSH 原生问题卡 form intent 表单卡向用户呈十五键逐键输入框（现值预填＋clamp 域提示），用户改值/直接提交即回结构化 key=value；第二段授权——有改动走确定性 clamp（越界回退域边界＋可读说明），最终授权一律走审批卡 Allow once（账本留痕不变）；审批卡 Reject → 回表单卡（带上次值）循环，用户关闭表单卡＝取消（结构化拒绝）。问题卡只收集改参、不承载授权（审批≠请示，闸门语义不迁移）；用户在聊天里的改参话术由 agent 语义理解后转 edits 结构化参数（自由文本永不直达生成面）。现值基线＝已确认快照＞run 的 IterationConfig 实值（prep/iteration-config——登记源，卡面与 Web 摘要同源）＞缺省。手动档（权限档）：审批面板 Allow once 确认后 config-snapshot 落盘。全自动训练档（会话档位=auto_training，经界面人工切换）：present 免审批——以智能缺省（L3 clamp 建议＋L2 派生）＋agent 参数推荐直接落快照，卡面内容转为通报（告警行＋alerts.json，每键取值＋来源标注可回看）；改参仍走 amend（同样免阻塞）。" +
      "全自动档 agent 参数推荐（recommend 参数，本档专属）：训练提交前基于任务描述＋数据集统计（样本数/长度分布/模态）＋经验锚点给出 epochs/lr/rank/cutoff/负样本带推荐值并附 reason（理由）。经验锚点（owner 手工训练经验，参考知识非硬规则）：样本 2万–3万 → 3 epochs；4万以上 → 2 epochs；小样本（<1万）宜多轮并防过拟合（配早停观察）。护栏：epochs∈[1,10] 整数、lr∈[5e-5,5e-4]、lora_rank∈{16,32,64,128}（alpha=2×rank 联动）、cutoff≤12800、像素两档∈{802816,1605632}（单源）、负样本构造带∈[0.02,0.05]（F2 R1 终裁——空对象构造配额）、bs 正整数、nproc∈[1,可用卡数]——越界推荐被拦截并回退固定建议（不静默修正），拦截事实进通报；推荐缺失同样回退。lora_alpha 不单独推荐（随 rank 联动）。" +
      "基模型锚点（owner 裁定 2026-10-12 §九）：确认卡基模型字段默认值＝模型库位置下的 Qwen3-VL-32B-Instruct（owner 偏置锚点，非查表推导；卡上可改，改动经防线①本地复核）。评估侧继续锚定 -AWQ 变体（现状不变）。" +
      "卡数偏置（owner 裁定 2026-10-11）：训练卡数默认拉满本机可用卡（nproc_per_node=机器事实可用卡数），训练时长优先；代价（显存/时长）如实呈现给用户，不作降档依据；降档仅在用户任务上下文明确要求时采纳。卡数维度无成文锚点——不编造「数据规模→卡数」映射、不查表推荐，卡数只来自机器事实与用户显式要求；自动档默认低于可用卡的 nproc 推荐会被护栏回退拉满。",
    parameters: {
      action: { type: "string", required: true, enum: ["present", "amend"], description: "present=构造/重呈卡；amend=应用结构化改参后重呈（edits 键值对象）" },
      run_id: { type: "string", required: true, description: "run 标识（快照与 pending 卡落点）" },
      overrides: { type: "object", additionalProperties: true, description: "显式覆盖值（present 形态：{learning_rate:\"2e-4\",...}）" },
      edits: { type: "object", additionalProperties: true, description: "amend 结构化改参（用户聊天话术经 agent 语义理解后的键值对象，如 {num_train_epochs:\"4\", learning_rate:\"2e-4\"}）——clamp 校验后随表单卡重呈双确认" },
      recommend: { type: "object", additionalProperties: true, description: "全自动档专属 agent 参数推荐：{epochs:3, learning_rate:\"2e-4\", lora_rank:32, cutoff_len:9000, reason:\"2.8万样本→3 epochs 防欠拟合\"}——越界键被拦截回退，手动档不消费" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    presentCall: function(args: { action: string; run_id: string }) {
      // pending 态卡面——九要素确认标题（具体 fields 在 execute 中构造后经 content 呈现）
      return {
        card: "generic" as const,
        title: args.action === "amend" ? `九要素配置确认（改参重呈）— ${args.run_id}` : `九要素训练配置确认 — ${args.run_id}`,
        kind: "other" as const,
      }
    },
    async execute(args: { action: "present" | "amend"; run_id: string; overrides?: Record<string, unknown>; edits?: Record<string, unknown>; recommend?: Record<string, unknown> }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      // 批㊶Q增补三 段3：run 目录双形态解析（新建带发起会话工作区归属——runs/<工作区>/<run_id>）
      const runDir = resolveRunDir(deps.runsRoot, args.run_id, { workspace: sessionWorkspaceSlug(exec) });
      // 现值基线：已确认快照（不重问）→ run 的 IterationConfig 实值（批㉛段2：登记源，确认卡
      // 与 Web 摘要同源——deepspeed 等实值不再落回泛化缺省）→ pending 卡现值 → 缺省
      const snapshotPath = join(runDir, "webui", "config-snapshot.json");
      // saveConfigSnapshot 形态＝{schema_version, confirmed}——基线取 confirmed 子对象
      // （批㉛段2 修正：原实现整文件映射，快照确认值从未真正入卡基线）
      const snapshot = (() => {
        if (!existsSync(snapshotPath)) return {} as Record<string, string>;
        try {
          const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as { confirmed?: Record<string, string> };
          return parsed.confirmed ?? ({} as Record<string, string>);
        } catch {
          return {} as Record<string, string>;
        }
      })();
      const iterPath = join(runDir, "prep", "iteration-config", "iteration-config.json");
      let iterTraining: Record<string, string> = {};
      if (existsSync(iterPath)) {
        try {
          const iter = JSON.parse(readFileSync(iterPath, "utf8")) as { training?: Record<string, unknown> };
          if (iter.training !== undefined && iter.training !== null && typeof iter.training === "object") {
            for (const [key, value] of Object.entries(iter.training)) {
              if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") iterTraining[key] = String(value);
            }
          }
        } catch {
          iterTraining = {};
        }
      }
      // 批㊶-P P-1：三层智能缺省组装——
      //   L3 模型建议值（iteration-config 建议）经 harness clamp（epochs/lr/rank/cutoff/像素）；
      //   L2 派生（global_batch=256 目标 → accum 派生；deepspeed 缺省切 ds_z3_offload）；
      //   L1 固定智能缺省（用户不感知——确认卡不展开，落 train.sh 生成面）。
      // 保守缺省（bs1/accum8）仅作建议值缺失时兜底——链路级修正（bl run bs2/accum8/128 被打回
      // bs1/accum1/8 的根因＝实验门 train 段空时 TRAINING_REQUIRED_KEY_DEFAULTS 直落）。
      const L3_CLAMPERS: Record<string, (raw: string | number) => string | number> = {
        learning_rate: clampLearningRate,
        num_train_epochs: clampEpochs,
        lora_rank: clampLoraRank,
        cutoff_len: clampCutoffLen,
        image_max_pixels: clampImageMaxPixels,
      };
      for (const key of Object.keys(iterTraining)) {
        const clamp = L3_CLAMPERS[key];
        const rawValue = iterTraining[key];
        if (clamp !== undefined && rawValue !== undefined) iterTraining[key] = String(clamp(rawValue));
      }
      if (iterTraining["lora_rank"] !== undefined) iterTraining["lora_alpha"] = String(loraAlphaFor(Number(iterTraining["lora_rank"])));
      const baseline = { ...iterTraining, ...snapshot };
      const rawOverrides = (args.overrides ?? {}) as Record<string, unknown>;
      const overrides: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawOverrides)) overrides[key] = String(value);
      let amendNote: string | undefined;
      let amended: Record<string, string> | undefined;
      // 批㊶-W F5：结构化值域 clamp 表（amend edits 与表单卡提交共用——文字解析链退役，
      // clamp 只认结构化值；负样本构造带 F2 入表）。
      const STRUCTURED_CLAMPERS: Record<string, (raw: string | number) => string | number> = {
        learning_rate: clampLearningRate,
        num_train_epochs: clampEpochs,
        lora_rank: clampLoraRank,
        cutoff_len: clampCutoffLen,
        image_max_pixels: clampImageMaxPixels,
        negative_ratio_target: clampNegativeRatio,
      };
      const clampEdits = (edits: Record<string, string>): string[] => {
        const clampedKeys: string[] = [];
        for (const [key, rawValue] of Object.entries(edits)) {
          const clamp = STRUCTURED_CLAMPERS[key];
          if (clamp === undefined) continue;
          const clamped = String(clamp(rawValue));
          if (clamped !== String(rawValue).trim()) {
            edits[key] = clamped;
            clampedKeys.push(`${key}=${String(rawValue).trim()}→${clamped}`);
          }
        }
        return clampedKeys;
      };
      if (args.action === "amend") {
        // 批㊶-W F5：结构化 amend——edits 键值对象（用户聊天话术经 agent 语义理解后转入）；
        // 自由文本解析链退役（自由文本永不直达生成面）。
        const rawEdits = (args.edits ?? {}) as Record<string, unknown>;
        if (Object.keys(rawEdits).length === 0) {
          return asToolValue({ ok: false, run_id: args.run_id, note: "amend 需结构化 edits（键值对象，如 {\"num_train_epochs\":\"4\",\"learning_rate\":\"2e-4\"}）——请把用户改参话术转成具体键值后传入；自由文本不再解析（表单化）" });
        }
        amended = {};
        for (const [key, value] of Object.entries(rawEdits)) amended[key] = String(value);
        // 改参值一律过确定性护栏（同 L3 clamp 域）——越界回退到域边界＋说明可读（不静默）
        const clampedKeys = clampEdits(amended);
        amendNote = `已按结构化改参重呈：${Object.keys(amended).join(", ")}；其余按现值${clampedKeys.length > 0 ? `；越界拦截回退（域边界）：${clampedKeys.join("、")}` : ""}`;
      }
      // 批㊶R前置②：卡数基线＝机器事实拉满（owner 裁定：训练默认拉满可用卡·训练时长优先）——
      // iteration-config/快照显式值（from_registry）优先保留；用户显式覆盖（overrides/amend）
      // 次之且可低于机器事实（降档仅用户明确要求）；两者皆缺且机器事实缺失＝machine-facts
      // 停下问（不设默认值——指令硬约束）
      // 批㊶-S5 §九：基模型路径基线（默认锚点＝模型库位置下 Qwen3-VL-32B-Instruct——owner 偏置，
      // 卡上可改；模型库未配置则不注入、字段走空缺省需确认）
      if (baseline["base_model_path"] === undefined) {
        const anchor = defaultBaseModelPath(process.env);
        if (anchor !== null) baseline["base_model_path"] = anchor;
      }
      // 批㊶-S5 门2修复①：训练卡数基线取值链——设置面五字段块 train_gpu_baseline ＞
      // 未配置回退探测拉满（gpuCount）＞ 机器事实缺失停下问（§二③语义；确认卡仍逐次可改）
      const settingsBaseline: string | null = ((): string | null => {
        try {
          const raw = openSettingsStore(instanceSettingsPath(process.env)).get().storage.train_gpu_baseline.trim();
          return raw !== "" && Number.isFinite(Number(raw)) && Number(raw) > 0 ? raw : null;
        } catch {
          return null;
        }
      })();
      const explicitNproc = overrides["nproc_per_node"] ?? amended?.["nproc_per_node"];
      if (baseline["nproc_per_node"] === undefined && explicitNproc === undefined) {
        if (settingsBaseline !== null) {
          baseline["nproc_per_node"] = settingsBaseline;
        } else if (gpuCount === null) {
          return asToolValue({ ok: false, run_id: args.run_id, error: "machine_facts_missing", note: "训练卡数基线不可得：visible_devices（CUDA_VISIBLE_DEVICES）与 nvidia-smi 皆未提供可用卡数——停下问用户，不设默认值" });
        } else {
          baseline["nproc_per_node"] = String(gpuCount);
        }
      }
      // L2 派生（bs×nproc 除尽 256 校验——除不尽/矛盾即停点问题串；nproc 用基线/显式卡数非静态缺省）
      const bsNum = Number(baseline["per_device_train_batch_size"] ?? 2);
      const nprocNum = Number(baseline["nproc_per_node"] ?? explicitNproc);
      if (!Number.isFinite(nprocNum) || nprocNum <= 0) {
        return asToolValue({ ok: false, run_id: args.run_id, error: "nproc_invalid", note: `nproc_per_node 现值（${baseline["nproc_per_node"] ?? explicitNproc}）非正整数——停下核实，不猜测` });
      }
      const accumDerived = deriveGradAccum(Number.isFinite(bsNum) && bsNum > 0 ? bsNum : 2, nprocNum);
      if ("error" in accumDerived) {
        return asToolValue({ ok: false, run_id: args.run_id, error: "global_batch_derive_failed", note: accumDerived.error });
      }
      baseline["gradient_accumulation_steps"] = String(accumDerived.accum);
      // P-1c：deepspeed 智能缺省＝ds_z3_offload（显式 > 缺省——iteration-config 显式声明优先）
      if (baseline["deepspeed"] === undefined) baseline["deepspeed"] = SMART_DEEPSPEED_DEFAULT;
      let fields: ConfigConfirmField[] = (() => {
        if (amended === undefined) return buildConfigConfirmFields(overrides, { fromRegistry: Object.keys(baseline).length > 0 ? baseline : undefined });
        // 改参重呈：现值基线保持原三态，仅应答改动项升 need_confirm（值替换）
        const base = buildConfigConfirmFields({}, { fromRegistry: Object.keys(baseline).length > 0 ? baseline : undefined });
        return base.map((field) => (amended[field.key] !== undefined ? { key: field.key, value: String(amended[field.key]), tag: "need_confirm" as const } : field));
      })();
      // 批㊶-Q 段2：全自动档分支——档位=auto_training 时不调用 requestApproval 阻塞，
      // 以智能缺省（L3 clamp 建议＋L2 派生）＋agent 参数推荐（护栏校验）直接落 config-snapshot，
      // 卡面内容转为通报（告警行＋alerts.json，含每键取值＋来源标注）。手动档行为零变化。
      const autoTier = isAutoTrainingTier(ctx, exec);
      const recommendReport: RecommendVerdict[] = [];
      const reason = (() => {
        const rawRecommend = (args.recommend ?? {}) as Record<string, unknown>;
        return typeof rawRecommend["reason"] === "string" ? rawRecommend["reason"] : undefined;
      })();
      if (autoTier && args.action !== "amend") {
        const rawRecommend = (args.recommend ?? {}) as Record<string, unknown>;
        const baselineByKey = new Map(fields.map((field) => [field.key, field.value]));
        for (const [key, value] of Object.entries(rawRecommend)) {
          if (key === "reason") continue;
          const baselineValue = baselineByKey.get(key) ?? "";
          const verdict = evalAgentRecommend(key, value, baselineValue, reason, { maxNproc: gpuCount });
          recommendReport.push(verdict);
          if (verdict.accepted) {
            const field = fields.find((f) => f.key === key);
            if (field !== undefined) {
              field.value = verdict.terminal;
              field.tag = "agent_recommend";
            }
            // alpha 随 rank 联动（确定性，非判断）：rank 推荐被采纳 → alpha=2×rank 同标 agent 推荐
            if (key === "lora_rank") {
              const alphaField = fields.find((f) => f.key === "lora_alpha");
              if (alphaField !== undefined) {
                alphaField.value = String(loraAlphaFor(Number(verdict.terminal)));
                alphaField.tag = "agent_recommend";
                recommendReport.push({ key: "lora_alpha", accepted: true, terminal: alphaField.value, source: verdict.source, note: `alpha 随 rank=${verdict.terminal} 联动（2×rank）` });
              }
            }
          }
        }
        // bs 被推荐改动 → accum 重派生（L2 整除校验，除不尽即停点问题串，禁静默取整）
        const bsField = fields.find((f) => f.key === "per_device_train_batch_size");
        const baselineBs = String(baseline["per_device_train_batch_size"] ?? "");
        if (bsField !== undefined && bsField.value !== baselineBs) {
          const bsNumNew = Number(bsField.value);
          if (!Number.isFinite(bsNumNew) || bsNumNew <= 0 || !Number.isInteger(bsNumNew)) {
            return asToolValue({ ok: false, run_id: args.run_id, error: "recommend_bs_invalid", note: `推荐 bs=${bsField.value} 不是正整数——拦截，未落快照` });
          }
          const reDerived = deriveGradAccum(bsNumNew);
          if ("error" in reDerived) {
            return asToolValue({ ok: false, run_id: args.run_id, error: "global_batch_derive_failed", note: reDerived.error });
          }
          const accumField = fields.find((f) => f.key === "gradient_accumulation_steps");
          if (accumField !== undefined) {
            accumField.value = String(reDerived.accum);
            accumField.tag = "agent_recommend";
            recommendReport.push({ key: "gradient_accumulation_steps", accepted: true, terminal: String(reDerived.accum), source: "default:harness-smart-defaults", note: `accum 随 bs=${bsField.value} 派生（gb=${reDerived.globalBatch} 不变）` });
          }
        }
      }
      // 批㊶R前置④：反模式拦截（确定性——建卡时；本 fields 即生效配置输入，拦截先于卡面/快照）
      //   A. 单卡×z3_offload → 回退可用卡数＋note；B. 超机器事实上限/非用户显式低配 → 回退拉满
      //   （need_confirm＝用户显式降档放行）；回退后 accum 随卡数重派生（整除校验不过即停点）。
      const guardResult = guardNprocAntiPatterns(fields, { gpuCount, baselineNproc: settingsBaseline });
      if ("error" in guardResult) {
        return asToolValue({ ok: false, run_id: args.run_id, error: "nproc_anti_pattern_blocked", note: guardResult.error });
      }
      const guardNotes: string[] = [];
      for (const hit of guardResult.hits) {
        if (hit.key !== "nproc_per_node") continue;
        const nprocField = fields.find((f) => f.key === "nproc_per_node");
        if (nprocField !== undefined) nprocField.value = hit.revertedTo;
        const bsField = fields.find((f) => f.key === "per_device_train_batch_size");
        const bsGuard = Number(bsField?.value ?? "2");
        const reDerived = deriveGradAccum(Number.isFinite(bsGuard) && bsGuard > 0 ? bsGuard : 2, Number(hit.revertedTo));
        if ("error" in reDerived) {
          return asToolValue({ ok: false, run_id: args.run_id, error: "global_batch_derive_failed", note: reDerived.error });
        }
        const accumField = fields.find((f) => f.key === "gradient_accumulation_steps");
        if (accumField !== undefined) accumField.value = String(reDerived.accum);
        guardNotes.push(hit.note);
      }
      const title = args.action === "amend" ? `九要素配置确认（改参重呈）— run ${args.run_id}` : `九要素训练配置确认 — run ${args.run_id}`;
      // 批㊶-W F5：双段式文案（共用 helper——表单卡改值提交，聊天打字路径退役）
      const baseNote = dualStageNote("九要素确认卡", { amendNote: amendNote });
      const note = guardNotes.length > 0 ? `${baseNote}\n${guardNotes.join("\n")}` : baseNote;
      if (autoTier) {
        // —— 全自动档：免阻塞落快照＋通报呈现（无静默：每键取值＋来源标注可回看） ——
        const sources: Record<string, string> = {};
        for (const field of fields) {
          sources[field.key] =
            field.tag === "agent_recommend"
              ? (recommendReport.find((v) => v.key === field.key && v.accepted)?.source ?? "default:harness-smart-defaults")
              : field.tag === "need_confirm"
                ? "user-specified"
                : "default:harness-smart-defaults";
        }
        const confirmed: Record<string, string> = {};
        for (const field of fields) confirmed[field.key] = field.value;
        const rejectedNotes = recommendReport.filter((v) => !v.accepted).map((v) => v.note);
        const recommendSummary = args.action === "amend"
          ? `；改参：${Object.keys(amended ?? {}).join(", ") || "（纯确认）"}`
          : recommendReport.length > 0
            ? `；agent 推荐：${recommendReport.map((v) => `${v.key}=${v.terminal}${v.accepted ? "✓" : "✗"}`).join(" ")}${reason !== undefined && reason.trim() !== "" ? `（理由：${reason.replace(/\s+/g, " ").slice(0, 80)}）` : ""}`
            : "；agent 推荐缺失——全键回退固定建议";
        const notification = `全自动训练档·配置自动确认（免审批，run ${args.run_id}）——${fields.map((f) => `${f.key}=${f.value}[${sources[f.key]}]`).join(" ")}${recommendSummary}${rejectedNotes.length > 0 ? `；拦截：${rejectedNotes.join("；")}` : ""}${guardNotes.length > 0 ? `；卡数护栏：${guardNotes.join("；")}` : ""}`;
        // 不写 pending 卡（无卡可应答——卡面内容转为通报）；改参走 amend 纯文字（同样免阻塞）
        appendNotification(runDir, { level: "info", kind: "config_auto", reason: notification, since: new Date().toISOString() });
        saveConfigSnapshot(runDir, confirmed, { auto: true, tier: AUTO_TRAINING_PRESET, sources });
        // 批㊶Q增补二3：自动档同样确认完成——历史残留 pending 卡（如手动卡后切档）一并清理
        clearPending(runDir);
        const iterConfigLiveAuto = join(runDir, "prep", "iteration-config.json");
        const iterConfigLegacyAuto = join(runDir, "prep", "iteration-config", "iteration-config.json");
        for (const candidate of [iterConfigLiveAuto, iterConfigLegacyAuto]) {
          const patched = applyConfirmedToIterationConfig(candidate, confirmed, "default:harness-smart-defaults", sources);
          void patched;
        }
        appendSegmentFact(runDir, "experiment_config", "atf_config_confirm");
        const sessionIdAuto = sessionIdOfExec(exec);
        if (sessionIdAuto !== undefined) appendBinding(runDir, sessionIdAuto);
        injectBashRunWorkspace(runDir); // 批㊶-S1 门2修复：围栏可写根随 run 切换更新
        return asToolValue({
          ok: true,
          run_id: args.run_id,
          confirmed: true,
          auto: true,
          tier: AUTO_TRAINING_PRESET,
          fields,
          sources,
          ...(recommendReport.length > 0 ? { recommend_report: recommendReport } : { recommend: "missing_fallback_defaults" }),
          notification,
          snapshot: "webui/config-snapshot.json",
          ...(amendNote !== undefined ? { amend: amendNote } : {}),
        });
      }
      if (args.recommend !== undefined) {
        // 手动档：recommend 为全自动档专属通道——零消费零行为变化（回归红线），仅如实回注
        return asToolValue({ ok: false, run_id: args.run_id, note: "recommend 为全自动训练档专属（当前会话为权限档）——手动档请用 overrides/edits 结构化改参；档位切换须经界面人工操作" });
      }
      // —— 批㊶-W F5：表单卡双段式（手动档）——
      // 第一段＝DSH 原生问题卡 form intent（vendor patch 0003）：逐键输入框＋现值预填＋clamp
      // 域提示；提交回结构化 key=value selected。第二段＝审批卡 Allow once（账本不变）。
      // Reject → 回表单卡（带上次值）循环；关闭表单卡（ASK_CANCELLED）＝结构化取消。
      const userQuestions = ctx.get("userQuestions") as FormAskService | undefined;
      if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
        return asToolValue({ ok: false, run_id: args.run_id, error: "user_questions_unavailable", note: "DSH user-questions 服务未挂载——表单卡通道不可用（fail-closed；不退纯文字链）" });
      }
      writePending(runDir, { kind: "config_confirm", run_id: args.run_id, title, fields, note, at: new Date().toISOString() });
      for (;;) {
        // 批㊶-W 真机修正：typert lossless JSON 拒绝嵌套 undefined（对象键值 undefined
        // 即「not lossless JSON data」）——可选键一律条件 spread，禁显式 undefined 值。
        const formFields = configFormFieldsOf(fields, gpuCount);
        const formDetail = [
          "改参：在输入框改值后提交；不改：直接提交（按现值）。提交后仍需审批卡 Allow once 才生效——表单卡只收改参、不承载授权。",
          ...(amendNote !== undefined ? [amendNote] : []),
          ...(guardNotes.length > 0 ? [`卡数护栏：${guardNotes.join("；")}`] : []),
        ].join("\n");
        let answers: { answers: ReadonlyArray<{ id: string; selected: ReadonlyArray<string> }> };
        try {
          answers = await userQuestions.ask({
            questions: [formAskQuestion({
              id: `config-confirm-${args.run_id}`,
              question: `九要素训练配置确认 — ${args.run_id}`,
              header: "训练配置",
              detail: formDetail,
              fields: formFields,
              submitLabel: "确认并继续",
            })],
            agent: exec.agent,
            signal: exec.signal,
          });
        } catch (cause) {
          // A1 伴生缺陷收口：卡通道失败不再零日志——诊断落 run 目录（路径随 note 可定位）
          const diagRel = appendAskFailureDiagnostic(runDir, "atf_config_confirm", `config-confirm-${args.run_id}`, cause);
          if ((cause as { code?: string }).code === "ASK_CANCELLED") {
            return approvalDeniedResult("atf_config_confirm", "cancelled");
          }
          return asToolValue({ ok: false, run_id: args.run_id, error: "form_ask_failed", note: `表单卡应答失败：${String(cause).slice(0, 200)}（通道诊断已落 run 目录 ${diagRel}）` });
        }
        // 结构化 edits（selected key=value——协议零改动的结构化回传面）
        const submitted = editsFromFormAnswers(answers);
        // 与进卡前 fields diff：预填未动的键不算改动（按现值）；必填拦空兜底
        const beforeByKey = new Map(fields.map((f) => [f.key, f.value]));
        const changedEdits: Record<string, string> = {};
        for (const [key, value] of Object.entries(submitted)) {
          if (value === "") continue;
          if (beforeByKey.get(key) !== value) changedEdits[key] = value;
        }
        const clampedKeys = clampEdits(changedEdits);
        // bs/nproc 改动 → accum 随卡数重派生（L2 整除校验——与自动档同语义，防 global batch 破）
        let loopNote = "";
        if (changedEdits["per_device_train_batch_size"] !== undefined || changedEdits["nproc_per_node"] !== undefined) {
          const nprocRaw = changedEdits["nproc_per_node"] ?? fields.find((f) => f.key === "nproc_per_node")?.value;
          const bsRaw = changedEdits["per_device_train_batch_size"] ?? fields.find((f) => f.key === "per_device_train_batch_size")?.value ?? "2";
          const nprocNow = Number(nprocRaw);
          const bsNow = Number(bsRaw);
          if (Number.isFinite(nprocNow) && nprocNow > 0 && Number.isFinite(bsNow) && bsNow > 0) {
            const reDerived = deriveGradAccum(Math.round(bsNow), Math.round(nprocNow));
            if ("error" in reDerived) {
              return asToolValue({ ok: false, run_id: args.run_id, error: "global_batch_derive_failed", note: `改参后 global batch 派生失败（bs=${bsNow}×nproc=${nprocNow}）：${reDerived.error}——请回表单卡调整组合` });
            }
            const accumField = fields.find((f) => f.key === "gradient_accumulation_steps");
            if (accumField !== undefined && changedEdits["gradient_accumulation_steps"] === undefined) {
              changedEdits["gradient_accumulation_steps"] = String(reDerived.accum);
              loopNote = `；accum 随派生更新=${reDerived.accum}（gb=${reDerived.globalBatch} 不变）`;
            }
          }
        }
        for (const [key, value] of Object.entries(changedEdits)) {
          const field = fields.find((f) => f.key === key);
          if (field !== undefined) {
            field.value = value;
            field.tag = "need_confirm";
          }
        }
        if (clampedKeys.length > 0 || loopNote !== "") {
          amendNote = `本轮改参：${Object.keys(changedEdits).join(", ") || "（按现值确认）"}${clampedKeys.length > 0 ? `；越界拦截回退（域边界）：${clampedKeys.join("、")}` : ""}${loopNote}`;
        }
        // 第二段＝审批卡（授权唯一落点——Reject 回表单卡循环）
        const verdict = await requestApproval(ctx, exec, "atf_config_confirm", `${title}\n${renderFields(fields)}\n${note}${amendNote !== undefined ? `\n${amendNote}` : ""}`);
        if (verdict.ok) break;
        if (verdict.outcome === "rejected") {
          // Reject → 回表单卡（带上次值——fields 已就地更新）
          continue;
        }
        return approvalDeniedResult("atf_config_confirm", verdict.outcome);
      }
      // 确认：全字段按现值落快照（手搓 saveConfigSnapshot 复用）
      const confirmed: Record<string, string> = {};
      for (const field of fields) confirmed[field.key] = field.value;
      saveConfigSnapshot(runDir, confirmed);
      // 批㊶Q增补二3：确认完成即清 pending 卡（备份改名 .answered——残留则 UI 持续渲染待确认态）
      clearPending(runDir);
      // 批㊶-P P-1a：确认快照回写 iteration-config training 段＋param_sources 标注
      // （harness 侧生成物后处理——内核 generate_iteration_config 无确认卡通路[实锚]；
      //  prelaunch 报告"无确认记录"由此消除，链路级修正）。写失败静默（fail-open）。
      const iterConfigLive = join(runDir, "prep", "iteration-config.json");
      const iterConfigLegacy = join(runDir, "prep", "iteration-config", "iteration-config.json");
      for (const candidate of [iterConfigLive, iterConfigLegacy]) {
        const patched = applyConfirmedToIterationConfig(candidate, confirmed);
        void patched;
      }
      // 批㊶-M M-3 段事实轨：实验配置确认成功即登记（experiment_config 段）
      appendSegmentFact(runDir, "experiment_config", "atf_config_confirm");
      // 批㊶-N N-5：会话绑定
      const sessionIdCfg = sessionIdOfExec(exec);
      if (sessionIdCfg !== undefined) appendBinding(runDir, sessionIdCfg);
      injectBashRunWorkspace(runDir); // 批㊶-S1 门2修复
      return asToolValue({ ok: true, run_id: args.run_id, confirmed: true, fields, snapshot: "webui/config-snapshot.json", ...(amendNote !== undefined ? { amend: amendNote } : {}) });
    },
  });

  const publishTool = defineTool({
    name: "atf_publish_confirm",
    description:
      "发布确认 digest 卡（审批必经）：对候选契约件（contract-candidate）做发布前确认——卡面呈现 artifact digest（sha256 凭据）与发布目标；Allow once＝确认发布凭据。digest 缺失时如实拒绝（不造数）。",
    parameters: {
      run_id: { type: "string", required: true, description: "run 标识" },
      digest: { type: "string", description: "契约件 sha256 digest（缺省读 runs/<run_id>/contract-candidate.json 的 digest 字段）" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: { run_id: string; digest?: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      // 批㊶Q增补三 段3：run 目录双形态解析（同 configTool）
      const runDir = resolveRunDir(deps.runsRoot, args.run_id, { workspace: sessionWorkspaceSlug(exec) });
      const candidatePath = join(runDir, "contract-candidate.json");
      let candidateDigest = args.digest;
      if (candidateDigest === undefined && existsSync(candidatePath)) {
        try {
          const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as Record<string, unknown>;
          candidateDigest = typeof candidate["digest"] === "string" ? (candidate["digest"] as string) : undefined;
        } catch {
          candidateDigest = undefined;
        }
      }
      if (candidateDigest === undefined) {
        return asToolValue({ ok: false, run_id: args.run_id, note: "无契约件 digest（contract-candidate.json 缺失或无 digest 字段）——无可发布凭据，不造数" });
      }
      const title = `发布确认（digest 凭据）— run ${args.run_id}`;
      // 批㊶-U §五：凭据卡退化形式——无可调参数不虚构；卡面 note＝统一说明＋复核通道（聊天重呈）
      const body = `  artifact: contract-candidate.json\n  digest: ${candidateDigest}\n  ${dualStageNote("契约凭据卡", { amendable: false })}`;
      writePending(runDir, { kind: "publish_confirm", run_id: args.run_id, title, digest: candidateDigest, at: new Date().toISOString() });
      const verdict = await requestApproval(ctx, exec, "atf_publish_confirm", `${title}\n${body}\n确认发布请点 Allow once。`);
      if (!verdict.ok) return approvalDeniedResult("atf_publish_confirm", verdict.outcome);
      // 批㊶Q增补二3：放行完成即清 pending 卡（同确认卡语义）
      clearPending(runDir);
      // 批㊶-M M-3 段事实轨：契约发布确认成功即登记（publish 段）
      appendSegmentFact(runDir, "publish", "atf_publish_confirm");
      // 批㊶-N N-5：会话绑定
      const sessionIdPub = sessionIdOfExec(exec);
      if (sessionIdPub !== undefined) appendBinding(runDir, sessionIdPub);
      injectBashRunWorkspace(runDir); // 批㊶-S1 门2修复
      return asToolValue({ ok: true, run_id: args.run_id, confirmed: true, digest: candidateDigest, artifact: "contract-candidate.json" });
    },
  });

  return [configTool, publishTool];
};
