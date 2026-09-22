# ATF独立Harness_批3执行报告_创作执行面_DDL关键路径_20260922

- **批次**：批 3「创作执行面」（DDL 关键路径·门 1+门 2 合并）；分支 `work/20260922-b3-creative-exec`（基线 main `9b1f79d`），单批 `--no-ff` 合入。
- **设计要点**：《ATF独立Harness_设计要点_批3创作执行面_DDL合并门_20260922.md》（同批入库）。
- **内核仓零写入；不 push 不发版；pin `v0.7.4b0` 未动。**

## 一、改动文件清单

**新增（4 源＋4 测试＋1 设计文档）**
- `src/core/workspace/scratchExec.ts`——受控执行引擎：env 白名单构造／argv[0] 白名单（统一经 python3 解释器 spawn）／stdout·stderr 上限与超时／G5 就绪检测（launch.sh→TRAIN_DIR→launch_manifest→IterationConfig sha256 对拍）／launch.sh 执行件（bash spawn、日志落盘、未退出不杀转后台）。
- `src/core/workspace/skillCatalog.ts`——SKILL.md frontmatter 清单（一行/技能）＋全文/附属文件按需读（路径守卫技能目录内）＋systemSuffix 文本。
- `src/core/tools/workspaceTools.ts`——四工具定义（模型面 schema＋canonical）与本地 handler：`atf_scratch_write`／`atf_scratch_exec`／`atf_skill_read`／`atf_launch_execute`（放行记录→launch.sh→state 回填三段）。
- `src/ui/launchCard.ts`——训练启动确认卡（卡面摘要／harness 译码确认文本／A2.5 同构合成）。
- `tests/workspace/scratchTools.test.ts`（7）／`tests/run/workspaceToolsRunner.test.ts`（5）／`tests/ui/launchCard.test.ts`（2）／`tests/llm/systemSuffix.test.ts`（1）。

**修改（11 文件，＋304/−11）**
- `src/core/run/runner.ts`（**解冻请求·唯一 runner 改动**，见 §三①）：`RunBranchOptions.toolFace?` 注入 seam＋executor 构造一行消费。
- `src/core/tools/executor.ts`——本地工具分派分支（审批闸后、桥接前；canonical 校验同桥接径）；4th 可选构造参。
- `src/core/tools/registry.ts`——`createWithWorkspaceTools()`（default＋4 工作区工具；default 注册表不变）。
- `src/core/tools/index.ts`／`src/core/workspace/index.ts`——出口补登。
- `src/llm/httpProvider.ts`——`systemSuffix?`（技能清单常驻，追加系统提示后；缺省逐字节不变）。
- `src/core/run/blockGuidance.ts`——五个本地拒绝码 guidance（argv0_not_allowed／path_escape／content_too_large／skills_root_missing／launch_config_mismatch）。
- `src/core/tools/approvalCopy.ts`——scratch_exec／launch_execute 审批弹窗人读文案。
- `src/ui/completedSummary.ts`——四工具产品名＋launch/技能产物行＋训练已启动的评估→badcase 交接指引（§四）。
- `src/ui/tui.ts`——工作区工具面装配（内核目录可解析即启用）＋provider tools 11 面＋systemSuffix＋G5 检测挂点（onEvent）＋启动确认卡块（同一目标只出一次）＋mock 模式 exec-home 清理。
- `src/cli/resume.ts`——同构装配（挂起应答续跑同样具备工作区工具面）。

## 二、验收结果

- **typecheck**：`tsc` 两 tsconfig 零错误。
- **两口径全绿**：口径①（不设 `ATF_CLI_PATH`）**572 passed / 13 skipped**；口径②（`ATF_CLI_PATH=<repo>/.atf-pinned`）**579 passed / 1 skipped**（批 2.5 基线 557/564，净增即本批新用例）。
- **三冒烟通过**：`smoke:l1ui`／`smoke:l1acp`／`smoke:l1mcp` 全绿（MCP/ACP 面 7 工具行为零变化）。
- **新用例覆盖（§五 对应）**：写越界/绝对路径/超限拒绝；argv 白名单（python3·pin 内 .py·scratch .py 放行，shell 与 scratch 外拒绝）；超时 `timed_out`；stdout 16 KiB 截断标注；env 白名单（`ATF_LLM_*` 凭据不出现、宿主任意 env 不继承、PYTHONPATH/TMPDIR/HOME 定向）；执行类审批链（无预录无问答轨＝exit 78 fail-closed；账本预录＝CAS 消费放行）；技能清单一行/技能＋全文读取＋附属文件路径守卫；systemSuffix 注入与缺省逐字节不变；G5 检测（TRAIN_DIR→manifest→sha256 对拍命中 config／对不上不给）；`atf_launch_execute` 全链（放行记录落内核账本径→launch.sh 执行→state.json 回填→tool/call+tool/result 落账）＋sha 对拍不一致拒（不放行不登记）。

## 三、偏离规范之处（逐项，待 owner 裁可）

1. **runner 解冻（逐区枚举）**：仅两处——① `RunBranchOptions` 增可选 `toolFace` 字段（约 +8 行）；② executor 构造行改为 `options.toolFace?.registry ?? ToolRegistry.createDefault()`（1 行）。缺省不注入＝既有行为逐位不变（`createDefault`＋无本地分派）。选 seam 而非全局可变注册表：与既有 `modelProvider`／`budgets` 注入缝同构，收敛面最小。
2. **env 透传两处修正**（对指令 §一「既有 ATF_* 变量」的字面）：① `ATF_LLM_*` 一律排除（凭据不进子进程——脱敏红线优先于字面）；② 具名例外 `LD_LIBRARY_PATH` 透传（实核：本机 python3 缺它不能加载 libpython，exit 127；属「python3 解释器路径」的运行时依赖）。`LD_PRELOAD` 等其余注入向量不透传。
3. **本地 handler 终态无 `failed`**：环境缺口（解释器缺失、skills 根缺失、IO 错误）一律折算 `rejected` 结构化回填（模型可如实转述）——`failed` 在 runner 语义中是 run 终局，用于本地工具会把可转述的环境问题放大成终局；harness 内部缺陷（canonical 违规，构造上不可达）仍折 `failed`。
4. **执行类审批疲劳**：`atf_scratch_exec` 每次 call 均须审批（指令建议口径，未做会话内批量授权）；走查若嫌重，owner 可裁定降级策略（如只对 `atf_launch_execute` 强制），本批未自行放宽。
5. **跨会话边界（如实标注）**：peer-real 模式下 exec/launch 的 HOME＝TUI 隔离 home（内核配置根＋training-release 账本落点）——TUI 退出即清。跨 TUI 会话重启后放行账本不延续，恢复路径＝重新确认→重新登记放行（`--record-training-release` 幂等可重放）；内核 run 树（ws-root）持久不受影响。

## 四、范围×红线交叉自检（§六，必附）

| 红线 | 本批触点 | 结论 |
|---|---|---|
| INV-A（状态只落本侧） | 会话事件 schema/类型零改（12 类不变）；工具事件照旧落 append-only 流 | 不破 |
| INV-B（一次决策一工具） | 本地工具走 executor 同一管线（含审批检查点），每次调用独立审批/CAS | 不破 |
| INV-C（turn 不跨进程） | 未触及 turn 边界机制 | 不破 |
| INV-D（模型面不含脚本指令） | `LlmDecision` 闭集零改；模型发 `tool_call{argv JSON}`（参数非指令类型），工作区动作全在 harness 本地 handler 执行；脚本专用步骤轨零改动、两轨并存 | 不破 |
| TCB：agent 代码不进 TCB、无权签闸 | 放行记录（`--record-training-release`）由 harness 在用户确认卡后执行，模型面无签闸工具；晋升闸 A 无新模型面入口（本批无 promote 工具，登记 backlog）；产物只落 T0 scratch，T0 不可引用为证据（ADR-08）由会话守卫继续兜底 | 不破 |
| 沙箱最小权限 | scratch 限写：path 守卫＋cwd/TMPDIR/HOME 定向＋argv[0] 白名单（无 shell 入口）；run 数据只读：exec 不触 artifacts/contracts 写面（OS 级硬隔离不可得，已如实声明边界） | 实用达成（边界声明） |
| `schema.ts` 最小改动 | 零 diff | 达成 |
| 契约零 diff | `bridge.contract.yaml` 零 diff（四工具皆 harness 本地、不占桥接方法面；default 注册表 7 工具不变，MCP/ACP 零风险） | 达成 |
| pin v0.7.4b0 不动 | 未触 pin；contract tests 口径②全绿 | 达成 |
| 不 push 不发版 | 未 push、未打 tag | 达成 |

## 五、下一步建议

1. **owner 走查**（DDL 硬终点）：按《ATF-Harness_走查单_DDL全流程_20260922.md》执行——跳 6 检查点若不通，优先查 `atf_scratch_exec` 返回的 `stderr_tail`（PYTHONPATH/env 注入形态已在返回体可见）；跳 7 确认卡→审批弹窗为两道人审（与批 2.5 口径一致）。
2. 走查中的审批频次体感如过重，可裁「scratch_exec 会话级批量授权」方案（需新的授权语义，另走变更单）。
3. backlog 登记：模型面 promote 工具（T0→T1 晋升的模型入口）；MCP/ACP 面的工作区工具扩面；skills 全文压缩读（>窗口窗口时的分段）。
