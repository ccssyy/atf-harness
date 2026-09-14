# ATF 独立 Harness——切片 0 执行报告：决策类型拆分与运行时守卫

**签发**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**日期**：2026-09-14
**依据**：《ATF独立Harness_切片0任务书_决策类型拆分与守卫_20260914.md》（§2 四步 / §3 硬约束 / §4 VERIFY 六项 / 附加要求：条款级完成清单 + 条款映射）
**性质**：治理前置工作包——**本地提交未推送，推送待 owner 另行授权**；内核仓零改动；契约零改动（帧/握手/方法面/字段全不动）

---

## 1. 缺口与修法

**缺口（任务书 §0）**：`LlmDecision = ScenarioStep` 类型别名使模型决策面与测试基建面同型——`promote`（晋升闸 A）等四类脚本专用指令（scratch_write / promote / cite_t0 / provider_switch）处于"模型可以返回的东西"里；切片 3 一接真实 provider，模型即成为决策产出方。

**修法（§2 四步）**：
1. `LlmDecision` 独立定义为模型面契约（恰好三类），`ScenarioStep` 改为其组合并集（＋四类脚本指令）——模型面**类型不可表达**脚本指令；
2. `assertModelDecision` 运行时守卫接入 provider 返回值入口——**运行时拒绝**兜底（类型在运行时无约束力）。

**命名口径说明**：任务书 §2.1 的 `{type:"message"}` 对应既有会话词汇 **`assistant_message`**（模型输出消息步）——`assistant_message` 不在脚本专用清单（任务书 §0 点名的脚本成员为 scratch_write / promote / cite_t0 / provider_switch 四类），故模型面收 `assistant_message`。此为对任务书表格的字面落法，如 owner 认为须改名 `message` 属破坏性变更（场景 schema 词汇变更），另行走契约/任务书流程。

## 2. 保全路径选择：**(b) Faux 角色调整**（任务书 §2.3 择一）

**选择**：Faux 保留"脚本执行器"角色，但**不再实现 `LlmProvider`**（模型面契约）——改实现独立测试供应商接口 **`ScriptedStepSource`**（`decisionFace: "script"` 显式标注非模型面）；`ProviderRegistry` 工厂类型同步收窄为产出 `ScriptedStepSource`。

**理由与影响面**：
- 路径 (a)（测试路径直连 branch.steps）需绕开 provider 抽象点重接 P2-S3 切换协议（段耗尽 → performSwitch）与 turn 归属（providerId 进事件/报告）——diff 更大且侵入切换机制，违背"不得顺手重构扩范围"；
- 路径 (b) 是纯类型面手术：runner 决策面改双轨（`LlmProvider | ScriptedStepSource`），守卫按 `decisionFace` **类型级分流**——脚本路径豁免守卫（守卫作用域 = provider 接口返回值，逐字满足任务书），模型面必经守卫；
- 影响面：`src/llm/` 五文件类型改写 ＋ `runner.ts` 分派区（守卫接入/类型放宽/注入 seam），既有场景、冒烟、R2 交付物零行为变更（零回归数字见 §5）；
- **守卫可测性 seam**：`RunBranchOptions.modelProvider?: LlmProvider`——注入模型面 provider 使守卫正反例可测；缺省不注入，既有路径逐位不变。

## 3. 条款级完成清单（开工前提交，逐条对照）

| # | 条款 | 来源 | 完成情况 |
|---|---|---|---|
| 1 | `LlmDecision` 独立定义（恰三类） | §2.1 | ✅ `provider.ts`（tool_call 仅 type/tool/params；assistant_message/final_answer） |
| 2 | `ScenarioStep = LlmDecision ∪ 四类脚本指令` | §2.1 | ✅ `scenario.ts` 组合并集，结构逐位不变 |
| 3 | `decide()` 签名返回 `LlmDecision \| null` | §2.1 | ✅ `LlmProvider.decide`；模型面不再可表达脚本指令（编译期证明见 §4） |
| 4 | 守卫位于 provider 返回值入口（分派之前） | §2.2 | ✅ runner 决策循环 null 检查后、分派前 |
| 5 | 非模型面 → fail-closed ＋ `model_decision_forbidden` ＋ 落事件留痕（含被拒 type） | §2.2 | ✅ `assistant/attempt`（既有事件类型零新增）＋ failed 终局 |
| 6 | 不吞错、不降级忽略 | §2.2 | ✅ 终局 break，留痕写入失败亦 fail-closed（session_failure） |
| 7 | 守卫作用域 = provider 接口返回值（非全局禁止） | §2.3 | ✅ 按 `decisionFace` 分流；脚本路径豁免 |
| 8 | 既有场景与三冒烟零回归 | §2.3 | ✅ §5 数字；四冒烟全过 |
| 9 | 择一保全路径并在报告说明 | §2.3 | ✅ 本报告 §2 |
| 10 | 不放宽守卫换零回归 | §2.3/§7.1 | ✅ 未放宽（守卫对模型面全覆盖，字段闭集白名单） |
| 11 | 不删 `promote` 能力（`scratch_write → promote → cite_t0` 可用） | §3 | ✅ VERIFY 4 用例＋既有 B1/B4 用例全绿 |
| 12 | 晋升闸 A 三闸语义零改动 | §3 | ✅ `src/workspace/` 零改动 |
| 13 | 不新增事件类型/退出码；不改会话协议；零依赖 | §3 | ✅ 留痕用既有 `assistant/attempt`；failed 复用 exit 1；dependencies 恒空 |
| 14 | 范围收敛（`src/llm/` ＋ runner 分派区以外不动） | §3 | ✅ 改动 8 文件（§6 清单），`src/session/`/`src/workspace/` 零改动 |
| 15 | 守卫 fail-closed 且可审计 | §3 | ✅ 拒绝原因进事件流（VERIFY 6） |
| 16 | VERIFY 1–6 六项 | §4 | ✅ §4/§5 |
| 17 | 条款映射表 | 附加要求 | ✅ §6 |
| 18 | 分支 `work/20260914-slice0-decision-types` 合回后删除 | §5.4 | ✅（`67d0b4b` → merge `662e8d8`，已删） |
| 19 | 本地提交不 push | §5.4 | ✅ 推送待 owner 授权 |

## 4. 守卫正反例原始输出（VERIFY 1/2/3/6 实跑）

```
✓ VERIFY 1 编译期证明：@ts-expect-error 断言 promote/scratch_write/cite_t0/provider_switch
  赋值 LlmDecision 均为类型错误（tsc 门下"意外可编译"会反向报错）——运行时白名单同组断言
  三类合法决策原样通过、四类脚本指令与面外字段（tool_call 带 cite_admitted_fact）全部拒绝
✓ VERIFY 2 守卫正例：assistant_message → assistant/message 事件；final_answer → completed（exit 0）
✓ VERIFY 3（核心）×4：provider 返回 promote / scratch_write / cite_t0 / provider_switch
    → outcome.kind = failed
    → error.code  = model_decision_forbidden
    → exit_code   = 1（不新增退出码）
    → events 含 assistant/attempt{rejected_type: "<被拒type>", reason: "model_decision_forbidden"}
    → turn/end{reason: "failed"} 收口；replay 可重建且含留痕事件（跨进程可审计）
✓ VERIFY 4 能力保全：默认脚本路径 scratch_write("note.md") → promote(node -e 重产同字节)
    → completed + promoted: true + catalog 恰 1 条登记（晋升闸 A 三闸零改动）
  （复现闸语义实录：命令须独立重产同字节 stdout——首版测试用 `cat` 被闸门正确拒绝，
    改用 B1 同款 node -e 形态后通过——闸门行为与既有语义一致的旁证）
```

## 5. 零回归数字（VERIFY 5，两轨＋四冒烟）

| 轨道 | 切片 0 前 | 切片 0 后 | 判定 |
|---|---|---|---|
| 真对端轨（设 `ATF_CLI_PATH`） | 207 passed / 1 skipped（30 文件） | **215 passed / 1 skipped（31 文件）** | ✅ 基线全保留＋8 守卫用例 |
| mock 轨（不设） | 202 passed / 9 skipped | **210 passed / 9 skipped（31 文件）** | ✅ 基线全保留 |
| `smoke:s5` / `smoke:p2s2` / `smoke:p2s3` | 全过 | 全过（零改动） | ✅ |
| `smoke:r2`（真对端） | 全过 | 全过（R2 交付物零改动） | ✅ |
| `typecheck` | 通过 | 通过（含 @ts-expect-error 编译期证明） | ✅ |

## 6. 条款映射表（改动 → 设计条款）

| 改动（文件） | 对应条款 |
|---|---|
| `src/llm/provider.ts`：LlmDecision 独立三类 ＋ LLM_DECISION_TYPES ＋ assertModelDecision ＋ decide 签名收窄；不再 import scenario.ts（依赖方向反转：scenario → provider） | 任务书 §2.1、§2.2；讨论稿 §6 D6；AGENTS §3.1 TCB 铁律（模型面与晋升闸隔离） |
| `src/llm/scenario.ts`：ScenarioStep = 组合并集（结构逐位不变） | 任务书 §2.1（ScenarioStep = LlmDecision ∪ 四类脚本指令） |
| `src/llm/fauxProvider.ts`：ScriptedStepSource 接口（decisionFace="script"）＋ FauxProvider 改实现 | 任务书 §2.3 路径 (b) |
| `src/llm/fauxVariantProvider.ts`：同上 | 任务书 §2.3 路径 (b) |
| `src/llm/providerRegistry.ts`：ProviderFactory/create 收窄为 ScriptedStepSource | 任务书 §2.3 路径 (b)（注册面 = 测试面） |
| `src/llm/index.ts`：出口补 assertModelDecision / ScriptedStepSource / 常量 | 任务书 §2.2（runner 消费） |
| `src/run/runner.ts`：RunErrorCode 增 `model_decision_forbidden`；决策面双轨类型；守卫接入（assistant/attempt 留痕 ＋ failed 终局）；`options.modelProvider` seam；openTurnRecord/performSwitch 类型放宽 | 任务书 §2.2（守卫位置/行为/留痕）、§2.3（作用域分流）、§3（不新增事件类型/退出码）；讨论稿 D6 |
| `tests/run/decisionGuard.test.ts`（新增 8 用例） | 任务书 §4 VERIFY 1/2/3/4/6 |

**不动项核对**：`bridge.contract.yaml`、`src/session/`、`src/workspace/`、`tests/run/realPeer/`、`src/run/smokeR2.ts`、内核仓、`dependencies`——全部零改动。

## 7. 提交清单（本地提交，**未推送**）

1. `67d0b4b` `feat(slice0)`：切片 0 工作笔（8 文件，+370/−40，分支合入）；
2. `662e8d8` `merge`：`work/20260914-slice0-decision-types` → main（分支与 worktree 已删）；
3. 本报告入库提交（`docs(slice0)`）。

**完成即停**：切片 0 闭合后切片 1（loop 骨架）方可启动（同文件区域串行纪律）；推送待 owner 另行授权。
