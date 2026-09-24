import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "paper-pulp-fermentation.json");
const port = Number(process.env.PORT || 3039);

// 批次规则：洗浆水量（升）不得少于纸浆量（斤）的倍数
const MIN_WATER_PER_PULP = 2;
// 批次规则：滤水浊度合格上限（度），高于二度转待复洗
const TURBIDITY_LIMIT = 2;
// 批次规则：换人两次合格复核的最小间隔（毫秒）
const REWASH_GAP_MS = 4 * 60 * 60 * 1000;

const seed = {
  "items": [
    {
      "code": "PF-001",
      "source": "构树皮",
      "vat": "三号缸",
      "days": 5,
      "pulpAmount": 120,
      "owner": "林素",
      "status": "发酵中",
      "logs": [
        {
          "at": "2026-06-15",
          "step": "观察",
          "note": "温度24.6，气味微酸，纤维开始松散",
          "abnormal": false
        }
      ]
    }
  ],
  "washings": [],
  "requisitions": []
};
const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["pulpAmount","纸浆量(斤)","number"],["owner","负责人","text"]];
const stages = ["入缸","发酵中","可抄纸","异常观察"];
const statLabels = ["入缸","发酵中","可抄纸","异常观察"];
const washStates = ["未洗浆","复核中","待复洗","可领用","已领完"];
const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  // 批次、洗浆记录、领用台账分开维护，老数据补齐空表
  db.items ||= [];
  db.washings ||= [];
  db.requisitions ||= [];
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId(prefix) { return prefix + "-" + Date.now(); }
function findItem(db, key) {
  return db.items.find(x => x.id === key || x.code === key);
}
function itemWashings(db, item) {
  return db.washings
    .filter(w => w.itemId === item.id || w.itemCode === item.code)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}
function itemRequisitions(db, item) {
  return db.requisitions
    .filter(r => r.itemId === item.id || r.itemCode === item.code)
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}
// 洗浆判定：水量不足或浊度高于二度均不合格
function judgeWashing(item, rec) {
  const enough = Number(rec.waterAmount) >= Number(item.pulpAmount || 0) * MIN_WATER_PER_PULP;
  const turbidityOk = Number(rec.turbidity) <= TURBIDITY_LIMIT;
  return { enough, turbidityOk, qualified: enough && turbidityOk };
}
// 领用许可：只看尚未被领用单核销（更正）的洗浆记录
function permitOf(db, item) {
  const usedWashIds = new Set(db.requisitions.flatMap(r => r.washIds || []));
  const active = itemWashings(db, item)
    .filter(w => !w.consumedBy && !usedWashIds.has(w.id));
  const remaining = remainingPulp(db, item);
  const result = { state: "未洗浆", active, remaining, pair: null, last: null, reasons: ["批次尚未登记洗浆复核"] };
  if (remaining <= 0 && db.requisitions.some(r => r.itemId === item.id || r.itemCode === item.code)) {
    return { ...result, state: "已领完", reasons: ["剩余浆量为零"] };
  }
  const last = active[active.length - 1];
  if (!last) return result;
  result.last = last;
  if (!last.qualified) {
    const reasons = [];
    if (!last.enough) reasons.push("洗浆水量不足（每斤浆不少于" + MIN_WATER_PER_PULP + "升）");
    if (!last.turbidityOk) reasons.push("滤水浊度高于" + TURBIDITY_LIMIT + "度");
    return { ...result, state: "待复洗", reasons };
  }
  if (active.length < 2 || !active[active.length - 2].qualified) {
    return { ...result, state: "复核中", reasons: ["已有1次浊度合格，尚需换人完成第2次合格复核"] };
  }
  const prev = active[active.length - 2];
  const diffOperator = prev.operator.trim() !== last.operator.trim();
  const gap = new Date(last.at) - new Date(prev.at);
  const gapOk = gap >= REWASH_GAP_MS;
  const reasons = [];
  if (!diffOperator) reasons.push("两次合格复核须由不同操作人完成（换人复核）");
  if (!gapOk) reasons.push("两次复核相隔不足4小时");
  if (diffOperator && gapOk) {
    return { ...result, state: "可领用", pair: [prev, last], reasons: ["两次换人复核浊度合格且相隔满4小时"] };
  }
  return { ...result, state: "复核中", reasons };
}
function remainingPulp(db, item) {
  const used = itemRequisitions(db, item).reduce((sum, r) => sum + Number(r.amount || 0), 0);
  return Number(item.pulpAmount || 0) - used;
}
function summarize(db, item) {
  const permit = permitOf(db, item);
  const taskLogs = (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return {
    ...item,
    logCount: (item.logs || []).length + taskLogs,
    remainingPulp: permit.remaining,
    washState: permit.state,
    permitReasons: permit.reasons,
    lastWash: permit.last ? {
      at: permit.last.at,
      operator: permit.last.operator,
      waterAmount: permit.last.waterAmount,
      turbidity: permit.last.turbidity,
      qualified: permit.last.qualified
    } : null
  };
}
function computeStats(db) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  const washStats = Object.fromEntries(washStates.map(label => [label, 0]));
  for (const item of db.items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
    washStats[permitOf(db, item).state] += 1;
  }
  return { ...stats, ...washStats };
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆发酵与洗浆领用</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { padding:0 28px 28px; }
    nav { display:flex; gap:8px; padding:16px 0 0; } nav button { background:#e4e9e1; color:var(--ink); } nav button.active { background:var(--accent); color:#fff; }
    .tabview { display:none; } .tabview.active { display:grid; grid-template-columns:380px 1fr; gap:22px; padding-top:18px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:150px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn,.bad { color:var(--warn); font-weight:700; } .ok { color:var(--accent); font-weight:700; }
    table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    th,td { border-bottom:1px solid var(--line); padding:9px 10px; text-align:left; font-size:13px; vertical-align:top; } th { background:#eef2eb; white-space:nowrap; }
    tr:last-child td { border-bottom:0; } .rule { background:#eef2eb; border:1px solid var(--line); border-radius:8px; padding:10px 12px; font-size:13px; color:var(--muted); margin-bottom:12px; line-height:1.7; }
    .hint { font-size:12px; color:var(--muted); margin-top:6px; line-height:1.6; } .row-actions { display:flex; gap:8px; } .row-actions button { flex:1; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} .tabview.active{grid-template-columns:1fr;} main{padding:0 16px 16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法纸浆发酵与洗浆领用</h1><div class="meta">批次规则 · 洗浆复核 · 领用台账，分开维护</div></div><button id="reload">刷新</button></header>
  <main>
    <nav>
      <button data-tab="batches" class="active">批次发酵</button>
      <button data-tab="wash">洗浆复核</button>
      <button data-tab="ledger">领用台账</button>
    </nav>

    <section class="tabview active" id="tab-batches">
      <div>
        <form id="createForm"><h2>新增纸浆批次</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存纸浆批次</button></form>
        <form id="actionForm" style="margin-top:14px"><h2>每日观察记录</h2><label>选择纸浆批次</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
      </div>
      <div>
        <div class="stats" id="stats"></div>
        <div class="toolbar">
          <select id="statusFilter"><option value="">全部状态</option>${stages.concat(["待复洗","可领用"]).map(s => '<option>'+s+'</option>').join('')}</select>
          <input id="search" placeholder="搜索编号或关键词">
        </div>
        <div class="panel"><h2>批次只记发酵天数与状态；洗浆水色逐缸复核，合格后方可领用。</h2><div class="grid" id="cards"></div></div>
      </div>
    </section>

    <section class="tabview" id="tab-wash">
      <div>
        <form id="washForm" class="panel">
          <h2>洗浆复核登记</h2>
          <div class="rule">进入「可抄纸」后逐缸登记洗浆水量、滤水浊度与操作人。<br>水量每斤浆不少于 ${MIN_WATER_PER_PULP} 升，浊度不高于 ${TURBIDITY_LIMIT} 度；任一不达标记为<b>待复洗</b>，不占领用量。<br>换人连续两次合格、相隔满 4 小时，批次才可领用。</div>
          <label>纸浆批次（仅可抄纸）</label><select name="item" id="washItem"></select>
          <label>洗浆水量（升）</label><input name="waterAmount" type="number" min="0" step="0.1" required>
          <label>滤水浊度（度）</label><input name="turbidity" type="number" min="0" step="0.1" required>
          <label>操作人</label><input name="operator" required>
          <label>复核时间（留空为当前）</label><input name="at" type="datetime-local">
          <div class="hint" id="washHint"></div>
          <button style="margin-top:10px">登记洗浆复核</button>
        </form>
      </div>
      <div>
        <div class="toolbar">
          <select id="washResultFilter"><option value="">全部结果</option><option value="qualified">合格</option><option value="failed">待复洗（不合格）</option></select>
          <select id="washItemFilter"><option value="">全部批次</option></select>
          <input id="washSearch" placeholder="搜索操作人或编号">
        </div>
        <div class="panel"><h2>洗浆记录</h2><div style="overflow:auto"><table id="washTable"></table></div></div>
      </div>
    </section>

    <section class="tabview" id="tab-ledger">
      <div>
        <form id="requisitionForm" class="panel">
          <h2>领用登记</h2>
          <div class="rule">换人连续两次浊度合格且相隔 4 小时方可领用；领用量不得超过剩余浆量。<br>领用后更正对应洗浆记录，原许可即失效，需重新复核；旧领用单长期可查。</div>
          <label>纸浆批次</label><select name="item" id="reqItem"></select>
          <div class="hint" id="reqHint"></div>
          <label>领用量（斤）</label><input name="amount" type="number" min="0" step="0.1" required>
          <label>领用人</label><input name="operator" required>
          <button style="margin-top:10px">开立领用单</button>
        </form>
      </div>
      <div>
        <div class="toolbar">
          <select id="reqItemFilter"><option value="">全部批次</option></select>
          <input id="reqSearch" placeholder="搜索单号、领用人或批次">
        </div>
        <div class="panel"><h2>领用台账（含历史旧单）</h2><div style="overflow:auto"><table id="reqTable"></table></div></div>
      </div>
    </section>
  </main>
  <script>
    const fields = ${JSON.stringify(fields)};
    const stages = ${JSON.stringify(stages)};
    const extraFields = ${JSON.stringify(extraFields)};
    const washStates = ${JSON.stringify(washStates)};
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const washForm = document.querySelector('#washForm');
    const requisitionForm = document.querySelector('#requisitionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [], washings = [], requisitions = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function esc(v) { return String(v ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
    function fmtAt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12:false }) : ''; }
    function itemOf(ref) { return items.find(i => (i.id || i.code) === ref || i.id === ref || i.code === ref); }
    function switchTab(name) {
      document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
      document.querySelectorAll('.tabview').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
    }
    document.querySelectorAll('nav button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function statePill(item) {
      const cls = item.washState === '待复洗' ? 'bad' : item.washState === '可领用' ? 'ok' : 'meta';
      return ' <span class="pill '+cls+'">洗浆：'+esc(item.washState)+'</span>';
    }
    function renderBatches() {
      itemSelect.innerHTML = items.map(item => '<option value="'+esc(item.id || item.code)+'">'+esc(item.code || item.id)+' · '+esc(item.name || item.source || '')+'</option>').join('');
      const counts = Object.fromEntries(stages.concat(washStates).map(s => [s, 0]));
      items.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1; counts[i.washState] += 1; });
      const show = ["入缸","发酵中","可抄纸","异常观察","待复洗","可领用"];
      statsEl.innerHTML = show.map(k => '<div class="stat"><span>'+k+'</span><strong>'+(counts[k] || 0)+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status || item.washState === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        try { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); }
        catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const note = prompt('记录备注'); if (note) { await api('/api/items/'+btn.dataset.note+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      document.querySelectorAll('[data-gowash]').forEach(btn => btn.onclick = () => { switchTab('wash'); document.querySelector('#washItem').value = btn.dataset.gowash; renderWashHint(); });
      document.querySelectorAll('[data-goreq]').forEach(btn => btn.onclick = () => { switchTab('ledger'); document.querySelector('#reqItem').value = btn.dataset.goreq; renderReqHint(); });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+esc(item[key] ?? '')+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+esc(l.step)+'：'+esc(l.note)+'</div>').join('');
      const ref = item.id || item.code;
      const last = item.lastWash ? '<div class="meta">末次洗浆：'+fmtAt(item.lastWash.at)+' · '+esc(item.lastWash.operator)+' · 水'+esc(item.lastWash.waterAmount)+'升 · 浊度'+esc(item.lastWash.turbidity)+'度 · '+(item.lastWash.qualified?'<span class="ok">合格</span>':'<span class="bad">待复洗</span>')+'</div>' : '<div class="meta">尚未登记洗浆复核</div>';
      return '<article class="card"><h3>'+esc(item.code || item.id)+'</h3><span class="pill">'+esc(item.status)+'</span>'+statePill(item)+main
        + '<div><b>纸浆量</b> '+esc(item.pulpAmount ?? '未登记')+' 斤　<b>剩余</b> '+esc(item.remainingPulp)+' 斤</div>'
        + last
        + '<label>发酵状态</label><select data-status="'+esc(ref)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'
        + '<div class="row-actions"><button class="secondary" data-gowash="'+esc(ref)+'">洗浆登记</button><button class="secondary" data-goreq="'+esc(ref)+'">领用登记</button><button class="secondary" data-note="'+esc(ref)+'">追加备注</button></div>'
        + '<div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function batchOptions(filterWash) {
      return items.filter(i => i.status === '可抄纸').map(i => '<option value="'+esc(i.id || i.code)+'">'+esc(i.code)+' · 剩'+esc(i.remainingPulp)+'斤 · '+esc(i.washState)+'</option>').join('');
    }
    function renderWashHint() {
      const item = itemOf(washForm.item.value);
      document.querySelector('#washHint').innerHTML = item ? '当前洗浆状态：<b>'+esc(item.washState)+'</b>；'+esc((item.permitReasons || []).join('；')) : '';
    }
    function renderWash() {
      document.querySelector('#washItem').innerHTML = batchOptions() || '<option value="">无可抄纸批次</option>';
      renderWashHint();
      const allBatches = '<option value="">全部批次</option>' + items.map(i => '<option value="'+esc(i.id || i.code)+'">'+esc(i.code || i.id)+'</option>').join('');
      document.querySelector('#washItemFilter').innerHTML = allBatches;
      const result = document.querySelector('#washResultFilter').value;
      const batchRef = document.querySelector('#washItemFilter').value;
      const q = document.querySelector('#washSearch').value.trim();
      const rows = washings
        .filter(w => !result || (result === 'qualified' ? w.qualified : !w.qualified))
        .filter(w => !batchRef || w.itemId === batchRef || w.itemCode === batchRef)
        .filter(w => !q || JSON.stringify(w).includes(q))
        .slice().reverse();
      const head = '<tr><th>复核时间</th><th>批次</th><th>操作人</th><th>水量(升)</th><th>浊度(度)</th><th>结果</th><th>许可状态</th></tr>';
      const body = rows.map(w => '<tr><td>'+fmtAt(w.at)+'</td><td>'+esc(w.itemCode || w.itemId)+'</td><td>'+esc(w.operator)+'</td><td>'+esc(w.waterAmount)+(w.enough?'':' <span class="bad">水量不足</span>')+'</td><td>'+esc(w.turbidity)+(w.turbidityOk?'':' <span class="bad">超二度</span>')+'</td><td>'+(w.qualified?'<span class="ok">合格</span>':'<span class="bad">待复洗</span>')+'</td><td class="meta">'+(w.consumedBy ? '已用于领用单 '+esc(w.consumedBy)+'，原许可失效' : '有效记录')+'</td></tr>').join('');
      document.querySelector('#washTable').innerHTML = head + (body || '<tr><td colspan="7" class="meta">暂无洗浆记录</td></tr>');
    }
    function renderReqHint() {
      const item = itemOf(requisitionForm.item.value);
      if (!item) { document.querySelector('#reqHint').textContent = ''; return; }
      const why = (item.permitReasons || []).join('；');
      document.querySelector('#reqHint').innerHTML = '剩余浆量 <b>'+esc(item.remainingPulp)+'</b> 斤；当前：<b class="'+(item.washState==='可领用'?'ok':item.washState==='待复洗'?'bad':'')+'">'+esc(item.washState)+'</b><br>'+esc(why);
    }
    function renderLedger() {
      document.querySelector('#reqItem').innerHTML = batchOptions() || '<option value="">无可抄纸批次</option>';
      renderReqHint();
      document.querySelector('#reqItemFilter').innerHTML = '<option value="">全部批次</option>' + items.map(i => '<option value="'+esc(i.id || i.code)+'">'+esc(i.code || i.id)+'</option>').join('');
      const batchRef = document.querySelector('#reqItemFilter').value;
      const q = document.querySelector('#reqSearch').value.trim();
      const rows = requisitions
        .filter(r => !batchRef || r.itemId === batchRef || r.itemCode === batchRef)
        .filter(r => !q || JSON.stringify(r).includes(q));
      const head = '<tr><th>领用单号</th><th>批次</th><th>领用时间</th><th>领用量(斤)</th><th>领用人</th><th>复核依据（换人两次合格）</th><th>领用后余额</th></tr>';
      const body = rows.map(r => {
        const basis = (r.washDetails || []).map(w => esc(w.operator)+' · 浊度'+esc(w.turbidity)+'度 · '+fmtAt(w.at)).join('<br>');
        return '<tr><td>'+esc(r.id)+'</td><td>'+esc(r.itemCode || r.itemId)+'</td><td>'+fmtAt(r.at)+'</td><td>'+esc(r.amount)+'</td><td>'+esc(r.operator)+'</td><td class="meta">'+(basis || '—')+'<br><span class="meta">许可已随单失效，旧单留存可查</span></td><td>'+esc(r.remainingAfter)+'</td></tr>';
      }).join('');
      document.querySelector('#reqTable').innerHTML = head + (body || '<tr><td colspan="7" class="meta">暂无领用记录</td></tr>');
    }
    function render() { renderBatches(); renderWash(); renderLedger(); }
    async function load() {
      [items, washings, requisitions] = await Promise.all([api('/api/items'), api('/api/washings'), api('/api/requisitions')]);
      render();
    }
    createForm.onsubmit = async event => {
      event.preventDefault();
      try { await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); }
      catch (e) { alert(e.message); }
    };
    actionForm.onsubmit = async event => {
      event.preventDefault();
      try { await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); }
      catch (e) { alert(e.message); }
    };
    washForm.onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(washForm).entries());
      try { await api('/api/washings', { method:'POST', body: JSON.stringify(data) }); washForm.reset(); await load(); renderWashHint(); }
      catch (e) { alert(e.message); }
    };
    requisitionForm.onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(requisitionForm).entries());
      try { await api('/api/requisitions', { method:'POST', body: JSON.stringify(data) }); requisitionForm.reset(); await load(); renderReqHint(); }
      catch (e) { alert(e.message); }
    };
    document.querySelector('#statusFilter').onchange = renderBatches;
    document.querySelector('#search').oninput = renderBatches;
    document.querySelector('#washResultFilter').onchange = renderWash;
    document.querySelector('#washItemFilter').onchange = renderWash;
    document.querySelector('#washSearch').oninput = renderWash;
    document.querySelector('#washItem').onchange = renderWashHint;
    document.querySelector('#reqItemFilter').onchange = renderLedger;
    document.querySelector('#reqSearch').oninput = renderLedger;
    document.querySelector('#reqItem').onchange = renderReqHint;
    document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") {
      return send(res, 200, db.items.map(item => summarize(db, item)));
    }
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      if (!input.code) return send(res, 400, { error: "批次编号必填" });
      const item = { id: newId("PF"), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建纸浆批次" }] };
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, summarize(db, item));
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findItem(db, patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      Object.assign(item, await body(req));
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, summarize(db, item));
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = findItem(db, log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, summarize(db, item));
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = findItem(db, action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      const abnormal = String(input.abnormal || "").includes("是") || String(input.abnormal || "").includes("有");
      item.observations ||= [];
      item.observations.push({ at: new Date().toISOString(), ...input, abnormal });
      item.days = Number(item.days || 0) + 1;
      item.status = abnormal ? "异常观察" : Number(item.days) >= 7 ? "可抄纸" : "发酵中";
      item.logs.push({ at: new Date().toISOString(), step: "观察", note: "温度" + (input.temperature || "") + "，" + (input.smell || "") + "，" + (input.fiber || "") });
      await saveDb(db);
      return send(res, 201, summarize(db, item));
    }

    // 洗浆记录（与批次分开维护）
    if (req.method === "GET" && url.pathname === "/api/washings") {
      let rows = db.washings.slice().sort((a, b) => new Date(b.at) - new Date(a.at));
      const itemRef = url.searchParams.get("item");
      if (itemRef) rows = rows.filter(w => w.itemId === itemRef || w.itemCode === itemRef);
      const result = url.searchParams.get("result");
      if (result === "qualified") rows = rows.filter(w => w.qualified);
      if (result === "failed") rows = rows.filter(w => !w.qualified);
      return send(res, 200, rows);
    }
    if (req.method === "POST" && url.pathname === "/api/washings") {
      const input = await body(req);
      const item = findItem(db, input.item || "");
      if (!item) return send(res, 404, { error: "批次不存在" });
      if (item.status !== "可抄纸") return send(res, 400, { error: "只有进入可抄纸的批次才能登记洗浆复核" });
      if (!Number.isFinite(Number(item.pulpAmount)) || Number(item.pulpAmount) <= 0) {
        return send(res, 400, { error: "批次未登记纸浆量，无法判定洗浆水量是否充足" });
      }
      const waterAmount = Number(input.waterAmount);
      const turbidity = Number(input.turbidity);
      const operator = String(input.operator || "").trim();
      if (!(waterAmount >= 0)) return send(res, 400, { error: "洗浆水量需为非负数字" });
      if (!(turbidity >= 0)) return send(res, 400, { error: "滤水浊度需为非负数字" });
      if (!operator) return send(res, 400, { error: "操作人必填" });
      const at = input.at ? new Date(input.at) : new Date();
      if (isNaN(at.getTime())) return send(res, 400, { error: "复核时间格式不正确" });
      const rec = {
        id: newId("XJ"),
        itemId: item.id,
        itemCode: item.code,
        at: at.toISOString(),
        waterAmount,
        turbidity,
        operator,
        ...judgeWashing(item, { waterAmount, turbidity })
      };
      db.washings.push(rec);
      await saveDb(db);
      return send(res, 201, { washing: rec, washState: permitOf(db, item).state });
    }

    // 领用台账（与批次、洗浆记录分开维护，旧单永久保留）
    if (req.method === "GET" && url.pathname === "/api/requisitions") {
      let rows = db.requisitions.slice().sort((a, b) => new Date(b.at) - new Date(a.at));
      const itemRef = url.searchParams.get("item");
      if (itemRef) rows = rows.filter(r => r.itemId === itemRef || r.itemCode === itemRef);
      return send(res, 200, rows);
    }
    if (req.method === "POST" && url.pathname === "/api/requisitions") {
      const input = await body(req);
      const item = findItem(db, input.item || "");
      if (!item) return send(res, 404, { error: "批次不存在" });
      if (item.status !== "可抄纸") return send(res, 400, { error: "只有可抄纸批次可以领用" });
      const permit = permitOf(db, item);
      if (permit.state !== "可领用") return send(res, 400, { error: "暂不可领用：" + permit.reasons.join("；") });
      const amount = Number(input.amount);
      const operator = String(input.operator || "").trim();
      if (!(amount > 0)) return send(res, 400, { error: "领用量需大于0" });
      if (!operator) return send(res, 400, { error: "领用人必填" });
      if (amount > permit.remaining) return send(res, 400, { error: "领用量不能超过剩余浆量（剩余" + permit.remaining + "斤）" });
      const slip = {
        id: newId("LY"),
        itemId: item.id,
        itemCode: item.code,
        at: new Date().toISOString(),
        amount,
        operator,
        washIds: permit.pair.map(w => w.id),
        washDetails: permit.pair.map(w => ({ at: w.at, operator: w.operator, turbidity: w.turbidity, waterAmount: w.waterAmount })),
        remainingAfter: permit.remaining - amount
      };
      db.requisitions.push(slip);
      // 领用后更正洗浆记录：两次合格记录随单核销，原许可失效
      for (const w of permit.pair) {
        const rec = db.washings.find(x => x.id === w.id);
        if (rec) {
          rec.consumedBy = slip.id;
          rec.correctedNote = "已用于领用单 " + slip.id + "，原许可失效";
        }
      }
      await saveDb(db);
      return send(res, 201, slip);
    }

    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法纸浆发酵与洗浆领用 listening on http://localhost:" + port));
