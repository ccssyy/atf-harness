# vendor/dsh patch 留档

- `0001-fixed-launch-token.patch`：dsh web launch token 固定值支持（env `DSH_WEB_LAUNCH_TOKEN`——在场用固定值，缺省逐字节不变＝随机轮换）。批㉟H owner 授权破戒（10-05 22:21 "uat 不要换新 token"），范围仅本 patch。
- `0002-composer-placeholder.patch`：composer placeholder 双语 8 行 ATF 化（`packages/client/ui-conversation/src/client/locales.ts` zh/en 各 4 键：placeholder.default/plan/hero/workspace）。批㊳ M3-3 owner 档二裁决授权破戒（决议件 2026-10-06 裁定三；locale 机制无第三方覆盖点——单占位注册，patch 为唯一路径），范围仅本 patch。
- **vendor submodule 更新（bump commit）后须依序重放全部 patch（0001 → 0002）**：在 vendor 仓根逐个 `git apply --check ../patches/000N-*.patch` 后 apply；vendor/dsh/deepseek-harness 呈 dirty 为预期状态。
- **bump 时 preset 同步义务（批㊴ 选项 A 代价登记）**：profile yml 的 `preset-standard` 覆写行（owner 定稿 persona，源＝`poc/web-profile-cordis-patch.yml`）是 plugins 全量重述——**vendor bump 时 preset 上游变更不自动流入，须随 bump 重同步该覆写行**（对照 `packages/bundle/web-app/presets/standard.patch.yml` 重述并仅保 persona prefix 定稿文案；重同步后 `dsh --profile web --dump-config` 核验）。此为配置面义务，与上列 patch 重放并行执行。

