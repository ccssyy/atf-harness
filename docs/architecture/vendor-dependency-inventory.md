# vendor/dsh 依赖面盘点闭集（批 4 · C1）

> 权威关系：patch 登记与 bump SOP 权威＝`vendor/dsh/LOCK.md`（本表不重复登记，只引用）；本文件是 **ATF 消费 vendor 面的盘点闭集账本**（三期方案 §3.2 批 4 交付物，任务书 `20261116-phase3-batch4-vendor-channel.md` C1）。上游形态：submodule 锁 `639ed01`＋patch 全集应用态（D301 裁定，不得还原）。
>
> 改动影响级图例：**P**＝源码行为面（只走 patch 通道）｜**B**＝构建产物面（升级/重建后传导，特征码护栏）｜**A**＝装配/进程面（发版与环境）｜**T**＝测试/eval 载体面｜**D**＝文案合同面（SKILL 层，受保护合同流程）。

## 盘点结论（先读）

- 消费全部集中在 **harness 仓**；**内核仓代码层零 vendor 引用**（仅 SKILL 文案层引用 read_image 工具与 AGENTS.md/paths.json 锚——见面 4/面 7）。
- **codegen 消费面盘点结论：零直接消费**——`tools/codegen-stage-order.mjs` 源头为内核 `stage_registry`（`ATF_KERNEL_SOURCE` 单版本源门），不触 vendor。
- 本批复述闸呈报的未登记消费点（vitest alias 逐包面、poc/dsh-home profile patch 面、dev.env 引用面）经 owner 确认后入表（闭集纪律）。

## 面清单

### 面 1 · patch 触达面（源码修改面，级 P）

| 消费方式 | 实锚 |
|---|---|
| patch 0001-0008 触达 18 文件/10 包，改 vendor 源码行为的唯一合法通道 | `vendor/dsh/LOCK.md` patch 表（触及文件列）；闭集快照＝`tests/tools/testVendorPatchConsolidation.test.ts` `TOUCHED_FILES`/`UNTRACKED_SRC`；重放＝`vendor/dsh/apply-patches.sh`（幂等三态） |

### 面 2 · 构建产物消费面（级 B）

| 消费方式 | 实锚 |
|---|---|
| vitest alias 直指 vendor lib（13 包：dsh-tools/schemastery/cordis/cosmokit/dsh-scope/dsh-util-values/dsh-brand/dsh-llm/dsh-typert-protocol/dsh-sandbox/dsh-user-approval/dsh-fs/dsh-session） | `vitest.config.ts:23-35` |
| atf-tools/atf-ui 扩展＝DSH Cordis 扩展包，仓侧消费 vendor/dsh 协议；生产经父仓 node_modules symlink 消费构建产物 | `packages/extensions/atf-tools/src/index.ts:4` |
| worktree 依赖装配（硬链主仓 node_modules+vendor 产物两层） | `scripts/setup-worktree-deps.sh` |
| 测试直 require vendor 模块（jsdom×真 React×vendor 组件） | `tests/dshUi/*.test.ts`（`createRequire("…/vendor/dsh/deepseek-harness/package.json")`，如 `tests/dshUi/draftResumeCard.test.ts:14`） |

### 面 3 · 装配/进程面（级 A）

| 消费方式 | 实锚 |
|---|---|
| dev server 宿主：`corepack pnpm dsh web`（cd VENDOR_DIR；tsx 直跑 src＝工作区即行为） | `deploy/instances/instance-restart.sh:44,215,221`；pkill 模式 `:285-291` |
| UAT 发版面：submodule update＋apply-patches 重放（发版步骤 1c/2） | `deploy/instances/uat-deploy.sh:54,209-241` |
| patch env 面：`DSH_WEB_LAUNCH_TOKEN`(0001)/`DSH_WORKSPACE_PICKER_ROOT`(0007)/`DSH_BASH_PASSTHROUGH_ENV`(0008)/`DSH_HOME` | `deploy/instances/dev.env:42,55,62,68` |
| 运行时 GLM 接线 profile patch（cordis.patch.yml；不改动 DSH 源码红线时期的运行时通道） | `poc/dsh-home/profiles/web/agent-default.patch.notes.md`；交付副本 `poc/web-profile-cordis-patch.yml` |

### 面 4 · agent 工具消费面（级 D）

| 消费方式 | 实锚 |
|---|---|
| SKILL 文案层引用宿主 `read_image` 看图合同（vendor 工具描述不可改，需求落 SKILL/文案层——AGENTS.md 双仓执行面裁定） | 内核 `skills/atf-admit-training-data/SKILL.md:246`、`skills/atf-analyze-badcases/SKILL.md:65` |

### 面 5 · 测试/eval 载体面（级 T）

| 消费方式 | 实锚 |
|---|---|
| 测试经 atf-tools 源码间接消费（vitest alias 解析 @deepseek-ai/* → vendor lib） | `tests/dshTools/*.test.ts`（3 件，import `packages/extensions/atf-tools/src/*`） |
| dshUi 直消费（见面 2） | `tests/dshUi/*.test.ts`（9 件）＋browser smoke（`smoke_*_browser.py` 3 件） |
| L2 eval 一次性宿主（headless 载体：`node --import tsx/esm apps/cli/src/bin.ts headless`） | `scripts/evals/label_qc_behavior_eval_dsh.sh:44` |

### 面 6 · codegen 消费面（盘点结论：零直接消费）

| 消费方式 | 实锚 |
|---|---|
| 段序 codegen 源头＝内核 `stage_registry.STAGE_ORDER_V2`（`ATF_KERNEL_SOURCE`），不触 vendor | `tools/codegen-stage-order.mjs:1-12` |

### 面 7 · DSH 运维工具级残留（级 A）

| 消费方式 | 实锚 |
|---|---|
| dsh CLI 运维角色：`dsh web`/`dsh headless`（实例管理＋eval 环境旁路；1107 裁定＝运维工具级非架构级，pin 保留无害） | `deploy/instances/instance-restart.sh:215`、`scripts/evals/label_qc_behavior_eval_dsh.sh:44`；角色定调＝`vendor/dsh/LOCK.md` 纪律段 |

## 与重评触发器（C4）的基线关系

触发器三信号的闭集基线取自面 1 的 LOCK 表（触达文件 18／包数 10——批 4 机检实锚更正 LOCK 旧记「8 包」）。

## 重评触发器清单（C4 实锚化）

三信号定义与检查入口（机检住 `scripts/vendor-smoke-gate.sh` 段④，每次跑门同窗输出；任一命中=启动独立评估批评「建镜像仓转 fork 模式」替换 submodule+patch 通道，不在业务批夹带）：

| 信号 | 定义 | 阈值 | 检查入口 |
|---|---|---|---|
| 1 新增 patch 频率 | 近 30 天 patch 首次入库数 | 月均 ≥2 件**非缺陷修复类**（分类人工判读；口径=git 首次入库时间，存量收编入库非新增——2026-11-15 收编批一次性入库 8 件属此类） | `bash scripts/vendor-smoke-gate.sh` 段④信号 1（git log --since 30d -- patches/） |
| 2 触达面扩张 | patch 全集 numstat 去重文件/包数 | 超基线（18 文件/10 包）1.5 倍＝27 文件/15 包 | 同上信号 2（git apply --numstat 全集并集） |
| 3 重放链脆弱 | 同文件被 ≥3 个 patch 叠加 | 任一文件命中 | 同上信号 3（numstat 逐 patch 交叉统计） |

## 维护纪律

- 新增 vendor 消费面（新 alias/新装配点/新 eval 载体）随批入表——盘点闭集只增不减，登记义务由守护测试 LOCK↔patch 明细对账（C2）锚 patch 面，其余面靠本表声明＋评审。
- 盘点发现未登记消费点：先呈报 owner 确认再入表（闭集纪律，同判读段盘点惯例）。
