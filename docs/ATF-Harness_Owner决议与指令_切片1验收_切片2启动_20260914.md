# ATF-Harness Owner 决议与指令——切片 1 验收 ＋ 推送授权 ＋ 切片 2 启动

**签发**：owner
**日期**：2026-09-14
**执行方**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**依据**：《ATF独立Harness_切片1任务书_loop骨架_20260914.md》＋《切片 1 执行报告》（`4f2bf64`）＋《ATF-TEM_接入设计_双消费者_20260914.md》
**结论先行**：**切片 1 验收通过**；授权推送 3 笔；**切片 2 启动**（任务书另文）。

---

## 1. 切片 1 验收复核（owner 独立核验）

| 验收项（任务书 §3） | 复核方式 | 结果 |
|---|---|---|
| 1 四重判据收敛 | 直读 `stopReason.ts` ＋ 用例 | ✅ 五值枚举落在新文件；`final_answer`→completed(0)、`no_more_tools`→completed(0)（纯函数 `resolveExhaustionStop`）、`error`→failed(1)、`aborted`→aborted(79)，各有用例 |
| 2 预算耗尽 | 直读 ＋ 用例 | ✅ `LOOP_MAX_STEPS_PER_TURN=32` / `LOOP_MAX_TURNS=8`（`src/session/constants.ts`）；超限 → `failed(budget_exhausted)` ＋ **exit 1**（不新增退出码）；段分支超 `max_turns` 亦有独立用例 |
| 3 预算不可见 | 用例 ＋ 契约注记 | ✅ 用例断言"注入上下文不出现预算常量名或值、决策对象类型面无预算字段"；契约给出**结构性理由**（`llm_context_event_fields` 白名单不含预算字段位） |
| 4 step 元数据 | 用例 | ✅ `turn/end.payload` **恒填** `step_count` / `decision_count`，且可由事件流推导（对账用例） |
| 5 "以可执行内容为准" | 用例 ×2 | ✅ 完整工具请求已产出后被截断 → **仍执行**（`tool/result` 在场）随后 `failed(error)`；声称完成但无 `final_answer` 且无待处理动作 → **判未收束** |
| 6 不变量 | 用例 ＋ 文档 | ✅ INV-1/2/3 各有断言（终局 turn 成对收口；switch 事件仅存在于 turn 边界之间） |
| 7 零回归 | **owner 独立复跑** | ✅ 真对端轨 **`226 passed / 1 skipped`**（原 215/1，+11）；mock 轨 **`221 passed / 9 skipped`**（原 210/9，+11）；四条冒烟 `s5`/`p2s2`/`p2s3` 全过、`r2` 无路径优雅 skip |
| 8 契约 | 直读 diff | ✅ `session.contract.yaml` **+16 纯增量注记**（两字段恒填 ＋ 一个可选字段 ＋ 预算不可见），**两个版本轴均不 bump、不新增事件类型**；`bridge.contract.yaml` **零改动** |
| 范围纪律 | `git diff --stat` | ✅ 未碰 `src/llm/`（**守卫未放宽**）、未碰 `src/workspace/`、未做切片 2 内容；短命分支已删 |
| 条款与映射 | 直读报告 | ✅ 条款级完成清单 **12 项** ＋ 改动→设计条款映射 **6 项** |

## 2. 既有缺口修复（INV-2）：**追认**

报告披露：`provider` 返回 `err` 的路径此前**不收口 turn 即 break**（违反 INV-2），本切片以 `{reason:"failed", stop_reason:"error"}` 收口。

**owner 判定：追认。** 影响面已如实说明（Faux 回放永不 `err` → 该路径此前不可达 → 事件序列对既有用例零影响）；并诚实标注边界：**落盘通道本身失效时收口不可行**，由 `session_failure` 终局承载。这是切片 1 的额外收益（骨架顺带修了不变量缺口），不是范围扩张。

## 3. 授权推送（3 笔）

1. **推送前强制复跑**：
   ```bash
   ATF_CLI_PATH=/data/sam/ATF-Harness/.atf-pinned npm test   # 底线：226 passed / 1 skipped
   npm test                                                   # 底线：221 passed / 9 skipped
   npm run smoke:s5 && npm run smoke:p2s2 && npm run smoke:p2s3 && npm run smoke:r2
   ```
   任何偏差立即停止并报告 owner。
2. **推送**：`git push origin main`——`1527724`（feat 切片 1）／`20bb4e6`（merge）／`4f2bf64`（报告）。
3. 推送后确认 `git rev-list --count HEAD..origin/main` = 0。

## 4. 切片 2 启动

按《ATF独立Harness_切片2任务书_adapter与公理兑现_20260914.md》执行。**关键澄清（N1 落地）**：`gate/advance-ack` 这个建议名**不作为新增事件类型**实现——闸门推进的"客户端观察事实"**已有载体＝既有的 `tool/result` 事件**（记录"我方调用 atf_gate 并收到 pass"）。因此 N1 在本切片的落地是**语义边界 ＋ 断言 ＋ 文档纪律**，而非新增机制（若将来确需独立事件，须走第 13 类扩面 ＋ owner 批准）。

## 5. 纪律

1. 切片 2 未闭合前不启动切片 3/L1a；切片 0/1 的守卫与预算**不得放宽**。
2. 预算默认值（32 / 8）如需调整须提请 owner。
3. 推送/标签授权边界不变；后续推送须另行提请 owner。
4. 会话边界与脱敏红线延续；内核仓只读；`dependencies` 恒空。
