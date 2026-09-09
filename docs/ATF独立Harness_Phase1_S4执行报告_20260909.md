# ATF 独立 Harness — Phase 1 / S4 三层工作区与晋升闸 A 任务执行报告

> 日期：2026-09-09 ｜ 执行方：zcode（本仓唯一开发 agent）｜ 报告对象：owner
> 执行依据：《ATF-Harness_Owner决议与启动指令_S3闭合_S4启动_20260909.md》（§1 闭合决议 + §2 执行序列 + §3 owner 口径 #1–#6）+《ATF独立Harness_Phase1任务书_20260908.md》§4（S4）
> 结论：**S3 已按决议闭合 push（tip `2526532`）；S4 全部验收用例通过，本轮产出本地提交未 push，停在 S5 前；S5 未获指令不得启动。**

---

## 0. 结论摘要

1. **执行 1（S3 闭合）**：push 前复跑全量 76 passed / 2 skipped 一致（`ATF_CLI_PATH` 指向 pin 副本）→ `cb94fd7` + `2526532` 推送 origin/main（`b68539c..2526532`）→ **push 后 tip = `2526532`**。
2. **执行 2/3（S4 BUILD + VERIFY）**：`src/workspace/` 按任务书 §4 完成——run 目录结构 v0（scratch/artifacts/contracts + session.jsonl 约定路径）、provenance 四元组自动生成、晋升闸 A 三闸校验器（幂等 already_promoted / 可复现 not_reproducible / sha 指纹 catalog.json 登记）、铁律一以 GuardedSessionLog 包装扩展接入（`t0_ref_forbidden`，**src/session/ 零改动**）。新契约 `workspace.contract.yaml` 登记（contract_version 1，owner 口径 #6 授权二选一）。
3. 验证：typecheck 0 error；全量 **95 passed / 2 skipped**（12 文件：S1 26+2、S2 30、S3 20 **零回归**，S4 新增 19）；`smoke:s1/s2/s3/s4` 四条手工冒烟全过 exit 0；pin 副本 HEAD = `a628f8b`（v0.2.0b7）干净，内核仓零改动。
4. §5 登记自主决策 7 项（均在 owner 口径授权范围内），供 review 知悉；**重点请审决策点 3（复现语义具体化）与 4（铁律一接线形态选择）**。无阻塞待决项。

## 1. S3 闭合决议执行对照（指令 §1/§2 执行 1）

| 决议 | 执行 |
|---|---|
| 报告 §5 决策点 ①–⑥ 全部同意为正式口径 | 已作为既定口径；本 slice 未触碰 S3 工具层代码与 `bridge.contract.yaml`（S3 测试 20 用例全绿佐证零回归） |
| 批准 push `cb94fd7` + `2526532` | ✓ push 前复跑全量 76 passed / 2 skipped（含 pin 副本契约测试）；`git push origin main` 一次成功 `b68539c..2526532 main -> main`；**tip = `2526532205212b5a34d3d93859d4444f4b43488f`** |

## 2. S4 owner 口径执行对照（指令 §3）

| # | 口径 | 执行结果 |
|---|---|---|
| 1 | run 目录宿主 = harness 仓测试工作区，不在内核仓物理写入；语义对齐 = 目录形状与命名沿用内核惯例 | ✓ 宿主定为 `<repo>/tmp/runs/<run_id>/`（`tmp/` 已 gitignore）；库本身不内置路径策略，根路径由调用方注入（与 session.contract.yaml persistence.path 同口径）；目录形状 = 任务书 §4.1 登记的 `runs/<run_id>/{scratch,artifacts}`。内核仓零写入（pin 副本 status 0 条佐证） |
| 2 | 冒烟 `model_id = "faux"`；`trigger_instruction` / `run_id` 本 slice 由测试/冒烟直接给定 | ✓ provenance 四元组由调用方注入；tests/smoke 全部显式给定 `model_id: "faux"` + 显式 trigger_instruction/run_id |
| 3 | 复现命令由 harness 侧子进程执行（mock/脚本产物），不调用真实内核；命令登记于产物元数据，校验器只执行 + 比对 hash | ✓ `promoteArtifact`：复现命令登记于 sidecar `<path>.meta.json`（`registerReproduce` 一次性登记）；执行 = `child_process.spawn` argv 形态（无 shell，cwd = run 根），测试/冒烟用 `node -e` 脚本产物；校验器只执行 + 比对 stdout 字节 sha256。全程零内核调用 |
| 4 | 铁律一 = 扩展 S2 domain_refs 校验；以扩展方式接入，不修改 src/session/ 既有语义 | ✓ **判定为无需改 S2 代码**。接线形态 = `GuardedSessionLog` 包装 SessionLog（append 前置校验 + replay 后置扫描），拒绝形态 = 首类结构化 block `{reason: "t0_ref_forbidden", invalid_refs}`，cause 已登记 workspace.contract.yaml。`src/session/`、`src/bridge/`、`src/tools/` 零改动（git status 佐证）。选择依据见 §5 决策点 4 |
| 5 | T2 contracts 层只读展示，晋升闸 B 不实现 | ✓ `RunWorkspace` 仅创建 contracts/ 目录并在 `status()` 返回 `{exists, entry_count}`；全库无任何对 contracts/ 的写入路径；晋升闸 B 未实现（任务书 §7 顺延项不变） |
| 6 | Artifact Catalog 用 harness 侧 JSON 清单（`artifacts/catalog.json`）；格式登记新建 workspace.contract.yaml 或并入 session.contract.yaml 由实现方定 | ✓ 新建 `workspace.contract.yaml` 承载（沿用 S2 分文件登记先例，contract_version 1）；catalog.json 读写严格校验（schema_version 恒 0 / digest pattern / artifact_id 唯一），写入走临时文件 + rename |

## 3. 设计要求与验收对照（任务书 §4）

### 3.1 设计要求 4 项

| # | 要求 | 实现 |
|---|---|---|
| 1 | run 目录结构 v0 | `src/workspace/runWorkspace.ts`：`RunWorkspace.create()` 建立 `scratch/`（T0）、`artifacts/`（T1 不可变）、`contracts/`（T2 只读）三层目录；`sessionLogPath` 落地 session.contract.yaml 的 `runs/<run_id>/session.jsonl` 默认约定（按需创建，不预创建） |
| 2 | scratch 自动生成 provenance.json 四元组 | `ensureProvenance()`：创建时自动落盘 `{run_id, trigger_instruction, model_id, created_at}`；重开语义 = 四元组逐字段比对（created_at 以既有为准），不一致/形状非法 = `err(provenance_conflict)`（fail-closed） |
| 3 | 晋升闸 A 三项任一失败 → block | `src/workspace/promote.ts`：`promoteArtifact()` 输入守卫 → catalog 校验 → 幂等闸（`blocked(already_promoted)`，已有 Artifact 一律不覆盖）→ 可复现闸（sidecar 登记命令子进程重跑一次，stdout hash 不一致或 exit≠0 → `blocked(not_reproducible)`）→ sha 指纹（入 artifacts 时计算并登记 catalog）。基础设施故障（IO/spawn/超时/stdout 超限/清单损坏）≠ 闸门裁决 → err，不猜测 |
| 4 | 铁律一：scratch 路径引用 → domain_refs 校验直接拒绝 | `src/workspace/t0Guard.ts`：`GuardedSessionLog` 包装 SessionLog——append 前置扫描命中 scratch/ 前缀 → `rejected(t0_ref_forbidden)` 事件不落盘；replay 重建后逐事件扫描 → `blocked`（流不可信，文件只读不改写）。未命中原样委托 S2（digest 校验语义零改动，对照用例佐证） |

### 3.2 验收 3 条

| 验收项 | 用例 | 结果 |
|---|---|---|
| 晋升正例 | T0 分析产物 → promote → artifacts 出现 + sha 登记 → 二次 promote → 幂等拒绝 | ✓ `tests/workspace/promote.test.ts`（产物字节落位 + catalog sha256 与文件字节吻合 + 二次 blocked(already_promoted) + 产物/catalog 不变）+ smoke:s4 步骤 2–3 |
| 复现反例 | 产物内容在两次执行间变化 → 可复现校验失败 → block | ✓ 同文件（`--` 波动内容 vs `Date.now()` 输出 → `blocked(not_reproducible)`，artifacts 与 catalog 零写入）+ 退出码非 0 → 同判 + smoke:s4 步骤 4 |
| 引用反例 | 事件 domain_refs 指向 scratch 文件 → 校验拒绝 | ✓ `tests/workspace/t0Guard.test.ts`（append → `rejected(t0_ref_forbidden)` 事件不落盘；绝对路径/嵌套前缀命中；replay 流内混入 → blocked）+ smoke:s4 步骤 5 |

### 3.3 补充语义测试

- **登记/文件失配 fail-closed**：catalog 已登记但产物被删 → `err(corrupt_catalog)`；artifacts/ 存在未登记同名文件 → 同判（不覆盖不吸收）。
- **复现基础设施故障**：spawn ENOENT / 超时（可注入超时覆盖）/ stdout 超限（10 MiB 防御常量）→ `err(reproduce_failure)`（≠ 闸门裁决，不猜测可复现性）。
- **输入守卫**：路径越界（`../`）、绝对路径、sidecar 缺失、sidecar 与源不符（手写篡改场景）→ `err(invalid_input)`；sidecar 登记一次性拒绝覆盖。
- **S2 语义对照**：GuardedSessionLog 下非 scratch 引用照常走 S2——digest 命中干净落盘、失配 `appended_blocked(ref_invalid)` 留痕；同一份含 T0 引用的流，未包装的 S2 replay 仅报 ref_invalid（对照组证明扩展为增量、非修改）。
- **T2 只读**：status.contracts 恒 `{exists: true, entry_count: 0}`（harness 无写入路径）。

## 4. 执行记录（指令 §2 序列）

1. **执行 1**：pin 副本 HEAD 校验（= `a628f8b`，v0.2.0b7，工作区干净）→ 复跑全量 76 passed / 2 skipped → push `b68539c..2526532`（一次成功）→ tip `2526532`。
2. **执行 2**：`workspace.contract.yaml` 登记 → `src/workspace/` 8 个模块 → `tests/workspace/` 19 用例 → `smoke:s4`（script + .gitignore tmp/）。
3. **执行 3**：typecheck ✓；全量 95 passed / 2 skipped ✓（S1/S2/S3 零回归）；`smoke:s1/s2/s3/s4` 四条全过 exit 0 ✓（verify 期间修正两处：`WorkspaceErrorCode` 补 `io_error` 枚举（契约已登记漏实现）；status.file_count 排除 catalog.json 本身（登记簿非产物）——均为 S4 新代码内部修正，不涉既有层）。
4. **执行 4**：本报告；**提交本地保存，不 push**（沿用纪律，等 owner review 后决议）。

## 5. 偏离与自主决策点（均在授权范围内，供 owner review 知悉）

1. **run 目录宿主 = `tmp/runs/`**（口径 #1 给定的二选一）：运行时产物与测试目录分离（`tests/fixtures/` 留给入库夹具），`tmp/` 已 gitignore；库不内置路径策略，宿主路径由调用方注入并登记契约。
2. **新建 `workspace.contract.yaml`**（口径 #6 给定的二选一）：沿用 S2 分文件登记先例；`contract_version: 1` 起步；bridge/session 契约零改动。
3. **复现语义具体化**（口径 #3 未尽的形态细节）：① sidecar 形态 = `<产物路径>.meta.json`，内容 `{artifact, reproduce:{command[]}, registered_at}`，登记一次性拒绝覆盖；② 复现 = 子进程执行恰好一次，**stdout 字节 sha256 与源产物字节比对**（不采用"命令回写文件再比对"形态，避免复现动作变异 T0 源）；③ 命令 exit≠0 → `blocked(not_reproducible)`（闸门裁决），spawn 失败/超时（30s，可注入）/stdout 超限（10 MiB）→ `err(reproduce_failure)`（基础设施故障≠裁决，不猜测）；cwd = run 根。
4. **铁律一接线形态 = 包装 SessionLog 入口，而非经 DigestResolver 通道**（口径 #4"新增规则注入或包装校验器"之包装形态，判定为**无需改 S2 代码**）：S2 `checkRefs` 会把 resolver err 统一包装为 `resolver_failure`（基础设施故障语义）且 ref_invalid cause 枚举固定（`digest_mismatch | fact_not_found`）——策略拒绝经该通道会被错误标注、归因深埋、无法承载 `t0_ref_forbidden`。`GuardedSessionLog`（append 前置校验 + replay 后置扫描）是唯一不改 src/session/、又不复用/污染既有语义的扩展点；拒绝形态为首类结构化 block `{reason: "t0_ref_forbidden", invalid_refs: [{index, journal_type, fact_id}]}`。**规则作用于全部携带 domain_refs 的事件类型**（任务书 §4.4 以 tool/result 为叙事场景，本实现取更严方向——fail-closed 同哲学；S5 B4 断言口径不受影响）。
5. **晋升写入顺序与回滚**：先写产物文件、后写 catalog（临时文件 + rename）；catalog 写失败回滚刚写的产物文件，回滚自身失败则如实报错不静默（不静默留不一致）。
6. **provenance 重开语义与 T0 覆盖语义**：同 run 重开须四元组逐字段一致（created_at 以既有为准）否则 `err(provenance_conflict)`；`scratchWrite` 允许同路径覆盖（T0 为晋升前自由区，不可变语义由 T1 晋升闸承载）。
7. **`status().artifacts.file_count` 不含 catalog.json 本身**（登记簿非产物）；`status()` 读到损坏 catalog = err（不带病报告）。

无与任务书/指令冲突的偏离；`src/session/`、`src/bridge/`、`src/tools/`、`bridge.contract.yaml`、`session.contract.yaml`、`tests/fixtures/mock_atf.mjs` **零改动**（git status 仅新增 workspace 相关文件 + package.json/.gitignore 两处计划内小改）。

## 6. 验证记录（VERIFY）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✓ 0 error |
| 全量测试 | `ATF_CLI_PATH=<本仓>/.atf-pinned npx vitest run` | ✓ **12 文件：95 passed / 2 skipped**（S1 26+2 零回归；S2 30 零回归；S3 20 零回归；S4 新增 19） |
| pin 校验 | `.atf-pinned` HEAD = `a628f8b8e23beff104b42b5c80088416ea78b394`（v0.2.0b7），`git status` 0 条 | ✓ 一致、干净，未追新；内核仓零改动 |
| 手工冒烟 | `npm run smoke:s1 -- --mock` / `smoke:s2` / `smoke:s3` / `smoke:s4` | ✓ 四条全过，真实退出码均 = 0 |
| S3 闭合 push | `git push origin main` | ✓ `b68539c..2526532`，tip = `2526532` |
| 内核仓改动 | — | 零改动 |

## 7. 改动文件清单

新增（契约）：
- `workspace.contract.yaml` — 三层工作区与晋升闸 A 契约（run 目录 v0 / provenance / Artifact Catalog / 晋升闸 A 三闸与 outcome/error 枚举 / 铁律一 t0_ref_forbidden / T2 只读边界）

新增（实现）：
- `src/workspace/errors.ts` — `WorkspaceError`（invalid_input / provenance_conflict / corrupt_catalog / reproduce_failure / io_error）+ `PromoteBlock`（already_promoted / not_reproducible）+ `PromoteOutcome`
- `src/workspace/catalog.ts` — Artifact Catalog 读写与严格校验（临时文件 + rename 原子写）
- `src/workspace/runWorkspace.ts` — RunWorkspace（三层目录创建 / provenance 四元组 / scratchWrite 路径守卫 / registerReproduce sidecar / status T2 只读清点）
- `src/workspace/promote.ts` — 晋升闸 A（幂等 / 可复现 / sha 指纹；子进程复现执行；一致性 fail-closed 与回滚）
- `src/workspace/t0Guard.ts` — 铁律一（`GuardedSessionLog` 包装 / `isScratchReference` 判定 / `T0RefBlock` / `T0_REF_FORBIDDEN`）
- `src/workspace/index.ts` — 工作区层公开出口
- `src/workspace/smoke.ts` — S4 手工冒烟命令

新增（测试）：
- `tests/workspace/runWorkspace.test.ts`（6 用例：结构 v0 / provenance 重开语义 / scratch 守卫 / sidecar 登记 / T2 status）
- `tests/workspace/promote.test.ts`（8 用例：验收正例+复现反例+失配 fail-closed+输入守卫+超时）
- `tests/workspace/t0Guard.test.ts`（5 用例：验收引用反例+判定面+S2 零改动对照+replay 铁律一）

修改（计划内）：
- `package.json` — 仅新增 `smoke:s4` script（`dependencies` 保持不存在）
- `.gitignore` — 仅新增 `tmp/`（run 目录宿主，owner 口径 #1）

## 8. 下一步建议

1. owner review 本报告，重点 §5 决策点 3（复现语义具体化）与 4（铁律一接线形态选择——GuardedSessionLog 包装而非 resolver 通道）。
2. review 通过后决议 S4 产出的 push 与 S5 启动。
3. S5（Faux provider 冒烟闭环）**未获指令不启动**——本会话按指令停在此处。S5 落地时：B4 分支直接消费 `GuardedSessionLog` 的 `t0_ref_forbidden` 结构化 block；provenance 的 `trigger_instruction`/`run_id` 切换为场景脚本注入；runner 退出码经由 S3 `resolveHeadlessExitCode()` 决出。
