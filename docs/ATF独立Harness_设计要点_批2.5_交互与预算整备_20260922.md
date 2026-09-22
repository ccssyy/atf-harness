# ATF独立Harness｜批 2.5「交互与预算整备」《设计要点》（门 1 交付）— 2026-09-22

- **性质**：门 1 交付物（仅设计，停等补核；owner 放行门 2 后实施）。
- **基线**：main `06354c2`（L1c 提前批已合入）；**零提交、零 tracked 改动**（本文件为 untracked 交付物）。
- **依据**：《ATF-Harness_指令_批2.5交互与预算整备_门1派工件_20260922.md》（sha256 `05ff4d69…`）＋走查问题清单（`546736ec…`）＋L1c 复核（静态＋两口径全绿）＋放行件 v7 ★段（A1.5.2 解冻枚举，`b2ae6b36…`）。
- **取证**：`tmp/ui-runs/run-walk6-ee9a35/session.jsonl`（79 行逐行只读核对）；`runner.ts`／`constantsBudget.ts`／`confirmCard.ts`／`session.contract.yaml` 按 main `06354c2` 实读。**内核仓零触碰**。

## (〇) 走查取证（铁证入册）

1. **确认转写混错 ×4**（split_policy 四种形态）：call `#35` **缺** split_policy 整键 → `#56` **null 直填**（`policy_id:null, seed:null`，内核"null 须显式给出"拒）→ `#70` **自造值**（`policy_id:"split-train80-test20", seed:42`——用户从未确认）→ `#75` **又退回 null**。三起 `invalid_params` 回流烧尽步数；**自造值若通过即"未确认值入账"**——审计轨污染风险，转写不可靠实证。
2. **32 步硬切断实证**：turn/end `#66`＝`budget_exhausted, step_count:32`（混错重试烧步数）→ 第二 turn `#79` provider HTTP 失败收口——判定②链路完整。
3. **policy_template 真实形态（七键）**：`schema_version:"DatasetSplitPolicy/v2"`／`assignment_mode:"recompute_with_policy"`／`auto_style_cluster:false`／`split_strategy:"cluster_content_family_seeded"`（四键内核定值）＋`target_ratios:{train:0.8,test:0.2}`（用户可决）＋`policy_id:null`／`seed:null`（待定两键）。

---

## (一) A2.5 确认直填（架构级——走查判定②根治）

### 1. 选型：执行链注入（批准即执行，模型不重生成参数）

| 案 | 内容 | 判定 |
|---|---|---|
| 甲·模型转写（L1c 现状） | 确认文本进上下文，模型构造 tool/call | **废弃**——走查混错 ×4 实证：schema 全量可见也不保证转写一致（四种形态漂移）；"确认值→提交值"之间隔着一次不可控生成 |
| 乙·拦截改写 | 模型发起时 runner 换入确认参数 | 否——伪方案：模型可能不发/发错工具/发一半；审批键随模型参数漂移；"何时发起"名义归模型实际不可依赖，失败模式更隐蔽 |
| **丙·确认直填（选定）** | harness 以 `f(内核模板, 确认值)` **确定性合成** tool/call，turn 开启时直接派发执行；模型第一拍看到的就是"已按确认参数执行"的结果 | 执行的就是批准的动作本身（CC/Codex 批准即执行的本质，见 (四) 表一）；语义正确性从"模型生成"改为"确定性合成"——该错误类**整体删除**而非修复 |

### 2. 合成来源（确定性合成 spec，全程无 LLM）

`src/ui/confirmCard.ts` 新增纯函数 `synthesizeAction(card, confirmed): { tool: string; params: Record<string, unknown> }`：

- **聚类**：`tool=atf_style_cluster_execute`，`params={dataset_id, pin?, cluster_params: 六键逐字取确认值}`（dataset_id/pin 自 factId `ds-…@pin` 确定性解析）；
- **划分**：`tool=atf_data_admission_request`，`params={dataset_id, pin?, split_policy: 模板全键保留＋确认值覆盖＋null 补全}`；
- **null 键补全规则表（原"Agent 补全"职责上移 harness；仅标识/初值级，不触数据语义）**：`policy_id = "policy-<dataset_id>-<yyyymmdd>"`（确定性标识串）；`seed = 0`（确定性初值）。内核闭集校验兜底——若规则与内核期待漂移，`invalid_params` 如实回流且**可确定性复现**（对比模型转写漂移：不可复现、不可归因）；
- 纯函数性即"无 LLM 参与"的可测形态：同输入同输出、不经 provider、不进 decide——验收断言（§四.1）据此逐字节锁定。

### 3. 注入 seam（与 A1.5.2 解冻区兼容；本批解冻申请见 (五)）

- runner options 扩 `continue.pendingAction?: { tool; params; origin: "confirm_card" }`（与既有 `resume` 重派先例同构：L1a resume granted 即 harness 代人重派原 tool/call——harness 侧派发有先例、非新机制）。
- **continue 块顺序**（扩展 `runner.ts:924-956` 区）：前置检查（不变）→ `user/message`（确认文本）落盘 → `turn/start` → **派发 pendingAction**：appendEvent `tool/call`（params＝合成值，`ui:{confirm_card}` 留痕）→ `executor.execute` 经**既有 approvalHandler gate**（第二道人审＝CAS 审批，一字不动）→ suspended/aborted/approval_missing/结果回填与 resume 重派路径同款语义 → 进入决策循环（模型第一拍即见 tool/call＋审批链＋tool/result）。
- **与 A1.5.2 三处解冻点的兼容**：`compaction.ts`／`sessionLog.ts:463` 本批**零触碰**；`runner.ts:991-993` seam 行（`projectContext(events, compactionTriggerTokens())`）**逐字节保持**——本批 loop-top 预算重设计（§二）在同区间作业但该行不动（交叉自检表 (五) 逐行核对）。turn 预算注入复用 `constantsBudget.ts` holder 同款模式（A1.5.2 已立的"外壳注入→两径同源"形态，无新机制）。

### 4. 模型侧呈现

模型上下文新增三事实：确认文本（user/message）、合成 tool/call、审批链与结果（tool/result）——模型第一拍读到的即"已按用户确认的参数执行"的事实；其决策面收窄为**读结果、走下一步**（复查 propose 推进 stage、汇报）。"模型参数构造错误"这一错误类**不存在了**——不是模型看不看得到的问题，是源头删除。模型仍可发起一切非确认类调用（状态/gate/propose 等）——决策面不完全剥夺（§一.5）。

### 5. 审计轨（账实一致，K4）

`user/message`（确认文本）→ `tool/call`（合成参数＋**`ui:{confirm_card:{kind, confirmed, synthesized:true}}`** 留痕——ui 命名空间 schema 既有，`convertToLlm` 恒剥离、模型不可见）→ approval request/response（CAS）→ `tool/result`。**确认值＝提交值＝执行值三者逐字节一致**。**顺带闭环 L1c 缺口**：L1c 登记"user/message ui 审计位"一行缺口，随本批 appendEvent 增强一并补（同区一次解冻）。

---

## (二) 预算重设计（去步数形态，四层替代——有界性保留）

**主流本质（指令 §二 已查证＋(四) 表二展开）**：Pi 核心 loop 无步数计数（预算在宿主扩展点）、CC 预算＝context＋硬阻塞线＋成本、Codex＝压缩水位＋per-tool tokens——**没有人用"步数"做预算**；预算都是真实资源＋熔断＋人工接管点。

### 层一｜turn 级 token 预算（数据驱动，替代 32 步）

- **度量**：本 turn 已落盘实质事件 payload 的估算 token **增量**（`ceil(chars/2)`，与 compaction 同一除数＝估算同源）；appendEvent 处增量累计、loop top 判定；
- **默认（数据驱动）**：`floor(compactionTriggerTokens() / 4)`——未配置窗口 24K→**6_000 est tokens/turn**；1M 配置→**243_750**；
- **可配**：llm.json 顶层可选键 `turn_token_budget`（providerConfig 解析＋env `ATF_LLM_TURN_TOKEN_BUDGET` 覆盖，同 LLM 旋钮规则）→ 外壳经 constantsBudget holder 注入；run options `budgets.turnTokenBudget` 直配（测试与宿主 seam）；
- **两层分明**：turn 预算度量**增量**（本 turn 烧多少），compaction 水位度量**存量**（上下文多大）——互不替代、互不干扰；
- 触达 → 模型面 `collapseTurn(budget_exhausted, limit=预算值, stuck_at="本轮 token 预算（N）已用完")`；**脚本执行径维持既有 32 步语义逐位不变**（Faux 断言路径零迁移——L1c 时代"脚本径豁免"纪律延续）。

### 层二｜渐进警告（80%，走投影两跳核）

- 触发：turn 估算 ≥ 80% 预算 → 置 flag（每 turn 一次）；
- **注入通道＝下一拍 `tool/result` 回流附 `nudge`**——**零新增 payload 字段**：跳 1 schema 零改、跳 2 白名单零扩（nudge 为 D-f 已登记字段，摘要化语义既有）；两跳核以"未新增任何字段"最强形式满足＋新增文案用例；
- 文案：`预算提示：本 turn 估算用量已达 N%（剩余约 M tokens），请尽快收口（给出最终答复或向用户汇报）。`

### 层三｜三档熔断保留

同参重复／无进展检测（D-f，五跑与走查双实证）**零改**；新增**连续 provider 失败熔断**：run 级计数连续 `provider_failure` 收口轮数，≥3 → `failure_summary.hint.note` 升级为"provider 已连续 3 轮失败——请核对 provider 配置/额度/网络后输入新指令"（quota 码联动 L1c C 项人读行）；任何非 provider_failure 收口复位。

### 层四｜兜底保险丝

`TURN_HARD_STEP_FUSE = 200`（run options `budgets.hardStepFuse` 可配）：模型面触达 → `collapseTurn(budget_exhausted, stuck_at="安全熔断线（200 步）触达——疑似异常循环，请核查")`。**防 bug 死循环的最后防线**，正常不触达；stop_reason 五值枚举不动（`session.contract.yaml:298` 零 diff）。`core/session/constants.ts` **零改**：`LOOP_MAX_STEPS_PER_TURN` 原值保留（脚本径仍用），新常量全落 `constantsBudget.ts`。`LOOP_MAX_TURNS=8` 保留——run 级**轮数**预算＝Pi onBeforeTurn 示例（50 turns）同形态的宿主级预算，非"步数"形态。

### 人工接管点

既有（SIGINT 中止／新指令续跑／CLI resume）不动；`budget_exhausted` 人读产品化：`COLLAPSE_NOTES` 该键改"**本轮预算已用完**（运行护栏，非进度指标）：控制权已交还——可直接输入新指令继续，或先收窄任务；输入新指令即可继续本会话"；fuse 触达另有"疑似异常循环"警示行（人读非裸码）。

### 旧语义迁移表（§二.6）

| 既有依赖 | 迁移 |
|---|---|
| `loopSkeleton.test.ts` 32 步用例（脚本径） | **零迁移**——脚本径保留 32 步语义，原样通过 |
| `realPeer/dfCollapseE2e.test.ts` "(a) 32 个互异 gate query → budget_exhausted"（模型面） | 迁移为 **token 预算径**：注入小 `budgets.turnTokenBudget` 触达收口（断言 reason/stop_reason/limit 形态不变、值变预算值）；另加 fuse 径用例（注入 hardStepFuse=小值） |
| `dfCollapse.test.ts`／`l1aE2e.test.ts` budget 断言 | 逐一核对：脚本径断言不动；模型面径改注入预算触发（同上形态） |
| `failure_summary.limit` 注释语义（"budget_exhausted：LOOP_MAX_STEPS_PER_TURN"） | 代码注释更新（token 预算值／fuse 步数两义并存，按径标注）——**未登记契约，零 diff** |

---

## (三) L1c.1 UX 四项（走查 B 类）

1. **call/result 合并渲染**：call 行改**动作短行**＝`→ <产品名>（参数首 160 字符…）执行中`；result 行保持现状（headline/原因）——参数全文不再在 call 行重复直出（模型面零改：adapter 不动，仅 TUI 展示层）。**零擦除保持**（B8 纪律：改的是初始渲染内容，非擦除重绘）；断言：大参数（>160 字符）call 行不含全文。
2. **确认卡标签表增强**：`CLUSTER_PARAM_LABELS`／划分标签表键值增两维——`values?`（闭集值域，来源＝bridge.contract.yaml 已登记闭集与模板回显，呈现层引用非第二权威，漂移内核校验兜底）＋`builtIn?: true`（内置键 `schema_version`/`assignment_mode`/`auto_style_cluster`/`split_strategy` 标注"内置（自动补全）"，**卡面折叠不暴露**）；卡面用户可决键收敛＝聚类六键／划分 `target_ratios`。
3. **文案产品化**：`"推荐参数（内核模板，可直接采用）"`→`"内置推荐参数（可直接采用）"`；`"（由 Agent 按模板规则补全）"`→`"待定项由系统按推荐规则自动补全，实际值在执行前回显"`；canonicalConfirmationText 的"请以上述值逐字…发起"改为"系统将按你确认的参数直接执行（确定性合成，不经模型改写）"——模型语境同步收窄。L1c 既有文案断言同步更新。
4. **静默状态行**：ui 新增 `StatusTicker` 小模块——每个 live 事件后起 2.5s 单发定时器，触达时仍无新事件 → `appendLine("⋯ 思考中（模型决策中）"／"⋯ 调用中：<产品名>…")`；下一事件到达即取消。**零擦除保持**（追加行，非重写行——与 CC/zcode 重绘式 spinner 的差异见 (四) 表四）；provider 流式＝中期架构项，**登记不实施**。

---

## (四) 六实现对标（每项：主流做法（来源）＋ATF 取值＋差异理由）

**来源盘点**：Pi（github.com/earendil-works/pi；agent-loop 无步数＋onBeforeTurn 扩展点＝指令已查证素材；**本机 443 受限未能二次实核源码，按 owner 查证口径引用并如实标注**）；CC（code.claude.com 公开文档，L1c 批已核两页）；Codex（公开配置参考＋L1c 批议题口径）；DSH（developer preview，无公开数值/形态文档——L1c 批已声明，维持）；**WorkBuddy**（腾讯系 harness/loop 架构 agent；公开面仅架构定位与 Bench 报道，无内部预算/审批形态文档——如实声明）；**zcode**（本 harness 开发宿主：权限提示批准后原样执行该调用、上下文近满自动压缩、无步数预算——产品行为面陈述）。

### 表一｜批准即执行（§一 A2.5）

| 实现 | 主流做法（来源） | 与 ATF 差异理由 |
|---|---|---|
| CC | 权限提示批准的对象＝**该次动作本身**（approve-and-execute；公开文档） | 同构 |
| Codex | approval policy 批准后执行**该命令本身**（官方 approvals 文档） | 同构 |
| Pi | 无内建逐动作审批（security.md：隔离交 OS/容器） | ATF 审批是训练数据证据链一环（ADR-07），必须内建落账——L1c (八) 表三既定 |
| DSH | 无公开形态文档（如实声明） | — |
| WorkBuddy | 无公开审批形态文档（如实声明；公开覆盖仅定位其为 harness/loop 架构） | — |
| zcode | 权限提示批准后**原样执行该工具调用**，无参数重生成（产品行为面） | 同构 |
| **ATF 取值** | **A2.5 丙案：确认值 → harness 确定性合成 → 原样执行；两道人审（确认卡＋CAS）不变** | 差异＝ATF 是**领域参数确认**（非命令白名单）：合成来源是内核模板＋用户改值，故"直填"之外还需 null 键补全规则表（(一).2）——六家无此场景（无参数模板回显确认） |

### 表二｜预算形态（§二）

| 实现 | 主流做法（来源） | ATF 取值 |
|---|---|---|
| Pi | 核心 loop **无步数计数**；预算在宿主扩展点（onBeforeTurn＋abort；示例 50 turns／500K tokens）（指令已查证素材） | **turn 级 token 预算**（层一）＝同"真实资源"形态；LOOP_MAX_TURNS=8 保留＝同宿主轮数预算形态 |
| CC | 预算＝context（近满 compaction）＋硬阻塞线＋成本；无步数（model-config 页，L1c 已核） | compaction 水位（既有）＝同构；**fuse 200 步**＝CC 无对应——ATF 独有保留项（差异理由：模型 face 决策循环的历史 bug 防线，正常不触达，触达即人读收口——保险丝不是预算） |
| Codex | 压缩水位＋`tool_output_token_limit`（公开配置参考） | 单条摘要上限（L1c 已落）同构 |
| DSH／WorkBuddy | 无公开数值文档（如实声明） | — |
| zcode | 上下文近满自动压缩＋会话管理；无步数（产品行为面） | 同构 |
| **ATF 差异理由** | **删除"32 步"这一非资源形态**；四层＝token 预算（真实资源）＋渐进警告＋熔断（行为护栏既有）＋fuse（bug 保险丝）——与主流共同点一致：真实资源＋熔断＋人工接管点 | 脚本径 32 步保留＝Faux 断言路径（测试执行器非模型面，无资源语义）——测试稳定性纪律，非产品形态 |

### 表三｜渐进警告与熔断（§二 层二/三）

| 实现 | 主流做法（来源） | ATF 取值与差异 |
|---|---|---|
| CC | compact 前用户提示；高危动作确认（公开文档） | ATF 警告面向**模型**（nudge 收敛提示）＋面向用户（预算人读收口行）双通道——CC 的 compact 对用户提示、对模型自动压缩，ATF compaction 同构既有 |
| Pi | overflow／stopReason "length" → 一次 compact-and-retry（compaction.md，L1c 已核） | ATF 熔断（无进展/同参切断）先于资源触达——D-f 既有，走查实证有效 |
| zcode | 上下文接近上限自动压缩（产品行为面） | 同构 |
| DSH／WorkBuddy | 无公开文档（如实声明） | — |

### 表四｜状态行与 call/result 渲染（§三.1/§三.4）

| 实现 | 主流做法（来源） | ATF 取值与差异 |
|---|---|---|
| CC／zcode | 重绘式 status/spinner 行（工具调用块折叠合并展示）（产品行为面） | **差异理由**：ATF B8 架构裁定"擦除/残留 bug 类自架构上消除"（append-only 零擦除）——不可重绘，故状态行＝**定时追加式**（2.5s 单发，事件到达即取消），call/result＝**短行＋结果行时序形态**（非折叠重绘）。形态不同、目的相同：消除"无反馈等待"与"参数重复直出" |
| Pi | TUI 组件化（pi-tui），重绘式 | 同上差异 |
| Codex | 重绘式 TUI | 同上差异 |
| DSH／WorkBuddy | 无公开渲染形态文档（如实声明） | — |

---

## (五) 范围 × 红线交叉自检（合并版指令教训的制度化执行）

| 红线 | 本批触碰面 | 自检 |
|---|---|---|
| `schema.ts` 预算警告注入 | nudge 复用（D-f 已登记字段）——**零新增 payload 字段**；tool/call ui 位＝schema 既有命名空间 | ✓ 两跳核最强形式满足 |
| 契约零 diff | stop_reason 五值枚举保留（`session.contract.yaml:298` 不动）；failure_summary 未登记于契约（limit 语义变化仅代码注释）；compaction 24K 登记（:128）不动；llm.json 新键 `turn_token_budget`＝providerConfig 域（非契约件） | ✓ **零 diff 成立，无需补登**（报告附核验行） |
| A1.5.2 三处解冻点 | `compaction.ts`／`sessionLog.ts:463` 零触碰；`runner.ts:991-993` seam 行逐字节保持（loop-top 重设计区包含该行区间但该行不动） | ✓ 兼容 |
| **本批解冻申请（提请门 2 裁定）** | runner 六区：imports／options 接口（:314-355，`budgets`＋`continue.pendingAction`）／appendEvent（:554-572，turn 估算计数＋ui 留痕＋L1c user/message ui 位闭环）／continue 块（:924-956，pendingAction 派发）／loop-top 预算区（:960-1050，四层重设计）／新增派发 helper（resume 重派附近）；`core/session/constants.ts` **零改**；`constantsBudget.ts` 增常量与 holder；`providerConfig.ts`（turn_token_budget 键）；ui：`confirmCard.ts`（合成＋标签表＋文案）、`tui.ts`（pendingAction 传递＋StatusTicker）、`eventView.ts`（call 短行）；测试迁移与新增 | **越界判定权在 owner**——枚举如上，未列区域零改动 |
| pin `v0.7.3b1`／内核／push | 零触碰；单批 `--no-ff` 合入不 push | ✓ |

---

## (六) 测试与验收（§四 对齐）

1. **确定性合成断言（本批核心判据）**：`synthesizeAction` 纯函数逐字节——聚类卡 fixture → `cluster_params` 与模板六键逐字相等；划分卡 → `split_policy` 与"模板键＋确认比例＋补全规则值"逐字相等；**runner 级**：`continue.pendingAction` → 落盘 tool/call params 与确认值**逐字节一致**＋`ui.confirm_card.synthesized=true`＋审批链完整（无模型参与由纯函数性＋不经 provider 结构保证）。
2. **预算两态断言**：注入小 `turnTokenBudget` → 80% nudge 进模型可见 summary（文案断言）＋触达 `budget_exhausted`（limit=预算值）；未配置 → 默认两态（6_000／243_750 按窗口）；fuse 注入触达（人读"疑似异常循环"行）；连续 provider 失败 ≥3 升级提示。
3. **真实体量 fixture 延续**：L1c `realvolume/` 不动，A2.5 合成断言直接消费 propose fixture。
4. **UX 用例**：call 短行（大参数无全文）、卡文案（"内置推荐参数"/"待定项由系统…"）、内置键折叠、StatusTicker（fake timers）。
5. **批前走查（复核含）**：走查判定扩展——**确认直填后 execute payload 逐字节一致**＋全程无 budget_exhausted 循环＋**渐进警告出现**（长 turn 时）；env 按 L1c 对照表（context_window=1M 已配置）。

## (七) 并行项转达（不阻塞本批，内核侧）

gate 穷举指引（状态面"当前可做动作"）／聚类结果人读丰富化——已由 owner 转达内核侧，本批零动作。

---

**停等**：本《设计要点》报补核 → owner 放行门 2（含 (五) 解冻申请裁定）→ 实施 → 单批 `--no-ff` 合入 → 复核（两口径＋批前走查）。
