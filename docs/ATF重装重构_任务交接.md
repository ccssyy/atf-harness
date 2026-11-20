# ATF 重装重构_任务交接

> 生成于 2026-11-20，基于当时磁盘状态。接手先读本文件。

## 一、这是什么

ATF 项目**基于干净 vendor 重装**的施工交接。owner 已裁定：不做渐进替换，一次性把 12,745 行重复实现清除，把领域资产重新适配到 vendor 原生接口；MCP 化合并做；dev 全程保持可用。

施工方案：`docs/audit/ATF_重装重构方案_20261120.md`（Phase 0-5，5-7 周）

## 二、文件

| 类别 | 路径 ||---|---|
| **交付物（改这里）** | `/data/sam/ATF-Harness`（harness）、`/data/sam/AgenticTrainingFlow`（内核 Py） |
| **权威源（勿改）** | `vendor/dsh/deepseek-harness`（submodule pin `639ed015`） |
| **施工方案** | `docs/audit/ATF_重装重构方案_20261120.md` |
| **审计机检** | `npm run audit:all`（退出码 2=有未登记重复） |
| **施工卡 G0-G7** | `docs/audit/ATF_施工卡_G0-G7_20261120.md` |
| **决策理由** | `docs/audit/ATF_决策理由档案_20261120.md` |
| **方案文档** | `docs/audit/ATF_重装重构方案_20261120.md` |

## 三、已拍板口径/决策

| # | 决策 | 内容 |
|---|---|---|
| D1 | 路线 | **基于干净 vendor 重装**（非渐进替换） |
| D2 | MCP | **与重装合并做**，省一轮返工 |
| D3 | patch | **8→6 + 2 插件**：0002 改 locale 插件、0004 改 provider-card slot；其余 6 个保留（无插件点） |
| D4 | 不提 PR | vendor 独立维护，升级时拉取同步再重放 patch |
| D5 | dev | **全程保持可用**：新代码在 worktree 搭到可用再切 |
| D6 | 工具名 | MCP 切换时**加适配层**，模型可见名保持 `atf_*`（不用 `mcp__atf__*`） |
| D7 | 内核 MCP | **手写最小 stdio 实现**（约 200 行），零新依赖 |
| D8 | 先做 A5 | Phase 2 前先做架构腐化审计器（1-2 天） |
| D9 | pin 树 | **承认退役**（dev 实际跑主仓 main） |

冲突优先级：磁盘最新版 > 本文 > 记忆；方案文档 > 总纲。

## 四、风格/约束

- 全部中文；结论优先，只留会改变决策的信息。
- 测试分层：开发测试可白盒，**产品测试必须黑盒**（判据只落用户可见文本/产物文件/进程事实）。
- 机检优先：任何「必须/禁止」须同批交付拦截点，配不出就降级为建议。

## 五、当前状态

**已完成**：三层重复审计器（工具/模块/跨仓）+ `npm run audit:all`
- 删 4 个死代码模块（`src/rpc`/`src/session`/`src/workspace`/`src/tools`）+ 14 条死命令
- 批次 A（snapshot 接回正式实现 + inspect per-doc）+ 批次 0-1/1-A/2 已部署 dev
- harness `cc5c334e` / 内核 `85edd5f4`，均已推 main

**进行中**：无。刚完成文档落盘，等开工 Phase 0。

**待用户决策**：
1. **段落 3（段序单源）**：声明 17 段 vs 真机实跑 9 段，不一致 → 暂停中
2. **并行施工编排**：是否按附录 G1-G4 分组并行

**已否决**：
- 渐进替换（B 批次逐个清）→ 依赖纠缠仅 13 处，重装更彻底 → 改为重装
- 向上游提 PR → owner 裁定独立产品 → 不提
- 目录照搬参考文章（harness/extensions/api/web）→ ATF 双仓+submodule 不适用 → 不搬

## 六、编辑纪律

- 改前先备份；`vendor/` 是 submodule，**禁止直接改**（走 `patches/` + `apply-patches.sh`）
- 自动生成物（`src/core/generated/`）**勿手改**，改内核源头重新 codegen
- 每批次独立提交；删代码前先跑 `npm run audit:all` 记录基线
- dev 部署走 `deploy/verify/deploy-dev.sh` 六步门禁，需 DeployEvidence PASS

## 七、坑

**技术坑**
- worktree 的 `vendor/dsh/deepseek-harness` 是**空目录**。跑审计器前软链主仓：`ln -s /data/sam/ATF-Harness/vendor/dsh/deepseek-harness vendor/dsh/deepseek-harness`；**提交前必须删软链**
- 39 packages + 55 src 有**陈旧 `.js` 残留**，会让 `createRequire` 加载旧代码 → 改 packages 后须先清
- 部署门禁：`head_commit` 须传**完整 40 位 sha**；预演报告禁写"0 FAIL"字面（用"零失败项"）

**口径坑**
- `../session/index.js` 实际解析到 **`src/core/session/index`**，不是 `src/session`（曾误判为损坏引用）
- `atf_pipeline_stage` **不走 bridge**，直接 spawn CLI（`ATF_DSH_PIPELINE_COMMAND`）→ MCP 化只覆盖 15 个方法，不是 39 个工具
- 审计器「模块层」判定是**语义判定**（写在 `MODULE_RULES`），模块枚举才是机械的

**写法坑**
- 白名单**只减不增**：删一项就减一项，新增重复必须显式登记理由
- 审计器有 **fail-closed**：vendor 缺失/空会拒绝出结论（防"无重复"假绿），不要绕过

---

## 附录

### 施工分组（G0-G7，完整覆盖 Phase 0-5）

| 组 | Phase | 任务 | 独占范围 | 依赖 |
|---|---|---|---|---|
| **G0** | 0 | 基座固化（A5 审计器、patch 8→6+2插件、同步检查器） | `tools/`、`vendor/dsh/patches/`、`atf-ui` | **必须先做** |
| **G1** | 1 | 内核 MCP server | `内核/.../mcp/**`（新建） | 无（可与 G0 并行） |
| **G2** | 2 | `atf-core` 迁 36 文件 | `packages/extensions/atf-core/**` | G0 |
| **G3** | 2 | `atf-tools` 改 13 处依赖 | `packages/extensions/atf-tools/src/**` | G2 |
| **G4** | 2 | `atf-ui` 瘦身 | `packages/extensions/atf-ui/**` | G0 |
| **G5** | 3 | **MCP 切换**（适配层、删 bridge） | `atf-tools` 适配、`src/bridge`、内核分帧层 | G1+G2+G3 |
| **G6** | 4 | **测试与验收**（74 黑盒重跑、155 白盒随删） | `tests/**` | G5 |
| **G7** | 5 | **部署 + pin 退役 + 文档** | `deploy/`、`instancePin.ts`、`docs/` | G6 |

**执行顺序（不可跳）**：
```
G0（串行）→ G1+G2+G4（并行）→ G2完成→G3 → G1+G3完成→G5 → G6 → G7
```

**每个 G 组的完整施工卡**（边界/交付/验收/依赖）见 `docs/audit/ATF_施工卡_G0-G7_20261120.md`。


### 回补记录（读侧追加；写侧消费清空，≤5 行）
> 只记「因缺失而真出错」：`[日期] 漏：<什么> → 错：<后果> → 处置`

本轮无。

---
接手先读本文件。

接手口令（复制下面一行到新任务输入框即可启动）：
接手 ATF重装重构_任务交接.md
