# ATF-Harness agent-loop 设计（门 1 讨论稿）

> **状态**：**已升格为正式设计**（门 1 通过，owner 2026-09-14）——D1–D8 与 N1/N2 裁决见《ATF-Harness_Owner决议与指令_R2门2验收_门1通过_切片排序_20260914.md》；据此按 §8 签发切片任务书（切片 0 已启动；切片 1 待切片 0 闭合后启动）
> **原状**：门 1 讨论稿（**不产生代码**）—— 已按 owner 逐项批复闭环
> **日期**：2026-09-14
> **性质**：补齐 Phase 0–2 从未设计的 runtime loop 语义（owner 2026-09-14 确认"从未专门设计讨论过"）
> **输入基线**：harness `main` @ `0dc75b2`（R2 门 1 入库、门 2 执行中）｜契约 v2 ｜ pin `v0.6.0b0`/`b6db349`
> **约束来源**：`AGENTS.md` §3 长期硬约束 ｜ ADR-05~09 ｜《R2 门 1 评审·门 2 放行》§2.3/§3.3/§5
> **与 R2 的关系**：**并行不冲突**——R2 换对端实现，loop 定形不改桥接方法签名（见 §7）

---

## 0. 结论先行

1. **本稿只回答一个问题：runtime loop 由谁驱动、在哪里停、状态落在哪。** 这三件事在 Phase 0–2 被有意绕开（Faux 脚本驱动使它们不可见），但它们是 Phase 3 的**唯一关键路径**。

2. **最重要的判断：R2 通过 ≠ 链路可用。** R2 把对端从 mock 换为真实内核，但 loop 的驱动源仍是 `FauxProvider`（`decide(_context)` 的 `_context` 下划线命名 = 显式声明不使用 context）。R2 之后链路是「真实内核 + Faux 驱动」——距 L1 交互级还差**一个真实 provider** 与**一个 loop**。

3. **一个必须先清掉的隐患（与设计结论无关，可立即独立执行）**：`src/llm/provider.ts` 的 `export type LlmDecision = ScenarioStep` 把模型决策面与测试基建面绑在一起。`ScenarioStep` 含 `promote` —— runner 收到它直接调 `promoteArtifact`（L620–632，**晋升闸 A**）。Faux 下无风险；Phase 3 接真实模型后，**模型只要能产出 `promote` 决策就绕过 4 工具面触达晋升闸**，与 TCB 铁律正面冲突。建议单列工作包（§6）。

4. **五项 schema 级决策（A 组）的推荐口径**（逐项论证见 §4）：

   | # | 问题 | 推荐口径 | 一句话理由 |
   |---|---|---|---|
   | A1 | 是否引入 step 粒度事件 | **不新增事件类型**；`turn/end.payload` 补 `step_count`/`decision_count` | 现有 `tool/call`↔`tool/result` 配对已提供可恢复边界；12 类已定死，新增成本大于收益 |
   | A2 | 终止判据 | **裁剪版四重判据 + 显式轮次预算**；新增 `stopReason` 枚举；**不新增退出码** | 真实模型下"何时停"必须有确定性判据，且**无预算的 loop 会失控**——这是 Faux 下不存在的风险 |
   | A3 | 工具批次语义 | **显式拒绝并行批次**；一次决策一个工具；adapter 负责把模型的多工具响应**展开为顺序决策** | 审批是逐工具一次性消费，并发会让消费顺序与事件顺序脱钩、重放不可确定 |
   | A4 | 审批往返与 turn | **维持现状：审批嵌在 turn 内**；挂起时 turn 收口（`reason:"suspended"`），**resume 开新 turn** | 与 R2 正在跑的实现一致（零改动面）；跨进程恢复后"同一 turn"无法自证 |
   | A5 | 是否新增第 13 类事件 | **本切片不新增**；保留位机制承接 | 12 类语义尚未在真实负载下检验；steering 属 B 组、Phase 3 才需要 |

5. **B 组五项属编排级**（§5），可在门 1 给方案、门 2 随实现落，**不需要现在拍板**。

6. **一条硬约束（由 R2 决议 §3.3 推出，必须是 loop 设计的公理）**：内核的闸门登记与账本消费**仅在会话进程内存**，进程结束即消亡。因此 **loop 依赖的一切状态必须落 harness 的 append-only 会话日志**——"跨进程可重建"在 ATF 侧只有一个凭证来源（§2.3）。

7. **建议切片顺序**：切片 0（类型拆分，可立即做）→ 切片 1（loop 骨架：终止判据 + 预算 + step 元数据）→ 切片 2（adapter 契约 + 多工具展开 + 错误回填）→ 切片 3（Phase 3 首切片：真实 provider + 审批人在回路 = L1 交互级，需 owner 显式授权）。

8. **本稿不改变任何既有语义**：不做分支回退、不引入扩展入口、不放松 fails-closed、不新增退出码。

---

## 1. 问题陈述：loop 的当前形状

### 1.1 源码实测

`src/run/runner.ts` 的循环体（L436 起）结构为：

```text
for (;;) {
  const step = await provider.decide(context?)   // context 入参被 Faux 忽略
  switch (step.type) { ... 七个分支 ... }        // 逐条分派，执行完取下一条
}
```

三个可验证事实：

| # | 事实 | 证据 |
|---|---|---|
| 1 | 决策分派**逐条线性**，七个 `step.type` 各走一支 | `runner.ts` L481–638 连续 `if (step.type === ...)` |
| 2 | **不存在"工具结果 → 回填 → 再次决策"的往返** | loop 内无任何把 `tool/result` 重新投给 `provider` 的路径 |
| 3 | `decide()` 的 **`_context` 下划线命名 = 显式声明不使用 context** | `src/llm/fauxProvider.ts` |

turn 边界由 `turn/start`（L427 首段 / L462 段边界）与 `turn/end`（L339 `appendTurnEnd` / L671 终局补收口）圈定。终局补收口逻辑为：

```ts
if (turnOpen) {
  const closed = await appendEvent({ type: "turn/end", payload: { reason: outcome.kind } });
}
```

**即：任一终局（含 `suspended` / `aborted`）都会以 `reason = outcome.kind` 收口 turn。** 这是 A4 推荐口径的既有实现基础。

### 1.2 缺口定位

<svg width="680" viewBox="0 0 680 300" xmlns="http://www.w3.org/2000/svg" font-family="PingFang SC, sans-serif">
  <rect x="0" y="0" width="680" height="300" fill="#1a1b26"/>
  <text x="20" y="24" fill="#c0caf5" font-size="15" font-weight="bold">图 1 ｜ loop 的当前形状与缺口（上=现状，下=目标）</text>

  <rect x="20" y="38" width="640" height="96" rx="8" fill="#1f2130" stroke="#e0af68" stroke-width="1"/>
  <text x="34" y="56" fill="#e0af68" font-size="12" font-weight="bold">现状：Faux 脚本单程驱动（R2 之后仍是此形状）</text>

  <rect x="34" y="66" width="140" height="52" rx="6" fill="#2d202a" stroke="#f7768e" stroke-width="1.2"/>
  <text x="104" y="86" fill="#f7768e" font-size="12" font-weight="bold" text-anchor="middle">decide()</text>
  <text x="104" y="104" fill="#a9b1d6" font-size="10.5" text-anchor="middle">context 被忽略</text>

  <line x1="174" y1="92" x2="200" y2="92" stroke="#565f89" stroke-width="1.5"/>
  <polygon points="200,92 193,88 193,96" fill="#565f89"/>

  <rect x="204" y="66" width="140" height="52" rx="6" fill="#262637" stroke="#565f89" stroke-width="1.2"/>
  <text x="274" y="86" fill="#a9b1d6" font-size="12" font-weight="bold" text-anchor="middle">分派 switch</text>
  <text x="274" y="104" fill="#565f89" font-size="10.5" text-anchor="middle">7 个 step.type</text>

  <line x1="344" y1="92" x2="370" y2="92" stroke="#565f89" stroke-width="1.5"/>
  <polygon points="370,92 363,88 363,96" fill="#565f89"/>

  <rect x="374" y="66" width="140" height="52" rx="6" fill="#262637" stroke="#565f89" stroke-width="1.2"/>
  <text x="444" y="86" fill="#a9b1d6" font-size="12" font-weight="bold" text-anchor="middle">执行</text>
  <text x="444" y="104" fill="#565f89" font-size="10.5" text-anchor="middle">工具面 / 工作区直操作</text>

  <text x="530" y="90" fill="#f7768e" font-size="11">✗ 无回填</text>
  <text x="530" y="108" fill="#f7768e" font-size="11">✗ 无终止判据</text>

  <rect x="20" y="150" width="640" height="96" rx="8" fill="#1f2130" stroke="#9ece6a" stroke-width="1"/>
  <text x="34" y="168" fill="#9ece6a" font-size="12" font-weight="bold">目标：模型驱动闭环（一个 turn = 一个 provider 段）</text>

  <rect x="34" y="178" width="136" height="52" rx="6" fill="#1e2b30" stroke="#2ac3de" stroke-width="1.2"/>
  <text x="102" y="198" fill="#2ac3de" font-size="12" font-weight="bold" text-anchor="middle">组装 context</text>
  <text x="102" y="216" fill="#a9b1d6" font-size="10.5" text-anchor="middle">transformContext 投影</text>

  <line x1="170" y1="204" x2="190" y2="204" stroke="#2ac3de" stroke-width="1.5"/>
  <polygon points="190,204 183,200 183,208" fill="#2ac3de"/>

  <rect x="194" y="178" width="136" height="52" rx="6" fill="#1e2b30" stroke="#2ac3de" stroke-width="1.2"/>
  <text x="262" y="198" fill="#2ac3de" font-size="12" font-weight="bold" text-anchor="middle">模型 decide</text>
  <text x="262" y="216" fill="#a9b1d6" font-size="10.5" text-anchor="middle">仅合法决策</text>

  <line x1="330" y1="204" x2="350" y2="204" stroke="#2ac3de" stroke-width="1.5"/>
  <polygon points="350,204 343,200 343,208" fill="#2ac3de"/>

  <rect x="354" y="178" width="136" height="52" rx="6" fill="#1e2b30" stroke="#2ac3de" stroke-width="1.2"/>
  <text x="422" y="198" fill="#2ac3de" font-size="12" font-weight="bold" text-anchor="middle">守卫管道</text>
  <text x="422" y="216" fill="#a9b1d6" font-size="10.5" text-anchor="middle">审批嵌在 turn 内</text>

  <line x1="490" y1="204" x2="510" y2="204" stroke="#2ac3de" stroke-width="1.5"/>
  <polygon points="510,204 503,200 503,208" fill="#2ac3de"/>

  <rect x="514" y="178" width="136" height="52" rx="6" fill="#1e2b30" stroke="#2ac3de" stroke-width="1.2"/>
  <text x="582" y="198" fill="#2ac3de" font-size="12" font-weight="bold" text-anchor="middle">结果回填</text>
  <text x="582" y="216" fill="#a9b1d6" font-size="10.5" text-anchor="middle">tool/result 落盘</text>

  <path d="M582 234 L582 262 L102 262 L102 234" fill="none" stroke="#9ece6a" stroke-width="1.5"/>
  <polygon points="102,234 98,241 106,241" fill="#9ece6a"/>
  <text x="342" y="280" fill="#9ece6a" font-size="11.5" text-anchor="middle">闭环：结果回填后再组装 context —— 这是当前唯一缺失的一段</text>
</svg>

---

## 2. 设计约束（不可协商项）

### 2.1 来自既有 ADR / AGENTS.md 的硬约束

| 约束 | 对 loop 设计的含义 |
|---|---|
| **TCB 铁律**（AGENTS.md §3.1） | agent 生成的代码永在 TCB 外；模型不得触达闸门签署与审批工具 |
| **审批 fails-closed**（ADR-07） | 无有效授权一律拒绝；headless 下 exit 78；宿主"自动应答"永远无效 |
| **T0 不可引用为证据**（ADR-08） | loop 产生的任何引用必须经 `GuardedSessionLog`（铁律一守卫不可绕过） |
| **零 npm 运行时依赖**（R2a） | loop 不得引入 SDK；真实 provider 优先 Node 内置 `fetch` + 薄适配层 |
| **工具面收敛为 4** | loop 不得为模型开放工具面之外的任何操作入口 |
| **脱敏** | loop 相关文档不得出现真实业务内容与内部绝对路径 |

### 2.2 来自 R2 决议 §2.3 的契约变更口径（已定死，loop 必须遵守）

| 变更类型 | 处理 |
|---|---|
| **纯增量**（新增方法、新增**可选**字段/参数、错误码枚举扩面） | 补登登记，**不 bump** 桥接契约版本轴 |
| **破坏性**（改名、删字段、改既有字段语义、收窄枚举、帧/握手/生命周期变更） | **bump 桥接契约版本轴** |

→ **推论**：§4 A1 的 `turn/end.payload` 补 `step_count` 属**纯增量**，不 bump；A2 的 `stopReason` 枚举若只**扩面**不修改既有取值，同样不 bump。

### 2.3 来自 R2 决议 §3.3 的durability 公理（**本稿最重要的一条约束**）

R2 决议明确：内核的闸门推进登记（`_registered_gates`）与账本消费链（`ApprovalLedger._records`）**仅在会话进程内存，进程结束即消亡**；报告措辞必须是"由**同会话 query 反读**验证"，不得表述为"已持久化/可重建"。

<svg width="680" viewBox="0 0 680 270" xmlns="http://www.w3.org/2000/svg" font-family="PingFang SC, sans-serif">
  <rect x="0" y="0" width="680" height="270" fill="#1a1b26"/>
  <text x="20" y="24" fill="#c0caf5" font-size="15" font-weight="bold">图 2 ｜ 跨进程可重建性：ATF 侧只有一个凭证来源</text>

  <rect x="20" y="40" width="300" height="120" rx="8" fill="#262637" stroke="#e0af68" stroke-width="1.3"/>
  <text x="170" y="62" fill="#e0af68" font-size="12.5" font-weight="bold" text-anchor="middle">ATF 内核（L1 · 独立进程）</text>
  <text x="36" y="86" fill="#a9b1d6" font-size="11">· 闸门登记 `_registered_gates`（内存）</text>
  <text x="36" y="106" fill="#a9b1d6" font-size="11">· 账本审批链 `ApprovalLedger._records`（内存）</text>
  <text x="36" y="126" fill="#a9b1d6" font-size="11">· 数据集登记 `datasets/&lt;id&gt;@&lt;pin&gt;/`（磁盘）</text>
  <text x="36" y="148" fill="#f7768e" font-size="11">✗ 进程结束 → 内存两态消亡</text>

  <rect x="360" y="40" width="300" height="120" rx="8" fill="#262637" stroke="#9ece6a" stroke-width="1.3"/>
  <text x="510" y="62" fill="#9ece6a" font-size="12.5" font-weight="bold" text-anchor="middle">harness（L2–L4 · 独立进程）</text>
  <text x="376" y="86" fill="#a9b1d6" font-size="11">· `session.jsonl` append-only（唯一凭证）</text>
  <text x="376" y="106" fill="#a9b1d6" font-size="11">· `artifacts/catalog.json`（sha 指纹）</text>
  <text x="376" y="126" fill="#a9b1d6" font-size="11">· `scratch/provenance.json`</text>
  <text x="376" y="148" fill="#9ece6a" font-size="11">✓ 崩溃后可 replay 重建</text>

  <rect x="20" y="176" width="640" height="40" rx="6" fill="#2d202a" stroke="#f7768e" stroke-width="1.2"/>
  <text x="340" y="196" fill="#f7768e" font-size="11.5" text-anchor="middle" font-weight="bold">公理：loop 依赖的一切状态，必须在 harness 事件流里有对应留痕</text>
  <text x="340" y="211" fill="#a9b1d6" font-size="10.5" text-anchor="middle">内核内存态不可作为 loop 的判断依据；判断依据只能来自 harness 自己的事件流（`resolveCredentialState` 即此公理的既有实现）</text>

  <text x="340" y="242" fill="#565f89" font-size="11" text-anchor="middle">推论：loop 的"已消费 / 已推进"判定必须可由事件流确定性推导——不得依赖对内核的二次查询作为唯一依据</text>
</svg>

**该公理对 loop 的三条具体约束**：

1. **审批结论必须落事件**：`approval/request` + `approval/response` 落盘后，凭据状态由 `resolveCredentialState(events, credential, {recoveryWatermark})` **纯函数**推导（既有实现，本稿维持）。
2. **闸门推进结论必须落事件**：当前 `atf_gate` advance 的结果只在内核内存 + 工具返回值。loop 若需要在恢复后知道"某闸门推进过"，**必须把该事实写进本侧事件流**（本稿在 §5 B2 给出方案）。
3. **禁止以"再查一次内核"作为恢复依据**：内核内存态在进程重启后为空，二次查询会得到"不存在"而非"未推进"，两者语义不同 → 必然误判。**只能以本侧事件流为准。**

### 2.4 来自 R2 决议 §5 的内核侧议题（登记，不阻塞本稿）

| # | 内核侧议题 | 与 loop 的关系 |
|---|---|---|
| 1 | 审批跨进程可见性（`ApprovalLedger` 纯内存 + CLI `serve` 无 owners 注入） | 直接影响 P3-1「跨进程 run-resume 下 indeterminate 集成实测」；loop 的恢复路径设计必须假定"内核侧不可见" |
| 2 | 会话级预录入口（内核未实现 `ledger_record`） | 问答轨是当前唯一可行的"运行时授权"路径；loop 设计必须保留双轨（账本轨 + 问答轨）并存 |
| 3 | 完整性 Gate advance 的求值入参文档化 | 不阻塞 loop；影响将来覆盖完整 advance 链路 |

**结论：这三项都不阻塞本稿**，但它们决定了"loop 的恢复路径只能单向依赖本侧事件流"这一设计前提。

---

## 3. 目标 loop 的形状

### 3.1 主循环

```text
turn/start（一个 turn = 一个 provider 段）
  │
  ├─► 组装 context（transformContext：attempt 过滤 + compaction 投影）
  │       │
  │       ├─► provider.decide(context)  ── 仅返回 LlmDecision（合法决策）
  │       │        │
  │       │        ├─ null ──► 终止判据判定（§4 A2）
  │       │        └─ decision ──► 分派
  │       │
  │       ├─► tool_call ──► 守卫管道
  │       │        ├─ 参数 schema 校验
  │       │        ├─ 审批检查 ── 账本轨（ledger_query → ledger_consume）
  │       │        │              └ 未命中 → 问答轨（approval/request → response）
  │       │        ├─ 桥接执行
  │       │        └─ canonical output 校验
  │       │
  │       └─► 结果回填（tool/result 落盘，携 call_ref 配对）
  │
  └─► 回到「组装 context」（闭环；受轮次预算约束）
turn/end（reason = 终局原因）
```

### 3.2 与现状的差异（恰好三处）

| # | 差异 | 属 A/B 组 |
|---|---|---|
| 1 | `decide(context)` 真正消费 context（现状 context 被忽略） | B1 |
| 2 | 结果回填后**回到组装 context**（现状无回环） | A2 + B1 |
| 3 | `LlmDecision` 与 `ScenarioStep` 解耦（现状模型面含脚本指令） | §6 独立工作包 |

### 3.3 明确不做（防 scope）

| 不做 | 依据 |
|---|---|
| 树形会话 / 分支回退 | ADR-08 与承证场景要求历史不可分叉；"重新提案"用审批 `supersedes` 链表达 |
| 热加载 / 扩展注册入口 | TCB 铁律（通用方案 §3 列为不可照搬陷阱） |
| 并发工具批次 | §4 A3 |
| 新增退出码 | 现有 0/1/75/78/79 已覆盖；新增属破坏性变更 |
| 真实 provider 实现 | 属切片 3，需 owner 显式授权 + 新 snapshot/binding |

---

## 4. A 组：五项 schema 级决策

> 每项格式：**问题 → 选项 → 推荐口径 → 取舍依据 → 影响面 → 选备选的代价**

### A1 是否引入 step 粒度事件

**问题**：现状 `turn/start`·`turn/end` 之间，多个 `tool/call` 无独立边界；step（一次决策）不可直接观测。

**选项**：
1. 不新增事件类型；step 边界由 `tool/call`↔`tool/result` 配对恢复；`turn/end.payload` 补计数元数据
2. 新增 `step/start` + `step/end`（升至 14 类）
3. 新增单一 `step` 标记事件（升至 13 类）

**推荐：选项 1。**

**依据**：
- **可恢复性已足够**：`tool/call` 与 `tool/result` 的 `call_ref` 配对（`credentialState.ts` 的 A1 配对键）已给出隐式边界；一条决策 → 至多一对事件，step 计数可从事件数推导。
- **Pi 的 step 服务于 UI 原位更新与日志观察边界**；ATF 的 L4 是 headless 报告（`BranchRunReport` 已用内存序列 + replay 对账），对 step 粒度的实时性需求弱。
- **新增事件类型的边际成本高**：牵动 compaction 白名单（`materialOf` 过滤集）、投影白名单（`convertToLlm`）、审计留痕、`schema.test.ts` 白名单断言、契约文档同步。而收益仅是可观测性。
- **契约口径友好**：`turn/end.payload` 增 `step_count` 属纯增量（R2 §2.3），**不 bump**。

**影响面**：`turn/end` payload 形状、`TurnAttribution`（可复用 `decision_count`）、UI 投影（无变化）。

**选备选的代价**：schema v2（14 类 → 需同步 compaction 白名单、投影、审计、测试断言、契约文档），且与 `credentialState` 的既有配对逻辑形成两套边界概念。

**需补的元数据（纯增量）**：`turn/end.payload` 增 `{ step_count, decision_count }`；`turn/start.payload` 增可选 `step_budget`。

---

### A2 终止判据

**问题**：现状 Faux 的终止是"序列耗尽 → `provider_failure`"（视为故障），除非脚本以 `final_answer` 收尾。真实模型下"何时停"必须有确定性判据。

**选项**：
1. 单一判据：provider 返回 `null` 即停
2. **裁剪版四重判据**（Pi 范式 + ATF 治理裁剪）+ 显式轮次预算
3. 全量照搬 Pi：`stopReason` 五值（toolUse/stop/length/error/aborted）+ 批次 terminate + `shouldStopAfterTurn`

**推荐：选项 2。**

**判据设计**（新增 `stopReason` 枚举，只扩面、不改既有取值 → 不 bump）：

| 判据 | 触发 | 结果 |
|---|---|---|
| `final_answer` | provider 产出收尾决策 | `completed`（exit 0） |
| `no_more_tools` | provider 返回 `null` 且本 turn 已有 `final_answer` | `completed`（exit 0） |
| `budget_exhausted` | 轮次预算耗尽（新增） | `failed`（exit 1），block reason 可区分 |
| `error` | provider 自身故障 | `failed`（exit 1） |
| `aborted` | 应答 `verdict=abort` 或宿主终止 | `aborted`（exit 79） |

**核心新增项 —— 轮次预算（本项必须现在定）**：
- 真实模型驱动的 loop **没有预算就会失控**（无限工具调用 / 无限重试）。Faux 下不存在此风险（脚本有限），因此 Phase 0–2 从未涉及。
- 预算两个档：`max_steps_per_turn`（默认建议 32）与 `max_turns`（默认建议 8）；收在常量层（`src/session/constants.ts` 同侧新建 loop 常量），**模型不可见**。
- 预算耗尽 → `failed(budget_exhausted)`，**不新增退出码**（复用 1）。理由：预算耗尽不是治理事件（不涉闸门/审批），不应占用治理语义的退出码；且新增退出码属破坏性变更。

**"以可执行内容为准"原则（Pi 范式，建议采纳）**：即使 provider 返回长度截断，只要已产出**完整的工具请求**，仍执行之；反之即使 provider 声称完成，若未产出 `final_answer` 且无待处理动作，仍判未收束。这避免把供应商的结束标签当作唯一事实。

**影响面**：`LlmProvider` 的返回语义（`null` 的含义从"序列耗尽"升为"provider 自然结束"）；`BranchOutcome` 增 `budget_exhausted` 收敛路径；`runError` 增 `budget_exhausted` 码。

**选备选的代价**：选项 1 在真实模型下会产生"模型说完了但其实没做"的静默成功；选项 3 引入 Pi 的批次 terminate（ATF 无批次概念，见 A3），属多余抽象。

---

### A3 工具批次语义

**问题**：一次决策是否可含多个工具调用？执行是串行还是并发？

**选项**：
1. **一次决策 = 一个工具调用**；显式拒绝并行批次；adapter 把模型的多工具响应展开为顺序决策
2. 允许批次：一个决策含多个工具，串行执行、整批结果一起回填
3. 允许批次且并发执行（Pi 式）

**推荐：选项 1。**

**依据（治理侧的三个不可让步点）**：
1. **审批是逐工具一次性消费**：`ledger_consume{approval_ref, record_id}` 每次消费一笔记录（CAS 一次性跃迁）。若一批多工具共享一次授权，则"一次性"退化为"批量授权"，即审批面被放大——与 ADR-07 的"无配额复用"红线冲突。
2. **事件顺序必须是决策顺序**：`credentialState` 的消费判定依赖 `call_ref` 指向的 `tool/call` 事件存在且唯一；并发会让完成顺序与调用顺序脱钩，**重放时判定结果不可确定**。
3. **审计确定性与 §2.3 公理**：跨进程恢复只能依赖事件流；并发下的事件流顺序非确定 → 恢复不可复现。

**Pi 的对照**：Pi 允许批次并发是因为它**没有账本概念**（`beforeToolCall` 只是一次性钩子，无可消费的授权记录）。ATF 的审批语义天然要求序列化。**这是"照搬 Pi 会破坏治理"的典型一例。**

**代价与对策**：主流模型（OpenAI / Anthropic）都支持一次返回多个工具调用。**对策 = 在 adapter 层展开**：模型响应的多工具被 adapter 转成**顺序的多个 `LlmDecision`**，loop 语义仍是"一次决策一个工具"。这样 loop 保持简单，适配复杂度收在 B1（这也是 Pi "变化集中在最底层"原则的同一手法）。

**影响面**：`LlmProvider.decide()` 的返回类型（仍为单个 `LlmDecision`，语义收紧为"一次一个"）；B1 adapter 契约必须显式承担展开职责。

**选备选的代价**：选项 2 需重定义审批粒度（一批一次授权 or 每工具一次）；选项 3 直接与"重放可确定"冲突。

---

### A4 审批往返与 turn 的关系

**问题**：`approval/request` → `approval/response` 的往返，占一个 turn 还是嵌在 turn 内？挂起后恢复是否续同一 turn？

**选项**：
1. **审批嵌在 turn 内**；挂起时以 `turn/end{reason:"suspended"}` 收口；**resume 开新 turn**
2. 审批往返占一个独立 turn
3. 审批不占 turn，用独立"阶段"事件表达

**推荐：选项 1 —— 且这是仅"写进设计"、零改动面的选项。**

**依据（三条，全部有代码或决议支撑）**：

| 依据 | 证据 |
|---|---|
| **与现状一致，零改动** | `ToolExecutor.approve()` 在 `execute()` 内同步 await（账本轨）或 await handler（问答轨）——审批**本来就嵌在 turn 内**。R2 正在跑的实现即此形状，改它会与 R2 撞车 |
| **挂起时 turn 已收口** | `runner.ts` L669–680：`if (turnOpen) { appendEvent({type:"turn/end", payload:{reason: outcome.kind}}) }` —— `suspended` 终局会以 `reason:"suspended"` 收口 |
| **跨进程恢复后"同一 turn"无法自证** | 依 §2.3 公理，恢复时唯一凭证是本侧事件流。若强行"续同一 turn"，则 turn 边界与进程边界脱钩，`TurnAttribution.first_event_id/last_event_id` 不再对应单次运行 → 报告不可解释 |

**由此固化的三条不变量**（写入设计，不改代码）：

| 不变量 | 内容 |
|---|---|
| **INV-1** | 一个 turn 恰好对应一次连续的同进程执行，不跨进程 |
| **INV-2** | 任意终局（含 suspended / aborted / failed）必须收口 turn（`reason = outcome.kind`）——现有代码已满足 |
| **INV-3** | provider 切换边界仍在 turn 边界（既有规则不变）；审批往返**不构成**切换窗口 |

**影响面**：无代码改动；`resume` 语义（Phase 3 P3-1）在设计上被约束为"开新 turn"，与 `resolveCredentialState` 的 `recoveryWatermark` 机制天然契合（恢复后新注入的凭据 `id > watermark` → `available`）。

**选备选的代价**：选项 2 需改 `TurnAttribution` 与切换边界判定，并破坏"R2 正在跑的实现"——收益仅是"turn 数更好看"。选项 3 引入与 turn 并行的第二套边界概念。

---

### A5 是否新增第 13 类事件

**问题**：是否需要为 steering 注入 / 通用 resume / run 挂起点新增事件类型。

**选项**：
1. **本切片不新增**；保留位机制承接（`SESSION_RESERVED_EVENT_TYPES` 当前为空但机制保留）
2. 立即新增 `steering/injected` 等
3. 新增通用 `session/resume`

**推荐：选项 1。**

**依据**：
- schema v1 的 12 类在 P2-S3 刚推进到 12/12 全启用，**语义尚未在真实负载下检验**；此时扩充是在未验证的地基上加层。
- 三者的需求时点都不在切片 1：steering 属 B3（Phase 3 宿主嵌入才有输入通道）；通用 resume 属 Phase 3 P3-1；挂起点可由 `turn/end{reason:"suspended"}` 表达，**无需新事件**。
- **保留位机制已就绪**：`SESSION_RESERVED_EVENT_TYPES` 集合为空但机制保留（`isEnabledEventType` 拒绝保留位），将来新增先进保留位——这是 schema v1 设计时预留的正确出口，本稿直接复用。

**影响面**：无。

**选备选的代价**：schema v2（牵动 compaction 白名单 / 投影 / 审计 / 测试断言 / 契约文档），且新增事件在无消费场景下成为死代码。

---

## 5. B 组：五项编排级设计（方案级，不需现在拍板）

### B1 adapter 契约（`LlmContextEvent[]` ↔ 模型消息）

**问题**：现在 `LlmContextEvent` 已是模型可见的白名单投影，但没有"投影 → 具体模型消息格式"的映射——Pi 在 provider adapter 层做这件事，ATF 尚无。

**方案**：
- 在 `src/llm/` 增 adapter 契约（**接口 + 归一化规则，非协议实现**，维持 R2a）：
  - `LlmContextEvent[]` → 模型消息序列（角色映射：`user/message` → user；`assistant/message` → assistant；`tool/call` + `tool/result` → assistant tool_use + user tool_result；`approval/*` → 折叠为附件上下文或摘要）
  - 模型响应 → `LlmDecision`（**含 A3 的多工具展开**、A2 的 `stopReason` 归一化）
  - **稳定前缀纪律**（Pi 的 KV cache 经验）：`turn/start` 与 `system` 段必须落在序列前部，任何中途变化的内容（时间戳、事件 id）不得插入前缀区
- 该层是**唯一知道具体模型协议的位置**（变化集中在最底层）。

### B2 错误回填给模型的形态

**方案**（采纳 Pi 的经验："错误文本属执行协议的一部分"）：
- `tool/result` 的 `ok:false` payload 必须含**可执行的修正线索**，分三类：① 缺哪个字段（schema 违规）② 哪个路径/事实不存在 ③ 哪项操作被策略拒绝（含 block reason）
- 只给"调用失败"四字会让模型无法自我修正——这与 ATF 既有的"结构化回填 + block reason 分流"是同一方向，本项只是把它**写进设计并作为 adapter 契约的一部分**
- **并补 §2.3 公理的兑现**：闸门推进（`atf_gate` advance）与账本消费的结论需在本侧事件流留痕（如 `tool/result` payload 携 `gate_status` / `consumed_record_id`），使恢复后无须回查内核内存态

### B3 steering / follow-up

**方案**（保留 Pi 的关键经验：**两种队列的处理时点不同，不得合并**）：
- steering（及时改向）：在每个工具轮次结束后检查，进当前 turn
- follow-up（排队续作）：在内层循环自然退出后检查，接**新 turn**
- 注入通道：Phase 3 宿主嵌入时经 ACP（`permission` / `cancel` 通道）；此前的实现不得自建输入面
- 事件留痕：待 A5 的保留位启用（**本切片不做**）

### B4 `bind_run` 在 loop 生命周期中的调用时点

**方案**：
- **编排层不依赖**：契约头部已有明确规定——runner / FactScanResolver 构造即携 `run_id` 并以显式 `params.run_id` 调只读方法（无状态优先）
- `bind_run` 服务**宿主 / 长会话**场景（Phase 3 dispatch 时调用一次，与 turn 解耦）
- loop 设计承诺：**不引入对会话绑定的隐式依赖**（保持"方法无隐式依赖"的既有口径）

### B5 System Prompt 的注入点与治理归属

**方案**：
- **归属**：内容来自 **T2 冻结合同区**（`contracts/`），变更走晋升闸 B（决策记录 + 审批 + 原子变更）——**这是本稿唯一需要触碰 T2 的点**，但只登记归属、不实现闸 B（闸 B 仍是顺延项）
- **注入点**：`transformContext` 输出的**稳定前缀首部**（B1 的 KV cache 纪律）
- **时机**：属切片 3 前置（接入真实 provider 前必补）；切片 1/2 可用占位空串，**不改变 loop 语义**

---

## 6. 独立工作包：`LlmDecision` / `ScenarioStep` 类型拆分

### 6.1 问题

```ts
// src/llm/provider.ts
export type LlmDecision = ScenarioStep;   // ← 模型决策面 = 测试基建面
```

`ScenarioStep` 的七个成员混了两类：

| 类别 | 成员 | 模型可否产出 |
|---|---|---|
| 合法模型决策 | `assistant_message` / `tool_call` / `final_answer` | ✅ 可 |
| 脚本专用指令 | `scratch_write`（直写 T0）/ **`promote`（直连晋升闸 A）** / `cite_t0`（构造 T0 引用）/ `provider_switch`（编排指令） | ❌ **不可** |

**危害**：`runner.ts` L620–632 收到 `promote` 直接调用 `promoteArtifact`——即**晋升闸 A**。Faux 下脚本由测试编写，无风险；Phase 3 接入真实 provider 后，**模型只要能产出 `promote` 决策，就绕过了 4 工具面直接触达晋升闸**，与 AGENTS.md §3.1（TCB 铁律）和"工具面收敛为 4"正面冲突。

### 6.2 拆分方案

<svg width="680" viewBox="0 0 680 350" xmlns="http://www.w3.org/2000/svg" font-family="PingFang SC, sans-serif">
  <rect x="0" y="0" width="680" height="350" fill="#1a1b26"/>
  <text x="20" y="24" fill="#c0caf5" font-size="15" font-weight="bold">图 3 ｜ 决策类型拆分：模型面与测试基建面解耦</text>

  <text x="20" y="48" fill="#f7768e" font-size="12" font-weight="bold">拆分前（现状）</text>
  <rect x="20" y="58" width="640" height="76" rx="8" fill="#2d202a" stroke="#f7768e" stroke-width="1.3"/>
  <text x="36" y="78" fill="#f7768e" font-size="12" font-weight="bold">LlmDecision = ScenarioStep（单一类型，七个成员混两类）</text>
  <rect x="36" y="88" width="126" height="22" rx="4" fill="#1f2335" stroke="#3b4261"/>
  <text x="99" y="103" fill="#9ece6a" font-size="10" text-anchor="middle">assistant_message</text>
  <rect x="170" y="88" width="86" height="22" rx="4" fill="#1f2335" stroke="#3b4261"/>
  <text x="213" y="103" fill="#9ece6a" font-size="10" text-anchor="middle">tool_call</text>
  <rect x="264" y="88" width="90" height="22" rx="4" fill="#1f2335" stroke="#3b4261"/>
  <text x="309" y="103" fill="#9ece6a" font-size="10" text-anchor="middle">final_answer</text>
  <rect x="362" y="88" width="90" height="22" rx="4" fill="#1f2335" stroke="#f7768e"/>
  <text x="407" y="103" fill="#f7768e" font-size="10" text-anchor="middle">scratch_write</text>
  <rect x="460" y="88" width="70" height="22" rx="4" fill="#1f2335" stroke="#f7768e"/>
  <text x="495" y="103" fill="#f7768e" font-size="10" text-anchor="middle">promote</text>
  <rect x="538" y="88" width="66" height="22" rx="4" fill="#1f2335" stroke="#f7768e"/>
  <text x="571" y="103" fill="#f7768e" font-size="10" text-anchor="middle">cite_t0</text>
  <text x="36" y="126" fill="#f7768e" font-size="10.5">绿 = 合法模型决策　红 = 脚本专用指令（模型不该能产出；promote 直连晋升闸 A）</text>

  <text x="20" y="162" fill="#9ece6a" font-size="12" font-weight="bold">拆分后</text>

  <rect x="20" y="172" width="310" height="106" rx="8" fill="#262637" stroke="#9ece6a" stroke-width="1.3"/>
  <text x="36" y="192" fill="#9ece6a" font-size="12" font-weight="bold">LlmDecision（模型合法决策 · 独立契约）</text>
  <text x="36" y="212" fill="#a9b1d6" font-size="10.5">· { type:"tool_call", tool, params }</text>
  <text x="36" y="230" fill="#a9b1d6" font-size="10.5">· { type:"message", text }</text>
  <text x="36" y="248" fill="#a9b1d6" font-size="10.5">· { type:"final_answer", text }</text>
  <text x="36" y="268" fill="#565f89" font-size="10">LlmProvider.decide() 只返回本类型</text>

  <rect x="350" y="172" width="310" height="106" rx="8" fill="#2a2a3c" stroke="#e0af68" stroke-width="1.3"/>
  <text x="366" y="192" fill="#e0af68" font-size="12" font-weight="bold">ScenarioStep（测试基建 · run 层消费）</text>
  <text x="366" y="212" fill="#a9b1d6" font-size="10.5">= LlmDecision ∪ 脚本指令</text>
  <text x="366" y="230" fill="#a9b1d6" font-size="10.5">· scratch_write · promote · cite_t0</text>
  <text x="366" y="248" fill="#a9b1d6" font-size="10.5">· provider_switch（编排指令）</text>
  <text x="366" y="268" fill="#565f89" font-size="10">不进 provider 接口，只由 runner 测试路径消费</text>

  <rect x="20" y="292" width="640" height="42" rx="6" fill="#1e2b30" stroke="#2ac3de" stroke-width="1.3"/>
  <text x="340" y="310" fill="#2ac3de" font-size="11.5" text-anchor="middle" font-weight="bold">新增守卫：assertModelDecision(step) —— provider 返回脚本指令即 failed（fail-closed）</text>
  <text x="340" y="327" fill="#a9b1d6" font-size="10.5" text-anchor="middle">这样"模型能否触达晋升闸 A"从"约定"变为"类型不可表达 + 运行时拒绝"的双重保证</text>
</svg>

### 6.3 为什么单列工作包

- **不依赖 A 组任何结论**（拆分是类型层面的正交操作）
- **可独立验收**：`tsc` 类型检查 + `assertModelDecision` 正反例 + 既有测试零回归
- **越早越便宜**：拖到切片 3，改的是已经对真实内核端到端跑通的接口面
- **紧迫性高于设计选择**：它是**真隐患**（治理可被绕过），不是偏好问题

---

## 7. 与 R2 的关系（并行不冲突的论证）

### 7.1 为什么不冲突

| 维度 | R2 | 本稿（loop 设计） | 是否冲突 |
|---|---|---|---|
| 改动对象 | `runner.ts` 的**对端**（`mockCommand` → 真内核）+ 夹具模块 | **驱动源**、终止判据、类型契约 | ✗ 不冲突 |
| 接口面 | 不改（契约 v2 冻结，7 方法签名稳定） | 不改桥接方法签名 | ✗ |
| 文件面 | `tests/run/realPeer/*`、`smoke:r2`、夹具工厂 | `src/llm/`、`src/run/`（切片 1/2） | ✗（若并行，注意 `runner.ts` 不同区块） |
| 真实写 | 限 `/tmp/atf-r2-*` 夹具根 | 无写动作 | ✗ |

### 7.2 三个必须对齐的接触点

| # | 接触点 | 本稿口径 | 与 R2 的关系 |
|---|---|---|---|
| 1 | **审批与 turn 的关系**（A4） | 维持现状（嵌在 turn 内；挂起收口 turn；resume 开新 turn） | **正是为不与 R2 撞车而选**——R2 正在跑的 `ToolExecutor.approve()` 即此形状 |
| 2 | **契约 bump 口径**（§2.2） | 遵守 R2 §2.3 已定死口径（纯增量不 bump） | 本稿 A1 的 `step_count`、A2 的 `stopReason` 扩面均属纯增量 |
| 3 | **跨进程可重建性公理**（§2.3） | 作为 loop 设计公理，loop 依赖的状态必须落本侧事件流 | 直接来自 R2 §3.3 的边界标注；本稿 B2 给出兑现方案 |

### 7.3 需要 R2 门 2 报告反馈的一项

R2 决议 §3.3 要求报告如实体现"内存登记不得写成已落盘"。**若 R2 门 2 报告在 `atf_gate` advance 或 `ledger_consume` 上披露了与本稿 §2.3 公理冲突的观察**（例如同会话 query 反读失败、或消费幂等性有例外），则切片 1 需据此调整 B2 的留痕方案。**这是本稿唯一需要等 R2 输出的地方**，其余部分可并行推进。

---

## 8. 切片建议

| 切片 | 内容 | 依赖 | 可启动时点 |
|---|---|---|---|
| **切片 0** | `LlmDecision` / `ScenarioStep` 类型拆分 + `assertModelDecision` 守卫（§6） | 无（不依赖 A 组结论） | **立即可启动** |
| **切片 1** | loop 骨架：终止判据 + 轮次预算 + step 元数据（A1/A2/A4/A5 的落地）＋ 契约纯增量补登 | 本稿门 1 通过 + R2 门 2 报告（§7.3） | 门 1 通过后 |
| **切片 2** | adapter 契约 + 多工具展开 + 错误回填（B1/B2，含 §2.3 公理兑现） | 切片 1 | 切片 1 闭合后 |
| **切片 3** | 真实 provider + 审批人在回路 = **L1 交互级** | 切片 2 + owner 显式授权 + 新 snapshot/binding | Phase 3 首切片 |

**纪律延续**：每切片代码 + vitest + 冒烟 + 变更描述 → owner review；测试基线不得回归；内核仓零改动；`dependencies` 恒空。

---

## 9. 待 owner 裁决点清单

| # | 裁决点 | 推荐口径 | 备选 |
|---|---|---|---|
| **D1** | A1 step 粒度 | 不新增事件类型；`turn/end` 补 `step_count`/`decision_count`（纯增量不 bump） | 新增 step 事件（升 13/14 类） |
| **D2** | A2 终止判据 | 裁剪版四重判据 + **显式轮次预算**（`max_steps_per_turn` 32 / `max_turns` 8）；`stopReason` 枚举扩面；**不新增退出码** | 单一判据 / 全量照搬 Pi |
| **D3** | A3 工具批次 | **显式拒绝并行**；一次决策一个工具；adapter 展开多工具响应为顺序决策 | 允许批次串行 / 允许并发 |
| **D4** | A4 审批与 turn | 维持现状（嵌在 turn 内）+ 固化 INV-1/2/3 三条不变量；resume 开新 turn | 审批占独立 turn |
| **D5** | A5 第 13 类事件 | 本切片不新增；保留位机制承接 | 新增 steering / resume 事件 |
| **D6** | 类型拆分是否单列工作包先做 | **是**（§6）——不依赖 A 组结论、可独立验收、紧迫性最高 | 并入切片 1 |
| **D7** | 本稿是否升格为正式设计（门 1 通过） | 由 owner 判定；建议通过后据 §8 签发切片 1 任务书 | 先讨论修订 |
| **D8** | 内核侧 §2.4 三项是否登记为 Phase 3 前置 | **是**（登记不阻塞）——尤其议题 1（审批跨进程可见性）直接决定 P3-1 的可行域 | 不登记 |

---

## 10. 不在本稿范围（显式排除）

| 排除项 | 归属 |
|---|---|
| 真实 provider 的具体协议实现 | 切片 3（需 owner 授权 + 新 snapshot/binding） |
| ACP server 化与消费面实现 | Phase 3 主体（D1/ADR-09 已完成消费面定型） |
| 晋升闸 B（T2 写入通道） | 顺延项；本稿仅登记 System Prompt 的治理归属（B5） |
| 树形会话 / 分支回退 | 已裁定不做（ADR-08） |
| 内核侧改动（审批跨进程可见性 / 会话级预录） | 内核议题，本仓不插队不阻塞（§2.4） |
| `bridge.contract.yaml` 的破坏性变更 | 本稿全部建议均为纯增量 |

---

*本稿为讨论稿，不含任何代码改动。所有源码引用基于 `A800_5005:/data/sam/ATF-Harness` @ `0dc75b2` 实测；约束引自 `AGENTS.md` §3、ADR-05~09、《R2 门 1 评审·门 2 放行》§2.3/§3.3/§5。*

---

## 实施章节（切片 1 落地，2026-09-14——《ATF独立Harness_切片1任务书_loop骨架_20260914.md》交付）

### I.1 终止判据表（A2 裁剪版四重判据 + 显式预算；实施形态）

| 判据 | 触发（实施口径） | 结果 | stop_reason |
|---|---|---|---|
| `final_answer` | provider 产出 final_answer 决策（分派即收口） | `completed`（exit 0） | `final_answer` |
| `no_more_tools` | provider 返回 `null` 且本 turn 已产出 final_answer（`resolveExhaustionStop`） | `completed`（exit 0） | `no_more_tools` |
| `budget_exhausted` | `turn_step_count ≥ LOOP_MAX_STEPS_PER_TURN(32)`（loop 顶，不再调用 provider）；或段边界开新 turn 前 `turnsOpened + 1 > LOOP_MAX_TURNS(8)` | `failed`（exit 1，runError code = `budget_exhausted`，可区分） | `budget_exhausted` |
| `error` | provider decide 自身故障（err） | `failed`（exit 1，code = `provider_failure` 既有取值不变） | `error` |
| `aborted` | 应答 verdict=abort / 宿主终止（既有 P2-S2 路径零改动） | `aborted`（exit 79） | `aborted` |

未收束（null 且无 final_answer 且无待处理动作）维持既有 `provider_failure` 终局——"以可执行内容为准"：
不把 provider 的结束信号当唯一事实；完整工具请求一旦产出即执行（执行先于后续判据）。

### I.2 预算（模型不可见）

- `LOOP_MAX_STEPS_PER_TURN = 32` / `LOOP_MAX_TURNS = 8`（`src/session/constants.ts`，与 compaction/fsync 常量同层）；
- 不可见性三重保证：①`llm_context_event_fields` 白名单不含预算字段位（session.contract.yaml pipeline 节）；
  ②runner 不向 `decide(context)` / 工具 params 注入任何预算信息；③`LlmDecision` 类型面无预算字段。
- 耗尽 → `failed(budget_exhausted)` 复用 exit 1（预算非治理事件，不占治理退出码）。

### I.3 step 元数据（A1，纯增量）

`turn/end.payload` = `{reason, step_count, decision_count, stop_reason?}`：
- `step_count`：本 turn 已分派执行的内容步（provider_switch 请求不计——无内容执行）；
- `decision_count`：本 turn provider 决策数（含被拒的 provider_switch 请求）；
- `stop_reason`：仅五值判据命中时携带；既有 `reason` 取值零改动（INV-2 兼容）。
session.contract.yaml 已按纯增量注记（不 bump 任何版本轴）；`bridge.contract.yaml` 零改动。

### I.4 不变量（A4）与断言口径

- **INV-1**（一个 turn = 一次连续同进程执行，不跨进程）：挂起（suspended）收口 turn，resume 开新 turn——
  断言：事件流中 turn/start 与 turn/end 严格成对、不嵌套（任意前缀中 end 数 ≤ start 数）；
- **INV-2**（任意可写终局必须收口 turn，reason = outcome 收口语义）：断言：终局报告的事件流最后一条
  事件（除落盘通道本身失效的 session_failure 边界外）为 turn/end；切片 1 修复既有缺口——provider
  decide err 路径此前不收口，现以 `{reason:"failed", stop_reason:"error"}` 收口；
- **INV-3**（provider 切换边界 = turn 边界；审批往返不构成切换窗口）：断言：provider/switch 事件仅
  出现于 turn/end 与下一 turn/start 之间（既有 `checkSwitchBoundary(turnOpen, …)` 强制 + 测试断言）；
  审批 request/response 往返不产生 switch 事件（P2-S2 既有用例承载）。
