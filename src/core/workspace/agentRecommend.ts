/**
 * 批㊶-Q 段2（v3 重设计）——agent 参数推荐层护栏（确定性；参数判断属 agent 能力域）。
 *
 * 分工（owner 裁定 3 v3）：难度/参数判断由宿主大模型（agent）承担——经验锚点知识化进工具
 * 描述面，agent 基于任务描述＋数据集统计＋经验锚点给出推荐值＋理由；harness 只做确定性护栏：
 * 逐键校验越界即拦截（不做判断、不静默修正），被拦截键回退现行固定建议。全在内核
 * param_sources.py 既有文法内（default:<依据>），闭集零扩展。
 *
 * 回退语义（红线·不猜不编造）：推荐缺失该键 / 值不可解析 / 越界 → 终值取基线建议
 * （iteration-config L3 clamp 值＞固定缺省），来源 default:harness-smart-defaults，拦截事实进通报。
 */
import { CONFIG_CONFIRM_KEYS } from "../../webui/configConfirm.js";
import { CLAMP_DOMAINS } from "./smartDefaults.js";

/** 推荐护栏可消费的键集（九要素卡键集为闭集——卡外键一律拒收）。 */
export const RECOMMENDABLE_KEYS: ReadonlySet<string> = new Set(CONFIG_CONFIRM_KEYS.map((entry) => entry.key));

export interface RecommendVerdict {
  key: string;
  /** true＝采纳推荐值（terminal=推荐值原样，域内不 clamp）；false＝拦截回退（terminal=基线建议）。 */
  accepted: boolean;
  terminal: string;
  /** 来源串（内核 param_sources 文法内）。 */
  source: string;
  /** 人类可读判定说明（进通报；采纳＝理由摘录，拦截＝越界/缺失事实）。 */
  note: string;
}

/** 理由 → 简据（来源串后缀：去空白合并、截 24 字符；缺理由如实「未附理由」）。 */
export const briefOf = (reason: string | undefined): string => {
  const text = (reason ?? "").replace(/\s+/g, "").slice(0, 24);
  return text !== "" ? text : "未附理由";
};

const num = (raw: unknown): number | null => {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** 单键推荐判定（纯函数）：域内原样采纳（不做判断）；越界/不可解析/未知键拦截回退基线。 */
export const evalAgentRecommend = (key: string, raw: unknown, baseline: string, reason?: string): RecommendVerdict => {
  if (!RECOMMENDABLE_KEYS.has(key)) {
    return { key, accepted: false, terminal: baseline, source: "default:harness-smart-defaults", note: `推荐键 ${key} 不在九要素卡键集——拦截` };
  }
  if (raw === undefined || raw === null || raw === "") {
    return { key, accepted: false, terminal: baseline, source: "default:harness-smart-defaults", note: "推荐缺失该键——回退固定建议" };
  }
  // alpha 随 rank 联动（2×rank）——显式推荐 alpha 一律拦截（确定性联动，不做判断）
  if (key === "lora_alpha") {
    return { key, accepted: false, terminal: baseline, source: "default:harness-smart-defaults", note: "lora_alpha 随 rank 联动（alpha=2×rank）——不单独采纳推荐" };
  }
  const reject = (why: string): RecommendVerdict =>
    ({ key, accepted: false, terminal: baseline, source: "default:harness-smart-defaults", note: `推荐 ${String(raw)} 越界被拒（${why}）——回退固定建议 ${baseline}` });
  switch (key) {
    case "per_device_train_batch_size": {
      const value = num(raw);
      if (value === null || !Number.isInteger(value) || value <= 0) return reject("须为正整数");
      break;
    }
    case "learning_rate": {
      const value = num(raw);
      if (value === null) return reject("不可解析为数值");
      if (value < CLAMP_DOMAINS.lr.min || value > CLAMP_DOMAINS.lr.max) return reject(`lr 域 [5e-5, 5e-4]`);
      break;
    }
    case "num_train_epochs": {
      const value = num(raw);
      if (value === null || !Number.isInteger(value)) return reject("须为整数");
      if (value < CLAMP_DOMAINS.epochs.min || value > CLAMP_DOMAINS.epochs.max) return reject(`epochs 域 [1, 10]`);
      break;
    }
    case "lora_rank": {
      const value = num(raw);
      if (value === null) return reject("不可解析为数值");
      if (!(CLAMP_DOMAINS.lora_rank as number[]).includes(value)) return reject(`rank 档位 {16, 32, 64, 128}`);
      break;
    }
    case "cutoff_len": {
      const value = num(raw);
      if (value === null || !Number.isInteger(value)) return reject("须为整数");
      if (value < 1 || value > CLAMP_DOMAINS.cutoff_len.max) return reject(`cutoff ≤ ${CLAMP_DOMAINS.cutoff_len.max}`);
      break;
    }
    case "image_max_pixels": {
      const value = num(raw);
      if (value === null) return reject("不可解析为数值");
      if (!(CLAMP_DOMAINS.image_max_pixels as number[]).includes(value)) return reject(`像素两档 {800000, 1600000}`);
      break;
    }
    default:
      break;
  }
  const terminal = String(typeof raw === "string" ? raw.trim() : raw);
  return { key, accepted: true, terminal, source: `default:agent-recommend:${briefOf(reason)}`, note: `agent 推荐 ${terminal}${reason !== undefined && reason.trim() !== "" ? `（${reason.replace(/\s+/g, " ").slice(0, 60)}）` : ""}` };
};
