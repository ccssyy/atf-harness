/**
 * F1（首跑体验批）——训练链入口预检共享面：内核 training_preflight.py 输出的
 * 固定 schema 校验＋三态清单渲染＋首跑 KPI 事实。run 目录本地文件，不进 bridge
 * 契约面（预检不是新段——内核 STAGE_ORDER 八段闭集不动）。
 *
 * - schema 单源＝owner 指令《ATF_指令_首跑体验F1_预检单卡_20261024》§一.1（固定，
 *   harness 消费）：{generated_at, items:[{id,state,detail,action,depends_on[]}],
 *   order:[id...], summary:{missing,derivable,confirm}}。内核脚本落地前按本 schema
 *   先开发（先对 schema 后集成）；输出不符即结构化拒绝（fail-closed，不猜不修）。
 *   E3（缺口 C）修订：order 对账放宽为 order ⊇ items.id——内核 order 恒为依赖链
 *   全量、items 只含问题项（就绪项不进 items，b7 实锚 order 7／items 5）；order 内
 *   出现闭集（PREFLIGHT_KNOWN_ITEM_IDS）外未知项或重复项仍拒。
 * - 三态（§〇.3）：missing＝环境/用户必须提供；derivable＝可自动执行（给动作与
 *   数量）；needs_confirm＝业务确认（合并一次问）。渲染按依赖链顺序（order），
 *   不按八段顺序暴露；derivable 项的 depends_on 尚有问题项在场时如实标「待依赖」
 *   （不误报可立即派生——验收锚 §三）。
 * - KPI（§二.3）：preflight（首次预检成功时间）＋first_launch_at（首次放行时间）
 *   落 <runDir>/webui/launch-kpi.json，供 time-to-launch/人工介入次数统计。两键均
 *   首写固定（统计基线不随重跑漂移——预检可多次跑、放行只记第一次）；写失败静默
 *   （fail-open——KPI 缺失不阻塞预检/放行主流程）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRunSubdir } from "./runSubdirs.js";

// ── 固定 schema（内核输出消费面）──

/** 三态闭集（§〇.3——内核侧同源；第二态文案＝可自动执行给动作与数量）。 */
export const PREFLIGHT_ITEM_STATES: readonly string[] = ["missing", "derivable", "needs_confirm"];

/** 内核检查项闭集（E3 锚＝内核 b7 tools/training_preflight.py 的 PREFLIGHT_ORDER 七件
 *  依赖链全序——order 恒为此闭集的全序，items 只含其中问题项、就绪项不进 items）。
 *  对账用它拒「order 内未知项」（错乱输出不采纳）；内核发版增检查项时随 re-pin
 *  同步本闭集（单点）。 */
export const PREFLIGHT_KNOWN_ITEM_IDS: readonly string[] = [
  "source_pairs",
  "field_config",
  "token_provider",
  "token_budget",
  "coordinate_pending",
  "lane_facts",
  "grouping_preset",
];

export interface PreflightItem {
  id: string;
  state: string;
  detail: string;
  action: string;
  depends_on: string[];
}

export interface PreflightSummary {
  missing: number;
  derivable: number;
  confirm: number;
}

/**
 * T5（内核 141a5dec 起）三节契约：预检从「只报缺」改为「会取数」——
 * `derivable[]` 能推的（默认生效并留痕）/ `must_ask[]` 该问的（业务话＋为什么推不出来）/
 * `degraded[]` 推不动的（断点与原因）。都是**可选**节：旧内核（无三节）报告照旧按
 * 三态清单渲染（向后兼容，不因缺节拒收）。
 */
export interface PreflightDerivable {
  id: string;
  /** 推导出来的值（null＝尚待执行）；展示面只呈现，不参与计算。 */
  value: string | null;
  /** 推导依据（注册/切分/统计/契约——四类依据，内核只给有依据的项）。 */
  basis: string;
  /** 是否已默认生效（false＝需 --apply 才生效）。 */
  effective: boolean;
  mode: string;
  detail: string;
  action: string;
}

export interface PreflightMustAsk {
  id: string;
  /** 业务话问句（内核已保证：禁参数名）。 */
  question: string;
  /** 为什么推不出来（业务话）。 */
  why_not_derivable: string;
  blocking: boolean;
  detail: string;
  action: string;
}

export interface PreflightDegraded {
  id: string;
  /** 断点（内核内部标识，仅供运维对账——用户面不呈现）。 */
  step: string;
  /** 断在哪一步/为什么（业务话）。 */
  reason: string;
  detail: string;
  action: string;
}

export interface PreflightReport {
  generated_at: string;
  items: PreflightItem[];
  order: string[];
  summary: PreflightSummary;
  /** 三节（可选）：在场即以三节渲染，缺席回落三态清单。 */
  derivable?: PreflightDerivable[];
  must_ask?: PreflightMustAsk[];
  degraded?: PreflightDegraded[];
  /** must_ask 超过软上限时的原因（内核原文，呈现前做业务化清洗）。 */
  must_ask_overflow_reason?: string;
}

export type PreflightParse =
  | { ok: true; report: PreflightReport }
  | { ok: false; error: string };

/** 预检报告解析（固定 schema 严格校验——fail-closed：键缺/类型错/态越闭集/
 *  order 与 items 不对账即拒，不给缺省不修形态）。 */
export const parsePreflightReport = (raw: string): PreflightParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "预检输出不是合法 JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "预检输出不是 JSON 对象" };
  }
  const root = parsed as Record<string, unknown>;
  if (typeof root["generated_at"] !== "string" || (root["generated_at"] as string) === "") {
    return { ok: false, error: "generated_at 缺失或非字符串" };
  }
  if (!Array.isArray(root["items"])) return { ok: false, error: "items 缺失或非数组" };
  const items: PreflightItem[] = [];
  const seen = new Set<string>();
  for (const entry of root["items"]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "items 含非对象条目" };
    }
    const item = entry as Record<string, unknown>;
    if (typeof item["id"] !== "string" || (item["id"] as string) === "") {
      return { ok: false, error: "item.id 缺失或非非空字符串" };
    }
    if (seen.has(item["id"] as string)) return { ok: false, error: `item.id 重复：${item["id"] as string}` };
    seen.add(item["id"] as string);
    if (typeof item["state"] !== "string" || !PREFLIGHT_ITEM_STATES.includes(item["state"] as string)) {
      return { ok: false, error: `item.state 越三态闭集：${String(item["state"])}` };
    }
    if (typeof item["detail"] !== "string") return { ok: false, error: `item.detail 非字符串：${item["id"] as string}` };
    if (typeof item["action"] !== "string") return { ok: false, error: `item.action 非字符串：${item["id"] as string}` };
    if (!Array.isArray(item["depends_on"]) || !(item["depends_on"] as unknown[]).every((d) => typeof d === "string")) {
      return { ok: false, error: `item.depends_on 非字符串数组：${item["id"] as string}` };
    }
    items.push({
      id: item["id"] as string,
      state: item["state"] as string,
      detail: item["detail"] as string,
      action: item["action"] as string,
      depends_on: item["depends_on"] as string[],
    });
  }
  if (!Array.isArray(root["order"]) || !(root["order"] as unknown[]).every((o) => typeof o === "string")) {
    return { ok: false, error: "order 缺失或非字符串数组" };
  }
  const order = root["order"] as string[];
  // E3（缺口 C 修复）：order 与 items 对账放宽为 order ⊇ items.id——内核 b7 实锚
  // （dev 直跑 u1-accept-swb：exit 1＋stdout 完整 JSON＋stderr 空）order 恒为依赖链
  // 全量七件，items 只含问题项（就绪项不进 items）→ order 允许比 items 长；渲染按
  // order 序过滤 items（就绪项零呈现）。仍拒两形态（fail-closed 不猜不修）：
  //   ① items 含 order 外的项（问题项不在依赖序——渲染序错乱）；
  //   ② order 出现未知项/重复项（不在内核检查项闭集 PREFLIGHT_KNOWN_ITEM_IDS，
  //      或同 id 重复——错乱输出不采纳；内核发版增检查项须随 re-pin 同步闭集）。
  if (new Set(order).size !== order.length) {
    return { ok: false, error: "order 含重复检查项" };
  }
  const unknownInOrder = order.filter((id) => !PREFLIGHT_KNOWN_ITEM_IDS.includes(id));
  if (unknownInOrder.length > 0) {
    return { ok: false, error: `order 含未知检查项：${[...new Set(unknownInOrder)].join("、")}` };
  }
  const ordered = new Set(order);
  if (![...seen].every((id) => ordered.has(id))) {
    return { ok: false, error: "order 与 items.id 不对账（items 含 order 外的项）" };
  }
  const summaryRaw = root["summary"];
  if (summaryRaw === null || typeof summaryRaw !== "object" || Array.isArray(summaryRaw)) {
    return { ok: false, error: "summary 缺失或非对象" };
  }
  const summary = summaryRaw as Record<string, unknown>;
  for (const key of ["missing", "derivable", "confirm"] as const) {
    if (typeof summary[key] !== "number" || !Number.isFinite(summary[key] as number) || (summary[key] as number) < 0) {
      return { ok: false, error: `summary.${key} 缺失或非非负数` };
    }
  }
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const optionalList = (key: string): unknown[] | undefined => {
    const raw = root[key];
    return Array.isArray(raw) ? raw : undefined;
  };
  const derivable = optionalList("derivable")?.flatMap((entry): PreflightDerivable[] => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const id = str(row["id"]);
    if (id === "") return [];
    const value = row["value"];
    return [{
      id,
      value: typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null,
      basis: str(row["basis"]),
      effective: row["effective"] === true,
      mode: str(row["mode"]),
      detail: str(row["detail"]),
      action: str(row["action"]),
    }];
  });
  const mustAsk = optionalList("must_ask")?.flatMap((entry): PreflightMustAsk[] => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const id = str(row["id"]);
    if (id === "") return [];
    return [{
      id,
      question: str(row["question"]),
      why_not_derivable: str(row["why_not_derivable"]),
      blocking: row["blocking"] !== false,
      detail: str(row["detail"]),
      action: str(row["action"]),
    }];
  });
  const degraded = optionalList("degraded")?.flatMap((entry): PreflightDegraded[] => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const id = str(row["id"]);
    if (id === "") return [];
    return [{
      id,
      step: str(row["step"]),
      reason: str(row["reason"]),
      detail: str(row["detail"]),
      action: str(row["action"]),
    }];
  });
  return {
    ok: true,
    report: {
      generated_at: root["generated_at"] as string,
      items,
      order,
      summary: { missing: summary["missing"] as number, derivable: summary["derivable"] as number, confirm: summary["confirm"] as number },
      ...(derivable === undefined ? {} : { derivable }),
      ...(mustAsk === undefined ? {} : { must_ask: mustAsk }),
      ...(degraded === undefined ? {} : { degraded }),
      ...(typeof root["must_ask_overflow_reason"] === "string" ? { must_ask_overflow_reason: root["must_ask_overflow_reason"] as string } : {}),
    },
  };
};

// ── 三态清单渲染（依赖链顺序）──

/** 依赖就绪判定：derivable 项的 depends_on 指向的 id 仍在本报告 items 里
 *  （＝该项自身还有问题未清）即未就绪——「待依赖」标注单源（不误报可立即派生）。 */
export const dependencyBlockersOf = (item: PreflightItem, report: PreflightReport): string[] => {
  const ids = new Set(report.items.map((entry) => entry.id));
  return item.depends_on.filter((id) => ids.has(id));
};

const STATE_HEAD: Record<string, string> = {
  missing: "missing——环境/用户必须提供",
  derivable: "derivable——可自动执行",
  needs_confirm: "needs_confirm——业务确认",
};

/** 三态清单文本（组间按 missing→derivable→needs_confirm；组内按依赖链 order 序；
 *  每项含 detail/action/待依赖标注；尾行 summary 对账——供预检卡 detail 与工具
 *  返回共用单源）。 */
export const renderPreflightChecklist = (report: PreflightReport): string => {
  const byOrder = (a: PreflightItem, b: PreflightItem): number => {
    const ia = report.order.indexOf(a.id);
    const ib = report.order.indexOf(b.id);
    return (ia < 0 ? report.items.length : ia) - (ib < 0 ? report.items.length : ib);
  };
  const lines: string[] = [];
  let serial = 0;
  for (const state of PREFLIGHT_ITEM_STATES) {
    const group = report.items.filter((item) => item.state === state).sort(byOrder);
    if (group.length === 0) continue;
    lines.push(`【${STATE_HEAD[state] as string}（${String(group.length)}）】`);
    for (const item of group) {
      serial += 1;
      const blocked = state === "derivable" ? dependencyBlockersOf(item, report) : [];
      lines.push(`  ${String(serial)}. ${item.id}：${item.detail}`);
      if (item.action !== "") lines.push(`     动作：${item.action}`);
      if (blocked.length > 0) lines.push(`     （待依赖：${blocked.join("、")} 未就绪——先清依赖项再派生）`);
    }
  }
  const total = report.items.length;
  lines.push(
    total === 0
      ? "预检全绿——八段链当前无待办（各段既有校验仍在场，预检不替代段内校验）。"
      : `共 ${String(total)} 项待处理：missing ${String(report.summary.missing)}／derivable ${String(report.summary.derivable)}／needs_confirm ${String(report.summary.confirm)}（按依赖链顺序逐项清；预检不替代各段既有校验）。`,
  );
  return lines.join("\n");
};

// ── T5 三节卡面（能推的／该问的／推不动的）──────────────────────────────────

/** must_ask 软上限（与内核 MUST_ASK_SOFT_LIMIT 同值——只用于呈现判断，不参与拒绝）。 */
export const PREFLIGHT_MUST_ASK_SOFT_LIMIT = 3;

/** 内核 overflow 原因的业务化清洗：去掉「must_ask=N 超过软上限 M:」这类内部前缀，
 *  只留业务解释（权威原文仍在报告里，这里是用户面）。 */
export const businessOverflowReason = (raw: string | undefined): string => {
  const text = (raw ?? "").trim();
  if (text === "") return "";
  return text
    .replace(/^must_ask\s*=\s*\d+[^:：]*[:：]\s*/, "")
    .replace(/[（(]\s*R\d+[^）)]*[）)]/g, "")
    .trim();
};

/** 派生项的「值」呈现（null＝待执行；不造占位）。 */
export const derivableValueText = (entry: PreflightDerivable): string =>
  entry.value === null || entry.value === "" ? "待执行" : entry.value;

/** 推不动的项的业务标签：优先用内核给的业务 detail；detail 空时如实说明形态，
 *  不把内部断点（step）搬到用户面。 */
export const degradedLabelOf = (entry: PreflightDegraded): string => {
  const detail = entry.detail.trim();
  if (detail !== "") return detail.length > 140 ? `${detail.slice(0, 140)}…` : detail;
  return "有一项本来能自动推导、但推导链断了";
};

/**
 * 预检卡面（T5 单源）：三节在场即按「该问的／能推的／推不动的」渲染，否则回落三态清单
 * （旧内核兼容）。呈现纪律：问句与理由**一律用内核给的业务话**，不出现参数名/内部键名；
 * 派生项折成一行（不逐项占主视线），逐项值与依据降为缩进展开；推不动的项显式列出并给原因。
 * @param report 已解析的预检报告。
 * @returns 卡面文本（多行）。
 */
export const renderPreflightFace = (report: PreflightReport): string => {
  const mustAsk = report.must_ask;
  const derivable = report.derivable;
  const degraded = report.degraded;
  if (mustAsk === undefined && derivable === undefined && degraded === undefined) {
    return renderPreflightChecklist(report);
  }
  const asks = mustAsk ?? [];
  const derived = derivable ?? [];
  const degradedRows = degraded ?? [];
  const lines: string[] = [];
  // 软上限提示（>3 才出；原因取内核，清洗掉内部键名）
  if (asks.length > PREFLIGHT_MUST_ASK_SOFT_LIMIT) {
    const why = businessOverflowReason(report.must_ask_overflow_reason);
    lines.push(`这次需要你确认的项偏多（${String(asks.length)} 项）${why === "" ? "。" : `：${why}`}`);
    lines.push("");
  }
  if (asks.length > 0) {
    lines.push(`【需要你确认的（${String(asks.length)}）】`);
    asks.forEach((entry, index) => {
      lines.push(`  ${String(index + 1)}. ${entry.question}`);
      lines.push(`     为什么推不出来：${entry.why_not_derivable}`);
    });
  }
  if (derived.length > 0) {
    const pending = derived.filter((entry) => !entry.effective).length;
    const settled = derived.length - pending;
    const modeNote = pending === 0
      ? "已全部默认生效"
      : settled === 0 ? `${String(pending)} 项待执行` : `${String(settled)} 项默认生效、${String(pending)} 项待执行`;
    lines.push(`【已按数据自动带入（${String(derived.length)}）】已按数据自动带入 ${String(derived.length)} 项（${modeNote}）——展开核对：`);
    for (const entry of derived) {
      lines.push(`     · ${derivableValueText(entry)} —— 依据：${entry.basis === "" ? "数据本身" : entry.basis}`);
    }
  }
  if (degradedRows.length > 0) {
    lines.push(`【本来能自动推、但推不出来的（${String(degradedRows.length)}）】`);
    degradedRows.forEach((entry, index) => {
      lines.push(`  ${String(index + 1)}. ${degradedLabelOf(entry)}`);
      lines.push(`     原因：${entry.reason === "" ? "推导链断了（内核未给出更细原因）" : entry.reason}`);
    });
  }
  if (asks.length === 0 && degradedRows.length === 0) {
    lines.push(derived.length > 0 ? "除上面自动带入的项之外，预检没有需要你回答的问题。" : "预检全绿——八段链当前无待办（各段既有校验仍在场，预检不替代段内校验）。");
  }
  lines.push("（预检不替代各段既有校验；确认项一次问完，不逐项弹。）");
  return lines.join("\n");
};

// ── 首跑 KPI 事实（launch-kpi.json）──

export interface LaunchKpi {
  /** 首次预检成功时间（首写固定——重跑不覆盖，time-to-launch 基线不漂移）。 */
  preflight?: string;
  /** 首次放行时间（atf_launch_execute 启动成功；首写固定）。 */
  first_launch_at?: string;
}

export const launchKpiPathOf = (runDir: string): string => join(resolveRunSubdir(runDir, "webui"), "launch-kpi.json");

export const readLaunchKpi = (runDir: string): LaunchKpi | null => {
  const path = launchKpiPathOf(runDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LaunchKpi;
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeLaunchKpi = (runDir: string, kpi: LaunchKpi): boolean => {
  try {
    const dir = resolveRunSubdir(runDir, "webui");
    mkdirSync(dir, { recursive: true });
    const target = launchKpiPathOf(runDir);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(kpi, null, 1)}\n`, "utf8");
    renameSync(tmp, target);
    return true;
  } catch {
    return false; // fail-open：KPI 写失败不阻塞主流程
  }
};

const recordKpiTimestamp = (runDir: string, key: "preflight" | "first_launch_at", nowIso: string): boolean => {
  const current = readLaunchKpi(runDir) ?? {};
  if (typeof current[key] === "string" && (current[key] as string) !== "") return true; // 首写固定：已在场不覆盖
  return writeLaunchKpi(runDir, { ...current, [key]: nowIso });
};

/** 预检 KPI：首次预检成功时间落盘（首写固定；失败静默）。 */
export const recordPreflightAt = (runDir: string, nowIso: string): boolean => recordKpiTimestamp(runDir, "preflight", nowIso);

/** 放行 KPI：首次放行时间落盘（首写固定；失败静默）。 */
export const recordFirstLaunchAt = (runDir: string, nowIso: string): boolean => recordKpiTimestamp(runDir, "first_launch_at", nowIso);
