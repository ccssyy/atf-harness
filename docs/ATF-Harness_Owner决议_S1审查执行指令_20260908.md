# Owner 决议：S1 审查通过 + 执行指令（①1 / ②1 / ③1）

> 日期：2026-09-08 ｜ 签发：owner ｜ 执行方：zcode
> 依据：《ATF独立Harness_Phase1_S1执行报告_20260908.md》§6 四决策点 + owner review（独立核验通过：提交状态 / pin 副本干净度 / 带 `ATF_CLI_PATH` 测试复跑 26 passed / 2 skipped / 零运行时依赖 / 代码抽审 frames.ts + connection.ts + 契约文件）。

## 0. 结论

**S1 验收通过。决议：①1（三类帧维持 request/response/event）、②1（批准在 ATF 仓立项排队内核 JSONL 会话能力）、③1（追加整改提交完成脱敏）。**

执行序列：执行 1（决议登记）→ 执行 2（③ 脱敏整改）→ 执行 3（push）→ 执行 4（S1 闭合简报），完成后**停在 S2 之前，等待 owner 的 S2 启动指令**。

## 1. 执行 1：决议登记（bridge.contract.yaml）

在 `atf_cli.known_gaps` 追加决议标记（不改任何既有条目语义，仅登记状态）：

```yaml
  decision_20260908:           # owner 决议 ②1：批准在 ATF 仓立项排队（JSONL RPC 会话模式 + 版本子命令）
    atf_side_backlog: approved_pending_queue   # 立项与排期由 owner 主线按 §8.3.3 流程处理，本仓不插队
    harness_side: 本仓契约测试占位不变；内核落地后 re-pin 即启用真实 CLI 会话断言
```

并在 `frames` 段错误帧语义说明后追加一行决议登记：

```yaml
# 【决议登记 2026-09-08】owner 决议 ①1：三类帧 = request / response / event 维持不变，
# 不引入第四类独立 error 线缆帧（错误由 response.ok=false 表达）。
```

本项变更属于 owner 书面批准范围内的元数据登记，随本次一并提交，无需另行走 review 循环。

## 2. 执行 2：③ 脱敏整改（追加提交，禁止重写历史）

**整改原则（硬约束）**：仅对指定 token 做**机械替换**，不得改动任何技术内容、措辞、结构；替换表如下，不在表内的任何内容零触碰。

| 文件 | 命中项 | 处置 |
|---|---|---|
| `AGENTS.md` | 内核仓本地路径示例 ×3（`/data/sam/AgenticTrainingFlow` 及派生路径） | 替换为占位符 `<ATF_KERNEL_DIR>`（派生路径如 `/data/sam/ATF-Harness` 替换为 `<HARNESS_DIR>`；`124.220.53.207` 等基础设施地址/端口替换为 `<INFRA_HOST>` / `<INFRA_PORT>`，以实际 grep 命中为准） |
| `docs/ATF独立Harness_Phase1任务书_20260908.md` | 训练服务器环境标注（IP / 端口 / 内部主机名） | 同上占位符替换 |
| `docs/ATF独立Harness_Phase0决策文档_20260907.md` | owner 署名 | 署名替换为 `owner`（正文自称"owner"处不动） |

执行步骤：
1. 整改前先 `grep -rn` 三份文档列出全部命中 token 清单，写入 S1 闭合简报（整改前后对照）；
2. 按替换表机械替换；
3. 替换后再次全仓 grep 复查，确认零命中（占位符本身不算命中）；
4. 以独立提交入库：`chore(docs): owner 批准脱敏整改（决议 ③1）——路径/地址/署名占位符化`。

## 3. 执行 3：push

1. push 前重跑全量测试（含 `ATF_CLI_PATH` 指向 pin 副本）：确认 **26 passed / 2 skipped** 方可推送；
2. 一次性 push 到 `origin/main`：`be7b603`（S1）+ S1 报告提交 + 决议登记提交 + 脱敏整改提交；
3. push 后记录 origin/main 最终 tip hash，写入闭合简报。

## 4. 执行 4：S1 闭合简报

在 `docs/` 新增《ATF独立Harness_Phase1_S1闭合简报_20260908.md》，内容：
1. 三项决议的执行结果对照（每项：做了什么 / 证据 / commit hash）；
2. 脱敏整改前后命中 token 对照表；
3. push 后 origin/main tip hash 与提交序列；
4. 声明：S1 全部闭合，停在 S2 前等待启动指令。

## 5. 决议 ② 的边界说明（zcode 无需动作部分）

ATF 仓立项（内核侧 JSONL RPC 会话模式 + `--version` 子命令）由 owner 主线按任务书 §8.3.3 流程处理，**zcode 不触碰内核仓**。本仓侧职责仅限执行 1 的契约登记；S2/S3 继续以契约忠实 mock 对端推进，不受该缺口阻塞。

## 6. 纪律不变条款

本指令不改变 AGENTS.md 任何常驻硬约束：S1 闭合后即停；S2 未收到书面启动指令不得启动；内核仓只读；无 GPU、无真实 Provider；零 npm 运行时依赖；pin 不自动升级；文档整改仅限本指令替换表范围。
