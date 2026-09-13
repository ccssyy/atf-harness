# ATF 独立 Harness Phase 1 任务书——headless 冒烟最小闭环（Codex 直接执行）

> 【时代说明（2026-09-13 契约 v2 修订）】本文为历史存档：文中"严格 4 工具面"的 `atf_surface_scan` 为 v1 时名，自契约 v2 起改名 `atf_fact_scan`（数组字段 `surface` → `facts`），现行登记见 `bridge.contract.yaml` v2。

> **状态：CLOSED（2026-09-10）** —— Phase 1 五切片（S1–S5）全部验收闭合，milestone tag `v0.1.0`。终验数字：109 passed / 2 skipped，smoke:s1–s5 全过。后续工作转 Phase 2（待 owner 启动指令），见《ATF独立Harness_Phase1_S5执行报告暨Phase1闭合报告_20260909.md》§8。

> 日期：2026-09-08 ｜ 前置：**Phase 0 已拍板 ACCEPTED**（ADR-05/06/07/08，见《ATF独立Harness_Phase0决策文档_20260907.md》）
> 执行方：Codex ｜ 执行环境：本地 Mac 开发目录，**不依赖 A800 GPU**（⚠️ ATF 仓现行工作流以 owner 当前约定为准，任务书引用的 08-10 梳理报告中 C02/Comet Native 状态已过时）
> 决策基线：R2a（TS harness 仅借鉴设计、零外部运行时依赖）+ 双层引用（A）+ 双轨审批（C）+ 三层工作区（A）
> 原则：**业务冒烟先于机制**——先验证结构正确性，不做任何"机制优化"（compaction、多 provider、并发调度一律顺延）

---

## 0. 任务总览

| # | Slice | 落点（新仓 `atf-harness/`） | 依赖 |
|---|---|---|---|
| S1 | 桥接层：TS ↔ atf CLI 子进程 | `src/bridge/` | ATF 内核仓（只读，atf CLI 可执行） |
| S2 | 会话 log + 双层事实 | `src/session/` | S1 |
| S3 | 工具注册表 + 账本审批 | `src/tools/` | S1 |
| S4 | 三层工作区 + 晋升闸 A | `src/workspace/` | S1 |
| S5 | Faux provider 冒烟闭环 | `src/llm/` + `scenarios/` | S2 S3 S4 |

**一句话目标**：`atf-harness --scenario admission-to-g2` 一次运行，用假 LLM（Faux provider，脚本化决策序列）驱动 atf CLI 完成「数据准入 → G2 实验门」，全程无 GPU、无真实 Provider 调用、无真实训练作业。

**硬约束**：
- ❌ 不修改 ATF 内核仓任何文件（`src/`、`tests/` 只读；atf CLI 只以子进程方式调用）
- ❌ 不调用真实 LLM Provider、不启动真实训练、不碰 GPU（冒烟全程 Faux provider + ATF fake adapter）
- ❌ 不引入 npm 运行时外部依赖（R2a：devDependencies 允许 typescript / vitest / @types；dependencies 必须为空）
- ❌ 不实现顺延项：compaction、多 provider 热切换、并发调度、子代理、ACP server、TUI/Web、TEM 回灌
- ✅ 会话 log 与工作区所有写操作先落盘再继续（append-only，崩溃可重建）
- ✅ 每个 slice 独立可验收（vitest 用例 + 1 条手工冒烟命令），完成一个 review 一个
- ✅ agent 每步提变更描述，由 codex 改；未经 owner 批准不 push / merge

---

## 1. S1 桥接层（`src/bridge/`）

**目的**：建立 TS harness 进程 → atf CLI 子进程的 stdio JSONL 通道（Pi RPC 范式）。

**设计要求**：
1. 协议帧三类：`request`（TS→Python，带自增 `id`）/ `response`（Python→TS，`id` 关联）/ `event`（Python→TS 单向通知）。严格 LF 分帧。
2. `Result` 类型全面 fallible：桥接层所有可能失败的操作返回 `ok/err`，**禁止抛异常穿越边界**（借鉴 Pi）。
3. 子进程生命周期：spawn → 握手（`atf --version` 交换）→ 就绪 → 优雅关闭；子进程意外退出 → 返回 `err` 并附 stderr 摘要，**不重试、不猜测成功**。
4. 请求超时（初值 30s，常量定义，不暴露给模型——ADR-06/工具白名单原则的预演）。

**验收**：
- 握手用例：spawn → 收到版本 response → 优雅退出，退出码 0
- 错误用例：指向不存在的 atf 可执行路径 → `err`，主进程不崩
- 分帧用例：连续 10 个 request 的 response 无串扰（`id` 全部正确配对）

---

## 2. S2 会话 log + 双层事实（`src/session/`）

**目的**：落地 ADR-06——append-only 会话事件流，`domain_refs` 引用领域事实 digest。

**设计要求**：
1. 事件类型枚举（schema v0）：`user/message`、`assistant/message`、`assistant/attempt`（失败尝试，落盘但不进模型历史）、`tool/call`、`tool/result`、`turn/start`、`turn/end`。每条事件带 `id` + `ts` + `type` + `payload`。
2. `domain_refs` 可选字段：`[{journal_type, fact_id, sha256_digest}]`。**校验规则**：引用前向 ATF 查询该 fact 的当前 digest，不一致或不存在 → 该事件标记 `ref_invalid` 并触发 block（fail-closed）。
3. 双管道占位实现：`transformContext()`（组装模型请求上下文，本阶段只做拼接 + 过滤 `assistant/attempt`）与 `convertToLlm()`（过滤 UI-only 字段）。函数签名定死，内部逻辑 Phase 2 再长。
4. 预留 `projection: {evidence_event: string | null}` 字段位（ADR-06 细则 3），Phase 3 前恒为 null，但 schema 里必须有。

**验收**：
- 重建用例：写入 20+ 事件 → 新建 Session 对象从磁盘 replay → 与内存序列逐条一致
- digest 反例用例：篡改 `domain_refs` 中任一 digest → replay 校验报 `ref_invalid` → block
- 白名单用例：含 UI-only 字段的事件在 `convertToLlm` 输出中不出现该字段

---

## 3. S3 工具注册表 + 账本审批（`src/tools/`）

**目的**：把 atf CLI 的最小工具子集包装为 ToolDefinition，审批走账本轨（ADR-07）。

**设计要求**：
1. **本阶段只注册 4 个工具**（工具面收敛原则）：`atf_admit_data`（数据准入）、`atf_gate`（查询/推进 G 闸门）、`atf_surface_scan`（证据面扫描）、`atf_workspace_status`（工作区状态查询）。
2. 每个 ToolDefinition 包含：模型可见 schema（name/description/parameters 白名单，内部字段一律不发）+ execute（经 S1 桥接）+ canonical output 声明（JSON Schema 校验每个成功返回值，校验失败 = err）。
3. **审批流程**：调用前查 approval ledger（经桥接查询，不直读文件）——命中且未消费 → 执行并消费；未命中 → 不执行，返回结构化 block（`reason: approval_missing`），exit 78 语义由 atf 侧返回。**无任何"自动应答"路径**（本阶段只有 headless 账本轨；交互问答轨 Phase 2+）。
4. 工具结果错误也是结构化回填（`ok: false, reason, detail`），让 Faux 冒烟脚本能断言失败路径。

**验收**：
- 成功用例：账本预录 → `atf_admit_data` 执行成功 → ledger 记录变为已消费 → 重复调用同 request → block（一次性消费语义）
- 反例 1：无预录 → block（`approval_missing`）→ **进程 exit code 78**
- schema 用例：ToolDefinition 序列化后不含 timeout 等内部字段

---

## 4. S4 三层工作区 + 晋升闸 A（`src/workspace/`）

**目的**：落地 ADR-08——run 目录下的 T0/T1 分层与晋升闸 A 校验器。

**设计要求**：
1. run 目录结构 v0（在 ATF 现有 run 目录内扩展，不改既有文件）：
   ```text
   runs/<run_id>/
     scratch/      # T0：agent 自由区，provenance.json 记录四元组
     artifacts/    # T1：不可变产物（沿用 Artifact Catalog 语义）
     # contracts 层（T2）本阶段只读，不做晋升闸 B 实现
   ```
2. `scratch` 写入自动生成 `provenance.json`：`{run_id, trigger_instruction, model_id, created_at}`（冒烟阶段 model_id = faux）。
3. 晋升闸 A 校验器 `promote(scratch_path → artifacts)`：可复现（指定复现命令重跑一次，输出 hash 一致）+ 幂等（重复 promote 同源 → 拒绝，已有 Artifact 不覆盖）+ sha 指纹（入 artifacts 时计算并登记）。三项任一失败 → block。
4. **铁律一实现**：会话 `tool/result` 若引用 `scratch/` 路径作为证据 → S2 的 `domain_refs` 校验直接拒绝（T0 不可引用）。

**验收**：
- 晋升正例：T0 分析产物 → promote → artifacts 出现 + sha 登记 → 二次 promote → 幂等拒绝
- 复现反例：产物内容在两次执行间变化 → 可复现校验失败 → block
- 引用反例：事件 `domain_refs` 指向 scratch 文件 → 校验拒绝（铁律一生效证明）

---

## 5. S5 Faux provider 冒烟闭环（`src/llm/` + `scenarios/`）

**目的**：全链路业务冒烟「数据准入 → G2 实验门」，证明结构正确性与模型无关。

**设计要求**：
1. `FauxProvider` 实现 LLM 接口：读取场景脚本（JSON，预编排的 assistant 决策序列：调哪个工具、什么参数、何时给最终回答），不产生任何网络调用。**场景脚本草案已备**：《atf-harness-drafts/scenarios/admission-to-g2.json》（draft-v0，四分支 steps + setup + expectations；字段名以实际实现为准，语义不变）。
2. 场景 `admission-to-g2`，四条分支：
   - **B1 成功路径**：读工作区状态 → atf_admit_data（账本已预录）→ atf_surface_scan → atf_gate G2 → PASS → 最终回答 → exit 0
   - **B2 缺证据**：直接 atf_gate G2 → block（证据缺失）→ Faux 转入补证据 → 重提 → PASS（验证 block 回填后模型可自纠）
   - **B3 无审批**：atf_admit_data 无预录 → block → 场景结束 → **exit 78**
   - **B4 T0 引用**：Faux 试图引用 scratch 产物为证据 → 校验拒绝 → **exit 非 0 且 block 原因 = t0_ref_forbidden**
3. 每条分支运行后必须满足：会话 log 可从磁盘完整重建当次 turn；ATF 侧 run journal 有对应事实；成功分支的会话事件携带合法 `domain_refs`。

**验收（冒烟总验收，逐项打勾）**：
- ⬜ B1 exit 0，G2 GateResult = PASS，证据链闭合
- ⬜ B2 block → 自纠 → PASS
- ⬜ B3 exit 78
- ⬜ B4 引用被拒（铁律一）
- ⬜ 四分支会话 log 全部可重建；digest 校验全部通过
- ⬜ T0→T1 晋升演示路径在 B1 中执行一次并登记 sha
- ⬜ 全程零 GPU、零真实 Provider、零内核仓改动（git diff 为空）

---

## 6. 执行流程与禁止事项（沿用项目纪律）

1. **顺序执行 S1→S5**，每个 slice 完成 = 代码 + vitest 用例 + 自测命令输出 + 变更描述，**交 owner review 后**才进下一个。
2. **BUILD/VERIFY 分离**：verify 阶段不改实现，失败回新 build task。
3. ❌ 未经 owner 显式授权：不 push / 不 merge / 不删分支 / 不碰真实 Provider / 不碰 GPU / 不动 ATF 内核仓。
4. ❌ 不擅自"顺手优化"：遇到设计不合理处，报告并等决策，不自行实现（与 P1 任务书"先报告，不要擅自实现"同一纪律）。
5. 完成定义（DoD）：S5 冒烟总验收 7 项全过 + owner 在本任务书标记 CLOSSED，随后进入 Phase 1 复盘与 Phase 2 范围讨论。

---

## 7. 顺延项登记（明确不做，防止 scope 蔓延）

| 顺延项 | 目标阶段 | 备注 |
|---|---|---|
| compaction（含领域事实白名单逻辑） | Phase 2 | S2 只留 transformContext 签名 |
| 多 provider / 热切换（R2b 升级评估） | Phase 2 | LLM 接口已抽象，单实现即可 |
| 交互壳实时问答轨（ADR-07 第二轨） | Phase 2+ | 本阶段仅账本轨 |
| ACP / JSON-RPC server（宿主子代理模式） | Phase 3 | dispatch/resume 演化 |
| `projection` 字段激活（TEM 回灌） | Phase 3 | 只留字段位 |
| T2 晋升闸 B 实现 | Phase 2 | 本阶段 contracts 只读 |
| TUI / Web 壳 | Phase 4（条件项，ACP 宿主体验够用则取消） | 最后 |

---

## 8. 仓库与开发工程约定（双仓并行开发）

> 背景：ATF 内核仓持续迭代中（2026-09-08 晚：v0.2.0b5 发布，badcase 分析链台账三项清零、新增 evaluate-checkpoints 技能、main 已与远程完全同步），atf-harness 是并行新建的第二仓。本节约定两者的 git 管理与防漂移机制。

### 8.1 仓库拓扑

| | AgenticTrainingFlow（现有仓） | atf-harness（新仓） |
|---|---|---|
| 层 | L1 内核，Python | L2–L4，TS |
| 分支模型 | **主干直改**（已核实，2026-09-08）：日常开发直接提交 main；特殊工作线开短命 `work/` 分支（现存 3 条历史 + work/20260909-experiment-rollup）。远程 origin = github.com/ccssyy/AgenticTrainingFlow。版本节奏：tag v0.2.0b0–**b7**（b7 = `a628f8b`，main tip 250ccd3 为其上 docs 提交） | **trunk-based**：main + 短命分支，S1–S5 各一个 PR 顺序合入 |
| 运行环境 | <INFRA_HOST>_<INFRA_PORT> 为主 | 纯本地 Mac（无 GPU 依赖，天然并行） |
| 版本标记 | 沿用现有 gate 体系 | milestone tag：v0.1.0 = Phase 1 冒烟 7 项验收通过 |
| 长期关系 | 不合并仓库；最终集成形态 = ACP/skills 双入口（与 TEM 独立仓同构） | 同左 |

### 8.2 契约唯一真相源：bridge.contract.yaml

atf-harness 仓内维护 `bridge.contract.yaml`，内容：JSONL 帧格式定义 + atf 子命令签名（本阶段 4 个工具）+ canonical output schema + **`atf_upstream: {commit_sha, contract_version}`**（对 ATF 内核仓的版本 pin，沿用 source_commit_pin 概念）。

**契约升级流程**：改契约 = 显式 PR → 双仓各自跑契约测试 → owner review → 双仓同时 bump contract_version。禁止任何一侧悄悄改。

### 8.3 防漂移三机制

1. **Contract tests（核心）**：atf-harness 仓的测试套件对**固定 commit 的真实 atf CLI**（经 `ATF_CLI_PATH` 环境变量指向本地 ATF clone，测试内校验 sha 与 pin 一致）跑 S1 帧协议 + S3 工具协议断言。ATF 侧任何 CLI/schema 变更若破坏契约，harness 侧 CI 立即红。
2. **ATF 侧变更标记**：ATF 仓内凡改动 CLI 子命令签名 / envelope 结构 / ledger 语义的 change，在变更描述中挂 `contract-breaking` 标记 → 触发 harness 仓 re-pin 与适配任务。该标记写入变更描述即可，不新增 ATF 机制。
3. **Phase 1 内核仓零改动目标**：冒烟用 fake adapter 与现有 CLI 能力足够；若确需新增只读子命令（如 ledger 查询、fact digest 查询），按 ATF 正常流程（change → BUILD → VERIFY → owner review）排队，**不因 harness 插队**。此为唯一串行点。

### 8.4 并行开发节奏

- 两仓技术栈不同（Python / TS），不同 worktree、不同 agent 会话，无文件冲突——**唯一的耦合点是契约文件**。
- 建议排布：ATF 主线（main 直改，当前 badcase 分析链节奏）照常走；atf-harness 每完成一个 slice → PR → owner review → merge，S1–S5 共 5 个 PR 序列。
- **初始 pin 建议**：`atf_upstream.commit_sha` 首次取值 = **tag `v0.2.0b7`**（commit `a628f8b`，2026-09-08 20:09；含 analyze-badcases --run 自动发现修复 e72a98f 系列与全量基线 970 passed / 129 skipped）。用 tag 作 pin 锚点比裸 sha 更可追溯；harness 仓开工时先跑 contract tests 对该 pin 验证通过后再开发。后续 re-pin 流程见项目 AGENTS.md §4。
- atf-harness 若托管 GitHub，注意脱敏：ATF 内部路径、业务单据信息、服务器地址不得进入 harness 仓（A800 相关一律以占位符/环境变量表达）。

