/** atf-ui client 半——GPU 状态一行卡＋快捷指令胶囊＋badcase viewer 内嵌浮层（批㉑三段＋批㉛段1）。
 *  品牌（批㊳ M3-2，档二 · 轴 C）：sidebar.brand.mark/name＋conversation.hero.brand.mark 三座位
 *  占位（沿官方 ui-brand-official 嵌套 inject 模式——官方占位被 build profile gate 关闭，
 *  非 official 构建座位空置，第三方 priority 0 直入无冲突面）；M3-1 persona/M3-4 标题经
 *  config/build-env 两轴，不在本文件。
 *  思考档位快切（批甲-BUILD T1，owner D1＝输入框右下角·与模型选择并排）：conversation.input.right
 *  槽注入 EffortSelect——数据面＝ui-model-selection 共享 ModelDirectory（ctx.modelDirectories
 *  .directoryFor(sessionId).store），提交走既有 session.selectModel RPC（零新桥方法零契约 diff；
 *  下 turn 生效语义由宿主 selectForNextRequest 承载）。闭集 Off(关)/Low(低)/High(高)/Max(最高)
 *  与目录 efforts 交集呈现；模型无思考档位（reasoning 缺席＝地板语义）控件隐藏；切换被 provider
 *  层拒绝（session/model-unavailable 等 RemoteResult）时错误码＋原因在卡内如实显示，不静默不降档。
 *  数据：workspaceFiles.read 轮询 <runsRoot>/atf-ui/monitor.json（同步器 5s 快照单源，
 *  gpu 字段＝nvidia-smi 首行单卡面，gpu_all/gpu_binding＝批㉝H 多卡聚合与绑卡声明，
 *  viewers 字段＝run 维度 badcase viewer 发现清单——批㉛段1）；
 *  sessionId 经 header.utilities 的 session-scoped inject 工厂捕获（批⑳实证通道）。
 *  viewer 渲染：iframe 指 server 半静态路由 /atf-ui/viewer/<runId>/（同源 cookie 鉴权，
 *  不重建 viewer 本身——产物由 atf-analyze-badcases skill 链产出）。
 *  挂载面（DSH slot 契约，批㉑三段实证）：conversation.session.header.utilities＝list
 *  （GPU 显隐开关＋sessionId 捕获）；conversation.composer.dock＝list（GPU 一行卡＋胶囊，
 *  与 ui-chat stats 同槽共存）；conversation.input.right＝list（思考档位快切，批甲-BUILD T1）；
 *  conversation.approval.detail＝single（ui-chat 独占——第三方注册会顶掉其 seat 致其 apply
 *  抛错，故不挂）。 */
window.__ModuleLoader__.load({
  id: '@atf/dsh-atf-ui',
  factory: function(require) {
    var React = require('react')
    // 批甲-BUILD T1：菜单 portal 用（composer 卡片 overflow 会裁剪就地弹层——body portal＋
    // 视口锚定与原生 ModelSelect 同型）
    var ReactDOM = require('react-dom')

    // 批㉘ monitor 路径单源：优先读 server 半经 index tap 注入的 per-instance 路径
    // （window.__ATF_UI_CONFIG__.monitorPath＝同步器实际写盘位，随 ATF_DSH_RUNS_ROOT／
    // ATF_WEBUI_RUNS_ROOT 解析）；无注入面时回退批㉑原缺省字面量（owner runsRoot 语义，
    // 3080 缺省行为零变化）。浏览器面不读 env——env 覆盖在 server 半解析后随 index 下发。
    var MONITOR_PATH = (typeof window !== 'undefined' && window.__ATF_UI_CONFIG__ && window.__ATF_UI_CONFIG__.monitorPath) || 'atf-ui/monitor.json'
    var POLL_MS = 5000

    var remoteFace = null
    // 批㊶Q增补一：右栏导航面暂存（apply 赋值；组件在 factory 闭包拿不到 ctx——沿 remoteFace 先例）
    var sidebarFace = null
    var store = {
      sessionId: undefined,
      open: true,
      // 批㉛段1：badcase viewer 浮层状态（null=关；{runId}=开着并指向该 run）
      viewer: null,
      // 批㉛段2：发起训练对话框状态（null=关；{runId, mode}）
      train: null,
      // 批㉛段3.1：右栏训练监控抽屉（默认收起——chat 不受挡；打开后选 run 联动）
      monitorOpen: false,
      monitorRunId: null,
      taskCardOpen: false,
      listeners: new Set(),
      setOpen: function(v) { this.open = v; this.listeners.forEach(function(fn) { fn() }) },
      subscribe: function(fn) { var s = this; s.listeners.add(fn); return function() { s.listeners.delete(fn) } },
      getOpen: function() { return this.open },
      setViewer: function(v) { this.viewer = v; this.listeners.forEach(function(fn) { fn() }) },
      setTrain: function(v) { this.train = v; this.listeners.forEach(function(fn) { fn() }) },
      setMonitor: function(open, runId) { this.monitorOpen = open; if (runId !== undefined) this.monitorRunId = runId; this.listeners.forEach(function(fn) { fn() }) },
      setTaskCard: function(v) { this.taskCardOpen = v; this.listeners.forEach(function(fn) { fn() }) },
      // 批㊶-S5：设置浮层状态（null=关；{}=开）
      setSettings: function(v) { this.settings = v; this.listeners.forEach(function(fn) { fn() }) },
    }

    // ── 批㊶-SSE S5：真 SSE 事件流订阅（传输层升级——事件到达即更新，渲染同一份数据）。
    // 单例 EventSource（每页一条连接——连接上限治理面）；按 event: 键分路（snapshot 全量替换/
    // gpu、gpu_all、runs 键值合并）；连接失败静默（EventSource 原生自动重连），轮询路保留兜底
    // ——降级不降功能。通知卡已读集/新鲜窗复用窗口 B 版，零改动。
    var ssePatchListeners = new Set()
    var sseState = { es: null, failed: false }
    function subscribeMonitorPatch(fn) {
      monitorPatchEnsure()
      ssePatchListeners.add(fn)
      return function() { ssePatchListeners.delete(fn) }
    }
    function sseDispatch(key, value) {
      ssePatchListeners.forEach(function(fn) { try { fn(key, value) } catch (e) { /* 单订阅方异常不断流 */ } })
    }
    function monitorPatchEnsure() {
      if (sseState.es !== null || sseState.failed) return
      if (typeof window === 'undefined' || typeof window.EventSource !== 'function') { sseState.failed = true; return }
      try {
        var es = new EventSource('/atf-ui/events')
        sseState.es = es
        es.addEventListener('snapshot', function(e) {
          try { sseDispatch('snapshot', JSON.parse(e.data)) } catch (err) { /* 坏帧丢弃（下帧校正） */ }
        })
        var keys = ['gpu', 'gpu_all', 'runs']
        for (var i = 0; i < keys.length; i++) {
          (function(key) {
            es.addEventListener(key, function(e) {
              try { sseDispatch(key, JSON.parse(e.data)) } catch (err) { /* 坏帧丢弃 */ }
            })
          })(keys[i])
        }
        es.onerror = function() { /* 静默回退：EventSource 自动重连；轮询路始终兜底（降级不降功能） */ }
      } catch (e) { sseState.failed = true }
    }

    /** 批㊶-TRAIN-OBS-FIX 断点 A：读链主通路换 ATF 自有同源快照端点（fetch 随 shell cookie
     *  过鉴权——不经 remote.mux workspaceFiles.read：该通路真实浏览器恒败且静默吞错无限重试）。
     *  SSE 到达即更新（触发源换流式）；快照轮询保留兜底。 */
    function fetchSnapshotOnce(onData) {
      return fetch('/atf-ui/snapshot', { cache: 'no-store' })
        .then(function(r) { if (!r.ok) return; return r.json(); })
        .then(function(d) { if (d !== null && d !== undefined) onData(d); })
        .catch(function() { /* 离线/未就绪——下周期重取 */ })
    }
    function useMonitor() {
      var _s = React.useState(null)
      var data = _s[0], setData = _s[1]
      React.useEffect(function() {
        var alive = true
        var read = function() {
          fetchSnapshotOnce(function(d) { if (alive && d.monitor) setData(d.monitor) })
        }
        read()
        var t = setInterval(read, POLL_MS)
        // 批㊶-SSE S5：订阅事件流补丁——到达即合并（渲染同一份 data，卡面函数零改动）
        var unsubPatch = subscribeMonitorPatch(function(key, value) {
          if (!alive) return
          if (key === 'snapshot' && value !== null && typeof value === 'object') { setData(value); return }
          setData(function(prev) {
            if (prev === null || typeof prev !== 'object' || !(key in prev)) return prev
            var next = Object.assign({}, prev)
            next[key] = value
            return next
          })
        })
        return function() { alive = false; clearInterval(t); unsubPatch() }
      }, [])
      return data
    }

    /** artifacts.json 轮询（批㉛段3.3 产物抽屉数据源）——批㊶-TRAIN-OBS-FIX 断点 A：
     *  同一读链缺陷面，切自有快照端点（d.artifacts）。 */
    function useArtifacts() {
      var _s = React.useState(null)
      var data = _s[0], setData = _s[1]
      React.useEffect(function() {
        var alive = true
        var read = function() {
          fetchSnapshotOnce(function(d) { if (alive && d.artifacts) setData(d.artifacts) })
        }
        read()
        var t = setInterval(read, POLL_MS)
        return function() { alive = false; clearInterval(t) }
      }, [])
      return data
    }

    /** 批㊶Q增补三 段3：工作区作用域集——本会话绑定 run ∪ 同工作区桶 run。
     *  myWorkspace 取自绑定 run 的 workspace 桶标注（monitor.json 单源；平铺存量/系统级
     *  标注 null＝退回纯绑定集，与 N-5 行为一致）。「全部实例」显式切换在调用方保留。 */
    function scopedRuns(mon, sessionId) {
      var all = (mon && mon.runs) || []
      var bound = all.filter(function(r) { return Array.isArray(r.bound_sessions) && r.bound_sessions.indexOf(sessionId) >= 0 })
      var myWorkspace = null
      for (var i = 0; i < bound.length; i++) {
        if (typeof bound[i].workspace === 'string' && bound[i].workspace !== '') { myWorkspace = bound[i].workspace; break }
      }
      if (myWorkspace === null) return bound
      return all.filter(function(r) {
        return r.workspace === myWorkspace || (Array.isArray(r.bound_sessions) && r.bound_sessions.indexOf(sessionId) >= 0)
      })
    }

    /** 在跑 run 挑选（只读展示推导）：第一个有推进（done>0 或 active 段）的 run。 */
    function pickActiveRun(mon) {
      var runs = (mon && mon.runs) || []
      for (var i = 0; i < runs.length; i++) {
        var segs = runs[i].segments || []
        var done = segs.filter(function(s) { return s.status === 'done' }).length
        var trainingActive = segs.some(function(s) { return s.key === 'training' && s.status === 'active' })
        var waiting = segs.some(function(s) { return s.key === 'experiment_config' && s.status === 'active' })
        if (done > 0 || trainingActive || waiting) return { run: runs[i], done: done, total: segs.length, trainingActive: trainingActive, waiting: waiting }
      }
      return null
    }

    /** 有 viewer 产物的 run 清单（批㉛段1：monitor.json viewers 字段，空数组＝无挂载面）。 */
    function runsWithViewers(mon) {
      return ((mon && mon.runs) || []).filter(function(r) { return (r.viewers || []).length > 0 })
    }

    /** 可发起训练的 run 清单（批㉛段2：launch.train_sh 或 iteration_config 在场）。 */
    function launchableRuns(mon) {
      return ((mon && mon.runs) || []).filter(function(r) {
        var l = r.launch
        return !!l && (l.train_sh === true || !!l.iteration_config)
      })
    }

    /** 训练发起消息模板（批㉛段2）——与 snapshot.js buildTrainLaunchMessage 单源语义
     *  同步维护（client 半裸服务不打包，无法 require 仓内模块；tests/dshUi/atfUi.test.ts
     *  有双份同语义钉子：两处模板都须含 DRY_RUN 止步条款与真训 owner 点头句，改动同步）。 */
    function trainLaunchMessage(plan) {
      var real = plan.mode === 'real'
      var lines = [
        '发起训练（' + plan.run_id + ' · ' + (real ? '真实训练' : 'DRY_RUN 验收') + '）：',
        '请按 prepare/run SKILL.md 正道链执行并逐步回报：',
        '① atf_config_confirm present（run_id=' + plan.run_id + '）——九要素卡呈我确认' + (plan.summaryCount > 0 ? '（Web 摘要已核：' + plan.summaryCount + ' 项来自 IterationConfig，其余为缺省/KB 未校准值，卡面如实标注）' : '') + '；',
        '② 我 Allow once 后：DRY_RUN 校验——DRY_RUN=1 bash 该 run 的 train.sh，输出须含 ADMISSION=pass；',
        '③ prelaunch 报告在场检查（train.sh 同目录 prelaunch*.md|json）——缺失则按 prepare SKILL.md:84 以 build_prelaunch_report.py 生成到 scratch 并回报路径（不回写 run 目录）；',
        '④ 账本登记核验：generate_train_launch.py --record-training-release --config <该 IterationConfig>（已放行过则如实回报 already_recorded），贴 ledger 命中行作登记证据；',
      ]
      lines.push(real
        ? '⑤ 放行执行：atf_launch_execute（launch_sh=scratch 内 launch.sh，config=同一 IterationConfig，note 注明 owner 书面授权）——唯一编排执行点，manifest sha 对拍 fail-closed；'
        : '⑤ 到此止：不执行 atf_launch_execute、不启动 tmux、不占 GPU——本轮仅 DRY_RUN 验收，真实训练候我单独书面点头。')
      return lines.join('\n')
    }

    /** 批㉝H：全卡聚合显示串＋绑卡标注——与 snapshot.js formatGpuAll/formatGpuBinding
     *  同语义的 client 本地副本（裸服务不打包无法 require；tests/dshUi/atfUi.test.ts
     *  有双份同语义钉子，改动同步）。 */
    function formatGpuAllLocal(gpuAll) {
      if (!gpuAll || gpuAll.length === 0) return null
      return gpuAll.map(function(c) {
        return 'GPU' + String(c && c.index !== undefined ? c.index : '?') + ' ' + String((c && c.utilization) || '—') + '/' + String((c && c.memoryUsed) || '—')
      }).join(' · ')
    }
    function formatGpuBindingLocal(binding) {
      if (!binding || typeof binding !== 'object') return null
      if (typeof binding.devices !== 'string' || binding.devices === '') return null
      var src = binding.source === 'deploy_effective' ? 'deploy_effective.visible_devices' : 'train.sh CUDA_VISIBLE_DEVICES'
      return '绑卡：' + binding.devices + '（' + src + '）'
    }

    /** Loss 曲线 polyline points（批㉛段3.1——与 snapshot.js lossSvgPath 同语义的 client 本地副本：
     *  裸服务不打包无法 require；归一 0..w，点不足 2 返回 null 不画）。 */
    function lossPoints(values, w, h) {
      if (!values || values.length < 2) return null
      var min = Math.min.apply(null, values), max = Math.max.apply(null, values)
      var range = max - min || 1
      return values.map(function(v, i) {
        return ((i / (values.length - 1)) * w).toFixed(1) + ',' + (h - 4 - ((v - min) / range) * (h - 8)).toFixed(1)
      }).join(' ')
    }

    /** 右栏训练监控抽屉（批㉛段3.1）：Loss 双线曲线（train 实线/eval 虚线——live run 的
     *  loss-series 双值；历史 run 为 trainer_state 单线，eval 侧如实标注无序列）＋KPI 2×2
     *  （F1/precision/recall/exact——最新评估轮 metrics_summary 同源）＋环境卡（基模型/数据集/
     *  deepspeed/lane＋GPU 实测行）。数据源＝monitor.json（5s 快照单源，只读）。 */
    function MonitorPanel() {
      // 批㊶-N N-5 三级作用域：选择器缺省只列本会话绑定 run；"全部实例"显式切换（owner 裁定④运维兜底）
      var showAllState = React.useState(false)
      var showAll = showAllState[0], setShowAll = showAllState[1]
      var monAll = useMonitor()
      var open = React.useSyncExternalStore(
        function(fn) { return store.subscribe(fn) },
        function() { return store.monitorOpen },
      )
      var selRunId = React.useSyncExternalStore(
        function(fn) { return store.subscribe(fn) },
        function() { return store.monitorRunId },
      )
      var mon = useMonitor()
      var arts = useArtifacts()
      // 批㉛段3.2：Loss 点选选中态（hook 须在条件 return 之前——React hooks 顺序不变量）
      var _sel = React.useState(null)
      var selIdx = _sel[0], setSelIdx = _sel[1]
      // 批㉞H：评估对比双轮选择态（同上——hooks 前置；null＝缺省取末两轮）
      var _cmpA = React.useState(null)
      var cmpA = _cmpA[0], setCmpA = _cmpA[1]
      var _cmpB = React.useState(null)
      var cmpB = _cmpB[0], setCmpB = _cmpB[1]
      // 批㊶-N N-5 三级作用域（hooks 已前置）：缺省只列本会话绑定 run；"全部实例"显式切换＝全量
      var showAllState = React.useState(false)
      var showAll = showAllState[0], setShowAll = showAllState[1]
      // 批㊶-S2a：运行列表过滤模式（'workspace'＝本工作区（默认）／'all'＝全部）
      var _listMode = React.useState('workspace')
      var listMode = _listMode[0], setListMode = _listMode[1]
      // 批㊶Q增补一：pane body 常挂后关闭态不再返回 null（空 pane 疑似故障）——空态占位指路
      if (!open) return React.createElement('div', { className: 'atf-monitor-panel', style: { padding: '20px 12px', height: '100%', overflow: 'auto' } },
        React.createElement('div', { className: 'atf-monitor-empty' }, '监控已关闭——点顶栏「监控」按钮重新打开'))
      var allRuns = (mon && mon.runs) || []
      // 批㊶Q增补三 段3：缺省作用域＝本会话绑定 ∪ 同工作区桶；「全部实例」显式切换＝全量
      var runs = showAll ? allRuns : scopedRuns(mon, store.sessionId)
      var runId = selRunId && runs.some(function(r) { return r.run_id === selRunId }) ? selRunId : (runs[0] ? runs[0].run_id : null)
      var run = runId ? runs.find(function(r) { return r.run_id === runId }) : null
      var points = (run && run.training && run.training.points) || []
      var trainVals = points.map(function(p) { return p.train_loss }).filter(function(v) { return typeof v === 'number' })
      var evalVals = points.map(function(p) { return p.eval_loss }).filter(function(v) { return typeof v === 'number' })
      var W = 300, H = 80
      var trainPts = lossPoints(trainVals, W, H)
      var evalPts = evalVals.length >= 2 ? lossPoints(evalVals, W, H) : null
      var done = run ? run.segments.filter(function(s) { return s.status === 'done' }).length : 0
      var active = run ? run.segments.some(function(s) { return s.status === 'active' }) : false
      var m = (run && run.metrics) || null
      var pct = function(v) { return typeof v === 'number' ? (v * 100).toFixed(1) + '%' : '—' }
      var env = (run && run.env) || null
      var gpu = (mon && mon.gpu) || null
      // 批㉝H：GPU 行多卡聚合（gpu_all 缺席回退首行单卡面）＋所选 run 绑卡标注（读不到不显示）
      var gpuAllText = formatGpuAllLocal(mon && mon.gpu_all)
      var gpuRow = gpu === null ? '—'
        : gpu.offline ? '离线'
        : gpuAllText !== null ? gpuAllText
        : (gpu.utilization || '—') + ' · ' + (gpu.memoryUsed || '—') + '/' + (gpu.memoryTotal || '—')
      var gpuBindText = run ? formatGpuBindingLocal(run.gpu_binding) : null
      // 批㉞H：两轮评估对比数据准备（eval_rounds——KPI 并排＋口径标注＋finish_reason＋错误类型＋字段级 F1）
      var cmpRounds = (run && run.eval_rounds) || []
      var cmpNames = cmpRounds.map(function(r) { return r.round })
      var cmpDefB = cmpRounds.length >= 1 ? cmpRounds[cmpRounds.length - 1].round : null
      var cmpDefA = cmpRounds.length >= 2 ? cmpRounds[cmpRounds.length - 2].round : cmpDefB
      var cmpAName = cmpA !== null && cmpNames.indexOf(cmpA) >= 0 ? cmpA : cmpDefA
      var cmpBName = cmpB !== null && cmpNames.indexOf(cmpB) >= 0 ? cmpB : cmpDefB
      var cmpRa = cmpRounds.find(function(r) { return r.round === cmpAName }) || null
      var cmpRb = cmpRounds.find(function(r) { return r.round === cmpBName }) || null
      var cmpM = function(r) { return r && r.metrics ? r.metrics : null }
      var cmpPct = function(surf, key) { return surf && typeof surf[key] === 'number' ? (surf[key] * 100).toFixed(1) + '%' : '—' }
      var cmpTok = function(surf) { return surf && typeof surf.max_completion_tokens === 'number' ? String(surf.max_completion_tokens) : '—' }
      var cmpFr = function(r, key) { return r && r.badcases && typeof r.badcases.finish_reason[key] === 'number' ? String(r.badcases.finish_reason[key]) : '—' }
      var cmpTotal = function(r) { return r && r.badcases && typeof r.badcases.total === 'number' ? String(r.badcases.total) : '—' }
      // 错误类型计数（by_field 联合键，按 A+B 计数降序取 top6）
      var cmpFieldKeys = []
      var cmpFieldSeen = {}
      ;[cmpRa, cmpRb].forEach(function(r) {
        if (!r || !r.badcases || !r.badcases.by_field) return
        Object.keys(r.badcases.by_field).forEach(function(k) {
          if (!cmpFieldSeen[k]) { cmpFieldSeen[k] = true; cmpFieldKeys.push(k) }
        })
      })
      cmpFieldKeys.sort(function(x, y) {
        var sa = ((cmpRa && cmpRa.badcases && cmpRa.badcases.by_field[x]) || 0) + ((cmpRb && cmpRb.badcases && cmpRb.badcases.by_field[x]) || 0)
        var sb = ((cmpRa && cmpRa.badcases && cmpRa.badcases.by_field[y]) || 0) + ((cmpRb && cmpRb.badcases && cmpRb.badcases.by_field[y]) || 0)
        return sb - sa || (x < y ? -1 : 1)
      })
      var cmpFieldTop = cmpFieldKeys.slice(0, 6)
      // 字段级 F1（两轮 fields_f1 联合键——现有产物已含则展示，双缺占位不造数据）
      var cmpF1Keys = []
      var cmpF1Seen = {}
      ;[cmpRa, cmpRb].forEach(function(r) {
        if (!r || !r.fields_f1) return
        Object.keys(r.fields_f1).forEach(function(k) {
          if (!cmpF1Seen[k]) { cmpF1Seen[k] = true; cmpF1Keys.push(k) }
        })
      })
      cmpF1Keys.sort()
      var kpis = [
        { label: 'F1（micro）', value: pct(m ? m.f1 : null) },
        { label: 'precision', value: pct(m ? m.precision : null) },
        { label: 'recall', value: pct(m ? m.recall : null) },
        { label: 'exact（页级）', value: pct(m ? m.exact : null) },
      ]
      // 批㉛段3.2：Loss 点选联动——点即选（圆标＋step/loss 读数），一键跳该 run 的 badcase 可视化
      var spikeIdx = null
      if (trainVals.length >= 3) {
        var worstRatio = 0
        for (var i = 1; i < trainVals.length - 1; i++) {
          var neigh = (trainVals[i - 1] + trainVals[i + 1]) / 2 || 1e-9
          var ratio = trainVals[i] / neigh
          if (ratio > worstRatio) { worstRatio = ratio; spikeIdx = i }
        }
        if (worstRatio <= 1.15) spikeIdx = null
      }
      var markIdx = selIdx !== null ? selIdx : spikeIdx
      var mark = null
      if (markIdx !== null && markIdx !== undefined && trainVals.length >= 2) {
        var mv = trainVals[markIdx]
        var mn = Math.min.apply(null, trainVals), mx = Math.max.apply(null, trainVals)
        var mr = mx - mn || 1
        var px = (markIdx / (trainVals.length - 1)) * W
        var py = H - 4 - ((mv - mn) / mr) * (H - 8)
        mark = { x: px, y: py, loss: mv, step: points[markIdx] && typeof points[markIdx].step === 'number' ? points[markIdx].step : null, isSpike: selIdx === null && spikeIdx !== null }
      }
      var runArtifacts = null
      if (arts && arts.runs) {
        var artRun = arts.runs.find(function(r) { return r.run_id === runId })
        runArtifacts = artRun ? artRun.artifacts : []
      }
      // 批㊶-M2 段 3：迁原生右栏 pane tab——壳样式交互随框架（fixed 壳已下线，L-4 遮挡自然消失）
      return React.createElement('div', { className: 'atf-monitor-panel', style: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto', fontSize: 12 } },
        // 批㊶-M M-5：部署默认档低频信息降级至此（dock 徽章撤销——档位唯一出口＝原生选择器）
        React.createElement('div', { className: 'atf-monitor-head', title: '部署缺省 ' + (((typeof window !== 'undefined' && window.__ATF_UI_CONFIG__ && window.__ATF_UI_CONFIG__.permissionPreset) || {}).label || ((typeof window !== 'undefined' && window.__ATF_UI_CONFIG__ && window.__ATF_UI_CONFIG__.permissionPreset) || {}).key || '—') + '，会话内可经下方选择器切换' },
          React.createElement('b', null, '训练监控'),
          React.createElement('select', {
            className: 'atf-viewer-select', value: runId || '',
            onChange: function(e) { store.setMonitor(true, e.target.value) },
          },
            runs.length === 0
              ? React.createElement('option', { value: '' }, '（本会话无绑定 run）')
              : runs.map(function(r) { return React.createElement('option', { key: r.run_id, value: r.run_id }, r.run_id) })),
          React.createElement('button', {
            className: 'atf-pill' + (showAll ? ' atf-pill-on' : ''),
            style: showAll ? { borderColor: 'var(--dsw-alias-brand-primary,#1d4ed8)', color: 'var(--dsw-alias-brand-primary,#1d4ed8)', fontWeight: 600 } : undefined,
            title: showAll ? '全部实例（开——显示全量 run）' : '全部实例（关——只列本会话绑定 run）',
            onClick: function() { setShowAll(!showAll) },
          }, '全部'),
          React.createElement('button', { className: 'atf-pill', title: '收起右栏面板（内容关闭；tab 由右栏原生 × 收）',
            onClick: function() {
              store.setMonitor(false)
              // 批㊶Q增补一：× 收右栏列（fail-open——导航面缺席/异常时仅关内容，空态兜底）
              try {
                if (sidebarFace && typeof sidebarFace.isExpanded === 'function' && sidebarFace.isExpanded()) sidebarFace.toggleExpanded()
              } catch (e) { /* fail-open */ }
            } }, '×')),
        // 批㊶-P P-2：探针告警行（error 红/warn 琥珀＋"重新发起"预填按钮——不自动代发）
        // 批㊶-Q 通报面（段1/2/3）：level=info 走品牌色；kind chip＝「全自动训练」（config_auto/
        // train_auto）与「OOM 降档重发」（oom_fallback）——品牌描边 chip，与权限档色语义独立；
        // 通报类不设"重新发起"按钮（自动链已处理，可回看；改参经会话 amend 唤出）。
        // 作用域：当前选中 run（选择器联动）——probe 面随 monitor.json 下发
        (function() {
          var selRunId = store.monitorRunId
          var runs = (mon && mon.runs) || []
          var activeRun = null
          if (selRunId) activeRun = { run: runs.find(function(r) { return r.run_id === selRunId }) || null }
          if (activeRun === null) activeRun = pickScopedActiveRun(mon, store.sessionId)
          var probe = activeRun !== null && activeRun.run ? (activeRun.run.probe || null) : null
          if (probe === null) return null
          var kind = probe.kind || 'probe'
          var isAutoNotice = kind === 'config_auto' || kind === 'train_auto' || kind === 'oom_fallback'
          var rowColor = probe.level === 'error' ? 'var(--dsw-static-red-500)' : probe.level === 'warn' ? 'var(--dsw-static-amber-500)' : 'var(--dsw-alias-brand-primary,#1d4ed8)'
          var chip = null
          if (kind === 'config_auto' || kind === 'train_auto') {
            chip = React.createElement('span', { style: { flex: 'none', fontSize: 10, lineHeight: '14px', padding: '0 6px', borderRadius: 7, border: '1px solid var(--dsw-alias-brand-primary,#1d4ed8)', color: 'var(--dsw-alias-brand-primary,#1d4ed8)', fontWeight: 600 } }, '全自动训练')
          } else if (kind === 'oom_fallback') {
            chip = React.createElement('span', { style: { flex: 'none', fontSize: 10, lineHeight: '14px', padding: '0 6px', borderRadius: 7, border: '1px solid var(--dsw-alias-brand-primary,#1d4ed8)', color: 'var(--dsw-alias-brand-primary,#1d4ed8)', fontWeight: 600 } }, 'OOM 降档重发')
          }
          var reissue = (probe.reason.indexOf('out of memory') >= 0 || probe.reason.indexOf('OOM') >= 0)
            ? '重新发起训练（OOM 降档）：调用 atf_run_training 工具 action=start，train_sh 沿用原 launch/train.sh，batch 改 1、梯度累积翻倍（全局批量 256 不变）——请确认后执行。'
            : '重新发起训练：调用 atf_run_training 工具 action=start 沿用原参数——请确认后执行。'
          return React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 12px', fontSize: 12, color: rowColor } },
            chip,
            // 批㊶Q增补一：长通报文本换行收窄（flex:1+minWidth:0+break-all——原单行溢出被 pane 裁切）
            React.createElement('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-all' } }, probe.reason + ' · ' + probe.since.slice(11, 19)),
            !isAutoNotice && React.createElement('button', {
              className: 'atf-pill', title: '在会话预填重发指令（含降档参数如适用）——点击后自行发送',
              style: { flex: 'none' },
              onClick: function() {
                var input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]')
                if (input) { input.focus(); document.execCommand('insertText', false, reissue) }
              },
            }, '重新发起'))
        })(),
        // 批㊶-N N-4：dock 撤销的 GPU 摘要与内核版本信息移此处（低频详情行；部署缺省档已注 title）
        React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#64748b)', padding: '2px 12px 0', fontFamily: 'monospace' } },
          (function() {
            var gpu = (mon && mon.gpu) || null
            var gpuText = gpu === null ? 'GPU —' : gpu.offline === true ? 'GPU 离线' : formatGpuAllLocal(mon && mon.gpu_all) || ('GPU ' + (gpu.utilization || '—'))
            var bridge = (typeof window !== 'undefined' && window.__ATF_UI_CONFIG__ && window.__ATF_UI_CONFIG__.bridge) || null
            var kernelText = bridge ? (bridge.mode === 'real' ? '内核 real' + (bridge.version ? '·' + bridge.version : '') : '⚠ mock') : ''
            return gpuText + (kernelText !== '' ? ' ｜ ' + kernelText : '')
          })()),
        // 批㊶-S2a：运行列表（过滤键＝runs[].workspace；本工作区视图＝当前会话工作区桶精确匹配，
        // 平铺（null）无法判定归属——只在「全部」出现，不猜；行点击＝选中该 run）
        (function() {
          var allRuns = (mon && mon.runs) || []
          var myWs = null
          for (var i = 0; i < allRuns.length; i++) {
            var r0 = allRuns[i]
            if (Array.isArray(r0.bound_sessions) && r0.bound_sessions.indexOf(store.sessionId) >= 0 && typeof r0.workspace === 'string' && r0.workspace !== '') { myWs = r0.workspace; break }
          }
          var visible = listMode === 'workspace'
            ? allRuns.filter(function(r) { return r.workspace !== null && r.workspace === myWs })
            : allRuns
          return React.createElement('div', { className: 'atf-monitor-sec' },
            React.createElement('div', { className: 'atf-monitor-title', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
              React.createElement('span', null, '运行列表'),
              React.createElement('span', null,
                React.createElement('button', {
                  className: 'atf-pill' + (listMode === 'workspace' ? ' atf-pill-on' : ''),
                  style: listMode === 'workspace' ? { borderColor: 'var(--dsw-alias-brand-primary,#1d4ed8)', color: 'var(--dsw-alias-brand-primary,#1d4ed8)', fontWeight: 600 } : undefined,
                  title: '本工作区（当前会话工作区桶）',
                  onClick: function() { setListMode('workspace') },
                }, '本工作区'),
                ' ',
                React.createElement('button', {
                  className: 'atf-pill' + (listMode === 'all' ? ' atf-pill-on' : ''),
                  style: listMode === 'all' ? { borderColor: 'var(--dsw-alias-brand-primary,#1d4ed8)', color: 'var(--dsw-alias-brand-primary,#1d4ed8)', fontWeight: 600 } : undefined,
                  title: '全部（含平铺存量）',
                  onClick: function() { setListMode('all') },
                }, '全部'))),
            visible.length === 0
              ? React.createElement('div', { className: 'atf-viewer-empty' }, listMode === 'workspace' ? '（本工作区无桶内运行——切「全部」查看存量）' : '（暂无运行）')
              : visible.map(function(r) {
                  return React.createElement('div', {
                    key: (r.workspace || 'flat') + '/' + r.run_id,
                    className: 'atf-run-row',
                    style: { display: 'flex', gap: 6, padding: '3px 4px', fontSize: 12, cursor: 'pointer', borderBottom: '1px dashed rgba(128,128,128,.15)', alignItems: 'baseline' },
                    onClick: function() { store.setMonitor(true, r.run_id) },
                    title: '选中 ' + r.run_id,
                  },
                    React.createElement('span', { style: { fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, r.run_id),
                    React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary,#64748b)', flex: 'none' } }, r.workspace === null ? '平铺' : r.workspace),
                    React.createElement('span', { style: { color: r.training && r.training.active === true ? 'var(--dsw-static-amber-500)' : 'var(--dsw-alias-label-tertiary,#64748b)', flex: 'none' } }, r.training && r.training.active === true ? '训练中' : (r.state || '')))
                }))
        })(),
        run === null
          ? React.createElement('div', { className: 'atf-monitor-empty' }, '（monitor 快照就绪中…）')
          : React.createElement('div', { className: 'atf-monitor-body' },
              React.createElement('div', { className: 'atf-monitor-status' },
                React.createElement('span', { className: 'atf-gpu-dot', style: { background: active ? 'var(--dsw-static-amber-500)' : 'var(--dsw-static-neutral-400)' } }),
                React.createElement('span', null, (active ? '训练中 · ' : '空闲 · ') + '段 ' + done + '/' + run.segments.length)),
              React.createElement(TrainlogTailSection, { run: run }),
              React.createElement('div', { className: 'atf-monitor-sec' },
                React.createElement('div', { className: 'atf-monitor-title' }, 'Loss 曲线'),
                React.createElement('svg', { className: 'atf-monitor-chart', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' },
                  trainPts ? React.createElement('polyline', { points: trainPts, fill: 'none', stroke: 'var(--dsw-alias-brand-primary,#1d4ed8)', strokeWidth: 1.5 }) : null,
                  evalPts ? React.createElement('polyline', { points: evalPts, fill: 'none', stroke: 'var(--dsw-static-neutral-400,#94a3b8)', strokeWidth: 1.5, strokeDasharray: '4 3' }) : null,
                  mark ? React.createElement('circle', {
                    cx: mark.x, cy: mark.y, r: 3.5,
                    fill: mark.isSpike ? 'var(--dsw-static-red-500)' : 'var(--dsw-alias-brand-primary,#1d4ed8)', stroke: 'var(--dsw-alias-bg-layer-1,#fff)', strokeWidth: 1,
                  }) : null,
                  trainVals.length >= 2 ? trainVals.map(function(v, idx) {
                    var mn2 = Math.min.apply(null, trainVals), mx2 = Math.max.apply(null, trainVals)
                    var r2 = mx2 - mn2 || 1
                    return React.createElement('circle', {
                      key: idx, cx: (idx / (trainVals.length - 1)) * W,
                      cy: H - 4 - ((v - mn2) / r2) * (H - 8), r: 7,
                      fill: 'transparent',
                      style: { cursor: 'pointer' },
                      onClick: function() { setSelIdx(idx === selIdx ? null : idx) },
                    })
                  }) : null),
                React.createElement('div', { className: 'atf-monitor-legend' },
                  React.createElement('span', null, React.createElement('span', { className: 'atf-sw', style: { background: 'var(--dsw-alias-brand-primary,#1d4ed8)' } }), 'train（' + trainVals.length + ' 点）'),
                  React.createElement('span', null, React.createElement('span', { className: 'atf-sw atf-sw-dash', style: { background: evalPts ? 'var(--dsw-static-neutral-400,#94a3b8)' : 'transparent' } }), evalVals.length >= 2 ? 'eval' : 'eval（本轮无 eval_loss 序列）')),
                mark ? React.createElement('div', { className: 'atf-monitor-spike' },
                  React.createElement('span', null, (mark.isSpike ? '突刺点' : '选中点') + '：' + (mark.step !== null ? 'step ' + mark.step + ' · ' : '') + 'loss ' + mark.loss),
                  (run && (run.viewers || []).length > 0)
                    ? React.createElement('button', {
                        className: 'atf-viewer-link',
                        title: '打开该 run 的 badcase 可视化（段1 viewer 入口）',
                        onClick: function() { store.setViewer({ runId: runId }) },
                      }, '查看 badcase →')
                    : React.createElement('span', { className: 'atf-viewer-empty' }, '（该 run 无 viewer 产物）')) : React.createElement('div', { className: 'atf-monitor-spike' }, React.createElement('span', { className: 'atf-viewer-empty' }, '点击曲线任一点查看读数；红点＝自动识别的突刺'))),
              React.createElement('div', { className: 'atf-monitor-sec' },
                React.createElement('div', { className: 'atf-monitor-title' }, '评估 KPI', m ? React.createElement('span', { className: 'atf-monitor-round' }, ' ' + m.round) : null),
                React.createElement('div', { className: 'atf-kpi-grid' },
                  kpis.map(function(k) {
                    return React.createElement('div', { key: k.label, className: 'atf-kpi-card' },
                      React.createElement('div', { className: 'atf-kpi-label' }, k.label),
                      React.createElement('div', { className: 'atf-kpi-value' }, k.value))
                  })),
                m ? React.createElement('div', { className: 'atf-monitor-sub' }, 'model：' + m.model + (m.pages !== null ? ' · ' + m.pages + ' 页' : '')) : React.createElement('div', { className: 'atf-monitor-sub' }, '（无评估轮产物——评估四件套入列后显示）')),
              // 批㉞H：两轮评估并排对比（KPI＋口径＋finish_reason＋错误类型＋字段级 F1）
              React.createElement('div', { className: 'atf-monitor-sec' },
                React.createElement('div', { className: 'atf-monitor-title' }, '评估对比'),
                cmpRounds.length < 2
                  ? React.createElement('div', { className: 'atf-viewer-empty' }, '（不足两轮——对比需 ≥2 个 eval 轮次，当前 ' + cmpRounds.length + ' 轮）')
                  : React.createElement('div', null,
                      React.createElement('div', { className: 'atf-cmp-pickers' },
                        React.createElement('select', { className: 'atf-viewer-select', value: cmpAName || '', onChange: function(e) { setCmpA(e.target.value) } },
                          cmpRounds.map(function(r) { return React.createElement('option', { key: r.round, value: r.round }, r.round) })),
                        React.createElement('span', { className: 'atf-viewer-empty' }, 'vs'),
                        React.createElement('select', { className: 'atf-viewer-select', value: cmpBName || '', onChange: function(e) { setCmpB(e.target.value) } },
                          cmpRounds.map(function(r) { return React.createElement('option', { key: 'b-' + r.round, value: r.round }, r.round) }))),
                      React.createElement('div', { className: 'atf-cmp-grid' },
                        [['指标', cmpAName, cmpBName],
                         ['F1（micro）', cmpPct(cmpM(cmpRa), 'f1'), cmpPct(cmpM(cmpRb), 'f1')],
                         ['precision', cmpPct(cmpM(cmpRa), 'precision'), cmpPct(cmpM(cmpRb), 'precision')],
                         ['recall', cmpPct(cmpM(cmpRa), 'recall'), cmpPct(cmpM(cmpRb), 'recall')],
                         ['exact（页级）', cmpPct(cmpM(cmpRa), 'exact'), cmpPct(cmpM(cmpRb), 'exact')],
                         ['口径 max_completion_tokens', cmpTok(cmpM(cmpRa)), cmpTok(cmpM(cmpRb))],
                         ['badcase 行数', cmpTotal(cmpRa), cmpTotal(cmpRb)],
                         ['finish=length 行数', cmpFr(cmpRa, 'length'), cmpFr(cmpRb, 'length')],
                         ['finish=stop 行数', cmpFr(cmpRa, 'stop'), cmpFr(cmpRb, 'stop')]]
                          .concat(cmpFieldTop.map(function(k) {
                            return ['错误·' + k,
                              cmpRa && cmpRa.badcases && cmpRa.badcases.by_field[k] !== undefined ? String(cmpRa.badcases.by_field[k]) : '—',
                              cmpRb && cmpRb.badcases && cmpRb.badcases.by_field[k] !== undefined ? String(cmpRb.badcases.by_field[k]) : '—']
                          }))
                          .concat(cmpF1Keys.map(function(k) {
                            return ['F1·' + k,
                              cmpRa && cmpRa.fields_f1 && typeof cmpRa.fields_f1[k] === 'number' ? (cmpRa.fields_f1[k] * 100).toFixed(1) + '%' : '—',
                              cmpRb && cmpRb.fields_f1 && typeof cmpRb.fields_f1[k] === 'number' ? (cmpRb.fields_f1[k] * 100).toFixed(1) + '%' : '—']
                          }))
                          .map(function(row, i) {
                            return React.createElement('div', { key: 'cmp-' + i, className: 'atf-cmp-row' + (i === 0 ? ' atf-cmp-head' : '') },
                              React.createElement('span', { className: 'atf-cmp-label' }, row[0]),
                              React.createElement('span', { className: 'atf-cmp-val' }, row[1]),
                              React.createElement('span', { className: 'atf-cmp-val' }, row[2]))
                          })),
                      cmpRa && cmpRb && !cmpRa.fields_f1 && !cmpRb.fields_f1
                        ? React.createElement('div', { className: 'atf-monitor-sub' }, '（字段级数据需分析链产出——当前产物无 fields 面）')
                        : null)),
              React.createElement('div', { className: 'atf-monitor-sec' },
                React.createElement('div', { className: 'atf-monitor-title' }, '环境'),
                React.createElement('div', { className: 'atf-monitor-env' },
                  React.createElement('div', null, 'GPU：' + gpuRow + (gpuBindText !== null ? ' · ' + gpuBindText : '')),
                  React.createElement('div', null, '基模型：' + (env ? env.base_model : '—')),
                  React.createElement('div', null, '数据集：' + (env ? env.dataset_keys : '—')),
                  React.createElement('div', null, 'deepspeed：' + (env ? env.deepspeed : '—')),
                  React.createElement('div', null, 'lane：' + (env ? env.lane : '—')))),
              React.createElement('div', { className: 'atf-monitor-sec' },
                React.createElement('div', { className: 'atf-monitor-title' }, '产物抽屉'),
                runArtifacts === null
                  ? React.createElement('div', { className: 'atf-viewer-empty' }, '（artifacts.json 就绪中…）')
                  : runArtifacts.length === 0
                    ? React.createElement('div', { className: 'atf-viewer-empty' }, '（该 run 无产物入列）')
                    : React.createElement('div', { className: 'atf-art-list' },
                        runArtifacts.map(function(a) {
                          var isViewer = a.kind === 'html'
                          return React.createElement('div', { key: a.path, className: 'atf-art-row' },
                            React.createElement('span', { className: 'atf-art-kind' }, a.kind),
                            isViewer
                              ? React.createElement('button', {
                                  className: 'atf-viewer-link', title: '内嵌打开（段1 viewer 入口）',
                                  onClick: function() { store.setViewer({ runId: runId }) },
                                }, a.name)
                              : React.createElement('span', { className: 'atf-art-name', title: a.path }, a.name))
                        })))))
    }

    /** 批㊶Q增补一：pane tab body 真身。批㊶-M2 段3 迁移留断点——本符号被引用却从未定义
     *  （createElement(undefined) 渲染恒空，pane 本体空白），而 MonitorPanel 仍挂 dock 且
     *  CSS fixed 壳未清，以视口右缘全高条（z-900）形态顶替 pane 位置形成"看似正常"假象，
     *  实际盖住浮卡、吞右缘点击（遮挡根因，hit-test 实证）。本体＝转调 MonitorPanel 共用
     *  内容体；挂载期发布 CSS 变量 --atf-pane-offset（pane 左缘让位量）供浮卡避让——
     *  浮层与右栏 pane tab 不重叠、不覆盖面板顶栏（几何上不可能）。 */
    function MonitorBody() {
      React.useEffect(function() {
        var root = document.documentElement
        var update = function() {
          var offset = '0px'
          var panel = document.querySelector('.atf-monitor-panel')
          if (panel) {
            var r = panel.getBoundingClientRect()
            if (r.width > 0 && r.height > 0 && r.left < window.innerWidth) offset = (window.innerWidth - r.left + 16) + 'px'
          }
          root.style.setProperty('--atf-pane-offset', offset)
        }
        update()
        var ro = 'ResizeObserver' in window ? new ResizeObserver(update) : null
        var panel = document.querySelector('.atf-monitor-panel')
        if (panel && ro) ro.observe(panel)
        window.addEventListener('resize', update)
        // pane 滑入/内容挂载晚于本 effect——两帧＋一次尾随补测（动画 350ms 后宽度已定）
        var raf = requestAnimationFrame(function() { requestAnimationFrame(update) })
        var t = setTimeout(function() {
          var p2 = document.querySelector('.atf-monitor-panel')
          if (p2 && ro) { ro.observe(p2); update() }
        }, 400)
        return function() {
          if (ro) ro.disconnect()
          window.removeEventListener('resize', update)
          cancelAnimationFrame(raf)
          clearTimeout(t)
          root.style.setProperty('--atf-pane-offset', '0px')
        }
      }, [])
      return React.createElement(MonitorPanel)
    }

    /** 批㊶-S5 设置面板（B2——四区块浮层；数据源＝/atf-ui/settings 鉴权 GET/POST，同源 cookie）。
     *  区块 1 根目录与存储（根/模型库·校验态红绿＋原因）；区块 2 运行环境（训练/评估 venv）；
     *  区块 3 训练卡数基线（占位＝探测拉满）；区块 4 只读信息（灰底）。根变更保存前弹确认卡。 */
    function SettingsPanel() {
      var open = React.useSyncExternalStore(
        function(fn) { return store.subscribe(fn) },
        function() { return store.settings !== null && store.settings !== undefined },
      )
      var _st = React.useState(null)
      var data = _st[0], setData = _st[1]
      var _err = React.useState({})
      var errors = _err[0], setErrors = _err[1]
      var _form = React.useState(null)
      var form = _form[0], setForm = _form[1]
      var _msg = React.useState(null)
      var msg = _msg[0], setMsg = _msg[1]
      React.useEffect(function() {
        if (!open) return
        fetch('/atf-ui/settings', { credentials: 'same-origin' })
          .then(function(r) { return r.json() })
          .then(function(d) {
            setData(d)
            setForm({
              atf_root: (d.storage.effective.atf_root || ''),
              model_root: (d.storage.effective.model_root || ''),
              train_env: (d.storage.effective.train_env || ''),
              eval_env: (d.storage.effective.eval_env || ''),
              train_gpu_baseline: (d.gpu_baseline_effective || ''),
            })
          })
          .catch(function() { setMsg({ kind: 'err', text: '设置面读取失败（鉴权或服务不可用）' }) })
      }, [open])
      if (!open) return null
      var field = function(key, label, placeholder, opts) {
        opts = opts || {}
        var err = errors[key]
        return React.createElement('div', { style: { marginBottom: 10 } },
          React.createElement('div', { style: { fontSize: 12, marginBottom: 3, color: 'var(--dsw-alias-label-primary,#1e293b)' } }, label),
          React.createElement('input', {
            value: (form && form[key]) || '', placeholder: placeholder || '',
            style: {
              width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '5px 8px', borderRadius: 6,
              border: err ? '1px solid var(--dsw-static-red-500)' : '1px solid var(--dsw-alias-border-l3)',
            },
            onChange: function(e) { setForm(Object.assign({}, form, (function(o){ o[key] = e.target.value; return o })({}))) },
          }),
          err ? React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-static-red-500)', marginTop: 2 } }, err) : null,
          opts.note ? React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#64748b)', marginTop: 2 } }, opts.note) : null)
      }
      var ro = (data && data.readonly) || {}
      var save = function() {
        if (form.atf_root !== ((data && data.storage.effective.atf_root) || '')) {
          // §三.4 根目录变更警示卡
          if (!window.confirm('根目录已改动：影响新建任务的目录归属，历史记录仍指向原位置。确认保存？')) return
        }
        setMsg(null)
        fetch('/atf-ui/settings', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ storage: form }),
        })
          .then(function(r) { return r.json().then(function(b) { return { status: r.status, body: b } }) })
          .then(function(r) {
            if (r.status === 400) { setErrors(r.body.errors || {}); setMsg({ kind: 'err', text: '保存被拒绝——请修正标红项' }); return }
            setErrors({})
            setMsg({
              kind: 'ok',
              text: '已保存' + ((r.body.created_subdirs || []).length > 0 ? '（已创建约定子目录：' + r.body.created_subdirs.join('、') + '）' : '') + (r.body.warning ? '。' + r.body.warning : ''),
            })
          })
          .catch(function() { setMsg({ kind: 'err', text: '保存失败（网络/服务不可用）' }) })
      }
      var blockTitle = function(t) { return React.createElement('div', { style: { fontWeight: 600, fontSize: 13, margin: '10px 0 6px', color: 'var(--dsw-alias-label-primary,#1e293b)' } }, t) }
      return React.createElement('div', {
        className: 'atf-viewer-overlay',
        onClick: function(e) { if (e.target === e.currentTarget) store.setSettings(null) },
      },
        React.createElement('div', { className: 'atf-viewer-frame', style: { width: 'min(680px,94vw)', height: 'auto', maxHeight: '88vh' } },
          React.createElement('div', { className: 'atf-viewer-head' },
            React.createElement('b', null, '设置'),
            React.createElement('span', { className: 'atf-viewer-empty' }, '根目录只影响新建任务的归属，现有数据位置不变'),
            React.createElement('button', { className: 'atf-pill', onClick: function() { store.setSettings(null) } }, '×')),
          React.createElement('div', { style: { padding: '10px 16px 16px', overflow: 'auto' } },
            !data ? React.createElement('div', { className: 'atf-viewer-empty' }, '设置面读取中…') : React.createElement('div', null,
              blockTitle('根目录与存储'),
              field('atf_root', 'ATF 根目录', '统一根目录绝对路径（约定子目录 datasets/runs/logs 自动创建）'),
              field('model_root', '模型库位置', '模型库绝对路径（改动＝下次任务生效）'),
              blockTitle('运行环境'),
              field('train_env', '训练环境（venv 绝对路径）', '未配置＝任务发起时询问'),
              field('eval_env', '评估环境（venv 绝对路径）', '未配置＝任务发起时询问'),
              blockTitle('训练卡数基线'),
              field('train_gpu_baseline', '训练卡数基线', '默认＝探测可用卡数拉满（' + String((data && data.gpu_detected) || '—') + ' 卡）；确认卡仍可逐次改'),
              blockTitle('只读信息'),
              React.createElement('div', { style: { fontSize: 12, background: 'rgba(128,128,128,.08)', borderRadius: 8, padding: '8px 10px', lineHeight: 1.8 } },
                React.createElement('div', null, '内核版本：' + (ro.kernel_version || '—')),
                React.createElement('div', null, '审批记录位置：' + (ro.approval_ledger || '—')),
                React.createElement('div', null, '模型凭据：' + (ro.key_status || '—')),
                React.createElement('div', null, '实例：' + (ro.instance_id || '—'))),
              msg ? React.createElement('div', { style: { fontSize: 12, marginTop: 10, color: msg.kind === 'err' ? 'var(--dsw-static-red-500)' : 'var(--dsw-static-green-500)' } }, msg.text) : null,
              React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 } },
                React.createElement('button', { className: 'atf-pill', onClick: function() { store.setSettings(null) } }, '关闭'),
                React.createElement('button', { className: 'atf-pill atf-train-send', onClick: save }, '保存'))))))
    }

    /** 发起训练对话框（批㉛段2）：run 选择＋IterationConfig 四件套摘要（含义＋值＋来源标注＋
     *  可改提示）＋DRY_RUN/真训形态＋生成发起消息（chat 通道走 atf_config_confirm 确认卡——
     *  批㉑ M2 内嵌审批通道，批准/驳回都在 chat 流）。摘要数据＝monitor.json launch.summary
     *  （同步器 buildIterationSummary 四件套——token_gate 语义＝构造准入闸门，非推理截断根因）。 */
    function TrainDialog() {
      var train = React.useSyncExternalStore(
        function(fn) { return store.subscribe(fn) },
        function() { return store.train },
      )
      var mon = useMonitor()
      var candidates = launchableRuns(mon)
      var runId = train && train.runId && candidates.some(function(r) { return r.run_id === train.runId })
        ? train.runId
        : (candidates[0] ? candidates[0].run_id : null)
      var run = runId ? candidates.find(function(r) { return r.run_id === runId }) : null
      var mode = train && train.mode === 'real' ? 'real' : 'dry_run'
      if (train === null) return null
      var summary = (run && run.launch && run.launch.summary) || []
      var sendMsg = function() {
        var iterCount = summary.filter(function(row) { return row.source === 'iteration_config' }).length
        var msg = trainLaunchMessage({ run_id: runId, mode: mode, summaryCount: iterCount })
        var input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]')
        if (input) {
          input.focus()
          document.execCommand('insertText', false, msg)
        }
        store.setTrain(null)
      }
      return React.createElement('div', {
        className: 'atf-viewer-overlay',
        onClick: function(e) { if (e.target === e.currentTarget) store.setTrain(null) },
      },
        React.createElement('div', { className: 'atf-viewer-frame atf-train-frame' },
          React.createElement('div', { className: 'atf-viewer-head' },
            React.createElement('b', null, '发起训练'),
            candidates.length > 0
              ? React.createElement('select', {
                  className: 'atf-viewer-select',
                  value: runId || '',
                  onChange: function(e) { store.setTrain({ runId: e.target.value, mode: mode }) },
                },
                candidates.map(function(r) {
                  return React.createElement('option', { key: r.run_id, value: r.run_id }, r.run_id)
                }))
              : React.createElement('span', { className: 'atf-viewer-empty' }, '（当前 runsRoot 无可发起 run——需 train.sh 或 IterationConfig 在场）'),
            React.createElement('button', { className: 'atf-pill', title: '关闭', onClick: function() { store.setTrain(null) } }, '×')),
          runId
            ? React.createElement('div', { className: 'atf-train-body' },
                React.createElement('div', { className: 'atf-train-facts' },
                  React.createElement('span', null, 'train.sh：' + (run.launch.train_sh ? '在场 ✓' : '缺席（需先走 prepare 链）')),
                  React.createElement('span', null, 'prelaunch 报告：' + (run.launch.prelaunch_report ? '在场 ✓' : '缺席（链内按 SKILL.md:84 生成）')),
                  React.createElement('span', null, '配置快照：' + (run.launch.config_snapshot ? '已确认 ✓' : '未确认（确认卡后落盘）'))),
                React.createElement('div', { className: 'atf-train-mode' },
                  React.createElement('label', null,
                    React.createElement('input', {
                      type: 'radio', name: 'atf-train-mode', checked: mode === 'dry_run',
                      onChange: function() { store.setTrain({ runId: runId, mode: 'dry_run' }) },
                    }), 'DRY_RUN 验收（缺省——确认卡→DRY_RUN 校验→账本核验后止步，不开真训）'),
                  React.createElement('label', null,
                    React.createElement('input', {
                      type: 'radio', name: 'atf-train-mode', checked: mode === 'real',
                      onChange: function() { store.setTrain({ runId: runId, mode: 'real' }) },
                    }), '真实训练（须 owner 单独书面点头；单卡 ≤180min 授权轴）')),
                React.createElement('div', { className: 'atf-train-summary' },
                  React.createElement('div', { className: 'atf-train-sum-head' },
                    React.createElement('span', null, 'IterationConfig 摘要（四件套：含义＋值＋来源标注＋可改）'),
                    React.createElement('span', { className: 'atf-viewer-empty' }, '改法：消息/卡面回复如「lr 改 2e-4」')),
                  summary.map(function(row) {
                    return React.createElement('div', { key: row.key, className: 'atf-train-row' },
                      React.createElement('span', { className: 'atf-train-key', title: row.meaning }, row.key),
                      React.createElement('span', { className: 'atf-train-val' }, row.value),
                      React.createElement('span', {
                        className: 'atf-train-src' + (row.source === 'default' ? ' atf-train-src-warn' : ''),
                      }, row.source === 'iteration_config' ? '来自 IterationConfig' : row.source === 'config_snapshot' ? '来自登记快照' : '缺省/KB 未校准 ⚠'),
                      React.createElement('span', { className: 'atf-train-mean', title: row.meaning }, row.meaning.split('｜')[0]))
                  })),
                React.createElement('div', { className: 'atf-train-actions' },
                  React.createElement('button', { className: 'atf-pill atf-train-send', onClick: sendMsg }, '生成发起消息（进 chat 正道链）'),
                  React.createElement('span', { className: 'atf-viewer-empty' }, '消息进 chat 后走确认卡批准/驳回（M2 内嵌通道）；批准≠放行真训——真训另有闸。')))
            : null))
    }

    // ── 批㊶-M M-4：悬浮任务卡（portal 会话区右上角；turnTail 卡下线迁移至此——
    // 批㊶-K 项4→批㊶-M 迁移留痕）。数据源＝monitor.json 既有字段（segments 四态数组/
    // training.points/train_loss/eval_rounds），零新数据面。四态色唯一来源＝DSH design
    // token（--dsw-static-*／--dsw-alias-*），亮暗主题随 token 自动切换，禁硬编码 hex。
    var STATE_COLORS = {
      done: 'var(--dsw-static-green-500)',
      active: 'var(--dsw-static-amber-500)',
      pending: 'var(--dsw-static-neutral-500)',
      fail: 'var(--dsw-static-red-500)',
    }
    var STATE_PENDING_DOT = 'var(--dsw-static-neutral-400)'
    function taskStateOf(active, run) {
      // 四态推导（纯函数——src/client.taskState.ts 单源同构，vitest 直测那份）：训练中/失败/完成/空闲
      if (run === null || run === undefined) return 'idle'
      var trainingNow = run.training && run.training.active === true
      if (trainingNow) return 'active'
      // 批㊶-S3 S-B2 修复④：snapshot 四态串是 'failed'（旧查 'fail' 恒不命中——失败态永不显示）
      var failed = (run.segments || []).some(function(seg) { return seg.status === 'failed' })
      if (failed) return 'fail'
      if ((run.segments || []).some(function(seg) { return seg.status === 'done' })) return 'done'
      return 'idle'
    }
    var STATE_TEXT = { done: '已完成', active: '训练中', fail: '失败', idle: '空闲' }
    var SEGMENT_MARK = { done: '✓', active: '●', pending: '○' }
    function segmentMark(status) { return SEGMENT_MARK[status] || '✗' }

    // ── 批㊶-S3 S-B1：评估就绪/可评估会话内通知卡（读账播报零造值）。
    // 数据源＝monitor.json runs[].eval_notices/eval_progress（additive——同步器读内核编排
    // orch/progress.jsonl 推导阶段流转，服务端只读账不造值；客户端按 id 去重渲染）。
    // 「SSE 通道」字面的承载说明：live 链（本扩展）无 SSE 端点（src/webui 历史层才有且
    // S2a 裁定勿改）——事件驱动语义由「服务端读账状态机＋客户端新 id 渲染」等价承载，
    // 偏离登记候 owner 验。已读集 localStorage（重启/重开页不重弹旧跳）。
    var NOTICE_SEEN_KEY = 'atf_seen_notices'
    var EVAL_NOTICE_MAX_AGE_MS = 24 * 3600 * 1000
    var PHASE_TEXT = { launching: '评估服务启动中', initializing: '评估服务初始化中', ready: '评估服务就绪', failed: '评估服务失败' }
    var PHASE_COLOR = {
      launching: 'var(--dsw-static-amber-500)', initializing: 'var(--dsw-static-amber-500)',
      ready: 'var(--dsw-static-green-500)', failed: 'var(--dsw-static-red-500)', trainable: 'var(--dsw-static-green-500)',
    }
    function noticeSeenMap() {
      try { var raw = window.localStorage.getItem(NOTICE_SEEN_KEY); return raw === null ? {} : (JSON.parse(raw) || {}) } catch (e) { return {} }
    }
    function markNoticeSeen(id) {
      try {
        var seen = noticeSeenMap()
        seen[id] = Date.now()
        var keys = Object.keys(seen)
        if (keys.length > 200) {
          keys.sort(function(a, b) { return seen[a] - seen[b] })
          for (var k = 0; k < keys.length - 200; k++) delete seen[keys[k]]
        }
        window.localStorage.setItem(NOTICE_SEEN_KEY, JSON.stringify(seen))
      } catch (e) { /* localStorage 不可用＝会话内去重降级（不阻塞监控主面） */ }
    }
    function noticeText(n) {
      if (n && n.kind === 'trainable') return '训练收尾完成，可发起评估（atf_evaluate）'
      var phase = n && typeof n.phase === 'string' ? n.phase : ''
      var text = PHASE_TEXT[phase] || phase
      var bits = []
      if (typeof n.detail === 'string' && n.detail !== '') bits.push(n.detail)
      if (typeof n.elapsed_s === 'number') bits.push('已等待 ' + n.elapsed_s + 's')
      return bits.length > 0 ? text + ' · ' + bits.join(' · ') : text
    }
    function EvalNoticeStack() {
      var mon = useMonitor()
      var forceState = React.useState(0)
      var force = forceState[1]
      var sid = store.sessionId
      if (mon === null || !sid) return null
      var seen = noticeSeenMap()
      var now = Date.now()
      var cards = []
      var pool = scopedRuns(mon, sid)
      for (var i = 0; i < pool.length; i++) {
        var run = pool[i]
        var notices = Array.isArray(run.eval_notices) ? run.eval_notices : []
        for (var j = 0; j < notices.length; j++) {
          var n = notices[j]
          if (n === null || typeof n !== 'object' || typeof n.id !== 'string') continue
          if (seen[n.id]) continue
          var at = Date.parse(typeof n.at === 'string' ? n.at : '')
          if (Number.isFinite(at) && now - at > EVAL_NOTICE_MAX_AGE_MS) continue
          cards.push({ runId: run.run_id || '', n: n })
        }
      }
      if (cards.length === 0) return null
      return React.createElement('div', { style: { position: 'fixed', right: 'calc(16px + var(--atf-pane-offset, 0px))', top: (topBarOffset() + 56), display: 'flex', flexDirection: 'column', gap: 8, zIndex: 799, maxWidth: 320 } },
        cards.slice(-4).map(function(card) {
          var n = card.n
          var color = PHASE_COLOR[n.kind === 'trainable' ? 'trainable' : (typeof n.phase === 'string' ? n.phase : '')] || 'var(--dsw-static-neutral-500)'
          return React.createElement('div', {
            key: n.id,
            className: 'atf-notice-card',
            style: {
              border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 10, padding: '8px 10px',
              background: 'var(--dsw-alias-bg-layer-2)', boxShadow: '0 4px 16px rgba(0,0,0,.12)',
              display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12,
            },
            onClick: function() { markNoticeSeen(n.id); force(function(v) { return v + 1 }) },
            title: '点击关闭（run ' + card.runId + '）',
          },
            React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: color, flex: 'none', marginTop: 4 } }),
            React.createElement('div', { style: { flex: 1, minWidth: 0 } },
              React.createElement('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, noticeText(n)),
              React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, card.runId)),
            React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', flex: 'none', padding: '0 2px' } }, '×'))
        }))
    }

    /** 悬浮任务卡（收起徽标默认；展开四区——附录 A 规格）。 */
    function FloatingTaskCard() {
      // 批㊶-N N-5：作用域收窄——本会话绑定集（未绑定存量 run 不进浮卡）；hooks 全部前置
      var mon = useMonitor()
      var expandedState = React.useState(false)
      var expanded = expandedState[0], setExpanded = expandedState[1]
      var seenStateRef = React.useRef(null)
      var pulseState = React.useState(0)
      var pulseTick = pulseState[1]
      var active = mon === null ? null : pickScopedActiveRun(mon, store.sessionId)
      var run = active !== null ? active.run : null
      var progress = run !== null && run.training && run.training.active === true ? (run.progress || null) : null
      var state = taskStateOf(active, run)
      // 批㊶-P P-2：探针告警红点（error 红/warn 琥珀，沿 DSH token；批㊶-Q info＝品牌色通报点）
      var probe = (run && run.probe) || null
      var probeDot = probe !== null
        ? React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, flex: 'none', background: probe.level === 'error' ? 'var(--dsw-static-red-500)' : probe.level === 'warn' ? 'var(--dsw-static-amber-500)' : 'var(--dsw-alias-brand-primary,#1d4ed8)' }, title: probe.reason })
        : null
      // 段状态跃迁呼吸一次（一次性 tick 触发 CSS animation 重放；不循环）
      React.useEffect(function() {
        var key = run ? run.run_id + ':' + state + ':' + (active ? active.done : 0) : ''
        if (seenStateRef.current !== null && seenStateRef.current !== key) pulseTick(function(n) { return n + 1 })
        seenStateRef.current = key
      }, [run ? run.run_id : '', state, active ? active.done : 0])
      if (run === null) return null
      var color = STATE_COLORS[state]
      var colorText = state === 'pending' ? 'var(--dsw-static-neutral-500)' : color
      var pts = (run.training && run.training.points) || []
      var lastLoss = null
      for (var i = pts.length - 1; i >= 0; i--) {
        if (typeof pts[i].train_loss === 'number') { lastLoss = pts[i].train_loss; break }
      }
      var lastCkpt = Array.isArray(run.ckpts) && run.ckpts.length > 0 ? run.ckpts[run.ckpts.length - 1] : null
      var segDetail = function(seg) {
        if (seg.key === 'training') {
          // 批㊶-N N-3：段内进度优先（"第 6/8 轮 · 剩余 17 步 · loss 0.0589"——无回退 loss/ckpt）
          if (progress) {
            var bits = []
            // 批㊶-S3 S-B2 修复③：步进百分比上卡（trainer_log percentage 直通——持续写链 30s 刷新）
            if (typeof progress.percentage === 'number') bits.push(String(progress.percentage) + '%')
            if (typeof progress.eta_s === 'number' && progress.eta_s >= 0) {
              var eh = Math.floor(progress.eta_s / 3600), em = Math.floor((progress.eta_s % 3600) / 60), es2 = Math.floor(progress.eta_s % 60)
              var pad2 = function(n2) { return String(n2).padStart(2, '0') }
              bits.push('预计剩 ' + (eh > 0 ? eh + ':' + pad2(em) + ':' + pad2(es2) : pad2(em) + ':' + pad2(es2)))
            }
            if (typeof progress.round === 'number') bits.push(typeof progress.total_rounds === 'number' ? '第 ' + progress.round + '/' + progress.total_rounds + ' 轮' : '第 ' + progress.round + ' 轮')
            if (typeof progress.step_remaining === 'number') bits.push('剩余 ' + progress.step_remaining + ' 步')
            if (typeof progress.loss === 'number') bits.push('loss ' + progress.loss)
            if (bits.length > 0) return bits.join(' · ')
          }
          if (lastLoss !== null) return 'loss ' + lastLoss
          if (lastCkpt !== null) return String(lastCkpt)
          return ''
        }
        if (seg.key === 'evaluate' && Array.isArray(run.eval_rounds) && run.eval_rounds.length > 0) {
          var lastRound = run.eval_rounds[run.eval_rounds.length - 1]
          return lastRound && lastRound.round ? String(lastRound.round) : ''
        }
        return ''
      }
      var pulseStyle = pulseTick !== null && pulseTick !== undefined
        ? { animation: 'atf-card-pulse 1.2s ease-in-out 1' }
        : undefined
      if (!expanded) {
        // A-1 收起徽标态（横向胶囊；四态配色；呼吸一次）
        return React.createElement('div', {
          className: 'atf-task-card-collapsed' + (pulseTick > 0 ? ' atf-card-pulsing' : ''),
          style: {
            position: 'fixed', right: 'calc(16px + var(--atf-pane-offset, 0px))', top: (topBarOffset() + 16),
            display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 12px',
            borderRadius: 16, cursor: 'pointer', zIndex: 800,
            border: '1px solid ' + (state === 'fail' ? 'var(--dsw-static-red-500)' : 'var(--dsw-alias-border-l3)'),
            background: 'var(--dsw-alias-bg-layer-2)',
            boxShadow: '0 2px 8px rgba(0,0,0,.10)',
            ...pulseStyle,
          },
          onClick: function() { setExpanded(true) },
          title: '展开训练任务进度（八段明细）',
        },
          React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: color, flex: 'none' } }),
          probeDot,
          // 批㊶-N N-3：训练中态徽标优先段内进度（"第 6/8 轮"——无则回退 N/8）
          // 批㊶-TRAIN-OBS-FIX2 T2 裁定（10-15）：收起徽标＝进度百分比优先（训练中实时）；
          // 无百分比回退轮比例（round/total_rounds）→ 段比例（done/8）——additive 不占位
          React.createElement('span', { style: { fontFamily: 'monospace', fontSize: 13, color: colorText, fontWeight: 600 } },
            state === 'active' && progress
              ? (typeof progress.percentage === 'number'
                  ? Math.round(progress.percentage) + '%'
                  : typeof progress.round === 'number'
                    ? (typeof progress.total_rounds === 'number' ? progress.round + '/' + progress.total_rounds : String(progress.round))
                    : (active ? active.done : 0) + '/8')
              : (active ? active.done : 0) + '/8'),
          React.createElement('span', { style: { fontSize: 12, color: colorText } }, STATE_TEXT[state]))
      }
      // A-2 展开态（264px 四区）
      return React.createElement('div', {
        className: 'atf-task-card',
        style: {
          position: 'fixed', right: 'calc(16px + var(--atf-pane-offset, 0px))', top: (topBarOffset() + 16), width: 264, zIndex: 800,
          borderRadius: 12, border: '1px solid var(--dsw-alias-border-l3)',
          background: 'var(--dsw-alias-bg-layer-2)', boxShadow: '0 6px 24px rgba(0,0,0,.14)',
          padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
        },
      },
        // ① 头部行
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 8, borderBottom: '1px solid var(--dsw-alias-border-l4)' } },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '训练任务'),
          React.createElement('span', { style: { display: 'inline-flex', gap: 8 } },
            React.createElement('button', {
              className: 'atf-pill', title: '收起为徽标', style: { padding: '0 6px' },
              onClick: function() { setExpanded(false) },
            }, '⤢'),
            React.createElement('button', {
              className: 'atf-pill', title: '更多（占位）', style: { padding: '0 6px' },
              onClick: function() { /* 菜单占位 */ },
            }, '···'))),
        // ② 进度区（大数字＋态标＋run 行）
        React.createElement('div', null,
          React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
            React.createElement('span', { style: { fontSize: 28, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', fontFamily: 'monospace' } },
              (active ? active.done : 0), React.createElement('span', { style: { fontSize: 14, color: 'var(--dsw-alias-label-tertiary)' } }, '/8')),
            React.createElement('span', {
              style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: colorText,
                border: '1px solid ' + color, borderRadius: 10, padding: '1px 8px' },
            },
              React.createElement('span', { style: { width: 7, height: 7, borderRadius: 4, background: color, display: 'inline-block', ...(state === 'active' ? { animation: 'atf-card-pulse 1.2s ease-in-out infinite' } : {}) } }),
              STATE_TEXT[state])),
          React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'monospace', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            run.run_id)),
        // ③ 八段清单区
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
          (run.segments || []).map(function(seg, idx) {
            var markColor = seg.status === 'done' ? STATE_COLORS.done : seg.status === 'active' ? STATE_COLORS.active : seg.status === 'pending' ? STATE_PENDING_DOT : STATE_COLORS.fail
            var detail = segDetail(seg)
            return React.createElement('div', { key: seg.key || idx, style: { display: 'flex', gap: 8, padding: '5px 0', alignItems: 'flex-start' } },
              React.createElement('span', {
                style: { width: 18, height: 18, borderRadius: 9, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, color: seg.status === 'pending' ? 'var(--dsw-alias-label-tertiary)' : '#fff',
                  background: seg.status === 'done' ? STATE_COLORS.done : seg.status === 'active' ? STATE_COLORS.active : seg.status === 'pending' ? 'transparent' : STATE_COLORS.fail,
                  border: seg.status === 'pending' ? '1px solid ' + STATE_PENDING_DOT : 'none',
                  ...(seg.status === 'active' ? { animation: 'atf-card-pulse 1.2s ease-in-out infinite' } : {}),
                },
              }, seg.status === 'pending' ? '' : segmentMark(seg.status)),
              React.createElement('div', { style: { display: 'flex', flexDirection: 'column', lineHeight: 1.3 } },
                React.createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, seg.label || seg.key || ''),
                detail !== '' ? React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'monospace' } }, detail) : null))
          })),
        // ④ 动作行
        React.createElement(TrainlogTailSection, { run: run }),
        React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          React.createElement('button', {
            className: 'atf-pill', title: '打开右栏训练监控（Loss 曲线）',
            onClick: function() { store.setMonitor(true, run.run_id) },
          }, '查看曲线'),
          React.createElement('button', {
            className: 'atf-pill', title: '查询训练任务状态',
            onClick: function() {
              var input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]')
              if (input) {
                input.focus()
                document.execCommand('insertText', false, '查看当前训练任务状态：调用 atf_run_training action=status，run_id=' + run.run_id + '，并把八段任务卡贴出来')
              }
            },
          }, '查状态')))
    }
    /** 批㊶-N N-4：浮卡展开态（dock chip 点击展开——fixed 定位不随 dock；内容同 A-2 四区）。 */
    function FloatingTaskCardExpanded() {
      var mon = useMonitor()
      var open = React.useSyncExternalStore(
        function(fn) { return store.subscribe(fn) },
        function() { return store.taskCardOpen },
      )
      var active = mon === null ? null : pickScopedActiveRun(mon, store.sessionId)
      if (!open || active === null) return null
      var run = active.run
      var trainingNow = !!(run.training && run.training.active === true)
      var state = taskStateOf(active, run)
      var color = STATE_COLORS[state]
      var progress = trainingNow ? (run.progress || null) : null
      var segDetail = function(seg) {
        if (seg.key === 'training') {
          if (progress) {
            var bits = []
            // 批㊶-S3 S-B2 修复③：步进百分比上卡（trainer_log percentage 直通——持续写链 30s 刷新）
            if (typeof progress.percentage === 'number') bits.push(String(progress.percentage) + '%')
            if (typeof progress.eta_s === 'number' && progress.eta_s >= 0) {
              var eh = Math.floor(progress.eta_s / 3600), em = Math.floor((progress.eta_s % 3600) / 60), es2 = Math.floor(progress.eta_s % 60)
              var pad2 = function(n2) { return String(n2).padStart(2, '0') }
              bits.push('预计剩 ' + (eh > 0 ? eh + ':' + pad2(em) + ':' + pad2(es2) : pad2(em) + ':' + pad2(es2)))
            }
            if (typeof progress.round === 'number') bits.push(typeof progress.total_rounds === 'number' ? '第 ' + progress.round + '/' + progress.total_rounds + ' 轮' : '第 ' + progress.round + ' 轮')
            if (typeof progress.step_remaining === 'number') bits.push('剩余 ' + progress.step_remaining + ' 步')
            if (typeof progress.loss === 'number') bits.push('loss ' + progress.loss)
            if (bits.length > 0) return bits.join(' · ')
          }
          return Array.isArray(run.ckpts) && run.ckpts.length > 0 ? String(run.ckpts[run.ckpts.length - 1]) : ''
        }
        if (seg.key === 'evaluate' && Array.isArray(run.eval_rounds) && run.eval_rounds.length > 0) {
          var lastRound = run.eval_rounds[run.eval_rounds.length - 1]
          return lastRound && lastRound.round ? String(lastRound.round) : ''
        }
        return ''
      }
      return React.createElement('div', {
        className: 'atf-task-card',
        style: {
          position: 'fixed', right: 'calc(16px + var(--atf-pane-offset, 0px))', top: (topBarOffset() + 16), width: 264, zIndex: 800,
          borderRadius: 12, border: '1px solid var(--dsw-alias-border-l3)',
          background: 'var(--dsw-alias-bg-layer-2)', boxShadow: '0 6px 24px rgba(0,0,0,.14)',
          padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
        },
      },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 8, borderBottom: '1px solid var(--dsw-alias-border-l4)' } },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '训练任务'),
          React.createElement('button', {
            className: 'atf-pill', title: '收起为徽标', style: { padding: '0 6px' },
            onClick: function() { store.setTaskCard(false) },
          }, '⤢')),
        React.createElement('div', null,
          React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
            React.createElement('span', { style: { fontSize: 28, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', fontFamily: 'monospace' } },
              active.done, React.createElement('span', { style: { fontSize: 14, color: 'var(--dsw-alias-label-tertiary)' } }, '/8')),
            React.createElement('span', {
              style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: color,
                border: '1px solid ' + color, borderRadius: 10, padding: '1px 8px' },
            },
              React.createElement('span', { style: { width: 7, height: 7, borderRadius: 4, background: color, display: 'inline-block', ...(trainingNow ? { animation: 'atf-card-pulse 1.2s ease-in-out infinite' } : {}) } }),
              STATE_TEXT[state])),
          React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'monospace', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            run.run_id)),
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
          (run.segments || []).map(function(seg, idx) {
            var detail = segDetail(seg)
            return React.createElement('div', { key: seg.key || idx, style: { display: 'flex', gap: 8, padding: '5px 0', alignItems: 'flex-start' } },
              React.createElement('span', {
                style: { width: 18, height: 18, borderRadius: 9, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, color: seg.status === 'pending' ? 'var(--dsw-alias-label-tertiary)' : '#fff',
                  background: seg.status === 'done' ? STATE_COLORS.done : seg.status === 'active' ? STATE_COLORS.active : seg.status === 'pending' ? 'transparent' : STATE_COLORS.fail,
                  border: seg.status === 'pending' ? '1px solid ' + STATE_PENDING_DOT : 'none',
                  ...(seg.status === 'active' ? { animation: 'atf-card-pulse 1.2s ease-in-out infinite' } : {}),
                },
              }, seg.status === 'pending' ? '' : segmentMark(seg.status)),
              React.createElement('div', { style: { display: 'flex', flexDirection: 'column', lineHeight: 1.3 } },
                React.createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, seg.label || seg.key || ''),
                detail !== '' ? React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'monospace' } }, detail) : null))
          })),
        React.createElement(TrainlogTailSection, { run: run }),
        React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          React.createElement('button', {
            className: 'atf-pill', title: '打开右栏训练监控（Loss 曲线）',
            onClick: function() { store.setMonitor(true, run.run_id) },
          }, '查看曲线'),
          React.createElement('button', {
            className: 'atf-pill', title: '查询训练任务状态',
            onClick: function() {
              var input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]')
              if (input) {
                input.focus()
                document.execCommand('insertText', false, '查看当前训练任务状态：调用 atf_run_training action=status，run_id=' + run.run_id + '，并把八段任务卡贴出来')
              }
            },
          }, '查状态')))
    }

    /** 宿主顶栏实高（批㊶-L L-4 测量先例——候选链＋回落 56，静默）。 */
    function topBarOffset() {
      try {
        var bar = document.querySelector('header') || document.querySelector('[class*="topbar"]') || document.querySelector('[class*="app-header"]')
        if (bar && bar.offsetHeight > 0) return bar.offsetHeight + 4
      } catch (e) { /* 静默 */ }
      return 56
    }

    /** dock 单训练状态 chip（批㊶-N N-4——三徽章撤销：GPU 摘要与内核版本移监控面板头部区，
     *  推进 run 并入主 chip 语义）。规格取舍（附录 B 二选一）：单行紧凑式——多 run 场景双行
     *  标签行占版面且与浮卡重复；单行 32px 高与快捷胶囊同构可读性最佳，注释说明取舍。
     *  绑定作用域（N-5）：pickActiveRun 收窄至当前会话绑定集（sessionId 由 header.utilities
     *  捕获通道；monitor.json bound_sessions 单源过滤——未绑定存量 run 不进浮卡/dock）。 */
    function pickScopedActiveRun(mon, sessionId) {
      if (!mon || !Array.isArray(mon.runs)) return null
      // 批㊶Q增补三 段3：作用域＝本会话绑定 ∪ 同工作区桶（scopedRuns；无绑定集＝不进浮卡/dock——存量未绑定归全部视图）
      const scopeRuns = sessionId ? scopedRuns(mon, sessionId) : null
      const pool = scopeRuns && scopeRuns.length > 0 ? scopeRuns : []  // 无绑定集＝不进浮卡/dock（存量未绑定归全部视图）
      for (let i = 0; i < pool.length; i++) {
        const run = pool[i]
        const segs = run.segments || []
        const done = segs.filter(function(s) { return s.status === 'done' }).length
        const trainingActive = run.training && run.training.active === true
        const waiting = segs.some(function(s) { return s.key === 'experiment_config' && s.status === 'active' })
        // 批㊶-N：绑定 run 恒为候选（段全 pending 也进——绑定语义＝本会话正在推进的 run）
        if (pool.length > 0) {
          const progress = trainingNowFresh(run) ? run.progress : null
          return { run, done, total: segs.length, trainingActive, waiting, progress }
        }
      }
      return null
    }
    function trainingNowFresh(run) {
      return !!(run && run.training && run.training.active === true)
    }

    // ── 批㊶-TRAIN-OBS-FIX 断点 C：日志尾部折叠区（capture-pane 采集面渲染收口）。
    // 数据源＝monitor.json runs[].trainlog_tail（两键闭集 captured_at/lines）；默认折叠、
    // 展开等宽只读、行尾省略；字段缺席不渲染不占位。captured_at 相对时间标注。
    function fmtRelTime(iso) {
      var at = Date.parse(iso)
      if (!isFinite(at)) return ''
      var d = Math.max(0, Date.now() - at)
      var m = Math.floor(d / 60000)
      if (m < 1) return '刚刚'
      if (m < 60) return m + ' 分钟前'
      var h = Math.floor(m / 60)
      return h + ' 小时前'
    }
    function TrainlogTailSection(props) {
      // 批㊶-TRAIN-OBS-FIX2：组件边界修正——本节内含 useState，须以 React.createElement
      // 挂载（直调形态把钩子记入调用方，条件挂载即 React #310 整槽崩溃——浮卡两条展开
      // 路径实锚）。props.run 取 run。
      var run = props.run
      var open = React.useState(false)
      var isOpen = open[0], setOpen = open[1]
      var tail = run && run.trainlog_tail
      if (tail === null || tail === undefined || !Array.isArray(tail.lines) || tail.lines.length === 0) return null
      var rel = fmtRelTime(tail.captured_at)
      return React.createElement('details', {
        className: 'atf-trainlog-tail',
        style: { margin: '8px 0', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: '6px 8px' },
        onToggle: function(e) { setOpen(e.target.open) },
      },
        React.createElement('summary', { style: { cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } },
          '训练日志（尾部 ' + tail.lines.length + ' 行' + (rel !== '' ? ' · ' + rel : '') + '）'),
        isOpen ? React.createElement('pre', {
          style: {
            margin: '6px 0 0', padding: '6px 8px', borderRadius: 6, maxHeight: 240, overflow: 'auto',
            fontFamily: 'monospace', fontSize: 11, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            color: 'var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary,#94a3b8))',
            background: 'var(--dsw-alias-bg-layer-3,rgba(128,128,128,.08))',
          },
        }, tail.lines.join('\n')) : null)
    }

    /** 训练状态单 chip（dock 主行；点击＝展开浮卡）。 */
    function GpuCard() {
      var open = React.useSyncExternalStore(
        function(fn) { return store.subscribe(fn) },
        function() { return store.getOpen() },
      )
      var mon = useMonitor()
      if (!open) return null
      var active = pickScopedActiveRun(mon, store.sessionId)
      var text, valueColor, title
      if (active === null) {
        text = '无训练进行中'
        valueColor = 'var(--dsw-static-neutral-500)'
        title = '当前会话无绑定训练 run——历史 run 走右栏监控面板"全部实例"视图'
      } else {
        var runTail = String(active.run.run_id).split('-').slice(-2).join('-')
        var prog = active.progress || null
        if (prog && typeof prog.round === 'number') {
          var seg = []
          seg.push(typeof prog.total_rounds === 'number' ? '第 ' + prog.round + '/' + prog.total_rounds + ' 轮' : '第 ' + prog.round + ' 轮')
          if (typeof prog.loss === 'number') seg.push('loss ' + prog.loss)
          text = runTail + ' · ' + seg.join(' · ')
        } else {
          text = runTail + ' · 段 ' + active.done + '/' + active.total
        }
        valueColor = active.trainingActive ? 'var(--dsw-static-amber-500)' : 'var(--dsw-alias-label-primary)'
        title = '训练任务：' + active.run.run_id + '（点击展开浮卡）'
      }
      return React.createElement('div', {
        className: 'atf-gpu-card',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 12px',
          borderRadius: 16, cursor: 'pointer', fontSize: 12,
          border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-2)',
        },
        onClick: function() { store.setTaskCard(!store.taskCardOpen) },
        title: title,
      },
        React.createElement('span', { style: { color: valueColor, fontWeight: 600 } }, text))
    }

    /** badcase viewer 浮层（批㉛段1）：run 维度选择＋iframe 内嵌渲染 viewer.html
     *  （不重建 viewer 本身——静态服务路由 /atf-ui/viewer/<runId>/ 同源 cookie 鉴权）。 */
    function ViewerOverlay() {
      var viewer = React.useSyncExternalStore(
        function(fn) { return store.subscribe(fn) },
        function() { return store.viewer },
      )
      var mon = useMonitor()
      var candidates = runsWithViewers(mon)
      var runId = viewer && candidates.some(function(r) { return r.run_id === viewer.runId })
        ? viewer.runId
        : (candidates[0] ? candidates[0].run_id : (viewer ? viewer.runId : null))
      if (viewer === null) return null
      return React.createElement('div', {
        className: 'atf-viewer-overlay',
        onClick: function(e) { if (e.target === e.currentTarget) store.setViewer(null) },
      },
        React.createElement('div', { className: 'atf-viewer-frame' },
          React.createElement('div', { className: 'atf-viewer-head' },
            React.createElement('b', null, 'badcase 可视化'),
            candidates.length > 0
              ? React.createElement('select', {
                  className: 'atf-viewer-select',
                  value: runId || '',
                  onChange: function(e) { store.setViewer({ runId: e.target.value }) },
                },
                candidates.map(function(r) {
                  return React.createElement('option', { key: r.run_id, value: r.run_id }, r.run_id)
                }))
              : React.createElement('span', { className: 'atf-viewer-empty' }, '（当前 runsRoot 无 viewer 产物——先跑 atf-analyze-badcases 生成）'),
            React.createElement('button', {
              className: 'atf-pill', title: '关闭',
              onClick: function() { store.setViewer(null) },
            }, '×')),
          runId
            ? React.createElement('iframe', {
                className: 'atf-viewer-iframe',
                src: '/atf-ui/viewer/' + encodeURIComponent(runId) + '/',
                title: 'badcase viewer',
              })
            : null))
    }

    var PILLS = [
      { label: '新建训练', msg: '我想启动一个新的训练任务' },
      { label: '查状态', msg: '查看当前训练任务状态' },
      { label: '继续上次', msg: '继续上次的训练任务' },
      { label: '对比两轮', msg: '对比最近两轮训练的指标' },
    ]

    // 批㊳ M3-2：ATF 品牌位组件（文字标——owner 终验可调；mark 位收宿主 {size} 呈现请求，
    // hero 位另传 className 一并透传，宿主样式不丢）
    function AtfBrandMark(props) {
      var size = (props && props.size) || 24
      return React.createElement('span', {
        className: props && props.className,
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: size, height: size, borderRadius: Math.max(4, Math.round(size / 5)),
          background: '#1d4ed8', color: '#fff', fontWeight: 700,
          fontSize: Math.round(size * 0.4), letterSpacing: '.02em',
          fontFamily: 'system-ui,-apple-system,sans-serif', flex: 'none',
        },
      }, 'ATF')
    }

    function AtfBrandName() {
      return React.createElement('span', {
        style: { fontWeight: 600, fontSize: 14, fontFamily: 'system-ui,-apple-system,sans-serif' },
      }, 'ATF 训练 Agent')
    }

    // ── 批甲-BUILD T1：思考档位快切（conversation.input.right 槽·输入框右下角与模型选择并排） ──
    // UI 闭集（owner 裁定，用户可见面零开发叙事——档位文案只此四值）；映射 provider 闭集
    // none/low/high/max 同位档（live 链 pi-ai 目录 zai-coding-cn glm-5.3 thinkingLevelMap
    // off/low/high/max——目录 effort id 逐一同位；关＝off 即不送思考参数的 GLM zai 语义位）。
    var EFFORT_CLOSED = [
      { id: 'off', label: 'Off(关)' },
      { id: 'low', label: 'Low(低)' },
      { id: 'high', label: 'High(高)' },
      { id: 'max', label: 'Max(最高)' },
    ]
    var effortLabelOf = function(id) {
      for (var i = 0; i < EFFORT_CLOSED.length; i++) {
        if (EFFORT_CLOSED[i].id === id) return EFFORT_CLOSED[i].label
      }
      return id
    }

    /** ModelDirectory 快照 → 当前模型 reasoning 面（与原生 ModelSelect 同构解析；未选中模型＝null）。 */
    function currentReasoningOf(state) {
      if (state === null || state === undefined || state.current === null) return null
      var groups = state.groups
      for (var gi = 0; gi < groups.length; gi++) {
        var group = groups[gi]
        if (group.id !== state.current.provider) continue
        for (var mi = 0; mi < group.models.length; mi++) {
          var model = group.models[mi]
          if (model.id === state.current.model) {
            return { provider: group.id, model: model.id, reasoning: model.reasoning }
          }
        }
      }
      return null
    }

    /** 思考档位快切控件（session-scoped slot 注入面 {available, directory, load, select}）。
     *  隐藏语义（地板）：无会话模型选中／模型无 reasoning 面（目录未声明档位）／subagent 寻址
     *  会话（Agent-bound RPC 不可达）——控件整体不出场，不出「可点但无效」的假面。
     *  组件边界：含 useState/useSyncExternalStore——slot 渲染必须 createElement 实例化
     *  （直调即 React #310 整槽崩溃，批㊶-TRAIN-OBS-FIX2 教训钉子）。 */
    function EffortSelect(props) {
      var injected = props || {}
      var available = injected.available === true
      var directory = injected.directory
      var state = React.useSyncExternalStore(
        function(fn) { return directory ? directory.subscribe(fn) : function() {} },
        function() { return directory ? directory.getSnapshot() : null },
      )
      var openState = React.useState(false)
      var open = openState[0], setOpen = openState[1]
      var errorState = React.useState(null)
      var error = errorState[0], setError = errorState[1]
      var busyState = React.useState(false)
      var busy = busyState[0], setBusy = busyState[1]
      var posState = React.useState(null)
      var pos = posState[0], setPos = posState[1]
      var triggerRef = React.useRef(null)

      var choice = currentReasoningOf(state)
      var reasoning = choice !== null ? choice.reasoning : undefined
      // 闭集∩目录：目录声明的档位才可切换（闭集外目录档位不进本控件——闭集为准；
      // 目录 efforts 空＝模型不支持思考档位 → 整体隐藏）
      var offered = []
      if (reasoning && reasoning.efforts && reasoning.efforts.length > 0) {
        for (var ci = 0; ci < EFFORT_CLOSED.length; ci++) {
          var candidate = EFFORT_CLOSED[ci]
          for (var li = 0; li < reasoning.efforts.length; li++) {
            if (reasoning.efforts[li].id === candidate.id) { offered.push(candidate); break }
          }
        }
      }
      var effectiveEffort = (reasoning && state.current && state.current.reasoningEffort !== undefined)
        ? state.current.reasoningEffort
        : (reasoning && reasoning.defaultEffort !== undefined ? reasoning.defaultEffort : undefined)
      var currentLabel = effectiveEffort === undefined ? '默认' : effortLabelOf(effectiveEffort)
      var pending = state.pending !== null && state.pending !== undefined
      var waiting = busy || pending

      var place = React.useCallback(function() {
        var rect = triggerRef.current && triggerRef.current.getBoundingClientRect()
        if (!rect) return
        setPos({
          right: Math.max(8, window.innerWidth - rect.right),
          bottom: Math.max(8, window.innerHeight - rect.top + 6),
        })
      }, [])

      React.useEffect(function() {
        if (!open) return
        place()
        var closeOutside = function(event) {
          var root = triggerRef.current && triggerRef.current.closest('.atf-effort-root')
          var menu = event.target && event.target.closest && event.target.closest('.atf-effort-menu')
          if (menu) return
          if (root && root.contains(event.target)) return
          setOpen(false)
        }
        var reposition = function() { place() }
        document.addEventListener('mousedown', closeOutside, true)
        window.addEventListener('resize', reposition)
        window.addEventListener('scroll', reposition, true)
        return function() {
          document.removeEventListener('mousedown', closeOutside, true)
          window.removeEventListener('resize', reposition)
          window.removeEventListener('scroll', reposition, true)
        }
      }, [open, place])

      if (state === null || state === undefined) return null
      if (!available || offered.length === 0) return null

      var toggle = function() {
        if (open) { setOpen(false); return }
        setError(null)
        if (typeof injected.load === 'function') injected.load()
        setOpen(true)
      }

      var switchTo = function(effortId) {
        if (waiting || choice === null) return
        setBusy(true)
        Promise.resolve(injected.select({
          provider: choice.provider,
          model: choice.model,
          reasoningEffort: effortId,
        })).then(function(result) {
          setBusy(false)
          if (result && result.ok === false) {
            // 拒绝路径如实显示：错误码＋原因原样呈现（不静默、不降档——当前档位不动）
            setError(String(result.error && result.error.code ? result.error.code : 'unknown') + ': ' + String(result.error && result.error.message ? result.error.message : '切换失败'))
            return
          }
          setError(null)
          setOpen(false)
        }).catch(function(cause) {
          setBusy(false)
          setError('切换异常: ' + String(cause && cause.message ? cause.message : cause))
        })
      }

      var menu = open
        ? ReactDOM.createPortal(
            React.createElement('div', {
              className: 'atf-effort-menu',
              role: 'menu',
              'aria-label': '思考档位',
              style: pos || { visibility: 'hidden', right: 8, bottom: 48 },
              onKeyDown: function(event) {
                if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) }
              },
            },
            offered.map(function(option) {
              var on = effectiveEffort === option.id
              return React.createElement('button', {
                key: option.id,
                type: 'button',
                className: 'atf-effort-row',
                role: 'menuitemradio',
                'aria-checked': on,
                'data-on': on ? '1' : '0',
                disabled: waiting,
                title: '思考档位切到 ' + option.label + '（下一条消息生效）',
                onClick: function() { switchTo(option.id) },
              },
              React.createElement('span', null, option.label),
              React.createElement('span', { className: 'atf-check' }, '✓'))
            }),
            waiting ? React.createElement('div', { className: 'atf-effort-pending' }, '切换中…') : null,
            error !== null
              ? React.createElement('div', { className: 'atf-effort-err', role: 'alert' }, '切换被拒绝：' + error)
              : null,
          ),
          document.body)
        : null

      return React.createElement('div', { className: 'atf-effort-root' },
        React.createElement('button', {
          ref: triggerRef,
          type: 'button',
          className: 'atf-effort-trigger',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          title: '思考档位：' + currentLabel + '（点开切换，下一条消息生效）',
          onClick: toggle,
        },
        React.createElement('span', { className: 'atf-effort-k' }, '思考'),
        React.createElement('span', { className: 'atf-effort-v' }, currentLabel),
        React.createElement('span', { className: 'atf-effort-caret' }, waiting ? '…' : '▾')),
        menu)
    }


    return {
      inject: ['slots', 'remote', 'remote.workspaceFiles', 'sidebarRightTabs', 'sidebarRight'],
      apply: function(ctx) {
        remoteFace = ctx.remote
        sidebarFace = ctx.sidebarRight || null

        if (typeof document !== 'undefined') {
          var style = document.createElement('style')
          style.dataset.plugin = '@atf/dsh-atf-ui'
          style.textContent = [
            // 语义回退链：优先 DSH 变量，fallback 内置（亮/暗跟随壳）
            '.atf-gpu-card{display:inline-flex;align-items:center;gap:7px;font-size:12px;',
            '  color:var(--dsh-text-secondary,#64748b);',
            '  background:rgba(128,128,128,.08);',
            '  border:1px solid rgba(128,128,128,.18);',
            '  border-radius:8px;padding:3px 10px;margin:2px 0 4px;}',
            '.atf-gpu-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}',
            '.atf-pill-row{display:flex;gap:8px;flex-wrap:wrap;padding:2px 0;}',
            '.atf-pill{border:0;background:rgba(128,128,128,.1);border-radius:8px;padding:4px 12px;cursor:pointer;font-size:13px;}',
            // 批㉛段1：viewer 直达入口＋浮层
            '.atf-viewer-link{border:0;background:transparent;color:var(--dsw-alias-brand-primary,#1d4ed8);cursor:pointer;',
            '  font-size:12px;padding:0;text-decoration:underline;text-underline-offset:2px;}',
            '.atf-viewer-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;',
            '  display:flex;align-items:center;justify-content:center;}',
            '.atf-viewer-frame{width:min(1100px,94vw);height:min(86vh,900px);background:var(--dsw-alias-bg-layer-1,#fff);',
            '  border-radius:12px;display:flex;flex-direction:column;overflow:hidden;',
            '  box-shadow:0 18px 60px rgba(0,0,0,.35);}',
            '.atf-viewer-head{display:flex;align-items:center;gap:10px;padding:8px 12px;',
            '  border-bottom:1px solid rgba(128,128,128,.25);font-size:13px;}',
            '.atf-viewer-select{font-size:12px;padding:2px 6px;border-radius:6px;}',
            '.atf-viewer-empty{color:var(--dsw-alias-label-tertiary,#64748b);font-size:12px;}',
            '.atf-viewer-iframe{flex:1;border:0;width:100%;}',
            // 批㉛段2：发起训练对话框
            '.atf-train-frame{width:min(880px,94vw);}',
            '.atf-train-body{flex:1;display:flex;flex-direction:column;gap:8px;padding:10px 12px;overflow:hidden;font-size:12px;}',
            '.atf-train-facts{display:flex;gap:14px;flex-wrap:wrap;color:var(--dsh-text-secondary,#64748b);}',
            '.atf-train-mode{display:flex;flex-direction:column;gap:4px;}',
            '.atf-train-mode label{display:flex;gap:6px;align-items:center;cursor:pointer;}',
            '.atf-train-summary{flex:1;overflow:auto;border:1px solid rgba(128,128,128,.2);border-radius:8px;padding:6px 8px;}',
            '.atf-train-sum-head{display:flex;justify-content:space-between;align-items:baseline;font-weight:600;padding:2px 0 6px;}',
            '.atf-train-row{display:grid;grid-template-columns:minmax(150px,auto) minmax(90px,auto) minmax(120px,auto) 1fr;gap:8px;padding:3px 0;border-bottom:1px dashed rgba(128,128,128,.15);}',
            '.atf-train-key{font-family:monospace;font-size:11px;}',
            '.atf-train-val{font-weight:600;}',
            '.atf-train-src{color:var(--dsw-alias-brand-primary,#1d4ed8);font-size:11px;}',
            '.atf-train-src-warn{color:var(--dsw-alias-state-warn-label,#b45309);}',
            '.atf-train-mean{color:var(--dsh-text-secondary,#64748b);font-size:11px;}',
            '.atf-train-actions{display:flex;gap:10px;align-items:center;}',
            // 批㊶-M M-4：段状态跃迁呼吸（一次性动画——animation 属性由内联 pulseStyle 触发一次）
            '@keyframes atf-card-pulse{0%{transform:scale(1)}50%{transform:scale(1.06)}100%{transform:scale(1)}}',
            '.atf-train-send{background:var(--dsw-alias-brand-primary,#1d4ed8);color:#fff;}',
            // 批㉛段3.1：右栏训练监控抽屉——批㊶Q增补一修复：fixed 壳（position:fixed/right/
            // bottom/width:360/z-index:900/border-left/box-shadow）随批㊶-M2 迁 pane 移除——
            // 残留曾使面板以视口右缘全高条（z-900）形态渲染，盖住 z-800 浮卡并吞右缘点击
            // （pane 本体因 MonitorBody 未定义恒空，fixed 条恰好盖在 pane 位置形成假象）。
            // 面板现居 pane body 内自然块级布局；背景/描边随 pane 主题，自身只保留排版。
            '.atf-monitor-panel{display:flex;flex-direction:column;min-width:0;',
            '  font-size:12px;color:var(--dsw-alias-label-primary,#1e293b);}',
            '.atf-monitor-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(128,128,128,.2);}',
            '.atf-monitor-body{flex:1;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:12px;}',
            '.atf-monitor-empty{padding:20px 12px;color:var(--dsw-alias-label-secondary,#64748b);}',
            '.atf-monitor-status{display:flex;align-items:center;gap:8px;font-weight:600;}',
            '.atf-monitor-sec{border:1px solid rgba(128,128,128,.18);border-radius:10px;padding:8px 10px;}',
            '.atf-monitor-title{font-weight:600;margin-bottom:6px;}',
            '.atf-monitor-round{font-weight:400;font-size:11px;color:var(--dsw-alias-label-secondary,#64748b);}',
            '.atf-monitor-chart{width:100%;height:80px;border:1px dashed rgba(128,128,128,.25);border-radius:6px;background:rgba(128,128,128,.04);}',
            '.atf-monitor-legend{display:flex;gap:12px;font-size:10px;color:var(--dsw-alias-label-secondary,#64748b);margin-top:4px;}',
            '.atf-sw{display:inline-block;width:12px;height:3px;vertical-align:middle;margin-right:4px;}',
            '.atf-sw-dash{background-image:linear-gradient(90deg,var(--dsw-static-neutral-400,#94a3b8) 60%,transparent 40%);background-size:6px 3px;}',
            '.atf-monitor-sub{font-size:11px;color:var(--dsw-alias-label-secondary,#64748b);margin-top:6px;}',
            '.atf-kpi-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}',
            '.atf-kpi-card{border:1px solid rgba(128,128,128,.18);border-radius:8px;padding:6px 8px;}',
            '.atf-kpi-label{font-size:10px;color:var(--dsw-alias-label-secondary,#64748b);}',
            '.atf-kpi-value{font-size:15px;font-weight:600;}',
            '.atf-monitor-env{display:flex;flex-direction:column;gap:3px;}',
            // 批㉞H：两轮评估对比（三列网格——指标｜A 轮｜B 轮）
            '.atf-cmp-pickers{display:flex;align-items:center;gap:6px;margin-bottom:6px;}',
            '.atf-cmp-grid{display:grid;grid-template-columns:150px 1fr 1fr;font-size:11px;}',
            '.atf-cmp-row{display:contents;}',
            '.atf-cmp-row>span{padding:2px 6px;border-bottom:1px dashed rgba(128,128,128,.15);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.atf-cmp-head>span{font-weight:600;color:var(--dsh-text-secondary,#64748b);}',
            // 批㉛段3.2/3.3：Loss 点选联动＋产物抽屉
            '.atf-monitor-spike{display:flex;align-items:center;gap:8px;font-size:11px;margin-top:5px;',
            '  color:var(--dsw-alias-label-primary,#1e293b);}',
            '.atf-art-list{display:flex;flex-direction:column;}',
            '.atf-art-row{display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px dashed rgba(128,128,128,.15);font-size:11px;}',
            '.atf-art-row:last-child{border-bottom:0;}',
            '.atf-art-kind{flex:none;width:34px;text-align:center;border:1px solid rgba(128,128,128,.25);border-radius:4px;',
            '  font-size:9px;color:var(--dsh-text-secondary,#64748b);padding:1px 0;}',
            // 批甲-BUILD T1：思考档位快切（composer 工具行内联座位＋body portal 弹出菜单）
            '.atf-effort-root{position:relative;display:inline-flex;}',
            '.atf-effort-trigger{display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(128,128,128,.25);',
            '  background:transparent;color:var(--dsw-alias-label-primary,#1e293b);border-radius:8px;padding:3px 8px;',
            '  font-size:12px;cursor:pointer;white-space:nowrap;}',
            '.atf-effort-trigger:hover{background:rgba(128,128,128,.08);}',
            '.atf-effort-k{color:var(--dsh-text-secondary,#64748b);}',
            '.atf-effort-caret{font-size:10px;color:var(--dsh-text-secondary,#64748b);}',
            '.atf-effort-menu{position:fixed;z-index:60;min-width:150px;display:flex;flex-direction:column;',
            '  background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid rgba(128,128,128,.3);border-radius:10px;',
            '  box-shadow:0 10px 32px rgba(0,0,0,.18);padding:4px;}',
            '.atf-effort-row{display:flex;align-items:center;justify-content:space-between;gap:8px;border:0;',
            '  background:transparent;color:inherit;font-size:12px;padding:6px 8px;border-radius:6px;cursor:pointer;',
            '  text-align:left;white-space:nowrap;}',
            '.atf-effort-row:hover:not(:disabled){background:rgba(128,128,128,.1);}',
            '.atf-effort-row:disabled{opacity:.55;cursor:default;}',
            '.atf-effort-row .atf-check{visibility:hidden;font-size:12px;line-height:1;}',
            '.atf-effort-row[data-on="1"]{font-weight:600;}',
            '.atf-effort-row[data-on="1"] .atf-check{visibility:visible;color:var(--dsw-alias-brand-primary,#1d4ed8);}',
            '.atf-effort-pending{padding:2px 8px 4px;font-size:11px;color:var(--dsh-text-secondary,#64748b);}',
            '.atf-effort-err{margin-top:4px;border-top:1px dashed rgba(128,128,128,.25);padding:6px 8px;font-size:11px;',
            '  color:var(--dsw-alias-state-danger-label,#b91c1c);max-width:300px;white-space:normal;word-break:break-all;}',
          ].join('')
          document.head.append(style)
        }

        // GPU 卡显隐开关（session-scoped：inject 工厂收 sessionId——批⑳实证通道；
        // 本处同时是 sessionId 进 store 的唯一捕获点）＋右栏监控开关（批㉛段3.1）
        ctx.slots.inject('conversation.session.header.utilities', function() {
          return ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'atf-gpu-toggle',
            order: 900,
            inject: function(sessionId) {
              store.sessionId = sessionId
              return { toggle: function() { store.setOpen(!store.getOpen()) } }
            },
          }, function(injected) {
            return React.createElement('div', { style: { display: 'flex', gap: 6 } },
              React.createElement('button', {
                className: 'atf-pill', title: 'GPU 状态卡显隐',
                onClick: injected.toggle,
              }, 'GPU'),
              React.createElement(MonitorTogglePill),
              React.createElement('button', {
                className: 'atf-pill', title: '设置（根目录与存储／运行环境／训练卡数基线）',
                onClick: function() { store.setSettings({}) },
              }, '设置'))
          })
        })

        // 批㊶-L L-4：监控开关（订阅 store 的真实组件——普函数渲染体不重渲，开关态需自订阅）
        function MonitorTogglePill() {
          var open = React.useSyncExternalStore(
            function(fn) { return store.subscribe(fn) },
            function() { return store.monitorOpen },
          )
          return React.createElement('button', {
            className: 'atf-pill' + (open ? ' atf-pill-on' : ''),
            style: open ? { borderColor: 'var(--dsw-alias-brand-primary,#1d4ed8)', color: 'var(--dsw-alias-brand-primary,#1d4ed8)', fontWeight: 600 } : undefined,
            title: open ? '监控（开——点击关闭右栏面板）' : '监控（关——点击打开右栏面板）',
            onClick: function() {
              var next = !store.monitorOpen
              store.setMonitor(next)
              // 批㊶Q增补一：开＝真开右栏原生 tab（openResource 走注册 kind 的 glob 路由；
              // 修复前只切 store 态——pane tab 从未打开，面板以 dock fixed 条顶替）。fail-open。
              if (next && sidebarFace && typeof sidebarFace.openResource === 'function') {
                try { sidebarFace.openResource('dsh-resource://atf-training-monitor/monitor') } catch (e) { /* fail-open：store 态已切，pane 未开时空态兜底 */ }
              }
            },
          }, '监控')
        }

        // 批㊶-K 项4 的 turnTail 训练进度卡已下线（批㊶-M 迁移至会话区右上悬浮任务卡——
        // FloatingTaskCard 在 dock 行组件处挂载；slot 不再占用）

        // 批㊶-M2 段 3：监控面板迁 DSH 原生右栏 pane tab（sidebar.right.pane.tab——沿 ui-deliverables
        // 同款挂法；sidebarRightTabs.register 声明 tab 类型＋slots 注册 tab body）。自绘 fixed 面板
        // （MonitorPanel）下线——L-4 顶栏遮挡问题随迁移自然消失。曲线 SVG/hex 债项随迁 token 化。
        ctx.effect(function() {
          ctx.sidebarRightTabs.register({
            id: '@atf/dsh-atf-ui',
            kind: 'atf-training-monitor',
            patterns: ['dsh-resource://atf-training-monitor/**'],
            priority: 'builtin',
            canOpen: function() { return true },
            title: function() { return '训练监控' },
          })
        }, 'atf-ui: training-monitor tab type')
        ctx.slots.inject('sidebar.right.pane.tab', function() {
          return ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: '@atf/dsh-atf-ui',
            children: { 'atf.monitor.actions': { kind: 'list', scope: 'session' } },
          }, function() { return React.createElement(MonitorBody) })
        })

        // 通道 C：composer.dock（list 槽）——GPU 一行卡＋快捷指令胶囊＋viewer 浮层（输入框上方，会话内常显）
        ctx.slots.inject('conversation.composer.dock', function() {
          return ctx.slots.register({ name: 'conversation.composer.dock', id: 'atf-dock-row' }, function() {
            return React.createElement('div', null,
              React.createElement(FloatingTaskCard),
              React.createElement(FloatingTaskCardExpanded),
              React.createElement(EvalNoticeStack),
              React.createElement(GpuCard),
              React.createElement('div', { className: 'atf-pill-row' },
                PILLS.map(function(pill) {
                  return React.createElement('button', {
                    key: pill.label, className: 'atf-pill',
                    onClick: function() {
                      // 输入面＝contenteditable 富输入（DSH 壳无 textarea）——execCommand 插入保 React 状态同步
                      var input = document.querySelector('textarea') || document.querySelector('[contenteditable=\"true\"]')
                      if (input) {
                        input.focus()
                        document.execCommand('insertText', false, pill.msg)
                      }
                    },
                  }, pill.label)
                }),
                React.createElement('button', {
                  className: 'atf-pill', title: '内嵌打开 badcase 可视化',
                  onClick: function() { store.setViewer({ runId: null }) },
                }, 'badcase 可视化'),
                React.createElement('button', {
                  className: 'atf-pill', title: '发起训练（IterationConfig 摘要→确认卡→正道链）',
                  onClick: function() { store.setTrain({ runId: null, mode: 'dry_run' }) },
                }, '发起训练')),
              React.createElement(ViewerOverlay),
              React.createElement(TrainDialog),
              React.createElement(SettingsPanel))
              // 批㊶Q增补一：MonitorPanel 卸离 dock——pane body（MonitorBody）唯一挂载；
              // dock 遗留挂载曾是 fixed 全高条假 pane 的载体（遮挡根因，见 MonitorBody 注）
          })
        })

        // 批甲-BUILD T1（owner D1＝输入框右下角·与模型选择并排）：conversation.input.right
        // （list 槽，session 域）——思考档位快切 EffortSelect。数据/提交走 ui-model-selection
        // 共享 ModelDirectory（ctx.modelDirectories.directoryFor(sessionId)）——与原生模型选择
        // 同一份状态与同一条 session.selectModel RPC（零新桥方法＝契约零 diff；下 turn 生效由
        // 宿主 selectForNextRequest 既有语义承载，不新造机制）。inject 工厂 fail-open：会话未
        // 绑定等瞬态返回 null＝控件空渲染，不让槽崩。
        ctx.inject(['slots', 'modelDirectories', 'sessions', 'remote', 'remote.session'], function(scope) {
          var models = scope.modelDirectories
          var sessions = scope.sessions
          scope.slots.inject('conversation.input.right', function() {
            return scope.slots.register({
              name: 'conversation.input.right',
              id: 'atf-effort-select',
              order: 100,
              inject: function(sessionId) {
                try {
                  var available = sessions.subagentAddress(sessionId) === undefined
                  var directory = models.directoryFor(sessionId)
                  return {
                    available: available,
                    directory: directory.store,
                    load: function() {
                      if (available) directory.load().catch(function() { /* 错误在 store 上呈现——共享面 */ })
                    },
                    select: function(selection) {
                      return available ? directory.select(selection) : Promise.resolve(undefined)
                    },
                  }
                } catch (e) {
                  return {}
                }
              },
            }, function(injected) {
              if (injected === null) return null
              return React.createElement(EffortSelect, injected)
            })
          })
        })

        // 批㊳ M3-2（档二品牌 · 轴 C）：brand slot 占位——沿官方嵌套 inject 模式
        // （ui-brand-official/src/client/index.ts:16-23）。声明感知：slot 声明已在则同步
        // 占位、未在则等声明提交后执行（免疫加载时序）；回调返回 disposer 数组（iterable
        // 契约，registry.ts inject 文档面）。占位后侧栏 fallback（"DSH 本地构建"）与
        // 版本徽标一并由我方组件接管面。
        ctx.slots.inject('sidebar.brand.mark', function() {
          return ctx.slots.inject('sidebar.brand.name', function() {
            return [
              ctx.slots.register({ name: 'sidebar.brand.mark' }, AtfBrandMark),
              ctx.slots.register({ name: 'sidebar.brand.name' }, AtfBrandName),
            ]
          })
        })

        // 空态 hero 鱼标位（顺手——EmptyHero renderSlot({size:34,className})）
        ctx.slots.inject('conversation.hero.brand.mark', function() {
          return ctx.slots.register({ name: 'conversation.hero.brand.mark' }, AtfBrandMark)
        })
      },
    }
  },
})
