# ATF 独立 Harness——L1 三层前端与集成面（长期参考）

**日期**：2026-09-16（L1 门 2 批次交付物；实现依据《ATF独立Harness_L1门2任务书_20260915.md》与门 1 裁定 D1–D15，本文为其长期形态记录，阶段状态以现行任务书为准）

---

## 1. 三层前端架构（D1/D1'）

```text
             ┌──────────────────────────────────────────┐
L1（已交付）  │ 前端一  src/ui/（TUI，主入口，同进程直连） │
             └─────────────────────┬────────────────────┘
             ┌─────────────────────┴────────────────────┐
             │ 前端二 src/acp/        │ 前端三 src/mcp/   │
             │ ACP agent 外壳（stdio）│ MCP server（stdio）│
             └───────────┬────────────┴─────────┬────────┘
                         ▼                      ▼
             ┌──────────────────────────────────────────┐
             │        core/（src/core/，T01 抽取）        │
             │ run 绑定 · 审批闸（账本轨/问答轨）·        │
             │ append-only 日志（唯一跨进程凭证）·        │
             │ 三层工作区 T0/T1/T2 · 工具定义与 canonical │
             │ 投影面（src/core/projection.ts）           │
             └─────────────────────┬────────────────────┘
                                   ▼
                 ATF 内核 stdio JSONL 桥接（src/bridge/，零改动）
```

**目录与依赖方向**（边界守卫：`tests/core/boundary.test.ts`）：

| 层 | 目录 | 职责 | 依赖 |
|---|---|---|---|
| 共享传输 | `src/rpc/` | JSON-RPC 2.0 over stdio 手写对等体（分帧/配对/双向通知，ACP 与 MCP 共用，T03） | Node 内置 |
| 共享中间层 | `src/core/` | 会话（append-only 日志）· 审批闸 · 三层工作区 · 工具定义与 canonical · run 引擎 · 投影面 | rpc 无；→ bridge/llm |
| 前端一（主入口） | `src/ui/` | TUI：同进程直连 core；差分渲染；审批弹窗＝问答轨渲染 | → core |
| 前端二（配件） | `src/acp/` | ACP agent（server 端）：acpx/编辑器经 ACP 驱动；**我方拥有循环** | → core＋rpc |
| 前端三（配件） | `src/mcp/` | MCP server：编码 Agent 挂载 7 工具；**对方拥有循环** | → core＋rpc |
| 入口 | `src/cli/`、各 `smoke*` | 既有 CLI 通道与冒烟入口（dist 路径不变） | → core |

治理语义**只在 core**：账本轨/问答轨（CAS 一次性消费、拒绝循环、挂起语义）、三层工作区、铁律一、退出码单一出口（`resolveHeadlessExitCode`）。三个外壳只做协议映射与投影，均无自动应答路径（ADR-07）。

## 2. 版本轴（各自归属单一文件）

| 轴 | 名称 | 当前值 | 归属文件 |
|---|---|---|---|
| 轴一 | 会话协议版本（内核握手） | 1 | `src/bridge/connection.ts::EXPECTED_SESSION_CONTRACT_VERSION`（内核侧 `session/contract.py::SESSION_CONTRACT_VERSION`） |
| 轴二 | 桥接契约版本 | 2 | `bridge.contract.yaml` 头部 |
| **轴三** | **ACP 协议版本** | **1** | **`src/acp/protocol.ts::ACP_PROTOCOL_VERSION`**（协商策略：恒应答 v1） |
| 轴四 | MCP 协议版本（日期串） | 2025-03-26 | `src/mcp/protocol.ts::MCP_SUPPORTED_VERSIONS`（命中回显，未命中回最新） |

## 3. ACP 面（前端二）：会话/审批/投影映射表

**入口**：`node dist/acp/main.js [--runs-root <dir>] [--mock <桥接 serve 脚本>] [--scope-mode …]`

### 3.1 会话映射

| ACP 方法 | 我方语义 |
|---|---|
| `initialize` | 轴三协商（恒应答 1）＋能力声明（仅 `loadSession: true`；**不声明 fs/terminal 能力面**，D7）＋`authMethods: []` |
| `session/new` | sessionId ≡ run_id（跨进程 load 可直查 `runs/<sessionId>/session.jsonl`）；**v1 一 session 一 run**；目录/日志惰建于首次 prompt |
| `session/prompt` | 一次 turn（同进程 ScenarioRunner）；返回 `stopReason`：completed→`end_turn`、挂起→`cancelled`、中止→`refusal`、失败→JSON-RPC error |
| `session/load` | 重放 append-only 日志重建 loop 状态（**INV-A 兑现**），快照（turns/pending 数）入 `_meta.atf.loopState`；挂起会话可经 prompt 续答 |
| `session/cancel` | 通知；授权等待点收口本 turn＝折算挂起（「取消非否决」，verdict=timeout 机制位＋reason 记取消事实）；迟到宿主应答丢弃 |

### 3.2 审批映射（D4/D5）

| 环节 | 语义 |
|---|---|
| 触发 | 高危工具（须审批）→ 账本轨优先（miss→问答轨；**ACP 面零账本预录**——scope 级记录会被首个高危动作消费，预录即盗用面） |
| 往返 | `session/request_permission`（toolCallId＋恰两选项 `allow_once`/`reject_once`） |
| 应答归一 | 规范嵌套 `{outcome:{outcome,optionId}}` 与扁平形态兼容（`normalizePermissionOutcome`）；形状非法＝非法响应 |
| D5 fail-closed | 未知 optionId（含 always 类）→ **拒绝＋reason 留痕「非法 optionId」**，不静默降级 |
| D4 B＋C 留痕 | approval/response 恒增 `channel:"acp"`＋`host_id`（clientInfo.name，缺省 acp-client）＋`requires_human_review: true`；宿主自动允许设置＝人的显式预授权，账本一次性消费不受影响 |
| 挂起续答 | 续答 prompt → 向宿主重发授权 → allow_once→resume(granted) / reject_once→resume(denied)，落盘 channel 留痕同上 |

### 3.3 投影映射（`session/update`；D9 措辞＝客户端观察事实）

| 会话事件（已落盘） | ACP 投影 |
|---|---|
| `assistant/message` | `agent_message_chunk`（整条文本） |
| `tool/call` | `tool_call`（toolCallId=事件 id；kind：atf_admit_data→edit、atf_gate(query)→read、atf_gate(advance)→edit（保守扩展）、只读工具→read；status in_progress） |
| `approval/request` | `tool_call_update` status=pending，title「未执行：等待人工审批」（**VERIFY 6 标注不丢**） |
| `approval/response` | granted→in_progress「宿主已应答放行」；denied→failed「未执行：宿主应答拒绝」；advised→pending「等待重新提案」；aborted→failed；timeout→pending「挂起可续」 |
| `tool/result` | ok→completed（content=canonical 摘要）；非 ok→failed（原因） |
| thought（D6） | **v1 无思考可投**：thinking 收敛于线缆域（HttpLlmProvider 剥离、会话日志恒无 thinking），投影面无事件源；恢复占位与真思考投影归 L1b（须 wire→投影面显式 tap） |

## 4. MCP 面（前端三）：7 细粒度工具（D11）

**入口**：`node dist/mcp/main.js [--runs-root <dir>] [--mock <桥接 serve 脚本>] [--scope-mode canonical|simulation] [--project-id <id>]`（本壳零 LLM 调用——模型/额度归客户端自管）

| # | 工具 | 治理 | 说明 |
|---|---|---|---|
| 1 | `atf_bind_run` | 会话界 | spawn 桥接→内核 bind→建工作区+append-only 审计流+审批闸；**v1 一进程一绑定** |
| 2 | `atf_workspace_status` | 免审批（只读） | canonical 沿用契约 |
| 3 | `atf_fact_scan` | 免审批（只读） | 同上 |
| 4 | `atf_gate` | 问答轨（见下） | query/advance 同治理；query 面向宿主策略=D4-C 预授权 |
| 5 | `atf_admit_data` | 问答轨（见下） | 高危写 |
| 6 | `ledger_query` | 直通 | canonical 复用 `LEDGER_QUERY_CANONICAL` |
| 7 | `ledger_consume` | 直通 | 对端 CAS 一次性语义强制；无记录→业务拒绝 exit 1 |

**授权（无授权原语）**：MCP 无 `session/request_permission` → 工具调用＝客户端审批面放行后的产物（D4-C 显式预授权）；我方闸门**不放宽**——问答轨 stub 恒 granted 但强制留痕 `channel:"mcp"+host_id+requires_human_review:true`，账本轨优先/CAS/重入/indeterminate 防线全保留。

**写类工具预授权白名单（L1b B1，L1b-D1=A）**：

- **写类集合**：`atf_admit_data` ＋ `atf_gate(action=="advance")`（闸门推进＝状态变更；query 只读不入类）。
- **配置**：缺省 `~/.atf-harness/mcp-preauth.json`（0600，与 llm.json 同范式；`--preauth` 或环境变量 `ATF_MCP_PREAUTH` 可指路径）：

  ```json
  { "schema_version": "McpPreauth/v1", "hosts": [ { "host_id": "workbuddy", "tools": ["atf_admit_data"] } ] }
  ```

- **语义**：白名单外写动作**默认拒绝**（不进 ToolExecutor、不写 `approval/request`——无自动应答路径），tool result 返回三段式拒绝文案（①事实②原因③修复，reason=`mcp_write_not_preauthorized`，exit 1），审计流仍落 tool/call+tool/result 可复核；白名单内放行走既有问答轨，留痕在 D4 三字段外增 `pre_authorization:true`。**预授权不写账本、不绕过 CAS 一次性消费**（D4-C 延续）。
- **fail-closed 基线**：文件缺失＝空白名单（缺省最严，非错误）；宽权限/坏 schema_version/解析失败一律视同空白名单并 stderr 留因；每次 `tools/call` 重新读取（配置热生效）。
- **⚠ 身份 caveat**：`host_id` 取自 MCP `clientInfo.name`＝**客户端自报身份**，预授权白名单**≠强身份鉴别**——仅用于约束宿主自动化行为（本地 stdio／D3 场景边界：传输两端同机，进程身份由 OS 域隔离承载）；远程多租户场景须另行鉴别机制（归 L2）。

**退出码**：MCP 无退出码 → `resolveHeadlessExitCode` 编码进 tool result 文本 JSON 的 `exit_code`（非零 `isError:true`）；`0/1/75/78/79` 仅保留 ACP 与 CLI 入口。

**审计流**：每次工具调用（含 bind/账本方法）`tool/call`+`tool/result` 逐对写入 append-only 日志（call_ref 配对）——唯一跨进程凭证。

## 5. 冒烟与对端

| 冒烟 | 对端 | 覆盖 |
|---|---|---|
| `smoke:l1ui` | 假端点＋stdin 脚本化人工应答 | TUI 全链＋同源断言 |
| `smoke:l1acp` | **acpx@0.15.1**（D2/D10：开发期对照工具，npx 锁版本，不入库不进 dependencies） | 协议原文九段＋授权闭环＋落盘证据 |
| `smoke:l1mcp` | 仓内最小 MCP 客户端桩 | 7 工具面＋绑定界＋写治理＋退出码编码 |
| WorkBuddy | 对端试验（SSH stdio 桥：`command:"ssh"`、`args:["A800_5005","node …/dist/mcp/main.js"]`；客户端侧仍本机 stdio，守 D3） | 按 owner 授权在 A800 侧执行（Expert 包装归 L1b） |

## 6. 已知边界（登记，非缺陷）

1. ACP：授权等待无我方超时（宿主是应答权威）；非授权等待点的 mid-turn cancel 不生效；一 session 一 run。
2. MCP：v1 一进程一绑定；denied/timeout 问答轨分支结构性死路（见 §4）。
3. ACP 面零账本预录的依据与 L1a headless 预录的差异，见《L1 门 2 执行报告》T04 节裁定 1。
