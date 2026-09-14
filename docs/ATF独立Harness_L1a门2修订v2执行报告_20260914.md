# ATF 独立 Harness——L1a 门 2 修订 v2 执行报告：provider 配置形态对齐（两层 ＋ 凭据引用 ＋ 兼容声明）

**签发**：harness 侧会话（zcode，worktree `.worktrees/provider-config-v3`，分支 `work/20260914-provider-config-v3`）
**日期**：2026-09-14
**依据**：《ATF独立Harness_L1a门2修订任务书v2_provider配置对齐PiDSH_20260914.md》（§0 参照 / §1 七条规则 / §2 范围 / §3 VERIFY 九项）＋《ATF-Harness_Owner决议与指令_L1a门2验收_推送_20260914.md》（§3 配置就绪 / §4 登记项 / §5 推送授权）
**性质**：**纯增量修订**——只动配置形态与装配点，闭环语义 / 两 codec 线缆语义 / 通道 / 切片 0/1/2 护栏零改动；`bridge.contract.yaml` 零改动；零真实网络调用；**本地提交随门 2 验收推送授权一并推送（累计 7 笔）**

---

## 1. 形态变更与 Pi/DSH 对齐说明（规则 1/2）

- `src/llm/providerConfig.ts` 全量重写为**两层清单**（`schema_version: "HarnessLlmConfig/v3"`）：
  顶层（`default_provider` 必填 / `default_model` 可选 / 全局旋钮）→ `providers.<别名>`（`protocol` / `base_url` / 凭据引用 / `compat` / `models[]`）→ 模型级元数据——与 Pi `models.json`（providers→models、`compat`、模型元数据）与 DSH `settings.yaml`（两层、`apiKeyEnv` 凭据引用、agent-default）同构；
- **选择**：`ATF_LLM_PROVIDER` / `ATF_LLM_MODEL` 覆盖默认；`default_model` 省略取 `models[0]`（顺序即默认，迁移说明明写）；未知 id → 结构化拒绝（fail-closed）；
- 选择语义细化（用例登记）：`default_model` 是**选中 provider 内**的默认——跨 provider 未声明该模型时须 env 显式选择（fail-closed 拒绝，不猜测回退）。

## 2. 凭据引用与零明文断言（规则 3，VERIFY 3）

- `api_key_env`（首选）与 `api_key`（过渡字面值，文档标注不推荐）**二选一**；并存 → 拒绝；引用的环境变量缺失/为空 → 拒绝；
- **零明文断言**：① `smoke:l1a` 新增断言——配置文件全文不含 key（本冒烟的假 key 仅运行期注入环境变量 `ATF_LLM_KEY_LOCAL_FAKE`，**不落任何文件**）；② 仓内扫描——`src/`/`tests/`/`docs/` 下无任何 `.json` 配置含 `api_key` 键；测试反例中的"字面值"仅为显式 fake 标记（`fake-transitional-marker-DO-NOT-USE`，非凭据，且只存在于运行期临时文件场景）；
- 凭据仍只在出站请求头出现（脱敏漏斗与 host 粒度 detail 延续，零改动）。

## 3. compat 与模型元数据生效证据（规则 4/5，VERIFY 4/5）

- **`supports_reasoning_effort:false` → 不发送**：codec `reasoningEffort` 入参扩展为 `string | null`，null 时请求体**整体省略** `reasoning_effort` 字段——请求体断言（`tests/llm/httpProvider.test.ts`）：缺省（协议标准）显式携带 `"reasoning_effort":"low"`；声明 false 后字段不存在；
- **`supports_developer_role`**：true → 首条指令消息 `role:"developer"`（新 OpenAI 约定）；缺省/false → `role:"system"`（与 v1 逐位一致）——codec 用例两向断言；
- **模型级元数据按选中模型生效**：`deepseek-flash`（默认）→ `max_tokens:4096`、effort 默认 low；`deepseek-v4-pro`（env 选择）→ `reasoning_effort:"max"`、`max_tokens:8192`、`context_window:131072`（配置解析断言）；env `ATF_LLM_REASONING_EFFORT`/`ATF_LLM_MAX_TOKENS` 覆盖模型级（VERIFY 7 用例）；
- **思考块剥离**（规则 5＋验收决议 §3 实现要求）：anthropic codec 对 `thinking`/`redacted_thinking` 块**剥离**（不进决策解析、不进模型上下文），其余未知块类型仍 fail-closed——用例：thinking＋text 混合响应只取 text；openai 面 `reasoning_content` 本就不在解析面（天然剥离）。

## 4. 校验 fail-closed 全表（规则 6，VERIFY 6）

未知顶层键 / 未知 provider 键 / 未知模型键 / `schema_version` 缺失或不符 / 缺 `protocol` / 缺 `base_url` / 缺 `models` / 空 `models` / 重复模型 `id` / `base_url` 内嵌 userinfo / `reasoning_effort="none"`（模型级与 env 同拦）/ 权限非 0600 / `ATF_LLM_CONFIG` 未设置——全部结构化拒绝（用例逐项覆盖）。

## 5. 迁移清单（规则 1/7，VERIFY 7 迁移干净）

| 迁移项 | 状态 |
|---|---|
| `src/llm/providerConfig.ts` 扁平解析路径（`PROVIDER_CONFIG_KEYS`/纯 env 供形/`ATF_LLM_PROTOCOL`/`ATF_LLM_BASE_URL`/`ATF_LLM_API_KEY`） | **已移除** |
| v1 配置层测试（单层正反例） | 重写为 v2 两层用例组（24 用例） |
| `smokeL1a.ts` 配置构造 | 两层＋`api_key_env`（＋配置文件零明文断言） |
| `l1aE2e.test.ts` rig | 两层＋`api_key_env` |
| `src/cli/resume.ts` / resume 通道 / runner / codec 线缆语义 | **零改动**（装配点仅 `httpProvider` 取选中 provider+model＋compat 传递） |
| 文档 | 《配置形态与迁移说明》（本文档姊妹篇，取代门 2 设计增补 §1.5 的 v1 说明） |

## 6. 零回归与闭环不变（VERIFY 8/9）

| 轨道 | 底线 | 实测 | 判定 |
|---|---|---|---|
| mock 轨 | ≥324 passed / 9 skipped | **338 passed / 9 skipped（40 文件）** | ✅ 基线全保留＋14 用例 |
| 真对端轨（`ATF_CLI_PATH=.atf-pinned`） | ≥329 passed / 1 skipped | **343 passed / 1 skipped（40 文件）** | ✅ 基线全保留＋14 用例 |
| `smoke:s5` / `smoke:p2s2` / `smoke:p2s3` / `smoke:r2` | 全过 | 全过 | ✅ |
| `smoke:l1a`（VERIFY 9 闭环不变） | 挂起 75＋人放行闭环逐项不变 | 挂起闭环（exit 75；turn 收口 reason=suspended）／`--list` 待办／`--answer granted` → exit 0／`tool/result(ok=true, call_ref=9)`／零外连 5 笔回环——**与门 2 验收原始输出逐项一致** | ✅ |
| `typecheck` | 通过 | 通过 | ✅ |
| `dependencies` | 恒空 | 恒空 | ✅ |

**登记项落实（验收决议 §4）**：悬空工具调用合成结果**首行显式标注 `[未执行：等待人工审批]`**（审批摘要与"动作未发生"说明保留）——`codecWire.danglingToolResultContent` 单点改动，既有断言（含"未执行"）零改动通过；接真实模型前的输入歧义已消除。

## 7. 条款映射表（改动 → 设计条款）

| 改动 | 对应条款 |
|---|---|
| `src/llm/providerConfig.ts` 重写（两层/schema_version/选择/校验/凭据解析） | 任务书 v2 §1 规则 1/2/3/6；§0 Pi/DSH 形态 |
| `src/llm/codecWire.ts`（`reasoningEffort: string\|null`、`developerRole`、悬空合成首行标注） | 规则 4/5；验收决议 §4 登记项 |
| `src/llm/openaiChatCodec.ts`（null 省略 reasoning_effort；developer 角色分流） | 规则 4；缺省行为与门 2 逐位一致 |
| `src/llm/anthropicMessagesCodec.ts`（thinking/redacted_thinking 剥离） | 规则 5；验收决议 §3 三条实现要求 |
| `src/llm/httpProvider.ts`（装配 compat；providerId = provider 别名） | 规则 4/7；§2 装配点收敛 |
| `src/run/smokeL1a.ts` / `tests/run/l1aE2e.test.ts` 迁移 | 规则 1/3；VERIFY 3/9 |
| `tests/llm/providerConfig.test.ts` 重写 ＋ codec/httpProvider 新用例 | VERIFY 1–7 |
| `docs/`：条款级完成清单 ＋ 配置形态与迁移说明 ＋ 本报告 | §3 附加；§4.3 |

## 8. 偏离规范之处（全部已登记于开工前清单「惯例与登记项」）

1. **codec 两处最小改动**：`reasoningEffort` 允许 null（compat 抑制省略，VERIFY 4 的实现载体）与 anthropic 思考块剥离（规则 5 明文要求）——均为任务书条款直接要求，非顺手改；缺省线缆行为与门 2 逐位一致（mock 轨零回归佐证）；
2. **文件级全局旋钮**（`timeout_ms`/`max_retries`/`max_calls_per_run` 顶层可选键）：规则 7 env 覆盖的覆盖对象，不在 §1 示例形态中，登记为补充；
3. **配置文件为 v2 唯一来源**：两层结构无法经 env 完整表达，纯 env 供形随扁平路径移除（`ATF_LLM_CONFIG` 必设）；
4. **`reasoning` 元数据语义**：描述性＋剥离必要性开关，不改变请求体（发送与否由 compat 决定）；
5. **悬空合成文本更新**：验收决议 §4 登记项，单点落实（见 §6）。

## 9. 提交与推送清单（验收决议 §5）

1. `feat(l1a)`：修订 v2 工作笔（配置层两层重写/codec 装配点/迁移/测试/文档）；
2. `merge`：`work/20260914-provider-config-v3` → main（分支与 worktree 合回后删除）；
3. `docs(l1a)`：本报告入库；
4. **推送前强制复跑**（§5.1）：两轨（底线 329/1 与 324/9）＋五冒烟——结果见 §6 与推送记录；
5. **推送** `git push origin main`（SSH 22 通道）：累计 **7 笔**＝切片 2 三笔（`0684c5c`/`d804828`/`67bb941`）＋ L1a 三笔（`b5ef0ca`/`43c8a0e`/`59ef292`）＋ 本修订两笔（feat＋merge）与本报告笔（推送时以 `git log origin/main..HEAD` 实际清单为准）；推后核对 `git rev-list --count HEAD..origin/main` = 0。

**待 owner（不在本次范围）**：① A800 三份 v1 配置按《配置形态与迁移说明》§2.4 迁移为一份两层文件（key 改 `api_key_env`）；② 真实端点完整试用仍待 owner 第二次授权＋新 snapshot/binding（登记项 §4 已在本修订落实）。
