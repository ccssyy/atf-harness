# E1 方案：用 MCP 替代自造 bridge（两仓集成形态评估）

- 日期：2026-11-20
- 状态：**方案待裁**（owner 已确认「接受 MCP server」方向，本文评估可行性与代价）
- 定位：ATF 两仓（harness / 内核）集成方式的演进方案

---

## 一、现状：自造 bridge

### 形态

```
harness (TS)                              内核 (Python)
─────────────────                         ──────────────────
atf_pipeline_stage（工具）
    ↓
src/bridge/connection.ts (412 行)
    ↓ spawn(cmd) + stdio JSONL 帧
  ┌────────────┐
  │ stdin/out  │ ────────────────────────→ session/runner.py（分帧/校验/分发）
  └────────────┘                             ↓
                                          atf serve（15 个注册方法）
                                            ↓
                                          17 段训练流程
```

### 规模

| 侧 | 文件 | 行数 |
|---|---|---|
| harness | `src/bridge/{connection,frames,bridgeCommand,errors,index,result}.ts` | 1,143 |
| 内核 | `session/{runner,frames,contract}.py` | ~600（估） |
| 契约 | `bridge.contract.yaml` | 第三份声明 |

### 已知风险（owner 提出「bridge 感觉也有风险」，实测确认）

| # | 风险 | 证据 | 严重度 |
|---|---|---|---|
| R1 | **协议三份声明** | `bridge.contract.yaml` + harness `toolDefinition.ts` + 内核 `session/tools.py` | **高**（漂移温床） |
| R2 | **版本双轴** | `contract_version`（桥，harness 独有，不进握手）与 pin（内核 tag）独立演进 | **高** |
| R3 | 单连接单例 | `BridgeManager` 单例，无法并发多内核 | 中 |
| R4 | 握手无超时 | `handshake(atf.version)` 失败回收，但无显式超时 | 中 |
| R5 | 进程崩溃无自动重连 | 需上层处理 | 中 |
| R6 | stderr 只取尾部摘要 | 长错误可能丢信息 | 低 |

**R1+R2 是本质问题**：同一份「内核能做什么」的认知存在三处，且版本轴各自演进。

---

## 二、目标形态：DSH 原生 MCP

### DSH 的 MCP 能力（实测）

```typescript
// vendor/.../mcp/mcp-client/src/index.ts:121
export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    command: z.string().required(),        // ← spawn 命令
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: Reconnect,                   // ← 原生重连（含退避与上限）
  }),
  z.object({ transport: z.const('streamable-http'), ... }),
])
```

**关键能力对照**：

| 能力 | 自造 bridge | DSH mcp-client |
|---|---|---|
| spawn 子进程 | ✅ 自己写 | ✅ `command` + `args` |
| env 注入 | ✅ 自己写 | ✅ `env` |
| 工具调用超时 | ❌ 缺 | ✅ `toolCallTimeoutMs` |
| **崩溃重连** | ❌ 缺 | ✅ `reconnect`（initialDelay/maxDelay/maxAttempts） |
| 启动失败策略 | 自己判 | ✅ `failOnStartupError` |
| 工具注册 | 自己注册 | ✅ **自动挂 `ctx.tools`**（`mcp__<server>__<tool>`） |
| 治理面（spill/pruner/timeout） | ❌ 绕开 | ✅ **自动生效**（因为走 `ctx.tools`） |

**工具命名**（实测）：

```typescript
// mcp-client/src/tools.ts:7-8
 * has the stable identity `(serverName, rawName)`; the model-facing public name
 * is `mcp__<serverName>__<rawName>`, normalized to the DeepSeek function-name
```

### 目标架构

```
harness (TS)                              内核 (Python)
─────────────────                         ──────────────────
ctx.mcp（vendor 原生）
    ↓ stdio + MCP 协议
  ┌────────────┐
  │ mcp-client │ ────────────────────────→ atf_mcp_server（新，MCP SDK）
  └────────────┘                             ↓
                                          现有 SessionTools 15 方法
                                            ↓
                                          17 段训练流程
```

**删除**：`src/bridge/`（1,143 行）+ 内核 `session/runner.py`（分帧层，保留业务方法）
**新增**：内核 `atf_mcp_server.py`（MCP stdio server 包装，估 200-300 行）
**配置**：profile `cordis.patch.yml` 加一个 `mcp-client` 条目

---

## 三、可行性评估

### 3.1 协议映射：15 个内核方法 → MCP tools

内核现有方法（实测 `session/tools.py:3869-3883`）：

| # | 内核方法 | 用途 |
|---|---|---|
| 1 | `atf.bind_run` | 绑定 run |
| 2 | `atf.bind_workspace` | 绑定工作区 |
| 3 | `atf_workspace_status` | 工作区状态 |
| 4 | `atf_fact_scan` | 事实索引 |
| 5 | `atf_gate` | 闸门 |
| 6 | `atf_admit_data` | 数据准入 |
| 7 | `atf_data_admission.request` | 准入请求 |
| 8 | `atf_preparation.propose` | 准备提案 |
| 9 | `atf_style_cluster.execute` | 聚类执行 |
| 10 | `atf_label_qc.inspect` | 标注体检 |
| 11 | `atf_label_qc.resolve` | 标注裁决 |
| 12 | `ledger_query` | 账本查询 |
| 13 | `ledger_consume` | 账本消费 |
| 14 | `ledger_record` | 账本记录 |
| 15 | `atf_flow_anchor` | 流程锚 |

**映射结论**：15 个方法都是「请求-响应」语义，**天然适配 MCP tool**。无流式、无双向、无长连接需求。

### 3.2 关键差异：harness 39 工具 ≠ 内核 15 方法

**这是本方案最重要的设计点**：

```
内核 15 方法（桥接面）    ← 只有这些走 bridge
harness 39 工具（模型面） ← 大部分不经过 bridge
```

**39 个工具的构成**：

| 类型 | 数量 | 是否过 bridge |
|---|---|---|
| 桥接面工具（包装内核方法） | ~16 | ✅ 过 |
| 训练域本地工具（读 run 目录/GPU/tmux） | ~13 | ❌ 不过（本地文件/进程） |
| 确认卡工具（config_confirm/publish_confirm） | 2 | ❌ 不过 |
| 子任务派发（subagent/deferred） | 4 | ❌ 不过 |
| 提示/自检（hello） | 1 | ❌ 不过 |
| **pipeline_stage** | 1 | ⚠️ **特殊：spawn CLI 而非走 bridge** |

**关键发现**：`atf_pipeline_stage` **不走 bridge**，它直接 spawn `walkthrough_pipeline.py`（`ATF_DSH_PIPELINE_COMMAND`）。

**所以 bridge 的实际覆盖范围只有 15 个方法**，不是 39 个工具。

### 3.3 E1 可行，但有一个必须解决的矛盾

**MCP 的 tool 命名是 `mcp__<server>__<rawName>`**，会改变模型看到的工具名。

| 现在 | MCP 后 |
|---|---|
| `atf_workspace_status` | `mcp__atf__workspace_status` |
| `atf_gate` | `mcp__atf__gate` |

**影响**：
1. 所有现有测试/断言中的工具名要改
2. persona/工具描述中的引用要改
3. `APPROVAL_SEMANTICS_BY_TOOL` 映射表要改
4. 用户可见的回执里若带工具名要改

**缓解方案**：
- **选项 A**：接受改名（彻底，但改动面大）
- **选项 B**：给 `atf-tools` 保留一层薄包装，把 MCP 工具重命名回 `atf_*`（多一层，但零破坏）⭐
- **选项 C**：不用 MCP 工具面，只用 MCP 传数据（那 MCP 就没意义了）

**我推荐 B**：`atf-tools` 里加一层「MCP 客户端适配」，把 `mcp__atf__*` 映射回 `atf_*`。成本约 100 行，换取零破坏。

---

## 四、代价与收益（量化）

### 收益

| 项 | 量化 |
|---|---|
| 删除自造协议代码 | **-1,143 行 TS** + **-~600 行 Python**（内核分帧层） |
| 消除三份协议声明 | **-1 份**（`bridge.contract.yaml` 退役，MCP schema 单源） |
| 消除版本双轴 | **-1 轴**（`contract_version` 退役） |
| 获得原生重连 | R5 风险消除 |
| 获得工具调用超时 | R4 风险消除 |
| **获得治理面生效** | spill/pruner/timeout 对桥接工具自动生效（当前绕开） |

### 代价

| 项 | 量化 |
|---|---|
| 内核侧新增 MCP server | +200~300 行 Python |
| 工具改名适配（选 B） | +~100 行 TS |
| 测试/断言更新 | 涉及工具名的测试 |
| **迁移窗口风险** | 协议切换期间两仓必须同版本 |

### 净效果

```
删除 ~1,743 行（bridge + 内核分帧）
新增 ~400 行（MCP server + 适配层）
净减 ~1,340 行
```

**但更重要的收益不是行数，是 R1/R2 两个「高」风险被结构性消除。**

---

## 五、实施路径（分三步，每步可回退）

### E1（本方案）：评估完成，待裁

**产出**：本文档
**状态**：✅ 完成（owner 已确认方向）

### E2：内核侧 MCP server

| 步骤 | 内容 | 验收 |
|---|---|---|
| E2-1 | 用 Python MCP SDK 包 `atf_mcp_server.py`，暴露 15 方法为 tools | MCP inspector 能 list/call 全部 15 个 |
| E2-2 | 保留旧 `serve` 入口（双轨并行） | 旧桥仍可用 |
| E2-3 | 契约测试：同一输入下 MCP 与旧 bridge 返回一致 | 15/15 一致 |

**风险**：中。可回退（旧 serve 保留）。

### E3：harness 侧切换

| 步骤 | 内容 | 验收 |
|---|---|---|
| E3-1 | profile 加 `mcp-client` 配置，指向 `atf_mcp_server.py` | 工具在 `ctx.tools` 可见 |
| E3-2 | `atf-tools` 加薄适配（`mcp__atf__*` → `atf_*`） | 模型看到的工具名不变 |
| E3-3 | 逐步切工具：先 1-2 个只读工具，验证后全切 | 真机验证 |
| E3-4 | 删 `src/bridge/` + 内核分帧层 | typecheck + 全测试绿 |

**风险**：中高。E3-3 分批切可控制。

### E4：清理

| 步骤 | 内容 |
|---|---|
| E4-1 | 删 `bridge.contract.yaml` |
| E4-2 | 删 `contract_version` 双轴 |
| E4-3 | 更新文档（AGENTS.md §4 契约与 pin 管理） |

---

## 六、风险与魔鬼代言人（≥3 条反例）

### 反例 1：MCP 工具改名破坏现有约定

**触发**：E3-2 适配层写错，或某个工具被漏映射
**影响**：模型调用 `atf_gate` 但实际工具是 `mcp__atf__gate` → 调用失败
**缓解**：E3-2 加**机检**：断言「模型可见工具名集合 = 切换前逐字一致」；E3-3 分批切

### 反例 2：MCP 协议对「大 payload」的限制

**触发**：`atf_label_qc.resolve` 的 decisions 可能很大（实测 748 字节嵌套 JSON 曾致 GLM 生成塌缩）
**影响**：MCP 有 `maxInstructionBytes` 上限（默认值需查），超限拒绝
**缓解**：实测各方法的 payload 大小分布；必要时调 `maxInstructionBytes`

### 反例 3：内核侧 MCP SDK 引入新依赖

**触发**：内核仓当前依赖只有 `Pillow` + `numpy`（`pyproject.toml`），加 MCP SDK 破坏「低依赖」纪律
**影响**：内核部署复杂化；A800 容器 site-packages 已有 stale 问题
**缓解**：评估能不能**手写最小 MCP stdio 实现**（MCP over stdio 是 JSON-RPC 2.0，协议本身不复杂，约 200 行）——这样零新依赖

### 反例 4：迁移期间两仓版本必须同步

**触发**：切到 MCP 后，若 harness 回退到旧版而内核已是 MCP
**影响**：桥连不上，产品不可用
**缓解**：E2 阶段双轨并行（旧 serve 保留）；E4 才删旧入口

**额外风险**：`atf_pipeline_stage` 不走 bridge（直接 spawn CLI），**MCP 化后它仍是独立通道**——这意味着「统一集成面」的收益只覆盖 15 个方法，不是全部。**这一点必须在方案中如实披露。**

---

## 七、明确不做的

| 不做 | 理由 |
|---|---|
| 把内核塞进 TS 扩展 | 89k 行 Python 重写 = 重写产品 |
| 用 HTTP 替代 stdio | 训练流程需长事务/文件流，HTTP 语义不匹配 |
| 用 MCP 替代 pipeline_stage 的 CLI spawn | 段脚本是确定性 CLI，MCP 包裹无收益 |

---

## 八、待 owner 裁决的事项

| # | 待裁 | 我的建议 |
|---|---|---|
| 1 | 工具改名：接受 `mcp__atf__*` 还是加适配层保持 `atf_*` | **加适配层**（零破坏，+100 行） |
| 2 | 内核 MCP 实现：用官方 SDK 还是手写最小实现 | **手写**（保低依赖纪律，MCP/stdio 是 JSON-RPC，约 200 行） |
| 3 | 迁移批次时机：B 阶段之后还是之前 | **B 阶段之后**（避免内核改两次） |
| 4 | `atf_pipeline_stage` 是否也 MCP 化 | **不 MCP 化**（确定性 CLI，无收益） |

---

## 九、与整体修复计划的关系

E1 属于**基础设施演进**，不影响当前产品可用性。

**建议排期**：
```
B3（删正则）→ B2（退役 loop）→ B8（LLM 层）→ ... → E2/E3（MCP 化）
```

**理由**：B 阶段会让内核/harness 接口多次变动，MCP 化应等接口稳定后做，避免改两次。
