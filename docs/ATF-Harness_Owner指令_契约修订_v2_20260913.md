# ATF-Harness Owner 指令——契约修订 v2（批次二前置工作包）

**签发**：owner
**日期**：2026-09-13
**执行方**：zcode（harness 侧 `/data/sam/ATF-Harness`）
**性质**：批次二**前置工作包**（契约修订）——**不启动 Phase 3**、不做 re-pin、不碰内核仓
**依据**：《ATF内核_批次二规格_定稿_20260913.md》§1（D1/D2/D3 与 S1–S3 裁决）
**结论先行**：按批次二规格把另一侧 `bridge.contract.yaml` 修订至 **`contract_version: 2`**：`atf_surface_scan` 改名 `atf_fact_scan`（数组字段 `surface` → `facts`）、`atf_gate` 结果增补 `warn` 与附加字段、账本方法改用内核审批链键模型、`atf_admit_data` 参数与输出对齐、`atf_workspace_status` 透出 `scope_ref`。改动走契约流程（显式 PR + 双仓契约测试 + owner review + 双侧同步 bump）。

---

## 1. 范围与边界

**改**（本仓）：`bridge.contract.yaml`（`methods` 节与相关注记）、工具定义与断言（`src/tools/` 内 4 工具面）、`src/run/surfaceScanResolver.ts`（改名与字段）、测试桩对端（MockLedger 等）、场景脚本中引用旧方法名/旧字段处、仓内文档中「4 工具面」相关表述、契约测试。

**不改**：内核仓（一行不改）；本仓 `src/session/`、`src/workspace/` 的既有语义；Phase 3 相关内容（ACP server / `projection` 激活）；`atf_upstream` pin（**保持 `v0.2.0b7` 不动**，re-pin 另行指令）。

**不做**：真实 Provider、真实内核对端、GPU。

---

## 2. 变更清单（逐条，均以批次二规格为准）

| # | 位置 | 变更 |
|---|---|---|
| 1 | `methods.atf_surface_scan` | **改名 `atf_fact_scan`**；`result` = `{ok, count, facts: [{journal_type, fact_id, sha256_digest}]}`（原 `surface` 数组改名 `facts`；**三元组字段名保持不变**）；语义注记改为"枚举本 run 可被引用的事实索引" |
| 2 | `methods.atf_gate.result` | `status` 枚举 `pass \| blocked` → **`pass \| warn \| blocked`**；新增 `reason_codes?: string[]`、`requires_human_review?: boolean`、`evidence?: string[]`；保留 `reason?` / `missing?` 为兼容字段并注明"建议由 `reason_codes` 派生" |
| 3 | `methods.atf_gate.params` | 增注**命名分流**规则：`^G[1-4]$`（大小写不敏感、内部归一化）→ 数据准入闸；其余必须命中七组完整性 GateId；都不命中 → `unknown_gate`（fail-closed） |
| 4 | `methods.ledger_query` | 改用内核审批链键模型：`params = {scope_ref{project_id, scope_type, scope_id, scope_mode}, operation_id?, state?, include_consumed?}` → `result = {ok, records:[{record_id, approval_id, sequence, state, command_id?, actor?, operation_id?, attempt_id?, evidence_refs?}]}`；默认只返回可消费记录 |
| 5 | `methods.ledger_consume` | `params = {approval_ref, record_id}` → `result = {ok, record_id, state:"consumed"}`；错误码登记 `approval_already_consumed` / `approval_record_mismatch` / `not_found` |
| 6 | `methods.ledger_*` 注记 | 明确 **`{tool, params_digest, consumed}` 配额式键不再是账本键**；该信息若仍需保留，由本仓自行维护映射（不进内核账本） |
| 7 | `methods.atf_admit_data` | `params.source?` → **`source_ref?`**（可校验引用）；`result` 明示三元组来源：`journal_type: "dataset-registry"` / `fact_id: "<dataset_id>@<pin>"` / `sha256_digest` = 数据集登记记录的 canonical digest |
| 8 | `methods.atf_workspace_status.result` | 增补 **`scope_ref: {project_id, scope_type, scope_id, scope_mode}`**（供 `ledger_query` 定位） |
| 9 | 契约头部 | **`contract_version: 1 → 2`**；在注记中登记本次变更清单与"双侧同步 bump"要求 |
| 10 | 仓内文档 | `AGENTS.md` 与相关 ADR 中"严格 4 工具面"的方法名同步（`atf_surface_scan` → `atf_fact_scan`）；不改条款语义，仅改名与新增字段 |

---

## 3. 同步面（必须与契约一致，否则契约测试即红）

1. **工具定义**：`TOOL_DEFINITIONS` 中 4 个工具的方法名与 canonical output schema；
2. **`SurfaceScanResolver`**：改名后的方法调用与 `facts` 字段解析（`lookupDigest` 逻辑不变，仅字段名）；
3. **账本轨实现与 mock 对端**：由 `{tool, params_digest}` 查询/消费改为 `scope_ref(+operation_id)` 查询 + `{approval_ref, record_id}` 消费；MockLedger 需重做为审批链形态；
4. **场景脚本**：引用旧方法名/旧字段处（如 `scenarios/*.json` 中的 `atf_surface_scan`、`gate` 结果断言中的两档 `status`）；
5. **测试**：既有用例中涉及上述四处的断言；
6. **契约测试**：`bridge.contract.yaml` 版本与 canonical output 校验路径。

---

## 4. 验收标准

1. 本仓全量测试**零回归**（当前基线 `186 passed / 2 skipped`，26 文件）；
2. 契约测试通过：对 `ATF_CLI_PATH`（pin `v0.2.0b7` 只读副本）仅跑 **pin 校验 + `--help` 冒烟**（对端仍为 mock，真实会话断言待 re-pin）；mock 路径全量断言通过；
3. 契约文件自检：`contract_version: 2`；方法面共 **6 个方法**（`atf.version` + 4 工具 + 2 账本，其中工具名含 `atf_fact_scan`）；`atf_upstream` pin **仍为 `v0.2.0b7`**；
4. 改名完整性：仓内 `grep -r "atf_surface_scan"` **零命中**（除历史 CHANGELOG/docs 归档处的时代说明，如有须显式注明）；
5. 变更描述与 PR 说明包含**双侧同步 bump** 要求（内核侧批次二按契约 v2 实现，届时同步其 `SESSION_CONTRACT_VERSION`）。

---

## 5. 执行序列

1. 阅读《批次二规格（定稿）》§2（六方法规格）与本指令；冲突以本指令为准并报告差异；
2. BUILD：契约 v2 + 同步面 1–6；
3. VERIFY：§4 五项，附全量测试输出与契约测试输出；
4. 产出《契约修订 v2 执行报告》（变更清单对照 / 同步面证据 / 验收对照 / 提交清单）；
5. **本地提交，不 push**（推送待 owner 授权）；完成后停在报告，**不启动 Phase 3、不做 re-pin**。

---

## 6. 纪律条款

1. **只动本仓**；内核仓只读纪律不变，pin 不动。
2. 契约变更按既定流程：显式 PR + 双仓契约测试 + owner review + 双侧同步 bump；**禁止悄悄改**。
3. 零 npm 运行时依赖（`dependencies` 恒空）；无 GPU / 无真实 Provider。
4. 本工作包完成 = 批次二的内核侧任务书可签发（两件事严格串行：契约 v2 落定 → 内核实现）。
