# ATF-Harness Owner 决议与启动指令——P2-S2 闭合 + P2-S3 启动（多 provider 与热切换）

**签发人**：owner
**日期**：2026-09-11
**执行人**：zcode（A800_5005:/data/sam/ATF-Harness）
**依据**：《ATF-Harness_Owner决议与启动指令_P2S2验收_S2a清项_20260911.md》+《ATF独立Harness_Phase2任务书_20260910.md》§4 + ADR-09（ACCEPTED v1.4，C9 定案）+ P2-S2/S2a 产出（`a0161f3` / `f8ec107`）
**结论先行**：**S2a 三项清项验收通过，P2-S2 正式闭合**（经门 1 设计、门 2 BUILD、S2a 清项三次迭代）。**P2-S3 现在启动**——多 provider 与热切换 + R2b 评估，附十二条预拍口径。S3 完成即停，Phase 2 收尾报告另候指令。

---

## 1. S2a 验收复核（owner 独立核验）

| 验收项 | 复核方式 | 结果 |
|---|---|---|
| 测试基线 | **owner 复跑**（17:45） | ✅ `169 passed / 2 skipped`（23 文件；S2 基线 168 → +1 区分性用例） |
| `smoke:p2s2` | **owner 执行** | ✅ 八项全过；**句柄警告计数 = 0**（`grep -ciE "garbage collection\|file descriptor"` → 0），冒烟尾部自报「无句柄警告」 |
| `smoke:s5` | **owner 执行** | ✅ 七项总验收全过 |
| 依赖与 pin | owner 直读 | ✅ `dependencies` 为空；`.atf-pinned` = `a628f8b` 未动 |
| C-1 `approval_advised` | owner 直读 diff | ✅ `errors.ts` 原因枚举新增；`advised` 分支改用；`denied` 保留 `approval_denied`；契约 `six_verdict_handling` 双行同步注明「给意见 ≠ 被否决」
| C-2 句柄 close | owner 直读 diff + 实测 | ✅ runner 分支收尾显式 `session.close()`（关闭失败仅注记、**零行为变化**）；`GuardedSessionLog.close()` 纯新增透传，未触及 append/replay 语义；警告实测归零 |
| C-3 文档登记 | owner 直读 | ✅ ADR-09 §5.3 新增开放点 **(f)**（含主流对标与"可选增强、暂不做"理由），修订说明记 **v1.4** 且声明"仅此一处"；契约 `pairing` 行同步指向 |
| 改动面 | owner 复核 `diff --stat` | ✅ 11 文件 +293/−8；除 §2 扩权项外全部落在 S2a §5 清单内 |

**S2a 结论：三项全过，验收通过。**

## 2. 扩权追认（`t0Guard.ts`）+ 纪律细化

`src/workspace/t0Guard.ts` 被改动（+9 行，新增 `GuardedSessionLog.close()` 透传），不在 S2a §5 允许清单内。zcode 以「**扩权追认提请**」形式在报告与提交信息中**主动单列**，未隐匿。

**实质判定**：C-2 要求"定位并修正未显式 close 的会话句柄"，而 runner 持有的是 `GuardedSessionLog` 包装实例——**不新增透传则无任何其他路径可关到内层句柄**；改动为纯新增（9 行）、零语义触碰。**owner 裁决：采纳并追认。**

**纪律细化（替代 S2 验收决议 §2 第 1 条的严格表述）**——区分两类：

| 类别 | 规则 |
|---|---|
| **必要性透传**（为实现本 slice 既有验收项所必需的最小面，如包装层透传已有能力的转发） | **可同批提请并实施**，但报告与提交信息中必须单列「扩权项：文件 / 行数 / 为何非它不可 / 是否已取最小面」 |
| **新增能力或语义改动**（超出本 slice 验收项的一切新行为） | **必须事前停下提请**，不得实施后再追认 |

依据：前者是被验收项倒逼出的最小面，为 9 行透传做一次往返不成比例；后者会改变切片语义，事前评审不可省。

## 3. P2-S2 闭合小结

| 项 | 结果 |
|---|---|
| 迭代路径 | 门 1（凭据消费小设计 v1.0 → v1.1 修订）→ 门 2 BUILD（`990f894`）→ S2a 清项（`a0161f3`）；四份 owner 决议 + 三份报告入库 |
| 交付能力 | 问答轨（六类应答分支、拒绝循环阈值 2、supersedes 演化链、clarification 多轮同会话、R2 持久化前置、授权凭据四值判定 + 恢复水位线、`indeterminate` 终态 + 五项上报）；退出码扩为 **0/1/75/78/79** 单出口；账本轨语义零改动 |
| 测试 | S1b 基线 138/2 → **169 passed / 2 skipped**（23 文件）；`smoke:p2s2` 八项 + `smoke:s5` 全过 |
| 契约与 ADR | `session.contract.yaml` 新增 `approval_track` 节（双轨优先级 / 载荷字段 / 六类处置 / 拒绝循环 / 凭据消费模型 / 桩对端定位）；ADR-09 §5.3 开放点 (e)(f)，版本 v1.4 |
| 纪律达成 | 零依赖、零内核改动、零真实 Provider、零 GPU；两处越界（`compaction.ts` 审计判重、`t0Guard.ts` 透传）均已追认并伴随纪律细化 |

**P2-S2 状态：CLOSED（2026-09-11）**。

---

## 4. P2-S3 启动指令

> 依据：任务书 §4（S3 要求 1–4 与验收）+ 门 2 放行决议 §3.2 C9 定案 + ADR-09 §1.4。

**范围**：`src/llm/`（第二 Provider 实现 + provider 注册与切换）、`src/run/`（切换点编排 + `provider/switch` 落盘 + 场景）、`src/session/schema.ts`（启用位 `provider/switch`，11 → 12）、`session.contract.yaml`、测试、`smokeP2S3`、`package.json`（仅新增冒烟脚本）、`docs/`（R2b 评估结论文档）。

**owner 预拍口径（十二条，直接采用，无需再问）**：

| # | 事项 | 口径 |
|---|---|---|
| 1 | 启用位推进 | `provider/switch` 移出保留位 → **enabled 12/12**（保留位机制保留但集合为空）；**`schema_version` 保持 1**（类型集合未变，仅启用位推进）；变更描述须标注 |
| 2 | provider 基线 | **B 自管基线**（C9 定案）：provider 由 harness 本地配置/脚本声明；**S3 不实现宿主注入**（dispatch 覆盖语义保留给 Phase 3，消费面已定，届时零改动） |
| 3 | 第二 Provider 实现 | 脚本化 Faux 变体（不同决策序列），**零网络调用、零依赖**；至少注册两个 `provider_id` 供切换 |
| 4 | 切换事件载荷 | `provider/switch` = `{ from: { provider_id, profile? }, to: { provider_id, profile? }, boundary: { turn_index, after_event_id }, reason? }`；**凭据与端点不进载荷明文**（红线延续） |
| 5 | 切换边界判据 | **仅 turn 边界**合法（无 open turn）；越界请求（turn 内 / 无 turn 上下文）→ 结构化 block `provider_switch_out_of_boundary`（exit 1，**非终局**）且**不落 switch 事件** |
| 6 | digest 连续性 | 切换落盘前后必须复跑 digest 校验（等价断言：`ref_invalid` 数为零 + resolver 可用）；失败 → **不落 switch 事件** + 结构化 block `provider_switch_digest_broken`（不放行切换） |
| 7 | 切换原子性 | 不得半生效：要么 switch 事件落盘成功且新 provider 生效，要么完全不切；**切换后首个 turn 必须由新 provider 出决策**（冒烟断言） |
| 8 | R2b 评估交付物 | 一份结论文档：是否维持 R2a；若建议引入依赖，须给理由 / 替代方案 / 影响面 / 迁移成本 / 回滚路径。**结论交 owner 确认**；**确认前 `dependencies` 必须为空**（建议维持 R2a——Phase 2 全无网络需求） |
| 9 | 场景扩展 | 新增场景文件（同会话两 provider 交替完成若干 turn + 一次越界切换被拒）；新增 `smoke:p2s3`；**不得改动 S5 场景脚本与既有四分支断言** |
| 10 | 改动面白名单 | 仅 §4 列明文件；**禁改**：`src/session/` 其余文件（compaction / durability / tail-repair / schema 除启用位）、`src/tools/`、`src/bridge/`、`bridge.contract.yaml`、`src/workspace/`（除必要性透传，按 §2 规则同批提请） |
| 11 | 纪律延续 | 不得新增第 13 类事件；不得新增桥接方法面；不得以 setup 基建承载运行时语义；脱敏纪律延续 |
| 12 | 性能 | 不要求新增性能实测（P2-3 已关闭；10 万级复测留待需要时） |

**验收标准**：

1. 任务书 §4 四条：交替分支冒烟通过 / turn 边界外切换被拒反例 / R2b 结论经 owner 确认 / `dependencies` 仍为空；
2. 追加：越界切换**不落事件**断言；digest 断裂反例（不放行 + 不落事件）；切换**原子性**（无半生效）；切换后首 turn **归属新 provider**；`provider/switch` 载荷字段与本决议 §4 一致；
3. 基线：**169 passed / 2 skipped 起不得回归**；`smoke:p2s3` 新增并通过；`smoke:p2s2`、`smoke:s5` 保持全过；
4. `schema_version` 仍为 **1**；`bridge.contract_version` 不动；pin `v0.2.0b7` / `a628f8b` 不动。

**执行序列**：

1. 阅读本决议 + 任务书 §4 + ADR-09 §1.4（C9）；冲突以本决议为准并报告差异；
2. BUILD（口径 #1–#12）；
3. VERIFY（§4 验收 1–4，附基线复跑与两条既有冒烟）；
4. 产出《ATF独立Harness_Phase2_P2S3执行报告_20260911.md》+《R2b 评估结论（多 provider 下的依赖策略）》（两份文档；R2b 结论单独可引用）；
5. **本地提交，不 push**；完成即停——**Phase 2 收尾报告与 tag 决议另候 owner 指令**。

---

## 5. 下一步预告（Phase 2 收尾）

S3 验收通过后，Phase 2 四切片（D1 / S1 / S2 / S3）全部闭合，届时将由 owner 决议：
1. 阶段报告（各切片 commit / 测试数 / 决议登记 / 遗留项）与 **milestone tag `v0.2.0`** 是否打；
2. 条件项状态确认：**P2-S4 晋升闸 B**（无真实消费面需求 → 维持未触发）、**C1 真实对端接入**（待内核 JSONL 会话能力发版落 tag → owner 签发 re-pin 专项指令）；
3. Phase 3 前置清单（含已登记的 P3-1 跨进程 run-resume 下 `indeterminate` 集成实测、P3-2 幂等键、P3-3 `call_uid`、P3-4 批量档跨进程恢复，以及《记忆分层口径确认》决议的立稿窗口）。

---

## 6. 纪律不变条款

1. 内核仓只读：pin `v0.2.0b7` / `a628f8b` 不动；C1 re-pin 未获指令不涉。
2. 测试基线不得回归（当前 169 passed / 2 skipped）；BUILD/VERIFY 分离。
3. 零 npm 运行时依赖；`dependencies` 保持为空（R2b 结论经 owner 确认前不得变更）。
4. 不得新增第 13 类事件；不得新增桥接方法面；不得以 setup 基建承载运行时语义。
5. 改动面按 §4 口径 #10；扩权按 §2 分类处理。
6. 禁止顺手优化；脱敏纪律延续。
