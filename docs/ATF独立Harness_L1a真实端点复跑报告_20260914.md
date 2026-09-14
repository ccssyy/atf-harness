# ATF 独立 Harness——L1a 真实端点复跑报告（owner §4 授权）

**签发**：harness 侧会话（zcode，worktree `.worktrees/l1a-real-rerun`，分支 `work/20260914-l1a-real-rerun`）
**日期**：2026-09-14
**依据**：《ATF-Harness_Owner决议与指令_配置修订v2验收_推送_20260914.md》§4（L1a 真实端点复跑授权）＋ L1a 设计 §2/D4 试用任务
**性质**：**真实网络调用仅限本授权范围**（经配置选中的 deepseek / deepseek-flash，条款内按量）；真实内核写仅落 /tmp 夹具根（合成数据）；**本地提交，推送另行授权**；产出本报告后即停

---

## 1. 硬前提核验（授权 §4 三项）

| # | 前提 | 核验 |
|---|---|---|
| ① | 合成 tool_result 显式标注"未执行：等待人工审批" | ✅ 修订 v2 已落实（`codecWire.danglingToolResultContent` 首行 `[未执行：等待人工审批]`），trial 脚本断言留证 |
| ② | 新 snapshot/binding | ✅ 真实内核 mkdtemp 夹具（`atf init` 装机 + run 十目录骨架 + journal×3 + admission-summary lane-a 全 pass）＋ runner `atf.bind_run`；全程 pin 副本（HEAD=`b6db3496…` 与契约 pin 一致）只读 |
| ③ | 凭据仅经 .env/配置注入，全程脱敏断言 | ✅ owner 两层配置 `~/.atf-harness/llm.json`（v3 形态，`api_key_env` 引用）＋ 同目录 `.env`（0600）；trial 终局对事件/报告/会话流/CLI 输出/落盘产物全序列化 not-contains 断言通过；key 值不落任何输出 |

## 2. 执行序列与原始输出（最终构建权威跑）

```
$ ATF_CLI_PATH=<pin 副本> ATF_LLM_CONFIG=~/.atf-harness/llm.json npm run trial:l1a-real

L1a 真实端点复跑（owner §4 授权）通过 ✓
  - 硬前提① 合成 tool_result 首行标注 [未执行：等待人工审批] —— 已在位（修订 v2 codecWire.danglingToolResultContent）
  - 对端 = pin 副本（HEAD = b6db3496b340…，与契约 pin 一致；只读）
  - 配置选中 provider=deepseek model=deepseek-flash protocol=openai-chat host=api.deepseek.com
    api_key_len=35 reasoning_effort=low max_tokens=4096（凭据值不落任何输出）
  - 硬前提② 新 snapshot/binding：真实内核夹具（/tmp 夹具根，atf init 装机）+ l1a-real-trial-run-1
    十目录骨架 + journal×3 + admission-summary（lane-a 全 pass）+ runner bind_run
  - preflight 账本探针通过：预录 scope 与 runner 查询 scope 逐字段一致，1 条 approved 可消费（一次性语义确认）
  - run 1 真实模型决策序：atf_workspace_status({}) → atf_fact_scan({}) → atf_gate({"gate":"g1","action":"query"})
    → atf_admit_data({"dataset_id":"ds-l1a-real-trial","source_ref":"l1a-real-trial-manual"})
    （provider 调用 3 次，逐决策经守卫与逐工具审批）
  - run 1 挂起闭环：approval/request#13 → turn/end(reason=suspended) → exit 75（INV-2）
  - CLI resume --list：待办可见（request#13，status=timeout_awaiting_human）
  - CLI resume --answer granted：resume 终局: outcome=completed exit=0 事件数=20
  - 真实写落盘证据：datasets/ds-l1a-real-trial@10c2ac7e366a/registration.json
    （dataset_id=ds-l1a-real-trial，pin=10c2ac7e366a，文件 sha256=a34322895e1d3166…；
    会话流 digest=6db766ecf46bbb27…）
  - run 2 真实模型续跑：重派执行后经真实调用收束（会话流 assistant/message 共 4 条）
  - 脱敏断言：事件/报告/会话流/CLI 输出/落盘产物全序列化不含任何凭据值
  - 隔离断言：pin 副本 git status 零改动；temp HOME 无 .agents/skills 泄漏；真实写仅落 /tmp 夹具根（合成数据）
```

**preflight 说明**：注入式对端预录**恰 1 条** operator 授权（scope 与 runner 查询逐字段一致），专供只读链 gate(query) 经账本轨自主消费；`atf_admit_data` 无预录 → 问答轨（人工）。resume 进程使用**纯净对端**（账本为空），确保重派走**人工凭据路径**而非预录——放行唯一来源 = CLI 应答（ADR-07）。

## 3. 会话流证据（跨进程完整事实链，节选）

| 事件 id | 类型 | 要点 |
|---|---|---|
| 3–12 | 真实模型决策序 | message → workspace_status(ok, call_ref=4) → fact_scan(ok, call_ref=6, 3 条 operation-journal) → message → gate(g1,query)(ok, **G1 pass**, call_ref=9) → message → admit_data 提案 |
| 13 | approval/request#13 | tool=atf_admit_data, attempt=1（问答轨，无账本预录） |
| 14 | approval/response | verdict=**timeout**, actor=harness（headless 等待耗尽，超时非否决） |
| 15 | turn/end(reason=**suspended**) | **exit 75**（INV-2：任意可写终局收口 turn） |
| 16 | approval/response | verdict=**granted**, actor=**cli-operator**（CLI 子进程写入，ref=13） |
| 17 | turn/start | **resume 开新 turn**（INV-1：turn 不跨进程） |
| 18 | tool/result(ok=**true**, call_ref=**12**) | 重派原 tool/call（复用原事件 id）→ 凭据 available 放行 → **真实写**：`fact_id=ds-l1a-real-trial@10c2ac7e366a`, journal_type=dataset-registry, sha256=6db766ec… |
| 19–20 | assistant/message + turn/end(completed, stop_reason=final_answer) | 真实模型中文汇总 → **exit 0** |

**模型最终答复（全文见 trial 留存目录）**：真实模型自主汇总了现场勘察（run/scope/admitted_count=0）、事实索引（3 条）、闸门状态（G1 pass，按指令只查询一次）、数据集登记（`ds-l1a-real-trial@10c2ac7e366a`，含审批往返审计引用 aps-1 / request_event_ref=13），并给出四条下一步建议（复核 digest、按序推进后续闸门、审批超时阈值确认、以三元组引用事实）——**对审批链的可解释性达到 D4 验收口径**。

## 4. 脱敏与隔离断言

- **脱敏**：`.env` 中全部凭据值（deepseek/glm 两把）对 run1 报告事件、会话流全文、CLI stdout/stderr、registration.json 落盘产物做全序列化 not-contains 断言——通过；key 只在出站 `Authorization: Bearer` 头出现（假端点时代已证，本复跑同构）；
- **隔离**：pin 副本 `git status` 零改动；temp HOME 无 `.agents/skills` 泄漏（技能自举关闭）；真实写仅落 `/tmp/atf-l1a-ws-*` 夹具根（合成数据 `ds-l1a-real-trial`）；
- **预算**：轮次 32/8 与单 run 调用上限 50 未放宽；实测 run 1 = 3 次 HTTP（7 决策，A3 缓冲），run 2（CLI 子进程）重派 + 收束若干次，远低于上限。

## 5. 复跑适配登记项（真实端点揭示，全部为最小增量；mock 轨默认行为逐位不变）

| # | 发现 | 适配 | 证据 |
|---|---|---|---|
| 1 | **内核 `ScopeMode` 枚举仅 `{canonical, simulation}`**——runner 硬编码 `scope_mode:"headless"` 被 `ledger_query` 拒绝（`invalid_params`），真实内核上任何须审批调用都无法执行（mock 轨测不出的桩-真差异） | `RunBranchOptions.scopeMode?`（默认 `headless` 不变）＋ CLI `--scope-mode`；trial 传 `canonical` | preflight 探针：headless → 拒绝；canonical → 通 |
| 2 | **DeepSeek thinking 模式要求回传 `reasoning_content`**（实测规则：会话内 ≥2 个 assistant 工具调用轮时**每轮都必须携带**，内容不校验；单轮可省——4 组原始探针钉死） | 模型元数据 `reasoning:true` 时启用**全量回填**：构造请求给所有缺 rc 的工具调用轮填最新捕获思考内容；**历史/恢复场景以中性占位文本补齐**（规则 5 剥离语义不变——canonical 上下文/会话流不落思考内容，仅线缆域回传） | run1 挂起 → resume 全链通；P1–P9 探针记录 |
| 3 | 相邻 assistant 线缆消息合并（文本并入紧随的 tool_calls 消息，`tool_calls:null` 视为无）——OpenAI 规范形态（content+tool_calls 同体），协议等价，仅线缆投影 | codec 线缆形状规则（`mergeAdjacentAssistantText`） | 单测 2 例 |
| 4 | 诊断转储开关 `ATF_LLM_DEBUG_DUMP=1`（4xx 时在错误 detail 附请求体——**不含任何请求头/凭据**） | `httpProvider` 诊断面 | run5–run8 定位过程 |

**已知边界（登记）**：恢复场景历史轮次的思考内容不可恢复（规则 5 剥离语义的必然代价），以占位文本回填满足对端校验——真实模型读到的是占位而非其原始思考；若后续认为影响行为质量，评估方向 = 内核侧会话协议为思考内容开持久化位（owner 另批，涉及会话 schema 扩面）。

## 6. 零回归（两轨＋五冒烟，复跑适配合入后）

| 轨道 | 底线 | 实测 | 判定 |
|---|---|---|---|
| mock 轨 | ≥338 passed / 9 skipped | **340 passed / 9 skipped（40 文件）** | ✅ |
| 真对端轨（`ATF_CLI_PATH=.atf-pinned`） | ≥343 passed / 1 skipped | **345 passed / 1 skipped（40 文件）** | ✅ |
| `smoke:s5` / `p2s2` / `p2s3` / `r2` / `l1a` | 全过 | 全过 | ✅ |
| `typecheck` ＋ `dependencies` | 通过 ＋ 恒空 | 通过 ＋ 恒空 | ✅ |

新增测试：codec 合并与 thinking 全量回填（2 例）；`trial:l1a-real` 冒烟级脚本（`npm run trial:l1a-real`，需真实授权环境变量）。

## 7. 条款映射（改动 → 授权条款）

| 改动 | 条款 |
|---|---|
| `src/run/trialL1aReal.ts` ＋ `trial:l1a-real` 脚本 | 决议 §4（真实试用任务 D4 ＋ 硬前提 ①②③ 断言承载） |
| `src/run/runner.ts` `scopeMode?` ＋ `src/cli/resume.ts` `--scope-mode` ＋ `src/run/resume.ts` 参数面 | 复跑适配 ①（内核 ScopeMode 枚举对接） |
| `src/llm/codecWire.ts`（`thinkingEcho`/占位）＋ `src/llm/openaiChatCodec.ts`（合并＋全量回填）＋ `src/llm/httpProvider.ts`（捕获/装配/诊断转储） | 复跑适配 ②③④；规则 5 剥离语义不变 |
| `tests/llm/codecOpenAI.test.ts`（＋2 例） | 适配 ②③ 的回归承载 |

## 8. 提交清单（本地提交，**未推送**）

1. `feat(l1a)`：真实端点复跑（trial 脚本 ＋ 复跑适配 ＋ 测试）；
2. `merge`：`work/20260914-l1a-real-rerun` → main（分支与 worktree 合回后删除）；
3. `docs(l1a)`：本报告入库。

**完成即停**：L1a 真实端点复跑闭合——「真实模型自主只读 → 真实写挂起(75) → CLI 放行 → 真实写执行 → run 可解释」在**真实内核 ＋ 真实 LLM**下成立。待 owner：① 推送授权；② 旧扁平配置文件（`/root/.atf-harness/llm.openai-*.json` 等，含明文 key）按 README ③ 计划删除并轮换；③ 思考内容持久化位（若需要）涉及会话 schema 扩面，另批。
