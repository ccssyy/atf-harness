# ATF-Harness `atf.bind_run` 补登执行报告

**签发**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**日期**：2026-09-13
**依据**：《ATF-Harness_Owner指令_推送授权与bind_run补登_20260913.md》（§2 补登六项 + §3 执行序列）
**性质**：方法面补登执行报告——**contract_version 保持 2 不 bump**；本批两笔提交**本地提交未推送**，推送待 owner 另行授权
**前置**：第一批（推送授权）已完成——复跑基线达标后 `938fc66..f2ec34a` 共 2 笔已推至 `origin/main`（过程注记见 §5）。

---

## 1. 变更对照（指令 §2 六项逐项）

| # | 指令要求 | 实际落点 | 状态 |
|---|---|---|---|
| 1 | 新增会话方法 `atf.bind_run`：`params {run_id}` → `result {ok, run_id, scope_ref}`；归入会话方法区（与 `atf.version` 同族），不进 4 工具面 | `bridge.contract.yaml` methods 段新增 `atf.bind_run`（点号命名，紧随 `atf.version`）；mock `METHODS` 注册 `"atf.bind_run"`（引号键）；`TOOL_DEFINITIONS` 零改动（仍 4 工具） | ✅ |
| 2 | `atf_workspace_status` / `atf_fact_scan` 参数由 `{}` 改为可选 `run_id`（`required: []`）；注记显式优先于会话绑定 | 两方法 params 均改为 `{ type: object, required: [], properties: { run_id: { type: string, required: false } } }`，行尾注记「显式 run_id 优先于会话绑定」 | ✅ |
| 3 | 错误码登记 `no_run_bound`（fail-closed）、`unknown_run`；均 error response、连接保持 | `atf.bind_run` 登记 `unknown_run`；两只读方法各登记 `no_run_bound` + `unknown_run`（`errors:` 段，注记「error response，连接保持」）；mock 两侧实现并保持连接（bindRun.test.ts 断言错误后同连接继续可用） | ✅ |
| 4 | 绑定留痕：覆盖绑定须发 event（`name: "session/run-bound"`，payload 含 from/to run_id） | 契约 `atf.bind_run.note` 登记 B4；mock 覆盖绑定先经 `writeChain` 发 event 再回 response（次序有保证）；同 run 重复绑定不发 event | ✅ |
| 5 | 契约头部登记补登条目；`contract_version` 保持 2 不 bump | 头部新增「【方法面补登 2026-09-13】」登记块（B1–B4 + 不 bump 理由 + 编排层口径）；`contract_version: 2` 不动 | ✅ |
| 6 | mock 对端与测试同步：`atf.bind_run` 会话内绑定状态 + `no_run_bound` 语义；四组用例（绑定后无参 / 显式覆盖 / 未绑定报错 / `unknown_run`） | mock 新增会话绑定状态与 `resolveRun`（显式 → 绑定 → `no_run_bound`）；新增 `tests/bridge/bindRun.test.ts` 五用例（四组 + 覆盖留痕）；另补 resolver 显式传参断言；契约自检 `contract.file.test.ts` 扩展（运行时方法面 = 握手 + 会话上下文 + 4 工具 + 2 账本） | ✅ |

**指令「不做」项核对**：4 工具面（`TOOL_DEFINITIONS`）零改动；`src/session/`、`src/workspace/` 零改动；未接真实内核对端；未启 Phase 3；未 re-pin（`atf_upstream` pin 仍 `v0.2.0b7` / `a628f8b`，契约自检断言在位）。

## 2. mock 与编排口径

### 2.1 编排层口径（指令 §2「编排层口径」的落地声明）

**本仓编排在 run 开始时采用显式 `run_id`，方法无隐式依赖、无状态优先**：

- `FactScanResolver` 构造即携带 `runId`（`src/run/factScanResolver.ts`），`lookupDigest` 以显式 `params.run_id` 调用 `atf_fact_scan`（不再传 `{}`）；
- `runner.ts` 在 run 开始（工作区创建后）以 `branch.run_id` 构造 resolver——run 标识自 scenario 分支确定性派生，不经会话绑定；
- **`atf.bind_run` 编排不依赖**：主要服务宿主/长会话场景（Phase 3 dispatch 时使用）；
- 模型可见工具面参数保持无参（`NO_PARAMS`）：run 绑定为编排/宿主职责，不开放给模型——与「不改 4 工具面」一致。

该口径已写入契约头部登记（「编排层口径」段）并有测试锚定（factScanResolver.test.ts「编排层口径」用例：断言请求参数恰为 `{ method: "atf_fact_scan", params: { run_id: <构造值> } }`）。

### 2.2 mock 对端形态与差异面声明

mock 承载 B1–B4 全语义：`atf.bind_run`（绑定/覆盖/留痕 event）、run 解析顺序（显式 → 会话绑定 → `no_run_bound`）、`unknown_run`、错误后连接保持。**与真实内核（批次二实现）的两处差异面，已在 mock 头部注记显式声明**：

1. **默认绑定 `mock-run-1`**：批次一隐含「当前 run」口径的兼容承载，保既有用例零回归；`--no-auto-bind` 旗标下严格启动（无绑定），供 `no_run_bound` 反例与新口径用例。真实内核按契约语义启动即无绑定。
2. **run 存在性 = auto-registry**：除 `--unknown-run=ID` 注定的不可解析值外，显式 run_id 首个引用即登记为已知 run（mock 无内核 run 注册表，自动登记保住多场景 run_id 可解析）。真实内核以自身 run 注册表判定，不可解析即 `unknown_run`。

两处均为 harness 测试基建的兼容性设计，不构成契约语义变更；真实对端接入（re-pin 后）以内核批次二实现为准。

## 3. 验收对照（指令 §2 验收四项）

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 全量测试零回归（基线 193 passed / 2 skipped）；`typecheck` 通过 | ✅ **200 passed / 2 skipped（28 文件）**——基线 193 全保留，新增 7 用例（bindRun 五 + resolver 传参一 + 契约自检扩展一）；`npm run typecheck`（`tsc -p tsconfig.json`）零错误 |
| 2 | 契约自检扩展后通过：运行时方法面 = 握手 + 会话上下文（`atf.bind_run`）+ 4 工具 + 2 账本；`contract_version` 仍为 2 | ✅ `contract.file.test.ts` 6 用例全过（含新增「补登登记」用例：可选 run_id ×2 / `no_run_bound` / `unknown_run` / `session/run-bound` / 编排口径登记 / 会话族恰 2 个） |
| 3 | mock 路径四组新用例通过（绑定 / 覆盖 / `no_run_bound` / `unknown_run`） | ✅ `tests/bridge/bindRun.test.ts` 5 用例全过（四组 + 覆盖留痕 event 与连接保持断言） |
| 4 | `git diff` 限于 `bridge.contract.yaml`、`src/`（编排与解析相关）、`tests/`（含 fixture）、`docs/`（注记） | ✅ 实际改动：`bridge.contract.yaml`、`src/run/factScanResolver.ts`、`src/run/runner.ts`（1 行）、`tests/fixtures/mock_atf.mjs`、`tests/bridge/contract.file.test.ts`、`tests/run/factScanResolver.test.ts`、新增 `tests/bridge/bindRun.test.ts`；docs 为本报告与指令文档 |

**附加回归面**：七个冒烟全过（s1–s5 / p2s1–p2s3，含指令点名的 s5 / p2s2 / p2s3）——覆盖 runner + resolver 显式 run_id 路径与 mock 全部交互形态。

## 4. 原始输出摘要

- 全量测试（`ATF_CLI_PATH=<pinned> npx vitest run`）：`Test Files 28 passed (28)`；`Tests 200 passed | 2 skipped (202)`。
- 契约自检前置校验：`.atf-pinned` HEAD = `a628f8b8…` = pin `v0.2.0b7`，一致。
- 冒烟：`S5 冒烟通过 ✓（七项总验收全过）`；`P2-S2 冒烟通过 ✓（六类应答 + 升级 + headless 等价 + 无句柄警告）`；`P2-S3 冒烟通过 ✓（交替切换 + 越界拒绝 + 载荷/边界/digest/原子性断言全过）`；S1/S2/S3/S4/P2-S1 均 `冒烟通过 ✓`。
- 内核仓零改动：全程仅经 `ATF_CLI_PATH` 只读消费 pin 副本，无任何回写。

## 5. 第一批（推送授权）过程注记

复跑达标（193 passed / 2 skipped + 三冒烟全过）后执行推送时，`https://github.com` 443 端口连接超时（本机对 github.com:443 出口被阻；`api.github.com`/`codeload.github.com` 同段可达，SSH 22 端口可达）。remote 配置未动，改经 **SSH 22 端口 + 本机已有的 ccssyy 用户密钥** 一次性推送：`938fc66..f2ec34a main -> main`，`ls-remote` 确认远端 `refs/heads/main` = `f2ec34a` = 本地 HEAD，2 笔全部到位（`HEAD..origin/main` 差异为 0）。推送内容与授权范围严格一致，通道切换不涉及任何内容变更。

## 6. 提交清单（本批两笔，均**未推送**）

1. `2596136` `feat(contract): atf.bind_run 方法面补登——会话级 run 绑定登记(owner 指令 20260913；contract_version 保持 2 不 bump)`——契约 + mock + 编排 + 测试（7 文件，+363/−27）。
2. 本报告入库提交（`docs(contract)`）：本报告 + 指令文档《ATF-Harness_Owner指令_推送授权与bind_run补登_20260913.md》。

**完成即停**：第二批推送待 owner 另行授权；不启动 Phase 3、不做 re-pin、内核仓零改动。
