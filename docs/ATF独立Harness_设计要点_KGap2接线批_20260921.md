# ATF独立Harness｜K-Gap-2 接线批《设计要点》（门 1 交付）— 2026-09-21

- **性质**：门 1 交付物（仅设计，停等核验；实施必须排在 D-f 批合入之后）。
- **基线**：main `900a578`；worktree `/data/sam/ATF-Harness-kgap2-wiring`、分支 `work/20260921-kgap2-wiring`；**零提交、零 tracked 改动**（本文件为 untracked 交付物；2026-09-21 门 2 起 (c) 段按 owner 裁定方案 A 六字段口径修订并随实施落盘）。
- **依据**：《ATF-Harness_指令_K-Gap2接线批门1放行_20260921.md》（sha256 `73af9d31…`）＋内核《ATF内核_回报harness_K-Gap-2与R-3接口对齐_20260921.md》（sha `4143f44a…`）＋harness 承接件《ATF-Harness_承接内核回报_K-Gap2接线与R3联合定义_20260921.md》（sha `4c390d53…`）。
- **冻结面取证**：本设计不凭指令转述自造 schema——已只读核对内核仓（`/data/sam/AgenticTrainingFlow`）变更单《ATF内核_变更单_K-Gap-2料门对齐批_20260921.md》与《ATF内核_门1设计稿_K-Gap-2形态细化_20260921.md》v3（裁定①–⑨），并逐字段核对内核 `work/kgap2-prep-alignment` worktree（`a5fffae`，S1–S3 已 commit）的实际实现 `src/agentic_training_flow/session/tools.py`。下文内核行号均指该 worktree；harness 行号指 main 900a578。

---

## (a) 工具面 5→7：定义／schema／RPC 映射与审批策略矩阵

**工具命名与 RPC 映射**（沿用 R1 接线批 D-1 先例：模型面工具名用下划线，点号方法经 executor 显式映射）：
- `src/core/tools/executor.ts:85-89` 的 `TOOL_METHOD_OVERRIDES` 增两项：`atf_preparation_propose → atf_preparation.propose`、`atf_style_cluster_execute → atf_style_cluster.execute`；`rpcMethodFor`（`:89`）零改动。
- 定义插入 `src/core/tools/toolDefinition.ts:95-291` 的 `TOOL_DEFINITIONS`（建议插在 `atf_data_admission_request` 条目 `:157-206` 之后，准备族聚拢）；`ToolRegistry.createDefault().modelVisible()`（消费点 `tui.ts:177`）自动进模型可见面，executor 审批管线（`executor.ts:126-129` → `approve()` `:142-225`）自动生效，零新机制。

**两个新工具定义**（schema 只做描述层指引＋字段声明，深度校验归内核——沿用 `atf_admit_data` 双形态先例 `toolDefinition.ts:98-103` 的「不引入第二权威」口径）：

| 项 | `atf_preparation_propose`（纯读） | `atf_style_cluster_execute`（写） |
|---|---|---|
| params（冻结面实测 `tools.py:1769-1773`／`:1928-1943`） | `{dataset_id（必填，非空、不含路径分隔符与 @）, pin?}` | `{dataset_id（必填）, pin?, cluster_params（必填 object，六键：algorithm_version／granularity／metric／linkage／threshold／min_cluster_size，键名进 harness schema、**值闭集不进 harness**——取值以 propose 回显的 `cluster_params_template` 为单源，内核闭集校验）}` |
| canonical_output（逐字段镜像内核返回面，executor 逐次校验） | `{ok, dataset_id, pin, fact_id, stage, cluster_material, explanation, human_summary}` 必填；`cluster_params_template?`／`policy_template?` 按阶段可选（`tools.py:1774-1790`）；`stage ∈ {cluster_confirmation, split_confirmation}`、`cluster_material ∈ {skills_ready, absent}` | `{ok, run_id, dataset_id, pin, fact_id, assignment_ref, cluster_digest, cluster_count, clusters[], source, human_summary}` 必填；`clusters[]` 项 `{cluster_id, size, representative_sample_ref}`（`tools.py:2000-2001` 实测）；`source` const `"kernel"` |
| description 要点 | 纯读：判定阶段、回模板与人读说明，不写盘不执行；指引「聚类阶段→确认参数后走 atf_style_cluster_execute；划分阶段→确认策略后走 atf_data_admission_request」 | 写动作须审批；六参数逐项显式、无隐式缺省；执行后聚类料就位可复查 propose |

**审批策略矩阵**（判定单一出口 `requiresApprovalFor`，`toolDefinition.ts:36-37`；基线旗标+谓词两式先例齐备）：

| 动作 | 审批 | 依据 |
|---|---|---|
| `atf_preparation_propose` | **免审批**（`requires_approval: false`，同 `atf_fact_scan` `:244`／`atf_workspace_status` `:269`） | 纯读：不写盘、不执行、锚不写（内核 S1 冻结语义） |
| `atf_style_cluster_execute` | **需审批**（恒 `true`，不做 gate 式参数分流——execute 无只读形态） | 写：聚类落料＋facts 留痕（owner mutation） |
| `atf_data_admission_request`（既有，增 `split_policy`） | **需审批不变**（`:179`） | B8 审批链语义零改动（硬约束） |

**`split_policy` 参数扩**（`toolDefinition.ts:163-178` parameters 区）：增可选 `split_policy: object`，description 注明「**经用户确认的完整策略 payload 对象**（DatasetSplitPolicy/v1|v2 骨架以 `atf_preparation_propose` 返回的 `policy_template` 为基准）；不接受自由文本；形态校验归内核（v1/v2、`target_ratios` 和为 1、`style_cluster_assignment_ref` 非空、unit 全覆盖），harness 只透传」；canonical_output（`:180-206`）增可选 `human_summary`（五键闭集）与可选 `policy`／`style_cluster_source`／`allocation_unit_source`／`partition_counts`（内核 `tools.py:1291-1301` 实测返回面）。

## (b) 两阶段状态与确认态采集路径

状态判定**权在内核**（propose 按 registration 面现状推导 `stage`／`cluster_material`，`tools.py:1776-1782`），harness 不自建阶段状态机——**harness 侧零新状态、零新事件类型**，两阶段由 Agent 经模型面工具驱动，过程事实全在既有会话流（tool/call＋tool/result＋approval/*）。

**确认态往返（owner 16:43 裁定：不新增参数编辑控件）**，每阶段同一循环：

1. **展示**：Agent 调 `atf_preparation_propose`（免审批直通）→ TUI 过程流渲染 `human_summary` 五段人读报告＋模板（(c) 的渲染落点）。
2. **自然语言改**：用户在既有新指令循环（`tui.ts:267`）输入（「默认 8:2 就行」「改成 7:3」等）——采集面就是现有输入循环，零新控件。
3. **Agent 译 payload**：模型把用户要求落为 schema 化 payload（骨架＝propose 回显模板；`policy_id`/`seed` 模板置 null 须显式给出，`tools.py:1848-1860`）——翻译是模型面行为，harness 只透传，不经手内容。
4. **内核校验回显→采纳或再改**：Agent 携 `split_policy`（或 `cluster_params`）发起写调用 → **审批在前**（executor `approve()` 先于 RPC，`executor.ts:126-131`；弹窗文案经 approvalCopy 呈现策略人读摘要＝「放行已定动作」确认点）→ 内核执行时 schema 校验（`tools.py:292-330`）：非法 → `invalid_params` rejected 回流（guidance 附字段级说明，模型改后重提重审）；合法 → 执行并返回双层报告（human_summary「将如何划分」说明＝回显）。**如实声明**：冻结面无独立预检方法（propose 实测不收 draft，`tools.py:1769-1773`），「校验回显」＝失败拒绝回流＋成功双层说明两形态，采纳动作＝审批放行；**审批＝放行已定动作、请示＝缺输入**，两者不互替（B8 零改动）。
5. **Stage 1→2 翻转**：execute 落料后 Agent 复查 propose，`stage` 翻 `split_confirmation`；确认态留痕：内核侧（确认人／`policy {source,digest,deviation}`／`style_cluster_source`，`tools.py:1291-1296`）＋harness 侧（tool/call payload 与 approval/response 既有账本，零新增）。

## (c) `human_summary` 直接渲染落点＋负向校验

> **【门 2 修订（照 owner《两批门2放行与human_summary裁定》§〇 裁定一，方案 A 六字段冻结表）】**
> 原门 1 设计按内核当时实现的五键闭集（conclusion/details/quantities/next_action/pending）描述；
> owner 已裁定取**方案 A 六字段**（与 harness 会签回执一致），`next_action` 不保留独立键、由
> `actions[]` 中 `needs_decision=false` 的首条承载「唯一下一动作」语义。本节按六字段口径修订，
> 实施已照此执行（内核侧 `_human_summary` 六键补正由内核侧会话按 §〇 办理，不在本批范围）。

**结构闭集（6 字段，冻结）**（owner 裁定 §〇；内核契约 §13.11 补正后同表）：

| 键 | 结构 |
|---|---|
| `headline` | string（一句话结论＋影响面量化） |
| `sections[]` | `{title, items[]}` |
| `metrics[]` | `{label, value}` |
| `actions[]` | `{title, detail, needs_decision: bool}` |
| `pending_confirmations[]` | `{title, detail, options?: string[]}` |
| `notes[]` | string[]（补充与工程细节降级区） |

**模块 `src/ui/humanSummary.ts`**（纯函数，同 eventView 展示层纪律——只格式化不新增载荷来源）：
- `isHumanSummaryShape(value)`：**六键**结构嗅探（防内核形态漂移，不命中则回落既有 JSON 行——零回归）。
- `humanSummaryLines(summary): string[]`：**六段版式**（结论先行 headline→分组 sections→量化 metrics→动作 actions（`needs_decision=true` 标「（需要你决定）」）→待确认 pending_confirmations（含 options 选项行）→补充 notes），每行可独立 `appendLine`。
- `nextActionOf(summary)`：**`actions[]` 中 `needs_decision=false` 的首条 detail**（裁定锁定的「唯一下一动作」提取口径，防渲染器再猜）。
- **负向校验 `engineeringLeak(line)`**：检测 64 位 hex digest、`<Schema>/v数字` 形态 schema 名、GateId（复用 `GATE_LEGAL_IDS` 单源＋`\bG[1-4]\b`）、snake_case 工程码（`reason_code`／`split_policy_missing` 类）。分层口径（对齐内核门 1 稿 §2.4 第 3/5 条）：**主叙述行**（headline／sections／metrics／actions／pending_confirmations）命中即整行降级为「（该行含未映射的工程信息，已收起；详情见事实日志）」——呈现层 fail-closed，不向用户放大内核漏映射；`notes[]` 为工程细节降级区，技术定位原样呈现、不作检测对象。
- **渲染挂点**：`src/ui/eventView.ts` tool/result 分支——`ok:true` 且 `result.human_summary` 命中六键形态 → 机器行只留 headline 摘要；新增导出 `formatEventDetailLines(event): string[]` 输出六段人读行（行带同事件 id 前缀，smoke:l1ui 的 id 集合断言保持全等）；`historyFold.ts` `handle`／`reveal` 批次缓冲从 `string[]` 扩为按事件行组（历史展开后同款人读形态）；`src/ui/tui.ts` 挂线第二 formatter。
- **断言方式（可 mock）**：`tests/ui/humanSummary.test.ts`——六键嗅探正反例／六段版式行序／`next_action` 提取／负向校验四类逐类命中＋纯人读文案不误报＋主叙述泄漏渲染降级／notes 容忍。与 **R3 去工程腔合并推进**：`src/core/tools/approvalCopy.ts` 的 `APPROVAL_COPY` 增 `atf_style_cluster_execute` 文案并给准入申请加确认态标注（放行前可继续修改），人读、不直出 digest。
- **schema 方言最小扩展**：`src/core/tools/canonical.ts` 的 `SchemaNode` 增 `strict?: boolean`（缺省 true 维持「properties 即白名单」；显式 `strict:false` 放开未声明键）——用于 `split_policy` 确认态与 human_summary 等自由形态对象的透传（深度校验归内核，harness 不做第二权威）；`cluster_params` 六键名进 schema（值闭集归内核）。

## (d) 拒绝码 → D-f 缺口卡收口语义映射

**线缆形态（实测）**：内核准入模块 `ValueError("split_policy_missing")` → 会话层 `MethodError(str(error), …)`（`tools.py:1232-1234`）→ 错误码**直出**（与 `unknown_gate` 同通道，`tools.py:759`）→ harness executor 结构化回流 `rejected.reason = <码>`（`executor.ts:239-243`）→ 走 **D-f 批已定的 `src/core/run/blockGuidance.ts` 注册表**（D-f 设计 (d) 落点），本批**只增两键、不新造机制**：

| 码 | 含义／缺什么 | 正常谁产 | 可选项（≤3，标推荐） |
|---|---|---|---|
| `split_policy_missing` | 缺「经确认的划分策略」：既无确认态 `split_policy` 也无登记面 `refs.split_policy_ref` skills 建议（`tools.py:1192-1199` 不透传不猜） | 用户确认（Agent 译 payload）或 skills 侧 `split-policy.json`（R-2 方向 A） | ① 确认划分策略（默认 训练：测试=8:2 或改比例）后重提（推荐）② 先落 skills 建议 policy 料 ③ 如实停止等待指示 |
| `split_recompute_cluster_required` | 用户既不提供聚类料也不选免聚类策略（内核 `data_admission.py:1381`/`:1515` 诚实拒绝） | skills 聚类料或内核确定性聚类（Stage 1） | ① 确认聚类参数走 `atf_style_cluster_execute` 落料（推荐）② 改选免聚类策略 payload ③ 如实停止 |

两键 `is_material_gap: true` → D-f 收口时自动出**缺口卡四段**（卡在哪／缺什么／为什么需要／可选项）；**禁止静默补齐或静默换策略**——harness 侧双保险：描述层不写任何「缺料自动聚类」指引，executor 不做参数改写（透传即全部）。policy 优先级（确认态＞`refs.split_policy_ref`＞拒绝执行，`tools.py:1162-1163`）落 `atf_data_admission_request` 描述层一句话；harness 不实现优先级逻辑（内核单源裁决）。

## (e) 契约登记段补登清单（逐条）＋与 D-f 批不重叠声明

`bridge.contract.yaml`（全部为登记段补登，双轴不动：会话协议轴仍 1、桥接契约头部 `contract_version` 仍 2——照 `:243-246` R1 补登先例措辞；`:559` 行注记复核）：

1. **`:243-246` 方法面注释块**：「5 个」→「7 个」，补 K-Gap-2 补登记注（依据内核变更单＋两方法名映射；补登不 bump 双轴）。
2. **新增方法条目 `atf_preparation.propose`**：`direction: ts_to_kernel`；`requires_approval: false`；params `{dataset_id, pin?}`；errors `invalid_params`／`dataset_not_registered`（纯读对未知数据集不猜，`tools.py:1786-1788`）；result 闭集＝(a) 表第二列逐字段（含 stage／cluster_material 枚举、human_summary 五键子 schema）。
3. **新增方法条目 `atf_style_cluster.execute`**：`requires_approval: true`；params `{dataset_id, pin?, cluster_params（六键 object，值闭集注明归内核）}`；errors `invalid_params`／`no_run_bound`／`dataset_not_registered`；result 闭集含 `clusters[]`（项 `{cluster_id, size, representative_sample_ref}`）、`cluster_digest`、`cluster_count`、`source: "kernel"`、`human_summary`。
4. **`atf_data_admission.request` 条目（`:365-403`）三处扩**：params 增可选 `split_policy`（完整 payload、校验归内核注记）；errors 增 `split_policy_missing`／`split_recompute_cluster_required`（模块稳定码直出登记，同 `:379` passthrough 族）；result 增可选 `human_summary`／`policy`／`style_cluster_source`／`allocation_unit_source`／`partition_counts`。
5. 工具描述同步（`toolDefinition.ts`）：两新工具 description＋request 的 `split_policy` 字段描述与优先级一句话（D-f 批若已在其 description 尾部补过 guidance 行，本批 rebase 后叠加、不回退）。

**不重叠声明**：本批与 D-f 批同触 `core/tools/toolDefinition.ts` 与 `src/ui/`——**实施严格排在 D-f 合入之后**，本批在其上 rebase；机制级不重叠——D-f 交付收口状态机／缺口卡结构／guidance 注册表／nudge 通道，本批只做**接口接线**（两新工具＋schema 扩）与**呈现层新增**（humanSummary 模块），并对 D-f 的 blockGuidance 注册表**增两键**；`core/run/runner.ts` 本批零改动（两新工具复用既有回流与收口链）。B8 审批链、`ask` 工具（L1c）、R-3 接线（待会签冻结＋re-pin 方法面 14）、kernel 侧改动：均不在本批。

## (f) 验收口径

- **mock 证据（pin 未升级前唯一宣称面）**：mock ≥460/9 零回归；`tests/fixtures/mock_atf.mjs` 增两方法仿真（方法映射 `:447` 区注册；数据驱动——按登记面 `refs` 现状推 `cluster_material`，与内核 S4 语义逐条对齐）＋`split_policy` 校验／两拒绝码仿真。新增用例五条（指令 §三）：propose 纯读免审批（断言零 approval/request 事件）／execute 写需审批（granted 放行＋denied 回流）／`split_policy` 透传＋非法 payload `invalid_params` 回流／human_summary 负向断言（detector 逐类）／两拒绝码→缺口卡收口→会话可续（依赖 D-f 已合入）。
- **真内核 e2e：re-pin 后才可宣称通过**——待内核 K-Gap-2 合回并发版，re-pin 三步（`bridge.contract.yaml` §4）切至含方法面 12 的 tag 后，交链路证据：propose→（缺料时）execute→request 携确认态→summary 落盘；**G3 翻转属内核侧判据，harness 侧只证链路**。当前 `.atf-pinned` 不动（`61631e6`/v0.7.2b0）。
- 边界复核：不落具名 unit／固定路径数量进 harness（聚类参数**值闭集**与 human 标签映射均不复制入 harness——内核单源）；不写 `source_root`/`split_root` 树内；契约登记段与内核 §13/§14 版本轴行逐条对齐后合并；单批 `--no-ff` 合回 main；**不 push、不发版**。

---

**停等核验**。两批时序：D-f 门 1 已交、本门 1 现交——两 worktree 均零提交；owner 核验通过后按「D-f 门 2 → 合入 → 本批实施」串行推进。
