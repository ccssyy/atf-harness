# ATF 独立 Harness——L1a 门 2 设计增补：codec 契约 / 通道接口 / 试用范围

**日期**：2026-09-14 ｜ **执行方**：harness 侧会话（zcode）
**依据**：《ATF独立Harness_L1a门2任务书_20260914.md》§4.3（设计文档增补）／《ATF独立Harness_L1a设计_门1讨论稿_20260914.md》§1/§3 ／ ADR-07 ／ ADR-09 ／ R2a
**性质**：L1a 门 2 交付物之一——codec 契约、通道接口、试用范围的权威登记；实现以其为准。

---

## 1. codec 契约（wire 面，两协议）

### 1.1 分层与职责

```
会话事件流 ──transformContext──▶ LlmContextEvent[]
   ──adaptProjectionToMessages──▶ AdapterMessage[]（canonical，切片 2）
   ──codec.encodeRequestBody──▶ wire 请求体 ──HTTP──▶ 对端
对端响应 ──codec.parseResponse──▶ ModelResponse（canonical）
   ──expandModelResponse──▶ LlmDecision[]（A3 顺序展开）
   ──assertModelDecision（切片 0 守卫）→ 逐工具审批（切片 2）→ 分派
```

codec **只做形状转换**（任务书 §1.2 硬约束）：工具是否可调、是否需审批等业务判断一律在
codec 之外；守卫/展开/逐工具审批/`authorization` 语义零改动。

| `protocol` | 模块 | 端点 | 认证头 |
|---|---|---|---|
| `openai-chat`（默认） | `src/llm/openaiChatCodec.ts` | POST `{base}/v1/chat/completions` | `Authorization: Bearer <api_key>` |
| `anthropic-messages` | `src/llm/anthropicMessagesCodec.ts` | POST `{base}/v1/messages` | `x-api-key: <api_key>` ＋ `anthropic-version: 2023-06-01` |

api_key **只在出站请求头出现**；错误明细只记 host（别名/主机名粒度），不记完整 URL。

### 1.2 canonical → wire（请求方向）

| AdapterMessage | openai-chat | anthropic-messages |
|---|---|---|
| system（harness 静态提示） | 首条 `role:"system"` | 顶层 `system` 字符串 |
| user | `{role:"user", content}` | `{role:"user", content:[{type:"text"}]}` |
| assistant | `{role:"assistant", content}` | `{role:"assistant", content:[{type:"text"}]}` |
| assistant_tool_call | `role:"assistant"` ＋ `tool_calls:[{id, type:"function", function:{name, arguments:JSON 串}}]`；id = `call_<source_event_id>` 确定性派生 | assistant `content:[{type:"tool_use", id, name, input:对象}]` |
| tool_result | `{role:"tool", tool_call_id, content}` | user 消息内 `{type:"tool_result", tool_use_id, content, is_error}`（协议要求全部 tool_use 在紧随 user 内回填） |
| approval（往返） | **缓冲**，随配对 tool_result 之后作为一条 user 附言回填 | 同左，合并进配对 tool_result 所在的同一条 user 消息 |

wire 形状规则（`codecWire.ts` 单点承载，两 codec 共用语义）：
- **approval 缓冲**：线缆协议要求工具调用与其结果相邻（openai：tool_calls 后必须紧跟
  对应 role:tool；anthropic：角色交替＋tool_result 紧随）。夹在中间的审批往返消息缓冲至
  配对结果之后回填——审批事实原样进入模型上下文（问答轨历史对模型可见，B1 既定）；
- **悬空工具调用合成**（挂起尾）：run 挂起时流尾存在「有 tool/call＋审批往返、无 tool_result」
  的序列，线缆协议不容忍无结果的工具调用——以审批摘要文本合成工具结果（内容明示
  "工具调用未执行：审批未在进程内完成，动作未发生"）。**这是形状要求，不是业务放行**；
- 相邻 user 消息合并（anthropic 角色交替要求）；
- 请求体额外字段：openai-chat 恒带 `tool_choice:"auto"` 与 **`reasoning_effort`（显式携带，
  见 1.4）**；anthropic 恒带 `max_tokens`（线缆必填，默认 4096）。

### 1.3 wire → canonical（响应方向）与收束语义

| wire 形态 | canonical `ModelResponse` |
|---|---|
| tool_calls/tool_use 存在（content/text 可并存） | `{message?, tool_calls:[…]}`（openai arguments JSON 串须 parse 为对象；anthropic input 即对象） |
| 仅 content（openai） | `{final_answer}`——**loop 收敛语义**：纯文本答复即收束，防止"再问一次同答"空转 |
| 仅 text ＋ `stop_reason:"end_turn"`（anthropic） | `{final_answer}` |
| 仅 text ＋ 其他 stop_reason（anthropic）/ `finish_reason:"length"`（openai） | **err（fail-closed）**——截断/拒绝等非完整语义不猜测 |

非法响应一律 fail-closed（结构化 err，不猜测决策）：choices/content 缺失或空、arguments
非法 JSON、name 缺失、未知块类型（anthropic，如未启用的 thinking）、空内容等。
canonical 之后的展开（A3）与守卫（切片 0）在 codec 之外照常执行。

### 1.4 reasoning 参数（chat 面限制登记，任务书 §1.2）

官方文档（2026-09-14 核）："Starting with GPT-5.4, tool calling is not supported in Chat
Completions with `reasoning: none`"。**openai-chat codec 恒显式携带 `reasoning_effort`**
（默认 `low`，配置键 `reasoning_effort` 可改）；配置层对显式 `none` 结构化拒绝（本 loop
依赖工具调用）。anthropic-messages 无此限制，v1 不携带 thinking 参数。

### 1.5 配置面（providerConfig.ts）

- 七键（任务书 §1.1）：`protocol` / `base_url` / `api_key` / `model` / `timeout_ms`（默认
  60000）/ `max_retries`（默认 1，仅网络/超时/5xx 类决策请求可重试；每次重试计入调用
  预算；4xx 与解析错不重试）/ `max_calls_per_run`（默认 50，D5 成本护栏，与轮次预算 32/8 正交）；
- 两个协议面必要可选键（登记项，超出任务书键清单的理由见括号）：`reasoning_effort`
  （§1.4 要求显式携带）、`max_tokens`（anthropic 线缆必填）；
- 读取顺序：**环境变量覆盖配置文件**（`ATF_LLM_*` 键族；文件路径 = `ATF_LLM_CONFIG`，
  owner 指定、不入仓、权限 0600 否则拒绝加载）；未知键 / 未知 protocol / 缺 model /
  缺 api_key / base_url 内嵌 userinfo → 一律 fail-closed；
- `openai-responses` 只预留 codec 位：接入硬前提（官方迁移文档 2026-09-14 核）＝
  ① `store:false`（禁服务端存储）；② 禁用其内置/服务端工具执行（工具循环在对端执行会
  绕开守卫与逐工具审批）——两条未满足前不得接入，另批评估。

## 2. 通道接口（v1 定死）

### 2.1 接口面（`src/run/resume.ts`；前端无关）

- **list pending**：`listPendingApprovals(events) → PendingApproval[]`——纯函数，事件流推导。
  判定：`approval/request` 为待办 ⇔ 流内不存在以它为 `request_event_ref` 的**非 timeout**
  应答；同一 `approval_session` 内仅最新候选为待办（更早者 = 已被 supersedes 链替代）；
  仅 timeout 应答的请求仍待人工（「超时非否决」）；
- **submit answer**：四类 `granted` / `advised` / `denied` / `abort`（abort ↔ 问答轨 verdict
  `aborted`）。答复 = 一条 `approval/response` 事件（复用既有字段闭集：`verdict` / `actor`
  （账面标识，CLI 恒 `cli-operator`）/ `reason`（denied/abort/granted 备注承载）/
  `advice_text`（advised 承载）），目标解析 fail-closed（无待办 / 多待办缺省 / 目标已答
  或被替代 → 拒绝）。

**红线（ADR-07）**：通道只能由人触发——harness 侧不含任何自动应答路径。headless 等待
人工期间窗口耗尽 → 记 `approval/response{verdict:"timeout", actor:"harness"}`（审计留痕，
超时非否决）→ run 挂起 75；放行唯一来源 = 人显式提交的应答。

### 2.2 CLI 前端（`src/cli/resume.js`；socket/界面不实现，接口预留）

```
node dist/cli/resume.js --list --runs-root <dir> --run-id <id>
node dist/cli/resume.js --answer <granted|advised|denied|abort> [--note "…"] [--request <事件id>]
    --runs-root <dir> --run-id <id> --scenario-id <id> [--mock <对端脚本路径>]
```

退出码 = resume run 终局码（0/1/75/79）；配置经 `ATF_LLM_CONFIG` / `ATF_LLM_*` 注入。

### 2.3 resume 时序（INV-1 / INV-2 / durability 公理）

```
run 1（headless）: … → tool/call(admit) → ledger 未命中 → approval/request
                   → 等待人工超时 → approval/response(timeout, actor=harness)
                   → turn/end(reason=suspended) → exit 75          [INV-2：turn 收口]
resume（新进程）:  ① 打开既有流，取恢复水位线 W（= 流内最大事件 id）
                   ② 装载流历史进本进程（凭据判定/待办/turn 计数全部自流推导）
                   ③ 答复落 approval/response（id = W+1 > W → 凭据 available，ADR-09 C3）
                   ④ abort → 终局 79（不开新 turn；流尾无 open turn，INV-2 不涉及）
                      granted/advised/denied → turn/start 开新 turn [INV-1：turn 不跨进程]
                   ⑤ granted → 重派原 tool/call（复用原事件 id，不新增 tool/call 事件）
                      → executor 账本未命中 → 问答轨 findExistingCredential（按 tool_call_id
                      命中原 request）→ resolveCredentialState：无消费事实 + granted.id > W
                      → available → flush 前置 → 放行执行 → tool/result(call_ref=原 id)
                      → 一次性消费语义落定（P2-S2 语义零改动）
                   ⑥ 决策循环继续（模型见 tool/result / 拒绝/建议摘要后收束或换路径）
```

跨进程延续（L1a 增量，durability 公理同范式——种子全部自事件流推导，进程内行为零改动）：
- 提案状态（`approval_key` 粒度的 attempt / denied_count / supersedes 链 / 会话延续）从流内
  历史 seeding——denied 升级阈值（2 次）与 supersedes 审计链**跨进程不重置**；
- 审批会话 id 计数器自流内 `aps-N` 最大值续起（防撞号）。

## 3. 试用范围（v1 收口，任务书 §1.4 / D4）

- **允许**：只读全链（`atf.bind_run`（runner 桥接层，非模型工具）→ `atf_workspace_status` →
  `atf_fact_scan` → `atf_gate(query)`）＋ 仅 `atf_admit_data` 一类写；
- `atf_gate(query)` 的自主执行走**账本轨预录授权**（run setup 显式登记，双轨语义不变：
  账本轨优先、问答轨兜底）；写动作（admit）无预录 → 问答轨 → 挂起等人；
- 其余高危动作（gate advance、账本消费）维持挂起等人放行；切片 2 逐工具审批与
  `authorization` 恒 none 不放宽；
- 试用脚本（假端点回放面）与 D4 任务一一对应：读事实索引 → 报登记与闸门状态 →
  提下一步建议；中途一次 `atf_admit_data` 验挂起与放行。

## 4. 已知边界与登记项

1. mock 对端的账本/事实为进程内存态：resume 新进程的 mock 账本为空（真内核状态持久，
   不受影响）；试用链不依赖跨进程账本残留；
2. resume 报告的期望核验（expect_violations）恒空——CLI 无场景期望文件，断言由调用方
   承担（非豁免语义）；
3. codec 对 `openai-chat` 的 `finish_reason:"length"` 与 anthropic 非 `end_turn` 的纯文本
   响应按 fail-closed 处理（截断不猜测）；若未来真实模型频繁截断，以调大 max_tokens /
   缩短提示解决，不改判据。
