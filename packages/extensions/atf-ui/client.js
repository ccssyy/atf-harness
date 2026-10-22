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
 *  批甲-FIX（2026-10-15，owner 三裁）：
 *  · T2.2 去「默认」态——当前档位取值链＝①当前会话用户最近手动切换值（state.current
 *    .reasoningEffort）→②用户为该模型设置的默认档（/atf-ui/settings effort_defaults，∩目录
 *    闭集）→③目录 efforts 顺位最低档（声明序首位：GLM-5.3→Off；Flash 系→Low）。链值经程序化
 *    补选固化为会话选择（显示值＝真实送出值，不悬空）；菜单恒闭集值，无闭集外项。
 *  · T2.3 会话内模型切换档位取值（owner 裁定：目标模型支持当前档位则保持，不支持则落
 *    该模型顺位最近档，如实呈现不静默跳 max）——vendor 两条模型切换路径落地时均不携带
 *    旧档位（composer 座 choose／/model 面板 selectionOf），故「保持/回退」由产品层在切换
 *    落地后补选承接；越界档位提交被拒路径（同模型重选携带陈旧档等）由补偿分支承接（防环）。
 *    跨会话 sticky＝宿主既有语义（selectModel→agentDefaultModel.saveSelection 全局持久化，
 *    新建会话经 catalog default 延用），本控件零新机制。
 *  · T2.1 Models 设置页 per-model 默认档——settings.models.provider-card keyed 槽（key＝
 *    glm-atf 的 settingsNs 'llm-pi-ai'）注入 ProviderModelDefaults：每模型一个「默认思考等级」
 *    下拉（选项＝该模型目录 efforts 闭集），持久化走 /atf-ui/settings effort_defaults 块
 *    （产品层设置单源；vendor 零写入）。
 *  数据：workspaceFiles.read 轮询 <runsRoot>/atf-ui/monitor.json（同步器 5s 快照单源，
 *  gpu 字段＝nvidia-smi 首行单卡面，gpu_all/gpu_binding＝批㉝H 多卡聚合与绑卡声明，
 *  viewers 字段＝run 维度 badcase viewer 发现清单——批㉛段1）；
 *  sessionId 经 header.utilities 的 session-scoped inject 工厂捕获（批⑳实证通道）。
 *  viewer 渲染：iframe 指 server 半静态路由 /atf-ui/viewer/<runId>/（同源 cookie 鉴权，
 *  不重建 viewer 本身——产物由 atf-analyze-badcases skill 链产出）。
 *  挂载面（DSH slot 契约，批㉑三段实证）：conversation.session.header.utilities＝list
 *  （「监控」按钮＋sessionId 捕获——GPU 按钮随 D11-2 去重删除）；conversation.composer.dock＝list（快捷胶囊＋训练任务卡，
 *  与 ui-chat stats 同槽共存）；conversation.input.right＝list（思考档位快切，批甲-BUILD T1）；
 *  settings.section＝list（训练配置页——D11-1 自搓设置浮层退役迁原生设置页，order 900）；
 *  conversation.approval.detail＝single（ui-chat 独占——第三方注册会顶掉其 seat 致其 apply
 *  抛错，故不挂）。
 *  目录结构 v1（默认桶语义＋目录迁移呈现）：dock 行加挂 LostWorkspacesBanner（/atf-ui/
 *  workspaces 只读端点轮询——exists=false 的工作区卡面标「目录已丢失——可用
 *  atf_rebind_workspace 重新定位」）；vendor「未分组/Ungrouped」桶文案在渲染层覆盖为
 *  「任务/Task」（rAF 合帧 sweep·双语闭集精确匹配·仅值变化写回——与 FIX2 同型防自激；
 *  W2b 微批修正：label/meta span 为 css-modules 哈希类，选择器取语义段子串＋行容器
 *  data-row-key 前缀（含未分组行 workspace: 空前缀形态），dev DOM 实锚定案）。 */
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

    // ── 批甲-FIX T2.1/T2.2：per-model 默认思考档（用户 settings 单源——/atf-ui/settings
    // effort_defaults 块，模型 id → 档位 id）。设置页 provider-card 下拉写、composer 取值链
    // 中段读；模块级缓存（apply 时预取——链值首帧即就位，免「最低档闪一拍」）。
    var effortDefaultsCache = { map: null, promise: null }
    function loadEffortDefaults(force) {
      if (force === true) { effortDefaultsCache.map = null; effortDefaultsCache.promise = null }
      if (effortDefaultsCache.promise === null) {
        effortDefaultsCache.promise = fetch('/atf-ui/settings', { credentials: 'same-origin', cache: 'no-store' })
          .then(function(r) { return r.ok ? r.json() : null })
          .then(function(d) {
            effortDefaultsCache.map = (d !== null && d !== undefined && typeof d.effort_defaults === 'object' && d.effort_defaults !== null)
              ? d.effort_defaults : {}
            return effortDefaultsCache.map
          })
          .catch(function() { /* 离线/未就绪——链中段空手而归（落到链③），下个 force 重取 */ })
      }
      return effortDefaultsCache.promise
    }
    function saveEffortDefaults(nextMap) {
      return fetch('/atf-ui/settings', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort_defaults: nextMap }),
      })
        .then(function(r) { return r.json().then(function(b) { return { status: r.status, body: b } }) })
        .then(function(out) {
          if (out.status === 200 && out.body && out.body.saved) {
            effortDefaultsCache.map = (out.body.effort_defaults && typeof out.body.effort_defaults === 'object')
              ? out.body.effort_defaults : nextMap
          }
          return out
        })
    }
    function userDefaultEffortOf(modelId) {
      var map = effortDefaultsCache.map
      if (map === null || typeof map !== 'object') return undefined
      var v = map[modelId]
      return typeof v === 'string' ? v : undefined
    }

    var remoteFace = null
    // 批㊶Q增补一：右栏导航面暂存（apply 赋值；组件在 factory 闭包拿不到 ctx——沿 remoteFace 先例）
    var sidebarFace = null
    var store = {
      sessionId: undefined,
      // 批㉛段1：badcase viewer 浮层状态（null=关；{runId}=开着并指向该 run）
      viewer: null,
      // 批㉛段2：发起训练对话框状态（null=关；{runId, mode}）
      train: null,
      // H5：联合训练字段编辑对话框状态（null=关；{}=开着——编辑态在组件本地 draft）
      joint: null,
      // 批㉛段3.1：右栏训练监控抽屉（默认收起——chat 不受挡；打开后选 run 联动）
      monitorOpen: false,
      monitorRunId: null,
      // 批B2 §四：全部模式（只读浏览）与绑定选择面板开合——升 store 单源（面板/空态/胶囊
      // 都要驱动，MonitorPanel 本地态升格；语义不变）
      monitorShowAll: false,
      bindingPanel: false,
      taskCardOpen: false,
      listeners: new Set(),
      subscribe: function(fn) { var s = this; s.listeners.add(fn); return function() { s.listeners.delete(fn) } },
      setViewer: function(v) { this.viewer = v; this.listeners.forEach(function(fn) { fn() }) },
      setTrain: function(v) { this.train = v; this.listeners.forEach(function(fn) { fn() }) },
      setJoint: function(v) { this.joint = v; this.listeners.forEach(function(fn) { fn() }) },
      setMonitor: function(open, runId) { this.monitorOpen = open; if (runId !== undefined) this.monitorRunId = runId; this.listeners.forEach(function(fn) { fn() }) },
      setMonitorShowAll: function(v) { this.monitorShowAll = v === true; this.listeners.forEach(function(fn) { fn() }) },
      setBindingPanel: function(open) { this.bindingPanel = open === true; this.listeners.forEach(function(fn) { fn() }) },
      setTaskCard: function(v) { this.taskCardOpen = v; this.listeners.forEach(function(fn) { fn() }) },
    }

    // ── 批B2 §一：会话↔Run 绑定 store（单源——B1 端点 /atf-ui/session-binding 为唯一真相，
    // 前端不推断绑定）。首屏/切会话 GET；bind/unbind/rename POST 成功后重拉；不新增轮询
    // （run 状态仍由 monitor 5s 拍/SSE 刷新）。迟到响应双保险丢弃：请求序号＋归属 sessionId
    // 任一不符＝切会话串台，不写状态不 emit。 ──
    var binding = {
      status: 'loading',      // loading | ready | error（loading 时 chip 显骨架不显旧值）
      sessionId: undefined,   // 当前归属会话（丢弃校验锚）
      seq: 0,                 // 请求序号（迟到响应丢弃）
      active: null,           // {run_id, workspace, title} | null
      unbound_reason: null,   // 'new'|'cleared'|'stale'|null
      recent: [],             // ≤3 {run_id, workspace, title, mtime}
      candidates: [],         // ≤5（本工作区优先）
      binding: null,          // 完整记录（撤销解除取 history 上一条）
      version: 0,
      listeners: new Set(),
      subscribe: function(fn) { var s = this; s.listeners.add(fn); return function() { s.listeners.delete(fn) } },
      emit: function() {
        this.version++
        this.listeners.forEach(function(fn) { try { fn() } catch (e) { /* 单订阅方异常不连坐 */ } })
      },
      /** 切会话/首屏：先清空到 loading（chip 显骨架不显旧会话值），再按新会话拉取。 */
      resetFor: function(sessionId) {
        this.sessionId = sessionId
        this.status = 'loading'
        this.active = null
        this.unbound_reason = null
        this.recent = []
        this.candidates = []
        this.binding = null
        this.emit()
      },
      load: function(sessionId) {
        var self = this
        if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve()
        var seq = ++this.seq
        return fetch('/atf-ui/session-binding?sessionId=' + encodeURIComponent(sessionId), { credentials: 'same-origin', cache: 'no-store' })
          .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)) })
          .then(function(d) {
            // 迟到响应丢弃（§一红线：防切会话串台——序号或会话任一不符即弃）
            if (seq !== self.seq || self.sessionId !== sessionId) return
            self.status = 'ready'
            self.active = (d && d.active) || null
            self.unbound_reason = (d && d.unbound_reason) || null
            self.recent = (d && Array.isArray(d.recent)) ? d.recent : []
            self.candidates = (d && Array.isArray(d.candidates)) ? d.candidates : []
            self.binding = (d && d.binding) || null
            self.emit()
          })
          .catch(function() {
            if (seq !== self.seq || self.sessionId !== sessionId) return
            self.status = 'error'
            self.emit()
          })
      },
      /** POST 通道：成功（saved）后重拉——chip/监控/胶囊经同一 store 同步刷新。 */
      post: function(body) {
        var self = this
        return fetch('/atf-ui/session-binding', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function(r) { return r.json().then(function(b) { return { status: r.status, body: b } }) })
          .catch(function() { return { status: 0, body: null } })
          .then(function(out) {
            if (out.status === 200 && out.body && out.body.saved) return self.load(self.sessionId).then(function() { return out })
            return out
          })
      },
      bindRun: function(runId) { return this.post({ sessionId: this.sessionId, runId: runId }) },
      unbindRun: function() { return this.post({ sessionId: this.sessionId, runId: null }) },
      renameRun: function(runId, title) { return this.post({ sessionId: this.sessionId, rename: { runId: runId, title: title } }) },
      /** 撤销解除（cleared 空态）：history 上一条 run（最新在前取首个）。 */
      undoUnbind: function() {
        var h = (this.binding && Array.isArray(this.binding.history)) ? this.binding.history : []
        var prev = h.length > 0 ? h[0].run_id : null
        return prev ? this.bindRun(prev) : Promise.resolve(null)
      },
      // ── B2c：草稿态「回到上次实验」——pending 绑定意图（客户端单份，零服务端态）。
      // 草稿态（无 sessionId）点击卡只存 pending 不 POST（没有 sessionId 可绑）；
      // 首条消息发出、sessionId 出现时消费一次（且仅一次——消费即清）POST 绑定→落账本
      // （B1 端点语义零改）。 ──
      pending: null,          // {runId, title, workspace} | null（草稿待绑定意图）
      draft: { status: 'idle', recent: [] }, // 草稿态最近实验（GET 无 sessionId 载荷）
      loadDraft: function() {
        var self = this
        self.draft.status = 'loading'
        self.emit()
        return fetch('/atf-ui/session-binding', { credentials: 'same-origin', cache: 'no-store' })
          .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)) })
          .then(function(d) {
            self.draft.status = 'ready'
            self.draft.recent = (d && Array.isArray(d.recent)) ? d.recent : []
            self.emit()
          })
          .catch(function() {
            self.draft.status = 'error'
            self.emit()
          })
      },
      /** 点卡存意图（幂等——pending 在场同 run 不重复入队；换 run 则替换为最新意图）。 */
      stagePending: function(item) {
        if (this.pending !== null && this.pending.runId === item.run_id) return
        this.pending = { runId: item.run_id, title: item.title || '', workspace: item.workspace || null }
        this.emit()
      },
      clearPending: function() { this.pending = null; this.emit() },
      // B2c：一次性业务通报（消费失败等——5s 自消失；null＝无）
      toast: null,
      toastTimer: null,
      setToast: function(text) {
        var self = this
        self.toast = text
        self.emit()
        if (self.toastTimer !== null) { clearTimeout(self.toastTimer); self.toastTimer = null }
        self.toastTimer = setTimeout(function() { self.toast = null; self.toastTimer = null; self.emit() }, 5000)
      },
      /** B2c：pending 消费（sessionId 出现时恰一次）——POST 绑定→落账本（B1 语义零改）。
       *  成功：清 pending（不复燃）；失败：清 pending＋业务通报（不静默丢、不自动重试——
       *  「恰一次 POST」红线；可在监控/顶栏手动重绑）。 */
      consumePending: function(sessionId) {
        var self = this
        var p = self.pending
        if (p === null || p === undefined) return
        self.clearPending()
        self.post({ sessionId: sessionId, runId: p.runId })
          .then(function(out) {
            if (!(out && out.status === 200 && out.body && out.body.saved)) {
              var reason = out && out.body && typeof out.body.message === 'string' && out.body.message !== '' ? out.body.message : '服务暂不可用'
              self.setToast('自动绑定上次实验失败（' + reason + '）——可在顶栏「选择实验」手动绑定')
            }
          })
          .catch(function() {
            self.setToast('自动绑定上次实验失败（网络异常）——可在顶栏「选择实验」手动绑定')
          })
      },
    }
    /** 绑定 store 订阅 hook（返回 store 本体——字段直读；version 变更驱动重渲）。
     *  subscribe 须以方法调用形态包一层（裸引用传 React 会丢 this——listeners undefined）。 */
    function useBinding() {
      React.useSyncExternalStore(
        function(fn) { return binding.subscribe(fn) },
        function() { return binding.version },
      )
      return binding
    }

    /** 批B2 §四.5：run 状态/进度单源（顶栏 chip 与监控头共用同一推导——禁两套）。
     *  run＝monitor.json runs[] 项；返回状态文案/色类/进度百分数/ETA/训练中布尔。 */
    function runStatusOf(run) {
      var progress = (run && run.progress) || (run && run.training && run.training.progress) || null
      var failed = !!(run && (run.segments || []).some(function(s) { return s.status === 'failed' }))
      var trainingNow = !!(run && run.training && run.training.active === true)
      var pct = trainingNow && progress && typeof progress.percentage === 'number' ? Math.round(progress.percentage) : null
      var eta = trainingNow && progress ? fmtEta(progress.eta_s) : null
      return {
        text: trainingNow ? '训练中' : failed ? '异常' : '空闲',
        cls: trainingNow ? ' atf-status-active' : failed ? ' atf-status-fail' : ' atf-status-idle',
        pct: pct,
        eta: eta,
        progress: progress,
        trainingNow: trainingNow,
        failed: failed,
        /** chip 单行形态：训练中 62% ／ 异常 ／ 空闲 */
        label: trainingNow ? ('训练中' + (pct !== null ? ' ' + pct + '%' : '')) : failed ? '异常' : '空闲',
      }
    }

    // ── 批B2：用户可见名（title＋工作区）——chip/选择面板/任务卡/通知共用；title 缺席
    // 降级「实验 <末6位>」（B1 同款降级），用户可见面不裸跑 run_id 为主标识。 ──
    function displayTitleOf(run) {
      if (!run) return ''
      var t = run.display && typeof run.display.title === 'string' && run.display.title !== '' ? run.display.title : null
      return t !== null ? t : ('实验 ' + String(run.run_id || '').slice(-6))
    }
    /** 通知/任务卡形态：title（workspace）——工作区缺席只 title。 */
    function displayLabelOf(run) {
      if (!run) return ''
      var ws = typeof run.workspace === 'string' && run.workspace !== '' ? run.workspace : null
      return displayTitleOf(run) + (ws !== null ? '（' + ws + '）' : '')
    }
    function findRunById(mon, runId) {
      var runs = (mon && mon.runs) || []
      for (var i = 0; i < runs.length; i++) if (runs[i] && runs[i].run_id === runId) return runs[i]
      return null
    }
    /** 同名跨工作区判定（§三：同名跨区主行加 [workspace] 前缀）——title 在 ≥2 个不同
     *  工作区出现的集合（无工作区标注项不参与——无跨区同名概念）。 */
    function dupTitleSet(lists) {
      var seen = {}
      var dup = {}
      for (var li = 0; li < lists.length; li++) {
        var list = lists[li] || []
        for (var i = 0; i < list.length; i++) {
          var item = list[i]
          if (!item) continue
          var title = item.title !== undefined && item.title !== null ? String(item.title) : displayTitleOf(item)
          var ws = typeof item.workspace === 'string' && item.workspace !== '' ? item.workspace : ''
          if (ws === '' || title === '') continue
          var byWs = seen[title] = seen[title] || {}
          if (byWs[ws]) continue
          byWs[ws] = true
          if (Object.keys(byWs).length >= 2) dup[title] = true
        }
      }
      return dup
    }
    /** 工作区徽标短名（af- 前缀与尾部日期段剥除＋截断；title 属性给全名——§二）。 */
    function wsShortOf(ws) {
      if (typeof ws !== 'string' || ws === '') return ''
      return ws.replace(/^af-/, '').replace(/-\d{8}$/, '').slice(0, 14)
    }
    /** 批B2：「继续上次」目标（跨会话语义——设计要点 §5.1：空白新会话的「继续上次」＝
     *  全局上一个 run）。解析序：本会话 history 首条 ＞ 全局最近（端点 recent[0]，server 侧
     *  runsRoot mtime 倒序）；title/workspace 优先 monitor 实锚，缺席用端点载荷，再缺实验<末6位>。 */
    function lastRunInfo(b, mon) {
      if (b.binding && Array.isArray(b.binding.history) && b.binding.history.length > 0) {
        var e = b.binding.history[0]
        var r = findRunById(mon, e.run_id)
        return {
          runId: e.run_id,
          title: r !== null ? displayTitleOf(r) : null,
          ws: r !== null && r.workspace ? r.workspace : null,
          monRun: r,
        }
      }
      if (Array.isArray(b.recent) && b.recent.length > 0) {
        var item = b.recent[0]
        var r2 = findRunById(mon, item.run_id)
        return {
          runId: item.run_id,
          title: typeof item.title === 'string' && item.title !== '' ? item.title : (r2 !== null ? displayTitleOf(r2) : null),
          ws: item.workspace || null,
          monRun: r2,
        }
      }
      return null
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

    // ── H5-JOINT-PURE-START（vitest 抽取锚——纯函数区，禁闭包依赖）──
    // H5 联合训练字段卡前校验——与 packages/extensions/atf-ui/src/jointTrainState.ts
    // jointSpecIssues 同语义双份（client 半裸服务不打包无法 require；双侧测试同夹具
    // 同判定——jointTrain.test.ts×jointTrainUi.test.ts 双钉，CLOSURE_MESSAGE 先例）。
    // 判定闭集（D25 设计 §4.2「字段必须带说明；同一类内 id 唯一」＋内核 builder spec
    // 校验前置镜像）：类清单非空／doc_type 非空且不重复／run_id 非空／document_zh 非空／
    // 每类选中字段非空／field_id 非空且类内唯一／zh 与 definition 非空。
    function jointSpecIssues(classes) {
      var issues = []
      if (!Array.isArray(classes) || classes.length === 0) {
        return [{ code: 'joint_datasets_empty', message: '还没有选择任何单据类型——联合训练至少要有一个类型' }]
      }
      var seen = {}
      for (var i = 0; i < classes.length; i++) {
        var item = classes[i] || {}
        var docType = typeof item.doc_type === 'string' ? item.doc_type.trim() : ''
        if (docType === '') {
          issues.push({ code: 'joint_doc_type_duplicate', message: '有类型没有填单据类型名——每个类型都要写类型名' })
          continue
        }
        if (seen[docType]) {
          issues.push({ code: 'joint_doc_type_duplicate', doc_type: docType, message: '单据类型「' + docType + '」重复——同一类型只能出现一次' })
          continue
        }
        seen[docType] = true
        var runId = typeof item.run_id === 'string' ? item.run_id.trim() : ''
        if (runId === '') issues.push({ code: 'joint_run_id_missing', doc_type: docType, message: '「' + docType + '」还没有选择实验——每个类型都要指到它数据所在的实验' })
        var documentZh = typeof item.document_zh === 'string' ? item.document_zh.trim() : ''
        if (documentZh === '') issues.push({ code: 'joint_document_zh_missing', doc_type: docType, message: '「' + docType + '」缺单据中文名——prompt 渲染必需' })
        var fields = Array.isArray(item.fields) ? item.fields : []
        var selected = []
        for (var j = 0; j < fields.length; j++) {
          if (fields[j] && fields[j].selected !== false) selected.push(fields[j])
        }
        if (selected.length === 0) {
          issues.push({ code: 'joint_field_missing', doc_type: docType, message: '「' + docType + '」一个字段都没选——至少要为每个类型勾选 1 个字段' })
          continue
        }
        var seenIds = {}
        for (var k = 0; k < selected.length; k++) {
          var f = selected[k]
          var fieldId = f && typeof f.field_id === 'string' ? f.field_id.trim() : ''
          if (fieldId === '') {
            issues.push({ code: 'joint_field_id_invalid', doc_type: docType, message: '「' + docType + '」有字段没填字段名——字段名必填' })
            continue
          }
          if (seenIds[fieldId]) {
            issues.push({ code: 'joint_field_id_invalid', doc_type: docType, field_id: fieldId, message: '「' + docType + '」字段名「' + fieldId + '」重复——同一类型内字段名不能重名' })
            continue
          }
          seenIds[fieldId] = true
          var zh = f && typeof f.zh === 'string' ? f.zh.trim() : ''
          var def = f && typeof f.definition === 'string' ? f.definition.trim() : ''
          if (zh === '' || def === '') {
            issues.push({ code: 'joint_field_desc_missing', doc_type: docType, field_id: fieldId, message: '「' + docType + '」字段「' + fieldId + '」缺中文名或字段说明——没有说明就无法写进提取要求' })
          }
        }
      }
      return issues
    }

    // H5 FieldSpec/v1 归一（UI 生成消息用——与 jointTrainState.normalizeJointFieldSpec 同构：
    // group 缺席按 goods；locators 缺省 []；选中字段才进 spec）。
    function jointNormalizeSpec(docType, documentZh, fields) {
      var picked = []
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i]
        if (!f || f.selected === false) continue
        picked.push({
          field_id: String(f.field_id == null ? '' : f.field_id).trim(),
          zh: String(f.zh == null ? '' : f.zh).trim(),
          group: f.group === 'non_goods' ? 'non_goods' : 'goods',
          definition: String(f.definition == null ? '' : f.definition).trim(),
          locators: Array.isArray(f.locators) ? f.locators : (Array.isArray(f.locator_keywords) ? f.locator_keywords : []),
        })
      }
      return { schema_version: 'FieldSpec/v1', doc_type: docType, document_zh: documentZh, fields: picked }
    }

    // H5 行数千分位（卡面/消息「预计 3,410 行」口径——与 jointTrainState.formatRowCount 同构）。
    function jointFormatRowCount(count) {
      return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    // H5 联合训练发起消息（业务语言——与 jointTrainState.buildJointTrainMessage 同语义双份；
    // trainLaunchMessage 先例。一个入口完成构建＋训练：不出现单类 A/B 两入口）。
    function buildJointTrainMessage(plan) {
      var typeList = plan.classes.map(function(c) { return c.doc_type }).join('、')
      var fieldCounts = plan.classes.map(function(c) { return c.doc_type + ' ' + String(c.field_count) }).join(' · ')
      var lines = [
        '发起联合训练（' + String(plan.classes.length) + ' 类：' + typeList + ' → run ' + plan.target_run_id + '）：',
        '请用 atf_joint_train 工具一次完成联合数据构建与训练启动（一个入口，不要拆成单类两步）：',
        'datasets：' + JSON.stringify(plan.classes.map(function(c) { return { run_id: c.run_id, doc_type: c.doc_type } })),
        'field_specs：' + JSON.stringify(plan.field_specs),
      ]
      if (plan.oversample && Object.keys(plan.oversample).length > 0) lines.push('oversample：' + JSON.stringify(plan.oversample))
      else lines.push('oversample：省略（全部类型 1 倍）')
      if (typeof plan.seed === 'number') lines.push('seed：' + String(plan.seed))
      lines.push('字段数核对：' + fieldCounts + (typeof plan.estimated_rows === 'number' ? '；预计 ' + jointFormatRowCount(plan.estimated_rows) + ' 行' : '') + '。')
      lines.push('我会在确认卡上核对类型／各类字段数／预计行数／合并倍率后放行。')
      return lines.join('\n')
    }
    // ── H5-JOINT-PURE-END ──

    // ── H5：联合训练字段编辑/导入对话框（D25 设计 §4.2/§七 Harness 2）──
    // 按类 tab（每个 doc_type 一张），类内 goods/non_goods 两组分区；字段行＝勾选＋id＋
    // 中文＋说明＋分组；全选/反选/加字段；导入＝粘贴 FieldSpec/field-config JSON 或本地
    // 文件（FileReader——浏览器面无任意路径读取）。卡前快败：生成消息前按 jointSpecIssues
    // （与工具面同判定）校验——缺则红字指明类/字段，不生成消息不进 chat 正道链。
    function JointTrainDialog() {
      var joint = React.useSyncExternalStore(
        function(fn) { return store.subscribe(fn) },
        function() { return store.joint })
      var mon = useMonitor()
      var runs = ((mon && mon.runs) || [])
      var st = React.useState(null)
      var draft = st[0], setDraft = st[1]
      var open = joint !== null
      React.useEffect(function() {
        if (open && draft === null) {
          setDraft({ targetRunId: '', seed: '', oversampleText: '', classes: [], activeTab: 0, importText: '', error: null })
        }
        if (!open && draft !== null) setDraft(null)
      }, [open, draft])
      if (!open || draft === null) return null
      var patch = function(next) { setDraft(Object.assign({}, draft, next)) }
      var active = draft.classes[draft.activeTab] || null
      var patchClass = function(idx, next) {
        var classes = draft.classes.slice()
        classes[idx] = Object.assign({}, classes[idx], next)
        setDraft(Object.assign({}, draft, { classes: classes }))
      }
      var addClass = function() {
        var classes = draft.classes.concat([{ doc_type: '', run_id: '', document_zh: '', fields: [] }])
        setDraft(Object.assign({}, draft, { classes: classes, activeTab: classes.length - 1, error: null }))
      }
      var removeClass = function(idx) {
        var classes = draft.classes.slice()
        classes.splice(idx, 1)
        setDraft(Object.assign({}, draft, {
          classes: classes,
          activeTab: Math.max(0, Math.min(draft.activeTab, classes.length - 1)),
          error: null,
        }))
      }
      var addField = function(group) {
        if (active === null) return
        var fields = active.fields.concat([{ field_id: '', zh: '', group: group || 'goods', definition: '', locators: [], selected: true }])
        patchClass(draft.activeTab, { fields: fields })
      }
      var patchField = function(fi, key, value) {
        if (active === null) return
        var fields = active.fields.slice()
        fields[fi] = Object.assign({}, fields[fi])
        fields[fi][key] = value
        patchClass(draft.activeTab, { fields: fields })
      }
      var removeField = function(fi) {
        if (active === null) return
        var fields = active.fields.slice()
        fields.splice(fi, 1)
        patchClass(draft.activeTab, { fields: fields })
      }
      var selectAll = function(value) {
        if (active === null) return
        var fields = active.fields.map(function(f) { return Object.assign({}, f, { selected: value }) })
        patchClass(draft.activeTab, { fields: fields })
      }
      var invertSelection = function() {
        if (active === null) return
        var fields = active.fields.map(function(f) { return Object.assign({}, f, { selected: f.selected === false }) })
        patchClass(draft.activeTab, { fields: fields })
      }
      var doImport = function(textOverride) {
        if (active === null) return
        var text = (typeof textOverride === 'string' ? textOverride : draft.importText).trim()
        if (text === '') {
          patch({ error: { fatal: '导入内容为空——粘贴字段规格 JSON，或选择本地字段规格文件' } })
          return
        }
        var parsed
        try { parsed = JSON.parse(text) } catch (e) {
          patch({ error: { fatal: '导入失败：不是合法 JSON——' + String(e && e.message ? e.message : e) } })
          return
        }
        var fields = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.fields) ? parsed.fields : null
        if (fields === null) {
          patch({ error: { fatal: '导入失败：JSON 里没有 fields 数组（须为 FieldSpec/field-config 形态）' } })
          return
        }
        var rows = fields.map(function(f) {
          f = f || {}
          return {
            field_id: typeof f.field_id === 'string' ? f.field_id : '',
            zh: typeof f.zh === 'string' ? f.zh : '',
            group: f.group === 'non_goods' ? 'non_goods' : 'goods',
            definition: typeof f.definition === 'string' ? f.definition : '',
            locators: Array.isArray(f.locators) ? f.locators : (Array.isArray(f.locator_keywords) ? f.locator_keywords : []),
            selected: true,
          }
        })
        var classes = draft.classes.slice()
        classes[draft.activeTab] = Object.assign({}, active, {
          fields: rows,
          document_zh: active.document_zh !== '' ? active.document_zh : (parsed && typeof parsed.document_zh === 'string' ? parsed.document_zh : ''),
        })
        setDraft(Object.assign({}, draft, { classes: classes, importText: '', error: null }))
      }
      var onFile = function(ev) {
        var file = ev.target.files && ev.target.files[0]
        if (!file) return
        var reader = new FileReader()
        reader.onload = function() { doImport(String(reader.result || '')) }
        reader.readAsText(file)
      }
      var generate = function() {
        // 卡前快败（与工具面同判定单源）：字段/说明缺失、类型重复、run 未选——红字指明
        // 类/字段，不生成消息（不进 chat 正道链，就不会出确认卡）。
        var issues = jointSpecIssues(draft.classes)
        if (issues.length > 0) { patch({ error: { issues: issues } }); return }
        if (draft.targetRunId === '') {
          patch({ error: { fatal: '还没有选择联合训练落点实验——联合数据集写到落点实验的 prep/joint/ 并在那里启动训练' } })
          return
        }
        var oversample = null
        var oversampleText = draft.oversampleText.trim()
        if (oversampleText !== '') {
          try { oversample = JSON.parse(oversampleText) } catch (e) { oversample = undefined }
          var oversampleBad = !oversample || typeof oversample !== 'object' || Array.isArray(oversample)
          if (!oversampleBad) {
            var keys = Object.keys(oversample).sort()
            var want = draft.classes.map(function(c) { return c.doc_type }).sort()
            if (keys.join('\u0000') !== want.join('\u0000')) oversampleBad = 'keyset'
            else {
              for (var ratioKey in oversample) {
                var v = oversample[ratioKey]
                if (typeof v !== 'number' || Math.floor(v) !== v || v < 1) { oversampleBad = 'value'; break }
              }
            }
          }
          if (oversampleBad) {
            patch({ error: { fatal: oversampleBad === 'keyset'
              ? '合并倍率键集与类型不一致——每个类型都要给倍率，或整体省略（＝全部 1 倍）'
              : '合并倍率非法——倍率须为 ≥1 的整数（如 {"pl":1,"swb":2}）；省略＝全部 1 倍' } })
            return
          }
        }
        var seed = null
        if (draft.seed.trim() !== '') {
          seed = Number(draft.seed.trim())
          if (!isFinite(seed) || Math.floor(seed) !== seed || seed < 0) {
            patch({ error: { fatal: 'seed 须为 ≥0 的整数（缺省 0）' } })
            return
          }
        }
        var fieldSpecs = {}
        var msgClasses = draft.classes.map(function(c) {
          var picked = c.fields.filter(function(f) { return f.selected !== false })
          fieldSpecs[c.doc_type] = jointNormalizeSpec(c.doc_type, c.document_zh, c.fields)
          return { doc_type: c.doc_type, run_id: c.run_id, field_count: picked.length }
        })
        var msg = buildJointTrainMessage({
          target_run_id: draft.targetRunId,
          classes: msgClasses,
          field_specs: fieldSpecs,
          oversample: oversample === null ? undefined : oversample,
          seed: seed === null ? undefined : seed,
        })
        var input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]')
        if (input) {
          input.focus()
          document.execCommand('insertText', false, msg)
        }
        store.setJoint(null)
        setDraft(null)
      }
      var runsOptions = runs.map(function(r) {
        return React.createElement('option', { key: r.run_id, value: r.run_id }, r.run_id)
      })
      var tabs = draft.classes.map(function(c, i) {
        return React.createElement('button', {
          key: 'joint-tab-' + String(i),
          className: 'atf-pill' + (i === draft.activeTab ? ' atf-joint-tab-active' : ''),
          'data-joint-tab': c.doc_type !== '' ? c.doc_type : String(i),
          onClick: function() { patch({ activeTab: i, error: null }) },
        }, c.doc_type !== '' ? c.doc_type : '类型' + String(i + 1))
      })
      var fieldRow = function(f, i) {
        return React.createElement('div', { key: 'joint-f-' + String(i), className: 'atf-joint-field' },
          React.createElement('input', {
            type: 'checkbox', 'aria-label': '选用字段 ' + (f.field_id !== '' ? f.field_id : String(i + 1)),
            checked: f.selected !== false,
            onChange: function(ev) { patchField(i, 'selected', ev.target.checked) },
          }),
          React.createElement('input', { className: 'atf-joint-fid', placeholder: '字段名', value: f.field_id, onChange: function(ev) { patchField(i, 'field_id', ev.target.value) } }),
          React.createElement('input', { className: 'atf-joint-fzh', placeholder: '中文', value: f.zh, onChange: function(ev) { patchField(i, 'zh', ev.target.value) } }),
          React.createElement('input', { className: 'atf-joint-fdef', placeholder: '说明（必填）', value: f.definition, onChange: function(ev) { patchField(i, 'definition', ev.target.value) } }),
          React.createElement('select', { value: f.group === 'non_goods' ? 'non_goods' : 'goods', 'aria-label': '分组', onChange: function(ev) { patchField(i, 'group', ev.target.value) } },
            React.createElement('option', { value: 'goods' }, '货描'),
            React.createElement('option', { value: 'non_goods' }, '非货描')),
          React.createElement('button', { className: 'atf-pill', title: '移除该字段', onClick: function() { removeField(i) } }, '×'))
      }
      var groupSection = function(group, label) {
        var rows = []
        if (active !== null) {
          for (var gi = 0; gi < active.fields.length; gi++) {
            if ((active.fields[gi].group || 'goods') === group) rows.push(fieldRow(active.fields[gi], gi))
          }
        }
        return React.createElement('div', { key: group, className: 'atf-joint-group', 'data-joint-group': group },
          React.createElement('div', { className: 'atf-joint-group-head' },
            React.createElement('b', null, label),
            React.createElement('span', { className: 'atf-viewer-empty' }, String(rows.length) + ' 个字段')),
          rows.length > 0 ? rows : React.createElement('div', { className: 'atf-viewer-empty' }, '（本组暂无字段——＋加字段或导入）'))
      }
      var errView = null
      if (draft.error !== null && draft.error !== undefined) {
        var errLines = []
        if (draft.error.fatal) errLines.push(draft.error.fatal)
        if (draft.error.issues) {
          for (var ei = 0; ei < draft.error.issues.length; ei++) errLines.push(draft.error.issues[ei].message)
        }
        errView = React.createElement('div', {
          className: 'atf-joint-err', role: 'alert',
          style: { color: 'var(--dsw-static-red-500)', marginTop: 8, whiteSpace: 'pre-wrap' },
        }, errLines.join('\n'))
      }
      return React.createElement('div', {
        className: 'atf-viewer-overlay',
        onClick: function(e) { if (e.target === e.currentTarget) { store.setJoint(null); setDraft(null) } },
      },
        React.createElement('div', { className: 'atf-viewer-frame atf-train-frame atf-joint-frame' },
          React.createElement('div', { className: 'atf-viewer-head' },
            React.createElement('b', null, '联合训练（多类字段选择）'),
            React.createElement('span', { className: 'atf-viewer-empty' }, '每类字段独立——不做跨类字段并集'),
            React.createElement('button', { className: 'atf-pill', title: '关闭', onClick: function() { store.setJoint(null); setDraft(null) } }, '×')),
          React.createElement('div', { className: 'atf-train-body' },
            React.createElement('div', { className: 'atf-joint-target' },
              React.createElement('label', null, '落点实验：',
                React.createElement('select', { 'data-joint-target': '1', value: draft.targetRunId, onChange: function(e) { patch({ targetRunId: e.target.value }) } },
                  React.createElement('option', { value: '' }, '（选择落点实验）'),
                  runsOptions)),
              React.createElement('label', null, 'seed：',
                React.createElement('input', { style: { width: 72 }, value: draft.seed, placeholder: '0', onChange: function(e) { patch({ seed: e.target.value }) } })),
              React.createElement('label', null, '倍率（可选）：',
                React.createElement('input', { style: { width: 170 }, value: draft.oversampleText, placeholder: '{"pl":1,"swb":2}——省略全 1', onChange: function(e) { patch({ oversampleText: e.target.value }) } }))),
            React.createElement('div', { className: 'atf-joint-tabs' },
              tabs,
              React.createElement('button', { className: 'atf-pill', 'data-joint-add-class': '1', onClick: addClass }, '＋加一类'),
              draft.classes.length > 0
                ? React.createElement('button', { className: 'atf-pill', title: '移除当前类', onClick: function() { removeClass(draft.activeTab) } }, '－移除本类')
                : null),
            active !== null
              ? React.createElement('div', { className: 'atf-joint-class' },
                  React.createElement('div', { className: 'atf-joint-class-head' },
                    React.createElement('input', { 'data-joint-doctype': '1', placeholder: '单据类型（如 pl）', value: active.doc_type, onChange: function(e) { patchClass(draft.activeTab, { doc_type: e.target.value }) } }),
                    React.createElement('select', { 'data-joint-runid': '1', value: active.run_id, onChange: function(e) { patchClass(draft.activeTab, { run_id: e.target.value }) } },
                      React.createElement('option', { value: '' }, '（选择该类数据所在实验）'),
                      runsOptions),
                    React.createElement('input', { 'data-joint-doczh': '1', placeholder: '单据中文名（如 装箱单）', value: active.document_zh, onChange: function(e) { patchClass(draft.activeTab, { document_zh: e.target.value }) } }),
                    React.createElement('button', { className: 'atf-pill', 'data-joint-select-all': '1', onClick: function() { selectAll(true) } }, '全选'),
                    React.createElement('button', { className: 'atf-pill', 'data-joint-invert': '1', onClick: invertSelection }, '反选'),
                    React.createElement('button', { className: 'atf-pill', 'data-joint-add-field': '1', onClick: function() { addField('goods') } }, '＋加字段')),
                  groupSection('goods', '货描字段（goods）'),
                  groupSection('non_goods', '非货描字段（non_goods）'),
                  React.createElement('div', { className: 'atf-joint-import' },
                    React.createElement('div', { className: 'atf-viewer-empty' }, '导入字段规格（当前类）——粘贴 FieldSpec/field-config JSON，或选择本地文件'),
                    React.createElement('textarea', {
                      className: 'atf-joint-import-text', rows: 3,
                      placeholder: '{"schema_version":"FieldSpec/v1","document_zh":"装箱单","fields":[{"field_id":"goods_description","zh":"货描","group":"goods","definition":"..."}]}',
                      value: draft.importText,
                      onChange: function(e) { patch({ importText: e.target.value }) },
                    }),
                    React.createElement('div', { className: 'atf-joint-import-actions' },
                      React.createElement('button', { className: 'atf-pill', 'data-joint-import': '1', onClick: function() { doImport() } }, '导入'),
                      React.createElement('input', { type: 'file', accept: '.json,application/json', 'data-joint-import-file': '1', onChange: onFile }))))
              : React.createElement('div', { className: 'atf-viewer-empty' }, '还没有类型——先「＋加一类」'),
            errView,
            React.createElement('div', { className: 'atf-train-actions' },
              React.createElement('button', { className: 'atf-pill atf-train-send', 'data-joint-generate': '1', onClick: generate }, '生成发起消息（进 chat 正道链→确认卡）'),
              React.createElement('span', { className: 'atf-viewer-empty' }, '字段缺失或说明缺失会在这里红字拦下——不会出确认卡')))))
    }

    // ── D11-2 运行监控面板（原生右栏 tab body——按 UI 稿 v2 逐区块，区块序不得调整）──
    // 顶部条（run/状态/进度/ETA/数据陈旧角标）→ 八段 stepper（禁 unknown，pending 指因）
    // → KPI×4（步进/Loss/指标 F1/显存）→ Loss 曲线（等距刻度＋网格＋图例＋hover＋原始/平滑）
    // → GPU 4×2（展开→2 列＋util/VRAM 双 sparkline＋进程 top1）→ 训练产物（run-file 打开）
    // → 训练日志（尾 40 行）。数据源＝monitor.json（5s 拍/SSE）＋/atf-ui/gpu-history；
    // SVG 自绘零图表库；空态显式说明不造数据。
    var GPU_HISTORY_POINTS = 60

    function useGpuHistory(enabled) {
      var _s = React.useState(null)
      var points = _s[0], setPoints = _s[1]
      React.useEffect(function() {
        if (!enabled) return
        var alive = true
        var read = function() {
          fetch('/atf-ui/gpu-history?minutes=5&maxPoints=' + GPU_HISTORY_POINTS, { credentials: 'same-origin', cache: 'no-store' })
            .then(function(r) { return r.ok ? r.json() : null })
            .then(function(d) { if (alive && d !== null && d !== undefined) setPoints(Array.isArray(d.points) ? d.points : []) })
            .catch(function() { /* 下周期重取 */ })
        }
        read()
        var t = setInterval(read, POLL_MS)
        return function() { alive = false; clearInterval(t) }
      }, [enabled])
      return points
    }

    /** 秒级心跳（数据陈旧角标的 now 面——仅驱动重渲，不改数据）。 */
    function useTickSecond() {
      var _s = React.useState(0)
      var tick = _s[0], setTick = _s[1]
      React.useEffect(function() {
        var t = setInterval(function() { setTick(function(n) { return n + 1 }) }, 1000)
        return function() { clearInterval(t) }
      }, [])
      return tick
    }

    var numOfToken = function(token) {
      if (typeof token !== 'string') return null
      var n = parseFloat(token)
      return Number.isFinite(n) ? n : null
    }
    var mibToG = function(mib) { return typeof mib === 'number' && Number.isFinite(mib) ? (mib / 1024).toFixed(0) + 'G' : null }
    var fmtEta = function(sec) {
      if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return null
      var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = Math.floor(sec % 60)
      var pad2 = function(n2) { return String(n2).padStart(2, '0') }
      return (h > 0 ? h + ':' : '') + pad2(m) + ':' + pad2(s2)
    }
    /** 居中滑动平均（窗口 5，端点用可用半窗——只改渲染不改数据）。 */
    function smoothSeries(values) {
      var out = []
      for (var i = 0; i < values.length; i++) {
        var sum = 0, n = 0
        for (var j = Math.max(0, i - 2); j <= Math.min(values.length - 1, i + 2); j++) { sum += values[j]; n++ }
        out.push(sum / n)
      }
      return out
    }

    /** Loss 曲线（SVG 自绘）：等距 Y 刻度＋网格线＋图例＋hover（竖线＋圆点＋读数）＋
     *  原始/平滑切换；空态骨架「等待首个 loss 点」不画假线。 */
    function LossChart(props) {
      var run = props.run
      var modeState = React.useState('raw')
      var mode = modeState[0], setMode = modeState[1]
      var hoverState = React.useState(null)
      var hover = hoverState[0], setHover = hoverState[1]
      var points = (run && run.training && run.training.points) || []
      var train = []
      var evals = []
      for (var i = 0; i < points.length; i++) {
        var p = points[i] || {}
        if (typeof p.step === 'number' && typeof p.train_loss === 'number') train.push({ step: p.step, loss: p.train_loss })
        if (typeof p.step === 'number' && typeof p.eval_loss === 'number') evals.push({ step: p.step, loss: p.eval_loss })
      }
      var W = 420, H = 150, L = 34, R = 408, T = 10, B = 118
      var head = React.createElement('div', { className: 'atf-loss-head' },
        React.createElement('span', { className: 'atf-sec-t' }, 'Loss 曲线'),
        React.createElement('span', { className: 'atf-loss-toggle' },
          React.createElement('button', { 'data-mode': 'raw', className: mode === 'raw' ? 'on' : undefined, onClick: function() { setMode('raw') } }, '原始'),
          React.createElement('button', { 'data-mode': 'smooth', className: mode === 'smooth' ? 'on' : undefined, onClick: function() { setMode('smooth') } }, '平滑')))
      if (train.length === 0) {
        return React.createElement('div', { className: 'atf-m-sec' }, head,
          React.createElement('div', { className: 'atf-loss-skeleton' },
            React.createElement('div', { className: 'atf-loss-skel-bar' }),
            React.createElement('span', { className: 'atf-loss-skel-text' }, '等待首个 loss 点')))
      }
      var xs = train.map(function(d) { return d.step })
      var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs)
      var yVals = train.map(function(d) { return d.loss }).concat(evals.map(function(d) { return d.loss }))
      var yMin = Math.min.apply(null, yVals), yMax = Math.max.apply(null, yVals)
      if (xMax === xMin) xMax = xMin + 1
      if (yMax - yMin < 1e-9) { var mid = (yMax + yMin) / 2 || 0.1; yMin = mid - Math.abs(mid) * 0.1 - 1e-6; yMax = mid + Math.abs(mid) * 0.1 + 1e-6 }
      var pad = (yMax - yMin) * 0.06
      yMin -= pad; yMax += pad
      var sx = function(step) { return L + ((step - xMin) / (xMax - xMin)) * (R - L) }
      var sy = function(loss) { return B - ((loss - yMin) / (yMax - yMin)) * (B - T) }
      var range = yMax - yMin
      var yDec = range >= 1 ? 1 : range >= 0.1 ? 2 : range >= 0.01 ? 3 : 4
      var yTicks = []
      for (var k = 0; k < 4; k++) yTicks.push(yMax - (k * range) / 3)
      var xTicks = []
      for (var k2 = 0; k2 < 5; k2++) xTicks.push(Math.round(xMin + (k2 * (xMax - xMin)) / 4))
      var trainVals = train.map(function(d) { return d.loss })
      var trainDraw = mode === 'smooth' ? smoothSeries(trainVals) : trainVals
      var trainSteps = train.map(function(d) { return d.step })
      var evalVals = evals.map(function(d) { return d.loss })
      var evalDraw = evals.length >= 2 ? (mode === 'smooth' ? smoothSeries(evalVals) : evalVals) : null
      var evalSteps = evals.map(function(d) { return d.step })
      var polyOf = function(vals, steps) {
        return vals.map(function(v, i2) { return sx(steps[i2]).toFixed(1) + ',' + sy(v).toFixed(1) }).join(' ')
      }
      var onMove = function(e) {
        var rect = e.currentTarget.getBoundingClientRect()
        if (rect.width <= 0) return
        var vx = ((e.clientX - rect.left) / rect.width) * W
        var best = 0
        for (var i3 = 1; i3 < train.length; i3++) {
          if (Math.abs(sx(trainSteps[i3]) - vx) < Math.abs(sx(trainSteps[best]) - vx)) best = i3
        }
        setHover(best)
      }
      var yGrid = [T, T + ((B - T) / 3), T + ((2 * (B - T)) / 3)].map(function(y, i4) {
        return React.createElement('line', { key: 'gy' + i4, x1: L, y1: y, x2: R, y2: y, stroke: 'var(--atf-grid-line)' })
      })
      var yLabels = yTicks.map(function(v, i5) {
        return React.createElement('text', { key: 'yl' + i5, x: L - 5, y: sy(v) + 3, textAnchor: 'end', className: 'atf-chart-tick' }, v.toFixed(yDec))
      })
      var xLabels = xTicks.map(function(v, i6) {
        return React.createElement('text', { key: 'xl' + i6, x: sx(v), y: B + 12, textAnchor: 'middle', className: 'atf-chart-tick' }, String(v))
      })
      var h = hover !== null && hover !== undefined && train[hover] ? train[hover] : null
      return React.createElement('div', { className: 'atf-m-sec' }, head,
        React.createElement('svg', {
          className: 'atf-loss-chart', viewBox: '0 0 ' + W + ' ' + H,
          onMouseMove: onMove, onMouseLeave: function() { setHover(null) },
        },
          React.createElement('g', null,
            React.createElement('line', { x1: L, y1: T, x2: L, y2: B, stroke: 'var(--atf-grid-axis)' }),
            React.createElement('line', { x1: L, y1: B, x2: R, y2: B, stroke: 'var(--atf-grid-axis)' }),
            yGrid, yLabels, xLabels,
            React.createElement('polyline', { points: polyOf(trainDraw, trainSteps), fill: 'none', stroke: 'var(--atf-spark-util)', strokeWidth: 1.8, strokeLinecap: 'round' }),
            evalDraw !== null ? React.createElement('polyline', { points: polyOf(evalDraw, evalSteps), fill: 'none', stroke: 'var(--atf-spark-mem)', strokeWidth: 1.5, strokeDasharray: '4 3' }) : null,
            h !== null ? React.createElement('line', { x1: sx(h.step), y1: T, x2: sx(h.step), y2: B, stroke: 'var(--atf-spark-mem)', strokeDasharray: '3 3' }) : null,
            h !== null ? React.createElement('circle', { cx: sx(h.step), cy: sy(h.loss), r: 3, fill: 'var(--atf-grid-axis)', stroke: 'var(--atf-spark-util)', strokeWidth: 1.6 }) : null,
            h !== null ? React.createElement('text', { x: Math.min(sx(h.step) + 6, R - 90), y: T + 10, className: 'atf-chart-hover' }, 'step ' + h.step + ' · loss ' + h.loss.toFixed(3)) : null)),
        React.createElement('div', { className: 'atf-loss-legend' },
          React.createElement('span', null, React.createElement('i', { className: 'atf-lg-train' }), 'train'),
          evals.length >= 2 ? React.createElement('span', null, React.createElement('i', { className: 'atf-lg-eval' }), 'eval') : null))
    }

    /** sparkline（宽随卡片高 22px；点 <2 不画——无历史不画平线）。 */
    /** 迷你趋势线：可选固定域 props.domain=[min,max]（D11-2a——util/VRAM 共享 0–100 域，
     *  恒值/不同尺度序列两线可分）；未给维持序列自身 min/max 现状。y clamp [2,20]。 */
    function Sparkline(props) {
      var values = props.values
      if (!Array.isArray(values) || values.length < 2) return null
      var min, max
      if (Array.isArray(props.domain) && props.domain.length === 2
        && typeof props.domain[0] === 'number' && typeof props.domain[1] === 'number') {
        min = props.domain[0]
        max = props.domain[1]
      } else {
        min = Math.min.apply(null, values)
        max = Math.max.apply(null, values)
      }
      var range = max - min || 1
      var pts = values.map(function(v, i) {
        var y = 20 - ((v - min) / range) * 18
        if (y < 2) y = 2
        if (y > 20) y = 20
        return ((i / (values.length - 1)) * 100).toFixed(1) + ',' + y.toFixed(1)
      }).join(' ')
      return React.createElement('svg', { className: 'atf-spark-svg', viewBox: '0 0 100 22', preserveAspectRatio: 'none' },
        React.createElement('polyline', { points: pts, fill: 'none', stroke: props.color, strokeWidth: 1.4 }))
    }

    /** GPU 单卡瓦片：编号＋util 条＋VRAM 条＋温度/功耗小字；展开追加双 sparkline＋进程 top1。 */
    function GpuTile(props) {
      var card = props.card
      var util = numOfToken(card.utilization)
      var memUsed = numOfToken(card.memoryUsed)
      var memTotal = numOfToken(card.memoryTotal)
      var memPct = memUsed !== null && memTotal !== null && memTotal > 0 ? Math.min(100, (memUsed / memTotal) * 100) : 0
      var busy = util !== null && util > 0
      var series = props.series || null
      var utilVals = series === null ? null : series.map(function(g) { return (g && typeof g.util === 'number') ? g.util : null }).filter(function(v) { return v !== null })
      // D11-2a：VRAM 转百分比序列（memUsed/memTotal*100；total≤0 的采样点丢弃不画）——与 util 共享 0–100 域
      var memPctVals = series === null ? null : series.map(function(g) {
        if (!g || typeof g.memUsed !== 'number' || typeof g.memTotal !== 'number' || g.memTotal <= 0) return null
        return Math.min(100, (g.memUsed / g.memTotal) * 100)
      }).filter(function(v) { return v !== null })
      var proc = series !== null && series.length > 0 ? (series[series.length - 1].procTop || null) : (props.procTop || null)
      return React.createElement('div', { className: 'atf-gpu-tile' + (busy ? ' busy' : '') },
        React.createElement('div', { className: 'atf-gpu-h' },
          React.createElement('span', null, String(card.index)),
          React.createElement('span', { className: 'atf-gpu-pct' }, util === null ? '—' : Math.round(util) + '%')),
        React.createElement('div', { className: 'atf-gpu-bar' }, React.createElement('i', { style: { width: (util === null ? 0 : Math.min(100, util)) + '%' } })),
        React.createElement('div', { className: 'atf-gpu-bar mem' }, React.createElement('i', { style: { width: memPct.toFixed(1) + '%' } })),
        React.createElement('div', { className: 'atf-gpu-meta' },
          React.createElement('span', null, (memUsed === null ? '—' : mibToG(memUsed) || '—') + '/' + (memTotal === null ? '—' : mibToG(memTotal) || '—')),
          React.createElement('span', null, (typeof card.temperature === 'number' ? Math.round(card.temperature) + '°' : '—') + ' ' + (typeof card.powerDraw === 'number' ? Math.round(card.powerDraw) + 'W' : '—'))),
        props.expanded ? React.createElement('div', { className: 'atf-gpu-spark' },
          utilVals !== null && utilVals.length >= 2
            ? React.createElement(Sparkline, { values: utilVals, domain: [0, 100], color: 'var(--atf-spark-util)' })
            : React.createElement('div', { className: 'atf-gpu-nohist' }, '暂无历史'),
          memPctVals !== null && memPctVals.length >= 2
            ? React.createElement(Sparkline, { values: memPctVals, domain: [0, 100], color: 'var(--atf-spark-mem)' })
            : null,
          React.createElement('div', { className: 'atf-gpu-proc' },
            '进程：', proc !== null ? proc.name + ' · ' + (mibToG(proc.memMiB) || '—') + ' · pid ' + proc.pid : '—')) : null)
    }

    /** 右栏训练监控面板（D11-2 重写——UI 稿 v2 逐区块；数据源 monitor.json 5s 拍/SSE）。 */
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
      var tick = useTickSecond()
      var expandState = React.useState(false)
      var expanded = expandState[0], setExpanded = expandState[1]
      var history = useGpuHistory(expanded)
      // 批㞢H：两轮评估对比选择态（hooks 前置；null＝缺省取末两轮）
      var cmpAState = React.useState(null)
      var cmpA = cmpAState[0], setCmpA = cmpAState[1]
      var cmpBState = React.useState(null)
      var cmpB = cmpBState[0], setCmpB = cmpBState[1]
      // 批㊶-N N-5 作用域沿用：缺省本会话绑定 ∪ 同工作区桶，「全部」显式切换＝全量。
      // 批B2 §四：showAll 升 store 单源（面板「查看全部」/空态「查看全部实验」同源驱动）。
      var showAll = React.useSyncExternalStore(
        function(fn) { return store.subscribe(fn) },
        function() { return store.monitorShowAll },
      )
      // 批B2 §一：绑定 store（监控默认跟随绑定——active 即选中，不再取 runs[0]）
      var b = useBinding()
      var narrowState = React.useState(false)
      var narrow = narrowState[0], setNarrow = narrowState[1]
      var roMsgState = React.useState(null)
      var roMsg = roMsgState[0], setRoMsg = roMsgState[1]
      var rootRef = React.useRef(null)
      var logRef = React.useRef(null)
      var logPausedRef = React.useRef(false)
      React.useEffect(function() {
        var el = rootRef.current
        if (el === null || el === undefined) return
        var update = function() {
          var w = el.clientWidth
          if (w > 0) setNarrow(w < 420)
        }
        update()
        var ro = 'ResizeObserver' in window ? new ResizeObserver(update) : null
        if (ro !== null) ro.observe(el)
        return function() { if (ro !== null) ro.disconnect() }
      }, [mon === null || mon === undefined])
      // 日志自动滚底（悬停暂停——ref 面板关/未渲染时守卫）
      React.useEffect(function() {
        var el = logRef.current
        if (el !== null && el !== undefined && !logPausedRef.current) el.scrollTop = el.scrollHeight
      })
      if (!open) return React.createElement('div', { className: 'atf-monitor-panel', style: { padding: '20px 12px', height: '100%', overflow: 'auto' } },
        React.createElement('div', { className: 'atf-monitor-empty' }, '监控已关闭——点顶栏「监控」按钮重新打开'))
      // 首次加载骨架屏（不闪空白）
      if (mon === null || mon === undefined) {
        return React.createElement('div', { className: 'atf-monitor-panel atf-m-loading', ref: rootRef },
          React.createElement('div', { className: 'atf-m-skel atf-m-skel-title' }),
          React.createElement('div', { className: 'atf-m-skel atf-m-skel-row' }),
          React.createElement('div', { className: 'atf-m-skel atf-m-skel-block' }),
          React.createElement('div', { className: 'atf-m-skel-hint' }, '监控快照就绪中…'))
      }
      var allRuns = (mon.runs) || []
      var runs = showAll ? allRuns : scopedRuns(mon, store.sessionId)
      // 批B2 §四.1：默认跟随绑定——active 在场即选中（不再取 runs[0]）；用户显式预览
      // （选择器/全部组）优先。绑定 store 未就绪（loading/error）或端点无未绑定指因
      // （active=null 且 reason=null——非明确未绑定态）时保留旧回退（存量浏览语义不断）。
      var previewId = selRunId && allRuns.some(function(r) { return r.run_id === selRunId }) ? selRunId : null
      var followId = (b.status === 'ready' && b.active !== null && b.active.run_id) ? b.active.run_id : null
      var followVisible = followId !== null && allRuns.some(function(r) { return r.run_id === followId })
      var unboundState = b.status === 'ready' && b.active === null
        && (b.unbound_reason === 'new' || b.unbound_reason === 'cleared' || b.unbound_reason === 'stale')
      var runId
      if (previewId !== null) runId = previewId
      else if (followVisible) runId = followId
      else if (unboundState) runId = null
      else if (b.status === 'ready' && followId !== null && !followVisible) runId = null // 绑定 run 监控缺席——实验不可见态
      else runId = (runs[0] ? runs[0].run_id : null) // 绑定面未就绪（loading/error/无指因）——旧回退
      var run = runId ? allRuns.find(function(r) { return r.run_id === runId }) || null : null
      // 数据陈旧角标（generated_at 超 30s；保留最后快照不清屏）
      var staleSec = null
      var genTs = Date.parse(mon.generated_at)
      if (Number.isFinite(genTs)) {
        var ageSec = Math.floor((Date.now() - genTs) / 1000)
        if (ageSec > 30) staleSec = ageSec
      }
      // 顶部条状态（训练中/空闲/异常＋进度＋ETA）——批B2 §四.5：runStatusOf 单源（与顶栏
      // chip 同一推导，禁两套；progress/trainingNow 供 KPI/产物区复用）
      var st = runStatusOf(run)
      var progress = st.progress
      var segFailed = st.failed
      var trainingNow = st.trainingNow
      var statusText = st.text
      var statusClass = st.cls
      var pct = st.pct
      var eta = st.eta
      // KPI 面（步进/Loss/指标 F1/显存；缺失 —，不造数）
      var pts = (run && run.training && run.training.points) || []
      var lastLoss = null
      for (var i = pts.length - 1; i >= 0; i--) {
        if (pts[i] && typeof pts[i].train_loss === 'number') { lastLoss = pts[i].train_loss; break }
      }
      var kpiLoss = progress && typeof progress.loss === 'number' ? progress.loss.toFixed(3) : (lastLoss !== null ? lastLoss.toFixed(3) : null)
      var kpiStep = progress && typeof progress.round === 'number'
        ? { v: String(progress.round), sub: typeof progress.total_rounds === 'number' ? '/' + progress.total_rounds : null }
        : null
      var metrics = (run && run.metrics) || null
      var kpiF1 = metrics && typeof metrics.f1 === 'number' ? metrics.f1.toFixed(3) : null
      var gpuAll = Array.isArray(mon.gpu_all) ? mon.gpu_all : []
      var sumUsed = 0, sumTotal = 0, busyCount = 0
      for (var gi = 0; gi < gpuAll.length; gi++) {
        var gc = gpuAll[gi]
        var u = numOfToken(gc.memoryUsed), t2 = numOfToken(gc.memoryTotal)
        if (u !== null) sumUsed += u
        if (t2 !== null) sumTotal += t2
        var uu = numOfToken(gc.utilization)
        if (uu !== null && uu > 0) busyCount++
      }
      var kpiVram = gpuAll.length > 0 && sumTotal > 0 ? mibToG(sumUsed) + '/' + mibToG(sumTotal) : null
      var bindingDevices = run && run.gpu_binding && typeof run.gpu_binding.devices === 'string' ? run.gpu_binding.devices : null
      // 历史序列按卡取（util/VRAM 双 sparkline＋进程 top1 最新点）
      var seriesByIndex = {}
      var lastProcByIndex = {}
      if (expanded && Array.isArray(history)) {
        for (var hi = 0; hi < history.length; hi++) {
          var hrow = history[hi]
          var hcards = Array.isArray(hrow.gpus) ? hrow.gpus : []
          for (var ci = 0; ci < hcards.length; ci++) {
            var hc = hcards[ci]
            var key = String(hc.index)
            seriesByIndex[key] = seriesByIndex[key] || []
            seriesByIndex[key].push(hc)
            if (hc.procTop !== null && hc.procTop !== undefined) lastProcByIndex[key] = hc.procTop
          }
        }
      }
      // 训练产物行（数据源＝artifacts.json＋monitor ckpts 投影；不新增扫描器）
      var artRows = []
      if (run) {
        var ckpts = Array.isArray(run.ckpts) ? run.ckpts : []
        for (var ki = 0; ki < ckpts.length && ki < 5; ki++) {
          artRows.push({ ico: 'CK', name: ckpts[ki], meta: '检查点元数据', rel: 'training/' + ckpts[ki] + '/trainer_state.json' })
        }
        var splitDone = (run.segments || []).some(function(s) { return s.key === 'split' && s.status === 'done' })
        if (splitDone) artRows.push({ ico: 'SP', name: 'split-manifest.json', meta: '数据切分', rel: 'dataset/split-manifest.json' })
        if (progress !== null || trainingNow) artRows.push({ ico: 'TR', name: 'trainer_log.jsonl', meta: '训练日志（全量）', rel: 'training/trainer_log.jsonl' })
        if (metrics && metrics.round !== undefined && metrics.f1 !== null && metrics.f1 !== undefined) {
          var evalRel = metrics.round === 'latest' ? 'eval/metrics_summary.json' : 'eval/' + metrics.round + '/orch/eval/metrics_summary.json'
          artRows.push({ ico: 'EV', name: '评估报告（上一轮）', meta: 'F1 ' + metrics.f1.toFixed(3), rel: evalRel })
        }
        var artRun = arts && arts.runs ? arts.runs.find(function(r) { return r.run_id === runId }) : null
        var generic = (artRun && artRun.artifacts) || []
        var marker = '/' + runId + '/'
        for (var ai = 0; ai < generic.length; ai++) {
          var arow = generic[ai]
          var ext = (String(arow.path).split('.').pop() || '').toLowerCase()
          // html（badcase viewer）不经 run-file——相对资源断裂，走既有 viewer 浮层通道
          if (ext === 'html' || !['json', 'jsonl', 'md', 'txt', 'csv', 'log', 'yaml', 'yml'].some(function(x) { return x === ext })) continue
          if (metrics && metrics.round !== undefined && arow.path.indexOf('/eval/' + metrics.round + '/') >= 0 && ext === 'json') continue
          var at = String(arow.path).indexOf(marker)
          if (at < 0) continue  // 路径不含该 run（跨 run 引用）——不猜不硬拆
          artRows.push({ ico: '··', name: arow.name, meta: '产物', rel: String(arow.path).slice(at + marker.length) })
        }
      }
      var openArtifact = function(row) {
        var url = '/atf-ui/run-file?runId=' + encodeURIComponent(runId || '') + '&rel=' + encodeURIComponent(row.rel)
        try {
          if (sidebarFace && typeof sidebarFace.openResource === 'function') {
            sidebarFace.openResource(url)  // 未命中任何注册 kind 时 vendor 抛错——落新标签回退
            return
          }
        } catch (e) { /* 回退新标签 */ }
        window.open(url, '_blank', 'noopener')
      }
      var tail = run && run.trainlog_tail
      var tailLines = tail !== null && tail !== undefined && Array.isArray(tail.lines) ? tail.lines.slice(-40) : []
      var tailRel = tail && typeof tail.captured_at === 'string' ? fmtRelTime(tail.captured_at) : ''
      var gpuHeadBits = []
      gpuHeadBits.push('忙 ' + busyCount + '/' + gpuAll.length)
      if (sumTotal > 0) gpuHeadBits.push((mibToG(sumUsed) || '—') + '/' + (mibToG(sumTotal) || '—'))
      if (bindingDevices !== null) gpuHeadBits.push('绑 ' + bindingDevices)
      var bridge = (typeof window !== 'undefined' && window.__ATF_UI_CONFIG__ && window.__ATF_UI_CONFIG__.bridge) || null
      // 批B2 §四.4：未绑定空态装载（unbound_reason ∈ new|cleared|stale——不渲染 KPI/Loss/
      // GPU 细卡/产物/日志假数据，只显示空态＋机器 GPU 一行只读）。
      var lastInfo = lastRunInfo(b, mon)
      var emptyHeadline = b.unbound_reason === 'stale' ? '原实验已不可见（可能归档/删除）'
        : b.unbound_reason === 'cleared' ? '已解除绑定'
        : '未选择实验'
      var emptyBind = function(runId) {
        return function() { void binding.bindRun(runId).then(function(out) { if (!(out && out.status === 200)) setRoMsg('绑定失败——请稍后重试') }) }
      }
      var emptyState = React.createElement('div', { className: 'atf-m-empty' },
        React.createElement('div', { className: 'atf-m-empty-t' }, emptyHeadline),
        lastInfo !== null
          ? React.createElement('div', { className: 'atf-m-empty-last' },
              React.createElement('button', {
                className: 'atf-pill', title: '绑定上次使用的实验（跨会话）',
                onClick: emptyBind(lastInfo.runId),
              }, '继续上次：' + (lastInfo.title !== null ? lastInfo.title + (lastInfo.ws ? '（' + lastInfo.ws + '）' : '') : '实验 ' + String(lastInfo.runId).slice(-6))),
              b.unbound_reason === 'cleared' && b.binding && Array.isArray(b.binding.history) && b.binding.history.length > 0
                ? React.createElement('button', {
                    className: 'atf-pill', title: '撤销解除——回到上一个实验',
                    onClick: function() { void binding.undoUnbind().then(function(out) { if (!(out && out.status === 200)) setRoMsg('撤销失败——请稍后重试') }) },
                  }, '撤销解除')
                : null)
          : null,
        (b.recent || []).length > 0
          ? React.createElement('div', { className: 'atf-m-empty-sec' },
              React.createElement('div', { className: 'atf-m-empty-h' }, '最近实验'),
              b.recent.map(function(item, ri) {
                var mrun = findRunById(mon, item.run_id)
                var rst = mrun !== null ? runStatusOf(mrun) : null
                return React.createElement('button', {
                  key: item.run_id + '/' + ri, className: 'atf-m-empty-row', 'data-bp-row': '1',
                  title: '绑定该实验',
                  onClick: function() { void binding.bindRun(item.run_id).then(function(out) { if (!(out && out.status === 200)) setRoMsg('绑定失败——请稍后重试') }) },
                },
                  React.createElement('span', { className: 'atf-m-empty-tt' }, item.title || displayTitleOf({ run_id: item.run_id })),
                  React.createElement('span', { className: 'atf-m-empty-ws' }, item.workspace || ''),
                  rst !== null ? React.createElement('span', { className: 'atf-m-empty-st' + rst.cls }, rst.label) : null)
              }))
          : null,
        React.createElement('div', { className: 'atf-m-empty-actions' },
          React.createElement('button', {
            className: 'atf-pill', onClick: function() { store.setTrain({ runId: null, mode: 'dry_run' }) },
          }, '新建实验'),
          React.createElement('button', {
            className: 'atf-pill', title: '只读浏览全部实验（不改变绑定）',
            onClick: function() { store.setMonitorShowAll(true); store.setMonitor(true, null) },
          }, '查看全部实验（只读）')),
        React.createElement('div', { className: 'atf-m-empty-gpu' },
          gpuAll.length > 0
            ? '机器 GPU：' + gpuAll.length + ' 卡 · 忙 ' + busyCount + '（只读，机器级）'
            : '机器 GPU：状态不可用（只读，机器级）'),
        roMsg !== null ? React.createElement('div', { className: 'atf-m-empty-msg' }, roMsg) : null)
      return React.createElement('div', { className: 'atf-monitor-panel atf-m-root' + (narrow ? ' atf-m-narrow' : ''), ref: rootRef },
        // ① 顶部条
        React.createElement('div', { className: 'atf-m-head' },
          React.createElement('div', null,
            React.createElement('div', { className: 'atf-m-title' }, '运行监控'),
            run !== null
              ? React.createElement('div', { className: 'atf-m-run', title: (run.workspace ? run.workspace + ' · ' : '') + run.run_id },
                  displayTitleOf(run),
                  React.createElement('span', { className: 'atf-m-runmeta' }, (run.workspace ? run.workspace + ' · ' : '') + run.run_id))
              : null,
            React.createElement('div', { className: 'atf-m-status' + statusClass },
              React.createElement('span', { className: 'atf-m-dot' }),
              React.createElement('span', null, run === null ? '未关联训练' : statusText + (pct !== null ? ' · ' + pct + '%' : '')),
              eta !== null ? React.createElement('span', { className: 'atf-m-eta' }, ' · 剩 ' + eta) : null,
              staleSec !== null ? React.createElement('span', { className: 'atf-m-stale', title: '数据更新暂停——保留最后快照' }, '数据陈旧 ' + staleSec + 's') : null)),
          React.createElement('div', { className: 'atf-m-runbox' },
            // 批B2 §四.2：紧凑入口（显示 title＋状态，开共用选择面板）；原生 select 作窄宽降级
            narrow
              ? React.createElement('select', {
                  className: 'atf-viewer-select', value: runId || '', title: '选择 run',
                  onChange: function(e) { store.setMonitor(true, e.target.value) },
                },
                  runs.length === 0
                    ? React.createElement('option', { value: '' }, '（无 run）')
                    : runs.map(function(r) { return React.createElement('option', { key: r.run_id, value: r.run_id }, r.run_id) }))
              : React.createElement('button', {
                  className: 'atf-effort-trigger', title: '选择实验（与顶栏同一个面板）',
                  onClick: function() { store.setBindingPanel(true) },
                },
                  run !== null ? displayTitleOf(run) + ' · ' + statusText : '选择实验',
                  React.createElement('span', { className: 'atf-effort-caret' }, ' ▾')),
            React.createElement('button', {
              className: 'atf-pill' + (showAll ? ' atf-pill-on' : ''),
              style: showAll ? { borderColor: 'var(--dsw-alias-brand-primary,#1d4ed8)', color: 'var(--dsw-alias-brand-primary,#1d4ed8)', fontWeight: 600 } : undefined,
              title: showAll ? '全部实例（开——显示全量 run）' : '全部实例（关——只列本会话绑定 run）',
              onClick: function() { store.setMonitorShowAll(!showAll) },
            }, '全部'))),
        // 批B2 §四.3：全部模式横幅（只读视图——选择只改预览，设为当前才 POST）
        showAll
          ? React.createElement('div', { className: 'atf-m-ro' },
              React.createElement('span', { className: 'atf-m-ro-text' }, '全部实例（只读视图）——点选只预览，不改变本会话绑定'),
              previewId !== null
                ? React.createElement('button', {
                    className: 'atf-pill atf-m-ro-bind', title: '把预览中的实验设为本会话当前绑定',
                    onClick: function() {
                      void binding.bindRun(previewId).then(function(out) {
                        if (out && out.status === 200) { store.setMonitor(true, null); setRoMsg(null) } else { setRoMsg('绑定失败——请稍后重试') }
                      })
                    },
                  }, '设为当前')
                : null,
              roMsg !== null ? React.createElement('span', { className: 'atf-m-empty-msg' }, roMsg) : null)
          : null,
        run === null
          ? (unboundState
              ? emptyState
              : React.createElement('div', { className: 'atf-m-guide' },
                  b.status === 'ready' && followId !== null && !followVisible
                    ? '原实验已不可见（可能归档/删除）——可从选择面板改选其他实验或解除绑定。'
                    : '本视图暂无关联训练 run——在上方选择 run，或先发起一次训练。',
                  React.createElement('div', { className: 'atf-m-guide-meta' },
                    (gpuAll.length > 0 ? 'GPU ' + gpuAll.length + ' 卡在册 · ' : 'GPU 状态不可用 · ') + (bridge ? (bridge.mode === 'real' ? '内核 real' + (bridge.version ? '·' + bridge.version : '') : '内核 mock') : ''))))
          : React.createElement('div', null,
        // 探针通报行（批㊶-P P-2 保留：error 红/warn 琥珀＋重新发起预填；自动链通报无按钮）
        (function() {
          var probe = run.probe || null
          if (probe === null) return null
          var kind = probe.kind || 'probe'
          var isAutoNotice = kind === 'config_auto' || kind === 'train_auto' || kind === 'oom_fallback'
          var rowColor = probe.level === 'error' ? 'var(--dsw-static-red-500)' : probe.level === 'warn' ? 'var(--dsw-static-amber-500)' : 'var(--dsw-alias-brand-primary,#1d4ed8)'
          var reissue = (probe.reason.indexOf('out of memory') >= 0 || probe.reason.indexOf('OOM') >= 0)
            ? '重新发起训练（OOM 降档）：调用 atf_run_training 工具 action=start，train_sh 沿用原 launch/train.sh，batch 改 1、梯度累积翻倍（全局批量 256 不变）——请确认后执行。'
            : '重新发起训练：调用 atf_run_training 工具 action=start 沿用原参数——请确认后执行。'
          var chip = null
          if (kind === 'config_auto' || kind === 'train_auto') {
            chip = React.createElement('span', { className: 'atf-m-chip' }, '全自动训练')
          } else if (kind === 'oom_fallback') {
            chip = React.createElement('span', { className: 'atf-m-chip' }, 'OOM 降档重发')
          }
          return React.createElement('div', { className: 'atf-m-probe', style: { color: rowColor } },
            chip,
            React.createElement('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-all' } }, probe.reason + ' · ' + probe.since.slice(11, 19)),
            !isAutoNotice && React.createElement('button', {
              className: 'atf-pill', title: '在会话预填重发指令（含降档参数如适用）——点击后自行发送',
              onClick: function() {
                var input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]')
                if (input) { input.focus(); document.execCommand('insertText', false, reissue) }
              },
            }, '重新发起'))
        })(),
        // ② 八段 stepper 置顶（done/active/pending/failed；禁 unknown，pending 指因 tooltip）
        React.createElement('div', { className: 'atf-m-segments' },
          (run.segments || []).map(function(seg) {
            var cls = seg.status === 'done' ? ' done' : seg.status === 'active' ? ' active' : seg.status === 'failed' ? ' failed' : ''
            var tip = seg.status === 'done' ? '已完成' : seg.status === 'active' ? '进行中'
              : seg.status === 'failed' ? '失败/中断——可查看训练日志定位' : (run.state_reason === 'no_on_disk_evidence' ? '暂无在盘完成证据' : '等待完成')
            return React.createElement('div', { key: seg.key, className: 'atf-m-seg' + cls, title: seg.label + '：' + tip },
              React.createElement('span', { className: 'atf-m-seg-node' }),
              React.createElement('span', { className: 'atf-m-seg-lbl' }, seg.label))
          })),
        // ③ KPI ×4
        React.createElement('div', { className: 'atf-m-kpis' },
          React.createElement('div', { className: 'atf-m-kpi' }, React.createElement('div', { className: 'atf-m-k' }, '步进'),
            React.createElement('div', { className: 'atf-m-v' }, kpiStep === null ? '—' : kpiStep.v, kpiStep !== null && kpiStep.sub !== null ? React.createElement('small', null, kpiStep.sub) : null)),
          React.createElement('div', { className: 'atf-m-kpi' }, React.createElement('div', { className: 'atf-m-k' }, 'Loss'),
            React.createElement('div', { className: 'atf-m-v' }, kpiLoss === null ? '—' : kpiLoss)),
          React.createElement('div', { className: 'atf-m-kpi' }, React.createElement('div', { className: 'atf-m-k' }, '指标 F1'),
            React.createElement('div', { className: 'atf-m-v' }, kpiF1 === null ? '—' : kpiF1)),
          React.createElement('div', { className: 'atf-m-kpi' }, React.createElement('div', { className: 'atf-m-k' }, '显存'),
            React.createElement('div', { className: 'atf-m-v' }, kpiVram === null ? '—' : kpiVram))),
        // ③.5 运行环境（D11-2a 恢复——UI 稿 v3.1：2×2 紧凑网格，当前选中 run 的 env 面；
        // 四项全 —/空 → 整块不渲染；部分缺失逐项 —；长值单行 ellipsis＋title 全文；
        // 标签禁键名。右上 hint＝部署默认权限档位（server 注入面 label||key）。）
        (function() {
          var env = run && run.env
          var cells = [
            { k: '基模型', v: env && typeof env.base_model === 'string' ? env.base_model : '' },
            { k: '数据集', v: env && typeof env.dataset_keys === 'string' ? env.dataset_keys : '' },
            { k: '并行', v: env && typeof env.deepspeed === 'string' ? env.deepspeed : '' },
            { k: '通道', v: env && typeof env.lane === 'string' ? env.lane : '' },
          ]
          var visible = cells.some(function(c) { return c.v !== '' && c.v !== '—' })
          if (!visible) return null
          var preset = (typeof window !== 'undefined' && window.__ATF_UI_CONFIG__ && window.__ATF_UI_CONFIG__.permissionPreset) || null
          var permText = preset ? String(preset.label || preset.key || '') : ''
          return React.createElement('div', { className: 'atf-m-sec' },
            React.createElement('div', { className: 'atf-m-sec-h' },
              React.createElement('span', { className: 'atf-sec-t' }, '运行环境'),
              permText !== '' ? React.createElement('span', { className: 'atf-sec-hint' }, '权限档位：' + permText) : null),
            React.createElement('div', { className: 'atf-env-grid' },
              cells.map(function(c, ei) {
                var v = c.v === '' ? '—' : c.v
                return React.createElement('div', { key: c.k, className: 'atf-env-cell' },
                  React.createElement('div', { className: 'atf-env-k' }, c.k),
                  React.createElement('div', { className: 'atf-env-v', title: v }, v))
              })))
        })(),
        // ④ Loss 曲线
        React.createElement(LossChart, { run: run }),
        // ⑤ GPU 区（默认 4 列紧凑；展开 2 列＋双 sparkline＋进程 top1）
        React.createElement('div', { className: 'atf-m-sec' },
          React.createElement('div', { className: 'atf-m-sec-h' },
            React.createElement('span', { className: 'atf-sec-t' }, 'GPU'),
            React.createElement('span', { className: 'atf-sec-hint' }, gpuHeadBits.join(' · '))),
          gpuAll.length === 0
            ? React.createElement('div', { className: 'atf-gpu-empty' }, 'GPU 状态不可用——采集面离线时不猜测，恢复后自动显示')
            : React.createElement('div', { className: 'atf-gpu-grid' + (expanded ? ' atf-gpu-grid-expanded' : ''), 'data-expanded': expanded ? '1' : '0' },
                gpuAll.map(function(card) {
                  var key = String(card.index)
                  return React.createElement(GpuTile, {
                    key: key, card: card, expanded: expanded,
                    series: expanded ? (seriesByIndex[key] || []) : null,
                    procTop: lastProcByIndex[key] || null,
                  })
                })),
          gpuAll.length > 0 ? React.createElement('div', { className: 'atf-gpu-more' },
            React.createElement('button', {
              onClick: function() { setExpanded(!expanded) },
            }, expanded ? '收起历史曲线 ▴' : '展开进程与历史曲线 ▾')) : null),
        // ⑥ 训练产物（点击走 run-file 路由——原生右栏优先，不支持则新标签）
        React.createElement('div', { className: 'atf-m-sec' },
          React.createElement('div', { className: 'atf-m-sec-h' },
            React.createElement('span', { className: 'atf-sec-t' }, '训练产物'),
            React.createElement('span', { className: 'atf-sec-hint' }, '点击在右栏直接查看')),
          artRows.length === 0
            ? React.createElement('div', { className: 'atf-art2-empty' }, '（该 run 暂无产物入列）')
            : React.createElement('div', { className: 'atf-art2-list' },
                artRows.map(function(row, ri) {
                  return React.createElement('div', {
                    key: row.rel + '/' + ri, className: 'atf-art2-row',
                    title: '打开 ' + row.name, onClick: function() { openArtifact(row) },
                  },
                    React.createElement('span', { className: 'atf-art2-ico' }, row.ico),
                    React.createElement('span', { className: 'atf-art2-nm' }, row.name),
                    React.createElement('span', { className: 'atf-art2-meta' }, row.meta),
                    React.createElement('span', { className: 'atf-art2-go' }, '›'))
                }))),
        // ⑦ 训练日志（尾 40 行；自动滚底悬停暂停）
        React.createElement('div', { className: 'atf-m-sec' },
          React.createElement('div', { className: 'atf-m-sec-h' },
            React.createElement('span', { className: 'atf-sec-t' }, '训练日志'),
            React.createElement('span', { className: 'atf-sec-hint' }, '最后 40 行' + (tailRel !== '' ? ' · ' + tailRel : '') + ' · 悬停暂停')),
          tailLines.length === 0
            ? React.createElement('div', { className: 'atf-art2-empty' }, '（暂无训练日志——训练启动后自动采集）')
            : React.createElement('div', {
                className: 'atf-m-logs', ref: logRef,
                onMouseEnter: function() { logPausedRef.current = true },
                onMouseLeave: function() { logPausedRef.current = false },
              },
                tailLines.map(function(line, li) {
                  return React.createElement('div', { key: li }, line)
                }))),
        (function() {
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
          var cmpF1Keys = []
          var cmpF1Seen = {}
          ;[cmpRa, cmpRb].forEach(function(r) {
            if (!r || !r.fields_f1) return
            Object.keys(r.fields_f1).forEach(function(k) {
              if (!cmpF1Seen[k]) { cmpF1Seen[k] = true; cmpF1Keys.push(k) }
            })
          })
          cmpF1Keys.sort()
          return React.createElement('div', { className: 'atf-m-sec' },
            React.createElement('div', { className: 'atf-m-sec-h' },
              React.createElement('span', { className: 'atf-sec-t' }, '评估对比'),
              React.createElement('span', { className: 'atf-sec-hint' }, '最近两轮评估并排')),
            cmpRounds.length < 2
              ? React.createElement('div', { className: 'atf-art2-empty' }, '（不足两轮——对比需 ≥2 个 eval 轮次，当前 ' + cmpRounds.length + ' 轮）')
              : React.createElement('div', { style: { padding: '6px 8px' } },
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
                      .map(function(row, i7) {
                        return React.createElement('div', { key: 'cmp-' + i7, className: 'atf-cmp-row' + (i7 === 0 ? ' atf-cmp-head' : '') },
                          React.createElement('span', { className: 'atf-cmp-label' }, row[0]),
                          React.createElement('span', { className: 'atf-cmp-val' }, row[1]),
                          React.createElement('span', { className: 'atf-cmp-val' }, row[2]))
                      })),
                  cmpRa && cmpRb && !cmpRa.fields_f1 && !cmpRb.fields_f1
                    ? React.createElement('div', { className: 'atf-cmp-note' }, '（字段级数据需分析链产出——当前产物无 fields 面）')
                    : null))
        })(),
        React.createElement('div', { className: 'atf-m-foot' },
          (bridge ? (bridge.mode === 'real' ? '内核 real' + (bridge.version ? ' · ' + bridge.version : '') : '内核 mock') : ''))))
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

    /** D11-1 训练配置页（原生 settings.section 座位——顶栏设置浮层退役迁此）。数据源＝
     *  /atf-ui/settings 鉴权 GET/POST，同源 cookie；字段名与请求体 {storage:{...}} 逐字沿用
     *  （API 零变）。四分组：数据与存储（数据根目录/模型库·校验态红绿＋根变更确认卡）／
     *  运行环境（训练/评估 venv）／训练基线（占位＝探测拉满）／只读信息（灰底）。
     *  用户可见文案零键名（业务表述）。校验/确认/错误映射自旧面板整体搬移零改写。 */
    function TrainingConfigSection() {
      var _st = React.useState(null)
      var data = _st[0], setData = _st[1]
      var _err = React.useState({})
      var errors = _err[0], setErrors = _err[1]
      var _form = React.useState(null)
      var form = _form[0], setForm = _form[1]
      var _msg = React.useState(null)
      var msg = _msg[0], setMsg = _msg[1]
      React.useEffect(function() {
        var alive = true
        fetch('/atf-ui/settings', { credentials: 'same-origin' })
          .then(function(r) { return r.json() })
          .then(function(d) {
            if (!alive) return
            setData(d)
            setForm({
              atf_root: (d.storage.effective.atf_root || ''),
              model_root: (d.storage.effective.model_root || ''),
              train_env: (d.storage.effective.train_env || ''),
              eval_env: (d.storage.effective.eval_env || ''),
              train_gpu_baseline: (d.gpu_baseline_effective || ''),
            })
          })
          .catch(function() { if (alive) setMsg({ kind: 'err', text: '设置面读取失败（鉴权或服务不可用）' }) })
        return function() { alive = false }
      }, [])
      if (data === null || form === null) return React.createElement('div', { className: 'atf-viewer-empty', style: { padding: '10px 2px' } }, '设置面读取中…')
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
              background: 'transparent', color: 'inherit',
            },
            onChange: function(e) { setForm(Object.assign({}, form, (function(o){ o[key] = e.target.value; return o })({}))) },
          }),
          err ? React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-static-red-500)', marginTop: 2 } }, err) : null,
          opts.note ? React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#64748b)', marginTop: 2 } }, opts.note) : null)
      }
      var ro = (data && data.readonly) || {}
      var save = function() {
        if (form.atf_root !== ((data && data.storage.effective.atf_root) || '')) {
          // 根目录变更确认卡（拒绝＝零 POST）
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
      return React.createElement('div', { style: { maxWidth: 560, fontSize: 12, padding: '10px 2px 16px' } },
        React.createElement('div', { className: 'atf-viewer-empty' }, '根目录只影响新建任务的归属，现有数据位置不变'),
        blockTitle('数据与存储'),
        field('atf_root', '数据根目录', '统一根目录绝对路径（约定子目录 datasets/runs/logs 自动创建）'),
        field('model_root', '模型库位置', '模型库绝对路径（改动＝下次任务生效）'),
        blockTitle('运行环境'),
        field('train_env', '训练环境（venv 绝对路径）', '未配置＝任务发起时询问'),
        field('eval_env', '评估环境（venv 绝对路径）', '未配置＝任务发起时询问'),
        blockTitle('训练基线'),
        field('train_gpu_baseline', '训练卡数基线', '默认＝探测可用卡数拉满（' + String((data && data.gpu_detected) || '—') + ' 卡）；确认卡仍可逐次改'),
        blockTitle('只读信息'),
        React.createElement('div', { style: { fontSize: 12, background: 'rgba(128,128,128,.08)', borderRadius: 8, padding: '8px 10px', lineHeight: 1.8 } },
          React.createElement('div', null, '内核版本：' + (ro.kernel_version || '—')),
          React.createElement('div', null, '审批记录位置：' + (ro.approval_ledger || '—')),
          React.createElement('div', null, '模型凭据：' + (ro.key_status || '—')),
          React.createElement('div', null, '实例：' + (ro.instance_id || '—'))),
        msg ? React.createElement('div', { style: { fontSize: 12, marginTop: 10, color: msg.kind === 'err' ? 'var(--dsw-static-red-500)' : 'var(--dsw-static-green-500)' } }, msg.text) : null,
        React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 } },
          React.createElement('button', { className: 'atf-pill atf-train-send', onClick: save }, '保存')))
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
      // 批次 R H1-1：TokenBudget 三要素区数据（monitor.json launch.token_budget；旧快照缺席＝null 不渲染）
      var budget = (run && run.launch && run.launch.token_budget) || null
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
                  }),
                  // 批次 R H1-1：TokenBudget 三要素区（同屏三行＋关系校验红字——与确认卡面
                  // 同一渲染/校验单源（server buildLaunchSurface token_budget）；violations 非空
                  // 即关系不成立（确认卡侧禁确认），此处只读呈现供发起前核对。
                  budget ? React.createElement('div', { className: 'atf-train-budget' },
                    React.createElement('div', { className: 'atf-train-sum-head' },
                      React.createElement('span', null, 'TokenBudget 三要素（预算可编辑；cutoff/推理窗口只读——预算须 ≤ 两者，训练/推理两栈独立取值）')),
                    budget.rows.map(function(line, i) {
                      return React.createElement('div', { key: 'budget-' + i, className: 'atf-train-row' },
                        React.createElement('span', { className: 'atf-train-mean' }, line))
                    }),
                    budget.violations.map(function(v, i) {
                      return React.createElement('div', { key: 'budget-viol-' + i, className: 'atf-train-budget-viol' }, '⚠ ' + v)
                    }))
                    : null),
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
      // 批C1-1 D5：训练终态通知（复用同一通知卡同一已读键——终态配色 done 绿/failed 红）
      training_done: 'var(--dsw-static-green-500)', training_failed: 'var(--dsw-static-red-500)',
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
      // 批C1-1 D5：训练终态文案取服务端 text 单源（缺省兜底同串——文案只说事实，零内部叙事）
      if (n && (n.kind === 'training_done' || n.kind === 'training_failed')) {
        return typeof n.text === 'string' && n.text !== ''
          ? n.text
          : (n.kind === 'training_done' ? '训练已结束' : '训练未完成退出，可查看训练日志或报告')
      }
      var phase = n && typeof n.phase === 'string' ? n.phase : ''
      var text = PHASE_TEXT[phase] || phase
      var bits = []
      if (typeof n.detail === 'string' && n.detail !== '') bits.push(n.detail)
      if (typeof n.elapsed_s === 'number') bits.push('已等待 ' + n.elapsed_s + 's')
      return bits.length > 0 ? text + ' · ' + bits.join(' · ') : text
    }
    /** 批C1-1 D6：评估段实时行（eval_progress 逐轮 phase＋服务健康——不造百分比；health 缺席
     *  只显 phase；eval_progress 缺席回退 eval_rounds 末轮名（原形态零回归））。 */
    function evalSegmentDetail(run) {
      var ep = run && run.eval_progress
      if (ep && typeof ep.phase === 'string' && ep.phase !== '') {
        var bits = [PHASE_TEXT[ep.phase] || ep.phase]
        if (ep.health && typeof ep.health.alive === 'boolean') {
          bits.push(ep.health.alive ? '服务运行中' : '服务未运行')
        }
        return bits.join(' · ')
      }
      if (Array.isArray(run.eval_rounds) && run.eval_rounds.length > 0) {
        var lastRound = run.eval_rounds[run.eval_rounds.length - 1]
        return lastRound && lastRound.round ? String(lastRound.round) : ''
      }
      return ''
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
        // 批C1-1 D5：train_notices 并入同一卡栈（同一渲染器同一已读键空间——零新组件零新键）
        var notices = (Array.isArray(run.eval_notices) ? run.eval_notices : []).concat(Array.isArray(run.train_notices) ? run.train_notices : [])
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
          var colorKey = (n.kind && PHASE_COLOR[n.kind]) ? n.kind : (typeof n.phase === 'string' ? n.phase : '')
          var color = PHASE_COLOR[colorKey] || 'var(--dsw-static-neutral-500)'
          // 批B2 §五：通知 run 行显 title（workspace）——不显示裸 run_id（title 属性留全名）
          var nrun = findRunById(mon, card.runId)
          var nlabel = nrun !== null ? displayLabelOf(nrun) : '实验 ' + String(card.runId).slice(-6)
          return React.createElement('div', {
            key: n.id,
            className: 'atf-notice-card',
            style: {
              border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 10, padding: '8px 10px',
              background: 'var(--dsw-alias-bg-layer-2)', boxShadow: '0 4px 16px rgba(0,0,0,.12)',
              display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12,
            },
            onClick: function() { markNoticeSeen(n.id); force(function(v) { return v + 1 }) },
            title: '点击关闭（' + nlabel + '）',
          },
            React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: color, flex: 'none', marginTop: 4 } }),
            React.createElement('div', { style: { flex: 1, minWidth: 0 } },
              React.createElement('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, noticeText(n)),
              React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, nlabel)),
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
        if (seg.key === 'evaluate') return evalSegmentDetail(run)
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
          // 批B2 §五：任务卡 run 行显 title（workspace）——不显示裸 run_id（全名 title 属性可复制）
          React.createElement('div', {
            style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'monospace', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            title: (run.workspace ? run.workspace + ' · ' : '') + run.run_id,
          },
            displayLabelOf(run))),
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
        if (seg.key === 'evaluate') return evalSegmentDetail(run)
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
          // 批B2 §五：展开态 run 行同显 title（workspace）——title 属性给全名可复制
          React.createElement('div', {
            style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'monospace', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            title: (run.workspace ? run.workspace + ' · ' : '') + run.run_id,
          },
            displayLabelOf(run))),
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
    // 目录结构 v1（设计基线 D5）：工作区目录丢失呈现——/atf-ui/workspaces（server 半只读
    // 端点：registry records＋path 目录在位状态）30s 轮询，对 exists=false 的工作区在
    // composer dock 卡面标「目录已丢失——可用 atf_rebind_workspace 重新定位」。零 vendor
    // 修改（自有端点＋自有卡面）；端点缺席/未就绪（503）静默下轮重取。
    var WORKSPACES_POLL_MS = 30000
    function LostWorkspacesBanner() {
      var hook = React.useState(null)
      var records = hook[0]
      var setRecords = hook[1]
      React.useEffect(function() {
        var stopped = false
        var load = function() {
          fetch('/atf-ui/workspaces', { credentials: 'same-origin', cache: 'no-store' })
            .then(function(r) { return r.ok ? r.json() : null })
            .then(function(d) {
              if (!stopped && d !== null && d !== undefined && Array.isArray(d.records)) setRecords(d.records)
            })
            .catch(function() { /* 离线/未就绪——下个周期重取 */ })
        }
        load()
        var timer = setInterval(load, WORKSPACES_POLL_MS)
        return function() { stopped = true; clearInterval(timer) }
      }, [])
      if (records === null) return null
      var lost = records.filter(function(record) { return record.exists === false })
      if (lost.length === 0) return null
      return React.createElement('div', { className: 'atf-lost-ws', role: 'status' },
        React.createElement('div', { className: 'atf-lost-ws-title' },
          '工作区目录已丢失（' + lost.length + '）——可用 atf_rebind_workspace 重新定位'),
        lost.map(function(record, index) {
          return React.createElement('div', { key: record.id || index, className: 'atf-lost-ws-row' },
            React.createElement('span', { className: 'atf-lost-ws-path' }, record.path),
            React.createElement('span', { className: 'atf-lost-ws-meta' },
              (record.title || '') + (record.session_count > 0 ? ' · ' + record.session_count + ' 会话' : '')))
        }))
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

    // ── 批B2 §三：共用选择面板（chip 与监控紧凑入口同一个组件——二处复用）。 ──
    // 分组序：本会话 → 继续上次（仅未绑定）→ 最近实验 → 本工作区其他（≤5）→ 全部实例（只读）。
    // 行主文 title、次行 workspace · run_id（等宽小字可复制）；同名跨区主行 [workspace] 前缀；
    // 「全部」组行点击＝仅预览（同步监控选择器，**不 POST**——红线：浏览不得改绑定），行另给
    // 「设为当前」；改名铅笔 ≤80 字 → POST rename；POST 失败 toast 行不改本地态（连续 2 次
    // 提示稍后重试）；Esc 关闭、↑↓ 焦点移动（行＝原生 button，Enter 天然选中）。
    function BindingPanel(props) {
      var b = useBinding()
      var mon = useMonitor()
      var msgState = React.useState(null)
      var msg = msgState[0], setMsg = msgState[1]
      var failState = React.useState(0)
      var fails = failState[0], setFails = failState[1]
      var renameState = React.useState(null)
      var rename = renameState[0], setRename = renameState[1]
      var rootRef = React.useRef(null)
      var close = props && typeof props.onClose === 'function' ? props.onClose : function() {}
      React.useEffect(function() {
        var onKey = function(e) {
          if (e.key === 'Escape') { close(); return }
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          var root = rootRef.current
          if (!root) return
          var rows = root.querySelectorAll('[data-bp-row]')
          if (rows.length === 0) return
          var idx = Array.prototype.indexOf.call(rows, document.activeElement)
          var next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx <= 0 ? 0 : idx - 1)
          var el = rows[next]
          if (el && typeof el.focus === 'function') { e.preventDefault(); el.focus() }
        }
        var onDown = function(e) {
          if (rootRef.current && rootRef.current.contains(e.target)) return
          close()
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown, true)
        return function() {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onDown, true)
        }
      }, [close])
      // 挂载条件由唯一宿主（BindingChip：panelOpen＝store.bindingPanel）控制——本组件不再
      // 复判 store（避免 chip 本地态/store 态双轨）。

      var allRuns = (mon && mon.runs) || []
      var bound = b.status === 'ready' && b.active !== null
      var activeRun = bound ? findRunById(mon, b.active.run_id) : null
      var lastInfo = lastRunInfo(b, mon)
      var dupTitles = dupTitleSet([allRuns, b.recent, b.candidates])
      var toast = function(out) {
        if (out && out.status === 200 && out.body && out.body.saved) { setFails(0); setMsg(null); return }
        var text = out && out.body && out.body.message ? String(out.body.message)
          : out && out.status === 404 ? '实验不存在——核对后重试'
          : out && out.status === 0 ? '网络异常——操作未生效'
          : '操作失败（HTTP ' + String(out && out.status !== undefined ? out.status : '?') + '）'
        var n = fails + 1
        setFails(n)
        setMsg({ kind: 'err', text: n >= 2 ? '稍后重试——' + text : text })
      }
      var doBind = function(runId) { return binding.bindRun(runId).then(toast) }
      var doUnbind = function() { return binding.unbindRun().then(toast) }
      var doUndo = function() { return binding.undoUnbind().then(toast) }
      var doRename = function(runId, title) {
        return binding.renameRun(runId, title).then(function(out) {
          if (out && out.status === 200 && out.body && out.body.saved) { setFails(0); setMsg({ kind: 'ok', text: '已改名' }); setRename(null); return }
          toast(out)
        })
      }
      /** 全部组预览（只读）：同步监控选择器并打开右栏——**零 POST**（红线）。 */
      var previewOnly = function(runId) {
        store.setMonitorShowAll(true)
        store.setMonitor(true, runId)
        if (sidebarFace && typeof sidebarFace.openResource === 'function') {
          try { sidebarFace.openResource('dsh-resource://atf-training-monitor/monitor') } catch (e) { /* fail-open */ }
        }
        close()
      }
      var mainTitle = function(item) {
        var title = item && item.title !== undefined && item.title !== null && String(item.title) !== '' ? String(item.title) : displayTitleOf(item)
        return dupTitles[title] === true && item.workspace ? '[' + item.workspace + '] ' + title : title
      }
      var groupEl = function(name, rows) {
        if (!rows || rows.length === 0) return null
        return React.createElement('div', { className: 'atf-bp-group', key: name },
          React.createElement('div', { className: 'atf-bp-gh' }, name),
          rows)
      }
      /** 行构造：main 主行（title＋状态）、sub 次行（workspace · run_id 等宽可复制）、右侧动作。 */
      var rowEl = function(o) {
        var monRun = o.monRun !== undefined ? o.monRun : findRunById(mon, o.runId)
        var st = monRun !== null ? runStatusOf(monRun) : null
        var sub = (o.workspace ? o.workspace + ' · ' : '') + o.runId
        var isAll = o.previewOnly === true
        return React.createElement('div', { className: 'atf-bp-row', key: o.key || o.runId },
          React.createElement('button', {
            className: 'atf-bp-main', 'data-bp-row': '1',
            disabled: o.current === true || undefined,
            title: isAll ? '只读预览——不改变本会话绑定' : o.current === true ? '当前绑定的实验' : '绑定该实验',
            onClick: function() {
              if (o.current === true) return
              if (isAll) { previewOnly(o.runId); return }
              doBind(o.runId).then(function() { if (o.afterBind) o.afterBind() })
            },
          },
            React.createElement('span', { className: 'atf-bp-ico' }, o.current === true ? '●' : isAll ? '○' : '○'),
            React.createElement('span', { className: 'atf-bp-tcol' },
              React.createElement('span', { className: 'atf-bp-title' }, mainTitle({ title: o.title, workspace: o.workspace, run_id: o.runId })),
              React.createElement('span', { className: 'atf-bp-sub' }, sub)),
            st !== null ? React.createElement('span', { className: 'atf-bp-st' + st.cls }, st.label + (st.pct !== null ? ' ' + st.pct + '%' : '')) : null),
          o.current === true && o.runId !== null
            ? React.createElement('button', {
                className: 'atf-bp-act', title: '改名（≤80 字）',
                onClick: function() { setRename(rename && rename.runId === o.runId ? null : { runId: o.runId, value: o.title || '' }) },
              }, '✎') : null,
          isAll
            ? React.createElement('button', {
                className: 'atf-bp-act', title: '设为当前实验（显式绑定动作）',
                onClick: function() { doBind(o.runId) },
              }, '设为当前') : null)
      }
      var renameEl = rename !== null
        ? React.createElement('div', { className: 'atf-bp-rename' },
            React.createElement('input', {
              className: 'atf-bp-rename-in', value: rename.value, maxLength: 80,
              placeholder: '实验名（≤80 字）', autoFocus: true,
              onChange: function(e) { setRename({ runId: rename.runId, value: e.target.value }) },
              onKeyDown: function(e) {
                if (e.key === 'Enter' && rename.value.trim() !== '') doRename(rename.runId, rename.value.trim())
                if (e.key === 'Escape') setRename(null)
              },
            }),
            React.createElement('button', {
              className: 'atf-bp-act', disabled: rename.value.trim() === '' || undefined,
              onClick: function() { doRename(rename.runId, rename.value.trim()) },
            }, '确定'),
            React.createElement('button', { className: 'atf-bp-act', onClick: function() { setRename(null) } }, '取消'))
        : null

      // 批B2a：跨组去重——shown 集按渲染序累积（active→继续上次→最近实验→本工作区其他），
      // 同 run 不在两组同屏重复；「全部实例（只读）」是目录，保持全量不去重；组去重为空时
      // groupEl 返回 null（不渲染组标题）。只改展示，不改绑定/候选语义（红线）。
      var shown = {}
      if (bound && b.active.run_id) shown[b.active.run_id] = true
      if (!bound && lastInfo !== null) shown[lastInfo.runId] = true
      var groups = []
      if (bound) {
        groups.push(groupEl('本会话', [
          rowEl({
            runId: b.active.run_id, workspace: b.active.workspace, title: b.active.title,
            monRun: activeRun, current: true, key: 'cur',
          }),
          renameEl,
          activeRun === null
            ? React.createElement('div', { className: 'atf-bp-warn', key: 'gone' },
                '原实验已不可见（可能归档/删除）——可选择其他实验或解除绑定')
            : null,
        ]))
      } else if (b.unbound_reason === 'stale') {
        groups.push(React.createElement('div', { className: 'atf-bp-warn', key: 'stale' }, '原实验已不可见（可能归档/删除）——请选择其他实验'))
      }
      if (!bound && lastInfo !== null) {
        var lastSt = lastInfo.monRun !== null ? runStatusOf(lastInfo.monRun) : null
        var lastRow = React.createElement('div', { className: 'atf-bp-row', key: 'last' },
          React.createElement('button', {
            className: 'atf-bp-main', 'data-bp-row': '1', title: '绑定上次使用的实验（跨会话）',
            onClick: function() { doBind(lastInfo.runId) },
          },
            React.createElement('span', { className: 'atf-bp-ico' }, '↺'),
            React.createElement('span', { className: 'atf-bp-tcol' },
              React.createElement('span', { className: 'atf-bp-title' },
                '上次：' + (lastInfo.title !== null ? lastInfo.title : '实验 ' + String(lastInfo.runId).slice(-6))),
              React.createElement('span', { className: 'atf-bp-sub' },
                (lastInfo.ws ? lastInfo.ws + ' · ' : '') + lastInfo.runId)),
            lastSt !== null ? React.createElement('span', { className: 'atf-bp-st' + lastSt.cls }, lastSt.label) : null))
        groups.push(groupEl('继续上次', [lastRow]))
      }
      var recentRows = (b.recent || []).filter(function(item) {
        return item && shown[item.run_id] !== true
      }).map(function(item, ri) {
        shown[item.run_id] = true
        return rowEl({ runId: item.run_id, workspace: item.workspace, title: item.title, key: 'r' + ri })
      })
      groups.push(groupEl('最近实验', recentRows))
      if (bound) {
        var others = (b.candidates || []).filter(function(c) {
          return c && shown[c.run_id] !== true
            && c.run_id !== b.active.run_id
            && (b.active.workspace === null || b.active.workspace === undefined || c.workspace === b.active.workspace)
        }).slice(0, 5)
        groups.push(groupEl('本工作区其他', others.map(function(c, ci) {
          shown[c.run_id] = true
          return rowEl({ runId: c.run_id, workspace: c.workspace, title: c.title, key: 'o' + ci })
        })))
      }
      var allRows = allRuns.map(function(r, ai) {
        return rowEl({
          runId: r.run_id, workspace: r.workspace, title: displayTitleOf(r),
          monRun: r, previewOnly: true, key: 'a' + ai,
        })
      })
      groups.push(groupEl('全部实例（只读）', allRows))

      return ReactDOM.createPortal(
        React.createElement('div', {
          className: 'atf-bp', ref: rootRef, role: 'dialog', 'aria-label': '选择实验',
          style: { position: 'fixed', top: (topBarOffset() + 6), right: 8, zIndex: 905 },
          onKeyDown: function(e) { if (e.key === 'Escape') { e.stopPropagation(); close() } },
        },
          React.createElement('div', { className: 'atf-bp-h' },
            React.createElement('b', null, bound ? '当前实验' : '选择实验'),
            React.createElement('button', { className: 'atf-bp-act', title: '关闭', onClick: close }, '×')),
          b.status === 'loading' ? React.createElement('div', { className: 'atf-bp-hint' }, '读取中…') : null,
          groups,
          !bound
            ? React.createElement('div', { className: 'atf-bp-actions' },
                React.createElement('button', {
                  className: 'atf-bp-act', onClick: function() { store.setTrain({ runId: null, mode: 'dry_run' }); close() },
                }, '新建实验'),
                React.createElement('button', {
                  className: 'atf-bp-act', onClick: function() { previewOnly(null) },
                }, '查看全部实验（只读）'))
            : React.createElement('div', { className: 'atf-bp-actions' },
                React.createElement('button', {
                  className: 'atf-bp-act atf-bp-unbind', title: '解除本会话与实验的绑定（回到未选择状态）',
                  onClick: function() { doUnbind() },
                }, '解除绑定')),
          msg !== null
            ? React.createElement('div', { className: 'atf-bp-msg', role: 'status', style: msg.kind === 'err' ? { color: 'var(--dsw-alias-state-danger-label,#b91c1c)' } : undefined }, msg.text)
            : null),
        document.body)
    }

    // ── B2c：草稿态「回到上次实验」卡（shell.overlay——root 域 list 槽，草稿态也渲染；
    // additive 零遮蔽——vendor 槽契约：conversation 域 list 槽全为 session 域（无 sessionId
    // 不渲染＝B2c 缺口根因），hero/composer 的 session-maybe 槽全为 single 替换槽（占用即
    // 遮蔽 shipped UI），故渲染挂点选 shell.overlay 全帧浮层位，草稿态浮层卡形态）。
    // 渲染条件自守卫：仅草稿态（无 sessionId）＋有最近实验；已绑定/有会话不出卡。
    // 点击存 pending（零 POST）；待绑定有可见反馈；pending 在场重复点击不重复入队。 ──
    function DraftResumeCard() {
      var b = useBinding()
      var sid = store.sessionId
      var draft = b.draft
      // 草稿态拉取（进草稿态拉一次；离开草稿态不拉不渲染）
      React.useEffect(function() {
        if (sid === undefined && draft.status === 'idle') void binding.loadDraft()
      }, [sid, draft.status])
      if (sid !== undefined) return null // 有会话/已绑定＝不出卡（B2c 验收锚）
      if (draft.status !== 'ready' || draft.recent.length === 0) return null
      var last = draft.recent[0]
      var pendingNow = b.pending !== null
      var label = typeof last.title === 'string' && last.title !== '' ? last.title : '实验 ' + String(last.run_id || '').slice(-6)
      var ws = typeof last.workspace === 'string' && last.workspace !== '' ? last.workspace : null
      return React.createElement('div', {
        className: 'atf-draft-card',
        style: {
          position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 96, zIndex: 798,
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', maxWidth: 'min(520px, 90vw)',
          borderRadius: 12, border: '1px solid var(--dsw-alias-border-l3)',
          background: 'var(--dsw-alias-bg-layer-2)', boxShadow: '0 6px 24px rgba(0,0,0,.14)', fontSize: 12,
          pointerEvents: 'auto',
        },
        'data-draft-resume': '1',
      },
        React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', flex: 'none' } }, '↩'),
        React.createElement('div', { style: { flex: 1, minWidth: 0 } },
          React.createElement('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            '回到上次实验：' + label),
          React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            pendingNow
              ? '已选中——发送首条消息后自动绑定「' + b.pending.title + '」'
              : (ws !== null ? ws : '上次实验') + ' · 点击选用，发送首条消息时自动绑定')),
        React.createElement('button', {
          className: 'atf-pill', 'data-draft-resume-go': '1',
          title: pendingNow ? '已记录——发送首条消息后自动绑定（重复点击不重复入队）' : '把「' + label + '」设为下一个会话的绑定实验',
          onClick: function() { binding.stagePending(last) },
        }, pendingNow ? '已选 ✓' : '继续这次实验'))
    }

    // B2c：轻量通报条（草稿 pending 消费失败等一次性业务文案——5s 自消失，不静默丢）。
    function DraftToast() {
      var b = useBinding()
      if (b.toast === null || b.toast === undefined || b.toast === '') return null
      return React.createElement('div', {
        className: 'atf-draft-toast', role: 'status',
        style: {
          position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 56, zIndex: 801,
          padding: '7px 14px', borderRadius: 10, fontSize: 12, maxWidth: 'min(520px, 90vw)',
          border: '1px solid var(--dsw-static-amber-500)', color: 'var(--dsw-alias-state-warning-label,#92400e)',
          background: 'var(--dsw-alias-bg-layer-2)', boxShadow: '0 4px 16px rgba(0,0,0,.12)',
          pointerEvents: 'auto',
        },
      }, b.toast)
    }

    // ── 批B2 §二：顶栏绑定 chip（conversation.session.header.utilities）──
    // 已绑定 [● title · 训练中 62% ▾][工作区徽标]；未绑定 [选择实验 ▾]；读取失败 [绑定读取失败 · 重试]
    // （点击重 GET）；绑定 run 在 monitor 缺席 → [实验不可见 ▾]（面板给「选择其他实验/解除」）。
    // loading＝骨架不显旧值。点击开共用选择面板（BindingPanel——与监控同一个组件）。
    function BindingChip() {
      var b = useBinding()
      var mon = useMonitor()
      var panelOpen = React.useSyncExternalStore(
        function(fn) { return store.subscribe(fn) },
        function() { return store.bindingPanel },
      )
      var close = function() { store.setBindingPanel(false) }
      var bound = b.status === 'ready' && b.active !== null
      var activeRun = bound ? findRunById(mon, b.active.run_id) : null
      var st = runStatusOf(activeRun)
      var visible = bound && activeRun !== null
      var label
      if (b.status === 'loading') label = null
      else if (b.status === 'error') label = '绑定读取失败 · 重试'
      else if (bound && !visible) label = '实验不可见'
      else if (bound) label = b.active.title + ' · ' + st.label
      else label = '选择实验'
      return React.createElement('div', { className: 'atf-bchip-root', style: { position: 'relative', display: 'inline-flex' } },
        React.createElement('button', {
          className: 'atf-effort-trigger atf-bchip' + (b.status === 'loading' ? ' atf-bchip-loading' : ''),
          'aria-busy': b.status === 'loading' ? 'true' : undefined,
          title: b.status === 'error' ? '绑定读取失败——点击重试'
            : visible ? (b.active.title + '（' + (b.active.workspace || '无工作区标注') + '）——点击切换')
            : bound ? '原实验在监控中不可见——点击处理'
            : '选择本会话要处理的实验',
          onClick: function() {
            if (b.status === 'error') { void binding.load(store.sessionId); return }
            if (panelOpen) { close(); return }
            store.setBindingPanel(true)
          },
        },
          b.status === 'loading'
            ? React.createElement('span', { className: 'atf-bchip-skel' }, '░░░░')
            : React.createElement('span', null,
                visible ? React.createElement('span', { className: 'atf-bchip-state' + st.cls },
                  React.createElement('span', { className: 'atf-m-dot' }),
                  ' ') : null,
                label,
                React.createElement('span', { className: 'atf-effort-caret' }, ' ▾')),
          bound && b.active.workspace ? React.createElement('span', {
            className: 'atf-bchip-ws', title: b.active.workspace,
          }, wsShortOf(b.active.workspace)) : null),
        panelOpen ? React.createElement(BindingPanel, { onClose: close }) : null)
    }

    // 批B2 §五：快捷胶囊按绑定状态启用——run 相关（查状态/继续上次/对比两轮）未绑定时
    // disabled＋「先选择实验」，点击弹选择面板（不发工具调用）；「新建实验/发起训练/badcase
    // 可视化」始终可用。已绑定：继续上次胶囊文案带 title（「继续训练：装箱单 4类」——取
    // title 首段短名，防止超长）。
    // D34：「走完闭环」胶囊——决策闭环默认指令（与 snapshot.js CLOSURE_MESSAGE 同语义
    // 双份——client 半裸服务不打包无法 require，trainLaunchMessage 先例；atfUi.test.ts 双钉）。
    // 封存步（事实日志＋锚点快照落盘）在默认步骤集内——闭环默认含封存，不再依赖用户点名。
    var CLOSURE_MESSAGE = [
      '把本轮实验走完决策闭环：',
      '①把本轮评估结论记成决策；',
      '②证据归档（逐项 sha256 清单）；',
      '③发布件按「可用模型归档」处理，支持则晋升为基线；',
      '④留痕封存——把本轮事实日志与锚点快照落盘存档（闭环默认步骤，勿跳过；完成后回报文件清单）；',
      '⑤给下一轮计划预览，然后本轮收口。该我确认的环节就出卡。',
    ].join('\n')
    var PILLS = [
      { label: '新建训练', msg: '我想启动一个新的训练任务' },
      { label: '查状态', msg: '查看当前训练任务状态', runRelated: true },
      { label: '继续上次', msg: '继续上次的训练任务', runRelated: true, continueLabel: true },
      { label: '对比两轮', msg: '对比最近两轮训练的指标', runRelated: true },
      { label: '走完闭环', msg: CLOSURE_MESSAGE },
      // H5：联合训练入口——绑定态开字段选择对话框（JointTrainDialog）；未绑定沿 B2 胶囊
      // 纪律弹选择面板（runRelated 语义复用，不发工具调用）。
      { label: '联合训练', runRelated: true, joint: true },
    ]
    function DockPillsRow() {
      var b = useBinding()
      var bound = b.status === 'ready' && b.active !== null
      var shortTitle = bound && typeof b.active.title === 'string' ? b.active.title.split(' · ')[0] : null
      return React.createElement('div', { className: 'atf-pill-row' },
        PILLS.map(function(pill) {
          var disabled = pill.runRelated === true && !bound
          var label = pill.continueLabel === true && bound ? '继续训练：' + (shortTitle || '当前实验') : pill.label
          // 批B2：禁用态用 aria-disabled＋降透明类（真 disabled 收不到点击——「点击弹面板」
          // 语义要求可点；不发起任何工具调用，仅开共用选择面板）。
          return React.createElement('button', {
            key: pill.label, className: 'atf-pill' + (disabled ? ' atf-pill-dis' : ''),
            'aria-disabled': disabled ? 'true' : undefined,
            title: disabled ? '先选择实验' : undefined,
            'data-run-related': pill.runRelated === true ? '1' : undefined,
            onClick: function() {
              // 未绑定点击 run 相关胶囊＝弹选择面板（§五——不发起工具调用）
              if (pill.runRelated === true && !bound) { store.setBindingPanel(true); return }
              // H5：联合训练胶囊＝开字段选择对话框（绑定态；不发起工具调用——消息由对话框生成）
              if (pill.joint === true) { store.setJoint({ openedAt: Date.now() }); return }
              // 输入面＝contenteditable 富输入（DSH 壳无 textarea）——execCommand 插入保 React 状态同步
              var input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]')
              if (input) {
                input.focus()
                document.execCommand('insertText', false, pill.msg)
              }
            },
          }, label)
        }),
        React.createElement('button', {
          className: 'atf-pill', title: '内嵌打开 badcase 可视化',
          onClick: function() { store.setViewer({ runId: null }) },
        }, 'badcase 可视化'),
        React.createElement('button', {
          className: 'atf-pill', title: '发起训练（IterationConfig 摘要→确认卡→正道链）',
          onClick: function() { store.setTrain({ runId: null, mode: 'dry_run' }) },
        }, '发起训练'))
    }

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
    // 闭集顺位（与 EFFORT_CLOSED 同序）——T2.3 最近档距离的度量域（不造档位，只量距离）
    var EFFORT_ORDER = ['off', 'low', 'high', 'max']
    var effortLabelOf = function(id) {
      for (var i = 0; i < EFFORT_CLOSED.length; i++) {
        if (EFFORT_CLOSED[i].id === id) return EFFORT_CLOSED[i].label
      }
      return id
    }

    /** 批甲-FIX T2.2 取值链②③（owner 裁定；①已由调用点先行短路）：
     *  ② 用户为该模型设置的默认档（/atf-ui/settings effort_defaults）∩目录闭集；
     *  ③ 目录 efforts 顺位最低档＝声明序首位（GLM-5.3→Off；Flash 系→Low——保守最低档
     *  为首次缺省，owner 可改）。两段出处均不造值：②是用户显式设置，③是目录声明序。 */
    function chainFallbackEffort(choice, offered) {
      if (choice === null || choice === undefined) return undefined
      var ud = userDefaultEffortOf(choice.model)
      if (ud !== undefined) {
        for (var i = 0; i < offered.length; i++) {
          if (offered[i].id === ud) return ud
        }
      }
      return offered.length > 0 ? offered[0].id : undefined
    }

    /** T2.2 ensure：会话无显式档位（current.reasoningEffort 缺席）时把链值固化为会话选择——
     *  显示值＝真实送出值（composer「默认」态悬空即端点缺省 max 的误导面，随固化消除）。
     *  程序化补选失败静默（writer-held 忙会话等——控件照常显示链值，不弹错误条不重试风暴）。 */
    function ensureChainEffort(injected, state, choice, offered, refs) {
      if (state === null || state === undefined || choice === null || choice === undefined) return
      if (injected.available !== true || typeof injected.select !== 'function') return
      if (state.status !== 'ready') return
      if (state.current !== null && state.current !== undefined && state.current.reasoningEffort !== undefined) return
      if (offered.length === 0) return
      var key = choice.provider + '/' + choice.model
      if (refs.ensured === key) return
      refs.ensured = key
      loadEffortDefaults().then(function() {
        var want = chainFallbackEffort(choice, offered)
        if (want === undefined) return undefined
        return injected.select({ provider: choice.provider, model: choice.model, reasoningEffort: want })
      }).then(function(result) {
        if (result && result.ok === false) { /* 程序化补选被拒——静默（链值显示不变，候下次就绪） */ }
      }).catch(function() { /* 同上——不阻断控件主面 */ })
    }

    /** 目录快照 → 目标模型档位 id 集（未在目录＝null；无思考档位＝[]）。 */
    function effortsOf(state, provider, modelId) {
      for (var gi = 0; gi < state.groups.length; gi++) {
        var group = state.groups[gi]
        if (group.id !== provider) continue
        for (var mi = 0; mi < group.models.length; mi++) {
          var model = group.models[mi]
          if (model.id === modelId) {
            return (model.reasoning && model.reasoning.efforts && model.reasoning.efforts.length > 0)
              ? model.reasoning.efforts.map(function(e) { return e.id }) : []
          }
        }
      }
      return null
    }

    /** 闭集顺位最近档（|顺位差|最小者——不静默跳 max；度量域＝EFFORT_ORDER 声明序）。 */
    function nearestEffort(fromId, ids) {
      var fromIdx = EFFORT_ORDER.indexOf(fromId)
      var want = null
      var best = Number.MAX_VALUE
      for (var i = 0; i < ids.length; i++) {
        var d = Math.abs(fromIdx - EFFORT_ORDER.indexOf(ids[i]))
        if (d < best) { best = d; want = ids[i] }
      }
      return want
    }

    /** 程序化补选（失败静默——store 已如实呈现首因，不弹错误条）。 */
    function quietSelect(injected, selection) {
      Promise.resolve(injected.select(selection)).then(function(result) {
        if (result && result.ok === false) { /* 程序化补选被拒——静默 */ }
      }).catch(function() { /* 同上 */ })
    }

    /** 统一档位同步器（store 快照驱动——每变重判，各分支自带幂等守卫）：
     *  ① T2.3 补偿：模型切换提交被拒（选择携带越界档位，host resolveCallConfig 拒
     *     UNSUPPORTED_REASONING_EFFORT→session/model-unavailable）——同模型拒绝＝用户档位
     *     选择本身被拒（如实显示不补偿）；跨模型拒绝＝落目标模型顺位最近档补选（防环：同
     *     目标只补一次）。可可达面：同模型重选携带陈旧档（目录收窄后）等提交全量选择的路径。
     *  ② T2.3 保持/回退：模型切换已落地但选择未携带档位（vendor 两条切换路径——composer
     *     座 choose 与 /model 面板 selectionOf——均不携带旧档位，落地即「无显式档位」态）——
     *     目标支持前档则保持（owner 裁定「支持则保持」），不支持落顺位最近档（如实呈现落点，
     *     不静默跳 max）；前模型本就无显式档位则不保持，交链②③。
     *  ③ T2.2 ensure：无显式档位（含切换后前档缺席）——按链固化（用户默认档→顺位最低档）。
     *  会话上下文切换（directory 身份变化）＝prev 作废——不跨会话「保持」，链语义重起。 */
    function syncEffortSelection(injected, state, choice, offered, refs) {
      if (state === null || state === undefined) return
      if (injected.available !== true || typeof injected.select !== 'function') return
      if (refs.directory !== injected.directory) {
        refs.directory = injected.directory
        refs.prev = null
        refs.pendingSelection = null
        refs.compensated = null
      }
      if (state.pending !== null && state.pending !== undefined) {
        refs.pendingSelection = state.pending
        return
      }
      var cur = state.current
      if (cur === null || cur === undefined) return
      var prev = refs.prev
      refs.prev = { provider: cur.provider, model: cur.model, reasoningEffort: cur.reasoningEffort }
      // ① 补偿：切换提交被拒（越界档位）
      if (state.status === 'error' && refs.pendingSelection !== null && refs.pendingSelection !== undefined) {
        var target = refs.pendingSelection
        refs.pendingSelection = null
        if (target.provider === cur.provider && target.model === cur.model) return
        if (target.reasoningEffort === undefined) return
        var key = target.provider + '/' + target.model + '@' + String(target.reasoningEffort)
        if (refs.compensated === key) return
        var ids = effortsOf(state, target.provider, target.model)
        if (ids === null || ids.length === 0) return
        var want = nearestEffort(target.reasoningEffort, ids)
        if (want === null) return
        refs.compensated = key
        quietSelect(injected, { provider: target.provider, model: target.model, reasoningEffort: want })
        return
      }
      // ② 保持/回退：切换落地未携带档位
      if (prev !== null && prev.model !== cur.model && cur.reasoningEffort === undefined) {
        var kept = prev.reasoningEffort
        if (kept !== undefined) {
          var ids2 = effortsOf(state, cur.provider, cur.model)
          if (ids2 !== null && ids2.length > 0) {
            var want2 = ids2.indexOf(kept) >= 0 ? kept : nearestEffort(kept, ids2)
            if (want2 !== null) {
              quietSelect(injected, { provider: cur.provider, model: cur.model, reasoningEffort: want2 })
              return
            }
          }
          // ids2 空数组（目标无思考档位）或目录缺席：现选择已不带档位＝正确落点，零动作
        }
      }
      // ③ ensure：链②③固化
      ensureChainEffort(injected, state, choice, offered, refs)
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
      // 批甲-FIX：统一档位同步器账本（directory 身份/前选择/在途提交/防环/ensure 去重）
      var watcherRef = React.useRef({ directory: undefined, prev: null, pendingSelection: null, compensated: null, ensured: null })

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
      // 批甲-FIX T2.2 去「默认」态——当前档位取值链（owner 裁定）：
      // ① 当前会话用户最近手动切换值（state.current.reasoningEffort）
      // → ② 用户为该模型设置的默认档（effort_defaults ∩目录闭集，T2.1）
      // → ③ 目录 efforts 顺位最低档（声明序首位：GLM-5.3→Off；Flash 系→Low）。
      // 链值经 ensure 固化为会话选择（见下 effect）——显示值恒为真实送出值。
      var chainEffort = (reasoning && state.current && state.current.reasoningEffort !== undefined)
        ? state.current.reasoningEffort
        : chainFallbackEffort(choice, offered)
      var currentLabel = chainEffort === undefined ? '—' : effortLabelOf(chainEffort)
      var pending = state.pending !== null && state.pending !== undefined
      var waiting = busy || pending

      // T2.2 链值固化＋T2.3 保持/回退/补偿（统一同步器——store 快照驱动，内含幂等守卫）
      React.useEffect(function() {
        syncEffortSelection(injected, state, choice, offered, watcherRef.current)
        // 依赖面即 store 快照（每变重判；同步器内幂等带守卫）
      }, [state])

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
              var on = chainEffort === option.id
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

    // ── 批甲-FIX T2.1：Models 设置页 per-model「默认思考等级」（settings.models.provider-card
    // keyed 槽座位；key＝glm-atf 的 settingsNs 'llm-pi-ai'——产品层实施，vendor 零写入）。
    // 每模型一个下拉，选项＝该模型目录 efforts 闭集（不造档位；目录缺席＝如实占位）；写入
    // /atf-ui/settings effort_defaults 块（用户 settings 单源）——composer 取值链②读同一份。
    // 会话内既有显式档位不受改档影响（链①优先）；新会话/未切档会话按新默认档补位。
    var remoteSessionFace = null
    function ProviderModelDefaultsBody(props) {
      var entry = props && props.provider
      var catalogState = React.useState(null)
      var catalog = catalogState[0], setCatalog = catalogState[1]
      var edState = React.useState(effortDefaultsCache.map)
      var edMap = edState[0], setEdMap = edState[1]
      var msgState = React.useState(null)
      var msg = msgState[0], setMsg = msgState[1]
      React.useEffect(function() {
        var alive = true
        loadEffortDefaults().then(function(m) { if (alive) setEdMap(Object.assign({}, m)) })
        if (remoteSessionFace !== null && typeof remoteSessionFace.modelCatalog === 'function') {
          remoteSessionFace.modelCatalog().then(function(r) {
            if (alive && r && r.ok === true) setCatalog(r.value)
          }).catch(function() { /* 目录缺席＝占位（不造档位） */ })
        }
        return function() { alive = false }
      }, [])
      if (entry === null || entry === undefined || entry.provider !== 'glm-atf') return null
      var groups = (catalog !== null && catalog !== undefined && catalog.groups) || []
      var models = []
      for (var gi = 0; gi < groups.length; gi++) {
        if (groups[gi].id !== 'glm-atf') continue
        models = groups[gi].models || []
        break
      }
      var onChange = function(modelId, effortId) {
        if (typeof effortId !== 'string' || effortId === '') return
        var next = Object.assign({}, edMap || {})
        next[modelId] = effortId
        setMsg({ kind: 'busy', text: '保存中…' })
        saveEffortDefaults(next).then(function(out) {
          if (out.status === 200 && out.body && out.body.saved) {
            setEdMap(Object.assign({}, (out.body.effort_defaults && typeof out.body.effort_defaults === 'object') ? out.body.effort_defaults : next))
            setMsg({ kind: 'ok', text: '已保存：' + modelId + ' 默认档＝' + effortLabelOf(effortId) })
          } else {
            var errs = out.body && out.body.errors ? JSON.stringify(out.body.errors) : String(out.status)
            setMsg({ kind: 'err', text: '保存被拒绝：' + errs })
          }
        }).catch(function() { setMsg({ kind: 'err', text: '保存失败（网络/服务不可用）' }) })
      }
      return React.createElement('div', { className: 'atf-ed-block' },
        React.createElement('div', { className: 'atf-ed-title' }, '默认思考等级（per-model）'),
        React.createElement('div', { className: 'atf-ed-note' },
          '每个模型未手动切档时的补位档（新会话按此延用）；取值链：会话最近切换 → 此处默认档 → 目录顺位最低档。'),
        catalog === null
          ? React.createElement('div', { className: 'atf-ed-note' }, '模型目录读取中…')
          : models.length === 0
            ? React.createElement('div', { className: 'atf-ed-note' }, '（模型目录无 glm-atf 行——目录未就绪或路由未配置）')
            : models.map(function(model) {
                var efforts = (model.reasoning && model.reasoning.efforts) || []
                var offered = []
                for (var ci = 0; ci < EFFORT_CLOSED.length; ci++) {
                  for (var li = 0; li < efforts.length; li++) {
                    if (efforts[li].id === EFFORT_CLOSED[ci].id) { offered.push(EFFORT_CLOSED[ci]); break }
                  }
                }
                var current = (edMap !== null && edMap !== undefined) ? edMap[model.id] : undefined
                return React.createElement('div', { key: model.id, className: 'atf-ed-row' },
                  React.createElement('span', { className: 'atf-ed-model' }, model.name || model.id),
                  offered.length === 0
                    ? React.createElement('span', { className: 'atf-ed-note' }, '（无思考档位）')
                    : React.createElement('select', {
                        className: 'atf-ed-select',
                        value: typeof current === 'string' ? current : '',
                        title: '为 ' + (model.name || model.id) + ' 设置默认思考等级（未手动切档时生效）',
                        onChange: function(e) { onChange(model.id, e.target.value) },
                      },
                      React.createElement('option', { value: '', disabled: true }, '未设置（按顺位最低档）'),
                      offered.map(function(option) {
                        return React.createElement('option', { key: option.id, value: option.id }, option.label)
                      })))
              }),
        msg !== null
          ? React.createElement('div', {
              className: 'atf-ed-msg',
              role: 'status',
              style: msg.kind === 'err' ? { color: 'var(--dsw-alias-state-danger-label,#b91c1c)' } : undefined,
            }, msg.text)
          : null)
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
            '.atf-pill-dis{opacity:.5;cursor:not-allowed;}',
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
            // 批次 R H1-1：TokenBudget 三要素区（relation violations 红字——DSH 静态红 token，亮暗主题同源）
            '.atf-train-budget{margin-top:8px;padding-top:6px;border-top:1px solid rgba(128,128,128,.25);}',
            '.atf-train-budget .atf-train-row{grid-template-columns:1fr;}',
            '.atf-train-budget-viol{color:var(--dsw-static-red-500,#dc2626);font-size:12px;font-weight:600;padding:2px 0;}',
            '.atf-train-actions{display:flex;gap:10px;align-items:center;}',
            // H5：联合训练字段编辑对话框（按类 tab＋goods/non_goods 分组＋导入区）
            '.atf-joint-frame{width:min(920px,96vw);}',
            '.atf-joint-target{display:flex;gap:14px;flex-wrap:wrap;align-items:center;}',
            '.atf-joint-target label{display:flex;gap:6px;align-items:center;}',
            '.atf-joint-tabs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}',
            '.atf-joint-tab-active{outline:2px solid var(--dsw-alias-brand-primary,#1d4ed8);}',
            '.atf-joint-class{display:flex;flex-direction:column;gap:6px;border:1px solid rgba(128,128,128,.2);border-radius:8px;padding:8px;}',
            '.atf-joint-class-head{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}',
            '.atf-joint-class-head input,.atf-joint-class-head select{font-size:12px;padding:2px 6px;}',
            '.atf-joint-group{display:flex;flex-direction:column;gap:4px;}',
            '.atf-joint-group-head{display:flex;gap:8px;align-items:baseline;}',
            '.atf-joint-field{display:grid;grid-template-columns:auto minmax(110px,auto) minmax(70px,auto) 1fr auto auto;gap:6px;align-items:center;padding:2px 0;border-bottom:1px dashed rgba(128,128,128,.12);}',
            '.atf-joint-field input[type="text"],.atf-joint-field input:not([type]),.atf-joint-field select{font-size:12px;padding:2px 4px;}',
            '.atf-joint-import{display:flex;flex-direction:column;gap:4px;border-top:1px dashed rgba(128,128,128,.2);padding-top:6px;}',
            '.atf-joint-import-actions{display:flex;gap:10px;align-items:center;}',
            '.atf-joint-err{color:var(--dsw-static-red-500);}',
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
            // 批甲-FIX T2.1：设置页 provider-card per-model 默认档座位（排版随卡面；色彩走 token）
            '.atf-ed-block{border-top:1px dashed rgba(128,128,128,.25);margin-top:10px;padding-top:8px;}',
            '.atf-ed-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1e293b);}',
            '.atf-ed-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#64748b);margin:3px 0;}',
            '.atf-ed-row{display:flex;align-items:center;gap:10px;padding:3px 0;font-size:12px;}',
            '.atf-ed-model{flex:none;min-width:130px;color:var(--dsw-alias-label-primary,#1e293b);}',
            '.atf-ed-select{font-size:12px;padding:2px 6px;border-radius:6px;border:1px solid rgba(128,128,128,.35);',
            '  background:transparent;color:inherit;}',
            '.atf-ed-msg{font-size:11px;margin-top:5px;color:var(--dsw-alias-state-success-label,#15803d);}',
            // 批甲-FIX2（档位入口单一化）：vendor 座位 effort 文本 span 隐藏——css-modules
            // 语义段子串选择器（构建哈希前缀免疫）；档位唯一入口＝「思考」控件。
            '[class*="triggerEffort"]{display:none!important;}',
            // 目录结构 v1：工作区目录丢失卡（amber 告警面——token 退化色随宿主主题）
            '.atf-lost-ws{border:1px solid rgba(180,120,20,.45);background:rgba(180,120,20,.08);',
            '  border-radius:8px;padding:6px 10px;margin:0 0 6px;font-size:12px;}',
            '.atf-lost-ws-title{font-weight:600;color:var(--dsw-alias-state-warning-label,#92400e);margin-bottom:3px;}',
            '.atf-lost-ws-row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;}',
            '.atf-lost-ws-path{font-family:monospace;color:var(--dsw-alias-state-warning-label,#92400e);word-break:break-all;}',
            '.atf-lost-ws-meta{color:var(--dsw-alias-label-tertiary,#64748b);}',
            // ── D11-2 运行监控面板（UI 稿 v2——色板走 DSH token 退化链，非硬编码主题）──
            // D17§C：root 撑满 pane 高度并自滚（height:100%+min-height:0 破 flex 收缩死锁；
            // overscroll-behavior:contain 防滚动链穿透宿主页）——布局与区块顺序零改。
            '.atf-m-root{display:flex;flex-direction:column;padding:10px 12px 14px;gap:8px;height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain;}',
            '.atf-m-skel{background:rgba(128,128,128,.12);border-radius:8px;animation:atf-skel 1.2s ease-in-out infinite;}',
            '@keyframes atf-skel{0%,100%{opacity:.55}50%{opacity:1}}',
            '.atf-m-skel-title{height:20px;width:40%;margin:6px 0 10px;}',
            '.atf-m-skel-row{height:44px;margin-bottom:8px;}',
            '.atf-m-skel-block{height:120px;}',
            '.atf-m-skel-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#64748b);margin-top:8px;}',
            '.atf-m-head{display:flex;align-items:flex-start;gap:8px;}',
            '.atf-m-title{font-weight:600;font-size:14px;color:var(--dsw-alias-label-primary,#1e293b);}',
            '.atf-m-status{display:flex;align-items:center;gap:6px;font-size:12px;margin-top:5px;color:var(--dsw-alias-label-secondary,#64748b);}',
            '.atf-m-status.atf-status-active{color:var(--dsw-static-green-500,#16a34a);}',
            '.atf-m-status.atf-status-fail{color:var(--dsw-static-red-500);}',
            '.atf-m-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-static-neutral-400,#94a3b8);flex:none;}',
            '.atf-status-active .atf-m-dot{background:var(--dsw-static-green-500,#16a34a);box-shadow:0 0 0 3px rgba(22,163,74,.12);}',
            '.atf-status-fail .atf-m-dot{background:var(--dsw-static-red-500);box-shadow:0 0 0 3px rgba(220,38,38,.12);}',
            '.atf-m-eta{color:var(--dsw-alias-label-tertiary,#64748b);}',
            '.atf-m-stale{margin-left:6px;font-size:10.5px;padding:1px 7px;border-radius:8px;',
            '  border:1px solid var(--dsw-static-amber-500);color:var(--dsw-static-amber-500);font-weight:600;}',
            '.atf-m-runbox{margin-left:auto;display:flex;align-items:center;gap:6px;}',
            '.atf-m-guide{border:1px dashed rgba(128,128,128,.3);border-radius:10px;padding:18px 12px;font-size:12px;',
            '  color:var(--dsw-alias-label-secondary,#64748b);text-align:center;}',
            '.atf-m-guide-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#64748b);margin-top:6px;}',
            '.atf-m-probe{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;font-size:12px;',
            '  border:1px solid rgba(128,128,128,.2);border-radius:8px;}',
            '.atf-m-chip{flex:none;font-size:10px;line-height:14px;padding:0 6px;border-radius:7px;',
            '  border:1px solid var(--dsw-alias-brand-primary,#1d4ed8);color:var(--dsw-alias-brand-primary,#1d4ed8);font-weight:600;}',
            '.atf-cmp-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#64748b);padding:2px 8px 6px;}',
            '.atf-m-segments{display:flex;align-items:flex-start;gap:2px;padding:4px 0 8px;border-bottom:1px solid rgba(128,128,128,.15);}',
            '.atf-m-seg{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;position:relative;}',
            '.atf-m-seg-node{width:13px;height:13px;border-radius:50%;border:2px solid rgba(128,128,128,.35);background:transparent;position:relative;z-index:1;}',
            '.atf-m-seg.done .atf-m-seg-node{border-color:var(--dsw-static-green-500,#16a34a);background:var(--dsw-static-green-500,#16a34a);}',
            '.atf-m-seg.active .atf-m-seg-node{border-color:var(--dsw-alias-brand-primary,#1d4ed8);background:var(--dsw-alias-bg-layer-1,#fff);}',
            '.atf-m-seg.active .atf-m-seg-node::after{content:"";position:absolute;inset:2.5px;border-radius:50%;background:var(--dsw-alias-brand-primary,#1d4ed8);}',
            '.atf-m-seg.failed .atf-m-seg-node{border-color:var(--dsw-static-red-500);background:var(--dsw-static-red-500);}',
            '.atf-m-seg:not(:last-child)::after{content:"";position:absolute;top:5.5px;left:50%;width:100%;height:2px;background:rgba(128,128,128,.18);z-index:0;}',
            '.atf-m-seg.done:not(:last-child)::after{background:rgba(22,163,74,.35);}',
            '.atf-m-seg-lbl{font-size:9px;color:var(--dsw-alias-label-tertiary,#64748b);white-space:nowrap;}',
            '.atf-m-seg.done .atf-m-seg-lbl,.atf-m-seg.active .atf-m-seg-lbl{color:var(--dsw-alias-label-secondary,#64748b);}',
            '.atf-m-seg.failed .atf-m-seg-lbl{color:var(--dsw-static-red-500);}',
            '.atf-m-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;padding:8px 0 0;}',
            // D11-2a：运行环境块（2×2 紧凑——基模型/数据集/并行/通道；长值 ellipsis＋title 全文）
            '.atf-env-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px 10px;}',
            '.atf-env-cell{border:1px solid rgba(128,128,128,.18);border-radius:7px;padding:4px 7px;min-width:0;}',
            '.atf-env-k{font-size:10px;color:var(--dsw-alias-label-tertiary,#64748b);margin-bottom:1px;}',
            '.atf-env-v{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary,#1e293b);',
            '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.atf-m-narrow .atf-m-kpis{grid-template-columns:repeat(2,1fr);}',
            '.atf-m-kpi{border:1px solid rgba(128,128,128,.18);border-radius:9px;padding:6px 8px;background:rgba(128,128,128,.04);}',
            '.atf-m-k{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#64748b);margin-bottom:2px;}',
            '.atf-m-v{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#1e293b);font-variant-numeric:tabular-nums;}',
            '.atf-m-v small{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#64748b);font-weight:400;margin-left:2px;}',
            '.atf-m-sec{border:1px solid rgba(128,128,128,.18);border-radius:9px;overflow:hidden;}',
            '.atf-m-sec-h{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid rgba(128,128,128,.15);background:rgba(128,128,128,.04);}',
            '.atf-sec-t{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#64748b);}',
            '.atf-sec-hint{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#64748b);}',
            '.atf-loss-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid rgba(128,128,128,.15);background:rgba(128,128,128,.04);}',
            '.atf-loss-toggle{margin-left:auto;display:flex;border:1px solid rgba(128,128,128,.3);border-radius:6px;overflow:hidden;}',
            '.atf-loss-toggle button{border:0;background:transparent;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#64748b);padding:2px 8px;cursor:pointer;}',
            '.atf-loss-toggle button.on{background:var(--dsw-alias-brand-primary,#1d4ed8);color:#fff;font-weight:600;}',
            '.atf-loss-chart{display:block;width:100%;height:auto;padding:4px 4px 0;}',
            '.atf-chart-tick{font-size:9px;fill:var(--dsw-alias-label-tertiary,#8a929c);}',
            '.atf-chart-hover{font-size:10px;fill:var(--dsw-alias-label-primary,#1e293b);font-weight:600;}',
            '.atf-loss-skeleton{padding:18px 10px;display:flex;flex-direction:column;gap:8px;align-items:center;}',
            '.atf-loss-skel-bar{width:80%;height:46px;border-radius:8px;background:rgba(128,128,128,.1);animation:atf-skel 1.2s ease-in-out infinite;}',
            '.atf-loss-skel-text{font-size:11px;color:var(--dsw-alias-label-tertiary,#64748b);}',
            '.atf-loss-legend{display:flex;gap:12px;padding:2px 10px 8px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#64748b);}',
            '.atf-loss-legend i{display:inline-block;width:14px;height:2px;margin-right:5px;vertical-align:middle;border-radius:1px;}',
            '.atf-lg-train{background:var(--atf-spark-util);}',
            '.atf-lg-eval{background:var(--atf-spark-mem);}',
            ':root{--atf-grid-line:rgba(128,128,128,.14);--atf-grid-axis:rgba(128,128,128,.32);',
            '  --atf-spark-util:var(--dsw-alias-brand-primary,#2563eb);--atf-spark-mem:#9db8f7;}',
            '.atf-gpu-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:8px;}',
            '.atf-gpu-grid.atf-gpu-grid-expanded{grid-template-columns:repeat(2,1fr);gap:8px;}',
            '.atf-m-narrow .atf-gpu-grid,.atf-m-narrow .atf-gpu-grid.atf-gpu-grid-expanded{grid-template-columns:repeat(2,1fr);gap:6px;}',
            '.atf-gpu-tile{border:1px solid rgba(128,128,128,.18);border-radius:7px;padding:6px;min-width:0;}',
            '.atf-gpu-tile.busy{border-color:rgba(37,99,235,.35);background:rgba(37,99,235,.05);}',
            '.atf-gpu-h{display:flex;align-items:baseline;gap:4px;font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1e293b);}',
            '.atf-gpu-pct{margin-left:auto;font-variant-numeric:tabular-nums;}',
            '.atf-gpu-bar{height:4px;border-radius:3px;background:rgba(128,128,128,.15);margin:4px 0 1px;overflow:hidden;}',
            '.atf-gpu-bar>i{display:block;height:100%;background:var(--atf-spark-util);}',
            '.atf-gpu-bar.mem>i{background:var(--atf-spark-mem);}',
            '.atf-gpu-meta{display:flex;justify-content:space-between;font-size:9px;color:var(--dsw-alias-label-tertiary,#64748b);margin-top:3px;}',
            '.atf-gpu-empty,.atf-art2-empty{padding:14px 10px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#64748b);}',
            '.atf-gpu-more{display:flex;justify-content:center;padding:0 8px 8px;}',
            '.atf-gpu-more button{border:0;background:transparent;color:var(--dsw-alias-brand-primary,#1d4ed8);font-size:10.5px;cursor:pointer;}',
            '.atf-gpu-spark{display:block;margin-top:5px;border-top:1px dashed rgba(128,128,128,.2);padding-top:5px;}',
            '.atf-spark-svg{display:block;width:100%;height:22px;}',
            '.atf-gpu-nohist{font-size:9.5px;color:var(--dsw-alias-label-tertiary,#64748b);height:22px;display:flex;align-items:center;}',
            '.atf-gpu-proc{font-size:9.5px;color:var(--dsw-alias-label-secondary,#64748b);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
            '.atf-art2-list{display:flex;flex-direction:column;padding:2px 0 4px;}',
            '.atf-art2-row{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:11.5px;cursor:pointer;}',
            '.atf-art2-row:hover{background:rgba(128,128,128,.08);}',
            '.atf-art2-ico{width:18px;height:18px;border-radius:5px;background:rgba(37,99,235,.12);color:var(--dsw-alias-brand-primary,#1d4ed8);',
            '  display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;flex:none;}',
            '.atf-art2-nm{color:var(--dsw-alias-label-primary,#1e293b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.atf-art2-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary,#64748b);font-size:10px;flex:none;}',
            '.atf-art2-go{color:var(--dsw-alias-label-tertiary,#64748b);font-size:12px;flex:none;}',
            '.atf-m-logs{height:96px;overflow:auto;background:rgba(128,128,128,.07);color:var(--dsw-alias-label-secondary,#334155);',
            '  font-family:"SFMono-Regular",Consolas,Menlo,monospace;font-size:10px;line-height:1.55;padding:7px 10px;white-space:pre-wrap;word-break:break-all;}',
            '.atf-m-foot{font-size:10px;color:var(--dsw-alias-label-tertiary,#64748b);padding:2px 2px 0;}',
            // ── 批B2：绑定 chip＋共用选择面板＋监控头部 run 行/全部横幅/未绑定空态 ──
            '.atf-bchip-state{display:inline-flex;align-items:center;}',
            '.atf-bchip-skel{letter-spacing:2px;color:var(--dsw-alias-label-tertiary,#64748b);animation:atf-skel 1.2s ease-in-out infinite;}',
            '.atf-bchip-ws{margin-left:6px;font-size:10px;line-height:16px;padding:0 6px;border-radius:7px;flex:none;',
            '  border:1px solid rgba(128,128,128,.35);color:var(--dsw-alias-label-secondary,#64748b);font-weight:600;}',
            '.atf-bp{width:min(420px,94vw);max-height:72vh;overflow:auto;display:flex;flex-direction:column;gap:6px;',
            '  background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid rgba(128,128,128,.3);border-radius:12px;',
            '  box-shadow:0 14px 44px rgba(0,0,0,.22);padding:8px;font-size:12px;}',
            '.atf-bp-h{display:flex;align-items:center;justify-content:space-between;padding:2px 4px;}',
            '.atf-bp-hint{color:var(--dsw-alias-label-tertiary,#64748b);padding:0 4px;}',
            '.atf-bp-group{display:flex;flex-direction:column;}',
            '.atf-bp-gh{font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-tertiary,#64748b);padding:5px 4px 2px;}',
            '.atf-bp-row{display:flex;align-items:center;gap:4px;}',
            '.atf-bp-main{flex:1;min-width:0;display:flex;align-items:center;gap:8px;border:0;background:transparent;',
            '  color:inherit;text-align:left;padding:6px 6px;border-radius:8px;cursor:pointer;font-size:12px;}',
            '.atf-bp-main:hover:not(:disabled){background:rgba(128,128,128,.1);}',
            '.atf-bp-main:disabled{cursor:default;opacity:.9;}',
            '.atf-bp-ico{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary,#64748b);}',
            '.atf-bp-tcol{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}',
            '.atf-bp-title{color:var(--dsw-alias-label-primary,#1e293b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}',
            '.atf-bp-sub{color:var(--dsw-alias-label-tertiary,#64748b);font-family:monospace;font-size:10.5px;',
            '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.atf-bp-st{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary,#64748b);}',
            '.atf-bp-act{flex:none;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;',
            '  border-radius:7px;padding:2px 8px;font-size:11px;cursor:pointer;white-space:nowrap;}',
            '.atf-bp-act:disabled{opacity:.5;cursor:default;}',
            '.atf-bp-act:hover:not(:disabled){background:rgba(128,128,128,.1);}',
            '.atf-bp-warn{border:1px solid var(--dsw-static-amber-500);color:var(--dsw-alias-state-warning-label,#92400e);',
            '  border-radius:8px;padding:6px 8px;font-size:11.5px;margin:2px 4px;}',
            '.atf-bp-rename{display:flex;gap:6px;padding:2px 4px 6px;}',
            '.atf-bp-rename-in{flex:1;min-width:0;font-size:12px;padding:3px 8px;border-radius:7px;',
            '  border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;}',
            '.atf-bp-actions{display:flex;gap:8px;justify-content:flex-end;border-top:1px dashed rgba(128,128,128,.2);padding:6px 4px 2px;}',
            '.atf-bp-unbind{color:var(--dsw-alias-state-danger-label,#b91c1c);}',
            '.atf-bp-msg{padding:2px 4px;font-size:11.5px;}',
            // 监控头部 run 行（title 主行＋workspace·run_id 次行等宽——次行 title 属性可复制）
            '.atf-m-run{display:flex;align-items:baseline;gap:8px;margin-top:3px;font-size:13px;font-weight:600;',
            '  color:var(--dsw-alias-label-primary,#1e293b);overflow:hidden;}',
            '.atf-m-runmeta{font-size:10.5px;font-weight:400;color:var(--dsw-alias-label-tertiary,#64748b);',
            '  font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            // 全部模式只读横幅
            '.atf-m-ro{display:flex;align-items:center;gap:8px;border:1px dashed rgba(128,128,128,.35);',
            '  border-radius:8px;padding:5px 10px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#64748b);}',
            '.atf-m-ro-text{flex:1;min-width:0;}',
            '.atf-m-ro-bind{flex:none;border:1px solid var(--dsw-alias-brand-primary,#1d4ed8);',
            '  color:var(--dsw-alias-brand-primary,#1d4ed8);font-weight:600;background:transparent;}',
            // 未绑定空态（不渲染假 KPI/进度——只空态＋机器 GPU 一行）
            '.atf-m-empty{border:1px dashed rgba(128,128,128,.3);border-radius:10px;padding:14px 12px;',
            '  display:flex;flex-direction:column;gap:10px;}',
            '.atf-m-empty-t{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1e293b);}',
            '.atf-m-empty-last{display:flex;gap:8px;flex-wrap:wrap;}',
            '.atf-m-empty-sec{display:flex;flex-direction:column;gap:2px;}',
            '.atf-m-empty-h{font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-tertiary,#64748b);padding:2px 0;}',
            '.atf-m-empty-row{display:flex;align-items:center;gap:8px;border:0;background:transparent;color:inherit;',
            '  text-align:left;padding:5px 6px;border-radius:7px;cursor:pointer;font-size:12px;}',
            '.atf-m-empty-row:hover{background:rgba(128,128,128,.08);}',
            '.atf-m-empty-tt{font-weight:600;color:var(--dsw-alias-label-primary,#1e293b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.atf-m-empty-ws{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#64748b);flex:none;}',
            '.atf-m-empty-st{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary,#64748b);flex:none;}',
            '.atf-m-empty-actions{display:flex;gap:8px;flex-wrap:wrap;}',
            '.atf-m-empty-gpu{font-size:11px;color:var(--dsw-alias-label-tertiary,#64748b);',
            '  border-top:1px dashed rgba(128,128,128,.2);padding-top:8px;}',
            '.atf-m-empty-msg{font-size:11.5px;color:var(--dsw-alias-state-danger-label,#b91c1c);}',
            '.atf-m-empty .atf-m-empty-st.atf-status-active{color:var(--dsw-static-green-500,#16a34a);}',
            '.atf-m-empty .atf-m-empty-st.atf-status-fail{color:var(--dsw-static-red-500);}',
            '.atf-bp-st.atf-status-active,.atf-bp .atf-bp-st.atf-status-active{color:var(--dsw-static-green-500,#16a34a);}',
            '.atf-bp .atf-bp-st.atf-status-fail{color:var(--dsw-static-red-500);}',
          ].join('')
          document.head.append(style)
        }

        // 批甲-FIX2（档位入口单一化）：vendor 座位/菜单 effort 面 JS 覆写（vendor 源码零写入）。
        // ②座位 title/aria 净名（「X · Max」→「X」；aria 去「, reasoning effort …」尾段——仅值变化
        // 才写回，防 observer 自激）；③菜单「Effort/推理等级」drill cell 隐藏（en/zh 双语词条闭集——
        // 隐藏后 effort 列表 pane 无路径可达）。档位唯一入口＝「思考」控件；FIX 既有交付
        // （目录声明/三段取值链/sticky）零回退。rAF 合帧防抖。
        // 目录结构 v1（默认桶语义）：未归属会话桶的呈现文案「未分组/Ungrouped」→「任务/Task」。
        // 选择器形态 dev DOM 实锚（2026-10-16 W2b 微批，禁猜纪律）：组行容器
        // data-row-key 前缀 workspace:（未分组行实测＝空前缀 workspace:——源面 UNGROUPED_KEY
        // 空串，同前缀命中）；label span 实测类＝css-modules 哈希形（nzO69G_title——字面量
        // .title 永不匹配＝T2 缺口根因），取语义段子串 [class*="title"]（构建哈希免疫，沿
        // FIX2 [class*=triggerEffort] 同型先例）；搜索结果 meta span 实测 nzO69G_searchResultWorkspace
        // 同因改 [class*="searchResultWorkspace"]。改写谓词＝双语闭集精确匹配（仅值变化才
        // 写回，防 observer 自激）。
        if (typeof MutationObserver !== 'undefined') {
          var atfFix2Scheduled = false
          var atfFix2Sweep = function() {
            atfFix2Scheduled = false
            var seatAria = 'Select model'
            for (var btn of document.querySelectorAll('button[aria-label*="' + seatAria + '"]')) {
              var aria = btn.getAttribute('aria-label')
              if (aria && aria.indexOf(', reasoning effort') >= 0) btn.setAttribute('aria-label', aria.replace(/, reasoning effort[\s\S]*$/, ''))
              var title = btn.getAttribute('title')
              if (title && title.indexOf(' · ') >= 0) btn.setAttribute('title', title.split(' · ')[0])
            }
            var labels = ['Effort', '推理等级']
            for (var cell of document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')) {
              if (cell.offsetParent === null) continue
              var first = (cell.innerText || '').split('\n')[0].trim()
              if (labels.indexOf(first) >= 0 && cell.style.display !== 'none') cell.style.display = 'none'
            }
            var taskLabel = { '未分组': '任务', 'Ungrouped': 'Task' }
            var labelSpans = document.querySelectorAll('[data-row-key^="workspace:"] [class*="title"], [class*="searchResultWorkspace"]')
            for (var ls = 0; ls < labelSpans.length; ls++) {
              var span = labelSpans[ls]
              var text = (span.textContent || '').trim()
              var replacement = taskLabel[text]
              if (replacement !== undefined && span.textContent !== replacement) span.textContent = replacement
            }
          }
          var atfFix2Schedule = function() {
            if (atfFix2Scheduled) return
            atfFix2Scheduled = true
            requestAnimationFrame(atfFix2Sweep)
          }
          new MutationObserver(atfFix2Schedule).observe(document.documentElement, {
            childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'title'],
          })
          atfFix2Schedule()
        }

        // D10.3 按 D10.2 归因更正：list 槽以 id 为 cell 键——缺 id 会共享 undefined cell 被选举
        // 静默丢；order 只影响排序。现行 vendor 对缺 id register 直接 throw。守卫＝fail-loud
        // 告警（console.error 点名槽与缺失字段）——不阻断注册与其他面。
        function listSlotOptions(opts) {
          if (typeof opts.id !== 'string' || opts.id === '') {
            console.error('[atf-ui] D10.1 守卫：list 槽注册缺 id（宿主 register 必拒）——' + String(opts.name))
          }
          return opts
        }

        // 「监控」开关（session-scoped：inject 工厂收 sessionId——批⑳实证通道；
        // 本处同时是 sessionId 进 store 的唯一捕获点）。D11-2：顶栏「GPU」按钮随 dock
        // 一行卡退役删除——GPU 并入监控面板区块（信息架构去重，设计件 §3）；顶栏只留「监控」。
        // 批B2：顶栏增绑定 chip（§二）——同一 inject 工厂捕获切会话：binding 先清空到
        // loading（chip 骨架不显旧会话值）再按新 sessionId 拉取（迟到响应按会话丢弃防串台）。
        ctx.slots.inject('conversation.session.header.utilities', function() {
          return ctx.slots.register(listSlotOptions({
            name: 'conversation.session.header.utilities',
            id: 'atf-monitor-pill',
            order: 900,
            inject: function(sessionId) {
              store.sessionId = sessionId
              if (binding.sessionId !== sessionId) {
                binding.resetFor(sessionId)
                void binding.load(sessionId)
              }
              // B2c：会话建立（首条消息发出、sessionId 出现）＝消费草稿 pending 恰一次——
              // POST 绑定→落账本（B1 语义零改）。pending 空＝零 POST（消费即清，不复燃）。
              if (sessionId !== undefined && binding.pending !== null) binding.consumePending(sessionId)
              return {}
            },
          }), function() {
            return React.createElement('div', { style: { display: 'flex', gap: 6 } },
              React.createElement(BindingChip),
              React.createElement(MonitorTogglePill))
              // D11-1：顶栏「设置」按钮随浮层退役删除——训练配置入口＝原生设置页
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
          // C1-1 live 修复留痕（D10.3 按 D10.2 归因更正）：id 为 cell 键必须显式带——order
          // 只影响排序非丢弃变量；id/order 两字段仍一并显式在位（注册实际值零变）。
          return ctx.slots.register(listSlotOptions({ name: 'conversation.composer.dock', id: 'atf-dock-row', order: 100 }), function() {
            return React.createElement('div', null,
              React.createElement(FloatingTaskCard),
              React.createElement(FloatingTaskCardExpanded),
              React.createElement(EvalNoticeStack),
              React.createElement(LostWorkspacesBanner),
              // 批B2 §五：胶囊行组件化（DockPillsRow——绑定状态驱动禁用/文案）
              React.createElement(DockPillsRow),
              React.createElement(ViewerOverlay),
              React.createElement(TrainDialog),
              // H5：联合训练字段编辑/导入对话框（与 TrainDialog 同槽并存——互斥由各自 store 键保证）
              React.createElement(JointTrainDialog))
              // 批㊶Q增补一：MonitorPanel 卸离 dock——pane body（MonitorBody）唯一挂载；
              // dock 遗留挂载曾是 fixed 全高条假 pane 的载体（遮挡根因，见 MonitorBody 注）
              // D11-1：SettingsPanel 卸离 dock——训练配置迁原生设置页（settings.section）
              // D11-2：GpuCard 卸离 dock——GPU 并入监控面板区块（信息架构去重，设计件 §3）
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
            return scope.slots.register(listSlotOptions({
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
            }), function(injected) {
              if (injected === null) return null
              return React.createElement(EffortSelect, injected)
            })
          })
        })

        // 批甲-FIX T2.1：Models 设置页 per-model 默认思考档座位（产品层实施——vendor 零写入）。
        // settings.models.provider-card＝keyed 槽，owner 按 settingsNs 分发（glm-atf 路由＝
        // 'llm-pi-ai'——pi-ai 适配器 directoryEntries settingsPath ['providers', <route>] 同源）；
        // owner props {provider, configured, keyConfigured}。声明感知：slots.inject 工厂在该槽
        // 声明在位时才执行 register（免疫加载时序）；非 glm-atf 卡不渲染（组件自守卫）。
        // 链中段预取：apply 即拉 effort_defaults（composer 首帧链值就位，免最低档闪一拍）。
        loadEffortDefaults()
        ctx.inject(['slots', 'remote', 'remote.session'], function(scope) {
          remoteSessionFace = (scope.remote && scope.remote.session) ? scope.remote.session : null
          scope.slots.inject('settings.models.provider-card', function() {
            return scope.slots.register({
              name: 'settings.models.provider-card',
              key: 'llm-pi-ai',
            }, function(props) {
              return React.createElement(ProviderModelDefaultsBody, props)
            })
          })
        })

        // D11-1：训练配置页迁原生设置（settings.section list 槽——声明感知 inject，免疫加载
        // 时序）。id atf-training-config／order 900（靠后不挤占内置页）／label 训练配置。
        // 顶栏「设置」按钮与自搓浮层（SettingsPanel/store.settings）已退役删除；四分组整体
        // 搬移，数据 API 零变（GET/POST /atf-ui/settings，请求体 {storage:{...}} 逐字沿用）。
        ctx.slots.inject('settings.section', function() {
          return ctx.slots.register(listSlotOptions({
            name: 'settings.section', id: 'atf-training-config', order: 900, label: '训练配置',
          }), function() { return React.createElement(TrainingConfigSection) })
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

        // B2c：草稿态「回到上次实验」卡＋业务通报条（shell.overlay——root 域 list 槽，
        // 全帧浮层位 additive 零遮蔽；选型理由见 DraftResumeCard 注）。组件自守卫：
        // 有会话＝全 null（零渲染），不影响会话态任何画面。
        ctx.slots.inject('shell.overlay', function() {
          return ctx.slots.register(listSlotOptions({
            name: 'shell.overlay', id: 'atf-draft-resume', order: 900,
          }), function() {
            return React.createElement('div', null,
              React.createElement(DraftResumeCard),
              React.createElement(DraftToast))
          })
        })
      },
    }
  },
})
