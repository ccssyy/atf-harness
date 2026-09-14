# ATF-Harness Owner 决议与指令——R2 门 2 验收 ＋ agent-loop 门 1 通过（升格）＋ 推送授权与切片排序

**签发**：owner
**日期**：2026-09-14
**执行方**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**依据**：《ATF-Harness_Owner决议与指令_R2门1评审_门2放行_20260914.md》＋《ATF-Harness_agent-loop设计_门1讨论稿_20260914.md》＋《ATF-Harness_Owner分析与架构方案_项目态势与训练Agent_20260914.md》＋《ATF独立Harness_切片0任务书_决策类型拆分与守卫_20260914.md》
**结论先行**：**R2 门 2 验收通过**，授权推送（R2 四笔 ＋ 本批 owner 文档入库）；**agent-loop 讨论稿升格为正式设计（门 1 通过）**，D1–D8 与 N1/N2 裁决如下；**切片排序定死：切片 0（已启动）→ 切片 1（待切片 0 闭合）→ 切片 2 → L1a → L1 → L2**。

---

## 1. R2 门 2 验收复核（owner 独立核验）

| 验收项 | 复核方式 | 结果 |
|---|---|---|
| 提交与合回 | `git log` | ✅ `3f8656a`（feat 门 2）→ `c4c0043`（merge，短命分支已删）→ `2669d8c`（执行报告）；本地 4 笔未推（含门 1 设计 `0dc75b2`） |
| 改动面 | `git diff --stat 0dc75b2..HEAD` | ✅ 10 文件 +1246/−1：`tests/run/realPeer/{fixture.ts, e2eChain.test.ts, failClosed.test.ts}`、`src/run/smokeR2.ts`、`bridge.contract.yaml`（+9，`pin` 参数补登）、`src/tools/toolDefinition.ts`（+3）、`package.json`、契约文件自检、报告 |
| 双轨（owner 复跑） | 设/不设 `ATF_CLI_PATH` | ✅ 设：**`207 passed / 1 skipped`**；不设：**`202 passed / 9 skipped`**（真对端组优雅跳过，mock 轨零回归） |
| `smoke:r2` | owner 执行 | ✅ 无 `ATF_CLI_PATH` 时优雅 skip（mock 轨完整可用） |
| 端到端主链 | 直读用例输出 | ✅ `bind_run → status → fact_scan → G 系 query → admit_data（落盘）→ G 系 advance → query 反读 → 优雅关闭` |
| fail-closed 反例 | 直读用例输出 | ✅ 八类反例逐一命中预期错误码且**错误后连接保持** |
| 注入式账本链路（D1） | 直读用例 | ✅ 预录链 query → consume（一次性）→ 重复消费 `approval_already_consumed` → `include_consumed` 复读 |
| 三项边界标注 | 直读报告 §5.3 | ✅ 如实入档：场景迁移另批 ／ **"内存登记"不得写成"已落盘"**（验证口径 = 同会话 query 反读）／ **R2 验收通过 ≠ 业务级可用** |
| 真实写范围 | 复核 | ✅ 仅 `/tmp/atf-r2-*` 夹具根内合成数据；落盘证据齐备 |
| mock 退役评估 | 直读报告 | ✅ 建议**保留**（附 4 项差异清单与触发条件）；本批不退役 |
| 内核三议题 | 直读报告 | ✅ 已确认登记，harness 侧以注入式对端 + 边界标注过渡（不插队） |

**R2 门 2 状态：通过。**

## 2. agent-loop 讨论稿：门 1 通过（升格为正式设计）

**裁决汇总**：

| # | 裁决点 | 裁决 |
|---|---|---|
| D1 | A1 step 粒度 | **不新增事件类型**；`turn/end.payload` 补 `step_count`/`decision_count`（纯增量，不 bump 桥接契约轴） |
| D2 | A2 终止判据 | **裁剪版四重判据 ＋ 显式轮次预算**（`max_steps_per_turn` 32 / `max_turns` 8，收在常量层、**模型不可见**）；`stopReason` 枚举扩面；**不新增退出码**（预算耗尽 = `failed(budget_exhausted)`，复用 exit 1） |
| D3 | A3 工具批次 | **显式拒绝并行**；一次决策一个工具；多工具响应由 adapter 展开为顺序决策 |
| D4 | A4 审批与 turn | **维持现状**（审批嵌在 turn 内；挂起以 `turn/end{reason:"suspended"}` 收口；resume 开新 turn）；固化 INV-1/2/3 |
| D5 | A5 第 13 类事件 | **本切片不新增**；保留位机制承接 |
| D6 | 类型拆分是否单列先行 | **是，并升格为"治理前置"** → 切片 0 任务书已签发（见 §4） |
| D7 | 讨论稿是否升格 | **通过**：讨论稿升格为正式设计（文件状态头已更新），后续据此签发切片任务书 |
| D8 | 内核三议题是否登记为 Phase 3 前置 | **是**（已登记于内核 `_docs/`；其中"审批跨进程可见性"直接决定 P3-1 可行域） |
| **N1** | 闸门推进留痕语义 | **采纳**：本侧留痕只能表述为**客户端观察事实**（建议事件命名 `gate/advance-ack`），**不得**当作内核状态的权威副本（防将来内核持久化落地后出现两个真相源） |
| **N2** | 是否采纳 L1a 中间台阶 | **采纳**：**L1a ＝ 真实 provider ＋ 一条最小人工应答通道**（模型自主只读；遇高危写动作挂起 exit 75 等人工放行），登记为**"可试用里程碑"**并入 Phase 3 前置清单（排在 L1/ACP 之前） |

## 3. 授权动作

### 3.1 入库两份 owner 文档

- `docs/ATF-Harness_Owner分析与架构方案_项目态势与训练Agent_20260914.md`（本次已投放）
- `docs/ATF独立Harness_切片0任务书_决策类型拆分与守卫_20260914.md`（本次已投放）
- `docs/ATF-Harness_agent-loop设计_门1讨论稿_20260914.md`（**升格版**：状态头已更新为"已升格为正式设计（门 1 通过）"，本次已投放）

### 3.2 推送（一次完成）

1. **推送前强制复跑**：
   ```bash
   ATF_CLI_PATH=/data/sam/ATF-Harness/.atf-pinned npm test   # 底线：207 passed / 1 skipped
   npm test                                                   # 底线：202 passed / 9 skipped
   npm run smoke:s5 && npm run smoke:p2s2 && npm run smoke:p2s3 && npm run smoke:r2
   ```
   任何偏差立即停止并报告 owner。
2. **入库**：上述三份 owner 文档（可分两笔：分析与任务书一笔、升格版讨论稿一笔；或合并为一笔，报告说明即可）。
3. **推送**：`git push origin main`——R2 四笔（`0dc75b2` / `3f8656a` / `c4c0043` / `2669d8c`）＋ 本批文档笔。
4. 推送后确认 `git rev-list --count HEAD..origin/main` = 0。

## 4. 切片排序（定死，串行）

| 顺序 | 切片 | 状态 | 启动条件 |
|---|---|---|---|
| ① | **切片 0**：决策类型拆分 ＋ 运行时守卫（**治理前置**） | **已启动**（任务书已签发） | 无依赖 |
| ② | 切片 1：loop 骨架（终止判据 ＋ 预算 ＋ step 元数据） | 待启动 | **切片 0 闭合后**（两者都改 `runner.ts` 的决策分派/loop 区域，串行避免冲突） |
| ③ | 切片 2：adapter 契约 ＋ 多工具展开 ＋ 错误回填 ＋ 公理兑现（N1 措辞） | 待启动 | 切片 1 闭合后 |
| ④ | **L1a**：真实 provider ＋ 最小人工应答通道 | 待启动 | 切片 2 闭合 ＋ owner 对**真实 provider** 的显式授权 ＋ 新 snapshot/binding |
| ⑤ | L1：ACP 宿主嵌入 ＋ 审批人在回路 | Phase 3 主体 | 宿主实现 |
| ⑥ | L2：真实 run / 真实数据 | — | 内核议题① ＋ owner 对真实 effect 的授权 |

## 5. 纪律

1. **切片 0 不得因"省事"放宽守卫**，也不得顺手加新机制；既有 `promote` 能力（测试路径）必须保留。
2. 切片 0 与 R2 的推送可并行，但**切片 1 必须等切片 0 闭合**（同文件区域）。
3. push / tag 授权边界不变：本批授权仅限 §3.2 范围；后续推送须另行提交 owner。
4. 会话边界：harness 侧只在本仓作业；内核仓只读。
5. 脱敏与通用性红线延续。
