# ATF-Harness Owner 决议与启动指令——P2-S1 闭合 + P2-S2 启动（首交付：凭据消费小设计）

**签发人**：owner
**日期**：2026-09-11
**执行人**：zcode（A800_5005:/data/sam/ATF-Harness）
**依据**：《ATF-Harness_Owner决议与启动指令_S1a验收_S1b收尾_20260911.md》+《ATF独立Harness_Phase2任务书_20260910.md》§3 + ADR-09（ACCEPTED，v1.3）+ P2-S1 三期产出（`93b1a88` / `410b4ea` / `6da6e3f` + 三份执行报告）
**结论先行**：**S1b 验收通过，P2-S1 正式闭合（经 S1a/S1b 两轮修正）。P2-S2 现在启动——但分两道门：先交「凭据消费模型小设计」并停下等 owner review，通过后才进 BUILD。S2 完成即停，S3 未获指令不得启动。**

---

## 1. S1b 验收复核（owner 独立核验，非转述）

| 验收项 | 复核方式 | 结果 |
|---|---|---|
| 测试基线 | **owner 复跑**（10:56，`ATF_CLI_PATH=.atf-pinned npm test`） | ✅ `138 passed / 2 skipped`（20 文件；S1a 为 136/2，本切片 +2） |
| `smoke:p2s1` | **owner 执行** | ✅ 六步全过；第 6 步文案已对齐定案 |
| `smoke:s5`（七项总验收） | **owner 执行** | ✅ 全过 |
| 依赖与 pin | owner 直读 | ✅ `dependencies` 为空；`.atf-pinned` = `a628f8b` 未动 |
| 改动面 | **owner 复核** `diff --stat` | ✅ `bridge.contract.yaml`(+7) + `session.contract.yaml` + `src/session/`(2 文件) + `src/workspace/t0Guard.ts` + ADR-09(+6/-) + 新测试 1 文件 + 报告 |
| L-1 退出码挪移 | owner 直读两处契约 | ✅ `bridge.contract.yaml` 第 99–101 行区块补登 75/79（注明承接决议 §2.3，未 bump `contract_version`）；`session.contract.yaml` 第 183 行改为指向性引用（单句，无同义重复） |
| L-2 包装层透传 | owner 直读 `t0Guard.ts` diff | ✅ `GuardedReplayOutcome` 的 `replayed` 字面量补 `truncated_tail`；新增 `get truncatedTail()` 透传内层；`ReplayOutcome.truncated_tail` 已由可选**收紧为必填**（类型系统强制补全，原「因包装层不透传故可选」注释已删）；**铁律一拦截路径未变** |
| L-3 冒烟文案 | owner 直读 diff | ✅ 第 6 步标题改为「ack = 已写入；攒满 N 条触发 fsync 后水位线归零」，并**新增水位线归零断言**（断言实质未削弱，反而加强） |
| 边界登记 | owner 直读契约 + ADR-09 | ✅ 契约第 162–166 行「已知边界，非待办承诺……需外部锚（run journal 事实 / catalog sha）；Phase 2 不实现 hash chain」；ADR-09 §4 第 5 条同口径；ADR-09 修订说明记录为 **v1.3**，仅改这两处 |
| 开放点 (d) 状态 | owner 直读 §5.3 | ✅ 已标注「P2-S2 首发小设计」并附四条约束（幂等 / 不新增第 13 类 / 禁 setup 基建 / fail-closed 优先） |
| 新测试有效性 | owner 直读 `guardedTailPassthrough.test.ts`（79 行） | ✅ 覆盖包装层透传 + 无残段时 `null` 收紧闭包 + 铁律一回归 |

**验收结论：S1b 通过，无遗留项。**

## 2. P2-S1 阶段闭合小结

| 项 | 结果 |
|---|---|
| 迭代路径 | P2-S1（`93b1a88`）→ S1a 修复（`410b4ea`）→ S1b 收尾（`6da6e3f`）；三份执行报告 + 三份 owner 决议入库 |
| 交付能力 | schema v1（12 类，enabled 9 / reserved 3）+ compaction（双指标触发 / 承证白名单 / chunk 滞后 / 审计透明）+ fsync 双档（逐条默认 + 批量水位线）+ 尾部残段修复（容忍 + 截断 + `session/repair` 成对留痕） |
| 测试 | Phase 1 基线 109/2 → **138 passed / 2 skipped**（20 文件）；冒烟 `smoke:p2s1` / `smoke:s5` 全过 |
| 契约 | `session.contract.yaml`（`tail_repair` / `durability` / `compaction` / 边界节新增）+ `bridge.contract.yaml`（75/79 枚举补登）；`contract_version` 与 `schema_version` 均保持 1 |
| 纪律达成 | 零 npm 运行时依赖、零内核改动（pin `v0.2.0b7` / `a628f8b` 全程未动）、零真实 Provider、零 GPU |
| owner 侧修正记录 | 两处 P0（C7 方法面依据、尾部半行策略）+ 一处 P1（投影 id）+ 若干 P2/P3，均已在切片内闭合或登记 |

**P2-S1 状态：CLOSED（2026-09-11）**。

---

## 3. P2-S2 启动指令

> 依据：任务书 §3（S2 要求 1–8 与验收）+ ADR-09 §1.3/§1.5（ACCEPTED）+ 决议 §2.1（应答即授权凭据）+ §2.2（退出码定案）+ 本决议 §3.2。

**双重门结构（不得跳门）**：

```text
门 1（首个交付） 凭据消费模型小设计（文档）→ 停下等 owner review
门 2（review 通过后） BUILD：src/tools/ + src/run/ 实现 → VERIFY → 报告 → 完成即停
```

### 3.1 门 1：凭据消费模型小设计（首个交付，先设计后实现）

产出 1–2 页设计说明（落 `docs/`，可命名为《ATF独立Harness_Phase2_凭据消费模型小设计_20260911.md》），必须回答：

1. **消费事实的载体**：在 schema v1 的 12 类事件内如何记录「该授权凭据已被使用」（若无解 → 提出 v2 修订建议并报 owner，不得自行新增类型）；
2. **重启幂等判定**：run 恢复后如何判定凭据已消费，判定路径必须是**确定性纯函数**（由事件流推导或由显式记录读取，二者择一并说明理由）；
3. **执行与消费事实的先后顺序**：明示顺序及其 fail-closed 边界（不确定即阻断，不得「猜已执行」）；
4. **与账本轨并存时的判定优先级**：账本命中 / 凭据命中 / 都不命中三种组合的行为；
5. **四条约束的自证**：重启幂等（防双执行）、不新增第 13 类事件、禁 setup 基建（`ledger_record` 等仅 setup 用）、fail-closed 优先。

**门 1 交付后必须停下**：不得继续 BUILD，等 owner review 结论。

### 3.2 门 2：owner 预拍口径（review 通过后直接采用，无需再问）

| # | 事项 | 口径 |
|---|---|---|
| 1 | 事件启用 | 本 slice 启用 `approval/request`、`approval/response`（enabled 9 → 11）；`provider/switch` 仍为保留位（S3 启用）。**`schema_version` 保持 1**（类型集合未变，仅启用位推进）；变更描述须标注「启用位推进」 |
| 2 | 审批载荷字段 | 按 ADR-09 §1.3 全字段：request = `approval_session_id` / `tool_call_id` / `tool` / `params` / `approval_key` / `rationale?` / `attempt` / `supersedes?`；response = 同 ADR-09 的 `approval_session_id` / `request_event_ref` / `verdict` / `actor` / `reason?` / `advice_text?` / `question?`。允许字段命名微调，**语义锚点与字段完整性不得削减**；增删字段需在报告中说明理由 |
| 3 | 六类应答分支 | 逐条按 ADR-09 §1.3 时序实现：`granted` → 凭据成立 → 审批检查点依据二 → 执行；`advised` → 意见原文回填模型 → 重新提案（新 request 带 `supersedes`）；`denied` → 结构化 block 回填 + 重提计数；`aborted` → run 终态；`clarification` → 补上下文后重发 request（同一 `approval_session_id`）；`timeout` → 落 `verdict=timeout`、`actor="harness"` → `suspended` |
| 4 | 拒绝循环阈值 | 常量 **2**；「同提案」= tool 名 + `params_digest` 一致；达阈值 → 升级（abort 或上报），**不得静默重试** |
| 5 | 无配额复用 | 一次 `granted` 仅覆盖一次调用；凭据消费后不得复用 |
| 6 | 双轨优先级 | 先查账本（`ledger_query` 命中且未消费 → 消费放行）；未命中**且**已声明 `approval_surface` → 发 request；未命中**且**未声明 → `blocked`（exit 78）。账本轨一次性消费与 78 锚点语义零改动 |
| 7 | headless 等价性 | 未声明 `approval_surface` → 不发 request，行为与 Phase 1 逐位一致（既有用例不得改动）；已声明但无应答 → 按 `timeout` 处理（`suspended`，**不是** 78） |
| 8 | 桩对端 | 测试用脚本化对端（同 Faux 思路）支持六类应答；**不实现 ACP server、不做界面、不引入网络**；桩对端属测试基建，**不得成为运行时依赖路径** |
| 9 | 退出码 | `suspended` = 75、`aborted` = 79，仍经 `resolveHeadlessExitCode()` **单出口**；终局语义保护条款延续；78 锚点不挪用 |
| 10 | 禁用项 | 不得以 `ledger_record` 或任何 setup 基建作为运行时路径；不得新增桥接方法面 |
| 11 | 上游零改动 | session 层仅允许 `schema.ts` 的启用位推进（9 → 11）；compaction / durability / tail-repair 语义零改动；workspace 层零改动 |
| 12 | 性能实测（P2-3 登记项） | 报告须给出实测数据：≥10k 事件规模下单次 `append` 耗时（含审批事件路径），据此提出「是否需增量缓存优化」的建议；**本 slice 不强制实现优化** |

### 3.3 验收标准

1. 六类应答各一组正例 / 反例（含 `timeout → suspended`、`aborted → 79`、`clarification` 多轮配对同一会话）；
2. `supersedes` 提案演化链可审计（可回答「最终执行的是基于哪条意见改出来的」）；
3. 拒绝循环升级用例（同提案第 3 次重提触发升级）；
4. **授权凭据 fails-closed**：无真实应答事件落盘 → 无凭据 → 不执行（含桩对端缺省场景）；
5. 账本轨全量既有用例**零改动**通过；headless 等价性用例通过；
6. 退出码三态可编程区分（0 / 75 / 78 / 79 / 1）并经单出口；
7. 基线零回归：**138 passed / 2 skipped 起不得回归**；新增冒烟命令 `smoke:p2s2` 承载六类分支；`smoke:s5` 保持全过；
8. 门 1 小设计经 owner review 通过（前置条件）；
9. `dependencies` 仍为空；pin `v0.2.0b7` / `a628f8b` 不动；`git diff` 限于 `src/tools/`、`src/run/`、`src/session/schema.ts`、契约（如需登记）、测试、docs。

### 3.4 执行序列

1. 阅读 ADR-09（ACCEPTED v1.3）+ 本指令 + 任务书 §3；与本指令冲突时以本指令为准并报告差异；
2. **门 1**：产出凭据消费模型小设计 → **停下等 owner review**（不得继续 BUILD）；
3. **门 2**（review 通过后）：BUILD（口径 #1–#12）；
4. VERIFY（§3.3 全部 9 项，附基线复跑输出与性能实测数据）；
5. 产出《ATF独立Harness_Phase2_P2S2执行报告_20260911.md》（执行记录 / 验收对照 / 偏离与决策点 / 性能实测 / 提交清单）；
6. **本地提交，不 push**；完成即停——**P2-S3 未获指令不得启动**。

---

## 4. 纪律不变条款

1. 内核仓只读：pin `v0.2.0b7` / `a628f8b` 不动；无 C1 指令不得涉 re-pin。
2. 测试基线不得回归（当前 138 passed / 2 skipped）；BUILD/VERIFY 分离。
3. 零 npm 运行时依赖；`dependencies` 保持为空；无 GPU、无真实 Provider、无网络模型调用。
4. 不得新增第 13 类事件；不得启用 `provider/switch`（属 S3）。
5. 不得以 setup 基建承载运行时语义；不得新增桥接方法面。
6. 门结构不得跳越：门 1 未过 review 不得进 BUILD。
7. 禁止顺手优化；脱敏纪律延续。
