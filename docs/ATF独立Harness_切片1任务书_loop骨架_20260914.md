# ATF 独立 Harness——切片 1 任务书：loop 骨架（终止判据 ＋ 轮次预算 ＋ step 元数据）

**日期**：2026-09-14
**签发**：owner
**执行方**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**依据**：《ATF-Harness_agent-loop设计_门1讨论稿_20260914.md》**（已升格为正式设计）** §3.1 主循环 / §4 A1·A2·A4·A5 ／《切片0验收_切片1启动》决议 ／ `AGENTS.md`
**前置**：**切片 0 已闭合**（类型面澄清：`LlmDecision` 三成员 ＋ `assertModelDecision` 守卫生效）
**结论先行**：把 loop 从"脚本耗尽即结束"变成**有确定性终止判据 ＋ 显式预算**的骨架；`turn/end.payload` 补 step 元数据（**纯增量，不 bump 桥接契约轴**，不新增事件类型/退出码）。**不含** adapter 与多工具展开（属切片 2）。

---

## 0. 现状与缺口（owner 侧实测）

| 项 | 事实 |
|---|---|
| 现状终止 | `provider` 序列耗尽 → `provider_failure`（**当作故障**），除非脚本以 `final_answer` 收尾 |
| 现状预算 | **无**——真实模型驱动下会失控（无限工具调用 / 无限重试）；Faux 下不可见 |
| 现状元数据 | `turn/start`·`turn/end` 之间多个 `tool/call` 无 step 粒度观测 |
| 关系 | 与切片 0 不冲突（类型面已澄清）；与切片 2 的边界：**本切片不做** context 消费、多工具展开、错误回填 |

## 1. 范围（严格四项）

### 1.1 终止判据（A2）

实现裁剪版四重判据 ＋ 显式预算，产出 `stopReason` 枚举（**只扩面、不改既有取值 → 不 bump**）：

| 判据 | 触发 | 结果 |
|---|---|---|
| `final_answer` | provider 产出收尾决策 | `completed`（exit 0） |
| `no_more_tools` | provider 返回 `null` 且本 turn 已产出 `final_answer` | `completed`（exit 0） |
| `budget_exhausted` | 轮次预算耗尽 | `failed`（exit 1），block reason 可区分 |
| `error` | provider 自身故障 | `failed`（exit 1） |
| `aborted` | 应答 `verdict=abort` 或宿主终止 | `aborted`（exit 79） |

**"以可执行内容为准"原则**（Pi 范式，采纳）：即使 provider 返回长度截断，只要已产出**完整工具请求**仍执行之；反之即使 provider 声称完成，若未产出 `final_answer` 且无待处理动作，仍判**未收束**。

### 1.2 轮次预算（本项必须现在落地）

- 两档：`max_steps_per_turn`（**默认 32**）与 `max_turns`（**默认 8**）；
- 收在**常量层**（`src/session/constants.ts` 同侧新建 loop 常量），**模型不可见**（不得进入任何注入上下文或工具参数）；
- 耗尽 → `failed(budget_exhausted)`，**复用 exit 1**，**不新增退出码**（预算耗尽不是治理事件，不占治理语义）。

### 1.3 step 元数据（A1）

**不新增事件类型**（第 13 类仍为保留位）：`turn/end.payload` 补 `step_count` 与 `decision_count`；契约侧按**纯增量**补登（`session.contract.yaml` 注记，**不 bump 任何版本轴**）。

### 1.4 不变量固化（A4）

把 INV-1/2/3 写入设计文档并加断言：
- **INV-1** 一个 turn 恰好对应一次连续的同进程执行，**不跨进程**；
- **INV-2** 任意终局（含 suspended / aborted / failed）必须收口 turn（`reason = outcome.kind`）；
- **INV-3** provider 切换边界仍在 turn 边界；**审批往返不构成**切换窗口。

## 2. 硬约束

- ❌ 不新增事件类型（第 13 类保持保留位）；不新增退出码；不改会话协议数值；
- ❌ **不得放宽切片 0 的守卫**；`model_decision_forbidden` 不得降级为警告；
- ❌ 不做切片 2 的内容：context 消费（B1）、多工具展开（A3/B1）、错误回填（B2）——本切片 loop 的驱动源**仍是脚本化来源**；
- ❌ 不得改 `src/workspace/`（晋升闸 A 语义）与 `src/session/` 既有语义；
- ✅ 预算与判据必须是**确定性**的（同输入同结果），且判据来源不依赖内核内存态（遵守 durability 公理：状态只落本侧事件流）。

## 3. VERIFY

| # | 用例 | 通过标准 |
|---|---|---|
| 1 | 四重判据各自收敛 | `final_answer` → completed(0)；`no_more_tools` → completed(0)；`error` → failed(1)；`aborted` → aborted(79) |
| 2 | 预算耗尽 | 超 `max_steps_per_turn` → `failed` ＋ `budget_exhausted`（可区分）＋ exit **1**（不新增码）；超 `max_turns` 同理 |
| 3 | 预算不可见 | 断言预算常量不出现在注入上下文 / 工具参数 / 决策对象中（模型面无法感知） |
| 4 | step 元数据 | 正常收尾的 `turn/end.payload` 含 `step_count` / `decision_count` 且与事件流实际计数一致 |
| 5 | "以可执行内容为准" | 构造"完全身工具请求 + 截断" → 仍执行；构造"声称完成但无 final_answer 且无待处理动作" → 判未收束 |
| 6 | 不变量 | INV-1/2/3 各有断言（终局收口 turn / 切换边界仍为 turn 边界 / 审批往返不构成切换窗口） |
| 7 | 零回归 | 真对端轨 **≥215 passed / 1 skipped**；mock 轨 **≥210 passed / 9 skipped**；`smoke:s5` / `p2s2` / `p2s3` / `r2` 全过 |
| 8 | 契约 | `session.contract.yaml` 只做纯增量注记；`bridge.contract.yaml` **零改动**；任一版本轴不 bump |

**附加**：开工前提交**条款级完成清单**；交付附「改动 → 设计条款（讨论稿 §4 A1/A2/A4/A5、本任务书）」映射表。

## 4. 交付物与流程

1. 代码 ＋ 测试（§3 八项）；
2. 《切片 1 执行报告》：判据与预算实现说明 / 不可见性证明 / 元数据对账 / 不变量断言 / 零回归两轨＋四冒烟数字 / 条款映射 / 提交清单；
3. 设计文档更新：把 INV-1/2/3 与终止判据表落入 `docs/`（既有讨论稿已升格，可增补为实施章节）；
4. 分支 `work/20260914-slice1-loop-skeleton` ＋ worktree；合回 main 后删除；
5. **本地提交，不 push**（推送待 owner 授权）。

## 5. 纪律

1. 本切片**只做骨架**：判据、预算、元数据、不变量；越界项一律留给切片 2。
2. 预算默认值（32 / 8）如需调整，**提请 owner**，不得自行放宽。
3. 会话边界与脱敏红线延续；内核仓只读；`dependencies` 恒空。
