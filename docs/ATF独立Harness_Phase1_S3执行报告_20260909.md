# ATF 独立 Harness — Phase 1 / S3 工具层 任务执行报告

> 【时代说明（2026-09-13 契约 v2 修订）】本文为历史存档：文中"严格 4 工具面"的 `atf_surface_scan` 为 v1 时名，自契约 v2 起改名 `atf_fact_scan`（数组字段 `surface` → `facts`），现行登记见 `bridge.contract.yaml` v2。

> 日期：2026-09-09 ｜ 执行方：zcode（本仓唯一开发 agent）｜ 报告对象：owner
> 执行依据：《ATF-Harness_Owner决议与启动指令_S2闭合_S3启动_20260909.md》（§1 闭合决议 + §2 执行序列 + §3 owner 口径 #1–#5）+《ATF独立Harness_Phase1任务书_20260908.md》§3（S3）
> 结论：**S2 已按决议闭合 push（tip `b68539c`）；S3 全部验收用例通过，本轮产出本地提交未 push，停在 S4 前；S4 未获指令不得启动。**

---

## 0. 结论摘要

1. **执行 1（S2 闭合）**：push 前复跑全量 56 passed / 2 skipped 一致 → `80386f6` + `b68539c` 推送 origin/main（首次因 GitHub HTTPS 连接超时失败，重试成功）→ **push 后 tip `b68539c`**。
2. **执行 2/3（S3 BUILD + VERIFY）**：`src/tools/` 按任务书 §3 完成——严格 4 个 ToolDefinition（模型可见 schema 白名单 + canonical output 声明 + 逐次校验）、账本轨审批（ledger 经桥接查询/消费，一次性语义在对端强制，无任何自动应答路径）、`approval_missing` → 结构化 block + headless exit 78 锚点。工具方法与 MockLedger 均由契约 mock 对端承载（owner 口径 #1）。
3. `bridge.contract.yaml` 完成任务书 §8.2 计划内方法面登记（4 工具 + 3 ledger 方法签名与 canonical schema），**contract_version 维持 1**（owner 口径 #2）；S1/S2 既有语义零改动。
4. 验证：typecheck 0 error；全量 **76 passed / 2 skipped**（S1 26+2、S2 30 **零回归**，S3 新增 20 passed）；`smoke:s1` / `smoke:s2` / `smoke:s3` 三条手工冒烟全过；pin 副本 HEAD 与 `v0.2.0b7 (a628f8b)` 一致，内核仓零改动。
5. §5 登记自主决策 6 项（均在 owner 口径授权范围内），供 review 知悉；无阻塞待决项。

## 1. S2 闭合决议执行对照（指令 §1）

| 决议 | 执行 |
|---|---|
| 报告 §5 决策点 ①–④ 全部同意为正式口径 | 已作为既定口径，本 slice 未触碰 `session.contract.yaml` 与 S2 代码（S2 测试全绿佐证零回归） |
| 批准 push `80386f6` + `b68539c` | ✓ push 前复跑全量 56 passed / 2 skipped；push 成功 `e8327b4..b68539c main -> main`；**tip = `b68539c`** |

## 2. S3 owner 口径执行对照（指令 §3）

| # | 口径 | 执行结果 |
|---|---|---|
| 1 | 4 工具方法 + ledger 查询/消费均由契约 mock 对端承载；`MockLedger` 支持预录/查询/消费/一次性语义；真实对端待 re-pin 后接入 | ✓ `tests/fixtures/mock_atf.mjs` 扩展：`atf_admit_data` / `atf_gate` / `atf_surface_scan` / `atf_workspace_status` 四方法返回 canonical output；进程内 MockLedger 承载 `ledger_record`（预录）/`ledger_query`（查询）/`ledger_consume`（消费，重复消费 = `ok:false/already_consumed`，一次性语义在对端强制）。与 S1 会话协议、S2 DigestResolver 同口径 |
| 2 | `bridge.contract.yaml` methods 段登记签名与 canonical schema；contract_version 维持 1 不 bump | ✓ 4 工具 + `ledger_query`/`ledger_consume`/`ledger_record`（注明非运行时方法面）登记完毕；`contract_version: 1` 未动；帧格式/握手 schema/既有方法语义零变更 |
| 3 | `approval_missing` 由 harness 主进程 exit 78 终止；本阶段由 mock 承载并写入契约 | ✓ `ToolBlock.exit_code: 78` + `resolveHeadlessExitCode()` 单一出口（S5 runner 的进程退出码必经此函数决出，防语义漂移）；exit 78 语义已写入契约 methods 段头注 |
| 4 | canonical 校验失败 → `err(schema_violation)`，结构化回填，不猜测成功 | ✓ `validateCanonicalOutput` 折算 `failed(schema_violation)`（`--corrupt-output` 反例验证）；对端业务拒绝（ok=false）→ `rejected` 结构化回填（`reason` + `detail`），供 Faux 断言失败路径 |
| 5 | 严格 4 个工具；模型可见 schema 白名单，timeout 等内部字段一律不发 | ✓ `ToolRegistry.createDefault()` 固定 4 工具、不暴露注册入口；`toModelVisible` 白名单投影仅 `{name, description, parameters}`——序列化断言不含 `timeout/canonical_output/requires_approval/method/connection/execute/ledger` |

## 3. 设计要求与验收对照（任务书 §3）

### 3.1 设计要求 4 项

| # | 要求 | 实现 |
|---|---|---|
| 1 | 只注册 4 个工具 | `src/tools/toolDefinition.ts`：`atf_admit_data` / `atf_gate` / `atf_surface_scan` / `atf_workspace_status`；registry 构造固定，`unknown_tool` 拒绝面外调用 |
| 2 | ToolDefinition = 模型可见 schema（白名单）+ execute（经 S1 桥接）+ canonical output 声明（逐次校验，失败 = err） | `toolDefinition.ts` + `executor.ts`：所有方法响应（含 ledger 方法自身）逐次过 canonical 校验；零依赖校验器方言（type/const/enum/required/properties/items/pattern，`properties` 即白名单——未声明字段拒绝，防对端泄漏内部字段） |
| 3 | 调用前查 approval ledger（经桥接，不直读文件）——命中未消费 → 执行并消费；未命中 → 结构化 block（`approval_missing`）；无自动应答 | `executor.ts approve()`：`ledger_query`（审批键 = tool + params_digest）→ 无未消费记录 → `blocked`；命中 → `ledger_consume` → 消费失败（一次性冲突）同样 `blocked`；审批键 digest 算法（stable stringify + sha256 小写 hex）在契约登记、双侧同构、锚点断言防漂移 |
| 4 | 工具结果错误结构化回填（供 Faux 断言失败路径） | 四终态穷尽互斥：`executed`（canonical 通过）/ `blocked`（审批轨）/ `rejected`（对端业务拒绝）/ `failed`（harness/桥接故障与 schema 违规）；execute 永不抛出 |

### 3.2 验收 3 条

| 验收项 | 用例 | 结果 |
|---|---|---|
| 成功 | 账本预录 → `atf_admit_data` executed（canonical 校验通过，fact + digest 产出）→ ledger 查询 `consumed=true` → 重复调用同 request → `blocked(approval_missing)` | ✓ `tests/tools/executor.test.ts` |
| 反例 1 | 无预录 → `blocked(approval_missing)`、`exit_code=78`、`resolveHeadlessExitCode = 78`；`smoke:s3` 端到端同样断言 `exit=78` 锚点 | ✓ 同上 + `src/tools/smoke.ts` |
| schema | 4 个 ToolDefinition 模型可见投影序列化后不含 `timeout` 等任何内部字段；canonical 校验器方言正反用例 11 项 | ✓ `tests/tools/definition.test.ts` |

### 3.3 补充语义测试

- `atf_gate` 业务信号：无证据 advance → canonical 内 `status: blocked / reason: evidence_missing`（合法产出，与审批 block 严格区分）；准入证据后 → `pass`。
- `--reject-method` 注入对端业务拒绝 → `rejected` 结构化回填（`reason=gate_rejected`），exit 锚点 = 1。
- 参数白名单：缺 required / 多余字段 → `failed(schema_violation)`，不触桥接。
- 桥接故障 fail-closed：连接不可用 → `failed(bridge_failure)`；须审批工具在 `ledger_query` 故障时同样 `failed`（无法确认授权状态，不猜测审批通过）。
- 审批键算法：键序无关、数组序敏感、与手工 stable-stringify + sha256 锚点一致。

## 4. 执行记录（指令 §2 序列）

1. **执行 1**：复跑全量（56 passed / 2 skipped）→ `git push origin main`（首次 `SSL_read Connection timed out` 失败，重试成功）→ tip `b68539c`，与远程同步。
2. **执行 2**：契约登记 → mock 对端扩展 → `src/tools/` 8 个模块 → `tests/tools/` 20 用例 → `smoke:s3`。
3. **执行 3**：typecheck ✓；全量 76 passed / 2 skipped ✓（S1/S2 零回归）；`smoke:s1/s2/s3` ✓（其中 smoke:s3 首跑暴露脚本自身漏预录 gate 审批，修正脚本后全过——实现层无改动）。
4. **执行 4**：本报告；**提交本地保存，不 push**（沿用纪律，等 owner review 后决议）。

## 5. 偏离与自主决策点（均在授权范围内，供 owner review 知悉）

1. **审批要求按工具分流**：`atf_admit_data`（写动作）与 `atf_gate`（闸门推进）须账本预录；`atf_surface_scan` / `atf_workspace_status`（只读）免审批。任务书 §3.3 未逐工具明说，按动作性质与 S5 场景叙事（B1 仅 admit_data 标注预录、读状态在先）推定；`requires_approval` 为 ToolDefinition 显式字段，可逐条 review。
2. **`ledger_record` 作为 mock setup 基建方法**：预录须经对端注入，契约登记时注明"非运行时方法面"——运行时面 = query/consume 两个。
3. **审批键 digest 算法写入契约**：`params_digest = sha256(stableStringify(params))`（键序递归排序、小写 hex）——审批绑定的 sha 语义在 mock 阶段的承载，双侧同构 + 测试锚点，防算法漂移。
4. **canonical 校验器为零依赖方言**（R2a 禁 npm 运行时依赖，不引 ajv）：能力面恰为契约所需七种约束；`properties` 即白名单（未声明字段一律拒绝）——比标准 JSON Schema 默认更严，属有意 fail-closed。
5. **headless 退出码锚点收敛为 `resolveHeadlessExitCode()` 单一出口**：`executed→0`、`blocked→78`、`rejected/failed→1`，S5 runner 必须经由它决出进程退出码（ADR-07 退出码细则的 S3 承载）。
6. **mock 对端扩展保持 S1 行为不变**：S1 全部旗标语义与既有响应零改动（S1 测试 26+2 全绿佐证）；新增 `--corrupt-output` / `--reject-method` 两个反例注入旗标。

无与任务书/指令冲突的偏离；S2 层代码与 `session.contract.yaml` 零改动。

## 6. 验证记录（VERIFY）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✓ 0 error |
| 全量测试 | `ATF_CLI_PATH=<本仓>/.atf-pinned npx vitest run` | ✓ **9 文件：76 passed / 2 skipped**（S1 26+2 零回归；S2 30 零回归；S3 新增 20） |
| pin 校验 | `.atf-pinned` HEAD = `a628f8b8e23beff104b42b5c80088416ea78b394`（v0.2.0b7） | ✓ 一致，未追新 |
| 手工冒烟 | `npm run smoke:s1 -- --mock` / `npm run smoke:s2` / `npm run smoke:s3` | ✓ 三条全过 exit 0 |
| S2 闭合 push | `git push origin main` | ✓ `e8327b4..b68539c`（首次网络超时，重试成功） |
| 内核仓改动 | — | 零改动 |

## 7. 改动文件清单

新增（实现）：
- `src/tools/canonical.ts` — 零依赖 canonical 校验器方言（type/const/enum/required/properties/items/pattern；properties 即白名单）
- `src/tools/errors.ts` — `ToolError`（schema_violation / unknown_tool / bridge_failure）+ `ToolBlock`（approval_missing，exit_code 78）
- `src/tools/approvalKey.ts` — 审批键 digest（stable stringify + sha256，契约同构）
- `src/tools/toolDefinition.ts` — 严格 4 工具完整定义 + `toModelVisible` 白名单投影
- `src/tools/registry.ts` — 固定注册表（不暴露注册入口）
- `src/tools/executor.ts` — 执行管线（审批轨 → 桥接 → canonical 校验）+ 四终态 + `resolveHeadlessExitCode` 锚点
- `src/tools/smoke.ts` — S3 手工冒烟命令
- `src/tools/index.ts` — 工具层公开出口

修改：
- `bridge.contract.yaml` — methods 段登记 4 工具 + 3 ledger 方法（计划内变更，contract_version 维持 1；exit 78 / digest 算法语义登记）
- `tests/fixtures/mock_atf.mjs` — 四工具 canonical 响应 + MockLedger 三方法 + `--corrupt-output` / `--reject-method` 注入旗标（S1 行为零改动）
- `package.json` — 仅新增 `smoke:s3` script（`dependencies` 保持不存在）

新增（测试）：
- `tests/tools/executor.test.ts`（9 用例：验收成功/反例 1 + 补充语义）、`tests/tools/definition.test.ts`（11 用例：验收 schema + canonical 方言 + digest 锚点）

## 8. 下一步建议

1. owner review 本报告，重点 §5 决策点 1（requires_approval 分流）与 4（canonical 白名单拒绝额外字段）。
2. review 通过后决议 S3 产出的 push 与否。
3. S4（三层工作区 + 晋升闸 A）**未获指令不启动**——本会话按指令停在此处。
