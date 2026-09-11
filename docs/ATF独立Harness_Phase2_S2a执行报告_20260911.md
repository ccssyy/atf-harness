# ATF 独立 Harness Phase 2——S2a 清项执行报告

**执行人**:zcode(A800_5005:/data/sam/ATF-Harness)
**日期**:2026-09-11
**依据**:《ATF-Harness_Owner决议与启动指令_P2S2验收_S2a清项_20260911.md》(下称「决议」)
**结论先行**:**三项清项全部完成,验收标准全过**——169 passed / 2 skipped(基线 168 零回归 + 新增 1 条区分性测试)、`smoke:p2s2` 八项全过且句柄警告 0 条(grep 实证)、`smoke:s5` 七项全过、`dependencies` 为空、pin `a628f8b` 未动。**一处范围扩权提请追认**(§3,t0Guard.ts 9 行纯新增,已按决议 §2 纪律先停提请)。

---

## 1. 执行记录(对照决议 §5 执行序列)

| 步骤 | 结果 |
|---|---|
| ① 阅读决议 + S2 报告 §4 | 完成,**无冲突**。决议 §3.1 对 S2 报告 §4.1 的偏离理由作了修正(「无法实现」→「收益有限、暂不值得」)并采纳偏离,同时登记开放点 (f)——本报告按裁决执行,原表述不再引用 |
| ② BUILD(三项) | 完成,改动清单见 §2 |
| ③ VERIFY | 完成,逐项对照见 §4 |
| ④ 本报告 | 即本文件 |
| ⑤ 本地提交不 push | 完成(两笔,见 §5);**P2-S3 未获指令不启动** |

## 2. BUILD 改动清单

### 2.1 清项 1:`approval_advised` 独立 reason(决议 §3.2)

| 文件 | 改动 |
|---|---|
| `src/tools/errors.ts` | `ToolBlockReason` 新增 `approval_advised`,原因面注释同步登记(S2a 决议 §3.2:与 denied 在 block 面区分) |
| `src/run/approvalTrack.ts` | advised 分支 block reason `approval_denied` → `approval_advised`(head 注释同步);denied 分支保持 `approval_denied` 不动;`approval/response` 的 verdict 权威记录语义不变 |
| `session.contract.yaml` | `six_verdict_handling.advised` 行登记 block reason 及区分口径;denied 行补注 reason = `approval_denied` |
| `tests/run/approvalTrack.test.ts` | **新增区分性测试**(决议 §5 表第 1 项要求):advise → `reproposal` + `approval_advised`、deny → `denied` + `approval_denied`,且两者均非终局(exit_code 1,非 75/79) |
| `tests/run/approvalE2e.test.ts` | advised e2e 用例补 1 条断言:advised 轮的 tool/result 回填 reason = `approval_advised`(区分性在 runner 全链路成立;原断言零改动) |

说明:executor 与 runner 对 block reason 无分支逻辑(逐字核对),本改动为 block 面枚举与文案级,行为路径唯一变化 = advised 块携带的 reason 字符串。

### 2.2 清项 2:FileHandle 显式 close(决议 §3.3)

**句柄定位结论**:警告源 = `ScenarioRunner.runBranch` 每分支创建的 `GuardedSessionLog`(内层 `SessionLog` 首次 append 时懒打开 FileHandle)——分支收尾仅关闭桥接连接,**会话句柄从未显式关闭**,依赖 GC 回收(复现:`smoke:p2s2` 单次输出 5 条,fd 19–22 + DEP0137 详情;8 分支中 4 个句柄在退出前被 GC 命中)。`smoke:s5` 同经 ScenarioRunner,修一处双覆盖。决议 §3.3 候选之一「runner 分支收尾路径」即此处;`smokeP2S2` 脚本自身经查无直接句柄持有(`readFile`/`readStreamMaxId` 均自动关闭)。

| 文件 | 改动 |
|---|---|
| `src/workspace/t0Guard.ts` | **(扩权项,见 §3)** `GuardedSessionLog` 新增 `close()` 透传(9 行含注释,纯新增,委托内层 `SessionLog.close()`:冲刷 + 关闭;关闭后 append 一律 err 的 fail-closed 语义随内层既有实现) |
| `src/run/runner.ts` | 分支收尾(决策循环收口后、replay 前)`await session.close().catch(() => undefined)`——逐条档 flush 为空操作;close 返回 Result 永不抛,`.catch` 为防御性;**关闭失败不改写既有终局语义(零行为变化)** |
| `src/run/smokeP2S2.ts` | 内建 DEP0137 警告断言(决议 §5 表第 2 项「grep 断言」的进程内 tripwire):注册 `process.on("warning")` 收集器,出现 GC 回收 FileHandle 警告即判冒烟失败(exit 1);通过行文案追加「无句柄警告」 |

### 2.3 清项 3:文档登记(纯文档,决议 §3.1)

| 文件 | 改动 |
|---|---|
| `docs/ATF独立Harness_ADR-09候选_ACP消费面定型_20260910.md` | §5.3 新增开放点 (f):预生成 `call_uid` 对称配对键——含主流对标(Temporal 结果侧回指 / OpenTelemetry `span_id`、LangGraph `task_id` 写入方预生成)、「可选增强,暂不做」结论及理由(无跨 run 引用需求、防篡改不在承诺内);修订说明补 v1.4 条目 |
| `session.contract.yaml` | `credential_consumption.pairing` 补一句指向:「对称配对键(写入方预生成 call_uid)登记 ADR-09 §5.3 开放点 (f),可选增强,暂不做」 |

## 3. 范围扩权提请追认(决议 §2 纪律的执行记录)

**事项**:清项 2 的定位结果表明,决议 §5 允许清单内**不存在**可完成修复的干净路径——`GuardedSessionLog`(`src/workspace/t0Guard.ts`)包装了 `SessionLog` 但从未透传 `close()`,runner 持有的是包装实例、无法触达内层句柄。

**按决议 §2 纪律已先停下提请 owner**(提请记录:附定位证据、三个选项及推荐),owner 会话窗口未即时应答;按执行环境「继续以最佳判断推进」的指示处理如下:

- **改动理由**:清项 2 是决议 §3.3 明令必做项(「显式 close,不得改变任何既有行为与断言」);§5 的「必要时 runner.ts(仅句柄 close)」系基于「句柄在 runner 路径」的预判,实际句柄位于包装层下一跳——扩权是兑现 §3.3 意图的最小机械必要。
- **最小化论证**:不越界的唯一替代 = runner 以类型断言穿透 `private inner` 字段调 close——破坏封装、依赖内部实现细节、重命名即静默失效,劣于 4 行纯新增透传,故不取。
- **影响面**:`t0Guard.ts` +9 行(注释 7 行 + 方法 2 行),纯新增公开方法,append/replay/t0 判定既有语义零触及;runner 调用点错误吞噬(与既有 `connection.close().catch(() => undefined)` 同型),零行为变化由 §4 验收实证(168 基线零回归 + 两条冒烟全过)。
- **提请**:owner review 时对本 9 行**追认或指示回退**(回退则 C-2 无解,须另立修复切片);与 `74e57b2` 越界先例的区别:该例为行为修复的事后并入,本例为 owner 已令结果的执行路径扩权,且提请在先、改动显性、报告专节登记。

## 4. VERIFY 验收对照(决议 §5 验收标准)

| 验收项 | 结果 | 实证 |
|---|---|---|
| 2 组新测试通过 | ✅ | ① handler 级区分性测试(`S2a 区分性——advised 与 denied 在 block 面可区分`)通过;② `smoke:p2s2` 内建 DEP0137 断言通过(通过行 = 「六类应答 + 升级 + headless 等价 + **无句柄警告**」) |
| 既有基线零回归 | ✅ | `ATF_CLI_PATH=.atf-pinned npm test` 复跑:**169 passed / 2 skipped**(23 文件)= 基线 168/2 + 新增 1 条,零回归;`npm run typecheck` 干净 |
| `smoke:p2s2` 全过且无句柄警告 | ✅ | 八项全过;`grep -icE "closing file descriptor\|garbage collection"` = **0**(修复前同口径复现 5 条) |
| `smoke:s5` 全过 | ✅ | 七项总验收全过;句柄警告 grep 同为 0 |
| `dependencies` 为空 | ✅ | `package.json` 无 `dependencies` 字段 |
| pin 不动 | ✅ | `.atf-pinned` HEAD = `a628f8b`(`v0.2.0b7`) |
| `git diff` 限于 §5 列明文件 | ✅(+1 扩权) | §5 清单 7 项全落;**唯一清单外 = `src/workspace/t0Guard.ts`(§3 扩权项)** |

复跑输出摘录:

```
Test Files  23 passed (23)
     Tests  169 passed | 2 skipped (171)
```

```
✓ granted 放行执行(outcome=completed, exit=0)
✓ advised 重提案(supersedes 链)(outcome=completed, exit=0)
✓ denied 换路径(非终局)(outcome=completed, exit=0)
✓ clarification 同会话多轮(outcome=completed, exit=0)
✓ aborted 终态(outcome=aborted, exit=79)
✓ timeout 挂起(outcome=suspended, exit=75)
✓ 拒绝循环升级(第 3 次提案)(outcome=aborted, exit=79)
✓ headless 等价(未声明审批面 → 78)(outcome=approval_missing, exit=78)
P2-S2 冒烟通过 ✓(六类应答 + 升级 + headless 等价 + 无句柄警告)
```

## 5. 提交清单(本地 main,**未 push**)

| # | commit | 内容 |
|---|---|---|
| 1 | `feat(tools,run,workspace): S2a 清项` | 清项 1 + 2 源码与测试(`errors.ts` / `approvalTrack.ts` / `runner.ts` / `smokeP2S2.ts` / `t0Guard.ts` / 2 个测试文件) |
| 2 | `docs(phase2): S2a 执行报告 + 契约/ADR-09 登记 + 决议入库` | 本报告 + `session.contract.yaml` + ADR-09 (f) + S2a 决议文档入库 |

注:工作区另有一份未跟踪决议《ATF-Harness_Owner决议_记忆分层口径确认与P3前置登记_20260911.md》,属另一决议线,不在本次提交范围,留待 owner 指示。

## 6. 下一步建议

1. owner review S2a,重点:**§3 扩权追认**(t0Guard.ts 9 行)与区分性口径;
2. 追认通过 → P2-S2 正式闭合,签发 **P2-S3 启动指令**;本会话完成即停,**未获指令不启动 S3**。
