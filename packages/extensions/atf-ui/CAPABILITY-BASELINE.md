# atf-ui 能力面基线（G4 施工登记）

本文件是 atf-ui **现有能力面**的登记件：注册了哪些 HTTP 路由、注入了哪些 slots、client 半读哪些数据源。
用途是后续集成与验收的比对基线——改本表内容＝改产品行为面，须与代码同步修订。

以码为源：`src/server.ts`（服务端半）、`client.js`（client 半）、`src/snapshot.js`（投影纯函数）。

## 1. HTTP 路由（8 条，全部经 vendor `webServer.register`）

atf-ui **没有自建 HTTP server**：所有路由都是 `ctx.webServer.register(...)` 注册到 vendor 的
`WebServer` 服务上（`packages/host/webserver`），鉴权一律复用 vendor 的
`ctx.connection.requestRejection(req)` 信任面——不自造鉴权。

| # | 路径 | kind | handler 位置 | 职责 | vendor 对应物 |
|---|---|---|---|---|---|
| 1 | `/atf-ui/viewer` | prefix | `viewerRouteHandler` @1481 | run 产物 viewer 静态服务（iframe 内嵌，同源 cookie 鉴权） | 无（ATF 产物目录布局专属） |
| 2 | `/atf-ui/snapshot` | exact | apply 内联 @2758 | `monitor.json` ＋ `artifacts.json` 双 JSON 一下发＋`eventlog` 降级态 | 无（vendor `workspaceFiles.read` 语义不同，见 §4） |
| 3 | `/atf-ui/workspaces` | exact | apply 内联 @2787 | 工作区注册表清单＋path 目录在位探测（只读） | 无（vendor `workspaceController` 无 list 型只读方法） |
| 4 | `/atf-ui/events` | prefix | `eventsRouteHandler` @2452 | SSE 事件流：monitor 增量＋`Last-Event-ID` 回放 | 无（vendor 无 SSE 端点，见 §4） |
| 5 | `/atf-ui/settings` | exact | apply 内联 @2854 | 设置面 GET/POST（storage 四键＋`effort_defaults`） | `settingsController`（域不同，见 §4） |
| 6 | `/atf-ui/gpu-history` | exact | apply 内联 @2956 | GPU 历史按天 jsonl 尾窗读取＋降采样 | 无（vendor 全仓零 `nvidia-smi`／GPU 采集） |
| 7 | `/atf-ui/run-file` | exact | apply 内联 @2994 | run 产物只读（白名单扩展名＋realpath 越界拒） | 无（产物目录布局专属，鉴权/穿越防护已复用 vendor 信任面） |
| 8 | `/atf-ui/session-binding` | exact | `sessionBindingRouteHandler` @2553 | 会话↔Run 绑定读写 | 无（ATF 会话与 run 对应关系专属） |

**结论**：8 条全部是 `/atf-ui/*` 专属路径（或 `VIEWER_ROUTE_PREFIX`），vendor 无同路径同语义承接物。

## 2. Slots 注入（10 个槽位，13 处 register）

| # | 槽位 | 形态 | 注入内容 |
|---|---|---|---|
| 1 | `conversation.session.header.utilities` | list（id `atf-monitor-pill`，order 900） | 「监控」开关 pill ＋ 会话绑定 chip（sessionId 捕获点） |
| 2 | `sidebar.right.pane.tab` | keyed（key `@atf/dsh-atf-ui`） | 训练监控面板 `MonitorBody`（右栏原生 tab） |
| 3 | `conversation.composer.dock` | list（id `atf-dock-row`，order 100） | 悬浮任务卡／评估通知栈／丢失工作区横幅／快捷胶囊行／viewer 浮层／训练对话框／联合训练对话框 |
| 4 | `conversation.input.right` | list（id `atf-effort-select`，order 100） | 思考档位快切 `EffortSelect`（与原生模型选择同源目录） |
| 5 | `settings.models.provider-card` | keyed（key `llm-pi-ai`） | per-model 默认思考档下拉 |
| 6 | `settings.section` | list（id `atf-training-config`，order 900） | 「训练配置」原生设置页 |
| 7-8 | `sidebar.brand.mark` ＋ `sidebar.brand.name` | 嵌套 inject，各 1 处 register | 侧栏品牌位 |
| 9 | `conversation.hero.brand.mark` | 单值 | 空态 hero 鱼标位 |
| 10 | `shell.overlay` | list（id `atf-draft-resume`，order 900） | 草稿态「回到上次实验」卡＋业务通报条 |

附属注册：`ctx.sidebarRightTabs.register`（kind `atf-training-monitor`，patterns
`dsh-resource://atf-training-monitor/**`）——右栏 tab 类型声明，是 #2 的配套面。

**结论**：10 个槽位全部是「新增能力型」注入（新 pill／新 tab／新设置页／新卡面），
符合 vendor 扩展模型的「只允许追加」边界，无一例试图覆盖 vendor 已有行为。

## 3. client 半读取面（11 个 fetch ＋ 1 条 EventSource）

| 数据源 | 调用点 | 用途 |
|---|---|---|
| `GET /atf-ui/settings` | L67、L1530 | `effort_defaults` 预取／设置页回读 |
| `POST /atf-ui/settings` | L79、L1571 | 保存思考档默认值／保存存储设置 |
| `GET /atf-ui/session-binding?sessionId=` | L170 | 绑定 chip 查询 |
| `POST /atf-ui/session-binding` | L192 | 绑定／解绑／改名 |
| `DELETE /atf-ui/session-binding` | L223 | 解除绑定 |
| `EventSource /atf-ui/events` | L392 | monitor 增量（`snapshot`/`gpu`/`gpu_all`/`runs` 四事件） |
| `GET /atf-ui/snapshot` | L413 | 快照轮询（5s 兜底 + 首帧） |
| `GET /atf-ui/gpu-history?minutes&maxPoints` | L762 | GPU 曲线历史点 |
| `GET /atf-ui/workspaces` | L2220 | 丢失工作区横幅（30s 轮询） |

**数据源拓扑**：SSE 是**增量推送主通路**，快照轮询是**兜底通路**（`EventSource` 不可用／断连时降级
不降功能）——两条不是冗余，是同一份 `monitor` 数据的两条传输路径，合并同一 `setData` 渲染。

**client 半零盘读取**：全部数据经 server 半投影后下发；client 不直接读 `monitor.json`。
（原文件头注释称「`workspaceFiles.read` 轮询 monitor.json」，与实现及同文件 L410 注矛盾，本轮已更正。）

## 4. 与 vendor 的重复性判定

判定判据＝「vendor 有等价实现」。逐项：

| atf-ui 能力 | vendor 现状实测 | 判定 |
|---|---|---|
| 路由注册机制 | `webServer.register` 即 vendor 服务 | **已复用**（非自建） |
| 路由鉴权 | `connection.requestRejection` 即 vendor 信任面 | **已复用**（非自造） |
| SSE 事件流 | 全仓无 SSE 端点；`client-hmr` 有一条 `/plugins/events` 但为 HMR 图推送专用，`sseData` 未导出、帧类型是 `PluginsEventFrame` 闭集 | **不重复**（问题域不同，见下） |
| Remote 事件推送 | `typertGateway.registerRemoteEvents` 是**单例独占**（重复注册直接 throw），已由 `packages/api/remotes` 占用；转发白名单 `API_REMOTE_FORWARDED_EVENTS` 是编译期常量闭集 | **不可承接**（架构上不允许第二个 source） |
| 多路流传输 | `api/gateway` `RemoteStreamMuxServer`＝WebSocket 多路复用 **Typert Remote RPC** 流 | **问题域不同**（RPC 载具 vs 监控增量推送） |
| 设置面 | `settingsController` 管 vendor 自己的 namespace 注册表（`describe`/`update`/`replace`/`mutate`）；ATF 的是 `<HOME>/.atf/webui-settings.json` 实例隔离 store（storage 四键＋`effort_defaults`） | **域不同**（不是同一份文档、不是同一 schema） |
| 工作区清单 | `workspaceController` 只有 create/rename/delete/order/archive/pin 等**变更型**方法＋`follow` 流（`WorkspaceView` 无目录在位状态字段） | **不可等价承接**（缺「目录已丢失」这一字段面） |
| GPU 采集/历史 | 全仓零 `nvidia-smi`、零 GPU 采集、零 gpu-history | **无对应物** |
| run 产物读取 | `workspaceFiles.read/readBytes/stat` 存在，但（a）走 Remote RPC 不是同源 HTTP，（b）client 侧该通路实测恒败（见 L410 注），（c）不支持 ATF 的 run 目录双形态解析＋扩展名白名单 | **不可等价承接** |
| 事件日志轮转 | 全仓无 jsonl 事件日志轮转／降级状态面 | **无对应物** |
| 降采样 | 全仓无序列降采样工具 | **无对应物** |
| 槽位注入 | vendor 扩展模型「只允许追加」——本插件 10 槽全为追加型 | **合理领域定制** |

**重复性总判**：atf-ui 与 vendor api 族**不存在可删除的等价重复**。审计器
`MODULE_RULES` 文案「自建 HTTP/SSE 与 vendor api 族重复」中的「自建 HTTP」与事实不符
（无自建 server，全走 `webServer.register`）；「SSE」的 vendor 对应物经实测也不存在
（`RemoteStreamMuxServer` 是 WebSocket RPC 载具，不是同一个问题）。
