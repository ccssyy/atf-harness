# ATF独立Harness｜L1c 提前批「确认卡与模型可见面」《设计要点》（门 1 交付）— 2026-09-22

- **性质**：门 1 交付物（仅设计，停等核验；owner 放行门 2 后实施）。
- **修订记录**：**v3（2026-09-22，合并版实施批随批件）**——(一).2 单条上限升级数据驱动 min(比例,绝对)；**(一).3 改写"一步到位"**（数据驱动水位＋seam 设计＋三铁律，放行件 v7 `b2ae6b36…` ★段解冻）；(二).5 登记落账实现口径；(八) 增补 Codex per-tool 模式＋学术引证；(七) 影响面更新为实施实况。**v2（2026-09-22，门 2 放行件 §〇 先决）**——补 **(八) 主流对标** 一节（owner 产品级方向决议 `b6ac0f30…` §二），其余各节零改动；补核范围＝仅 (八) 节，通过即随门 2 实施。
- **基线**：main `1561189`；**零提交、零 tracked 改动**（本文件为 untracked 交付物）。
- **依据**：《ATF-Harness_指令_L1c提前批_确认卡与模型可见面_20260922.md》（sha256 `40afe970…`）＋五跑核验记录与产品问题清单（`c86f1720…`，§六测试纪律四条）＋owner 21:38 原则（更正件 `1772676b…`）＋接线批复核 `3c9cc161…`。
- **取证**：五跑 `tmp/ui-runs/run-smoke2-8e0d14/session.jsonl`（108 行）逐行只读核对；`adapter.ts`／`compaction.ts`／`runner.ts`／`humanSummary.ts`／`eventView.ts`／`approval.ts`／`httpProvider.ts`／`toolDefinition.ts`／`bridge.contract.yaml` 均按 main `1561189` 实读。**内核仓零触碰**。

---

## (一) A1 投影摘要改造（阻断级）

### 1. 根因取证（铁证入册）

五跑事件 `#18`（`atf_preparation_propose` 成功返回，**1172 字符**）模型可见摘要＝前 160 字符，截断点实测：

```
{"cluster_material":"absent","cluster_params_template":{"algorithm_version":"bbox_layout_v1","granularity":"page","linkage":"average","metric":"cosine","min_clu
```

——恰切在 `"min_clu`：`min_cluster_size`（值 `"1"`）与 `threshold`（值 `"auto_candidates"`）模型**永远读不到**。同返回体内核已带六字段 `human_summary` 与逐键 `explanation`（A2 卡片内容源已存在，见 (二)）。模型 16 次重调、`tool_cut_no_progress` 两拍切断、预算耗尽后向用户讨参数——与核验记录 §二完全吻合。

### 2. 截断策略选型（§一.1 问）

三案对比：

| 案 | 内容 | 判定 |
|---|---|---|
| 甲·全放开 | 成功结构化 JSON 一律不限长 | 否——无上限单条（未来工具大清单、异常体量返回）可单项挤占上下文，且 compaction 估算被动失衡；把今天的问题换成明天的 |
| 乙·字段白名单透传 | 具名清单（cluster_params_template 等）定向放行 | 否——「关键字段」判定权属内核语义，harness 自建第二权威；清单需逐工具维护，**漂移即漏**。投影面同族前两次事故（approval 白名单、nudge/guidance 白名单）根因恰是白名单维护跟不上真实形态，不重蹈 |
| **丙·体量纪律（选定）** | 成功体**取消 160**，改「**单条上限＋保键分层降级**」；失败径零改 | 体量纪律是**工具无关**的：不认工具名、不认字段名，任何返回体同规则；键保全＝「关键字段全量」由结构保证而非清单保证 |

**选定丙，具体规则**（`src/llm/adapter.ts` 新增纯函数 `structuredResultSummary(result, capChars)`，仅替换 `ok:true` 径的 `readableSummary(result)`；预算常量与解析器收 core/session **新增常量文件一个** `constantsBudget.ts`——红线复核点②口径，理由随常量登记）：

1. 上限 **`capChars` 数据驱动＝min(比例上限, 绝对上限)（两道防线不可二选一，A1.5.3）**：比例上限＝`context_window × 12.5%`，绝对上限＝25K tokens（沿 CC `MAX_MCP_OUTPUT_TOKENS` 口径）；tokens→chars 换算 ×2（与 compaction 估算除数同一保守口径，代码内注明）；**未配置 `context_window` 回退 6_000 字符**；折算结果**只升不降**（低于回退值维持回退值——小窗口不比历史更激进）。全文 ≤ capChars → **全量透传**（五跑真实体 1172、状态面 2052，均直通）；
2. 超限 → **保键降级**后重试：逐顶层键遍历——字符串值 >512 字符截至 512＋`…[截断N字符]`；数组 >50 项保留前 50＋`…[共N项已折叠]`（**键集与结构恒保全**，短的模板键永不被丢）；降级后 ≤capChars → 采用；
3. 仍超限（病态体）→ 硬切至 capChars＋尾标 `…[已截断，原文N字符]`——模型始终**知情**拿到的是残缺体（与今天"不知情截断"的本质区别）。

provider 侧经 `adaptProjectionToMessages(context, { toolResultSummaryCapChars })` 注入（`resolveSummaryResultCapChars(config.context_window)`）；缺省回退 6_000。

**失败/附注径逐字节零改**（§一.3 两态语义）：

| 态 | 摘要构造 | 变更 |
|---|---|---|
| `ok:false` | `[reason, guidance, nudge]` 滤空 `"｜"` 连接 | **零改**（reason 本就短码、不经 readableSummary；紧凑语义原样） |
| `ok:true` | `[structuredResultSummary(result), nudge]` 滤空 `"｜"` 连接 | 仅第一段升级；nudge 位置与连接符不变 |
| `approval/request|response` | `readableSummary(payload)`（160） | **零改**（问答轨历史本为紧凑行，五跑无截断问题；不动无恙） |

### 3. 上下文预算（§一.2 问，新约束设计）——**v3 改写：两步走 → 一步到位（A1.5.2）**

现状链路：`projectContext`（compaction 投影）→ `injectMemoryEntries` → `provider.decide` → `adaptProjectionToMessages`（摘要在此逐事件构造）。

**触发水位数据驱动（一步到位，放行件 v7 ★段解冻）**：

- **公式**：`触发水位 = context_window − reserve`，其中 `reserve = max(压缩摘要输出预算, 单条绝对上限) = max(20K, 25K) = 25K tokens`（20K＝CC 摘要预算口径 owner 指引；25K＝CC `MAX_MCP_OUTPUT_TOKENS` 口径）；`单条摘要上限 = min(context_window × 12.5%, 25K tokens) × 2 字符`；
- **回退（三铁律之二·行为中立）**：未配置 `context_window` → 触发水位回退既有常量 **24_000**、单条上限回退 **6_000 字符**——与历史行为**逐字节一致**（`planCompaction(events)` 缺省参数＝旧常量；解析器 `resolve*()` 对 null 返回旧值）；且**只升不降**：窗口折算低于现值时维持现值（数据驱动只用于放开方向）；
- **同源（三铁律之一）**：`planCompaction` 预算参数化后，投影径与审计径**共用同一函数、同一解析**——runner seam 显式传 `compactionTriggerTokens()`，sessionLog:463 同源调用，禁只改一处；
- **seam 设计（放行件 v7 解冻枚举＝恰好三处）**：① `compaction.ts` 预算参数化（`planCompaction(events, triggerTokens = 24_000)`／`projectContext` 透传）；② `sessionLog.ts:463` 消费点联动（审计语义零改，仅同源传值）；③ `runner.ts:991-993` seam 透传（`projectContext(events, compactionTriggerTokens())`——projectContext 与 pipeline.transformContext 为同一实现纯委托）。进程级 context_window 由外壳注入（`constantsBudget.setCompactionContextWindow`，TUI/trial/ACP 三处在 providerConfig 加载后调用）；
- **事件数双门保留（A1.5.4）**：≥128 实质事件触发门不动；配置 1M 时水位 975K、单条上限 50_000 字符；
- **纯度说明**：planCompaction 仍是 `(events, triggerTokens)` 的纯函数；holder 仅承载进程级配置（runBranch 前注入一次、运行期只读），live 与 replay 同进程折算一致。

**与 compaction 的账面关系（不变部分）**：估算口径＝`ceil(payload JSON 字符数 / 2)`、保留窗 32、推进粒度 32——**估算基数是 event.payload 全文**，compaction 早就按返回体全量计账，A1 放开的只是模型**可见**量；单条上限保证任何单条摘要 ≤ 触发水位的约 5%（1M 配置：50K 字符/975K tokens 估算）——不更高了，是**更精确**；`tool/result` 无 `domain_refs` 属可折叠，老的大返回随 boundary 折叠、保留窗内原文恒在。

### 4. provider `max_tokens` 核对（§一.4 问，次因）

查证：`~/.atf-harness/llm.json` 全部 5 个模型条目 `max_tokens=4096`（＝代码缺省 `PROVIDER_CONFIG_DEFAULTS.maxTokens=4096`）；`context_window` 全部未配置。**结论：偏紧**。reasoning 模型（`reasoning=true` ＋ `reasoning_effort=max`）下生成预算需同时容纳思考与 tool-call JSON，五跑"polymerity/merge"式怪参数名与输入截断同源叠加，不能排除生成侧吃紧的贡献。**处置**：走查与六跑以 **`ATF_LLM_MAX_TOKENS=16384`** 环境覆盖（旋钮已存在：env > 模型级 > 缺省，`providerConfig.ts:408-430`）；**代码缺省不动**（改缺省属 provider 选型面，不在本批；建议随走查单落env，效果批前走查即可验证）。

### 5. 投影面两跳核（硬约束兑现）

- **跳 1**（落盘 schema）：`schema.ts` 零改——tool/result payload 本就是自由 JSON，模板全量早已落盘（铁证：五跑日志里模板完整）；
- **跳 2**（adapter 白名单＋摘要化）：白名单字段闭集 `[tool, ok, result, reason, call_ref, block, detail, nudge, guidance]` **零扩**（本批不新增任何 payload 字段）；改的只是 `ok:true` 摘要构造；**补真实体量用例**见 (六)。

---

## (二) A2 两阶段确认卡（阻断级）

### 1. 形态判定（§二.4 问：复用还是新增）

**新增「确认卡」形态；载体范式复用 B8；审批轨一字不动。**

| 维度 | 确认卡（新） | 审批弹窗（既有，不动） |
|---|---|---|
| 性质 | 参数/策略**请示**（缺输入，非高危放行） | CAS 高危放行闸（ADR-07） |
| 通道 | 无新通道：TUI 呈现＋输入行应答（B8 流内一行式＋输入行应答同范式，零擦除） | 问答轨 approvalSurface stub（原样） |
| 账面 | **确认行为落 user/message**（见 5）；后续 tool/call＋approval/* 既有链即完整审计 | approval/request|response ＋账本轨（原样） |
| 键位 | `1=按推荐确认 2=逐项修改`；直接输入其他指令＝跳过卡 | `1/g 2/a 3/d 4/x`（原样） |

`atf_style_cluster_execute` 发起时**仍走既有审批**（requires_approval: true 不变）——审批弹窗此时语义＝「放行已定动作」（K-Gap-2 (b).4 既定），与确认卡不互替、形成两道人审点。

### 2. 触发时机（本设计关键取舍）

**卡片在 turn 收口后渲染，不在 turn 内阻塞。** 规则：turn 以 `completed` 或 `turn_failed` 收口，且本 turn **末次** `atf_preparation_propose` 成功结果携带 `cluster_params_template` 或 `policy_template` → TUI 在收口区（A3 摘要/collapseLines 之后）渲染对应确认卡。选此不选「turn 内 propose 即拦」的理由：

1. **零 core 改动**：propose 是纯读免审批工具，turn 内拦截需在 runner 增确认 seam——而模型复查 propose（查 stage/cluster_material）属合法调用，turn 内逢 propose 必弹卡会误伤；收口点 TUI 已持有 `report.events` 全量事实，纯呈现层即可判定；
2. **与五跑痛点精确对位**：五跑两次 `tool_cut_no_progress` 与预算收口后，用户面对的是"模型讨参数"——卡在收口处出现，恰替换"用户手工抄参数"那一步；turn_failed 的缺口卡可选项①（"确认聚类参数后…"）由确认卡直接操作化，两卡互补不冲突（渲染顺序＝收口卡→确认卡）；
3. **不劫持输入**：卡应答入口就是既有"新指令"输入行，跳过卡＝直接输入其他指令，随时可绕。

### 3. 聚类确认卡（§二.1）

内容源＝模板回显单源（`cluster_params_template` 六键值即推荐/参考值）＋内核 `explanation`（语义一句）。harness 侧新增**呈现层标签表**（六键中文名＋一句含义；性质同 `approvalCopy.ts` 的 APPROVAL_COPY 呈现文案先例——是文案不是第二权威；**值闭集零复制**，漂移由内核 `invalid_params` fail-closed 拦截如实暴露）：

| 键 | 中文名 | 含义一句 |
|---|---|---|
| `algorithm_version` | 算法版本 | 聚类算法的确定版本 |
| `granularity` | 分组粒度 | 以什么为单位聚类（如按页） |
| `metric` | 相似度量 | 判断两页版式是否相似所用的度量 |
| `linkage` | 合并方式 | 相似页归并成组的方式 |
| `threshold` | 相似阈值 | 多相似才算同类 |
| `min_cluster_size` | 最小组容量 | 一组至少含多少样本 |

卡渲染样例（过程流多行，随流折叠）：

```
┌─ 确认卡 · 版式聚类（数据集 ds-3b7551bca6ec@5fe2a8c9a98b）
│ 聚类把版面相似的样本页归为一类，划分时同类保持在同一分区（训练/测试都覆盖各类版式）。
│ 推荐参数（内核模板，可直接采用）：
│   · 分组粒度：page        · 相似度量：cosine
│   · 合并方式：average     · 相似阈值：auto_candidates
│   · 最小组容量：1         · 算法版本：bbox_layout_v1
└─ 应答（1=按推荐确认 2=逐项修改；直接输入其他指令＝跳过）> 
```

逐项修改＝逐键提示 `中文名（当前推荐值）>`，回车保留、输入替换；harness 只做轻格式提示（如非空），深度校验归内核。

### 4. 划分确认卡（§二.2）

内容源＝`policy_template`（DatasetSplitPolicy/v2 骨架；契约 `bridge.contract.yaml` propose result 已登记 `stage: split_confirmation` 携带）。渲染同款版式：**划分比例**（`target_ratios`，默认 训练:测试 = 8:2，输入 `7:3` 即改）＋**分组方案**（按已落料的版式聚类分层／免聚类，以模板内分层引用现状回显）＋`policy_id`/`seed` 等模板置 null 的工程待定字段**不向用户要值**（用户不碰参数名）——确认文本中标注"待定字段由 Agent 按模板规则补全，实际值在审批弹窗回显"。

### 5. 用户确认 → harness 译 payload ＋确认保真三道防线（§二.3 文案判据内嵌）

应答后 **harness 生成规范化确认文本**落 `user/message`（用户全程不碰参数名），样例：

> 【确认卡·聚类参数】数据集 ds-3b7551bca6ec@5fe2a8c9a98b 聚类参数已逐项确认：algorithm_version="bbox_layout_v1"、granularity="page"、metric="cosine"、linkage="average"、threshold="auto_candidates"、min_cluster_size="1"。请以上述值**逐字**作为 cluster_params 六键发起 atf_style_cluster_execute（勿改动、勿增删键）。

模型复制发起 execute（决策面单一来源不变），保真由三道防线兜底：① **harness 译码**——确认文本由 harness 生成，逐字段精确值不经模型转写用户口语；② **逐字复制指引**——A1 后模板全量可见＋上述文本内嵌指令；③ **内核闭集校验＋审批回显**——越值即 `invalid_params` 回流（guidance 已登记），漂移未拦住的在审批弹窗被看见：`approvalCopy` 扩展 `atf_style_cluster_execute`／`atf_data_admission_request` 文案为**逐参数中文回显实际提交值**，TUI 侧另做与确认卡的**只读一致性比对**（一致→"（与确认卡一致）"；不一致→"（注意：与确认卡不一致：差异…）"）——只提示、不拦截、不改写（executor 透传即全部，K-Gap-2 (d) 纪律）。

**落账**：`user/message` 事件 payload `{text: 规范化确认文本}`（v3 实施口径）。**`ui:{confirm_card}` 审计位的实现缺口（如实登记）**： attaching ui 需改 `runner.ts` continue 路径 appendEvent（:951-952 一处）——该行在 v7 ★段解冻枚举（compaction.ts／sessionLog.ts:463／runner.ts:991-993）之外，按"越界即复核不通过"未实施。当前确认行为的审计链＝user/message 确认文本（落盘）＋`> 确认留痕` 呈现留痕行＋后续 tool/call＋approval/* 既有链，审计实质完整；ui 便捷标签位登记为**一行式后续**（owner 一句话放行即补）。

---

## (三) A3 completed turn 产品化摘要

**现状**：failure 收口有 `failure_summary`＋`collapseLines` 六段版式；completed 只有 `outcome=completed` 一行——对称缺口属实。

**设计**：**TUI 侧确定性推导**（`report.events` 取末 turn 切片——自末次 `turn/start` 起），新增 `src/ui/completedSummary.ts` 纯函数，轻量三段：

1. **做了什么**：本 turn 工具动作产品名清单（呈现层工具产品名 copy 表，如 `atf_admit_data→登记数据`；成功结果带内核 `human_summary.headline` 的以 headline 代替机名）；
2. **产生了什么**：产物清单——登记身份（`atf_admit_data` 结果 fact_id）、聚类产物（`atf_style_cluster_execute` 结果 `assignment_ref`＋`cluster_count`）、准入判定（`atf_data_admission_request` 结果 status）；
3. **下一步建议**：末次内核 `human_summary` 的 `nextActionOf()`（"唯一下一动作"既有提取口径）；无则该段不出现（产品化判据：没内容就不出行）。

**形态取舍（§三问：复用六字段还是轻量版）**：**轻量三段，不伪造六字段**——六字段是**内核**人读层的冻结形态，harness 自产同形表会冒充"内核说"；轻量三段已覆盖"做了什么/产生了什么/下一步"，且纯由已落盘事件推导（摘要＝投影非第二真相源，与 `core/projection.ts` 同哲学，**账本轨零新增**——turn/end payload 不加字段，事实本就在流内）。内核未来若提供 turn 级 summary，直渲染切单源（登记建议，不在本批）。

**渲染**：TUI 终局区 completed 分支（与 `collapseLines` 同级）；渲染毕按 (二).2 规则接确认卡。**ACP/MCP 不在本批**（配件面，登记 L1c 后续）；模型面不受影响（turn/end 在 adapter 为 skip，摘要不进模型上下文，不增上下文负担）。

---

## (四) B 静默与文案（owner 11:0x 口径）

1. **leak 降级提示行整体静默**：`humanSummary.ts` `safe()` 与 `eventView.ts` `safeLine()` 改为**滤除**——命中工程语的行**不显示、不解释、不指路**；两条降级文案（"（该行含未映射的工程信息，已收起；详情见事实日志）"、"（该行含工程信息，已收起）"）**删除**。附带闭合一处现存漏洞：`eventView.ts:64` human_summary 机器行的 `headline` 未过校验——静默口径下 headline 命中即机器行只留 `ok=true <tool>`（不配中性填充语）。`notes[]` 工程细节降级区按其设计定位**原样保留**（内核 §2.4 容忍区，非本条所指"降级提示行"）。事实日志审计不受影响（滤除仅呈现层，事件全在流内）。
2. **产品化判据**入本批验收：产品流每一行都要回答"用户现在需要知道什么/做什么"，回答不了的行不出现——设计文档内已对保留行逐行自检（结论行/分组行/动作行/待确认行/收口卡行均合格）；**边界外观察提请 owner 裁示**：`approval.ts:48` 请求行尾缀"（本请求仅为问答轨渲染，非新通道）"属系统视角表述，不在指令点名范围，本批默认不动（零回归纪律），owner 圈了就一行并入。
3. **描述层补"状态面信息直接使用、无需向用户复述"**：`HARNESS_SYSTEM_PROMPT` 增第 4 条（状态面/查询返回的信息供直接使用与决策——勿向用户复述其枚举内容、勿将其误称为"工具"；向用户报告只说结论与下一步）；`atf_workspace_status` 工具 description 尾补同义一句。

---

## (五) C 查证：provider quota/用量上限错误映射

**查证结论：未覆盖。** `httpProvider.ts:200-254` 现状分类只有四类：网络/超时（可重试）、5xx（可重试）、**其余非 2xx 一律通用文案"决策请求被拒绝（HTTP xxx，不重试）"**、响应非 JSON。provider 侧 429（限流）与配额/欠费类（多见 402/403＋body 码 `insufficient_quota` 等）全落通用分支，无人读映射、无结构化可区分码。

**补映射设计**（`postJson` 4xx 分支前插入判定，先于通用文案）：

- 命中判据：`status === 429`，**或** body excerpt 含 `insufficient_quota`／`quota`／`rate limit`／`usage limit`／`arrearage`（大小写不敏感）；
- 产出：`LlmErrorCode` 扩一值 **`provider_quota_or_rate_limited`**（`provider.ts:86` 两值并集扩一——src 类型面，非 schema/契约面），message＝人读一行"模型服务用量已达上限（provider 侧配额/限流）：请核对账户额度或稍后重试；输入新指令即可继续本会话"，detail 带 `status`＋`body_excerpt`（既有截断与脱敏漏斗照走）；
- **不重试**：现重试机制无退避，429 立即重试只会白烧 `max_calls_per_run` 预算——额度类一次判明即收口；
- 收口呈现：`runner.ts` provider_failure 径 `stuckAt` 本就携带 `error.message`——**runner 零改动**，TUI `collapseLines` 卡在哪行自然显示人读文案；
- 测试：`httpProvider.test.ts` 增 429 与 403+insufficient_quota 两例（断言结构化码、人读 message、零重试、调用计数＝1）。

---

## (六) 测试纪律四条落验收（§六逐条对齐）

| # | 纪律 | 本批落点 |
|---|---|---|
| 1 | 测试数据真实化 | 新增 `tests/fixtures/realvolume/`：`propose-cluster-template.json`（五跑 `#18` 真实体 **1172 字符逐字拷贝**，脱敏复核通过：仅 dataset 标识/短 pin，无地址/单据/人名）＋`workspace-status-overview.json`（五跑 2052 字符体，同上复核）＋用例内合成 >6000 大体（生成式，不落盘） |
| 2 | 真实体量断言 | `tests/llm/adapter.test.ts` 新 describe：①**模板完整性**——真实体过 `adaptProjectionToMessages`，断言 tool_result summary **逐字段含** `algorithm_version`/`granularity`/`linkage`/`metric`/`min_cluster_size`/`threshold` 六键**键名与取值**（"1"、"auto_candidates"、"page"、"average"、"cosine"、"bbox_layout_v1"）；②全量透传长度断言（summary ⊇ 全文）；③超限降级——大体用例断言 ≤6000＋尾标、**键集保全**、长串值截断标记；④失败径回归——`ok:false` 摘要与现状**逐字节一致**（既有用例 1/2 原样）。既有"用例 4（ok:true 无 nudge 逐字节一致）"随本批**语义升级**改写为"小体量全量透传"断言（旧断言锁的是 160 截断本身，正是本批要修的缺陷） |
| 3 | 交互闭环 | 确认卡与工具链**同批**交付：新增 `tests/ui/confirmCard.test.ts`（两卡触发条件/渲染行含中文名＋推荐值/一键确认→规范化文本含精确 JSON/逐项修改/跳过路径/turn_failed 收口也出卡）＋`approvalCopy` 逐参数回显与一致性比对用例＋既有 `kgap2Wiring.test.ts` 链路零回归；工具链（propose/execute/request）已在上批合入，本批 UI 补齐即闭环 |
| 4 | 批前走查 | 门 2 复核时复核方跑 **pty 真实模型最小链（约 5 分钟）**：绑定→状态查询→propose（见卡）→卡确认→execute 审批→request 携策略→划分卡→completed 摘要，以用户身份过一眼；走查单随批交付，env 带 `ATF_LLM_MAX_TOKENS`（**按对照表取值**——合并版 §三更正：16384 为保守档非上限，走查与六跑按 llm.json 登记面各模型官方输出上限取值）＋`context_window` 配置 |

---

## (七) 影响面清单＋红线自检（v3＝实施实况）

**改动文件（实施批）**：
- **模型面（A1/C/描述层）**：`src/llm/adapter.ts`（structuredResultSummary 三档＋options 注入面）、`src/llm/provider.ts`（LlmErrorCode 扩 `provider_quota_or_rate_limited`）、`src/llm/httpProvider.ts`（quota 判定不重试＋cap 数据驱动注入＋系统提示第 4 条）；
- **core/session（放行件 v7 ★段解冻枚举＋新增常量一个）**：`src/core/session/compaction.ts`（预算参数化，缺省回退逐字节中立）、`src/core/session/sessionLog.ts:463`（消费点同源联动，审计语义零改）、`src/core/run/runner.ts`（import＋:991-993 seam 透传）、**新增** `src/core/session/constantsBudget.ts`（预算常量与解析器——红线复核点②"零修改既有文件，新增常量文件一个"口径；constants.ts/schema.ts/session index.ts 零改）；
- **呈现层（A2/A3/B）**：`src/ui/humanSummary.ts`（静默滤除）、`src/ui/eventView.ts`（静默＋headline 闭合）、**新增** `src/ui/confirmCard.ts`、**新增** `src/ui/completedSummary.ts`、`src/ui/tui.ts`（setter 注入＋卡候选追踪＋A3 渲染＋卡交互＋审批 echo）、`src/ui/approval.ts`（confirmationEcho 注入面）、`src/core/tools/approvalCopy.ts`（逐参数中文回显＋比例回显＋标签表单源化）、`src/core/tools/index.ts`（导出标签表）、`src/core/tools/toolDefinition.ts`（workspace_status 描述句）、`src/acp/shell.ts`＋`src/run/trialL1aReal.ts`（setter 注入）；
- **测试**：`tests/fixtures/realvolume/`（两真实体 fixture）、`tests/llm/adapter.test.ts`（A1 describe＋用例 4 语义升级）、`tests/llm/httpProvider.test.ts`（quota 三例）、`tests/session/compactionBudget.test.ts`（新）、`tests/ui/confirmCard.test.ts`（新）、`tests/ui/completedSummary.test.ts`（新）、`tests/ui/humanSummary.test.ts`／`tests/ui/approvalInline.test.ts`／`tests/run/f6StatusFace.test.ts`（B 静默口径升级＋echo 用例）。

| 硬约束 | 自检（实施后复核口径） |
|---|---|
| `schema.ts` 零改 | ✓（12 事件类型、payload/ui 命名空间均复用既有位） |
| `runner.ts` 零改动 → **v7 ★段修订** | ✓（解冻枚举内：仅 import 一处＋:991-993 seam 透传；其余零改） |
| core/session 零修改既有文件（新增 constants 一个）→ **v7 ★段修订** | ✓（解冻枚举内：compaction.ts 预算参数化＋sessionLog.ts:463 同源联动；**新增 constantsBudget.ts 一个**；constants.ts/schema.ts/index.ts 零改——报告口径＝"零修改既有文件，新增常量文件一个"按解冻枚举修正） |
| 契约零 diff | ✓（复核点①核验行：`bridge.contract.yaml`／`session.contract.yaml`／`workspace.contract.yaml` 均未登记 LlmError 码闭集——仅有的相近登记为 exit-78 语义注记与 turn/end stop_reason 枚举，与 LlmErrorCode 无关；该码属 harness 内部面不过线缆——**零 diff 成立，无需补登**） |
| pin `v0.7.3b1` 不动 / 不动内核 | ✓（`.atf-pinned` 只读复用，HEAD `2f9a052e…`＝pin sha；内核仓零写入） |
| 投影面两跳核 | ✓（(一).5：跳 1 零改、跳 2 白名单零扩＋摘要升级＋真实体量用例） |
| 不 push 不发版 | ✓（单批 `--no-ff` 合入 main，不 push） |

---

## (八) 主流对标（门 2 放行件 §〇 先决补充；本节为唯一补核范围）

**对标来源盘点**（2026-09-22 公开取证；引证以实际核出页面为准）：

| 来源 | 性质 | 本节取证内容 |
|---|---|---|
| **Pi**（立项参照） | github.com/earendil-works/pi 公开文档（`packages/coding-agent/docs/compaction.md`／`security.md`） | compaction 触发/保留窗/工具结果截断；无内建审批的安全模型原文 |
| **DSH**（立项参照系） | **developer preview、官方明示 breaking changes**（Phase0 决策文档 §R2）；项目内实测记录仅配置形态（`~/.dsh/settings.yaml` 两层＋凭据引用，L1a 门 2 修订任务书 v2 §0.2） | **无公开的截断线/预算/审批数值文档**——数值对标以 Pi／Claude Code／Codex 为准；DSH 仅作产品形态参照（自带 Web UI＋CLI、自有 UI 主入口） |
| **Claude Code** | code.claude.com/docs/en/model-config（**已核**：200K–1M 窗、auto-compact 近满 ~967K 缺省、可配 100K–1M）＋ /docs/en/mcp（**已核**：`MAX_MCP_OUTPUT_TOKENS` 缺省 25,000 tokens、超 10,000 tokens 警告、超限落文件＋对话内路径引用） | 引证更正：owner 指引注 25K/10K 出自 model-config 页，实核该两值在 **/mcp 页**；20K compact 摘要预算公开页未见（不作本文取值依据，仅记 owner 指引口径） |
| **Codex** | openai/codex 公开仓库议题（2025-10：工具内容发模型前**硬编码 10 KiB ≈ 10,240 字符**截断，议题即讨论将其可配化）＋官方 approvals 文档（OS 沙箱＋审批策略分层） | 数值为议题口径非正式文档口径（下表注明） |

### 表一｜A1 截断线（单条工具结果进模型上下文的上限）

| 系统 | 主流做法（来源） | 取值 |
|---|---|---|
| Claude Code | 超 10K tokens **警告**；超 25K tokens（`MAX_MCP_OUTPUT_TOKENS`，可配）**截断＋落文件＋对话内替换为路径引用**（code.claude.com/docs/en/mcp，已核） | 警告 10K／上限 25K tokens |
| Codex | 发模型前硬编码 **10 KiB** 截断（openai/codex 议题 2025-10，非正式文档口径） | ≈10K 字符 |
| Pi | 摘要序列化径工具结果截 **2000 字符＋余量标记**；正常上下文 tool result 与 tool call 绑定不切（pi compaction.md） | 摘要径 2000 字符 |
| **ATF（本批）** | 成功结构化 JSON 取消 160，**单条 6000 字符＋保键分层降级＋硬切知情尾标**（§(一).2） | 6000 字符（≈3k 估算 token） |

**差异理由**：① 比例纪律对齐 Claude Code——25K/200K 窗＝**12.5%**，ATF 6000 字符/24k 估算触发门＝**12.5%**，同构；② 较 Codex 10 KiB 略宽——内核模板类返回体必须**整条可读**（五跑缺陷即截在关键字段半截），真实体 1172 字符＋5 倍余量取整；③ Pi 的 2000 字符属**摘要序列化径**，对应 ATF compaction 折叠径语义（折叠本不保留原文），与本文上限不冲突；④ 10K 警告线**不引入**——ATF 单条上限本低于该量级，且面向用户的警告行违反 B 静默口径；⑤ Claude Code 超限"落文件供回读"**不引入**——模型面无通用文件回读工具（工具面收敛 7 个），超限降级用知情尾标替代（模型始终知情拿到残缺体）。

### 表二｜A1 上下文预算水位（compaction 触发形态）

| 系统 | 主流做法（来源） | 取值 |
|---|---|---|
| Claude Code | auto-compact **近满窗触发**（Sonnet 5 缺省 ~967K/1M；`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 可配 100K–1M）（model-config 页，已核） | 近满窗＋可配 |
| Pi | `contextTokens > contextWindow − reserveTokens` 触发（reserve 缺省 **16,384**，可按模型覆盖）；保留窗 `keepRecentTokens` 缺省 **20,000 tokens** 原文保留；永不切在 tool result 上（compaction.md） | 窗口−reserve；保留 20K |
| **ATF（本批不变更）** | 双指标固定门：实质事件 ≥128 ∨ 估算 token ≥24,000（字符/2 保守估算）；保留窗 32 条；承证白名单豁免（§(一).3） | 固定双门 |

**差异理由**：主流水位是"模型窗口的绝对余量"，前提＝tokenizer＋真实窗口值；ATF 无 tokenizer（字符/2 保守估算）且 `context_window` 全部未配置——本批在零改红线内**不动触发常量**，分两步：① **输入侧对齐随走查单交付**（各模型 `context_window` 配置建议，给估算门一个正确基准——放行件 §三 连带项）；② 触发形态向主流"窗口−reserve"演化**登记后续批**（属 providerConfig/compaction 联动改造，非本批）。既有同构点：ATF 保留窗（最近 32 条原文恒在）≈ Pi `keepRecentTokens`；ATF 承证白名单＝训练场景特有约束（领域事实引用链不可折叠），主流无此物。

### 表三｜A2 确认/审批交互形态

| 系统 | 主流做法（来源） |
|---|---|
| Claude Code | 逐动作权限提示（once；**含 "don't ask again" 类持久选项**）；plan mode＝"先出方案→人审→再执行"两阶段形态（公开文档） |
| Codex | OS 沙箱＋审批策略分层（Read Only／Auto／Full Access），越沙箱动作请求人批（官方 approvals 文档） |
| Pi | **无内建逐动作审批**——原文立场："Pi does not include a built-in sandbox… Real isolation needs to come from the operating system or a virtualization/container boundary"；仅项目 trust（管"加载什么"，不管"执行什么"）（pi security.md，已核） |
| ACP 规范 | `session/request_permission` 与 ATF 审批闸同构（pending 注释原文 "awaiting approval"）（项目 L1 设计门 1 讨论稿已核） |
| **ATF（本批）** | **双闸**：确认卡（缺输入请示·harness 译码·`user/message` 落账）＋ CAS 审批（写动作一次性放行·账本轨唯一真相源·**无 always 类**）（§(二)） |

**差异理由**：
1. **vs Claude Code 持久授权**：编码场景可 "don't ask again"；ATF 训练数据场景**禁止配额复用**（CAS 一次性消费、审批 fails-closed，ADR-07 铁律）——每次写动作须留独立授权事实，训练产物可信度底线；
2. **vs Pi 外置审批**：Pi 无账本审计需求故把隔离交给 OS/容器；ATF 的审批行为**本身是训练数据准入证据链一环**（ApprovalRecord 唯一真相源），必须内建且落账——分歧不在"要不要审批"，在"审批是不是业务证据"；
3. **确认卡 vs plan mode**：两阶段"先呈现→人审→执行"与 plan mode 同构；差异＝ATF 卡是**领域参数确认**（逐字段中文名＋推荐值＋harness 译码＋内核闭集校验兜底），plan mode 是自由文本计划——更强约束，防的正是五跑"模型转述丢字段"缺陷。主流编码 agent 无"参数模板回显确认"对应物，此为 ATF 领域特有形态，呈现判据沿用产品化口径（每行回答用户需要知道/做什么）。

### (八) 小结（v3 修订）

本批取值与主流**同构或更严，无一处更松**。对标中发现的引证更正一处（25K/10K 权威出处＝/docs/en/mcp 页，非 owner 指引所注 model-config 页）已如上注明。

### (八) 增补（v3，合并版 §〇.3：选型理由补充——随实施批提交）

**1. Codex `tool_output_token_limit` 模式（单工具结果 token 预算：全局缺省＋逐工具覆写）**——合并版 §二 A1.5.5 三流派之:
- 主流做法：Codex 以 config.toml 配置单工具结果进模型的 token 预算（公开配置参考列 `tool_output_token_limit`，全局键；**per-tool/MCP 逐个覆写在公开文档未直接核出**——如实标注；Claude Code 面的 per-tool 对应物＝工具 `_meta["anthropic/maxResultSizeChars"]`（/docs/en/mcp 页已核，硬顶 500_000 字符））；窗口侧配 `model_context_window` 覆盖＋`model_auto_compact_token_limit`（社区口径 auto_compact ≤70% 启发式）；
- ATF 取值与选型理由：**Codex per-tool 模式为推荐参照形态**——per-tool 覆写精确满足"模板类工具整条可读、其他工具照常截"，优于全局单值与字段白名单两极；本批实现取**全局体量纪律（丙）**（工具无关、零具名清单，见 (一).2 选型），全局值经 `min(比例, 绝对)` 双防线已使模板类工具在真实体量下全量透传（1172≪6_000/50_000），per-tool 覆写**登记为后续演化位**（providerConfig 增 per-tool 旋钮即可，机制不预设）。

**2. 学术引证（"产品级"方向依据）**：*"Same Model, Different Harness: Different Coding-Agent Results"*（arXiv:2608.26218，Sydney Lewis，2026-08-26，已核原文页）——固定模型与任务、只改 harness（旧工具结果在上下文压力下缩短＋重复/停滞处理）→ 三个 coding benchmark 的 mean F2PF 全部上升，紧窗口 SWE-bench Verified 队列 **28%→49%（+21pp）**，且增益不经调参迁移到另三个模型；结论＝评测应把 harness 与模型"作为同一被测求解器"。对本批的意义：五跑缺陷（截断→16 次重调→预算耗尽）正是该文 treatment 所刻画的"上下文供给方式决定结果质量"——A1（当前工具结果完整可见）＋A1.5（数据驱动水位＋摘要预算）与文中增益方向一致；harness 配置（本批对照表/走查 env）按"被测求解器组件"对待，数值须有出处（禁口头值）。

**3. 三流派选型并陈（合并版 §一 A1.5.5，机制选型理由）**：① Pi 绝对余量（窗口−reserve，缺省 reserve 16_384）→ ATF 取其**形态**（水位＝窗口−reserve）而 reserve 用 max(摘要预算, 单条上限) 推导式（A1.5.2，不直接沿用 16_384——其 compaction.md 原文口径已核但属 Pi 实现值）；② CC 绝对 cap（25K tokens）＋比例纪律（25K/200K=12.5%）→ ATF 取**双防线取 min**（A1.5.3）；③ Codex per-tool tokens（全局＋逐工具覆写）→ ATF 取其**作为后续演化形态**（见上 1）。最终机制＝Pi 形态的水位＋CC 双防线单条上限＋Codex per-tool 登记后续——三者各取所需，理由如上。

---

**状态（v3）**：合并版指令（`64cfb82c…`）已按 §〇–§八 实施；本 v3 随实施批提交（单批 `--no-ff` 合入 main）→ 交 owner 复核（两口径＋批前走查双验）。
