# ATF 独立 Harness——L1a 门 2 执行报告：配置式 provider ＋ CLI 最小人在回路

**签发**：harness 侧会话（zcode，worktree `.worktrees/l1a-provider`，分支 `work/20260914-l1a-provider`）
**日期**：2026-09-14
**依据**：《ATF独立Harness_L1a门2任务书_20260914.md》（§0 D1–D6 ／ §1 范围四项 ／ §2 硬约束 ／ §3 VERIFY 八项 ／ §4 交付物）＋《ATF独立Harness_L1a设计_门1讨论稿_20260914.md》§1/§3 ＋ ADR-07 ／ ADR-09 ／ R2a
**性质**：**本地提交未推送，推送待 owner 另行授权**；内核仓零改动（真对端轨 pin 副本 `git status` 零改动断言通过）；`bridge.contract.yaml` 零改动；**门 2 零真实网络调用**（LLM 面只连 127.0.0.1 本地假端点）；切片 0 守卫 / 切片 1 预算（32/8）/ 切片 2 逐工具审批与 `authorization` 恒 none 未放宽；不实现 socket/界面/流式/多模态/ACP，projection 不激活，不接真实 TEM
**前置交付**：《L1a 门 2 条款级完成清单》（开工前已提交，已全部 ✅ 并回填证据章节）

---

## 1. 配置层说明（任务书 §1.1 / D2 / D5）

- 模块：`src/llm/providerConfig.ts::loadLlmProviderConfig(env)`；
- 七键 ＋ 两个协议面必要可选键（`reasoning_effort` / `max_tokens`，扩充理由登记于设计增补 §1.5）；读取顺序 **环境变量覆盖配置文件**（`ATF_LLM_*` 键族）；文件路径 = `ATF_LLM_CONFIG`（owner 指定、不入仓）；
- **fail-closed 全覆盖**：未知 `protocol`（含 `openai-responses` 预留位显式拒绝与硬前提提示）/ 缺 `model` / 缺 `api_key` / 未知配置键 / 非 JSON 文件 / **权限非 0600**（D2 硬约束，group/other 任一位存在即拒）/ `base_url` 内嵌 userinfo 凭据 / `reasoning_effort="none"`（GPT-5.4 chat 面限制）——全部结构化拒绝，不猜测回退；
- 默认值收在常量层：timeout 60000ms / max_retries 1 / **max_calls_per_run 50**（D5）/ reasoning low / max_tokens 4096；
- **凭据面**：`api_key` 只被 `HttpLlmProvider` 私有持有，只在出站请求头出现（codec `authHeaders`）；VERIFY 1 用例与全链脱敏断言见 §6。

## 2. 两 codec 说明（任务书 §1.2 / D6）

- `openai-chat`（默认，`src/llm/openaiChatCodec.ts`）：`messages`（首条 system）／`tools:[{type:"function",function:{name,description,parameters}}]`／`tool_calls[]`（arguments 为 JSON 字符串，parse 失败即拒）／`finish_reason`（`length` 截断 = fail-closed）／`Authorization: Bearer`；**恒显式携带 `reasoning_effort`**（GPT-5.4 起 `reasoning:none` 下工具调用不受支持——显式携带＋配置层拒绝 `none`，登记于设计增补 §1.4）；
- `anthropic-messages`（`src/llm/anthropicMessagesCodec.ts`）：顶层 `system`／`tools:[{name,description,input_schema}]`／`content[]` 内 `tool_use`（`input` 为对象）／工具结果以 user 消息内 `tool_result` 回填（含 `is_error`）／`stop_reason`（纯文本非 `end_turn` = fail-closed）／`x-api-key` ＋ `anthropic-version: 2023-06-01`／`max_tokens` 恒填；
- **形状规则单点承载**（`codecWire.ts`）：approval 往返缓冲至配对 tool_result 之后回填；挂起尾悬空工具调用以审批摘要合成工具结果（线缆形状要求，**非业务放行**）；相邻 user 合并（anthropic）；
- **收束语义**（登记于设计增补 §1.3）：仅 content/text ＋ 完整收尾 → `final_answer`（loop 收敛，防"再问同答"空转）；工具调用与文本并存 → message ＋ tool_calls；
- **只做形状转换**：codec 无任何审批/工具可调性判断；canonical 面之后照常走 `expandModelResponse`（切片 2）→ `assertModelDecision`（切片 0 守卫）→ 逐工具审批；
- fixture 级测试（`tests/llm/codecOpenAI.test.ts` 11 用例 / `tests/llm/codecAnthropic.test.ts` 10 用例）：请求构造、响应解析、工具调用与结果回填形状、正反例 fail-closed、canonical↔wire 双向保形——**零网络依赖**。

## 3. CLI 通道与 resume 语义（任务书 §1.3；INV-1/INV-2）

- **通道接口**（`src/run/resume.ts`，前端无关 v1 定死）：`listPendingApprovals`（待办 = 无非 timeout 应答的请求；同会话仅最新候选；「超时非否决」）/ `submit answer` 四类（`granted`/`advised`/`denied`/`abort` → 问答轨 `aborted`）；目标解析 fail-closed（无待办/多待办缺省/已答或被替代 → 拒绝）；
- **CLI 前端**（`src/cli/resume.ts`）：`resume --list` / `resume --answer <verdict> --note "…" [--request <id>]`；答复落 `approval/response`（actor 账面标识 `cli-operator`）→ **resume 开新 turn**；退出码 = run 终局码；
- **红线**：通道只由人触发——harness 无任何自动应答路径；run 1 挂起复用既有 timeout 语义（`approval/response{verdict:"timeout", actor:"harness"}`，审计留痕非应答）；**socket/界面不实现**（接口预留）；
- **resume 时序**（granted 凭据路径全部走 P2-S2 既有纯函数，语义零改动）：水位线先取（应答前）→ 答复落盘（id > 水位线 → `available`，ADR-09 C3）→ 开新 turn → **重派原 tool/call**（复用原事件 id，不新增 tool/call）→ `findExistingCredential` 按 tool_call_id 命中 → `resolveCredentialState` available → flush 前置 → 放行执行 → `tool/result(call_ref=原 id)` 一次性消费落定；
- **跨进程延续种子**（`approvalTrack.ts`，纯增量）：提案状态（attempt/denied_count/supersedes 链/会话 id）自事件流 seeding——denied 升级阈值与 supersedes 审计链跨进程不重置；会话计数器自流内 `aps-N` 续起防撞号。

## 4. 假端点闭环与挂起/放行闭环原始输出（VERIFY 3/4/5；含落盘证据）

**假端点**（`src/llm/fakeEndpoint.ts`）：127.0.0.1 回环 node:http 服务器，回放式——逐笔校验/记录请求（路径、认证头匹配布尔、key 是否入体、请求体快照），按脚本回放 canonical 响应（经 codec `encodeWireResponse`）；支持 HTTP 状态/非法形状/非 JSON/延迟注入；脚本耗尽 = 500 显式失败信号。

**D4 试用任务全链（`npm run smoke:l1a`，CLI 子进程实跑）原始输出**：

```
L1a 门 2 冒烟（D4 试用任务）通过 ✓
  - run 1: 挂起闭环成立（exit 75；approval/request#10 tool=atf_admit_data；turn 收口 reason=suspended）
  - run 1: 模型调用 4 次（只读链 + admit 提案），全部经守卫与逐工具审批
  - CLI resume --list: 待办可见（request#10，status=timeout_awaiting_human）
  - CLI resume --answer granted: exit 0；resume 终局: outcome=completed exit=0 事件数=17
  - 落盘证据: granted 应答 + 2×turn/start（新进程新 turn）+ tool/result(ok=true, call_ref=9) 全在流内
  - 零外连断言: 5 笔请求全部命中回环 /v1/chat/completions；认证头一致；key 未入请求体
  - 脱敏断言: 事件/报告/会话流/CLI 输出全序列化不含 fake key
```

链路展开（run_id=run-l1a-trial；对应 VERIFY 3/4/5 逐项）：

```
run 1: bind_run(runner 桥接) → workspace_status → fact_scan → gate(g1,query)[账本预录授权,自主完成]
       → atf_admit_data(无预录) → approval/request → 等待耗尽 → timeout(actor=harness)
       → turn/end(reason=suspended) → exit 75                      [VERIFY 3 + 4, INV-2]
CLI:   --list → 待办 request#10 可见
       --answer granted --note "同意准入 ds-l1a-trial（已备案）" → exit 0
resume: approval/response(granted, actor=cli-operator) 落事件 → turn/start 开新 turn [INV-1]
       → 重派原 tool/call(id=9,不新增) → 凭据 available 放行 → tool/result(ok=true, call_ref=9)
       → 模型见结果 → final_answer → completed exit 0              [VERIFY 5, 可复核证据齐]
```

E2E 测试（`tests/run/l1aE2e.test.ts`，8 用例）覆盖同链路进程内变体：只读链自主完成、挂起 75＋INV-2、放行执行＋INV-1（`deriveLoopStateFromEvents` 流推导 turns_opened=2）、**非挂起流拒绝恢复**（fail-closed）、anthropic-messages 协议全链互换。

## 5. 拒绝/建议/中止分支与成本护栏（VERIFY 6/7）原始要点

- **denied**（E2E 实测）：应答落流（`verdict:"denied"`＋人读理由）→ resume 开新 turn → 模型换路径收束 → `atf_admit_data` **零成功回填**（不执行且可解释）；
- **advised**（E2E 实测）：建议原文回填（`advice_text`）→ **不构成放行**（零执行回填）→ 模型重提案 → 新 request `attempt=2`、`supersedes=原 request id`（**跨进程 supersedes 链经流种子延续**）→ 再次挂起 75 → granted → 执行 → completed；
- **abort**（E2E 实测）：应答落流 → run 终态 **exit 79** → 不开新 turn（流尾无 open turn，INV-2 不涉及）→ 零执行；
- **成本护栏**（D5）：`max_calls_per_run`（默认 50 可配，重试计入）命中 → `err(call_budget_exhausted)`（结构化可区分）→ runner 折算 `provider_failure` 终局 exit 1，原始错误码留存 `detail.code`——**不静默继续**；与轮次预算（32/8，未触碰）正交（E2E 断言 `detail.code==="call_budget_exhausted"` 且 `detail.detail.limit` 为配置值）。

## 6. 脱敏与零外连断言（任务书 §2 / §3.1/§3.3）

- **零外连**：假端点请求台账逐笔断言——全部命中 `127.0.0.1:<ephemeral>` 回环协议路径；单测层以 fetch 注入面拦截断言（`tests/llm/httpProvider.test.ts`：全部 URL = 配置 base_url + 协议路径，URL 出域即用例失败）；`smoke:l1a` 台账请求数 = provider 实调数；
- **认证**：每笔请求认证头与期望假 key 等值匹配（openai `Authorization: Bearer` / anthropic `x-api-key`＋`anthropic-version`）；
- **脱敏**：① key 不入请求体（台账逐笔断言 `apiKeyInBody=false`）；② 全事件＋报告＋会话流＋CLI stdout/stderr 全序列化不含 fake key（smoke 断言）；③ 错误漏斗：5xx 响应体故意含 key 的反例 → 报错消息与 detail 均 `[REDACTED]`；④ 错误 detail 只记 host（ADR-09 红线：别名/主机名粒度，不记完整 URL）；
- **仓内零凭据**：测试假 key 全部显式标注（`fake-*-DO-NOT-USE`），仅运行期存在于 tmp/（不入仓）。

## 7. 零回归数字（VERIFY 8，两轨＋四冒烟）与纪律核对

| 轨道 | 门 2 前（切片 2 基线） | 门 2 后 | 判定 |
|---|---|---|---|
| 真对端轨（`ATF_CLI_PATH=.atf-pinned`，HEAD=`b6db349…`=pin） | 241 passed / 1 skipped（34 文件） | **329 passed / 1 skipped（40 文件）** | ✅ 基线全保留＋88 用例 |
| mock 轨（不设） | 236 passed / 9 skipped（34 文件） | **324 passed / 9 skipped（40 文件）** | ✅ 基线全保留（skip 集不变） |
| `smoke:s5` / `smoke:p2s2` / `smoke:p2s3` | 全过 | 全过 | ✅ |
| `smoke:r2`（真对端，含 pin 副本零改动与临时 HOME 隔离断言） | 全过 | 全过 | ✅ |
| `smoke:l1a`（本轮新增） | — | 全过 | ✅ |
| `typecheck` | 通过 | 通过 | ✅ |
| `dependencies` | 恒空 | **恒空**（仅 devDependencies：typescript/vitest/@types/node） | ✅ |

**不动项核对**：切片 0 守卫（`assertModelDecision`）与切片 1 预算常量（32/8）零改动；逐工具审批/`authorization` 恒 none 零改动；`bridge.contract.yaml` 零改动；`session.contract.yaml` 零改动（未新增事件类型，答复复用 `approval/response` 既有字段闭集）；内核仓零改动；R2 交付物零改动。

## 8. 条款映射表（改动 → 设计条款）

| 改动 | 对应条款 |
|---|---|
| `src/llm/providerConfig.ts`（新增）：七键＋env 覆盖＋0600＋fail-closed | 任务书 §1.1/D2/D5；设计增补 §1.5 |
| `src/llm/codecWire.ts`＋`src/llm/openaiChatCodec.ts`＋`src/llm/anthropicMessagesCodec.ts`＋`src/llm/codec.ts`（新增）：形状转换/缓冲/合成/收束语义 | 任务书 §1.2/D6；设计 §1.1 多 codec 架构；设计增补 §1.2/1.3/1.4 |
| `src/llm/httpProvider.ts`（新增）：内置 fetch＋重试＋脱敏漏斗＋决策缓冲＋`call_budget_exhausted` | 任务书 §1.1/§1.2/§3.7/D5；设计 §1.2（重试纪律）；R2a |
| `src/llm/fakeEndpoint.ts`（新增）：回放式假端点（台账＝零外连/认证/脱敏证据面） | 任务书 D1/§2/§3.3；设计 §0/§1.1 |
| `src/run/resume.ts`（新增）＋`src/cli/resume.ts`（新增）：通道接口＋CLI 前端 | 任务书 §1.3；设计 §1.3；ADR-07；设计增补 §2 |
| `src/run/runner.ts`：resume 前置（水位线→应答→开新 turn→重派）/`modelId`/`bind_run` 接线/expect 跳过 | 任务书 §1.3/§1.4；INV-1/INV-2；durability 公理；设计增补 §2.3/§3 |
| `src/run/approvalTrack.ts`：提案状态/会话计数器流种子（纯增量，进程内行为零改动） | 任务书 §1.3；ADR-07（升级阈值跨进程不重置）；durability 公理 |
| `src/llm/adapter.ts`：approval payload 白名单补登实写形态（修正，见 §9 偏离 ①） | 切片 2 B1（真实流形态修正）；全仓 fail-closed 哲学 |
| `src/llm/provider.ts`：`LlmErrorCode` 扩 `call_budget_exhausted`（加法） | 任务书 §3.7/D5 |
| `src/workspace/runWorkspace.ts`：`readRunProvenance`（resume 重开输入） | 任务书 §1.3；重开语义（既有等值校验内建） |
| `src/run/smokeL1a.ts`＋`package.json smoke:l1a`：D4 试用任务全链 | 任务书 D4/§4.1；设计 §2/§3 |
| `tests/llm/*`（4 文件 32 用例）＋`tests/run/l1aE2e.test.ts`（8 用例）＋`tests/run/resumeChannel.test.ts`（14 用例） | 任务书 §3 VERIFY 1–7 |
| `docs/`：条款级完成清单＋设计增补＋本报告 | 任务书 §3 附加/§4.2/§4.3 |

## 9. 偏离规范之处（含修正登记，全部已入条款级完成清单「惯例与登记项」）

1. **adapter approval 白名单修正**：切片 2 桩测试未覆盖真实流形态——`approval/request|response` 实际写入含 `tool_call_id`/`params`/`approval_key`/`supersedes`/`request_event_ref`，真实流投影被旧白名单拦截（真实闭环 E2E 揭示）。纯增量补登，映射语义不变（payload 整体以摘要进模型上下文，B1 既定）；既有 adapter 用例零改动通过；
2. **配置键扩充**（任务书七键之外＋2 可选键）：`reasoning_effort`（§1.2 要求显式携带）、`max_tokens`（anthropic 线缆必填）；未知键仍 fail-closed；
3. **approvalTrack 种子**（P2-S2 模块纯增量）：跨进程提案状态延续——不放宽（升级阈值/一次性消费语义反而跨进程保持），新 run 空流行为逐位不变（mock 轨零回归佐证）；
4. **runner `atf.bind_run` 接线**：只读全链第一步（任务书 §1.4 / pin 已含该方法）；失败 fail-closed 终局；两轨零回归佐证；
5. **resume 报告 expect_violations 恒空**：CLI 无场景期望文件，断言由调用方承担（非豁免语义）。

## 10. 条款级完成清单

见《ATF独立Harness_L1a门2条款级完成清单_20260914.md》——开工前提交，24 项全部 ✅（证据章节已逐项回填）。

## 11. 提交清单（本地提交，**未推送**）

1. `feat(l1a)`：门 2 工作笔（配置层/两 codec/HTTP provider/假端点/通道＋CLI/runner resume/种子/测试/冒烟/文档）；
2. `merge`：`work/20260914-l1a-provider` → main（短命分支与 worktree 合回后删除，任务书 §4.4）；
3. `docs(l1a)`：本报告入库提交。

**完成即停**：门 2 闭合即达 **L1a（可试用里程碑）**——待 owner 事项：① 真实 `base_url`/`model`/`api_key` 填入配置文件（不入仓、0600、路径经 `ATF_LLM_CONFIG` 指定）＋ 真实网络调用显式授权 ＋ 新 snapshot/binding，届时复跑 §3 第 3/4/5 项并另附原始输出；② 推送另行授权；③ L1（ACP 宿主嵌入，以 Codex 等宿主为首要集成目标之一）另行签发。
