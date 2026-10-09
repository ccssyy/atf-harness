/**
 * 批㊶-M M-3——段事实轨（run 目录 `webui/segments.json`）。
 *
 * 形态：append 式数组 `[{segment, at, source}]`（segment＝八段键；source＝登记来源
 * 工具名）。写者＝atf-tools 各段工具执行成功后追加（appendSegmentFact）；读者＝
 * 同步器 scanRunDir——有记录的段直接 done，启发式文件锚降级为兜底（monitor.json
 * 输出形状不变，schema 零 bump）。
 *
 * 挂点核实结论（段↔工具，本批实装）：register←atf_admit_data；label_qc←atf_label_qc_inspect；
 * experiment_config←atf_config_confirm；publish←atf_publish_confirm；training←atf_run_training
 * （start 放行成功即记「训练完成前置」的事实轨不适用——training 段完成语义沿 loss-series
 * 在场，启动事实以 source 区分）；evaluate←atf_evaluate（编排启动即记，轮产物锚仍兜底）。
 * 缺口如实登记（本批不造挂点）：split（切分发生在走查管线/别 workspace，run 内无锚无工具）
 * 与 admission（train.sh DRY_RUN 过＝生成期自检，无独立工具挂点）——两段沿锚兼容兜底。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 段事实条目（append 队列形态）。 */
export interface SegmentFact {
  segment: string;
  at: string;
  source: string;
}

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
