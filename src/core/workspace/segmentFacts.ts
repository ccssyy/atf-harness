/**
 * 批㊶-M M-3——段事实轨（run 目录 `webui/segments.json`）。
 *
 * 形态：append 式数组 `[{segment, at, source}]`（segment＝八段键；source＝登记来源
 * 工具名）。写者＝atf-tools 各段工具执行成功后追加（appendSegmentFact）；读者＝
 * 同步器 scanRunDir——有记录的段直接 done，启发式文件锚降级为兜底（monitor.json
 * 输出形状不变，schema 零 bump）。
 *
 * 挂点核实结论（段↔工具，本批实装；D96 键名对齐内核段名后更新）：register←atf_admit_data；
 * label_qc←atf_label_qc_inspect；experiment_setup←atf_config_confirm；publish←atf_publish_confirm；
 * training_prep←atf_pipeline_stage（内核段触发）；training←atf_run_training
 * （启动确认即记「训练已放行启动」事实（完成语义另由 D50 training/completion.json 承载——
 * status ok 时本轨幂等复核登记，status failed 不登记不伪装完成））；evaluate←atf_evaluate
 * （编排启动即记，轮产物锚仍兜底）——training/evaluate 两键 D96 起不占段灯（独立卡/区块事实）。
 * 缺口如实登记（沿旧）：family_split（切分发生在走查管线/别 workspace，run 内无锚无工具，
 * 家族切分段摘要在场时经映射表兜底）与 admission（train.sh DRY_RUN 过＝生成期自检，无独立
 * 工具挂点）——两段沿锚兼容兜底。历史 run 的老键事实（experiment_config/split/candidate）
 * 不被新灯面读取，段证据由启发式文件锚兜底。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 段事实条目（append 队列形态）。 */
export interface SegmentFact {
  segment: string;
  at: string;
  source: string;
}

/** 内核段名 → UI 段键映射表（A2.2b 落常量；D3/D4 自 atf-tools pipelineFace 迁入本叶——
 *  单源禁第二套：pipelineFace re-export 同一常量，atf-ui 兜底源同表消费）。
 *  D96（owner 裁定 UI 段清单对齐内核）：映射恒等化——UI 段键名与内核 STAGE_ORDER 八段
 *  一一对应（register/label_qc/experiment_setup/candidate_build/publish/family_split/
 *  admission/training_prep），训练执行（training）与评估（evaluate）不再占段灯（作为
 *  独立卡/区块，其事实轨键保留不占灯）。历史老键（experiment_config/split/candidate）
 *  不在灯面——老 run 段证据由启发式文件锚兜底（三源 OR 语义不动）。 */
export const SEGMENT_FACT_BY_KERNEL_STAGE: Readonly<Record<string, string | null>> = {
  register: "register",
  label_qc: "label_qc",
  experiment_setup: "experiment_setup",
  candidate_build: "candidate_build",
  publish: "publish",
  family_split: "family_split",
  admission: "admission",
  training_prep: "training_prep",
};

/** 段事实文件路径（run 目录 webui/segments.json）。 */
export const segmentsFactPathOf = (runDir: string): string => join(runDir, "webui", "segments.json");

/** 读段事实（缺失/坏行如实空数组，不猜）。 */
export const readSegmentFacts = (runDir: string): SegmentFact[] => {
  const path = segmentsFactPathOf(runDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SegmentFact =>
        entry !== null && typeof entry === "object" &&
        typeof (entry as SegmentFact).segment === "string" &&
        typeof (entry as SegmentFact).at === "string" &&
        typeof (entry as SegmentFact).source === "string",
    );
  } catch {
    return [];
  }
};

/** 某段是否已有事实（done 判定源）。 */
export const hasSegmentFact = (runDir: string, segment: string): boolean =>
  readSegmentFacts(runDir).some((fact) => fact.segment === segment);

/** 追加一条段事实（幂等去重：同段同源已存在则不重复追加；目录自动创建）。 */
export const appendSegmentFact = (runDir: string, segment: string, source: string, at: string = new Date().toISOString()): void => {
  const facts = readSegmentFacts(runDir);
  if (facts.some((fact) => fact.segment === segment && fact.source === source)) return;
  facts.push({ segment, at, source });
  const dir = join(runDir, "webui");
  mkdirSync(dir, { recursive: true });
  writeFileSync(segmentsFactPathOf(runDir), `${JSON.stringify(facts, null, 1)}\n`, "utf8");
};

/** D3/D4——段兜底源②：内核段摘要扫描（`stage-<内核段>.summary.json`，内核直跑 CLI/
 *  walkthrough 的完成事实落点——非工具路径不写 webui/segments.json，摘要即唯一在盘事实）。
 *  采纳判据（沿 E10b 双对账）：顶层 `run_id`＝本 run ∧ `stage`＝文件名段名 ∧ `exit_code`=0；
 *  陈旧件/他 run 件/坏 JSON/拒绝态一律不采纳。映射经 SEGMENT_FACT_BY_KERNEL_STAGE 单源，
 *  null（不点灯）与非段序键（training_prep/candidate）如实分流。 */
export const stageSummarySegmentFacts = (runDir: string, runId: string): Set<string> => {
  const out = new Set<string>();
  for (const kernelStage of Object.keys(SEGMENT_FACT_BY_KERNEL_STAGE)) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(runDir, `stage-${kernelStage}.summary.json`), "utf8")) as unknown;
    } catch {
      continue; // 摘要缺席/坏 JSON＝该段无此源（不猜）
    }
    if (doc === null || typeof doc !== "object") continue;
    const row = doc as Record<string, unknown>;
    if (row["run_id"] !== runId || row["stage"] !== kernelStage) continue;
    if (row["exit_code"] !== 0) continue;
    const mapped = SEGMENT_FACT_BY_KERNEL_STAGE[kernelStage];
    if (typeof mapped === "string" && mapped !== "") out.add(mapped);
  }
  return out;
};
