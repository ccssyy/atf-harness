# 批次 R · b4 复验清单（VERIFY_CHECKLIST）— 2026-10-22

> **落盘纪律**：本文件位于 `docs/_owner/`（.gitignore 内，既定纪律＝指令/报告落盘不进
> git），不 tracked、不随分支提交——对批次 R 指令分工表为已知偏离（H2 回报已列明）。
> **本会话（批次 R · H2）未执行任何复验**：内核 b4 未发版、本会话不重启 dev。下列全部
> 可执行片段**本会话未运行**，仅供复验时取证。

## 执行前提（三项全备才开验；任一未备＝BLOCKED，回报 owner）

1. **内核 b4 发版完成**且 harness re-pin 由 owner 按 re-pin 三步排期执行；
2. **H1（fix/h1-tokenbudget-card）已合入 main**（G/H 两项依赖 H1 产出）；
3. dev 实例净室重启：`npm run build && deploy/instances/instance-restart.sh dev`
   （顺序不可反——出处：`tests/dshUi/smoke_d11_monitor_browser.py` 前置注记；本批纪律＝重启由 owner 排期）。

## 通用取证约定

- **证据目录**＝本目录（`docs/_owner/批次R_evidence_20261022/`）；截图命名
  `R-<项号>-<主题>-<序号>.png`（例：`R-A-session-chip-01.png`）；文件类证据原样拷贝
  ＋同名 `.txt` 摘录（沿 `docs/_owner/B2_取证_20261020/` 惯例）。
- **失败即停（逐项同款声明）**：该项任一子判定不成立 → 立即停止后续项，登记失败项、
  截图与现场文件清单，回报 owner 裁定；**不得现场修补、不得重跑掩盖、不得放宽判定**。
- UI 驱动沿仓内真机冒烟先例：`python3 tests/dshUi/smoke_*_browser.py`（playwright 真实
  浏览器，产出截图＋ALL PASS／FAILURES 摘要，退出码 0＝全绿——出处：
  `tests/dshUi/smoke_b2_binding_browser.py`、`smoke_train_obs_fix2_browser.py` 头注）。

---

## A 会话/chip/选择器（判定：可开可切）

- **判定条件**：
  1. 顶栏会话 chip 正常呈现（未绑定/已绑定等态）；
  2. 点开共用选择面板，会话/run 分组可见；
  3. 切换到另一会话后 chip 与呈现面跟随切换（无残留旧会话态）。
- **取证方式**：截图（面板展开态＋切换前后两态，共 ≥2 张）。
- **证据文件名**：`R-A-session-chip-01.png`、`R-A-session-chip-02.png`。
- **可执行片段（本会话未运行）**：
  ```bash
  # 快照面辅助（键面/会话载荷——出处 tests/dshUi/sseEvents.test.ts 的 /atf-ui/snapshot）
  curl -s http://127.0.0.1:3080/atf-ui/snapshot | python3 -m json.tool | head -40
  ```
- 组件锚：`tests/dshUi/sessionBindingUi.test.ts`（顶栏 chip 三态／共用选择面板分组）。
- **失败即停**：适用（任一子判定不成立即停后续项）。

## B 切 run（判定：「全部」只读、显式才绑定）

- **判定条件**：
  1. 选择面板「全部」分组**只读**展示（无绑定按钮、不发起 POST）；
  2. 显式点击具体 run 才发起绑定 POST；
  3. 绑定后账本（session-bindings.json）与 UI 状态逐字一致。
- **取证方式**：截图（「全部」组＋显式绑定后态）＋账本文件拷贝。
- **证据文件名**：`R-B-run-scope-01.png`、`R-B-session-bindings.json.txt`。
- **可执行片段（本会话未运行）**：
  ```bash
  # 账本（出处 tests/dshUi/smoke_b2_binding_browser.py 的 LEDGER）
  cat /data/atf/instances/dev/atf-home/atf-state/session-bindings.json
  ```
- 组件锚：`tests/dshUi/sessionBindingUi.test.ts`（全部组只读不 POST）；真机幕④：
  `tests/dshUi/smoke_b2_binding_browser.py`。
- **失败即停**：适用。

## C 监控（判定：非空、滚到底见 GPU/日志/产物）

- **判定条件**：
  1. 监控面板非空（有内容渲染）；
  2. 面板滚动到底，依次可见 GPU 面板、训练日志尾部、产物清单（三段齐）。
- **取证方式**：截图（含滚到底全貌 ≥1 张）。
- **证据文件名**：`R-C-monitor-01.png`。
- **可执行片段（本会话未运行）**：
  ```bash
  # 快照键面辅助（出处同 A；监控投影数据源＝monitor.json，出处 smoke_train_obs.mts）
  curl -s http://127.0.0.1:3080/atf-ui/snapshot | python3 -c 'import json,sys; print(sorted(json.load(sys.stdin).keys()))'
  cat /data/atf/dev/runs/atf-ui/monitor.json | python3 -m json.tool | head -60
  ```
- 组件锚：`tests/dshUi/gpuPanelD11.test.ts`（GPU 面板）、`tests/dshUi/monitorScrollD17.test.ts`
  （滚到底）、真机 `tests/dshUi/smoke_d11_monitor_browser.py`（BASE=3080）。
- **失败即停**：适用。

## D 假活（判定：训练结束显示空闲、training.active=false）

- **判定条件**：
  1. 训练结束后 UI 状态从「训练中」回到「空闲」（无假活）；
  2. monitor.json 中该 run 的 `training.active` 为 `false`。
- **取证方式**：截图（训练结束后的状态面）＋monitor.json 摘录。
- **证据文件名**：`R-D-idle-01.png`、`R-D-monitor.json.txt`。
- **可执行片段（本会话未运行）**：
  ```bash
  # 出处 tests/dshUi/smoke_train_obs.mts（monitorPath=/data/atf/dev/runs/atf-ui/monitor.json；
  # training.active 判据＝loss 进料 startLossIngest）
  python3 -c 'import json; d=json.load(open("/data/atf/dev/runs/atf-ui/monitor.json")); print([(r.get("run_id"), (r.get("training") or {}).get("active")) for r in d.get("runs", [])])'
  ```
- 真机先例：`tests/dshUi/smoke_train_obs_fix2_browser.py`（训练观测链五截图）。
- **失败即停**：适用。

## E 进度（判定：progress 有 percentage/eta）

- **判定条件**：
  1. 卡面进度行呈现 percentage 与 ETA；
  2. progress.json 以 ~5s 颗粒更新，percentage 推进、eta_s 在盘。
- **取证方式**：截图＋progress.json 摘录（两次采样对比更佳）。
- **证据文件名**：`R-E-progress-01.png`、`R-E-progress.json.txt`。
- **可执行片段（本会话未运行）**：
  ```bash
  # 出处 tests/dshUi/smoke_train_obs.mts（progress.json eta_s/percentage 5s 颗粒断言）
  cat /data/atf/dev/runs/atf-ui/progress.json; sleep 6; cat /data/atf/dev/runs/atf-ui/progress.json
  ```
- **失败即停**：适用。

## F 评估状态（判定：只问不报参数名）

- **判定条件**：会话中询问评估状态，回复只描述状态/进度（就绪/排队/进行中等业务语），
  **不出现内部实现词**（port、kernelDir、registry 字段名、脚本路径等参数名）。
- **取证方式**：对话截图（问＋答完整同屏）。
- **证据文件名**：`R-F-eval-state-01.png`。
- **可执行片段（本会话未运行，辅助取证；判定以对话截图为准）**：
  ```bash
  # SSE 通知投影 3s 采样（出处 tests/dshUi/smoke_sse_stream.mts——curl -N 收流，超时退出码 28 属正常）
  curl -sN --max-time 3 http://127.0.0.1:3080/atf-ui/events
  ```
- 组件锚：`tests/dshUi/evalProgressTrack.test.ts`（通知投影摘要化）、
  `tests/dshUi/evalServiceHealth.test.ts`（零假健康——端口缺＝null 不造假）。
- **失败即停**：适用。

## G 预算卡（判定：三行、关系勾、无 65536、无别名）— 依赖 H1 合入

- **判定条件**：
  1. 九要素卡三行同屏：`max_total_tokens`（可编辑，9000 惯例基线，来源标注
     convention/user）、`cutoff_len`（只读，=预算）、`max_model_len`（只读，独立取值）；
  2. 两条关系不成立时红字（预算超训练截断／超推理窗口）且禁用确认；改预算与 cutoff
     不等时提示同步（同步是用户动作），不同步须填理由；
  3. 卡面**无 65536 预填**、全仓**无 `max_model_token` 别名**。
- **取证方式**：截图（正常态＋关系不成立红字态，≥2 张）。
- **证据文件名**：`R-G-budget-card-01.png`、`R-G-budget-card-02.png`。
- **可执行片段（本会话未运行）**：
  ```bash
  # 别名退役源码面零命中（H1 测试同款判定；在主工作区 main 合入后执行）
  git -C /data/sam/ATF-Harness grep -n "max_model_token" -- packages src tests
  ```
- 承载面（批次 R 指令 H1 注记）：`packages/extensions/atf-ui/src/server.ts`＋
  `packages/extensions/atf-tools/src/confirmFace.ts`（`src/webui/*` 为历史资产层，零 importer）。
- **失败即停**：适用。

## H 错误回流（判定：缺 provider 时人话＋下一步）— 依赖 H1 合入

- **判定条件**：受控制造缺失场景（provider 缺失／预算文件缺失，场景构造方式以 owner
  复验指令为准，本清单不发明构造）时，卡面/聊天显示**人话错误＋下一步指引**
  （如「预算文件缺失，先确认实验配置」），不出现裸内核错误码或堆栈。
- **取证方式**：截图（错误提示完整同屏，含下一步指引）。
- **证据文件名**：`R-H-error-flow-01.png`。
- **可执行片段（本会话未运行）**：对照口径＝批次 R 指令 H1-3 四错误码表
  （`token_budget_missing`／`token_budget_inconsistent:<detail>`／`token_gate_not_configured`／
  `gpu_capacity_insufficient`）；组件锚 `tests/llm/providerConfig.test.ts`（provider 配置面）。
- **失败即停**：适用。

## I B2c（判定：草稿「回到上次实验」）

- **判定条件**：
  1. 未绑定新会话（草稿态）呈现「回到上次实验」卡（title＋workspace）；
  2. 点击后 pending 且零 POST；sessionId 出现后恰一次 POST 正确 runId；
  3. 已绑定·有会话态不出卡。
- **取证方式**：截图（草稿卡在场＋点击绑定完成两态）。
- **证据文件名**：`R-I-draft-resume-01.png`、`R-I-draft-resume-02.png`。
- **可执行片段（本会话未运行）**：
  ```bash
  # 账本同 B 项；组件语义锚 tests/dshUi/draftResumeCard.test.ts（草稿卡五锚）
  cat /data/atf/instances/dev/atf-home/atf-state/session-bindings.json
  ```
- **失败即停**：适用。

## J D33–D36（判定：横幅/封存/数值/必填）

- **判定条件**：
  1. **D33 横幅**：GPU 排队时横幅在场、生命周期结束清零（`alerts.json` 落盘零动——呈现面）；
  2. **D34 封存**：「走完闭环」胶囊含封存步（事实日志＋锚点快照落盘），胶囊与面板页
     双钉同语义；
  3. **D35 数值**：引用值逐字一致（引用字段值原样拷贝源串，无千分位/小数点重排转写）；
  4. **D36 必填**：空值拦截兜底＋建议值前置（口径 `TRAINING_PIN_CONSTANTS` 单源）。
- **取证方式**：截图（横幅在场/清零两态、闭环胶囊、含引用数值的卡面、空值拦截红字）。
- **证据文件名**：`R-J-d33-banner-01.png`、`R-J-d34-closure-01.png`、
  `R-J-d35-literal-01.png`、`R-J-d36-required-01.png`。
- **可执行片段（本会话未运行）**：
  ```bash
  # 组件锚四件（复验时跑，全绿为 J 项组件面判据）
  cd /data/sam/ATF-Harness && npx vitest run \
    tests/dshUi/gpuPanelD11.test.ts \
    tests/dshUi/atfUi.test.ts \
    tests/dshTools/trainingFace.test.ts \
    tests/dshTools/askFormIntent.test.ts
  ```
- 锚点出处：`tests/dshUi/gpuPanelD11.test.ts`（D33）、`tests/dshUi/atfUi.test.ts`（D34
  CLOSURE_MESSAGE 双钉）、`tests/dshTools/trainingFace.test.ts`（D35 逐字一致）、
  `tests/dshTools/askFormIntent.test.ts`（D36 建议值前置）。
- **失败即停**：适用（四个子项任一不成立即停）。

---

## 复验结果登记表（2026-10-22 门 R0 · 复验会话已填写）

**boot 锚**：握手 `0.7.24b0`（日志实载＋UI 右栏「内核 real · v0.7.24b0」）；atf-tools 激活（桥接 9 件）；白名单根 **13**（上次 boot 12——差 1＝两次 boot 间工作区注册表新增 `ws-pl-walkthrough`/`ws-pl-walkthrough-r1`（G2 复验注册），环境演进非批次 R 引入：fileRoots 声明面与 instance env 零改动佐证）。

| 项 | 结果（PASS/FAIL/BLOCKED） | 证据文件 | 备注 |
|---|---|---|---|
| A | PASS | R-A-panel-groups-01.png、R-D-idle-01.png、R-B-explicit-bind-02.png | chip 已绑定态＋面板三分组（本会话/最近实验/全部实例只读）＋切换后 chip 跟随（实验 ugh-r1→实验 efault 实证）；sessionBindingUi 14/14 |
| B | PASS | R-B-explicit-bind-02.png、R-B-session-bindings.json.txt | 「全部实例（只读）」组头明示「点选只预览，不改变本会话绑定」且点行**零 POST**（458 请求零绑定）；显式点击恰一次 POST（#459）；账本 user_pick＋active_run_id 与 chip 逐字一致（复原操作 07:03:23 再次实证） |
| C | PASS | R-C-monitor-01.png（滚到底）、R-C-monitor-02-top.png（顶部） | 面板非空；GPU 段（忙 0/8·8G/640G·绑 0-7）＋训练产物清单＋训练日志区（该 run 无 trainer_log 数据＝数据面事实，区块在场）＋评估对比段 |
| D | PASS | R-D-idle-01.png、R-D-monitor.json.txt | chip「空闲」＋「训练已结束」卡同屏；monitor.json 73 runs `training.active` 唯一值集合＝{False} |
| E | BLOCKED | —（progress.json 不存在） | 无活跃训练可驱动 progress；真实训练启动需 owner 显式授权（不在本会话范围） |
| F | PASS | R-F-eval-state-01.png、R-F-eval-state-02-qa.png | 问「当前评估状态如何」→ 回复业务语（评估已完成收尾/无进程在跑/静态产物态＋产物交付物表）；无 port/kernelDir/registry 字段名/脚本路径 |
| G | PASS | R-G-budget-card-01.png、R-G-budget-card-02-violations.png、R-G-budget-card-03-dual-gate.png | 三行同屏（9000[惯例基线 owner 2026-10-22]／9000[=预算]／12800[独立取值]）；改 20000→三 ⚠（超训练截断/超推理窗口/不同步须理由）＋提交被拦不出审批卡＋来源切 [用户指定]；`token_budget_sync_reason` 理由行在场（不等必填）；无 65536 预填；`git grep max_model_token` 源码面 0 命中；tokenBudgetCard 25/25 |
| H | BLOCKED（组件面 PASS） | tests/llm/providerConfig.test.ts 28/28 | 受控缺失场景构造方式按清单预设留 owner 复验指令指定（未发明构造）；四错误码映射组件面绿 |
| I | PARTIAL（组件面 PASS） | R-I-draft-page-01.png、draftResumeCard 5/5 | 组件五锚全绿（title＋workspace/点击 pending 零 POST/sessionId 后恰一次 POST/已绑定不出卡）；**UI 面**：新会话草稿页（新版 Start 页布局）未渲染「回到上次实验」overlay 卡——呈现条件未满足，是否属新版布局行为变化待 owner 判定 |
| J | PASS（D34 执行面 N/A） | R-D-idle-01.png（走完闭环按钮）、R-G-budget-card-01.png（D35 数值/D36 建议）、组件锚四件 | D33：清零态在场（UI 无横幅＋alerts.json 缺席＋GPU 全闲）＋生命周期组件锚绿；D34：「走完闭环」按钮在场＋CLOSURE_MESSAGE 双钉锚绿，完整闭环执行 N/A（无新完成实验可闭环）；D35：trainingFace 逐字一致锚绿＋卡面数值行；D36：askFormIntent 建议值前置锚绿＋UI 空值提交被拒实证（服务端按权威值回流，空值未生效） |

**已知基线缺陷（非本批引入，登记待 owner 裁定）**：`tests/dshUi/gpuPanelD11.test.ts` 的 `appendGpuHistory` 用例失败——实现按 `new Date()`（真实当日 10-22）生成历史文件名，测试读固定日期 `gpu-history-20261019.jsonl` → ENOENT；**仅 2026-10-19 当日可通过**。证据：批次 R 对该测试与 server.ts gpu-history 段零改动（diff 0 行）；基线 f1c12927 版本即含此固定日期断言与 `new Date()` 实现（git show 逐字核实）；memory「B1 会话绑定批测试坑」有同款先例记录。

**组件锚汇总**：tokenBudgetCard 25/25｜providerConfig 28/28｜draftResumeCard 5/5｜sessionBindingUi 14/14｜trainingFace、askFormIntent、atfUi 于合并后子集回归（200 passed）全绿｜gpuPanelD11 14/15（1 项＝上述基线缺陷）。

**现场复原**：载体会话绑定经显式操作切回原 run `pl-walkthrough-r1`（账本 07:03:23 user_pick）；G 流程表单卡已 Cancel、审批卡已 Reject（配置未放行、训练未启动）。
