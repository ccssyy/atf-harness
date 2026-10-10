# 部署模板（产品级单源）——deploy/profiles/web/

产品/实例分层（owner 增补裁定 2026-10-08）：模板＝产品层（零实例值、零具体绝对路径）；
实例差异只落 `deploy/instances/<实例>.overlay.yml`（profile 行覆写/追加）与
`deploy/instances/<实例>.env`（boot env 声明，含白名单附加集 `ATF_V1_FILE_TOOL_ROOTS`）——
两者均 gitignored，样例见 `overlays/*.example`。换环境/换机器＝改实例文件，产品资产零改动。

## 接入一个实例

1. `cp overlays/uat.env.example deploy/instances/<实例>.env` 并填实值；
2. 如需行覆写（如业务 provider）：`cp overlays/uat.overlay.example.yml deploy/instances/<实例>.overlay.yml`；
3. 生成：`python3 deploy/profiles/web/generate.py --overlay deploy/instances/<实例>.overlay.yml --out <DSH_HOME>/profiles/web/cordis.patch.yml`；
4. 校验：`python3 deploy/profiles/web/check-drift.py --overlay … --deployed …`（重启前必跑，漂移即停）。

## 守护纪律

- **单树收敛（批㊶-M2）**：实例 env 须声明 `ATF_DSH_RUNS_ROOT=<workspace>/runs`——工具链写入/监控扫描/模型文件面三面同源；tmp 侧独立 runsRoot 布局已废弃。

## 守护纪律

- 产品资产零具体绝对路径：tests/dshTools/fileGuard.test.ts 静态守护（①）；
- 派生集＝配置声明面：同文件守护（②）——白名单根由 src/agent/fileRoots.ts 从
  声明面（env 名镜像＋内核配置/env-profiles 声明）自动重建，附加集只走 env；
- vendor bump：patch 重放（0001→0002）＋preset-standard 行重同步（台账义务），再重新生成实例文件。
