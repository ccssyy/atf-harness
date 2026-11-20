/**
 * E3 只读呈现：本次训练用哪些字段、prompt 的字段段到底长什么样。
 *
 * 背景（owner 2026-10-26）：全链此前唯一能看到 prompt 的地方是评估服务预检报告的**事后**
 * 回显——用户在训练前看不到「到底会用什么字段、什么 prompt」，只能等评估阶段回看。
 * 本模块补一张**只读**呈现（不是确认卡、不加交互）：字段清单（业务名＋字段 id）＋
 * prompt 里渲染后的字段段原文（逐行）＋字段说明的来源标注。
 *
 * 来源单源（不重算、不拼装——渲染权在内核）：
 * - 字段清单与（可选）分段声明：`<run>/experiment-setup/field-config.json`
 *   （内核实验门落盘的字段配置副本）；
 * - prompt 字段段原文：`<run>/experiment-setup/experiment_setup_report.md` 里
 *   「训练 prompt 实文样例」代码块（内核自述「与训练行逐字同式」）——本模块只截取、
 *   不重新渲染，避免出现第二套 prompt 渲染实现。
 *
 * 用户面纪律：不出现 FieldSpec／segments／classifier=heuristic 这类内部词；
 * 「保真回退」（工作流没解析成功、字段说明按原文原样使用）用一句业务话说明。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRunFile } from "./runSubdirs.js";

/** 字段来源两类（业务话，不暴露内部词汇）。 */
export type TrainingFieldSource = "declared" | "generated";

export const TRAINING_FIELD_SOURCE_LABEL: Readonly<Record<TrainingFieldSource, string>> = {
  declared: "按你配置里的字段分段声明",
  generated: "随字段定义生成",
};

export interface TrainingFieldRow {
  id: string;
  /** 业务名（字段配置里的中文名；缺失回退字段 id，不造占位）。 */
  name: string;
  source: TrainingFieldSource;
  /** 渲染行与「字段名＋定义」逐字相同＝说明按原文原样使用（保真回退的业务事实）。 */
  verbatim: boolean;
}

export interface TrainingPromptPreview {
  fields: TrainingFieldRow[];
  /** prompt 字段段原文（逐行；取内核报告的实文样例块，未渲染成功＝空数组）。 */
  promptLines: string[];
  /** 字段说明按原文原样使用的字段 id（保真回退——业务话说明用）。 */
  verbatimFields: string[];
  /** 不可得时的如实说明（不造占位）。 */
  unavailable?: string;
}

/** RunLayout/v3 实验设置目录（v2 存量 experiment-setup/ 只读兼容——路径经 runSubdirs 解析）。 */
const EXPERIMENT_DIR = "experiment-setup";
const FENCE_START = "```text";
const SAMPLE_HEAD = "训练 prompt 实文样例";

/** 读字段配置（缺失/坏件＝空，不抛——呈现面不阻塞训练前报告）。 */
const readFieldConfig = (runDir: string): { id: string; zh: string; definition: string; declared: boolean }[] => {
  const path = resolveRunFile(runDir, `${EXPERIMENT_DIR}/field-config.json`);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { fields?: unknown };
    if (!Array.isArray(parsed.fields)) return [];
    return parsed.fields.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      const id = typeof row["field_id"] === "string" ? row["field_id"] : "";
      if (id === "") return [];
      const segments = row["segments"];
      return [{
        id,
        zh: typeof row["zh"] === "string" ? row["zh"] : "",
        definition: typeof row["definition"] === "string" ? row["definition"] : "",
        declared: Array.isArray(segments) && segments.length > 0,
      }];
    });
  } catch {
    return [];
  }
};

/** 从内核报告截取 prompt 实文样例块（```text 围栏内），再取其中的字段段行。 */
const readPromptSampleBlock = (runDir: string): string[] => {
  const path = resolveRunFile(runDir, `${EXPERIMENT_DIR}/experiment_setup_report.md`);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const head = text.indexOf(SAMPLE_HEAD);
  if (head < 0) return [];
  const fence = text.indexOf(FENCE_START, head);
  if (fence < 0) return [];
  const bodyStart = text.indexOf("\n", fence);
  if (bodyStart < 0) return [];
  const bodyEnd = text.indexOf("```", bodyStart);
  if (bodyEnd < 0) return [];
  return text.slice(bodyStart + 1, bodyEnd).split("\n").map((line) => line.replace(/\s+$/, ""));
};

/** 字段段行（prompt 里 `- <字段 id>：…` 形态；其它行属任务说明/输出规范，不进字段段）。 */
const FIELD_LINE = /^\s*[-*]\s+([A-Za-z0-9_]+)\s*[：:]\s*(.*)$/;

/**
 * 组装只读呈现（纯读，不写盘、不改配置）。
 * @param runDir run 根目录。
 * @returns 字段行、prompt 字段段原文、保真回退字段集与不可得说明。
 */
export const buildTrainingPromptPreview = (runDir: string): TrainingPromptPreview => {
  const config = readFieldConfig(runDir);
  const sample = readPromptSampleBlock(runDir);
  const fieldLines: { id: string; line: string }[] = [];
  for (const line of sample) {
    const match = FIELD_LINE.exec(line);
    if (match === null) continue;
    fieldLines.push({ id: match[1] as string, line });
  }
  if (config.length === 0 && fieldLines.length === 0) {
    return {
      fields: [],
      promptLines: [],
      verbatimFields: [],
      unavailable: "实验配置段还没有产出字段清单与 prompt 实文（先完成实验配置段，再回来看这一屏）",
    };
  }
  const lineById = new Map(fieldLines.map((entry) => [entry.id, entry.line]));
  const fields: TrainingFieldRow[] = config.map((entry) => {
    const line = lineById.get(entry.id);
    const verbatim =
      line !== undefined
      && !entry.declared
      && entry.definition !== ""
      && line.replace(/\s+/g, " ").trim() === `- ${entry.id}：${entry.zh}${entry.zh === "" ? "" : "，"}${entry.definition}`.replace(/\s+/g, " ").trim();
    return {
      id: entry.id,
      name: entry.zh === "" ? entry.id : entry.zh,
      source: entry.declared ? "declared" : "generated",
      verbatim,
    };
  });
  // 字段配置缺席但报告里有字段行：按报告行兜底列 id（业务名缺失如实回退 id）
  const missing = fieldLines.filter((entry) => !config.some((row) => row.id === entry.id));
  for (const entry of missing) {
    fields.push({ id: entry.id, name: entry.id, source: "generated", verbatim: false });
  }
  return {
    fields,
    promptLines: fieldLines.map((entry) => entry.line),
    verbatimFields: fields.filter((field) => field.verbatim).map((field) => field.id),
  };
};

/**
 * 只读呈现块（训练前一屏摘要用；纯文本，逐行）。
 * @param preview buildTrainingPromptPreview 的产物。
 * @returns 多行文本（不可得时只回一句业务话）。
 */
export const renderTrainingPromptPreviewBlock = (preview: TrainingPromptPreview): string => {
  if (preview.unavailable !== undefined) return `本次训练字段与 prompt：${preview.unavailable}`;
  const lines: string[] = [];
  const declared = preview.fields.filter((field) => field.source === "declared").length;
  lines.push(`本次训练字段（${String(preview.fields.length)} 项；字段说明来源：${String(declared)} 项按你配置的字段分段声明、${String(preview.fields.length - declared)} 项随字段定义生成）`);
  for (const field of preview.fields) {
    lines.push(`  · ${field.name}（${field.id}）——${TRAINING_FIELD_SOURCE_LABEL[field.source]}`);
  }
  if (preview.promptLines.length > 0) {
    lines.push("prompt 里的字段段（逐行原文，训练行与它同式）：");
    for (const line of preview.promptLines) lines.push(`  ${line}`);
  } else {
    lines.push("prompt 里的字段段：实验配置报告未含实文样例（字段说明以字段配置为准）");
  }
  if (preview.verbatimFields.length > 0) {
    lines.push(`字段说明按原文原样使用（${String(preview.verbatimFields.length)} 项）：${preview.verbatimFields.join("、")}——这几项的说明没有额外的定位/排除子句，训练时就是上面这段原文。`);
  }
  return lines.join("\n");
};
