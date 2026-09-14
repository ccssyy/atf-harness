# ATF-Harness Owner 决议与指令——R2 门 1 评审通过 + 门 2 放行（含真实写授权）

**签发**：owner
**日期**：2026-09-14
**执行方**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**依据**：《ATF独立Harness_R2任务书_真实对端夹具与工具面端到端_20260914.md》门 1 ＋《ATF独立Harness_R2门1_夹具设计_20260914.md》（`0dc75b2`）＋ owner 侧对 pin 副本源码的抽检
**结论先行**：**门 1 设计通过**（八项逐一有答，探针地基 F1–F11 经 owner 抽检成立）；**四项裁决已定**；**门 2 放行**，并**正式授予真实写授权**（范围严格限定见 §2.4）。三项边界标注必须在门 2 报告中如实体现（§3）。

---

## 1. 门 1 验收复核

| 任务书 §1 八问 | 设计对应 | 判定 |
|---|---|---|
| 1 夹具形态与生命周期 | §1 三层隔离根（temp HOME / wsRoot / pin cwd）+ mkdtemp 幂等 + 双兜底回收 + `init` 与直构目录树的混合取舍 | ✅ 取舍有理由（`init` 保真、run 骨架直建） |
| 2 覆盖表（含替代路径） | §2 九项逐条（含 6b 完整性 advance、9 账本成功消费两处替代路径） | ✅ 不可满足者均给出替代路径，未粉饰 |
| 3 最小 run 夹具构成 | §3 十目录 + 3 行 journal + 两 lane summary（验最坏裁决）+ **经真实 `atf_admit_data` 登记数据集**（不手写） | ✅ 以真实写路径替代手写夹具，保真度更高 |
| 4 隔离与安全断言 | §4 五项污染断言（pin 副本 `git status` 为空 / temp HOME 无 `.agents/skills` / 真实 `~/.atf` 不可达 / 路径前缀 / 合成数据标识） | ✅ |
| 5 双轨策略 | §5 mock 轨恒跑、真对端组 `ATF_CLI_PATH` 门控、runner 默认仍 mock、`smoke:r2` 无路径优雅 skip | ✅ 与硬约束"未设置时全套可过"一致 |
| 6 真实写清单与授权范围 | §6 五行写动作 ×（落盘位置 / 证据 / 验证 / 清理） | ✅ 授权范围按此表（见 §2.4） |
| 7 与场景/冒烟对接 | §7 三条既有冒烟零改动；场景迁移暂缓建议另批 | ✅ 采纳（§3.1） |
| 8 风险与回退 | §8 七项 mock↔真内核差异逐项吸收 + 回退设计（门控下 mock 轨完整可用） | ✅ |

**owner 侧抽检的载荷性事实**（决定夹具能否成立，均实测成立）：

| 事实 | 抽检结果 |
|---|---|
| F6 准入 summary 路径与错误码 | ✅ `session/tools.py:75 _ADMISSION_SUMMARY_GLOB = "*source-backed-admission-summary.json"`；`admission_state_unavailable`（524/555） |
| F9 注入口存在且为显式测试口 | ✅ `build_registry(channel, workspace_root=None, owners: FactOwners \| None = None)`（823–826）；`ApprovalLedger._records: dict[str, list[ApprovalRecord]]` 纯内存（2385）；`register_command`（2389） |
| F7 闸门登记为会话内存 | ✅ `self._registered_gates: dict[str, GateResult]`（226）；advance 写入 636、query 读 519 |

## 2. 四项裁决（对应设计 §9）

### 2.1 D1 注入式 serve 对端：**接受**（限定用途 + 三条约束）

**裁决**：接受以 `python3 -c` 包装 `run_session` + `build_registry(channel, owners=预录 FactOwners)` 作为**测试专用对端**，用于账本成功消费与 `approval_already_consumed` 分支。理由：内核 docstring 自述 `register_command` 为"登记 fixture 提供的 typed approval command"——**内核显式提供该注入口供夹具使用**；且注入式对端仍走同一 `run_session` / `build_registry` / `ApprovalLedger` 代码，消费语义（CAS 一次性跃迁、逐值一致校验）是真实的。

**三条约束**：
1. **仅限测试夹具**（`tests/run/realPeer/*`、`smoke:r2`）；**不得进入 `src/` 生产路径**（生产路径仍只有 `derive_command` 派生的 CLI argv）；
2. **同源注入**：与 `derive_command` 一致注入 `PYTHONPATH` / `PYTHONDONTWRITEBYTECODE=1` / `ATF_SKILLS_AUTO_INSTALL=0`，`cwd = pin`，HOME 隔离（由夹具工厂单点产出）；
3. **报告必须标注**：该路径绕过 CLI argv 入口，且账本"产品级预录"尚未闭环（见 §3.3）。

### 2.2 D2 完整性 Gate advance：**接受"列为可选扩展"**（不阻塞 R2）

理由：该分支需构造 `GateEngine.evaluate` 的最小证据对象，成本高；而**内核侧** B2-2 已用单测覆盖 advance 的求值与 `register_gate_result` 登记（17 用例含 advance 正反例）。R2 的价值在跨进程真实链路，重复覆盖 GateEngine 入参构造收益有限。门 2 覆盖 `query`（未登记 → `gate_verdict_not_registered`）与 `unknown_gate` 分支即可；完整 advance 另立子任务（需先核入参工作量）。

### 2.3 D3 内核 `pin` 参数：**走契约补登，不 bump 桥接契约版本轴**（并固化 bump 口径）

内核 `atf_admit_data` 接受可选 `pin`，契约未登记。**裁决：随 R2 同批补登**（契约 `atf_admit_data.params` 增可选 `pin`，注明"显式优先，缺省 `canonical_digest({dataset_id, source_ref})[:12]`"）。

**同时固化桥接契约版本轴的 bump 口径（此前存在口径含糊，本次定死）**：

| 变更类型 | 处理 |
|---|---|
| **纯增量**（新增方法、新增**可选**字段/参数、错误码枚举扩面） | **补登登记，不 bump**（沿用 `atf.bind_run` 补登先例） |
| **破坏性**（改名、删字段、改既有字段语义、收窄枚举、帧/握手/生命周期变更） | **bump 桥接契约版本轴**（会话协议轴仅在线缆规则变更时单独处理） |

该口径须写进契约头部「版本轴注记」。

### 2.4 D4 真实写授权：**正式授权**（范围如下，越界即违规）

**授权范围**：在 **mkdtemp 生成的夹具根**（路径前缀 `/tmp/atf-r2-`）内、对**合成数据**（`r2-fixture-*` 标识）执行：

| 动作 | 允许的落盘 | 说明 |
|---|---|---|
| `atf init` | 临时 HOME 的 `.atf/config.json` ＋ `<wsRoot>` 目录树 | HOME 已隔离 |
| `atf_admit_data` | `datasets/<id>@<pin>/registration.json`（＋ 可选 `splits/<id>/split-manifest@<pin>.json`） | **R2 唯一真实磁盘写**，须有落盘证据（文件 + sha 复算） |
| `atf_gate` G 系 advance | 无落盘（会话内存登记） | 以同会话 query 反读为证 |
| `ledger_consume` | 无落盘（会话内存链追加） | 以响应 + 重复消费 `approval_already_consumed` 为证 |

**禁止**：写真实 `~/.atf`、`~/.agents`、内核仓（`.atf-pinned` 与 `/data/sam/AgenticTrainingFlow`）、任何业务数据或真实 run 目录；使用真实单据内容（夹具一律合成标识）。

## 3. 三项边界标注（**门 2 报告必须如实体现，不得含糊**）

1. **场景迁移另批**（设计 §7 建议）：采纳。`admission-to-g2` 等场景脚本迁真内核涉及 run_id/workspace 参数化与 Faux 回放适配，R2 以 `smoke:r2` 达成端到端验收即可；场景迁移列为 R2 收尾评估项或另批。
2. **mock↔内核的 event 键差异**（设计 §8#2：mock `{from,to}` vs 内核 `{from_run_id,to_run_id}`）登记进**「mock 退役评估」清单**（R2 收尾项），不在本批统一。
3. **"内存登记"不得写成"已落盘"**：F7/F9 表明闸门推进登记与账本消费**仅在会话进程内存**，进程结束即消亡。因此 R2 报告的措辞必须是"由**同会话 query 反读**验证"，**不得**表述为"已持久化/可重建"。R2 之后"跨进程事实可重建"仍依赖 harness 自己的 append-only 会话日志与工作区文件——这一点若将来需要变更，属**内核侧议题**（§5）。

**另加一条边界（防误读）**：R2 的 run 是**合成最小 run**（`r2-fixture-*`），R2 验收通过 ≠ 业务级可用；真实训练链路上的端到端（含真实数据与真实 effect）仍需独立授权与独立批次。

## 4. 门 2 执行要求

1. **范围**：按 R2 任务书 §2（替换对端 → 夹具落地 → 端到端链路 → `smoke:r2` → mock 退役评估），并吸收本决议 §2 四项裁决与 §3 三项标注。
2. **端到端链路（验收主链）**：`bind_run` → `workspace_status` → `fact_scan` → `gate`(G 系 query) → `admit_data`（写）→ `gate`(G 系 advance) → `ledger_query` → `ledger_consume`（写，注入式对端）；另含 fail-closed 反例组：`no_run_bound` / `unknown_run` / `unknown_gate` / `admission_state_unavailable` / `gate_verdict_not_registered` / 空链 `not_found` / 坏 journal `internal_error` / 重复消费 `approval_already_consumed`。
3. **不动项**：三条既有冒烟与 runner 默认链路保持 mock；全量测试在 `ATF_CLI_PATH` 未设置时仍全绿（下限 `202 passed / 1 skipped`）；内核仓零改动；`dependencies` 恒空。
4. **交付**：门 2 代码与测试 + 夹具模块 + `smoke:r2` + 《R2 门 2 执行报告》（端到端原始输出 / 落盘证据 / 隔离断言 / 三项边界标注 / 验收对照 / 提交清单）。
5. **推送前**：复跑全量（两轨）＋ `smoke:s5` / `p2s2` / `p2s3` / `r2`；推送须另行提请 owner 授权。
6. **分支**：`work/20260914-r2-real-peer` 短命分支 + worktree，合回 main 后删除。

## 5. 内核侧议题登记（交 ATF 仓排队，本仓不插队、不阻塞）

| # | 议题 | 来源 |
|---|---|---|
| 1 | **审批跨进程可见性**：`ApprovalLedger` 为纯内存实现 + 纯 CLI `serve` 无 owners 注入 → 由其他进程登记的审批在会话进程内不可见 | 设计 §0 F9 / 本决议 §2.1 |
| 2 | **会话级预录入口**：若产品级流程需要"预录审批 → 会话消费"，需要内核提供 setup 方法（harness 契约已预留 `ledger_record` 为 setup 基建，内核未实现）或 Approval Ledger 持久化 | 同上 |
| 3 | 完整性 Gate advance 的求值入参文档化（若将来要覆盖完整链路） | 设计 §2#6b |

## 6. 纪律

1. 真实写严格限于 §2.4 范围；越界即违规并立即停止。
2. 注入式对端仅存在于测试面，不得进入 `src/` 生产路径。
3. 契约变更按 §2.3 口径（纯增量补登不 bump / 破坏性 bump），并在契约头部注记。
4. 会话边界：harness 侧会话只在本仓作业；内核仓零改动。
5. 脱敏：夹具与文档一律合成标识，不出现真实业务内容与内部绝对路径。
