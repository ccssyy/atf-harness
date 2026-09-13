# Owner 决议与启动指令：S3 闭合（push 授权）+ Phase 1 / S4 启动

> 【时代说明（2026-09-13 契约 v2 修订）】本文为历史存档：文中"严格 4 工具面"的 `atf_surface_scan` 为 v1 时名，自契约 v2 起改名 `atf_fact_scan`（数组字段 `surface` → `facts`），现行登记见 `bridge.contract.yaml` v2。

> 日期：2026-09-09 ｜ 签发：owner ｜ 执行方：zcode
> 依据：《ATF独立Harness_Phase1_S3执行报告_20260909.md》+ owner review（独立核验通过：76 passed / 2 skipped 复跑一致、改动范围仅计划内文件、pin a628f8b 干净、smoke:s3 exit 0、executor.ts 抽审达标）。
> 结论先行：**S3 审查通过。决议：报告 §5 决策点 ①–⑥ 全部同意为正式口径；批准 push；S4 现在启动。S4 完成即停，S5 未获指令不得启动。**

---

## 1. S3 闭合决议

报告 §5 六项自主决策全部批准为正式口径：
1. `requires_approval` 分流：`atf_admit_data` / `atf_gate` 须账本审批，`atf_surface_scan` / `atf_workspace_status` 只读免审批；
2. `ledger_record` 为 mock setup 基建方法，非运行时方法面（运行时面 = query / consume）；
3. 审批键 digest 算法（stable stringify + sha256 小写 hex）作为契约登记，双侧同构 + 锚点测试；
4. canonical 校验器为零依赖方言，`properties` 即白名单（未声明字段一律拒绝）；
5. headless 退出码锚点收敛 `resolveHeadlessExitCode()` 单一出口（executed→0 / blocked→78 / rejected·failed→1），S5 runner 必须经由它决出；
6. mock 对端扩展保持 S1 行为零改动。

批准 push：`cb94fd7`（feat tools）+ `2526532`（S3 执行报告）推送到 `origin/main`。

## 2. 执行序列

1. **执行 1（S3 闭合 push）**：push 前重跑全量测试（含 `ATF_CLI_PATH` 指向 pin 副本），确认 76 passed / 2 skipped 方可推送；记录 push 后 tip hash；
2. **执行 2（S4 BUILD）**：按任务书 §4 实现 `src/workspace/`（run 目录结构 v0 + provenance 四元组 + 晋升闸 A 校验器 + 铁律一接线），并按第 3 节口径执行；
3. **执行 3（S4 VERIFY）**：任务书 §4 三条验收用例 + 全量测试（S1 26+2、S2 30、S3 20 不得回归）+ typecheck + 手工冒烟；
4. **执行 4（S4 报告）**：产出《Phase1_S4执行报告_20260909.md》；**提交本地保存，不 push**，等 owner review 后决议。

## 3. S4 owner 预先拍板的口径（实现时直接采用，无需再问）

| # | 事项 | 口径 |
|---|---|---|
| 1 | run 目录的宿主 | run 目录结构 v0 落在 **harness 仓测试工作区**（如 `tests/fixtures/runs/` 或 `tmp/runs/`，由你按工程惯例定并登记契约），**不在内核仓 `runs/` 内实际写入**——内核仓只读纪律不变；"在 ATF 现有 run 目录内扩展"指语义对齐（目录形状与命名沿用内核惯例），非物理写入内核仓 |
| 2 | provenance 四元组的冒烟值 | 冒烟阶段 `model_id = "faux"`；`trigger_instruction` 与 `run_id` 由 S5 场景脚本注入，本 slice 由测试/冒烟直接给定 |
| 3 | 复现校验的执行方式 | 晋升闸 A 的"指定复现命令重跑一次"在本阶段由 **harness 侧子进程执行**（mock/脚本产物），不调用真实内核；复现命令本身登记于产物元数据，校验器只负责执行 + 比对 hash |
| 4 | 铁律一的接线点 | T0 不可引用 = 扩展 S2 `domain_refs` 校验：引用路径解析后落在 `scratch/` 前缀内 → 校验拒绝（结构化 block，cause 登记契约）。**S2 校验器代码以扩展方式接入（新增规则注入或包装校验器），不修改 `src/session/` 既有语义**；若判定必须改 S2 代码，停下提请 owner，不得先改 |
| 5 | T2 层边界 | 本阶段 contracts 层只读展示（目录存在 + 只读校验），晋升闸 B 不实现（任务书 §4.1 明示） |
| 6 | sha 指纹登记 | Artifact Catalog 本阶段用 harness 侧 JSON 清单承载（`artifacts/catalog.json`），格式登记 `session.contract.yaml` 或新建 `workspace.contract.yaml` 由你定（沿用 S2 分文件登记先例亦可） |

## 4. 纪律不变条款

内核仓只读；无 GPU、无真实 LLM Provider、无网络模型调用；零 npm 运行时依赖；pin 不自动升级（v0.2.0b7 / a628f8b）；S1/S2/S3 代码与既有契约语义零改动（铁律一注入点与契约新增登记除外，且须在报告中列明 diff）；S5 未获指令不得启动。
