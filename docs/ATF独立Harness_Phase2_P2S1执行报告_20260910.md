# ATF 独立 Harness Phase 2——P2-S1 执行报告

> **日期**:2026-09-10 ｜ **执行方**:zcode ｜ **切片**:P2-S1 会话能力升级(compaction + fsync + schema v1)
> **依据**:《ATF-Harness_Owner决议与启动指令_D1闭合_P2S1启动_20260910.md》(下称「决议」)+《ATF独立Harness_Phase2任务书_20260910.md》§2 + ADR-09 §1.2(C4/C5)
> **结论先行**:P2-S1 已完成。任务书 §2 八条设计要求全部落地、六项验收全部通过;测试基线 **126 passed / 2 skipped**(Phase 1 基线 109/2 + 本 slice 新增 17 用例,零回归);冒烟命令 `smoke:p2s1` 与既有 `smoke:s5`(七项总验收)全过;改动面严格限于 `src/session/` + `session.contract.yaml` + 测试,未 push;**未进入 P2-S2**(等指令)。
> **最重要的一项实质决策**:批量档 fsync 语义在 BUILD 中发现初版设计死锁,已改判为「write 即 ack + 刷盘水位线」(详见 §4.1),契约同步登记。

---

## 1. 执行记录(对照决议 §4 执行序列)

| 序列 | 动作 | 执行情况 |
|---|---|---|
| 1 | 阅读任务书 §2 + 决议 + ADR-09 §1.2 | ✅ 与决议无冲突;差异仅有两处口径落点选择(见 §4.3/§4.4) |
| 2 | D1 修订版(v1.1)入库 + 决议入库 | ✅ `c50f3d6`(v1.1 升格 ACCEPTED,严格按决议 §3 十一处)+ `78af9fa` |
| 3 | BUILD:`src/session/` 实现 | ✅ commit `93b1a88`(见 §2) |
| 4 | VERIFY:六项验收 + 基线复跑 | ✅(见 §3),复跑输出 `Tests 126 passed | 2 skipped (128)` |
| 5 | 产出本报告 | ✅ 本文档 |
| 6 | 本地提交、不 push;完成即停 | ✅ 未 push;**未启动 P2-S2** |

---

## 2. BUILD 改动清单(commit `93b1a88`)

| 文件 | 改动 |
|---|---|
| `src/session/schema.ts` | schema **v0 → v1 显式 bump**:白名单 11 类一次定死(口径 #1);`SESSION_ENABLED_EVENT_TYPES` 8 类(可写入)+ `SESSION_RESERVED_EVENT_TYPES` 3 类(approval/request、approval/response、provider/switch 保留位,写入与落盘流出现一律 `err(schema_violation)`);`hasDomainRefs` 迁入(见 §4.5) |
| `src/session/constants.ts`(新) | 压缩触发常量:`COMPACTION_TRIGGER_EVENTS=128`、`COMPACTION_TRIGGER_TOKENS=24000`、`TOKEN_ESTIMATE_DIVISOR=2`、`COMPACTION_KEEP_RECENT=32`、`COMPACTION_CHUNK=32`;fsync 常量:`FSYNC_DEFAULT_MODE="per-append"`、`FSYNC_BATCH_MAX_EVENTS=32`、`FSYNC_BATCH_WINDOW_MS=50`——全部收在常量层,模型不可见,初值理由见代码注释与契约登记 |
| `src/session/compaction.ts`(新) | 压缩纯函数:`planCompaction`(双指标触发、CHUNK 粒度滞后推进、KEEP_RECENT 保留窗)、`computeCompactionWhitelist`(domain_refs 命中 + tool/call↔同名工具最近配对 tool/result 因果链豁免)、`buildCompactionRecord`(确定性摘要)、`projectContext`(投影 = [摘要]+[白名单豁免原文]+[保留窗原文]);`convertToLlm`/`LlmContextEvent` 迁入本模块(pipeline 原样再导出,公开 API 不变) |
| `src/session/pipeline.ts` | `transformContext` 签名不变,实现由拼接占位升级为压缩投影;未触发时行为 = v0 语义原样 |
| `src/session/sessionLog.ts` | ① durability 双档:逐条档 write+fsync 后 ack;批量档 write 即 ack、fsync 在 N 条 / T 毫秒边界异步补做(`unsyncedEvents` 暴露水位线,`flush()`/`close()` 可显式推进);② 内存 history(create 时从既有流装载);③ 压缩审计自动落盘(`session/compaction`,按 `covers.to_id` 判重,同一边界只记一次;审计失败按写路径失败上报) |
| `src/session/index.ts` / `errors.ts` | 公开出口补新符号(常量/压缩/保留位/FSync 选项);错误码注释更新 v1 |
| `session.contract.yaml` | `schema_version: 1`;event_types 11 类登记(enabled/reserved 标注);新增 `compaction` 节(触发指标+初值理由+算法+审计)、`migration` 节(v0→v1 向后兼容)、`durability` 重写(两档契约+确认点)、`headless_exit_codes` 节(决议 §2.2 枚举补登,见 §4.3);pipeline 节更新 v1 行为 |
| `tests/session/schema.test.ts` | v0 常量断言随 bump 更新为 v1(原用例意图保留);新增保留位拒写 / 保留位出现于落盘流拒 replay / v0 流迁移 replay 三组用例 |
| `tests/session/compaction.test.ts`(新) | 触发正反例、token 兜底、滞后推进、白名单豁免(含因果链)、审计留痕判重、**审计透明性**(含审计的 replay 序列与不含审计的内存序列投影逐条一致)、重建一致性 |
| `tests/session/fsyncCrash.test.ts`(新)+ `tests/fixtures/p2s1_fsync_child.mjs`(新) | 双档崩溃恢复(子进程逐条 append,父进程收 k 个 ack 后 SIGKILL → replay 校验确认点内事件无缺失、id 连续无半行)+ 双档写入时机单测 + close 后拒写 |
| `src/session/smokeP2S1.ts`(新)+ `package.json` | 冒烟命令 `smoke:p2s1`(dependencies 未动,仍为空) |

---

## 3. VERIFY 验收对照(任务书 §2)

### 3.1 六项验收

| # | 验收项 | 结果 | 承载 |
|---|---|---|---|
| 1 | 压缩触发正反例 | ✅ | 128 条→触发折叠前 96 条;127 条→不触发投影原样;token 兜底分支(70 条超长事件→`token_budget` 触发) |
| 2 | 白名单豁免 | ✅ | 折叠区间内 `tool/result`(带 domain_refs)及其配对 `tool/call` 原文保留于投影,引用字段不丢弃 |
| 3 | 压缩事件重建 | ✅ | 160 条混合事件落盘→replay(含审计事件)后投影与内存序列逐条一致,且幂等 |
| 4 | fsync 双档崩溃恢复 | ✅ | 逐条档:12 个 ack 后 SIGKILL→全部 ack 在落盘流;批量档:8 个 ack 后 SIGKILL→刷盘水位线内事件全部在落盘流、id 连续无半行 |
| 5 | schema v1 迁移可 replay | ✅ | v0 形态流(7 类)在 v1 规则下原样合法,零改写 |
| 6 | 基线零回归 | ✅ | `ATF_CLI_PATH=.atf-pinned npm test` → **`Tests 126 passed | 2 skipped (128)`**(18 文件全过,2026-09-10 20:40,2.81s);pin `v0.2.0b7`/`a628f8b` 未动 |

### 3.2 八条设计要求落点速览

1. compaction 真实实现+双指标常量 → `compaction.ts` + `constants.ts`;2. 摘要事件+schema bump+迁移说明 → `session/compaction` + contract `migration` 节;3. append-only 不变(压缩只影响投影视图) → `projectContext` 纯函数,磁盘不删不改;4. 领域事实白名单纯函数化 → `computeCompactionWhitelist` 可独立单测;5. 压缩自身可审计 → 审计事件 payload 含 `covers/folded_count/kept_ids/type_counts/trigger`,可回答「哪次压缩吃掉了哪些事件」;6. fsync 双档 → 见 §4.1;7. durability 契约文档化 → 写入路径注释 + contract `durability` 节;8. 崩溃恢复测试 → 双档各一组 + 进程内时机单测。

---

## 4. 偏离与决策点

1. **批量档 fsync 语义改判(BUILD 中的实质决策,请 owner 重点复核)**:按「ack 等待覆盖自己的刷盘」初版实现后,复现出**顺序 await 调用下的结构性死锁**(第 1 条 append 永远等不到第 N 条触发刷盘,最小复现确认)。改判为:**批量档 ack = write 完成**(数据交 OS、顺序保留、进程崩溃不丢),fsync 攒批(N 条 / T 毫秒)异步补做,**持久化确认点 = 刷盘水位线**(`unsyncedEvents` 归零)。此语义与 Phase 0/1 对 fsync 的原始分析一致(「write() 成功 ≠ 已在磁盘;进程崩溃无碍,断电丢未刷部分」)——批量档即该原始语义 + 攒批 fsync,逐条档为其 durability 升级。两档的崩溃恢复测试按各自确认点校验。契约 `durability` 节已按改判后口径登记。
2. **schema.test.ts 随 bump 更新**:v0 常量断言(7 类/版本 0)按任务书 §2 设计要求 2 的 bump 要求同步更新为 v1(11 类/版本 1),原用例意图保留并扩充;属 bump 的伴生改动而非测试放松。
3. **退出码 75/79 的登记位置**:决议 §2.2 要求「在契约文件登记」且不触发 `contract_version` bump。S1 范围内唯一可动的契约文件是 `session.contract.yaml`,故 `headless_exit_codes` 节(0/78/1/75/79,标注 75/79 为枚举补登)落在该文件。**如 owner 认为应登记于他处(如 bridge.contract.yaml 或未来 run 契约),请指示,挪移为纯文档动作**。
4. **压缩初值选型(决议口径 #2 授权自定)**:事件数 128(Phase 1 冒烟单分支 ≤50,留 2 倍余量)、token 24000(chars/2 保守估算,兜底少而长的会话)、保留窗 32、chunk 32(滞后防逐条重折叠);理由已登记契约 `compaction` 节。
5. **审计事件透明性设计**:为满足「runner 内存序列(不含审计)与 replay 序列(含审计)投影必须一致」且 runner 不可改(范围约束),设计为 `session/compaction` 对压缩算法透明(不计事件数、不参与折叠、不进入投影,摘要由算法确定性重建);审计事件专职留痕,其 payload 与投影摘要同源(确定性可互核)。
6. **`hasDomainRefs` 迁移**:从 `sessionLog.ts` 迁至 `schema.ts`(避免 compaction→sessionLog 环依赖),`index.ts` 公开出口不变,`src/run/runner.ts` 引用不受影响。
7. **崩溃测试的子进程载体**:vitest 不编译 TS,子进程经 `dist/` 运行,测试内自动 build-if-stale(`npm run build`,零新依赖);子进程经 stdout 打印 ack 与刷盘水位线,父进程 SIGKILL 后 replay 校验。
8. **新增冒烟命令 `smoke:p2s1`**(沿用每 slice 一条冒烟命令惯例);`dependencies` 保持为空;未使用 `ledger_record` 或任何 setup 基建方法作为运行时路径,未新增桥接方法面(决议口径 #7)。

---

## 5. 提交清单(本地 main,**未 push**)

| # | commit | 内容 |
|---|---|---|
| 1 | `c50f3d6` | `docs(phase2): D1 文档升格 ADR-09 ACCEPTED(C7 改判授权凭据 / 退出码定案)` |
| 2 | `78af9fa` | `docs(owner): D1 闭合决议 + P2-S1 启动指令` |
| 3 | `93b1a88` | `feat(session): P2-S1 compaction+fsync+schema v1`(14 文件,+1331/−104) |
| 4 | (本笔) | `docs(phase2): P2-S1 执行报告` |

---

## 6. 下一步建议

1. **owner review P2-S1**,重点两处:§4.1 批量档语义改判(ack=write、确认点=水位线)与 §4.3 退出码登记位置。
2. review 通过后签发 **P2-S2 启动指令**;S2 任务书细化时建议携带:ADR-09 §5.3 开放点 a/c/d(approval_session_id 形态 / 载荷字段命名 / 凭据消费状态记录形态)+ 决议 §2.1(应答即授权凭据,executor 审批检查点接受第二类依据)+ §2.2(75/79 已在契约登记,suspended/aborted 进程表达落地)。
3. 本会话不自行启动 P2-S2,完成即停。
