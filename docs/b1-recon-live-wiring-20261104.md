# B1 门1侦察：vendor 件 live 装配三态表（2026-11-04 初版）

- 性质：ADR-0019 决定 4「侦察先行」的首轮产物（B0 任务书完成定义·端到端项）
- 证据源（全部只读，2026-11-04 实锚）：dev 实例 DSH_HOME `profiles/web/cordis.patch.yml`（174 行，17 处 @deepseek 插件引用；装配清单由 `deploy/profiles/web/generate.py` 生成，勿手改）；现役 dev 进程 cmdline（`node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 3080`，cwd＝vendor 仓）
- 方法：装配清单逐件比对 ADR-0019 决定 2 判定表 #1-#8；「不在显式面」的件标注深挖锚点，不做猜测

## 三态表（dev 实例）

| 判定表# | vendor 件 | 装配态 | 证据 | 收编含义 |
|---|---|---|---|---|
| #1 | interaction·permission presets | **在跑（清单形态）** | `approvalPolicy.preset: atf-training` ＋ `chainTools` 工具名清单（D170v2 步3 刚扩过裁决/准入免审） | 机制已在场。B2＝从「工具名清单」升级「按操作语义分档」（D170v2 原则4），配置/生成器改造，非新接线 |
| #5 | jobs 族 | **在跑** | preset-standard 内 `tool-jobs` 启用＋独立 `- id: jobs`（`@deepseek-ai/dsh-jobs-local`）装配 | 机制已在场。B3＝退役 scratch 轮询、ATF 编排面改用 job 工具（迁移使用面） |
| #7 | goal 族 | **在场禁用** | `tool-goal`／`command-goal` 均 `disabled: true` | B3＝启用＋语义边界配置（续跑不越停等确认卡，ADR-0019 决定 1） |
| — | plan 族 | 在跑 | preset-standard `planning` 组（plan-mode，isolate） | 判定表 #9 的 plan 面已在场，B5 只差 todo/deliverables 呈现接线 |
| #2/#3/#4 | compaction-tool-result-pruner／image-offload／spill | **不在 dev patch 显式面** | cordis.patch.yml 无对应插件条目 | 待 B1 深挖：锚点＝vendor `packages/preset`（dsh-agent-preset 默认集）与 app-boot 默认 bundle；确认「默认在跑」还是「需显式装配」 |
| #8 | schedule 族 | 不在 dev patch 显式面 | 同上 | 同上；有界收编红线不变（ADR-0019 决定 2） |
| #6 | guard 族 | 不在 dev patch 显式面 | 同上；src 存量 `core/run/noProgress*.ts` 为其自研 B 档对照 | 同上 |
| #9 | todo／deliverables／feedback／session-title | 不在 dev patch 显式面 | 同上 | B5 前补锚 |
| #10 | compaction-basic | 同上 | 窗口证据：同一份装配清单 providers 段 `contextWindow: 1048576`（GLM 1M，D78 死路径判断的直接配置面证据） | 不主动依赖（ADR-0019 决定 3） |

## 初步结论（修正 10-17 盘点的成本预估）

已锚三件（#1/#5/#7）全部「在场」——甲收口的大头不是接线工程，是**启用、配置升级与使用面迁移**。收编成本显著低于 10-17 盘点「按缺失接线」的预估。

## 待深挖清单（B1 门1 补锚，不阻塞 B0）

1. vendor `packages/preset`（dsh-agent-preset）默认插件集——确认 #2/#3/#4/#6/#8/#9 是否默认在跑；
2. app-boot 默认 bundle 与 profile patch 的合并语义（patch 未列＝用默认 还是 ＝不装）；
3. compaction/spill 的阈值与策略配置面位置（B1 配置对齐动作的前置）。

## 门禁拦截演练记录（B0 任务书完成定义·对抗项）

- 见 `tests/guards/noSelfBuiltMechanisms.spec.ts` 文件头注释与 commit message：制造违规样例→红（含修复指令）→删除→绿，输出留证于本批 commit。
