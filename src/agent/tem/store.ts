/**
 * 门 1b（批 P）——TEM 层二/三/四：ExperienceCase（Value 寻址）／PatternClaim（ValueList
 * 寻址）／Mechanism 检索缝（faux，embedding 后置）。
 *
 * 设计依据：《ATF-Harness_门1b设计_TEM到pi存储映射_20260924.md》§一映射总表。
 * 纪律（TEM 接入设计）：单一对象模型（字段集为丙线投影，冲突以 TEM 侧为准）；
 * 同 run 单一写入者（Case 以 run_id 覆盖写＝run_ref 去重）；提炼层人工触发（Claim 只落
 * 读写 API，丙 v1 不自动提炼）。
 */
import { value as valueAddress, list as listAddress, type Session } from "@earendil-works/pi-agent-core";
import { ensureMainBranch, type SessionLike } from "../sessionMirror.js";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/pi-agent-core";
import type { EvidenceEvent } from "./evidence.js";

const context: Context = BACKGROUND_CONTEXT;

// ---------------------------------------------------------------- ExperienceCase（Value）

/** ExperienceCase（丙线投影 v1：证据集合＋结局＋成本＋环境指纹；结局七态词汇随丙 v1
 *  收口批对齐 runner，本批先落 pending 形态）。 */
export interface ExperienceCase {
  kind: "experience_case";
  case_id: string;
  run_id: string;
  closed_at: string;
  outcome: "pending" | string; // 七态闭集归丙 v1 收口批（设计文档 §五）
  evidence_event_ids: string[];
  cost: { model_calls: number }; // usage 计量随真实 provider 接线扩展（faux 期调用计数）
  env_fingerprint: EvidenceEvent["env_fingerprint"];
}

const caseAddress = (runId: string) => valueAddress<ExperienceCase>("tem.case", runId);

/** run 收尾写闸：ExperienceCase 落库（Value 标量寻址，同 run 覆盖＝run_ref 去重）。 */
export const writeExperienceCase = async (session: SessionLike, cas: ExperienceCase): Promise<void> => {
  await (session as Session).setValue(caseAddress(cas.run_id), cas as never, context);
};

/** 读 Case（同 run 去重键直查；无 = undefined）。 */
export const readExperienceCase = async (session: SessionLike, runId: string): Promise<ExperienceCase | undefined> => {
  const stored = await (session as Session).getValue(caseAddress(runId), context);
  return stored?.value as ExperienceCase | undefined;
};

// ---------------------------------------------------------------- PatternClaim（ValueList）

/** PatternClaim（丙线投影 v1：人工提炼产物；valid_until/审批闸/来源引用纪律保留）。 */
export interface PatternClaim {
  kind: "pattern_claim";
  claim_id: string;
  claim: string;
  lane?: string; // 检索键：lane/when.lane（结构化过滤通道；PoC 关键词期并入查询词元）
  structural_preconditions?: string[]; // 不折叠类（注入时打标）
  valid_until?: string;
  source_refs: string[]; // EvidenceEvent event_id / Case case_id 可追溯引用
}

const claimListAddress = () => listAddress<PatternClaim>("tem.claim");

/** 追加 PatternClaim（人工提炼写入面）。 */
export const appendPatternClaim = async (session: SessionLike, claim: PatternClaim): Promise<void> => {
  await (session as Session).appendList(claimListAddress(), claim as never, context);
};

/** 读全部 PatternClaim（升序；读取失败 = 空集——无记忆运行）。 */
export const readPatternClaims = async (session: SessionLike): Promise<PatternClaim[]> => {
  try {
    const elements = await (session as Session).readList(claimListAddress(), { order: "asc" }, context);
    return elements
      .map((element) => element.value as PatternClaim)
      .filter((claim) => typeof claim === "object" && claim !== null && claim.kind === "pattern_claim");
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------- Mechanism 检索缝（faux）

export interface MechanismQuery {
  terms: string[];
  gate?: string;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * Mechanism 查询单点（换装位）：PoC = 关键词 faux 评分（结构化过滤 lane/structural_
 * preconditions 并入词元匹配）；embedding 激活 = 本单点换装 bge-m3:9033 HTTP 客户端
 * （另批授权＋凭据 env-only；本批零真实调用——红线）。
 */
export const queryMechanisms = async (session: SessionLike, query: MechanismQuery): Promise<Scored<PatternClaim>[]> => {
  const claims = await readPatternClaims(session);
  const scored: Scored<PatternClaim>[] = [];
  for (const claim of claims) {
    if (!isValidUntilLive(claim)) continue; // valid_until 过期不入检索（失效纪律）
    const text = [claim.claim, claim.lane ?? "", ...(claim.structural_preconditions ?? [])].join(" ").toLowerCase();
    const score = query.terms.filter((term) => term !== "" && text.includes(term.toLowerCase())).length;
    if (score > 0) scored.push({ item: claim, score });
  }
  return scored.sort((a, b) => b.score - a.score);
};

const isValidUntilLive = (claim: PatternClaim): boolean => {
  if (claim.valid_until === undefined) return true;
  const until = Date.parse(claim.valid_until);
  return Number.isNaN(until) ? true : until > Date.now();
};

/** TEM 面共用：主分支确保（镜像/存储首写前；lane 配置随首次调用就位）。 */
export const ensureTemBranch = async (session: SessionLike): Promise<void> => {
  await ensureMainBranch(session as Session);
};
