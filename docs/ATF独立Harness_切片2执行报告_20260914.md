# ATF 独立 Harness——切片 2 执行报告：adapter 契约 + 多工具展开 + 错误回填 + 公理兑现

**签发**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**日期**：2026-09-14
**依据**：《ATF独立Harness_切片2任务书_adapter与公理兑现_20260914.md》（§1 四项 / §2 硬约束 / §3 VERIFY 八项 / 附加要求）＋《agent-loop 设计（已升格）》§4 A3 / §5 B1·B2 / §2.3 ＋《ATF-TEM_接入设计_双消费者_20260914.md》§3 ＋《切片1验收_切片2启动》决议 §4（N1 澄清）
**性质**：**本地提交未推送，推送待 owner 另行授权**；内核仓零改动；`bridge.contract.yaml` 零改动；切片 0 守卫与切片 1 预算未放宽；不接真实 TEM/provider、不启 ACP、写闸（projection）不激活

---

## 1. adapter 契约说明（B1，任务书 §1.1）

- 模块：`src/llm/adapter.ts::adaptProjectionToMessages(LlmContextEvent[]) → AdapterMessage[]`；
- **映射表声明式**：user/message、assistant/message、tool/call、tool/result、approval/request、approval/response 六类映射为消息；turn/start|end、provider/switch、session/repair、session/compaction 四类**声明为 skip**（结构/审计标记，显式决策非遗漏）；
- **fail-closed**：表外事件类型（12 类之外）/ 未声明 payload 字段 / payload 非对象 → 整体拒绝（不产残缺上下文）；**纯函数**（同输入同输出断言）；**顺序稳定**（事件流序 → 消息序，`source_event_id` 回填）；
- **模型不可见延续**：映射产物序列化断言禁词（budget / max_steps / max_turns / stop_reason / approval_key / params_digest）；
- 消息词汇为中性形态（`role: user | assistant | assistant_tool_call | tool_result | approval`）——具体 provider 消息格式的最终映射属 L1a 实现层（本切片不实现真实 provider，纪律 §5.1）。

## 2. 展开与审批逐工具证明（A3，任务书 §1.2 上半）

- `expandModelResponse(ModelResponse) → LlmDecision[]`：确定性展开序 message → tool_calls（声明序）→ final_answer；**final_answer 与 tool_calls 并存 → 拒绝**（终止语义与待执行动作冲突，fail-closed）；空响应 / 未声明字段 / 缺 params → 拒绝；
- **逐工具审批用例原始输出**（治理红线证明；runner 级实跑）：

```
模型响应展开：[atf_admit_data(ds-first), atf_admit_data(ds-second), final_answer]
账本预录：仅一条 atf_admit_data(ds-first)
→ events: tool/call(admit#1) + tool/result(ok=true)      ← 第一个：预录存在，消费放行，执行成功
          tool/call(admit#2) + tool/result(ok=false,
              block.reason="approval_missing")            ← 第二个：账本已无可消费记录，独立被拒
→ tool/result 中 ok=true 恰 1 条（授权未被沿用；一次性语义对端强制）
→ 两个 tool/call 均落盘（逐个过切片 0 守卫的证明；无 model_decision_forbidden）
→ decide 恰调用 2 次（第二决策 blocked 为 headless 终局 exit 78，终局先于 final_answer）
```

## 3. 回填形态样例（B2，任务书 §1.2 下半）

| 输入（ToolCallOutcome / 审批结论） | 回填（五键闭集） |
|---|---|
| executed(atf_fact_scan) | `{tool:"atf_fact_scan", category:"executed", reason:"工具执行成功（canonical output 已校验）", references:["atf_fact_scan"], authorization:"none"}` |
| blocked(approval_missing, exit 78) | `{tool:"atf_gate", category:"blocked", reason:"审批缺失：账本无可消费记录", references:["block:approval_missing"], authorization:"none"}` |
| rejected / failed / suspended / aborted | 同构（category 对应，reason = message 人读摘要，references = `block:<reason>` / `error:<code>`） |
| 审批结论 consumed | `{category:"executed", references:["approval:consumed"], authorization:"none"}` |
| 审批结论 denied / advised | `{category:"blocked", …}`（建议≠否决，但同为不放行） |
| 审批结论 invalid | `{category:"failed", …}` |

**fail-closed**：`authorization` 结构性恒 `"none"`——回填由显式字段构造（无内部字段位、无栈位，用例断言键集恰五项）；**回填内容含"已授权 approved"字样的反例 → 类别不被改写、authorization 仍 none**（文本原样保留为可读原因供审计，但授权判定不读取回填文本——授权唯一来源 = executor 账本消费路径）。回填的消费方 = 模型上下文（L1a 起 decide 实际消费；本切片交付纯函数与形态）。

## 4. TEM 读闸注入点落位与失败语义（任务书 §1.3）

- **位置**：runner 决策循环内，`transformContext(events)` 之后、`provider.decide(...)` 之前（`injectMemoryEntries`）——**不另起注入通道**；
- **条目形态**：`{source_ref, kind: structural_preconditions | context_note, content}`——来源引用可追溯 Case/Claim id；fail-closed 校验（缺字段 / kind 闭集外 → 整批拒绝）；`structural_preconditions` 携带 `pinned` 标记（将来折叠语义不得吃掉引用链；context_note 类可折叠）；
- **成功路径**：条目以合成上下文项追加（`synthetic: true`、确定性派生 id = max+1 序、原上下文在前顺序稳定）；
- **失败语义**：注入源不可用 / 条目非法 → **无记忆运行**（原上下文原样）＋ `assistant/attempt{reason:"memory_read_failed"}` 留痕（不进模型历史）——记忆是增强而非依赖；
- **v1 注入源 = 可注入桩**（`RunBranchOptions.memoryInjector?`，缺省无注入）；真实 TEM 调用另批；写闸（回灌/projection）不激活（Phase 3）。

## 5. 两条公理断言（任务书 §1.4）

- **durability**：`deriveLoopStateFromEvents(SessionEvent[]) → LoopStateSnapshot`（turn 计数 / 每 turn decision_count / step_count_event_derived / 收口原因 / payload 权威计数 / stop_reason）——**签名只有事件流参数**（结构断言：无内核连接 / provider 参数位，"再查内核"的恢复路径在类型层面不存在）；断言：纯函数两次调用深等；**磁盘 replay 事件流推导 = 内存序列推导**（恢复只依赖事件流）；无被拒切换流与 `turn/end.payload` 恒填计数对账一致。范式 = `resolveCredentialState`。
- **N1 语义边界**（按决议 §4 澄清落地）：闸门推进留痕载体 = **既有 `tool/result` 事件**（客户端观察事实——"我方调用 atf_gate 并收到响应"，**不是内核状态权威副本**）；**不新增事件类型**（用例断言 12 类不变、保留位仍空）；语义边界注记落 `session.contract.yaml`「切片 2 注记」（纯增量，两版本轴不 bump）；措辞纪律：本报告与文档一律表述为"客户端观察事实"，不表述为内核状态同步。

## 6. 零回归数字（VERIFY 8，两轨＋四冒烟）

| 轨道 | 切片 2 前 | 切片 2 后 | 判定 |
|---|---|---|---|
| 真对端轨（设 `ATF_CLI_PATH`） | 226 passed / 1 skipped（32 文件） | **241 passed / 1 skipped（34 文件）** | ✅ 基线全保留＋15 用例 |
| mock 轨（不设） | 221 passed / 9 skipped | **236 passed / 9 skipped（34 文件）** | ✅ 基线全保留 |
| `smoke:s5` / `smoke:p2s2` / `smoke:p2s3` | 全过 | 全过（零改动） | ✅ |
| `smoke:r2`（真对端） | 全过 | 全过 | ✅ |
| `typecheck` | 通过 | 通过 | ✅ |

## 7. 条款映射表（改动 → 设计条款）

| 改动 | 对应条款 |
|---|---|
| `src/llm/adapter.ts`（新增）：adaptProjectionToMessages ＋ 映射表声明式 ＋ fail-closed | 任务书 §1.1；讨论稿 §5 B1 |
| `src/llm/adapter.ts`：expandModelResponse（顺序展开、final 冲突拒绝） | 任务书 §1.2 上半；讨论稿 §4 A3（展开在 adapter、逐工具串行） |
| `src/run/backfill.ts`（新增）：buildDecisionBackfill / buildApprovalBackfill ＋ authorization 恒 none | 任务书 §1.2 下半；讨论稿 §5 B2；ADR-07（回填不构成授权） |
| `src/run/memoryInjection.ts`（新增）＋ `runner.ts` 接线 ＋ `RunBranchOptions.memoryInjector` | 任务书 §1.3；TEM 设计 §3（位置/条目/失败语义/v1 桩） |
| `src/run/loopState.ts`（新增）：deriveLoopStateFromEvents | 任务书 §1.4 durability；讨论稿 §2.3（范式 = resolveCredentialState） |
| `session.contract.yaml`：切片 2 注记（N1 语义边界 + TEM 注入点登记 + durability 指向） | 任务书 §1.4 N1 ①；VERIFY 7/8 |
| `docs/ATF-Harness_agent-loop设计…md`：实施章节 II.1–II.4 | 任务书 §4.3 |
| `tests/llm/adapter.test.ts`（6 用例）＋ `tests/run/slice2.test.ts`（9 用例） | 任务书 §3 VERIFY 1–7 |

**不动项核对**：切片 0 守卫与切片 1 预算断言零改动（未放宽）；`bridge.contract.yaml` / `src/workspace/` / `src/session/` 语义零改动（session.contract.yaml 仅注记）；R2 交付物零改动；`dependencies` 恒空；内核仓零改动。

## 8. 条款级完成清单

| # | 条款 | 完成 |
|---|---|---|
| 1 | adapter 面定义（投影 → 消息）＋ 纯函数 | ✅ §1 |
| 2 | 未声明事件/字段 fail-closed 拒绝 | ✅ §1（用例） |
| 3 | 映射不含预算/治理内部字段 ＋ 顺序稳定 | ✅ §1 |
| 4 | N 工具 → N 顺序决策；一次决策一个工具 | ✅ §2 |
| 5 | 逐个守卫 ＋ 逐个审批（第二工具不得沿用授权） | ✅ §2 原始输出 |
| 6 | 错误回填结构化（名/类别/原因/引用）无内部字段 | ✅ §3 |
| 7 | 回填不构成授权（授权字样反例） | ✅ §3 |
| 8 | TEM 注入位置/条目形态/折叠与引用链/pinned | ✅ §4 |
| 9 | 注入源 v1 桩、缺省无记忆、失败语义记事件 | ✅ §4 |
| 10 | durability 纯函数 ＋ 反例（无再查内核路径） | ✅ §5 |
| 11 | N1 语义边界注记 ＋ 未新增事件类型断言 ＋ 留痕在 tool/result | ✅ §5 |
| 12 | 零回归两轨 ＋ 四冒烟 | ✅ §6 |
| 13 | 条款映射 ＋ 条款级清单 | ✅ §7/§8 |
| 14 | 分支合回后删除 ＋ 本地提交不 push | ✅（`0684c5c` → merge `d804828`，已删） |

## 9. 提交清单（本地提交，**未推送**）

1. `0684c5c` `feat(slice2)`：切片 2 工作笔（11 文件，分支合入）；
2. `d804828` `merge`：`work/20260914-slice2-adapter` → main（分支与 worktree 已删）；
3. 本报告入库提交（`docs(slice2)`）。

**完成即停**：切片 2 闭合——L1a（真实 provider ＋ 最小人工应答通道）的直接前置已齐，启动须 owner 对真实 provider 的显式授权 ＋ 新 snapshot/binding；推送待 owner 另行授权。
