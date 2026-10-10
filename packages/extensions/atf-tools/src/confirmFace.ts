/**
 * 批⑱-M2——确认卡工具面（ui-atf-confirm 的数据与语义源）。
 *
 * atf_config_confirm：九要素训练配置确认卡——构造/改参/重呈/快照全链复用手搓
 * src/webui/configConfirm.ts（buildConfigConfirmFields/parseConfigEditText/
 * saveConfigSnapshot——逻辑零重写）；卡面＝presentCall content 逐行（key: 值 —— 三态标记），
 * 审批面板主体＝displayReason 多行同格式；Allow once＝确认并继续（snapshot 落盘）。
 * atf_publish_confirm：发布确认 digest 卡（契约件 digest 凭据同构）。
 *
 * 纯文字应答链（指令验收 1）：用户回复「lr 改 2e-4」→ GLM 调本工具 action=amend →
 * parseConfigEditText 解析 → 新 fields 重呈。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { buildConfigConfirmFields, parseConfigEditText, saveConfigSnapshot } from "../../../../src/webui/configConfirm.js";

/** 卡面字段（buildConfigConfirmFields 返回形态——本地结构类型；批㊶-Q 增第四态 agent_recommend，
 *  仅全自动档采纳 agent 参数推荐时由本文件后处理标注，buildConfigConfirmFields 不产出该态）。 */
type ConfigConfirmField = { key: string; value: string; tag: "need_confirm" | "from_registry" | "default_used" | "agent_recommend" };
import { approvalDeniedResult, requestApproval } from "./approvalFace.js";
import { appendSegmentFact } from "../../../../src/core/workspace/segmentFacts.js";
import { appendNotification } from "../../../../src/core/workspace/trainProbe.js";
import { evalAgentRecommend, type RecommendVerdict } from "../../../../src/core/workspace/agentRecommend.js";
import { isAutoTrainingTier, AUTO_TRAINING_PRESET } from "./autoTrainingTier.js";
import {
  FIXED_SMART_DEFAULTS,
  deriveGradAccum,
  clampLearningRate,
  clampEpochs,
  clampLoraRank,
  loraAlphaFor,
  clampCutoffLen,
  clampImageMaxPixels,
  SMART_DEEPSPEED_DEFAULT,
  applyConfirmedToIterationConfig,
} from "../../../../src/core/workspace/smartDefaults.js";
import { appendBinding } from "../../../../src/core/workspace/runFacts.js";

/** 批㊶-N N-5：会话身份提取（exec.agent.session.id；取不到＝undefined 如实跳过）。 */
const sessionIdOfExec = (exec: unknown): string | undefined => {
  const id = (exec as { agent?: { session?: { id?: unknown } } }).agent?.session?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
};
import { asToolValue } from "./schemaTranslate.js";

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
}

/** pending 卡落盘（刷新重建源：runs/<run>/webui/pending-confirm.json）。 */
const writePending = (runsRoot: string, runId: string, payload: Record<string, unknown>): void => {
  const dir = join(runsRoot, runId, "webui");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pending-confirm.json"), `${JSON.stringify(payload, null, 1)}\n`, "utf8");
};

export const buildConfirmTools = (deps: ConfirmDeps): unknown[] => {
  const { runsRoot, ctx } = deps;

  const configTool = defineTool({
    name: "atf_config_confirm",
    description:
      "九要素训练配置确认卡：action=present 构造/重呈九要素卡（overrides 传显式覆盖值）；action=amend 解析用户纯文字应答（如「lr 改 2e-4 其他 ok」）并重呈。现值基线＝已确认快照＞run 的 IterationConfig 实值（prep/iteration-config——批㉛段2 登记源，卡面与 Web 摘要同源）＞缺省。手动档（权限档）：审批面板 Allow once 确认后 config-snapshot 落盘。全自动训练档（会话档位=auto_training，经界面人工切换）：本工具免审批——以智能缺省（L3 clamp 建议＋L2 派生）＋agent 参数推荐直接落快照，卡面内容转为通报（告警行＋alerts.json，每键取值＋来源标注可回看）；改参仍走 amend 纯文字（同样免阻塞）。" +
      "全自动档 agent 参数推荐（recommend 参数，本档专属）：训练提交前基于任务描述＋数据集统计（样本数/长度分布/模态）＋经验锚点给出 epochs/lr/rank/cutoff 推荐值并附 reason（理由）。经验锚点（owner 手工训练经验，参考知识非硬规则）：样本 2万–3万 → 3 epochs；4万以上 → 2 epochs；小样本（<1万）宜多轮并防过拟合（配早停观察）。护栏：epochs∈[1,10] 整数、lr∈[5e-5,5e-4]、lora_rank∈{16,32,64,128}（alpha=2×rank 联动）、cutoff≤12800、像素∈{800000,1600000}、bs 正整数——越界推荐被拦截并回退固定建议（不静默修正），拦截事实进通报；推荐缺失同样回退。lora_alpha 不单独推荐（随 rank 联动）。",
    parameters: {
      action: { type: "string", required: true, enum: ["present", "amend"], description: "present=构造/重呈卡；amend=解析纯文字应答后重呈" },
      run_id: { type: "string", required: true, description: "run 标识（快照与 pending 卡落点）" },
      overrides: { type: "object", additionalProperties: true, description: "显式覆盖值（present 形态：{learning_rate:\"2e-4\",...}）" },
      amend_text: { type: "string", description: "amend 形态：用户纯文字应答原文（如「lr 改 2e-4 其他 ok」）" },
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
    async execute(args: { action: "present" | "amend"; run_id: string; overrides?: Record<string, unknown>; amend_text?: string; recommend?: Record<string, unknown> }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      const runDir = join(runsRoot, args.run_id);
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
      // L2 派生（bs×nproc 除尽 256 校验——除不尽/矛盾即停点问题串）
      const bsNum = Number(baseline["per_device_train_batch_size"] ?? 2);
      const accumDerived = deriveGradAccum(Number.isFinite(bsNum) && bsNum > 0 ? bsNum : 2);
      if ("error" in accumDerived) {
        return asToolValue({ ok: false, run_id: args.run_id, error: "global_batch_derive_failed", note: accumDerived.error });
      }
      baseline["gradient_accumulation_steps"] = String(accumDerived.accum);
      // P-1c：deepspeed 智能缺省＝ds_z3_offload（显式 > 缺省——iteration-config 显式声明优先）
      if (baseline["deepspeed"] === undefined) baseline["deepspeed"] = SMART_DEEPSPEED_DEFAULT;
      const rawOverrides = (args.overrides ?? {}) as Record<string, unknown>;
      const overrides: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawOverrides)) overrides[key] = String(value);
      let amendNote: string | undefined;
      let amended: Record<string, string> | undefined;
      if (args.action === "amend") {
        const parsed = parseConfigEditText(args.amend_text ?? "");
        if (parsed === null) {
          return asToolValue({ ok: false, note: "无法从应答解析出配置改动——请用户换一种说法（如「lr 改 2e-4 其他 ok」）", run_id: args.run_id });
        }
        amended = parsed.edits;
        amendNote = `已按应答改参：${Object.keys(parsed.edits).join(", ")}；其余按现值确认`;
      }
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
          const verdict = evalAgentRecommend(key, value, baselineValue, reason);
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
      const title = args.action === "amend" ? `九要素配置确认（改参重呈）— run ${args.run_id}` : `九要素训练配置确认 — run ${args.run_id}`;
      const note = amendNote ?? "确认请点审批面板 Allow once；逐项修改可直接回复如「lr 改 2e-4」。";
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
        const notification = `全自动训练档·配置自动确认（免审批，run ${args.run_id}）——${fields.map((f) => `${f.key}=${f.value}[${sources[f.key]}]`).join(" ")}${recommendSummary}${rejectedNotes.length > 0 ? `；拦截：${rejectedNotes.join("；")}` : ""}`;
        // 不写 pending 卡（无卡可应答——卡面内容转为通报）；改参走 amend 纯文字（同样免阻塞）
        appendNotification(runDir, { level: "info", kind: "config_auto", reason: notification, since: new Date().toISOString() });
        saveConfigSnapshot(runDir, confirmed, { auto: true, tier: AUTO_TRAINING_PRESET, sources });
        const iterConfigLiveAuto = join(runDir, "prep", "iteration-config.json");
        const iterConfigLegacyAuto = join(runDir, "prep", "iteration-config", "iteration-config.json");
        for (const candidate of [iterConfigLiveAuto, iterConfigLegacyAuto]) {
          const patched = applyConfirmedToIterationConfig(candidate, confirmed, "default:harness-smart-defaults", sources);
          void patched;
        }
        appendSegmentFact(join(deps.runsRoot, args.run_id), "experiment_config", "atf_config_confirm");
        const sessionIdAuto = sessionIdOfExec(exec);
        if (sessionIdAuto !== undefined) appendBinding(join(deps.runsRoot, args.run_id), sessionIdAuto);
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
        return asToolValue({ ok: false, run_id: args.run_id, note: "recommend 为全自动训练档专属（当前会话为权限档）——手动档请用 overrides/pure 文字 amend；档位切换须经界面人工操作" });
      }
      // pending 卡落盘（ui-atf-confirm / 刷新重建的同源数据）
      writePending(runsRoot, args.run_id, { kind: "config_confirm", run_id: args.run_id, title, fields, note, at: new Date().toISOString() });
      // 审批面板主体＝九要素多行（ATF 格式三态标记）
      const verdict = await requestApproval(ctx, exec, "atf_config_confirm", `${title}\n${renderFields(fields)}\n${note}`);
      if (!verdict.ok) {
        return approvalDeniedResult("atf_config_confirm", verdict.outcome);
      }
      // 确认：全字段按现值落快照（手搓 saveConfigSnapshot 复用）
      const confirmed: Record<string, string> = {};
      for (const field of fields) confirmed[field.key] = field.value;
      saveConfigSnapshot(runDir, confirmed);
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
      appendSegmentFact(join(deps.runsRoot, args.run_id), "experiment_config", "atf_config_confirm");
      // 批㊶-N N-5：会话绑定
      const sessionIdCfg = sessionIdOfExec(exec);
      if (sessionIdCfg !== undefined) appendBinding(join(deps.runsRoot, args.run_id), sessionIdCfg);
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
      const candidatePath = join(runsRoot, args.run_id, "contract-candidate.json");
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
      const body = `  artifact: contract-candidate.json\n  digest: ${candidateDigest}`;
      writePending(runsRoot, args.run_id, { kind: "publish_confirm", run_id: args.run_id, title, digest: candidateDigest, at: new Date().toISOString() });
      const verdict = await requestApproval(ctx, exec, "atf_publish_confirm", `${title}\n${body}\n确认发布请点 Allow once。`);
      if (!verdict.ok) return approvalDeniedResult("atf_publish_confirm", verdict.outcome);
      // 批㊶-M M-3 段事实轨：契约发布确认成功即登记（publish 段）
      appendSegmentFact(join(deps.runsRoot, args.run_id), "publish", "atf_publish_confirm");
      // 批㊶-N N-5：会话绑定
      const sessionIdPub = sessionIdOfExec(exec);
      if (sessionIdPub !== undefined) appendBinding(join(deps.runsRoot, args.run_id), sessionIdPub);
      return asToolValue({ ok: true, run_id: args.run_id, confirmed: true, digest: candidateDigest, artifact: "contract-candidate.json" });
    },
  });

  return [configTool, publishTool];
};
