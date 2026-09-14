# ATF-Harness Owner 指令——re-pin 专项（窄 R1：通道对真实内核）

**签发**：owner
**日期**：2026-09-14
**执行方**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**性质**：**re-pin 专项**（唯一合法升级路径，按本仓 `AGENTS.md` §4「re-pin 三步」执行）
**依据**：《ATF内核_Owner决议与指令_B2-2验收_批次二闭合与发版_20260914.md》＋ 本仓 `AGENTS.md` §4 ＋ `bridge.contract.yaml`「版本轴注记」
**结论先行**：把 `atf_upstream` pin 由 `v0.2.0b7` 切到 **`v0.6.0b0`**，并让**契约测试对真实 CLI 跑真实会话断言**（握手 / 帧配对 / stdout 洁净 / 优雅关闭）——即验证「**通道对真实内核成立**」。**本次不做** mock 对端替换（工具面与账本面仍走 mock，属 R2，另批）。

---

## 1. 前置状态（owner 侧实测，已齐备）

| # | 要素 | 实测 |
|---|---|---|
| 1 | harness 契约 v2 + `atf.bind_run` 补登 + 版本轴修正 | ✅ 已推送（HEAD `af94692`，与 origin 同步 0/0） |
| 2 | 内核批次二 tag | ✅ **`v0.6.0b0`**（annotated，tag 对象 → 提交 **`b6db3496b34089147044be9c6b9a0a7ceb595e3a`**）；内核与 origin 同步 0/0 |
| 3 | 内核方法面 | ✅ 7 方法落地；**会话协议版本仍为 1**（方法面补登不 bump） |
| 4 | 内核基线 | **1235 passed / 128 skipped（合计 1363）** |

## 2. 范围与不做项

**做**：`.atf-pinned` 切到目标 tag → 契约 pin 块更新 → `derive_command.env` 补一项 → 契约测试扩充**真实会话断言** → 复跑与报告。

**不做**：mock 对端替换（`tests/fixtures/mock_atf.mjs` 保留，runner 与三条冒烟仍走 mock）；真实写动作（不建真实工作区、不做数据登记 / 闸门推进 / 账本消费）；Phase 3（ACP server / `projection`）；内核仓任何改动。

## 3. 执行步骤

### 3.1 切 pin 副本

```bash
git -C /data/sam/AgenticTrainingFlow worktree remove /data/sam/ATF-Harness/.atf-pinned   # 旧副本在 a628f8b
git -C /data/sam/AgenticTrainingFlow worktree add /data/sam/ATF-Harness/.atf-pinned v0.6.0b0
git -C /data/sam/ATF-Harness/.atf-pinned rev-parse HEAD   # 必须 == b6db3496b34089147044be9c6b9a0a7ceb595e3a
```

若 `worktree remove` 因本地改动受阻：先确认 `.atf-pinned` 无本地改动再移除（**不得**用 `--force` 丢弃未知改动；有改动先报告 owner）。

### 3.2 契约 pin 块更新（`bridge.contract.yaml`）

| 字段 | 新值 |
|---|---|
| `tag` | `v0.6.0b0` |
| `commit_sha` | `b6db3496b34089147044be9c6b9a0a7ceb595e3a` |
| `pinned_at` | `"2026-09-14"` |
| `baseline` | `全量基线 1235 passed / 128 skipped（合计 1363）` |
| `contract_version` | **保持 1**（会话协议版本轴；内核本批未 bump。**桥接契约版本轴不随 re-pin 变动**，见「版本轴注记」） |

### 3.3 `derive_command.env` 补一项（契约变更项，须在 PR 说明中显式列出）

```yaml
env:
  PYTHONPATH: $ATF_CLI_PATH/src
  PYTHONDONTWRITEBYTECODE: "1"
  ATF_SKILLS_AUTO_INSTALL: "0"     # 新增：内核 CLI 入口有技能自举，测试期必须关闭，避免写用户技能目录
```

依据：内核自 `v0.2.0b7` 起 CLI 入口执行技能自举（`skills_install.ensure_skills_installed()`，写 `~/.agents/skills`，开关 `ATF_SKILLS_AUTO_INSTALL` 默认 `1`）。

### 3.4 契约测试扩充：真实会话断言（`tests/bridge/contract.pin.test.ts` 组内）

对 **`ATF_CLI_PATH` 指向的真实 tag 副本**执行真实会话（未设置 `ATF_CLI_PATH` 时整组仍跳过，保持既有语义）：

1. **spawn 真实 CLI**：`python3 -m agentic_training_flow serve`，`cwd = ATF_CLI_PATH`，env 按 `derive_command.env`（含 `ATF_SKILLS_AUTO_INSTALL=0`）；**子进程 HOME / 工作区指向临时夹具**，不得污染用户目录；
2. **握手断言**：`atf.version` → `name === "atf"`、`version` 非空（与内核 `__version__` 一致时可断言）、**`contract_version === EXPECTED_SESSION_CONTRACT_VERSION`（= 1）**；
3. **帧配对**：连续两次 `atf.version`（或一次握手 + 一次 `unknown method` 错误帧）→ `id` 逐条正确回显、无串扰；未知方法 → `method_not_found` 且连接保持；
4. **stdout 洁净**：stdout 全字节流逐行可解析为合法帧（无欢迎语、无诊断输出）；
5. **优雅关闭**：关闭 stdin → 进程 **exit 0**；
6. 上述断言须给出**原始输出片段**入报告。

### 3.5 复跑与冒烟

```bash
ATF_CLI_PATH=/data/sam/ATF-Harness/.atf-pinned npm test    # 底线：修正前基线 200 passed / 2 skipped，新增断言后计数应上升、零回归
npm run smoke:s5 && npm run smoke:p2s2 && npm run smoke:p2s3   # 仍走 mock，本批不动
```

### 3.6 产出报告

《re-pin R1 执行报告》（落 `docs/`）：pin 前后对比（tag/sha/baseline）、契约变更项清单（env + 测试扩充）、真实会话原始输出、验收对照、提交清单。

## 4. 验收标准

1. `.atf-pinned` HEAD == `b6db3496b34089147044be9c6b9a0a7ceb595e3a`；契约 pin 块四项更新到位；
2. **契约测试组对真实 CLI 全绿**（含 §3.4 五项新断言），并给出原始输出；
3. 全量测试**零回归**（下限 = 修正前基线 200 passed / 2 skipped；新增用例计入）；
4. `git diff` 限于：`bridge.contract.yaml`、`tests/bridge/*`、`tests/`（如需夹具）、`docs/`；
5. 内核仓**零改动**；mock 文件保留；`src/` 业务语义零改动；
6. 完成即停——**不启动 R2、不启动 Phase 3**。

## 5. 纪律

1. **re-pin 只落 tag**，禁止追 main 中间态或分支 tip；pin 三项（tag/sha/baseline）必须与 §1 实测一致。
2. 契约变更（`derive_command.env` 与测试扩充）按流程：显式 PR 说明 + owner review；**桥接契约版本轴不随 re-pin 变动**（版本轴注记口径）。
3. 真实 CLI 调用一律在**隔离环境**（临时 HOME / 夹具工作区），不得写用户目录、不得写内核仓。
4. 不做真实写动作（登记 / 推进 / 消费均不触发）；如发现必须触发才能跑通，**停下提请 owner**——那属 R2。
5. 会话边界：harness 侧会话只在本仓作业；内核仓只读。

## 6. R2 登记（下一批，另行签发）

| # | 事项 | 说明 |
|---|---|---|
| 1 | 真实对端夹具 | `atf init` 建工作区（隔离路径）、run 目录骨架、数据集登记、审批预录——形成可复用的测试夹具 |
| 2 | 工具面端到端 | 4 工具方法改走真内核（替换 runner 的 `mockCommand`）；含 `atf_fact_scan` 的两类事实对真实 run 的索引断言 |
| 3 | 账本面端到端 | `ledger_query` / `ledger_consume` 对真实 Approval Ledger 的查询与一次性消费断言 |
| 4 | owner 授权 | 真实写动作（数据登记 / 闸门推进 / 账本消费）属 effect，须 owner 显式授权后方可执行 |
| 5 | mock 退役评估 | R2 完成后评估 `mock_atf.mjs` 的保留范围（冒烟是否仍依赖 mock） |
