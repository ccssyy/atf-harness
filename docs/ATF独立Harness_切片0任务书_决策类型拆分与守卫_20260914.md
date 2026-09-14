# ATF 独立 Harness——切片 0 任务书：决策类型拆分与运行时守卫（治理前置）

**日期**：2026-09-14
**签发**：owner
**执行方**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**依据**：《ATF-Harness_agent-loop设计_门1讨论稿_20260914.md》§6 ＋《ATF-Harness_Owner分析与架构方案_项目态势与训练Agent_20260914.md》§3.2（D6）＋ `AGENTS.md` §3.1（TCB 铁律）
**性质**：**治理前置工作包**（不依赖 A 组任何设计结论；可独立验收）
**结论先行**：把**脚本专用指令从模型面契约中移出**（`LlmDecision` 独立为合法决策三成员），并在 provider 返回值入口加**运行时守卫**——使"模型触达晋升闸 A"由**约定**变为**类型不可表达 ＋ 运行时拒绝**。**不删除任何既有能力**；既有场景与三条冒烟必须零回归。

---

## 0. 前置与现状（owner 侧实测）

| 项 | 事实 |
|---|---|
| 缺口 | `src/llm/provider.ts:16`：`export type LlmDecision = ScenarioStep;` —— 模型决策面与测试基建面是**同一个类型** |
| 脚本专用成员 | `src/llm/scenario.ts`：`scratch_write`(47) / **`promote`(48)** / `cite_t0`(49) / `provider_switch`(52) |
| 危险路径 | `src/run/runner.ts:620–632`：收到 `promote` → 直调 `promoteArtifact`（`src/workspace/promote.ts:40`）＝ **晋升闸 A**，不经 4 工具面、不经审批检查点 |
| 为何今天无害 | 决策由测试脚本产出，无对手方 |
| 为何必须现在修 | 切片 3 一接真实 provider，**模型即成为决策产出方** → 幻觉/提示注入即可下发 `promote` |
| R2 门 2 状态 | 已交付并 owner 核验通过（真对端轨 `207 passed / 1 skipped`；mock 轨 `202 passed / 9 skipped`）；**R2 未改 `runner.ts`** → 与本切片不冲突 |

## 1. 目标（一句话）

**把 `promote`（及另三类脚本指令）从"模型可以返回的东西"里移出去，并让运行时守卫兜底。**

## 2. 范围（严格四步）

### 2.1 类型拆分（`src/llm/provider.ts` / `src/llm/scenario.ts`）

| 类型 | 成员 | 谁消费 |
|---|---|---|
| **`LlmDecision`**（模型面契约，独立定义） | `{type:"tool_call", tool, params}` ｜ `{type:"message", text}` ｜ `{type:"final_answer", text}` | `LlmProvider.decide()` 只返回它 |
| **`ScenarioStep`**（测试基建面） | `LlmDecision` ∪ `{ scratch_write, promote, cite_t0, provider_switch }` | runner 的**测试路径**、场景脚本解析 |

要求：`LlmProvider.decide()` 签名改为返回 `LlmDecision | null`；**模型面不再可表达任何脚本指令**。

### 2.2 运行时守卫（`assertModelDecision`）

- 位置：**provider 返回值入口**（决策进入分派之前）；
- 行为：返回值不属于 `LlmDecision` → **fail-closed**（`failed`）＋ 结构化错误码（建议 `model_decision_forbidden`）＋ 落事件留痕（含被拒的 `type`）；
- **不得**吞掉错误、不得降级为"忽略该步"。

### 2.3 既有能力保全（关键约束，**决定实现路径**）

现状：场景步骤**经 provider 接口**输出（`FauxProvider.fromBranch(branch)`），因此直接加守卫会让含 `promote` / `cite_t0` 的既有场景变红。**要求**：

1. **守卫的作用域 = provider 接口的返回值**（不是全局禁止脚本指令）；
2. 既有场景与三条冒烟（`smoke:s5` / `p2s2` / `p2s3`）**零回归**——为此允许的实现路径：
   - **(a) 测试路径直连**：runner 在测试模式（脚本驱动）下从 branch 直接取 `ScenarioStep` 执行，不经 provider 接口；
   - **(b) Faux 角色调整**：保留 Faux 作为"脚本执行器"但不再实现 `LlmProvider` 接口（或实现一个**独立的**测试供应商接口，明确标注非模型面）；
3. **择一并在报告中说明理由**与影响面；**禁止**用"放宽守卫"来换零回归。

### 2.4 变更面与不动项

- **改**：`src/llm/provider.ts`、`src/llm/scenario.ts`、`src/llm/fauxProvider.ts`（按 §2.3 所选路径）、`src/run/runner.ts`（守卫接入 + 分派区）、测试、`docs/`（说明与映射）。
- **不改**：`bridge.contract.yaml`（**本切片不涉契约**：帧/握手/方法面/字段全不动）；`src/session/`、`src/workspace/`（`promoteArtifact` 与晋升闸 A 语义**零改动**）；R2 交付物（`tests/run/realPeer/*`、`src/run/smokeR2.ts`）；内核仓；`dependencies`。

## 3. 硬约束

- ❌ **不得删除或削弱 `promote` 能力**（测试路径仍需用)：
  `scratch_write → promote → cite_t0` 这条构造工作区状态的用法必须继续可用；
- ❌ 不得改动晋升闸 A 的三闸语义（幂等 / 可复现 / sha 指纹）；
- ❌ 不得新增事件类型或退出码；不得改会话协议；不得引入依赖；
- ❌ 不得以"顺手重构"扩大范围（`src/llm/` 与 `runner.ts` 的决策分派区以外不动）；
- ✅ 守卫必须 fail-closed 且可审计（拒绝原因进事件流）。

## 4. VERIFY

| # | 用例 | 通过标准 |
|---|---|---|
| 1 | 类型边界 | `tsc` 通过；**编译期证明** `LlmProvider` 无法返回脚本指令（可用类型级断言测试） |
| 2 | 守卫正例 | 合法决策（`tool_call` / `message` / `final_answer`）正常通过并执行 |
| 3 | 守卫反例（**本切片核心**） | 四类脚本指令各一组：**`promote` 经 provider 返回 → `failed`（`model_decision_forbidden`）**；`scratch_write` / `cite_t0` / `provider_switch` 同理 |
| 4 | 能力保全 | `scratch_write → promote → cite_t0` 在**测试路径**下仍可执行；晋升闸 A 三闸行为不变（既有 workspace 用例全绿） |
| 5 | 零回归 | 全量测试两轨：真对端轨 `≥207 passed / 1 skipped`；mock 轨 `≥202 passed`（9 skip 保持）；`smoke:s5` / `p2s2` / `p2s3` / `r2` 全过 |
| 6 | 留痕 | 被拒的守卫事件可在会话日志中查到（`type` + 原因） |

**附加要求**：开工前先提**条款级完成清单**；交付附「改动 → 设计条款（讨论稿 §6 / AGENTS §3.1 / 本任务书）」映射表。

## 5. 交付物

1. 代码 + 测试（含 §4 六项）；
2. 《切片 0 执行报告》：缺口与修法 / 所选保全路径及理由 / 守卫正反例原始输出 / 零回归数字（两轨）/ 条款映射 / 提交清单；
3. `docs/` 内更新说明（若涉及既有文档表述，仅改必要处）；
4. **本地提交，不 push**（推送待 owner 授权）；分支 `work/20260914-slice0-decision-types` 短命分支 + worktree，合回 main 后删除。

## 6. 与其它工作的关系

| 对象 | 关系 |
|---|---|
| R2 门 2（本地 4 笔未推） | **不冲突**：R2 未改 `runner.ts`；本切片改 `runner.ts` 的守卫接入与分派区。若实际出现文件级冲突 → **停下报告**，不得强行合并 |
| 切片 1（loop 骨架） | 本切片是其前置（模型面澄清后才能定 loop 的决策面契约） |
| 内核仓 | 零改动 |
| 契约 | 不涉（无帧 / 握手 / 方法面变更） |

## 7. 纪律

1. 本切片是**治理前置**：不得因"想少改点"而放宽守卫，也不得因"想更严"而顺手加新机制（如全局禁脚本指令）。
2. 不删能力、不改闸语义、不扩范围；一切偏离须在报告中显式声明并等 owner 追认。
3. 会话边界：harness 侧只在本仓作业；内核仓只读。
4. 脱敏与通用性红线延续（实现/测试/文档不得出现真实业务内容与内部绝对路径）。
