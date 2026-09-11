# ATF-Harness Owner 决议与启动指令——S1a 验收 + S1b 收尾修复（S2 前清项）

**签发人**：owner
**日期**：2026-09-11
**执行人**：zcode（A800_5005:/data/sam/ATF-Harness）
**依据**：《ATF-Harness_Owner决议与启动指令_P2S1验收_S1a修复_20260910.md》+《ATF独立Harness_Phase2任务书_20260910.md》§3 + P2-S1/S1a 产出（`93b1a88` / `04af91f` / `410b4ea` / `efc7aa7`）
**结论先行**：**P2-S1 + S1a 技术验收通过（七组必需测试齐备、136 passed / 2 skipped、两条冒烟全过）。按 owner 裁决，先出 S1b 收尾修复清掉三项附带小项 + 落地一项边界登记；S1b 复核通过后签发 P2-S2 启动指令。只做 S1b，完成即停。**

---

## 1. S1a 验收复核（owner 独立核验，非转述）

| 验收项 | 复核方式 | 结果 |
|---|---|---|
| 测试基线 | **owner 复跑**（01:07，`ATF_CLI_PATH=.atf-pinned npm test`） | ✅ `136 passed / 2 skipped`（P2-S1 为 126/2，本切片 +10） |
| `smoke:p2s1` | **owner 执行** | ✅ 六步全过，含第 5 步「尾部半行修复：伪造未确认尾部 → create 截断 + session/repair 留痕」 |
| `smoke:s5`（七项总验收） | **owner 执行** | ✅ 全过（B1 exit 0 / B2 block 自纠 / B3 exit 78 / B4 铁律一 / 四分支可重建 / 晋升 sha / 零内核改动） |
| 依赖与 pin | owner 直读 | ✅ `dependencies` 为空；`.atf-pinned` = `a628f8b` 未动 |
| 改动面 | **owner 复核** `diff --stat` | ✅ `src/session/`（4 改 1 新）+ `session.contract.yaml` + ADR-09（+2 行）+ 测试（4 文件）+ `smokeP2S1` |
| 半行尾判定 | owner 直读 `scanTailFragment` | ✅ 仅末尾容忍；末尾紧邻空行并入残段；**中间损坏不越界** |
| `create` 修复序 | owner 直读 | ✅ 先物理截断（UTF-8 字节精确，`truncate(droppedFromOffset)`）→ 成对写 `session/repair`；留痕失败 → 结构化 fail-closed 上报（含 `truncated_tail`） |
| `replay` 只读性 | owner 直读 + 测试断言 | ✅ 不改写文件，仅返回 `truncated_tail` |
| 透明性 | owner 直读 `materialOf` + 测试 | ✅ 同时排除 `session/compaction` 与 `session/repair`；计划与投影逐条一致 |
| 7 组必需测试 | owner 逐项比对用例 | ✅ 全部到位（半行尾 / 更短残段 / 中间损坏回归 / **完成行坏 JSON 于流末仍 fail-closed** / 留痕四字段 + sha256 / 留痕失败注入 / 透明度 / 投影 (id, synthetic) 唯一性 / kill 后注入半行尾） |
| 契约与 ADR 一致性 | owner 直读 diff | ✅ `tail_repair` 节、`durability` 措辞（两档强度不同 + 消费者纪律 + 审计可重建旁注）、`synthetic` 语义、12 类集合；ADR-09 §1.2 补句 |

**验收结论**：S1a 修复有效、范围克制、测试为实证（含对既有 `corrupt_stream` 语义的回归保护）。P2-S1 判定为「技术验收通过，闭合待 S1b」。

### 1.1 遗留三项（S1b 清除对象）

| # | 事项 | 事实 | 风险 |
|---|---|---|---|
| L-1 | 退出码 75/79 登记位置 | 现落在 `session.contract.yaml` 的 `headless_exit_codes` 节（决议 §2.3 已裁决应挪至 `bridge.contract.yaml`，Phase 1 exit 78 登记先例所在处） | exit code 属进程/运行面语义，留在会话契约会被后续读者误认为会话层职责 |
| L-2 | 包装层未透传修复事实 | `ReplayOutcome.truncated_tail` 被设为**可选**字段，原因登记为「`GuardedSessionLog` 字面量不透传」；`SessionLog.truncatedTail` 亦未确认经包装可见 | run 层（S2 起）会静默丢失「本次会话发生过尾部截断」这一审计事实 |
| L-3 | 冒烟文案与定案语义冲突 | `smokeP2S1` 第 6 步标题为「fsync 批量档：攒满 N 条即刷、**ack 即持久化**」 | 与决议 §2.2 定案的批量档语义（ack = 已写入，持久化看水位线）矛盾，属文档级误导 |

### 1.2 另一项边界（S1b 仅登记，不实现）

尾部容忍策略在**结构上**无法发现「整条尾部事件被删除」（例如把末条完整事件连同其 LF 一起删掉 → 文件以更早的 LF 结尾，不构成残段）。这是 append-only 文件在无外部锚时的固有边界，非 S1a 缺陷。owner 裁决：**登记为后续议题，Phase 2 不做**；`session/repair` 留痕对「残段」类删除已具备取证能力（`tail_excerpt` + `tail_sha256`）。

---

## 2. 三项裁决

### 2.1 时序：先清附带项，再启 P2-S2

**裁决**：先出 **S1b 收尾修复**（范围严格限于 §1.1 三项 + §1.2 登记）。S1b 复核通过后，P2-S1 正式闭合，随后签发 P2-S2 启动指令。理由（owner 侧）：这三项都是「会污染下游判断」的小项——L-1 影响退出码归属、L-2 会让 S2 的恢复链丢审计、L-3 直接在冒烟输出里留下与定案相反的表述；在 S2 开工前清掉，避免 S2 报告出现口径分歧。

### 2.2 凭据消费模型：S2 首个交付出小设计（不在 S1b 做）

**裁决**：授权凭据的一次性消费模型（D1 开放点 d）**由 P2-S2 首发交付**——先出小设计（不含实现），owner review 通过后再实现。**S1b 不得实现、不得预写该部分代码**。

S2 小设计必须满足的约束（预先锁定）：
1. **重启幂等**：run 恢复后对同一凭据不得重复消费（防双执行）；
2. **不新增第 13 类事件**：若无解，走 schema v2 定义修订并报 owner（不得夹带）；
3. **禁 setup 基建**：不得以 `ledger_record` 或任何 setup 方法承载消费事实；
4. **fail-closed 优先**：执行与消费事实的先后顺序必须明示，不确定即阻断，不得「猜已执行」。

### 2.3 防篡改锚定：登记为后续议题

**裁决**：Phase 2 不实现会话流 hash chain；在契约（`session.contract.yaml` 新增边界节或 `tail_repair` 节内）与 ADR-09 §4 边界声明中**各登记一条**：会话流无防篡改链，整条尾部事件删除不可检测，需外部锚（run journal 事实 / catalog sha）方可发现。措辞须明确「这是已知边界，不是待办承诺」。

---

## 3. S1b 收尾修复指令

**范围（严格限定，不得夹带）**：`bridge.contract.yaml`、`session.contract.yaml`、`src/workspace/`（仅 `GuardedSessionLog` 透传）、`src/session/sessionLog.ts`（仅 `truncated_tail` 收紧与注释）、`src/session/smokeP2S1.ts`、`docs/ATF独立Harness_ADR-09候选_ACP消费面定型_20260910.md`、相关测试。

| # | 改动 | 要点 |
|---|---|---|
| 1 | 退出码挪移（L-1） | `bridge.contract.yaml` 补登 75/79（**枚举补登，不 bump `contract_version`**，沿用 exit 78 登记区块的形态与注释风格）；`session.contract.yaml` 的 `headless_exit_codes` 节改为**指向性引用**（或移除），不得两处并存同义内容 |
| 2 | 包装层透传（L-2） | 定位：`src/workspace/t0Guard.ts` 的 `GuardedSessionLog.replay` 返回值**手工重建字面量**，现仅展开 `events`/`blocks`（`GuardedReplayOutcome = { kind: "blocked" } \| ({ kind: "replayed" } & ReplayOutcome)`）→ `truncated_tail` 被静默丢弃。要求：透传 `truncated_tail`；包装实例透传 `truncatedTail`；`ReplayOutcome.truncated_tail` 由可选**收紧为必填**（`TruncatedTail \| null`）——收紧后类型系统会强制该字面量补全字段，并删除「因包装层不透传故可选」的注释。**不得改变铁律一的拦截语义**（`t0_ref_forbidden` 行为逐位不变） |
| 3 | 冒烟文案（L-3） | 第 6 步标题与输出改为「批量档 ack = 已写入；攒满 N 条触发 fsync 后水位线归零」。**断言实质不变**（仍验证水位线归零与落盘条数） |
| 4 | 边界登记（§1.2） | 契约 + ADR-09 §4 各一条「无防篡改链」已知边界声明（措辞：已知边界，非承诺） |
| 5 | 开放点状态更新 | ADR-09 §5.3 开放点 (d) 标注为「S2 首发小设计（owner 裁决 §2.2）」，附四条约束摘要 |

**必须新增/更新的测试**：

1. **包装层透传**：经 `GuardedSessionLog` 包装的 `replay` 在存在尾部残段时，`truncated_tail` 可见且数值正确；无残段时为 `null`（收紧闭包）；
2. **铁律一回归**：包装层对 `t0_ref_forbidden` 的拦截行为逐位不变（复用既有用例，不得放松）；
3. **冒烟口径**：`smoke:p2s1` 第 6 步断言不变但文案更新（人工核对输出）。

**验收标准**：

- 上述 3 组测试通过；**既有 136 passed / 2 skipped 零回归**（复跑输出随报告）；`smoke:p2s1`、`smoke:s5` 全过；
- `schema_version` 仍为 **1**；`bridge.contract_version` **不动**（变更描述中标注「枚举补登，非语义变更」）；
- `dependencies` 仍为空；pin `v0.2.0b7` / `a628f8b` 不动；
- `git diff` 仅覆盖 §3 列明文件。

**执行序列**：

1. 阅读本指令 + 现状代码/契约/ADR；与本指令冲突时以本指令为准并报告差异；
2. BUILD（§3 清单 1–5）；
3. VERIFY（3 组测试 + 基线复跑 + 两条冒烟）;
4. 产出《ATF独立Harness_Phase2_S1b执行报告_20260911.md》（执行记录 / 验收对照 / 偏离与决策点 / 提交清单）；
5. **本地提交，不 push**；完成即停——**P2-S2 未获指令不得启动**，凭据消费小设计亦不得预写。

---

## 4. 纪律不变条款

1. 内核仓只读：pin `v0.2.0b7` / `a628f8b` 不动。
2. 测试基线不得回归（当前 136 passed / 2 skipped）；BUILD/VERIFY 分离。
3. 零 npm 运行时依赖；`dependencies` 保持为空；无 GPU、无真实 Provider。
4. 不得使用 `ledger_record` 或任何 setup 基建方法作为运行时路径；不得新增桥接方法面。
5. S1b 仅动 §3 列明文件；不得夹带 P2-S2 的实现（含凭据消费模型）、不得夹带 P2-3 性能优化。
6. `bridge.contract.yaml` 本次仅作枚举补登，不得改动任何既有方法签名 / 帧格式 / 握手 schema。
7. 禁止顺手优化；脱敏纪律延续。
