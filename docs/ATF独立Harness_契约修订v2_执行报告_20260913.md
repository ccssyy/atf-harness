# ATF 独立 Harness——契约修订 v2 执行报告

> **本工作包由内核侧会话执行（owner 误派），产出经 owner 核验追认（2026-09-13）。**

- **日期**：2026-09-13
- **执行方**：zcode（内核侧会话，经 owner 指派至 harness 仓 `/data/sam/ATF-Harness`；勘误与追认见上）
- **性质**：批次二**前置工作包**（契约修订）执行报告——不启动 Phase 3、不做 re-pin、内核仓零改动
- **依据**：《ATF-Harness_Owner指令_契约修订_v2_20260913.md》＋《ATF内核_批次二规格_定稿_20260913.md》§1（D1/D2/D3 与 S1–S3 裁决）
- **提交**：`a6814f7`（harness main，**本地提交未推送**，领先 origin/main 1 笔；推送待 owner 授权）
- **结论先行**：`bridge.contract.yaml` 已修订至 **`contract_version: 2`**，指令 §2 变更清单十项、§3 同步面六项全部落地；验收 §4 五项全过（全量 193 passed / 2 skipped 零回归、契约自检自动化、旧名 grep 合规）。

---

## 1. 变更清单对照（指令 §2 十项）

| # | 变更 | 落点 |
|---|---|---|
| 1 | `atf_surface_scan` 改名 `atf_fact_scan`；数组字段 `surface` → `facts`（三元组 `journal_type`/`fact_id`/`sha256_digest` 不变）；语义注记改为"枚举本 run 可被引用的事实索引" | 契约 methods、`src/tools/toolDefinition.ts`、`src/run/surfaceScanResolver.ts` → `src/run/factScanResolver.ts`（git mv，保留改名史）、`tests/fixtures/mock_atf.mjs`、场景脚本、测试 |
| 2 | `atf_gate.result.status` 枚举 `pass\|blocked` → `pass\|warn\|blocked`；新增 `reason_codes` / `requires_human_review` / `evidence`；`reason` / `missing` 保留为兼容字段并注明"建议由 `reason_codes` 派生" | 契约 methods + 工具定义 canonical；mock blocked 路径改发 `reason_codes: ["evidence_missing"]` |
| 3 | `atf_gate.params` 增注命名分流：`^G[1-4]$`（大小写不敏感、内部归一化）→ 数据准入闸；其余须命中七组完整性 GateId；都不命中 → `unknown_gate`（fail-closed） | 契约 params 注记 + 工具 description |
| 4 | `ledger_query` 改内核审批链键模型：`params = {scope_ref{project_id, scope_type, scope_id, scope_mode}, operation_id?, state?, include_consumed?}`；`result = {ok, records:[{record_id, approval_id, sequence, state, command_id?, actor?, operation_id?, attempt_id?, evidence_refs?}]}`；默认只返回可消费记录（state=approved 且未 consumed） | 契约 methods + executor + mock（scope_ref 精确匹配、operation_id 过滤、state/include_consumed 语义） |
| 5 | `ledger_consume`：`params = {approval_ref, record_id}`；`result = {ok, record_id, state:"consumed"}`；错误码 `approval_already_consumed` / `approval_record_mismatch` / `not_found` | 契约 methods（errors 登记）+ mock（三错误码逐值一致校验） |
| 6 | `{tool, params_digest, consumed}` 配额式键不再是账本键；如需保留由 harness 自行维护映射（不进内核账本） | 契约头部「审批账本键模型 v2」登记；digest 算法保留为审计检索辅助；问答轨提案键（approval_key = params_digest）为 harness 内部状态键，维持不变 |
| 7 | `atf_admit_data`：`params.source?` → `source_ref?`（可校验引用）；result 三元组明示 `journal_type:"dataset-registry"` / `fact_id:"<dataset_id>@<pin>"` / `sha256_digest`=登记记录 canonical digest | 契约 + 工具定义 + mock（pin = dataset_id sha256 前 12 位确定性派生；真实 pin 来源由批次二任务书明确） |
| 8 | `atf_workspace_status.result` 增补 `scope_ref`（供 `ledger_query` 定位） | 契约 + canonical + mock（固定 `mock-run-1` 作用域） |
| 9 | 契约头部 `contract_version: 1 → 2` + 变更清单登记 + 双侧同步 bump 要求 | 契约头部「契约 v2 修订登记 2026-09-13」；`src/bridge/connection.ts::EXPECTED_CONTRACT_VERSION` 1→2；mock 握手 contract_version 同步回 2 |
| 10 | 仓内文档「严格 4 工具面」方法名同步 | `AGENTS.md` 与 ADR 经 grep 核查**无旧方法名表述**，无需改动；4 份历史存档 md + `docs/admission-to-g2.json` 加显式时代注记（§5） |

**runner 侧配套**（同步面 #3 的延伸）：`ScenarioRunner` 以 `{project_id: <scenario_id>, scope_type: "run", scope_id: <run_id>, scope_mode: "headless"}` 确定性派生 scope_ref，setup 预录（`ledger_record` params = `{scope_ref, tool, params_digest}`）与执行期查询天然同域；`ToolExecutor` 构造注入 scope_ref，缺省时须审批调用 `failed(scope_ref_missing)`（fail-closed，新增专项用例）。

## 2. 同步面证据（指令 §3 六项）

| # | 同步面 | 证据 |
|---|---|---|
| 1 | `TOOL_DEFINITIONS` 四工具方法名与 canonical output schema | `toolDefinition.ts` v2 化；`tests/tools/definition.test.ts` 断言工具面闭集恰 4 且含 `atf_fact_scan`；executor/registry 全链过 canonical 校验 |
| 2 | `FactScanResolver` 改名后的方法调用与 `facts` 字段解析 | git mv 改名文件与类名；`lookupDigest` 逻辑不变仅字段名；`tests/run/factScanResolver.test.ts` 命中/未命中/canonical 破损/桥接故障四路径全绿 |
| 3 | 账本轨实现与 mock 对端 | `executor.ts` approve() 改 scope_ref 查询 + `{approval_ref, record_id}` 消费；`MockLedger` 重做审批链形态（`rec-NNN` / `apr-NNN` / `sequence` / `state`，一次性语义在对端强制）；`approvalTrack` 问答轨语义零改动（提案键为 harness 内部） |
| 4 | 场景脚本 | `scenarios/admission-to-g2.json`（2 处）与 `scenarios/provider-alternation.json`（1 处）旧名清零；B2 分支断言随 mock 改发 `reason_codes` 对齐 |
| 5 | 既有测试断言 | executor / definition / session / frames / fauxProvider / sessionLog / scenario / approvalTrack 各测试更新；executor 新增「默认只返回可消费记录」与「scope_ref 缺省 fail-closed」两用例 |
| 6 | 契约测试 | 新增 `tests/bridge/contract.file.test.ts`（5 用例，零依赖文本断言）；`contract.pin.test.ts` 维持 pin 校验 + `--help` 冒烟范围不变 |

## 3. 验收对照（指令 §4 五项）

1. **全量零回归** ✅：与基线同口径（设 `ATF_CLI_PATH`）实测 **193 passed / 2 skipped（27 文件）**；基线 186 passed / 2 skipped（26 文件）——净增 7 passed 全部为新用例（契约自检 5 + executor 2），skip 数一致，零回归。typecheck（`tsc -p tsconfig.json`）通过。
2. **契约测试** ✅：pin 校验（`git rev-parse HEAD` == `a628f8b`）与 `--help` 冒烟对 pin `v0.2.0b7` 只读副本**真实执行通过**（450ms，非 skip）；mock 路径全量断言通过；真实会话断言仍按契约 known_gaps 待 re-pin。
3. **契约文件自检** ✅（已自动化于 `contract.file.test.ts`）：`contract_version: 2`；运行时方法面 = 握手 `atf.version` + 4 工具（含 `atf_fact_scan`）+ 2 账本方法（`ledger_query`/`ledger_consume`），`ledger_record` 注明 mock setup 基建不计——即规格 §2「六个方法」的运行时口径（方法键合计 7 = 6 运行时 + 握手，计数口径已与规格逐条对齐）；`atf_upstream` pin 仍为 `v0.2.0b7`（`a628f8b`）。
4. **改名完整性** ✅：`src/`、`tests/`、`scenarios/` 旧名**零命中**；全仓余量仅四类且均显式注明——①契约 v2 变更登记注释（自检测试强制"旧名只允许出现在 `#` 注释部分"）；②历史存档文档的时代注记（§5）；③自检测试自身的规则断言字符串；④owner 指令原文（未触碰）。
5. **双侧同步 bump** ✅：已写入提交信息与契约头部登记——内核侧批次二按契约 v2 实现时，同步其握手 `contract_version`（`session/contract.py::SESSION_CONTRACT_VERSION` 单一常量承载），禁止任何一侧悄悄改。

**手工冒烟**（`npm run smoke:s3`，exit 0，原始输出）：

```text
[2] 无预录调用 atf_admit_data → 期望 blocked(approval_missing, exit 78)
✓ 无预录 → blocked — exit=78
[3] 账本预录（scope_ref + 审计辅助键）→ admit_data 执行成功（canonical 校验通过）
✓ 预录 ledger_record — {"ok":true,"record_id":"rec-001"}
✓ admit_data 执行成功 — fact="ds-001@63b3fa92c8f3"
[4] 重复调用同 request → 账本已消费 → blocked（一次性消费语义）
✓ 重复调用 → blocked(approval_missing)
[5] atf_gate advance：预录 gate 审批（证据已准入）→ pass
✓ gate G2 pass — {"ok":true,"gate":"G2","status":"pass"}
[6] 只读工具免审批：fact_scan / workspace_status
✓ fact_scan count=1
✓ workspace_status admitted_count=1 且含 scope_ref
✓ 优雅关闭
S3 冒烟通过 ✓
```

## 4. 提交清单

- **提交**：`a6814f7` `feat(contract): 契约修订 v2——批次二前置工作包`（harness main，本地未推送）。
- **变更面**：契约 1（bridge.contract.yaml）；src 11 文件（bridge/connection、tools/{approvalKey,errors,executor,index,smoke,toolDefinition}、run/{factScanResolver,index,runner}）；tests 10 文件（含改名 2、新增 contract.file.test.ts）与 mock_atf.mjs；scenarios 2；docs 时代注记 5（4 md + 1 json）；owner 指令文档随本包入库。
- **不动项核验**：内核仓零改动；`src/session/`、`src/workspace/` 语义零改动；pin `v0.2.0b7` 未动；Phase 3（ACP server / projection）未触碰；零新增 npm 依赖。

## 5. 时代注记明细（验收 §4.4 承载）

- 契约文件：旧名仅存于 v2 变更登记注释（自检测试机械强制"注释部分之外零残留"）。
- 历史存档加注（4 md + 1 json，均于标题后/文件头插入显式时代说明）：`ATF独立Harness_Phase1任务书_20260908.md`、`ATF-Harness_Owner决议与启动指令_S3闭合_S4启动_20260909.md`、`ATF独立Harness_Phase1_S3执行报告_20260909.md`、`ATF独立Harness_Phase1_S5执行报告暨Phase1闭合报告_20260909.md`、`docs/admission-to-g2.json`（`_era_note` 字段）。
- owner 指令 `ATF-Harness_Owner指令_契约修订_v2_20260913.md`：原文保留，不加注（授权文件本身即变更依据）。

## 6. 停止点

契约 v2 已落定并经 owner 核验追认（2026-09-13）。**未推送**（待 owner 授权）；Phase 3 未启动；re-pin 未执行。批次二的内核侧任务书可按《批次二规格（定稿）》§2 签发——规格 §4 待确认细项中"fact_scan 数组字段名"已随本契约定为 `facts`，其余细项（pin 来源、journal_type 回填等）由批次二任务书明确。
