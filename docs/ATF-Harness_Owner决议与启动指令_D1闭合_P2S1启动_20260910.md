# ATF-Harness Owner 决议与启动指令——D1 闭合（含 C7 修订）+ P2-S1 启动

**签发人**：owner
**日期**：2026-09-10
**执行人**：zcode（A800_5005:/data/sam/ATF-Harness）
**依据**：《ATF-Harness_Owner启动指令_Phase2_D1_20260910.md》+《ATF独立Harness_Phase2任务书_20260910.md》+《ATF-Harness_P2S2审批应答语义设计草案_20260910.md》+ D1 产出（`fc1fda2` D1 文档 / `47d5bc3` D1 执行报告）
**结论先行**：**D1 验收通过，但需一处 P0 级修订（C7）；四项裁决已定；D1 修订版出后升格 ADR-09 ACCEPTED；P2-S1 现在启动——不等修订完成。只做 P2-S1，完成即停，P2-S2 未获指令不得启动。**

---

## 1. D1 验收（owner 独立复核，非转述）

| 验收项 | 复核方式 | 结果 |
|---|---|---|
| 覆盖任务书 §1 五节 | 通读 D1 文档 §1.1–§1.5 | ✅ 五节齐备 |
| 吸收 P2S2 §5 schema 结论 | 逐项比对四项 | ✅ 全量吸收；增补 `request_event_ref`（最小增量，已声明理由） |
| 不实现项清单与任务书 §5 一致 | 清单 9 项比对 | ✅ 前 5 项逐项一致；含条件项触发核查（不触发闸 B、不触发 re-pin） |
| 未越界传输层 | 核查 §3.6/§4.2 | ✅ JSON-RPC 帧、进程模型、鉴权、凭据句柄、事件流通道均归 Phase 3 |
| 测试基线 | **owner 复跑**（19:18，`ATF_CLI_PATH=.atf-pinned npm test`） | ✅ `109 passed / 2 skipped`，16 文件全过，2.81s |
| 内核仓只读 | **owner 复核** `.atf-pinned` HEAD | ✅ `a628f8b` 未动 |
| 改动面 | **owner 复核** 三笔提交 `--stat` | ✅ `docs/` 三处（5+1+1 文件），**零 `src/`、零契约 yaml 改动** |
| 提交纪律 | `git status` / `git log` | ✅ 三笔本地提交（`c1e4a72`/`fc1fda2`/`47d5bc3`），未 push |

**评审补充结论（owner 判断，非 zcode 缺口）**：D1 主体质量达标——11 类事件一次定死、投影三层白名单、状态机六态且 78 锚点不挪用、§5.1 十二条对账无冲突，均予认可。唯一问题是 C7 的方法面依据（见 §2.1）。

---

## 2. 四项裁决

### 2.1 C7 改判：应答即授权凭据，不运行时落账本（P0）

**问题事实**：D1 §1.3 C7 将「问答 granted 回流」实现为「先经桥接 `ledger_record` 落一次性 ApprovalRecord，再走账本轨消费」。但 `bridge.contract.yaml` 第 92 行与第 223 行两处均明确登记：`ledger_record` **仅为测试/冒烟 setup 基建，非运行时方法面**。mock 口径下 MockLedger 能承载，故测试全绿掩盖了该问题；对真实内核（C1 re-pin 后）无依据成立。若强行使用，等于把 `ledger_record` 提升为运行时方法面——按契约登记规则属「既有方法语义变更」，须走契约变更流程（显式 PR + 双仓契约测试 + owner review + bump `contract_version`）且需内核侧确认可写账本，构成对内核主线的插队（Phase 1 §8.3 唯一串行点）。

**正式口径（改判）**：
1. 问答轨的一次 `granted` **不以写入内核账本为前置**。应答事件本身（`approval/response`，带 `actor` / `request_event_ref` / `approval_key`）即**授权凭据**，与账本记录并列成为审批检查点的两类依据：
   - 依据一（账本轨）：`ledger_query` 命中且未消费的记录 → 消费放行（**语义零改动**）；
   - 依据二（问答轨）：本 run 内同一 `approval_session_id` 的 `granted` 应答事件，且未被消费（一次性）。
2. **ADR-07 表述精化（文字级增补，不动机制）**：授权真相源 = **账本记录 ∪ 已 granted 且未消费的问答会话**；两类来源各自留痕、互不替代、互不豁免。
3. **`ledger_record` 在 Phase 2 一律不得作为运行时路径使用**（仅 setup 用途，如冒烟预录）。
4. fails-closed 性质必须逐条保持：没有真实应答事件落盘 → 无授权凭据 → 不执行；账本查询故障 → 不猜测通过（Phase 1 既有口径）。
5. 「是否将问答授权并入内核账本（`ledger_record` 运行时化）」**登记为 C1 re-pin 后的议题**，由内核实际能力实测后决议，本轮不做、不探索。
6. S2 要求 5 的「账本轨零改动」继续成立；executor 审批检查点接受第二类依据属 S2 实现范围（任务书未要求 executor 零改动）。

### 2.2 退出码映射定案（D1 开放点 b）

| 终态/非终态 | 退出码 | 语义 |
|---|---|---|
| `completed` | **0** | 正常收束 |
| `blocked` | **78** | `approval_missing`（锚点，不挪用） |
| `failed` | **1** | 系统/对端/桥接/工作区故障 |
| `suspended` | **75** | 非终态，可恢复（EX_TEMPFAIL 语义：暂时无法继续，resume 可续） |
| `aborted` | **79** | 终态，主动终止（harness 自定义码，登记入契约） |

三项要求：① 映射仍经 `resolveHeadlessExitCode()` **单出口**；② 75/79 为新增码，需在契约文件登记，**不改既有 0/78/1 语义**（故不触发 `contract_version` bump，属枚举补登，请按契约登记纪律办理并在变更描述中说明）；③ 终局语义保护条款延续（终态不被后续写失败覆盖）。

### 2.3 C9 provider 注入定案

采用 **B（harness 自管）为基线、A（宿主注入）为 Phase 3 增强**。Phase 2 只实现自管路径；dispatch 载荷的覆盖语义按 D1 §1.4 已定义口径保留，Phase 3 启用时消费面零改动。两条红线不变：凭据与端点不进载荷明文、不进会话事件；配置取值变更必落 `provider/switch` 事件。

### 2.4 D1 修订与升格时序

**修订后升格，P2-S1 同步启动。** 修订为文档级最小改动，不与 S1 开工串行。

---

## 3. D1 修订要求（最小范围，不得夹带其他改动）

产出 D1 文档 **v1.1**，仅改动以下位置：

| # | 位置 | 改动 |
|---|---|---|
| 1 | 文首状态块 | 候选(DRAFT) → **ACCEPTED（ADR-09）**，注明 owner 决议日期与本决议文档名 |
| 2 | §0 结论表 C7 行 | 改为「应答即授权凭据：账本记录 ∪ 已 granted 未消费的问答会话，两类依据并列」 |
| 3 | §0 结论表 C2 行 | 补入退出码映射 0 / 78 / 1 / 75 / 79 |
| 4 | §0 结论表 C9 行 | 标注「owner 已裁决：B 基线 + A 增强（Phase 3）」 |
| 5 | §1.3 C7 段 | 按 §2.1 口径重写；新增「ADR-07 表述精化」小节；删除「经 `ledger_record` 落记录」的运行时表述，改为「凭据来源二」；保留 fails-closed 论证 |
| 6 | §1.3 往返时序图 | `granted` 分支改为「凭据化 → 审批检查点依据二 → 放行执行」，并标注 `ledger_record` 为 setup-only |
| 7 | §1.1 状态机表 | `suspended` = 75、`aborted` = 79 落表（原「见开放点」改为定案） |
| 8 | §1.4 provider 节 | 「建议（待 owner 裁决）」→「裁决：B 基线 + A 增强」 |
| 9 | §5.1 对账表 | 更新 C7/S2 要求 2/4 行的对账结论；新增 `resolveHeadlessExitCode()` 映射对账行 |
| 10 | §5.3 开放点 | (b) 退出码 → 已裁决（移入定案）；(a)(c) 保留；新增 (d) 授权凭据的消费状态记录形态（S2 定） |
| 11 | 文末 | 新增「修订说明」块：v1.0 → v1.1 改动清单 + 依据本决议 |

**禁止**：不改动 §1.1 载荷四要素、§1.2 事件集合与投影白名单、§1.5 透出模型、§3 不实现项、§4 边界声明；不新增结论编号（C1–C12 编号体系保持）。

---

## 4. P2-S1 启动指令

> 依据：《ATF独立Harness_Phase2任务书_20260910.md》§2（S1 设计要求 1–8 与验收 6 项）+ 本决议 + D1 文档 C4/C5。

**范围**：`src/session/` 的 compaction + fsync（任务书 §2 全部 8 条设计要求）。**不改** `src/bridge/`、`src/tools/`、`src/workspace/`、`src/llm/`、`src/run/`；如发现必须改动其他模块才能完成 S1，停下来提请 owner。

**owner 预先拍板口径（实现时直接采用，无需再问）**：

| # | 事项 | 口径 |
|---|---|---|
| 1 | schema v1 事件集合 | **11 类一次定死**（v0 七类 + `approval/request` + `approval/response` + `session/compaction` + `provider/switch`），本 slice 完成 v0 → v1 bump + 迁移说明；**本 slice 只 emit 前 8 类 + `session/compaction`**，approval/provider 类为保留位——**未实现类型不得被写入**（未知或未启用 type 一律拒绝写入，沿用 v0 白名单纪律） |
| 2 | compaction 触发阈值 | 双指标（事件数 + 估算 token），常量定义、模型不可见；具体初值由你定并登记 `session.contract.yaml`，附选取理由 |
| 3 | 白名单逻辑 | `domain_refs` 命中事件及其相邻因果链永不压缩；判定为**纯函数**、可独立单测 |
| 4 | fsync | 默认逐条（已确认事件永不丢）；批量窗口（N 条 / T 毫秒）为可配置性能档位，收在常量层，模型不可见；两档语义差异写入 `session.contract.yaml` |
| 5 | 版本登记 | **会话事件 schema 版本迭代不 bump `bridge.contract_version`**（该文件仅帧格式 / 握手 schema / 既有方法语义变更才 bump）；在 `session.contract.yaml` 登记 v1 并在变更描述中标记「会话 schema v1」 |
| 6 | 崩溃恢复测试 | 写入中途 kill 进程 → replay 校验已确认事件无缺失，逐条档 / 批量档各一组 |
| 7 | 禁用项 | 不得使用 `ledger_record` 或任何 setup 基建方法作为运行时路径；不得新增桥接方法面 |

**执行序列**：
1. 阅读任务书 §2 + 本指令 + D1 文档 §1.2（C4/C5）；与本指令冲突时以本指令为准并报告差异。
2. **先做 D1 修订版（v1.1）并入库提交**（§3 清单，建议信息 `docs(phase2): D1 文档升格 ADR-09 ACCEPTED（C7 改判授权凭据 / 退出码定案）`），本决议与启动指令随之入库（建议信息 `docs(owner): D1 闭合决议 + P2-S1 启动指令`）。
3. **BUILD**：`src/session/` 实现（compaction + fsync + schema v1）。
4. **VERIFY**：任务书 §2 六项验收（压缩触发正反例 / 白名单豁免 / 压缩事件重建 / fsync 双档崩溃恢复 / schema v1 迁移可 replay / 基线零回归），附 `ATF_CLI_PATH=.atf-pinned npm test` 复跑输出。
5. 产出《ATF独立Harness_Phase2_P2S1执行报告_20260910.md》（执行记录 / 验收对照 / 偏离与决策点 / 提交清单）。
6. **提交本地保存，不 push**；完成即停，P2-S2 未获指令不得启动。

---

## 5. 纪律不变条款

1. 内核仓只读：pin `v0.2.0b7` / `a628f8b` 不动；无 re-pin 指令不得涉及。
2. 测试基线 **109 passed / 2 skipped 不得回归**；BUILD/VERIFY 分离。
3. 零 npm 运行时依赖（R2a）；`dependencies` 保持为空。
4. 无 GPU、无真实 LLM Provider、无网络模型调用。
5. 条件项（P2-S4 闸 B、C1 re-pin、以及本轮新登记的「问答授权并入内核账本」）未触发前，不得开展相关探索性调研、不得预写代码。
6. 禁止顺手优化；遇设计不合理处报告并等决策。
7. 契约流程：`bridge.contract.yaml` 变更须显式 PR + 双仓契约测试 + owner review + 双仓 bump `contract_version`；`session.contract.yaml` 变更按口径 #5 办理。
8. 脱敏纪律延续。
