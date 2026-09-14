# ATF-Harness Owner 指令——re-pin R1 验收（推送授权 + AGENTS pin 行更新）

**签发**：owner
**日期**：2026-09-14
**执行方**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**依据**：《ATF-Harness_Owner指令_re-pin专项_R1_20260914.md》＋《ATF-Harness_re-pinR1执行报告_20260914.md》
**结论先行**：**R1 验收通过**（pin 已切 `v0.6.0b0`，真实会话断言在真内核上通过）；**追认 `src/bridge/atfCommand.ts` 一处偏离**；**授权推送 2 笔**，并**授权更新 `AGENTS.md` §4 的 pin 行**。

---

## 1. R1 验收复核（owner 独立核验）

| 验收项 | 复核方式 | 结果 |
|---|---|---|
| pin 副本 | `git -C .atf-pinned rev-parse HEAD` | ✅ **`b6db3496b34089147044be9c6b9a0a7ceb595e3a`**（由 `a628f8b` 切换） |
| 契约 pin 块 | 直读 `bridge.contract.yaml` | ✅ tag `v0.6.0b0` / 全 sha / `pinned_at: 2026-09-14` / baseline `1235 passed / 128 skipped（合计 1363）` / **`contract_version` 保持 1** |
| `derive_command.env` | 直读 | ✅ 已补 `ATF_SKILLS_AUTO_INSTALL: "0"`（含原因注释） |
| 契约测试 | **owner 独立复跑**（设 `ATF_CLI_PATH`） | ✅ **`202 passed / 1 skipped`**——原 2 个占位 skip 已成**真实会话断言并通过**；剩余 1 个为"未设置 `ATF_CLI_PATH` 时整组跳过"的有意占位 |
| 真实对端原始输出 | 直读报告 §3.2 | ✅ 真探针（隔离 HOME + `ATF_SKILLS_AUTO_INSTALL=0`，副本 @ `v0.6.0b0`）：握手 `{"contract_version": 1, "name": "atf", "version": "0.6.0b0"}`、`method_not_found` 连接保持、id 逐条配对 → **版本轴修正与 pin 切换在真实对端上同时成立** |
| 隔离与不动项 | 复核两仓 | ✅ mock `mock_atf.mjs` 未改动；**内核仓零改动**（0/0，工作树仅既有未跟踪计划文件）；`src` 业务语义零改动 |
| 提交 | `git log` | ✅ `fce4227`（feat R1）＋ `592f703`（执行报告），本地 2 笔未推 |

## 2. 偏离追认（一处）

`src/bridge/atfCommand.ts`（+9/−2）不在指令 §4.4 的 diff 枚举内，属两类**必要性面**：

1. `ATF_UPSTREAM_TAG` / `ATF_UPSTREAM_COMMIT_SHA` 为契约 pin 块的**测试承载镜像**（唯一真相源仍是契约 `atf_upstream`），不同步则 pin 校验必红；
2. `deriveAtfCommand` 的 env 与契约 `derive_command.env` 一一对应，不补 `ATF_SKILLS_AUTO_INSTALL=0` 则 `--help` 冒烟即触发内核技能自举写用户目录，违反隔离纪律。

**owner 裁决：追认**（无业务语义变更；已按规范在报告 §5 显式披露）。适用范围：**pin 同步与配置镜像的必要性面**，不构成"可自行扩充 src 改动面"的先例。

## 3. 授权动作

### 3.1 推送（2 笔）

1. **推送前强制复跑**：
   ```bash
   ATF_CLI_PATH=/data/sam/ATF-Harness/.atf-pinned npm test   # 底线：202 passed / 1 skipped
   npm run smoke:s5 && npm run smoke:p2s2 && npm run smoke:p2s3
   ```
   任何偏差立即停止并报告 owner。
2. **在推送前先完成 §3.2 的 AGENTS.md 更新**（同一批推送，3 笔）。
3. **推送**：`git push origin main`；推送后 `git rev-list --count HEAD..origin/main` 应为 0。

### 3.2 `AGENTS.md` §4 pin 行更新（owner 授权）

- **授权范围**：仅更新 §4「契约与 pin 管理」中"**当前 pin：tag `v0.2.0b7`（commit `a628f8b`，2026-09-08；…）**"这一行为 `v0.6.0b0`（commit `b6db3496b34089147044be9c6b9a0a7ceb595e3a`，2026-09-14），并可顺带把该行的能力描述更新为"会话方法面 7 方法（含 `atf.bind_run`）"。
- **不得改动**该文件其他条款（分支模型、硬约束、契约变更纪律等一律照旧）。
- 提交信息建议：`docs(owner): AGENTS.md §4 pin 行同步至 v0.6.0b0（owner 授权）`。

## 4. 纪律

1. **pin 只落 tag**；本次 pin 落 `v0.6.0b0`，禁止追 main 中间态。
2. 桥接契约版本轴（2）不随 re-pin 变动；会话协议轴（1）与内核一致。
3. 本次不动 mock、不做真实写动作（R2 范围）。
4. 会话边界：harness 侧会话只在本仓作业。

## 5. 下一步

**R2 任务书已同时签发**：《ATF独立Harness_R2任务书_真实对端夹具与工具面端到端_20260914.md》（两道门：先交夹具设计 → owner review → 再谈真实写授权与实现）。本指令完成后即按 R2 门 1 执行。
