# ATF-Harness Owner 决议与启动指令——P2-S1 验收（含 P0 修正）+ S1a 修复切片启动

**签发人**：owner
**日期**：2026-09-10
**执行人**：zcode（A800_5005:/data/sam/ATF-Harness）
**依据**：《ATF-Harness_Owner决议与启动指令_D1闭合_P2S1启动_20260910.md》+《ATF独立Harness_Phase2任务书_20260910.md》§2 + ADR-09（ACCEPTED）+ P2-S1 产出（`93b1a88` 实现 / `04af91f` 执行报告）
**结论先行**：**P2-S1 主体质量达标（八条设计要求、六项验收、126/2 零回归），但存在一处 P0（尾部半行策略缺失）与一处 P1（投影摘要 id 复用），P2-S1 暂不闭合；先出 S1a 修复切片，验收通过后再启 P2-S2。四项裁决已定。**

---

## 1. P2-S1 验收复核（owner 独立核验，非转述）

| 验收项 | 复核方式 | 结果 |
|---|---|---|
| 测试基线 | **owner 复跑**（21:40，`ATF_CLI_PATH=.atf-pinned npm test`） | ✅ `126 passed / 2 skipped`（18 文件，2.82s）——Phase 1 基线 109/2 + 新增 17，零回归 |
| 依赖纪律 | owner 直读 `package.json` | ✅ `dependencies` 为空；仅新增 `smoke:p2s1` 脚本 |
| 内核只读 | **owner 复核** `.atf-pinned` HEAD | ✅ `a628f8b` 未动 |
| 改动面 | **owner 复核** `diff --stat` | ✅ `src/session/`（5 改 2 新）+ `session.contract.yaml` + 测试（2 新 1 改）+ fixtures + `package.json`；未动 bridge / tools / workspace / llm / run |
| schema v1 实现 | owner 直读 `schema.ts` | ✅ 白名单 11 类；enabled 8 类；保留位 3 类**写入拒 + 落盘流出现拒**（`validateEventEnvelope` 第 129–135 行），与口径 #1 一致 |
| compaction 实现 | owner 直读 `compaction.ts` | ✅ 纯函数化（`planCompaction`/`computeCompactionWhitelist`/`buildCompactionRecord`/`projectContext`）；白名单含 tool/call ↔ tool/result 配对豁免；审计事件对算法透明（`materialOf`） |
| durability 双档 | owner 直读 `sessionLog.ts` 第 345–384 行 | ✅ 逐条档 write + fsync 后 ack；批量档 write 即 ack + N/T 双触发攒批 fsync；`unsyncedEvents` 暴露水位线；timer `unref` |
| 禁止 setup 基建作运行时路径 | owner 复核 `grep ledger_record` | ✅ 未出现在 `src/session/` |
| 提交纪律 | `git log` | ✅ 四笔本地提交（`c50f3d6`/`78af9fa`/`93b1a88`/`04af91f`），未 push |

**通过项（予以确认，S1a 不得改动其语义）**：schema v1 集合与拒写纪律、compaction 算法（触发指标/保留窗/chunk 滞后/白名单/审计透明性设计）、durability 双档机制、`convertToLlm` 白名单投影、fail-closed 路径（resolver 故障不落盘、close 后拒写）。

**不通过项**：P0-1、P1-2（见 §1.1/§1.2）。

### 1.1 P0-1：尾部半行（torn write）策略缺失

**事实链**（owner 核到行）：`splitLines`（`sessionLog.ts` 465–471）把末尾无 LF 的残段当完整行交给 `parseLine`；`JSON.parse` 失败即 `err(corrupt_stream)`（444–446）。`replay()` 与 `create()` 共用该路径 → **一条半行尾巴导致整个会话日志不可 replay、不可续写**（`create` 亦失败）。

**后果（两处硬冲突）**：
1. 契约 `durability` 节自述批量档「可容忍丢尾部」，实际语义是「尾部不完整 ⇒ 全流报废」；
2. ADR-09 C3 承诺「宿主进程崩溃重启后经 run_id 重挂事件流恢复消费」，且 P2-S2 `suspended → resume` 必须先 `create`/`replay` 该 run 会话——半行尾巴会让两条承诺同时失效，而这恰是 fsync 存在的目标场景。

**测试为何未暴露**：`fsyncCrash.test.ts` 仅用 SIGKILL（页缓存保留、write 必然完成，天然不产生半行），断言「id 连续无半行」属同义反复；无任何伪造半行尾的用例。

### 1.2 P1-2：投影摘要复用 anchor 事件 id

`compaction.ts` 216–217 行摘要条目取 `{ id: anchor.id }`，而 223 行可能以同一 id 输出白名单豁免的 anchor 原文 → 投影内出现重复 id，按 id 消费投影者产生歧义。

### 1.3 P2 级登记（不阻塞，登记不改）

| # | 事项 | 处理 |
|---|---|---|
| P2-3 | 每次 `append` 全量重算压缩计划（`planCompaction`+`materialOf`+白名单，白名单最坏 O(n²)） | 登记为 S2 评估项：S2 报告需给出实测数据（如 10k 事件下单次 append 耗时），据此决定是否做增量缓存 |
| P2-4 | 契约 `durability` 节称两档「承诺同强度」，与批量档 ack 语义不符 | 随 S1a 修正措辞（§3 清单第 4 项） |
| P3-5 | 保留位类型在 S2/S3 启用时会改变 `isEnabledEventType` 集合 | S2 变更描述中标注（登记，无动作） |
| P3-6 | 批量档下 `session/compaction` 审计事件同样仅到 write 级 | 契约旁注一句说明「摘要可由算法确定性重建」（S1a 随措辞一并补） |

---

## 2. 四项裁决

### 2.1 尾部半行策略：容忍 + 截断留痕（P0-1 处置）

**正式口径**：

1. **判定**：文件末尾存在**不完整记录**（末段无结尾 LF，或末段 JSON 解析失败且位于文件末尾）→ 判为「未确认尾部」，**不**视为 `corrupt_stream`。
2. **位置纪律**：容忍**仅限文件末尾**；中间行不可解析 / id 断裂，仍 fail-closed `corrupt_stream`（原语义不变）。
3. **动作**：`replay()` 与 `create()` 均按同一策略丢弃该残段；**`create()` 必须先完成截断修复再续写**（否则坏行滞留流中，造成永久损坏）。截断只作用于从未被 ack 过的残段，不触及任何已确认事件。
4. **留痕（成对动作）**：截断后必须写入一条 `session/repair` 审计事件，payload 含 `dropped_bytes`、`dropped_from_offset`、`tail_excerpt`（末段前若干字符）、`tail_sha256`。**截断与留痕必须成对**：留痕写失败 → 该次修复失败并上报（fail-closed）。
5. **返回结构**：`ReplayOutcome` 与 `create` 结果需显式携带该事实（如 `truncated_tail: { dropped_bytes, dropped_from_offset } | null`），供上层（S2 起为 run 层）登记与审计。
6. **新增事件类型（口径 #1 的定义修正，非第二次 bump）**：schema v1 集合由 **11 类 → 12 类**（新增 `session/repair`，enabled）。依据：**P2-S1 尚未闭合，v1 仍在修正窗口内**，故该增补属 v1 定义修正，不构成 v1→v2。同步更新 `SESSION_EVENT_TYPES`（12）、`SESSION_ENABLED_EVENT_TYPES`（9）、契约 `event_types` 与 `schema_version` 说明。
7. **对计划透明**：`materialOf` 需明确排除 `session/compaction` 与 **`session/repair`**（运维留痕非对话内容，不参与折叠、不计入触发指标、不进入投影），并补测试固定该语义。

### 2.2 批量档 fsync 语义改判：批准（附三条件）

**批准**「批量档 ack = write 完成，持久化确认点 = 刷盘水位线」为正式口径。owner 推演确认该改判是批量档唯一自洽语义（顺序 await 下「ack 等自己的刷盘 + 攒 N 条触发」必死锁；若改为「ack 等覆盖自己的 fsync」，T 毫秒窗口会给每条事件叠加最多 T 的延迟，顺序写场景吞吐反低于逐条档）。

**附三条件**：
1. **不得为默认档**：默认恒为 `per-append`（常量与契约双处声明）。
2. **契约必须明写两档强度不同**（不得再出现「承诺同强度」表述）：批量档 ack **不含**断电级持久性。
3. **消费者纪律**：任何需要证据级持久性的消费者（P2-S2 的 `suspended`/`resume` 状态推进、未来 TEM 回灌）**必须**使用 `per-append` 档或显式 `flush()` 后再推进状态。

### 2.3 退出码 75/79 登记位置：挪至 `bridge.contract.yaml`

**裁决**：exit code 属进程/运行面语义，Phase 1 的 exit 78 登记先例即在 `bridge.contract.yaml`；该节**不应**留在会话契约。S1a 不动该处（避免扩大 S1a 范围），**挪移随 P2-S2 一次完成**：`bridge.contract.yaml` 补登 75/79（枚举补登，不 bump `contract_version`），`session.contract.yaml` 的 `headless_exit_codes` 节改为指向性引用或移除。

### 2.4 修复时序：先出 S1a，再启 P2-S2

**裁决**：P2-S1 暂不闭合。先出 **S1a 修复切片**（P0-1 + P1-2 + 契约措辞 + 集合 11→12），验收通过后再签发 P2-S2 启动指令。理由：P0-1 修的是 S1 交付物本身的恢复语义，而 S2 的 resume 语义直接建立其上；留到 S2 修会造成「S2 未开工先背 S1 的债」。

---

## 3. S1a 修复指令

**范围（最小改动，不得夹带）**：`src/session/`、`session.contract.yaml`、会话测试、`smokeP2S1`（如需），以及 ADR-09 的一处一致性补句（第 5 项）。

| # | 改动 | 要点 |
|---|---|---|
| 1 | 半行尾巴策略 | 按 §2.1 全部七条实现；`splitLines`/`parseLine` 区分「末尾残段」与「中间损坏」；`create` 先修复后续写 |
| 2 | `session/repair` 事件 | 新增第 12 类；截断后成对写入；payload 四字段；留痕失败 = 修复失败上报 |
| 3 | `materialOf` 透明性 | 排除 `session/compaction` + `session/repair`；不得影响既有压缩计划的确定性 |
| 4 | 契约更新 | `schema_version` 说明与 `event_types` 补第 12 类（标注 enabled）；`durability` 节措辞修正（两档强度不同 + 消费者纪律 + 审计事件可重建旁注）；新增/更新 tail 修复小节（判定、位置纪律、成对留痕、返回结构字段） |
| 5 | ADR-09 一致性补句 | §1.2 投影形态纪律补一条：摘要条目携带 `synthetic: true` 标记；并注明投影消费者应接受该标记（不改 C5 三层白名单结论） |
| 6 | P1-2 修复 | 投影摘要条目改为 `{ id: anchor.id, ts: anchor.ts, type: "session/compaction", payload: record, synthetic: true }`；同步 `LlmContextEvent` 白名单与契约 `pipeline` 节 |
| 7 | P2-4/P3-6 | 随第 4 项契约修改一并落地 |

**新增测试（必须，不得以既有用例代替）**：

1. **伪造半行尾**：在流末写入 `\n{"id":13,"ty` → `replay` 成功、`truncated_tail` 非空、丢弃字节数正确；`create` 成功截断续写，续写后流 id 连续且无残留坏行；
2. **伪造截断尾（更短残段）**：仅写入半个字段 → 同上；
3. **中间损坏回归**：把中间第 5 行改为非法 JSON → 仍 `corrupt_stream`（容忍不得越界到中间）；
4. **repair 留痕成对性**：截断后存在 `session/repair` 事件且 payload 四字段齐备；留痕写失败路径有对应用例；
5. **透明性回归**：含 `session/repair` 的序列与不含的序列，压缩计划与投影逐条一致；
6. **投影 id 语义**：构造 anchor 同时命中白名单的用例，断言投影条目可按 `(id, synthetic)` 唯一识别，无歧义重复；
7. **两档崩溃用例扩展**：保留既有 SIGKILL 用例，并在 kill 后人为注入半行尾，验证修复路径。

**验收标准**：

- 上述 7 组测试全过；**既有 126 passed / 2 skipped 零回归**（复跑输出随报告）；`smoke:p2s1` 与 `smoke:s5` 全过；
- `schema_version` 仍为 **1**（v1 定义修正，不 bump）；`bridge.contract_version` 不动；`dependencies` 仍为空；
- 无伪造半行时的行为与 P2-S1 现状逐位一致（容忍策略不得改变「完整流」的处理路径）。

**执行序列**：

1. 阅读本指令 + P2-S1 实现与契约 + ADR-09 §1.2；
2. BUILD（§3 清单 1–7）；
3. VERIFY（7 组新测试 + 基线复跑 + 两条冒烟）；
4. 产出《ATF独立Harness_Phase2_S1a执行报告_20260910.md》（执行记录 / 验收对照 / 偏离与决策点 / 提交清单）；
5. **本地提交，不 push**；完成即停——**P2-S2 未获指令不得启动**。

---

## 4. 纪律不变条款

1. 内核仓只读：pin `v0.2.0b7` / `a628f8b` 不动。
2. 测试基线不得回归（当前 126 passed / 2 skipped）；BUILD/VERIFY 分离。
3. 零 npm 运行时依赖；`dependencies` 保持为空。
4. 无 GPU、无真实 Provider、无网络模型调用。
5. 不得使用 `ledger_record` 或任何 setup 基建方法作为运行时路径；不得新增桥接方法面。
6. S1a 仅动 §3 列明文件；`bridge.contract.yaml` 本期不动（退出码挪移属 S2）。
7. 不改 compaction 算法语义（仅摘要 id 标记）、不改 durability 机制（仅措辞与消费者纪律）。
8. 禁止顺手优化；S1a 不得夹带 P2-3 的性能优化（该事项按 §1.3 走 S2 评估）。
9. 脱敏纪律延续。
