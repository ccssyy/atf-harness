/**
 * 跨 turn 无进展检测（F2 批，2026-09-26；指令 docs/_owner/ATF-Harness_指令_F2_跨turn无进展检测_20260925.md）。
 *
 * 缺口（走查 v077 DeepSeek 线实证：全流 13 turn / 1330 次调用、atf_admit_data 落账恒 0，
 * 停线收证流 /tmp/wt077-session-final.jsonl.bak）：D-f-4 无进展检测器（noProgress.ts）每 turn
 * 重建、计数复位——探针每轮重开 turn 即绕过护栏，跨 turn 绕圈无约束。本模块补跨 turn 维度：
 * 同类行为跨 turn 连续重复达到阈值时，按既有三档控制介入（档 1 nudge → 档 2 切断 →
 * 档 3 run 级收口），只服务控制面，模型面仅见 nudge 文案。
 *
 * 范式与 noProgress.ts / loopState.ts 同款 durability 纪律：检测所需状态只由本侧事件流事实
 * 推导（turn 边界内 tool/call + tool/result），进程内增量维护（游标只进不退），resume/continue
 * 装载历史后一次 update 即重建——跨进程恢复语义与 D-f 对齐。一切阈值常量模型不可见
 * （不进 prompt / 工具参数 / 决策对象）。
 *
 * 指令三信号在本仓实码上的归并（语义保持；登记于交付报告）：
 *   - 信号 2「零状态推进（写类事实零增长）」→ 无进展 turn 判据：本 turn 无任何状态变化事实；
 *   - 信号 1「同类调用序列重复（名字＋关键参数形态相似度）」→ 窗口相似度判据：末 turn 对
 *     窗口末前一 turn 的双层包含率（动作指纹层＝工具名＋参数 digest，与 D-f 同一
 *     actionFingerprint 单源；工具名层＝名字集合包含率）取 max ≥ 阈值，逐对链式成窗；
 *   - 信号 3「自读自写循环（v077 实测形态：回读自身转录＋重复扫描同一产物＋产出摘要）」→
 *     由前两者合取覆盖：其读探针跨 turn 链式重复（实证：逐 turn 工具名集合包含率 ~100%——
 *     参数逐次微变使精确指纹层失效，名字层即为此形态而设）且写类事实零增长。
 *   无进展裁定 = 两判据合取：纯重复伴随落账＝合法重试（判据①打断），纯零推进而行为已换路
 *   （判据②打断）均不误伤。
 *
 * 状态变化事实（写类事实落账口径，走查 v077 实证驱动，与 D-f POLLING_STATE_CHANGERS 有意
 * 分道——两处回答的问题不同：「是否可能翻转被询状态」vs「是否真实落账推进」）：
 *   - atf_admit_data executed ok=true（账本/facts 落账——指令约束②「admission 重试成功落账」
 *     的机查面）；
 *   - atf_gate executed ok=true 且 result.status="pass" 且原调用 action="advance"（闸门放行＝
 *     gate 状态变更；action 经 tool/call↔tool/result 的 call_ref 配对取回；query 回显 pass 与
 *     advance blocked 均非推进）。配对缺失的退化流按状态变化计（宁可漏检不误罚）。
 *   明确不算（v077 实证：预授权流 granted 审批每 turn 高达 61 次而零落账；
 *   atf_data_admission_request 被 blocked 的重复提交恰是绕圈形态本身）：
 *   - approval/response granted（授权落账≠事实推进——授权由工具执行结果兑现，后者另行计入）；
 *   - atf_data_admission_request ok=true（提案提交≠落账）。
 *
 * 三档升级（窗口 W = 连续「无进展且链式相似」的已闭行为 turn 数；状态变化 turn 打断窗口；
 * 零调用 turn 透明——无行为证据，不延长亦不打断）：
 *   - W ≥ N（ATF_NO_PROGRESS_CROSS_TURNS，缺省 3）→ 档 1 nudge：后续 tool/result 回流附
 *     CROSS_TURN_NUDGE_NOTE（payload.nudge 既有字段，模型下一拍可见；模型不可见机制细节）；
 *   - W ≥ N+1 → 档 2 切断：当前 turn 链终止（turn 级收口，run 非终局，控制权交还调用方）；
 *   - W ≥ N+2 → 档 3 run 级收口：收口报告附 cross_turn.escalation="run_close"（机查档位；
 *     收口形态与档 2 同为 collapseTurn——BranchOutcome 零扩面，run 级定性由摘要承载）。
 * 检测面隔离：仅模型面（无 decisionFace）生效；脚本执行径（Faux 断言路径）豁免，与 D-f 同判别式。
 */
import { type SessionEvent } from "../session/index.js";
import { envPositiveInt } from "../session/constants.js";
import { actionFingerprint } from "./noProgress.js";

/** 档 1 触发：连续无进展且链式相似的已闭行为 turn 数（W ≥ N；缺省 3——比 D-f turn 内 nudge
 *  阈值 2 更保守：跨 turn 误伤的代价高于 turn 内，多给一轮自纠机会）。env ATF_NO_PROGRESS_CROSS_TURNS。 */
export const CROSS_TURNS_DEFAULT = 3;

/** 窗口相似度阈值（‰）：末 turn 对窗口末前一 turn 的双层包含率（动作指纹层／工具名层取 max）
 *  下限（缺省 600‰）。取整千分数保持 env 正整数纪律（无浮点解析面）。env ATF_NO_PROGRESS_OVERLAP_PERMILLE。 */
export const CROSS_TURNS_OVERLAP_PERMILLE_DEFAULT = 600;

/** 档 1 nudge 文案（payload.nudge 载体；模型下一拍可见）。只描述行为与指令，不暴露检测
 *  机制细节（owner 产品原则①：系统知识不由模型面承载）。 */
export const CROSS_TURN_NUDGE_NOTE =
  "控制面提示：连续多轮未见实质进展（同类操作重复、无新事实落账）。请收口当前工作并向用户汇报，或改用其他路径推进；勿继续重复探查。";

/** 生效配置（env 覆盖纪律同 ATF_LOOP_MAX_TURNS：正整数合法即覆盖；未设/空/非法 fail-closed 回退缺省，
 *  覆盖/非法各记一行 stderr——每进程每值恰一次）。 */
export interface CrossTurnNoProgressConfig {
  /** 档 1 窗口阈值 N */
  windowTurns: number;
  /** 窗口相似度阈值（‰） */
  overlapPermille: number;
}

export const resolveCrossTurnNoProgressConfig = (): CrossTurnNoProgressConfig => ({
  windowTurns: envPositiveInt(process.env["ATF_NO_PROGRESS_CROSS_TURNS"], CROSS_TURNS_DEFAULT, "ATF_NO_PROGRESS_CROSS_TURNS"),
  overlapPermille: envPositiveInt(
    process.env["ATF_NO_PROGRESS_OVERLAP_PERMILLE"],
    CROSS_TURNS_OVERLAP_PERMILLE_DEFAULT,
    "ATF_NO_PROGRESS_OVERLAP_PERMILLE",
  ),
});

/** 单个已闭行为 turn 的进展事实（事件流纯推导）。 */
interface CrossTurnFacts {
  /** 动作指纹集合（tool/call 去重；与 D-f 同一 actionFingerprint 单源） */
  readonly fps: ReadonlySet<string>;
  /** 工具名集合（名字层判据） */
  readonly names: ReadonlySet<string>;
  /** 入窗时对前一 turn 的双层包含率 max（‰；诊断面随 verdict 透出） */
  overlapPermille: number;
}

/** 三档升级取值（failure_summary.cross_turn.escalation 机查档位）。 */
export type CrossTurnEscalation = "nudge" | "cut" | "run_close";

export interface CrossTurnVerdict {
  tier: "none" | CrossTurnEscalation;
  /** 当前窗口长度 W */
  windowTurns: number;
  /** 窗口末 turn 的入窗相似度（‰；诊断面） */
  overlapPermille: number;
  /** 生效阈值 N（诊断面） */
  thresholdTurns: number;
}

const payloadOf = (event: SessionEvent): Record<string, unknown> =>
  typeof event.payload === "object" && event.payload !== null ? (event.payload as Record<string, unknown>) : {};

const containmentPermille = (cur: ReadonlySet<string>, prev: ReadonlySet<string>): number => {
  if (cur.size === 0) return 0;
  let hits = 0;
  for (const item of cur) if (prev.has(item)) hits += 1;
  return Math.floor((hits / cur.size) * 1000);
};

/** 单次执行结果是否为状态变化事实（事件区间扫描与 runner 本拍判定共用的单源纯函数——
 *  「本 turn 已落账 ⇒ 介入豁免」与闭 turn 判据同源，防两处口径漂移）。 */
export const executionStateChange = (tool: string, params: unknown, result: unknown): boolean => {
  if (tool === "atf_admit_data") return true;
  if (tool === "atf_gate") {
    const status = typeof result === "object" && result !== null ? (result as Record<string, unknown>)["status"] : undefined;
    if (status !== "pass") return false;
    // 配对语义：仅 advance 放行＝gate 状态变更（query 回显非推进；params 缺 action 的退化形态按 advance 计——宁可漏检不误罚）
    const action = typeof params === "object" && params !== null ? (params as Record<string, unknown>)["action"] : undefined;
    return action === undefined || action === "advance";
  }
  return false;
};

/** turn 事件区间 → 行为事实（纯函数）。stateChange 判定含 gate advance 配对（call_ref → 原调用 action）。 */
const factsFromRange = (events: readonly SessionEvent[], from: number, to: number): { facts: CrossTurnFacts; toolCalls: number; stateChange: boolean } => {
  let toolCalls = 0;
  let stateChange = false;
  const fps = new Set<string>();
  const names = new Set<string>();
  /** call_ref → 原 tool/call payload（gate advance 配对） */
  const callsById = new Map<number, Record<string, unknown>>();
  for (let i = from; i <= to; i += 1) {
    const event = events[i] as SessionEvent;
    const payload = payloadOf(event);
    if (event.type === "tool/call") {
      const callId = event.id;
      if (typeof callId === "number") callsById.set(callId, payload);
      if (typeof payload["tool"] === "string") {
        toolCalls += 1;
        fps.add(actionFingerprint(payload["tool"], payload["params"]));
        names.add(payload["tool"]);
      }
      continue;
    }
    if (event.type !== "tool/result" || payload["ok"] !== true) continue;
    const tool = payload["tool"];
    if (typeof tool !== "string") continue;
    const callRef = payload["call_ref"];
    const call = typeof callRef === "number" ? callsById.get(callRef) : undefined;
    // 配对缺失的退化流按 advance 计（宁可漏检不误罚）；atf_admit_data 无需配对
    const params = call === undefined ? undefined : call["params"];
    if (executionStateChange(tool, params, payload["result"])) stateChange = true;
  }
  return { facts: { fps, names, overlapPermille: 0 }, toolCalls, stateChange };
};

/**
 * 跨 turn 无进展检测器（每 run 分支一个实例；游标增量消费事件流，闭 turn 才入窗）。
 * 线程模型：单进程决策循环串行调用，无并发。
 */
export class CrossTurnNoProgressDetector {
  private readonly config: CrossTurnNoProgressConfig;
  /** 已消费事件游标（只进不退；update 幂等——同前缀重复消费零副作用） */
  private cursor = 0;
  /** 当前扫描 turn 的 start 事件下标（-1 = 尚未进入 turn） */
  private turnStartIndex = -1;
  /** 窗口：连续「无进展且链式相似」的已闭行为 turn 事实（尾插） */
  private readonly window: CrossTurnFacts[] = [];

  public constructor(config: CrossTurnNoProgressConfig) {
    this.config = config;
  }

  /**
   * 消费事件流增量（通常传 runner 内存全量事件序列）；遇 turn/end 即处理该 turn。
   * 幂等：游标推进，重复传入同序列零副作用。
   */
  public update(events: readonly SessionEvent[]): void {
    for (let i = this.cursor; i < events.length; i += 1) {
      const event = events[i] as SessionEvent;
      if (event.type === "turn/start") {
        this.turnStartIndex = i;
        continue;
      }
      if (event.type !== "turn/end") continue;
      // 闭 turn 事实处理（turn/start 缺失的退化流：以 0 起算——事件流 envelope 保序，无跨 turn 混装）
      const { facts, toolCalls, stateChange } = factsFromRange(events, this.turnStartIndex >= 0 ? this.turnStartIndex + 1 : 0, i - 1);
      this.admit(facts, toolCalls, stateChange);
      this.turnStartIndex = -1;
      this.cursor = i + 1;
    }
  }

  private admit(facts: CrossTurnFacts, toolCalls: number, stateChange: boolean): void {
    // 状态变化 turn（admission 落账／gate advance 放行）＝写类事实推进——合法重试不误伤，窗口归零
    if (stateChange) {
      this.window.length = 0;
      return;
    }
    // 零调用 turn（纯答复）＝无行为证据——透明：不延长亦不打断（窗口度量工具行为连续性）
    if (toolCalls === 0) return;
    const prev = this.window[this.window.length - 1];
    const similarity = prev === undefined
      ? 0
      : Math.max(containmentPermille(facts.fps, prev.fps), containmentPermille(facts.names, prev.names));
    // 低相似 turn（行为已换路径——对上一 turn 的名字/参数双层包含率不足）＝无进展定性不成立，窗口自本 turn 重建
    if (prev !== undefined && similarity < this.config.overlapPermille) this.window.length = 0;
    this.window.push({ ...facts, overlapPermille: this.window.length === 0 ? 0 : similarity });
  }

  /** 当前三档裁决（窗口只含已闭 turn——本 turn 行为不影响本拍裁决）。 */
  public verdict(): CrossTurnVerdict {
    const w = this.window.length;
    const n = this.config.windowTurns;
    const tier: CrossTurnVerdict["tier"] = w >= n + 2 ? "run_close" : w >= n + 1 ? "cut" : w >= n ? "nudge" : "none";
    const last = this.window[this.window.length - 1];
    return {
      tier,
      windowTurns: w,
      overlapPermille: last !== undefined ? last.overlapPermille : 0,
      thresholdTurns: n,
    };
  }

  /**
   * 当前 open turn 是否已出现状态变化事实（本 turn 实时自纠面）。窗口只含已闭 turn——
   * 绕圈后的当前 turn 恰在落账（如 admission 重试成功）时，闭 turn 视角看不到本 turn 的
   * 实时推进，介入判据须以本方法豁免（指令约束②：伴随账本推进的同类调用不计入重复）。
   * 消费时点（runner 回流前）：本拍执行结果尚未落盘，须与 executionStateChange(本拍)
   * 联合判定。
   */
  public openTurnHasStateChange(events: readonly SessionEvent[]): boolean {
    if (this.turnStartIndex < 0) return false;
    const callsById = new Map<number, Record<string, unknown>>();
    for (let i = this.turnStartIndex + 1; i < events.length; i += 1) {
      const event = events[i] as SessionEvent;
      const payload = payloadOf(event);
      if (event.type === "tool/call") {
        if (typeof event.id === "number") callsById.set(event.id, payload);
        continue;
      }
      if (event.type !== "tool/result" || payload["ok"] !== true) continue;
      const tool = payload["tool"];
      if (typeof tool !== "string") continue;
      const callRef = payload["call_ref"];
      const call = typeof callRef === "number" ? callsById.get(callRef) : undefined;
      if (executionStateChange(tool, call === undefined ? undefined : call["params"], payload["result"])) return true;
    }
    return false;
  }

  /** 窗口长度（测试/诊断面）。 */
  public windowLength(): number {
    return this.window.length;
  }
}
