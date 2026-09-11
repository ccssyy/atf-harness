# ATF 独立 Harness——ADR-09:ACP 消费面定型

> **日期**:2026-09-10 ｜ **状态**:ACCEPTED(ADR-09)——owner review 通过(2026-09-10),v1.1 修订依据《ATF-Harness_Owner决议与启动指令_D1闭合_P2S1启动_20260910.md》
> **依据**:《ATF-Harness_Owner启动指令_Phase2_D1_20260910.md》+《ATF独立Harness_Phase2任务书_20260910.md》§1 +《ATF-Harness_Owner决议_Phase2范围确认与任务书签发_20260910.md》§1.2/§1.6 +《ATF-Harness_P2S2审批应答语义设计草案_20260910.md》§5 + Phase 0 四项 ADR(05/06/07/08)+ S5 决议①
> **抽象层级声明**(指令口径 #2):本文档只定**消费面形态**——调用载荷、事件投影、审批往返、配置注入、resume 语义;**不定传输层协议与实现选型**(JSON-RPC 帧格式、进程模型、鉴权机制均属 Phase 3)。
> **引用约定**:结论编号 C1–C12(P2-S2 / P2-S3 任务书条款细化时逐条引用)。

---

## 0. 结论先行

1. **消费面定位**:harness 作为外部宿主的**子代理被调用方**(callee)。宿主经控制面(dispatch / resume)驱动 run,经事件投影面读取会话流,经审批往返面转达高危调用授权,经 provider 配置面声明模型来源。四个面共同构成本 ADR 的定型范围;server 实现不在其中。
2. **核心结论一览**:

| # | 结论 | 一句话口径 |
|---|---|---|
| C1 | dispatch 形态 | 一次 dispatch = 创建一次 run;载荷 = trigger_instruction(必填)+ external_ref + approval_surface + provider 覆盖;run_id 由 harness 生成 |
| C2 | run 状态机 | running / suspended(非终态)+ 终态四类 completed / blocked / aborted / failed;退出码 0 / 78 / 1 / 75 / 79(suspended=75 可恢复、aborted=79 主动终止,两码为新增枚举补登,既有 0/78/1 语义不变),`resolveHeadlessExitCode()` 单出口 |
| C3 | resume 语义 | resume 仅对 suspended 有效,三动作 = answer / wait / abort;不新建 run、不重放已确认事件、不改 approval_session_id |
| C4 | schema v1 事件集合 | 11 类一次定死 = v0 七类 + `approval/request` + `approval/response` + `session/compaction` + `provider/switch`;P2-S1 一次 bump,S2/S3 不再 bump 版本 |
| C5 | 投影白名单 | 分层子集:必投 6 类 + 选投 4 类 + 不投 1 类(`assistant/attempt`);payload 原样透传,`ui` 不入事实投影,`projection.evidence_event` 保持 null |
| C6 | 审批会话模型 | 吸收 P2S2 §5 全部结论:`approval_session_id` ↔ `tool_call_id` 配对、统一 `approval/response` + `verdict` 六枚举、`supersedes` 演化链、`actor` 身份;增补 `request_event_ref` 兑现可审计配对 |
| C7 | 应答即授权凭据 | 授权真相源 = **账本记录 ∪ 已 granted 且未消费的问答会话**,两类依据并列、各自留痕、互不替代;`ledger_record` 为 setup-only 基建,不作运行时路径;fails-closed 逐条保持 |
| C8 | 超时分流 | 未声明 approval_surface = 账本轨-only,未命中 blocked(78),与 Phase 1 完全一致;已声明但对端超时 = `timeout` → suspended(非否决,可 resume) |
| C9 | provider 配置注入 | **owner 已裁决:B(harness 自管)基线 + A(宿主注入)Phase 3 增强**;凭据与端点不进载荷明文、不进会话事件 |
| C10 | 多轮审批透出 | 审批会话为透出一等单元:必投事件内联 + 按 `approval_session_id` 聚合重建;聚合视图是派生物,真相源唯一(磁盘 append-only log) |
| C11 | 不实现项 | 见 §3,与任务书 §5 条件项登记一致;本 ADR 结论**不触发闸 B、不触发 re-pin** |
| C12 | 条款对账 | 与 P2-S1/S2/S3 任务书条款**无冲突,无需条款级修订**;三个 payload 级开放点移交 S2 任务书(§5) |

---

## 1. 五节设计

### 1.1 dispatch / resume 的调用形态(C1–C3)

**定位**:一次 dispatch 对应既有实现中的一次分支执行(`ScenarioRunner.runBranch` 即其最小化雏形——mock 对端口径下已验证)。宿主嵌入后,dispatch 由 Phase 3 server 承载,run 的内部语义(三层工作区、会话 log、账本轨、GuardedSessionLog)与 Phase 1 完全一致。

**dispatch 载荷四要素**:

| 字段 | 必填 | 语义 |
|---|---|---|
| `trigger_instruction` | 是 | 触发指令,落盘为 `user/message` 事件(与 Phase 1 同构) |
| `external_ref` | 否 | 宿主侧关联标识;harness 不解释其内容,原样落 run meta。重复 `external_ref` 的 dispatch 拒绝(幂等保护,fail-closed) |
| `approval_surface` | 否 | 审批回调面声明(§1.3)。**缺省 = 问答轨不启用**——harness 不发 `approval/request`,审批仅走账本轨,未命中即 blocked(78),与 Phase 1 行为逐位一致(C8 前半) |
| `provider` | 否 | provider 配置覆盖(§1.4)。缺省 = harness 自管基线 |

dispatch 返回 run 句柄:`run_id`(harness 生成,即工作区目录名,Phase 1 语义)+ 初始状态 + 事件流订阅口(订阅通道的传输形态属 Phase 3,本 ADR 只约定「宿主可依 C5 白名单收到事件」这一能力)。

**run 状态机(C2)**:

| 状态 | 性质 | 进入条件 | 离开路径 |
|---|---|---|---|
| `running` | 非终态 | dispatch 成功;或 resume(answer/wait) | 正常收束 / 审批超时 / 故障 / 终止 |
| `suspended` | 非终态 | 已声明 approval_surface 且应答等待超时(`timeout` 落盘) | `resume(answer)`→ running;`resume(wait)`→ running;`resume(abort)`→ aborted。进程表达 = **exit 75**(EX_TEMPFAIL 语义:暂时无法继续,可恢复) |
| `completed` | 终态 | `final_answer` 正常收束 | exit 0 |
| `blocked` | 终态 | 账本轨 `approval_missing`(含 approval_surface 未声明场景) | exit **78**(锚点不挪用) |
| `aborted` | 终态 | 应答 verdict=abort;或宿主 resume(abort) | exit **79**(主动终止,harness 自定义码,登记入契约) |
| `failed` | 终态 | 会话拒绝(t0_ref_forbidden)/ 对端拒绝 / provider / 桥接 / 工作区故障,携带结构化原因 | exit 1 |

状态机与 Phase 1 的关系:`BranchOutcome` 四态(completed / approval_missing / session_rejected / failed)全部保留;本 ADR 仅新增 `suspended`(非终态)与 `aborted`(终态,由问答轨引入),两者分别以 75(可恢复)与 79(主动终止)表达,均不经由 78。

**resume 语义(C3)**:resume 是 suspended 唯一的离开入口,三种动作:

- `answer`:注入迟到的应答(载荷 = `approval/response` 同构,回流路径与 §1.3 完全一致——凭据化处置同规则,不因迟到而豁免);
- `wait`:不注入应答,仅恢复等待(超时时钟语义属 S2 细化,见 §5 开放点);
- `abort`:宿主显式终止 → aborted 终态。

resume 三条不变式:**不新建 run**(run_id 不变)、**不重放已确认事件**(append-only log 续写)、**不改 approval_session_id**(多轮配对跨挂起延续)。宿主进程崩溃重启后,经 run_id 重挂事件流即可恢复消费——真相源是磁盘 append-only log,replay 重建(Phase 1 已验证),宿主侧无状态要求。

### 1.2 会话事件向宿主的投影白名单(C4、C5)

**schema v1 事件集合(C4)**——11 类一次定死,由 P2-S1 完成 v0 → v1 显式 bump(含迁移说明:旧 v0 会话可 replay):

| 来源 | 事件类型 | 说明 |
|---|---|---|
| v0 既有(7 类) | `user/message`、`assistant/message`、`assistant/attempt`、`tool/call`、`tool/result`、`turn/start`、`turn/end` | 语义不变 |
| P2-S2 | `approval/request`、`approval/response` | 审批往返(载荷见 §1.3) |
| P2-S1 | `session/compaction` | 压缩动作落盘(哪次压缩吃掉了哪些事件,可审计可重建) |
| P2-S3 | `provider/switch` | provider 热切换落盘(命名就此定死,任务书原为暂名「如 provider/switch」) |

两条纪律重申:① **工作区动作(scratch_write / promote)仍不落会话事件**(S5 决议①),白名单不扩,宿主对工作区状态无事件流、仅可经显式查询面(Phase 3 定义);② compaction 只影响**投给模型的视图**(`transformContext` 投影),不改变磁盘事件流,因此也不改变宿主投影——宿主收到的是完整的落盘历史。

**宿主投影白名单(C5)**——v1 事件集合的分层子集:

| 层 | 事件 | 宿主语义 |
|---|---|---|
| 必投(6 类) | `turn/start`、`turn/end`、`user/message`、`assistant/message`、`approval/request`、`approval/response` | 宿主可依赖的最低面:进度骨架 + 审批往返(审批不可关,否则转达义务无法履行) |
| 选投(4 类) | `tool/call`、`tool/result`、`session/compaction`、`provider/switch` | 默认投;宿主可按能力声明关闭(如低带宽订阅只看进度与审批) |
| 不投(1 类) | `assistant/attempt` | 内部失败尝试:落盘、不进模型历史(transformContext 过滤)、亦不进宿主流;仅诊断视图可及 |

投影形态纪律:

1. **只读透传**:payload 原样透出,不改写、不重排、不摘要;`domain_refs` 随事件透出(审计面)。
2. `ui` 命名空间不入事实投影(与 convertToLlm 同纪律:仅界面/诊断,宿主 UI 可选读,非审计依据)。
3. `projection.evidence_event` 保持 `null`——TEM 回灌属 Phase 3 激活,本白名单不提前激活(ADR-06 细则 3)。
4. `ref_invalid` 标记(fail-closed 留痕)随事件透出,宿主不得隐藏(证据链断点必须可见)。
5. 宿主的**写路径仅两条**:控制面(dispatch/resume)+ 审批应答面(`approval/response`);对会话事件流无任何写路径。
6. (S1a 补句)投影中的压缩摘要条目为**投影合成物**,携带 `synthetic: true` 标记,与同 id 的白名单豁免原文区分;原文条目不携带该键。投影消费者应接受该标记并按 `(id, synthetic)` 唯一识别条目。本条不改变 C5 的三层白名单结论。

### 1.3 审批请求经宿主转达与应答回流的形态(C6、C7、C8)

**审批会话模型(C6,吸收 P2S2 §5 全部 schema 结论)**:

- 一次高危调用发起一次审批会话:`approval_session_id`(会话内多轮往返共享)↔ `tool_call_id`(被审批的 `tool/call` 事件 id)配对;
- 应答统一建模:单一事件类型 `approval/response` + `verdict` 枚举(决策六 C 口径,事件类型集合收敛):`granted | advised | denied | aborted | clarification | timeout`;
- 提案演化链:advise/deny 后由模型重新提案,新 `approval/request` 携带 `supersedes`(指向被替代的前次 request 事件 id),审计可回答「最终执行的是基于哪条意见改出来的」;
- 应答者身份:每条 `approval/response` 必落 `actor`(Phase 2 = 桩对端标识;Phase 3 = 宿主/人)——「谁批的」是审计必需项;
- **D1 增补字段** `request_event_ref`:应答指向被应答的那次 request 事件 id——P2S2 不变量 4(可审计配对:「每次应答都能回溯到被应答的那次请求」)要求此引用显式存在,任务书字段清单(「字段含……」)为下限,此为增量不是冲突。

**事件载荷形态草案**(字段级细节 S2 任务书可细化,语义锚点在此):

```text
approval/request payload:
  approval_session_id : string        // 审批会话唯一标识(多轮共享)
  tool_call_id        : integer       // 被审批的 tool/call 事件 id
  tool                : string        // 工具名
  params              : unknown       // 原样参数(转达人须可读)
  approval_key        : string        // tool + params digest(与账本轨同构,供落账本)
  rationale           : string?       // 调用理由(模型侧提供)
  attempt             : integer       // 同提案重提计数(1 起;≥2 触发升级,常量阈值)
  supersedes          : integer?      // 被本提案替代的前次 request 事件 id

approval/response payload:
  approval_session_id : string
  request_event_ref   : integer       // 被应答的 approval/request 事件 id(D1 增补)
  verdict             : granted | advised | denied | aborted | clarification | timeout
  actor               : string        // 应答者身份(timeout 时 = "harness"(系统标记,非人非宿主))
  reason              : string?       // deny 理由(建议留)
  advice_text         : string?       // advise 意见原文(必留)
  question            : unknown?      // clarification:对端要求补充的上下文说明
```

**转达与回流的往返形态**(消费面时序,传输机制属 Phase 3):

```text
模型提案(tool/call 落盘,须审批)
  → harness 落 approval/request(白名单必投 → 宿主转达人)
  → 等待应答:
      granted      → 应答凭据化(C7:granted 且未消费 = 授权凭据·依据二)
                     → 审批检查点核对凭据 → 放行执行
                       (账本轨 record/consume 不在此路径;ledger_record 为 setup-only,
                        不作运行时使用——owner 决议 §2.1)
                     → tool/result 落盘 → 继续
      advised      → 意见原文回填模型 → 模型重新提案(新 request 带 supersedes)→ 回到等待
      denied       → 结构化 block 回填 → 模型可换路径(同提案重提计数 +1,≥2 升级)
      aborted      → run 终态(aborted),不重试不降级
      clarification→ harness 补足上下文 → 重发 request(同一 approval_session_id)→ 回到等待
      超时         → harness 落 verdict=timeout(actor="harness")→ run 挂起 suspended
                     → resume(answer) 注入迟到应答 → 按其 verdict 处置(含落账本)
```

**应答即授权凭据(C7,owner 决议 §2.1 改判)**:问答轨的一次 granted **不以写入内核账本为前置**——应答事件本身(`approval/response`,带 `actor` / `request_event_ref` / `approval_key`)即**授权凭据**,与账本记录并列成为审批检查点的两类依据:

- **依据一(账本轨)**:`ledger_query` 命中且未消费的记录 → 消费放行(**语义零改动**);
- **依据二(问答轨)**:本 run 内同一 `approval_session_id` 的 `granted` 应答事件,且未被消费(一次性)。

**ADR-07 表述精化**(owner 决议 §2.1 第 2 款,文字级增补,不动机制):授权真相源 = **账本记录 ∪ 已 granted 且未消费的问答会话**;两类来源各自留痕、互不替代、互不豁免。

fails-closed 性质逐条保持(owner 决议 §2.1 第 4 款):

- **没有真实应答事件落盘 → 无授权凭据 → 不执行**;账本查询故障 → 不猜测通过(Phase 1 既有口径);
- 一次 granted 一次性消费,无配额复用(P2S2 不变量 2);凭据消费状态的记录形态见 §5.3 开放点(d);
- **`ledger_record` 为 setup-only 基建**(`bridge.contract.yaml` 既有登记:仅测试/冒烟 setup 用途),Phase 2 一律不得作为运行时路径使用;「问答授权是否并入内核账本(`ledger_record` 运行时化)」登记为 **C1 re-pin 后议题**,由内核实际能力实测后决议,本轮不做、不探索;
- **宿主/外部的「自动应答」配置对闸门永远无效**:没有真实应答事件落盘、且账本无未消费记录,就没有执行(fails-closed)。

**超时分流(C8)**:

| 场景 | 行为 | 依据 |
|---|---|---|
| dispatch 未声明 approval_surface | 问答轨不启用,不发 request;账本轨未命中 → blocked(78) | 任务书 S2 要求 6「headless 等价性」逐字满足,Phase 1 行为零漂移 |
| 已声明 approval_surface,应答等待超时 | verdict=timeout → suspended(非否决,可 resume) | P2S2:超时 ≠ 拒绝;任务书 S2 要求 2(timeout → suspend) |

**双轨并存**(决议六 F,消费面表达):审批检查点先查账本(ledger_query),命中未消费 → 走消费放行(问答轨不启用);未命中且 approval_surface 已声明 → 发 approval/request;未命中且未声明 → blocked(78)。账本轨语义(一次性消费、78 锚点)零改动。

### 1.4 provider 配置的注入来源(C9,双模式对照;owner 已裁决 B 基线 + A 增强)

| 维度 | 模式 A:宿主注入 | 模式 B:harness 自管 |
|---|---|---|
| 配置来源 | dispatch 载荷(`provider` 字段:provider_id + profile 引用) | harness 本地环境(环境变量 / 本地配置 / 场景脚本——Phase 1 现状,`LlmProvider` 实现自脚本注入) |
| 凭据保管 | 宿主持有,经凭据句柄机制转交(**机制属 Phase 3 鉴权面,本 ADR 不定**) | harness 环境持有(Phase 2 全程 Faux,无真实凭据) |
| 切换发起方 | 宿主(仅 turn 边界,`provider/switch` 落盘) | harness 内部策略(Phase 2 = 场景脚本声明) |
| 适配场景 | Phase 3 宿主嵌入、多租户/多模型编排 | headless 冒烟、CI、Phase 2 全程 |
| 风险 | dispatch 载荷面扩大:注入内容须校验,fail-closed 责任在 harness | 凭据落 harness 环境,脱敏纪律(AGENTS.md §3.7)压力大;无宿主编排能力 |

**注入/覆盖语义(两模式下一致)**:dispatch 载荷未携带 `provider` → 回退自管基线;携带 → harness 校验后覆盖,生效仍受热切换规则约束(仅 turn 边界、切换前后 `domain_refs` digest 校验连续、`provider/switch` 事件落盘——P2-S3 条款不动)。

**裁决(owner,2026-09-10,决议 §2.3)**:**B 为基线,A 为 Phase 3 增强**。Phase 2 只实现自管路径;dispatch 载荷的覆盖语义按下述口径保留,Phase 3 启用 A 模式时消费面零改动。理由:① Phase 2 全程无真实宿主,自管是唯一可验证路径,冒烟先行验证不阻塞;② 凭据经 dispatch 载荷明文传递与 TCB/脱敏纪律有张力,句柄机制成型前不宜把注入做成主路径;③ 覆盖语义已定义,Phase 3 启用 A 模式时消费面零改动,只是填上凭据句柄的传输机制。

**红线(两模式共同)**:凭据与端点**不进 dispatch 载荷明文**(载荷只到 provider_id + profile 引用粒度)、**不进会话事件**(payload / ui 均不得出现);provider 配置的实际取值变更必须以 `provider/switch` 事件落盘留痕。

### 1.5 多轮审批会话如何透出(C10)

**审批会话生命周期**(透出一等单元):

```text
created(open)
  ├─ granted      → 执行 → settled(executed)
  ├─ denied       → settled(denied)(同提案重提计数 +1,≥2 升级:abort 或上报)
  ├─ aborted      → settled(aborted)(run 终态)
  ├─ advised      → 模型重提案(新 request,supersedes)→ 回 open(同一会话)
  ├─ clarification→ 补上下文重发 request → 回 open(同一会话)
  └─ 超时          → suspended → resume(answer) → 回 open(同一会话)
```

**透出形态两层**:

1. **事件内联(必投)**:`approval/request` 与 `approval/response` 均在 C5 必投层——宿主与终端用户在任意时刻能看到当前 open 的审批会话及其全部历史轮次(这是「转达」义务的数据基础,不可关闭)。
2. **聚合重建(派生视图)**:宿主可按 `approval_session_id` 对事件流聚合,重建单会话完整时间线:提案链(supersedes 演化)、各轮 verdict、actor、耗时。聚合规则是确定性的纯函数(由事件流重放即得),**聚合视图是派生物,不是第二真相源**;真相源唯一 = 磁盘 append-only 会话 log。

**多轮纪律**:clarification / advise 往返不新开会话(`approval_session_id` 不变);跨 suspend/resume 配对延续(C3);settled 之后的迟到应答一律拒绝且拒绝动作落盘留痕(fails-closed,防双花);同提案(工具名 + 参数摘要)重提阈值 2 次升级,阈值取常量、不暴露给模型(决议六 D)。

P2-S2 验收锚点直接引用:多轮 clarification 往返配对到同一审批会话;supersedes 演化链可审计。

---

## 2. 接口草案

> 声明形态的对照锚点,**不是本仓代码**——不落 `src/`,不进构建;P2-S2 落 schema v1 载荷、Phase 3 落 server 时以此为准逐字段对照。TypeScript 声明仅为表达精度,零依赖。

```ts
// ── 控制面(§1.1)──────────────────────────────────────────────

interface DispatchRequest {
  trigger_instruction: string;
  external_ref?: string;                    // 宿主关联标识;重复 → 拒绝(fail-closed)
  approval_surface?: ApprovalSurfaceDescriptor; // 缺省 = 账本轨-only(Phase 1 等价)
  provider?: ProviderConfigOverride;        // 缺省 = 自管基线(§1.4)
  resource_root?: string;                   // 工作区根定位;缺省 = harness 默认(环境变量注入)
}

// 形态占位:声明粒度只到「存在可应答的回调面」;通道实现属 Phase 3
interface ApprovalSurfaceDescriptor {}

interface DispatchReceipt {
  run_id: string;                           // harness 生成 = 工作区目录名
  state: "running";
  // 事件流订阅口(形态 Phase 3 定);能力承诺 = 按 C5 白名单收到事件
}

type ResumeAction =
  | { kind: "answer"; response: ApprovalResponseInput }  // 迟到应答,回流路径含落账本
  | { kind: "wait" }                                     // 恢复等待(时钟语义 S2 细化)
  | { kind: "abort"; reason?: string };

interface ResumeRequest { run_id: string; action: ResumeAction; }

// ── run 状态机(§1.1)──────────────────────────────────────────

type RunState =
  | { kind: "running" }
  | { kind: "suspended"; pending_session: string }       // approval_session_id
  | { kind: "completed" }                                // exit 0
  | { kind: "blocked"; block: { reason: "approval_missing" } } // exit 78(锚点)
  | { kind: "aborted"; reason: string }                  // 退出码映射:S2 开放点(b)
  | { kind: "failed"; error: { code: string; message: string } }; // exit 1

// ── 审批往返(§1.3,schema v1 事件载荷)────────────────────────

type ApprovalVerdict =
  | "granted" | "advised" | "denied" | "aborted" | "clarification" | "timeout";

interface ApprovalRequestPayload {
  approval_session_id: string;
  tool_call_id: number;                     // tool/call 事件 id
  tool: string;
  params: unknown;
  approval_key: string;                     // tool + params digest(与账本轨同构)
  rationale?: string;
  attempt: number;                          // 同提案重提计数,1 起
  supersedes?: number;                      // 前次 request 事件 id
}

interface ApprovalResponseInput {
  approval_session_id: string;
  request_event_ref: number;                // D1 增补:被应答的 request 事件 id
  verdict: ApprovalVerdict;
  actor: string;                            // timeout 时 = "harness"
  reason?: string;
  advice_text?: string;                     // advise 意见原文(必留)
  question?: unknown;                       // clarification 补充要求
}

// ── provider 配置(§1.4)──────────────────────────────────────

interface ProviderConfigOverride {
  provider_id: string;                      // harness 侧注册标识(如 "faux-scripted")
  profile?: string;                         // provider 内 profile 引用
  // 刻意没有更多字段:凭据/端点不进载荷明文(红线)
}
```

---

## 3. Phase 2 不实现项清单

与任务书 §5 条件项登记及硬约束(❌ 项)一致:

| # | 不实现项 | 归属 |
|---|---|---|
| 1 | ACP server 本体(进程模型、连接生命周期、方法路由) | Phase 3 |
| 2 | TUI / Web 界面(审批问答的人机界面) | Phase 3/4 |
| 3 | `projection` 激活(TEM 回灌,`evidence_event` 启用) | Phase 3 |
| 4 | P2-S4 晋升闸 B(T2 冻结区写入通道) | 条件项(任务书 §5) |
| 5 | C1 真实对端接入(re-pin) | 条件项(任务书 §5) |
| 6 | 传输层协议与实现选型:JSON-RPC 帧格式、进程模型、鉴权机制、凭据句柄传输、事件流推送/拉取通道 | Phase 3(本 ADR 口径 #2 边界) |
| 7 | 宿主多轮对话式追加 prompt 的会话编排(v1 消费面 dispatch = 单指令 run) | Phase 3 |
| 8 | 真实 LLM Provider / 网络调用 | Phase 5/真实验证阶段(owner 显式授权) |
| 9 | 「授权即改」快捷路径(`amended_proposal` 仅留扩展位) | 不做(决议六 E) |

**条件项触发核查**:本 ADR 结论**不触发闸 B**(未产生 harness 侧管理 T2 的需求——provider 配置与会话事件均不属 T2 冻结合同区);**不触发 re-pin**(问答回流落账本沿用既有 `ledger_record` 桥接方法,mock 对端已承载,无需内核新能力)。

---

## 4. 与 Phase 3 的边界声明

1. 本文档只定**消费面**:调用载荷、事件投影白名单、审批往返、配置注入、resume 语义。
2. **传输层协议与实现选型全部归 Phase 3**:JSON-RPC 帧格式、进程模型(spawn / 常驻)、鉴权机制、凭据句柄传输、事件流通道(推送/拉取/重连)、`external_ref` 幂等索引的存储形态。本文档对这些只字不选。
3. ACP 公开规范(`session/new` / `session/load` / `session/prompt` / `session/request_permission` / `session/update`,agentclientprotocol.com)仅作**形态参考**——本 ADR 的 dispatch/resume/审批往返与其语义同构,便于 Phase 3 选型时映射;**不构成本仓任何依赖**(R2a 零依赖纪律),Phase 3 是否采用 ACP 作为传输协议属选型决策,另行评审。
4. `projection`(TEM 回灌)激活、闸 B 触发判定、re-pin 均不在本文档范围(§3)。
5. (S1b 登记)**会话流无防篡改链**:这是已知边界,不是待办承诺——「整条尾部完整事件被连同 LF 删除」在结构上不可检测(文件以更早的 LF 结尾、不构成残段),发现此类删除需外部锚(run journal 事实 / catalog sha);Phase 2 不实现会话流 hash chain。
6. **生效方式**:owner review 通过 → 本文档升格 ADR-09 ACCEPTED;S2/S3 任务书按 C1–C12 细化条款(细化属条款级修订,不改范围,如需修订任务书原文按指令口径 #6 书面提出)。

---

## 5. 与 P2-S1/S2/S3 任务书条款的对账(C12)

### 5.1 逐条对账

| 任务书条款 | D1 结论 | 对账结果 |
|---|---|---|
| S1 要求 2(`session/compaction`、v0→v1 bump、迁移说明) | C4 | 一致;D1 补充:**v1 一次 bump 定死 11 类**,S2/S3 不再 bump |
| S1 要求 3(append-only,replay 投影一致) | C5、C10 | 一致;compaction 不影响宿主投影(§1.2 纪律②) |
| S1 要求 6/7(fsync 双档) | 不涉 | 无冲突;「已确认事件不丢」durability 语义是 suspended/resume 可信的前提 |
| S2 要求 1(审批会话模型落 schema v1;字段含四项) | C4、C6 | 一致;D1 增补 `request_event_ref`(任务书「字段含」为下限,增量非冲突) |
| S2 要求 2(六类应答分支处置) | C6、C7、C8 | 一致(verdict 枚举与处置路径逐条吻合);granted 分支为**凭据化放行(依据二)**,不以落账本为前置(决议 §2.1 改判) |
| S2 要求 3(拒绝循环阈值 2 次常量) | C10 | 一致 |
| S2 要求 4(无配额复用) | C7 | 一致(一次 granted 一次性消费;凭据即授权,消费状态记录形态见 §5.3 开放点(d)) |
| S2 要求 5(双轨并存,账本轨优先,账本轨零改动) | C7、C8 | 一致;消费面表达见 §1.3 双轨并存段;executor 审批检查点接受第二类依据属 S2 实现范围(决议 §2.1 第 6 款) |
| S2 要求 6(headless 等价性) | C8 | 一致(未声明 approval_surface = Phase 1 逐位等价) |
| S2 要求 8(退出码单出口、终局语义保护) | C2 | 一致;`suspended` 非终态不经 78 表达 |
| S3 要求 2(热切换、切换事件暂名「如 provider/switch」) | C4 | 一致;事件名就此定死 `provider/switch`(暂名转正,非冲突) |
| S3 要求 1/3(第二 provider、R2b) | C9 | 一致;S3 实现自管路径(B 基线已裁决),注入模式为 Phase 3 增强 |
| 退出码映射(决议 §2.2 定案) | C2 | 定案:completed=0 / blocked=78 / failed=1 / suspended=75 / aborted=79,映射仍经 `resolveHeadlessExitCode()` 单出口;75/79 为新增码登记入契约,不改既有 0/78/1 语义(枚举补登,不触发 `contract_version` bump);终局语义保护条款延续 |

### 5.2 条款级修订建议

**无**。未发现 D1 结论与 P2-S1/S2/S3 任务书条款存在冲突,无需按指令口径 #6 提出修订。

### 5.3 移交 P2-S2 任务书的 payload 级开放点(非 D1 缺口,登记防遗漏)

> 原开放点 (b)(suspended/aborted 退出码映射)已由决议 §2.2 **定案**(75/79),移入正文(C2、§1.1 状态机表),不再是开放点。

| # | 开放点 | 建议方向 |
|---|---|---|
| a | `approval_session_id` 生成形态(唯一性、可读性) | harness 侧单调标识或 UUID,形态 S2 定;消费面只要求全局唯一且落盘 |
| c | advise 意见原文与 clarification 载荷的字段命名细化 | 本 ADR 以 `advice_text` / `question` 表意,S2 可改命名,语义锚点不变 |
| d | **问答授权凭据的消费状态记录形态**(决议 §2.1 新增) | **状态更新(S1b 决议 §2.2):由 P2-S2 首发交付小设计(先设计后实现,owner review 通过后再实现;S1b 不预写)。四条约束:① 重启幂等——run 恢复后同一凭据不得重复消费(防双执行);② 不新增第 13 类事件——若无解,走 schema v2 定义修订并报 owner(不得夹带);③ 禁 setup 基建——不得以 `ledger_record` 等承载消费事实;④ fail-closed 优先——执行与消费事实的先后顺序必须明示,不确定即阻断,不得「猜已执行」** |

---

## 6. 参考资料(仅形态对照,零依赖)

- Agent Client Protocol(ACP)公开规范:agentclientprotocol.com——`session/new`(对应 dispatch)、`session/load`(对应宿主重挂/恢复消费)、`session/prompt`(对应 trigger_instruction 驱动)、`session/request_permission`(对应审批转达)、`session/update`(对应事件投影)。Phase 3 传输选型时作对照,本文档不以其为依赖前提。

---

## 修订说明

- **v1.0**(2026-09-10,commit `fc1fda2`):初版,候选(DRAFT),交 owner review。
- **v1.1**(2026-09-10):依据《ATF-Harness_Owner决议与启动指令_D1闭合_P2S1启动_20260910.md》升格 **ACCEPTED(ADR-09)**。改动仅限决议 §3 清单位置:
  1. 文首状态块:DRAFT → ACCEPTED(ADR-09),注明决议日期与文档名(文件名按登记保持不变);
  2. §0 C7 行改判:**应答即授权凭据**(账本记录 ∪ 已 granted 未消费的问答会话,两类依据并列;`ledger_record` setup-only);
  3. §0 C2 行补退出码映射 0 / 78 / 1 / 75 / 79;
  4. §0 C9 行标注 owner 已裁决(B 基线 + A 增强);
  5. §1.3 C7 段按决议 §2.1 口径重写,新增「ADR-07 表述精化」小节,删除运行时落账本表述,保留 fails-closed 论证;
  6. §1.3 往返时序图 granted 分支改为「凭据化 → 审批检查点依据二 → 放行执行」,标注 `ledger_record` setup-only;
  7. §1.1 状态机表落定 suspended=75、aborted=79(连同 §1.1 resume `answer` 行的同步一致性微调);
  8. §1.4 「建议(待 owner 裁决)」→「裁决:B 基线 + A 增强」;
  9. §5.1 更新 C7/S2 要求 2/4/5 行对账结论,新增退出码映射对账行;
  10. §5.3 原开放点 (b) 定案移入正文,新增 (d) 授权凭据消费状态记录形态;
  11. 本修订说明块。
- C1–C12 结论编号体系保持,未新增编号;§1.1 载荷四要素、§1.2 事件集合与投影白名单、§1.5 透出模型、§3 不实现项、§4 边界声明未改动。
- **v1.2**(2026-09-10):依据《ATF-Harness_Owner决议与启动指令_P2S1验收_S1a修复_20260910.md》§3 第 5 项,§1.2 投影形态纪律补一条(投影摘要条目携带 `synthetic: true`,投影消费者按 `(id, synthetic)` 唯一识别);仅此一处,不改 C5 三层白名单结论。
- **v1.3**(2026-09-11):依据《ATF-Harness_Owner决议与启动指令_S1a验收_S1b收尾_20260911.md》§3 第 4/5 项——§4 边界声明补第 5 条(会话流无防篡改链,已知边界非承诺);§5.3 开放点 (d) 标注为「P2-S2 首发小设计」并附四条约束摘要;仅此两处。
