/**
 * T2 附件装配的 harness 呈现面（只读 + 业务话）。
 *
 * 分工（照内核 SKILL 的三层边界）：内核装配器只产确定性产物（`assembly-report.json` 与
 * 六节方案稿），**不弹卡、不做业务决策**；呈现由会话面负责。本模块就是 harness 侧的呈现层：
 * 读内核报告 → 翻成业务话 → 交给工具决定「弹卡确认」还是「一行汇报落文件」。
 *
 * 两档只改呈现、不改结果（owner 2026-10-26 裁定）：
 * - 非完全授权档：弹一张确认卡（原生 options + multiSelect），用户可勾掉不对的判断；
 * - 完全授权档（预设 atf-training ＋ 权限档 danger-full-access）：不弹卡，对话一行汇报 +
 *   落 `<ws>/analysis/attachments-report.md`。
 * 两条路径读同一份报告、走同一套业务话映射，差别只在「问不问」。
 *
 * 用户面纪律：不出现 images／records／instructions／field_config／auxiliary／template 这些
 * 内部角色名（一律用 ROLE_BUSINESS 的中文说法）；置信度不给数字，只给「比较确定／大概是这样／
 * 说不太准／看不出来」四档，且低于 50% 才追加一句「这一项我不太确定，你确认一下」。
 */
import { existsSync, readFileSync } from "node:fs";

/** 装配报告固定 schema 版本（内核 blocks_report.REPORT_SCHEMA）。 */
export const ASSEMBLY_REPORT_SCHEMA = "AssemblyReport/v1";

/** 角色闭集（与内核 classify.ROLES 同集；只用于校验与映射，不对外呈现）。 */
export const ASSEMBLY_ROLES = ["images", "records", "instructions", "field_config", "template", "auxiliary"] as const;
export type AssemblyRole = (typeof ASSEMBLY_ROLES)[number];

/** 角色 → 用户面说法（业务话单源；内核 ROLE_LABEL 同义，harness 不依赖对方代码故本地持有）。 */
export const ROLE_BUSINESS: Readonly<Record<AssemblyRole, string>> = {
  images: "单据图像",
  records: "结构化记录",
  instructions: "抽取说明",
  field_config: "字段配置",
  template: "输出模板",
  auxiliary: "未归类的附带文件",
};

/** 角色 → 缺件时的**后果**说明（只说「接下来会怎样」，不复述角色名——避免与内核 detail 撞车：
 *  报告里的 detail 通常已经是「包内有抽取说明，但没找到字段配置」，再复述一遍就成了
 *  「没找到字段配置……没找到字段配置」）。 */
export const MISSING_IMPACT: Readonly<Record<AssemblyRole, string>> = {
  images: "训练没法开始，请补上单据图像",
  records: "接下来会先问你怎么标",
  instructions: "接下来会问你要抽哪些字段、怎么定位",
  field_config: "接下来会问你要抽哪些字段",
  template: "输出格式会先按默认规则",
  auxiliary: "附带文件不进数据集，不影响训练",
};

/** 置信度分档（业务话；不暴露数字）。 */
export type ConfidenceBand = "high" | "medium" | "low" | "unknown";

export const CONFIDENCE_WORD: Readonly<Record<ConfidenceBand, string>> = {
  high: "比较确定",
  medium: "大概是这样",
  low: "说不太准",
  unknown: "看不出来",
};

/** 低于此值追加一句「这一项我不太确定，你确认一下」（owner 定的 50%）。 */
export const UNCERTAIN_BELOW = 0.5;
/** 内核的「无法判断」下限（低于它按看不出来处理）。 */
export const INCONCLUSIVE_BELOW = 0.35;

export interface AssemblyIdentified {
  id: string;
  role: AssemblyRole;
  roleLabel: string;
  pathCount: number;
  confidence: number;
  inconclusive: boolean;
  paths: string[];
  /** 并列候选（有则一并呈现为「也可能是什么」）。 */
  alternatives: string[];
  rationale: string;
}

export interface AssemblyMissing {
  role: AssemblyRole;
  detail: string;
  basis: string[];
}

export interface AssemblyDegraded {
  path: string;
  reason: string;
}

export interface AssemblyRevision {
  id: string;
  from: string;
  to: string;
  reason: string;
  at?: string;
}

export interface AssemblyReport {
  datasetName: string;
  identified: AssemblyIdentified[];
  missing: AssemblyMissing[];
  degraded: AssemblyDegraded[];
  revisions: AssemblyRevision[];
  landing: string;
  planPath: string;
  version: string;
}

export type AssemblyParse =
  | { ok: true; report: AssemblyReport }
  | { ok: false; error: "assembly_report_incomplete"; missing: string; note: string }
  | { ok: false; error: "assembly_report_malformed"; note: string };

/** 字段 → 用户面名字（「装配结果不完整，缺 X」里的 X）。 */
const FIELD_BUSINESS: Readonly<Record<string, string>> = {
  identified: "识别结果",
  id: "判断编号",
  role: "判断类型",
  path_count: "文件数",
  confidence: "把握度",
  missing: "缺口清单",
  degraded: "未读到的信息",
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const incomplete = (field: string, at?: string): AssemblyParse => {
  const name = FIELD_BUSINESS[field] ?? field;
  return {
    ok: false,
    error: "assembly_report_incomplete",
    missing: name,
    note: `装配结果不完整，缺「${name}」${at === undefined ? "" : `（${at}）`}——请回内核重跑一次整理（harness 不猜、不自行补齐）`,
  };
};

/**
 * 报告解析（严格校验结构但不改语义）：缺字段即报「装配结果不完整，缺 X」；
 * 结构不是对象/JSON 坏即「装配结果读不出来」。
 * @param raw 报告文件内容。
 */
export const parseAssemblyReport = (raw: string): AssemblyParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "assembly_report_malformed", note: "装配结果读不出来（不是合法 JSON）——请回内核重跑一次整理" };
  }
  const root = asRecord(parsed);
  if (root === null) return { ok: false, error: "assembly_report_malformed", note: "装配结果读不出来（不是键值结构）——请回内核重跑一次整理" };
  const schema = str(root["schema_version"]);
  if (schema !== "" && schema !== ASSEMBLY_REPORT_SCHEMA) {
    return { ok: false, error: "assembly_report_malformed", note: `装配结果版本不认识（${schema}）——请更新到与内核同版本的整理脚本后重跑` };
  }
  if (!Array.isArray(root["identified"])) return incomplete("identified");
  const identified: AssemblyIdentified[] = [];
  for (const [index, entry] of (root["identified"] as unknown[]).entries()) {
    const row = asRecord(entry);
    if (row === null) return incomplete("identified", `第 ${String(index + 1)} 项不是键值结构`);
    const id = str(row["id"]);
    if (id === "") return incomplete("id", `第 ${String(index + 1)} 项`);
    const role = str(row["role"]) as AssemblyRole;
    if (!(ASSEMBLY_ROLES as readonly string[]).includes(role)) return incomplete("role", `判断 ${id}`);
    const pathCount = num(row["path_count"]);
    if (pathCount === null) return incomplete("path_count", `判断 ${id}`);
    const confidence = num(row["confidence"]);
    if (confidence === null) return incomplete("confidence", `判断 ${id}`);
    const paths = Array.isArray(row["paths"]) ? (row["paths"] as unknown[]).filter((item): item is string => typeof item === "string") : [];
    const alternatives = Array.isArray(row["alternatives"])
      ? (row["alternatives"] as unknown[]).map((item) => (asRecord(item) === null ? "" : str((item as Record<string, unknown>)["role"]))).filter((item) => item !== "")
      : [];
    identified.push({
      id,
      role,
      roleLabel: str(row["role_label"]) === "" ? ROLE_BUSINESS[role] : str(row["role_label"]),
      pathCount,
      confidence,
      inconclusive: row["inconclusive"] === true || confidence < INCONCLUSIVE_BELOW,
      paths,
      alternatives,
      rationale: str(row["rationale"]),
    });
  }
  const missingRaw = root["missing"];
  if (missingRaw !== undefined && !Array.isArray(missingRaw)) return incomplete("missing");
  const missing: AssemblyMissing[] = [];
  for (const entry of (missingRaw as unknown[] | undefined) ?? []) {
    const row = asRecord(entry);
    if (row === null) continue;
    const role = str(row["role"]) as AssemblyRole;
    if (!(ASSEMBLY_ROLES as readonly string[]).includes(role)) continue;
    missing.push({
      role,
      detail: str(row["detail"]),
      basis: Array.isArray(row["basis"]) ? (row["basis"] as unknown[]).filter((item): item is string => typeof item === "string") : [],
    });
  }
  const degradedRaw = root["degraded"];
  const degraded: AssemblyDegraded[] = [];
  for (const entry of Array.isArray(degradedRaw) ? (degradedRaw as unknown[]) : []) {
    const row = asRecord(entry);
    if (row === null) continue;
    degraded.push({ path: str(row["path"]) === "" ? str(row["entry"]) : str(row["path"]), reason: str(row["reason"]) });
  }
  const revisions: AssemblyRevision[] = [];
  for (const entry of Array.isArray(root["revision"]) ? (root["revision"] as unknown[]) : []) {
    const row = asRecord(entry);
    if (row === null) continue;
    revisions.push({
      id: str(row["id"]),
      from: str(row["from"]),
      to: str(row["to"]),
      reason: str(row["reason"]),
      ...(str(row["at"]) === "" ? {} : { at: str(row["at"]) }),
    });
  }
  return {
    ok: true,
    report: {
      datasetName: str(root["dataset_name"]),
      identified,
      missing,
      degraded,
      revisions,
      landing: str(root["landing"]),
      planPath: str(root["plan_path"]),
      version: str(root["version"]),
    },
  };
};

/** 读报告文件（不存在＝assembly_report_missing，调用方给「装配结果未找到」）。 */
export const readAssemblyReport = (path: string): AssemblyParse | { ok: false; error: "assembly_report_missing"; note: string } => {
  if (!existsSync(path)) {
    return {
      ok: false,
      error: "assembly_report_missing",
      note: `装配结果未找到（${path}）——先把素材整理跑完（清点→判断→落地），有了装配结果再来确认`,
    };
  }
  try {
    return parseAssemblyReport(readFileSync(path, "utf8"));
  } catch (cause) {
    return { ok: false, error: "assembly_report_malformed", note: `装配结果读不出来：${String(cause).slice(0, 160)}` };
  }
};

/** 置信度 → 业务话分档。 */
export const confidenceBandOf = (confidence: number): ConfidenceBand => {
  if (confidence < INCONCLUSIVE_BELOW) return "unknown";
  if (confidence >= 0.8) return "high";
  if (confidence >= UNCERTAIN_BELOW) return "medium";
  return "low";
};

/** 该项要不要加一句「我不太确定」（<50% 才加；看不出来必然加）。 */
export const needsUserConfirmation = (confidence: number): boolean => confidence < UNCERTAIN_BELOW;

/** 一项的业务描述：`单据图像 438 个（比较确定）`＋（必要时）不确定提示＋并列候选。 */
export const identifiedLineOf = (item: AssemblyIdentified): string => {
  const band = confidenceBandOf(item.confidence);
  const head = `${item.roleLabel} ${String(item.pathCount)} 个（${CONFIDENCE_WORD[band]}）`;
  const uncertain = needsUserConfirmation(item.confidence) ? "——这一项我不太确定，你确认一下" : "";
  const alt = item.alternatives.length > 0
    ? `；也可能是${item.alternatives.map((role) => ROLE_BUSINESS[role as AssemblyRole] ?? role).join("／")}`
    : "";
  return `${head}${alt}${uncertain}`;
};

/** 缺件一行：`字段配置：没找到字段配置，接下来会问你要抽哪些字段`。 */
export const missingLineOf = (entry: AssemblyMissing): string =>
  `${ROLE_BUSINESS[entry.role]}：${entry.detail === "" ? MISSING_IMPACT[entry.role] : `${entry.detail}——${MISSING_IMPACT[entry.role]}`}`;

/** 未读到一行。 */
export const degradedLineOf = (entry: AssemblyDegraded): string =>
  `${entry.path === "" ? "有一个文件" : entry.path}：${entry.reason === "" ? "内容没读到（原因内核未给出）" : entry.reason}`;

/** 卡面 detail（业务话，含识别结果摘要、缺口、未读到、修订数）。 */
export const renderAssemblyCardDetail = (report: AssemblyReport): string => {
  const lines: string[] = [];
  lines.push(`我在这次素材包里认出了这些（共 ${String(report.identified.length)} 类）：`);
  for (const item of report.identified) lines.push(`  · ${item.id}｜${identifiedLineOf(item)}`);
  if (report.missing.length > 0) {
    lines.push("没有找到的：");
    for (const entry of report.missing) lines.push(`  · ${missingLineOf(entry)}`);
  } else {
    lines.push("没有缺件。");
  }
  if (report.degraded.length > 0) {
    lines.push(`有 ${String(report.degraded.length)} 个文件的信息没读全：`);
    for (const entry of report.degraded) lines.push(`  · ${degradedLineOf(entry)}`);
  }
  if (report.revisions.length > 0) lines.push(`已按你之前的说明改过 ${String(report.revisions.length)} 条判断。`);
  lines.push("下面把「还成立的判断」勾上（不勾＝我判错了，我会再问你它到底是什么）。");
  return lines.join("\n");
};

/** 完全授权档的一行汇报（对话里只说一句，细节进报告文件）。 */
export const renderAssemblySummaryLine = (report: AssemblyReport): string => {
  const parts = report.identified.map((item) => `${item.roleLabel} ${String(item.pathCount)} 个`);
  const gaps = report.missing.length === 0 ? "没有缺件" : `缺 ${report.missing.map((entry) => ROLE_BUSINESS[entry.role]).join("、")}`;
  const where = report.landing === "" ? "" : `；已整理到 ${report.landing}`;
  const degraded = report.degraded.length === 0 ? "" : `；${String(report.degraded.length)} 个文件的信息没读全`;
  return `素材整理好了：${parts.join("、")}；${gaps}${where}${degraded}。细节写在 ${report.datasetName === "" ? "分析目录" : `${report.datasetName} 的分析目录`}的 attachments-report.md。`;
};

/**
 * 完全授权档落盘的业务话报告（不是 JSON 转贴）。
 * @param report 装配报告。
 * @returns markdown 文本。
 */
export const renderAttachmentsMarkdown = (report: AssemblyReport): string => {
  const lines: string[] = [];
  lines.push(`# 素材整理结果${report.datasetName === "" ? "" : `（${report.datasetName}）`}`);
  lines.push("");
  lines.push("## 识别结果");
  for (const item of report.identified) {
    lines.push(`- ${item.id}｜${identifiedLineOf(item)}`);
    if (item.rationale !== "") lines.push(`  - 依据：${item.rationale}`);
  }
  lines.push("");
  lines.push("## 缺口");
  if (report.missing.length === 0) lines.push("- 没有缺件");
  for (const entry of report.missing) lines.push(`- ${missingLineOf(entry)}`);
  lines.push("");
  lines.push("## 未读到的信息");
  if (report.degraded.length === 0) lines.push("- 无");
  for (const entry of report.degraded) lines.push(`- ${degradedLineOf(entry)}`);
  lines.push("");
  lines.push("## 落点");
  lines.push(`- ${report.landing === "" ? "（尚未落地）" : report.landing}`);
  if (report.planPath !== "") lines.push(`- 整理方案：${report.planPath}`);
  lines.push("");
  lines.push("## 按你的说明改动");
  if (report.revisions.length === 0) lines.push("- 暂无");
  for (const entry of report.revisions) {
    lines.push(`- ${entry.id}：${ROLE_BUSINESS[entry.from as AssemblyRole] ?? entry.from} → ${ROLE_BUSINESS[entry.to as AssemblyRole] ?? entry.to}（${entry.reason}）`);
  }
  lines.push("");
  return `${lines.join("\n")}`;
};
