# 批⑱-M0 PoC 评估记录：DSH 集成（迁移风险验证点）

- 日期：2026-09-30 ｜ 执行：zcode ｜ 指令：a6e80571
- 锁 commit：`639ed015397290b3745d163aafe02ffee4aa3f84`（dsh 0.2.0-rc.2，见 vendor/dsh/LOCK.md）
- 运行实例：`http://127.0.0.1:3080/?token=ZkFlPkgYz-OiRi4dMBUKyxePRlaUE4_AV-78l04Q3lE`（DSH_HOME=poc/dsh-home；重跑：`cd vendor/dsh/deepseek-harness && source /root/.atf-harness/.env && DSH_HOME=<repo>/poc/dsh-home corepack pnpm dsh web --no-open`）

## 一、GLM 接入路径（结论：pi-ai seam 直连，零适配层）

- **走的路径**：`llm-pi-ai` adapter 的自定义 provider 路由——`poc/dsh-home/profiles/web/cordis.patch.yml` 声明 route `glm-atf`（`apiKeyEnv: ATF_LLM_KEY_GLM`＋`api: openai-completions`＋`baseURL: https://open.bigmodel.cn/api/coding/paas/v4`＋models glm-5.3-flash/glm-5.3）。key 由启动前 `source /root/.atf-harness/.env` 注入进程 env——DSH credentials 语义"inherited environment 优先"，**key 零落盘**（红线达成，未触碰 $DSH_HOME/.credentials.yaml）。
- **备而未用的路径**：DSH 内置 provider 目录已含 `zai`（GLM）——设置页 Add model provider 即可，但其 key 落 .credentials.yaml，与 ATF env-only 纪律冲突，故弃。
- **卡点**：无。patch 热生效（模型清单即出现"GLM（ATF 授权线）"分组）；Web UI 里选定模型即存为会话默认（写 profile 运行时快照 `cordis.yml`，与手写 `cordis.patch.yml` 叠加读取、后者为基线）。
- **架构事实复核**：DSH llm-pi-ai 与 ATF 同依赖 `@earendil-works/pi-ai ^0.87.1`——provider 语义完全同源，门 1' 设计判断证实。

## 二、开箱能力清单（实测逐项）

| 能力 | 状态 | 证据 |
|---|---|---|
| Web UI 三栏/对话流 | ✅ 开箱 | 左栏 Workspaces/会话列表＋中栏对话＋右栏（可折叠）；原生形态见截图 |
| GLM 流式对话 | ✅ 实测 2 轮 | 轮 1（glm-5.3-flash，32s，46 tok/s，12.1K tok）；轮 2（glm-5.3，2s，75 tok/s，cache hit 53%） |
| 思考流渲染 | ✅ 开箱 | glm-5.3 回复出现"Completed in 2s"折叠条，展开＝"Analysis completed"（reasoning 折叠呈现；短题思考极短故仅标题）；flash（reasoning=false）无折叠条不伪造——与 ATF 批⑯prime 降级语义同构 |
| 会话持久化 | ✅ 开箱 | 刷新后侧栏会话在（带 1min/3min 相对时间）；落盘 $DSH_HOME（SQLite 系，门 1' 判断一致） |
| 设置页框架 | ✅ 开箱 | General（Permission/Language/Appearance/Work details/快捷键/Send behavior…）＋Models＋Built-in plugins＋Agent presets＋Open configuration file 直达 cordis.patch.yml |
| 审批面板 ui-approval | ✅ 默认激活（未触发） | dsh-base 组合 `approval: policy=ask`＋permission presets（read-only/workspace-write/danger-full-access）；web-app 组合含 ui-approval 行。PoC 两轮纯对话无工具调用故未出卡——**工具触发路径留 M1 冒烟** |
| URL token 鉴权 | ✅ 开箱 | 启动即发 `?token=…`，无 token 拒绝 |
| 会话自动标题 | ✅ 开箱 | session-title-llm（首轮 prompt 生成，CJK 目标字数配置在位） |
| Trajectory 事件审计 | ✅ 开箱 | SYSTEM/USER/CONTEXT/ASSISTANT 逐事件＋Duration/Turns/Calls 时间轴＋全文搜索 |
| **技能自动发现** | ✅ 意外之喜 | skill 插件扫描宿主 `/root/.agents/skills`，`available_skills` 注入 system prompt——GLM 首轮即"看见" atf-* 15 个技能并列述。**M1/M2 技能面迁移≈零成本** |
| Usage/token 计量 | ✅ 开箱 | 每条回复 Usage 行＋底部状态条（tok/s、cache hit、上下文百分比） |

## 三、工具扩展点初探（M1 探路，只定位未实现）

1. **工具插件协议**（`packages/fs/tool-fs` 为范本）：Cordis 插件四件套——`export const name`／`inject = ['tools','fs','systemPrompt']`（service-availability 驱动）／schemastery `Config`／`apply(ctx, config)`；工具本体 `defineTool({ name, description, parameters(JSON-Schema), output:{schema, render, presentationMeta}, isConcurrencySafe, execute(args, exec) })`，注册进 `ctx.tools` 经 system-prompt 组装给模型。
2. **执行管线**（docs/tool-execution-pipeline.md，自动生成且 verify 锁新鲜）：tool/call 落事件 → pre-execute 瀑布（hooks/permission/**ctx.approval 一次性 prompt**/sandbox）→ 单调 guards → around（timeout/retry/metrics）→ execute 体 → post-execute → finalize → tool/result 事件 → UI 卡两段式（presentCall/presentResult）。**ATF 双轨审批的映射点＝pre-execute 的 ctx.approval seam**（M2 活）。
3. **atf_* 9 工具迁移形态**：execute 体可自由 spawn 子进程（tool-bash 先例）——现 9 工具的 JSONL 桥调用（spawn atf CLI）可整体封装为一个 tool 插件族；**M1 设计决策点＝桥连接生命周期**（每调用 spawn 短连接 vs 插件级长驻连接）。GPU 排队语义迁 `ctx.jobs`（job registry＋job_* 工具现成）或 `ctx.schedule`（cron/定时语义现成）。
4. **文档/测试基建**：tool-catalog / config-catalog / capability-seams 全自动生成（`pnpm run gen-tool-catalog` 校验每个 `packages/*/tool-*` 有文档），vitest 4 在仓——新工具插件不写目录页会 fail doc-sync，工具测试有仓内先例。

## 四、M1 工作量复核（原估 2 天：维持，构成修正）

- **维持 2 天**。向下因素：defineTool 模板清晰（首工具学习成本低于预估）；技能面零成本（原以为要迁）；config/测试/文档基建全现成。
- 向上因素（新增）：① 桥连接生命周期设计＋连接池健壮性（Result 语义桥接到 tool result 的 error 归一）② `output.presentationMeta` 语义（UI 卡重放依赖它，9 工具的产物卡要逐个定）③ doc-sync 硬约束（每个工具包要配目录页）。
- 构成修正：协议适配 ↓（约 0.5 天）／桥接封装与生命周期 ↑（约 0.75 天）／冒烟与 doc-sync 收尾 ↑（约 0.75 天）。
- 风险转记：DSH developer preview 破坏性变更——M1 期间若上游发 0.3.0，锁 commit 隔离（LOCK.md 纪律）可保 M1 不受阻，但 re-lock 需评估批。

## 五、红线核验

- 零真实训练 ✓（两轮纯对话；无工具执行）
- vendor 源码零改动 ✓（仅外层：poc/dsh-home 配置与 .gitignore；DSH 树内无 diff——嵌套 .git 已除，无法改亦无改）
- 手搓版 8899 常驻不动 ✓（全程未触碰；8648 为批⑰临时验证实例，已停）
- GLM ≤10 calls ✓（实测 4 calls＝2 主对话＋2 标题生成）
