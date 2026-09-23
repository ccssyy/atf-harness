/**
 * 会话层常量（P2-S1，owner 口径 #2/#4 / 决议四）：compaction 触发指标与 fsync 档位。
 * 全部收在常量层——不暴露给模型（不进入 prompt、工具 schema 或会话事件 payload），
 * 初值选取理由同步登记于 session.contract.yaml 的 compaction / durability 节。
 */

// ---------------------------------------------------------------------------
// compaction（任务书 §2 设计要求 1/4：双指标触发，先到者生效）
// ---------------------------------------------------------------------------

/** 事件数触发门：会话实质事件数（不含 session/compaction 审计事件）达到即触发压缩。
 *  修复批 3（2026-09-23）：128 → 512——重跑① 实证 128 过早折叠（约 2 个 turn 即触发，
 *  且折叠边界的配对切断风险随折叠次数线性累积）；512 把折叠推迟到长会话深部，配合
 *  切点对齐（compaction.alignBoundaryToPairs）双保险。进程级可配（constantsBudget
 *  setCompactionTriggerEvents——测试/宿主 seam，缺省回退本常量）；按 token 语义重估
 *  （事件数门与 token 门的关系归一）留 backlog。 */
export const COMPACTION_TRIGGER_EVENTS = 512;

/** 估算 token 触发门：未折叠事件的 payload 估算 token 总量达到即触发。
 *  初值理由：约 24k token 的上下文占用护栏，远小于任何在用模型窗口，
 *  用于兜底「事件数少但单条超长」形态的会话。 */
export const COMPACTION_TRIGGER_TOKENS = 24_000;

/** token 估算除数：单事件估算 token = ceil(payload JSON 字符串长度 / 本除数)，求和。
 *  初值理由：中文约 0.6–1 token/字符、英文约 0.25，取 1/2 为偏保守估计（宁可早压，
 *  不冒上下文溢出风险）；纯启发式，不追求 tokenizer 精度。 */
export const TOKEN_ESTIMATE_DIVISOR = 2;

/** 保留窗：最近 N 条实质事件永不折叠——模型始终保有最新原文上下文。 */
export const COMPACTION_KEEP_RECENT = 32;

/** 折叠推进粒度（滞后量）：折叠边界只按该粒度的整数倍推进，防止每次 append 逐条重折叠。 */
export const COMPACTION_CHUNK = 32;

// ---------------------------------------------------------------------------
// fsync（durability 契约，任务书 §2 设计要求 6–8 / owner 决议四）
// 两档共同契约：append 返回（ack）⇒ 该事件已 fsync 持久化，已确认事件永不丢；
// 差异只在 fsync 的触发时机：逐条档每条一刷，批量档攒批一刷（吞吐换延迟）。
// ---------------------------------------------------------------------------

/** 默认档位：逐条 fsync（owner 决议四：durability 优先，承证场景的产品可信度底线）。 */
export const FSYNC_DEFAULT_MODE = "per-append" as const;

/** 批量档：缓冲满 N 条触发一次 write+fsync。 */
export const FSYNC_BATCH_MAX_EVENTS = 32;

/** 批量档：自缓冲最早未刷盘事件起 T 毫秒窗口到期触发一次 write+fsync（含空转时钟不驻留进程）。 */
export const FSYNC_BATCH_WINDOW_MS = 50;

// ---------------------------------------------------------------------------
// loop 轮次预算（切片 1，A2——《agent-loop 设计（已升格）》§4 A2 / 任务书 §1.2）
// 真实模型驱动的 loop 没有预算会失控（无限工具调用 / 无限重试）；Faux 下脚本有限
// 不可见此风险。预算耗尽 → failed(budget_exhausted)，复用 exit 1（不新增退出码）。
// **模型不可见**：不得进入任何注入上下文、工具参数或决策对象（会话 schema 无此字段位，
// runner 不向 decide context / 工具 params 注入——任务书 §1.2 硬约束）。
// ---------------------------------------------------------------------------

/** 单 turn 步数上限（一个 turn 内可执行内容步——assistant_message/tool_call/工作区动作等）。 */
export const LOOP_MAX_STEPS_PER_TURN = 32;

/** 单分支（run）turn 数上限。 */
export const LOOP_MAX_TURNS = 8;
