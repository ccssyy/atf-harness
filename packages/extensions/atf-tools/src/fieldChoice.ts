/**
 * 字段清单确认账本（FieldChoice/v1）——**字段清单必须经用户确认，不能由 agent 单方面固化**。
 *
 * 现场（dev 2026-10-28，owner 追问）：用户从没给过字段列表，agent 自己从标注
 * `marks[].pselect` 数出 17 个字段、自己起中文名与定义、直接写进 field-config 往下跑。
 * 数据驱动的方向是对的（字段名确实来自标注），但**中文名与定义是它写的、用户从未确认**——
 * 而这两个东西直接决定 prompt 与训练效果。
 *
 * 本模块负责「用户确认过哪些字段」这一件事：
 *   - 卡面呈现内核算出来的字段清单（`<run> 下 data/field-labels.json`，含框数/覆盖页数）；
 *   - 用户勾选要训练的字段（**不勾＝全部训练**，不强迫逐项点）；
 *   - 结果落 `<run>/runtime/webui/field-choice.json`，重跑沿用（与分组选择账本同一模式）。
 *
 * 为什么放 `runtime/webui/`：它是**卡面输入态**，与 `config-snapshot.json`（方案卡确认值）、
 * `pending-confirm.json`（待确认卡态）、`grouping-choice.json`（分组选择）同类。
 * `analysis/decisions/` 是内核 DecisionGate 的判定账（「做了什么判断」），不是「用户填了什么」。
 *
 * 它同时是 D-f 的判据：`user_provided`（字段配置自带 group → 不出分组卡）只有在
 * **有本账本记录**时才成立——否则那只是 agent 自己写进配置的占位值。
 *
 * @module fieldChoice
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRunSubdir } from "../../../../src/core/workspace/runLayout.js";

/** 账本 schema 标识。 */
export const FIELD_CHOICE_SCHEMA = "FieldChoice/v1";

/** 账本文件名（与 config-snapshot / pending-confirm / grouping-choice 同目录）。 */
export const FIELD_CHOICE_FILE = "field-choice.json";

/** 内核产出的字段清单文件名（`<run> 下 data/field-labels.json`）。 */
export const FIELD_LABELS_FILE = "field-labels.json";

/** 内核字段清单的一个字段。 */
export interface FieldLabel {
  readonly label: string;
  readonly box_count: number;
  readonly page_count: number;
  readonly absent_pages: number;
}

/** 内核字段清单（FieldLabels/v1 的读侧子集）。 */
export interface FieldLabels {
  readonly page_count: number;
  readonly label_count: number;
  readonly box_count: number;
  readonly labels: FieldLabel[];
}

/** 一条确认记录。 */
export interface FieldChoiceRecord {
  readonly schema_version: string;
  readonly run_id: string;
  /** 用户勾选要训练的字段（空数组＝全部训练，见 `allFields`）。 */
  readonly confirmed_fields: string[];
  /** 是否等价于「全部字段都训练」（勾了 0 项或勾满）。 */
  readonly all_fields: boolean;
  readonly total_fields: number;
  readonly decided_at: string;
  /** 来源闭集：目前只有「用户在卡上确认」。 */
  readonly source: "user_confirmed";
}

/** 账本落点：`<run>/runtime/webui/field-choice.json`（v3；v2 存量树 webui/ 同名同址）。 */
export const fieldChoicePathOf = (runDir: string): string =>
  join(resolveRunSubdir(runDir, "webui"), FIELD_CHOICE_FILE);

/** 内核字段清单落点：`<run> 下 data/field-labels.json`（v3；v2 存量树 prep/）。 */
export const fieldLabelsPathOf = (runDir: string): string =>
  join(resolveRunSubdir(runDir, "prep"), FIELD_LABELS_FILE);

/**
 * 读内核算出来的字段清单。
 *
 * @param runDir run 根。
 * @returns 清单；缺席/坏行/schema 不符 → null（调用方按「无清单」处理，不造伪数据）。
 */
export const readFieldLabels = (runDir: string): FieldLabels | null => {
  const path = fieldLabelsPathOf(runDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      schema_version?: unknown;
      page_count?: unknown;
      label_count?: unknown;
      box_count?: unknown;
      labels?: unknown;
    };
    if (parsed.schema_version !== "FieldLabels/v1" || !Array.isArray(parsed.labels)) return null;
    const labels = parsed.labels
      .map((raw) => {
        const row = (raw ?? {}) as Record<string, unknown>;
        const label = typeof row["label"] === "string" ? row["label"] : "";
        if (label === "") return null;
        return {
          label,
          box_count: Number(row["box_count"] ?? 0),
          page_count: Number(row["page_count"] ?? 0),
          absent_pages: Number(row["absent_pages"] ?? 0),
        } satisfies FieldLabel;
      })
      .filter((item): item is FieldLabel => item !== null);
    if (labels.length === 0) return null;
    return {
      page_count: Number(parsed.page_count ?? 0),
      label_count: Number(parsed.label_count ?? labels.length),
      box_count: Number(parsed.box_count ?? 0),
      labels,
    };
  } catch {
    return null;
  }
};

/** 读确认记录（缺席/坏行 → null）。 */
export const readFieldChoice = (runDir: string): FieldChoiceRecord | null => {
  const path = fieldChoicePathOf(runDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FieldChoiceRecord> | null;
    if (parsed === null || typeof parsed !== "object") return null;
    if (parsed.schema_version !== FIELD_CHOICE_SCHEMA || !Array.isArray(parsed.confirmed_fields)) return null;
    return parsed as FieldChoiceRecord;
  } catch {
    return null;
  }
};

/**
 * 落账（用户确认后立刻写）。
 *
 * @param runDir run 根。
 * @param record 除 schema_version 外的字段。
 * @returns 实际写入路径。
 */
export const writeFieldChoice = (
  runDir: string,
  record: Omit<FieldChoiceRecord, "schema_version">,
): string => {
  const dir = resolveRunSubdir(runDir, "webui");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FIELD_CHOICE_FILE);
  writeFileSync(path, `${JSON.stringify({ schema_version: FIELD_CHOICE_SCHEMA, ...record }, null, 1)}\n`, "utf8");
  return path;
};

/**
 * 卡面正文：把内核算的清单说成人话（**零内部术语**）。
 *
 * 每个字段给三件用户真正关心的信息：出现多少页（必填还是偶发）、框数、缺多少页。
 *
 * @param labels 内核字段清单。
 * @param alreadyConfirmed 已有的确认记录（重跑时用于回显）。
 * @returns 卡面 detail 文本。
 */
export const fieldChoiceDetailOf = (labels: FieldLabels, alreadyConfirmed?: FieldChoiceRecord | null): string => {
  const lines: string[] = [];
  lines.push(
    `标注里一共 ${String(labels.label_count)} 个字段（${String(labels.box_count)} 个框，覆盖 ${String(labels.page_count)} 页）。`,
  );
  lines.push("");
  lines.push("这些是**从你的标注里数出来的**，不是系统编的：");
  for (const item of labels.labels) {
    const rarity =
      item.absent_pages === 0
        ? `每页都有（${String(item.page_count)}/${String(labels.page_count)} 页）`
        : `只在 ${String(item.page_count)}/${String(labels.page_count)} 页出现`;
    lines.push(`· ${item.label} —— ${rarity}，${String(item.box_count)} 个框`);
  }
  lines.push("");
  lines.push(
    "**这些字段要全部训练吗？** 默认就是全部训练（下面输入框已填好）；只想训其中几个，"
      + "把输入框改成字段名即可，例如 awb, shipper。",
  );
  lines.push("中文名与字段定义由训练侧按标注标签生成——如果你要改某个字段的叫法，直接在这里说。");
  if (alreadyConfirmed !== undefined && alreadyConfirmed !== null) {
    lines.push(
      `（上次你确认过：${alreadyConfirmed.all_fields ? "全部字段" : alreadyConfirmed.confirmed_fields.join("、")}）`,
    );
  }
  return lines.join("\n");
};
