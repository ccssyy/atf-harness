# ATF 独立 Harness Phase 2——D1 执行报告

> **日期**:2026-09-10 ｜ **执行方**:zcode ｜ **切片**:D1 ACP 消费面设计定型(纯文档,零代码)
> **依据**:《ATF-Harness_Owner启动指令_Phase2_D1_20260910.md》(下称「指令」)——执行序列、自检清单、入库动作与纪律不变条款均按指令逐条落实。
> **结论先行**:D1 已完成。产出《ATF独立Harness_ADR-09候选_ACP消费面定型_20260910.md》(下称「D1 文档」),五节齐备、schema 结论全量吸收、不实现项与 Phase 3 边界已声明、未越界传输层;测试基线复跑 **109 passed / 2 skipped 零回归**;共 3 笔本地提交(**未 push**,待 owner review);**未进入 P2-S1**(等指令)。

---

## 1. 执行记录(对照指令 §3 序列)

| 序列 | 动作 | 执行情况 |
|---|---|---|
| 1 | 阅读四份 Phase 2 文档 + 指令 | ✅《Phase2规划设计》《Owner决议_Phase2范围确认与任务书签发》《Phase2任务书》《P2S2审批应答语义设计草案》全读;并核对仓内 Phase 1 资产(`src/session/schema.ts` 七类白名单、`src/llm/provider.ts`、`src/run/runner.ts` 四态终局、`src/tools/executor.ts` 账本轨管线、`session.contract.yaml` schema v0、S5 决议①原文) |
| 2 | 撰写 D1 文档 + 自检 | ✅ 完成,自检四项全过(见 §3) |
| 3 | 产出本执行报告 | ✅ 本文档 |
| 4 | Phase 2 文档入库(5 份) | ✅ commit `c1e4a72`,提交信息沿用指令建议原文 |
| 5 | 本地提交、不 push | ✅ 共 3 笔提交(见 §5),**未 push、未 merge、未动内核仓** |

调研边界(指令口径 #5):仅查阅 ACP 公开规范(agentclientprotocol.com,经公开检索确认 `session/new` / `session/load` / `session/prompt` / `session/request_permission` / `session/update` 方法形态)作为 §6 形态参考;**未引入任何依赖、未写任何原型代码(含临时试验目录)、`dependencies` 保持为空**。

---

## 2. 五节对照(指令 §1 要求 → D1 文档落点)

| 指令要求 | D1 文档落点 | 结论编号 |
|---|---|---|
| ① dispatch / resume 的调用形态 | §1.1:载荷四要素表、run 状态机六态表、resume 三动作与三不变式 | C1–C3 |
| ② 会话事件向宿主的投影白名单 | §1.2:schema v1 十一类事件集合(一次定死)+ 必投 6 / 选投 4 / 不投 1 分层白名单 + 五条投影纪律 | C4、C5 |
| ③ 审批请求经宿主转达与应答回流的形态 | §1.3:审批会话模型 + 事件载荷草案 + 往返时序 + 应答落账本(C7)+ 超时分流(C8)+ 双轨并存 | C6–C8 |
| ④ provider 配置的注入来源 | §1.4:宿主注入 / harness 自管双模式对照表 + 覆盖语义 + 建议(B 基线、A 增强)+ 红线;**未定案,留 owner 裁决** | C9 |
| ⑤ 多轮审批会话如何透出 | §1.5:审批会话生命周期图 + 事件内联 / 聚合重建两层透出 + 多轮纪律 | C10 |

**schema 结论吸收核对**(指令 §1「必须吸收」四项):`approval_session_id` ↔ `tool_call_id` 配对(D1 文档 §1.3)✅;统一 `approval/response` + `verdict` 六枚举 granted / advised / denied / aborted / clarification / timeout ✅;`supersedes` 提案演化链 ✅;`actor` 应答者身份 ✅。另增补 `request_event_ref` 字段(兑现 P2S2 不变量 4「可审计配对」;任务书字段清单为下限,增量非冲突,已在 D1 文档 §5.1 对账)。

**不实现项清单**(指令 §1):D1 文档 §3 共 9 项,前 5 项与任务书 §5 / 硬约束 ❌ 逐项一致(ACP server 本体、TUI/Web、`projection` 激活、闸 B、re-pin);并完成条件项触发核查——**本 ADR 不触发闸 B(无 harness 侧 T2 写入需求)、不触发 re-pin(落账本沿用既有 `ledger_record` 桥接方法,mock 对端已承载)**。

---

## 3. 自检清单结果(指令 §3.2)

| # | 自检项 | 结果 |
|---|---|---|
| 1 | 五节是否齐备 | ✅ 五节齐全(§2 对照表),另有接口草案(§2)/ 不实现项(§3)/ 边界声明(§4)/ 条款对账(§5)/ 参考资料(§6) |
| 2 | schema 结论是否吸收 | ✅ 四项全量吸收 + 一项增补(`request_event_ref`),口径与决议六 C 一致(统一 `approval/response` + `verdict`,事件类型集合收敛) |
| 3 | 不实现项与边界是否声明 | ✅ §3 清单 9 项(前 5 与任务书一致)+ §4 五条边界声明 |
| 4 | 是否越界到传输层 | ✅ 未越界:事件流订阅通道、凭据句柄机制、JSON-RPC 帧、进程模型、鉴权均显式划归 Phase 3(§1.1、§1.4、§4.2);接口草案仅为声明形态锚点,不落 `src/` |

---

## 4. 偏离与决策点

1. **报告命名补全前缀**:指令 §3.3 写作《Phase2_D1执行报告_20260910.md》,本报告按仓内 Phase 1 报告惯例补全为《ATF独立Harness_Phase2_D1执行报告_20260910.md》,视为同名,内容结构完全按指令四项(执行记录 / 五节对照 / 偏离与决策点 / 提交清单)。
2. **provider 注入未定案**(指令口径 #4):D1 文档并列两模式并给出建议「自管为基线、dispatch 覆盖为增强」,明确标注**最终由 owner 裁决**,未自行定案。
3. **无条款级修订**(指令口径 #6):D1 结论与 P2-S1/S2/S3 任务书条款逐条对账(D1 文档 §5.1,12 条)**无冲突**,无需修订;其中两处为「澄清而非冲突」——schema v1 一次 bump 定死 11 类(S2 要求 1「落 schema v1」措辞本已蕴含)、`provider/switch` 暂名转正(S3 要求 2 原文即「如 provider/switch」)。
4. **D1 增补一项字段**:`request_event_ref`(应答指向被应答的 request 事件 id),为兑现 P2S2 不变量 4 的最小增量,已在 D1 文档 §1.3/§5.1 声明理由。
5. **移交 P2-S2 的三个 payload 级开放点**(非 D1 缺口,D1 文档 §5.3 登记):`approval_session_id` 生成形态;suspended/aborted 的 headless 进程表达(退出码经 `resolveHeadlessExitCode()` 单出口细化,78 锚点不挪用);advise/clarification 载荷字段命名细化。
6. **测试基线口径备注**:基线 109/2 须在 `ATF_CLI_PATH` 注入 pin 副本时复现;不注入时契约组自动跳过(108 passed / 4 skipped),属既有设计(契约测试文件头注),非回归。本次复跑已按 AGENTS.md §4 前置注入。

---

## 5. 验收结果与提交清单

### 5.1 指令验收对照

| 指令/任务书验收项 | 结果 |
|---|---|
| 覆盖任务书 §1 设计要求 1–4,五节缺一不可 | ✅(§2 对照表) |
| 必须吸收 P2S2 §5 schema 结论 | ✅(§2 核对) |
| 含 Phase 2 不实现项清单,与任务书 §5 一致 | ✅(§2 核对) |
| 测试基线 109 passed / 2 skipped 零回归 | ✅ 复跑输出:`Tests  109 passed | 2 skipped (111)`(命令 `ATF_CLI_PATH=<本仓>/.atf-pinned npm test`,2026-09-10 18:33,Duration 2.79s) |
| 不改 src/、不改契约 yaml、零新依赖、零实现代码 | ✅ `git show --stat` 仅 docs/ 三个文件 |
| 内核仓只读,pin `v0.2.0b7` / `a628f8b` 不动 | ✅ `.atf-pinned` HEAD 复核 = `a628f8b`,未做任何 re-pin 动作 |
| 提交本地保存,不 push | ✅(见 5.2) |
| 完成即停,不进入 P2-S1 | ✅ 停在本报告 |

### 5.2 提交清单(全部在本地 main,**未 push**)

| # | commit | 内容 |
|---|---|---|
| 1 | `c1e4a72` | `docs(owner): Phase 2 范围决议与任务书入库 + D1 启动指令`——《Phase2规划设计》《Owner决议_Phase2范围确认与任务书签发》《Phase2任务书》《P2S2审批应答语义设计草案》《Owner启动指令_Phase2_D1》共 5 份(指令 §3.4) |
| 2 | `fc1fda2` | `docs(phase2): D1 ADR-09 候选——ACP 消费面定型(五节设计/接口草案/不实现项清单/Phase 3 边界声明)`——D1 文档本体 |
| 3 | (本笔) | `docs(phase2): D1 执行报告——五节对照/自检/基线复跑/提交存证`——本报告 |

改动文件全集:`docs/ATF独立Harness_ADR-09候选_ACP消费面定型_20260910.md`、`docs/ATF独立Harness_Phase2_D1执行报告_20260910.md` + 入库 5 份 owner 文档;`git status` 干净(除本报告所属提交)。

---

## 6. 下一步建议

1. **owner review D1 文档**:重点裁决两处——C9 provider 注入模式(双模式并列,建议「自管基线 + 注入覆盖」);C4 schema v1 十一类事件集合一次定死(P2-S1 一次 bump,S2/S3 不再 bump 版本)。
2. review 通过 → D1 文档由候选(DRAFT)升格 ADR-09 ACCEPTED(升格动作建议由 owner 或 owner 指定会话执行),随后签发 **P2-S1 启动指令**;本会话不自行启动 P2-S1。
3. 若 review 提出修改意见:按意见回改 D1 文档并出修订版执行报告,再行提交;P2-S2 任务书撰写时引用 C1–C12 编号与 §5.3 三个开放点。
