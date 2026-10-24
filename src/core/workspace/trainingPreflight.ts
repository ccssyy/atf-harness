/**
 * F1（首跑体验批）——训练链入口预检共享面：内核 training_preflight.py 输出的
 * 固定 schema 校验＋三态清单渲染＋首跑 KPI 事实。run 目录本地文件，不进 bridge
 * 契约面（预检不是新段——内核 STAGE_ORDER 八段闭集不动）。
 *
 * - schema 单源＝owner 指令《ATF_指令_首跑体验F1_预检单卡_20261024》§一.1（固定，
 *   harness 消费）：{generated_at, items:[{id,state,detail,action,depends_on[]}],
 *   order:[id...], summary:{missing,derivable,confirm}}。内核脚本落地前按本 schema
 *   先开发（先对 schema 后集成）；输出不符即结构化拒绝（fail-closed，不猜不修）。
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

// ── 固定 schema（内核输出消费面）──

/** 三态闭集（§〇.3——内核侧同源；第二态文案＝可自动执行给动作与数量）。 */
export const PREFLIGHT_ITEM_STATES: readonly string[] = ["missing", "derivable", "needs_confirm"];

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

export interface PreflightReport {
  generated_at: string;
  items: PreflightItem[];
  order: string[];
  summary: PreflightSummary;
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
  // order 与 items 双向对账：长度相等＋order 覆盖全部 item id（无缺项无多余）
  const ordered = new Set(order);
  if (order.length !== seen.size || ![...seen].every((id) => ordered.has(id))) {
    return { ok: false, error: "order 与 items.id 不对账（缺项或多出）" };
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
  return {
    ok: true,
    report: {
      generated_at: root["generated_at"] as string,
      items,
      order,
      summary: { missing: summary["missing"] as number, derivable: summary["derivable"] as number, confirm: summary["confirm"] as number },
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

// ── 首跑 KPI 事实（launch-kpi.json）──

export interface LaunchKpi {
  /** 首次预检成功时间（首写固定——重跑不覆盖，time-to-launch 基线不漂移）。 */
  preflight?: string;
  /** 首次放行时间（atf_launch_execute 启动成功；首写固定）。 */
  first_launch_at?: string;
}

export const launchKpiPathOf = (runDir: string): string => join(runDir, "webui", "launch-kpi.json");

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
    const dir = join(runDir, "webui");
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
