# Owner 启动指令：Phase 1 / S2（会话 log + 双层事实）

> 日期：2026-09-09 ｜ 签发：owner ｜ 执行方：zcode
> 依据：《ATF独立Harness_Phase1任务书_20260908.md》§2（S2 设计要求与验收标准）+ AGENTS.md 常驻硬约束 + S1 已闭合（origin/main tip e8327b4，测试 26 passed / 2 skipped）。
> 结论先行：**S2 现在启动。只做 S2，完成即停，S3 未获指令不得启动。**

---

## 1. 范围

- 实现 `src/session/`：append-only 会话事件流 + `domain_refs` digest 校验 + 双管道占位 + projection 字段位（任务书 §2 设计要求 1–4，全部落在本 slice）。
- S1 桥接层（`src/bridge/`）零改动；如发现必须改桥接层才能完成 S2，停下来提请 owner，不得先改。

## 2. owner 预先拍板的口径（实现时直接采用，无需再问）

| # | 事项 | 口径 |
|---|---|---|
| 1 | digest 校验对端 | 任务书 S2-2 所述"引用前向 ATF 查询该 fact 的当前 digest"，本阶段由**注入式接口承载**：定义 `DigestResolver` 接口，S2 提供契约 mock 实现（可配置返回指定 digest / 缺失）。真实对端待内核能力落地 re-pin 后接入——与 S1 会话协议同口径，不阻塞、不插队 |
| 2 | `ref_invalid` 后的行为 | fail-closed：标记事件 + 触发 block（block 语义本阶段为返回结构化 block 结果即可，审批 UI 属后续 slice） |
| 3 | 事件 schema 版本 | schema v0 起步，事件类型枚举严格白名单（任务书列出的 7 类），未知 type 拒绝写入 |
| 4 | 会话落盘形态 | append-only JSONL（与会话事件流同构），文件位置/命名由你按工程惯例定，写入 `bridge.contract.yaml` 或新建 `session.contract.yaml` 登记并说明 |

## 3. 执行序列

1. 阅读任务书 §2 + 本指令；如与本指令冲突，以本指令为准并报告差异；
2. BUILD：`src/session/` 实现 + 测试；
3. VERIFY：任务书 §2 三条验收用例（重建 replay 逐条一致 / digest 篡改 → `ref_invalid` → block / UI-only 字段在 `convertToLlm` 输出中不出现）+ 全量测试（含 `ATF_CLI_PATH` 指向 pin 副本，S1 既有 26 passed / 2 skipped 不得回归）；
4. 产出《Phase1_S2执行报告_20260909.md》（执行记录 / 验收对照 / 偏离与决策点 / 提交清单）；
5. **提交本地保存，不 push**——push 与否待 owner review 后决议（沿用 S1 纪律）。

## 4. 纪律不变条款

内核仓只读；无 GPU、无真实 LLM Provider、无网络模型调用；零 npm 运行时依赖；pin 不自动升级（v0.2.0b7 / a628f8b）；未获 S3 启动指令不得进入 S3。
