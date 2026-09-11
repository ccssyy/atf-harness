# ATF 独立 Harness Phase 2——S1b 执行报告

> **日期**:2026-09-11 ｜ **执行方**:zcode ｜ **切片**:S1b 收尾修复(L-1/L-2/L-3 + 边界登记,S2 前清项)
> **依据**:《ATF-Harness_Owner决议与启动指令_S1a验收_S1b收尾_20260911.md》(下称「决议」)§1.1 三项遗留 + §1.2 边界 + §2 三项裁决 + §3 修复指令
> **结论先行**:S1b 已完成。§3 清单 1–5 全部落地,3 组测试要求全过(新增包装层透传 2 用例;铁律一回归复用既有用例原样全过;冒烟文案人工核对),全量 **138 passed / 2 skipped**(S1a 基线 136/2 + 新增 2,零回归),双冒烟全过;`schema_version` 仍 1,`bridge.contract_version` 不动(枚举补登),`dependencies` 为空;本地提交未 push;**未进入 P2-S2,凭据消费小设计未预写**。

---

## 1. 执行记录(对照决议 §3 执行序列)

| 序列 | 动作 | 执行情况 |
|---|---|---|
| 1 | 阅读决议 + 现状代码/契约/ADR | ✅ 与决议无冲突,无差异需报告 |
| 2 | BUILD(§3 清单 1–5) | ✅ commit `6da6e3f`(见 §2) |
| 3 | VERIFY(3 组测试 + 基线复跑 + 双冒烟) | ✅(见 §3) |
| 4 | 产出本报告 | ✅ 本文档 |
| 5 | 本地提交、不 push;完成即停 | ✅ 未 push;未启动 P2-S2;凭据消费小设计(决议 §2.2)零预写 |

---

## 2. BUILD 改动清单(commit `6da6e3f`,7 文件 +120/−20)

| 决议 §3 项 | 落点 |
|---|---|
| 1. 退出码挪移(L-1) | `bridge.contract.yaml`:头部登记区新增「【exit 75/79 枚举补登 2026-09-11】」注释块——形态与注释风格沿用 exit 78 登记区块;75 = suspended(非终态,EX_TEMPFAIL 语义,resume 可续)、79 = aborted(终态,主动终止);**枚举补登,不改既有 0/78/1 语义,不 bump `contract_version`**;全表以该登记为准。`session.contract.yaml`:`headless_exit_codes` 节改为**指向性引用**(一句话 + 指针),同义内容不再两处并存 |
| 2. 包装层透传(L-2) | `src/session/sessionLog.ts`:`ReplayOutcome.truncated_tail` 由可选**收紧为必填**(`TruncatedTail \| null`),删除「因包装层不透传故可选」注释。`src/workspace/t0Guard.ts`(仅透传,范围放宽已由决议 §3 列明):`GuardedSessionLog.replay` 字面量补传 `truncated_tail`;新增实例 getter `truncatedTail` 委托内层。**铁律一拦截语义逐位不变**(既有 t0Guard 全量用例零改动通过) |
| 3. 冒烟文案(L-3) | `smokeP2S1.ts` 第 6 步:标题改「fsync 批量档:ack = 已写入;攒满 N 条触发 fsync 后水位线归零」,输出行改「批量档水位线归零、6 条全部落盘 ✓」;断言实质不变并补一条 `unsyncedEvents === 0` 校验(与文案语义一致,非放松) |
| 4. 边界登记(§1.2/§2.3) | `session.contract.yaml` `tail_repair.boundary`:会话流无防篡改链(hash chain),「整条尾部完整事件被连同 LF 删除」结构上不可检测,发现需外部锚(run journal 事实 / catalog sha),**已知边界非待办承诺**,Phase 2 不实现。ADR-09 §4 补第 5 条同口径登记 |
| 5. 开放点状态更新 | ADR-09 §5.3 (d) 标注「P2-S2 首发小设计(先设计后实现,owner review 通过后再实现)」+ 四条约束摘要(重启幂等 / 不新增第 13 类事件 / 禁 setup 基建 / fail-closed 优先);文末修订说明补 v1.3 行 |

---

## 3. VERIFY 验收对照(决议 §3)

### 3.1 三组测试要求

| # | 要求 | 结果 | 承载 |
|---|---|---|---|
| 1 | 包装层透传:有残段时 `truncated_tail` 可见且数值正确;无残段时 `null`(收紧闭包) | ✅ 新增 `tests/workspace/guardedTailPassthrough.test.ts` 2 用例:11 字节残段经包装 replay 报 `dropped_bytes: 11`、包装 create 后实例 `truncatedTail` 同值;干净流 replay `truncated_tail === null` | 类型收紧后 `t0Guard.ts` 字面量由编译器强制补全(决议预期生效) |
| 2 | 铁律一回归:拦截行为逐位不变 | ✅ 既有 `tests/workspace/t0Guard.test.ts` 全量用例零改动通过(rejected 拒绝不落盘 / replay blocked / S2 语义对照),未放松任何断言 | 复用,不新建 |
| 3 | 冒烟口径:第 6 步断言不变、文案更新 | ✅ `smoke:p2s1` 第 6 步输出「[6/6] fsync 批量档:ack = 已写入;攒满 N 条触发 fsync 后水位线归零 / 批量档水位线归零、6 条全部落盘 ✓」(人工核对,见复跑输出) | 人工核对项 |

### 3.2 验收标准逐项

| 标准 | 结果 |
|---|---|
| 3 组测试通过;既有 136 passed / 2 skipped 零回归 | ✅ 全量 `ATF_CLI_PATH=.atf-pinned npm test` → **`Tests 138 passed | 2 skipped (140)`**(20 文件;S1a 基线 136 + 新增 2;既有用例零改动) |
| `smoke:p2s1`、`smoke:s5` 全过 | ✅ 双冒烟通过(七项总验收含 B1–B4 全过) |
| `schema_version` 仍 1;`bridge.contract_version` 不动 | ✅ 均未变;`bridge.contract.yaml` 仅注释区块补登,变更描述标注「枚举补登,非语义变更」,无任何方法签名 / 帧格式 / 握手 schema 改动 |
| `dependencies` 为空;pin 不动 | ✅ `dependencies` 为空;`.atf-pinned` = `a628f8b` 未动 |
| `git diff` 仅覆盖 §3 列明文件 | ✅ 7 文件 = `bridge.contract.yaml`、`session.contract.yaml`、`src/session/sessionLog.ts`、`src/workspace/t0Guard.ts`、`src/session/smokeP2S1.ts`、ADR-09、新增测试——与 §3 范围清单一一对应 |

纪律条款:未夹带 P2-S2 实现(凭据消费模型零预写)、未夹带 P2-3 性能优化;未用 `ledger_record` 等基建方法;无 GPU / 无真实 Provider;脱敏纪律延续。

---

## 4. 偏离与决策点

1. **无实质偏离**。两处实现细节说明:① 冒烟第 6 步在既有断言(落盘 6 行)之外补了一条 `unsyncedEvents === 0` 断言——使断言面与新文案「水位线归零」严格一致,属收紧非放松;② `GuardedSessionLog` 透传采用显式属性补传(而非对象展开),保持 blocked 分支字面量不变,铁律一行为逐位不受影响。
2. **决议 §1.2 边界(整条尾部事件删除不可检测)已按 §2.3 双处登记**(契约 `tail_repair.boundary` + ADR-09 §4 第 5 条),措辞均为「已知边界,非待办承诺」;Phase 2 不实现 hash chain。
3. **凭据消费模型(决议 §2.2)未做任何实现或预写**,仅在 ADR-09 §5.3 (d) 完成状态登记(约束摘要四条)。

---

## 5. 提交清单(本地 main,**未 push**)

| # | commit | 内容 |
|---|---|---|
| 1 | `6da6e3f` | `fix(session,workspace): S1b 收尾——L-1 退出码挪登 / L-2 包装层透传(必填收紧) / L-3 冒烟文案 / 防篡改边界登记 + 开放点(d) 状态更新`(7 文件,+120/−20) |
| 2 | (本笔) | `docs(phase2): S1b 执行报告` + 决议文档入库(`docs(owner)` 惯例随附) |

---

## 6. 下一步建议

1. **owner review S1b**;通过后 **P2-S1 正式闭合**(S1 → S1a → S1b 三切片链完整),随后签发 **P2-S2 启动指令**。
2. P2-S2 启动指令建议一并携带的既有口径清单:ADR-09 §5.3 开放点 a/c(payload 级,新增点 d 已裁决为 S2 首发小设计)+ 决议 §2.2 四条约束(重启幂等 / 不新增第 13 类事件 / 禁 setup 基建 / fail-closed 优先)+ 批量档消费者纪律(证据级持久性消费者用逐条档或显式 flush)+ 退出码全表现在 `bridge.contract.yaml` + P2-3 性能评估项(10k 事件 append 耗时实测)。
3. 本会话不自行启动 P2-S2,完成即停。
