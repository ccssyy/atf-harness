# ATF 独立 Harness Phase 2——收尾报告（完整版）

**执行人**:zcode(A800_5005:/data/sam/ATF-Harness)
**日期**:2026-09-11
**依据**:《ATF-Harness_Owner决议与启动指令_P2S3验收_Phase2闭合_20260911.md》§7(收尾执行序列)
**结论先行**:Phase 2 四切片(**D1 / P2-S1 / P2-S2 / P2-S3**)全部验收闭合;**milestone tag `v0.2.0`** 已打并推送(指向 `b40f1d4`);R2b 结论经 owner 确认**维持 R2a**;终验数字 **186 passed / 2 skipped**,四条冒烟(`smoke:p2s1` / `p2s2` / `p2s3` / `s5`)全过;内核仓全程只读(pin `v0.2.0b7` / `a628f8b` 未动)。

---

## 1. 四切片明细

### D1——ACP 消费面定型(仅文档)

| 项 | 内容 |
|---|---|
| commit 区间 | `c1e4a72`(任务书入库)→ `fc1fda2`(ADR-09 候选)→ `47d5bc3`(执行报告)→ `c50f3d6`(升格 ACCEPTED v1.1)→ `78af9fa`(闭合决议) |
| 测试增量 | 无代码改动(109 passed / 2 skipped 维持) |
| 决议链 | 《Phase2范围确认与任务书签发》→《启动指令_Phase2_D1》→ D1 报告 → 门 1 评审通过升格 **ADR-09 ACCEPTED** |
| 关键落点 | ADR-09 C1–C12 结论体系:dispatch/resume 消费面、事件投影白名单(C4/C5)、审批往返(C6)、授权凭据(C7)、超时分流(C8)、provider 配置(C9)、多轮透出(C10)、不实现项(C11)、条款对账(C12);退出码 0/78/1/75/79 定案 |
| 偏离与追认 | 无代码;门 1 评审 C7 改判(应答即授权凭据)、75/79 新增枚举补登——均 owner 裁决 |

### P2-S1——会话能力升级(compaction + fsync + schema v1)

| 项 | 内容 |
|---|---|
| commit 区间 | `93b1a88`(feat)→ `04af91f`(报告)→ `410b4ea`(S1a 修复)→ `efc7aa7`(S1a 报告+决议)→ `6da6e3f`(S1b 收尾)→ `15e6071`(S1b 报告+决议) |
| 测试增量 | 109/2 → **138/2**(S1b 终态,+29) |
| 决议链 | 《D1闭合_P2S1启动》→ P2-S1 报告 →《P2S1验收_S1a修复》→ S1a 报告 →《S1a验收_S1b收尾》→ S1b 报告 →《P2S1闭合_P2S2启动》 |
| 关键落点 | schema v1 定死 12 类(保留位拒写 + v0 迁移兼容);transformContext 真实压缩(双指标触发 / 承证白名单 / chunk 滞后 / 审计事件透明 + `session/compaction` 留痕);fsync 双档(逐条默认 ack=fsync / 批量 write 即 ack + 刷盘水位线);尾部残段容忍 + 物理截断 + `session/repair` 成对留痕 |
| 偏离与追认 | 批量档 ack 语义按决议 §2.2 改判措辞(强度按档表述);S1a 三项修复(P0-1 尾部半行策略 / P1-2 投影摘要 `synthetic:true` / 契约 v1 修正窗口 11→12 不 bump);S1b 三项收尾(L-1 退出码 75/79 挪登 bridge.contract.yaml / L-2 `truncatedTail` 透传收紧 / L-3 冒烟文案对齐);无越界 |

### P2-S2——交互问答审批轨

| 项 | 内容 |
|---|---|
| commit 区间 | `4e3651e`(门 1 小设计+决议)→ `fa046b0`(门 1 评审+v1.1 修订指令)→ `57faba7`(设计 v1.1)→ `990f894`(feat)→ `d12f524`(报告+门 2 放行)→ `74e57b2`(审计判重修正补交)→ `a0161f3`(S2a 清项)→ `f8ec107`(S2a 报告) |
| 测试增量 | 138/2 → **168/2**(S2,+30)→ **169/2**(S2a,+1 区分性) |
| 决议链 | 《P2S1闭合_P2S2启动》→ 门 1 小设计 v1.0 →《门1评审_设计v1.1修订》→ 设计 v1.1 →《门1通过_门2放行》→ BUILD →《P2S2验收_S2a清项》(三项清项令)→ S2a 报告 →《P2S2闭合_P2S3启动》 |
| 关键落点 | 问答轨六类应答分支(granted/advised/denied/aborted/clarification/timeout);拒绝循环阈值 2;`supersedes` 演化链;clarification 同会话多轮;R2 持久化前置;凭据四值判定(`resolveCredentialState` 纯函数 + 恢复水位线 + `call_ref` 精确配对);`indeterminate` 终态 failed(1) + 五项上报;退出码单出口 0/1/75/78/79;账本轨语义零改动;`approval/request`、`approval/response` 启用(9→11);ADR-09 §5.3 开放点 (e) 登记 |
| 偏离与追认 | ① A1 `tool/call` 侧自指 `call_ref` 未落盘——偏离采纳,登记开放点 (f)(S2a);② `74e57b2` 审计判重修正越界(compaction.ts)——采纳并追认;③ S2a 两项清项(C-1 `approval_advised` 独立 reason / C-2 FileHandle 显式 close),`t0Guard.ts` 透传扩权追认 + **必要性透传纪律细化** |

### P2-S3——多 provider 与热切换

| 项 | 内容 |
|---|---|
| commit 区间 | `4d09b5b`(feat)→ `d947bd1`(报告+R2b+决议)→ `8932294`(owner 决议入库)→ `b40f1d4`(任务书 CLOSED) |
| 测试增量 | 169/2 → **186/2**(+17) |
| 决议链 | 《P2S2闭合_P2S3启动》(十二条预拍口径)→ P2S3 报告 + R2b 结论 →《P2S3验收_Phase2闭合》(七项口径补全逐条裁决 + R2b 确认 + 收尾授权) |
| 关键落点 | `provider/switch` 启用位 11→12(12/12,保留位空集,schema v1 不 bump);第二实现 `faux-alt` + `ProviderRegistry`(≥2 id,面外拒绝);段边界切换协议(边界判据 / digest 前后复跑 / 原子性单出口);越界切换不落事件;场景 schema 七类步骤 + `segments` 段声明;R2b 结论维持 R2a(owner 确认) |
| 偏离与追认 | 七项口径补全全部采纳;其中**段模型具体化被追认为正解**(owner 口径 #5 在单 turn/分支 runner 下不可表达合法切换,属口径欠明确非执行偏差);`provider_switch_unknown_provider` 防御原因采纳;登记 Phase 3 议题 P3-5(切换发起方落运行时)/ P3-6(digest 质控作用域优化) |

## 2. 验收汇总

### 2.1 测试与冒烟

| 项 | 结果 |
|---|---|
| 测试基线 | **186 passed / 2 skipped**(26 文件);链路:109(P1 终态)→ 138(S1)→ 168(S2)→ 169(S2a)→ 186(S3),全程零回归 |
| `smoke:p2s1` | 全过(compaction / fsync 双档 / 尾部修复) |
| `smoke:p2s2` | 八项全过(六类应答 + 升级 + headless 等价 78),**无句柄警告**(DEP0137 断言内建) |
| `smoke:p2s3` | 十六项全过(载荷逐字段 / turn 归属 / 首 turn 决策实证 / 边界形态 / 原子性 / digest 连续 / 越界不落事件 / 非终局) |
| `smoke:s5` | 七项总验收全过(S5 场景与四分支断言零改动零回归) |

### 2.2 性能实测(P2-3,已关闭)

10k 事件压缩基准:p50 **2.10–2.25ms** / p95 **4.07–4.41ms**(20% 承证对最坏路径 p95 4.41ms)→ 10k 级无需增量缓存;10 万级复测留待需要时(P2-S3 未实现优化,符合纪律)。

### 2.3 契约与 ADR 变更清单

| 文档 | Phase 2 变更 |
|---|---|
| `session.contract.yaml` | v1 定死 12 类 + 启用位两轮推进(9→11→12,保留位空集,不 bump);compaction 节;durability 双档 + consumer_discipline;tail_repair 节;approval_track 节(双轨/载荷/六类处置/拒绝循环/凭据消费模型/桩定位);provider_switch 节;headless 退出码改指向 bridge.contract.yaml |
| `bridge.contract.yaml` | 头部「exit 75/79 枚举补登」区块(S1b);`contract_version` 保持 1 |
| `workspace.contract.yaml` | Phase 1 形态保持,零改动(除 S1b 无关细节) |
| ADR-09 | v1.0 候选 → ACCEPTED(v1.1 门 1 评审)→ v1.2(S1a `synthetic:true` 纪律)→ v1.3(S1b 边界声明 + 开放点 (d) 标注)→ **v1.4**(S2a 开放点 (f));§5.3 开放点 (d)/(e)/(f) 落齐 |

## 3. 阶段数据

| 维度 | 数值 |
|---|---|
| src 文件 / 行数 | 47 个 `.ts` / 6,613 行 |
| 测试文件 / 用例 | 26 个测试文件 / 188 用例(186 passed + 2 skipped 契约占位) |
| Phase 2 提交数 | **23** 笔(`c1e4a72..b40f1d4`),全部已 push |
| 契约文件 | 3 份 yaml(bridge / session / workspace)+ 场景脚本 2 份(`admission-to-g2.json` / `provider-alternation.json`) |
| 冒烟命令 | 7 条(`smoke:s1–s5` Phase 1 + `smoke:p2s1–p2s3` Phase 2) |
| milestone tag | `v0.1.0`(Phase 1)→ **`v0.2.0`**(Phase 2,annotated,指向 `b40f1d4`) |
| 依赖 | `dependencies` 恒空(R2b 确认维持 R2a);devDependencies 仅 typescript / vitest / @types/node |
| 内核仓 | 只读,pin `v0.2.0b7`(`a628f8b`)全程未动,零改动 |

## 4. 条件项状态(决议 §5)

| 条件项 | 状态 | 触发条件 |
|---|---|---|
| P2-S4 晋升闸 B | **未触发**(Phase 2 全程无 harness 侧 T2 写入需求) | 出现真实消费面需求 → 另立任务书 |
| C1 真实对端接入(re-pin) | **未触发**(待内核 stdio JSONL 会话能力发版落 tag) | 内核发版 → owner 签发 re-pin 专项指令 |

## 5. Phase 3 前置清单(决议 §6,未获指令不启动)

| # | 事项 |
|---|---|
| P3-1 | 跨进程 run-resume 下 `indeterminate` 集成级实测(真恢复路径验证终态 + 五项上报) |
| P3-2 | 幂等键(`approval_key`/`request_id`)→ 窗口内「安全重放」升级(ADR-09 §5.3 (e),re-pin 后可谈) |
| P3-3 | 预生成 `call_uid` 对称配对键(可选增强,ADR-09 §5.3 (f)) |
| P3-4 | 批量档跨进程恢复语义 |
| P3-5 | 切换发起方落到运行时(宿主 dispatch 覆盖 = C9 A 模式;凭据句柄机制 + 明文红线) |
| P3-6 | digest 连续性质控作用域优化(现为全流复跑,成本随引用数线性增长) |
| P3-7 | 记忆分层立稿窗口(三类记忆 / 两道闸 / 四条硬约束;窗口 = Phase 3 启动) |

## 6. 索引——Phase 2 全部 owner 决议/指令文档(审计追溯)

| # | 文档 | 节点 |
|---|---|---|
| 1 | 《ATF-Harness_Owner决议_Phase2范围确认与任务书签发_20260910.md》 | Phase 2 启动 |
| 2 | 《ATF-Harness_Owner启动指令_Phase2_D1_20260910.md》 | D1 启动 |
| 3 | 《ATF-Harness_Owner决议与启动指令_D1闭合_P2S1启动_20260910.md》 | D1 闭合 / S1 启动 |
| 4 | 《ATF-Harness_Owner决议与启动指令_P2S1验收_S1a修复_20260910.md》 | S1 验收 / S1a 令 |
| 5 | 《ATF-Harness_Owner决议与启动指令_S1a验收_S1b收尾_20260911.md》 | S1a 验收 / S1b 令 |
| 6 | 《ATF-Harness_Owner决议与启动指令_P2S1闭合_P2S2启动_20260911.md》 | S1 闭合 / S2 启动 |
| 7 | 《ATF-Harness_Owner决议与启动指令_P2S2门1评审_设计v1.1修订_20260911.md》 | S2 门 1 评审 |
| 8 | 《ATF-Harness_Owner决议与启动指令_P2S2门1通过_门2放行_20260911.md》 | S2 门 2 放行 |
| 9 | 《ATF-Harness_Owner决议与启动指令_P2S2验收_S2a清项_20260911.md》 | S2 验收 / S2a 令 |
| 10 | 《ATF-Harness_Owner决议与启动指令_P2S2闭合_P2S3启动_20260911.md》 | S2 闭合 / S3 启动 |
| 11 | 《ATF-Harness_Owner决议与启动指令_P2S3验收_Phase2闭合_20260911.md》 | S3 验收 / Phase 2 闭合 |
| 12 | 《ATF-Harness_Owner决议_记忆分层口径确认与P3前置登记_20260911.md》 | 记忆分层口径 / P3 前置 |

执行报告链:《D1 执行报告》/《P2S1 执行报告》/《S1a 执行报告》/《S1b 执行报告》/《P2S2 执行报告》/《S2a 执行报告》/《P2S3 执行报告》/《凭据消费模型小设计 v1.1》/《R2b 评估结论》/ 本报告。

## 7. 关闭声明

Phase 2 自本报告入库起**正式关闭**。tag `v0.2.0` 打出后不得移动或删除;Phase 3(含 P3-1~P3-7 全部前置项)**未获 owner 书面启动指令前一律不得开工**(含探索性调研、预写代码);内核仓只读与脱敏纪律永久有效;R2a 依赖策略经 R2b 确认维持,变更须走书面提议 → owner 批准 → 显式 PR 流程。
