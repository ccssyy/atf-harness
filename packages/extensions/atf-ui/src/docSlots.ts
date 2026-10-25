/**
 * E8——一个 run 多单据槽位读侧路径表（H3a；全仓唯一实现，后续工具面复用禁止第二份）。
 *
 * 槽位合同＝owner 决议《ATF_决议与指令_E8_一个run多槽位_20261025》§〇（裁定 A）：
 * - 槽位根 publish/<doc>/：契约三件随槽位（contract-candidate.json／confirmation-report.md／
 *   contract-user-confirmation.json）＋发布工作区 publish/<doc>/<attempt>/（attempt＝候选 sha 前 8）；
 * - 槽位 prep/variants/<doc>/（train.jsonl／lineage／dataset_info／variants_report）；
 * - 槽位 experiment-setup/<doc>/（field-config.json 登记副本）；prep/prompt-profile/<doc>.json、
 *   prep/risk-signals/<doc>/ 同轴（本仓暂未消费不展开——需要时经本模块补，不另起路径表）；
 * - run 级联合合并件落 prep/variants/ 根（train.jsonl 文件形态）——与槽位子目录天然区分。
 *
 * 类枚举单源＝prep/variants/ 下「有 train.jsonl 的子目录」（E8 K1.4，与内核同式）；根级
 * train.jsonl 文件不构成类（run 级合并件／legacy 平铺形态）。doc_type 字典序（内核 sorted 同式）。
 * E8b 补 runDocRegistry：已登记单据清单读侧（内核 b13 run.json docs[] 优先，缺键目录探测
 * 标 legacy）——「已登记清单」与「已备槽位」（listDocSlots）是两个事实面，消费方比对不合并。
 * legacy 只读 fallback（E8 §〇 旧 run 兼容：不迁移、不双写）：run 根三件＋publish/<attempt>/
 * （内核 RunLayout/v1 canonical 现形态——attempt 目录＝候选 sha 前 8 hex）；经
 * legacyCandidatePath／legacyPublishWorkspaces 提供，槽位优先、根级仅 fallback。
 * N=1 与 N>1 同一条代码路径（槽位数＝1 即恒等，不设分支）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 槽位名规则（E8 §〇：doc_type 须匹配本式——内核写入侧 fail-closed，读侧非法名不构成类）。 */
export const DOC_TYPE_SLOT_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** attempt 目录名（候选 sha 前 8——hex 小写；publish 工作区标识）。 */
export const ATTEMPT_DIR_RE = /^[0-9a-f]{8}$/;

/** 单据槽位（路径表——存在性由消费方按需判，本结构不造假值）。 */
export interface DocSlot {
  doc_type: string;
  /** 槽位根 <runDir>/publish/<doc>/。 */
  slot_dir: string;
  /** 契约候选 <slot_dir>/contract-candidate.json。 */
  candidate_path: string;
  /** 变体槽位 <runDir>/prep/variants/<doc>/。 */
  variants_dir: string;
  /** 该类训练数据 <variants_dir>/train.jsonl。 */
  train_jsonl: string;
  /** 字段规格登记副本 <runDir>/experiment-setup/<doc>/field-config.json。 */
  field_config: string;
  /** 发布工作区 <slot_dir>/<attempt>/（字典序首；未发现＝null）。 */
  publish_ws: string | null;
  /** attempt 名（候选 sha 前 8；未发现＝null）。 */
  attempt: string | null;
}

/** 槽位发布工作区发现：slot_dir 直下 attempt 形态目录，字典序取首（确定性）。 */
const firstAttemptOf = (slotDir: string): string | null => {
  try {
    const names = readdirSync(slotDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ATTEMPT_DIR_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    return names[0] ?? null;
  } catch {
    return null; // 槽位根缺席＝尚未发布
  }
};

/**
 * 单据槽位枚举（全仓唯一读侧路径表）：prep/variants/<doc>/ 有 train.jsonl 的子目录即类；
 * prep/variants 缺席／无合格子目录 → 空数组（legacy／未槽位化 run，消费方走 legacy fallback）。
 */
export const listDocSlots = (runDir: string): DocSlot[] => {
  const classes: string[] = [];
  try {
    for (const entry of readdirSync(join(runDir, "prep", "variants"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue; // 根级 train.jsonl 文件＝run 级合并件，不构成类
      if (!DOC_TYPE_SLOT_RE.test(entry.name)) continue; // 非法槽位名不构成类（如实跳过）
      if (!existsSync(join(runDir, "prep", "variants", entry.name, "train.jsonl"))) continue;
      classes.push(entry.name);
    }
  } catch {
    return [];
  }
  classes.sort();
  return classes.map((docType) => {
    const slotDir = join(runDir, "publish", docType);
    const attempt = firstAttemptOf(slotDir);
    return {
      doc_type: docType,
      slot_dir: slotDir,
      candidate_path: join(slotDir, "contract-candidate.json"),
      variants_dir: join(runDir, "prep", "variants", docType),
      train_jsonl: join(runDir, "prep", "variants", docType, "train.jsonl"),
      field_config: join(runDir, "experiment-setup", docType, "field-config.json"),
      publish_ws: attempt !== null ? join(slotDir, attempt) : null,
      attempt,
    };
  });
};

/** legacy 契约候选（run 根三件之一——只读 fallback；存在性由消费方判）。 */
export const legacyCandidatePath = (runDir: string): string => join(runDir, "contract-candidate.json");

/**
 * legacy 发布工作区：publish/ 直下 attempt 形态目录（内核 RunLayout/v1 canonical 现形态）。
 * docTypes＝在槽位类名集合（listDocSlots 产物）——doc_type 恰为 8hex 名时 publish/<该名>/
 * 是槽位根而非 attempt 工作区，须排除（调用方传入，避免本函数内二次枚举）。
 */
export const legacyPublishWorkspaces = (runDir: string, docTypes: ReadonlySet<string> = new Set()): string[] => {
  try {
    return readdirSync(join(runDir, "publish"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ATTEMPT_DIR_RE.test(entry.name) && !docTypes.has(entry.name))
      .map((entry) => join(runDir, "publish", entry.name))
      .sort();
  } catch {
    return [];
  }
};

/** JSONL 非空行计数（行数事实面——doc_slots 投影与消息预计行数共用）；缺失/不可读＝null。 */
export const countJsonlRows = (path: string): number | null => {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").length;
  } catch {
    return null;
  }
};

// ── E8b：已登记单据清单读侧（run.json docs[] 单源；镜像内核 run_doc_registry 语义）──

/** 已登记单据条目（内核 register 段 append_run_doc 写入形态——doc_type 之外键原样保留）。 */
export interface RunDocEntry {
  doc_type: string;
  [key: string]: unknown;
}

/** 已登记单据清单读侧结果。
 *  - ok：清单可得（run_json_docs＝b13+ canonical 权威面；legacy_dir_probe＝目录探测兜底）；
 *  - docs_invalid：run.json 带 docs 键但形态非法——清单不可信（fail-closed，不降级为目录
 *    探测：身份文件声称有清单却不可读，静默改用探测会让「登记清单」失去单源意义）。 */
export type RunDocRegistryResult =
  | { status: "ok"; source: "run_json_docs" | "legacy_dir_probe"; docs: RunDocEntry[] }
  | { status: "docs_invalid" };

/** run 根 register 段摘要文件名模式（legacy 目录探测证据——内核布局检查 docs[] 一致性同式）。 */
const STAGE_REGISTER_SUMMARY_RE = /^stage-register\.(.+)\.summary\.json$/;

/**
 * 读 run 的已登记单据清单（E8b·内核 b13 run.json docs[] 读侧单源；消费「已登记清单」
 * 一律经本函数，禁止各写目录探测猜清单）。与「已备数据槽位」（listDocSlots）语义不同：
 * docs[]＝登记事实（register 段写入），槽位＝数据事实（data-prep 段产物）——两者由
 * 消费方比对（不一致即拒），本模块不合并。
 * - run.json 在场且带合法 docs[] → source=run_json_docs（按 doc_type 排序，逐项浅拷贝）；
 * - run.json 缺席或无 docs 键（b13 前 canonical／legacy run）→ 目录探测（run 根
 *   stage-register.\<doc\>.summary.json 集合）标 legacy_dir_probe；
 * - docs 键形态非法（非列表／条目缺非空 doc_type）→ docs_invalid。
 */
export const runDocRegistry = (runDir: string): RunDocRegistryResult => {
  let document: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    document = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    document = null; // run.json 缺席/不可解析 → 目录探测（legacy）
  }
  if (document === null || !("docs" in document)) {
    // legacy 探测：register 段摘要文件名集合（登记证据，与槽位枚举的判据区分）。
    try {
      const names = readdirSync(runDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && STAGE_REGISTER_SUMMARY_RE.test(entry.name))
        .map((entry) => (STAGE_REGISTER_SUMMARY_RE.exec(entry.name) ?? [])[1] ?? "")
        .filter((name) => name !== "")
        .sort();
      return { status: "ok", source: "legacy_dir_probe", docs: names.map((docType) => ({ doc_type: docType })) };
    } catch {
      return { status: "ok", source: "legacy_dir_probe", docs: [] };
    }
  }
  const docs = document["docs"];
  if (!Array.isArray(docs) || !docs.every(
    (item) => typeof item === "object" && item !== null && !Array.isArray(item)
      && typeof (item as Record<string, unknown>)["doc_type"] === "string"
      && ((item as Record<string, unknown>)["doc_type"] as string).trim() !== "",
  )) {
    return { status: "docs_invalid" };
  }
  const entries = (docs as Array<Record<string, unknown>>)
    .map((item) => ({ ...item }) as RunDocEntry)
    .sort((a, b) => (a.doc_type < b.doc_type ? -1 : a.doc_type > b.doc_type ? 1 : 0));
  return { status: "ok", source: "run_json_docs", docs: entries };
};
