# ATF 独立 Harness——L1a 门 2 修订 v2 条款级完成清单（开工前提交）

**日期**：2026-09-14 ｜ **执行方**：harness 侧会话（zcode，worktree `.worktrees/provider-config-v3`，分支 `work/20260914-provider-config-v3`）
**依据**：《ATF独立Harness_L1a门2修订任务书v2_provider配置对齐PiDSH_20260914.md》（§0 参照 / §1 七条规则 / §2 范围 / §3 VERIFY 九项 / §4 交付物）＋《ATF-Harness_Owner决议与指令_L1a门2验收_推送_20260914.md》§3/§4/§5
**性质**：任务书 §3 附加——开工前条款级完成清单（开工前已提交）；完成后已逐项 ✅ 并回填证据章节（指向《修订 v2 执行报告》）。

| # | 条款 | 来源 | 完成标准 | 状态 | 证据 |
|---|---|---|---|---|---|
| 1 | 唯一规范形态 = 两层清单（provider → models）；schema_version=`HarnessLlmConfig/v3`；旧"单 provider 扁平"读取路径**移除** | §1 规则 1 | 加载器只认两层形态；v1 扁平路径与断言删除/迁移 | ✅ | 报告 §1/§5 |
| 2 | 选择：`default_provider` 必填；`default_model` 省略取 `models[0]`（顺序即默认）；`ATF_LLM_PROVIDER`/`ATF_LLM_MODEL` 覆盖；未知 id fail-closed | §1 规则 2 | 三类正例 + 三类反例用例 | ✅ | 报告 §1 |
| 3 | 凭据只留引用：`api_key_env` 首选 / `api_key` 字面值仅过渡（文档标注不推荐）；并存拒绝；引用 env 缺失/为空拒绝；**配置与 fixture 内零明文** | §1 规则 3 | 用例 + 仓内扫描断言 | ✅ | 报告 §2 |
| 4 | provider 级 `compat`（可选）：`supports_developer_role` / `supports_reasoning_effort`，缺省按协议标准行为 | §1 规则 4 | `supports_reasoning_effort:false` → 不发送 reasoning 参数；`supports_developer_role:true` → developer 角色（缺省 system 不变） | ✅ | 报告 §3 |
| 5 | 模型级元数据：`reasoning`/`reasoning_effort`/`max_tokens`/`context_window` 按选中模型生效；`reasoning` 为真且对端返回思考块 → codec 剥离 | §1 规则 5 / 验收决议 §3 | 请求体断言（reasoning_effort/max_tokens per-model）；anthropic `thinking`/`redacted_thinking` 块剥离 | ✅ | 报告 §3 |
| 6 | fail-closed 校验：未知顶层/provider/模型键、缺 `protocol`/`base_url`/`models`、空 `models`、重复 `id`、`base_url` 内嵌凭据 → 结构化拒绝 | §1 规则 6 | 全反例用例 | ✅ | 报告 §4 |
| 7 | env 覆盖保留：`ATF_LLM_TIMEOUT_MS`/`MAX_RETRIES`/`MAX_CALLS_PER_RUN`/`REASONING_EFFORT`/`MAX_TOKENS` 作用于选中 provider/model；文件级旋钮（同名顶层键）可被 env 覆盖 | §1 规则 7 | 覆盖用例 | ✅ | 报告 §3/§5 |
| 8 | 装配点收敛：`httpProvider` 只取"选中 provider+model"，协议语义不变；providerId = provider 别名 | §2 | diff 范围核对 | ✅ | 报告 §7 |
| 9 | VERIFY 1 两层正例 | §3.1 | 多 provider × 多 model；default 生效；models[0] 兜底 | ✅ | 报告 §6 |
| 10 | VERIFY 2 选择 fail-closed | §3.2 | 未知 provider/model、缺 default_provider → 拒绝 | ✅ | 报告 §1/§6 |
| 11 | VERIFY 3 凭据引用 | §3.3 | env 解析正常；缺失/为空拒绝；并存拒绝；零明文断言 | ✅ | 报告 §2/§6 |
| 12 | VERIFY 4 compat | §3.4 | false → 不发送；缺省 → 发送 | ✅ | 报告 §3/§6 |
| 13 | VERIFY 5 模型元数据 | §3.5 | 按选中模型生效（请求体可断言） | ✅ | 报告 §3/§6 |
| 14 | VERIFY 6 校验 fail-closed | §3.6 | 全部拒绝 | ✅ | 报告 §4/§6 |
| 15 | VERIFY 7 迁移干净 | §3.7 | 仓内无扁平路径/断言；文档更新（含迁移说明） | ✅ | 报告 §5 |
| 16 | VERIFY 8 零回归：真对端 ≥329/1；mock ≥324/9；五冒烟全过 | §3.8 | 实跑数字入报告 | ✅ | 报告 §6 |
| 17 | VERIFY 9 闭环不变：`smoke:l1a` 挂起 75 与人放行闭环逐项不变 | §3.9 | 冒烟原始输出对比 | ✅ | 报告 §6 |
| 18 | 登记项（验收决议 §4）：悬空工具调用合成结果**首行显式标注 `[未执行：等待人工审批]`**（保留审批摘要） | 验收决议 §4 | codecWire 合成文本更新 + 用例 | ✅ | 报告 §6 |
| 19 | 交付：代码+测试 / 修订 v2 执行报告 / 配置形态与迁移说明 / 分支+worktree 合回删除 / 本地提交不 push | §4 | 清单核对 | ✅ | 报告 §9 |
| 20 | 推送（验收决议 §5）：复跑两轨＋五冒烟后 `git push`；累计 3（切片 2）+3（L1a）+1（本修订）笔；推后 `rev-list --count` = 0 | 验收决议 §5 | 推送记录 | ✅ | 报告 §9 |

## 惯例与登记项（预估偏离，实施中补充入报告）

- **配置文件为 v2 唯一来源**：两层结构无法经环境变量完整表达，`ATF_LLM_CONFIG` 指向文件为必需；v1 的纯 env 供形（`ATF_LLM_PROTOCOL`/`ATF_LLM_BASE_URL`/`ATF_LLM_API_KEY`）随扁平路径一并移除——`ATF_LLM_MODEL` 语义改为"模型 id 选择"（与 v1 字面模型名同形，冒烟/测试同步迁移）。
- **文件级旋钮**：`timeout_ms`/`max_retries`/`max_calls_per_run` 允许为可选顶层键（规则 7 env 覆盖的覆盖对象）；不在 §1 示例形态中，登记为补充。
- **codec 两处最小改动**（均为任务书条款直接要求，非顺手改）：① `reasoning_effort` 入参允许 null（compat 抑制时整体省略字段，VERIFY 4）；② anthropic 解析剥离 `thinking`/`redacted_thinking` 块（规则 5 剥离要求 + 验收决议 §3 三条实现要求之一）。
- **`reasoning` 元数据语义**：描述性元数据（经校验保留）＋ 剥离必要性开关；不改变请求体（reasoning 参数发送与否由 compat 决定——与 GPT-5.4 约束不冲突：抑制只发生在对端不认该参数时）。
- **悬空合成文本更新**（验收决议 §4 登记项）：首行 `[未执行：等待人工审批]`，审批摘要与"动作未发生"说明保留——codecWire 单点改动。
