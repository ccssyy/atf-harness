/**
 * H5——atf_joint_train 多类联合训练入口（D25 设计 §四/§五＋指令 H5 节；内核 v0.7.23b0）。
 *
 * 路线定案（D25 设计 §〇/§六）：产品只有一个训练入口——联合是同一管线的 N>1，单类是 N=1
 * 特例。本工具即该唯一入口的多类面：一张确认卡（类型/各类字段数/预计行数/倍率/seed）→
 * 确认后一个联合任务内部完成「逐类数据构建（内核 builder）→ 确定性倍率合并 → 训练启动
 * （atf_run_training 执行函数直调）」——不出现单类 A/B 两入口，卡面/返回体不引导去 A/B。
 *
 * 执行链与取证（2026-10-21，内核 pin v0.7.23b0 只读面）：
 * - builder＝spawn `python3 <kernelDir>/tools/build_joint_dataset.py`（内核根解析复用实例
 *   pin 单源 resolveInstanceKernelDir——装配点注入 cfg.kernelDir，禁硬编码路径）；
 *   CLI：--run DOC_TYPE=RUN_DIR（可重复）＋--field-spec DOC_TYPE=SPEC_JSON（可重复，键集
 *   恰一致）＋--base-model-family（缺省 qwen3_vl）＋--seed＋--out。builder 无 oversample
 *   旗标——倍率由本工具确定性落地（见下）。
 * - --out 落点＝<目标run>/prep/joint/：内核 RunLayout/v1 --out 守卫单源
 *   （src/agentic_training_flow/run_layout.py ensure_out_within_run_layout）语义＝落点在
 *   run 树内须命中 run.json.dirs 声明闭集（exact 或前缀；prep 声明覆盖 prep/joint），
 *   无 run.json（legacy run）原样放行。本工具在卡前做同语义只读镜像判定
 *   （jointOutLayoutVerdict），树外落点零消耗拒绝。
 * - 卡前快败门（先于一切产物生成与审批，零消耗放行式——D32 start 逐参验证先例）：六态
 *   ＝某类 fields 空／字段说明缺失（zh/definition）／doc_type 重复／键集不一致／prep 产物
 *   缺失（prep/variants/train.jsonl 或 contract-candidate.json）／倍率非法；判定语义单源
 *   ＝atf-ui/src/jointTrainState.ts jointSpecIssues（UI 面同锚双钉）。
 * - 预计行数取实测：审批卡前先 dry 跑 builder（--out 落临时目录，run 树零写入）取
 *   joint-dataset-plan.json 的逐类 source_row_count——卡面行数＝实测 plan 而非估算；
 *   dry 跑同时镜像内核 _validate_and_collect 校验（跨类 field_id 共享命名空间等内核侧
 *   拒绝在卡前回流，零审批消耗）。
 * - oversample（按类倍率 map，缺省全 1）：builder 产物 train.jsonl 按 merge_manifest.json
 *   行级账（rows[].row_index/doc_type）做确定性倍率复制——原行序逐行重复 ratio 次，不改行
 *   内容；倍率全 1 时零改动直通（sha 与 builder 产物逐字节一致）。倍率账写 harness 侧注记
 *   harness-oversample.json（无时间戳——同 seed/倍率重跑逐字节稳定，D25 测试 7 锚）。
 * - 训练直调＝buildRunTrainingTool 的 execute 原样执行（DRY_RUN 校验/prelaunch 检查/
 *   base_model 复核/端口预检/GPU 排队/双启请示/探活进料全链零复制）；设计 §五.3「一张
 *   确认卡……由一个联合任务内部完成」——本工具卡即该任务的人工放行点，内部训练段的
 *   danger 卡由本卡承接（内部审批面仅对 toolName=atf_run_training 的请求应答 allowed-once，
 *   其余审批请求与 user-questions 双启请示等非审批闸原样透传真实服务；本卡未放行则整链
 *   一步都不走——审批 fails-closed 语义不变）。
 * - run_id 解析单源＝atf-ui enumerateRunEntries（server.ts resolveRunEntry 导出面——
 *   registry/canonical 先占、flat/bucket 后到，禁两套路径表）。
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { asToolValue, looseObjectOutput, renderAsJsonText } from "./schemaTranslate.js";
import { approvalDeniedResult, buildApprovalReason, requestApproval, type ApprovalFace } from "./approvalFace.js";
import { buildRunTrainingTool, type TrainingToolsConfig } from "./trainingFace.js";
import { resolveRunEntry, type RunDirEntry, type RegistryWorkspaceSeed } from "../../atf-ui/src/server.js";
import { listRegistryRecords, resolveDshHome } from "../../../../src/core/workspace/workspaceRegistry.js";
import {
  formatRowCount,
  jointSpecIssues,
  normalizeJointFieldSpec,
  type JointClassDraft,
  type JointFieldRow,
} from "../../atf-ui/src/jointTrainState.js";

/** 内核 builder 脚本（pin 单源——cfg.kernelDir 消费链，禁硬编码路径）。 */
export const JOINT_BUILDER_RELPATH = join("tools", "build_joint_dataset.py");
/** 联合产物落点（目标 run 声明目录 prep 的前缀闭集内——内核 RunLayout/v1 守卫合法形态）。 */
export const JOINT_OUT_REL = "prep/joint";
/** builder 超时（合并＝逐字拼接，大库亦快；5 分钟上限如实回报）。 */
export const JOINT_BUILDER_TIMEOUT_MS = 300_000;

/** builder 产物文件名（内核常量镜像——build_joint_dataset.py TRAIN/PLAN/MANIFEST_FILENAME）。 */
export const JOINT_TRAIN_FILENAME = "train.jsonl";
export const JOINT_PLAN_FILENAME = "joint-dataset-plan.json";
export const JOINT_MANIFEST_FILENAME = "merge_manifest.json";
/** harness 侧倍率账注记（与内核 merge_manifest 并列，不改写内核产物）。 */
export const JOINT_OVERSAMPLE_NOTE_FILENAME = "harness-oversample.json";

/** 内核 builder 失败码→卡前结构化回流（stderr JSON {"error","detail"} 协议）。 */
export interface JointBuilderStderr {
  error: string | null;
  detail: string | null;
}
export const parseJointBuilderStderr = (stderr: string): JointBuilderStderr => {
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; detail?: unknown };
      if (typeof parsed.error === "string") {
        return {
          error: parsed.error,
          detail: typeof parsed.detail === "string" ? parsed.detail : null,
        };
      }
    } catch {
      // 非 JSON 行跳过（builder 只在 stderr 打一行 JSON 错误账——其余为环境噪声）
    }
  }
  return { error: null, detail: null };
};

// ── --out 落点守卫（内核 run_layout.py ensure_out_within_run_layout 同语义只读镜像）──

export type JointOutVerdict = { ok: true } | { ok: false; error: "joint_out_outside_layout"; declared: string[]; note: string };

/** 落点判定：目标 run 有合法 run.json → rel 须命中 dirs 声明（exact 或前缀）；
 *  无 run.json／身份非法（legacy 形态）→ 原样放行（与内核守卫同口径——内核脚本侧仍单源复核）。 */
export const jointOutLayoutVerdict = (targetRunDir: string, rel: string): JointOutVerdict => {
  let document: unknown = null;
  try {
    document = JSON.parse(readFileSync(join(targetRunDir, "run.json"), "utf8")) as unknown;
  } catch {
    return { ok: true }; // legacy run（缺 run.json）——内核守卫同口径放行
  }
  if (document === null || typeof document !== "object") return { ok: true };
  const rawDirs = (document as { dirs?: unknown })["dirs"];
  if (!Array.isArray(rawDirs)) return { ok: true };
  const dirs = rawDirs.filter((d): d is string => typeof d === "string" && d !== "");
  const hit = dirs.some((d) => rel === d || rel.startsWith(`${d}/`));
  if (hit) return { ok: true };
  return {
    ok: false,
    error: "joint_out_outside_layout",
    declared: dirs,
    note: `联合产物落点 ${rel} 不在目标 run 的 run.json.dirs 声明闭集内（声明：${dirs.join("、") || "（空）"}）——内核 --out 守卫会拒绝；落点固定为 <目标run>/prep/joint/（prep 声明前缀内）`,
  };
};

// ── oversample 确定性倍率复制（纯函数——测试锚）──

export interface JointOversampleOutcome {
  ok: boolean;
  /** 复制后全文（倍率全 1＝原文直通，逐字节一致）。 */
  text: string;
  /** false＝全 1 直通（train.jsonl 零改动——sha 不变）。 */
  changed: boolean;
  final_rows: number;
  error?: "joint_oversample_failed";
  note?: string;
}

/** 行级账驱动的倍率复制：manifest rows[].row_index ↔ train.jsonl 非空行序一一对应，
 *  每行按其 doc_type 的倍率原序重复 ratio 次；行内容逐字不动、行序确定性（同输入同
 *  倍率 → 行数与 sha 稳定——D25 测试 7 锚）。账与文件行数不一致＝fail-closed 拒绝。 */
export const applyJointOversample = (
  trainText: string,
  rows: ReadonlyArray<{ row_index?: unknown; doc_type?: unknown }>,
  ratios: Readonly<Record<string, number>>,
): JointOversampleOutcome => {
  const lines = trainText.split("\n").filter((line) => line.trim() !== "");
  if (lines.length !== rows.length) {
    return {
      ok: false, text: trainText, changed: false, final_rows: lines.length,
      error: "joint_oversample_failed",
      note: `行级账与 train.jsonl 行数不一致（账 ${String(rows.length)} 行 / 文件 ${String(lines.length)} 行）——fail-closed 不改写，倍率账不落`,
    };
  }
  const allOne = Object.keys(ratios).length > 0 && Object.values(ratios).every((r) => r === 1);
  if (allOne) {
    return { ok: true, text: trainText, changed: false, final_rows: lines.length };
  }
  const out: string[] = [];
  for (const row of rows) {
    const index = typeof row.row_index === "number" ? row.row_index : -1;
    const line = index >= 0 ? lines[index] : undefined;
    const docType = typeof row.doc_type === "string" ? row.doc_type : "";
    if (line === undefined || docType === "") {
      return {
        ok: false, text: trainText, changed: false, final_rows: lines.length,
        error: "joint_oversample_failed",
        note: "行级账存在缺 row_index/doc_type 的坏行——fail-closed 不改写",
      };
    }
    const ratio = ratios[docType] ?? 1;
    for (let i = 0; i < ratio; i += 1) out.push(line);
  }
  return { ok: true, text: `${out.join("\n")}\n`, changed: true, final_rows: out.length };
};

// ── 请求归一与卡前快败门 ──

export interface JointClassResolved {
  doc_type: string;
  run_id: string;
  run_dir: string;
  document_zh: string;
  /** 归一后的 FieldSpec/v1（写盘形态——键序固定，确定性）。 */
  spec: Record<string, unknown>;
  field_count: number;
  /** spec 来源：inline＝调用方内联对象；file＝现成 spec 文件导入（原样拷贝入 run 树）。 */
  spec_source: "inline" | "file";
  /** file 来源的原始路径（审计面；inline＝null）。 */
  spec_file: string | null;
}

export interface JointRequestNormalized {
  classes: JointClassResolved[];
  ratios: Record<string, number> | null;
  seed: number;
  base_model_family: string;
  target_run_id: string;
  train_sh: string;
  prelaunch_report: string | null;
}

export type JointGateRejection = {
  ok: false;
  error: string;
  note: string;
  [key: string]: unknown;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonBlankString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** spec 行解析（导入文件与内联对象同构——只认 FieldSpec/v1 消费闭集，多余键不携带）。 */
const fieldRowsOf = (raw: unknown): JointFieldRow[] => {
  if (!Array.isArray(raw)) return [];
  const rows: JointFieldRow[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    rows.push({
      field_id: nonBlankString(item["field_id"]),
      zh: nonBlankString(item["zh"]),
      group: item["group"] === "non_goods" ? "non_goods" : "goods",
      definition: nonBlankString(item["definition"]),
      ...(Array.isArray(item["locators"]) ? { locators: item["locators"].filter((v): v is string => typeof v === "string") } : {}),
      ...(Array.isArray(item["locator_keywords"]) ? { locators: item["locator_keywords"].filter((v): v is string => typeof v === "string") } : {}),
      ...(Array.isArray(item["exclusions"]) ? { exclusions: item["exclusions"].filter((v): v is string => typeof v === "string") } : {}),
      ...(typeof item["confusable"] === "string" ? { confusable: item["confusable"] } : {}),
    });
  }
  return rows;
};

/**
 * 卡前快败门（纯结构面——零产物零审批零 spawn；prep/落点等盘面检查由调用方续做）。
 * 六态全覆盖：字段缺失／字段说明缺失／doc_type 重复／键集不一致／倍率非法（+形态与
 * 种子面）；判定语义单源＝jointTrainState.jointSpecIssues（UI 面同锚）。
 */
export const validateJointRequestShape = (args: {
  datasets?: unknown;
  field_specs?: unknown;
  oversample?: unknown;
  seed?: unknown;
  base_model_family?: unknown;
  target_run_id?: unknown;
  train_sh?: unknown;
  prelaunch_report?: unknown;
}): { ok: true; value: Omit<JointRequestNormalized, "classes"> & { classes: Array<Omit<JointClassResolved, "run_dir" | "spec" | "field_count"> & { fields: JointFieldRow[]; rawSpec: unknown }> } } | { ok: false; rejection: JointGateRejection } => {
  // ① datasets：数组且 ≥1 类；元素 {run_id, doc_type} 非空；doc_type 不重复
  const datasets = args.datasets;
  if (!Array.isArray(datasets) || datasets.length === 0) {
    return {
      ok: false,
      rejection: {
        ok: false, error: "joint_datasets_invalid", datasets: null,
        note: "datasets 必填：至少 1 个类型的数组，每项 {run_id, doc_type}（run_id＝该类已完成 prep 的实验，doc_type＝单据类型键）",
      },
    };
  }
  const docTypes: string[] = [];
  const runIds: string[] = [];
  for (const item of datasets) {
    if (!isPlainObject(item) || nonBlankString(item["run_id"]) === "" || nonBlankString(item["doc_type"]) === "") {
      return {
        ok: false,
        rejection: {
          ok: false, error: "joint_datasets_invalid", bad_item: item ?? null,
          note: "datasets 每项须为 {run_id, doc_type} 且两键非空字符串",
        },
      };
    }
    docTypes.push(nonBlankString(item["doc_type"]));
    runIds.push(nonBlankString(item["run_id"]));
  }
  const dup = docTypes.find((dt, i) => docTypes.indexOf(dt) !== i);
  if (dup !== undefined) {
    return {
      ok: false,
      rejection: {
        ok: false, error: "joint_doc_type_duplicate", doc_type: dup,
        note: `单据类型「${dup}」在 datasets 里重复——同一类型只能出现一次（多类联合，每类一项）`,
      },
    };
  }
  // ② field_specs：对象；键集与 datasets 恰一致；每类 inline 对象或 spec 文件路径
  const fieldSpecs = args.field_specs;
  if (!isPlainObject(fieldSpecs)) {
    return {
      ok: false,
      rejection: {
        ok: false, error: "joint_field_specs_invalid", field_specs: null,
        note: "field_specs 必填：按类型的对象（键＝doc_type）——值为 FieldSpec/v1 对象（内联）或现成 spec 文件绝对路径（导入，如实验树 field-configs/ 或 run 的 experiment-setup/）",
      },
    };
  }
  const specKeys = Object.keys(fieldSpecs).sort();
  const wantKeys = [...docTypes].sort();
  const missing = wantKeys.filter((k) => !specKeys.includes(k));
  const extra = specKeys.filter((k) => !wantKeys.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    return {
      ok: false,
      rejection: {
        ok: false, error: "joint_field_spec_keyset_mismatch", missing_keys: missing, extra_keys: extra,
        note: `field_specs 键集与 datasets 不一致（缺 ${missing.join("、") || "无"}／多 ${extra.join("、") || "无"}）——两处键集必须恰一致`,
      },
    };
  }
  // ③ 每类 spec 结构（共享判定单源——UI 面同锚）：字段空/说明缺/id 非法/中文名缺
  const classes: Array<Omit<JointClassResolved, "run_dir" | "spec" | "field_count"> & { fields: JointFieldRow[]; rawSpec: unknown }> = [];
  for (let i = 0; i < docTypes.length; i += 1) {
    const docType = docTypes[i] as string;
    const rawSpec = fieldSpecs[docType];
    let documentZh = "";
    let fields: JointFieldRow[] = [];
    let specSource: "inline" | "file" = "inline";
    let specFile: string | null = null;
    if (typeof rawSpec === "string") {
      // 文件导入形态：现成 FieldSpec/field-config 路径
      const path = rawSpec.trim();
      specSource = "file";
      specFile = path;
      if (path === "" || !isAbsolute(path) || !existsSync(path)) {
        return {
          ok: false,
          rejection: {
            ok: false, error: "joint_field_spec_unreadable", doc_type: docType, path,
            note: `「${docType}」的字段规格文件不可读（${path || "（空路径）"}）——给现成 FieldSpec/field-config JSON 的绝对路径，或改为内联对象`,
          },
        };
      }
      try {
        if (!statSync(path).isFile()) throw new Error("不是文件");
      } catch {
        return {
          ok: false,
          rejection: {
            ok: false, error: "joint_field_spec_unreadable", doc_type: docType, path,
            note: `「${docType}」的字段规格文件不可读（${path}）——给现成 FieldSpec/field-config JSON 的绝对路径，或改为内联对象`,
          },
        };
      }
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (!isPlainObject(parsed)) throw new Error("顶层不是 JSON 对象");
        documentZh = nonBlankString(parsed["document_zh"]);
        fields = fieldRowsOf(parsed["fields"]);
      } catch (cause) {
        return {
          ok: false,
          rejection: {
            ok: false, error: "joint_field_spec_unreadable", doc_type: docType, path,
            note: `「${docType}」字段规格文件解析失败（${cause instanceof Error ? cause.message : String(cause)}）——须为含 document_zh 与 fields 的 JSON 对象`,
          },
        };
      }
    } else if (isPlainObject(rawSpec)) {
      documentZh = nonBlankString(rawSpec["document_zh"]);
      fields = fieldRowsOf(rawSpec["fields"]);
    } else {
      return {
        ok: false,
        rejection: {
          ok: false, error: "joint_field_specs_invalid", doc_type: docType,
          note: `「${docType}」的字段规格须为 FieldSpec/v1 对象或 spec 文件路径字符串（得 ${typeof rawSpec}）`,
        },
      };
    }
    const draft: JointClassDraft = { doc_type: docType, run_id: runIds[i] as string, document_zh: documentZh, fields };
    const issues = jointSpecIssues([draft]);
    const first = issues[0];
    if (first !== undefined) {
      return {
        ok: false,
        rejection: {
          ok: false, error: first.code, doc_type: first.doc_type, field_id: first.field_id,
          issues,
          note: `${first.message}（卡前快败——零产物零审批；补齐后重推）`,
        },
      };
    }
    classes.push({
      doc_type: docType,
      run_id: runIds[i] as string,
      document_zh: documentZh,
      spec_source: specSource,
      spec_file: specFile,
      fields,
      rawSpec,
    });
  }
  // ④ oversample：可选按类倍率 map——键集恰一致＋整数 ≥1（非法零消耗拒绝）
  let ratios: Record<string, number> | null = null;
  if (args.oversample !== undefined && args.oversample !== null) {
    if (!isPlainObject(args.oversample)) {
      return {
        ok: false,
        rejection: {
          ok: false, error: "joint_oversample_invalid", oversample: null,
          note: "oversample 须为按类型的倍率对象（如 {\"pl\":1,\"swb\":2}）；省略＝全部 1 倍",
        },
      };
    }
    ratios = {};
    for (const [key, value] of Object.entries(args.oversample)) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        return {
          ok: false,
          rejection: {
            ok: false, error: "joint_oversample_invalid", doc_type: key, value: value ?? null,
            note: `倍率非法：「${key}」＝${JSON.stringify(value ?? null)}——倍率须为 ≥1 的整数`,
          },
        };
      }
      ratios[key] = value;
    }
    const ratioKeys = Object.keys(ratios).sort();
    const ratioMissing = wantKeys.filter((k) => !ratioKeys.includes(k));
    const ratioExtra = ratioKeys.filter((k) => !wantKeys.includes(k));
    if (ratioMissing.length > 0 || ratioExtra.length > 0) {
      return {
        ok: false,
        rejection: {
          ok: false, error: "joint_oversample_keyset_mismatch", missing_keys: ratioMissing, extra_keys: ratioExtra,
          note: `oversample 键集与 datasets 不一致（缺 ${ratioMissing.join("、") || "无"}／多 ${ratioExtra.join("、") || "无"}）——倍率按类给全或整体省略（缺省全 1）`,
        },
      };
    }
  }
  // ⑤ seed／base_model_family（记录进 plan/manifest——缺省与内核一致）
  const seed = args.seed ?? 0;
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0) {
    return {
      ok: false,
      rejection: {
        ok: false, error: "joint_seed_invalid", seed: seed ?? null,
        note: "seed 须为 ≥0 的整数（记录进 plan/manifest；缺省 0）",
      },
    };
  }
  const baseModelFamily = nonBlankString(args.base_model_family) || "qwen3_vl";
  // ⑥ 目标 run 与 train.sh（训练直调语义与 atf_run_training 一致）
  const targetRunId = nonBlankString(args.target_run_id);
  if (targetRunId === "") {
    return {
      ok: false,
      rejection: {
        ok: false, error: "joint_target_run_missing", target_run_id: null,
        note: "target_run_id 必填：联合训练落点实验（联合数据集写到它的 prep/joint/，构建后直接启动该 run 的训练）",
      },
    };
  }
  const trainSh = nonBlankString(args.train_sh);
  if (trainSh === "" || !isAbsolute(trainSh) || !existsSync(trainSh)) {
    return {
      ok: false,
      rejection: {
        ok: false, error: "joint_train_sh_missing", train_sh: trainSh || null,
        note: "train_sh 必填：目标 run 的 train.sh 绝对路径（须已过 DRY_RUN 生成链——训练段与 atf_run_training 同一执行函数）",
      },
    };
  }
  const prelaunchReport = nonBlankString(args.prelaunch_report);
  return {
    ok: true,
    value: {
      classes: classes as never,
      ratios,
      seed,
      base_model_family: baseModelFamily,
      target_run_id: targetRunId,
      train_sh: trainSh,
      prelaunch_report: prelaunchReport !== "" ? prelaunchReport : null,
    },
  };
};

// ── 工具构造 ──

export interface JointTrainToolsConfig {
  runsRoot: string;
  /** 内核根（实例 pin 单源——装配点 resolveInstanceKernelDir 注入）。 */
  kernelDir: string;
  logDir: string;
  /** 训练直调用（与 atf_run_training 同一执行函数——models 清单随卡面回流）。 */
  models?: { root: string; names: string[] };
  bindRun?: (runId: string) => Promise<void>;
  /** 注册工作区种子（测试注入面；缺省＝listRegistryRecords(resolveDshHome(env)) 实例态）。 */
  registryWorkspaces?: ReadonlyArray<RegistryWorkspaceSeed>;
}

/** builder 调用（python3 子进程——quantize 同款 env 针：技能自举关闭）。 */
const runBuilder = (script: string, argv: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    execFile(
      "python3",
      [script, ...argv],
      // 技能自举关闭（quantize 同口径——内核入口技能自举测试期关闭）
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ATF_SKILLS_AUTO_INSTALL: "0" } },
      (error, stdout, stderr) => {
        const raw = error === null ? 0 : (error as NodeJS.ErrnoException & { code?: number | string }).code;
        const code = typeof raw === "number" ? raw : null;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** builder argv（单源——dry 与真跑同构，仅 --out 不同；doc_type 字典序与内核类序一致）。 */
export const jointBuilderArgv = (input: {
  classes: ReadonlyArray<{ doc_type: string; run_dir: string; specPath: string }>;
  baseModelFamily: string;
  seed: number;
  out: string;
}): string[] => {
  const ordered = [...input.classes].sort((a, b) => (a.doc_type < b.doc_type ? -1 : a.doc_type > b.doc_type ? 1 : 0));
  const argv: string[] = [];
  for (const c of ordered) argv.push("--run", `${c.doc_type}=${c.run_dir}`);
  for (const c of ordered) argv.push("--field-spec", `${c.doc_type}=${c.specPath}`);
  argv.push("--base-model-family", input.baseModelFamily, "--seed", String(input.seed), "--out", input.out);
  return argv;
};

export const buildJointTrainTool = (ctx: { get(service: string): unknown }, cfg: JointTrainToolsConfig): unknown =>
  defineTool({
    name: "atf_joint_train",
    description:
      "多类联合训练（唯一训练入口的多类面——单类是 N=1 特例，不要拆成单类分步跑）：一次完成「N 类已完成 prep 的实验 → 联合数据集（每类字段独立、按类渲染 prompt，绝不做跨类字段并集）→ 确定性倍率合并 → 训练启动」。" +
      "datasets＝[{run_id, doc_type}]（每类一个已完成 prep 的实验）；field_specs＝按类型的字段规格（值为 FieldSpec/v1 对象：{document_zh, fields:[{field_id, zh, group(goods|non_goods), definition, locator_keywords?}]}，或现成字段规格 JSON 文件的绝对路径——导入后原样入 run 树）；oversample＝按类型倍率对象（可选，缺省全 1 倍；如 {\"pl\":1,\"swb\":2}）；seed（缺省 0，记录进合并账）；target_run_id＝联合训练落点实验（联合数据集写到它的 prep/joint/，构建后直接启动该实验的训练）；train_sh＝该实验的 train.sh 绝对路径（训练段与 atf_run_training 同一执行链）；prelaunch_report 可选。" +
      "确认卡会呈类型／各类字段数／预计行数（实测 builder plan）／合并倍率／seed——一张卡放行整链。字段缺失或字段说明缺失会被卡前拒绝（零消耗），先补齐字段规格再重推。",
    parameters: {
      // schema 全可选（必填语义由 description 携带）——卡前快败结构化码在 execute 内
      // 单源产出（quantize/D32 先例：schema 硬校验会抢走结构化错误面）。
      // field_specs/oversample 用 object+additionalProperties（vendor 类型词典 json＝作者侧专用，
      // 模型传参会被剥 null——门2 幕4 实测）；模型传参面类型必填语义仍由 description 携带。
      datasets: { type: "array", description: "必填：[{run_id, doc_type}] 数组（≥1 类；每类一个已完成 prep 的实验与它的单据类型键）" },
      field_specs: { type: "object", additionalProperties: true, description: "必填：按类型的字段规格对象（键＝doc_type）——值为 FieldSpec/v1 对象（{document_zh, fields:[{field_id, zh, group, definition}]}）或现成字段规格 JSON 文件绝对路径" },
      oversample: { type: "object", additionalProperties: true, description: "可选：按类型倍率对象（如 {\"pl\":1,\"swb\":2}）；省略＝全部 1 倍。倍率须为 ≥1 整数且键集与 datasets 一致" },
      seed: { type: "integer", description: "可选：随机种子（记录进合并账，缺省 0）" },
      base_model_family: { type: "string", description: "可选：基座模型族（记录进 plan 并决定渲染坐标制式，缺省 qwen3_vl）" },
      target_run_id: { type: "string", description: "必填：联合训练落点实验（联合数据集写到它的 prep/joint/，构建后直接启动该实验训练）" },
      train_sh: { type: "string", description: "必填：目标实验的 train.sh 绝对路径（训练段与 atf_run_training 同一执行链）" },
      prelaunch_report: { type: "string", description: "可选：build_prelaunch_report.py 产物路径（缺省自动扫 train.sh 同目录 prelaunch*）" },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    presentCall: function(args: { target_run_id?: string; datasets?: unknown }) {
      const count = Array.isArray(args.datasets) ? args.datasets.length : 0;
      return { card: "generic" as const, title: `联合训练（${String(count)} 类）— ${args.target_run_id ?? "会话绑定实验"}`, kind: "other" as const };
    },
    async execute(
      args: {
        datasets?: unknown;
        field_specs?: unknown;
        oversample?: unknown;
        seed?: unknown;
        base_model_family?: unknown;
        target_run_id?: unknown;
        train_sh?: unknown;
        prelaunch_report?: unknown;
      },
      exec: { agent?: unknown; callId?: string; signal?: unknown },
    ) {
      // ── ① 卡前快败门（零产物零审批——先于一切生成）──
      const shaped = validateJointRequestShape(args);
      if (!shaped.ok) return asToolValue(shaped.rejection);
      const normalized = shaped.value;

      // ── ② 盘面检查：源 run 解析（枚举单源）＋prep 产物＋目标 run＋--out 落点守卫 ──
      const registryWorkspaces = cfg.registryWorkspaces ??
        listRegistryRecords(resolveDshHome(process.env))
          .filter((record) => record.exists)
          .map((record) => ({ path: record.path, title: record.title, sessionIds: record.sessionIds }));
      const resolvedClasses: JointClassResolved[] = [];
      for (const item of normalized.classes) {
        const entry: RunDirEntry | null = resolveRunEntry(cfg.runsRoot, item.run_id, registryWorkspaces);
        if (entry === null) {
          return asToolValue({
            ok: false, error: "joint_run_unresolved", run_id: item.run_id, doc_type: item.doc_type,
            note: `「${item.doc_type}」的实验 ${item.run_id} 解析不到——run_id 须为已存在的实验（枚举面单源）；核对后重推`,
          });
        }
        const prepTrain = join(entry.dir, "prep", "variants", "train.jsonl");
        const candidate = join(entry.dir, "contract-candidate.json");
        const missing: string[] = [];
        if (!existsSync(prepTrain)) missing.push("prep/variants/train.jsonl");
        if (!existsSync(candidate)) missing.push("contract-candidate.json");
        if (missing.length > 0) {
          return asToolValue({
            ok: false, error: "joint_prep_missing", run_id: item.run_id, doc_type: item.doc_type,
            run_dir: entry.dir, missing,
            note: `「${item.doc_type}」的实验 ${item.run_id} prep 产物不齐（缺 ${missing.join("＋")}）——联合构建只消费已完成 prep 的实验`,
          });
        }
        resolvedClasses.push({
          doc_type: item.doc_type,
          run_id: item.run_id,
          run_dir: entry.dir,
          document_zh: item.document_zh,
          // 归一 spec（确定性键序）；file 来源在放行后原样拷贝（字节保留）
          spec: item.spec_source === "inline"
            ? normalizeJointFieldSpec(item.doc_type, item.document_zh, item.fields)
            : {},
          field_count: item.fields.length,
          spec_source: item.spec_source,
          spec_file: item.spec_file,
        });
      }
      const targetEntry = resolveRunEntry(cfg.runsRoot, normalized.target_run_id, registryWorkspaces);
      if (targetEntry === null) {
        return asToolValue({
          ok: false, error: "joint_run_unresolved", run_id: normalized.target_run_id, target: true,
          note: `联合训练落点实验 ${normalized.target_run_id} 解析不到——落点 run 须已存在（先建实验再联合）`,
        });
      }
      const outDir = join(targetEntry.dir, "prep", "joint");
      const outVerdict = jointOutLayoutVerdict(targetEntry.dir, JOINT_OUT_REL);
      if (!outVerdict.ok) {
        return asToolValue({
          ok: false, error: outVerdict.error, target_run_id: normalized.target_run_id, rel: JOINT_OUT_REL,
          declared: outVerdict.declared, note: outVerdict.note,
        });
      }
      const builderScript = join(cfg.kernelDir, JOINT_BUILDER_RELPATH);
      if (!existsSync(builderScript)) {
        return asToolValue({
          ok: false, error: "joint_builder_missing", script: builderScript,
          note: "内核联合构建器缺失（tools/build_joint_dataset.py）——核实例内核 pin 装配（须含 D25a builder 的内核版）",
        });
      }

      // ── ③ dry 取 plan（实测预计行数；同时镜像内核校验——卡前回流，零审批消耗）──
      // spec 先落临时目录（dry 与真跑同 argv 形态——唯一差异是 --out）。
      const dryRoot = mkdtempSync(join(tmpdir(), "atf-joint-dry-"));
      try {
        const drySpecDir = join(dryRoot, "field-specs");
        mkdirSync(drySpecDir, { recursive: true });
        const specPaths: Record<string, string> = {};
        for (const c of resolvedClasses) {
          const specPath = join(drySpecDir, `${c.doc_type}.json`);
          if (c.spec_source === "file" && c.spec_file !== null) copyFileSync(c.spec_file, specPath);
          else writeFileSync(specPath, `${JSON.stringify(c.spec, null, 1)}\n`, "utf8");
          specPaths[c.doc_type] = specPath;
        }
        const dryArgv = jointBuilderArgv({
          classes: resolvedClasses.map((c) => ({ doc_type: c.doc_type, run_dir: c.run_dir, specPath: specPaths[c.doc_type] as string })),
          baseModelFamily: normalized.base_model_family,
          seed: normalized.seed,
          out: join(dryRoot, "out"),
        });
        const dry = await runBuilder(builderScript, dryArgv, JOINT_BUILDER_TIMEOUT_MS);
        const dryPlanPath = join(dryRoot, "out", JOINT_PLAN_FILENAME);
        if (dry.code !== 0 || !existsSync(dryPlanPath)) {
          const kernel = parseJointBuilderStderr(dry.stderr);
          return asToolValue({
            ok: false, error: "joint_builder_failed", stage: "dry", kernel_error: kernel.error,
            ...(kernel.detail !== null ? { kernel_detail: kernel.detail } : {}),
            ...(kernel.error === null ? { stderr_tail: dry.stderr.slice(-800) } : {}),
            note: kernel.error !== null
              ? `内核构建器校验拒绝（卡前实测——零审批消耗）：${kernel.error}${kernel.detail !== null ? `｜${kernel.detail}` : ""}`
              : "dry 取 plan 失败（内核构建器非零退出）——按 stderr 明细修正后重推",
          });
        }
        const dryPlan = JSON.parse(readFileSync(dryPlanPath, "utf8")) as {
          classes?: Array<{ doc_type?: unknown; source_row_count?: unknown }>;
        };
        const sourceRowsByType: Record<string, number> = {};
        for (const c of dryPlan.classes ?? []) {
          if (typeof c.doc_type === "string" && typeof c.source_row_count === "number") sourceRowsByType[c.doc_type] = c.source_row_count;
        }
        const ratios = normalized.ratios ?? Object.fromEntries(resolvedClasses.map((c) => [c.doc_type, 1]));
        const classFacts = resolvedClasses.map((c) => {
          const sourceRows = sourceRowsByType[c.doc_type] ?? 0;
          const ratio = ratios[c.doc_type] ?? 1;
          return {
            doc_type: c.doc_type,
            run_id: c.run_id,
            field_count: c.field_count,
            source_rows: sourceRows,
            ratio,
            final_rows: sourceRows * ratio,
          };
        });
        const estimatedRows = classFacts.reduce((sum, c) => sum + c.final_rows, 0);

        // ── ④ 一张确认卡（E5 模板＋四要素＋seed＋权属行——设计 §4.3/D20h/D24h 纪律）──
        const typeList = resolvedClasses.map((c) => c.doc_type).join("、");
        const fieldCounts = classFacts.map((c) => `${c.doc_type} ${String(c.field_count)}`).join(" · ");
        const rowDetail = classFacts.map((c) => `${c.doc_type} ${formatRowCount(c.source_rows)}×${String(c.ratio)}`).join(" ＋ ");
        const ratioText = classFacts.map((c) => `${c.doc_type} ×${String(c.ratio)}`).join(" · ");
        const verdict = await requestApproval(ctx, exec, "atf_joint_train",
          buildApprovalReason({
            action: "多类联合数据构建并启动训练",
            target: `（${String(resolvedClasses.length)} 类：${typeList} → run ${normalized.target_run_id}）`,
            effect: `在落点 run 写联合数据集（${JOINT_OUT_REL}/）并启动该 run 训练（GPU 占用与训练产物写入）`,
            reversible: "数据产物可人工清理；训练启动不可自动回滚",
            cost: "按任务卡（GPU/时长以确认卡与 train.sh 为准）",
          }) + "\n" + [
            "联合明细：",
            `- 类型：${typeList}（${String(resolvedClasses.length)} 类）`,
            `- 各类字段数：${fieldCounts}`,
            `- 预计行数：${formatRowCount(estimatedRows)}（实测 builder plan：${rowDetail}）`,
            `- 合并倍率：${ratioText}${normalized.ratios === null ? "（缺省全 1）" : ""}`,
            `- seed：${String(normalized.seed)}`,
            "仅 owner 可点；执行方不得代点",
          ].join("\n"));
        if (!verdict.ok) return approvalDeniedResult("atf_joint_train", verdict.outcome);

        // ── ⑤ 真跑：spec 入 run 树 → builder → oversample → 倍率账注记 ──
        const specDir = join(outDir, "field-specs");
        mkdirSync(specDir, { recursive: true });
        const finalSpecPaths: Record<string, string> = {};
        for (const c of resolvedClasses) {
          const specPath = join(specDir, `${c.doc_type}.json`);
          if (c.spec_source === "file" && c.spec_file !== null) copyFileSync(c.spec_file, specPath);
          else writeFileSync(specPath, `${JSON.stringify(c.spec, null, 1)}\n`, "utf8");
          finalSpecPaths[c.doc_type] = specPath;
        }
        const buildArgv = jointBuilderArgv({
          classes: resolvedClasses.map((c) => ({ doc_type: c.doc_type, run_dir: c.run_dir, specPath: finalSpecPaths[c.doc_type] as string })),
          baseModelFamily: normalized.base_model_family,
          seed: normalized.seed,
          out: outDir,
        });
        const built = await runBuilder(builderScript, buildArgv, JOINT_BUILDER_TIMEOUT_MS);
        const trainPath = join(outDir, JOINT_TRAIN_FILENAME);
        const manifestPath = join(outDir, JOINT_MANIFEST_FILENAME);
        if (built.code !== 0 || !existsSync(trainPath) || !existsSync(manifestPath)) {
          const kernel = parseJointBuilderStderr(built.stderr);
          return asToolValue({
            ok: false, error: "joint_builder_failed", stage: "build", kernel_error: kernel.error,
            ...(kernel.detail !== null ? { kernel_detail: kernel.detail } : {}),
            ...(kernel.error === null ? { stderr_tail: built.stderr.slice(-800) } : {}),
            note: "内核构建器执行失败——按 stderr/内核错误码明细修正后重推（放行已消耗，先核对盘面再重推）",
          });
        }
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          rows?: Array<{ row_index?: unknown; doc_type?: unknown }>;
          merged?: { row_count?: unknown; sha256?: unknown };
        };
        const rowsLedger = Array.isArray(manifest.rows) ? manifest.rows : [];
        const builderMergedSha = typeof manifest.merged?.sha256 === "string" ? manifest.merged.sha256 : null;
        const trainText = readFileSync(trainPath, "utf8");
        const oversample = applyJointOversample(trainText, rowsLedger, ratios);
        if (!oversample.ok) {
          return asToolValue({ ok: false, error: oversample.error, note: oversample.note });
        }
        if (oversample.changed) writeFileSync(trainPath, oversample.text, "utf8");
        const finalSha = createHash("sha256").update(oversample.changed ? oversample.text : trainText).digest("hex");
        const note = {
          schema_version: "JointOversampleNote/v1",
          seed: normalized.seed,
          ratios,
          classes: classFacts.map((c) => ({
            doc_type: c.doc_type,
            source_rows: c.source_rows,
            ratio: c.ratio,
            final_rows: c.final_rows,
          })),
          merged: {
            row_count: oversample.final_rows,
            sha256: finalSha,
            builder_sha256: builderMergedSha,
            passthrough: !oversample.changed,
          },
        };
        const notePath = join(outDir, JOINT_OVERSAMPLE_NOTE_FILENAME);
        writeFileSync(notePath, `${JSON.stringify(note, null, 1)}\n`, "utf8");

        // ── ⑥ 训练直调（atf_run_training 执行函数原样——不出现 A/B 入口）──
        // 一张卡语义（设计 §五.3）：内部训练段的 danger 卡由本卡承接——内部审批面对
        // toolName=atf_run_training 的请求应答 allowed-once；其余服务原样透传真实 ctx
        // （user-questions 双启请示等非审批闸零触碰——该卡照常真人应答）。
        const realGet = (service: string): unknown => ctx.get(service);
        const innerCtx: { get(service: string): unknown } = {
          get: (service: string) => {
            if (service !== "approval") return realGet(service);
            const real = realGet("approval") as ApprovalFace | undefined;
            if (real === undefined || typeof real.request !== "function") return undefined;
            return {
              request: async (req: { toolName: string }) =>
                req.toolName === "atf_run_training" ? "allowed-once" : await real.request(req as never),
            };
          },
        };
        const trainCfg: TrainingToolsConfig = {
          runsRoot: cfg.runsRoot,
          logDir: cfg.logDir,
          ctx: innerCtx,
          ...(cfg.models !== undefined ? { models: cfg.models } : {}),
          ...(cfg.bindRun !== undefined ? { bindRun: cfg.bindRun } : {}),
        };
        const innerTraining = buildRunTrainingTool(innerCtx, trainCfg) as {
          execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>;
        };
        const trainingResult = await innerTraining.execute(
          {
            action: "start",
            train_sh: normalized.train_sh,
            run_id: normalized.target_run_id,
            ...(normalized.prelaunch_report !== null ? { prelaunch_report: normalized.prelaunch_report } : {}),
          },
          exec,
        );

        // ── ⑦ 返回体（typert lossless——条件 spread 拒 undefined 键）──
        return asToolValue({
          ok: true,
          started: trainingResult["started"] === true,
          action: "joint_train",
          run_id: normalized.target_run_id,
          doc_types: resolvedClasses.map((c) => c.doc_type),
          seed: normalized.seed,
          base_model_family: normalized.base_model_family,
          classes: classFacts,
          oversample: ratios,
          joint_dir: outDir,
          train_jsonl: trainPath,
          plan_path: join(outDir, JOINT_PLAN_FILENAME),
          manifest_path: manifestPath,
          oversample_note: notePath,
          merged_rows: oversample.final_rows,
          merged_sha256: finalSha,
          oversample_passthrough: !oversample.changed,
          training: trainingResult,
          note: trainingResult["started"] === true
            ? `联合数据集已构建（${String(resolvedClasses.length)} 类，${formatRowCount(oversample.final_rows)} 行）且训练已启动——status 跟进训练进度；评估按类各自选字段集`
            : `联合数据集已构建（${String(resolvedClasses.length)} 类，${formatRowCount(oversample.final_rows)} 行）但训练未启动——按 training 载荷的 error/note 处理后重推（数据产物已在位，重推只需补训练）`,
        });
      } finally {
        rmSync(dryRoot, { recursive: true, force: true });
      }
    },
  });
