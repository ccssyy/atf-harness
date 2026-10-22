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

## 复验结果登记表（复验会话填写）

| 项 | 结果（PASS/FAIL/BLOCKED） | 证据文件 | 备注 |
|---|---|---|---|
| A | | | |
| B | | | |
| C | | | |
| D | | | |
| E | | | |
| F | | | |
| G | | | |
| H | | | |
| I | | | |
| J | | | |
