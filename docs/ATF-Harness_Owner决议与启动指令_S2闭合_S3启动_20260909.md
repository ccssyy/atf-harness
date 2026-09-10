# Owner 决议与启动指令：S2 闭合（push 授权）+ Phase 1 / S3 启动

> 日期：2026-09-09 ｜ 签发：owner ｜ 执行方：zcode
> 依据：《ATF独立Harness_Phase1_S2执行报告_20260909.md》+ owner review（独立核验通过：56 passed / 2 skipped 复跑一致、`src/bridge` 与 `bridge.contract.yaml` 零 diff、pin a628f8b 干净、smoke:s2 exit 0）。
> 结论先行：**S2 审查通过。决议：报告 §5 决策点 ①–④ 全部同意；批准 push；S3 现在启动。S3 完成即停，S4 未获指令不得启动。**

---

## 1. S2 闭合决议

1. 报告 §5 四项自主决策全部批准为正式口径：
   - ① 新建 `session.contract.yaml` 分文件登记（与 `bridge.contract.yaml` 互不隶属）；
   - ② `convertToLlm` 采用白名单投影（强于任务书黑名单基线，验收键集恒定）；
   - ③ `ref_invalid` 事件照常落盘（事实留痕），拒写仅保留给 schema 违规与 resolver 故障；
   - ④ `DigestResolver` 为 `SessionLog.create` 必要参数。
2. 批准 push：`80386f6`（feat session）+ `b68539c`（S2 执行报告）推送到 `origin/main`。

## 2. 执行序列

1. **执行 1（S2 闭合 push）**：push 前重跑全量测试（含 `ATF_CLI_PATH` 指向 pin 副本），确认 56 passed / 2 skipped 方可推送；记录 push 后 tip hash；
2. **执行 2（S3 BUILD）**：按任务书 §3 实现 `src/tools/`（4 个 ToolDefinition + 账本审批 + canonical output 校验），并按第 3 节口径执行；
3. **执行 3（S3 VERIFY）**：任务书 §3 三条验收用例 + 全量测试（S1 26/2 + S2 30 不得回归）+ typecheck + 手工冒烟；
4. **执行 4（S3 报告）**：产出《Phase1_S3执行报告_20260909.md》（执行记录 / 验收对照 / 偏离与决策点 / 提交清单）；**提交本地保存，不 push**，等 owner review 后决议。

## 3. S3 owner 预先拍板的口径（实现时直接采用，无需再问）

| # | 事项 | 口径 |
|---|---|---|
| 1 | 工具方法与账本的对端 | 4 个工具方法 + approval ledger 查询/消费**均由契约 mock 对端承载**（与 S1 会话协议、S2 DigestResolver 同口径）：`MockLedger` 支持预录/查询/消费/一次性语义；真实对端待内核能力落地 re-pin 后接入，不阻塞、不插队 |
| 2 | `bridge.contract.yaml` 变更性质 | S3 在 `methods` 段登记 4 个工具方法 + ledger 查询/消费方法的**签名与 canonical output schema**（任务书 §8.2 计划内变更）。`contract_version` **维持 1 不 bump**——v1 的完整方法面 = 握手 + 4 工具 + ledger 方法，方法新增不属破坏性变更；仅帧格式/握手 schema/既有方法语义变更才 bump |
| 3 | exit 78 语义落点 | `approval_missing` block 发生时，由 **harness 主进程以 exit code 78 终止**（headless 冒烟断言锚点）；"exit 78 由 atf 侧返回"理解为内核侧真实实现时的语义约定，本阶段由 mock 承载并写入契约登记 |
| 4 | canonical output 校验失败 | 按 S1 纪律折算 `err(schema_violation)`，结构化回填 `ok: false`，不猜测成功 |
| 5 | 工具面收敛 | 严格 4 个工具，禁止注册任何额外工具；模型可见 schema 白名单，timeout 等内部字段一律不发 |

## 4. 纪律不变条款

内核仓只读；无 GPU、无真实 LLM Provider、无网络模型调用；零 npm 运行时依赖；pin 不自动升级（v0.2.0b7 / a628f8b）；S1/S2 代码与本轮决议登记的既有语义零改动（canonical output schema 登记除外）；S4 未获指令不得启动。
