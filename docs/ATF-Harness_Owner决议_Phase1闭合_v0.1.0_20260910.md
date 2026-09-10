# ATF-Harness Owner 决议——Phase 1 闭合（S5 批准 + push + tag v0.1.0 + 任务书 CLOSED）

**签发人**：owner
**日期**：2026-09-10
**执行人**：zcode（A800_5005:/data/sam/ATF-Harness）
**性质**：Phase 1 整体闭合决议（终局性）

---

## 0. 决议摘要

针对《ATF独立Harness_Phase1_S5执行报告暨Phase1闭合报告_20260909.md》（`77e4dae`）：

| # | 决议 | 内容 |
|---|---|---|
| 1 | S5 八项自主决策 ①–⑧ | **全部批准**为正式口径（工作区动作不落会话事件 / SurfaceScanResolver 复用 surface_scan 通道 / 终局语义保护 / 场景 schema 内聚 scenario.ts 等，以报告 §5 登记为准） |
| 2 | S5 执行报告 | **验收通过**，七项总验收确认 |
| 3 | push 授权 | `9debfac`（feat llm,run）+ `77e4dae`（docs 报告） |
| 4 | milestone tag | 打 **annotated tag `v0.1.0`**（Phase 1 冒烟验收通过，任务书 §8.1） |
| 5 | 任务书状态 | 《ATF独立Harness_Phase1任务书_20260908.md》标记 **CLOSED** |
| 6 | 存档建议（批准执行） | 仓内 6 份未跟踪的 owner 指令/决议文档一并入库，补全审计链 |

## 1. 执行序列（严格按序）

1. **push 前强制复跑**：
   ```bash
   ATF_CLI_PATH=/data/sam/ATF-Harness/.atf-pinned npx vitest run
   ```
   底线：**109 passed / 2 skipped**，不得回归。任何偏差立即停止并报告 owner。
2. **push 两个待批提交**：`9debfac` + `77e4dae` → origin/main。
3. **owner 指令文档入库**：`git add docs/ATF-Harness_Owner*.md`（当前 6 份未跟踪文件：S1 审查执行指令、S2 启动指令、S2闭合_S3启动、S3闭合_S4启动、S4闭合_S5启动、本文件），提交信息建议 `docs(owner): Phase 1 全程 owner 指令/决议文档入库存档`。这些是 zcode 的执行依据，入库存证后 Phase 1 复盘可完整追溯"owner 决议 → zcode 执行 → 报告 → review"闭环。
4. **任务书标记 CLOSED**：在《ATF独立Harness_Phase1任务书_20260908.md》**文档头部**添加状态块（正文内容零改动）：
   > **状态：CLOSED（2026-09-10）** —— Phase 1 五切片（S1–S5）全部验收闭合，milestone tag `v0.1.0`。终验数字：109 passed / 2 skipped，smoke:s1–s5 全过。后续工作转 Phase 2（待 owner 启动指令），见《ATF独立Harness_Phase1_S5执行报告暨Phase1闭合报告_20260909.md》§8。
   
   单独提交，建议信息：`docs(phase1): 任务书标记 CLOSED——Phase 1 闭合，tag v0.1.0`。
5. **复跑测试确认**（同第 1 步口径，109/2 不变）。
6. **打 tag 并推送**：
   ```bash
   git tag -a v0.1.0 -m "Phase 1 closed: headless smoke minimal loop (S1 bridge / S2 session / S3 tools+approval / S4 workspace / S5 faux provider). 109 passed / 2 skipped, smoke s1-s5 all green, kernel repo untouched (pinned v0.2.0b7)."
   git push origin main --follow-tags
   ```
7. **产出《Phase 1 闭合存证简报》**（简短即可）：记录 push/tag/CLOSED 三个动作的 commit sha 与 tag 指向，落 docs/，随最后提交推送。

## 2. 纪律条款

1. 本指令执行完毕后，**Phase 1 正式关闭**；zcode 停在 Phase 2 议题前。
2. Phase 2 范围（报告 §8 清单：compaction / 多 provider / 交互问答轨 / 晋升闸 B / fsync 策略 / 真实对端接入）**未获 owner 书面启动指令前，一律不得开工**，包括探索性调研。
3. 内核仓只读纪律永久有效：pin `v0.2.0b7` 不动，re-pin 需 owner 专项指令（待内核 JSONL 会话能力发版落 tag 后另行签发）。
4. tag 打出后**不得移动或删除**；如发现 push 后问题，报告 owner 处置，禁止自行 force 操作。

## 3. 边界与登记

- ②号决议（内核 JSONL 会话能力立项）的落地责任在 owner 主线，不在本仓范围；`known_gaps → decision_20260908` 登记维持现状。
- Phase 2 待决清单以 S5 报告 §8 为准，本指令不新增、不删减。
