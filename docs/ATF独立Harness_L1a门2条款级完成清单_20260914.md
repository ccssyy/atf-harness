# ATF 独立 Harness——L1a 门 2 条款级完成清单（开工前提交）

**日期**：2026-09-14 ｜ **执行方**：harness 侧会话（zcode，worktree `.worktrees/l1a-provider`，分支 `work/20260914-l1a-provider`）
**依据**：《ATF独立Harness_L1a门2任务书_20260914.md》（§1 范围四项 / §2 硬约束 / §3 VERIFY 八项 / §4 交付物）＋《ATF独立Harness_L1a设计_门1讨论稿_20260914.md》§1/§3 ＋ ADR-07/09 ＋ R2a
**性质**：任务书 §3 附加要求——开工前条款级完成清单（2026-09-14 开工前提交）；执行完成后已逐项以 ✅ 标注并回填证据章节号（指向《L1a 门 2 执行报告》）。

| # | 条款 | 来源 | 完成标准 | 状态 | 证据 |
|---|---|---|---|---|---|
| 1 | 配置层：`protocol`/`base_url`/`api_key`/`model`/`timeout_ms`/`max_retries`/`max_calls_per_run` 七键；环境变量覆盖配置文件；配置文件不入仓、`0600`、路径经环境变量指定 | 任务书 §1.1 / D2 | 载入与校验纯函数；用例：env 覆盖文件、缺 `model` 拒绝、权限非 0600 拒绝 | ✅ | 报告 §1/§8 |
| 2 | 未知 `protocol` → fail-closed（不猜测回退）；`openai-responses` 仅预留 codec 位（接入硬前提登记） | 任务书 §1.1 / D6 / 设计 §1.1 | 结构化拒绝（含允许值清单）；两硬前提（`store:false`＋禁服务端工具执行）写入设计文档 | ✅ | 报告 §1 |
| 3 | Node 内置 `fetch` ＋ 自研薄适配层，不引 SDK；`dependencies` 恒空 | 任务书 §1.1 / R2a | package.json dependencies 为空；无 SDK import | ✅ | 报告 §1/§7 |
| 4 | codec `openai-chat`（默认）：`messages`（含 system）/`tools:[{type:"function"}]`/`tool_calls`（arguments 为 JSON 串）/`finish_reason`/`Authorization: Bearer` | 任务书 §1.2 | fixture 级正反例：请求构造与响应解析、工具调用与结果回填形状、非法响应 fail-closed | ✅ | 报告 §2/§8 |
| 5 | codec `anthropic-messages`：顶层 `system`/`tools:[{name,input_schema}]`/`tool_use`（input 为对象）/工具结果以 user 消息内 `tool_result` 回填/`stop_reason`/`x-api-key`＋`anthropic-version` | 任务书 §1.2 | 同上（×2 用例组） | ✅ | 报告 §2/§8 |
| 6 | chat 面 reasoning 参数**显式携带**并在文档登记（GPT-5.4 限制：`reasoning: none` 下工具调用不受支持） | 任务书 §1.2 | 请求体恒含 `reasoning_effort`（≠none）；显式配 `none` → fail-closed；设计文档登记 | ✅ | 报告 §2 |
| 7 | codec 只做形状转换，不含业务判断；canonical 面（`AdapterMessage[]`↔`ModelResponse`）↔ wire 面 | 任务书 §1.2 / 设计 §1.1 | codec 模块无审批/工具可调性判断（评审断言＋用例） | ✅ | 报告 §2 |
| 8 | 通道接口 v1：`list pending` / `submit answer`（`granted`/`advised`/`denied`/`abort` 四类） | 任务书 §1.3 | 导出函数面（供 CLI 与未来前端共用）；答复校验 fail-closed（已答/被替代/未知 request 拒绝） | ✅ | 报告 §3 |
| 9 | CLI 前端：`resume --list` / `resume --answer <verdict> --note "…"`；答复落 `approval/response` → **resume 开新 turn（INV-1）** | 任务书 §1.3 | CLI 子进程实跑；resume 新进程开新 turn；turn 计数自事件流推导（durability 公理） | ✅ | 报告 §3/§4 |
| 10 | 红线：通道只能由人触发；无任何自动应答路径；socket/界面不实现（接口预留） | 任务书 §1.3 / ADR-07 | 仓内无自动应答代码路径（headless 等待即 timeout→挂起，非应答）；无 socket 代码 | ✅ | 报告 §3 |
| 11 | 试用范围：只读全链（`bind_run`/`workspace_status`/`fact_scan`/`gate` query）＋ 仅 `atf_admit_data` 一类写；其余高危动作挂起等人放行 | 任务书 §1.4 / D4 | 试用脚本只含上述动作；审批语义逐工具不放宽 | ✅ | 报告 §5 |
| 12 | 硬约束：门 2 零真实网络调用（只连本地假端点，127.0.0.1 回放式 HTTP echo）；零外连断言 | 任务书 §2 / D1/D3 | fetch 注入面断言全部请求 URL=配置 base_url（回环）；假端点请求台账核验 | ✅ | 报告 §6 |
| 13 | 硬约束：切片 0 守卫、切片 1 预算（32/8）、切片 2 逐工具审批与 `authorization` 恒 none 不放宽 | 任务书 §2 | 相关断言用例零改动通过；守卫/预算代码零改动 | ✅ | 报告 §7 |
| 14 | 硬约束：不做 socket/界面/流式/多模态/ACP；不激活 projection；不接真实 TEM | 任务书 §2 | 交付清单核对 | ✅ | 报告 §7 |
| 15 | 硬约束：仓内零凭据（fixture 假 key 显式标注 fake 不可误用）；key 只在出站请求头；不进事件/载荷/报告；日志与错误不回显 key（脱敏漏斗） | 任务书 §2 / D2 | 全事件＋报告序列化断言不含 key；错误回显反例（对端 500 body 含 key → 报错脱敏） | ✅ | 报告 §6 |
| 16 | VERIFY 1 配置层：env 覆盖、未知 protocol 拒绝、缺 model 拒绝、凭据脱敏断言 | 任务书 §3.1 | 测试组全绿 | ✅ | 报告 §1/§8 |
| 17 | VERIFY 2 codec×2：fixture 正反例；工具调用与结果回填形状；非法响应 fail-closed | 任务书 §3.2 | 两测试组全绿 | ✅ | 报告 §2/§8 |
| 18 | VERIFY 3 假端点闭环：只读链路自主完成；无真实网络调用 | 任务书 §3.3 | E2E：`bind_run → workspace_status → fact_scan → gate(query)` 自主完成（exit 0 前置段）＋零外连断言 | ✅ | 报告 §4/§8 |
| 19 | VERIFY 4 挂起闭环：`atf_admit_data` → `approval/request` ＋ **exit 75** ＋ turn 收口（INV-2） | 任务书 §3.4 | E2E 原始输出 | ✅ | 报告 §4/§8 |
| 20 | VERIFY 5 人放行闭环：CLI 答复 → `approval/response` 落事件 → resume 开新 turn → 动作**真正执行**（可复核证据：`tool/result` ok=true 且 call_ref 配对） | 任务书 §3.5 | E2E 原始输出（落盘证据） | ✅ | 报告 §4/§8 |
| 21 | VERIFY 6 拒绝/建议分支：`denied` 不执行且可解释；`advised` 回填建议（不构成放行，重提案 supersedes）；`abort` → exit 79 | 任务书 §3.6 | E2E 三分支用例 | ✅ | 报告 §4/§8 |
| 22 | VERIFY 7 成本护栏：超 `max_calls_per_run` → 收敛（可区分原因），不静默继续 | 任务书 §3.7 / D5 | 结构化错误 `call_budget_exhausted`（默认 50，可配）；与轮次预算正交用例 | ✅ | 报告 §5/§8 |
| 23 | VERIFY 8 零回归：真对端轨 ≥241 passed / 1 skipped；mock 轨 ≥236 passed / 9 skipped；`smoke:s5`/`p2s2`/`p2s3`/`r2` 全过 | 任务书 §3.8 | 两轨四冒烟实跑数字入报告 | ✅ | 报告 §7 |
| 24 | 交付物：代码＋测试（含本地假端点 fixture）；执行报告；设计文档增补（codec 契约/通道接口/试用范围）；分支＋worktree 合回后删除；本地提交不 push | 任务书 §4 | 清单核对 | ✅ | 报告 §9 |

## 惯例与登记项（预估，实施中如再偏离将在此补充并入报告「偏离规范之处」）

- **配置键扩充登记**：任务书七键之外增两个可选键——`reasoning_effort`（openai-chat 显式携带，§1.2 要求，默认 `low`，显式 `none` 拒绝）与 `max_tokens`（anthropic-messages 线缆协议**必填**字段，默认 4096）。均为协议面必要参数，非业务扩权；未知配置键一律 fail-closed。
- **run 1 挂起语义**：复用 P2-S2 既有 timeout 路径（`approval/response{verdict:"timeout",actor:"harness"}` → 挂起 75，「超时非否决」）——CLI 应答是**等待人工期间不产生的自动应答**以外的唯一应答来源；harness 在 headless 下等待窗口耗尽记 timeout 属审计留痕，不构成应答（ADR-07 红线不触碰）。
- **granted 重派语义**：resume 后对**原 `tool/call` 事件**复用重派（不新增 tool/call 事件），凭据经既有 `findExistingCredential`/`resolveCredentialState` 判 `available`（granted.id > 水位线；水位线在应答落盘**前**取值）→ 放行执行；一次性消费语义不变。
- **bind_run 接线**：runBranch spawn 后调用 `atf.bind_run`（pin 已含该方法），使「只读全链 bind_run → …」为真实步骤；mock 对端 B1–B4 已承载。
