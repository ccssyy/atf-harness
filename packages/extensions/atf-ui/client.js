/** atf-ui client 半——GPU 状态一行卡＋快捷指令胶囊（批㉑三段）。
 *  品牌沿 owner 路线 2 裁定：维持 DSH 默认文案（替换随 M3 persona/identity config 正道），
 *  本文件不含任何品牌覆盖（slot/CSS/DOM 文本替换均不设）。
 *  数据：workspaceFiles.read 轮询 <runsRoot>/atf-ui/monitor.json（同步器 5s 快照单源，
 *  gpu 字段＝nvidia-smi 实测面）；sessionId 经 header.utilities 的 session-scoped
 *  inject 工厂捕获（批⑳实证通道）。
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
    var MONITOR_PATH = (typeof window !== 'undefined' && window.__ATF_UI_CONFIG__ && window.__ATF_UI_CONFIG__.monitorPath) || '/data/sam/ATF-Harness/tmp/webui-runs/atf-ui/monitor.json'
    var POLL_MS = 5000

    var remoteFace = null
    var store = {
      sessionId: undefined,
      open: true,
      listeners: new Set(),
      setOpen: function(v) { this.open = v; this.listeners.forEach(function(fn) { fn() }) },
      subscribe: function(fn) { var s = this; s.listeners.add(fn); return function() { s.listeners.delete(fn) } },
      getOpen: function() { return this.open },
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

    /** GPU 状态一行卡（紧凑单行——指令三段形态：GPU util/显存/在跑 run）。 */
    function GpuCard() {
      var open = React.useSyncExternalStore(
        function(fn) { return store.subscribe(fn) },
        function() { return store.getOpen() },
      )
      var mon = useMonitor()
      if (!open) return null
      var gpu = (mon && mon.gpu) || null
      var parts = []
      if (gpu === null) {
        parts.push('GPU 监控就绪中…')
      } else if (gpu.offline === true) {
        parts.push('GPU 离线（nvidia-smi 不可用）')
      } else {
        parts.push('GPU ' + String(gpu.utilization || '—'))
        parts.push('显存 ' + String(gpu.memoryUsed || '—') + '/' + String(gpu.memoryTotal || '—'))
      }
      var active = mon === null ? null : pickActiveRun(mon)
      if (active !== null) {
        parts.push(active.run.run_id + ' 段 ' + active.done + '/' + active.total)
        if (active.trainingActive) parts.push('训练中')
        else if (active.waiting) parts.push('等确认')
      } else if (gpu !== null && gpu.offline !== true) {
        parts.push('暂无推进 run')
      }
      var dotColor = active !== null && active.trainingActive ? '#f59e0b' : active !== null ? '#1d4ed8' : '#16a34a'
      return React.createElement('div', { className: 'atf-gpu-card' },
        React.createElement('span', { className: 'atf-gpu-dot', style: { background: dotColor } }),
        React.createElement('span', null, parts.join(' · ')))
    }

    var PILLS = [
      { label: '新建训练', msg: '我想启动一个新的训练任务' },
      { label: '查状态', msg: '查看当前训练任务状态' },
      { label: '继续上次', msg: '继续上次的训练任务' },
      { label: '对比两轮', msg: '对比最近两轮训练的指标' },
    ]

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
          ].join('')
          document.head.append(style)
        }

        // GPU 卡显隐开关（session-scoped：inject 工厂收 sessionId——批⑳实证通道；
        // 本处同时是 sessionId 进 store 的唯一捕获点）
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
            return React.createElement('button', {
              className: 'atf-pill', title: 'GPU 状态卡显隐',
              onClick: injected.toggle,
            }, 'GPU')
          })
        })

        // 通道 C：composer.dock（list 槽）——GPU 一行卡＋快捷指令胶囊（输入框上方，会话内常显）
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
                })))
          })
        })
      },
    }
  },
})
