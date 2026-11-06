# 实例 env 文件（deploy/instances/*.env）——运维语义

本目录的 `dev.env`／`uat.env` 是实例层环境真值（gitignored，token/密钥零入仓）；
`dev.overlay.yml`／`uat.overlay.yml` 是模板投影。本文件只记录 env 键的语义与边界，
不记录任何实例的真值。

## 双 env 双面白名单语义（D169 收敛口径）

两个白名单 env 分属两套执行面，**同名不同面，排查时先认面再看值**：

| env 键 | 生效面 | 语义 | 约束 |
|---|---|---|---|
| `ATF_V1_FILE_TOOL_ROOTS` | harness 文件工具面（会话内文件读写工具的可见根） | 冒号分隔绝对根；文件工具越出即拒 | 只装「配置外素材根」（如 pinned 树、批量验收素材目录），**不装模型权重类路径**（如 `/data/LLM_model` 仅 awq_base 消费方，不入文件白名单） |
| `ATF_WORKSPACE_ALLOWLIST` | 内核治理面（内核 CLI/管线对 workspace 的准入判定） | 冒号分隔绝对根；与内核登记面（register 建立的 workspace）取并集生效 | 实例家工作区根＋素材根；手工摆目录不入白名单被拒是产品语义（报文含 how_to_fix，走产品入口或 env 声明） |

- 派生集：内核侧白名单＝「登记面 workspace 根 ∪ env 显式附加」同源不另立清单；
  UAT 经 `ATF_DSH_BRIDGE_COMMAND` 注入。
- 排查误判警示（D169 实锚）：UAT 容器是冻结 checkout，**没有** dev 侧的 env 文件——
  在容器里找声明源必扑空；声明源唯一在 dev 侧本目录的实例 env 文件。
- 越界报文：`workspace_path_outside_allowlist`（含合法根清单与 how_to_fix）。

## UAT SSH 目标（D165 口径）

`instance-restart.sh uat`／`uat-deploy.sh` 的 atf-uat 容器 SSH 目标**禁写死 IP**：
容器在 docker 默认 bridge 上重建后内网地址会变。解析序＝
`ATF_UAT_SSH_TARGET` 显式 env ＞ 实例 env 文件声明（`export ATF_UAT_SSH_TARGET=root@<容器内网IP>`）
＞ 网段探测（172.18.0.2-30 认 3081 监听）。`--env-cmd/--env-dump` 只做前两级静态解析
（零网络依赖），restart 走全三级并做 SSH 三分归因（网络≠身份≠容器内文件缺失）。
