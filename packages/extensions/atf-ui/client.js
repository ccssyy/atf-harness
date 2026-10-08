/** atf-ui client 半——GPU 状态一行卡＋快捷指令胶囊＋badcase viewer 内嵌浮层（批㉑三段＋批㉛段1）。
 *  品牌（批㊳ M3-2，档二 · 轴 C）：sidebar.brand.mark/name＋conversation.hero.brand.mark 三座位
 *  占位（沿官方 ui-brand-official 嵌套 inject 模式——官方占位被 build profile gate 关闭，
 *  非 official 构建座位空置，第三方 priority 0 直入无冲突面）；M3-1 persona/M3-4 标题经
 *  config/build-env 两轴，不在本文件。
 *  数据：workspaceFiles.read 轮询 <runsRoot>/atf-ui/monitor.json（同步器 5s 快照单源，
 *  gpu 字段＝nvidia-smi 首行单卡面，gpu_all/gpu_binding＝批㉝H 多卡聚合与绑卡声明，
 *  viewers 字段＝run 维度 badcase viewer 发现清单——批㉛段1）；
 *  sessionId 经 header.utilities 的 session-scoped inject 工厂捕获（批⑳实证通道）。
 *  viewer 渲染：iframe 指 server 半静态路由 /atf-ui/viewer/<runId>/（同源 cookie 鉴权，
 *  不重建 viewer 本身——产物由 atf-analyze-badcases skill 链产出）。
 *  挂载面（DSH slot 契约，批㉑三段实证）：conversation.session.header.utilities＝list
 *  （GPU 显隐开关＋sessionId 捕获）；conversation.composer.dock＝list（GPU 一行卡＋胶囊，
 *  与 ui-chat stats 同槽共存）；conversation.approval.detail＝single（ui-chat 独占——
 *  第三方注册会顶掉其 seat 致其 apply 抛错，故不挂）。 */
window.__ModuleLoader__.load({
  id: '@atf/dsh-atf-ui',
  factory: function(require) {
    var React = require('react')

    // 批㉘ monitor 路径单源：优先读 server 半经 index tap 注入的 per-instance 路径
    // （window.__ATF_UI_CONFIG__.monitorPath＝同步器实际写盘位，随 ATF_DSH_RUNS_ROOT／
    // ATF_WEBUI_RUNS_ROOT 解析）；无注入面时回退批㉑原缺省字面量（owner runsRoot 语义，
    // 3080 缺省行为零变化）。浏览器面不读 env——env 覆盖在 server 半解析后随 index 下发。
    var MONITOR_PATH = (typeof window !== 'undefined' && window.__ATF_UI_CONFIG__ && window.__ATF_UI_CONFIG__.monitorPath) || 'atf-ui/monitor.json'
    var POLL_MS = 5000

    var remoteFace = null
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
      listeners: new Set(),
      setOpen: function(v) { this.open = v; this.listeners.forEach(function(fn) { fn() }) },
      subscribe: function(fn) { var s = this; s.listeners.add(fn); return function() { s.listeners.delete(fn) } },
      getOpen: function() { return this.open },
      setViewer: function(v) { this.viewer = v; this.listeners.forEach(function(fn) { fn() }) },
      setTrain: function(v) { this.train = v; this.listeners.forEach(function(fn) { fn() }) },
      setMonitor: function(open, runId) { this.monitorOpen = open; if (runId !== undefined) this.monitorRunId = runId; this.listeners.forEach(function(fn) { fn() }) },
    }

    /** monitor.json 轮询（sessionId 由 header.utilities 注入后生效；未就绪期静默等下周期）。 */
    function useMonitor() {
      var _s = React.useState(null)
      var data = _s[0], setData = _s[1]
      React.useEffect(function() {
        var alive = true
        var read = function() {
          var sid = store.sessionId
          if (sid === undefined || remoteFace === null) return
          remoteFace.workspaceFiles.read(sid, MONITOR_PATH, {}, new AbortController().signal)
            .then(function(result) {
              if (!alive || !result || result.ok === false) return
              try { setData(JSON.parse(result.value.text)) } catch { /* 下周期重试 */ }
            })
            .catch(function() { /* 离线/未就绪——下周期重试 */ })
        }
        read()
        var t = setInterval(read, POLL_MS)
        return function() { alive = false; clearInterval(t) }
      }, [])
      return data
    }

    /** artifacts.json 轮询（批㉛段3.3 产物抽屉数据源——同步器同批写盘）。 */
    function useArtifacts() {
      var _s = React.useState(null)
      var data = _s[0], setData = _s[1]
      React.useEffect(function() {
        var alive = true
        var read = function() {
          var sid = store.sessionId
          if (sid === undefined || remoteFace === null) return
          // 与 monitor.json 同目录同名换文件（同步器同批写盘——atf-ui/artifacts.json）
          var artsPath = MONITOR_PATH.replace(/monitor\.json$/, 'artifacts.json')
          remoteFace.workspaceFiles.read(sid, artsPath, {}, new AbortController().signal)
            .then(function(result) {
              if (!alive || !result || result.ok === false) return
              try { setData(JSON.parse(result.value.text)) } catch { /* 下周期重试 */ }
            })
            .catch(function() { /* 下周期重试 */ })
        }
        read()
        var t = setInterval(read, POLL_MS)
        return function() { alive = false; clearInterval(t) }
      }, [])
      return data
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
      if (!open) return null
      var runs = (mon && mon.runs) || []
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
      return React.createElement('div', { className: 'atf-monitor-panel' },
        React.createElement('div', { className: 'atf-monitor-head' },
          React.createElement('b', null, '训练监控'),
          React.createElement('select', {
            className: 'atf-viewer-select', value: runId || '',
            onChange: function(e) { store.setMonitor(true, e.target.value) },
          },
            runs.map(function(r) { return React.createElement('option', { key: r.run_id, value: r.run_id }, r.run_id) })),
          React.createElement('button', { className: 'atf-pill', title: '收起', onClick: function() { store.setMonitor(false) } }, '×')),
        run === null
          ? React.createElement('div', { className: 'atf-monitor-empty' }, '（monitor 快照就绪中…）')
          : React.createElement('div', { className: 'atf-monitor-body' },
              React.createElement('div', { className: 'atf-monitor-status' },
                React.createElement('span', { className: 'atf-gpu-dot', style: { background: active ? '#f59e0b' : '#16a34a' } }),
                React.createElement('span', null, (active ? '训练中 · ' : '空闲 · ') + '段 ' + done + '/' + run.segments.length)),
              React.createElement('div', { className: 'atf-monitor-sec' },
                React.createElement('div', { className: 'atf-monitor-title' }, 'Loss 曲线'),
                React.createElement('svg', { className: 'atf-monitor-chart', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' },
                  trainPts ? React.createElement('polyline', { points: trainPts, fill: 'none', stroke: '#1d4ed8', strokeWidth: 1.5 }) : null,
                  evalPts ? React.createElement('polyline', { points: evalPts, fill: 'none', stroke: '#94a3b8', strokeWidth: 1.5, strokeDasharray: '4 3' }) : null,
                  mark ? React.createElement('circle', {
                    cx: mark.x, cy: mark.y, r: 3.5,
                    fill: mark.isSpike ? '#dc2626' : '#1d4ed8', stroke: '#fff', strokeWidth: 1,
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
                  React.createElement('span', null, React.createElement('span', { className: 'atf-sw', style: { background: '#1d4ed8' } }), 'train（' + trainVals.length + ' 点）'),
                  React.createElement('span', null, React.createElement('span', { className: 'atf-sw atf-sw-dash', style: { background: evalPts ? '#94a3b8' : 'transparent' } }), evalVals.length >= 2 ? 'eval' : 'eval（本轮无 eval_loss 序列）')),
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

    // 批㊶-K 项 4：对话流训练进度卡（conversation.chat.turnTail——每轮尾部；训练中才渲染。
    // 数据源＝monitor.json（与 GpuCard 同源单源：pickActiveRun 推导），零新数据面）
    function TrainingProgressCard() {
      var mon = useMonitor()
      var active = mon === null ? null : pickActiveRun(mon)
      // 训练中判据＝run.training.active（monitor 单源布尔——loss-series 在场且新鲜；
      // 段状态此时为 done 不作判据）
      if (active === null || !(active.run && active.run.training && active.run.training.active === true)) return null
      var run = active.run
      var lossText = ''
      var pts = (run.training && run.training.points) || []
      for (var i = pts.length - 1; i >= 0; i--) {
        if (typeof pts[i].train_loss === 'number') { lossText = ' · loss ' + pts[i].train_loss; break }
      }
      return React.createElement('div', {
        className: 'atf-train-progress',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12,
          color: 'var(--dsh-text-secondary,#64748b)', background: 'rgba(128,128,128,.08)',
          borderRadius: 8, padding: '3px 10px', margin: '4px 0',
        },
      },
        React.createElement('span', { className: 'atf-gpu-dot', style: { background: '#f59e0b' } }),
        React.createElement('span', null,
          '训练中 · ' + run.run_id + ' · 段 ' + active.done + '/' + active.total + lossText),
        React.createElement('button', {
          className: 'atf-pill', title: '打开右栏训练监控（Loss 曲线）',
          onClick: function() { store.setMonitor(true, run.run_id) },
        }, '曲线'))
    }

    /** GPU 状态一行卡（批㉝H 多卡聚合形态：逐卡 util/显存汇总＋当前推进 run 绑卡标注；
     *  gpu_all 缺席（旧快照/采集失败）回退首行单卡面——双向向后兼容）。 */
    function GpuCard() {
      var open = React.useSyncExternalStore(
        function(fn) { return store.subscribe(fn) },
        function() { return store.getOpen() },
      )
      var mon = useMonitor()
      if (!open) return null
      var gpu = (mon && mon.gpu) || null
      var gpuAllText = formatGpuAllLocal(mon && mon.gpu_all)
      // 悬停明细：逐卡显存 used/total（聚合行只显 used，total 进 title 不占行宽）
      var gpuAllTitle = mon && Array.isArray(mon.gpu_all) && mon.gpu_all.length > 0
        ? mon.gpu_all.map(function(c) {
            return 'GPU' + c.index + ' 显存 ' + c.memoryUsed + '/' + c.memoryTotal
          }).join(' · ')
        : undefined
      var parts = []
      if (gpu === null) {
        parts.push('GPU 监控就绪中…')
      } else if (gpu.offline === true) {
        parts.push('GPU 离线（nvidia-smi 不可用）')
      } else if (gpuAllText !== null) {
        parts.push(gpuAllText)
      } else {
        parts.push('GPU ' + String(gpu.utilization || '—'))
        parts.push('显存 ' + String(gpu.memoryUsed || '—') + '/' + String(gpu.memoryTotal || '—'))
      }
      var active = mon === null ? null : pickActiveRun(mon)
      if (active !== null) {
        parts.push(active.run.run_id + ' 段 ' + active.done + '/' + active.total)
        if (active.trainingActive) parts.push('训练中')
        else if (active.waiting) parts.push('等确认')
        // 批㉝H：当前推进 run 绑卡声明（train.sh/manifest——读不到不显示，仅全卡聚合）
        var bindText = formatGpuBindingLocal(active.run.gpu_binding)
        if (bindText !== null) parts.push('当前 run ' + bindText)
      } else if (gpu !== null && gpu.offline !== true) {
        parts.push('暂无推进 run')
      }
      var dotColor = active !== null && active.trainingActive ? '#f59e0b' : active !== null ? '#1d4ed8' : '#16a34a'
      // 批㊶-E-H 项 2.3：桥类型徽标（__ATF_UI_CONFIG__.bridge 注入面——旧装配面无此键不渲染，
      // 向后兼容）。real＝内核 real·<版本>（版本探测不到如实省略）；mock＝⚠ mock 提示。
      var bridgeCfg = (typeof window !== 'undefined' && window.__ATF_UI_CONFIG__ && window.__ATF_UI_CONFIG__.bridge) || null
      var bridgeBadge = null
      if (bridgeCfg !== null && bridgeCfg.mode === 'real') {
        bridgeBadge = React.createElement('span', {
          title: 'ATF 内核桥（真内核）',
          style: { color: '#16a34a', fontWeight: 600, flex: 'none' },
        }, '内核 real' + (bridgeCfg.version ? '·' + bridgeCfg.version : ''))
      } else if (bridgeCfg !== null) {
        bridgeBadge = React.createElement('span', {
          title: '桥对端为 mock 内核（非真内核）——设 ATF_DSH_BRIDGE_COMMAND 切换',
          style: { color: '#dc2626', fontWeight: 600, flex: 'none' },
        }, '⚠ mock')
      }
      // 批㉛段1：当前推进 run 有 viewer 产物 → 行内直达入口（无则不渲染，不留死按钮）
      var activeViewers = active !== null ? ((mon.runs.find(function(r) { return r.run_id === active.run.run_id }) || {}).viewers || []) : []
      // 批㊶-K 项 3：部署默认权限档徽标（会话现值由宿主头部指示器与 atf_permission_status 承载）
      var permCfg = (typeof window !== 'undefined' && window.__ATF_UI_CONFIG__ && window.__ATF_UI_CONFIG__.permissionPreset) || null
      var permBadge = permCfg !== null
        ? React.createElement('span', {
            title: '部署默认权限档（会话现值见顶部档位指示；档位变更须经界面人工操作）',
            style: { color: '#64748b', fontWeight: 600, flex: 'none' },
          }, '档位 ' + (permCfg.label || permCfg.key || ''))
        : null
      return React.createElement('div', { className: 'atf-gpu-card' },
        bridgeBadge,
        permBadge,
        React.createElement('span', { className: 'atf-gpu-dot', style: { background: dotColor } }),
        React.createElement('span', { title: gpuAllTitle }, parts.join(' · ')),
        activeViewers.length > 0
          ? React.createElement('button', {
              className: 'atf-viewer-link',
              title: '内嵌打开 badcase 可视化（' + active.run.run_id + '）',
              onClick: function() { store.setViewer({ runId: active.run.run_id }) },
            }, 'badcase 可视化')
          : null)
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


    return {
      inject: ['slots', 'remote', 'remote.workspaceFiles'],
      apply: function(ctx) {
        remoteFace = ctx.remote

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
            '.atf-viewer-link{border:0;background:transparent;color:#1d4ed8;cursor:pointer;',
            '  font-size:12px;padding:0;text-decoration:underline;text-underline-offset:2px;}',
            '.atf-viewer-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;',
            '  display:flex;align-items:center;justify-content:center;}',
            '.atf-viewer-frame{width:min(1100px,94vw);height:min(86vh,900px);background:#fff;',
            '  border-radius:12px;display:flex;flex-direction:column;overflow:hidden;',
            '  box-shadow:0 18px 60px rgba(0,0,0,.35);}',
            '.atf-viewer-head{display:flex;align-items:center;gap:10px;padding:8px 12px;',
            '  border-bottom:1px solid rgba(128,128,128,.25);font-size:13px;}',
            '.atf-viewer-select{font-size:12px;padding:2px 6px;border-radius:6px;}',
            '.atf-viewer-empty{color:#64748b;font-size:12px;}',
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
            '.atf-train-src{color:#1d4ed8;font-size:11px;}',
            '.atf-train-src-warn{color:#b45309;}',
            '.atf-train-mean{color:var(--dsh-text-secondary,#64748b);font-size:11px;}',
            '.atf-train-actions{display:flex;gap:10px;align-items:center;}',
            '.atf-train-send{background:#1d4ed8;color:#fff;}',
            // 批㉛段3.1：右栏训练监控抽屉
            '.atf-monitor-panel{position:fixed;top:0;right:0;bottom:0;width:360px;background:var(--dsh-bg,#fff);',
            '  border-left:1px solid rgba(128,128,128,.25);box-shadow:-8px 0 24px rgba(0,0,0,.12);z-index:900;',
            '  display:flex;flex-direction:column;font-size:12px;color:var(--dsh-text-primary,#1e293b);}',
            '.atf-monitor-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(128,128,128,.2);}',
            '.atf-monitor-body{flex:1;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:12px;}',
            '.atf-monitor-empty{padding:20px 12px;color:var(--dsh-text-secondary,#64748b);}',
            '.atf-monitor-status{display:flex;align-items:center;gap:8px;font-weight:600;}',
            '.atf-monitor-sec{border:1px solid rgba(128,128,128,.18);border-radius:10px;padding:8px 10px;}',
            '.atf-monitor-title{font-weight:600;margin-bottom:6px;}',
            '.atf-monitor-round{font-weight:400;font-size:11px;color:var(--dsh-text-secondary,#64748b);}',
            '.atf-monitor-chart{width:100%;height:80px;border:1px dashed rgba(128,128,128,.25);border-radius:6px;background:rgba(128,128,128,.04);}',
            '.atf-monitor-legend{display:flex;gap:12px;font-size:10px;color:var(--dsh-text-secondary,#64748b);margin-top:4px;}',
            '.atf-sw{display:inline-block;width:12px;height:3px;vertical-align:middle;margin-right:4px;}',
            '.atf-sw-dash{background-image:linear-gradient(90deg,#94a3b8 60%,transparent 40%);background-size:6px 3px;}',
            '.atf-monitor-sub{font-size:11px;color:var(--dsh-text-secondary,#64748b);margin-top:6px;}',
            '.atf-kpi-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}',
            '.atf-kpi-card{border:1px solid rgba(128,128,128,.18);border-radius:8px;padding:6px 8px;}',
            '.atf-kpi-label{font-size:10px;color:var(--dsh-text-secondary,#64748b);}',
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
            '  color:var(--dsh-text-primary,#1e293b);}',
            '.atf-art-list{display:flex;flex-direction:column;}',
            '.atf-art-row{display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px dashed rgba(128,128,128,.15);font-size:11px;}',
            '.atf-art-row:last-child{border-bottom:0;}',
            '.atf-art-kind{flex:none;width:34px;text-align:center;border:1px solid rgba(128,128,128,.25);border-radius:4px;',
            '  font-size:9px;color:var(--dsh-text-secondary,#64748b);padding:1px 0;}',
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
              React.createElement('button', {
                className: 'atf-pill', title: '右栏训练监控（Loss 曲线/KPI/环境卡）',
                onClick: function() { store.setMonitor(!store.monitorOpen) },
              }, '监控'))
          })
        })

        // 批㊶-K 项 4：turnTail 训练进度卡（每轮尾部；训练中才渲染）
        ctx.slots.inject('conversation.chat.turnTail', function() {
          return ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'atf-train-progress' }, TrainingProgressCard)
        })

        // 通道 C：composer.dock（list 槽）——GPU 一行卡＋快捷指令胶囊＋viewer 浮层（输入框上方，会话内常显）
        ctx.slots.inject('conversation.composer.dock', function() {
          return ctx.slots.register({ name: 'conversation.composer.dock', id: 'atf-dock-row' }, function() {
            return React.createElement('div', null,
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
              React.createElement(MonitorPanel))
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
