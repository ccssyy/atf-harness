# ATF-Harness 版本轴修正（双轴明确）执行报告

**签发**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**日期**：2026-09-13
**依据**：《ATF-Harness_Owner指令_版本轴修正与推送_20260913.md》（§2 六项 + §3 验收 + §4 执行序列；依据《ATF内核_Owner决议与指令_B2-1验收_B2-2启动_双轴裁定_20260913.md》§3 版本轴裁定）
**性质**：跨仓一致性修正执行报告——**不启动 Phase 3、不做 re-pin、内核仓零改动**
**结论先行**：`EXPECTED_CONTRACT_VERSION` 的语义缺陷已按双轴裁定修正——握手只校验**会话协议版本（1）**；桥接契约版本（**2**）退回 harness 内部（契约文件自检/文档）。修正后与 `atf.bind_run` 补登 2 笔一并推送（共 3 笔），远端已确认到位。

---

## 1. 问题与证据（指令 §1）

| 位置 | 修正前现状 | 缺陷 |
|---|---|---|
| `src/bridge/connection.ts` | `EXPECTED_CONTRACT_VERSION = 2`，注释称"与 bridge.contract.yaml 的 contract_version 一致"，握手不等即 `handshake_failed` | 契约 v2 后该常量 = 桥接契约版本 2，却用于校验握手返回的**会话协议版本** |
| 内核 `session/contract.py` | `SESSION_CONTRACT_VERSION = 1`，握手回 1 | 内核只改方法面、未改线缆规则，**保持 1 是正确的**——re-pin 后首次握手必失败 |
| `tests/fixtures/mock_atf.mjs` | 握手默认回 2 | mock 与真实内核语义不一致，掩盖了上述缺陷 |

错误文案"契约版本不一致……请核对 bridge.contract.yaml 与 atf_upstream pin"进一步误导排查方向（指向版本选择而非语义混用）。

## 2. 六项变更对照（指令 §2 逐项）

| # | 指令要求 | 实际落点 | 状态 |
|---|---|---|---|
| 1 | 常量语义拆分：`EXPECTED_SESSION_CONTRACT_VERSION = 1`（握手校验用）＋ `BRIDGE_CONTRACT_VERSION = 2`（仅契约文件自检/文档用） | `connection.ts` 两常量并立，注释写明双轴（轴一与内核 `session/contract.py::SESSION_CONTRACT_VERSION` 同源；轴二 harness 独有不进握手）；`bridge/index.ts` 转出口同步替换 | ✅ |
| 2 | 错误文案改指向会话协议版本 | `handshake_failed` 消息 = "会话协议版本不一致：harness 期望 1，对端报告 M（线缆协议不兼容；若需核对方法面差异，请查契约文件版本而非本值）"；`errors.ts` 中 `handshake_failed` 枚举注释同步精化 | ✅ |
| 3 | mock 握手默认回 1；`--contract-version=N` 保留（反例注入 2） | `contractVersion` 缺省 `2 → 1`；头部旗标注记更新（双轴口径指引）；旗标机制本身未动 | ✅ |
| 4 | 契约头部两轴注记；"双侧同步 bump"表述精化 | 新增「【版本轴注记（双轴明确）2026-09-13】」登记块（两轴定义/承载常量/当前值/bump 条件 + 问题存证）；头部变更纪律改两轴表述；v2 登记 #9 与"mock 握手回 2"表述原位标注**作废精化**（不删史）；`atf_upstream` 注记同步修正 | ✅ |
| 5 | 测试：握手期望 1；不一致反例注入 2 并断言文案；契约自检断言 `BRIDGE_CONTRACT_VERSION` 语义 | `session.test.ts` 握手期望 `contract_version: 1`；反例 `--contract-version=2`，断言 `handshake_failed` + 文案五段（会话协议版本不一致/期望 1/对端报告 2/线缆协议不兼容/请查契约文件版本）；`frames.test.ts` 夹具值 2→1；`contract.file.test.ts` 新增 `BRIDGE_CONTRACT_VERSION === 2` 与文件头部值锚定 + 版本轴注记存在性断言 | ✅ |
| 6 | AGENTS.md/ADR 涉"contract_version 同步 bump"表述按两轴精化 | 全库排查：ADR（Phase0 决策文档）无该表述；`AGENTS.md` §4 re-pin 第②步精化——pin 的 contract_version 属**会话协议版本轴**随内核 bump 同步，桥接契约版本轴不随 re-pin 变动（仅指涉处，条款语义不变，本指令即授权） | ✅ |

**「不改」项核对**：`TOOL_DEFINITIONS` 4 工具面零改动；`atf.bind_run` 补登内容零改动；`src/session/`、`src/workspace/` 零改动；契约文件 `contract_version` 值保持 **2**；`atf_upstream` pin 保持 `v0.2.0b7` / `a628f8b`。

## 3. 验收对照（指令 §3 四项）

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 全量测试零回归（修正前基线 200 passed / 2 skipped）；typecheck 通过 | ✅ **200 passed / 2 skipped（28 文件）**——与基线逐位一致（本批为用例修正，无新增）；`tsc -p tsconfig.json` 零错误 |
| 2 | 握手期望 = 1 与 mock 默认一致 → 通过；注入 2 → `handshake_failed` 且文案指向会话协议版本 | ✅ `session.test.ts` 三用例（握手 1 / 注入 2 反例五段文案断言 / close 幂等）全过 |
| 3 | 契约自检仍断言 `contract_version: 2`（`BRIDGE_CONTRACT_VERSION`） | ✅ 自检首用例 = 双轴语义断言（文件值 2 ≡ `BRIDGE_CONTRACT_VERSION`；版本轴注记在位） |
| 4 | diff 限于 `src/bridge/*`、`tests/`（含 fixture）、`bridge.contract.yaml`（注记）、`docs/`（如需）、`AGENTS.md`（如涉及） | ✅ 实际：`src/bridge/{connection,errors,index}.ts`、`tests/bridge/{session,frames,contract.file}.test.ts`、`tests/fixtures/mock_atf.mjs`、`bridge.contract.yaml`、`AGENTS.md`、docs（指令文档随修正笔入库） |

**附加回归面**：三冒烟全过（s5 七项总验收 / p2s2 六类应答 / p2s3 切换边界）——覆盖握手 → 会话 → 工具 → run 全链路。

## 4. 推送存证

- **推送前强制复跑**（指令 §4.4）：全量 `200 passed | 2 skipped (202)`；`smoke:s5` / `smoke:p2s2` / `smoke:p2s3` 全过。`.atf-pinned` HEAD = `a628f8b` = pin `v0.2.0b7` 一致。
- **推送**（指令 §4.5，共 3 笔）：`git push` → `f2ec34a..f87d429 main -> main`：
  1. `2596136` `feat(contract): atf.bind_run 方法面补登`（上一工作包，owner 本指令授权随推）；
  2. `d69b28f` `docs(contract): atf.bind_run 补登执行报告入库`（同上）；
  3. `f87d429` `fix(contract): 版本轴修正（双轴明确）——握手只校验会话协议版本`（本批修正笔，含指令文档）。
- **到位确认**：`ls-remote` + fetch 对齐后 `git rev-list --count HEAD..origin/main` = **0**，远端 `refs/heads/main` = `f87d429` = 本地 HEAD。
- **通道注记**：本机 `github.com` 443 出口仍被阻（承上一报告 §5），本次推送同走 SSH 22 + `id_ed25519_llama_fatory` 用户密钥，remote 配置未动；URL 直推后已 fetch 对齐 `refs/remotes/origin/main` 跟踪引用。

## 5. 完成即停

本报告与后续 docs 提交**未随本次推送**（推送严格限定 3 笔），随下次 owner 授权推送入库。**不启动 Phase 3、不做 re-pin、内核仓零改动。**
