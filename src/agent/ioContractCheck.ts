// -*- coding: utf-8 -*-
// StageIoContract C2：atf_write 写时校验（首版范围=owner 确认口径）——
// 只拦「已登记 schema（schema: 形态声明）且落在段产物声明路径上的件」：
//   ① content 须为合法 JSON；② schema_version 须与声明引用一致。
// raw: 文件合同件、未声明路径（scratch 等自由面）零打扰放行。
// 声明数据单源=内核 stage_registry（经 codegen:stage-order 导出 STAGE_REGISTRY_V2 的
// output_artifacts 字段）；本校验逻辑只是声明数据的消费方实现。
import { STAGE_REGISTRY_V2 } from "../core/generated/stageOrder.js";

export interface IoDecl {
  stage: string;
  name: string;
  schemaRef: string;
  pathPattern: string;
}

/** codegen 导出的全段 output 声明（schema: 形态才参与写时校验）。 */
export const OUTPUT_DECLS: readonly IoDecl[] = STAGE_REGISTRY_V2.flatMap((e) =>
  (e.output_artifacts ?? []).map((d) => ({
    stage: e.stage,
    name: d.name,
    schemaRef: d.schema_ref,
    pathPattern: d.path_pattern,
  })),
);

const placeholderRe = /<(doc_type|dataset)>/g;

/** path_pattern（run 相对，占位符形态）→ 在绝对路径上 search 的 RegExp。 */
const patternToRe = (pattern: string): RegExp => {
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(placeholderRe, "[^/]+");
  return new RegExp(source);
};

export interface IoViolation {
  reason: string;
  message: string;
}

/**
 * 内核单源统计件闭集（子切片 6·M8 形态丙——只拦统计件，agent 判读件与 scratch 自由）。
 * 分层准则（owner 1107 裁定）=语义判读归 agent / 事实统计归内核：闭集=内核脚本自产的事实
 * 统计/计划/装配件文件名。1112 实锚=agent 手跑 field_risk_signals.py 直写 run 产物绕段门禁。
 */
const KERNEL_STATISTIC_FILES: readonly string[] = [
  "field_risk_signals.json",
  "visual-sample-plan.json",
  "label-qc-report.json",
  "qc-parallel-workorders.json",
  "registration.json",
  "split-manifest.json",
  "iteration-config.json",
  "train.sh",
];

/** run 数据面判定：路径含 run 目录标记（experiments/<exp>/<run> 或 datasets/）即视为 run 产物面；scratch/tmp 自由。 */
const inRunDataSurface = (absPath: string): boolean =>
  /experiments\/[a-z0-9_-]+\/[a-z0-9_-]+\//.test(absPath) || /\/datasets\//.test(absPath);

/**
 * 内核单源统计件外部直写拦截（子切片 6，纯函数）。
 *
 * @param absPath 写目标绝对路径。
 * @return 违例描述（含段入口指路）；null=放行（agent 判读件/scratch/非闭集）。
 */
export const kernelStatisticWriteViolationOf = (absPath: string): IoViolation | null => {
  if (!inRunDataSurface(absPath)) return null;
  const base = absPath.split("/").pop() ?? "";
  if (!KERNEL_STATISTIC_FILES.includes(base)) return null;
  return {
    reason: "kernel_statistic_write_denied",
    message: `「${base}」是内核单源统计件（分层准则：事实统计归内核），不允许从文件工具旁路直写——旁路产物绕过段门禁校验（1112 实锚：手跑脚本直写导致段状态与盘面不一致）。how_to_fix：走段入口重跑本段由内核自产该件（如 field_risk_signals 由对应段门禁自建命令产出）；若为修数场景，用段入口的重跑/补件参数而非直写文件`,
  };
};

/**
 * 写时校验判据（纯函数）。
 *
 * @param absPath 写目标绝对路径。
 * @param content 待写内容。
 * @param decls 段 output 声明闭集（缺省=codegen 单源导出）。
 * @return 违例描述；null=放行。
 */
export const ioContractViolationOf = (
  absPath: string,
  content: string,
  decls: readonly IoDecl[] = OUTPUT_DECLS,
): IoViolation | null => {
  for (const decl of decls) {
    if (!decl.schemaRef.startsWith("schema:")) continue; // raw: 文件合同件不校验内容
    if (!patternToRe(decl.pathPattern).test(absPath)) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(content) as unknown;
    } catch {
      return {
        reason: "io_contract_violation",
        message: `段产物件「${decl.name}」（${decl.stage} 段声明，schema ${decl.schemaRef.slice("schema:".length)}）内容不是合法 JSON——声明路径上的件必须为 JSON 且带 schema_version。how_to_fix：改为 JSON 形态并带 schema_version="${decl.schemaRef.slice("schema:".length)}" 再写；若是临时笔记请写 scratch 相对路径`,
      };
    }
    const version =
      typeof doc === "object" && doc !== null && !Array.isArray(doc)
        ? (doc as Record<string, unknown>)["schema_version"]
        : undefined;
    const expected = decl.schemaRef.slice("schema:".length);
    if (typeof version !== "string" || version === "") {
      return {
        reason: "io_contract_violation",
        message: `段产物件「${decl.name}」（${decl.stage} 段声明）缺 schema_version——契约件以 schema_version 自标识。how_to_fix：内容顶层加 "schema_version": "${expected}" 再写`,
      };
    }
    if (version !== expected) {
      return {
        reason: "io_contract_violation",
        message: `段产物件「${decl.name}」schema_version 不符：写了 "${version}"，声明要求 "${expected}"（${decl.stage} 段）。how_to_fix：二选一——改 schema_version 为声明值；或确认这不是 ${decl.stage} 段产物、改写其它路径（不要冒用契约件路径）`,
      };
    }
    return null; // 命中声明且校验通过——一个路径只归一个声明，命中即止
  }
  return null;
};
