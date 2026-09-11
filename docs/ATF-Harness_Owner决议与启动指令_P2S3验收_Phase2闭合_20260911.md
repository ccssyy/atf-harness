# ATF-Harness Owner 决议与启动指令——P2-S3 验收 + Phase 2 闭合（push + tag v0.2.0 + 收尾报告）

**签发人**：owner
**日期**：2026-09-11
**执行人**：zcode（A800_5005:/data/sam/ATF-Harness）
**依据**：《ATF-Harness_Owner决议与启动指令_P2S2闭合_P2S3启动_20260911.md》+《ATF独立Harness_Phase2任务书_20260910.md》§4/§7 + P2-S3 产出（`4d09b5b` 实现 / `d947bd1` 报告与 R2b 结论）
**结论先行**：**P2-S3 验收通过，Phase 2 四切片（D1 / S1 / S2 / S3）全部闭合。** R2b 结论确认为**维持 R2a**。七项口径补全逐条裁决完毕（全部采纳，其中段模型一项系 owner 口径欠明确）。三项收尾动作授权：**push 21 笔 + 打 annotated tag `v0.2.0` + 产出完整版 Phase 2 收尾报告**。执行序列严格按序，完成即停——Phase 3 未获指令不启动。

---

## 1. P2-S3 验收复核（owner 独立核验）

| 验收项 | 复核方式 | 结果 |
|---|---|---|
| 测试基线 | **owner 复跑**（18:30） | ✅ `186 passed / 2 skipped`（26 文件；S2a 基线 169 → +17，零回归） |
| `smoke:p2s3` | **owner 执行** | ✅ 十六项断言全过（载荷逐字段 / turn 归属 `[faux, faux-alt, faux]` / 切换后首 turn 决策文本出自新 provider 脚本 / 边界形态前后邻事件 / `turn_index` 语义 / 原子性 / digest 连续 / reason 留痕 / 越界不落事件 / 非终局） |
| `smoke:p2s2` / `smoke:s5` | **owner 执行** | ✅ 均保持全过（p2s2 含无句柄警告） |
| 依赖 / pin / 版本 | owner 直读 | ✅ `dependencies` 空；`a628f8b` 未动；`schema_version` = 1；`bridge.contract_version` = 1 |
| 改动面 | **owner 复核** `--name-only` | ✅ 19 文件，全在 §4 口径 #10 白名单内；**禁改面零改动**（session 其余 / tools / bridge / `bridge.contract.yaml` / workspace / S5 场景与四分支断言） |
| 口径 #1 启用位 | owner 直读 `schema.ts` | ✅ `provider/switch` 移出保留位 → enabled 12/12；保留位改为空集（机制保留，`isEnabledEventType` 纪律不变）；未 bump |
| 口径 #2/#3 | owner 直读 `providerRegistry.ts` | ✅ B 自管基线；`faux` / `faux-alt` 两 id；**注册面外返回 null，不猜测回退**；零网络零依赖 |
| 口径 #4/#5/#6/#7 | owner 直读 `providerSwitch.ts` | ✅ 载荷形态与口径一致；`checkSwitchBoundary` 仅 `turnOpen === false` 放行；`verifyDigestContinuity` pre/post 两阶段、三类断裂（标记残留 / digest 不一致 / resolver 故障）全 `provider_switch_digest_broken`；原子性单出口（落盘成功才激活；落盘后复核失败 → run 终局且新 provider 不激活） |
| 口径 #9 | owner 复核 | ✅ 新场景 `scenarios/provider-alternation.json`（交替 + 越界两分支）；`smoke:p2s3`；S5 场景零改动 |
| 口径 #12 | owner 复核 | ✅ 未新增性能实测（P2-3 已关闭） |

---

## 2. 七项口径补全：逐条裁决

| # | 事项 | 裁决 |
|---|---|---|
| 1 | `provider_switch_unknown_provider`（注册面未命中防御原因） | **采纳**：fail-closed、不落事件、与另两条原因同族同纪律，契约已登记，不构成语义扩张 |
| 2 | **段模型具体化**（`segments` 一段 = 一个 turn；段边界 = 合法切换点；段内 `provider_switch` 步骤 = 越界反例） | **采纳，并明确追认为正解**：owner 口径 #5「仅 turn 边界合法」在既有 runner（单 turn/分支）下**不可表达任何合法切换**——属 owner 口径欠明确，非执行偏差。段模型同时满足两条要求：规则不变（仅 turn 边界）、且可表达可验收。单 provider 分支零改动已实证（S5 四分支零回归） |
| 3 | `boundary.turn_index` 语义（被本切换关闭的 turn 序号，与 `after_event_id` 对称） | **采纳**，契约登记 |
| 4 | `turn/end` 的 `reason` 新增值 `provider_switch` | **采纳**（payload 为自由 JSON 面，不影响既有枚举） |
| 5 | 场景 `cite_admitted_fact` 语义修正（由 admit 步骤移至 surface_scan 步骤，对齐 B1 语义） | **采纳**，属 BUILD 自测中自行发现并纠正，处理正确 |
| 6 | 场景 schema 白名单六类 → 七类 | **采纳**：Phase 1 的「无第七类」表述由本 slice 按任务书 §4 演进；未知 type 仍一律拒绝（收口纪律不变） |
| 7 | 未新增性能实测 | **采纳**（口径 #12） |

**登记（Phase 3 议题）**：Phase 2 的切换发起方为场景脚本 `segments`（测试/演示基建）；**生产侧发起方**（宿主 dispatch 覆盖 = C9 的 A 模式，或 harness 内部策略）属 Phase 3，不得把 segments 误读为运行时 API。

---

## 3. R2b 结论：确认维持 R2a

**owner 确认**：《R2b 评估结论_多provider下的依赖策略_20260911.md》结论**维持 R2a（零外部运行时依赖，`dependencies` 恒空）**。理由认可：Phase 2 对第三方依赖的消费面为零（引入即纯风险敞口）；真实 Provider 接入形态受 Phase 3 鉴权面支配，提前引入 SDK 必返工；TCB 最小化是契约级承诺。

**三条补充口径**：
1. **Phase 3 起若接真实 Provider**：优先 **Node ≥22 内置 `fetch` + `src/llm/` 内自研薄适配层**（接口沿用既有 `LlmProvider`），不引入厂商 SDK；确需引入时按 §3.2 流程。
2. **引入依赖的流程**（沿用 R2b 文档 §5）：书面提议（理由 / 具体包与版本 / 传递依赖清单与审计 / 替代方案再对照）→ owner 批准 → 显式 PR + 锁版本 + 供应链审查 → 契约登记更新。
3. **回滚边界**：依赖隔离在 `src/llm/` 单适配层内，删除依赖 + 适配层即回到 R2a；会话 / 桥接 / 审批各层无耦合。

---

## 4. Phase 2 闭合小结

| 切片 | 交付 | 决议链 |
|---|---|---|
| **D1** ACP 消费面定型 | ADR-09（ACCEPTED v1.4，C1–C12 结论体系 + 开放点 a–f） | 门 1 评审 + v1.1 修订 + 门 1 通过 |
| **P2-S1** 会话能力升级 | schema v1 定死 12 类；compaction（双指标 / 承证白名单 / chunk 滞后 / 审计透明）；fsync 双档（逐条默认 + 批量水位线）；尾部残段容忍 + 截断 + `session/repair` 成对留痕 | S1a 修复 + S1b 收尾 |
| **P2-S2** 交互问答审批轨 | 六类应答分支 / 拒绝循环阈值 2 / `supersedes` 演化链 / clarification 多轮 / R2 持久化前置 / 凭据四值判定 + 恢复水位线 / `indeterminate` 终态 + 五项上报；退出码扩为 0·1·75·78·79 单出口；账本轨零改动 | 门 1 凭据消费小设计 v1.0→v1.1 + 门 2 BUILD + S2a 清项 |
| **P2-S3** 多 provider 与热切换 | 启用位 12/12；`faux-alt` + 注册表（面外拒绝）；段边界切换协议（边界判据 / digest 前后复跑 / 原子性）；越界不落事件；R2b 结论 | 本决议 |

**阶段数据**：测试 109 passed / 2 skipped（Phase 1 终态）→ **186 passed / 2 skipped**（26 文件）；三条冒烟 `smoke:p2s1` / `smoke:p2s2` / `smoke:p2s3` + 总验收 `smoke:s5` 全过；`contract_version` 与 `schema_version` 均保持 1；pin 全程 `a628f8b` 未动；零 npm 运行时依赖。

**三处越界与追认记录（全部已裁决）**：`compaction.ts` 审计判重修正（采纳并追认）；`t0Guard.ts` 句柄 close 透传（采纳并追认 + 必要性透传纪律细化）；S2a 两项清项（C-1 独立 reason / C-2 句柄 close）。

---

## 5. 条件项状态

| 条件项 | 当前状态 | 触发条件 |
|---|---|---|
| **P2-S4 晋升闸 B** | **未触发**（Phase 2 全程无 harness 侧 T2 写入需求；provider 配置与会话事件均不属 T2 冻结合同区） | 出现真实消费面需求（D1 结论要求 harness 管 T2 / 内核契约演化需冻结区配合） |
| **C1 真实对端接入（re-pin）** | **未触发**（依赖内核侧 stdio JSONL 会话能力发版落 tag；属 owner 主线，harness 侧无法推进） | 内核发版落 tag → owner 签发 re-pin 专项指令（bump `atf_upstream` → 启用 2 个 skipped 契约用例 → mock 替换 → 契约测试全绿） |

---

## 6. Phase 3 前置清单（登记，Phase 3 未获指令不启动）

| # | 事项 | 来源 |
|---|---|---|
| P3-1 | **跨进程 run-resume 下 `indeterminate` 集成级实测**（Phase 2 单进程 e2e 无法自然触发；须在真恢复路径验证终态 + 五项上报） | P2-S2 验收 |
| P3-2 | 幂等键（`approval_key` / `request_id`）→ 窗口内由「不重放 + 人工核对」升级为「安全重放」 | ADR-09 §5.3 (e) |
| P3-3 | 预生成 `call_uid` 对称配对键（可选增强） | ADR-09 §5.3 (f) |
| P3-4 | 批量档跨进程恢复语义 | P2-S2 验收 |
| P3-5 | **切换发起方落到运行时**（宿主 dispatch 覆盖 = C9 A 模式；凭据句柄机制 + 红线：凭据/端点不进载荷明文） | 本决议 §2 |
| P3-6 | digest 连续性质控的作用域优化（现为全流复跑，长会话下切换成本随引用数线性增长） | 本决议 §1 实现抽读 |
| P3-7 | **记忆分层立稿窗口**（三类记忆 / 两道闸 / 四条硬约束；立稿窗口 = Phase 3 启动） | 《记忆分层口径确认与 P3 前置登记》决议 |

---

## 7. 收尾执行序列（严格按序，完成即停）

1. **push 前强制复跑**：
   ```bash
   ATF_CLI_PATH=/data/sam/ATF-Harness/.atf-pinned npm test    # 底线：186 passed / 2 skipped
   npm run smoke:p2s3 && npm run smoke:p2s2 && npm run smoke:s5
   ```
   任何偏差立即停止并报告 owner。
2. **入库仍 untracked 的两份 owner 文档**：`docs/ATF-Harness_Owner决议_记忆分层口径确认与P3前置登记_20260911.md` + 本决议；建议提交信息 `docs(owner): 记忆分层口径决议 + P2-S3 验收暨 Phase 2 闭合决议`。
3. **push**：`git push origin main`（21 笔 + 本决议入库笔）。
4. **任务书标记 CLOSED**：在《ATF独立Harness_Phase2任务书_20260910.md》**文档头部**加状态块（正文零改动）：
   > **状态：CLOSED（2026-09-11）** —— Phase 2 四切片（D1 / S1 / S2 / S3）全部验收闭合，milestone tag `v0.2.0`。终验数字：186 passed / 2 skipped，smoke:p2s1 / p2s2 / p2s3 / s5 全过。条件项 P2-S4（闸 B）、C1（re-pin）未触发，状态见《P2-S3验收暨Phase2闭合决议》§5。
   
   单独提交，建议信息：`docs(phase2): 任务书标记 CLOSED——Phase 2 闭合，tag v0.2.0`。
5. **打 annotated tag 并推送**：
   ```bash
   git tag -a v0.2.0 -m "Phase 2 closed: capability extension (P2-S1 session compaction+fsync+tail-repair / P2-S2 interactive approval track with credential model / P2-S3 multi-provider hot switch / D1 ACP consumption surface ADR-09). 186 passed / 2 skipped, smokes p2s1-p2s3 + s5 green, kernel repo untouched (pinned v0.2.0b7)."
   git push origin main --follow-tags
   ```
6. **产出《ATF独立Harness_Phase2_收尾报告_20260911.md》（完整版）**，内容清单：
   - 四切片明细（每片：commit 区间 / 测试增量 / 决议链 / 关键落点 / 偏离与追认）；
   - 验收汇总（Phase 2 全部验收项 + 四条冒烟 + 性能实测数据 + 契约与 ADR 变更清单）；
   - 阶段数据（src 文件数/行数、测试文件数/用例数、提交数、契约数）；
   - 条件项状态（§5）；
   - Phase 3 前置清单（§6 七项）；
   - 索引（Phase 2 全部 owner 决议/指令文档清单，供审计追溯）。
7. **复跑确认**（同第 1 步口径）后产出《Phase 2 闭合存证简报》（push / tag / CLOSED 三动作的 commit sha 与 tag 指向），随最后提交推送。
8. 完成即停——**Phase 3 未获 owner 指令不得启动**（含探索性调研）。

---

## 8. 纪律条款

1. **tag 打出后不得移动或删除**；如 push 后发现异常，报告 owner 处置，禁止自行 force 操作。
2. 内核仓只读：pin `v0.2.0b7` / `a628f8b` 不动；re-pin 仅经 C1 专项指令。
3. 测试基线不得回归（186 passed / 2 skipped）；BUILD/VERIFY 分离。
4. 零 npm 运行时依赖（R2a 经 R2b 确认维持）；`dependencies` 保持为空。
5. Phase 3 启动前不得开展任何 Phase 3 相关探索性调研或预写代码（含 P3-1~P3-7 各项）。
6. 脱敏纪律延续。
