# ATF 独立 Harness Phase 2——凭据消费模型小设计(P2-S2 门 1 交付)

> **日期**:2026-09-11 ｜ **版本**:v1.1(评审修订版) ｜ **性质**:小设计(仅设计,不含实现;owner review 通过后方可进门 2 BUILD)
> **依据**:《ATF-Harness_Owner决议与启动指令_P2S1闭合_P2S2启动_20260911.md》§3.1 五问 + §2.2 四约束 + 《ATF-Harness_Owner决议与启动指令_P2S2门1评审_设计v1.1修订_20260911.md》(R1–R3 必改 + 四项裁决)+ ADR-09 §1.3(ACCEPTED v1.3,C6/C7)+《ATF-Harness_Owner决议与启动指令_D1闭合_P2S1启动_20260910.md》§2.1(应答即授权凭据)
> **状态**:门 1 交付,等 owner review——**门 2 BUILD 未放行**
> **结论先行**:**消费事实不设显式事件,由会话事件流确定性推导——消费 = 被授权调用的完成事实(`tool/result` 落盘,经 `call_ref` 显式配对);判定为 (事件流, 恢复水位线) 的确定性函数,四值(consumed / available / indeterminate / invalid);放行前强制 granted 持久化前置(契约 `durability.consumer_discipline`);崩溃窗口以 `indeterminate → run 终态 failed(1) + credential_indeterminate + 人工核对上报` 兜底,at-most-once,fail-closed 强度与账本轨一致。不触发 schema v2,不新增第 13 类事件。**

**修订记录**:v1.0(2026-09-11,`4e3651e`,门 1 初版)→ **v1.1**(2026-09-11):依《P2S2门1评审_设计v1.1修订》§4 十处清单——R1 判定上下文入参(恢复水位线,替代"同进程/恢复"二分)、R2 持久化前置、R3 `call_ref` 精确配对、`indeterminate` 升级 run 终态 failed(1)、新增 §5.5 主流对标与裁决采纳;五问框架、四值模型、载体选择(推导式)与配对链(`request_event_ref` 回溯)未改。**门 2 仍未放行。**

---

## 1. 消费事实的载体(§3.1 问 1)

**载体 = 授权调用的完成事实,不新增任何事件类型。**

一次 granted 凭据(`approval/response`,verdict=granted)经 `request_event_ref → approval/request → tool_call_id → tool/call 事件` 精确回溯到它授权的那次调用。该凭据的「已被使用」**由流内既有事实承载**:被授权调用对应一条 `tool/result` 落盘(无论 `ok` 真假——凭据授权的是一次**调用尝试**,结果成败不回补授权,与账本轨「消费即核销、不问业务结果」同构)。

选择推导而非显式记录的理由:

1. **不需要新载体**:v1 的 12 类事件内,`tool/result` 天然是「调用已发生」的唯一权威事实;为消费再造一条显式记录反而引入「记录与流内事实不一致」的第二真相源风险;
2. **判定是 (事件流, 恢复水位线) 的确定性函数**:同一水位线下的重放恒等;恢复与实时的判定差异被显式建模为水位线入参(R1,见 §2),而非隐含的进程性事实——append-only 语义下推导对 compaction / replay / 尾部修复全部透明(只依赖事件存在性与引用链,不依赖位置);
3. **不触发 v2**:约束 2 的「若无解走 v2」不成立——下述判定在 v1 内完备(含崩溃窗口的兜底,见 §3;配对精确化经 `call_ref` 解决,见 §2,该字段写入自由 payload,无 schema 约束)。

被否决的备选(留档):**备选 B = v2 新增显式消费事件(如 `approval/consume`,执行前落盘)**。它与账本轨的 `ledger_consume` 前置语义完全同构,但需 v2 定义修订 + 新事件类型,且消费记录与执行效果仍是两条事实;经 §5.5 主流对标确认——本架构已具备前置意图记录(`tool/call` 在调用内核前落盘 + `request_event_ref → tool_call_id` 精确配对),显式消费事件属重复记账。若 owner 日后改变裁决,再按约束 2 走 v2 报批。

---

## 2. 重启幂等判定(§3.1 问 2):确定性纯函数,四值

**判定路径选「由事件流推导」**(而非显式记录读取),理由即 §1;函数签名(R1,落 `src/tools/`,与审批检查点同层)——**第二上下文参数为恢复水位线**,替代 v1.0 的「同进程 / 恢复上下文」二分(进程性事实不入函数,水位线使其成为可重放的确定性输入):

```text
resolveCredentialState(events, credential, context) =
    consumed | available | indeterminate | invalid

credential = { approval_session_id, request_event_ref }
context    = { recoveryWatermark: number }   // 恢复/启动时刻流内最大事件 id;全新 run = 0
```

| 判定 | 条件(全为事件流上的存在性/引用/比较检查,无时钟、无进程态) | 处置 |
|---|---|---|
| `invalid` | granted 事件不存在;或 `request_event_ref` 指向的 request 不存在 / 类型不符 / `tool_call_id` 无法回溯到 `tool/call` 事件 | 视为死凭据:不得执行,结构化 block(fail-closed,宁可错杀) |
| `consumed` | 回溯链完整,且存在 `payload.call_ref` 等于该 call 事件 id 的 `tool/result` 已落盘 | 凭据已耗尽:再次以此凭据请求执行 → 结构化 block `credential_consumed`(防双执行主闸) |
| `indeterminate` | 回溯链完整,`tool/result` 不存在,**且 `granted.id ≤ recoveryWatermark`**(旧遗留:上次运行的中断窗口,执行可能已发生) | **run 终态**(见 §3):failed(1) + `credential_indeterminate` + 人工核对上报 |
| `available` | 回溯链完整,`tool/result` 不存在,**且 `granted.id > recoveryWatermark`**(本次恢复后经 `resume(answer)` 新注入,或全新 run 内本进程落盘) | 执行该次调用;执行后 `tool/result` 落盘,判定自然翻转为 `consumed` |

边界判据的唯一依据是 `granted.id` 与水位线的大小关系——流内可检验,重放恒等:

- `granted.id ≤ watermark`:旧遗留悬空授权 → 上次执行是否已生效不可知 → `indeterminate`;
- `granted.id > watermark`:**本次恢复后由 `resume(answer)` 新注入的 granted 必须判定为 `available` 并放行执行**——这是显式结论:ADR-09 C3 的 resume 语义(挂起后注入应答、继续执行)不被窗口策略误杀。

配对纪律(R3):消费判定改用**显式引用配对**——`tool/result.payload.call_ref` 等于被授权 `tool/call` 的事件 id。v1.0 的「同名工具 + 位置就近」为隐式配对,在同名工具多次调用、结果与调用交错时会错配;`call_ref` 由门 2 在写入路径落定(两 payload 各写入一次,见 §6),payload 为自由 JSON,不触发 v2。旧流(Phase 1 / P2-S1 产物)不含 granted 事件、不进入凭据判定,无需兼容退化路径。`approval_session_id` 仅承担多轮审计分组——同会话多轮(clarification / advise 重提案)各有各的 request 与 tool_call_id,granted 只消费它 `request_event_ref` 指向的那条调用(ADR-09 C6 可审计配对的落地)。

**重启幂等的证明**:恢复时刻,流内全部既有 granted 恒满足 `id ≤ watermark`,故恢复后立即可判的只有 `consumed` / `indeterminate` / `invalid`——**不存在任何放行路径**;`available` 仅对恢复后新注入(`id > watermark`)的凭据可达。判定为 (事件流, 水位线) 的确定性函数,同一水位线下重复求值恒等。

---

## 3. 执行与消费事实的先后顺序(§3.1 问 3)

**明示顺序(R2):凭据判定 → `available` → ① granted 持久化确认 → ② 执行(对端生效)→ ③ `tool/result` 落盘(消费事实成立)。**

**① 持久化前置(放行的硬性前置条件)**:判定为 `available` 后、调用内核前,**必须先确保该 granted 事件已持久化**——当前为 `per-append` 档则 ack 即 fsync(直接断言档位);处于批量档则显式 `flush()` 并确认成功。持久化失败 → **不放行**(结构化 block,fail-closed)。依据:契约 `session.contract.yaml → durability.consumer_discipline`(S1b 定案)——「需要证据级持久性的消费者必须使用 per-append 档,或在推进状态前显式调用 flush() 并确认成功」;否则批量档断电场景会出现「granted 丢失而执行已发生」的无授权痕迹执行。

由此窗口收敛为:**持久化确认之后、`tool/result` 落盘之前**的进程中断——恢复后流内 `granted.id ≤ watermark` 且无 `call_ref` 结果 → `indeterminate`,流内无法区分「未执行」与「已执行未回填」。

| | 账本轨(Phase 1 既有) | 问答轨(本设计) |
|---|---|---|
| 消费事实 | `ledger_consume`(对端持久,执行前) | `tool/result` 落盘(执行后;granted 持久化前置) |
| 崩溃窗口 | consume 后、执行前中断 | 持久化确认后、result 前中断 |
| 恢复后判定 | 已消费 → blocked,**不重执行** | `indeterminate` → **run 终态**,**不重执行** |
| fail-closed 强度 | 卡死不重执行(窗口内) | 卡死不重执行(窗口内,且更保守:连「确实没执行过」的情形也一并终局) |

两轨窗口内的处置同格:**宁可卡死,不得重执行**。

**`indeterminate` 终局处置(§3.2 裁决,at-most-once)**——语义 =「不确定性上报,需人工核对」:

1. **不重放该调用,不允许模型换路径继续**(后续步骤若建立在错误前提上,产出不可信);
2. 退出码走既有集合的 **`failed`(1)** + 结构化原因 **`credential_indeterminate`**(**不新增退出码**,0/1/75/78/79 已定死);
3. 上报形态(Phase 2)= 结构化输出 + 运行报告条目,列明待核对信息:`approval_session_id` / `tool_call_id` / `tool` / `approval_key` / 窗口区间(`granted.id` 与水位线);人工核对界面属 Phase 3(不做界面);
4. 与 `denied` 明确区分:`denied` 是**决策**(可换路径继续),`indeterminate` 是**事实缺口**(必须停)。

fail-closed 边界小结:判定不出(`invalid` / 链断)→ 拒;`consumed` → 拒;`indeterminate` → 终局停 run;唯一放行路径 `available` 叠加两层前置——`id > watermark` 与 granted 持久化确认,全程无「猜已执行/未执行」路径。

---

## 4. 与账本轨并存的判定优先级(§3.1 问 4)

审批检查点(单次须审批调用)按序判定,**账本轨优先**(决议六 F 不变):

| 组合 | 行为 |
|---|---|
| 账本命中(未消费记录) | `ledger_consume` 消费放行(账本轨一次性语义零改动);问答凭据不参与本次判定,互不豁免 |
| 账本未命中 + 凭据 `available` | 持久化前置确认后问答轨放行执行;执行后凭据自然翻转为 `consumed` |
| 账本未命中 + 凭据 `consumed` | 结构化 block `credential_consumed`;模型可换路径(同提案重提计数累计,达阈值 2 次升级) |
| 账本未命中 + 凭据 `indeterminate` | **run 终态:failed(1) + `credential_indeterminate` + 人工核对上报材料**——不是普通 block,不允许换路径(§3 终局处置) |
| 账本未命中 + 凭据 `invalid` | 结构化 block `credential_invalid`;模型可换路径 |
| 账本未命中 + 无凭据 | 已声明 `approval_surface` → 发 `approval/request` 进入等待(timeout → suspended,75);未声明 → `blocked`(exit 78,Phase 1 逐位一致) |

无配额复用由判定天然保证:一次 granted 恰好对应一条 `call_ref` 结果事实,第二次引用同凭据必落 `consumed`。

---

## 5. 四条约束自证(§3.1 问 5 / §2.2)

| 约束 | 自证 |
|---|---|
| ① 重启幂等(防双执行) | §2:判定为 (事件流, 水位线) 的确定性函数,**同一水位线下重放恒等**;恢复时刻流内既有凭据恒 `id ≤ watermark`,可判态只有 consumed / indeterminate / invalid——恢复后放行路径为零;`available` 仅对恢复后新注入(`resume(answer)`)可达,ADR-09 C3 语义不受损 |
| ② 不新增第 13 类事件 | §1/§2(R3):载体为既有 `tool/result` 存在性,配对经自由 payload 字段 `call_ref`(无 schema 约束);`schema_version` 保持 1,门 2 仅启用位推进(enabled 9 → 11) |
| ③ 禁 setup 基建 | 判定输入仅为会话事件流(本仓 append-only log),全程不触 `ledger_record` / 桥接 setup 方法;账本轨查询仍走既有 `ledger_query`(运行时方法面,Phase 1 既有);持久化前置使用会话层自有 `flush()`(S1b 公开口),非桥接面 |
| ④ fail-closed 优先 | §3:放行需三重前提显式成立——`id > watermark`、链路完整回溯、**granted 持久化确认**(flush 成功或 per-append 断言,失败不放行);非放行态全部结构化拒绝或终局上报,无「猜已执行/未执行」路径 |

### 5.5 主流对标与裁决采纳(决议 §3)

| 裁决 | 结论 | 主流对标 | 采纳理由 |
|---|---|---|---|
| 3.1 消费记录方式 | **维持推导式;不新增第 13 类事件、不触发 v2**;`schema_version` 保持 1(门 2 仅启用位 9→11) | 前置意图记录确为主流:Temporal 执行前写 `ActivityTaskScheduled`、官方幂等配方为先插幂等键再执行副作用;DBOS / Restate / Dapr Workflow journal 均先记再执行;LangGraph 每 super-step 存 checkpoint + pending writes,已完成节点不重跑 | **本架构已具备前置意图记录**——`tool/call` 在调用内核前落盘(Phase 1 既有),granted 与该次调用的配对由 `request_event_ref → tool_call_id` 精确建立;显式消费事件属重复记账,只换来 v2 代价 |
| 3.2 `indeterminate` 终局 | **升级 run 终态**:failed(1) + `credential_indeterminate` + 上报;不重放、不换路径 | 无幂等键时主流统一 **at-most-once**——不重放、上报不确定性(Temporal `maxAttempts=1`:宁可不做也不重复做);无框架把「副作用状态未知」当普通拒绝绕过 | 事实核对:`atf_admit_data` / `atf_gate` 参数均**无幂等键**,内核侧无重复调用去重承诺——只能不重放 |
| 3.3 幂等键前瞻 | **登记为后续议题**(ADR-09 §5.3 新增开放点 (e) + 阶段报告;登记动作随门 2/阶段报告落地):内核方法支持幂等键(如以 `approval_key` / `request_id` 去重)→ 窗口内可升级为安全重放、无需人工介入 | 幂等键是 durable execution 框架处理副作用的通用解(Temporal 幂等配方) | **Phase 2 不实现、不探索** |
| 3.4 修订时点 | 门 1 出 v1.1,交 owner review;**通过后才放行门 2 BUILD** | —— | 三项必改触及判定函数接口与放行顺序,是 BUILD 直接输入,先定后写避免返工 |

---

## 6. 门 2 落点预告(非本门交付)

- **`call_ref` 写入(R3)**:`tool/call` 与 `tool/result` payload 各写入 `call_ref`(= `tool/call` 事件 id),落 `src/run/runner.ts` 事件构造路径;消费判定以 `payload.call_ref` 精确配对;
- **水位线注入(R1)**:run 恢复/启动时刻的 `recoveryWatermark`(流内最大事件 id,全新 run = 0)由 `src/run/` 注入判定上下文;`resume(answer)` 注入的 granted 可执行性断言为门 2 必测;
- **持久化前置(R2)**:放行路径落 `src/tools/` 审批检查点——per-append 档断言或显式 `flush()` 确认,失败不放行;
- **`indeterminate` 终态与上报材料**:run 终态 failed(1) + `credential_indeterminate`,运行报告条目列明 `approval_session_id` / `tool_call_id` / `tool` / `approval_key` / 窗口区间;
- **幂等键议题登记**:随门 2 产出在 ADR-09 §5.3 新增开放点 (e) + 阶段报告登记(re-pin 后可谈项,Phase 2 不实现不探索);
- 其余测试面按指令 §3.3:六类应答正反例、supersedes 演化链、拒绝循环升级、凭据 fails-closed(含桩对端缺省)、账本轨零改动、退出码 0/75/78/79/1 单出口、性能实测(≥10k 事件 append 耗时)。

**v1.1 交付完毕,停下等 owner review;门 2 BUILD 未放行,不启动。**
