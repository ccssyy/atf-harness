# ATF 独立 Harness Phase 2——S1a 执行报告

> **日期**:2026-09-10 ｜ **执行方**:zcode ｜ **切片**:S1a 修复(P0-1 尾部半行策略 + P1-2 投影摘要 id + 契约措辞 + 集合 11→12)
> **依据**:《ATF-Harness_Owner决议与启动指令_P2S1验收_S1a修复_20260910.md》(下称「决议」)§2 四项裁决 + §3 修复指令
> **结论先行**:S1a 已完成。§3 清单 1–7 全部落地,7 组新测试全过,全量 **136 passed / 2 skipped**(P2-S1 基线 126/2 + 新增 10 用例;既有用例零回归),双冒烟(`smoke:p2s1` 6 步 / `smoke:s5` 七项)全过;`schema_version` 仍为 1,`bridge.contract.yaml` 未动,`dependencies` 为空;本地提交未 push;**未进入 P2-S2**(等指令)。

---

## 1. 执行记录(对照决议 §3 执行序列)

| 序列 | 动作 | 执行情况 |
|---|---|---|
| 1 | 阅读决议 + P2-S1 实现与契约 + ADR-09 §1.2 | ✅ 与决议无冲突;两处实现口径选择见 §4 |
| 2 | BUILD(§3 清单 1–7) | ✅ commit `410b4ea`(见 §2) |
| 3 | VERIFY(7 组新测试 + 基线复跑 + 双冒烟) | ✅(见 §3) |
| 4 | 产出本报告 | ✅ 本文档 |
| 5 | 本地提交、不 push;完成即停 | ✅ 未 push;**未启动 P2-S2** |

---

## 2. BUILD 改动清单(commit `410b4ea`)

| 决议 §3 项 | 落点 |
|---|---|
| 1. 半行尾巴策略(§2.1 七条) | `sessionLog.ts`:新增 `scanTailFragment`(物理判定:文件非空且不以 LF 结尾 → 末段为未确认尾部,无论内容是否可解析;紧邻残段的空行一并吸收,见 §4.1)/ `truncateTail`(UTF-8 字节精确物理截断)/ `parseLine` 仅作用于完整行——中间行不可解析、id 断裂仍 `corrupt_stream`(原语义不变);`create()` 先截断再续写;`replay()` 只读丢弃 + 报告 |
| 2. `session/repair` 事件 | `schema.ts` 集合 11→12(enabled,第 9 个启用类);截断后成对写入,payload 四字段 `dropped_bytes` / `dropped_from_offset` / `tail_excerpt`(前 64 字符)/ `tail_sha256`;留痕写失败 → `create` 返回 `err(io_error, stage=tail_repair_audit)`(fail-closed) |
| 3. `materialOf` 透明性 | 排除 `session/compaction` + `session/repair`(运维留痕不计数、不折叠、不投影);压缩计划确定性不变(透明性回归用例固定) |
| 4. 契约更新 | `session.contract.yaml`:schema_version 说明(v1 修正窗口内 11→12,不 bump)、event_types 补第 12 类、新增 `tail_repair` 节(判定/位置纪律/成对留痕/返回结构/透明性)、`durability` 节措辞修正(P2-4:两档强度不同、批量档 ack 不含断电级持久性、默认恒 per-append、新增 `consumer_discipline` 消费者纪律、`audit_note` 可重建旁注 = P3-6) |
| 5. ADR-09 一致性补句 | §1.2 投影形态纪律补第 6 条(摘要条目携带 `synthetic: true`,投影消费者按 `(id, synthetic)` 唯一识别;不改 C5 结论);文末修订说明补 v1.2 行 |
| 6. P1-2 修复 | `compaction.ts`:`LlmContextEvent` 白名单增补可选键 `synthetic?`;投影摘要条目 `{ id: anchor.id, ts, type: "session/compaction", payload: record, synthetic: true }`;`convertToLlm` 不设置该键(原文条目无标记);契约 `pipeline` 节同步 |
| 7. P2-4 / P3-6 | 随第 4 项落地(两档强度措辞 + 审计事件可重建旁注) |

返回结构(§2.1.5):`ReplayOutcome.truncated_tail?: { dropped_bytes, dropped_from_offset } | null`(会话层 `SessionLog.replay` 恒显式赋值;可选化的原因见 §4.3);`create` 修复事实经实例属性 `SessionLog.truncatedTail` 携带(原因见 §4.4),包装层透传收紧属 S2 run 层。

---

## 3. VERIFY 验收对照(决议 §3)

### 3.1 七组新测试(全部通过)

| # | 测试组 | 承载 | 关键断言 |
|---|---|---|---|
| 1 | 伪造半行尾 `\n{"id":13,"ty` | `tailRepair.test.ts` | replay 成功、`truncated_tail.dropped_bytes = 13`(含紧邻空行)、replay 后文件未动;create 截断续写后流 id 1–14 连续、repair 事件在位、无残留坏行 |
| 2 | 更短残段 `{"i` | 同上 | 同策略容忍 + 修复,replay 幂等 |
| 3 | 中间损坏回归 | 同上 | 中间第 5 行坏 JSON(保留 LF)→ replay/create 均 `corrupt_stream`;另补「完整行坏 JSON 以 LF 结尾位于流末」仍 `corrupt_stream`(容忍不越界) |
| 4 | repair 留痕成对性 | 同上 | payload 四字段齐备且值正确(excerpt/sha256 与残段逐字节对应);留痕写失败 → create 上报 `io_error`,文件已截断但无 repair 事件(注入手段见 §4.2) |
| 5 | 透明性回归 | 同上 | 含 `session/repair` 的序列与不含的序列,`planCompaction` 与 `transformContext` 逐条一致,不进入投影 |
| 6 | 投影 id 语义(P1-2) | `compaction.test.ts` | anchor 命中白名单时摘要(synthetic=true)与原文并存于同 id,全投影 `(id, synthetic)` 组合唯一 |
| 7 | 两档崩溃用例扩展 | `fsyncCrash.test.ts` | 保留既有 SIGKILL 用例;新增 it.each 两档:kill 后注入半行尾 → replay 容忍 + create 截断留痕 + 修复后流干净 |

### 3.2 验收标准逐项

| 标准 | 结果 |
|---|---|
| 7 组测试全过 | ✅(§3.1) |
| 既有 126 passed / 2 skipped 零回归 | ✅ 全量 `ATF_CLI_PATH=.atf-pinned npm test` → **`Tests 136 passed | 2 skipped (138)`**(19 文件,2.85s;P2-S1 基线 126 + 新增 10)。既有用例中 4 处按裁决更新的说明见 §4.5 |
| `smoke:p2s1` 与 `smoke:s5` 全过 | ✅ smoke:p2s1 扩为 6 步(新增半行修复演示);smoke:s5 七项总验收全过 |
| `schema_version` 仍 1;`bridge.contract_version` 不动;`dependencies` 空 | ✅ v1 修正窗口内 11→12(决议 §2.1.6);`bridge.contract.yaml` 零改动;`dependencies` 为空 |
| 无伪造半行时与 P2-S1 现状逐位一致 | ✅ 完整流(每行 LF 结尾)路径 `scanTailFragment` 直接返回 `tail = null`,解析路径与 P2-S1 完全相同 |

纪律条款:内核仓只读(pin `v0.2.0b7`/`a628f8b` 未动);未用 `ledger_record` 等基建方法;未新增桥接方法面;未动 compaction 算法语义与 durability 机制;P2-3 性能优化未夹带(留 S2 评估)。

---

## 4. 偏离与决策点

1. **紧邻残段的空行一并吸收为未确认尾部**:指令测试向量 `\n{"id":13,"ty` 会在残段前引入一个空行;若只吸收残段本身,该空行将落入「中间空行 = corrupt_stream」规则使向量失败。故判定为:残段及其紧邻空行同属未确认尾部、一并丢弃(`dropped_bytes` 相应含空行字节,测试按 13 断言)。契约 `tail_repair.judgement` 已登记。**纯物理判定原则不变:无结尾 LF 即未确认,不尝试解析 salvage**(裁决 §2.1.1 支 1)。
2. **「留痕写失败」用例的注入手段**:`vi.spyOn(SessionLog.prototype, "append")` 单次返回 err——纯测试技术,产品代码无注入缝、无新增配置面。
3. **`ReplayOutcome.truncated_tail` 为可选字段**(`?: TruncatedTail | null`):包装层 `GuardedSessionLog`(`src/workspace/`,S1a 范围外)以字面量构造 replay 结果、不透传新字段,必填化将破坏 typecheck;会话层 `SessionLog.replay` 恒显式赋值(null 或对象),语义完整。透传收紧随 S2 run 层落地。
4. **`create` 修复事实经实例属性 `truncatedTail` 携带**:同理,`GuardedSessionLog.create` 依赖 `Result<SessionLog, …>` 签名(范围外),不改返回类型;决议「create 结果需显式携带」以实例只读属性兑现。
5. **既有损坏用例的向量修正(4 处,均有裁决依据)**:① 常量断言 11→12/启用 8→9(§2.1.6);② 空文件 `toEqual` 补 `truncated_tail: null`(返回结构扩展);③ 「末行残缺 → 一律 err」用例按 P0-1 裁决翻转为容忍语义(该用例断言的正是被推翻的行为);④ `createAndWrite` helper 统一补结尾 LF——P2-S1 时代手写流向量为无 LF 形态,在新判定下整段成为未确认尾部;补 LF 后这些用例的测试意图(坏行/越权 type/提前激活/id 断裂 → fail-closed)原样保留,对应「完整流行为逐位一致」验收条款。
6. **smoke:p2s1 增加第 6 步**(伪造半行 → 截断 + 留痕演示),决议 §3 范围条款「smokeP2S1(如需)」。

---

## 5. 提交清单(本地 main,**未 push**)

| # | commit | 内容 |
|---|---|---|
| 1 | `410b4ea` | `fix(session): S1a 修复——P0-1 尾部半行策略 / P1-2 投影摘要 synthetic / 契约 v1 修正(11→12)与 durability 措辞 / ADR-09 §1.2 补句`(11 文件,+504/−46) |
| 2 | (本笔) | `docs(phase2): S1a 执行报告` + 决议文档入库(`docs(owner)` 惯例随附) |

---

## 6. 下一步建议

1. **owner review S1a**,重点:§4.1 空行吸收判定与 §4.5 既有用例向量修正的处置。
2. review 通过 → P2-S1 连同 S1a 闭合,签发 **P2-S2 启动指令**;S2 任务书建议同时携带:ADR-09 §5.3 开放点 a/c/d、决议 §2.1(应答即授权凭据)、§2.2 三条件(消费者纪律对 suspended/resume 状态推进的约束)、§2.3(退出码 75/79 挪移 `bridge.contract.yaml` + `session.contract.yaml` 节改为指向性引用)、P2-3 性能评估项(10k 事件下单次 append 耗时实测)。
3. 本会话不自行启动 P2-S2,完成即停。
