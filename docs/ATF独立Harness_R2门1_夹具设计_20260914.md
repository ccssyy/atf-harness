# ATF 独立 Harness——R2 门 1：真实对端夹具设计

**签发**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**日期**：2026-09-14
**依据**：《ATF独立Harness_R2任务书_真实对端夹具与工具面端到端_20260914.md》门 1（§1 八项）
**性质**：**只交设计，不写实现**——本文全部结论基于对 pin 副本（`v0.6.0b0` / `b6db3496…`）内核源码的只读探针与最小隔离实跑验证（`atf init`、`serve` 会话探针），探针残留已清理。
**门 1 交付后停下等 owner review；门 2（实现 + 真实写授权）另行开工。**

---

## 0. 探针得到的关键内核事实（设计的地基）

以下均为 pin 副本实测/源码只读确认，供 review 对照：

| # | 事实 | 出处 |
|---|---|---|
| F1 | 工作区根解析：`SessionTools._workspace()` 显式注入优先，缺省读 `~/.atf/config.json` 的 `workspace_root`；未初始化 → `unknown_run`（"workspace 未初始化"） | `session/tools.py`、`workspace_init.workspace_root()` |
| F2 | `atf init --workspace-root <path>`（HOME 隔离下实测）：写 `<HOME>/.atf/config.json` + 建 `<ws>/{datasets,splits,runs}` + `ATF.md`，输出 JSON 摘要，退出码 0 | 实跑验证 |
| F3 | run 骨架 = `runs/<run_id>/` 十目录：`experiment-setup / l1 / variants / launch / training / models / eval / journal / verification / decisions`（`RUN_SKELETON` 常量）；`bind_run` 仅要求 `runs/<run_id>/` 目录存在 | `workspace_init.RUN_SKELETON`、`tools._require_existing_run` |
| F4 | journal 事实：`runs/<run_id>/journal/journal.jsonl` 逐行 `{ts, action, out, refs}`（canonical JSON），行号自 1 起，`fact_id = journal-event:<run_id>:<行号>`；坏行 → `internal_error` 拒绝残缺索引 | `tools._journal_facts` |
| F5 | 数据集登记：`atf_admit_data` 经 `register_dataset` 真实写 `datasets/<id>@<pin>/registration.json`（schema `DatasetRegistration/v1`，含 `dataset_id/pin/registered_at/l1_dir/refs`）；`pin` 显式优先，缺省 = `canonical_digest({dataset_id, source_ref})[:12]`；提供 `l1_dir` 时逐产物 sha 登记并归档 split-manifest | `session/tools.admit_data`、`workspace_init.register_dataset` |
| F6 | 准入闸 summary：`runs/<run_id>/l1/**/*source-backed-admission-summary.json`，文档须含恰 4 项 `gates` 数组（`gate_id` ∈ G1–G4 对应七组闭集前四项，逐份文档四项齐备），`verdict ∈ pass/warn/block` + `reason_codes`；多份取**最坏裁决**聚合；无 summary → query/advance 均 `blocked(admission_state_unavailable)` | `tools._aggregate_admission_gate` 等 |
| F7 | G 系 `advance` 登记为**会话进程内事实**（`GateResult` → `_registered_gates` + Artifact Catalog 内存 owner，producer `workflow:session-gate-advance`）；`session/tools.py` 全文件**无任何 journal/写盘调用**——闸门推进与账本消费均不落盘；外部可验证 = 同会话 query 反读 | `tools` 源码 |
| F8 | 完整性 Gate：query 未登记 → `blocked(gate_verdict_not_registered)`；advance 需 `GateEngine.evaluate` 求值对象——判定权威同为会话内存 Artifact Catalog | `tools._query/_advance_integrity_gate` |
| F9 | **审批链为会话进程内存对象**：`FactOwners()` 内建 `ApprovalLedger()`（纯内存 dict）；纯 CLI `serve` 入口无 owners 注入（`run_session` → `build_registry(channel)`）；内核 `build_registry(channel, workspace_root=, owners=)` 与 `register_command`（docstring 自述"登记 fixture 提供的 typed approval command"）为**显式测试注入口** | `facts/owners.py`、`session/runner.py`、`session/tools.build_registry` |
| F10 | bind_run 留痕 event：**首绑也发**（`from_run_id=null`），payload 键 = `from_run_id`/`to_run_id`；scope 投影 = `project_id="agentic-training-flow"`、`scope_type="run"`、`scope_id=<run_id>`、`scope_mode="canonical"` | `tools.bind_run`、`_scope_projection` |
| F11 | 会话协议行为：未知方法 `method_not_found` 连接保持；协议违规 exit 3（业务错误恒 error response）；`serve` 优雅关闭 exit 0 | `session/runner.py`（R1 已实测） |

---

## 1. 夹具形态与生命周期（任务书 §1.1）

**形态（三层隔离根，全部 `/tmp` 下 mkdtemp）**：

```
/tmp/atf-r2-home-XXXX/            ← 子进程 HOME（~/.atf 配置根、技能目录的隔离兜底）
/tmp/atf-r2-ws-XXXX/              ← workspace root（atf init 目标；runs/、datasets/ 等）
    └── runs/<run_id>/            ← 夹具直建十目录骨架（F3 常量）
.atf-pinned/（只读 checkout）      ← cwd，全程 git status 零改动断言
```

**`atf init` vs 直构目录树——取舍结论：混合**。
- **工作区与配置根用真实 `atf init --workspace-root`**：这是内核自己的装机入口，实跑验证副作用恰好限定于临时 HOME 与目标 workspace（F2），比手写 `config.json` 更保真（顺带覆盖 init 产物形态断言）；夹具对其输出 JSON 做存在性断言。
- **run 目录骨架与 journal/summary 夹具直建**：`init` 不建 run；内核 Python API `run_dir(ensure=True)` 需进程内调用，不值得为此加包装。十目录名取自 `RUN_SKELETON` 常量（F3，自 ADR-0005 稳定），夹具以字面常量维护并在测试中断言内核 `bind_run` 接受（漂移即红——这是期望中的契约报警路径）。

**生命周期与幂等性**：
- 工厂函数 `createRealPeerFixture()`：每次调用新建独立三层根（mkdtemp 天然不重名，幂等），返回 `{wsRoot, home, runId, cleanup()}`；
- 时机：每个用例（或每组链路用例）fresh 一个；`afterEach`/`finally` 调 `cleanup()`（`rm -rf`，`force: true`）；
- 失败残留：双层兜底——①vitest afterEach 兜底回收已登记 fixture；②进程崩溃残留仅限 `/tmp` 匿名目录（系统 tmp 清理可回收，无用户目录风险）；冒烟末尾断言本进程创建的夹具根已清零。

## 2. 覆盖表（任务书 §0 七类前提逐项，含替代路径）

| # | 方法 | 夹具可满足？ | 说明 / 替代路径 |
|---|---|---|---|
| 1 | `atf.bind_run` | ✅ | 夹具直建 `runs/<run_id>/` 十目录（F3）；`unknown_run` 反例 = 未建 run_id；留痕 event 断言（F10，注意 payload 键差异见 §8） |
| 2 | `atf_workspace_status` | ✅ | init 工作区（F2）+ 空 `datasets/` → `admitted_count=0`；登记后计数上升；未初始化工作区反例 = 不设 HOME/config → `unknown_run` |
| 3 | `atf_fact_scan` | ✅ | journal 样例 → operation-journal 事实（F4）；`atf_admit_data` 后 → dataset-registry 事实；坏行反例 → `internal_error`（残缺索引拒绝） |
| 4 | `atf_gate` G1–G4 query | ✅ | summary 样例（F6）三态各一份；多 lane 两份验证最坏裁决聚合；无 summary → `blocked(admission_state_unavailable)` |
| 5 | `atf_gate` G1–G4 advance | ✅（写 = 会话内存） | 判定输入 = 落盘 summary（F6）；登记为会话内事实（F7）——外部验证 = 同会话 query 反读一致；block/warn 缺原因码 → `internal_error` 反例 |
| 6 | `atf_gate` 完整性 query | ✅ | 未登记 → `blocked(gate_verdict_not_registered)`（F8）；`unknown_gate` 反例 = 七组闭集外命名 |
| 6b | `atf_gate` 完整性 advance | ⚠️ **有限** | 需构造 `GateEngine.evaluate` 最小证据对象（契约/证据对象形态复杂）。**替代路径**：门 2 仅覆盖 `unknown_gate` 与 query 未登记分支，完整 advance 链路列为可选扩展（独立子任务，需另核 `contracts/gates.py` 求值入参后判定工作量）；不阻塞 R2 主链路 |
| 7 | `atf_admit_data` | ✅ | 真实写盘（F5）：`registration.json` +（提供 `l1_dir` 时）产物 sha 登记与 split 归档——**R2 唯一真实落盘写** |
| 8 | `ledger_query` | ✅ | 空链 → `ok, records=[]`；`include_consumed`/`state` 过滤分支对内存链同样可验 |
| 9 | `ledger_consume` | ⚠️ **成功路径需注入** | 纯 CLI `serve` 无预录入口（F9）。**替代路径（双轨）**：①错误分支（`approval_record_mismatch` 前缀校验、`not_found` 链不存在）走纯 CLI 覆盖；②成功消费 + `approval_already_consumed` 走**注入式 serve**——夹具以 `python3 -c` 包装 `run_session` + `build_registry(channel, owners=预录 FactOwners)`（`register_command`/`consume_command` 形成 approved 记录），内核文档自述该注入口为"测试注入用"。**此为门 1 需 owner 裁决项**：注入式对端仍是真实内核代码（同一 `build_registry`/`run_session`），但绕过 CLI argv 入口；若 owner 不认可，则账本面成功消费推迟至内核提供预录入口（ATF 仓排队，本仓不插队），R2 账本面仅交付错误分支 |

## 3. 最小 run 夹具的构成（任务书 §1.3）

以单一 `run_id`（合成标识，如 `r2-fixture-run-1`）为单元：

1. **十目录骨架**：F3 常量逐目录 mkdir（`journal` 必建，其余存在性由 bind_run 反例组覆盖亦可——设计取全建，贴合 ADR-0005）。
2. **journal 样例**（`journal/journal.jsonl`，3 行，canonical JSON 键序 `{ts, action, out, refs}`）：
   - 行 1 `experiment_setup`（refs 空）；
   - 行 2 `eval_service_generated`（refs 带一个合成 sha）；
   - 行 3 `train_launch_generated`（out 指向 run 内相对目录）。
   预期事实断言：3 条 operation-journal，`fact_id` 行号连续，digest 与夹具侧同构 canonical 计算一致。
3. **准入 summary 样例**（验证最坏裁决，两 lane）：
   - `l1/lane-a/<ts>-source-backed-admission-summary.json`：4 项 gates 全 `pass`；
   - `l1/lane-b/<ts>-source-backed-admission-summary.json`：G2 `warn`（带 reason_codes）、其余 pass → 聚合预期 G2=warn；
   - 反例组第三 run：`block` 带 reason_codes → 聚合 block；缺 gates 数组/闸门身份错位 → `internal_error`（形态损坏反例，可选）。
4. **数据集登记**：**经真实 `atf_admit_data`**（不手写 registration.json——保真且同时覆盖写路径）；`l1_dir` 变体放 2 个标准产物文件验证逐产物 sha 登记。
5. **审批链预录**（注入式对端组，待 §2#9 裁决）：夹具持 `OperatorCommand`（command_type=approval，actor/scope_ref/operation_id/attempt_id/subject_ref 与请求侧逐值一致）经 `register_command` 登记、`consume_command` 形成 sequence=1 的 approved 记录；`record_id` 形态 `approval-record:<approval_id>:<n>`（F11 之前缀规则）。

## 4. 隔离与安全（任务书 §1.4）

**强制注入（夹具工厂统一产出，单点维护）**：`HOME=<temp>`、`ATF_SKILLS_AUTO_INSTALL=0`、`PYTHONPATH=<pin>/src`、`PYTHONDONTWRITEBYTECODE=1`、`cwd=<pin>`；workspace 全部位于 `<wsRoot>`（/tmp）。

**污染断言（每条真对端用例的 afterEach 收尾断言）**：
1. `git -C .atf-pinned status --short` 为空（内核仓零写）；
2. temp HOME 内不出现 `.agents/skills/` 与任何技能文件（技能自举关闭生效 + HOME 隔离双保险）；
3. 真实 `~/.atf` 不可达（HOME 隔离使然——探针实测 config 落在临时 HOME，F2）；
4. 夹具根 `rm -rf` 后无残留；写动作落盘路径全部位于 `<wsRoot>` 内（路径前缀断言）；
5. 夹具数据全合成（`r2-fixture-*` 标识、sha 均为夹具生成），零真实业务内容。

## 5. 双轨策略（任务书 §1.5）

- **同文件分组 + 既有 `describeIfPinned` 门控模式**（`contract.pin.test.ts` 先例）：mock 轨用例恒跑（CI/常规开发）；真对端用例集中新目录 `tests/run/realPeer/*.test.ts`，组级 `ATF_CLI_PATH` 门控（未设置 → 整组 skip，全量测试仍全绿——硬约束"未设置时全套可过"）。
- **runner 场景保持 mock**：`mockCommand` 机制不动；真对端注入点设计为 runner 的显式 opt-in 配置（门 2 评审点），默认值恒 mock。
- **冒烟**：新增 `smoke:r2`（`src/run/smokeR2.ts`，`package.json` 脚本）——无 `ATF_CLI_PATH` 时输出说明并 exit 0（skip 语义）；三条既有冒烟零改动。

## 6. 真实写动作清单（任务书 §1.6，**owner 授权范围按此理解**）

| 写动作 | 落盘位置（全部 `<wsRoot>` 内） | 落盘证据 | 验证方式 | 清理 |
|---|---|---|---|---|
| `atf_admit_data`（基础） | `datasets/<id>@<pin>/registration.json` | `DatasetRegistration/v1` JSON（F5） | 文件存在 + 身份一致 + `workspace_status.admitted_count` / `fact_scan` 复读 | cleanup rm |
| `atf_admit_data`（带 `l1_dir`） | 同上 + `splits/<id>/split-manifest@<pin>.json` | 逐产物 sha 登记记录 | refs 内 sha 与夹具文件实测 sha 一致 | 同上 |
| `atf_gate` G 系 advance | **无落盘**（会话内存登记，F7） | 同会话 query 反读一致 | query 断言 + （可选）重复 advance 冲突 CAS 反例 | 会话结束即消亡 |
| `ledger_consume` | **无落盘**（会话内存审批链，F9） | 响应 `state=consumed` | 重复消费 → `approval_already_consumed` | 同上 |
| `atf init`（夹具装机） | `<HOME>/.atf/config.json` + `<wsRoot>` 树 | init 输出 JSON 摘要（F2） | 存在性 + `workspace_root` 值断言 | cleanup rm |

**需 owner 授权的范围**：上表前两行（真实磁盘写，限定 `/tmp` 夹具根）+ 后三行的"执行"（本身无落盘，但属 effect 类动作）。授权边界建议表述为：**仅限 `mkdtemp` 夹具根内的合成数据**；越界即违规。

## 7. 与场景/冒烟的对接（任务书 §1.7）

- **保留**：`smoke:s5` / `smoke:p2s2` / `smoke:p2s3` 与 runner 默认链路全部维持 mock 轨（既有 202/1 基线不动）。
- **新增**：`smoke:r2` 真对端专项冒烟 = §门 2.3 的端到端链路 + fail-closed 反例 + 隔离断言，一糖一盐全覆盖。
- **场景迁移（`admission-to-g2` 走真内核）**：暂缓——涉及场景脚本的 run_id/workspace 参数化与 Faux 回放适配，建议 R2 以 `smoke:r2` 达成端到端验收后，场景迁移列为 R2 收尾评估项或另批（**门 1 建议：另批**）。

## 8. 风险与回退（任务书 §1.8）

**mock/真内核关键差异面（夹具与断言设计已吸收）**：

| # | 差异 | 吸收方式 |
|---|---|---|
| 1 | mock 默认绑定 `mock-run-1`；内核会话启动无绑定（`no_run_bound` 真实存在） | 真对端组一律显式 `bind_run` 或显式 `run_id`（编排口径一致）；`no_run_bound` 作为必测反例 |
| 2 | 留痕 event：mock 覆盖绑定时发 `{from,to}`；内核**首绑也发**且键为 `{from_run_id,to_run_id}`（F10） | 真对端 event 断言按内核实测形态；mock 侧差异注记已有，契约措辞"payload 含 from/to run_id"两者皆容——不构成契约违反；如 owner 认为需统一，走契约注记微调（另批） |
| 3 | scope_ref：mock 固定 `mock-project/headless`；内核 `agentic-training-flow/run/canonical`（F10） | ledger 预录的 scope_ref 与内核投影逐字段一致（夹具常量单点维护） |
| 4 | admit pin 派生：mock = sha256(dataset_id)[:12]；内核 = canonical_digest({dataset_id, source_ref})[:12]，且内核额外接受 `pin` 参数（契约未登记） | 真对端组断言不依赖具体 pin 值（以响应回传的 `fact_id` 为准）；**pin 参数为契约未登记面——登记待办走契约流程（另批，桥接契约版本轴 bump）** |
| 5 | 错误码粒度：内核更细（`admission_state_unavailable` / `gate_verdict_not_registered` / `internal_error` 等） | 真对端组按内核实测码断言；不要求 mock 对齐（mock 退役评估时统一裁量） |
| 6 | 账本：mock 预录方法面（ledger_record）存在；内核无预录入口（F9） | §2#9 双轨替代路径，owner 裁决注入式对端取舍 |
| 7 | 闸门 summary 形态强校验（四项齐备、身份错位 → internal_error） | 夹具样例严格按 F6 构造；形态损坏作为反例组 |

**回退设计**：真对端全部用例处于 `ATF_CLI_PATH` 门控之下，`smoke:r2` 无路径时优雅 skip；runner 默认 mockCommand 不变——R2 任一环节失败，mock 轨完整可用，本仓持续可交付（不阻塞、不插队原则的工程化表达）。

---

## 9. 门 1 需 owner 裁决项汇总

1. **注入式 serve 对端**（§2#9）：账本成功消费路径是否接受 `build_registry(owners=…)` 注入式夹具（真实内核代码、非 CLI argv 入口）？不接受则账本面 R2 仅交付错误分支，成功路径待内核预录入口。
2. **完整性 Gate advance**（§2#6b）：仅覆盖 query/unknown_gate 分支是否可接受？完整求值链路是否列入 R2 可选扩展（需先核 `GateEngine.evaluate` 入参构造工作量）？
3. **内核 `atf_admit_data` 的 `pin` 参数**（§8#4）：契约未登记——是否随 R2 走契约补登（桥接契约版本轴 bump）？
4. **真实写授权范围**：按 §6 表理解（"仅限 mkdtemp 夹具根内的合成数据"）是否准确？

**门 1 交付即停——等 owner review，不预写任何实现代码。**
