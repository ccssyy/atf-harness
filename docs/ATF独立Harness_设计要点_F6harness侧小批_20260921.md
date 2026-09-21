# ATF独立Harness｜F6 harness 侧小批《设计要点》（门 1 交付）— 2026-09-21

- **性质**：门 1 交付物（停等核验；门 2 放行后实施）。依据：《ATF-Harness_裁定落定_F6小批与双面覆盖与走查批次化_20260921.md》（sha256 `0de5fc0d…`）**仅 §二**（§一内核侧不在范围；跨仓引用仅为对齐基准）。本文件为 untracked 交付物，门 2 随批首提交入册。
- **基线**：main `548b67b`（含 D-f 批＋补正批）；pin `61631e6`（v0.7.2b0）不动；行号核自 main。

---

## 〇、范围与协调依赖（如实声明）

内核侧 §一 的返回形态**未冻结**（形态归内核侧门 1）。harness 侧设计原则＝**最大容忍＋不引入第二权威**：canonical 校验只保既有必填面，概览字段整体透传（深形态归内核）；渲染只产人读行、禁直出工程语。内核合回后若形态与假设有出入，harness 侧无需返工（tolerance 设计），登记段注记同步对齐即可。

## 一、① 透传与校验放宽（canonical_output 增可选概览，多返回字段不 fail-closed）

- **落点 1（方言）**：`src/core/tools/canonical.ts` `SchemaNode` 增 `strict?: boolean`（缺省 true＝「properties 即白名单」语义逐位不变；显式 `strict:false` 放开未声明键，已声明属性仍逐键校验）。与接线批分支 `fdf3555` 的同名扩展**同形同义**（该分支停等中，届时 rebase 零冲突或同文合并）；此为 harness 实现载体层，契约文件零 diff。
- **落点 2（状态面）**：`src/core/tools/toolDefinition.ts:270-289` `atf_workspace_status.canonical_output`——根节点增 `strict: false`（**内核多返回任何顶层字段不再 fail-closed**），既有 `required` 四键与 `scope_ref` 结构校验原样保留；properties 增两项可选透传位：`datasets`（array，items 为 `strict:false` 对象——对齐裁定形态「dataset_id＋pin（可多个）＋来源根相对形态摘要＋最近登记时间」，不逐键声明）＋`human_summary`（object，`strict:false`——内核双层报告若给则透传）。
- **落点 3（契约登记段补登，不 bump 双轴）**：`bridge.contract.yaml` `atf_workspace_status` 条目 result 增可选 `datasets`／`human_summary` 注记（「K-Gap 之外独立小批 F6 补登 2026-09-21；概览深形态归内核，harness 透传」）。

## 二、② 渲染：人读行呈现、禁直出工程语

- **落点**：`src/ui/eventView.ts:48-58` tool/result ok 分支——`payload.tool === "atf_workspace_status"` 时机器行改为 `ok=true atf_workspace_status 已登记 N 批`（N＝`admitted_count`），并经新增 detail-lines 通道（同批引入，与 D-f 补正批 detail-lines 同机制）输出人读行。
- **新纯函数 `statusOverviewLines(result): string[]`**（放 `src/ui/eventView.ts` 内，紧凑实现；接线批合入后可与 `humanSummary.ts` 统一——登记为合并点，防双机制漂移）：
  - 若 `result.human_summary` 在场：按其结论/分组/待确认字段产人读行（内核人读层直渲染——同「内核供语义、harness 供版式」分工）；
  - 否则按 `datasets[]` 产「已登记 N 批」＋逐批人读行（登记身份 `ds-<id>@<pin>`＋形态摘要＋登记时间——均为用户所需标识与人读文本）；
  - **禁直出工程语**：人读行内不做 64 位 digest／`X/v数字` schema 名／snake_case 工程码的拼装；实现一个与接线批 `engineeringLeak` 同判据的本地保守过滤（命中的行降级为中性提示）——接线批合入后合并为单一函数。
- **模型可见面零新增风险**：`result` 在 adapter（`adapter.ts:107-113` 补正批后）为已声明不透明字段，成功摘要＝`readableSummary(result)`——本批不改 adapter、无白名单新跳；§三 双面覆盖用例照做（下文四.4）。

## 三、③ 描述层指引（勿按示例猜路径）

- `src/core/tools/toolDefinition.ts:104-106`（`atf_admit_data` 描述尾）与 `:161-163`（`atf_data_admission_request` 描述尾）各补一句（裁定原文）：**「先按工作区状态（atf_workspace_status）确认来源根的实际形态，再据此取 `source_root`／`split_root`；勿按示例路径猜测。」**
- **guidance 文案修正（§二.6 活体复验新增）**：`src/core/run/blockGuidance.ts:82-90` `invalid_params` 条目 `actionLine` 尾追加裁定原句——**「亦可能是路径不存在或不可达——请先按工作区状态确认来源根实际形态，勿按示例路径猜测」**（四跑实测该码真实成因是目录不存在，旧文案把模型推向"改形态"）；`meaning` 同步补「（亦含来源根路径不存在/不可达）」。用例断言该句存在（下文四.3）。

## 四、④ 用例（走双面＋§三 投影路径硬要求）

1. **canonical 两态（mock 旗标 `--ws-overview`，缺省关＝474|12 基线零回归）**：`tests/fixtures/mock_atf.mjs:415` `toolWorkspaceStatus` 增概览仿真（datasets 形态摘要＋human_summary 双层）——带概览／不带概览两态 canonical 校验均过（executor 链路级）。
2. **渲染断言**：`eventView` 对两态的行——概览态含「已登记 N 批」与逐批人读行；两态均断言无 64 位 digest／schema 名／snake_case 工程码直出。
3. **guidance 断言**：`blockGuidance` 的 `invalid_params` 一行文案含「路径不存在或不可达」与「勿按示例路径猜测」；并过既有回流链（`guidanceLineFor`）。
4. **§三 双面覆盖（http 投影路径，`FakeLlmEndpoint`＋`HttpLlmProvider`）**：模型面首拍调 `atf_workspace_status`（mock 带概览）→ canonical 透传 → 回流 → **下一拍 decide 成功**（投影无 err）；断言投影摘要含概览片段、无工程码泄漏。落位 `tests/run/f6StatusFace.test.ts`。
5. **描述层断言**：两工具 description 含「勿按示例路径猜测」。

## 五、约束与验收口径

- 契约零 diff（**除登记段补登**）；`schema.ts` 零改；pin 不动；改动面＝`canonical.ts`（方言旗标）＋`toolDefinition.ts`（canonical/描述）＋`blockGuidance.ts`（一句文案）＋`eventView.ts`（渲染）＋mock＋测试＋契约登记注记；**不动 runner.ts／adapter.ts**。
- 验收：typecheck OK；mock 两口径并列报数（基线 `482|12` 不设 CLI／`489|1` 设 CLI）；新增用例全过；**不 push／不发版**；真内核 e2e 待内核 §一 合回＋re-pin 后补（届时核对真实概览形态与登记注记逐条对齐）。
- 走查批次化衔接：五跑建议本批与内核 §一 合回后进行（否则必然重复撞"模型猜路径"）。

---

**停等核验**。门 2 放行后实施；单批提交 → 合入 main（零契约面除登记补登）→ 交复核。
