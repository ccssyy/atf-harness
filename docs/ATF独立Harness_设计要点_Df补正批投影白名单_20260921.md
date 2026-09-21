# ATF独立Harness｜D-f 补正批（投影白名单）《设计要点》（门 1 交付）— 2026-09-21

- **性质**：门 1 交付物（P0 回归补正；停等核验，门 2 放行后实施）。
- **基线**：main `0780479`（含 D-f 批）；pin `61631e6`（v0.7.2b0）不动；本文件为 untracked 交付物，门 2 随批首提交入册。
- **依据**：《ATF-Harness_指令_Df补正批投影白名单_20260921.md》（sha256 `1b3ff651…`）＋《ATF-Harness_冒烟2四跑核验记录_20260921.md》§三。
- **边界**：改动面限 `src/llm/adapter.ts`（＋测试）；不动 `runner.ts`／`ui/`／`toolDefinition.ts`；契约零 diff；`schema.ts` 零改动。

---

## 一、缺陷确认（一行事实）

`src/llm/adapter.ts:107`：`rejectUndeclared(event.payload, ["tool","ok","result","reason","call_ref","block","detail"], "tool/result")` —— D-f 给 payload 新增的可选字段 `nudge`／`guidance` 未声明 → 首条 guidance 回填后，下一拍 `adaptProjectionToMessages` 报 `tool/result 含未声明字段 "guidance"` → `httpProvider.ts:116` 折 `provider_failure`（"模型上下文投影失败 fail-closed"），该 run 此后每拍决策皆失败。与 `:117-121` 注释在案的 approval 白名单事故**同类第二次**；测试盲区同为「mock／真内核 e2e 走脚本面 provider，不经投影」。

注入点（main 实际行号）：`runner.ts:1224`（ok:true 附 nudge）／`:1226-1228`（ok:false 附 nudge／guidance）。

## 二、B1 白名单补登（核心，纯增量）

- **落点**：`src/llm/adapter.ts:107` 声明数组末尾追加 `"nudge"`、`"guidance"` 两项（单行改动）。
- **注释登记**：照 `:117-121` approval 先例格式，紧随其后补一行——「D-f 补正批登记（2026-09-21）：tool/result 增可选附注 nudge（无进展指引）／guidance（业务阻断码一行文案），注入点 runner.ts 回流 payload；切片 2 白名单未含 → 真实流投影被拦（第二次同类，测试盲区＝脚本面不经投影）；纯增量补登，映射语义不变」。
- **映射语义确认（不变）**：`:112` 摘要生成规则不动——失败回流 summary 仍为 `reason` 串、成功仍为 `readableSummary(result)`；两字段仅通过白名单校验、不参与摘要。
- **边界如实声明**：B1 后 `nudge`/`guidance` 文案**不会**因此进模型上下文（summary 规则不变，owner 明示不改）；D-f-4 三档升级为**控制面机制**（检测器在 runner 侧驱动 nudge→切断→收口，不依赖模型读到文案），四跑判据 J3 不受影响；模型侧可见性仍靠既有 `reason` 回流。此边界写入门 2 报告。

## 三、B2 投影路径用例（防第三次）

1. **纯函数（`tests/llm/adapter.test.ts` 追加）**：
   - `tool/result` 带 `guidance`（ok:false，含 block/detail）→ 投影不报错，summary == reason 串（正常生成）；
   - `tool/result` 带 `nudge`（ok:true 成功结果附注形态，覆盖 runner.ts:1224 注入点）→ 投影不报错，summary == readableSummary(result)；
   - **反向**：`tool/result` 带未声明字段（如 `budget`）→ 仍报 `含未声明字段`（白名单机制未被放宽）。
2. **链路最小复现（`tests/run/` 新增，走真投影路径——`FakeLlmEndpoint`＋`HttpLlmProvider`，沿 l1aE2e makeRig 先例，非脚本面）**：
   - 场景：模型面首拍调 `atf_data_admission_request` → mock 拒绝回流附 `guidance` → **下一拍 decide 成功**（伪端点收到第二次请求且投影无 adapter err）→ 修参/收束 → completed；
   - 该用例的通过输出即为「**guidance 回填后下一拍决策成功**」的明确证据（门 2 交付附原始输出）。

## 四、B3 同类遗漏自查（逐字段核过，结论：无其他遗漏）

- `tool/result`：`nudge`／`guidance`（本批修）；切断回填的 `tool_cut_no_progress` 为 `reason` **取值**非字段；`detail.control_plane`/`detail.until` 为已声明字段 `detail` 的取值——白名单只拦键不拦值 ✓。
- `turn/end`：`failure_summary`（含 `gap_card`/`cut_tools`/`blocked_description`）属 `turn/end` payload，而 `turn/end` 在映射表为 **skip**（`adapter.ts:63-64`），不经 rejectUndeclared——确认无风险 ✓。
- 其余 D-f 改动（TUI 渲染／approvalCopy／collapseView）在 UI 层，不产生事件 payload；`schema.ts` 事件类型白名单零变化 ✓。

## 五、口径（§五闭合，随门 2 报告两值并列）

当前 main 原始汇总：`Test Files 61 passed ｜ Tests 474 passed | 12 skipped (486)`（未设 `ATF_CLI_PATH`）。此前报数（481／492）为**设 `ATF_CLI_PATH` 口径**——真对端组 7 例由 skip 转 pass（474+7=481；分支态 485+7=492），系统性 +7 之差即此。门 2 交付报告将并列：① vitest 原始汇总行 ② 设/不设 CLI 两口径差值说明。补正批底线按 main 实测：**474 基线全保＋B2 新增用例全过**（并以 485+12 分支口径并列报数）。

---

**停等核验**。门 2 放行后：单点改动＋用例落地 → typecheck／全量／契约零 diff 复核 → 单批提交合入 main（本补正零契约面、可合入）→ 附「guidance 回填后下一拍决策成功」原始输出证据；五跑（新 run-id）候 owner 指令。不 push、不发版。
