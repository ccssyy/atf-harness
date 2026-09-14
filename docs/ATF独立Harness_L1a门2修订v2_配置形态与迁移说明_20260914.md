# ATF 独立 Harness——L1a 门 2 修订 v2：配置形态与迁移说明

**日期**：2026-09-14 ｜ **执行方**：harness 侧会话（zcode）
**依据**：《ATF独立Harness_L1a门2修订任务书v2_provider配置对齐PiDSH_20260914.md》§4.3；形态对齐 Pi `~/.pi/agent/models.json` ＋ DSH `~/.dsh/settings.yaml` 实测形态（任务书 §0）
**性质**：本文为 provider 配置的**现行权威说明**；《L1a 门 2 设计增补》（2026-09-14）§1.5 的 v1 单层配置说明自本修订起**由本文取代**。

---

## 1. 唯一规范形态（两层清单，`HarnessLlmConfig/v3`）

```json
{
  "schema_version": "HarnessLlmConfig/v3",
  "default_provider": "deepseek",
  "default_model": "deepseek-flash",
  "timeout_ms": 60000,
  "max_retries": 1,
  "max_calls_per_run": 50,
  "providers": {
    "deepseek": {
      "protocol": "openai-chat",
      "base_url": "https://api.deepseek.com",
      "api_key_env": "ATF_LLM_KEY_DEEPSEEK",
      "compat": { "supports_developer_role": false, "supports_reasoning_effort": true },
      "models": [
        { "id": "deepseek-flash",  "reasoning": true, "max_tokens": 4096 },
        { "id": "deepseek-v4-pro", "reasoning": true, "reasoning_effort": "max", "max_tokens": 4096, "context_window": 131072 }
      ]
    },
    "deepseek-anthropic": {
      "protocol": "anthropic-messages",
      "base_url": "https://api.deepseek.com/anthropic",
      "api_key_env": "ATF_LLM_KEY_DEEPSEEK",
      "models": [ { "id": "deepseek-v4-pro", "reasoning": true, "max_tokens": 4096 } ]
    }
  }
}
```

### 1.1 键面（闭集，未知键一律 fail-closed）

| 层 | 键 | 说明 |
|---|---|---|
| 顶层 | `schema_version` | 恒 `"HarnessLlmConfig/v3"`（其他值拒绝） |
| 顶层 | `default_provider` | **必填**（规则 2） |
| 顶层 | `default_model` | 可选；省略 = 选中 provider 的 `models[0]`（**顺序即默认**） |
| 顶层 | `timeout_ms` / `max_retries` / `max_calls_per_run` | 可选全局旋钮（默认 60000 / 1 / 50；`max_retries` 允许 0 = 不重试） |
| provider | `protocol` | `openai-chat` \| `anthropic-messages`（`openai-responses` 仍为预留位，拒绝并提示硬前提） |
| provider | `base_url` | http(s)；拒绝内嵌 userinfo 凭据（ADR-09） |
| provider | `api_key_env` \| `api_key` | **二选一**：环境变量名（首选）/ 字面值（仅过渡，**不推荐**，仓内配置与 fixture 禁用）；并存 → 拒绝 |
| provider | `compat` | 可选：`supports_developer_role`（true → 首条指令消息用 `developer` 角色；缺省 `system`，与 v1 行为一致）/ `supports_reasoning_effort`（false → 请求体**整体省略** `reasoning_effort`；缺省 = 发送） |
| provider | `models` | 非空数组；`id` provider 内唯一 |
| model | `id` ＋ `reasoning` / `reasoning_effort` / `max_tokens` / `context_window` | 模型级元数据（可选）；`reasoning=true` ⇒ 对端可能返回思考块，codec **剥离** `thinking`/`redacted_thinking`（openai 面的 `reasoning_content` 本就不进解析面） |

### 1.2 选择与覆盖

- **选择**：`ATF_LLM_PROVIDER=<provider 别名>` ＋ `ATF_LLM_MODEL=<模型 id>` 覆盖 `default_provider`/`default_model`；指到不存在的 id → fail-closed。注意 `default_model` 是**选中 provider 内**的默认——切换到未声明该模型的 provider 时须显式给 `ATF_LLM_MODEL`；
- **旋钮覆盖优先级**：`ATF_LLM_TIMEOUT_MS` / `ATF_LLM_MAX_RETRIES` / `ATF_LLM_MAX_CALLS_PER_RUN`（env > 文件顶层 > 默认）；`ATF_LLM_REASONING_EFFORT` / `ATF_LLM_MAX_TOKENS`（env > 模型级元数据 > 默认）——全部作用于**选中 provider+model**（规则 7）；
- **凭据解析**：加载时读 `api_key_env` 指向的环境变量，缺失/为空 → fail-closed；凭据只在出站请求头出现，不进事件/载荷/报告/日志；
- **文件纪律**：路径经 `ATF_LLM_CONFIG` 指定（不入仓）；权限 0600（否则拒绝加载）；两层结构只能经文件表达，环境变量仅作选择与旋钮覆盖。

## 2. 迁移说明（v1 单层 → v2 两层）

### 2.1 对应关系

| v1 扁平键（已移除） | v2 去向 |
|---|---|
| `protocol` | `providers.<别名>.protocol` |
| `base_url` | `providers.<别名>.base_url` |
| `api_key`（明文） | **`providers.<别名>.api_key_env`**（把 key 放进环境变量，配置只留变量名；过渡期可暂用 provider 级 `api_key` 字面值，不推荐） |
| `model` | `providers.<别名>.models[].id` ＋ 顶层 `default_model`（或 env `ATF_LLM_MODEL`） |
| `timeout_ms` / `max_retries` / `max_calls_per_run` | 顶层同名键（语义不变；env 覆盖保留） |
| `reasoning_effort`（全局键） | 模型级 `reasoning_effort`（或 env `ATF_LLM_REASONING_EFFORT`） |
| `max_tokens`（全局键） | 模型级 `max_tokens`（或 env `ATF_LLM_MAX_TOKENS`） |
| —（新增） | `schema_version` / `default_provider` / `compat` / `reasoning` / `context_window` |

### 2.2 迁移示例

旧（v1，已不被读取）：

```json
{ "protocol": "openai-chat", "base_url": "https://api.deepseek.com", "api_key": "sk-…（明文）", "model": "deepseek-flash", "max_tokens": 4096 }
```

新（v2）：

```json
{
  "schema_version": "HarnessLlmConfig/v3",
  "default_provider": "deepseek",
  "default_model": "deepseek-flash",
  "providers": {
    "deepseek": {
      "protocol": "openai-chat",
      "base_url": "https://api.deepseek.com",
      "api_key_env": "ATF_LLM_KEY_DEEPSEEK",
      "models": [ { "id": "deepseek-flash", "reasoning": true, "max_tokens": 4096 } ]
    }
  }
}
```

配套：`export ATF_LLM_CONFIG=<0600 文件路径>`、`export ATF_LLM_KEY_DEEPSEEK=<真实 key>`。

### 2.3 删除清单（本修订移除的 v1 面）

- `PROVIDER_CONFIG_KEYS`（v1 扁平键闭集）与扁平解析路径——`src/llm/providerConfig.ts` 全量重写；
- v1 env 供形键：`ATF_LLM_PROTOCOL` / `ATF_LLM_BASE_URL` / `ATF_LLM_API_KEY`（连同"纯 env 无文件"供形——两层结构只能经文件表达）；
- 冒烟与 e2e 中的扁平配置文件构造（`smokeL1a.ts` / `l1aE2e.test.ts`）——全部迁移为两层＋`api_key_env`；
- v1 配置层测试（单层正反例）——由 v2 两层用例组取代（`tests/llm/providerConfig.test.ts` 重写）。

### 2.4 owner 侧待迁移（仓外，不阻塞）

《L1a 门 2 验收》§3 登记的三份 A800 配置（`llm.openai-flash.json` / `llm.openai-pro.json` / `llm.anthropic-pro.json`）按 §2.1 对应关系迁移为一份两层文件：key 由明文改 `api_key_env` 引用；文件 `0600`（目录 `0700`）不变；`ATF_LLM_PROVIDER`/`ATF_LLM_MODEL` 可在三个形态间选择，无需三份文件。
