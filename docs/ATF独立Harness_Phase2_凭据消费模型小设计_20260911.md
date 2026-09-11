# ATF 独立 Harness Phase 2——凭据消费模型小设计(P2-S2 门 1 交付)

> **日期**:2026-09-11 ｜ **性质**:小设计(仅设计,不含实现;owner review 通过后方可进门 2 BUILD)
> **依据**:《ATF-Harness_Owner决议与启动指令_P2S1闭合_P2S2启动_20260911.md》§3.1 五问 + §2.2 四约束 + ADR-09 §1.3(ACCEPTED v1.3,C6/C7)+《ATF-Harness_Owner决议与启动指令_D1闭合_P2S1启动_20260910.md》§2.1(应答即授权凭据)
> **结论先行**:**消费事实不设显式事件,由会话事件流确定性推导——消费 = 被授权调用的完成事实(`tool/result` 落盘)」;判定为纯函数四值(consumed / available / indeterminate / invalid);崩溃窗口(执行后、回填前)以 `indeterminate → 阻断` 兜底,fail-closed 强度与账本轨一致。不触发 schema v2,不新增第 13 类事件。**

---

## 1. 消费事实的载体(§3.1 问 1)

**载体 = 授权调用的完成事实,不新增任何事件类型。**

一次 granted 凭据(`approval/response`,verdict=granted)经 `request_event_ref → approval/request → tool_call_id → tool/call 事件` 精确回溯到它授权的那次调用。该凭据的「已被使用」**由流内既有事实承载**:被授权调用对应一条 `tool/result` 落盘(无论 `ok` 真假——凭据授权的是一次**调用尝试**,结果成败不回补授权,与账本轨「消费即核销、不问业务结果」同构)。

选择推导而非显式记录的理由:

1. **不需要新载体**:v1 的 12 类事件内,`tool/result` 天然是「调用已发生」的唯一权威事实;为消费再造一条显式记录反而引入「记录与流内事实不一致」的第二真相源风险;
2. **append-only 免疫**:推导式判定对 compaction / replay / 尾部修复全部透明(只依赖事件存在性,不依赖位置),重启后由同一纯函数重放得出同一结论;
3. **不触发 v2**:约束 2 的「若无解走 v2」不成立——下述判定在 v1 内完备(含崩溃窗口的兜底,见 §3)。

被否决的备选(留档):**备选 B = v2 新增显式消费事件(如 `approval/consume`,执行前落盘)**。它与账本轨的 `ledger_consume` 前置语义完全同构,但需 v2 定义修订 + 新事件类型,且消费记录与执行效果仍是两条事实;在 §3 的窗口补偿达到同等 fail-closed 强度的前提下,不为其付出 v2 代价。若 owner review 后仍要求消费前置,再按约束 2 走 v2 报批。

---

## 2. 重启幂等判定(§3.1 问 2):确定性纯函数,四值

**判定路径选「由事件流推导」**(而非显式记录读取),理由即 §1;函数签名(P2-S2 BUILD 落 `src/tools/`,与审批检查点同层):

```text
resolveCredentialState(events, credential) =
    consumed | available | indeterminate | invalid

credential = { approval_session_id, request_event_ref }   // 取自 granted 应答事件
```

| 判定 | 条件(全为事件流上的存在性/引用检查,无时钟、无外部状态) | 处置 |
|---|---|---|
| `invalid` | granted 事件不存在;或 `request_event_ref` 指向的 request 不存在 / 类型不符 / `tool_call_id` 无法回溯到 `tool/call` 事件 | 视为死凭据:不得执行,结构化 block(fail-closed,宁可错杀) |
| `consumed` | 回溯链完整,且该 `tool/call` 之后的同名工具 `tool/result` 已落盘 | 凭据已耗尽:再次以此凭据请求执行 → 结构化 block(防双执行主闸) |
| `indeterminate` | 回溯链完整,`tool/result` 不存在,**且处于恢复上下文**(进程重启后自流恢复) | **阻断**:既不执行也不猜已执行,升级处置(S2 run 层结构化 block)——见 §3 窗口分析 |
| `available` | 回溯链完整,`tool/result` 不存在,且处于**同进程连续执行上下文**(该 granted 由本进程生命周期内落盘,检查点正常放行) | 执行该次调用;执行后 `tool/result` 落盘,判定自然翻转为 `consumed` |

配对纪律:消费判定**沿 `request_event_ref` 逐跳精确回溯**,`approval_session_id` 仅承担多轮审计分组——同会话多轮(clarification / advise 重提案)各有各的 request 与 tool_call_id,granted 只消费它 `request_event_ref` 指向的那条调用,杜绝同会话错配(ADR-09 C6 可审计配对的落地)。

**重启幂等的证明**:恢复后同一凭据的所有可能路径都被封死——结果已落盘 → `consumed` 拒;结果不在 → `indeterminate` 阻断;链断 → `invalid` 拒。不存在任何「恢复后判定为可执行」的路径,`available` 仅在同进程连续流(对端未生效是本进程确定事实)内可达。判定函数无副作用、幂等,对同一流重复求值恒等。

---

## 3. 执行与消费事实的先后顺序(§3.1 问 3)

**明示顺序:凭据判定 → (available) → 执行(对端生效)→ `tool/result` 落盘(消费事实成立)。消费事实后置于执行效果。**

由此存在一个结构性窗口:**对端已生效、`tool/result` 未落盘时进程中断**——恢复后流内无法区分「未执行」与「已执行未回填」。处置如下,并与账本轨对齐论证:

| | 账本轨(Phase 1 既有) | 问答轨(本设计) |
|---|---|---|
| 消费事实 | `ledger_consume`(对端持久,**执行前**) | `tool/result` 落盘(**执行后**) |
| 崩溃窗口 | consume 后、执行前中断 | 执行后、result 前中断 |
| 恢复后判定 | 已消费 → blocked,**不重执行** | `indeterminate` → 阻断,**不重执行** |
| fail-closed 强度 | 卡死不重执行(窗口内) | **卡死不重执行(窗口内,且更保守:连「确实没执行过」的情形也一并阻断)** |

两轨窗口内的处置同格:**宁可卡死,不得重执行**。问答轨因消费事实后置,恢复侧无法区分两种中断原因,按约束 4「不确定即阻断」全量阻断——这是有意的保守,不是缺口;其代价(极小概率下的不必要人工介入)远小于双执行。若 owner 认为必须消除该窗口(消费前置),出路即 §1 备选 B(v2 显式消费事件),按约束 2 报批,本设计不自行采用。

fail-closed 边界小结:判定不出(`invalid` / 链断)→ 拒;判定 `consumed` → 拒;判定 `indeterminate` → 阻断;唯一放行路径 `available` 的前提(本进程内确定未生效)由检查点调用上下文保证,不依赖任何「猜已执行/未执行」。

---

## 4. 与账本轨并存的判定优先级(§3.1 问 4)

审批检查点(单次须审批调用)按序判定,**账本轨优先**(决议六 F 不变):

| 组合 | 行为 |
|---|---|
| 账本命中(未消费记录) | `ledger_consume` 消费放行(账本轨一次性语义零改动);问答凭据不参与本次判定,互不豁免 |
| 账本未命中 + 凭据 `available` | 问答轨放行执行;执行后凭据自然翻转为 `consumed` |
| 账本未命中 + 凭据 `consumed`/`indeterminate`/`invalid` | 结构化 block(原因区分:`credential_consumed` / `credential_indeterminate` / `credential_invalid`);模型可换路径(重提计数按同提案口径累计,达阈值 2 次升级) |
| 账本未命中 + 无凭据 | 已声明 `approval_surface` → 发 `approval/request` 进入等待(timeout → suspended,75);未声明 → `blocked`(exit 78,Phase 1 逐位一致) |

无配额复用由判定天然保证:一次 granted 恰好对应一条 `tool/result` 完成事实,第二次引用同凭据必落 `consumed`。

---

## 5. 四条约束自证(§3.1 问 5 / §2.2)

| 约束 | 自证 |
|---|---|
| ① 重启幂等(防双执行) | §2:恢复后不存在可达的放行路径(consumed 拒 / indeterminate 阻断 / invalid 拒);判定纯函数、重放恒等 |
| ② 不新增第 13 类事件 | §1:载体为既有 `tool/result` 存在性,零新类型;`schema_version` 保持 1,门 2 仅启用位推进(enabled 9 → 11) |
| ③ 禁 setup 基建 | 判定输入仅为会话事件流(本仓 append-only log),全程不触 `ledger_record` / 桥接 setup 方法;账本轨查询仍走既有 `ledger_query`(运行时方法面,Phase 1 既有) |
| ④ fail-closed 优先 | §3:唯一放行路径前提显式(同进程确定未生效);三种非放行态全部结构化拒绝/阻断;顺序与窗口如实声明,不确定即阻断,无「猜已执行」路径 |

---

## 6. 门 2 落点预告(非本门交付)

- 判定函数 `resolveCredentialState` 落 `src/tools/`(纯函数、可独立单测,四态各一组构造流用例);
- 悬空审批会话的恢复检测(流尾 granted 无 result → indeterminate 阻断)落 `src/run/` 恢复路径;
- 测试面按指令 §3.3:六类应答正反例、supersedes 演化链、拒绝循环升级、凭据 fails-closed(含桩对端缺省)、账本轨零改动、退出码 0/75/78/79/1 单出口、性能实测(≥10k 事件 append 耗时)。

**门 1 交付完毕,停下等 owner review;门 2 BUILD 未获放行不启动。**
