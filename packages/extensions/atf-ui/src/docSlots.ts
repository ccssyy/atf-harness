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
