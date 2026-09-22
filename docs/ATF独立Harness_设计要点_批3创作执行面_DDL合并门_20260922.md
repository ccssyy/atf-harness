# ATF-Harness 批 3「创作执行面」设计要点（DDL 合并门·门 1 交付随批）— 2026-09-22

- **依据**：批 3 指令（sha256 `beadbec1…`，§〇 代码级事实全数实核复认）；owner 20:42 两裁决。
- **DDL 模式**：门 1+门 2 合并，本文件随实施批提交；**runner 解冻请求（单点、逐区枚举）**：① `RunBranchOptions` 增可选 `toolFace` 注入 seam；② executor 构造行改为消费该 seam——缺省不注入＝`ToolRegistry.createDefault()`＋无本地分派，既有行为逐位不变。其余改动收敛在 `tools/executor.ts`（本地工具分支）、`tools/registry.ts`（`createWithWorkspaceTools` 扩面构造器）、`ui/tui.ts`＋`cli/resume.ts`（装配）与新模块；MCP/ACP 零改动（仍 7 工具注册表）。
- **新建模块**：`src/core/workspace/scratchExec.ts`（受控执行引擎）、`src/core/workspace/skillCatalog.ts`（SKILL.md 清单/全文）、`src/core/tools/workspaceTools.ts`（四工具定义＋本地 handler）、`src/ui/launchCard.ts`（启动确认卡）。

## 一、模型面四工具（§一 两创作工具 ＋ §二/§三 各一机制工具）

| 工具 | params（模型可见） | 审批 | canonical output（成功） |
|---|---|---|---|
| `atf_scratch_write` | `path`（scratch 相对路径）＋`content`（≤1 MiB） | **免审批**（T0 自由区即免审写入；路径/体量守卫兜底） | `{ok, path, bytes, sha256}` |
| `atf_scratch_exec` | `argv`（1–32 个非空 string）＋`timeout_seconds?`（1–3600，缺省 120） | **需审批**（执行类默认审批——指令建议口径） | `{ok, exit_code?, timed_out, stdout, stdout_truncated, stderr_tail, duration_ms, launch_ready?}` |
| `atf_skill_read` | `skill?`（缺省=清单）＋`file?`（references 内文件） | 免审批（纯读） | `{ok, skills?/\{skill, body, references\}}` |
| `atf_launch_execute` | `launch_sh`（scratch 相对路径）＋`config?`（IterationConfig 相对路径）＋`note?` | **需审批**（放行＝CAS 一次性消费） | `{ok, release_recorded, release_result, state, launcher_count, effect_started, pid, log_path, timed_out}` |

- **INV-D 关系**：`LlmDecision` 闭集零改动——模型发 `tool_call{name, params JSON}`（argv 是参数不是脚本指令类型），工作区动作全部在 harness 侧本地 handler 执行；脚本专用步骤类型（scratch_write/promote/cite_t0）仍为脚本轨独占，**既有脚本轨零改动、两轨并存**（指令建议口径）。
- **沙箱**（scratch_exec）：cwd=scratch；env 白名单＝`PATH`(解析出的 python3 目录＋固定最小集)+`HOME`(对端隔离 home)+`ATF_WORKSPACE_ROOT`+`ATF_SKILLS_AUTO_INSTALL=0`+`PYTHONPATH=<内核>/src`(pin 唯一真相源；skills scripts 自注入 parents[3]/src 与此同值，双保险)+`PYTHONUTF8/LANG`+`TMPDIR=<scratch>/.tmp`＋宿主 `ATF_*` 透传——**排除 `ATF_LLM_*`（凭据不进子进程；对指令「既有 ATF_* 变量」的脱敏红线修正，如实标注）**＋具名例外 `LD_LIBRARY_PATH`（实核发现：本机 python3 经它加载 libpython，属「python3 解释器路径」注入面的运行时依赖；`LD_PRELOAD` 等其余注入向量一律不透传）；argv[0] 白名单＝python3 解释器／`<内核>/skills/**` 内 .py／scratch 内 .py——**放行执行统一经解析出的 python3 解释器 spawn（无 shell、无第二二进制入口）**，launch.sh/train.sh 不是合法 argv[0]（harness 专执行点）；stdout 16 KiB／stderr tail 8 KiB 上限（超限截断＋知情尾标）；超时 SIGTERM。OS 级硬隔离不可得（零 npm 依赖），以「argv 白名单＋env 定向＋cwd/TMPDIR 归 scratch＋上限」为如实边界声明。
- **产物只经晋升闸 A**：exec 产物落 T0 scratch；本批**不**加模型面 promote（指令最小集 2 工具）；T0 不可引用为证据（ADR-08）由会话守卫继续兜底。模型面 promote 登记 backlog。

## 二、skills 装载（§二，Pi lazy 模式）

- **清单常驻**：`SkillCatalog` 读 `<内核>/skills/*/SKILL.md` frontmatter（name+description）；经 `HttpLlmProviderOptions.systemSuffix` 追加在 `HARNESS_SYSTEM_PROMPT` 之后——每技能一行＋一行使用指引（「用 atf_skill_read 读全文、用 atf_scratch_exec 跑 scripts」）。TUI/resume 接线；**MCP/ACP 本批不动**（仍 7 工具注册表，登记边界）。
- **按需读全文**：`atf_skill_read`——无参=清单（同常驻源）；`skill`=SKILL.md 全文＋references 文件列表；`skill+file`=读 reference（路径守卫 skill 目录内、256 KiB 上限）。执行链闭环：读 SKILL.md → `atf_scratch_write` 写 IterationConfig 等输入 → `atf_scratch_exec` 跑 scripts（python+PYTHONPATH，scripts 自注入 `parents[3]/src`＝pin，双保险）。

## 三、G5 后受控执行（§三，owner 裁决②）

1. **检测（确定性，harness 侧）**：scratch_exec 成功后扫 scratch（深度≤5、跳 `.` 目录）找 `launch.sh`；命中→result 附 `launch_ready{launch_sh, run_id, iteration_config_sha256, global_batch, nnodes, config?}`；config＝scratch 内 `IterationConfig/v1` 文件**字节级 sha256 对拍** manifest 的 `iteration_config_sha256`（对不上不给，fail-honest）。
2. **确认卡**（turn 收口后，载体同批 2.5）：人读中文卡＝训练计划摘要＋「是否登记放行并执行 launch.sh？」；应答 1=确认 → A2.5 既有 `pendingAction` 机制确定性合成 `atf_launch_execute`（模型不重生成参数）→ **审批弹窗第二道人审**（CAS 一次性消费不变）。
3. **执行序（local handler）**：① 带 config 时 harness 执行 `generate_train_launch.py --record-training-release --config <abs>`（放行记录落内核账本 `~/.atf/approval-ledger/training-release.jsonl`——**harness 代执行、以用户卡确认为前提，agent 永不代签**）；② 执行 `launch.sh`（cwd=launch 目录、同 env 白名单、stdout/stderr 落 `harness-launch-<ts>.log`、等待至 `wait_seconds` 缺省 120s——**未退出不杀**，转 `{status:"running", pid, log_path}` 后台跟踪）；③ 读 `state.json` 回填（waiting_for_start／已启动／launcher_count／effect_started）。
4. **长任务／失败续接**：`state.json`（内核语义）＝跟踪面，agent 经 scratch_exec 读状态与日志；run 事实＝tool/call+tool/result 事件流（已启动/进行中/结束）；再执行＝再确认＋再放行（CAS 一次性），launch.sh 幂等语义（RUN_TOKEN/ownership）归内核。

## 四、测试与红线自检（详见执行报告）

- 新用例：写越界（`..`/绝对/越出 scratch）拒绝；argv[0] 白名单外拒绝；超时；stdout 上限截断；env 白名单（凭据不出现）；执行审批链（headless 无预录=exit 78；预录=CAS 消费放行）；skills 清单进 systemSuffix＋按需全文；G5 检测→卡→确认→放行记录→state 回填；两口径全绿。
- 红线：INV-A/B/C/D 不破（事件类型/schema.ts 零改；一次决策一工具、turn 不跨进程不变；模型面无脚本指令类型）；TCB（agent 无签闸面；晋升闸无模型面入口）；契约零 diff（四工具皆 harness 本地、不占桥接方法面）；pin v0.7.4b0 不动；runner.ts 零改动。
