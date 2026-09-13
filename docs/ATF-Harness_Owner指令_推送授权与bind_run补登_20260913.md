# ATF-Harness Owner 指令——契约 v2 推送授权 + `atf.bind_run` 契约补登

**签发**：owner
**日期**：2026-09-13
**执行方**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**性质**：①推送授权 ＋ ②批次二配套的契约补登（**不启动 Phase 3、不做 re-pin、内核仓只读**）
**依据**：《ATF-Harness_Owner指令_契约修订_v2_20260913.md》＋《ATF内核_批次二规格_定稿_20260913.md》§2（会话上下文口径）＋《ATF内核_批次二任务书_20260913.md》§2/§9
**结论先行**：**授权推送 harness 侧 2 笔**（`a6814f7` 契约 v2、`f2ec34a` 执行报告）；随后完成 **`atf.bind_run` 方法面补登**（含两方法可选 `run_id`、错误码登记、mock 对端与测试同步）——属**方法面补登，不 bump `contract_version`**。

---

## 1. 推送授权（第一批）

1. **推送前强制复跑**：
   ```bash
   ATF_CLI_PATH=/data/sam/ATF-Harness/.atf-pinned npm test   # 底线：193 passed / 2 skipped（27 文件）
   npm run smoke:s5 && npm run smoke:p2s2 && npm run smoke:p2s3
   ```
   任何偏差立即停止并报告 owner。
2. **推送**：`git push origin main`（`938fc66..f2ec34a`，共 2 笔）。
3. **报告到位确认**：推送后 `git rev-list --count HEAD..origin/main` 应为 0。

---

## 2. `atf.bind_run` 契约补登（第二批，方法面补登）

**背景**：契约 v2 的 `atf_workspace_status` / `atf_fact_scan` 参数为 `{}`（隐含"当前 run"），批次一会话无状态；内核侧批次二将实现会话级 run 绑定（《批次二任务书》§2 口径）。本补登把该口径登记进契约，避免"内核已实现、契约无登记"的不一致窗口。

**范围（本仓）**：

| # | 变更 | 要点 |
|---|---|---|
| 1 | 新增会话方法 **`atf.bind_run`** | `params: {run_id: string}` → `result: {ok: true, run_id: string, scope_ref: {project_id, scope_type, scope_id, scope_mode}}`；**归入"会话方法"区（与 `atf.version` 同族），不进 4 工具面** |
| 2 | `atf_workspace_status` / `atf_fact_scan` 参数 | 由 `{}` 改为**可选 `run_id`**（`required: []`）；语义注记：显式 `run_id` 优先于会话绑定 |
| 3 | 错误码登记 | 新增 `no_run_bound`（未绑定且未显式给 run_id，fail-closed）、`unknown_run`（run_id 不存在/不可解析）；两者均为 error response、**连接保持** |
| 4 | 绑定留痕 | 契约注记：重复绑定允许覆盖，但内核须发 event 留痕（`name: "session/run-bound"`，payload 含 from/to run_id） |
| 5 | 契约头部登记 | 在 v2 修订登记的**补登条目**中追加本次四项；**`contract_version` 保持 2 不 bump**（方法面补登，沿用批次一先例：仅帧格式/握手 schema/生命周期语义变更才 bump） |
| 6 | mock 对端与测试 | `tests/fixtures/mock_atf.mjs` 支持 `atf.bind_run`（会话内绑定状态）与 `no_run_bound` 语义；新增/更新用例覆盖：绑定后无参调用、显式 `run_id` 覆盖、未绑定报错、`unknown_run` |

**编排层口径（本批同时定）**：本仓编排在 run 开始时**采用显式 `run_id`**（方法无隐式依赖，无状态优先）；`atf.bind_run` 主要服务宿主/长会话场景（Phase 3 dispatch 时使用）。编排选择须在报告与契约注记中写明。

**不做**：不改 4 工具面（`TOOL_DEFINITIONS` 仍为 `atf_admit_data` / `atf_gate` / `atf_fact_scan` / `atf_workspace_status`）；不改 `src/session/`、`src/workspace/` 语义；不接真实内核对端；不启 Phase 3。

**验收**：
1. 全量测试**零回归**（推送后基线 193 passed / 2 skipped）；`typecheck` 通过；
2. 契约自检（`contract.file.test.ts`）扩展后通过：运行时方法面 = 握手 + 会话上下文（`atf.bind_run`）+ 4 工具 + 2 账本；`contract_version` 仍为 2；
3. mock 路径四组新用例通过（绑定 / 覆盖 / `no_run_bound` / `unknown_run`）；
4. `git diff` 限于：`bridge.contract.yaml`、`src/`（编排与解析相关）、`tests/`（含 fixture）、`docs/`（如需注记）。

**推送**：本批为**新增提交**，其推送**需另行提请 owner 授权**（不随第一批一并推）。

---

## 3. 执行序列

1. 阅读本指令；与《契约修订 v2 执行报告》不冲突（本指令只做增量）；
2. **第一批**：复跑 → `git push origin main` → 报告推送结果（remote 指向、笔数）；
3. **第二批**：BUILD（§2 六项）→ VERIFY（§2 四项验收）→ 产出《`atf.bind_run` 补登执行报告》（变更对照 / mock 与编排口径 / 验收对照 / 提交清单），落 `docs/`；
4. **本地提交，不推送**；完成即停——第二批的 push 待 owner 授权；**不启动 Phase 3、不做 re-pin、内核仓零改动**。

---

## 4. 纪律

1. 内核仓只读；`atf_upstream` pin 保持 `v0.2.0b7` 不动（re-pin 另行指令）。
2. 契约变更登记纪律：方法面补登也须在契约头部登记，禁止悄悄改；`contract_version` 仅在帧格式 / 握手 schema / 生命周期语义变更时 bump。
3. 零 npm 运行时依赖（`dependencies` 恒空）；无 GPU / 无真实 Provider。
4. **会话边界**：harness 侧会话只在本仓作业；若收到内核侧任务（`_docs/` 下内核任务书），先停下提请 owner。
