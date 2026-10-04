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

/** 卡面字段（buildConfigConfirmFields 返回形态——本地结构类型）。 */
type ConfigConfirmField = { key: string; value: string; tag: "need_confirm" | "from_registry" | "default_used" };
import { approvalDeniedResult, requestApproval } from "./approvalFace.js";
import { asToolValue } from "./schemaTranslate.js";

/** 三态标记（卡面文本化：⚠ 已用缺省／◆ 来自登记／? 需确认——与手搓批⑮三态标签同源语义）。 */
const TAG_MARK: Record<ConfigConfirmField["tag"], string> = {
  default_used: "已用缺省 ⚠",
  from_registry: "来自登记 ◆",
  need_confirm: "需确认 ?",
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
      "九要素训练配置确认卡（审批必经）：action=present 构造/重呈九要素卡（overrides 传显式覆盖值）；action=amend 解析用户纯文字应答（如「lr 改 2e-4 其他 ok」）并重呈。现值基线＝已确认快照＞run 的 IterationConfig 实值（prep/iteration-config——批㉛段2 登记源，卡面与 Web 摘要同源）＞缺省。确认（审批面板 Allow once）后 config-snapshot 落盘 runs/<run_id>/webui/。卡面与审批面板均按 ATF 九要素格式渲染（三态标记：⚠已用缺省/◆来自登记/?需确认）。",
    parameters: {
      action: { type: "string", required: true, enum: ["present", "amend"], description: "present=构造/重呈卡；amend=解析纯文字应答后重呈" },
      run_id: { type: "string", required: true, description: "run 标识（快照与 pending 卡落点）" },
      overrides: { type: "object", additionalProperties: true, description: "显式覆盖值（present 形态：{learning_rate:\"2e-4\",...}）" },
      amend_text: { type: "string", description: "amend 形态：用户纯文字应答原文（如「lr 改 2e-4 其他 ok」）" },
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
    async execute(args: { action: "present" | "amend"; run_id: string; overrides?: Record<string, unknown>; amend_text?: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
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
      const baseline = { ...iterTraining, ...snapshot };
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
      const fields = (() => {
        if (amended === undefined) return buildConfigConfirmFields(overrides, { fromRegistry: Object.keys(baseline).length > 0 ? baseline : undefined });
        // 改参重呈：现值基线保持原三态，仅应答改动项升 need_confirm（值替换）
        const base = buildConfigConfirmFields({}, { fromRegistry: Object.keys(baseline).length > 0 ? baseline : undefined });
        return base.map((field) => (amended[field.key] !== undefined ? { key: field.key, value: String(amended[field.key]), tag: "need_confirm" as const } : field));
      })();
      const title = args.action === "amend" ? `九要素配置确认（改参重呈）— run ${args.run_id}` : `九要素训练配置确认 — run ${args.run_id}`;
      const note = amendNote ?? "确认请点审批面板 Allow once；逐项修改可直接回复如「lr 改 2e-4」。";
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
      return asToolValue({ ok: true, run_id: args.run_id, confirmed: true, digest: candidateDigest, artifact: "contract-candidate.json" });
    },
  });

  return [configTool, publishTool];
};
