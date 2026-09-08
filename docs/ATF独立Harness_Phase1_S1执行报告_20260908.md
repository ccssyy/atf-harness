# ATF 独立 Harness — Phase 1 启动 & S1 桥接层 任务执行报告

> 日期：2026-09-08 ｜ 执行方：zcode（本仓唯一开发 agent）｜ 报告对象：owner
> 执行依据：《ATF独立Harness_Phase1任务书_20260908.md》§1（S1）+ 开发启动指令（Phase 1 / S1）
> 结论：**S1 全部验收用例通过，按纪律停在此处等 owner review；S2 未启动。**

---

## 0. 结论摘要

1. 仓库已建立并与远程同步：`github.com/ccssyy/atf-harness`（**私有**）。初始提交 `6104880`（权威文档 + 工程骨架 + bridge.contract.yaml 初版）已按启动指令脱敏自查后推送 main；S1 代码在本地提交 `be7b603`，**未推送**（"未经 owner 批准不 push" 纪律）。
2. S1 桥接层（`src/bridge/`）按任务书完成：stdio JSONL 三类帧、Result 类型贯穿、spawn→握手→就绪→优雅关闭、30s 超时常量、fail-closed 失败语义（不重试、不猜测成功）。
3. 测试全量（含 `ATF_CLI_PATH` 指向 pin 副本）：**26 passed / 2 skipped**（跳过项均为"等待内核排队"的占位断言，非失败）；两条手工冒烟命令 exit 0。
4. 发现并登记 **4 项待 owner 决策点**（见 §6），其中最关键的是内核 CLI 在 pin 上**无 `--version`、无 JSONL 会话模式**——S1 会话协议对端由契约忠实 mock 对端承载，真实 CLI 契约面 = pin 校验 + 一次性调用冒烟。

## 1. 任务范围与执行依据

| 项 | 内容 |
|---|---|
| 本 phase 目标 | headless 冒烟最小闭环（S1 桥接 → S2 会话 → S3 工具 → S4 工作区 → S5 Faux 冒烟） |
| 本报告范围 | **Phase 1 启动（第 0–2 步）+ S1 桥接层（第 3 步）+ VERIFY** |
| 执行依据 | Phase 1 任务书 §1（S1 设计要求与验收标准）、AGENTS.md 长期硬约束、Phase 0 决策文档（ADR-05~08，已拍板不再讨论） |
| 决策基线 | R2a（零 npm 运行时依赖）+ 双层引用 + 双轨审批 + 三层工作区 |

## 2. 环境与前置确认

| 项 | 实测 | 结果 |
|---|---|---|
| Node | v24.16.0（要求 ≥22） | ✓ |
| git | 2.43.5 | ✓ |
| gh CLI | 已登录 ccssyy（repo 权限，https 协议） | ✓ |
| 内核仓 pin | `v0.2.0b7^{commit}` = `a628f8b8e23beff104b42b5c80088416ea78b394`，main tip `250ccd3` 为其上 docs 提交，与任务书 §8.4 一致 | ✓ |
| pin 副本 | 经 `git worktree add` 建于本仓 `.atf-pinned/`（gitignore，不进仓），HEAD 与 pin 实测一致，全程零改动 | ✓ |
| 内核 CLI 实测 | `python3 -m agentic_training_flow`（PYTHONPATH 派生）`--help` exit 0；**无 `--version` 旗标**（argparse 直接报错）；**无 JSONL 会话模式** | 见 §6-② |

## 3. 执行记录

### 第 0 步：上下文加载
完整阅读 AGENTS.md、Phase 0 决策文档（ADR-05/06/07/08）、Phase 1 任务书、`admission-to-g2.json`；环境验证如上表。

### 第 1 步：建仓与 GitHub 同步
1. `git init -b main`；仓库身份配置为 ccssyy（GitHub noreply 邮箱）。
2. `.gitignore`：`node_modules/`、`dist/`、`.atf-pinned/`、`.env*`、`coverage/`。
3. 脱敏自查（首次提交前）：对全部将入库文件扫描基础设施地址端口 / IP / 内部路径 / 人名——**本次会话生成的全部文件零命中**；owner 亲笔文档存在命中项，处置见 §6-③。
4. `gh repo create ccssyy/atf-harness --private --source . --remote origin` + `git push -u origin main`（初始提交 `6104880`）。

### 第 2 步：工程骨架
- `package.json`：`type=module`、`engines.node>=22`、`private=true`；**`dependencies` 字段不存在（零运行时依赖，R2a 达成）**；devDependencies 仅 `typescript@^7.0.2`、`vitest@^5.0.0`、`@types/node@^26.5.0`（含 lockfile）。
- `tsconfig.json`（typecheck：src+tests，strict + noUncheckedIndexedAccess + verbatimModuleSyntax）+ `tsconfig.build.json`（src → dist）。
- 目录纪律：仅创建 `src/bridge/` 与 `tests/`；S2–S5 的目录未提前建空壳。
- `bridge.contract.yaml` 初版：JSONL 三类帧定义 + 协议常量（LF 分帧 / 1MiB 帧上限 / 30s 超时 / 握手 schema）+ atf CLI 对接面（`ATF_CLI_PATH` 注入、派生命令、已知缺口）+ `atf_upstream` pin。

### 第 3 步：S1 桥接层
1. **实现**（`src/bridge/`）：
   - `result.ts`：`Result<T,E>`（ok/err），一切可失败操作的统一形态；
   - `errors.ts`：`BridgeError`（code/message/stderrTail/detail）+ stderr 尾部摘要（8KB 上限）；
   - `frames.ts`：request/response/event 三类帧 + 严格白名单校验（内核发 request = 协议违规）+ 增量 LF 分帧解码器（容忍字节分片与多帧合包）+ 请求帧编码（循环引用/超限 → err，不抛）；
   - `connection.ts`：spawn + 握手（`atf.version`，contract_version 不一致即 err）+ id 自增配对 + 每请求超时（`REQUEST_TIMEOUT_MS = 30_000`，常量）+ 超时/协议违规/意外退出 → fail-closed 回收 + 优雅关闭（end stdin，退出码 0 才 ok，幂等）；
   - `atfCommand.ts`：pin 常量 + 由 `ATF_CLI_PATH` 派生一次性调用 + `git rev-parse` pin 校验 + `--help` 冒烟探针；
   - `smoke.ts` + `npm run smoke:s1`：slice 手工冒烟命令（`--mock` / `--atf` 双模式）。
2. **mock 对端**（`tests/fixtures/mock_atf.mjs`，harness 测试基建，非内核代码）：契约忠实实现，支持行为注入旗标（`--chunk` 字节分片 / `--flush-delay` 合包 / `--delay-response` 超时 / `--contract-version` 版本不一致反例 / `--crash-on-second-request` 意外退出 / `--bad-line-after-handshake` 协议违规）。
3. **测试**（vitest，26 用例）：解码器单元 13 + 会话/验收 11 + 真实 CLI 契约 4（其中 2 项需 `ATF_CLI_PATH`，1 项等待内核排队的占位 skip，1 项环境自检）。

## 4. S1 验收结果对照（任务书 §1 验收标准）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 握手：spawn → 收到版本 response → 优雅退出，退出码 0 | ✅ | `session.test.ts` 用例 1（version 三字段校验 + close exitCode=0）；close 幂等与契约版本不一致反例同组覆盖 |
| 2 | 错误：不存在的 atf 可执行路径 → err，主进程不崩 | ✅ | ENOENT → `err(spawn_failed)` 附路径；脚本缺失 → `err(handshake_failed)` 附 stderr 摘要 "Cannot find module"；promise 全程不 reject |
| 3 | 分帧：连续 10 个 request 的 response 无串扰（id 全部正确配对） | ✅ | `--chunk=3` 字节分片与 `--flush-delay=25` 合包双压力下 10/10 配对；成功/错误响应交错各归其主；event 帧不干扰配对 |
| 4 | 契约测试前置：`.atf-pinned` HEAD == pin，不一致直接 fail | ✅ | 设 `ATF_CLI_PATH` 实跑：pin 校验 + `--help` 冒烟 2 passed |
| 5 | 请求超时常量（初值 30s，不暴露给模型） | ✅ | `REQUEST_TIMEOUT_MS=30_000` + 契约文件同值；超时用例验证 err(timeout) → 连接回收 → err(closed) |
| 6 | 失败语义：意外退出 err 附 stderr 摘要，不重试不猜测成功 | ✅ | crash 用例：挂起请求 err(peer_exit)+stderr 摘要；后续请求 err(closed) |
| 7 | 手工冒烟命令 1 条 | ✅ | `npm run smoke:s1 -- --mock --chunk=7` exit 0；`-- --atf`（pin ✓ + `--help` ✓）exit 0 |
| 8 | 全量测试 | ✅ | **26 passed / 2 skipped**（skipped = 占位与环境自检，非失败） |

## 5. 改动文件清单与提交状态

| 提交 | 状态 | 内容 |
|---|---|---|
| `6104880` `chore(repo)` | **已推送 origin/main** | `.gitignore`、`package.json`、`package-lock.json`、`tsconfig.json`、`tsconfig.build.json`、`vitest.config.ts`、`bridge.contract.yaml`、AGENTS.md 与 docs/（owner 原文未动） |
| `be7b603` `feat(bridge)` | **本地，待 review** | `src/bridge/{result,errors,frames,connection,atfCommand,index,smoke}.ts`、`tests/fixtures/mock_atf.mjs`、`tests/bridge/{frames,session,contract.pin}.test.ts` |
| 本报告 | 本地，待 review | `docs/ATF独立Harness_Phase1_S1执行报告_20260908.md` |

## 6. 偏离规范之处 / 待 owner 决策项（未擅自处置）

1. **三类帧表述差异**：启动指令括号写 "request/response/error"，任务书 S1 正文写 "request/response/event"。**已按任务书（权威执行依据）实现**：`event` 为第三类帧，"错误帧"由 `response` 携带 `ok=false` 表达，并在 `bridge.contract.yaml` 书面注明该解释。若 owner 本意是独立第四类 error 线缆帧，请指示，契约与实现随之调整。
2. **内核 CLI 能力缺口（pin v0.2.0b7 实测）**：无 `--version` 旗标、无 JSONL 会话模式。S1 的版本握手与会话协议由契约忠实 mock 对端承载；真实 CLI 契约面 = pin 校验 + 派生命令 `--help` 冒烟。缺口已登记 `bridge.contract.yaml → atf_cli.known_gaps` 并留测试占位。若要求内核原生提供（版本子命令 / JSONL RPC 会话），建议按任务书 §8.3.3 走 ATF 仓正常流程排队，本仓不阻塞、不插队。
3. **owner 亲笔文档的脱敏命中**：本次生成的文件零命中；但 AGENTS.md（内核仓本地路径示例 ×3）、Phase 1 任务书（训练服务器环境标注）、Phase 0 决策文档（owner 署名）存在命中项（具体 token 可径直 grep 上述三份文档核实）。因"文档未经批准不可改动"与"入库前脱敏"两指令冲突、且仓库为私有，本次**原样入库**并在此提请决策：如需整改（路径改占位符、署名改 "owner" 等），请书面批准后由我执行并重写相关历史（或追加整改提交）。
4. **内核主仓存在并行在途改动（非本会话造成）**：主仓工作区在会话窗口内出现 analyze-badcases 三个文件的未提交修改（badcase viewer 的 JPEG 支持等功能开发，系任务书 §8.4 所述并行主线会话所为）。本会话对内核仓的全部写入仅为 owner 指定的 `git worktree add` 元数据，未触碰任何工作区文件。故"内核仓 diff 为空"以 **`.atf-pinned` 全程干净 + 主仓 tracked 改动与 harness 无因果** 的口径如实报告。

## 7. 纪律遵守自查

- ✅ S1 完成即停，S2 未启动；
- ✅ 内核仓工作区零触碰（仅只读探测 + 指定的 worktree 元数据写入），`.atf-pinned` 状态全程干净；
- ✅ 无 GPU、无真实 LLM Provider、无网络模型调用，测试全部 Faux/mock；
- ✅ 零 npm 运行时依赖（`dependencies` 字段不存在）；
- ✅ 未自动升级 pin（pin = `v0.2.0b7`/`a628f8b`，实测一致）；未 merge、未打 tag、未改仓库可见性；
- ✅ S1 提交未推送，等 owner review；
- ✅ Result 类型贯穿桥接层，无裸 throw 穿过边界（公开 API 全部 `Result` / `Promise<Result>`）。

## 8. 下一步建议

1. **owner review** 本地提交 `be7b603` 与 §6 四项决策点；
2. 批准后执行：S1 提交 push（§6-③ 如需整改则先行整改）；review 通过后按任务书顺序进入 **S2（会话 log + 双层事实，`src/session/`）**；
3. 若 owner 决定要求内核提供 JSONL 会话 / 版本能力，建议在 ATF 仓立项排队，本仓契约测试占位已就绪，内核落地后 re-pin 即可启用真实 CLI 会话断言。
