# ATF 独立 Harness — Phase 1 / S5 Faux 冒烟闭环 执行报告 暨 Phase 1 闭合报告

> 日期：2026-09-09 ｜ 执行方：zcode（本仓唯一开发 agent）｜ 报告对象：owner
> 执行依据：《ATF-Harness_Owner决议与启动指令_S4闭合_S5启动_20260909.md》（§1 闭合决议 + §2 执行序列 + §3 owner 口径 #1–#6 + §4 七项总验收）+《ATF独立Harness_Phase1任务书_20260908.md》§5（S5）
> 结论：**S4 已按决议闭合 push（tip `89510d1`）；S5 全部完成，任务书 §5 七项总验收逐项打勾全过——Phase 1 冒烟最小闭环达成。本轮产出本地提交未 push，停在 Phase 2 议题前；未获 owner 指令不得启动任何新 slice。**

---

## 0. 结论摘要

1. **执行 1（S4 闭合）**：push 前复跑全量 95 passed / 2 skipped 一致 → `4f0f643` + `89510d1` 推送 origin/main（`2526532..89510d1`）→ **push 后 tip = `89510d1`**。
2. **执行 2/3（S5 BUILD + VERIFY）**：`src/llm/`（LlmProvider 接口 + FauxProvider 脚本回放）+ `src/run/`（ScenarioRunner 分支执行器 + SurfaceScanResolver + 统一退出码出口）+ `scenarios/admission-to-g2.json` v1 定稿入库。四分支端到端：B1 exit 0（G2 PASS + 晋升登记 sha）、B2 block 回填自纠 PASS、B3 exit 78、B4 会话层拒绝 exit 1（`t0_ref_forbidden`，不走 78）。
3. **七项总验收（任务书 §5）逐项打勾全过**（见 §3）；typecheck 0 error；全量 **109 passed / 2 skipped**（16 文件：S1 26+2、S2 30、S3 20、S4 19 零回归，S5 新增 14）；`smoke:s1–s5` 五条冒烟全过 exit 0；pin 副本 `a628f8b`（v0.2.0b7）干净——**零 GPU、零真实 Provider、零内核仓改动**。
4. §5 登记自主决策 8 项（均在 owner 口径授权范围内）；§7 给出 Phase 2 待决事项清单。无阻塞待决项。

## 1. S4 闭合决议执行对照（指令 §1/§2 执行 1）

| 决议 | 执行 |
|---|---|
| 报告 §5 决策点 ①–⑦ 全部同意为正式口径 | 已作为既定口径；本 slice 零触碰 S4 工作区层与 `workspace.contract.yaml`（S4 测试 19 用例全绿佐证零回归） |
| 批准 push `4f0f643` + `89510d1` | ✓ push 前复跑全量 95 passed / 2 skipped（含 pin 副本契约测试）；`git push origin main` 一次成功 `2526532..89510d1`；**tip = `89510d11f7247575a37689d4b562754a7290a7cf`** |

## 2. S5 owner 口径执行对照（指令 §3）

| # | 口径 | 执行结果 |
|---|---|---|
| 1 | 晋升是 harness 本地动作（走晋升闸 A），不是内核桥接调用；场景脚本实现为 runner 内置步骤类型 `promote`，不进工具注册表 | ✓ 步骤类型 `promote`（映射 `registerReproduce` + `promoteArtifact`）；同类 runner 内置步骤 `scratch_write` / `cite_t0`；严格 4 工具与内核方法面零改动（`TOOL_DEFINITIONS` 未动） |
| 2 | 场景脚本 draft-v0 → v1 入库 `scenarios/`，占位符替换为真实 fixture 引用、字段名对齐实现；校准对照表写入报告 | ✓ `scenarios/admission-to-g2.json`（version: 1）；对照表见 §4；语义不变 |
| 3 | "ATF 侧 run journal 有对应事实"由 mock 对端进程内状态承载 | ✓ `SurfaceScanResolver`：DigestResolver 的 run 层实现，以严格 4 工具面内只读免审批的 `atf_surface_scan` 为查询通道（复用契约 canonical 校验）；mock 工具内状态（admittedFacts）即 journal 事实源；真实对端待 re-pin 接入，同 S1/S2/S3 口径 |
| 4 | B4 退出码 = 1，不走 78（78 专属 approval_missing 不扩用）；`resolveHeadlessExitCode` 单一出口纪律不变，会话层拒绝映射在同一文件登记 | ✓ `src/run/runner.ts` 内 `resolveRunExitCode()`：completed→0；approval_missing→**经 S3 `resolveHeadlessExitCode` 锚点决出 78**；session_rejected / failed→1；B4 实测 exit 1 |
| 5 | B2 自纠由脚本顺序表达；验证点是 block 回填会话且可重放，非模型行为 | ✓ B2 序列 = gate 先行（canonical 内 `status: blocked / evidence_missing` 业务信号）→ admit 补证据 → 重提 pass；测试断言首次 gate 的 tool/result 事件在会话流内且 replay 可重建该事件 |
| 6 | runner 使用 `GuardedSessionLog`；provenance 的 run_id / trigger_instruction 切换为场景脚本注入 | ✓ `GuardedSessionLog.create(sessionLogPath, SurfaceScanResolver, scratchDir)`（B4 天然获得拒绝能力）；每分支 `run_id` / `trigger_instruction` 来自场景脚本注入 `RunWorkspace.create`——S4 口径 #2 兑现 |

## 3. 任务书 §5 七项总验收（逐项打勾）

- ✅ **B1 exit 0，G2 GateResult = PASS，证据链闭合**——gate tool/result 携带准入事实三元组 domain_refs（digest 经 SurfaceScanResolver 对 mock journal 校验通过）；`tests/run/scenario.test.ts` + smoke:s5 [2][3]
- ✅ **B2 block → 自纠 → PASS**——gate 序列 blocked(evidence_missing) → pass；block 事件落盘可重放
- ✅ **B3 exit 78**——无预录 → `blocked(approval_missing)` 即终局，`resolveRunExitCode` = 78（经 S3 锚点）
- ✅ **B4 引用被拒（铁律一）**——`cite_t0` 引用真实 scratch 产物（digest 取自文件字节）→ `GuardedSessionLog` 拒绝，事件不落盘，exit 1 + `t0_ref_forbidden`
- ✅ **四分支会话 log 全部可重建；digest 校验全部通过**——四分支 replay 全部 `replayed` 且 blocks 为空、内存序列与磁盘逐条一致（B1 13 / B2 12 / B3 5 / B4 3 条）
- ✅ **T0→T1 晋升演示路径在 B1 中执行一次并登记 sha**——B1 catalog 恰一条登记，sha256 = artifacts 产物字节（smoke:s5 [3] 实测 `8747c8721c10…`）
- ✅ **全程零 GPU、零真实 Provider、零内核仓改动（git diff 为空）**——FauxProvider 无网络路径；对端为本地 node mock 子进程；pin 副本 `git status` 0 条、HEAD `a628f8b` 未动

## 4. 场景脚本校准对照表（owner 口径 #2：draft-v0 → v1，语义不变）

| # | draft-v0（docs/admission-to-g2.json） | v1（scenarios/admission-to-g2.json） | 校准说明 |
|---|---|---|---|
| 1 | `version: "draft-v0"` | `version: 1` | 定稿版本位 |
| 2 | `branches` 数组（元素带 `branch_id`） | `branches` 对象映射（键 = branch_id，解析层强校验一致） | 消除键/字段双写漂移 |
| 3 | `setup.ledger_pre_record: [{operation, binding}]`，binding 含 `<fixture_sha>` 占位符 | `setup.ledger: [{tool, params}]`，params 显式全量（如 `{dataset_id: "ds-ten-doc-round3"}`） | 审批键 = tool + params digest 严格绑定（S3 契约）；预录与调用同 params 显式重复可审计；占位符全部替换为真实 fixture 引用（mock 对端 fact = `fact-<dataset_id>`） |
| 4 | `setup.scratch_fixture`（声明式夹具） | 显式步骤 `{type: "scratch_write", path, content}` | 夹具表达统一进决策序列（runner 单遍执行，无隐式 setup 写盘） |
| 5 | `atf_workspace_status` / `atf_surface_scan` 带 `arguments {run_id / scope}` | `params: {}` | 对齐 S3 契约（两工具为无参只读面） |
| 6 | `atf_gate` action `"evaluate"` | `"advance"` | 对齐 S3 契约枚举（query \| advance） |
| 7 | `atf_promote_scratch` 作为 tool_call | runner 内置步骤 `{type: "promote", source, command}` | **owner 口径 #1**：晋升是 harness 本地动作（晋升闸 A），不进工具注册表 |
| 8 | `repro_command: "python scratch/… --dry-run"`（字符串，脚本自运行） | `command` argv 数组 + node -e 生成器 | 对齐 S4 晋升闸 A 复现语义：**stdout 字节 = 产物字节**；复现由 harness 侧子进程执行、不调用真实内核（owner 口径 #3） |
| 9 | B2 自纠 = surface_scan 后直接重提 | B2 自纠 = `atf_admit_data` 补证据后重提 | mock gate 证据语义 = 已准入事实（严格 4 工具语义不变）；"补证据"落在准入动作上，block→自纠→PASS 语义不变 |
| 10 | B4 = gate evidence_refs 携带 scratch 路径（工具参数层拦截） | B4 = `{type: "cite_t0", source}` 独立步骤（会话层引用尝试） | **owner 口径 #4/#6**：T0 拒绝在会话层（GuardedSessionLog），非工具参数校验；"gate_never_reached" 语义保留（拒绝先于任何工具调用） |
| 11 | `expectations` 自由字段（`"G2=PASS"` 等） | `expect` 受控枚举（outcome / exit_code / gate_status / first_gate_status / block_reason / promoted / replayable / domain_refs_valid） | runner `evaluateExpectations` 可计算核验，违例结构化列入报告 |
| 12 | B4 `exit_code_nonzero: true` | `exit_code: 1` | **owner 口径 #4**：会话层拒绝不走 78，精确锚定 1 |
| 13 | `run_id: "<run_fixture>"` 占位符 | 每 branch 真实 `run_id`（`s5-b1-admission-g2` 等）+ `trigger_instruction` 字段 | 注入 provenance（owner 口径 #6）；run_id 白名单 `[A-Za-z0-9][A-Za-z0-9._-]*` 防路径逃逸（解析层强制） |
| 14 | `tool_call.arguments` | `tool_call.params` | 字段名对齐工具层实现 |

## 5. 偏离与自主决策点（均在授权范围内，供 owner review 知悉）

1. **会话事件序列形态**：`turn/start → user/message(trigger_instruction) → [assistant/message | (tool/call + tool/result)]* → assistant/message(final) → turn/end`。工作区动作（scratch_write / promote）不落会话事件（非会话语义，7 类型白名单不扩）；被拒引用事件不落盘（S4 既有语义）。
2. **tool/result payload 形态** `{tool, ok, result | reason + block/detail}`——S3 四终态在会话流的结构化回填；B3 的 approval_missing block 亦回填留痕（终局前最后一条 tool/result）。
3. **`cite_admitted_fact` 机制**：gate 步骤声明后，runner 把最近一次成功准入的事实三元组作为该步 tool/result 的 domain_refs——证据链闭合的脚本化表达；digest 由 mock 对端产出，经 SurfaceScanResolver 校验后才落盘（B2 重提同法）。
4. **SurfaceScanResolver 以 `atf_surface_scan` 为查询通道**：不动工具面、不新增方法（口径 #3 的最小实现）；canonical 校验复用 `TOOL_DEFINITIONS` 登记，故障 → `err(resolver_failure)`（会话层语义：不落盘、不标记、不猜测）。
5. **分支终局语义**：approval_missing 即终止（headless 账本轨：无自动应答、不重试）；cite_t0 被拒即终止；铁律一未拦截 = harness 故障（fail-closed 折算 failed）。终局分支补 `turn/end` 收口；收口写失败**不覆盖** 78 / 会话拒绝终局语义（仅 completed 分支折算失败）。
6. **runner fresh 语义**：默认清理同 run_id 既有工作区（验收运行防既有流污染，`SessionLog` 续写语义不受影响）；run_id 白名单在解析层强制。
7. **B3/B4 的 final_answer 步骤按 draft 保留作叙事存档**，执行中不可达（分支在 block 处终局）；已在脚本 notes 登记。
8. **场景脚本 schema 未新登记契约文件**：v1 步骤 schema 内聚于 `src/llm/scenario.ts`（严格白名单解析，反例 8 项测试锚定）；场景脚本属"随所属 phase"资产（AGENTS.md §2），bridge/session/workspace 三契约文件零改动。

无与任务书/指令冲突的偏离；`src/session/`、`src/bridge/`、`src/tools/`、`src/workspace/`、三份契约 yaml、`tests/fixtures/mock_atf.mjs` **零改动**（git status 佐证：计划内改动仅 package.json 新增 smoke:s5）。

## 6. 执行记录与验证记录（指令 §2 执行 1–3）

| 项 | 命令 | 结果 |
|---|---|---|
| S4 闭合 push | `git push origin main` | ✓ `2526532..89510d1`，tip = `89510d1` |
| 类型检查 | `npm run typecheck` | ✓ 0 error |
| 全量测试 | `ATF_CLI_PATH=<本仓>/.atf-pinned npx vitest run` | ✓ **16 文件：109 passed / 2 skipped**（S1 26+2 / S2 30 / S3 20 / S4 19 零回归；S5 新增 14） |
| 七项总验收 | `npm run smoke:s5` | ✓ 全过（四分支 + 打勾表逐项，真实退出码 0） |
| 手工冒烟 | `smoke:s1 -- --mock` / `s2` / `s3` / `s4` / `s5` | ✓ 五条全过 exit 0 |
| pin 校验 | `.atf-pinned` HEAD = `a628f8b8e23beff104b42b5c80088416ea78b394`（v0.2.0b7），status 0 条 | ✓ 一致、干净，未追新 |
| 内核仓改动 | — | 零改动 |

## 7. Phase 1 闭合——五切片回顾

| Slice | 落点 | 特性 commit | 报告 commit | 测试数 | 关键决议（owner 已批准为正式口径） |
|---|---|---|---|---|---|
| S1 桥接层 | `src/bridge/` | `be7b603` | `c54735c`（+ `2ac5003` 决议登记、`29ff9df` 脱敏、`e8327b4` 闭合简报） | 26 passed + 2 skipped | 三类帧维持不设第四类（①1）；内核 JSONL 能力在 ATF 仓排队（②1）；脱敏整改（③1） |
| S2 会话事件流 | `src/session/` | `80386f6` | `b68539c` | 30 | DigestResolver 注入口（内核 digest 查询落地前的承载）；ref_invalid 留痕 + 结构化 block；append-only JSONL 落盘形态 |
| S3 工具注册表 + 账本审批 | `src/tools/` | `cb94fd7` | `2526532` | 20 | requires_approval 分流；ledger_record 非运行时方法面；审批键 digest 算法契约登记；canonical 零依赖方言（properties 即白名单）；`resolveHeadlessExitCode` 单一出口；mock 对端 S1 行为零改动 |
| S4 三层工作区 + 晋升闸 A | `src/workspace/` | `4f0f643` | `89510d1` | 19 | tmp/runs 宿主；workspace.contract.yaml 分文件；复现语义具体化（stdout 字节比对）；铁律一 GuardedSessionLog 包装且规则覆盖全部携带 domain_refs 的事件；写入顺序与回滚；provenance 重开语义；catalog 失配 fail-closed |
| S5 Faux 冒烟闭环 | `src/llm/` + `src/run/` + `scenarios/` | 本轮 | 本报告 | 14 | 见本报告 §5（八项） |

Phase 1 终态：**109 passed / 2 skipped，五条冒烟全过，七项总验收全过，四层工具面/会话面/工作区面/运行面契约登记齐备（bridge / session / workspace 三 yaml + 场景脚本 v1），零内核仓改动。**

## 8. Phase 2 待决事项清单（提请 owner 排期，未获指令不启动）

**A. 本仓顺延项（任务书 §7 登记）**
1. **compaction**（含领域事实白名单逻辑）——S2 只留 `transformContext` 签名，内部逻辑待长。
2. **多 provider / 热切换（R2b 升级评估）**——`src/llm/provider.ts` LlmProvider 接口已定死，单实现（Faux）即可起步。
3. **交互壳实时问答轨**（ADR-07 第二轨）——本阶段仅账本轨。
4. **T2 晋升闸 B 实现**——contracts 层本阶段只读（目录存在 + 清点）。
5. **会话落盘 fsync 策略**（session.contract.yaml durability 注记）——Phase 1 冒烟量级不依赖断电级持久性。

**B. 双仓对接前置（内核能力落地 → re-pin）**
6. **ATF 仓 backlog 兑现**（owner 决议 ②1 立项已批准）：JSONL RPC 会话模式 + 版本子命令 + fact digest 查询能力。落地后按 AGENTS.md §4 re-pin 三步走，harness 侧接入：S1 真实 CLI 会话断言、S2 `DigestResolver` 真实实现（替换 SurfaceScanResolver 承载）、S3 ledger 三方法与 4 工具真实对端、S5 "run journal 对应事实"真实承载。

**C. Phase 1 收尾待决议**
7. **milestone tag `v0.1.0` 打点**（任务书 §8.1：Phase 1 冒烟 7 项验收通过即打）——待 owner 确认本报告后由 owner 或指定会话执行。
8. **Phase 1 复盘与 Phase 2 范围讨论**（任务书 §6 DoD：owner 在任务书标记 CLOSED 后进入）。

**D. 远期（不变）**
9. ACP / JSON-RPC server（Phase 3）、projection 字段激活 / TEM 回灌（Phase 3）、TUI/Web 壳（Phase 4 条件项）；两仓永不合并。

## 9. 改动文件清单

新增（实现）：
- `src/llm/provider.ts` — LlmProvider 接口 + LlmDecision + LlmError（Phase 2 真实 provider 的抽象面）
- `src/llm/fauxProvider.ts` — FauxProvider 脚本线性回放（零网络路径）
- `src/llm/scenario.ts` — 场景脚本 v1 schema 与严格白名单解析（六类步骤）
- `src/llm/index.ts` — LLM 层公开出口
- `src/run/surfaceScanResolver.ts` — DigestResolver 经 atf_surface_scan 的 mock 承载（口径 #3）
- `src/run/runner.ts` — ScenarioRunner（决策分派 / 统一退出码 `resolveRunExitCode` / 期望核验 `evaluateExpectations`）
- `src/run/index.ts` — run 层公开出口
- `src/run/smoke.ts` — S5 手工冒烟（七项总验收打勾表）
- `scenarios/admission-to-g2.json` — 场景脚本 v1 定稿（draft-v0 校准，对照表见 §4）

新增（测试）：
- `tests/llm/scenario.test.ts`（2：v1 定稿解析 + 反例族 8 项）
- `tests/llm/fauxProvider.test.ts`（3：线性回放 / 耗尽 null / 场景→决策链集成）
- `tests/run/scenario.test.ts`（6：B1–B4 四分支 + 退出码映射 + 未知分支守卫）
- `tests/run/surfaceScanResolver.test.ts`（3：命中/未命中/canonical 破损/桥接故障）

修改（计划内）：
- `package.json` — 仅新增 `smoke:s5` script（`dependencies` 保持不存在）

## 10. 下一步

1. owner review 本报告（重点 §5 决策点 3/5 与 §4 校准对照表 9/10 两处语义微调）。
2. review 通过后决议 S5/Phase 1 产出的 push、`v0.1.0` tag 打点与任务书 CLOSED 标记。
3. 本会话按指令**停在 Phase 2 议题前**——上述 §8 清单任何一项未获指令不启动。
