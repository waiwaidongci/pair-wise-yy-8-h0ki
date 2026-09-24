import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "paper-pulp-fermentation.json");
const port = Number(process.env.PORT || 3039);

const ruleDefaults = {
  minWaterVolume: 120,   // 每缸最低洗浆水量（升），低于即水量不足
  turbidityLimit: 2,     // 滤水浊度上限（度），高于二度判不合格
  qualifyChecks: 2,      // 领用前需要的连续合格复核次数
  qualifyGapHours: 4,    // 两次复核最少相隔小时数
  requireDifferentOperator: true // 连续复核须换人
};

const seed = {
  "items": [
    {
      "code": "PF-001",
      "source": "构树皮",
      "vat": "三号缸",
      "days": 5,
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
  ]
};

// 演示数据：进入可抄纸后逐缸洗浆，一缸已满足换人双复核，一缸待复洗
const demoWashSeed = {
  item: {
    code: "PF-002",
    source: "构树皮",
    vat: "五号缸",
    days: 9,
    owner: "周茂",
    pulpAmount: 260,
    status: "可抄纸",
    logs: [{ at: "2026-09-22T18:00:00", step: "状态", note: "发酵9天，进入可抄纸" }]
  },
  washes: [
    { id: "W-demo-2a", batchCode: "PF-002", vat: "五号缸", at: "2026-09-23T08:10:00", waterVolume: 180, turbidity: 1.2, operator: "林素", result: "合格", reason: "" },
    { id: "W-demo-2b", batchCode: "PF-002", vat: "五号缸", at: "2026-09-23T13:20:00", waterVolume: 200, turbidity: 0.8, operator: "周茂", result: "合格", reason: "" }
  ]
};
const demoRewashSeed = {
  item: {
    code: "PF-003",
    source: "竹浆",
    vat: "七号缸",
    days: 8,
    owner: "陈浦",
    pulpAmount: 180,
    status: "可抄纸",
    logs: [{ at: "2026-09-22T19:00:00", step: "状态", note: "发酵8天，进入可抄纸" }]
  },
  washes: [
    { id: "W-demo-3a", batchCode: "PF-003", vat: "七号缸", at: "2026-09-23T15:00:00", waterVolume: 90, turbidity: 2.6, operator: "陈浦", result: "不合格", reason: "水量不足（低于120升）；浊度超限（高于二度）" }
  ]
};

const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["pulpAmount","入缸浆量(公斤)","number"],["owner","负责人","text"]];
const stages = ["入缸","发酵中","可抄纸","异常观察"];
const statLabels = ["入缸","发酵中","可抄纸","异常观察"];
const washStates = ["待复洗", "可领用", "待复核", "已领完", "未到复核"];
const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  let changed = false;
  if (!db.rules) { db.rules = { ...ruleDefaults }; changed = true; }
  if (!Array.isArray(db.washes)) { db.washes = []; changed = true; }
  if (!Array.isArray(db.requisitions)) { db.requisitions = []; changed = true; }
  if (!db.items.some(i => i.code === demoWashSeed.item.code)) {
    db.items.push(demoWashSeed.item, demoRewashSeed.item);
    db.washes.push(...demoWashSeed.washes, ...demoRewashSeed.washes);
    changed = true;
  }
  if (changed) await writeFile(dbPath, JSON.stringify(db, null, 2));
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
function fail(res, status, error, message) { return send(res, status, { error, message }); }
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId(prefix) { return prefix + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6); }
function toTime(value) {
  if (!value) return Date.now();
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
}
function findItem(db, key) { return db.items.find(x => x.id === key || x.code === key); }

// 洗浆复核结论：完全由洗浆记录、领用台账和批次规则推算，不回写发酵状态
function summarizeWash(item, washes, slips, rules) {
  // 合格与否按当前批次规则即时判定（水量/浊度阈值可调），登记时的结论保留在记录中
  const isPass = r => r.waterVolume >= rules.minWaterVolume && r.turbidity <= rules.turbidityLimit;
  const recs = washes
    .filter(w => w.batchCode === item.code)
    .map(w => ({ ...w, currentPass: isPass(w), time: new Date(w.at).getTime() }))
    .sort((a, b) => a.time - b.time);
  const mySlips = slips
    .filter(r => r.batchCode === item.code)
    .map(r => ({ ...r, time: new Date(r.at).getTime() }))
    .sort((a, b) => a.time - b.time);
  const pulpAmount = item.pulpAmount === undefined || item.pulpAmount === "" ? null : Number(item.pulpAmount);
  const usedPulp = mySlips.reduce((n, r) => n + Number(r.amount || 0), 0);
  const remaining = pulpAmount === null ? null : pulpAmount - usedPulp;
  const lastSlip = mySlips.at(-1);

  // 领用后原许可失效：只统计上次领用之后的复核；在当前规则下合格的记录上滑动查找连续 k 次且换人、间隔达标的窗口
  const pool = recs.filter(r => (!lastSlip || r.time > lastSlip.time) && r.currentPass);
  const k = Math.max(1, Math.trunc(Number(rules.qualifyChecks) || 1));
  let ready = false;
  let gapHours = null;
  let chain = [];
  const windowOk = (w) => {
    if (rules.requireDifferentOperator) {
      for (let i = 1; i < w.length; i += 1) {
        if (w[i].operator === w[i - 1].operator) return false;
      }
    }
    const span = k === 1 ? 0 : (w[k - 1].time - w[0].time) / 36e5;
    return k === 1 || span + 1e-9 >= Number(rules.qualifyGapHours);
  };
  for (let i = 0; i + k <= pool.length; i += 1) {
    const w = pool.slice(i, i + k);
    if (windowOk(w)) { ready = true; chain = w; gapHours = k === 1 ? 0 : (w[k - 1].time - w[0].time) / 36e5; }
  }
  if (!ready && pool.length) {
    chain = pool.slice(-k);
    gapHours = k === 1 ? 0 : (chain[Math.min(k - 1, chain.length - 1)].time - chain[0].time) / 36e5;
  }

  const latest = recs.at(-1) || null;
  const reasons = [];
  let state;
  if (item.status !== "可抄纸") {
    state = "未到复核";
    reasons.push("批次尚未进入可抄纸");
  } else if (latest && !latest.currentPass) {
    state = "待复洗";
    const why = [];
    if (latest.waterVolume < rules.minWaterVolume) why.push("水量不足（低于" + rules.minWaterVolume + "升）");
    if (latest.turbidity > rules.turbidityLimit) why.push("浊度超限（高于" + rules.turbidityLimit + "度）");
    reasons.push(why.join("；") || latest.reason || "最近一次复核不合格");
  } else if (ready && remaining !== null && remaining <= 0) {
    state = "已领完";
  } else if (ready) {
    state = "可领用";
    if (remaining === null) reasons.push("批次未登记入缸浆量，暂不能开具领用单");
  } else {
    state = "待复核";
    if (!latest) {
      reasons.push("进入可抄纸后尚未登记洗浆复核");
    } else if (lastSlip && pool.length < k) {
      reasons.push("原许可已于上次领用后失效，须换人连续" + k + "次浊度合格、相隔" + rules.qualifyGapHours + "小时");
    } else if (pool.length < k) {
      reasons.push("已合格" + pool.length + "次，还须连续合格" + (k - pool.length) + "次");
    } else if (!windowOk(chain)) {
      let sameOperator = false;
      for (let i = 1; i < chain.length; i += 1) if (chain[i].operator === chain[i - 1].operator) sameOperator = true;
      if (rules.requireDifferentOperator && sameOperator) reasons.push("连续两次复核须换人操作");
      else reasons.push("两次复核相隔" + gapHours.toFixed(1) + "小时，不足" + rules.qualifyGapHours + "小时");
    }
  }

  return {
    code: item.code,
    vat: item.vat || "",
    owner: item.owner || "",
    status: item.status,
    pulpAmount,
    remaining,
    state,
    requisitionable: state === "可领用" && remaining !== null && remaining > 0,
    reasons,
    latest: latest ? { id: latest.id, at: latest.at, waterVolume: latest.waterVolume, turbidity: latest.turbidity, operator: latest.operator, result: latest.currentPass ? "合格" : "不合格", recordedResult: latest.result, reason: latest.reason } : null,
    chain: chain.map(stripTime),
    gapHours: gapHours === null ? null : Number(gapHours.toFixed(2)),
    checksNeeded: k,
    recordCount: recs.length,
    slipCount: mySlips.length,
    lastSlipAt: lastSlip ? lastSlip.at : null,
    lastSlipCode: lastSlip ? lastSlip.code : null
  };
}
function stripTime(r) {
  const { time, ...rest } = r;
  return rest;
}
function nextSlipCode(slips, at) {
  const d = new Date(at);
  const p = n => String(n).padStart(2, "0");
  const prefix = "LY-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  const seq = slips.filter(s => s.code && s.code.startsWith(prefix)).length + 1;
  return prefix + "-" + String(seq).padStart(3, "0");
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item, db) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  const usedPulp = (db.requisitions || []).filter(r => r.batchCode === item.code).reduce((n, r) => n + Number(r.amount || 0), 0);
  const pulpAmount = item.pulpAmount === undefined || item.pulpAmount === "" ? null : Number(item.pulpAmount);
  return { ...item, logCount, remainingPulp: pulpAmount === null ? null : pulpAmount - usedPulp };
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆发酵与洗浆领用</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --ok:#2f6b3a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; font-size:16px; } main { padding:0 28px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.ok { color:var(--ok); border-color:#b9d3bd; background:#eef5ee; } .pill.bad { color:var(--warn); border-color:#e0bcb2; background:#f8ede9; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; } .ok-text { color:var(--ok); font-weight:700; }
    .tabs { display:flex; gap:6px; padding:16px 28px 0; } .tabs button { background:#eef1ea; color:var(--ink); border:1px solid var(--line); border-bottom:none; border-radius:8px 8px 0 0; padding:10px 18px; } .tabs button.active { background:#fff; color:var(--accent); }
    .tab { display:none; background:transparent; border:none; padding:18px 0 0; } .tab.active { display:block; }
    .two-col { display:grid; grid-template-columns:380px 1fr; gap:22px; }
    table { width:100%; border-collapse:collapse; font-size:13px; background:#fff; border-radius:8px; overflow:hidden; } th,td { border-bottom:1px solid var(--line); padding:8px 10px; text-align:left; vertical-align:top; } th { background:#eef1ea; font-weight:700; }
    .sub { margin-top:10px; border-top:1px dashed var(--line); padding-top:8px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} .two-col{grid-template-columns:1fr;} main{padding:0 12px 16px;} .tabs{padding:12px 12px 0; flex-wrap:wrap;} }
  </style>
</head>
<body>
  <header><div><h1>古法纸浆发酵与洗浆领用</h1><div class="meta">发酵批次只记天数与状态；可抄纸后逐缸登记洗浆复核，换人双合格方可领用</div></div><button id="reload">刷新</button></header>
  <nav class="tabs">
    <button data-tab="batch" class="active">发酵批次</button>
    <button data-tab="wash">洗浆复核</button>
    <button data-tab="ledger">领用台账</button>
    <button data-tab="rules">批次规则</button>
  </nav>
  <main>
    <section class="tab active" id="tab-batch">
      <div class="two-col">
        <div>
          <form id="createForm" class="panel"><h2>新增纸浆批次</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><div style="margin-top:12px"><button>保存纸浆批次</button></div></form>
          <form id="actionForm" class="panel" style="margin-top:14px"><h2>每日观察记录</h2><label>选择纸浆批次</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><div style="margin-top:12px"><button>提交记录</button></div></form>
        </div>
        <div>
          <div class="stats" id="stats"></div>
          <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
          <div class="panel"><h2>发酵批次：逐缸记录天数与状态，进入可抄纸后转“洗浆复核”页逐缸看水色。</h2><div class="grid" id="cards"></div></div>
        </div>
      </div>
    </section>

    <section class="tab" id="tab-wash">
      <div class="two-col">
        <div>
          <form id="washForm" class="panel">
            <h2>登记洗浆复核</h2>
            <label>选择可抄纸批次（逐缸）</label><select name="batchCode" id="washBatchSelect"></select>
            <label>洗浆水量（升）</label><input name="waterVolume" type="number" min="0" step="1" required>
            <label>滤水浊度（度，高于二度不合格）</label><input name="turbidity" type="number" min="0" step="0.1" required>
            <label>操作人</label><input name="operator" required>
            <label>登记时间（留空为现在）</label><input name="at" type="datetime-local">
            <div style="margin-top:12px"><button>提交复核</button></div>
            <div class="meta sub">水量不足或浊度高于二度，该缸转待复洗，不占领用量；换人连续两次浊度合格且相隔四小时才可领用。</div>
          </form>
        </div>
        <div>
          <div class="stats" id="washStats"></div>
          <div class="toolbar">
            <select id="washStateFilter"><option value="">全部复核状态</option>${washStates.map(s => '<option>'+s+'</option>').join('')}</select>
            <input id="washSearch" placeholder="搜索批次、缸号或操作人">
          </div>
          <div class="panel"><h2>洗浆记录与领用许可</h2><div class="grid" id="washCards"></div></div>
        </div>
      </div>
    </section>

    <section class="tab" id="tab-ledger">
      <div class="two-col">
        <form id="requisitionForm" class="panel">
          <h2>开具领用单</h2>
          <label>可领用批次</label><select name="batchCode" id="requisitionBatchSelect"></select>
          <div class="meta" id="requisitionHint">仅显示已满足换人双复核的批次</div>
          <label>领用量（公斤，不得超过剩余浆量）</label><input name="amount" type="number" min="0" step="0.1" required>
          <label>领用人</label><input name="operator" required>
          <div style="margin-top:12px"><button>登记领用</button></div>
          <div class="meta sub">领用后自动更正洗浆记录、原许可失效；旧领用单保留可查，再次领用须重新复核。</div>
        </form>
        <div>
          <div class="toolbar"><input id="ledgerSearch" placeholder="搜索单号、批次、缸号或领用人"></div>
          <div class="panel"><h2>领用台账（只增不改，旧单可查）</h2><div style="overflow:auto"><table id="ledgerTable"></table></div></div>
        </div>
      </div>
    </section>

    <section class="tab" id="tab-rules">
      <form id="rulesForm" class="panel" style="max-width:520px">
        <h2>批次规则</h2>
        <label>每缸最低洗浆水量（升）</label><input name="minWaterVolume" type="number" min="1" step="1">
        <label>滤水浊度上限（度，高于此值不合格）</label><input name="turbidityLimit" type="number" min="0" step="0.1">
        <label>领用前连续合格复核次数</label><input name="qualifyChecks" type="number" min="1" step="1">
        <label>复核最少相隔小时数</label><input name="qualifyGapHours" type="number" min="0" step="0.5">
        <label><span style="display:inline;width:auto"><input type="checkbox" name="requireDifferentOperator" style="width:auto"> 连续两次复核须换人操作</span></label>
        <div style="margin-top:12px"><button>保存规则</button></div>
        <div class="meta sub">规则仅影响新登记复核的判定与许可推算；洗浆记录、领用台账与发酵批次分开维护。</div>
      </form>
    </section>
  </main>
  <script>
    const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["pulpAmount","入缸浆量(公斤)","number"],["owner","负责人","text"]];
    const stages = ["入缸","发酵中","可抄纸","异常观察"];
    const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];
    const washStates = ["待复洗","可领用","待复核","已领完","未到复核"];
    let items = [], washes = [], slips = [], summaries = [], rules = null;

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '请求失败');
      return data;
    }
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
    function fmtAt(s) { if (!s) return ''; const d = new Date(s); if (isNaN(d.getTime())) return esc(s); const p = n => String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); }
    function num(v) { return v === null || v === undefined ? '未登记' : v; }

    // ---------- 发酵批次 ----------
    function renderBatchForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function renderBatch() {
      document.querySelector('#itemSelect').innerHTML = items.map(item => '<option value="'+esc(item.id || item.code)+'">'+esc(item.code)+' · '+esc(item.vat || item.source || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      document.querySelector('#stats').innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      document.querySelector('#cards').innerHTML = visible.map(cardHtml).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+encodeURIComponent(sel.dataset.status), { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await loadAll(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const note = prompt('记录备注'); if (note) { await api('/api/items/'+encodeURIComponent(btn.dataset.note)+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await loadAll(); } });
    }
    function cardHtml(item) {
      const rows = [['原料来源',item.source],['浸泡缸',item.vat],['发酵天数',item.days],['入缸浆量(公斤)',num(item.pulpAmount)],['剩余浆量(公斤)',num(item.remainingPulp)],['负责人',item.owner]]
        .map(([k,v]) => '<div><b>'+k+'</b> '+esc(v)+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+esc(l.step)+'：'+esc(l.note)+'</div>').join('');
      return '<article class="card"><h3>'+esc(item.code || item.id)+'</h3><span class="pill">'+esc(item.status)+'</span>'+rows
        + '<label>状态</label><select data-status="'+esc(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'
        + '<button class="secondary" data-note="'+esc(item.id || item.code)+'">追加备注</button>'
        + '<div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }

    // ---------- 洗浆复核 ----------
    function stateClass(s) { return s === '可领用' ? 'ok' : (s === '待复洗' ? 'bad' : ''); }
    function renderWash() {
      const ready = items.filter(i => i.status === '可抄纸');
      document.querySelector('#washBatchSelect').innerHTML = ready.length
        ? ready.map(i => '<option value="'+esc(i.code)+'">'+esc(i.code)+' · '+esc(i.vat)+' · 负责人'+esc(i.owner)+'</option>').join('')
        : '<option value="">暂无进入可抄纸的批次</option>';
      const counts = Object.fromEntries(washStates.map(s => [s, 0]));
      let availablePulp = 0;
      summaries.forEach(s => { if (counts[s.state] !== undefined) counts[s.state] += 1; if (s.state === '可领用' && s.remaining > 0) availablePulp += s.remaining; });
      document.querySelector('#washStats').innerHTML =
        '<div class="stat"><span>待复洗（缸）</span><strong class="warn">'+counts['待复洗']+'</strong></div>'
        + '<div class="stat"><span>可领用（缸）</span><strong class="ok-text">'+counts['可领用']+'</strong></div>'
        + '<div class="stat"><span>可领浆量（公斤）</span><strong>'+availablePulp.toFixed(1)+'</strong></div>'
        + '<div class="stat"><span>待复核（缸）</span><strong>'+counts['待复核']+'</strong></div>'
        + '<div class="stat"><span>已领完（缸）</span><strong>'+counts['已领完']+'</strong></div>';
      const f = document.querySelector('#washStateFilter').value;
      const q = document.querySelector('#washSearch').value.trim();
      const visible = summaries.filter(s => (!f || s.state === f) && (!q || (s.code+s.vat+s.owner+(s.latest?s.latest.operator:'')+(s.reasons.join(''))).includes(q)));
      document.querySelector('#washCards').innerHTML = visible.map(washCardHtml).join('') || '<div class="meta">没有符合条件的缸</div>';
      document.querySelectorAll('[data-pulp]').forEach(btn => btn.onclick = async () => { const v = prompt('补登入缸浆量（公斤）'); if (v === null) return; await api('/api/items/'+encodeURIComponent(btn.dataset.pulp), { method:'PATCH', body: JSON.stringify({ pulpAmount: v }) }); await loadAll(); });
    }
    function washCardHtml(s) {
      const latest = s.latest ? '<div class="sub"><b>最近复核</b> '+fmtAt(latestAt(s))+' · 水量'+s.latest.waterVolume+'升 · 浊度'+s.latest.turbidity+'度 · '+esc(s.latest.operator)
        + ' <span class="pill '+(s.latest.result==='合格'?'ok':'bad')+'">'+s.latest.result+'</span>'
        + (s.latest.reason ? '<div class="warn">'+esc(s.latest.reason)+'</div>' : '') + '</div>' : '<div class="sub meta">尚未登记洗浆复核</div>';
      let chain = '';
      if (s.chain.length) {
        chain = '<div class="sub"><b>许可复核链</b><br>' + s.chain.map((r,i) => '<span class="meta">第'+(i+1)+'次 '+fmtAt(r.at)+' · '+esc(r.operator)+' · 浊度'+r.turbidity+'度 · 水量'+r.waterVolume+'升 · <span class="pill '+(r.result==='合格'?'ok':'bad')+'">'+r.result+'</span>'+(r.permitUsedBy?' · 已由 '+esc(r.permitUsedBy)+' 领用失效':'')+'</span>').join('<br>')
          + (s.gapHours !== null ? '<div class="meta">相隔 '+s.gapHours+' 小时</div>' : '') + '</div>';
      }
      const reasons = s.reasons.length ? '<div class="'+(s.state==='待复洗'?'warn':'meta')+'">'+s.reasons.map(esc).join('；')+'</div>' : '';
      const pulp = s.remaining === null
        ? '<button class="secondary" data-pulp="'+esc(s.code)+'">补登入缸浆量</button>'
        : '<div><b>剩余浆量</b> '+s.remaining.toFixed(1)+' / '+num(s.pulpAmount)+' 公斤</div>';
      const recs = washes.filter(w => w.batchCode === s.code).sort((a,b)=> a.at < b.at ? 1 : -1);
      const table = '<div class="sub"><b>逐缸洗浆记录（'+s.recordCount+'条）</b><table><tr><th>时间</th><th>水量(升)</th><th>浊度(度)</th><th>操作人</th><th>结果</th></tr>'
        + recs.map(r => '<tr><td>'+fmtAt(r.at)+'</td><td>'+r.waterVolume+(r.result==='不合格'&&r.reason.includes('水量')?' <span class="warn">不足</span>':'')+'</td><td>'+r.turbidity+(r.result==='不合格'&&r.reason.includes('浊度')?' <span class="warn">超限</span>':'')+'</td><td>'+esc(r.operator)+(r.permitUsedBy?'<div class="meta">许可已由 '+esc(r.permitUsedBy)+' 领用</div>':'')+'</td><td><span class="pill '+(r.result==='合格'?'ok':'bad')+'">'+r.result+'</span></td></tr>').join('') + '</table></div>';
      return '<article class="card"><h3>'+esc(s.code)+' · '+esc(s.vat)+'</h3><span class="pill '+stateClass(s.state)+'">'+s.state+'</span>'
        + '<div class="meta">发酵状态：'+esc(s.status)+' · 负责人 '+esc(s.owner)+'</div>'
        + pulp + reasons + latest + chain + (s.lastSlipCode ? '<div class="meta">上次领用单：'+esc(s.lastSlipCode)+'（'+fmtAt(s.lastSlipAt)+'），原许可失效</div>' : '') + table + '</article>';
    }
    function latestAt(s) { return s.latest ? s.latest.at : ''; }

    // ---------- 领用台账 ----------
    function renderLedger() {
      const can = summaries.filter(s => s.requisitionable);
      const sel = document.querySelector('#requisitionBatchSelect');
      sel.innerHTML = can.length ? can.map(s => '<option value="'+esc(s.code)+'">'+esc(s.code)+' · '+esc(s.vat)+' · 剩余'+s.remaining.toFixed(1)+'公斤</option>').join('') : '<option value="">暂无可领用批次</option>';
      updateRequisitionHint();
      const q = document.querySelector('#ledgerSearch').value.trim();
      const rows = slips.filter(r => !q || (r.code+r.batchCode+r.vat+r.operator).includes(q)).sort((a,b)=> a.at < b.at ? 1 : -1);
      const latestByBatch = {};
      slips.forEach(r => { if (!latestByBatch[r.batchCode] || latestByBatch[r.batchCode] < r.at) latestByBatch[r.batchCode] = r.at; });
      document.querySelector('#ledgerTable').innerHTML = '<tr><th>领用单号</th><th>批次/缸</th><th>领用量(公斤)</th><th>领用人</th><th>时间</th><th>许可依据（换人双复核）</th><th>领用后剩余(公斤)</th><th>状态</th></tr>'
        + rows.map(r => '<tr><td><b>'+esc(r.code)+'</b></td><td>'+esc(r.batchCode)+'<br><span class="meta">'+esc(r.vat)+'</span></td><td>'+r.amount+'</td><td>'+esc(r.operator)+'</td><td>'+fmtAt(r.at)+'</td><td>'
          + (r.permit ? esc(r.permit.operators.join(' → '))+'<br><span class="meta">'+fmtAt(r.permit.firstAt)+' → '+fmtAt(r.permit.lastAt)+'，相隔'+r.permit.gapHours+'小时</span>' : '')
          + '</td><td>'+num(r.remainingAfter)+'</td><td><span class="pill ok">已入账</span>'+(latestByBatch[r.batchCode]===r.at?'':'<div class="meta">历史单，可查</div>')+'</td></tr>').join('')
        || '<tr><td class="meta">暂无领用记录</td></tr>';
    }
    function updateRequisitionHint() {
      const code = document.querySelector('#requisitionBatchSelect').value;
      const s = summaries.find(x => x.code === code);
      document.querySelector('#requisitionHint').textContent = s ? ('剩余浆量 '+s.remaining.toFixed(1)+' 公斤，领用量不得超过此数') : '仅显示已满足换人双复核的批次';
    }

    // ---------- 规则 ----------
    function renderRules() {
      if (!rules) return;
      const f = document.querySelector('#rulesForm');
      f.minWaterVolume.value = rules.minWaterVolume;
      f.turbidityLimit.value = rules.turbidityLimit;
      f.qualifyChecks.value = rules.qualifyChecks;
      f.qualifyGapHours.value = rules.qualifyGapHours;
      f.requireDifferentOperator.checked = !!rules.requireDifferentOperator;
    }

    async function loadAll() {
      [items, washes, slips, rules, summaries] = await Promise.all([
        api('/api/items'), api('/api/washes'), api('/api/requisitions'), api('/api/rules'), api('/api/wash-summary')
      ]);
      renderBatch(); renderWash(); renderLedger(); renderRules();
    }

    document.querySelector('#createForm').onsubmit = async event => {
      event.preventDefault();
      await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(document.querySelector('#createForm')).entries())) });
      document.querySelector('#createForm').reset(); await loadAll();
    };
    document.querySelector('#actionForm').onsubmit = async event => {
      event.preventDefault();
      const f = document.querySelector('#actionForm');
      await api('/api/items/'+encodeURIComponent(document.querySelector('#itemSelect').value)+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(f).entries())) });
      f.reset(); await loadAll();
    };
    document.querySelector('#washForm').onsubmit = async event => {
      event.preventDefault();
      const f = document.querySelector('#washForm');
      const data = Object.fromEntries(new FormData(f).entries());
      if (!data.at) delete data.at;
      else data.at = new Date(data.at).toISOString();
      try {
        const r = await api('/api/washes', { method:'POST', body: JSON.stringify(data) });
        alert('已登记：' + r.result + (r.reason ? '（' + r.reason + '），该缸当前状态：' + r.state.state : ''));
        f.reset(); await loadAll();
      } catch (e) { alert(e.message); }
    };
    document.querySelector('#requisitionForm').onsubmit = async event => {
      event.preventDefault();
      const f = document.querySelector('#requisitionForm');
      try {
        const r = await api('/api/requisitions', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(f).entries())) });
        alert('领用单 '+r.code+' 已入账，洗浆记录已更正，原许可失效');
        f.reset(); await loadAll();
      } catch (e) { alert(e.message); }
    };
    document.querySelector('#rulesForm').onsubmit = async event => {
      event.preventDefault();
      const f = document.querySelector('#rulesForm');
      const data = Object.fromEntries(new FormData(f).entries());
      data.requireDifferentOperator = f.requireDifferentOperator.checked;
      await api('/api/rules', { method:'PUT', body: JSON.stringify(data) });
      alert('规则已保存'); await loadAll();
    };
    document.querySelectorAll('.tabs button').forEach(btn => btn.onclick = () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.querySelector('#tab-'+btn.dataset.tab).classList.add('active');
    });
    document.querySelector('#statusFilter').onchange = renderBatch;
    document.querySelector('#search').oninput = renderBatch;
    document.querySelector('#washStateFilter').onchange = renderWash;
    document.querySelector('#washSearch').oninput = renderWash;
    document.querySelector('#ledgerSearch').oninput = renderLedger;
    document.querySelector('#requisitionBatchSelect').onchange = updateRequisitionHint;
    document.querySelector('#reload').onclick = loadAll;
    renderBatchForms(); loadAll();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());

    // ---------- 发酵批次 ----------
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(i => summarize(i, db)));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      if (!input.code) return fail(res, 400, "code_required", "批次编号不能为空");
      if (db.items.some(i => i.code === input.code)) return fail(res, 409, "code_exists", "批次编号已存在");
      const item = {
        id: newId("PF"),
        ...input,
        days: Number(input.days || 0),
        pulpAmount: input.pulpAmount === "" || input.pulpAmount === undefined ? undefined : Number(input.pulpAmount),
        logs: [{ at: new Date().toISOString(), step: "建档", note: "创建纸浆批次" }]
      };
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, summarize(item, db));
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findItem(db, decodeURIComponent(patch[1]));
      if (!item) return fail(res, 404, "item_not_found", "批次不存在");
      const input = await body(req);
      if (input.pulpAmount !== undefined) input.pulpAmount = input.pulpAmount === "" ? undefined : Number(input.pulpAmount);
      Object.assign(item, input);
      item.logs ||= [];
      if (input.status) item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, summarize(item, db));
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = findItem(db, decodeURIComponent(log[1]));
      if (!item) return fail(res, 404, "item_not_found", "批次不存在");
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = findItem(db, decodeURIComponent(action[1]));
      if (!item) return fail(res, 404, "item_not_found", "批次不存在");
      const input = await body(req);
      item.logs ||= [];
      const abnormal = String(input.abnormal || "").includes("是") || String(input.abnormal || "").includes("有");
      item.observations ||= [];
      item.observations.push({ at: new Date().toISOString(), ...input, abnormal });
      item.days = Number(item.days || 0) + 1;
      item.status = abnormal ? "异常观察" : Number(item.days) >= 7 ? "可抄纸" : "发酵中";
      item.logs.push({ at: new Date().toISOString(), step: "观察", note: "温度" + (input.temperature || "") + "，" + (input.smell || "") + "，" + (input.fiber || "") });
      await saveDb(db);
      return send(res, 201, summarize(item, db));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));

    // ---------- 批次规则（与批次、洗浆、台账分开维护） ----------
    if (req.method === "GET" && url.pathname === "/api/rules") return send(res, 200, db.rules);
    if (req.method === "PUT" && url.pathname === "/api/rules") {
      const input = await body(req);
      const next = {
        minWaterVolume: Number(input.minWaterVolume),
        turbidityLimit: Number(input.turbidityLimit),
        qualifyChecks: Math.trunc(Number(input.qualifyChecks)),
        qualifyGapHours: Number(input.qualifyGapHours),
        requireDifferentOperator: !!input.requireDifferentOperator
      };
      if (![next.minWaterVolume, next.turbidityLimit, next.qualifyGapHours].every(v => Number.isFinite(v) && v >= 0)) {
        return fail(res, 400, "bad_rule", "规则数值必须为不小于0的数字");
      }
      if (!Number.isFinite(next.qualifyChecks) || next.qualifyChecks < 1) return fail(res, 400, "bad_rule", "连续合格次数至少为1");
      db.rules = next;
      await saveDb(db);
      return send(res, 200, db.rules);
    }

    // ---------- 洗浆复核 ----------
    if (req.method === "GET" && url.pathname === "/api/washes") return send(res, 200, db.washes);
    if (req.method === "GET" && url.pathname === "/api/wash-summary") {
      const touched = new Set(db.washes.map(w => w.batchCode).concat(db.requisitions.map(r => r.batchCode)));
      const list = db.items.filter(i => i.status === "可抄纸" || touched.has(i.code));
      return send(res, 200, list.map(i => summarizeWash(i, db.washes, db.requisitions, db.rules)));
    }
    if (req.method === "POST" && url.pathname === "/api/washes") {
      const input = await body(req);
      const item = findItem(db, String(input.batchCode || "").trim());
      if (!item) return fail(res, 404, "item_not_found", "批次不存在");
      if (item.status !== "可抄纸") return fail(res, 400, "not_ready", "批次尚未进入可抄纸，不能登记洗浆复核");
      const operator = String(input.operator || "").trim();
      if (!operator) return fail(res, 400, "operator_required", "操作人不能为空");
      const waterVolume = Number(input.waterVolume);
      const turbidity = Number(input.turbidity);
      if (!Number.isFinite(waterVolume) || waterVolume < 0) return fail(res, 400, "bad_water_volume", "洗浆水量必须为不小于0的数字");
      if (!Number.isFinite(turbidity) || turbidity < 0) return fail(res, 400, "bad_turbidity", "滤水浊度必须为不小于0的数字");
      const at = toTime(input.at);
      if (!Number.isFinite(at)) return fail(res, 400, "bad_at", "登记时间格式不正确");

      // 水量不足或浊度高于二度即不合格，转待复洗，不占领用量
      const lacksWater = waterVolume < db.rules.minWaterVolume;
      const tooTurbid = turbidity > db.rules.turbidityLimit;
      const reasons = [];
      if (lacksWater) reasons.push("水量不足（低于" + db.rules.minWaterVolume + "升）");
      if (tooTurbid) reasons.push("浊度超限（高于" + db.rules.turbidityLimit + "度）");
      const record = {
        id: newId("W"),
        batchCode: item.code,
        vat: item.vat || "",
        at: new Date(at).toISOString(),
        waterVolume,
        turbidity,
        operator,
        result: reasons.length ? "不合格" : "合格",
        reason: reasons.join("；")
      };
      db.washes.push(record);
      await saveDb(db);
      return send(res, 201, { record, state: summarizeWash(item, db.washes, db.requisitions, db.rules) });
    }

    // ---------- 领用台账 ----------
    if (req.method === "GET" && url.pathname === "/api/requisitions") return send(res, 200, db.requisitions);
    if (req.method === "POST" && url.pathname === "/api/requisitions") {
      const input = await body(req);
      const item = findItem(db, String(input.batchCode || "").trim());
      if (!item) return fail(res, 404, "item_not_found", "批次不存在");
      const operator = String(input.operator || "").trim();
      if (!operator) return fail(res, 400, "operator_required", "领用人不能为空");
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, "bad_amount", "领用量必须为大于0的数字");

      const summary = summarizeWash(item, db.washes, db.requisitions, db.rules);
      if (item.status !== "可抄纸") return fail(res, 400, "not_ready", "批次尚未进入可抄纸，不能领用");
      if (summary.state === "待复洗") return fail(res, 400, "rewash_required", "该缸待复洗：" + summary.reasons.join("；"));
      if (summary.state !== "可领用") return fail(res, 400, "not_requisitionable", "尚不满足领用条件：" + summary.reasons.join("；"));
      if (summary.remaining === null) return fail(res, 400, "pulp_amount_missing", "批次未登记入缸浆量，请先在发酵批次页补登");
      if (amount > summary.remaining) return fail(res, 400, "amount_exceeds_remaining", "领用量" + amount + "公斤超过剩余浆量" + summary.remaining.toFixed(1) + "公斤");

      const chain = summary.chain;
      const at = Date.now();
      const before = summary.remaining;
      const slip = {
        id: newId("LY"),
        code: nextSlipCode(db.requisitions, at),
        batchCode: item.code,
        vat: item.vat || "",
        amount,
        operator,
        at: new Date(at).toISOString(),
        remainingBefore: Number(before.toFixed(3)),
        remainingAfter: Number((before - amount).toFixed(3)),
        permit: {
          washIds: chain.map(r => r.id),
          operators: chain.map(r => r.operator),
          firstAt: chain[0].at,
          lastAt: chain[chain.length - 1].at,
          gapHours: summary.gapHours
        }
      };
      db.requisitions.push(slip);

      // 领用后更正洗浆记录：原许可标记失效；旧领用单保留在台账中可查
      const permitIds = new Set(slip.permit.washIds);
      for (const w of db.washes) {
        if (permitIds.has(w.id)) w.permitUsedBy = slip.code;
      }
      item.logs ||= [];
      item.logs.push({ at: slip.at, step: "领用", note: slip.code + " 领用" + amount + "公斤，剩余" + slip.remainingAfter + "公斤，洗浆许可失效" });
      await saveDb(db);
      return send(res, 201, { slip, state: summarizeWash(item, db.washes, db.requisitions, db.rules) });
    }

    send(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    send(res, 500, { error: "server_error", message: error.message });
  }
});
server.listen(port, () => console.log("古法纸浆发酵与洗浆领用 listening on http://localhost:" + port));
