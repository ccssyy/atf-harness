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
- 纪律：**升级只走独立评估批**（不自动追新；上游明示 developer preview 有破坏性变更）；submodule 指针零偏离官方 commit，源码修改只走 patches/ 编号 patch 通道（见下节；2026-11-15 收编批起登记面与文件面由测试对账）——atf-ui/atf-tools 经父仓 node_modules symlink 消费其构建产物
- 运行时 GLM 接线（poc/dsh-home 运行时目录不入仓）：`poc/web-profile-cordis-patch.yml` 为 profile patch 的交付副本（apiKeyEnv env 引用零落盘）

## 本地 patch 清单（patch 文件住父仓版本化；bump 须重同步）

上游源码以 patch 形态维护（patch 文件住本目录、父仓 git 跟踪；worktree 保持「锁 commit＋patch 已应用」修改态——2026-11-15 收编批实证：dev server 以 tsx 直跑 src（node --import tsx/esm apps/cli/src/bin.ts），工作区还原 pristine 即刻回退 server 面 patch 行为（launch token 固定值变随机实锚），pristine 日常态被真机否决；应用态一致性由 tests/tools/testVendorPatchConsolidation.test.ts 断言护栏——18 触达文件与 patch 全集重放逐字节比对＋client 产物特征码）：

| patch | 批次 | 内容 | 触及文件 |
|---|---|---|---|
| `0001-fixed-launch-token.patch` | 批㉟H | `DSH_WEB_LAUNCH_TOKEN` env 支持（固定 token 语义） | `packages/client/connection/src/browser-auth.ts` |
| `0002-composer-placeholder.patch` | 品牌化批 | composer 占位文案 ATF 化 | `packages/client/ui-conversation/src/client/locales.ts` |
| `0003-form-intent.patch` | 批㊶-W F5 | user-questions 加 `form` 呈现意图（tagged union＋ask 校验分支＋client formOf/FormPanel 表单卡＋locales 三键）——确认卡表单化底座（表单卡只收改参不承载授权；答案经 selected `key=value` 结构化回传，协议零改动） | `packages/interaction/user-questions/src/{types,index}.ts`、`packages/client/ui-user-questions/src/client/{contract/slots.ts,QuestionComposer.tsx,FormPanel.tsx,FormPanel.module.css,index.ts,locales.ts}`、`packages/plan/plan-mode/tests/plan-mode.spec.ts`（intent 联合类型窄化） |
| `0004-api-key-reveal.patch` | 批甲-BUILD | Models 设置页 ProviderEditor API Key 栏加眼睛明文切换（password↔text＋aria-pressed＋内联 SVG 眼/闭眼＋locales 两键 keyReveal；owner 2026-10-15「对齐市面产品」裁定） | `packages/client/ui-settings-models/src/client/{ProviderEditor.tsx,ModelsSection.module.css,locales.ts}` |
| `0005-form-cancel.patch` | 修复批A1.1 | form 卡显式取消入口：`PendingQuestion.cancel()`（waterfall.reject('ASK_CANCELLED')——与 dismiss 的 hide 语义分离：hide＝收起请示继续，cancel＝终止本次请示）；FormPanel footer 增 outline 取消钮（busy 禁用；成功 close 卡、失败落 status 面不静默；不调用 dismiss）；locales 两键 form.cancel；.actions 固化右对齐两钮。红线：dismiss 语义零改动、取消≠拒绝授权、无 Esc、form 校验不放宽 | `packages/client/ui-user-questions/src/client/{contract/slots.ts,FormPanel.tsx,FormPanel.module.css,locales.ts}` |
| `0006-settings-host-persistence.patch` | D75 | ui-settings persistence 不再按非回环降级 'memory'（apply 内恒 'host'；mirror/ConfigForms 消费逻辑零触）。根因：served 页 isLoopback＝isLoopbackHostname(location.hostname)，UAT 公网访问必降 'memory' → describe 永不发出 → Models 页 "settings are unavailable"（Step 0 Playwright 实锚 2026-10-23）。安全注记：UAT 内部试用环境，公网暴露设置写入面可接受（owner 10-23 16:05 授权）。已知 vendor spec 失配 1 条（developer-tools.client.spec "shares one remote-browser preference…" 锁旧 memory 语义，重放后红属预期——详见 patches/README.md 0006 条目） | `packages/client/ui-settings/src/client/index.ts` |
| `0007-workspace-picker-root.patch` | b11 批（10-28 owner 授权） | 目录选择器缺省根可声明：`DSH_WORKSPACE_PICKER_ROOT` env 声明缺省根（未声明＝homedir() 逐字节同旧行为）。根因：实例宿主家目录 /root，工作区落实例根外与 F16「实例资产在实例根内」冲突。**重放注意：包 main 指向 lib/index.js 构建产物，重放后须重建本包**（根因与授权链详见 patches/README.md 0007 条目） | `packages/host/directory-picker-browse/src/index.ts` |
| `0008-bash-env-passthrough.patch` | b11 批（10-28 owner 授权） | bash 会话按声明透传宿主 env：`DSH_BASH_PASSTHROUGH_ENV` 逗号名单（未声明＝逐字节同旧行为；透传层置于 spec.env 前，调用方可覆盖）。根因：atf_bash 里 python3 起不来——LD_LIBRARY_PATH 无通道，容器本地编译 python3 需它加载 libpython。配套 dev.env:66 声明。**重放注意：同 0007，包 main 指向 lib 构建产物须重建**（根因与授权链详见 patches/README.md 0008 条目） | `packages/shell/bash-local/src/index.ts`、`packages/terminal/terminal-bash/src/index.ts` |

**bump 重同步**（唯一合法路径＝re-pin 三步同族）：submodule 升级后走四步 SOP——①指针推进（独立评估批内改锁 commit）→ ②跑 `vendor/dsh/apply-patches.sh` 按序重放全部编号 patch（当前 0001→0008，新 patch 接续编号 glob 自动纳入；幂等：已应用 patch reverse-check 跳过；未应用且 apply 失败即停，人工评估更新 patch）＋产物重建（有新应用才重建，全部已应用则跳过重建段）→ ③**契约冒烟**：`npx vitest run tests/tools/testVendorPatchConsolidation.test.ts` 全绿（基线/登记对账/编号/应用态/产物特征码/演练逐字节 cmp 六面）＋目录回归 → ④**真机回归**：dev 净室重启后验三项功能点——bash 会话透传（python3 可起）、提问卡可出可答（atf_config_confirm present 出卡→作答提交→agent 消费）、模型设置面板可开（0006 describe 正常+0004 眼睛按钮）；三项证据落盘真机轮报告（docs/testing/）。跳过③④的 bump 无效（20261115 实证：还原 pristine 即回退 server 面行为，只有真机能抓到）。

**重评触发**（受控修改通道的退出条件，三期方案 §3.2 批 4 预留路径）：patch 改动面扩大到治理成本超阈值——具体信号：新 patch 落盘频率显著上升（月均 ≥2 个非缺陷修复类新 patch）、触达包数超过当前闭集（18 文件/10 包，批 4 机检实锚更正旧记 8 包）的 1.5 倍、或同文件被 ≥3 个 patch 叠加导致重放链脆弱——满足任一时启动独立评估批，评估「建镜像仓转 fork 模式」替换 submodule+patch 通道；重评与切换只走独立批，不在业务批夹带。

构建命令明细：`tsc -b tsconfig.host.json`＋`tsc -b tsconfig.client.json`＋`tsdown --env.DSH_BUILD_FACE host`＋`pnpm --filter @deepseek-ai/dsh-client-ui-user-questions run bundle`＋`corepack pnpm --filter @deepseek-ai/dsh-client-ui-settings run bundle`（成本已接受——M3 同族裁定；末条＝D75 补口——patch 触达的 client 包凡带 bundle 脚本均需重建，当前 0006＝ui-settings）。
