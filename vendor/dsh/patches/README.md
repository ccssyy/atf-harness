# vendor/dsh patch 留档

- `0001-fixed-launch-token.patch`：dsh web launch token 固定值支持（env `DSH_WEB_LAUNCH_TOKEN`——在场用固定值，缺省逐字节不变＝随机轮换）。批㉟H owner 授权破戒（10-05 22:21 "uat 不要换新 token"），范围仅本 patch。
- `0002-composer-placeholder.patch`：composer placeholder 双语 8 行 ATF 化（`packages/client/ui-conversation/src/client/locales.ts` zh/en 各 4 键：placeholder.default/plan/hero/workspace）。批㊳ M3-3 owner 档二裁决授权破戒（决议件 2026-10-06 裁定三；locale 机制无第三方覆盖点——单占位注册，patch 为唯一路径），范围仅本 patch。
- **vendor submodule 更新（bump commit）后须依序重放全部 patch（0001 → 0002）**：在 vendor 仓根逐个 `git apply --check ../patches/000N-*.patch` 后 apply；vendor/dsh/deepseek-harness 呈 dirty 为预期状态。
