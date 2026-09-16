# AGENTS.md — ATF-Harness 项目须知（面向 zcode / 任何开发 agent）

> 本文件是本仓所有 agent 会话的第一阅读项，覆盖**项目全生命周期**。
> 本文件是常驻规范，**不维护阶段状态**——当前执行哪个 phase、推进到哪个 slice，一律以 `docs/` 下现行任务书与 owner 指示为准。本文件变更须 owner 批准。

## 1. 项目定位

本仓实现 **atf-harness**：把 ATF 训练内核变成一个可独立运行的训练 Agent（R2a 路线——TS harness 借鉴 Pi 设计 + Python 内核经 stdio JSONL 桥接）。

- **本仓（atf-harness）**：L2–L4 层。TypeScript，trunk-based（main + 短命分支）。
- **内核仓（ATF）**：L1 层，位于 `<ATF_KERNEL_DIR>`。harness 通过 spawn 其 `atf` CLI 子进程驱动它，**不做任何代码级依赖**（无 submodule、无 pip/npm 依赖、不 import）。
- **长期路线**（**路线轴定义**，详见决策文档 §路线图）：0 决策 ✅ → 1 headless 冒烟 → 2 深水区 → **3+4 合并为 L1「产品本体落地」**。**本轴已按 2026-09-15 owner 裁定 D15-a 修订**：原 Phase 3（宿主嵌入 / ACP server）与原 Phase 4（表面壳，原定语"条件阶段 · 可砍"）自该裁定起**合并为一个阶段**——原因是自有 UI 已确立为**产品本体主入口**（前端一），不再是"若宿主嵌入体验够用则砍掉"的条件阶段；ACP / MCP 是两个集成面（配件）。合并后按批次推进：**L1**（`core/` 抽取 ＋ 自有 UI 最小前端 TUI ＋ ACP 外壳 ＋ MCP 外壳）→ **L1b** → **L1c**（Web UI）→ **L1d**（桌面 app）。最终集成形态 = ACP / skills 双入口，**两仓永不合并**。

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
- **当前 pin：tag `v0.6.0b0`（commit `b6db3496b34089147044be9c6b9a0a7ceb595e3a`，2026-09-14；会话方法面 7 方法（含 `atf.bind_run`），内核批次二发版）**。pin 只落在 ATF 发版 tag 上，不追 main 中间态。
- contract tests 运行前提：`ATF_CLI_PATH` 指向一份 **checkout 在 pin 上的 ATF 只读副本**，测试先校验其 HEAD sha 与 pin 一致，不一致直接 fail：
  ```bash
  git -C <ATF_KERNEL_DIR> worktree add <HARNESS_DIR>/.atf-pinned v0.6.0b0
  export ATF_CLI_PATH=<HARNESS_DIR>/.atf-pinned
  ```
  （`.atf-pinned/` 加入 .gitignore，不进本仓。）
- **re-pin 三步**（唯一合法的升级路径，禁止自动追新）：
  ① 触发：ATF 侧 `contract-breaking` 标记，或 harness 需要内核新能力；
  ② 执行：worktree 切到目标 tag → 改 contract.yaml pin（pin 的 contract_version 属会话协议版本轴，随内核 bump 同步——双轴口径见 bridge.contract.yaml「版本轴注记」2026-09-13；桥接契约版本轴不随 re-pin 变动）→ 跑 contract tests，红了修 harness 侧适配；
  ③ 收口：PR 改 pin → owner review → 合入。
- 契约变更双向纪律：本仓改契约 = 显式 PR + 双仓测试；ATF 侧改坏契约 = contract tests 红，影响面即契约面，运行时永不静默炸。

## 5. 工程约定

- TypeScript strict，Node ≥ 22，测试框架 vitest；Result 类型贯穿一切可能失败的操作，禁止裸 throw 穿过桥接边界。
- 目录（L1/L1b 落地后，2026-09-16）：`src/core/`（共享中间层：会话事件/审批闸/三层工作区/工具定义与 canonical/run 引擎/投影面）、`src/rpc/`（共享 JSON-RPC 2.0/stdio 传输层，ACP/MCP 共用）、`src/bridge/`（内核 stdio JSONL 桥接）、`src/llm/`（模型面 provider 与假端点）、`src/ui/`（前端一 TUI 主入口）、`src/acp/`（前端二 ACP agent 外壳）、`src/mcp/`（前端三 MCP server 外壳）、`src/cli/`（CLI 挂起应答通道）、`src/session|tools|workspace/`（各层冒烟入口留存位）、`scenarios/`、`tests/`、`docs/`。依赖方向：三外壳 → core → {bridge, llm}（`tests/core/boundary.test.ts` 静态守卫；`dependencies` 恒空）。
- 入口与命令（构建产物 `dist/`）：`node dist/ui/tui.js`（TUI 主入口；多轮续跑）、`node dist/cli/resume.js --list|--answer`（挂起应答通道）、`node dist/acp/main.js`（ACP agent；acpx@0.15.1 对端验收，开发期工具不入库）、`node dist/mcp/main.js`（MCP server，7 细粒度工具）。冒烟八条：`npm run smoke:p2s1|p2s2|p2s3|r2|l1a|l1ui|l1acp|l1mcp`；真端点试用 `trial:l1a-real`。
- MCP 写类工具预授权（L1b-D1=A）：白名单配置缺省 `~/.atf-harness/mcp-preauth.json`（0600；`ATF_MCP_PREAUTH` 或 `--preauth` 指路径），白名单外写动作默认拒绝；文件缺失/解析失败/权限过宽一律视同空白名单（fail-closed）；`host_id`＝客户端自报身份（非强身份鉴别）。
- 会话事件 schema（12 事件类型全启用、`domain_refs` 三元组 `{journal_type, fact_id, sha256_digest}`、compaction 白名单、`projection` 预留位）是全仓最重要的 schema，一次定死，细节以对应任务书与 ADR-06 为准。
- 内核 pin 现状 `v0.6.0b0`（归属与 re-pin 三步见 §4）；re-pin 至含 K4 的内核发版（`.atf-pinned` → `v0.7.0b0`）为登记待办，届时 mock 对端 `ledger_record` wire 形态同步切换（另走变更单）。
- 提交信息：`feat/fix/test/docs/chore(scope): 中文描述`；trunk-based，slice/PR 粒度合入 main；milestone tag 仅在 phase 验收全过后打（首个 = `v0.1.0`）；commit/merge/push/re-pin 等 repo 写操作执行主体＝zcode（协议 §3.5 铁律五）。

## 6. 沟通纪律

- 每份 slice / 每项任务的产出报告须含：改动文件清单、验收结果、偏离规范之处（如有）、下一步建议。
- 本仓工作与 ATF 主线开发使用不同会话窗口，不混上下文。
- 对规范本身（本文件、ADR、任务书）的修改建议走书面提议，经 owner 批准后由 owner 或指定会话执行。
