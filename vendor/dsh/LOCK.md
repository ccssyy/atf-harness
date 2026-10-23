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

## 本地 patch 清单（worktree 修改态＋patches/ 存档；bump 须重同步）

上游源码以 patch 形态维护（worktree 保持「锁 commit＋patch 已应用」修改态；构建产物 lib/ 随主仓构建流程重建）：

| patch | 批次 | 内容 | 触及文件 |
|---|---|---|---|
| `0001-fixed-launch-token.patch` | 批㉟H | `DSH_WEB_LAUNCH_TOKEN` env 支持（固定 token 语义） | `packages/client/connection/src/browser-auth.ts` |
| `0002-composer-placeholder.patch` | 品牌化批 | composer 占位文案 ATF 化 | `packages/client/ui-conversation/src/client/locales.ts` |
| `0003-form-intent.patch` | 批㊶-W F5 | user-questions 加 `form` 呈现意图（tagged union＋ask 校验分支＋client formOf/FormPanel 表单卡＋locales 三键）——确认卡表单化底座（表单卡只收改参不承载授权；答案经 selected `key=value` 结构化回传，协议零改动） | `packages/interaction/user-questions/src/{types,index}.ts`、`packages/client/ui-user-questions/src/client/{contract/slots.ts,QuestionComposer.tsx,FormPanel.tsx,FormPanel.module.css,index.ts,locales.ts}`、`packages/plan/plan-mode/tests/plan-mode.spec.ts`（intent 联合类型窄化） |
| `0004-api-key-reveal.patch` | 批甲-BUILD | Models 设置页 ProviderEditor API Key 栏加眼睛明文切换（password↔text＋aria-pressed＋内联 SVG 眼/闭眼＋locales 两键 keyReveal；owner 2026-10-15「对齐市面产品」裁定） | `packages/client/ui-settings-models/src/client/{ProviderEditor.tsx,ModelsSection.module.css,locales.ts}` |
| `0005-form-cancel.patch` | 修复批A1.1 | form 卡显式取消入口：`PendingQuestion.cancel()`（waterfall.reject('ASK_CANCELLED')——与 dismiss 的 hide 语义分离：hide＝收起请示继续，cancel＝终止本次请示）；FormPanel footer 增 outline 取消钮（busy 禁用；成功 close 卡、失败落 status 面不静默；不调用 dismiss）；locales 两键 form.cancel；.actions 固化右对齐两钮。红线：dismiss 语义零改动、取消≠拒绝授权、无 Esc、form 校验不放宽 | `packages/client/ui-user-questions/src/client/{contract/slots.ts,FormPanel.tsx,FormPanel.module.css,locales.ts}` |
| `0006-settings-host-persistence.patch` | D75 | ui-settings persistence 不再按非回环降级 'memory'（apply 内恒 'host'；mirror/ConfigForms 消费逻辑零触）。根因：served 页 isLoopback＝isLoopbackHostname(location.hostname)，UAT 公网访问必降 'memory' → describe 永不发出 → Models 页 "settings are unavailable"（Step 0 Playwright 实锚 2026-10-23）。安全注记：UAT 内部试用环境，公网暴露设置写入面可接受（owner 10-23 16:05 授权）。已知 vendor spec 失配 1 条（developer-tools.client.spec "shares one remote-browser preference…" 锁旧 memory 语义，重放后红属预期——详见 patches/README.md 0006 条目） | `packages/client/ui-settings/src/client/index.ts` |

**bump 重同步**（唯一合法路径＝re-pin 三步同族）：submodule 升级后跑 `vendor/dsh/apply-patches.sh`——按序重放 0001→0006（apply 失败即停，人工评估更新 patch）并重建 host/client 产物。构建命令明细：`tsc -b tsconfig.host.json`＋`tsc -b tsconfig.client.json`＋`tsdown --env.DSH_BUILD_FACE host`＋`pnpm --filter @deepseek-ai/dsh-client-ui-user-questions run bundle`（成本已接受——M3 同族裁定）。
