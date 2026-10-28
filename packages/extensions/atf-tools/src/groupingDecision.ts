/**
 * D-c：分组选择账本（GroupingChoice/v1）。
 *
 * 现场（dev 2026-10-28 webui 真机）：C2 分组卡弹出、用户选定「按业务域分五组」，
 * 但选定结果只是 `resolveGroupingFace` 的**进程内返回值**——该段随后失败（当时是
 * field_config 错误归因导致 experiment_setup 连续四次失败），零写入，选择随之蒸发。
 * agent 原话：「那次零写入，选定记录没存下来」。重跑只能再问一遍，换会话更是必然重问。
 *
 * 落点：`<run>/runtime/webui/grouping-choice.json`。
 * 它属于**卡面输入态**，与 `config-snapshot.json`（训练方案卡确认值）、
 * `pending-confirm.json`（待确认卡态）同类；**不放** `analysis/decisions/`——
 * 那是内核 DecisionGate 的判定账（decisions.jsonl：每个询问点问还是自动决定 + 依据，
 * badcase 分析后的建议采纳决策也记在那里），语义是「做了什么判断」，不是「用户填了什么」。
 *
 * 重跑时按**字段集合指纹**判定是否仍然适用：
 *   - 指纹一致   → 直接沿用，不再出卡；审批卡上披露「沿用你上次的选择」
 *   - 字段增删   → 指纹变 → 上次选择作废、重新出卡（不拿旧选择套新字段）
 *
 * 与「字段配置自带 group」的关系：那一态（field_provided）在调用侧优先于本账本——
 * 字段配置里写了 group 就是用户/agent 已把选择固化进配置，此时无需再走账本。
 *
 * @module groupingDecision
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRunSubdir } from "../../../../src/core/workspace/runLayout.js";

/** 账本 schema 标识（与 schema_version 同值；版本不符即视为不可用）。 */
export const GROUPING_DECISION_SCHEMA = "GroupingChoice/v1";

/** 文件名（同目录还有 config-snapshot.json／pending-confirm.json——不共名、不覆盖）。 */
export const GROUPING_DECISION_FILE = "grouping-choice.json";

/** 一条选定记录。`groups` 原样保存候选里的分组结构（含字段清单），供重跑直接下传。 */
export interface GroupingDecisionRecord {
  readonly schema_version: string;
  readonly run_id: string;
  /** 用户选定的候选名（原样，回执与卡面共用）。 */
  readonly candidate_name: string;
  /** 候选携带的分组（结构由内核 schema 定义，本模块只搬运不解释）。 */
  readonly groups: ReadonlyArray<Record<string, unknown>>;
  /** 透传内核的候选原文（本工具已把 recommended 旗标挪到用户选的那个）——
   *  重跑时必须原样下传，否则内核只认 recommended、认不出「用户上次选的是哪套」。 */
  readonly payload: Record<string, unknown>;
  /** 字段集合指纹（排序后的字段标识拼接；null＝当时无法定位字段配置）。 */
  readonly fields_digest: string | null;
  /** 当时字段数（指纹失效时给用户看得懂的量级对照）。 */
  readonly field_count: number;
  /** 选定时间（ISO）。 */
  readonly decided_at: string;
  /** 来源闭集：目前只有「用户在卡上选定」会落账（策略自动选定不落——它每次都一样）。 */
  readonly source: "user_selected";
}

/** 落点：`<run>/runtime/webui/grouping-choice.json`（v3；v2 存量树 webui/ 同名同址）。
 *  与 config-snapshot.json／pending-confirm.json 同一解析口径（resolveRunSubdir "webui"）。 */
export const groupingDecisionPathOf = (runDir: string): string =>
  join(resolveRunSubdir(runDir, "webui"), GROUPING_DECISION_FILE);

/**
 * 字段集合指纹——**只取字段标识的排序集合**，刻意不含 group/definition 等易变内容。
 *
 * 为什么不直接对整个文件算 sha256：agent 会重写字段配置（格式化、字段顺序、补 definition），
 * 那不代表「分组决策失效」。反过来字段增删**必须**让旧选择失效——旧方案的字段清单对不上新配置。
 *
 * @param fieldConfigPath 字段配置绝对路径（空串＝未定位）。
 * @returns 指纹；文件缺席/坏行/无 fields 数组 → null（无法判定，调用方按「允许继承」处理）。
 */
export const fieldsDigestOf = (fieldConfigPath: string): string | null => {
  if (fieldConfigPath.trim() === "") return null;
  try {
    const parsed = JSON.parse(readFileSync(fieldConfigPath, "utf8")) as { fields?: unknown };
    const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
    const ids = fields
      .map((raw) => {
        const row = (raw ?? {}) as Record<string, unknown>;
        return String(row["field_id"] ?? row["key"] ?? row["name"] ?? "");
      })
      .filter((id) => id !== "")
      .sort();
    return ids.length === 0 ? null : ids.join("\u0000");
  } catch {
    return null;
  }
};

/** 账本读取结论：`absent` 没选过；`stale` 选过但字段集合变了；`malformed` 账本坏了。 */
export type GroupingDecisionRead =
  | { readonly ok: true; readonly record: GroupingDecisionRecord }
  | { readonly ok: false; readonly reason: "absent" | "stale" | "malformed"; readonly note: string };

/**
 * 读取并判定账本是否仍然适用。
 *
 * @param runDir run 根（定位账本）。
 * @param fieldsDigest 当前字段集合指纹（null＝当前无法定位字段配置）。
 * @returns 适用时给记录；否则给原因（`stale` 的 note 可直接上卡面）。
 */
export const readGroupingDecision = (runDir: string, fieldsDigest: string | null): GroupingDecisionRead => {
  const path = groupingDecisionPathOf(runDir);
  if (!existsSync(path)) return { ok: false, reason: "absent", note: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    return { ok: false, reason: "malformed", note: `分组选择账本读不出来（${path}）：${String(cause).slice(0, 120)}——本次重新问` };
  }
  const record = parsed as Partial<GroupingDecisionRecord> | null;
  if (
    record === null
    || typeof record !== "object"
    || record.schema_version !== GROUPING_DECISION_SCHEMA
    || typeof record.candidate_name !== "string"
    || !Array.isArray(record.groups)
    || record.payload === null
    || typeof record.payload !== "object"
  ) {
    return { ok: false, reason: "malformed", note: `分组选择账本格式不认识（${path}）——本次重新问` };
  }
  const priorDigest = typeof record.fields_digest === "string" ? record.fields_digest : null;
  // 两边都拿得到指纹才比对；任一侧为 null（当时/现在定位不到字段配置）→ 不据此作废。
  if (fieldsDigest !== null && priorDigest !== null && fieldsDigest !== priorDigest) {
    return {
      ok: false,
      reason: "stale",
      note: `字段集合与上次选定分组时不一致（上次 ${String(record.field_count ?? "?")} 个字段，现在 ${String(fieldsDigest.split("\u0000").length)} 个）——上次选的「${record.candidate_name}」已作废，本次重新问`,
    };
  }
  return { ok: true, record: record as GroupingDecisionRecord };
};

/**
 * 落账（用户选定后立刻写，**先于**拼 argv 与段执行——段失败也不丢）。
 *
 * @param runDir run 根。
 * @param record 除 schema_version 外的记录字段。
 * @returns 实际写入路径（回执披露用）。
 */
export const writeGroupingDecision = (
  runDir: string,
  record: Omit<GroupingDecisionRecord, "schema_version">,
): string => {
  const dir = resolveRunSubdir(runDir, "webui");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, GROUPING_DECISION_FILE);
  const payload: GroupingDecisionRecord = { schema_version: GROUPING_DECISION_SCHEMA, ...record };
  writeFileSync(path, `${JSON.stringify(payload, null, 1)}\n`, "utf8");
  return path;
};
