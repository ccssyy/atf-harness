# AGENTS.md — ATF-Harness 项目须知（面向 zcode / 任何开发 agent）

> 本文件是本仓所有 agent 会话的第一阅读项，覆盖**项目全生命周期**。
> 本文件是常驻规范，**不维护阶段状态**——当前执行哪个 phase、推进到哪个 slice，一律以 `docs/` 下现行任务书与 owner 指示为准。本文件变更须 owner 批准。

## 1. 项目定位

本仓实现 **atf-harness**：把 ATF 训练内核变成一个可独立运行的训练 Agent（R2a 路线——TS harness 借鉴 Pi 设计 + Python 内核经 stdio JSONL 桥接）。

- **本仓（atf-harness）**：L2–L4 层。TypeScript，trunk-based（main + 短命分支）。
- **内核仓（ATF）**：L1 层，位于 `/data/sam/AgenticTrainingFlow`。harness 通过 spawn 其 `atf` CLI 子进程驱动它，**不做任何代码级依赖**（无 submodule、无 pip/npm 依赖、不 import）。
- **长期路线**（Phase 0–4，详见决策文档 §路线图）：0 决策 ✅ → 1 headless 冒烟 → 2 深水区 → 3 宿主嵌入（ACP server）→ 4 表面壳（条件阶段）。最终集成形态 = ACP / skills 双入口，**两仓永不合并**。

## 2. 权威文档体系（docs/）

| 文档 | 性质 | 有效期 |
|---|---|---|
| `ATF独立Harness_Phase0决策文档_20260907.md` | **ADR-05~08**：四项已拍板决策（R2a / 双层事实模型 A / 双轨审批 C / 三层工作区 A） | **永久有效**，一切实现以其为准，agent 无权重新讨论 |
| `ATF独立Harness_PhaseN任务书_*.md` | 当前 phase 的 slice 拆解与验收标准 | 仅本 phase 有效；phase 结束归档，新 phase 出新任务书 |
| `admission-to-g2.json` 等场景脚本 | Faux 冒烟输入 | 随所属 phase |

规则：**遇到任务书未覆盖的 schema / 接口级问题 → 停下询问 owner**，不得自行拍板；对 ADR 的任何修订请求以书面提出，由 owner 决策。每个 phase 的执行依据 = 该 phase 的任务书（含专属约束、slice 顺序与验收标准），任务书之间互不继承。

## 3. 长期硬约束（整个项目生命周期有效，违反 = 立即停下报告 owner）

1. **TCB 铁律**：agent / harness 生成的代码永远在可信计算基之外——沙箱执行、run 数据只读、无权调用闸门签署与审批工具。
2. **审批 fails-closed（ADR-07）**：任何无有效授权的高危动作一律拒绝；headless 下 exit 专用码（78）；交互问答只是账本录入前端，ApprovalRecord 是唯一真相源。宿主/外部的"自动应答"配置对闸门永远无效。
3. **T0 不可引用为证据（ADR-08）**：自由创作区产物可读，但事实链只指向晋升后的 T1+ Artifact。
4. **无 GPU、无真实 LLM Provider**：开发与测试全程走 Faux / 假实现；真实训练调用必须 owner 显式授权且独立审批。
5. **内核仓引用纪律**：对 ATF 主仓工作区只读；需要 pin 版本副本用 `git worktree add`（见 §4）；本仓产生的一切改动不回写内核仓。若确需内核新能力，登记待办交 owner 走 ATF 仓自己的流程排队，**本仓不阻塞等待、不插队**。
6. **零 npm 运行时依赖（R2a）**：`dependencies` 必须为空；devDependencies 仅允许构建测试工具（typescript / vitest 类）。借鉴 Pi 的设计（分层纪律、Result 类型、双上下文管道），不引入 pi-ai 代码。
7. **脱敏**：本仓任何文件不得出现 A800 地址端口、业务单据内容、内部同事信息；ATF 路径一律经环境变量（`ATF_CLI_PATH`）注入。

## 4. 契约与 pin 管理

- 仓内 `bridge.contract.yaml` 是 harness 对 ATF 认知的**唯一真相源**：JSONL 帧格式 + atf 子命令签名 + canonical output schema + `atf_upstream` pin（commit + contract_version）。
- **当前 pin：tag `v0.2.0b7`（commit `a628f8b`，2026-09-08；含 --run 自动发现修复与全量基线）**。pin 只落在 ATF 发版 tag 上，不追 main 中间态。
- contract tests 运行前提：`ATF_CLI_PATH` 指向一份 **checkout 在 pin 上的 ATF 只读副本**，测试先校验其 HEAD sha 与 pin 一致，不一致直接 fail：
  ```bash
  git -C /data/sam/AgenticTrainingFlow worktree add /data/sam/ATF-Harness/.atf-pinned v0.2.0b7
  export ATF_CLI_PATH=/data/sam/ATF-Harness/.atf-pinned
  ```
  （`.atf-pinned/` 加入 .gitignore，不进本仓。）
- **re-pin 三步**（唯一合法的升级路径，禁止自动追新）：
  ① 触发：ATF 侧 `contract-breaking` 标记，或 harness 需要内核新能力；
  ② 执行：worktree 切到目标 tag → 改 contract.yaml pin（contract_version 同步 bump）→ 跑 contract tests，红了修 harness 侧适配；
  ③ 收口：PR 改 pin → owner review → 合入。
- 契约变更双向纪律：本仓改契约 = 显式 PR + 双仓测试；ATF 侧改坏契约 = contract tests 红，影响面即契约面，运行时永不静默炸。

## 5. 工程约定

- TypeScript strict，Node ≥ 22，测试框架 vitest；Result 类型贯穿一切可能失败的操作，禁止裸 throw 穿过桥接边界。
- 目录：`src/bridge/`、`src/session/`、`src/tools/`、`src/workspace/`、`src/faux/`、`scenarios/`、`tests/`、`docs/`（按 phase 扩充，不提前建空壳）。
- 会话事件 schema（8 事件类型、`domain_refs` 三元组 `{journal_type, fact_id, sha256_digest}`、compaction 白名单、`projection` 预留位）是全仓最重要的 schema，一次定死，细节以对应任务书与 ADR-06 为准。
- 提交信息：`feat/fix/test/docs/chore(scope): 中文描述`；trunk-based，slice/PR 粒度合入 main；milestone tag 仅在 phase 验收全过后打（首个 = `v0.1.0`）。

## 6. 沟通纪律

- 每份 slice / 每项任务的产出报告须含：改动文件清单、验收结果、偏离规范之处（如有）、下一步建议。
- 本仓工作与 ATF 主线开发使用不同会话窗口，不混上下文。
- 对规范本身（本文件、ADR、任务书）的修改建议走书面提议，经 owner 批准后由 owner 或指定会话执行。
