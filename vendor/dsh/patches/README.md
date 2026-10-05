# vendor/dsh patch 留档

- `0001-fixed-launch-token.patch`：dsh web launch token 固定值支持（env `DSH_WEB_LAUNCH_TOKEN`——在场用固定值，缺省逐字节不变＝随机轮换）。批㉟H owner 授权破戒（10-05 22:21 "uat 不要换新 token"），范围仅本 patch。
- **vendor submodule 更新（bump commit）后须重放本 patch**（vendor/dsh/deepseek-harness 呈 dirty 为预期状态）。
