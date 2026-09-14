# ATF-Harness Owner 指令——执行报告推送授权 ＋ re-pin 前置状态盘点

**签发**：owner
**日期**：2026-09-14
**执行方**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**性质**：推送授权（1 笔）＋ re-pin 前置状态说明（**本指令不触发 re-pin 动作**）
**依据**：《ATF-Harness_Owner指令_版本轴修正与推送_20260913.md》＋《ATF内核_Owner决议与指令_B2-2验收_批次二闭合与发版_20260914.md》
**结论先行**：**授权推送本地剩余 1 笔**（`af94692` 版本轴修正执行报告）；**re-pin 四要素已齐备三项**，待内核侧批次二 tag `v0.6.0b0` 落定后，由 owner 另发 **re-pin 专项指令**——本指令不启动 re-pin、不启动 Phase 3。

---

## 1. 推送授权（1 笔）

1. **推送前强制复跑**：
   ```bash
   ATF_CLI_PATH=/data/sam/ATF-Harness/.atf-pinned npm test   # 底线：200 passed / 2 skipped
   npm run smoke:s5 && npm run smoke:p2s2 && npm run smoke:p2s3
   ```
   任何偏差立即停止并报告 owner。
2. **推送**：`git push origin main`（`af94692`，1 笔）→ 推送后 `git rev-list --count HEAD..origin/main` 应为 0。
3. 完成后即停。

## 2. re-pin 前置状态盘点（owner 侧实测）

| # | 前置要素 | 状态 |
|---|---|---|
| 1 | 契约 v2（方法面 / 账本键模型 / `scope_ref` / `warn` / `fact_scan` 改名） | ✅ 已推送（`a6814f7`、`f2ec34a`） |
| 2 | `atf.bind_run` 方法面补登 | ✅ 已推送（`2596136`、`d69b28f`） |
| 3 | 版本轴修正（双轴明确） | ✅ 已推送（`f87d429`）；执行报告待本次推送 |
| 4 | 内核侧批次二（方法面落地 + tag） | ⏳ tag `v0.6.0b0` 待内核侧按同期指令打出并推送 |

**四项齐备后**，owner 将签发 **re-pin 专项指令**，届时另批（预告范围，勿提前执行）：
1. `bridge.contract.yaml` 的 `atf_upstream` 由 `v0.2.0b7` 改为 **`v0.6.0b0`**（bump pin，含基线数字更新）；
2. 契约测试从"pin 校验 + `--help` 冒烟"扩展到**真实 CLI 会话断言**（启用当前 2 个 skipped 用例）；
3. mock 对端逐项替换为**真实内核**会话（工具方法、账本方法、`bind_run`）；
4. 双仓契约测试全绿 + 变更描述标注（契约变更流程：显式 PR + 双仓契约测试 + owner review）。

## 3. 纪律

1. 本指令只授权推送 1 笔；**不做 pin 变更、不启 Phase 3、不碰内核仓**。
2. `atf_upstream` pin 在 re-pin 专项指令到达前保持 `v0.2.0b7`。
3. 会话边界：harness 侧会话只在本仓作业；收到内核侧任务先停下提请 owner。
