# ATF-Harness 设计要点：R-3 接线批（工具面 7→9＋体检确认交互＋引导）— 2026-09-23

- **性质**：批 2 · R-3 接线（harness 侧）；owner 裁定《ATF_裁定_K2体检必经步化与K1闸门指引_20260923》§一.2。
- **基线**：main `6aef6a1`（走查修复小批后）；pin `v0.7.4b0` 不动；不 push。
- **补核（门 1 预承义务，已做）**：R-3 语义对码＝内核 stdio-session-contract §13.13/§13.14 实读＋`modules/label_qc.py` 实读；两待补件均已在内核侧落实——①`disposition×check_class` 组合闭集表（`label_qc.py:67-84`）②`evidence[].ref` 解析根＝workspace 根（§13.13 补件②）。冻结回执《ATF内核_会签回执_R-3三件冻结_20260921》（四组字段表）逐字段对码。

## 一、工具面 7→9（桥接方法面）

`TOOL_DEFINITIONS`（toolDefinition.ts）新增两员，插于 `atf_style_cluster_execute` 之后（契约 §序对齐）：

| 工具（模型面） | RPC（executor 显式映射） | 审批 | 定性 |
|---|---|---|---|
| `atf_label_qc_inspect` | `atf_label_qc.inspect` | **true** | 写动作：不可变报告＋逐项证据切片落登记面，直接改变准入前置状态（现 pin：pending>0 即整体阻断；K2 后无报告亦阻断）——与 `atf_style_cluster_execute` 落料同类 |
| `atf_label_qc_resolve` | `atf_label_qc.resolve` | **true** | 裁决落不可变累积产物＋run 级 journal 留痕＋owner tail 挂点写锚——写动作＋第二道人审天然必要 |

- schema＝冻结面转写：inspect `{dataset_id, pin?, qc_params?{iou_threshold?, bounds_tolerance?}}`；resolve `{dataset_id, pin?, actor, decided_at?, report_digest, decisions[]}`（decisions 项＝`{item_id, action: accept|reject|modify, disposition?（九项闭集枚举）, modified_value?, target_field?, target_candidate_id?, keep_ref?, reason_text?, evidence_ref?, judgements?}`）。closed-set 校验归内核（invalid_params fail-closed），harness schema 只做键声明与描述层指引（D-b 原则：不引入第二权威）。
- canonical_output（成功返回逐次校验）：inspect＝`{ok, dataset_id, pin, report_ref, report_file_sha256(HEX64), report_digest(^sha256:[0-9a-f]{64}$), counts(strict:false), human_summary(strict:false)}`；resolve＝`{ok, dataset_id, pin, resolved_count, pending_count, decisions_ref, decisions_sha256(HEX64), human_summary}`。digest 形态已对内核实读核（`report_digest`＝`sha256:` 前缀规范域 digest；file/decisions sha256＝裸 hex 字节摘要）。
- **MCP/ACP 不扩**：`MCP_TOOL_NAMES` 维持 8（K-Gap-2 两工具亦未入 MCP——既定口径：方法面镜像只落 TUI/桥接面）。TUI 注册表 11→13（createDefault 7→9＋工作区 4）。

## 二、裁定 B（Q2 多模态＝整图理解）harness 侧落点

- 工具描述明示：Q2 判断＝**整图理解**，内核**永不下发 `crop`**（`evidence[].kind` 枚举保留 crop 但恒不出现）；证据切片经 `image_workspace_ref` 衔接整图，**仅来源根在 workspace 内时给值**（外部根置 null——卡片如实显示「外部来源，无工作区引用」）。
- 卡片只展示 workspace 相对引用（文本形态），harness 不做任何裁切/缩放/图像处理；判断主体＝人（basis=`user`），harness 不代做 multimodal 判定、不内嵌视觉模型。
- 双面覆盖归属（内核契约判据 10）：审批交互＋Q2 整图多模态用例归本批。

## 三、确认交互（体检确认卡；载体＝批 2.5/批 3 同款）

**触发**：live `tool/result`（atf_label_qc_inspect，ok=true 且 `counts.pending>0`）→ turn 收口后出卡（`peer real` 模式且 wsRoot 可读报告时；否则降级一行提示——mock 轨无登记面文件，如实降级不造数）。

**卡数据（单源＝内核登记面）**：TUI 读 `<wsRoot>/<report_ref>`（workspace 相对，禁 `..` 越界——TCB 纪律：run 数据只读）；并防御性读 `label-qc-decisions.json` 剔除已裁决项（fail-open：读不到则全量展示，幂等冲突由内核 fail-closed 拦截）。`report_digest` 以 **inspect 返回值**为单源，与文件不符即不出卡（fail-honest）。

**卡面（依据/条款/出处展示）**：逐项列 `human_label`（检查类人读标签，报告自带）／出处 `locator`（样本·字段·页）／依据 `evidence[]`（kind+ref+digest12；Q2 附整图 `image_workspace_ref`）／Q2 候选对（candidate_id·值·框·来源·IoU）／内核建议 `suggested_action`（仅建议非裁决）。

**逐项处置（九项闭集×检查类约束）**：每项应答 `1=按建议（accept+hint，无建议不可选）｜2=维持原状（reject，≠剔除）｜3=自选处置（该检查类允许集内给出 disposition，必填附加字段逐项追问：dedupe→keep_ref、keep_first/keep_second→target_candidate_id（候选 A/B 选择）、keep_both/drop_both→reason_text、set_value→modified_value、fix_field→target_field）｜s=暂不处置`。**未决项（s）不进 decisions——绝不默认处置**（分批 partial：本次只提交已确认项）。

**确认后（A2.5 确认直填同构）**：确定性合成 `atf_label_qc_resolve`（`actor="tui-operator"`、`decided_at`=确认时刻 tz-aware ISO、`report_digest`=inspect 返回值、`decisions`=确认值逐字，模型不重生成参数）；下一 turn `continue.pendingAction` 派发；**审批弹窗第二道人审不变**（CAS 一次性）。Q2 项合成附 `judgements:[{item_id, basis:"user", reason_text:<备注或"用户裁决">}]`（内核要求 Q2 须附判断依据）。

**去重**：同 `dataset@pin|report_digest|已裁决数` 只出一次卡；部分裁决后再跑 inspect（幂等）→ 已裁决数变化 → 卡仅剩剩余项。

## 四、一键体检引导（blockGuidance）

- 补 `label_qc_required`（**K2 前瞻登记**：现 pin 不触发，内核启用后即命中）：指路 `atf_label_qc.inspect` 一键入口＋待确认项走确认卡；**勿遍历文件系统找报告**。isMaterialGap=false（模型可自 remediate：调工具）。
- 补 `label_qc_pending`（pin 现语义：报告存在且 pending>0 整体阻断）：指路逐项裁决、未决不默认、勿重复探查。isMaterialGap=true（需用户裁决——请示式缺口卡，同 `split_policy_missing` 构型）。
- skill 打通：actionLine 与系统提示层面指向 `atf-inspect-annotations`（批 3 装载面既有技能常驻 systemSuffix，无需新机制）。

## 五、审批文案（R1 D-4 映射延续）

`atf_label_qc_inspect`／`atf_label_qc_resolve` 各一条产品语言文案（含 dataset_id、项数、不改原始标注/未决保持等关键语义）；呈现层 only，不触 CAS 判定流。

## 六、测试与验收

1. 模型可见面 9 工具（definition.test 顺序断言扩至 9）＋审批矩阵（两新工具均 true）；契约 file test 工具面 7→9＋§13.13/13.14 补登断言。
2. executor 映射：两下划线工具名 → 点号方法（fake transport 断言 method 名）。
3. canonical：两方法成功形态过校验（kernel 形态样本）；未知键拒绝（strict 白名单）；resolve decisions 项闭集（action/disposition 枚举、judgements.basis 枚举）。
4. core labelQc：报告读取（越界 ref 拒绝、缺文件结构化失败）、已裁决集剔除、九项闭集×检查类表与内核逐字对齐、必填附加字段校验、Q2 无判断依据拒绝、未决项不默认（合成 params 只含显式确认项）。
5. ui 卡：卡面行含依据/出处/整图引用；处置应答解析（含追问流）；合成 params 字节级断言；确认文本。
6. blockGuidance：两码命中出指引（含「勿遍历文件系统」）。
7. 两口径全绿；pin 不动；**契约补登不 bump**（轴一 1／轴二 2 不变，K-Gap-2 同款口径）；内核仓零写入。

## 七、边界与红线

- 改动文件：`src/core/tools/toolDefinition.ts`／`executor.ts`／`approvalCopy.ts`／`src/core/run/blockGuidance.ts`／`src/core/workspace/labelQc.ts`（新）＋`index.ts` 出口／`src/ui/labelQcCard.ts`（新）／`src/ui/tui.ts`（接线）／`bridge.contract.yaml`（补登）／测试若干。
- runner.ts **零改动**（A2.5 pendingAction 机制既有，本批只消费）；工作区分册不扩（新模块只读登记面，无新工具）。
- 红线自检：TCB（卡片数据＝只读登记面，无权写）；审批 fails-closed（两工具均过账本轨，未决不默认）；内核仓零写入；零 npm 依赖；脱敏。
- 降级如实：mock 轨/无 wsRoot 时卡不出现（一行说明），登记面数据不可得即不造数。
