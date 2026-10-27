/**
 * RunLayout/v3 run 内目录面（叶子模块——零 workspace 依赖，供 runLayout 与各读/写面共用，
 * 避免 runLayout ↔ segmentFacts 的循环 import）。
 *
 * 与内核 `src/agentic_training_flow/run_layout.py` 同值同序：
 *   RUN_LAYOUT_VERSION = "RunLayout/v3"
 *   RUN_LAYOUT_V3      = 冻结骨架（顶层 9 类，子目录由前缀自带）
 *   V2_TO_V3_DIR_MAP   = v2 → v3 目录映射（webui→runtime/webui、prep→data、
 *                        experiment-setup→config/experiment-setup、loop→runtime/loop）
 *
 * 解析契约（读写同源，防同一 run 产物被劈成两处）：
 *   - 候选链 v3 名在前、v2 存量名在后；
 *   - 单源落点＝首个在场候选；两缺＝按该 run 的 run.json `layout_version` 决定落名
 *     （内核口径：目录身份单源＝run.json，不按目录名猜）——v3 树落 v3 名，
 *     无 manifest／v1／v2 树落 v2 名（与它自己声明的 dirs 一致，不制造未声明目录）；
 *   - 存量 v2 只读兼容：不改名、不迁移、不补建（ADR-0016/ADR-0018）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 布局契约版本标识（run.json 的 layout_version 单源——与内核 RUN_LAYOUT_VERSION 同值）。 */
export const RUN_LAYOUT_VERSION = "RunLayout/v3";

/** RunLayout/v3 冻结骨架（顶层 9 类，按作用分类；子目录由前缀自带）。 */
export const RUN_LAYOUT_V3: readonly string[] = [
  "config",
  "config/iteration-config",
  "config/experiment-setup",
  "config/bootstrap",
  "data",
  "data/variants",
  "data/l1",
  "data/risk-signals",
  "stage",
  "launch",
  "training",
  "eval",
  "analysis",
  "analysis/decisions",
  "analysis/journal",
  "analysis/verification",
  "publish",
  "publish/models",
  "runtime",
  "runtime/webui",
  "runtime/loop",
];

/** v2 → v3 run 内目录映射（存量只读场景下按此定位同一份产物；不改写存量磁盘）。 */
export const V2_TO_V3_DIR_MAP: Readonly<Record<string, string>> = {
  webui: "runtime/webui",
  loop: "runtime/loop",
  prep: "data",
  "prep/iteration-config": "config/iteration-config",
  "prep/variants": "data/variants",
  "prep/l1": "data/l1",
  "prep/risk-signals": "data/risk-signals",
  "experiment-setup": "config/experiment-setup",
  bootstrap: "config/bootstrap",
};

/** run 内相对路径 → v3 名（最长前缀命中 V2_TO_V3_DIR_MAP；未登记＝原样）。 */
export const runRelPathV3 = (v2Rel: string): string => {
  const segments = v2Rel.split("/").filter((segment) => segment !== "");
  // i 从「全长」起：单段路径（如 webui／prep／loop）本身即目录名，i=1 命中映射；
  // 多段路径取最长命中前缀（prep/iteration-config/x.json → 先试全路径，再逐级缩短）
  for (let i = segments.length; i >= 1; i -= 1) {
    const mapped = V2_TO_V3_DIR_MAP[segments.slice(0, i).join("/")];
    if (mapped !== undefined) return [mapped, ...segments.slice(i)].join("/");
  }
  return v2Rel;
};

/** run 自身声明的布局版本（run.json 的 layout_version 单源——"目录身份不由目录名猜"）。
 *  run.json 缺席/坏行/无该键＝null（legacy 无 manifest 的 run）。只读、fail-open。 */
export const runLayoutVersionOf = (runDir: string): string | null => {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as { layout_version?: unknown };
    return typeof parsed?.layout_version === "string" ? parsed.layout_version : null;
  } catch {
    return null;
  }
};

/** 该 run 是否 v3 契约树（run.json 明示 RunLayout/v3；无 manifest／v1／v2 一律不是）。
 *  写面用它决定「新建产物该落哪套名」——存量 v2 树保持 v2 名，不制造与自身 run.json
 *  dirs 声明不符的目录（skills 侧 check_run_layout 的 layout_undeclared_dir 是失败级）。
 *  fail-open 语义：**读不到 run.json（缺席／坏行／不可读）一律按「非 v3」处理**——即回退
 *  到 v2 名、也就是「不认识的 run 不动它」；宁可沿用旧名，也不给来路不明的树添新目录。 */
export const isV3RunTree = (runDir: string): boolean => runLayoutVersionOf(runDir) === RUN_LAYOUT_VERSION;

/** run 内子目录候选链（v3 名在前、v2 存量名在后——顺序即优先级，只读扫描用）。 */
export const runSubdirCandidates = (runDir: string, v2Rel: string): string[] => {
  const v3Rel = runRelPathV3(v2Rel);
  return v3Rel === v2Rel ? [join(runDir, v2Rel)] : [join(runDir, v3Rel), join(runDir, v2Rel)];
};

/** run 内子目录落点（**写侧单源**）：
 *   - run.json 明示 RunLayout/v3 → **落名恒取 v3 名**，不因 v2 名目录「恰好存在」而改道。
 *     理由：写侧只认该 run 自己声明的闭集；v3 树里若残留 v2 名目录（webui/ 之类），
 *     写进去就是未声明目录（审计失败级），所以「存在优先」在写侧是错的。
 *   - 非 v3（v2／v1／无 manifest／读不到 run.json）→ 沿用 v2 名：存量树不迁移、不改名，
 *     两代产物不劈成两处。
 *  读侧需要回退请用 runSubdirCandidates（v3 名先行、v2 名回退）。 */
export const resolveRunSubdir = (runDir: string, v2Rel: string): string => {
  const v3Rel = runRelPathV3(v2Rel);
  if (v3Rel === v2Rel || !isV3RunTree(runDir)) return join(runDir, v2Rel);
  return join(runDir, v3Rel);
};

/** run 内文件候选链（v3 映射形态在前、v2 存量形态在后——只读探测用）。 */
export const runFileCandidates = (runDir: string, v2Rel: string): string[] => {
  const v3Rel = runRelPathV3(v2Rel);
  return v3Rel === v2Rel ? [join(runDir, v2Rel)] : [join(runDir, v3Rel), join(runDir, v2Rel)];
};

/** run 内文件落点（与 resolveRunSubdir 同口径的**写侧单源**）：v3 树 → 恒取 v3 形态；
 *  非 v3（含读不到 run.json）→ 沿用 v2 形态。读侧探测用 runFileCandidates。 */
export const resolveRunFile = (runDir: string, v2Rel: string): string => {
  const v3Rel = runRelPathV3(v2Rel);
  if (v3Rel === v2Rel || !isV3RunTree(runDir)) return join(runDir, v2Rel);
  return join(runDir, v3Rel);
};

