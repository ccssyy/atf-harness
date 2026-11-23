# AGENTS.md — ATF-Harness 项目须知（面向 zcode / 任何开发 agent）

> 本文件是本仓所有 agent 会话的第一阅读项，覆盖**项目全生命周期**。
> 本文件是常驻规范，**不维护阶段状态**——当前执行哪个 phase、推进到哪个 slice，一律以 `docs/` 下现行任务书与 owner 指示为准。本文件变更须 owner 批准。

## 1. 项目定位

本仓实现 **atf-harness**：把 ATF 训练内核变成一个可独立运行的训练 Agent（重装路线——vendor DSH 为宿主，ATF 只写训练域增量；**内核经 MCP（stdio JSON-RPC 2.0）对接**，G5 起 `src/bridge/` 与 stdio JSONL 分帧层已退役）。

- **本仓（atf-harness）**：L2–L4 层。TypeScript，trunk-based（main + 短命分支）。
- **内核仓（ATF）**：L1 层，位于 `<ATF_DSH_KERNEL_DIR>`（> `ATF_CLI_PATH` > `ATF_KERNEL_SOURCE` > 兄弟目录，见 `src/core/workspace/instancePin.ts`）。harness 经 **MCP server**（`python3 -m agentic_training_flow.mcp`）驱动它，**不做任何代码级依赖**（无 submodule、无 pip/npm 依赖、不 import）。
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
6. **低依赖＋锁版本＋审计（R2a，2026-09-23 修订态）**：`dependencies` 保持低依赖且一律锁版本（当前＝pi-ai 底座 `@earendil-works/pi-ai`／`@earendil-works/pi-agent-core` 双包锁 0.87.1）；devDependencies 仅允许构建测试工具（typescript / vitest 类）。借鉴 Pi 的设计（分层纪律、Result 类型、双上下文管道）。
7. **脱敏**：本仓任何文件不得出现 A800 地址端口、业务单据内容、内部同事信息；ATF 路径一律经环境变量（`ATF_CLI_PATH`）注入。
8. **语义理解归 agent，工具不代猜（B3c，2026-11-21 owner 裁定）**：工具只做两类事——确定性动作（落账/调内核/协议转换）与精确映射（本卡下发数据的等值查找）。**凡是需要「理解用户意思」的，一律原样回传 agent，由它理解后带结构化参数重调。**
   - vendor 原生模型即此形态：`AskUserQuestionAnswerItem` 只给 `selected: string[]`（label 原文）与 `custom?: string`（手打原文），官方 `tool-ask-user` 明写「feeds that answer back into the agent loop as an ordinary tool result」。
   - **禁止**形态：用正则从 `custom` 抽数字/组数、把 `label` 经拼写表（`"3"`/`"3倍"`/`"每图 3 条"` 混一表）翻回 `value`、任何 `spellingIndexOf` / `*TEXT_INDEX` / `*FromText` 式猜测。
   - **正确形态**：答案原样进 `card_answers` 返回 + 落账留痕；需要结构化值时由 agent 显式传参（如 `requested_group_count`）。
   - **机检**：`tests/dshTools/freeTextNoRegex.test.ts` 的 B3c 事故锚（查表全族不得存在、必有 `card_answers` 字段）。
   - **历史事故**：复验#24（「除 X 外的 N 个都要」被正则静默吞、卡消失凭据不落）+ N5（`"2 倍"` 被吞成「不增强」）+ ci-bl-1103（无视用户组数导致循环确认）。

### 3.8 产品验证纪律（浏览器实操）

- 产品使用测试一律用 Playwright MCP 驱动真实浏览器：UI/交互/验收不得脚本直调内部 API、不得注入桩、不得读内部状态代替页面观察；MCP 会话需跨步骤保持。
- 视口不小于 1920×1080；小于该尺寸的截图不作验收依据，证据需注明视口。
- 关键结论必须有页面级证据：网络 POST 计数、DOM 节点断言（data-*）、渲染区域截图；仅组件测试通过不算产品通过。
- 「组件绿、页面不可见」一律判 FAIL（不是 PARTIAL），登记并给页面级复现。

### 3.9 测试分层（硬规则）

- 本仓细则：`docs/测试分层与验收判据面.md`（判据面白名单、出件前三问、证据两栏、缺陷分流、本仓落地锚）。
- 硬规则同源：`~/.zcode/AGENTS.md`「测试分层（硬规则）」；操作清单：`~/.zcode/sop/test-acceptance.md`。

## 4. 契约与 pin 管理（G7／D9 后：pin 树已退役）

- **协议单源＝内核**：MCP `tools/list` 是 harness 对内核能力的唯一真相源（15 个方法，`outputSchema` 由内核对侧声明）。harness **不复制** schema——守卫 `tests/guards/schemaZeroCopy.test.ts` 钉死。
- **pin 树已退役（2026-11-22 D9）**：`ATF_INSTANCE_PIN_ROOT` 从实例 env 移除；`resolveKernelDir` 取代 `resolveInstancePinDir`——内核目录单一来源，**不再有 pin 副本**。历史 pin `v0.7.8b0` 与 `.atf-pinned/` 用法一并废止。
- **内核目录解析**（`src/core/workspace/instancePin.ts`）：
  `ATF_DSH_KERNEL_DIR` > `ATF_CLI_PATH` > `ATF_KERNEL_SOURCE` > 兄弟目录 `../AgenticTrainingFlow` > 空串。
  两条取舍：缺省兄弟目录须**实存**（`existsSync` 才返回）；都不可得返回**空串而非猜路径**（空串被 boot preflight 判假 → L2 fail-fast 指名缺哪个 env）。
- **接口变更纪律**：内核侧改 MCP 方法签名/输出 → harness 的契约测试红，影响面即契约面，运行时永不静默炸。harness 侧不向上游提 PR（owner 裁定：独立产品，升级时拉取同步）。

## 5. 工程约定

- TypeScript strict，Node ≥ 22，测试框架 vitest；Result 类型贯穿一切可能失败的操作，禁止裸 throw 穿过桥接边界。
- 测试运行分层（测试提速 T2，指令 `edaebcb148f7` §三）：开发批＝触达面子集——按目录 `npx vitest run tests/<dir>`、按改动文件反向定位 `npx vitest related <files>`；全量与 Playwright 产品面验收只在收口批（合并后 main＋统一重启窗口）。smoke 脚本（`npm run smoke:*` 与 `tests/dshUi/smoke_*`）只在对应层验收时跑，不在开发批循环跑（每个全量 build 属预期）。transform 持久缓存已开（vitest `fsModuleCache`，缓存落 `node_modules/.vitest-cache`）。
- 目录（重装路线，2026-11-23 实测）：`packages/extensions/`（**产品本体**：`atf-core` 领域资产 38 文件、`atf-tools` 工具面、`atf-ui` 界面、`atf-subagent` 已退役）、`src/mcp/`（MCP 连接器：`connection`/`atfCommand`/`bridgeCommand`）、`src/core/`（`workspace` 4 文件 + `tools` 工具定义与执行管线）、`src/webui/`（纯函数：run 只读面/配置卡/设置）、`src/agent/`（仅 `toolActionLabels` 18 行）。**已删除**：`src/bridge/`、`src/llm/`、`src/core/session/`、自研 loop 全族。依赖方向：`packages/extensions/*` → `@atf/dsh-atf-core` → vendor；`src/` 侧只剩被 packages 引用的领域件。
- 入口与命令（构建产物 `dist/`）：`node dist/ui/tui.js`（TUI 主入口；多轮续跑）、`node dist/cli/resume.js --list|--answer`（挂起应答通道）、`node dist/acp/main.js`（ACP agent；acpx@0.15.1 对端验收，开发期工具不入库）、`node dist/mcp/main.js`（MCP server，7 细粒度工具）。冒烟八条：`npm run smoke:p2s1|p2s2|p2s3|r2|l1a|l1ui|l1acp|l1mcp`；真端点试用 `trial:l1a-real`。
- MCP 写类工具预授权（L1b-D1=A）：白名单配置缺省 `~/.atf-harness/mcp-preauth.json`（0600；`ATF_MCP_PREAUTH` 或 `--preauth` 指路径），白名单外写动作默认拒绝；文件缺失/解析失败/权限过宽一律视同空白名单（fail-closed）；`host_id`＝客户端自报身份（非强身份鉴别）。
- 会话事件 schema（12 事件类型全启用、`domain_refs` 三元组 `{journal_type, fact_id, sha256_digest}`、compaction 白名单、`projection` 预留位）是全仓最重要的 schema，一次定死，细节以对应任务书与 ADR-06 为准。
- **内核来源现状**：pin 树已退役（§4）——内核目录经 `resolveKernelDir` 单源解析，dev 实际跑 `<ATF_KERNEL_SOURCE>` 主检出。CI 里由 `ATF_HARNESS_SOURCE`／`ATF_KERNEL_SOURCE` 注入路径，无需 worktree 副本。
- 提交信息：`feat/fix/test/docs/chore(scope): 中文描述`；trunk-based，slice/PR 粒度合入 main；milestone tag 仅在 phase 验收全过后打（首个 = `v0.1.0`）；commit/merge/push/re-pin 等 repo 写操作执行主体＝zcode（协议 §3.5 铁律五）。

## 6. 沟通纪律

- 每份 slice / 每项任务的产出报告须含：改动文件清单、验收结果、偏离规范之处（如有）、下一步建议。
- 本仓工作与 ATF 主线开发使用不同会话窗口，不混上下文。
- 对规范本身（本文件、ADR、任务书）的修改建议走书面提议，经 owner 批准后由 owner 或指定会话执行。
