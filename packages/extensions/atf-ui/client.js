/** atf-ui client 半——品牌 slot＋快捷指令＋确认指引＋监控面板（批⑳dot1 修正版）。 */
window.__ModuleLoader__.load({
  id: '@atf/dsh-atf-ui',
  factory: function(require) {
    var React = require('react')
    var remoteFace = null

    function BrandMark() {
      return React.createElement('span', {
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                 width: 24, height: 24, borderRadius: 6,
                 background: 'var(--atf-accent,#1d4ed8)', color: '#fff',
                 fontSize: 10, fontWeight: 700, flexShrink: 0 }
      }, 'ATF')
    }
    function BrandName() {
      return React.createElement('span', { style: { fontWeight: 600, fontSize: 14 } }, 'ATF 训练 Agent')
    }
    function ConfirmGuide() {
      return React.createElement('div', {
        style: { border: '1px dashed #b45309', borderRadius: 8, padding: 8, fontSize: 11, color: '#b45309' }
      },
        React.createElement('b', null, 'ATF 确认卡应答方式'),
        '确认并继续＝Allow once；逐项修改＝回复「lr 改 2e-4」；拒绝＝Reject。三态：⚠ 缺省／◆ 登记／? 确认。')
    }

    function AtfMonitor(props) {
      var mon = props.monitor
      var runs = (mon && mon.runs) || []
      var _r = React.useState(runs.length ? runs[0].run_id : ''), runId = _r[0]
      var run = runs.find(function(r) { return r.run_id === runId }) || runs[0]
      if (!run) return React.createElement('div', { style: { color: '#64748b', fontSize: 11 } }, '（暂无 run）')
      var pts = (run.training && Array.isArray(run.training.points)) ? run.training.points : []
      var segs = (run.segments || []).map(function(s, i) {
        var icon, iconBg, fg
        if (s.status === 'done') { iconBg = 'var(--atf-success,#16a34a)'; icon = '✓'; fg = 'var(--atf-textPrimary,#0f172a)' }
        else if (s.status === 'active') { iconBg = 'var(--atf-warning,#f59e0b)'; icon = '●'; fg = 'var(--atf-textPrimary,#0f172a)' }
        else { iconBg = 'var(--atf-cardElevated,#e2e8f0)'; icon = String(i + 1); fg = 'var(--atf-textSecondary,#64748b)' }
        return React.createElement('div', { key: s.key, style: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' } },
          React.createElement('span', { style: { width: 20, height: 20, borderRadius: '50%', background: iconBg, color: fg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, flexShrink: 0 } }, icon),
          React.createElement('span', { style: s.status === 'done' ? { textDecoration: 'line-through', opacity: 0.6 } : { fontWeight: 500 } }, s.label))
      })
      var pts_ = pts
      var trainPath = null
      if (pts_.length > 1) {
        var losses = pts_.map(function(p) { return p.train_loss || 0 })
        var mn = Math.min.apply(null, losses), mx = Math.max.apply(null, losses), rng = mx - mn || 1
        trainPath = losses.map(function(v, i) { return (i / (losses.length - 1) * 300).toFixed(1) + ',' + (76 - ((v - mn) / rng) * 72).toFixed(1) }).join(' ')
      }
      var kpis = { train_loss: pts_.length ? String(pts_[pts_.length-1].train_loss) : '—', eval_loss: '—', learning_rate: '—', gpu_mem: '—' }
      return React.createElement('div', null,
        React.createElement('select', { style: { marginBottom: 4, width: '100%', padding: '3px 6px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 12 },
          value: runId, onChange: function(e) { runId = e.target.value; forceUpdate() } },
          runs.map(function(r) { return React.createElement('option', { key: r.run_id, value: r.run_id }, r.run_id) })),
        React.createElement('div', null, segs),
        pts_.length === 0
          ? React.createElement('div', { style: { color: '#b45309', background: '#fef3c7', borderRadius: 6, padding: 6, margin: '6px 0', fontSize: 12 } }, '等待训练启动 · DRY_RUN 已过 · 排队中')
          : React.createElement('div', null,
              React.createElement('div', { style: { fontSize: 20, fontWeight: 700 } }, pts_.length + ' 步'),
              trainPath ? React.createElement('svg', { viewBox: '0 0 300 80', style: { width: '100%', height: 60 } },
                React.createElement('polyline', { points: trainPath, fill: 'none', stroke: '#1d4ed8', strokeWidth: 1.5 })) : null,
              React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 4 } },
                Object.keys(kpis).map(function(k) {
                  return React.createElement('div', { key: k, style: { background: 'var(--atf-cardElevated,#e2e8f0)', borderRadius: 6, padding: '4px 6px' } },
                    React.createElement('div', { style: { fontSize: 10, color: '#64748b' } }, k),
                    React.createElement('div', { style: { fontSize: 13, fontWeight: 600 } }, kpis[k]))
                }))))
    }

    function AtfArtifacts(props) {
      var runs = (props.artifacts && props.artifacts.runs) || []
      return React.createElement('div', null,
        runs.map(function(run) {
          return React.createElement('div', { key: run.run_id, style: { border: '1px solid #e2e8f0', borderRadius: 8, padding: 6, marginBottom: 4 } },
            React.createElement('div', { style: { fontWeight: 600, fontSize: 12 } }, 'run ' + run.run_id),
            run.artifacts.length === 0
              ? React.createElement('div', { style: { color: '#64748b', fontSize: 11 } }, '（暂无产物）')
              : run.artifacts.map(function(a, i) {
                  return React.createElement('div', { key: i, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: 11 } },
                    React.createElement('span', null, a.name),
                    React.createElement('button', { style: { border: '1px solid #e2e8f0', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 11 },
                      onClick: function() {
                        var text = '查看 ' + a.name
                        var url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
                        window.open(url, '_blank')
                      } }, '[预览]'))
                }))
        }))
    }

    var _updateFns = []
    function forceUpdate() { _updateFns.forEach(function(fn) { fn() }) }

    return {
      inject: ['slots', 'remote'],
      apply: function(ctx) {
        remoteFace = ctx.remote

        // CSS（语义 token 双主题）
        if (typeof document !== 'undefined') {
          var style = document.createElement('style')
          style.dataset.plugin = '@atf/dsh-atf-ui'
          style.textContent = [
            '.atf-scope{--atf-accent:#1d4ed8;--atf-cardElevated:#e2e8f0;--atf-textPrimary:#0f172a;--atf-textSecondary:#64748b;--atf-success:#16a34a;--atf-warning:#f59e0b;}',
            '.atf-dock{position:fixed;top:0;right:0;width:400px;max-height:100vh;overflow-y:auto;background:#fff;border-left:1px solid #e2e8f0;z-index:40;padding:12px;font-family:"PingFang SC",sans-serif;font-size:13px;color:#0f172a;}',
            '.atf-dock-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}',
            '.atf-dock-title{font-weight:600;font-size:15px;margin:10px 0 4px;}',
            '.atf-btn{border:1px solid #e2e8f0;background:#fff;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:11px;}',
            '.atf-dim{color:#64748b;font-size:11px;}',
            '.atf-seg-line{display:flex;align-items:center;gap:12px;padding:8px 0;}',
          ].join('')
          document.head.append(style)
          // 品牌覆盖 CSS（延迟注入——等待 DSH 壳渲染完毕后生效）
          setTimeout(function() {
            var brandStyle = document.createElement('style')
            brandStyle.dataset.plugin = '@atf/dsh-atf-ui-brand'
            brandStyle.textContent = [
              // 侧栏品牌区：隐藏 DSH fallback，显示 ATF
              '[class*=sidebar] [class*=brand] { visibility: hidden; position: relative; }',
              '[class*=sidebar] [class*=brand]::after {',
              '  content: "ATF 训练 Agent";',
              '  visibility: visible; position: absolute; left: 0; top: 0;',
              '  font-weight: 600; font-size: 14px; color: var(--atf-textPrimary,#0f172a);',
              '}',
              // 侧栏顶栏 brand mark 区域：隐藏 DSH 图标，显示 ATF 徽标
              '[class*=sidebar] [class*=brand] [class*=mark], [class*=sidebar] img[class*=logo] { display: none !important; }',
              '[class*=sidebar] [class*=brand]::before {',
              '  content: "ATF";',
              '  display: inline-block; width: 24px; height: 24px; border-radius: 6px;',
              '  background: var(--atf-accent,#1d4ed8); color: #fff; font-size: 10px; font-weight: 700;',
              '  text-align: center; line-height: 24px; margin-right: 8px; vertical-align: middle;',
              '  visibility: visible; position: relative;',
              '}',
            ].join('')
            document.head.append(brandStyle)
          }, 2000)
        }

        // 修正 1：品牌 slot 注入
        ctx.slots.inject('sidebar.brand.mark', function() {
          return ctx.slots.register({ name: 'sidebar.brand.mark', id: 'atf-brand-mark' }, BrandMark)
        })
        ctx.slots.inject('sidebar.brand.name', function() {
          return ctx.slots.register({ name: 'sidebar.brand.name', id: 'atf-brand-name' }, BrandName)
        })

        // ---- 批⑳dot1 补充：DOM 层品牌文本替换（sidebar fallback 的 slot 注入依赖
        //  render tree 时序，此处用 setTimeout 在壳渲染完毕后直接替换文本——可靠兜底） ----
        setTimeout(function() {
          var done = false
          function tryReplace() {
            if (done) return
            var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false)
            var node
            while ((node = walker.nextNode())) {
              if (node.textContent && node.textContent.indexOf('DSH Local Build') !== -1) {
                node.textContent = node.textContent.replace(/DSH Local Build[^\n]*/, 'ATF 训练 Agent')
                done = true
              }
            }
            if (!done) setTimeout(tryReplace, 1000)
          }
          tryReplace()
        }, 3000)

        // 修正 2：审批面板指引卡
        ctx.slots.inject('conversation.approval.detail', function() {
          return ctx.slots.register({ name: 'conversation.approval.detail', id: 'atf-confirm-guide' }, ConfirmGuide)
        })

        // 快捷指令胶囊
        ctx.slots.inject('conversation.composer.dock', function() {
          var pills = [
            { label: '新建训练', msg: '我想启动一个新的训练任务' },
            { label: '查状态', msg: '查看当前训练任务状态' },
            { label: '继续上次', msg: '继续上次的训练任务' },
            { label: '对比两轮', msg: '对比最近两轮训练的指标' },
          ]
          return ctx.slots.register({ name: 'conversation.composer.dock', id: 'atf-quick-pills' }, function() {
            return React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', padding: '4px 0' } },
              pills.map(function(pill) {
                return React.createElement('button', { key: pill.label,
                  style: { border: 0, background: 'rgba(128,128,128,.1)', borderRadius: 8, padding: '4px 12px', cursor: 'pointer', fontSize: 13 },
                  onClick: function() {
                    var ta = document.querySelector('textarea')
                    if (ta) { ta.value = pill.msg; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus() }
                  },
                }, pill.label)
              }))
          })
        })

        // 监控面板（shell.overlay 右侧停靠）
        ctx.slots.inject('shell.overlay', function() {
          return ctx.slots.register({ name: 'shell.overlay', id: 'atf-dock-panel' }, function() {
            var remote = ctx.remote
            var _s = React.useState({ runs: [] }), data = _s[0], setData = _s[1]
            React.useEffect(function() {
              var read = function() {
                remote.workspaceFiles.read(store.sessionId, '/data/sam/ATF-Harness/tmp/webui-runs/atf-ui/monitor.json', new AbortController().signal)
                  .then(function(r) { if (r) setData(typeof r === 'string' ? JSON.parse(r) : r) })
                  .catch(function() {})
              }
              read()
              var t = setInterval(read, 5000)
              return function() { clearInterval(t) }
            }, [])
            return React.createElement('div', { style: { position: 'fixed', top: 0, right: 0, width: 400, maxHeight: '100vh', overflowY: 'auto', background: '#fff', borderLeft: '1px solid #e2e8f0', zIndex: 40, padding: 12 } },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: 8, fontSize: 15 } }, '分段监控'),
              React.createElement(AtfMonitor, { monitor: data }),
              React.createElement('div', { style: { fontWeight: 600, marginTop: 10, marginBottom: 4, fontSize: 15 } }, '产物抽屉'),
              React.createElement(AtfArtifacts, { artifacts: data }))
          })
        })

        var store = { sessionId: undefined }
      },
    }
  },
})
