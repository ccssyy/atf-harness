# ATF-Harness Owner 指令——版本轴修正（双轴明确）＋ 推送授权

**签发**：owner
**日期**：2026-09-13
**执行方**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**性质**：批次二配套的**跨仓一致性修正**（不启动 Phase 3、不做 re-pin、内核仓只读）
**依据**：《ATF内核_Owner决议与指令_B2-1验收_B2-2启动_双轴裁定_20260913.md》§3（版本轴裁定）＋《ATF-Harness_Owner指令_契约修订_v2_20260913.md》
**结论先行**：`EXPECTED_CONTRACT_VERSION` 的语义错误——它现在等于桥接契约版本（2），却被用来校验内核握手返回的**会话协议版本**。按裁定改为**双轴明确**：握手只校验会话协议版本（当前 **1**）；桥接契约版本（**2**）退回 harness 内部（契约文件自检与文档）。**修正后与 `atf.bind_run` 补登 2 笔一起推送（共 3 笔）。**

---

## 1. 问题（owner 侧实测证据）

| 位置 | 现状 | 问题 |
|---|---|---|
| `src/bridge/connection.ts` | `EXPECTED_CONTRACT_VERSION` 注释为"与 `bridge.contract.yaml` 的 `contract_version` 一致；不一致 = 握手失败"；第 143 行断言不等即 `handshake_failed` | 契约文件升 v2 后该常量 = **2** |
| `src/agentic_training_flow/session/contract.py`（内核） | `SESSION_CONTRACT_VERSION = 1`，握手返回 `contract_version: 1` | 内核只改了方法面，未改线缆规则 → 保持 1 **是正确的** |
| `tests/fixtures/mock_atf.mjs` | 握手默认返回 `contract_version: 2` | mock 与真实内核语义不一致，掩盖了该缺陷 |

⇒ **re-pin 后首次握手即失败**，且错误文案指向"契约版本不一致/请核对 pin"，易被误判为内核版本选择错误。

## 2. 修正范围（本仓）

| # | 变更 | 要点 |
|---|---|---|
| 1 | 常量语义拆分 | `EXPECTED_CONTRACT_VERSION` → **`EXPECTED_SESSION_CONTRACT_VERSION = 1`**（握手校验用）；另设 **`BRIDGE_CONTRACT_VERSION = 2`**（仅契约文件自检/文档用）。命名与注释明确写清两轴，禁止再混用 |
| 2 | 错误文案 | `handshake_failed` 消息由"契约版本不一致…请核对 pin"改为**"会话协议版本不一致：harness 期望 N，对端报告 M（线缆协议不兼容）"**，并附一句"若需核对方法面差异，请查契约文件版本而非本值" |
| 3 | `tests/fixtures/mock_atf.mjs` | 握手默认返回 **1**（与会话协议版本一致）；`--contract-version=N` 参数保留用于注入不一致反例（反例注入 **2** 以验证拒连） |
| 4 | 契约头部注记 | 明确两轴：**会话协议版本**（两侧共有，握手传递，当前 1，仅线缆规则变更时双侧同步 bump）／**桥接契约版本**（harness 独有，当前 2，方法面与字段变更时 bump）。原"双侧 `contract_version` 同步 bump"表述按此精化 |
| 5 | 测试 | 更新握手里程碑用例（期望 1）；保留/新增不一致反例（注入 2 → `handshake_failed`，且断言错误码与文案指向会话协议版本）；契约文件自检用例改为断言 `BRIDGE_CONTRACT_VERSION` 语义 |
| 6 | 文档 | 若 `AGENTS.md` 或 ADR 中涉及"contract_version 同步 bump"的表述，按两轴口径修正（仅指涉该概念处，不改条款语义） |

**不改**：4 工具面（`TOOL_DEFINITIONS` 不变）；`atf.bind_run` 补登内容；`src/session/`、`src/workspace/` 语义；`contract_version` 文件值（**保持 2**）；`atf_upstream` pin（保持 `v0.2.0b7`）。

## 3. 验收

1. 全量测试**零回归**（修正前基线 **200 passed / 2 skipped**；修正后数字入报告）；`typecheck` 通过；
2. 握手用例：期望值 = **1**，与 mock（默认 1）一致 → 通过；注入 2 → `handshake_failed` 且文案指向"会话协议版本"；
3. 契约文件自检仍断言 `contract_version: 2`（`BRIDGE_CONTRACT_VERSION`）；
4. `git diff` 限于：`src/bridge/*`、`tests/`（含 fixture）、`bridge.contract.yaml`（注记）、`docs/`（如需）、`AGENTS.md`（如涉及）。

## 4. 执行序列（先修后推）

1. 阅读本指令；与《契约修订 v2 执行报告》《`atf.bind_run` 补登执行报告》不冲突（本指令只做增量修正）；
2. BUILD（§2 六项）；
3. VERIFY（§3 四项）；
4. **推送前强制复跑**：`ATF_CLI_PATH=/data/sam/ATF-Harness/.atf-pinned npm test`（底线 **200 passed / 2 skipped**）+ `npm run smoke:s5 && npm run smoke:p2s2 && npm run smoke:p2s3`；
5. **推送**：`git push origin main`——本次共 **3 笔**（`2596136` 补登 + `d69b28f` 补登报告 + 本次修正笔）；
6. 产出《版本轴修正执行报告》（问题与证据 / 六项变更对照 / 验收对照 / 推送存证），落 `docs/`，随推送入库；
7. 完成即停——**不启动 Phase 3、不做 re-pin、内核仓零改动**。

## 5. 纪律

1. 内核仓只读；`atf_upstream` pin 保持 `v0.2.0b7`。
2. 会话协议版本（1）与桥接契约版本（2）**不得再混用**；任何涉及两轴的表述以本指令 §2 第 4 项口径为准。
3. 零 npm 运行时依赖；无 GPU / 无真实 Provider。
4. 会话边界：harness 侧会话只在本仓作业；收到内核侧任务（`_docs/` 下内核任务书）先停下提请 owner。
