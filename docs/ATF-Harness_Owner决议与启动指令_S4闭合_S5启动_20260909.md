# Owner 决议与启动指令：S4 闭合（push 授权）+ Phase 1 / S5 启动（收官切片）

> 日期：2026-09-09 ｜ 签发：owner ｜ 执行方：zcode
> 依据：《ATF独立Harness_Phase1_S4执行报告_20260909.md》+ owner review（独立核验通过：95 passed / 2 skipped 复跑一致、六路径零改动确认、pin a628f8b 干净、smoke:s4 exit 0、t0Guard.ts / promote.ts 抽审达标）。
> 结论先行：**S4 审查通过。决议：报告 §5 决策点 ①–⑦ 全部同意为正式口径；批准 push；S5 现在启动——Phase 1 最终切片。S5 完成即 Phase 1 闭合，停在 Phase 2 议题前。**

---

## 1. S4 闭合决议

报告 §5 七项自主决策全部批准为正式口径（tmp/runs 宿主 / workspace.contract.yaml 分文件 / 复现语义具体化 / GuardedSessionLog 包装且规则覆盖全部携带 domain_refs 的事件类型 / 写入顺序与回滚 / provenance 重开语义与 T0 覆盖 / catalog 失配 fail-closed）。

批准 push：`4f0f643`（feat workspace）+ `89510d1`（S4 执行报告）推送到 `origin/main`。

## 2. 执行序列

1. **执行 1（S4 闭合 push）**：push 前重跑全量测试（含 `ATF_CLI_PATH`），确认 95 passed / 2 skipped 方可推送；记录 push 后 tip hash；
2. **执行 2（S5 BUILD）**：按任务书 §5 实现 `src/llm/`（FauxProvider）+ `src/run/`（冒烟 runner）+ 场景脚本校准定稿，并按第 3 节口径执行；
3. **执行 3（S5 VERIFY）**：任务书 §5 七项总验收逐项打勾 + 全量测试（S1 26+2、S2 30、S3 20、S4 19 不得回归）+ typecheck + 五条冒烟全过；
4. **执行 4（Phase 1 闭合报告）**：产出《Phase1_S5执行报告暨Phase1闭合报告_20260909.md》——S5 验收对照 + 七项总验收打勾表 + Phase 1 五切片回顾（各切片 commit / 测试数 / 决议登记）+ Phase 2 待决事项清单；**提交本地保存，不 push**，等 owner review 后决议。

## 3. S5 owner 预先拍板的口径（实现时直接采用，无需再问）

| # | 事项 | 口径 |
|---|---|---|
| 1 | **`atf_promote_scratch` 步骤的落点（场景脚本 B1 校准点）** | 晋升是 harness 本地动作（T0→T1，走 `RunWorkspace.promoteArtifact`），**不是内核桥接调用**。场景脚本该步骤实现为 runner 内置步骤类型 `promote`（映射到晋升闸 A），**不进工具注册表**——严格 4 工具与内核方法面不变；场景脚本校准时同步改名（如 step type: "promote"）并消除歧义 |
| 2 | 场景脚本定稿 | `admission-to-g2.json` draft-v0 → 校准为 **v1 入库 `scenarios/`**（占位符替换为真实 fixture 引用、字段名对齐实现）；校准对照表（draft 字段 → v1 字段）写入执行报告；"语义不变"纪律不变 |
| 3 | "ATF 侧 run journal 有对应事实"（任务书 §5.3） | 本阶段由 **mock 对端进程内状态承载**（MockLedger / mock 工具响应可断言），真实对端待内核能力落地 re-pin 后接入——与 S1/S2/S3 同口径 |
| 4 | **B4 退出码语义** | `t0_ref_forbidden` 是会话层拒绝（非工具审批 block），**不走 78**——78 专属 `approval_missing` 语义，不扩用。B4 退出码 = **1**（经 runner 统一出口决出，断言按任务书"非 0 且 block 原因 = t0_ref_forbidden"执行）；`resolveHeadlessExitCode` 单一出口纪律不变，runner 对会话层拒绝的映射在同一文件内登记 |
| 5 | B2 自纠语义 | Faux 无智能理解：自纠由脚本顺序表达（gate 先行 → 收结构化 block 回填会话 → surface_scan → 重提）——验证点是 **block 回填会话且可重放**，非模型行为 |
| 6 | 会话层接线 | runner 使用 `GuardedSessionLog`（S4 产物）承载会话 log——B4 分支由此天然获得拒绝能力；provenance 的 `run_id` / `trigger_instruction` 切换为场景脚本注入（S4 口径 #2 的兑现） |

## 4. 任务书 §5 七项总验收（S5 报告逐项打勾，原样转抄）

- ⬜ B1 exit 0，G2 GateResult = PASS，证据链闭合
- ⬜ B2 block → 自纠 → PASS
- ⬜ B3 exit 78
- ⬜ B4 引用被拒（铁律一）
- ⬜ 四分支会话 log 全部可重建；digest 校验全部通过
- ⬜ T0→T1 晋升演示路径在 B1 中执行一次并登记 sha
- ⬜ 全程零 GPU、零真实 Provider、零内核仓改动（git diff 为空）

## 5. 纪律不变条款

内核仓只读；无 GPU、无真实 LLM Provider、无网络模型调用；零 npm 运行时依赖；pin 不自动升级（v0.2.0b7 / a628f8b）；S1–S4 代码与既有契约语义零改动（场景脚本校准与 runner 新增除外）；Phase 1 闭合后停在 Phase 2 议题前，未获 owner 指令不得启动任何新 slice。
