# ATF-Harness Owner 决议与启动指令——P2-S2 门 1 评审：设计 v1.1 修订（门 2 未放行）

**签发人**：owner
**日期**：2026-09-11
**执行人**：zcode（A800_5005:/data/sam/ATF-Harness）
**依据**：《ATF-Harness_Owner决议与启动指令_P2S1闭合_P2S2启动_20260911.md》§3.1/§3.2 + ADR-09（ACCEPTED v1.3）+ 门 1 产出《ATF独立Harness_Phase2_凭据消费模型小设计_20260911.md》（`4e3651e`）
**结论先行**：**门 1 方向通过（推导式消费 + 事实后置 + 窗口阻断，不触发 schema v2），但设计需出 v1.1——三项必改（R1 判定上下文入参、R2 持久化前置、R3 配对精确化）。四项裁决已定，其中两项经主流框架对标后确认。门 2 BUILD 仍未放行。**

---

## 1. 门 1 验收复核（owner 独立核验）

| 项 | 复核方式 | 结果 |
|---|---|---|
| 门纪律 | `git show --stat 4e3651e` | ✅ 仅 `docs/` 两份（小设计 100 行 + P2-S1 闭合决议 115 行）；**零代码改动**；`git diff -- src/ tests/ package.json` 为空 |
| 预写禁令 | 复核工作树 | ✅ 无凭据消费相关预写；pin `.atf-pinned` = `a628f8b` 未动；工作树干净 |
| 五问覆盖 | 逐节比对 §1–§5 | ✅ 五问均有明确回答，无回避 |
| 四约束自证 | 逐条核对 §5 | ✅ 四条均给出论证（推导式在 v1 内完备，不触发 v2） |
| 关键论证质量 | 复核 §2 配对链、§3 窗口分析 | ✅ 回溯链 `request_event_ref → approval/request → tool_call_id → tool/call` 精确；窗口分析与账本轨并列对账，结论"宁可卡死，不得重执行"正确 |

**予以确认、v1.1 不得改动的部分**：消费事实载体选"既有 `tool/result` 存在性"（不新增事件类型）；判定四值模型（consumed / available / indeterminate / invalid）；配对纪律（沿 `request_event_ref` 逐跳回溯，`approval_session_id` 仅作多轮审计分组）；否决备选 B 的理由；两轨窗口同格对比；四约束自证框架。

## 2. 三项必改（v1.1）

### R1（P0）判定上下文入参：以「恢复水位线」替代「同进程 / 恢复上下文」的二分

**问题**：§2/§3 用「同进程连续执行上下文 vs 恢复上下文」区分 `available` 与 `indeterminate`，但函数签名 `resolveCredentialState(events, credential)` **只吃事件流**——"本进程落盘"是进程性事实，流内不可得。后果有二：① 「纯函数、重放恒等」的声明不成立（§1 理由 2、§5 约束①）；② 布尔式"是否恢复"会混淆两种情形——**恢复时流内既有的悬空 granted**（上次执行可能已发生 → 应阻断）与**恢复后由 `resume(answer)` 新注入的 granted**（应放行执行）。后者被误判将使 **ADR-09 C3 的 resume 语义失效**。

**修法**：判定签名改为三元输入，第二项为**恢复水位线**：

```text
resolveCredentialState(events, credential, context)
  credential = { approval_session_id, request_event_ref }
  context    = { recoveryWatermark: number }   // 恢复/启动时刻流内最大事件 id；全新 run = 0
```

边界随之确定：`granted.id ≤ watermark` → 旧遗留 → `indeterminate`；`granted.id > watermark` → 本次恢复后新注入 → `available`（可执行）。

**配套表述修正**：§1 理由 2、§5 约束① 的措辞由「重启后由同一纯函数重放得出同一结论」改为「判定为 **(事件流, 水位线) 的确定性函数**，同一水位线下的重放恒等」——不夸大其为"仅由流决定"。

**必测断言**（门 2）：恢复后用 `resume(answer)` 注入 granted → 判定为 `available` 并被放行执行（resume 语义不被窗口策略误杀）。

### R2（P1）持久化前置：放行前必须确保 granted 已落盘

**问题**：契约 `durability.consumer_discipline`（S1b 定）要求"需要证据级持久性的消费者必须用 `per-append` 档或显式 `flush()`"。设计的放行路径未提持久化——若 run 处于**批量档**（ack = write 级），执行内核调用后断电，**granted 事件丢失而执行已发生**，恢复后流内既无凭据也无结果，等于出现一次"无授权痕迹的执行"。

**修法**：在 §3 的顺序声明中补入前置条件——判定为 `available` 后、调用内核前，**必须先确保该 granted 事件已持久化**（显式 `flush()` 并确认成功；或断言当前为 `per-append` 档）；持久化失败 → 不放行（结构化 block，fail-closed）。并引用契约 `durability.consumer_discipline` 条目。

**必测断言**（门 2）：批量档下放行前确实完成刷盘；刷盘失败 → 不放行。

### R3（P2）配对精确化：`tool/result` 与 `tool/call` 改用显式引用

**问题**：§2 以「该 `tool/call` 之后的**同名工具** `tool/result` 已落盘」判定消费。事实核对：`tool/call` payload 仅 `{tool, params}`、`tool/result` payload 仅 `{tool, ok, …}`（`src/run/runner.ts:101–103`、`255–290`），**两者之间无任何显式标识**，配对隐式依赖"同名 + 位置"，在并发调用、结果与调用交错、同名工具多次调用时会错配。

**修法**：在 `tool/call` 与 `tool/result` payload 中各写入 `call_ref`（= `tool/call` 事件 id）；消费判定改为「存在 `payload.call_ref` 等于该 call 事件 id 的 `tool/result`」。**payload 为自由 JSON、无 schema 约束，不触发 v2**。补充说明：旧流不含 granted 事件、不进入凭据判定，故无需兼容退化路径。

---

## 3. 四项裁决

### 3.1 消费记录方式：维持推导式（不做前置显式记录、不做 v2）

**主流对标结论**：前置意图记录确为主流（Temporal 在执行前写 `ActivityTaskScheduled`；其官方幂等配方为先插幂等键记录再执行副作用；DBOS / Restate / Dapr Workflow 的 journal 均先记再执行；LangGraph 每 super-step 存 checkpoint + pending writes，已完成节点不重跑）。**但我们的架构已具备前置意图记录**——`tool/call` 在调用内核前落盘（Phase 1 既有顺序），granted 与该次调用的配对由 `request_event_ref → tool_call_id` 精确建立。故新增显式消费事件属重复记账，只换来 schema v2 的代价。

**裁决**：维持推导式；**不新增第 13 类事件、不触发 v2**；`schema_version` 保持 1，门 2 仅推进启用位（enabled 9 → 11）。

参考：Temporal Activity execution / idempotency（docs.temporal.io、temporal.io/blog/idempotency-and-durable-execution）、LangGraph checkpointers（docs.langchain.com）、Dapr/Diagrid durable execution 分析。

### 3.2 `indeterminate` 终局：停 run + 上报（终态，非"换路径"）

**主流对标结论**：主流在**无幂等键**时统一采取 **at-most-once 语义——不重放、把不确定性上报**（Temporal `maxAttempts=1` 即此语义：宁可不做也不重复做）。没有任何主流框架把"副作用状态未知"当作一次可绕过的普通拒绝。

**事实核对**：`bridge.contract.yaml` 的 `atf_admit_data`（`dataset_id` / `source`）与 `atf_gate`（`gate` / `action` / `evidence_refs`）**均无幂等键参数**，内核侧无重复调用去重承诺——故只能走"不重放"这一条。

**裁决**：`indeterminate` **升级为 run 终态**，语义 = 「不确定性上报，需人工核对」：
1. 不重放该调用、不允许模型换路径继续（后续步骤若建立在错误前提上，产出不可信）；
2. 退出码走既有集合的 **`failed`（1）** + 结构化原因 `credential_indeterminate`（**不新增退出码**，退出码集合 0/1/75/78/79 已定死）；
3. 上报形态 Phase 2 为结构化输出 + 运行报告条目（列明待核对信息：`approval_session_id` / `tool_call_id` / `tool` / `approval_key` / 窗口区间）；人工核对界面属 Phase 3（不做界面）；
4. 与 `denied` 明确区分：`denied` 是决策（可换路径继续），`indeterminate` 是事实缺口（必须停）。

### 3.3 幂等键前瞻路径：登记为后续议题

**裁决**：登记「内核方法支持幂等键（如以 `approval_key` / `request_id` 去重）→ 窗口内可升级为安全重放、无需人工介入」为 re-pin 后可谈项。登记位置：ADR-09 §5.3 新增开放点 (e) + 阶段报告。**Phase 2 不实现、不探索。**

### 3.4 修订时点：先出 v1.1，门 2 未放行

**裁决**：门 1 设计出 **v1.1**（含 §2 三项必改 + §3 四项裁决结论采纳），交 owner review；**通过后才放行门 2 BUILD**。依据：三项必改都触及判定函数接口与放行顺序，是 BUILD 的直接输入，先定后写避免返工。

---

## 4. v1.1 最小改动清单（不得夹带）

| # | 位置 | 改动 |
|---|---|---|
| 1 | 文首状态/修订说明 | 增 v1.1 修订说明块（依本决议）；注明门 2 仍未放行 |
| 2 | §1 理由 2 | 表述修正为「(事件流, 水位线) 的确定性函数」 |
| 3 | §2 判定表 | `available` / `indeterminate` 边界改为 `granted.id` 与 `recoveryWatermark` 比较；函数签名补 `context` 入参；补「resume(answer) 注入的 granted 必须可执行」一条显式结论 |
| 4 | §2 配对纪律 | 判定改用 `tool/result.payload.call_ref`（并说明该字段在 §6 门 2 落点写入） |
| 5 | §3 顺序段 | 补 R2 持久化前置（`flush()` 成功或 per-append 断言；失败不放行）并引用契约 `durability.consumer_discipline` |
| 6 | §3 处置表 | `indeterminate` 处置改为「run 终态 failed(1) + 结构化原因 `credential_indeterminate` + 人工核对上报材料」 |
| 7 | §4 组合表 | 「账本未命中 + 凭据 `indeterminate`」行同步为终态语义（不再表述为普通 block） |
| 8 | §5 约束自证 | 按 R1–R3 与四项裁决更新（尤其约束①的幂等证明改为"同一水位线下"、约束④补持久化前置） |
| 9 | 新增 §5.5 | 「主流对标与裁决采纳」小节：四项裁决结论 + 参考来源（可精简为一表） |
| 10 | §6 门 2 落点预告 | 补 `call_ref` 写入、水位线注入、持久化前置、`indeterminate` 终态与上报材料四项落点；补幂等键议题登记说明 |

**禁止**：不改五问框架与四值模型本身；不改已确认的载体选择（推导式）与配对链（`request_event_ref` 回溯）。

---

## 5. 门 2 放行条件与后续

1. v1.1 交付并入库（本地提交，不 push）→ 交 owner review；
2. review 通过 → owner 签发门 2 放行（或在本决议上追加放行指令），随后按《P2S1闭合_P2S2启动》§3.2 十二条口径 BUILD；
3. 门 2 验收项在原九项基础上**追加**：R1 的 resume 可执行性断言、R2 的持久化前置断言、R3 的 `call_ref` 精确配对用例、`indeterminate` 终态用例（exit 1 + `credential_indeterminate`）。

## 6. 纪律不变条款

1. 门结构不得跳越：v1.1 未过 review 前不得进 BUILD、不得预写实现。
2. 内核仓只读：pin `v0.2.0b7` / `a628f8b` 不动；幂等键议题 Phase 2 不探索。
3. 测试基线不得回归（当前 138 passed / 2 skipped）；零 npm 运行时依赖。
4. 不得新增第 13 类事件、不得启用 `provider/switch`（属 S3）；不得新增桥接方法面；不得以 setup 基建承载运行时语义。
5. 脱敏纪律延续。
