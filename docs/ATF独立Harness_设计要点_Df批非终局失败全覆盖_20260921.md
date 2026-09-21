# ATF独立Harness｜D-f 批《设计要点》（门 1 交付）— 2026-09-21

- **性质**：门 1 交付物（仅设计，停等核验；门 2 放行后方可实施）。
- **基线**：main `900a578`；worktree `/data/sam/ATF-Harness-df-collapse`、分支 `work/20260921-df-collapse`；**零提交、零 tracked 改动**（本文件为 untracked 交付物）。
- **依据**：《ATF-Harness_指令_Df批门1放行_20260921.md》（sha256 `de2e3e87…`）＋《ATF-Harness_指令_Df批非终局失败全覆盖_草案待裁_20260921.md》v4（sha256 `7fb7bed5…`）＋《ATF-Harness_冒烟2三跑核验记录_20260921.md》（sha `f71c15fd…`）。
- 行号均核自 worktree（与 main 900a578 一致）。

---

## 〇、现状基线（缺口的代码定位）

D-1 已生效面：`reject_loop_exhausted` 两触发点已改 turn 级收口——主循环 `src/core/run/runner.ts:1118-1139`、resume 重派 `runner.ts:763-788`；`TurnFailureSummary` 定义 `runner.ts:115-128`；`BranchOutcome.turn_failed` `runner.ts:140`；TUI 存活分支 `src/ui/tui.ts:229-242` → 新指令循环 `tui.ts:261-292`。

**剩余缺口**（冒烟 #2 三跑 F1）：单 turn 步数预算命中 `runner.ts:857-868` 走 `failed` 终局；provider 决策失败 `runner.ts:879-885` 走 `failed` 终局（stop_reason=error，29c48117 之死因）；决策序列耗尽未收束 `runner.ts:943` 同为终局。三者落 TUI `tui.ts:243-251`（`failed` 分支）→ 进程退出。无进展检测、缺口卡、guidance 回填均未落地。

---

## (a) 合并状态机：三路径＋无进展检测 → nudge／切断／收口 三档

### a.1 改／不改逐点映射（穷尽）

**① 改为 turn 级收口（join `turn_failed` 家族，均加 `!("decisionFace" in provider)` 模型面判别式，沿用 `runner.ts:767`/`:1119` 先例；脚本执行径逐位不变）**：

| 路径 | 现落点 | 改法 |
|---|---|---|
| `reject_loop_exhausted`（两处） | `runner.ts:770-788`、`:1122-1139` | **已收口，不动**；仅 summary 走共享构造器（见 b） |
| `budget_exhausted`（单 turn 步数） | `runner.ts:857-868` | outcome 改 `{kind:"turn_failed"}`，summary.reason=`"budget_exhausted"`、limit=32；`appendTurnEnd("failed","budget_exhausted",summary)` **保留 stop_reason 五值枚举** |
| `provider_failure`（decide err） | `runner.ts:879-885` | 同上，summary.reason=`"provider_failure"`；`appendTurnEnd("failed","error",summary)` |
| `provider_failure`（耗尽未收束） | `runner.ts:943` | 模型面改 turn 收口（用户重发指令即重试）；`runner.ts:924-930` 段切换两处属脚本 provider（segments 走 registry 脚本面），**豁免不动** |

退出码面零变化：`turn_failed` headless 已映射 exit 1（`runner.ts:156-171`，与原 `failed` 同码）；TTY 存活走既有 `tui.ts:229-242`→`:261-292` 路径——**结构性达成「禁止 turn failed → 进程退出」**：`tui.ts:243-251` 的 `failed` 分支从此只见真终局。

**② 保持 run 终局（逐点声明，防静默扩散）**：run 级预算 `max_turns=8` 三处（resume 前置 `runner.ts:654-661`、continue 前置 `:832-839`、段切换前 `:891-901`）；显式 abort（resume abort `:691-702`、问答轨 `:1030-1038`，exit 79）；终局性 block：`approval_missing`→78（`:1066-1071`，ADR-07 锚点不动）、`credential_indeterminate`（`:1073-1096`）、`approval_track_failed`/`credential_persist_failed`（`:1097-1106`）、`session_rejected` 铁律一（`:1204-1209`）；E3/E4 恒终局（`:1151-1155`）；运行时守卫 `model_decision_forbidden`（`:965-975`，fail-closed 设计）；suspended→75 不动。**边界提示请 owner 注意**：E4（内核对端桥接故障）保持终局而 provider_failure 改收口，属指令三路径的忠实执行，不对称是有意的（对端基础设施故障≠模型控制面问题）。

### a.2 无进展检测的三档接入（与上三条共用收口层）

每 turn 状态（`openTurnRecord` `runner.ts:552-566` 清零，新增三件）：`nudged: Set<pair>`、`cut: Set<tool>`、`lastMaterialGap`。

- **档 1 nudge**：同一 `(动作指纹×结果指纹)` 对在 turn 内**第 2 次**出现、且两次之间无状态变化事件（判据见 c）→ 本轮回流 tool/result payload 附 `nudge` 一行文案（模型下一拍可见，见 c 载体）。
- **档 2 切断**：同 pair **第 3 次**出现 → 该 tool 入 `cut` 集；执行点在 `runner.ts:1017`（`executor.execute` 调用前）短路：**先落 `tool/call`（可观测性不缺）→ 不发桥接请求 → 回填 rejected `reason="tool_cut_no_progress"`**（detail 含 until=turn_end＋指引）；不计入 `turnRejectCount`（控制面≠业务回流，E1–E4 口径不受染）。
- **档 3 收口**：**第 2 个不同工具入 cut 集** → `turn_failed`，summary.reason=`"same_call_repeat"`（exact repeat 主导）或 `"no_progress"`（no-op／oscillation 形态主导，判别见 c）；另两既有触发（reject 阈值 3、步数 32）不变阈值、改收口语义。cut 后模型的换参重试＝新动作指纹、但同工具仍拒（cut 以 tool 为粒度，防绕行——设计取舍：粗粒度换确定性）；cut 拒绝耗步数，32 步兜底天然成立。

**状态机一句话**：`NORMAL →(pair×2) NUDGED →(pair×3) CUT(tool) →(cut×2 工具) COLLAPSED`；COLLAPSED＝turn 收口、run 非终局、控制权交还用户；新 turn（新指令 `tui.ts:285-291` / resume 应答）全量恢复工具面。resume 重派径（`:722-804`）单调用无循环，检测器不挂载。

---

## (b) 收口结构扩展 ＋ TUI 呈现规范

**`TurnFailureSummary`（`runner.ts:115-128`）向后兼容扩展**——既有字段 `rejected`/`limit` 改可选（reject 两径继续填满，D-1 消费面不破），新增可选段：

```
reason: "reject_loop_exhausted" | "same_call_repeat" | "no_progress" | "budget_exhausted" | "provider_failure"
blocked_description?: { stuck_at; turns_used; steps_used }   // 阻塞说明：卡在哪／已用轮次（turnsOpened，runner.ts:550）
gap_card?: { stuck; missing; why; options:[{text; recommended?}] }  // 缺口卡四段；options ≤3、标推荐；空数组=如实停止等指示
cut_tools?: string[]                                          // no_progress 收口时本 turn 已切断工具
hint: { gate_ids?; note }                                     // 既有
```

summary 构造抽共享 helper（现 `runner.ts:776-784` 与 `:1126-1134` 双份字面量），四类触发同源产出防漂移。

**TUI 呈现规范**（改 `tui.ts:229-242` 分支为统一收口渲染）：
- **不显示步数**：删终局行的「模型调用=N 次」代理步数计（`tui.ts:228`）；事件数保留（append-only 对账口径，非进度）。`blocked_description` 中 `turns_used` 收进收口一句话（「已用 N 轮」——v4 D-f-2 明文），`steps_used` 仅留 payload 供机查、不上屏。
- **缺口卡仅文字＋分行**：固定四段行式「①卡在哪／②缺什么／③为什么需要／④可选项（推荐项标注）」，纯 `renderer.appendLine`，**不新增任何按键/交互控件**（既有全局 r/e/h 不动）；headless 非 TTY 照旧 exit 1（`tui.ts:263` 口径不变）。
- 收口行语义统一为「turn 收口（会话保持存活）」族，reason 码随行展示（机器可查同 payload）。

---

## (c) 无进展检测落点、轮询白名单、切断作用域与恢复

- **新模块 `src/core/run/noProgress.ts`**（与 `loopState.ts`/`stopReason.ts` 同层同范式）：`actionFingerprint = tool + params_digest`（复用 `approvalParamsDigest`，与 `runner.ts:1121` 同源）；`resultFingerprint = sha256(归一化结果)`（executed→result 载荷；rejected/blocked→{kind,reason,block.reason}）；pair 检测同时覆盖 exact repeat（同 pair 重现）与 no-op/oscillation（不同 pair 但零状态变化——窗口内所有 executed 结果指纹恒等）。提供事件流纯函数重建式（镜像 `loopState.ts:37-75` 的 durability 范式），runner 内增量维护 O(1)。
- **轮询白名单＝轮询豁免判据＋单源常量**：核心洞见是**轮询的合法性来自中间发生过状态变化**。常量 `POLLING_STATE_CHANGERS = ["atf_admit_data","atf_data_admission_request"]`（成功执行＝状态变化）＋ `approval/response(granted)` 落盘亦计状态变化；同 pair 两次出现之间含任一状态变化事件 → 豁免（合法重询），否则计数。另设静态 `NO_PROGRESS_EXEMPT_TOOLS: readonly string[] = []`（初始空；当前 5 工具无一属纯轮询读；维护方式同 `GATE_LEGAL_IDS` 先例 `toolDefinition.ts:61-77`——单源常量＋注释登记＋PR 变更）。此判据下冒烟 #2 的 16 连 gate 查／5 次完全重复（零中间写入）全部正确计数，而「准入后重询闸门」不误报——即验收用例「轮询白名单不误报」的判据化落地。
- **切断作用域与恢复**：cut 集为 turn 内控制面瞬态，不入事件流、不持久化；恢复＝turn 边界这一事件流事实（`openTurnRecord` 清零与 `deriveLoopStateFromEvents` 的 turn/start 对齐）：本 turn 内不可解除，收口即失效，新 turn（新指令/resume）全量恢复。
- **nudge 载体**：回填 tool/result payload 的可选 `nudge` 字段——payload 为自由 JSON（`src/core/session/schema.ts:66`、`:114`），模型经 `convertToLlm` 收到完整 payload（`src/core/session/compaction.ts:40-49`），`transformContext` 仅滤 `assistant/attempt`（`pipeline.ts:18`、`compaction.ts:217`）——零 schema 变更、模型可见性成立。阈值常量收 `noProgress.ts`（模型不可见，`session/constants.ts:47-53` 纪律）。

---

## (d) 四个业务阻断码 guidance 回填与「缺料→请示收口」接法

- **新模块 `src/core/run/blockGuidance.ts`**：`BLOCK_CODE_GUIDANCE` 注册表，键＝回流码（executor 自内核 `code` 透传于 `src/core/tools/executor.ts:240-243` 的 rejected.reason）。每码一行可行动文案（含义／缺什么／正常谁产／无料应请示停止、不得重复探查），如 `split_manifest_missing`：「split_root 下缺 global_assignment.csv（9 列）或 global_plan.json；正常由上游拆分管线产出；本批若无此料：如实向用户请示并停止，勿重复探查」（内核实据见核验记录 §四 `data_admission.py:1843` 起）。
- **消费点两处**：① 回流富化——runner 回填 tool/result 时命中注册表即附 `guidance` 字段（同 nudge 载体，零 schema 变更）；② 收口自动出卡——注册项带 `is_material_gap` 标（`split_manifest_missing`/`source_split_assignment_missing`=true），turn 收口时取本 turn 最后一个 material-gap 回流**自动填充缺口卡四段**（确定性、可 mock 断言；可选项不含「代派生料」承诺，符合 D-f-5 取乙）；`invalid_params`/`unknown_gate`=false（修参/查清单可自解，不出卡，仅 guidance 行＋nudge）。模型自发请示走引导层：`atf_admit_data`／`atf_data_admission_request` 描述尾部补一行「返回 *_missing 类业务拒绝：勿重复探查，向用户说明缺料并停止」（`toolDefinition.ts:104-105`、`:161-162`）——模型以 final_answer 陈述，TUI 邻近呈现，与自动卡互补；**不新增工具面**（`ask` 工具归 L1c）。
- **与 K-Gap-2 串行**：`toolDefinition.ts` 与 `ui/` 两批同触（门 1 放行 §三），实施期串行。

---

## (e) D-1 兼容声明

- **阈值零变更**：`REJECT_LOOP_LIMIT=3`（`src/core/run/constants.ts:10`）、`LOOP_MAX_STEPS_PER_TURN=32`（`src/core/session/constants.ts:56`，v4 D-f-2 明示不调参）、`LOOP_MAX_TURNS=8`（`:59`）。
- **E1–E4 判据零变更**：E1/E2 模型面非终局回流（`runner.ts:1118-1141`）、脚本径终局（`:1142-1149`）、E3/E4 恒终局（`:1151-1155`）、E2 锚点 input_violation 产出位（`executor.ts:114-124`）全部不动。
- **reason 码机器可查**：`TurnFailureSummary.reason` 扩为五值并集，既有 `"reject_loop_exhausted"` 保首；`same_call_repeat`/`no_progress`/`budget_exhausted` 并列可查；`LoopStopReason` 五值枚举不动（`stopReason.ts:12`，复用 `budget_exhausted`/`error`，收口径照 D-1 先例不带 stop_reason，`runner.ts:787`/`:1137`）。
- **面零变更**：会话 schema 12 类白名单不动（`schema.ts:15-28`）、payload 自由 JSON 上只加可选字段（failure_summary/nudge/guidance，`appendTurnEnd` 先例 `runner.ts:509-536`）；契约零 diff、pin `61631e6`/v0.7.2b0 不动、`dependencies` 恒空、无新退出码、无新事件类型、脚本执行径豁免逐位不变。
- **新增用例**（门 1 放行 §二 五条）：`budget_exhausted`→收口→TUI 存活→同会话续跑；`provider_failure` 同款；exact repeat/no-op→nudge→切断→收口；轮询白名单不误报（有/无中间状态变化对照）；缺关键输入→缺口卡收口→会话可续。落位建议 `tests/run/dfCollapse.test.ts`（桩 provider 模式沿用 `tests/run/toolErrorBackfill.test.ts:39` modelStub 先例）＋ mock 增 `split_manifest_missing` 拒绝仿真（`tests/fixtures/mock_atf.mjs`，现 `:338` 起准入仿真区）；真内核 e2e 三情形挂 `tests/run/realPeer/e2eChain.test.ts`。mock 底线 ≥460/9 零回归。

---

**停等核验**。门 1 期间仓零改动（worktree 已建、零提交）；owner 核验通过后按门 2 排程实施（先于 K-Gap-2 接线批，`toolDefinition.ts`/`ui/` 串行）；不 push、不发版。
