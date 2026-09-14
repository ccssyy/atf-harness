# ATF 独立 Harness——R2 任务书：真实对端夹具与工具面端到端

**日期**：2026-09-14
**签发**：owner
**执行方**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**依据**：《ATF-Harness_Owner指令_re-pin专项_R1_20260914.md》＋《ATF-Harness_re-pinR1执行报告_20260914.md》＋《ATF内核_批次二任务书_20260913.md》＋《ATF-Harness_Owner指令_re-pinR1验收与推送_20260914.md》§5 ＋ 本仓 `AGENTS.md` §4
**性质**：**两道门**——门 1 只交设计（夹具设计），owner review 通过后才进门 2（实现＋真实写授权）。**不得跳门。**
**结论先行**：R1 已证「通道对真实内核成立」；R2 的目标是让**业务方法面**也在真实内核上端到端跑通——把 `runner.ts` 的 `mockCommand` 换成真内核，并为此建设**可复用、可隔离、可清理的真实对端夹具**。

---

## 0. 现状（owner 侧实测）

| 项 | 实测 |
|---|---|
| pin | `v0.6.0b0`（`b6db3496b34089147044be9c6b9a0a7ceb595e3a`）；`.atf-pinned` 已切换 |
| 契约测试 | 真实会话断言已启用并通过（`202 passed / 1 skipped`：原 2 个占位 skip 已落地为真实用例） |
| 仍走 mock 的路径 | `src/run/runner.ts`（`mockCommand`）＋ `src/bridge/smoke.ts` ＋ `src/run/smoke.ts` / `smokeP2S2.ts` / `smokeP2S3.ts` ——**全部指向 `tests/fixtures/mock_atf.mjs`** |
| 方法面 | 内核 7 方法已落地（`atf.bind_run` / `atf_workspace_status` / `atf_fact_scan` / `atf_gate`(query+advance) / `atf_admit_data` / `ledger_query` / `ledger_consume`） |

**真内核方法的最小前提（据内核 B2-1/B2-2 实现实测）**：

| 方法 | 真实前提 | 备注 |
|---|---|---|
| `atf.bind_run` | `runs/<run_id>/` 存在（run 目录骨架，十目录） | 不存在 → `unknown_run` |
| `atf_workspace_status` | workspace root（`atf init` 或等价目录树）＋ `datasets/*/registration.json` | 未初始化 → 按 `unknown_run` 折入 |
| `atf_fact_scan` | run 的 `journal/journal.jsonl`（原产地流水）＋ 数据集登记面 | 产出两类事实：`operation-journal` / `dataset-registry` |
| `atf_gate`（G1–G4 query/advance） | `l1/**/source-backed-admission-summary.json`（准入 summary，可多份，取最坏裁决） | 缺 summary → 可理解 block |
| `atf_gate`（完整性 Gate advance） | `GateEngine.evaluate` 求值所需契约/证据对象＋ `GateResult` 登记 | 未登记时 query → `blocked(gate_verdict_not_registered)` |
| `atf_admit_data` | workspace root ＋ 可选 L1 产物目录（逐产物 sha 登记） | `pin` 显式优先，缺省 `canonical_digest[:12]` |
| `ledger_query` / `ledger_consume` | **预录审批链**（`register_command` ＋ `consume_command` 形成 approved 记录） | 完全显式：`scope_ref` 必传；消费为 CAS 一次性跃迁 |

---

## 1. 门 1：真实对端夹具设计（**只交设计，不写实现**）

产出《R2 夹具设计》文档（落 `docs/`），必须逐项回答：

1. **夹具形态与生命周期**：临时 workspace 建在何处（建议 `/tmp` 隔离根）；用 `atf init --workspace-root` 还是直接构造目录树（两者取舍）；创建/销毁时机与幂等性（失败残留如何清理）。
2. **覆盖表**：上表 7 类前提逐项标注——**夹具可满足** / **不可满足**（不可满足者必须给出替代路径，例如完整性 Gate 只能覆盖"未登记 → `blocked`"分支，或需要构造最小证据对象）。
3. **最小 run 夹具的构成**：十目录骨架；`journal/journal.jsonl` 样例（行格式 `{ts, action, out, refs}`）；准入 summary 样例（或多 lane 多份以验证"最坏裁决"）；数据集登记（`datasets/<id>@<pin>/registration.json`）；审批链预录（`register_command` + `consume_command` 的真实调用路径）。
4. **隔离与安全**：HOME、workspace root、`ATF_SKILLS_AUTO_INSTALL=0` 的强制注入；如何**断言**未污染 `~/.agents/skills`、未写内核仓、未触碰真实业务数据。
5. **双轨策略**：`ATF_CLI_PATH` 未设置 → 走 mock（CI/常规开发不依赖真内核）；设置 → 走真内核（本地与专项）。两条轨的用例集合如何组织（同文件分支 / 独立文件）。
6. **真实写动作清单**：每个写动作（`atf_admit_data` 落 `datasets/…`、`atf_gate advance` 登记 GateResult、`ledger_consume` 追加 consumed 记录）写到哪个绝对路径、产生哪些落盘证据、如何验证与清理；并明确**需要 owner 授权的范围**。
7. **与场景/冒烟的对接**：S5 四分支（`admission-to-g2` 等）是否改走真内核，或另建"真对端专项冒烟"（如 `smoke:r2`）；mock 冒烟是否保留。
8. **风险与回退**：真内核行为与 mock 的关键差异（如 `no_run_bound`、`unknown_gate`、多 summary 聚合）如何在夹具设计中吸收；失败时如何回退到 mock 轨。

**门 1 交付后停下等 owner review；不得预写实现代码。**

---

## 2. 门 2：实现（review 通过 + owner 对真实写的授权后）

1. **替换对端**：`src/run/runner.ts` 的 `mockCommand` → 真内核 spawn（按契约 `derive_command`：`python3 -m agentic_training_flow serve`，`cwd = ATF_CLI_PATH`，`PYTHONPATH=<ATF_CLI_PATH>/src`，`PYTHONDONTWRITEBYTECODE=1`，`ATF_SKILLS_AUTO_INSTALL=0`）。
2. **夹具实现**：按门 1 结论落地（建议独立模块 + 工厂函数，供测试与冒烟共用）。
3. **真对端端到端验证**：至少覆盖链路——`bind_run` → `workspace_status` → `fact_scan` → `gate`(G 系 query) → `admit_data`（写）→ `gate`(G 系 advance，写) → `ledger_query` → `ledger_consume`（写）；并含一条 fail-closed 反例（如未绑定 → `no_run_bound`、空链消费 → `not_found`）。
4. **冒烟**：新增 `smoke:r2`（真对端专项）或扩展既有冒烟的真对端变体；三条既有冒烟（`s5`/`p2s2`/`p2s3`）保持 mock 轨不动。
5. **验收**：端到端链路全绿 ＋ **真实写落盘证据**（文件路径与内容摘要）＋ 隔离断言（无用户目录/内核仓/真实数据污染）＋ 全量零回归（下限 `202 passed / 1 skipped`）。
6. **mock 退役评估**：评估 `mock_atf.mjs` 保留范围（结论入报告，退役与否由 owner 定）。

---

## 3. 硬约束

- ❌ 真实写动作**仅限隔离夹具路径**（`/tmp` 下的临时 workspace）；不得写用户目录、不得写内核仓、不得触碰真实业务数据；
- ❌ 不启动 Phase 3（ACP server / `projection` 激活）；不接真实模型 Provider；不做 GPU 相关动作；
- ❌ 不改内核仓一行；不改会话协议数值；
- ✅ 双轨并存：`ATF_CLI_PATH` 未设置时全套测试仍须能通过（mock 轨）；
- ✅ 零 npm 运行时依赖（`dependencies` 恒空）；
- ✅ 契约如因 R2 需要变更 → 走契约流程（显式 PR + 双仓契约测试 + owner review），**桥接契约版本轴 bump、会话协议轴不动**。

---

## 4. 流程与纪律

1. 门 1 交付《R2 夹具设计》→ **停下等 review**；门 2 开工前须取得 owner 对**真实写动作**的显式授权（授权范围按门 1 §6 清单）。
2. 分支：`work/<日期>-r2-real-peer-fixtures` 短命分支 + worktree；合回 main 后删除。
3. 阶段产出：《R2 门 1 夹具设计》→（review）→《R2 回执行报告》（含端到端原始输出、写落盘证据、隔离断言、验收对照、提交清单）。
4. 推送前须 owner 授权；tag 打出后不得移动。
5. 会话边界：harness 侧会话只在本仓作业；收到内核侧任务先停下提请 owner。
6. 通用性红线与脱敏纪律延续（实现/测试/文档不得出现内部绝对路径与业务内容）。

---

## 5. 与另一侧的关系（登记）

| # | 事项 | 说明 |
|---|---|---|
| 1 | 内核侧**不改** | R2 全部改动在 harness 侧；内核只作为被调用的对端 |
| 2 | pin 保持 `v0.6.0b0` | 本批不涉 re-pin；如需新内核能力 → 走 ATF 仓排队，不插队 |
| 3 | 若发现内核侧缺陷 | 停下报告 owner（附最小复现），由 owner 决定是否开内核侧修复批 |
