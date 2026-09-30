/**
 * atf-ui client 半：三定制组件的浏览器渲染面（零构建纯 JS——沿 fixture-live-client 的
 * window.__ModuleLoader__.load 协议；React 由 DSH 前端 require 提供）。
 *
 * 组件：
 *   AtfConfirmDetail —— conversation.approval.detail slot：ATF 确认操作指引卡
 *                       （面板主体九要素文案由 atf_config_confirm 的 displayReason 承载）。
 *   AtfPanel         —— shell.overlay 右侧停靠面板：上半 ui-atf-monitor（分段卡＋三线曲线＋
 *                       KPI 2×2＋空态文案），下半 ui-atf-artifacts（逐段入列＋[预览] 直开）。
 * 数据：workspaceFiles.read 轮询 <runsRoot>/atf-ui/{monitor,artifacts}.json（服务端同步器
 * 产出；刷新从落盘文件重建——不依赖浏览器会话）。
 */
window.__ModuleLoader__.load({
    id: '@atf/dsh-atf-ui',
    factory(require) {
      const React = require('react')
      // 渲染辅助内联（bundle 打包器不支持包内相对 require——数据驱动：SEGMENTS 来自 monitor.json）
      const QUEUE_IDLE_TEXT = '等待训练启动 · DRY_RUN 已过 · 排队中'
      const KPI_KEYS = ['train_loss', 'eval_loss', 'learning_rate', 'gpu_mem']
      function lossSvgPath(points, key, w, h) {
        const vs = points.map((p) => p[key]).filter((v) => typeof v === 'number')
        if (vs.length < 2) return null
        const min = Math.min(...vs), max = Math.max(...vs), range = max - min || 1
        return vs.map((v, i) => ((i / (vs.length - 1)) * w).toFixed(1) + ',' + (h - 4 - ((v - min) / range) * (h - 8)).toFixed(1)).join(' ')
      }
      function deriveKpis(points) {
        const last = points[points.length - 1] ?? {}
        return {
          train_loss: typeof last.train_loss === 'number' ? String(last.train_loss) : '—',
          eval_loss: typeof last.eval_loss === 'number' ? String(last.eval_loss) : '—',
          learning_rate: typeof last.learning_rate === 'number' ? String(last.learning_rate) : '—',
          gpu_mem: '—',
        }
      }
      function deriveTrainingState(points) { return points.length > 0 ? 'training' : 'idle' }

      const POLL_MS = 5000
      const SERIES_COLORS = { train_loss: '#1d4ed8', eval_loss: '#94a3b8', grad_norm: '#16a34a' }
      const SERIES_DASH = { train_loss: '', eval_loss: '4 3', grad_norm: '' }
      const SERIES_LABELS = { train_loss: 'train（实线蓝）', eval_loss: 'eval（虚线灰）', grad_norm: '梯度范数（绿）' }

      // ---- 面板级共享 store（按钮开合＋会话 id 由 header 按钮注入） ----
      function ConfirmGuide() {
        return React.createElement('div', { className: 'atf-confirm-guide' },
          React.createElement('b', null, 'ATF 确认卡应答方式'),
          '确认并继续＝点下方 Allow once；逐项修改＝直接在输入框回复（如「lr 改 2e-4 其他 ok」），九要素卡将改参重呈；拒绝＝Reject。卡面字段右侧三态标记：⚠ 已用缺省／◆ 来自登记／? 需确认。')
      }

      let remoteFace = null
      const store = {
        open: false,
        sessionId: undefined,
        listeners: new Set(),
        set(open) {
          this.open = open
          this.listeners.forEach((listener) => listener())
        },
        subscribe(listener) {
          this.listeners.add(listener)
          return () => this.listeners.delete(listener)
        },
        getSnapshot() {
          return this.open
        },
      }

      function useStore() {
        const [, force] = React.useState(0)
        React.useEffect(() => store.subscribe(() => force((n) => n + 1)), [])
        return [store.getSnapshot(), (v) => store.set(v)]
      }

      function useAtfSnapshots(sessionId) {
        const [snap, setSnap] = React.useState({ monitor: null, artifacts: null })
        React.useEffect(() => {
          if (sessionId === undefined || remoteFace === null) return undefined
          let alive = true
          const read = async () => {
            try {
              const readOne = async (file) => {
                const result = await remoteFace.workspaceFiles.read(sessionId, `/data/sam/ATF-Harness/tmp/webui-runs/atf-ui/${file}`, new AbortController().signal)
                if (result && result.ok === false) return null
                return typeof result === 'string' ? JSON.parse(result) : result?.content ?? result?.text ?? result ?? null
              }
              const monitor = await readOne('monitor.json')
              const artifacts = await readOne('artifacts.json')
              if (alive) setSnap({ monitor, artifacts })
            } catch { /* 文件未就绪/离线——下周期重试 */ }
          }
          void read()
          const timer = setInterval(read, POLL_MS)
          return () => { alive = false; clearInterval(timer) }
        }, [sessionId])
        return snap
      }

      // ---- 组件 2：ui-atf-monitor ----
      function AtfMonitor({ monitor }) {
        const [runId, setRunId] = React.useState('')
        const runs = monitor?.runs ?? []
        const activeRun = runs.find((r) => r.run_id === runId) ?? runs[0]
        if (runs.length === 0) {
          return React.createElement('div', { className: 'atf-monitor' },
            React.createElement('div', { className: 'atf-dim' }, '（暂无 run——对话创建后此处亮卡）'))
        }
        const points = Array.isArray(activeRun?.training?.points) ? activeRun.training.points : []
        const state = deriveTrainingState(points)
        const kpis = deriveKpis(points)
        const [tab, setTab] = React.useState('loss')
        const seriesKeys = tab === 'loss' ? ['train_loss', 'eval_loss'] : ['grad_norm']
        return React.createElement('div', { className: 'atf-monitor' },
          React.createElement('div', { className: 'atf-row' },
            React.createElement('select', {
              className: 'atf-select', value: activeRun.run_id,
              onChange: (e) => setRunId(e.target.value),
            }, runs.map((r) => React.createElement('option', { key: r.run_id, value: r.run_id }, r.run_id)))),
          // 分段感知五卡（批⑮定稿口径）
          React.createElement('div', { className: 'atf-seg-row' },
            activeRun.segments.map((seg) => React.createElement('div', {
              key: seg.key, className: 'atf-seg-card' + (seg.lit ? ' lit' : ' dim'),
            }, seg.label, React.createElement('span', { className: 'atf-seg-state' }, seg.lit ? '●' : '⏸')))),
          state === 'idle'
            ? React.createElement('div', { className: 'atf-idle' }, QUEUE_IDLE_TEXT)
            : React.createElement('div', { className: 'atf-training' },
                React.createElement('div', { className: 'atf-pct' }, `${String(points.length)} 步`),
                React.createElement('div', { className: 'atf-tabs' },
                  ['loss', 'grad'].map((key) => React.createElement('button', {
                    key, className: 'atf-tab' + (tab === key ? ' active' : ''),
                    onClick: () => setTab(key),
                  }, key === 'loss' ? 'Loss 双线' : '梯度范数'))),
                React.createElement('svg', { className: 'atf-chart', viewBox: '0 0 300 80', preserveAspectRatio: 'none' },
                  seriesKeys.map((key) => {
                    const path = lossSvgPath(points, key, 300, 80)
                    return path === null ? null : React.createElement('polyline', {
                      key, points: path, fill: 'none', stroke: SERIES_COLORS[key], strokeWidth: 1.5,
                      strokeDasharray: SERIES_DASH[key] || undefined,
                    })
                  })),
                React.createElement('div', { className: 'atf-legend' },
                  seriesKeys.map((key) => React.createElement('span', { key, className: 'atf-legend-item' },
                    React.createElement('span', { className: 'atf-swatch', style: { background: SERIES_COLORS[key] } }),
                    SERIES_LABELS[key]))),
                React.createElement('div', { className: 'atf-kpi-grid' },
                  KPI_KEYS.map((key) => React.createElement('div', { key, className: 'atf-kpi-card' },
                    React.createElement('div', { className: 'atf-kpi-label' }, key),
                    React.createElement('div', { className: 'atf-kpi-value' }, kpis[key]))))),
        )
      }

      // ---- 组件 3：ui-atf-artifacts ----
      function AtfArtifacts({ artifacts }) {
        const runs = artifacts?.runs ?? []
        const [preview, setPreview] = React.useState(null)
        const openPreview = async (row) => {
          try {
            const result = await remoteFace.workspaceFiles.read(
              store.sessionId, `/data/sam/ATF-Harness/tmp/webui-runs/${row.path}`, new AbortController().signal)
            const text = typeof result === 'string' ? result : (result?.content ?? result?.text ?? JSON.stringify(result ?? {}, null, 1))
            // 直开语义（批⑰修复口径）：blob 新标签展示内容，不新建会话
            const url = URL.createObjectURL(new Blob([String(text)], { type: 'text/plain; charset=utf-8' }))
            window.open(url, '_blank')
            setPreview(row.name)
          } catch { setPreview(`${row.name}（预览失败——文件不可读）`) }
        }
        if (runs.length === 0) return React.createElement('div', { className: 'atf-artifacts' }, React.createElement('div', { className: 'atf-dim' }, '（暂无产物）'))
        const active = runs.find((r) => r.run_id === store.activeRun) ?? runs[0]
        return React.createElement('div', { className: 'atf-artifacts' },
          runs.map((run) => React.createElement('div', { key: run.run_id, className: 'atf-art-run' },
            React.createElement('div', { className: 'atf-art-run-head' }, `run ${run.run_id}`),
            run.artifacts.length === 0
              ? React.createElement('div', { className: 'atf-dim' }, '（该 run 暂无产物）')
              : run.artifacts.map((row) => React.createElement('div', { key: row.path, className: 'atf-art-row' },
                  React.createElement('span', { className: 'atf-art-name' }, row.name),
                  React.createElement('button', {
                    className: 'atf-btn', onClick: () => void openPreview(row),
                  }, '[预览]'))))),
          preview === null ? null : React.createElement('div', { className: 'atf-dim' }, `已直开：${String(preview)}`))
      }

      // ---- 右侧停靠面板（overlay 自绘右栏——实现方式 M2 自主决定，验收看效果） ----
      function AtfDockPanel({ sessionId, snapOverride }) {
        const [open] = useStore()
        if (!open || sessionId === undefined) return null
        return React.createElement('div', { className: 'atf-dock' },
          React.createElement('div', { className: 'atf-dock-head' },
            React.createElement('b', null, 'ATF 训练 Agent'),
            React.createElement('button', { className: 'atf-btn', onClick: () => store.set(false) }, '×')),
          React.createElement(AtfPanelBody, { sessionId, snapOverride }))
      }

      function AtfPanelBody({ snapOverride }) {
        const polled = useAtfSnapshots(undefined)
        const snap = snapOverride ?? polled
        return React.createElement('div', { className: 'atf-dock-body' },
          React.createElement('div', { className: 'atf-dock-title' }, '分段监控'),
          React.createElement(AtfMonitor, { monitor: snap.monitor }),
          React.createElement('div', { className: 'atf-dock-title' }, '产物抽屉'),
          React.createElement(AtfArtifacts, { artifacts: snap.artifacts }))
      }

      const __components = { AtfMonitor, AtfArtifacts, AtfPanelBody, ConfirmGuide }
      return {
        __components,
        inject: ['slots', 'remote', 'locale'],
        apply(ctx) {
          // remote 面：workspaceFiles.read（外路径读＝其文档明示能力）；sessionId 经 header 按钮的
          // session-scoped 注入拿（ConversationInjected）——见 header.utilities 注册。
          // 浏览器副作用带环境守卫（Node 测试环境无 window/document——纯 slot 注册照常可测）。
          console.log('[atf-ui] apply step1: remote 注入')
          remoteFace = ctx.remote
          console.log('[atf-ui] apply step2: locale 注册前')
          ctx.locale.register('atfUi', {
            zh: { toggle: 'ATF', panelTitle: 'ATF 训练 Agent' },
            en: { toggle: 'ATF', panelTitle: 'ATF Training Agent' },
          })
          if (typeof window !== 'undefined') window.__ATF_REMOTE__ = ctx.remote
          if (typeof document !== 'undefined') {
            const style = document.createElement('style')
            style.dataset.plugin = '@atf/dsh-atf-ui'
          style.textContent = [
            '.atf-dock{position:absolute;top:0;right:0;width:400px;max-height:100vh;overflow-y:auto;',
            'background:#fff;border-left:1px solid #e2e8f0;box-shadow:-4px 0 12px rgba(15,23,42,.08);z-index:40;',
            'font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;color:#1e293b;padding:12px;}',
            '.atf-dock-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}',
            '.atf-dock-title{font-weight:600;font-size:14px;margin:10px 0 6px;}',
            '.atf-btn{border:1px solid #e2e8f0;background:#fff;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:11px;}',
            '.atf-dim{color:#64748b;font-size:11px;}',
            '.atf-seg-row{display:flex;gap:4px;margin:6px 0;}',
            '.atf-seg-card{flex:1;border:1px solid #e2e8f0;border-radius:6px;padding:4px 6px;text-align:center;font-size:11px;}',
            '.atf-seg-card.lit{border-color:#1d4ed8;background:#eff6ff;color:#1d4ed8;}',
            '.atf-seg-card.dim{opacity:.5;}',
            '.atf-seg-state{display:block;}',
            '.atf-idle{color:#b45309;background:#fef3c7;border-radius:6px;padding:8px;margin:6px 0;font-size:11px;}',
            '.atf-pct{font-size:20px;font-weight:700;}',
            '.atf-tabs{display:flex;gap:4px;margin:6px 0;}',
            '.atf-tab{border:1px solid #e2e8f0;background:#fff;border-radius:999px;padding:1px 8px;cursor:pointer;font-size:11px;}',
            '.atf-tab.active{background:#1d4ed8;color:#fff;border-color:#1d4ed8;}',
            '.atf-chart{width:100%;height:80px;border:1px dashed #e2e8f0;border-radius:6px;background:#f8fafc;}',
            '.atf-legend{display:flex;gap:10px;font-size:10px;color:#64748b;margin:4px 0;}',
            '.atf-swatch{display:inline-block;width:10px;height:3px;vertical-align:middle;margin-right:3px;}',
            '.atf-kpi-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;}',
            '.atf-kpi-card{border:1px solid #e2e8f0;border-radius:6px;padding:4px 6px;}',
            '.atf-kpi-label{font-size:10px;color:#64748b;}',
            '.atf-kpi-value{font-size:13px;font-weight:600;}',
            '.atf-art-run{border:1px solid #e2e8f0;border-radius:8px;padding:6px 8px;margin-bottom:6px;}',
            '.atf-art-run-head{font-weight:600;margin-bottom:4px;}',
            '.atf-art-row{display:flex;justify-content:space-between;align-items:center;padding:2px 0;font-size:11px;}',
            '.atf-confirm-guide{border:1px dashed #b45309;background:#fffbeb;border-radius:8px;padding:8px;font-size:11px;color:#b45309;}',
            '.atf-confirm-guide b{display:block;margin-bottom:4px;color:#1e293b;}',
          ].join('')
            document.head.append(style)
          }

          // 组件 1：ui-atf-confirm —— 审批面板 detail 区（ATF 确认指引；面板主体九要素文案
          // 由 atf_config_confirm/atf_publish_confirm 的 displayReason 承载）。
          console.log('[atf-ui] apply step3: locale/slots 就绪——注册 approval.detail')
          ctx.slots.inject('conversation.approval.detail', () => ctx.slots.register({
            name: 'conversation.approval.detail', id: 'atf-confirm-guide',
          }, (props) => React.createElement(ConfirmGuide, { ...props })))


          // 面板开关按钮（session-scoped：inject 工厂收 sessionId——RightbarSeat 同款）＋overlay 停靠面板
          console.log('[atf-ui] apply step4: 注册 header.utilities')
          ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'atf-dock-toggle',
            order: 900,
            locale: 'atfUi',
            inject: (sessionId) => {
              store.sessionId = sessionId
              return { openPanel: () => store.set(true) }
            },
          }, ({ openPanel, t }) => React.createElement('button', {
            className: 'atf-btn', title: 'ATF 训练监控与产物', onClick: openPanel,
          }, t('toggle'))))
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay', id: 'atf-dock-panel',
          }, () => React.createElement(AtfDockPanel, { sessionId: store.sessionId })))
        },
      }
    },
})