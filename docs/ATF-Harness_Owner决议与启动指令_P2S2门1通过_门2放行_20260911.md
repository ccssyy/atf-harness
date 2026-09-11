# ATF-Harness Owner 决议与启动指令——P2-S2 门 1 通过 + 门 2 放行（BUILD 授权）

**签发人**：owner
**日期**：2026-09-11
**执行人**：zcode（A800_5005:/data/sam/ATF-Harness）
**依据**：《ATF-Harness_Owner决议与启动指令_P2S2门1评审_设计v1.1修订_20260911.md》+《ATF-Harness_Owner决议与启动指令_P2S1闭合_P2S2启动_20260911.md》§3.2/§3.3 + 设计 v1.1（`57faba7`）+ ADR-09（ACCEPTED v1.3）
**结论先行**：**门 1 设计 v1.1 验收通过。门 2 BUILD 现在放行**——按《P2S1闭合_P2S2启动》§3.2 十二条预拍口径 + 本决议 §2 四项追加口径执行。S2 完成即停，S3 未获指令不得启动。

---

## 1. 门 1 v1.1 验收复核（owner 独立核验）

| 验收项 | 复核方式 | 结果 |
|---|---|---|
| 门纪律 | **owner 复核** `git diff --stat 4e3651e..HEAD -- src/ tests/ package.json` | ✅ 为空——零代码改动 |
| 提交面 | `git log` / 工作树 | ✅ `57faba7`（设计 v1.1，1 文件 +66/−34）+ `fa046b0`（评审决议入库）；工作树干净 |
| 内核 pin | owner 复核 `.atf-pinned` | ✅ `a628f8b` 未动 |
| 修订清单逐条 | 对照评审决议 §4 十处 | ✅ 十处全部落地（状态/修订记录、§1 理由 2 表述、§2 签名与判定表、§2 配对纪律、§3 顺序与持久化前置、§3 终局处置、§4 组合表、§5 约束自证、新增 §5.5、§6 落点） |
| R1（P0） | 直读 §2 | ✅ 三元签名 + `recoveryWatermark`；边界为 `granted.id ≤ watermark → indeterminate` / `> watermark → available`；**resume 可执行性显式写成结论**（第 50 行）；表述修正为「同一水位线下重放恒等」 |
| R2（P1） | 直读 §3 | ✅ 放行序列含「① granted 持久化确认」（per-append 断言或 `flush()` 成功，失败不放行）；引用契约 `durability.consumer_discipline`；崩溃窗口相应收敛为「持久化确认后、result 前」 |
| R3（P2） | 直读 §2/§6 | ✅ 配对改 `payload.call_ref` 显式引用；旧流兼容说明合理（不含 granted，不进入判定） |
| 四项裁决采纳 | 直读 §3/§4/§5.5/§6 | ✅ 推导式维持（不触发 v2）、`indeterminate` 终态 failed(1)、幂等键议题登记路径、修订时点 |
| 未越界 | 对照评审决议 §4 禁止项 | ✅ 五问框架、四值模型、载体选择、`request_ref` 回溯链均未改 |

**验收结论：v1.1 通过，门 1 闭合。**

---

## 2. 门 2 追加口径（四项，BUILD 时直接采用）

《P2S1闭合_P2S2启动》§3.2 十二条继续有效；以下四项为 v1.1 评审中识别出的细化点，须一并采用：

| # | 事项 | 口径 |
|---|---|---|
| A1 | `call_ref` 的字段语义 | `tool/call.payload.call_ref` = **该事件自身 id**（自指，供对称校验）；`tool/result.payload.call_ref` = **被回填的 `tool/call` 事件 id**。消费判定仅认后者；**`call_ref` 指向不存在或非 `tool/call` 事件的结果，不构成消费事实**（视同无结果，落 `indeterminate`/`available` 按水位线判定）——须有对应用例 |
| A2 | 水位线取值时机与固定性 | `recoveryWatermark` 由 `src/run/` 在**打开/恢复会话后立即取值并固定于本次进程上下文**，取值来源 = 打开时刻流内最大事件 id（**含 `session/repair` 审计事件**）；取值后不随后续 append 变化。须有「恢复后继续 append，watermark 不变、判定不漂移」用例 |
| A3 | `indeterminate` 终态的固定表达 | 退出码 **1** + 结构化原因 **`credential_indeterminate`**；运行报告条目固定含五项：`approval_session_id` / `tool_call_id` / `tool` / `approval_key` / 窗口区间（`granted.id` 与水位线）；该终态**不得被后续写失败覆盖**（沿用 Phase 1 终局语义保护条款） |
| A4 | 允许改动的文件清单 | 允许：`src/tools/`、`src/run/`、`src/session/schema.ts`（**仅启用位推进 9 → 11**）、`session.contract.yaml`（登记审批载荷字段、`call_ref` 字段与启用位）、测试、`smokeP2S2`、`package.json`（仅新增冒烟脚本）、`docs/`。**禁止**：`bridge.contract.yaml`、`src/bridge/`、`src/session/` 其余文件（compaction / durability / tail-repair 语义零改动）、`src/workspace/`、`AGENTS.md` |

另：**幂等键议题登记**为门 2 的显式交付项——在 ADR-09 §5.3 新增开放点 (e)，并在 S2 执行报告中登记（re-pin 后可谈，Phase 2 不实现不探索）。

---

## 3. 门 2 验收清单

**原九项（《P2S1闭合_P2S2启动》§3.3）**：六类应答正反例 / `supersedes` 演化链可审计 / 拒绝循环升级 / 凭据 fails-closed / 账本轨零改动 + headless 等价 / 退出码 0·75·78·79·1 单出口 / 基线 138-2 不得回归 + `smoke:p2s2` 新增 + `smoke:s5` 保持 / 门 1 通过（已达成）/ 依赖与 pin 纪律。

**追加四项（本决议 §3 对应）**：

1. **resume 可执行性**：恢复后用 `resume(answer)` 注入 granted → 判为 `available` 并放行执行（不被窗口策略误杀）；
2. **持久化前置**：批量档下放行前确实完成刷盘；刷盘失败 → 不放行（fail-closed）；
3. **精确配对**：`call_ref` 正例（精确命中 → `consumed`）+ 反例（`call_ref` 悬空/类型不符 → 不构成消费事实）；
4. **`indeterminate` 终态**：exit 1 + `credential_indeterminate` + 报告五字段齐备；且该终态不被后续写失败覆盖。

**追加三项（本决议 §2）**：A1 的悬空 `call_ref` 反例；A2 的 watermark 固定性用例；A3 的报告字段与终局保护用例。

**性能实测（P2-3 登记项）**：报告须给出 ≥10k 事件规模下单次 `append` 的耗时数据（建议 p50 / p95），并给出「是否需增量缓存优化」的建议；**本 slice 不强制实现优化**。

---

## 4. 执行序列

1. 阅读设计 v1.1（生效版）+《P2S1闭合_P2S2启动》§3.2 + 本决议；冲突以本决议为准并报告差异；
2. BUILD：`src/session/schema.ts` 启用位（9 → 11）→ `src/tools/`（`resolveCredentialState` + 审批检查点接受依据二 + 拒绝循环阈值 + 六类应答处置）→ `src/run/`（水位线注入、`call_ref` 写入、`indeterminate` 终态与上报材料、`resume(answer)` 路径）→ 桩对端 → `smokeP2S2`；
3. VERIFY：门 2 验收清单全部 + 基线复跑 + 两条既有冒烟 + 性能实测；
4. 产出《ATF独立Harness_Phase2_P2S2执行报告_20260911.md》（执行记录 / 验收对照 / 偏离与决策点 / 性能实测 / 幂等键议题登记 / 提交清单）；
5. **本地提交，不 push**；完成即停——**P2-S3 未获指令不得启动**。

---

## 5. 纪律不变条款

1. 内核仓只读：pin `v0.2.0b7` / `a628f8b` 不动；幂等键议题不探索、不实现。
2. 测试基线 **138 passed / 2 skipped 不得回归**；BUILD/VERIFY 分离。
3. 零 npm 运行时依赖；`dependencies` 保持为空；无 GPU、无真实 Provider、无网络模型调用。
4. 不得新增第 13 类事件；不得启用 `provider/switch`（属 S3）；不得新增桥接方法面；不得以 setup 基建（`ledger_record` 等）承载运行时语义。
5. 改动面严格按 §2 A4；`bridge.contract.yaml` 与 session 层其余文件不得改动。
6. 禁止顺手优化（P2-3 性能优化须待报告数据 + owner 裁定）。
7. 脱敏纪律延续。
