/* ───────────────────────────
   Lean app.js (optimized)
   - Single scheduler (no CSV)
   - CSV live: single-instance, no overlap, visibility-aware
   - Paint only on change
─────────────────────────── */

/* ========== helpers ========== */
const fmt = n => (typeof n === "number" ? Math.round(n * 100) / 100 : n);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const seriesHash = arr => Array.isArray(arr) ? arr.map(d => `${d.ts}:${d.count}`).join('|') : '';

/* hour-buckets */
function bucketizeSeriesByHour(series){
  if (!series || !series.length) return [];
  const m = new Map();
  for(const p of series){
    const d = new Date(p.ts); d.setMinutes(0,0,0);
    const k = d.toISOString();
    m.set(k, (m.get(k)||0) + (p.count||0));
  }
  return [...m].map(([ts,count])=>({ts,count})).sort((a,b)=>a.ts<b.ts?-1:1);
}

/* tiny sparkline */
function px(val,min,max,H){ if(max===min) return H/2; return H-((val-min)*(H/(max-min))); }
function sparklineSVG(series,w=320,h=48){
  if(!series||!series.length) return `<svg class="spark" viewBox="0 0 ${w} ${h}"></svg>`;
  const n=series.length,pad=4,ys=series.map(s=>s.y),yMin=Math.min(...ys),yMax=Math.max(...ys),step=(w-pad*2)/Math.max(1,n-1);
  let pts="";
  for(let i=0;i<n;i++){ const x=pad+i*step, y=px(series[i].y,yMin,yMax,h-pad*2)+pad; pts+=`${x.toFixed(1)},${y.toFixed(1)} `; }
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="#94a3b8" stroke-width="2" points="${pts.trim()}"/></svg>`;
}

/* bars */
function barChartSVG(data,w=1100,h=180){
  const pad=28,n=data.length; if(!n) return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px"></svg>`;
  const max=Math.max(...data.map(d=>d.count),1), bw=(w-pad*2)/n, showEvery=Math.max(1,Math.ceil(n/12)), tickEvery=Math.max(1,Math.ceil(n/6));
  const rects=[], labels=[], ticks=[];
  for(let i=0;i<n;i++){
    const H=(data[i].count/max)*(h-pad*2), x=pad+i*bw, y=h-pad-H;
    rects.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1,bw-3).toFixed(1)}" height="${H.toFixed(1)}" rx="4" ry="4" fill="#94a3b8" opacity="0.9"/>`);
    if(i%showEvery===0 || bw>=26) labels.push(`<text x="${(x+Math.max(1,bw-3)/2).toFixed(1)}" y="${Math.max(12,y-6).toFixed(1)}" font-size="12" text-anchor="middle" fill="#cbd5e1">${data[i].count}</text>`);
    if(i%tickEvery===0 || i===n-1){
      const t=new Date(data[i].ts).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'});
      ticks.push(`<text x="${x.toFixed(1)}" y="${(h-8).toFixed(1)}" font-size="11" fill="#94a3b8">${t}</text>`);
    }
  }
  const axis=`<line x1="${pad}" y1="${h-pad}" x2="${w-pad}" y2="${h-pad}" stroke="#334155" stroke-width="1"/>`;
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px" preserveAspectRatio="none">${axis}${rects.join("")}${labels.join("")}${ticks.join("")}</svg>`;
}

/* ========== API ========== */
async function apiSummary(signal){ const r=await fetch('/api/summary?minutes=60',{signal,cache:'no-store',keepalive:true}); return r.ok? r.json():[]; }
async function apiLatest(signal){ const r=await fetch('/api/latest?minutes=200',{signal,cache:'no-store',keepalive:true}); return r.ok? r.json():[]; }
async function apiMetricsLast(min,signal){ try{ const r=await fetch(`/api/metrics/last_minutes?minutes=${min}`,{signal,cache:'no-store',keepalive:true}); return r.ok? r.json():null; }catch{ return null; } }
async function apiDestinations(signal){ try{ const r=await fetch('/api/destinations',{signal,cache:'no-store',keepalive:true}); return r.ok? r.json():{destinations:[]}; }catch{ return {destinations:[]}; } }
async function apiCurrentRho(signal){ try{ const r=await fetch('/api/current-rho',{signal,cache:'no-store',keepalive:true}); return r.ok? r.json():{rho:0,lambda_hat:0,mu:0}; }catch{ return {rho:0,lambda_hat:0,mu:0}; } }
async function apiSetOfficers(cp,count){ await fetch('/api/capacity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({checkpoint_id:cp,officers:count})}); }
async function apiCsvLatest(limit=50,signal){ const r=await fetch(`/api/csv/latest?limit=${limit}&_t=${Date.now()}`,{signal,cache:'no-store'}); return r.ok? r.json():null; }

/* ========== shaping ========== */
function groupLatestByCp(latest){
  const map={}, byCp={};
  for(const r of latest) map[r.checkpoint_id+"|"+r.ts_minute]=r;
  Object.values(map).forEach(r=>{ (byCp[r.checkpoint_id] ||= []).push(r); });
  for(const cp in byCp) byCp[cp].sort((a,b)=>a.ts_minute<b.ts_minute?-1:1);
  return byCp;
}
function aggregateTotalPerMinute(latest){
  const dedup={}, m={};
  latest.forEach(r=>{ dedup[r.checkpoint_id+"|"+r.ts_minute]=r; });
  Object.values(dedup).forEach(r=>{ const ts=r.ts_minute; m[ts]=(m[ts]||0)+(r.n_t||0); });
  const arr=Object.entries(m).map(([ts,count])=>({ts,count})).sort((a,b)=>a.ts<b.ts?-1:1);
  return arr.slice(-60);
}

/* ========== CSV table (incremental) ========== */
const CsvTable=(()=>{ 
  let headerDrawn=false, prevIds=new Set(), tbodyEl=null, lastCols=[];
  const makeId=r=> r.__rowid ?? [(r.ts_minute||r.ts||r.time||''),(r.checkpoint_id||r.cp||''),(r.pnr||r.id||'')].join('|');
  function rebuild(tbl,cols,rows){
    let html='<thead><tr>'+cols.filter(c=>c!=='__rowid').map(c=>`<th>${c}</th>`).join('')+'</tr></thead><tbody>';
    const ns=new Set();
    for(const r of rows){
      const rid=makeId(r); ns.add(rid);
      html+=`<tr data-rid="${rid}">`; for(const c of cols) if(c!=='__rowid') html+=`<td>${r[c]??''}</td>`; html+='</tr>';
    }
    html+='</tbody>'; tbl.innerHTML=html; tbodyEl=tbl.querySelector('tbody'); headerDrawn=true; prevIds=ns; lastCols=cols.slice();
  }
  function upsert(data){
    const tbl=document.getElementById('csvTable'); if(!tbl) return;
    const cols=data?.columns??[], rows=(data?.rows??[]).slice(-50);
    if(!cols.length){ tbl.innerHTML=`<tbody><tr><td class="muted">CSV boş veya okunamadı.</td></tr></tbody>`; headerDrawn=false; prevIds.clear(); tbodyEl=null; lastCols=[]; return; }
    if(!headerDrawn || !tbodyEl || !same(cols,lastCols)){ rebuild(tbl,cols,rows); return; }
    const incomingIds=rows.map(makeId), unknown=incomingIds.filter(id=>!prevIds.has(id)).length;
    if(tbodyEl.rows.length!==rows.length || unknown>5){ rebuild(tbl,cols,rows); return; }
    const frag=document.createDocumentFragment();
    for(const r of rows){
      const rid=makeId(r); if(prevIds.has(rid)) continue;
      const tr=document.createElement('tr'); tr.className='rowNew'; tr.dataset.rid=rid;
      for(const c of cols){ if(c==='__rowid') continue; const td=document.createElement('td'); td.textContent=r[c]??''; tr.appendChild(td); }
      frag.appendChild(tr); prevIds.add(rid);
    }
    if(frag.childNodes.length) tbodyEl.appendChild(frag);
    while(tbodyEl && tbodyEl.rows.length>50){ const rid=tbodyEl.rows[0].dataset.rid; if(rid) prevIds.delete(rid); tbodyEl.deleteRow(0); }
  }
  function reset(){ headerDrawn=false; prevIds.clear(); tbodyEl=null; lastCols=[]; }
  return { upsert, reset };
})();

/* ========== gauge ========== */
function createGaugeChart(rho,w=200,h=150){
  const r=Math.min(w,h)*0.8, cx=w/2, cy=h*0.8, max=3.0, p=Math.min(rho,max)/max*100;
  let color="#16a34a"; if(rho>=0.9) color="#ef4444"; else if(rho>=0.7) color="#eab308";
  const bg=`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`;
  const ang=p/100*Math.PI, ex=cx+r*Math.cos(Math.PI-ang), ey=cy-r*Math.sin(Math.PI-ang);
  const val=`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${ex} ${ey}`;
  const nx=cx+(r*0.9)*Math.cos(Math.PI-ang), ny=cy-(r*0.9)*Math.sin(Math.PI-ang);
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px">
    <path d="${bg}" fill="none" stroke="#334155" stroke-width="8" stroke-linecap="round"/>
    <path d="${val}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"/>
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="#e5e7eb" stroke-width="2" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="4" fill="#e5e7eb"/>
    <text x="${cx}" y="${cy + r*0.25}" text-anchor="middle" fill="currentColor" font-size="14" font-weight="bold">ρ ${fmt(rho)}</text>
    <text x="${cx}" y="${cy + r*0.4}" text-anchor="middle" fill="var(--muted)" font-size="10">${p.toFixed(1)}%</text>
  </svg>`;
}

/* ========== theme ========== */
(function initTheme(){
  const btn=document.getElementById('themeToggle'); if(!btn) return;
  if(!btn.__bound){ btn.addEventListener('click',()=>{ const b=document.body; b.classList.toggle('light'); btn.innerHTML=b.classList.contains('light')?'🌙':'☀️'; btn.title=b.classList.contains('light')?'Koyu Temaya Geç':'Açık Temaya Geç'; localStorage.setItem('theme',b.classList.contains('light')?'light':'dark'); }); btn.__bound=true; }
  const saved=localStorage.getItem('theme'); const body=document.body;
  if(saved==='light'){ body.classList.add('light'); btn.innerHTML='🌙'; btn.title='Koyu Temaya Geç'; } else { btn.innerHTML='☀️'; btn.title='Açık Temaya Geç'; }
})();

/* ========== UI ========== */
const UI=(()=> {
  let chartHourHash='', chartDayHash='', destHash='', lastRho=null, lastHourSeries=[], lastDaySeries=[], lastDest=[];
  const ro=new ResizeObserver(entries=>{ for(const e of entries){ const id=e.target.id;
    if(id==='chartHour' && lastHourSeries.length) drawChartHour(lastHourSeries);
    if(id==='chartDay' && lastDaySeries.length) drawChartDay(lastDaySeries);
    if(id==='destinationsChart' && lastDest.length) drawDestinations(lastDest);
    if(id==='rhoGauge' && lastRho!=null) drawGauge(lastRho);
  }});
  ['chartHour','chartDay','destinationsChart','rhoGauge'].forEach(id=>{ const el=document.getElementById(id); if(el) ro.observe(el); });

  function setKpis(k){
    const g=(id)=>document.getElementById(id);
    g('kpiTotal')&&(g('kpiTotal').textContent=k.total??0);
    g('kpiAvg')&&(g('kpiAvg').textContent=`${fmt(k.avg_per_min??0)} kişi/dk`);
    g('kpiPeak')&&(g('kpiPeak').textContent=`${k.peak_count??0} kişi`);
    g('kpiPeakTime')&&(g('kpiPeakTime').textContent=k.peak_ts? new Date(k.peak_ts).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}) : '—');
    g('kpiCpCount')&&(g('kpiCpCount').textContent=k.cp_count??'0');
  }
  function drawChartHour(series){ const el=document.getElementById('chartHour'); if(!el) return; const h=seriesHash(series); if(h===chartHourHash) return; chartHourHash=h; lastHourSeries=series; const w=Math.max(el.clientWidth||1100,600); el.innerHTML=barChartSVG(series,w,180); }
  function drawChartDay(series){ const el=document.getElementById('chartDay'); if(!el) return; const h=seriesHash(series); if(h===chartDayHash) return; chartDayHash=h; lastDaySeries=series; const w=Math.max(el.clientWidth||1100,600); el.innerHTML=barChartSVG(series,w,180); }

  function normalizeDestinations(payload){
    if(!payload) return [];
    const arr=Array.isArray(payload)?payload:(payload.destinations ?? payload.top ?? payload.top_destinations ?? []);
    return arr.map(d=>{ const name=d.dest??d.destination??d.code??d.name??'—'; const count=Number(d.count??d.value??d.freq??0); const percentage=d.percentage??d.percent??null; return {name,dest:name,count,percentage}; })
             .filter(d=>d.count>0).sort((a,b)=>b.count-a.count).slice(0,10);
  }
  function createPieChart(data,width=600,height=280){
    const pie=Math.max(240,Math.min(height-20,Math.floor(width*0.45))), size=pie, cx=size/2, cy=size/2, r=size/2-10;
    const total=data.reduce((s,d)=>s+(d.count||0),0)||1, palette=["#60a5fa","#ef4444","#22c55e","#f59e0b","#a78bfa","#f472b6","#06b6d4","#8b5cf6","#fb7185","#f97316"];
    let acc=0; const slices=[], labels=[];
    data.forEach((d,i)=>{ const v=(d.count||0)/total, a0=acc*2*Math.PI-Math.PI/2; acc+=v; const a1=acc*2*Math.PI-Math.PI/2, mid=(a0+a1)/2;
      const x0=cx+r*Math.cos(a0), y0=cy+r*Math.sin(a0), x1=cx+r*Math.cos(a1), y1=cy+r*Math.sin(a1), large=(a1-a0)>Math.PI?1:0, color=palette[i%palette.length];
      slices.push(`<path d="M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z" fill="${color}" opacity="0.92"><title>${(d.dest??d.name??'').toString().toUpperCase()}: ${d.count}${d.percentage!=null?` (${d.percentage}%)`:''}</title></path>`);
      const code=(d.dest??d.name??'').toString().slice(0,3).toUpperCase();
      if(code && v>=0.05){ const lx=cx+(r*0.62)*Math.cos(mid), ly=cy+(r*0.62)*Math.sin(mid);
        labels.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" style="font-size:12px;font-weight:800;fill:#fff;paint-order:stroke;stroke:#000;stroke-width:2;stroke-opacity:.35">${code}</text>`); }
    });
    const legend=data.map((d,i)=>{ const color=palette[i%palette.length], name=(d.dest??d.name??'').toString().toUpperCase();
      const pct=d.percentage!=null? d.percentage : ((d.count||0)/total*100);
      return `<div style="display:flex;align-items:center;gap:8px;"><span style="width:10px;height:10px;border-radius:2px;background:${color};display:inline-block"></span><span style="font-size:12px;opacity:.95">${name} (${(d.count||0).toLocaleString('tr-TR')} - %${pct.toLocaleString('tr-TR',{maximumFractionDigits:1,minimumFractionDigits:1})})</span></div>`;
    }).join('');
    return `<div style="display:flex;align-items:center;justify-content:center;gap:24px;"><div style="flex:0 0 ${pie}px;display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 ${size} ${size}" width="${pie}" height="${pie}">${slices.join('')}${labels.join('')}</svg></div><div style="flex:1 1 520px;display:grid;grid-template-columns:repeat(2,minmax(180px,1fr));gap:8px 16px;align-content:start">${legend}</div></div>`;
  }
  function drawDestinations(payload){ const el=document.getElementById('destinationsChart'); if(!el) return;
    const data=normalizeDestinations(payload), h=JSON.stringify(data); if(h===destHash) return; destHash=h; lastDest=data;
    const w=Math.max(el.clientWidth||600,400), hgt=Math.max(el.clientHeight||220,160); el.innerHTML=createPieChart(data,w,hgt);
  }
  function drawGauge(rho){ const el=document.getElementById('rhoGauge'); if(!el) return; lastRho=rho; const w=Math.max(el.clientWidth||200,150); el.innerHTML=createGaugeChart(rho,w,150); }

  function drawCards(summary,latest){
    const byCpSummary={}; summary.forEach(s=>byCpSummary[s.checkpoint_id]=s);
    const latestByCp=groupLatestByCp(latest), grid=document.getElementById('grid'); if(!grid) return; grid.innerHTML='';
    for(const cp in byCpSummary){
      const s=byCpSummary[cp], cls=(s.level==='YEŞİL')?'green':(s.level==='SARI'?'yellow':'red');
      const seriesNt=(latestByCp[cp]||[]).slice(-30).map(r=>({x:r.ts_minute,y:(r.n_t??0)}));
      const spark=sparklineSVG(seriesNt), officersMatch=s.detail?.match(/görevli:\s*(\d+)/), officers=officersMatch?officersMatch[1]:'1', rhoTxt=`ρ ${fmt(s.rho)}×`;
      const card=document.createElement('div'); card.className='card'; card.innerHTML=`
        <div class="row"><div class="titleRow">${s.emoji||''} ${cp}</div><div class="level ${cls}">${s.level}</div></div>
        <div class="row" style="margin-top:6px;"><div class="big">${rhoTxt}</div>
          <div class="controls">
            <button class="btn" data-op="-" title="Görevliyi azalt">−</button>
            <div class="badge">Görevli: <b class="off">${officers}</b></div>
            <button class="btn" data-op="+" title="Görevliyi artır">+</button>
          </div>
        </div>
        <div class="muted" style="margin-top:8px;">${s.detail||''}</div>
        <div style="margin-top:8px">${spark}</div>
        <div class="footer"><div class="advice">${s.advice||''}</div><div class="time">Zaman: ${s.time||''}</div></div>`;
      const offEl=card.querySelector('.off');
      card.querySelector('[data-op="-"]').addEventListener('click', async ()=>{ const curr=parseInt(offEl.textContent||'1',10); const nxt=Math.max(1,curr-1); await apiSetOfficers(cp,nxt); offEl.textContent=String(nxt); Scheduler.requestTickSoon(); });
      card.querySelector('[data-op="+"]').addEventListener('click', async ()=>{ const curr=parseInt(offEl.textContent||'1',10); const nxt=curr+1; await apiSetOfficers(cp,nxt); offEl.textContent=String(nxt); Scheduler.requestTickSoon(); });
      grid.appendChild(card);
    }
    if(!Object.keys(byCpSummary).length){ const empty=document.createElement('div'); empty.className='card'; empty.innerHTML=`<div class="titleRow">Henüz veri yok</div><div class="muted">CSV'ye kayıt düştükçe burada görünecek.</div>`; grid.appendChild(empty); }
  }

  function setLastUpdated(){ const b=document.getElementById('lastUpdated'); if(b) b.textContent='Güncelleme: '+new Date().toLocaleTimeString('tr-TR'); }

  return {
    paint({summary,latest,metrics,metrics24,destinations,currentRho}){
      setLastUpdated();
      let series=[], kpis=null;
      if(metrics && metrics.series && metrics.kpis){ series=metrics.series; kpis=metrics.kpis; }
      else{
        series=aggregateTotalPerMinute(latest||[]);
        const total=series.reduce((s,d)=>s+d.count,0), avg=series.length? total/series.length:0;
        let peak={count:0,ts:null}; series.forEach(d=>{ if(d.count>peak.count) peak=d; });
        const byCp={}; (summary||[]).forEach(s=>byCp[s.checkpoint_id]=s);
        kpis={ total, avg_per_min:fmt(avg), peak_count:peak.count||0, peak_ts:peak.ts||null, cp_count:Object.keys(byCp).length||0 };
      }
      setKpis(kpis); drawChartHour(series);
      if(metrics24 && metrics24.series){ drawChartDay(bucketizeSeriesByHour(metrics24.series).slice(-24)); }
      if(destinations){ drawDestinations(destinations); }
      if(currentRho && typeof currentRho.rho==='number'){ drawGauge(currentRho.rho); }
      drawCards(summary||[], latest||[]);
    },
    resetCsv(){ CsvTable.reset(); }
  };
})();

/* ========== Scheduler (NO CSV here) ========== */
const Scheduler=(()=> {
  let ctrl=null, nextTimer=null; const PERIOD=2000;
  async function tick(){
    ctrl?.abort(); ctrl=new AbortController(); const signal=ctrl.signal;
    const [summary, latest, metrics, destinations, currentRho]=await Promise.all([
      apiSummary(signal).catch(()=>[]),
      apiLatest(signal).catch(()=>[]),
      apiMetricsLast(60, signal).catch(()=>null),
      apiDestinations(signal).catch(()=>({destinations:[]})),
      apiCurrentRho(signal).catch(()=>({rho:0.0}))
    ]);
    // metrics24'ü seyrek iste (yaklaşık 30 sn'de bir)
Scheduler.__tickCount = (Scheduler.__tickCount|0) + 1;
let metrics24 = null;
if (Scheduler.__tickCount % 20 === 1) {
  metrics24 = await apiMetricsLast(60 * 24, signal).catch(() => null);
}

    //const metrics24=await apiMetricsLast(60*24, signal).catch(()=>null);
    if(signal.aborted) return;
    requestAnimationFrame(()=>UI.paint({summary, latest, metrics, metrics24, destinations, currentRho}));
    nextTimer=setTimeout(tick, PERIOD);
  }
  function start(){ if(!nextTimer) tick(); }
  function stop(){ if(nextTimer){ clearTimeout(nextTimer); nextTimer=null; } ctrl?.abort(); }
  function requestTickSoon(){ if(nextTimer){ clearTimeout(nextTimer); nextTimer=null; } tick(); }
  return { start, stop, requestTickSoon };
})();
Scheduler.start();

/* === CSV LIVE (güvenilir) ====================================
   - Tek instans, overlap yok (AbortController)
   - 1 sn’de bir çek; veri JSON'u değiştiyse tabloyu güncelle
   - payload: {columns, rows} veya direkt [rows] destekler
============================================================== */
/* === CSV LIVE (basit & sağlam) =================================
   - Tek instans
   - Overlap yok (busy kilidi)
   - 1 sn'de bir çek ve tabloyu komple yeniden yaz
   - JSON/İmza karşılaştırması YOK -> değişimi asla kaçırmaz
================================================================= */
(function csvLiveMinimal(){
  // başka bir sürüm kuruluysa tekrar kurma
  if (window.__CSV_LIVE_MIN__) return;
  window.__CSV_LIVE_MIN__ = true;

  const TICK_MS = 1000;
  let busy = false;

  // Kolon sırası (varsa bunlara göre diz)
  const PREFERRED = [
    'ID','Name','PNR','OriginAirport','DestinationAirport','IATA',
    'FlightNumber','FlightDate','CheckDate','IsSuccess','ErrorReason','Type'
  ];

  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]
  ));

  const norm = k => (k||'').toString().toLowerCase();
  const pickKey = (obj, name) => {
    const want = norm(name);
    return Object.keys(obj).find(k => norm(k) === want) || null;
  };

  function buildTableHTML(rows){
    if (!rows || !rows.length) return '<tbody><tr><td class="muted">CSV boş.</td></tr></tbody>';

    // Kolonları belirle (önce tercih edilenler, sonra kalanlar)
    const cols = [];
    for (const name of PREFERRED) {
      const k = pickKey(rows[0], name);
      if (k) cols.push({ key: k, title: name });
    }
    const have = new Set(cols.map(c => c.key));
    for (const k of Object.keys(rows[0])) if (!have.has(k)) cols.push({ key: k, title: k });

    // Başlık
    let html = '<thead><tr>';
    for (const c of cols) html += `<th>${esc(c.title)}</th>`;
    html += '</tr></thead><tbody>';

    // Satırlar
    for (const r of rows) {
      html += '<tr>';
      for (const c of cols) html += `<td>${esc(r[c.key])}</td>`;
      html += '</tr>';
    }
    html += '</tbody>';
    return html;
  }

  async function tick(){
    if (busy) { setTimeout(tick, 150); return; }
    busy = true;

    try {
      const r = await fetch(`/api/csv/latest?limit=50&_t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const payload = await r.json();
      const rows = Array.isArray(payload) ? payload : (payload.rows ?? payload.data ?? []);

      const tbl = document.getElementById('csvTable');
      if (tbl && Array.isArray(rows)) {
        tbl.innerHTML = buildTableHTML(rows);
      }
    } catch {
      /* sessizce geç */
    } finally {
      busy = false;
      setTimeout(tick, TICK_MS);
    }
  }

  function boot(){
    if (!document.getElementById('csvTable')) { setTimeout(boot, 250); return; }
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();




