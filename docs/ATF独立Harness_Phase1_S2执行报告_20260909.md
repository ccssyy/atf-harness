# ATF 独立 Harness — Phase 1 / S2 会话层 任务执行报告

> 日期：2026-09-09 ｜ 执行方：zcode（本仓唯一开发 agent）｜ 报告对象：owner
> 执行依据：《ATF独立Harness_Phase1任务书_20260908.md》§2（S2）+《ATF-Harness_Owner启动指令_Phase1_S2_20260909.md》（含 owner 口径 #1–#4）
> 结论：**S2 全部验收用例通过，按指令停在 S3 前；代码本地提交未 push（沿用 S1 纪律，push 与否待 owner review 后决议）。**

---

## 0. 结论摘要

1. S2 会话层（`src/session/`）按任务书 §2 + owner 口径完成：schema v0 七类事件严格白名单、`domain_refs` digest 校验（经注入式 `DigestResolver` 承载 + 契约 mock 实现）、`ref_invalid` → 结构化 block（fail-closed）、双管道占位（`transformContext` / `convertToLlm` 签名定死）、`projection` 字段位恒 null、append-only JSONL 落盘（先落盘再继续，崩溃可重建）。
2. 落盘形态契约按 owner 口径 #4 新建 **`session.contract.yaml`** 登记（选项理由见 §5-①）；`bridge.contract.yaml` **零改动**，S1 桥接层代码 **零改动**。
3. 测试全量（含 `ATF_CLI_PATH` 指向 pin 副本 `v0.2.0b7 / a628f8b`）：**56 passed / 2 skipped**——S1 既有 26 passed / 2 skipped **零回归**，S2 新增 30 passed；typecheck 过；`npm run smoke:s1` / `npm run smoke:s2` 两条手工冒烟命令 exit 0。
4. 本报告无待决策阻塞项；§5 登记了 4 项执行中自主拍板的实现细节（均在 owner 口径与任务书授权范围内），供 owner review 时知悉。

## 1. 范围对照（启动指令 §1）

| 项 | 要求 | 实际 |
|---|---|---|
| 实现落点 | `src/session/`：事件流 + digest 校验 + 双管道占位 + projection 字段位 | ✓ 全部落在本 slice |
| S1 桥接层 | 零改动 | ✓ `src/bridge/` 无任何 diff；未出现"必须改桥接层"情形 |
| 停止点 | 完成 S2 即停，S3 未获指令不得启动 | ✓ 本报告即停止点 |

## 2. owner 口径执行对照（启动指令 §2）

| # | 口径 | 执行结果 |
|---|---|---|
| 1 | digest 校验对端由注入式接口承载，S2 提供契约 mock（可配置返回指定 digest / 缺失），真实对端待内核能力落地 re-pin 后接入 | ✓ `DigestResolver` 接口（`lookupDigest(journalType, factId)` → `found/not_found`/err）；`MockDigestResolver` 支持 `withDigests` 静态构造 + `register/unregister` 动态变更；resolver 查询自身失败 = `err(resolver_failure)`，不落盘、不标记、不猜测。与 S1 会话协议同口径：mock 承载、re-pin 后接入 |
| 2 | `ref_invalid` 后 fail-closed：标记事件 + 触发 block（本阶段 block = 返回结构化 block 结果） | ✓ append 时校验失败的事件带 `ref_invalid` 标记**照常落盘**（事实留痕），返回 `{status: "appended_blocked", event, block}`；`SessionBlock = {reason: "ref_invalid", message, event_id, invalid_refs[]}`（`invalid_refs` 含 index / journal_type / fact_id / claimed_digest / cause∈{digest_mismatch, fact_not_found}）。审批 UI 未实现（属后续 slice，符合口径） |
| 3 | schema v0 起步，事件类型严格白名单（7 类），未知 type 拒绝写入 | ✓ `SESSION_SCHEMA_VERSION = 0`；`SESSION_EVENT_TYPES` 恰为任务书 7 类；append 白名单外 type → `err(schema_violation)` 且文件零增长；replay 遇白名单外 type → `err(schema_violation)`（文件被篡改到结构不可信） |
| 4 | append-only JSONL 落盘（与事件流同构），文件位置/命名自定，登记入 `bridge.contract.yaml` 或新建 `session.contract.yaml` | ✓ 新建 `session.contract.yaml`（contract_version 1）；路径由调用方注入，库不内置路径策略（S4 工作区落地后默认约定 `runs/<run_id>/session.jsonl`，已在契约中写明） |

## 3. 设计要求与验收对照（任务书 §2）

### 3.1 设计要求 4 项

| # | 要求 | 实现 |
|---|---|---|
| 1 | 7 类事件枚举，每条带 `id + ts + type + payload` | `src/session/schema.ts`：白名单常量 + `SessionEvent`（id 从 1 自增；ts ISO 8601 UTC；payload 必填任意 JSON 值，`undefined` 显式拒绝） |
| 2 | `domain_refs` 可选 + 前向查询校验，不一致/不存在 → `ref_invalid` + block | `sessionLog.ts`：append 与 replay 两个校验点（见 §4 语义表）；三元组语法校验（journal_type/fact_id 非空，digest 64 位小写 hex） |
| 3 | 双管道占位：`transformContext`（拼接 + 过滤 `assistant/attempt`）与 `convertToLlm`（过滤 UI-only 字段），签名定死 | `src/session/pipeline.ts`：纯函数，签名 `(events: readonly SessionEvent[]) => LlmContextEvent[]` / `(event: SessionEvent) => LlmContextEvent`；UI-only 字段落点 = 事件顶层 `ui` 命名空间；convertToLlm 按**白名单投影**实现（输出仅 `{id, ts, type, payload, domain_refs?}`），比黑名单剔除更强——未来任何新增字段默认不进模型上下文（与 S3"内部字段一律不发"同一哲学） |
| 4 | `projection: {evidence_event: string | null}` 字段位，Phase 3 前恒 null | append 产出的每条事件强制携带 `projection: {evidence_event: null}`（含落盘形态）；replay 发现该字段缺失或非 null → `err(schema_violation)`（防提前激活） |

### 3.2 验收 3 条（BUILD/VERIFY 分离，verify 阶段未改实现）

| 验收项 | 用例 | 结果 |
|---|---|---|
| 重建 | 写入 42 条混合事件（7 类型全覆盖，含 domain_refs 正例与 ui 字段）→ 新建 `SessionLog.replay` 从磁盘重建 → 与内存序列逐条一致（deep equal），blocks 为空 | ✓ `tests/session/sessionLog.test.ts` |
| digest 反例 | ① append 时 digest 不一致 → 事件带 `ref_invalid` 落盘 + 结构化 block；② 合法落盘后**手工篡改文件中 digest** → replay 报 `ref_invalid` + block，未篡改事件不受牵连，文件只读不改写；③ not_found → `cause = fact_not_found`；④ 混合引用（一好一坏）仅坏引用入标记；⑤ resolver 查询失败 → `err(resolver_failure)` 不落盘 | ✓ 同上（5 个反例子用例） |
| 白名单 | 事件携带 `ui` / `projection` / `ref_invalid` 字段 → `convertToLlm` 输出键集恒为 `{id, ts, type, payload, domain_refs?}`，UI-only 内容级断言（`JSON.stringify` 不含字段值）不泄漏；`transformContext` 过滤 `assistant/attempt` 且保持顺序 | ✓ `tests/session/pipeline.test.ts` |

### 3.3 补充语义测试（fail-closed 加固，`tests/session/schema.test.ts` + `digestResolver.test.ts`）

- 续写打开：从既有文件尾部 id 续接（崩溃恢复）；既有流 id 断裂 → 拒绝打开。
- 落盘流损坏反例：坏 JSON 行 / 白名单外 type / `projection.evidence_event` 非 null / id 不连续 / 中间空行 / 末尾残缺半行（崩溃残留）→ replay 与续写打开一律 err（`corrupt_stream` 或 `schema_violation`），不猜测。
- replay 幂等确定性：append 时已标记 `ref_invalid` 的事件，resolver 状态不变时 replay 读回相同标记（事件序列 deep equal 成立）。
- 末行残缺语义：无结尾 LF 的尾部字节视为不可信 → replay/续写均 `err(corrupt_stream)`，不做"宽容截断"（避免截断后续写产生合并坏行）。
- `MockDigestResolver`：found / not_found / register / unregister / 跨 journal_type 不串扰。

## 4. domain_refs 校验语义表（实现口径，登记于 session.contract.yaml）

| resolver 结果 | append 行为 | replay 行为 |
|---|---|---|
| found + digest 一致 | 校验通过，事件不带任何校验标记 | 同左 |
| found + digest 不一致 | 事件带 `ref_invalid` 标记落盘 + `appended_blocked` | 该事件内存中标记 + blocks 报告；文件只读不改写 |
| not_found | 同上（cause = fact_not_found） | 同左 |
| 查询自身失败 | `err(resolver_failure)`，不落盘、不标记 | `err(resolver_failure)` |

设计理由：事件是事实记录，校验失败也要留痕（与 `assistant/attempt` 同哲学）；但基础设施故障 ≠ 引用失效，此时不落盘（宁可少一条，不可错标）。

## 5. 偏离与自主决策点（均在授权范围内，供 owner review 知悉）

1. **落盘契约登记选了新建 `session.contract.yaml`**（owner 口径 #4 给了两个选项）：`bridge.contract.yaml` 定位是"对 ATF 内核认知的唯一真相源"，会话落盘是 harness 本地形态、不涉内核对接面——分文件登记语义更干净，且避免为非内核事项触碰 S1 契约文件。两文件已在各自头部注明互不隶属。
2. **`convertToLlm` 采用白名单投影而非黑名单剔除**：任务书说"过滤 UI-only 字段"，实现为"输出仅含白名单字段"——可验收性更强（键集恒定可断言），且与项目"模型可见 schema 白名单"哲学一致。UI-only 字段的载体定为事件顶层 `ui` 命名空间（schema v0 新增的可选字段，已登记契约）。
3. **ref_invalid 事件照常落盘**：任务书"该事件标记 ref_invalid"按字面执行——标记落盘 + block 并行，而非"校验失败即拒写"。拒写仅保留给 schema 违规（结构性非法）与 resolver 故障（校验状态不可知）。
4. **`SessionLog.create` 将 resolver 设为必要参数**（会话层自创建起即具备校验能力），并支持既有文件续写打开（id 续接）；续写打开只做结构校验不做 digest 校验（digest 校验职责在 append 与 replay）。

无与任务书/指令冲突的偏离；S1 桥接层与 `bridge.contract.yaml` 零改动。

## 6. 验证记录（VERIFY）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✓ 0 error |
| 全量测试 | `ATF_CLI_PATH=<本仓>/.atf-pinned npx vitest run` | ✓ **7 文件：56 passed / 2 skipped**（S1 26 passed / 2 skipped 零回归 + S2 新增 30 passed；2 skipped 为等待内核排队的既有占位） |
| pin 校验 | `.atf-pinned` HEAD = `a628f8b8e23beff104b42b5c80088416ea78b394`（v0.2.0b7） | ✓ 一致，全程未追新 |
| S1 手工冒烟 | `npm run smoke:s1 -- --mock` | ✓ exit 0 |
| S2 手工冒烟 | `npm run smoke:s2`（append → replay 重建 → 篡改反例 → 白名单投影全流程） | ✓ exit 0 |
| 内核仓改动 | — | 零改动（本 slice 未触 `ATF_CLI_PATH` 副本工作区任何文件） |

## 7. 改动文件清单

新增（实现）：
- `src/session/schema.ts` — schema v0：7 类白名单、`DomainRef` / `Projection` / `SessionEvent`、信封与三元组校验
- `src/session/errors.ts` — `SessionError`（schema_violation / resolver_failure / corrupt_stream / io_error）+ `SessionBlock` / `InvalidRef`
- `src/session/digestResolver.ts` — `DigestResolver` 接口 + `MockDigestResolver` 契约 mock
- `src/session/sessionLog.ts` — `SessionLog.create/append/replay`：append-only JSONL、先落盘再继续、ref_invalid/block、id 续接、损坏流 fail-closed
- `src/session/pipeline.ts` — `transformContext` / `convertToLlm` 双管道占位 + `LlmContextEvent` 白名单形态
- `src/session/smoke.ts` — S2 手工冒烟命令
- `src/session/index.ts` — 会话层公开出口

新增（契约与测试）：
- `session.contract.yaml` — 会话层契约登记（schema v0 / digest 校验语义 / 落盘形态 / 双管道签名）
- `tests/session/sessionLog.test.ts`（验收 1/2）、`tests/session/pipeline.test.ts`（验收 3）、`tests/session/schema.test.ts`（白名单与损坏流反例）、`tests/session/digestResolver.test.ts`

修改：
- `package.json` — 仅新增 `smoke:s2` script（`dependencies` 保持不存在，零运行时依赖不变）

未改动：`src/bridge/**`、`bridge.contract.yaml`、`tests/bridge/**`、`AGENTS.md`、内核仓任何文件。

## 8. 下一步建议

1. owner review 本报告与 `session.contract.yaml`（尤其 §4 校验语义表与 §5 决策点 2/3 的口径确认）。
2. review 通过后决议 push 与否（沿用 S1 流程：owner 批准后由 owner 或指定会话推送）。
3. S3（工具注册表 + 账本审批）**未获指令不启动**——本会话按指令停在此处。
