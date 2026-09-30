# vendor/dsh 锁版本记录（批⑱-M0 引入；M2 复核修正：改 git submodule 方案）

- 上游仓：https://github.com/deepseek-ai/deepseek-harness（DeepSeek Harness，developer preview）
- **锁 commit：`639ed015397290b3745d163aafe02ffee4aa3f84`**（dsh **0.2.0-rc.2**；远端 master HEAD 同指该 commit，ls-remote 已核）
- 引入方式（M2 复核修正后）：**git submodule**——`vendor/dsh/deepseek-harness` 为 submodule 指针（.gitmodules），harness 仓只存指针不存源码
- 检出/构建（三步）：
  ```sh
  git submodule update --init vendor/dsh/deepseek-harness   # 检出锁 commit（浅克隆可加 --depth 1）
  cd vendor/dsh/deepseek-harness && corepack pnpm install   # 依赖安装（pnpm 11.7.0；实测 2m4s）
  corepack pnpm run build                                   # 构建（实测 install+build 总 404s）
  ```
- 本地远端为 SSH 通道的机器（443 阻）：`git config submodule.vendor/dsh/deepseek-harness.url git@github.com:deepseek-ai/deepseek-harness.git` 后再 init/fetch
- 纪律：**升级只走独立评估批**（不自动追新；上游明示 developer preview 有破坏性变更）；DSH 源码零改动——atf-ui/atf-tools 经父仓 node_modules symlink 消费其构建产物
- 运行时 GLM 接线（poc/dsh-home 运行时目录不入仓）：`poc/web-profile-cordis-patch.yml` 为 profile patch 的交付副本（apiKeyEnv env 引用零落盘）
