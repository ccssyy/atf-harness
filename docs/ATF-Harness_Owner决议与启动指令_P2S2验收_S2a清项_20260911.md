# ATF-Harness Owner 决议与启动指令——P2-S2 验收 + S2a 清项（S3 前清项）

**签发人**：owner
**日期**：2026-09-11
**执行人**：zcode（A800_5005:/data/sam/ATF-Harness）
**依据**：《ATF-Harness_Owner决议与启动指令_P2S2门1通过_门2放行_20260911.md》+ 设计 v1.1（生效版）+ P2-S2 产出（`990f894` / `d12f524` / `74e57b2`）
**结论先行**：**P2-S2 验收通过**（原九项 + 追加七项全过、168 passed / 2 skipped、三条冒烟全过）。按 owner 裁决**先出 S2a 清项**（两项小修 + 一项登记），复核通过后 P2-S2 正式闭合，再签发 P2-S3 启动指令。越界修正正式追认并附纪律提醒。

---

## 1. P2-S2 验收复核（owner 独立核验）

| 验收项 | 复核方式 | 结果 |
|---|---|---|
| 测试基线 | **owner 复跑**（16:14，`ATF_CLI_PATH=.atf-pinned npm test`） | ✅ `168 passed / 2 skipped`（23 文件；S1b 基线 138/2 → +30） |
| `smoke:p2s2` | **owner 执行** | ✅ 八项全过：granted(0) / advised(0) / denied(0) / clarification(0) / aborted(**79**) / timeout(**75**) / 拒绝循环升级(79) / headless 等价(**78**) |
| `smoke:s5` | **owner 执行** | ✅ 七项总验收仍全过（零回归） |
| 依赖与 pin | owner 直读 | ✅ `dependencies` 为空；`.atf-pinned` = `a628f8b` 未动 |
| 改动面 | **owner 复核** `diff --stat` | ✅ 含一处越界（见 §2），其余落在 A4 清单 |
| `resolveCredentialState` | owner 直读实现 | ✅ 三元签名；`granted.id ≤/> watermark` → indeterminate/available；`grantedList.length !== 1 → invalid`（保守判死）；消费经 `payload.call_ref` 精确配对 |
| executor 双轨 | owner 直读 diff | ✅ 账本轨路径逐字保留（仅被包进 `approval === undefined` 分支）；handler 异常折算结构化 block；`resolveHeadlessExitCode` → `0\|1\|75\|78\|79` 单出口 |
| 编排器六类分支 | owner 直读 `approvalTrack.ts` | ✅ 与 ADR-09 §1.3 逐条对齐；clarification 重发 request 不设 `supersedes`、attempt 不变；timeout 落 `actor="harness"`；升级路径不落伪造应答 |
| 拒绝循环 | owner 直读 | ✅ 常量 2、同提案 = tool + `params_digest`；达阈值升级 aborted 且不落 request |
| R2 持久化前置 | owner 直读 | ✅ `persistAndGrant` 先复核 state 必须 `available`，再 `flush()`，失败 → `credential_persist_failed` 不放行 |
| A2 水位线 | owner 直读 runner + 测试 | ✅ 打开会话后立即取值并固定；含 `session/repair`；有"恢复后 append 判定不漂移"用例 |
| A3 终态 | owner 直读 runner | ✅ `credential_indeterminate` → `failed`(exit 1) + **五项上报材料**（含 `tool_call_id`）；`credential_persist_failed` / `approval_track_failed` 亦终局；denied/consumed/invalid 非终局 |
| R3 `call_ref` | owner 直读 + 测试 | ✅ 写入 result payload；悬空 / 指向非 call 的反例齐备 |
| 幂等键登记 | owner 直读 ADR-09 | ✅ §5.3 开放点 (e) 已落 |
| 性能实测（P2-3） | owner 复核数据 | ✅ 10k 事件 p50 2.10–2.25ms / p95 4.07–4.41ms（20% 承证对最坏路径 p95 4.41ms）→ **P2-3 关闭**：10k 级无需增量缓存；10 万级复测再议（本 slice 未实现优化，符合纪律） |

**遗留（S2a 清除对象）**：

| # | 事项 | 事实 |
|---|---|---|
| C-1 | `advised` 的 block.reason 复用 `approval_denied` | `approvalTrack.ts:251`——block 面上无法区分"被拒"与"给了修改意见"，与"六类逐条处置"口径不一致（权威记录 `approval/response` 的 verdict 仍正确） |
| C-2 | FileHandle 未显式 close | `smoke:p2s2` 输出 4 次 `Closing file descriptor N on garbage collection`（Node DeprecationWarning；未来版本将直接报错） |

---

## 2. 越界修正正式追认 + 纪律提醒

`74e57b2` 修改了 `src/session/compaction.ts`（4 行 + 2/−2），而门 2 决议 A4 的允许清单中 session 层仅允许 `schema.ts` 启用位。

**实质判定**：改动正确且必要——审计判重键原先取「最后一条被折叠者」（`folded[last]`），当折叠区间末端事件命中承证白名单被豁免时，与判重锚（`covers.to_id`）错位，导致同一折叠边界重复写审计（3k 事件实测 1239 条 vs 应约 91 条；修复后 10k 实测 311 条 ≈ 边界推进数），并附判重回归用例。**owner 裁决：采纳并追认**（回退会重新引入已知缺陷）。

**纪律提醒（写入本决议，后续切片适用）**：
1. 越界改动必须**先停下提请 owner**，附：改动理由、最小化论证（能否在不越界前提下解决）、影响面；**不得以"补交"形式事后并入**。
2. 若修正确实必要，owner 可当场扩权（如本次）或另立修复切片；两种路径都比事后追认便宜——因为事后追认会同时失去"事前评审"与"范围可控"两项保护。
3. 本次追认不构成对同类做法的先例。

---

## 3. 四项裁决

### 3.1 A1 的 `tool/call` 自指 `call_ref` 未落盘：**采纳偏离**

**主流对标（owner 核实）**：Temporal 的事件历史为 append-only、事件 id 由服务端写入时分配；调用与结果配对的形态是**结果侧携带调用侧事件 id**（`ActivityTaskCompleted.scheduled_event_id` = `ActivityTaskScheduled` 事件 id，另有 `started_event_id`）；调用事件本身不自指。AWS SWF `ActivityTaskCompletedEventAttributes` 同构。**故"仅认 result 侧 `call_ref`"与主流一致，非妥协。**

**对 zcode 偏离理由的修正**：其理由（"append-only 下自身 id 不可预知、session 层未暴露 nextId"）对**位置型 id** 成立，但主流中带自指标识的系统（OpenTelemetry `span_id`、LangGraph `task_id`）均**由写入方在发出前预生成 id**。我们的 payload 为自由 JSON，runner 可在 append 前生成 `call_uid` 并写入两个 payload，**无需动 session 层**——故"无法实现"这一论证不成立，准确表述是"收益有限、暂不值得"。

**裁决**：采纳偏离（判定仅认 result 侧 + `invalid` 路径覆盖 call 存在性校验）；**登记「预生成 `call_uid` 作对称配对键」为可选增强**（ADR-09 §5.3 新增开放点 (f)），理由：当前无跨 run 引用需求、防篡改本不在承诺内（已登记无 hash chain 边界），留待事件标识 uid 化或跨 run 引用需求出现时一并考虑。

### 3.2 `advised` 独立 reason：**要求修正**（S2a C-1）

新增 `approval_advised`；`advised` 分支改用之；`approval_denied` 仅保留给 `denied`。理由：六类应答的区分在 block 面必须成立（否则下游断言、模型反馈、审计检索都会把"给意见"与"被否决"混同），且区分成本极低。契约 `approval_track.six_verdict_handling.advised` 行与 `errors.ts` 原因面同步登记。

### 3.3 FileHandle GC 警告：**要求定位并修正**（S2a C-2）

定位未显式 close 的会话句柄（候选：`smokeP2S2` 脚本、runner 分支收尾路径），显式 close；**不得改变任何既有行为与断言**。验收方式：`npm run smoke:p2s2` 输出中不再出现 `closing file descriptor` / `garbage collection` 字样（可用 grep 断言）。

### 3.4 S3 启动时序：**先清项再启**

S2a 复核通过后 P2-S2 正式闭合，随后签发 P2-S3 启动指令。

---

## 4. Phase 3 前置登记（随本决议登记，不属 Phase 2 范围）

| # | 事项 | 说明 |
|---|---|---|
| P3-1 | **跨进程 run-resume 下的 `indeterminate` 实测** | Phase 2 为单进程 e2e，`indeterminate` 由纯函数与 handler 注入承载；真正的"进程重启 → 旧遗留 granted → 终态 failed(1) + 五项上报"必须在 Phase 3 run-resume 中做**集成级**验证——列为 Phase 3 必测项 |
| P3-2 | ADR-09 §5.3 开放点 (e) 幂等键 → 窗口内"安全重放"升级路径 | re-pin 后可谈；Phase 2 不实现不探索 |
| P3-3 | ADR-09 §5.3 开放点 (f) 预生成 `call_uid` 对称配对 | 可选增强；与事件标识 uid 化 / 跨 run 引用需求一并考虑 |
| P3-4 | 批量档跨进程恢复语义 | 当前 runner 会话恒为逐条档；批量档 flush 路径由 handler 级测试覆盖，跨进程语义属 Phase 3 |

---

## 5. S2a 清项指令

**范围（严格三项，不得夹带）**：`src/tools/errors.ts`、`src/run/approvalTrack.ts`、`src/run/smokeP2S2.ts`（如需 close 修正）、必要时 `src/run/runner.ts`（仅句柄 close，行为零变化）、`session.contract.yaml`（reason 与开放点登记）、`docs/ATF独立Harness_ADR-09候选_ACP消费面定型_20260910.md`（§5.3 新增 (f)）、测试。

| # | 改动 | 要点 |
|---|---|---|
| 1 | `approval_advised` 独立 reason | errors 原因面 + `approvalTrack.ts` advised 分支；契约 `six_verdict_handling.advised` 与原因清单同步；**区分性测试**：advise → `approval_advised`，deny → `approval_denied`，且两者均为非终局（continue） |
| 2 | 句柄显式 close | 定位并修正；**零行为变化**；`smoke:p2s2` 输出无 GC 警告（grep 断言） |
| 3 | 文档登记（纯文档） | ADR-09 §5.3 新增开放点 (f)（预生成 `call_uid` 对称配对，含本决议 §3.1 的结论与"暂不做"理由）；契约同步一句指向 |

**验收标准**：
- 上述 2 组新测试通过；**既有 168 passed / 2 skipped 零回归**（复跑输出随报告）；
- `smoke:p2s2` 全过且**无句柄警告**；`smoke:s5` 全过；
- `dependencies` 仍为空；pin 不动；`git diff` 限于 §5 列明文件。

**执行序列**：
1. 阅读本决议 + S2 报告 §4；冲突以本决议为准并报告差异；
2. BUILD（三项）；
3. VERIFY（新测试 + 基线复跑 + 两条冒烟 + 警告 grep）；
4. 产出《ATF独立Harness_Phase2_S2a执行报告_20260911.md》（执行记录 / 验收对照 / 句柄定位结论 / 提交清单）；
5. **本地提交，不 push**；完成即停——**P2-S3 未获指令不得启动**。

---

## 6. 纪律不变条款

1. 内核仓只读：pin `v0.2.0b7` / `a628f8b` 不动；C1 re-pin 未获指令不涉。
2. 测试基线不得回归（当前 168 passed / 2 skipped）；BUILD/VERIFY 分离。
3. 零 npm 运行时依赖；`dependencies` 保持为空；无 GPU、无真实 Provider。
4. 不得新增第 13 类事件；不得启用 `provider/switch`（属 S3）；不得新增桥接方法面；不得以 setup 基建承载运行时语义。
5. S2a 仅动 §5 列明文件；不得夹带 S3 内容（多 provider / 热切换 / R2b）与 P2-3 性能优化。
6. 越界改动纪律见 §2（必须先停下提请，不得事后合并）。
7. 脱敏纪律延续。
