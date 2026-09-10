# ATF 独立 Harness Phase 2 任务书——能力扩展（Codex 直接执行）

> 日期：2026-09-10 ｜ 前置：**Phase 1 已 CLOSED**（tag `v0.1.0`，109 passed / 2 skipped，S1–S5 全闭）
> 执行方：Codex ｜ 执行环境：本地 Mac 开发目录，**不依赖 A800 GPU**
> 决策基线：Phase 0 四项 ADR（05/06/07/08）＋《ATF-Harness_Phase2规划设计_20260910.md》＋《ATF-Harness_Owner决议_Phase2范围确认与任务书签发_20260910.md》＋《ATF-Harness_P2S2审批应答语义设计草案_20260910.md》
> 原则：**能力扩展，不改架构**——Phase 2 全部落点在 Phase 1 已预留的占位上（`transformContext` / `LlmProvider` / S3 审批位 / S4 contracts 层），不新增架构级决策

---

## 0. 任务总览

| # | Slice | 落点 | 依赖 | 性质 |
|---|---|---|---|---|
| D1 | ACP 消费面设计定型 | `docs/`（仅文档） | Phase 1 已完成 | 文档产出，无代码 |
| P2-S1 | 会话能力升级：compaction ＋ fsync | `src/session/` | D1 review 通过 | 代码 + 测试 |
| P2-S2 | 交互问答审批轨（六类应答语义） | `src/tools/` ＋ `src/run/` | D1、P2-S1 | 代码 + 测试 |
| P2-S3 | 多 provider 与热切换 ＋ R2b 评估 | `src/llm/` | P2-S1 | 代码 + 测试 + 评估文档 |

**条件项（本轮不做，仅登记）**：P2-S4 晋升闸 B、C1 真实对端接入（re-pin）。触发条件见 §5。

**一句话目标**：在 Phase 1 headless 冒烟骨架上，补齐长会话处理能力（compaction / fsync）、审批第二轨（交互问答）、模型适配面（多 provider），使 harness 具备 Phase 3 宿主嵌入所需的全部前置能力，全程仍为零真实 Provider、零 GPU、内核仓零改动。

**硬约束**：
- ❌ 不修改 ATF 内核仓任何文件（pin `v0.2.0b7` 不动；atf CLI 仅以子进程调用）
- ❌ 不调用真实 LLM Provider、不启动真实训练、不碰 GPU（Phase 2 全程 Faux/stub 对端）
- ❌ 不引入 npm 运行时依赖（`dependencies` 必须保持为空；任何变更仅可经 §4 的 R2b 流程 + owner 确认）
- ❌ 不实现 ACP / JSON-RPC server（D1 只出设计文档；server 属 Phase 3）
- ❌ 不做 TUI / Web 界面；不激活 `projection` 字段（TEM 回灌属 Phase 3）
- ❌ 不实现 P2-S4 晋升闸 B、不做 re-pin（条件项，触发前不得开展探索性调研）
- ✅ 会话 log 与工作区写操作先落盘再继续（append-only，崩溃可重建）；fsync 语义按 §2 明确到位
- ✅ 每个 slice 独立可验收（vitest 用例 + 冒烟命令），完成一个 review 一个
- ✅ 测试基线 **109 passed / 2 skipped 不得回归**
- ✅ agent 每步提变更描述，由 codex 改；未经 owner 批准不 push / merge

---

## 1. D1 ACP 消费面设计定型（仅文档）

**目的**：在写第二轨与多 provider 代码之前，先把「harness 作为宿主子代理被外部编排方调用」的消费面定死，使 P2-S2 的事件 schema 与 P2-S3 的切换粒度有锚点，避免 Phase 3 返工。

**设计要求**：
1. 产出《ACP 消费面定型（ADR-09 候选）》，至少覆盖五项：dispatch / resume 的调用形态；会话事件向宿主的投影白名单；审批请求经宿主转达与应答回流的形态；provider 配置的注入来源（宿主注入 vs harness 自管）；多轮审批会话如何透出。
2. **必须吸收《P2S2 审批应答语义设计草案》§5 的 schema 结论**：审批会话模型（`approval_session_id` ↔ `tool_call_id` 配对）、六类应答事件建模（统一 `approval/response` + `verdict` 枚举）、`supersedes` 提案演化链、`actor` 应答者身份。
3. 明确声明与 Phase 3 的边界：本文档只定消费面，不含 server 实现、不含网络协议栈选型实现。
4. 不写代码、不改仓内实现；若结论要求调整 S2 / S3 的设计要求，提出**条款级修订建议**，不自行修改规划文档。

**验收**：
- 文档交 owner review 通过；
- P2-S2 / P2-S3 任务书条款可逐条引用其结论；
- 文档内含「Phase 2 不实现项」清单，与 §5 条件项登记一致。

---

## 2. P2-S1 会话能力升级：compaction ＋ fsync（`src/session/`）

**目的**：把 Phase 1 预留的 `transformContext()` 占位升级为真实实现，并把「先落盘再继续」承诺的持久性语义显式定死。

**设计要求**：
1. **compaction 真实实现**：`transformContext()` 由拼接占位升级为压缩实现；触发采用双指标（事件数 + 估算 token，常量定义，不暴露给模型）。
2. **摘要事件与 schema bump**：压缩产出摘要事件（新增 `session/compaction`），会话 schema 由 v0 → v1 **显式 bump**，并给出迁移说明（旧会话可 replay）。
3. **append-only 不变**：原始事件在磁盘上不删不改，压缩只影响投给模型的投影视图；replay 后投影一致。
4. **领域事实白名单**：`domain_refs` 命中的事件及其相邻因果链**永不压缩**；白名单判定逻辑纯函数化、可独立单测。
5. **压缩自身可审计**：压缩动作作为事件落盘，可追溯「哪次压缩吃掉了哪些事件」。
6. **fsync 语义（owner 决策四口径）**：默认逐条 fsync（已确认事件永不丢）；批量窗口（N 条 / T 毫秒）作为可配置性能档位；两者均收在常量层，模型不可见。
7. **durability 契约文档化**：在写入路径注释 + 契约文件增补字段中明示两档语义差异。
8. **崩溃恢复测试**：写入中途 kill 进程 → replay 校验已确认事件无缺失（逐条档、批量档各一组）。

**验收**：
- 压缩触发正反例（达阈值触发 / 未达阈值不触发）；
- 白名单豁免用例（含 `domain_refs` 的事件在压缩后仍在投影中）；
- 压缩事件重建用例（replay 后投影逐条一致）；
- fsync 双档崩溃恢复用例；
- schema v1 bump 后既有会话可 replay；
- **109 passed / 2 skipped 基线零回归**。

---

## 3. P2-S2 交互问答审批轨（`src/tools/` ＋ `src/run/`）

**目的**：落地 ADR-07 第二轨，并完整实现六类应答的分支处置（owner 决策六口径）。

**设计要求**：
1. **审批会话模型落 schema v1**：`approval/request` + `approval/response`（`verdict ∈ granted | advised | denied | aborted | clarification | timeout`）；字段含 `approval_session_id`、`tool_call_id`、`supersedes`、`actor`。
2. **六类应答分支处置**（严格依《P2S2 设计草案》§2）：
   - `allow` → `granted` → 执行该次调用 → 结果回填 → 继续；
   - `advise` → `advised`（意见原文必留）→ 回填模型，**由模型重新提案**（新 request 带 `supersedes`），不自动改写参数执行；
   - `deny` → `denied` → 结构化 block 回填 → 模型可换路径；
   - `abort` → `aborted` → run 终态，按既定退出码结束；
   - `ask_back` → `clarification` → 补上下文后重发 request，配对同一审批会话（多轮往返）；
   - `timeout` → `timeout` → run 挂起（suspend），**不等同于拒绝**。
3. **拒绝循环防护**：同一提案（工具名 + 参数摘要）重提计数，达 2 次即升级（abort 或上报）；阈值取常量。
4. **无配额复用**：一次 `granted` 不产生可复用授权，后续步骤仍需独立审批。
5. **双轨并存规则**：账本轨优先——先查账本，未命中再走问答轨；**账本轨语义零改动**（一次性消费、退出码 78 锚点）。
6. **headless 等价性**：headless 场景下问答对端缺省 = 无应答 → 行为与 Phase 1 完全一致。
7. **对端形态**：Phase 2 使用测试桩对端；**不接真实宿主、不做界面**（界面属 Phase 3）。
8. **退出码纪律**：仍走 `resolveHeadlessExitCode()` 单出口；终局语义保护条款（终态不被后续写失败覆盖）延续。

**验收**：
- 六类应答各一组正例 / 反例；
- 多轮 `clarification` 往返配对到同一审批会话；
- `supersedes` 提案演化链可审计（可回答「最终执行的是基于哪条意见改出来的」）；
- 拒绝循环升级用例（重提第 3 次触发升级）；
- 账本轨全量既有用例零改动通过；
- headless 等价性用例（无对端时与 Phase 1 行为一致）。

---

## 4. P2-S3 多 provider 与热切换（`src/llm/`）

**目的**：把 `LlmProvider` 抽象从单实现扩展为可切换，并完成 R2b 评估。

**设计要求**：
1. **第二 Provider 实现**：仍为脚本化 Faux 变体；**不接真实 Provider、不产生网络调用**。
2. **热切换语义**：仅允许在 turn 边界切换；切换事件落盘（如 `provider/switch`）；切换前后 `domain_refs` digest 校验保持连续。
3. **R2b 评估（owner 决策五口径）**：产出结论文档——多 provider 需求下 R2a（零外部依赖）是否维持；若建议引入外部依赖，需给出理由、替代方案与影响面，**交 owner 确认**；未获确认前 `dependencies` 保持为空。
4. **场景脚本扩展**：新增同会话两 provider 交替完成的冒烟分支（可新增 scenario 文件，命名沿用现有约定）。

**验收**：
- 交替分支冒烟通过（两 provider 在同一会话内各完成若干 turn）；
- turn 边界外切换被拒的反例；
- R2b 结论经 owner 确认；
- `package.json` 的 `dependencies` 仍为空。

---

## 5. 条件项登记（本轮不做，触发后另行立任务书）

| 条件项 | 触发条件 | 触发后动作 |
|---|---|---|
| P2-S4 晋升闸 B | 出现真实消费面需求（如 D1 结论要求 harness 侧管理 T2，或内核契约演化需冻结区配合） | 单项任务书：T2 冻结区写入通道 = 决策记录 + 审批（双轨之一）+ 原子变更 + `bridge.contract.yaml` 一致性检查 |
| C1 真实对端接入（re-pin） | 内核侧 stdio JSONL 会话能力发版落 tag → owner 签发 re-pin 专项指令 | bump `atf_upstream` → 启用 2 个 skipped 契约用例 → mock 对端逐项替换 → 契约测试全绿 |

**纪律**：条件项未触发前，不得开展相关探索性调研，不得预写相关代码。

---

## 6. 执行流程与禁止事项

1. **顺序执行**：D1（文档）→ owner review → P2-S1 → P2-S2 → P2-S3；每个 slice 完成 = 代码 + vitest 用例 + 自测命令输出 + 变更描述，**交 owner review 后**才进下一个。
2. **BUILD/VERIFY 分离**：verify 阶段不改实现，失败回新 build task。
3. ❌ 未经 owner 显式授权：不 push / 不 merge / 不删分支 / 不碰真实 Provider / 不碰 GPU / 不动内核仓。
4. ❌ 不擅自"顺手优化"：遇设计不合理处报告并等决策，不自行实现。
5. **契约流程**：`bridge.contract.yaml` 变更 = 显式 PR + 双仓契约测试 + owner review + 双仓同时 bump `contract_version`。
6. **脱敏纪律**：ATF 内部路径、业务单据信息、服务器地址不得进入 harness 仓（一律以占位符/环境变量表达）。
7. **测试基线**：109 passed / 2 skipped 不得回归；每个 PR 附复跑输出。

---

## 7. 完成定义（DoD）

| # | 条件 |
|---|---|
| 1 | D1 文档经 owner review 通过 |
| 2 | P2-S1 / P2-S2 / P2-S3 各自 PR 合入（owner 授权），冒烟命令通过，测试基线无回归 |
| 3 | R2b 评估结论经 owner 确认，依赖策略明确 |
| 4 | 全程零 GPU、零真实 Provider、零内核仓改动（`git diff` 对内核仓为空） |
| 5 | 提交 Phase 2 阶段报告（各 slice commit / 测试数 / 决策登记 / 遗留项），由 owner 决议是否打 milestone tag `v0.2.0` |
