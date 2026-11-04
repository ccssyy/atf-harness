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

---

## 终版结论（2026-11-04 深挖补锚后，覆盖上表「待深挖」项）

### 装配语义定案

宿主装配是三层叠加：**dsh-base 组合**（`packages/bundle/base/cordis.patch.yml`，权威文档 `apps/cli/composition.md`）→ profile 模式层 → 用户层（dev `profiles/web/cordis.patch.yml` 只调差异项）。base 默认装配且 dev 未禁用的件＝**默认在 live**：

- **#2/#3/#4 spill 三件在跑**：`spill-local`＋`spill-policy`（`maxInlineTokens: 12500`）＋`tool-result-pruner`（`thresholdChars: 8192`/head 4096/tail 1024）＋`image-offload`（图像预算拒绝→占位重试）；
- **#11 session-checkpoint-policy 在 base 装配**——判定表「暂缓」自动满足（机制在场，D170v2 领域件并行不冲突）；
- **session-title 在场**（`session-title-first-prompt-llm`）——10-17 盘点「来源未锚」项闭合；
- **#10 compaction-basic 在跑但 GLM 1M 水位不可达**（providers `contextWindow: 1048576`）——与 D78「85 会话零触发」自洽。

### 行为证据（关键修正：机制装配≠机制执行）

T10 真机会话（d168v2-replay，本机 zstd 全量解压 994 行/2.7MB）实锚：

- `tool/result` 最大 28.9K／16.7K／14.9K／12.3K／11.3K 字符，**全部超过 pruner 的 8192 阈值**；
- 会话内 `compaction/prune` 事件 **0 条**（pruner 源码语义：修剪必落此事件＋replace 件）；
- 根因（pruner 源码实锚）：`pruneSession` 唯一调用方＝`compaction-basic`，双触发语义——`context-overflow`（真溢出，无条件先 prune 再摘要）与 `pressure`（水位按模型窗口比例解析，1M 下不可达）。D7 的 318K 未达任何触发线，原文直出＝**设计行为**。

### ADR-0019 判定表补注（两处）

1. **#10 修正**：compaction-basic 不只是摘要器，还是 pruner 的常规触发器。「不主动依赖」精确化为「不依赖其**摘要输出**」；其水位触发策略属配置面，B1 可调。
2. **#2-#4 与 #10 存在触发依赖**：希望大结果在远低于 1M 的水位被管控（D7/1210 场景），正确动作＝**降 pressure 水位**（overlay 配置），不是新接线、也不是启摘要。

### B1 剩余动作（配置批＋验证，小）

1. 挖 compaction-basic 的 pressure policy 配置键（`resolveTargetPolicy`/config schema）→ `deploy/profiles/web/generate.py` overlay 加目标水位（按 ATF 场景定，如 200K 量级触发 prune/spill）；
2. 重启 dev（owner 已授权随时）；
3. 验证锚（黑盒）：超阈值工具结果场景 → 会话落盘出现 `compaction/prune` 事件＋上下文峰值下降；1210 大图场景 → image-offload 占位重试可见。

### 方法论留痕

- dev 容器无 zstd 二进制：远端 zstd 管道全为假阴性（本次前两轮扫描教训）；会话文件须拉本机解压或用支持多帧的解压实现；
- Node zlib `zstdDecompressSync` 只解第一帧（流式会话文件为多帧拼接），远端统计因此失真。

---

## B1 配置批执行记录（2026-11-04 深夜）

### 已落地并验证

- dev 装配清单追加 `compaction-basic.config.thresholdRatio: 0.2`（200K 水位触发 prune/spill，默认 0.8=800K 在 GLM 1M 下不可达）；
- 净室重启 dev 成功：新进程在听 3080（HTTP 401=token 门正常）、atf-ui 扩展装载、compaction 配置通过启动校验零报错；
- 回滚路径：删除追加的 4 行＋重启（备份 `cordis.patch.yml.bak-b1-20261104` 在实例 profile 目录）。

### 过程事故与处置（教训登记）

重新生成路径（overlay→generate.py）暴露 **dev.overlay.yml 与现役装配清单多处未同步**：llm-pi-ai 缺 zai-coding-cn provider（默认模型正用它）、atf-tools 的 chainTools 停在 D170v2 步3 之前（缺 atf_label_qc_resolve/atf_admit_data/atf_gate）、agent-default-model 与现役不一致。按 overlay 行覆写语义重新生成＝回退 D170v2 免审面＋断默认模型。**已避险**：改走「备份＋最小追加」路径，D170v2 免审面与默认模型逐项验证保留。overlay 同步缺门禁是 2026-10-11 已登记已知病（overlay 头注）的再现——建议 B2 批一并装 drift 对账门禁（check-drift 强化）。

### B1 剩余（下个验证窗口）

- 行为级验证锚（黑盒）：驱动一个超 200K 上下文会话（大图 read_image 场景）→ 断言会话落盘出现 `compaction/prune` 事件＋上下文峰值受控；1210 场景观察 image-offload 占位重试；
- 验证有效后把水位段升产品层模板（cordis.patch.template.yml）——当前只在 dev 实例层。

---

## Owner 裁定（2026-11-04 深夜）：撤销 0.2 水位调参，保持原生默认

- **裁定内容**：撤销本日 B1 配置批的 thresholdRatio 0.2，compaction-basic 回到 vendor 原生默认 0.8。已执行：产物/overlay 双回滚＋净室重启，装配清单与调整前零差异（备份对账）。
- **理由（owner 原话要点）**：当前全部是测试短会话，短测零触发不代表真实使用没有长会话。真实训练 run 走到高水位时原生管控本会正常接管。
- **纪律依据**：调参无真实事故支撑，违反「围栏唯一合法来源是真实事故」（元规则 2）——测试期观测样本不可作为产品参数依据。
- **B1 结论修正**：#2-#4 收编状态＝装配在场＋**原生默认保持**；水位调参从 B1 剩余动作移除。触发观察改为被动：真实长会话自然出现 `compaction/prune` 事件或溢出事故时，按事故证据定靶（届时区分水位问题/单结果管控问题/呈现面问题，不再预设）。
- **D7 归因再修正**：318K<1M 未达水位＝设计行为；真实使用中同类直出若构成事故，属单结果管控或呈现面问题，非水位问题。
