/**
 * 分组节卡面（读内核 experiment-config 的新 keys）。
 *
 * 内核 65a0106c 起删除 `GROUPING_PRESETS`（A/B 写死组名），`--grouping-preset` 降为可选、无闭集的
 * 方案 id 透传；分组真实来源与落账形态改为 `experiment-config.json` 的 `grouping` 对象：
 *   `{source: "field_group"|"field_projection"|"none", source_note, preset|null, preset_name,
 *     groups: {<key>: [field_id]}, group_plan: [{key, field_ids}], confirmed, decision,
 *     limit_source, notes}`
 *
 * 两条硬约束（owner 明示）：
 *  ① `groups` 是 dict（构造器按 `.values()` 消费，改不了）——**列表形态必须读 `group_plan`**，
 *     本模块绝不遍历 groups 当列表用；
 *  ② `preset_name` 已退化为「来源说明」，**不得**当 A/B 方案名呈现；用户面也不得出现
 *     A／B／preset／grouping_preset 这些字样。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRunFile } from "./runSubdirs.js";

/** 分组来源闭集（内核 grouping.source）。 */
export const GROUPING_SOURCES = ["field_group", "field_projection", "none"] as const;
export type GroupingSource = (typeof GROUPING_SOURCES)[number];

/** 来源 → 用户面业务话（禁出现内部词）。 */
export const GROUPING_SOURCE_LABEL: Readonly<Record<GroupingSource, string>> = {
  field_group: "按你字段配置里的分组",
  field_projection: "按抽取约定里的分组",
  none: "不分组，全部平铺",
};

export interface GroupingGroup {
  key: string;
  fieldIds: string[];
}

export interface ExperimentGrouping {
  source: GroupingSource;
  sourceNote: string;
  confirmed: boolean;
  /** 列表形态（来自 group_plan；groups 是 dict 不能当列表用）。 */
  groups: GroupingGroup[];
}

/** 读取 experiment-config.json 的 grouping（缺席/坏件＝null，呈现面不阻塞）。 */
export const readExperimentGrouping = (runDir: string): ExperimentGrouping | null => {
  const path = resolveRunFile(runDir, "experiment-setup/experiment-config.json");
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const root = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const grouping = root === null ? null : root["grouping"];
  if (grouping === null || typeof grouping !== "object" || Array.isArray(grouping)) return null;
  const raw = grouping as Record<string, unknown>;
  const sourceRaw = typeof raw["source"] === "string" ? raw["source"] : "";
  const source: GroupingSource = (GROUPING_SOURCES as readonly string[]).includes(sourceRaw) ? (sourceRaw as GroupingSource) : "none";
  const groups: GroupingGroup[] = [];
  // 列表形态单源＝group_plan（groups 是 dict，不遍历）
  const plan = raw["group_plan"];
  if (Array.isArray(plan)) {
    for (const entry of plan) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const row = entry as Record<string, unknown>;
      const key = typeof row["key"] === "string" ? row["key"] : "";
      if (key === "") continue;
      const ids = Array.isArray(row["field_ids"])
        ? (row["field_ids"] as unknown[]).filter((item): item is string => typeof item === "string")
        : [];
      groups.push({ key, fieldIds: ids });
    }
  }
  return {
    source,
    sourceNote: typeof raw["source_note"] === "string" ? raw["source_note"] : "",
    confirmed: raw["confirmed"] === true,
    groups,
  };
};

/** 字段 id → 业务名（读 field-config.json 的 zh；缺席回退 id，不造占位）。 */
export const fieldNameMapOf = (runDir: string): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  const path = resolveRunFile(runDir, "experiment-setup/field-config.json");
  if (!existsSync(path)) return map;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { fields?: unknown };
    if (!Array.isArray(parsed.fields)) return map;
    for (const entry of parsed.fields) {
      if (entry === null || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const id = typeof row["field_id"] === "string" ? row["field_id"] : "";
      const zh = typeof row["zh"] === "string" ? row["zh"] : "";
      if (id !== "" && zh !== "") map.set(id, zh);
    }
  } catch {
    // 坏件＝无业务名映射（回退 id）
  }
  return map;
};

/**
 * 分组节文本（卡面/回执共用的单源）。
 * 组清单每行「组名：N 个字段」＋缩进展开字段业务名（不只给 id）；
 * 确认态：false＝「这些分组是我按字段推的，你可以改」；true＝「已确认」。
 * @param grouping 已解析的分组（null＝本轮还没有分组产物）
 * @param fieldNames 字段 id → 业务名
 * @returns 多行文本；无分组产物时返回一句业务话。
 */
export const renderGroupingSection = (grouping: ExperimentGrouping | null, fieldNames: ReadonlyMap<string, string>): string => {
  if (grouping === null) return "分组：还没有分组结果（实验配置段跑完后再看这一节）。";
  const lines: string[] = [];
  const label = GROUPING_SOURCE_LABEL[grouping.source];
  const note = grouping.sourceNote.trim();
  lines.push(`分组来源：${label}${note === "" || note === label ? "" : `——${note}`}`);
  lines.push(grouping.confirmed ? "分组确认：已确认" : "分组确认：这些分组是我按字段推的，你可以改");
  if (grouping.source === "none" || grouping.groups.length === 0) {
    lines.push("组清单：不分组（全部平铺成一行一样本）");
    return lines.join("\n");
  }
  lines.push(`组清单（${String(grouping.groups.length)} 组）：`);
  for (const group of grouping.groups) {
    lines.push(`  · ${group.key}：${String(group.fieldIds.length)} 个字段`);
    const names = group.fieldIds.map((id) => {
      const name = fieldNames.get(id);
      return name === undefined ? id : `${name}（${id}）`;
    });
    if (names.length > 0) lines.push(`      ${names.join("、")}`);
  }
  return lines.join("\n");
};
