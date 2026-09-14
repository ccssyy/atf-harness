# ATF 独立 Harness——切片 1 执行报告：loop 骨架（终止判据 + 轮次预算 + step 元数据）

**签发**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**日期**：2026-09-14
**依据**：《ATF独立Harness_切片1任务书_loop骨架_20260914.md》（§1 四项 / §2 硬约束 / §3 VERIFY 八项 / 附加要求）＋《agent-loop 设计（已升格）》§3.1/§4 A1·A2·A4·A5
**性质**：骨架工作包——**本地提交未推送，推送待 owner 另行授权**；内核仓零改动；`bridge.contract.yaml` 零改动；切片 0 守卫继续生效未放宽

---

## 1. 判据与预算实现说明（任务书 §1.1/§1.2）

### 1.1 终止判据（A2，stopReason 五值，只扩面）

| 判据 | 实施触发点 | 结果 | stop_reason |
|---|---|---|---|
| `final_answer` | provider 产出 final_answer 决策（分派即收口，既有路径） | `completed`（exit 0） | `final_answer` |
| `no_more_tools` | provider 返回 `null` 且本 turn 已产出 final_answer（`resolveExhaustionStop` 纯函数判定，runner null 分支接入） | `completed`（exit 0） | `no_more_tools` |
| `budget_exhausted` | ①loop 顶 `turnStepCount ≥ LOOP_MAX_STEPS_PER_TURN(32)`——不再调用 provider；②段边界开新 turn 前 `turnsOpened + 1 > LOOP_MAX_TURNS(8)`——不执行切换协议即收口 | `failed`（exit 1，runError code = `budget_exhausted`） | `budget_exhausted` |
| `error` | provider decide 自身故障（err） | `failed`（exit 1，code = `provider_failure` **既有取值不变**） | `error` |
| `aborted` | 应答 verdict=aborted / 宿主终止（P2-S2 既有路径零改动） | `aborted`（exit 79） | `aborted` |

- **未收束**（null 且无 final_answer 且无待处理动作）维持既有 `provider_failure` 终局——"以可执行内容为准"：不把 provider 的结束信号当唯一事实。
- **null 语义升格**：`null` 从"序列耗尽（故障）"扩为"provider 自然结束"，段分支的段边界切换协议保持不变（切片 1 未引入回环，回环属切片 2 的 B1——本切片 loop 驱动源仍为脚本化来源）。
- **实施口径说明**：final_answer 分派即收口（判据 1），故 `no_more_tools` 在 runner 层为 null 分支的防御形态，由 `resolveExhaustionStop` 纯函数承载并单元直测（如实声明，不虚构成不可达的 runner 级用例）。
- **既有缺口修复（INV-2）**：provider decide err 路径此前**不收口 turn** 即 break——本切片以 `{reason:"failed", stop_reason:"error"}` 收口（事件序列对既有用例零影响：Faux 回放永不 err，该路径此前不可达）。

### 1.2 轮次预算

- `LOOP_MAX_STEPS_PER_TURN = 32`、`LOOP_MAX_TURNS = 8`，收在 `src/session/constants.ts`（与 compaction/fsync 常量同层，附初值理由注释）；默认值未调整（如需调整提请 owner）。
- 耗尽 → `failed(budget_exhausted)` **复用 exit 1**，不新增退出码；runError code 独立可区分（`BranchRunReport.outcome.error.code`）。
- 确定性：两档检查均为纯常量比较（loop 顶 / 段边界前），不依赖内核内存态；预算耗尽路径自身也收口 turn（INV-2）。

## 2. 不可见性证明（VERIFY 3）

1. **结构位**：`session.contract.yaml` `llm_context_event_fields` 白名单 = `[id, ts, type, payload, domain_refs?, synthetic?]`——无任何预算字段位；预算信息结构性无法进入注入上下文。
2. **运行时采样**：`contextCapturingProvider` 捕获每次 `decide(context)` 收到的完整注入上下文（JSON 序列化），断言不含 `max_steps_per_turn` / `max_turns` / `budget` / `stop_reason` 任意键串（用例实跑通过）。
3. **类型面**：`LlmDecision` 三成员键集无预算字段（用例断言 `tool_call` 键集恰为 `params/tool/type`）。

## 3. 元数据对账（VERIFY 4，A1 纯增量）

`turn/end.payload` = `{reason, step_count, decision_count, stop_reason?}`：

- `step_count` = 本 turn 已分派执行的内容步（assistant_message / tool_call / scratch_write / promote / cite_t0；**provider_switch 请求不计**——无内容执行）；
- `decision_count` = 本 turn provider 决策数（**含被拒的 provider_switch 请求**——与既有 `TurnAttribution.decision_count` 口径一致）；
- 对账用例：3 步分支 → `turn/end.payload {step_count: 3, decision_count: 3}`，与 turn/start..turn/end 之间 3 条 `assistant/message` 事件一致；双段分支两 turn 各自记账（`{reason:"provider_switch", step_count:1}` / `{reason:"completed", stop_reason:"final_answer", step_count:1}`）。
- 契约侧：`session.contract.yaml` 追加「切片 1 注记」（纯增量；`contract_version` / `schema_version` 均不 bump）；`bridge.contract.yaml` 零改动；不新增事件类型（第 13 类保持保留位）。

## 4. 不变量断言（VERIFY 6，A4）

| 不变量 | 断言口径 | 落点 |
|---|---|---|
| INV-1（turn 不跨进程连续执行） | 事件流 turn/start↔turn/end 严格成对、任意前缀 end 数 ≤ start 数、终态 depth=0（不嵌套、不悬空） | `assertTurnPairing`（各 runner 级用例复用） |
| INV-2（任意可写终局收口 turn） | 终局报告最后一条事件为 turn/end；切片 1 修复 decide err 路径缺口；**边界声明**：落盘通道本身失效（append 失败）时收口不可行，由 session_failure 终局承载 | runner 各终局路径 ＋ 用例 |
| INV-3（switch 边界 = turn 边界；审批往返不构成切换窗口） | switch 事件前一事件恒为 turn/end、后一事件恒为 turn/start（双段用例实跑断言）；审批 request/response 往返不产生 switch 事件（P2-S2 既有用例承载） | runner `checkSwitchBoundary` ＋ 用例 |

三项已落入《agent-loop 设计（已升格）》新增「实施章节（切片 1 落地）」。

## 5. 零回归数字（VERIFY 7，两轨＋四冒烟）

| 轨道 | 切片 1 前 | 切片 1 后 | 判定 |
|---|---|---|---|
| 真对端轨（设 `ATF_CLI_PATH`） | 215 passed / 1 skipped（31 文件） | **226 passed / 1 skipped（32 文件）** | ✅ 基线全保留＋11 用例 |
| mock 轨（不设） | 210 passed / 9 skipped | **221 passed / 9 skipped（32 文件）** | ✅ 基线全保留 |
| `smoke:s5` / `smoke:p2s2` / `smoke:p2s3` | 全过 | 全过（零改动） | ✅ |
| `smoke:r2`（真对端） | 全过 | 全过 | ✅ |
| `typecheck` | 通过 | 通过 | ✅ |

**VERIFY 8 契约**：`session.contract.yaml` 仅纯增量注记（§3）；`bridge.contract.yaml` 零改动；任一版本轴不 bump。**切片 0 守卫**：`assertModelDecision` 原样生效，反例用例（切片 0 组）全绿，未降级。

## 6. 条款映射表（改动 → 设计条款）

| 改动 | 对应条款 |
|---|---|
| `src/session/constants.ts`：LOOP_MAX_STEPS_PER_TURN=32 / LOOP_MAX_TURNS=8（＋理由注释＋不可见性声明） | 任务书 §1.2；讨论稿 §4 A2（预算两档、常量层、模型不可见） |
| `src/run/stopReason.ts`（新增）：LoopStopReason 五值枚举 ＋ resolveExhaustionStop 纯函数 | 任务书 §1.1；讨论稿 A2（stopReason 枚举只扩面、确定性判据） |
| `src/run/runner.ts`：loop 顶步数预算 ＋ 段边界 turn 预算 ＋ null 分支 no_more_tools ＋ decide err 收口（stop_reason=error）＋ final_answer/aborted 贯通 stop_reason ＋ turnStepCount/turnHadFinalAnswer/turnsOpened 状态 ＋ appendTurnEnd 扩展（step_count/decision_count/stop_reason） | 任务书 §1.1/§1.2/§1.3；讨论稿 A2 影响面（BranchOutcome 增 budget_exhausted 收敛路径、runError 增码）＋ A1（元数据）＋ A4（INV-2） |
| `session.contract.yaml`：切片 1 注记（元数据字段 ＋ stop_reason 枚举 ＋ 预算常量不可见 ＋ 不变量指向） | 任务书 §1.3/VERIFY 8；讨论稿 §2.3 公理（纯增量不 bump） |
| `docs/ATF-Harness_agent-loop设计_门1讨论稿_20260914.md`：新增「实施章节（切片 1 落地）」（判据实施表 / 预算 / 元数据 / INV） | 任务书 §4.3（设计文档更新） |
| `tests/run/loopSkeleton.test.ts`（新增 11 用例） | 任务书 §3 VERIFY 1–6 |

**不动项核对**：不做切片 2 内容（context 消费 B1 / 多工具展开 A3 / 错误回填 B2——loop 驱动源仍为脚本化来源）；`src/workspace/`（晋升闸 A）与 `src/session/` 既有语义零改动；切片 0 守卫未放宽；不新增事件类型/退出码；`dependencies` 恒空；内核仓零改动。

## 7. 条款级完成清单

| # | 条款 | 完成 |
|---|---|---|
| 1 | 裁剪版四重判据 ＋ 显式预算落地 | ✅ §1.1/§1.2 |
| 2 | stopReason 枚举只扩面、不改既有取值 | ✅ 五值新增字段，既有 reason 零改动 |
| 3 | 预算两档 32/8 收常量层、模型不可见 | ✅ §2 三重证明 |
| 4 | 预算耗尽 failed(budget_exhausted) 复用 exit 1 | ✅ |
| 5 | turn/end.payload 补 step_count/decision_count | ✅ §3 对账 |
| 6 | 契约纯增量注记、不 bump、bridge 零改动 | ✅ VERIFY 8 |
| 7 | "以可执行内容为准"两侧语义 | ✅ VERIFY 5 两用例 |
| 8 | INV-1/2/3 文档化 ＋ 断言 | ✅ §4（含 decide err 缺口修复声明） |
| 9 | 不做切片 2 内容、不改 workspace/session 语义 | ✅ |
| 10 | 零回归两轨 ≥215/1 与 ≥210/9 ＋ 四冒烟 | ✅ §5 |
| 11 | 分支合回后删除 ＋ 本地提交不 push | ✅（`1527724` → merge `20bb4e6`，已删） |
| 12 | 条款映射 ＋ 条款级完成清单 | ✅ 本报告 §6/§7 |

## 8. 提交清单（本地提交，**未推送**）

1. `1527724` `feat(slice1)`：切片 1 工作笔（9 文件，分支合入）；
2. `20bb4e6` `merge`：`work/20260914-slice1-loop-skeleton` → main（分支与 worktree 已删）；
3. 本报告入库提交（`docs(slice1)`）。

**完成即停**：切片 1 闭合；切片 2（adapter 契约 + 多工具展开 + 错误回填）待 owner 签发启动；推送待 owner 授权。
