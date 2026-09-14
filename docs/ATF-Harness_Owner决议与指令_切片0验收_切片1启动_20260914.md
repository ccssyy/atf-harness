# ATF-Harness Owner 决议与指令——切片 0 验收 ＋ 推送授权 ＋ 切片 1 启动

**签发**：owner
**日期**：2026-09-14
**执行方**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**依据**：《ATF独立Harness_切片0任务书_决策类型拆分与守卫_20260914.md》＋《切片 0 执行报告》（`8483567`）＋《agent-loop 设计（已升格）》
**结论先行**：**切片 0 验收通过**（治理破口已由"约定"变为"类型不可表达 ＋ 运行时拒绝"，且有留痕可审计）；授权推送本批 4 笔；**切片 1（loop 骨架）启动**（任务书另文）。

---

## 1. 切片 0 验收复核（owner 独立核验）

| 验收项 | 复核方式 | 结果 |
|---|---|---|
| 提交与合回 | `git log` | ✅ `67d0b4b`（feat）→ `662e8d8`（merge，短命分支已删）→ `8483567`（报告）；本地 3 笔未推 |
| 类型边界（VERIFY 1） | 直读 `provider.ts` ＋ 用例 | ✅ `LlmDecision` 独立定义为恰好三成员（`tool_call` / `assistant_message` / `final_answer`）；**编译期证明**由 `@ts-expect-error` ＋ tsc 门承担（四类脚本指令赋值即类型错误） |
| 守卫（VERIFY 2/3/6） | 直读实现 ＋ 用例 ＋ 报告 §4 | ✅ `assertModelDecision` 作用于 **provider 返回值入口**，白名单 ＋ **字段闭集**（面外字段同样拒绝）；四类脚本指令经 provider 返回 → `failed` ＋ **`model_decision_forbidden`** ＋ exit 1（**不新增退出码**）＋ 留痕事件（`assistant/attempt{rejected_type, reason}`）＋ `turn/end{reason:"failed"}` 收口，**replay 可重建** |
| 能力保全（VERIFY 4） | 直读用例 ＋ 报告 §4 | ✅ 默认脚本路径 `scratch_write → promote`（复现命令须独立重产同字节）→ `completed` ＋ `promoted: true` ＋ catalog 恰 1 条；**晋升闸 A 三闸零改动**。旁证很硬：首版测试用 `cat` 被复现闸**正确拒绝**，改 `node -e` 才通过——说明闸门语义与既有实现一致 |
| 零回归（VERIFY 5） | **owner 独立复跑** | ✅ 真对端轨 **`215 passed / 1 skipped`**（原 207/1，+8）；mock 轨 **`210 passed / 9 skipped`**（原 202/9，+8）；四条冒烟 `s5` / `p2s2` / `p2s3` 全过、`r2` 无路径优雅 skip |
| 范围纪律 | `git diff --stat` | ✅ 改动面＝`src/llm/`（5 文件类型面）＋ `src/run/runner.ts`（守卫接入/分派区）＋ 新测试 `tests/run/decisionGuard.test.ts` ＋ docs；**`bridge.contract.yaml` 零改动**、`src/session/` 与 `src/workspace/` 零改动 |
| 条款与映射 | 直读报告 §3/§6 | ✅ 条款级完成清单 **19 项** ＋ 改动→设计条款映射表 **8 项** |
| 纪律 | 复核 | ✅ 内核仓零改动；`dependencies` 恒空；脱敏与通用性红线延续 |

## 2. 保全路径裁定：**(b) Faux 角色调整 —— 追认**

所选路径：Faux 保留"脚本执行器"角色，但**不再实现 `LlmProvider`**，改实现测试供应商接口 **`ScriptedStepSource`**（`decisionFace: "script"` 显式标注非模型面）；registry 工厂类型同步收窄；runner 决策面改双轨（`LlmProvider | ScriptedStepSource`），守卫按 `decisionFace` **类型级分流**。

**owner 判定：追认。** 理由与报告一致——路径 (a)（测试路径直连 branch.steps）需绕开 provider 抽象点重接 P2-S3 切换协议与 turn 归属，diff 更大且侵入切换机制；路径 (b) 是纯类型面手术，且**逐字满足**"守卫作用域 = provider 接口返回值"。另注意到它额外提供了**可测性 seam**（`RunBranchOptions.modelProvider?`，缺省不注入 → 既有路径逐位不变），这是必要的，否则守卫正反例无法在真链路上测。

## 3. 一处观察（登记，不阻塞）

留痕载体**借用了既有的 `assistant/attempt` 事件类型**（携 `rejected_type` ＋ `reason`）。这符合"不新增第 13 类事件"的纪律，且 payload 可判别；但严格说这是一次**语义借用**——`assistant/attempt` 的本义是"模型尝试输出"。**登记**：若日后审计需要独立检索"守卫拒绝"，届时应评估升级为显式 `kind` 字段（纯增量）或独立事件（须走 13 类扩面）。本批不改。

## 4. 授权推送（4 笔）

1. **推送前强制复跑**：
   ```bash
   ATF_CLI_PATH=/data/sam/ATF-Harness/.atf-pinned npm test   # 底线：215 passed / 1 skipped
   npm test                                                   # 底线：210 passed / 9 skipped
   npm run smoke:s5 && npm run smoke:p2s2 && npm run smoke:p2s3 && npm run smoke:r2
   ```
   任何偏差立即停止并报告 owner。
2. **入库**：`docs/ATF-TEM_接入设计_双消费者_20260914.md`（owner 投放，现为未跟踪）→ 一笔。
3. **推送**：`git push origin main`——切片 0 三笔（`67d0b4b` / `662e8d8` / `8483567`）＋ TEM 设计笔。
4. 推送后确认 `git rev-list --count HEAD..origin/main` = 0。

## 5. 切片 1 启动

按《ATF独立Harness_切片1任务书_loop骨架_20260914.md》执行（排序表中"切片 0 闭合后启动"的条件已满足）。要点：**终止判据 ＋ 轮次预算 ＋ step 元数据**（A1/A2/A4/A5 落地）＋ 契约纯增量补登；**不含** adapter/多工具展开（属切片 2）。

## 6. 纪律

1. 切片 1 未闭合前不得启动切片 2（同文件区域：`runner.ts` 的 loop 区）。
2. 切片 0 的守卫**继续生效**且不得放宽；`model_decision_forbidden` 不得被降级为警告。
3. 推送/标签授权边界不变；后续推送须另行提请 owner。
4. 会话边界与脱敏红线延续。
