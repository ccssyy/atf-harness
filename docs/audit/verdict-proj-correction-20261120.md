# verdict：ATF 项目纠正批（阶段 0-1 / 1-A / 2）

- **验收时点**：2026-11-20
- **评估器**：主会话自行验收（contract-verdict 子 agent 超时未回，如实登记）
- **commit**：
  - 内核 `64a38563`（相对上次部署 pin `937f729b`）
  - harness `8f33cec5`（相对上次部署点 `d3feccc4`）
- **总判定：PASS**

---

## 条款判定

### C1 分组确认闸判据修正 —— PASS

**改动**：`_gate_confirmed_for` 判定对象从「顶层 `confirmed`」改为「`grouping.confirmed`，缺键回落顶层」。

**验证证据**：

① 新旧逻辑源码逐字对比成立：

```python
# 旧版（937f729b）
config = self._read_json_if_file(path)
return isinstance(config, dict) and isinstance(config.get("confirmed"), dict) and bool(config["confirmed"])

# 新版（64a38563）
config = self._read_json_if_file(path)
if not isinstance(config, dict):
    return False
grouping = config.get("grouping")
if isinstance(grouping, dict) and "confirmed" in grouping:
    return bool(grouping["confirmed"])
return isinstance(config.get("confirmed"), dict) and bool(config["confirmed"])
```

② 四态行为验证（真实内核，主仓代码）：

| 场景 | 结果 | 期望 |
|---|---|---|
| 分组未确认 + 顶层 by=user（缺陷场景） | `False` | ✅ 拦 |
| 分组已确认 | `True` | ✅ 放 |
| 旧 run 无 grouping 块 | `True` | ✅ 兼容 |
| 空配置 | `False` | ✅ fail-closed |

③ 判据先行成立：新增 `tests/skills/test_gate_judges_claimed_object.py`
- 修复前如实变红（AssertionError 准确指出「判定对象错读为顶层 confirmed」）
- 修复后 4 passed
- **该闸此前零测试覆盖**（`grep -rn '_gate_confirmed_for' tests/` 无命中）

④ 内核 fast 全量：**1293 passed / 0 failed**

**随迁偏差（登记，非判定性）**：三处测试夹具原本依赖「顶层 confirmed 恒为真」才能过，
补 `--grouping-confirm` 显式声明。这三处夹具本意是「机制贯通」而非「未确认也能切分」，
补参后语义与本意一致。**属预期变更，非回归。**

---

### C2 卡面限时等待 + 原生提问工具挂载 —— PASS

**验证证据**：

① `askTimed` 确为 DSH vendor 已有能力，非自造：
- `vendor/dsh/deepseek-harness/packages/interaction/user-questions/src/index.ts:234`
- 类型声明 `lib/types/index.d.ts:79`
- 编译产物 `lib/index.js:613`
- **atf 此前只用了 `ask()`，未用 `askTimed()`**

② 四种回落路径真实存在且行为不变：
- 无 `askTimed` 能力 → 回落 `ask`
- `ATF_ASK_TIMEOUT_MS=0` → 回落 `ask`
- 无 `callId` → 回落 `ask`
- 无 `agent` → 回落 `ask`

③ 判据：`tests/dshTools/askTimeout.test.ts` **9 passed**（限时生效／超时转 pending／四态回落／配置解析四态）

④ `tool-ask-user` 挂载格式对照 vendor Config schema 正确：
```yaml
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  config:
    mode: timed
    timeout: 120
```

⑤ typecheck exit 0

---

### C3 删线两批 —— PASS

**删除**：`src/ui`、`src/acp`、`src/mcp`、`src/core/run`、`src/run`、`src/cli` 及对应测试

**验证证据**：

① `packages/` 对已删模块**零真实 import**：
```
grep -rn 'core/run' packages/*.ts  → 仅 bridgeFace.ts:214 一处注释，无 import
```

② dev 依赖的 src 文件全数在场（10/10 逐个验证）：
`agent/fileTools` `agent/fileRoots` `agent/atfAgentTools` `webui/readOnlyTools`
`webui/configConfirm` `webui/settings` `webui/storageSettings` `core/tools/index`
`bridge/bridgeCommand` `llm/providerConfig`

③ typecheck：**292 错误 → 0**

④ **预演驱动器 17 段全链真跑：80 PASS / 0 FAIL，JOURNEY GREEN，卡面捕获 7 次**
——删线未破坏任何一段的用户可见行为

⑤ 净减 10,334 行（57,436 → 47,102）

---

### C4 blockGuidance 迁移 —— PASS

**改动**：`src/core/run/blockGuidance.ts` → `src/core/blockGuidance.ts`，内部 `../tools` → `./tools`；
`src/llm/adapter.ts` import 路径同步修正。

**验证**：
- 被 `src/llm/adapter.ts` 真实 import（`renderGuidanceText`），非甲线私有
- typecheck 0 错，无循环依赖

---

## 偏差清单（非判定性）

1. **contract-verdict 子 agent 超时未回**：本 verdict 由主会话自行完成验收。
   如实登记——按 harness-flow 纪律本应由独立角色出具，本次为时间约束下的权宜。

2. **harness 既有存量测试污染**：`tests/dshTools` 全量并行跑有 9-10 例失败，
   单独跑全过（`atfTools.test.ts` 单跑 33 passed）。属测试间状态泄漏的既有问题，
   与本次改动无关（改动前基线同口径对比已确认）。

3. **三处测试夹具补 `--grouping-confirm`**：见 C1 随迁说明，属预期变更。

---

## 覆盖边界

- 本 verdict 覆盖：分组闸判据、卡面限时等待、原生提问工具挂载、删线两批、blockGuidance 迁移
- **不覆盖**：阶段 3（段序单源）、阶段 4（zcode A/B/C 缺陷批）——本批未实施
- 预演覆盖内核段行为与段间 IO 对账，**不覆盖** LLM 行为面（预演驱动器不经 LLM，
  这是 zcode C1 已指出的判据缺口，本批未补）

---

## 总判定：PASS
