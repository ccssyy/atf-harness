# ATF 独立 Harness Phase 2——P2-S2 执行报告

> **日期**:2026-09-11 ｜ **执行方**:zcode ｜ **切片**:P2-S2 交互问答审批轨(门 2 BUILD)
> **依据**:《ATF-Harness_Owner决议与启动指令_P2S2门1通过_门2放行_20260911.md》(十二条预拍口径 + A1–A4 追加口径)+《ATF独立Harness_Phase2_凭据消费模型小设计_20260911.md》v1.1(生效版)+《ATF独立Harness_Phase2任务书_20260910.md》§3 + ADR-09(ACCEPTED v1.3)
> **结论先行**:门 2 BUILD 完成。原九项 + 追加七项验收全部通过;测试 **168 passed / 2 skipped**(基线 138/2 + 新增 30 用例,零回归);三条冒烟(`smoke:p2s2` / `smoke:p2s1` / `smoke:s5`)全过;性能实测 10k 事件 append p50≈2.1–2.5ms / p95≈4.1–4.8ms,BUILD 中发现并修复 1 个审计判重 bug;本地提交未 push;**未进入 P2-S3**。

---

## 1. 执行记录(对照决议 §4 执行序列)

| 序列 | 动作 | 执行情况 |
|---|---|---|
| 1 | 阅读设计 v1.1 + §3.2 十二条 + 门 2 决议 | ✅ 无冲突;A1 的 call 侧自指字段偏离见 §4.1 |
| 2 | BUILD | ✅ commit `990f894`(16 文件,+1511/−63,见 §2) |
| 3 | VERIFY(九项 + 追加七项 + 基线 + 性能) | ✅(见 §3) |
| 4 | 产出本报告 | ✅ 本文档 |
| 5 | 本地提交、不 push;完成即停 | ✅ 未 push;**未启动 P2-S3** |

## 2. BUILD 改动清单(commit `990f894`)

| 层 | 文件 | 内容 |
|---|---|---|
| session | `schema.ts` | **仅启用位推进**:enabled 9 → 11(approval/request、approval/response 移出保留位);provider/switch 仍保留位;`schema_version` 保持 1 |
| tools | `credentialState.ts`(新) | `resolveCredentialState(events, credential, context)` 四值纯函数(consumed/available/indeterminate/invalid;`request_event_ref → request → tool_call_id → tool/call` 回溯链 + `payload.call_ref` 消费配对 + `granted.id` 与 `recoveryWatermark` 比较);`findExistingCredential` 重入/恢复预检 |
| tools | `executor.ts` | `execute` 增可选 `ApprovalGate`(账本轨优先路径**零改动**;未命中且声明审批面才调 handler,异常折算结构化 block);`ToolCallOutcome` 增 suspended(75)/aborted(79) 两终态;`resolveHeadlessExitCode` 单出口扩 75/79 |
| tools | `errors.ts` | ToolBlock 原因面与退出码面扩充(approval_denied / credential_consumed / credential_invalid / credential_indeterminate / credential_persist_failed / approval_track_failed = 1;approval_timeout = 75;approval_aborted = 79;approval_missing 恒 78 不挪用) |
| run | `approvalTrack.ts`(新) | 问答轨编排器:六类应答分支(ADR-09 §1.3 逐条)、拒绝循环阈值常量 2(同提案 = tool+params_digest;被拒 2 次后第 3 次提案升级 aborted,不落伪造应答)、supersedes 演化链、clarification 同会话多轮重发、R2 持久化前置、`readStreamMaxId`(A2 水位线取值,含 repair) |
| run | `runner.ts` | `approvalSurface` 声明(缺省 = Phase 1 逐位一致);`call_ref` 写入 tool/result(R3/A1);BranchOutcome 增 suspended/aborted;`credential_indeterminate` 终态映射(failed(1) + 报告 `credential_indeterminate` 五字段);A2 水位线取值并固定 |
| run | `smokeP2S2.ts`(新) | 冒烟命令 `smoke:p2s2`(六类 + 升级 + headless 等价,8 分支) |
| 契约/文档 | `session.contract.yaml` | `approval_track` 节(双轨优先级/载荷字段/六类处置/拒绝循环/凭据消费模型/桩对端定位)+ 启用位标注;ADR-09 §5.3 **新增开放点 (e)**(幂等键前瞻,re-pin 后可谈,Phase 2 不实现不探索) |
| 测试 | 3 个新文件 + 2 处既有更新 | credentialState(11 用例)/approvalTrack handler 级(9)/approvalE2e(9);schema.test 常量断言随启用位推进更新(12/11/1) |

## 3. VERIFY 验收对照

### 3.1 原九项(《P2S1闭合_P2S2启动》§3.3)

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 六类应答正反例(含 timeout→suspended、aborted→79、clarification 多轮同会话) | ✅ e2e 6 用例 + handler 级 6 用例;每类另有反例(误杀/错配/失败注入) |
| 2 | supersedes 演化链可审计 | ✅ advised → 重提 request2.supersedes=request1 → granted;意见原文在 response 必留,可回答「最终执行基于哪条意见」 |
| 3 | 拒绝循环升级(第 3 次提案) | ✅ 两次 denied 后第 3 次提案被拦截 → aborted(79),仅落 2 条 request |
| 4 | 凭据 fails-closed | ✅ flush 失败不放行 / 旧遗留 indeterminate 终态 / consumed 拒 / invalid 拒 / 桩缺省=timeout 挂起而非执行 |
| 5 | 账本轨零改动 + headless 等价 | ✅ 既有账本用例零改动通过;未声明审批面 → 78 且不发 request |
| 6 | 退出码 0/75/78/79/1 单出口 | ✅ 均经 `resolveRunExitCode`/`resolveHeadlessExitCode` 决出,单元 + e2e 双覆盖 |
| 7 | 基线零回归 + smoke:p2s2 新增 + smoke:s5 保持 | ✅ **168 passed / 2 skipped**(138 基线 + 30 新增);三冒烟全过 |
| 8 | 门 1 通过 | ✅(已达成) |
| 9 | 依赖与 pin 纪律 | ✅ `dependencies` 空;pin `v0.2.0b7`/`a628f8b` 未动;diff 限于 A4 清单 |

### 3.2 追加七项(门 2 决议)

| # | 验收项 | 结果 |
|---|---|---|
| R1 | resume 可执行性 | ✅ 恢复后注入 granted(id > 水位线)→ available → 放行执行且不重复问询(handler 级 + 纯函数级) |
| R2 | 持久化前置 | ✅ handler 层:flush 失败 → `credential_persist_failed` 不放行;runner 侧为逐条档断言路径(见 §4.2) |
| R3 | call_ref 精确配对 | ✅ 正例(consumed)+ 反例(悬空/指向非 call/错配 → 不构成消费事实) |
| A3 | indeterminate 终态 | ✅ exit 1 + `credential_indeterminate` + 报告五字段(`approval_session_id`/`tool_call_id`/`tool`/`approval_key`/窗口区间);终局保护沿用既有收口规则(终态不被写失败覆盖) |
| A1 | 悬空 call_ref 反例 | ✅(§4.1 含 call 侧自指偏离登记) |
| A2 | watermark 固定性 | ✅ 取值含 repair、恢复后 append 不漂移;runner 打开即取值 |
| A3-2 | 终局保护 | ✅ 既有收口规则 + 单元断言(failed 先于 turn/end 写入,不被覆盖) |

### 3.3 性能实测(P2-3 登记项)

| 场景(逐条 fsync 档) | p50 | p95 | avg |
|---|---|---|---|
| 10k 事件,纯叙述负载 | 2.10ms | 4.07ms | 2.14ms |
| 10k 事件,20% 承证对(白名单最坏路径,审计判重修复后) | 2.25ms | 4.41ms | 2.29ms |

**建议**:当前量级(≥10k)**无需增量缓存优化**——每次 append 的压缩计划全量重算在 10k 规模下 p95 < 5ms,瓶颈为 fsync 本身(设计内);若未来会话规模到 10 万级,建议复测后按 P2-3 再议(本 slice 未实现优化,遵纪律 §6)。

## 4. 偏离与决策点

1. **A1 的 `tool/call` 侧自指 `call_ref` 未落盘(偏离登记)**:append-only 下事件自身 id 在写入前不可预知,而 `session` 层除 `schema.ts` 外禁改(无法暴露 nextId),回填又违反 append-only。判定仅认 result 侧(A1 原文),对称校验由判定链的「call 事件存在性检查」覆盖(invalid 拒绝路径)。契约 `approval_track.credential_consumption.pairing` 已如实登记;后续若需对称字段,属 session 层微改(留 S3 前评审)。
2. **R2 持久化前置的两条路径**:runner 会话恒为逐条 fsync 档(未注入 fsync 选项)→ 「档位断言」路径成立(ack 即 fsync);「批量档 flush 确认」由 handler 层注入测试覆盖(`SessionLog.flush` 公开口,失败不放行);批量档跨进程恢复属 Phase 3 run-resume。
3. **拒绝循环口径换算**:决议「重提 2 次即升级」实现为——attempt 1/2 各被拒 1 次(denied_count=2)后,第 3 次提案被拦截直接升级(不落 request、不落伪造应答事件),即任务书「第 3 次重提触发升级」的严格化表达;报告中说明,不视为冲突。
4. **BUILD 中发现并修复 1 个实现 bug(审计判重错位)**:折叠区间末端为白名单豁免事件时,`covers.to_id` 取「最后一条被折叠者」而非区间端点,与判重锚错位 → 同一边界重复写审计(3k 实测 1239 条 vs 应约 91 条)。修复:covers 端点取折叠区间端点(material[boundary-1]),判重稳定;回归用例固定(同边界仅一条审计)。修复后 10k 实测审计 311 条 ≈ 边界推进数。
5. **denied 换路径分支的占位守卫修正**:初始占位 outcome 为 failed kind,原守卫误判导致 denied 后不再继续;改为仅识别真实写失败(code=session_failure)。
6. **indeterminate 的测试承载层级**:Phase 2 e2e(单进程)无法自然触发 indeterminate(需跨进程恢复),以「判定函数纯函数 + handler 级注入」承载;runner 侧映射(resolveRunExitCode failed→1 + 报告五字段)单元覆盖。跨进程恢复处置属 Phase 3 run-resume。
7. **开放点 (a) 部分定形**:`approval_session_id` 采 run 内单调 `aps-<n>`(闭包计数),消费面要求(全局唯一且落盘)在 run 内满足;跨 run 全局唯一留 Phase 3。

## 5. 幂等键议题登记(决议 §2 显式交付项)

**已登记 ADR-09 §5.3 开放点 (e)**:内核方法支持幂等键(如以 `approval_key`/`request_id` 去重)→ 凭据崩溃窗口内可由「不重放 + 人工核对」升级为「安全重放」。**re-pin 后可谈项;Phase 2 不实现、不探索**。本报告为该登记的执行报告侧载体。

## 6. 提交清单(本地 main,**未 push**)

| # | commit | 内容 |
|---|---|---|
| 1 | `990f894` | `feat(tools,run): P2-S2 问答轨`(16 文件,+1511/−63,含契约与 ADR-09 (e) 登记) |
| 2 | (本笔) | `docs(phase2): P2-S2 执行报告` + 门 2 放行决议入库(`docs(owner)` 惯例随附) |

## 7. 下一步建议

1. **owner review P2-S2**,重点:§4.1(call 侧自指偏离)与 §4.5(审计判重修复)。
2. review 通过 → P2-S2 闭合,签发 **P2-S3 启动指令**(多 provider 与热切换 + R2b 评估);本会话不自行启动,完成即停。
