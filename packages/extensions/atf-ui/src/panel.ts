/** atf-ui 面板页（自包含 HTML——三定制组件：分段监控/训练曲线/产物抽屉；零外部依赖）。 */
export const PANEL_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ATF 训练 Agent · 分段监控与产物</title>
<!-- 数据内嵌（atf-ui 同步器每次 tick 重写本文件）——file:// 直开即用 -->
<script type="application/json" id="atf-data">__ATF_DATA_JSON__</script>
<style>
:root { --border:#e2e8f0; --blue:#1d4ed8; --amber:#b45309; --amber-bg:#fef3c7; --sub:#64748b; --text:#1e293b; }
* { box-sizing: border-box; }
body { margin:0; font-family:"PingFang SC","Microsoft YaHei",sans-serif; color:var(--text); background:#f8fafc; }
#layout { display:grid; grid-template-columns: 1fr 1fr; gap:14px; padding:14px; max-width:1100px; margin:0 auto; }
.card { background:#fff; border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin-bottom:12px; }
.title { font-weight:600; font-size:15px; margin:0 0 8px; }
.dim { color:var(--sub); font-size:11px; }
.seg-row { display:flex; gap:6px; margin:8px 0; }
.seg-card { flex:1; border:1px solid var(--border); border-radius:8px; padding:6px 8px; text-align:center; font-size:12px; }
.seg-card.lit { border-color:var(--blue); background:#eff6ff; color:var(--blue); }
.seg-card.dimc { opacity:.5; }
.seg-state { display:block; font-size:10px; }
.idle { color:var(--amber); background:var(--amber-bg); border-radius:8px; padding:8px 10px; margin:8px 0; font-size:12px; }
.pct { font-size:24px; font-weight:700; }
.tabs { display:flex; gap:6px; margin:8px 0; }
.tab { border:1px solid var(--border); background:#fff; border-radius:999px; padding:2px 10px; cursor:pointer; font-size:11px; }
.tab.active { background:var(--blue); color:#fff; border-color:var(--blue); }
svg.chart { width:100%; height:90px; border:1px dashed var(--border); border-radius:6px; background:#fff; }
.legend { display:flex; gap:12px; font-size:10px; color:var(--sub); margin:4px 0 8px; }
.swatch { display:inline-block; width:12px; height:3px; vertical-align:middle; margin-right:4px; }
.kpi-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.kpi-card { border:1px solid var(--border); border-radius:8px; padding:6px 8px; }
.kpi-label { font-size:10px; color:var(--sub); }
.kpi-value { font-size:15px; font-weight:600; }
.art-run { border:1px solid var(--border); border-radius:8px; padding:6px 10px; margin-bottom:8px; }
.art-head { font-weight:600; margin-bottom:4px; font-size:12px; }
.art-row { display:flex; justify-content:space-between; align-items:center; padding:3px 0; font-size:12px; border-bottom:1px dashed #f1f5f9; }
.art-row:last-child { border-bottom:0; }
.btn { border:1px solid var(--border); background:#fff; border-radius:6px; padding:2px 10px; cursor:pointer; font-size:11px; }
.run-select { border:1px solid var(--border); border-radius:6px; padding:3px 6px; font-size:12px; margin-bottom:6px; }
.head { display:flex; justify-content:space-between; align-items:baseline; padding:14px 14px 0; max-width:1100px; margin:0 auto; }
.head b { font-size:16px; }
.pending { font-size:11px; color:var(--sub); margin-top:6px; white-space:pre-wrap; }
</style>
</head>
<body>
<div class="head"><b>ATF 训练 Agent · 分段监控与产物</b><span class="dim" id="updated">加载中…</span></div>
<div id="layout">
  <div>
    <div class="card"><h3 class="title">分段监控</h3>
      <select id="run-select" class="run-select"></select>
      <div id="segments" class="seg-row"></div>
      <div id="training"></div>
    </div>
  </div>
  <div><div class="card"><h3 class="title">产物抽屉</h3><div id="artifacts"><div class="dim">加载中…</div></div></div></div>
</div>
<script>
const QUEUE_IDLE_TEXT = '等待训练启动 · DRY_RUN 已过 · 排队中';
const SEGMENTS = [['register','登记卡'],['split','切分卡'],['label_qc','体检卡'],['candidate','候选'],['publish','发布']];
const COLORS = { train_loss:'#1d4ed8', eval_loss:'#94a3b8', grad_norm:'#16a34a' };
const DASH = { train_loss:'', eval_loss:'4 3', grad_norm:'' };
let activeRun = '';
let tab = 'loss';
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
function lossPath(points, key, w, h) {
  const vs = points.map(p => p[key]).filter(v => typeof v === 'number');
  if (vs.length < 2) return null;
  const min = Math.min(...vs), max = Math.max(...vs), range = max - min || 1;
  return vs.map((v,i) => ((i/(vs.length-1))*w).toFixed(1) + ',' + (h-4-((v-min)/range)*(h-8)).toFixed(1)).join(' ');
}
function render(data) {
  const runs = (data.monitor && data.monitor.runs) || [];
  const sel = document.getElementById('run-select');
  if (sel.options.length !== runs.length) {
    sel.innerHTML = runs.map(r => '<option value="'+esc(r.run_id)+'">'+esc(r.run_id)+'</option>').join('');
  }
  if (!runs.find(r => r.run_id === activeRun)) activeRun = runs[0] ? runs[0].run_id : '';
  if (activeRun) sel.value = activeRun;
  const run = runs.find(r => r.run_id === activeRun) || runs[0];
  document.getElementById('segments').innerHTML = run
    ? run.segments.map(s => '<div class="seg-card '+(s.lit?'lit':'dimc')+'">'+esc(s.label)+'<span class="seg-state">'+(s.lit?'●':'·')+'</span></div>').join('')
    : '<div class="dim">（暂无 run）</div>';
  const points = run && Array.isArray(run.training.points) ? run.training.points : [];
  const training = document.getElementById('training');
  if (points.length === 0) {
    training.innerHTML = '<div class="idle">'+QUEUE_IDLE_TEXT+'</div>';
  } else {
    const keys = tab === 'loss' ? ['train_loss','eval_loss'] : ['grad_norm'];
    const paths = keys.map(k => { const p = lossPath(points, k, 300, 90); return p ? '<polyline points="'+p+'" fill="none" stroke="'+COLORS[k]+'" stroke-width="1.5"'+(DASH[k]?' stroke-dasharray="'+DASH[k]+'"':'')+'/>' : ''; }).join('');
    const last = points[points.length-1];
    const kpi = (label, v) => '<div class="kpi-card"><div class="kpi-label">'+label+'</div><div class="kpi-value">'+(v === undefined ? '—' : v)+'</div></div>';
    training.innerHTML = '<div class="pct">'+points.length+' 步</div>'
      + '<div class="tabs"><button class="tab'+(tab==='loss'?' active':'')+'" data-tab="loss">Loss 双线</button>'
      + '<button class="tab'+(tab==='grad'?' active':'')+'" data-tab="grad">梯度范数</button></div>'
      + '<svg class="chart" viewBox="0 0 300 90" preserveAspectRatio="none">'+paths+'</svg>'
      + '<div class="legend">'+keys.map(k => '<span><span class="swatch" style="background:'+COLORS[k]+'"></span>'+k+'</span>').join('')+'</div>'
      + '<div class="kpi-grid">'+kpi('train_loss', last.train_loss)+kpi('eval_loss', last.eval_loss)+kpi('learning_rate', last.learning_rate)+kpi('GPU 显存','—')+'</div>';
  }
  const artRuns = (data.artifacts && data.artifacts.runs) || [];
  document.getElementById('artifacts').innerHTML = artRuns.length === 0 ? '<div class="dim">（暂无产物）</div>'
    : artRuns.map(run => '<div class="art-run"><div class="art-head">run '+esc(run.run_id)+'</div>'
      + (run.artifacts.length === 0 ? '<div class="dim">（该 run 暂无产物）</div>'
        : run.artifacts.map(a => '<div class="art-row"><span>'+esc(a.name)+'</span>'
          + '<button class="btn" data-path="'+esc(a.path)+'" data-name="'+esc(a.name)+'">[预览]</button></div>').join(''))
      + '</div>').join('');
  document.getElementById('updated').textContent = '更新于 ' + new Date().toLocaleTimeString();
}
const DATA = JSON.parse(document.getElementById('atf-data').textContent || '{}');
function poll() { if (DATA !== null) render(DATA); }
document.getElementById('layout').addEventListener('click', (event) => {
  const tabBtn = event.target.closest('.tab');
  if (tabBtn !== null) { tab = tabBtn.dataset.tab; poll(); }
});
document.getElementById('run-select').addEventListener('change', (e) => { activeRun = e.target.value; poll(); });
window.addEventListener('load', poll);
</script>
</body>
</html>`;
