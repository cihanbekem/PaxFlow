/*
  FAST UI REFRESH — drop‑in replacement for app.js
  Amaç: daha az reflow, çakışan fetch’leri iptal, sadece değişen kısımları boyamak.
  - setInterval yerine tek döngü + AbortController
  - Grafik/tablolar için değişim kontrolü (hash) + ResizeObserver
  - CSV tabloyu incremental güncelle (full innerHTML yok)
  - ρ gauge koşulu düzeltildi (0.7–0.9 sarı)
*/

// ====== helpers ======
const fmt = n => (typeof n === "number" ? Math.round(n * 100) / 100 : n);
function classForLevel(levelTR) {
  if (levelTR === "YEŞİL") return "green";
  if (levelTR === "SARI") return "yellow";
  return "red";
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const seriesHash = (arr) => Array.isArray(arr) ? arr.map(d => `${d.ts}:${d.count}`).join('|') : '';

// Seri dakikalık [{ts, count}] geliyor. 1 saatlik kovalar.
function bucketizeSeriesByHour(series) {
  if (!series || series.length === 0) return [];
  const buckets = new Map();
  for (const p of series) {
    const d = new Date(p.ts);
    const b = new Date(d);
    b.setMinutes(0, 0, 0);
    const key = b.toISOString();
    buckets.set(key, (buckets.get(key) || 0) + (p.count || 0));
  }
  return Array.from(buckets.entries())
    .map(([ts, count]) => ({ ts, count }))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

/* küçük sparkline (kart içi n_t trendi) */
function px(val, min, max, H) {
  if (max === min) return H / 2;
  return H - ((val - min) * (H / (max - min)));
}
function sparklineSVG(series, width = 320, height = 48) {
  if (!series || series.length === 0)
    return `<svg class="spark" viewBox="0 0 ${width} ${height}"></svg>`;
  const n = series.length, W = width, H = height, pad = 4, ys = series.map(s => s.y);
  const yMin = Math.min(...ys), yMax = Math.max(...ys), step = (W - pad * 2) / Math.max(1, n - 1);
  let points = "";
  for (let i = 0; i < n; i++) {
    const x = pad + i * step;
    const y = px(series[i].y, yMin, yMax, H - pad * 2) + pad;
    points += `${x.toFixed(1)},${y.toFixed(1)} `;
  }
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline fill="none" stroke="#94a3b8" stroke-width="2" points="${points.trim()}"></polyline>
  </svg>`;
}

/* toplam geçiş bar grafiği (etiket yoğunluğu otomatik) */
function barChartSVG(data, width = 1100, height = 180) {
  const pad = 28;
  const n = data.length;
  if (n === 0) return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:${height}px"></svg>`;

  const max = Math.max(...data.map(d => d.count), 1);
  const bw = (width - pad * 2) / n;
  const showEvery = Math.max(1, Math.ceil(n / 12));
  const tickEvery = Math.max(1, Math.ceil(n / 6));
  const rects = [], labels = [], ticks = [];

  for (let i = 0; i < n; i++) {
    const h = (data[i].count / max) * (height - pad * 2);
    const x = pad + i * bw;
    const y = height - pad - h;

    rects.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 3).toFixed(1)}" height="${h.toFixed(1)}"
             rx="4" ry="4" fill="#94a3b8" opacity="0.9"></rect>`
    );

    if (i % showEvery === 0 || bw >= 26) {
      const ly = Math.max(12, y - 6);
      labels.push(
        `<text x="${(x + Math.max(1, bw - 3) / 2).toFixed(1)}" y="${ly.toFixed(1)}"
               font-size="12" text-anchor="middle" fill="#cbd5e1">${data[i].count}</text>`
      );
    }

    if (i % tickEvery === 0 || i === n - 1) {
      const t = new Date(data[i].ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      ticks.push(
        `<text x="${(x).toFixed(1)}" y="${(height - 8).toFixed(1)}" font-size="11" fill="#94a3b8">${t}</text>`
      );
    }
  }
  const axis = `<line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#334155" stroke-width="1"/>`;
  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:${height}px" preserveAspectRatio="none">${axis}${rects.join("")}${labels.join("")}${ticks.join("")}</svg>`;
}

// ====== API helpers ======
async function apiSummary(signal) {
  const r = await fetch('/api/summary?minutes=60', { signal, cache: 'no-store', keepalive: true });
  return r.ok ? r.json() : [];
}
async function apiLatest(signal) {
  const r = await fetch('/api/latest?minutes=200', { signal, cache: 'no-store', keepalive: true });
  return r.ok ? r.json() : [];
}
async function apiSetOfficers(cp, count) {
  await fetch('/api/capacity', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkpoint_id: cp, officers: count })
  });
}
async function apiDestinations(signal) {
  try {
    const r = await fetch('/api/destinations', { signal, cache: 'no-store', keepalive: true });
    return r.ok ? r.json() : { destinations: [] };
  } catch { return { destinations: [] }; }
}
async function apiCurrentRho(signal) {
  try {
    const r = await fetch('/api/current-rho', { signal, cache: 'no-store', keepalive: true });
    return r.ok ? r.json() : { rho: 0.0, lambda_hat: 0.0, mu: 0.0 };
  } catch { return { rho: 0.0, lambda_hat: 0.0, mu: 0.0 }; }
}
async function apiMetricsLast(minutes, signal) {
  try {
    const r = await fetch(`/api/metrics/last_minutes?minutes=${minutes}`, { signal, cache: 'no-store', keepalive: true });
    return r.ok ? r.json() : null;
  } catch { return null; }
}
// CSV'nin son N satırı (cache bypass)
async function apiCsvLatest(limit = 50, signal) {
  const r = await fetch(`/api/csv/latest?limit=${limit}&_t=${Date.now()}`, {
    signal,
    cache: 'no-store',
    keepalive: true
  });
  if (!r.ok) return null;
  return await r.json();
}


// ====== data shaping ======
function groupLatestByCp(latest) {
  const map = {};
  for (const r of latest) map[r.checkpoint_id + "|" + r.ts_minute] = r;
  const byCp = {};
  Object.values(map).forEach(r => { (byCp[r.checkpoint_id] ||= []).push(r); });
  for (const cp in byCp) byCp[cp].sort((a, b) => a.ts_minute < b.ts_minute ? -1 : 1);
  return byCp;
}
function aggregateTotalPerMinute(latest) {
  const dedup = {};
  latest.forEach(r => { dedup[r.checkpoint_id + "|" + r.ts_minute] = r; });
  const map = {};
  Object.values(dedup).forEach(r => {
    const ts = r.ts_minute;
    map[ts] = (map[ts] || 0) + (r.n_t || 0);
  });
  const arr = Object.entries(map).map(([ts, count]) => ({ ts, count }));
  arr.sort((a, b) => a.ts < b.ts ? -1 : 1);
  return arr.slice(-60);
}

// ====== CSV table (incremental) ======
// ====== CSV table (reconcile + incremental, robust) ======
const CsvTable = (() => {
  let headerDrawn = false;
  let prevIds = new Set();
  let tbodyEl = null;
  let lastCols = [];

  const makeId = (r) =>
    r.__rowid ??
    [
      r.ts_minute || r.ts || r.time || '',
      r.checkpoint_id || r.cp || '',
      r.pnr || r.id || ''
    ].join('|');

  function rebuild(tbl, cols, rows) {
    let html = '<thead><tr>' +
      cols.filter(c => c !== '__rowid').map(c => `<th>${c}</th>`).join('') +
      '</tr></thead><tbody>';

    const newSet = new Set();
    for (const r of rows) {
      const rid = makeId(r);
      newSet.add(rid);
      html += `<tr data-rid="${rid}">`;
      for (const c of cols) if (c !== '__rowid') html += `<td>${r[c] ?? ''}</td>`;
      html += '</tr>';
    }
    html += '</tbody>';
    tbl.innerHTML = html;
    tbodyEl = tbl.querySelector('tbody');
    headerDrawn = true;
    prevIds = newSet;
    lastCols = cols.slice();
  }

  function upsert(data) {
    const tbl = document.getElementById('csvTable');
    if (!tbl) return;

    const cols = data?.columns ?? [];
    const rows = (data?.rows ?? []).slice(-50); // son 50 ile çalış
    if (cols.length === 0) {
      tbl.innerHTML = `<tbody><tr><td class="muted">CSV boş veya okunamadı.</td></tr></tbody>`;
      headerDrawn = false; prevIds.clear(); tbodyEl = null; lastCols = [];
      return;
    }

    if (!headerDrawn || !tbodyEl || !same(cols, lastCols)) {
      rebuild(tbl, cols, rows);
      return;
    }

    const incomingIds = rows.map(makeId);
    const unknown = incomingIds.filter(id => !prevIds.has(id)).length;

    // Gelen küme büyük ölçüde farklıysa veya satır sayısı değiştiyse tam rebuild
    if (tbodyEl.rows.length !== rows.length || unknown > 5) {
      rebuild(tbl, cols, rows);
      return;
    }

    // Küçük farklarda inkremental ekle
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const rid = makeId(r);
      if (prevIds.has(rid)) continue;
      const tr = document.createElement('tr');
      tr.className = 'rowNew';
      tr.dataset.rid = rid;
      for (const c of cols) {
        if (c === '__rowid') continue;
        const td = document.createElement('td');
        td.textContent = r[c] ?? '';
        tr.appendChild(td);
      }
      frag.appendChild(tr);
      prevIds.add(rid);
    }
    if (frag.childNodes.length) tbodyEl.appendChild(frag);

    // tam 50 satırı koru ve prevIds'ten düş
    while (tbodyEl && tbodyEl.rows.length > 50) {
      const rid = tbodyEl.rows[0].dataset.rid;
      if (rid) prevIds.delete(rid);
      tbodyEl.deleteRow(0);
    }
  }

  function reset(){ headerDrawn = false; prevIds.clear(); tbodyEl = null; lastCols = []; }

  return { upsert, reset };
})();


// ====== ρ gauge ======
function createGaugeChart(rho, width = 200, height = 150) {
  const radius = Math.min(width, height) * 0.8;
  const centerX = width / 2;
  const centerY = height * 0.8;
  const maxRho = 3.0;
  const clampedRho = Math.min(rho, maxRho);
  const percentage = (clampedRho / maxRho) * 100;

  let color = "#16a34a"; // GREEN
  if (rho >= 0.9) color = "#ef4444";       // RED
  else if (rho >= 0.7 && rho < 0.9) color = "#eab308"; // YELLOW (fix)
  else color = "#16a34a";                   // GREEN

  const backgroundPath = [
    `M ${centerX - radius} ${centerY}`,
    `A ${radius} ${radius} 0 0 1 ${centerX + radius} ${centerY}`
  ].join(' ');

  const angle = (percentage / 100) * Math.PI;
  const endX = centerX + radius * Math.cos(Math.PI - angle);
  const endY = centerY - radius * Math.sin(Math.PI - angle);
  const valuePath = [
    `M ${centerX - radius} ${centerY}`,
    `A ${radius} ${radius} 0 0 1 ${endX} ${endY}`
  ].join(' ');

  const needleX = centerX + (radius * 0.9) * Math.cos(Math.PI - angle);
  const needleY = centerY - (radius * 0.9) * Math.sin(Math.PI - angle);

  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:${height}px">
    <path d="${backgroundPath}" fill="none" stroke="#334155" stroke-width="8" stroke-linecap="round"/>
    <path d="${valuePath}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"/>
    <line x1="${centerX}" y1="${centerY}" x2="${needleX}" y2="${needleY}" stroke="#e5e7eb" stroke-width="2" stroke-linecap="round"/>
    <circle cx="${centerX}" cy="${centerY}" r="4" fill="#e5e7eb"/>
    <text x="${centerX}" y="${centerY + radius * 0.25}" text-anchor="middle" fill="currentColor" font-size="14" font-weight="bold">ρ ${fmt(rho)}</text>
    <text x="${centerX}" y="${centerY + radius * 0.4}" text-anchor="middle" fill="var(--muted)" font-size="10">${percentage.toFixed(1)}%</text>
  </svg>`;
}

// ====== THEME ======
(function initTheme() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  if (!btn.__bound) {
    btn.addEventListener('click', () => {
      const body = document.body;
      body.classList.toggle('light');
      btn.innerHTML = body.classList.contains('light') ? '🌙' : '☀️';
      btn.title = body.classList.contains('light') ? 'Koyu Temaya Geç' : 'Açık Temaya Geç';
      localStorage.setItem('theme', body.classList.contains('light') ? 'light' : 'dark');
    });
    btn.__bound = true;
  }
  const saved = localStorage.getItem('theme');
  const body = document.body;
  if (saved === 'light') { body.classList.add('light'); btn.innerHTML = '🌙'; btn.title = 'Koyu Temaya Geç'; }
  else { btn.innerHTML = '☀️'; btn.title = 'Açık Temaya Geç'; }
})();

// ====== RENDER ======
const UI = (() => {
  let chartHourHash = '', chartDayHash = '', destHash = '', lastRho = null;
  let lastHourSeries = [], lastDaySeries = [], lastDest = [];

  // Responsive: sadece genişlik değişince grafikleri yeniden çiz
  const ro = new ResizeObserver(entries => {
    for (const e of entries) {
      const id = e.target.id;
      if (id === 'chartHour' && lastHourSeries.length) drawChartHour(lastHourSeries);
      if (id === 'chartDay' && lastDaySeries.length) drawChartDay(lastDaySeries);
      if (id === 'destinationsChart' && lastDest.length) drawDestinations(lastDest);
      if (id === 'rhoGauge' && lastRho != null) drawGauge(lastRho);
    }
  });
  ['chartHour','chartDay','destinationsChart','rhoGauge'].forEach(id => { const el = document.getElementById(id); if (el) ro.observe(el); });

  function setKpis(kpis) {
    const totalEl = document.getElementById('kpiTotal');
    const avgEl = document.getElementById('kpiAvg');
    const peakEl = document.getElementById('kpiPeak');
    const peakTimeEl = document.getElementById('kpiPeakTime');
    const cpEl = document.getElementById('kpiCpCount');
    totalEl && (totalEl.textContent = kpis.total ?? 0);
    avgEl && (avgEl.textContent = `${fmt(kpis.avg_per_min ?? 0)} kişi/dk`);
    peakEl && (peakEl.textContent = `${kpis.peak_count ?? 0} kişi`);
    peakTimeEl && (peakTimeEl.textContent = kpis.peak_ts ? new Date(kpis.peak_ts).toLocaleTimeString('tr-TR', {hour:'2-digit', minute:'2-digit'}) : '—');
    cpEl && (cpEl.textContent = kpis.cp_count ?? '0');
  }

  function drawChartHour(series) {
    const el = document.getElementById('chartHour');
    if (!el) return;
    const h = seriesHash(series);
    if (h === chartHourHash) return; // değişmediyse çizme
    chartHourHash = h; lastHourSeries = series;
    const w = Math.max(el.clientWidth || 1100, 600);
    el.innerHTML = barChartSVG(series, w, 180);
  }

  function drawChartDay(series) {
    const el = document.getElementById('chartDay');
    if (!el) return;
    const h = seriesHash(series);
    if (h === chartDayHash) return;
    chartDayHash = h; lastDaySeries = series;
    const w2 = Math.max(el.clientWidth || 1100, 600);
    el.innerHTML = barChartSVG(series, w2, 180);
  }

  function drawDestinations(payload) {
    const el = document.getElementById('destinationsChart');
    if (!el) { console.warn('#destinationsChart bulunamadı'); return; }
  
    const data = normalizeDestinations(payload);
    const h = JSON.stringify(data);
    if (h === destHash) return; // değişmediyse çizme
  
    destHash = h; lastDest = data;
    const w = Math.max(el.clientWidth || 600, 400);
    const hgt = Math.max(el.clientHeight || 220, 160);
    el.innerHTML = createPieChart(data, w, hgt);
  }
  

  function drawGauge(rho) {
    const el = document.getElementById('rhoGauge');
    if (!el) return;
    lastRho = rho;
    const w = Math.max(el.clientWidth || 200, 150);
    el.innerHTML = createGaugeChart(rho, w, 150);
  }

  function normalizeDestinations(payload) {
    if (!payload) return [];
    // payload array olabilir veya {destinations:[…]}, {top:[…]}, {top_destinations:[…]}
    const arr = Array.isArray(payload)
      ? payload
      : (payload.destinations ?? payload.top ?? payload.top_destinations ?? []);
  
    return arr
      .map(d => {
        const name = d.dest ?? d.destination ?? d.code ?? d.name ?? '—';
        const count = Number(d.count ?? d.value ?? d.freq ?? 0);
        const percentage = d.percentage ?? d.percent ?? null;
        return { name, dest: name, count, percentage };
      })
      .filter(d => d.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }
  
  function createPieChart(data, width = 600, height = 280) {
    // soldaki pastanın boyutu: panel yüksekliği ve toplam genişliğe göre
    const pie = Math.max(220, Math.min(height - 20, Math.floor(width * 0.42)));
    const size = pie;
    const cx = size / 2, cy = size / 2, r = size / 2 - 10;
  
    const total = data.reduce((s, d) => s + (d.count || 0), 0) || 1;
    const palette = ["#60a5fa","#ef4444","#22c55e","#f59e0b","#a78bfa","#f472b6","#06b6d4","#8b5cf6","#fb7185","#f97316"];
  
    let acc = 0;
    const slices = [];
    const labels = [];
  
    data.forEach((d, idx) => {
      const value = (d.count || 0);
      const v = value / total;
      const a0 = acc * 2 * Math.PI - Math.PI / 2;
      acc += v;
      const a1 = acc * 2 * Math.PI - Math.PI / 2;
      const mid = (a0 + a1) / 2;
  
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const large = (a1 - a0) > Math.PI ? 1 : 0;
      const color = palette[idx % palette.length];
  
      // dilim
      slices.push(
        `<path d="M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z"
                fill="${color}" opacity="0.92">
           <title>${(d.dest ?? d.name ?? '').toString().toUpperCase()}: ${value}${d.percentage != null ? ` (${d.percentage}%)` : ''}</title>
         </path>`
      );
  
      // dilim üstü 3 harflik kısaltma (çok ufak dilimler gürültü yapmasın diye %5 eşik)
      const code = (d.dest ?? d.name ?? '').toString().slice(0,3).toUpperCase();
      if (code && v >= 0.05) {
        const lx = cx + (r * 0.62) * Math.cos(mid);
        const ly = cy + (r * 0.62) * Math.sin(mid);
        labels.push(
          `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}"
                 text-anchor="middle" dominant-baseline="middle"
                 style="font-size:12px;font-weight:800;fill:#fff;paint-order:stroke;stroke:#000;stroke-width:2;stroke-opacity:.35">
            ${code}
           </text>`
        );
      }
    });
  
    // Sağdaki legend: 2 sütun
  const legend = data.map((d, idx) => {
    const color = palette[idx % palette.length];
    const name = (d.dest ?? d.name ?? '').toString().toUpperCase();
    const pct = (d.percentage != null) ? d.percentage : ((d.count || 0) / total * 100);
    const pctText = pct.toLocaleString('tr-TR', {maximumFractionDigits:1, minimumFractionDigits:1});
    const countText = (d.count || 0).toLocaleString('tr-TR');
    return `<div style="display:flex;align-items:center;gap:8px;">
      <span style="width:10px;height:10px;border-radius:2px;background:${color};display:inline-block"></span>
      <span style="font-size:12px;opacity:.95">${name} (${countText} - %${pctText})</span>
    </div>`;
  }).join('');

  // Basit, temiz düzen: solda pasta, sağda 2 sütun legend
  return `
  <div style="display:flex;align-items:center;justify-content:center;gap:24px;">
    <div style="flex:0 0 ${pie}px;display:flex;align-items:center;justify-content:center">
      <svg viewBox="0 0 ${size} ${size}" width="${pie}" height="${pie}">
        ${slices.join('')}
        ${labels.join('')}
      </svg>
    </div>
    <div style="flex:1 1 520px;display:grid;grid-template-columns:repeat(2,minmax(180px,1fr));
                gap:8px 16px;align-content:start">
      ${legend}
    </div>
  </div>`;
  }
  

  function drawCards(summary, latest) {
    const byCpSummary = {}; summary.forEach(s => { byCpSummary[s.checkpoint_id] = s; });
    const latestByCp = groupLatestByCp(latest);

    const grid = document.getElementById('grid');
    grid.innerHTML = '';

    for (const cp in byCpSummary) {
      const s = byCpSummary[cp];
      const cls = (s.level === 'YEŞİL') ? 'green' : (s.level === 'SARI' ? 'yellow' : 'red');
      const seriesNt = (latestByCp[cp] || []).slice(-30).map(r => ({ x: r.ts_minute, y: (r.n_t ?? 0) }));
      const spark = sparklineSVG(seriesNt);
      const officersMatch = s.detail?.match(/görevli:\s*(\d+)/);
      const officers = officersMatch ? officersMatch[1] : '1';
      const rhoTxt = `ρ ${fmt(s.rho)}×`;

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="row">
          <div class="titleRow">${s.emoji || ''} ${cp}</div>
          <div class="level ${cls}">${s.level}</div>
        </div>
        <div class="row" style="margin-top:6px;">
          <div class="big">${rhoTxt}</div>
          <div class="controls">
            <button class="btn" data-op="-" title="Görevliyi azalt">−</button>
            <div class="badge">Görevli: <b class="off">${officers}</b></div>
            <button class="btn" data-op="+" title="Görevliyi artır">+</button>
          </div>
        </div>
        <div class="muted" style="margin-top:8px;">${s.detail || ''}</div>
        <div style="margin-top:8px">${spark}</div>
        <div class="footer">
          <div class="advice">${s.advice || ''}</div>
          <div class="time">Zaman: ${s.time || ''}</div>
        </div>`;

      const offEl = card.querySelector('.off');
      card.querySelector('[data-op="-"]').addEventListener('click', async () => {
        const curr = parseInt(offEl.textContent || '1', 10);
        const nxt = Math.max(1, curr - 1);
        await apiSetOfficers(cp, nxt);
        offEl.textContent = String(nxt);
        Scheduler.requestTickSoon();
      });
      card.querySelector('[data-op="+"]').addEventListener('click', async () => {
        const curr = parseInt(offEl.textContent || '1', 10);
        const nxt = curr + 1;
        await apiSetOfficers(cp, nxt);
        offEl.textContent = String(nxt);
        Scheduler.requestTickSoon();
      });

      grid.appendChild(card);
    }

    if (Object.keys(byCpSummary).length === 0) {
      const empty = document.createElement('div');
      empty.className = 'card';
      empty.innerHTML = `<div class="titleRow">Henüz veri yok</div><div class="muted">CSV'ye kayıt düştükçe burada görünecek.</div>`;
      grid.appendChild(empty);
    }
  }

  function setLastUpdated() {
    const badge = document.getElementById('lastUpdated');
    if (badge) badge.textContent = 'Güncelleme: ' + new Date().toLocaleTimeString('tr-TR');
  }

  return {
    paint({ summary, latest, metrics, metrics24, csvData, destinations, currentRho }) {
      setLastUpdated();

      let series = [], kpis = null;
      if (metrics && metrics.series && metrics.kpis) {
        series = metrics.series;
        kpis = metrics.kpis;
      } else {
        series = aggregateTotalPerMinute(latest || []);
        const total = series.reduce((s, d) => s + d.count, 0);
        const avg = series.length ? total / series.length : 0;
        let peak = { count: 0, ts: null };
        series.forEach(d => { if (d.count > peak.count) peak = d; });
        const byCpSummaryTmp = {}; (summary||[]).forEach(s => { byCpSummaryTmp[s.checkpoint_id] = s; });
        kpis = { total, avg_per_min: fmt(avg), peak_count: peak.count || 0, peak_ts: peak.ts || null, cp_count: Object.keys(byCpSummaryTmp).length || 0 };
      }
      setKpis(kpis);
      drawChartHour(series);

      if (metrics24 && metrics24.series) {
        const hourlySeries = bucketizeSeriesByHour(metrics24.series).slice(-24);
        drawChartDay(hourlySeries);
      }

      if (destinations) {
        drawDestinations(destinations);
      }
      

      if (currentRho && typeof currentRho.rho === 'number') {
        drawGauge(currentRho.rho);
      }

      drawCards(summary || [], latest || []);

      if (csvData) CsvTable.upsert(csvData);
    },
    resetCsv() { CsvTable.reset(); }
  };
})();

// ====== SCHEDULER (tek döngü, çakışan istek yok) ======
const Scheduler = (() => {
  let ctrl = null;
  let nextTimer = null;
  const PERIOD = 3000; // 3s

  async function tick() {
    ctrl?.abort();
    ctrl = new AbortController();
    const signal = ctrl.signal;

    // Paralel istekler (her biri fail ederse null dönsün)
    const [summary, latest, metrics, csvData, destinations, currentRho] = await Promise.all([
      apiSummary(signal).catch(() => []),
      apiLatest(signal).catch(() => []),
      apiMetricsLast(60, signal).catch(() => null),
      apiCsvLatest(50, signal).catch(() => null),
      apiDestinations(signal).catch(() => ({ destinations: [] })),
      apiCurrentRho(signal).catch(() => ({ rho: 0.0 }))
    ]);

    // Son 24 saatlik seri (ayrı istek; önceki iptal olabilir)
    const metrics24 = await apiMetricsLast(60 * 24, signal).catch(() => null);

    if (signal.aborted) return; // iptal edildiyse boyama yapma

    requestAnimationFrame(() => UI.paint({ summary, latest, metrics, metrics24, csvData, destinations, currentRho }));

    // sıradaki tick
    nextTimer = setTimeout(tick, PERIOD);
  }

  function start() { if (!nextTimer) tick(); }
  function stop() { if (nextTimer) { clearTimeout(nextTimer); nextTimer = null; } ctrl?.abort(); }
  function requestTickSoon() { if (nextTimer) { clearTimeout(nextTimer); nextTimer = null; } tick(); }

  return { start, stop, requestTickSoon };
})();

// Başlat
Scheduler.start();

/* === CSV LIVE (basit ve sade) ===============================
   - Her 1 sn'de /api/csv/latest?limit=50 çağrılır (cache yok)
   - Gelen satırlar #csvTable içine komple yazılır
   - Başlık sırası ekrandakiyle uyumlu (bulduklarımızı yazar)
============================================================= */
(function csvLiveSimple(){
  const PREFERRED = [
    'ID','Name','PNR','OriginAirport','DestinationAirport','IATA',
    'FlightNumber','FlightDate','CheckDate','IsSuccess','ErrorReason','Type'
  ];
  const tbl = document.getElementById('csvTable');
  if (!tbl) return;

  // küçük yardımcılar
  const norm = k => (k||'').toString().toLowerCase();
  const pickKey = (obj, name) => {
    const want = norm(name);
    return Object.keys(obj).find(k => norm(k) === want) || null;
  };
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  let lastHash = '';

  async function tick(){
    try {
      const r = await fetch(`/api/csv/latest?limit=50&_t=${Date.now()}`, { cache:'no-store' });
      if (!r.ok) throw new Error(r.status);
      const payload = await r.json();                    // NOT: bu bir dosya değil, HTTP yanıt formatı
      const rows = Array.isArray(payload) ? payload : (payload.rows ?? payload.data ?? []);
      if (!Array.isArray(rows) || rows.length === 0) { schedule(); return; }

      // değişim kontrolü (50 satır için hafif)
      const h = JSON.stringify(rows);
      if (h === lastHash) { schedule(); return; }
      lastHash = h;

      // kolonları sırala
      const cols = [];
      for (const name of PREFERRED) {
        const k = pickKey(rows[0], name);
        if (k) cols.push({key:k, title:name});
      }
      // tabloda olmayan ama gelen ekstra kolonlar da sona eklensin
      const have = new Set(cols.map(c => c.key));
      for (const k of Object.keys(rows[0])) if (!have.has(k)) {
        cols.push({key:k, title:k});
      }

      // başlık
      let html = '<thead><tr>';
      for (const c of cols) html += `<th>${escape(c.title)}</th>`;
      html += '</tr></thead><tbody>';

      // satırlar
      for (const r0 of rows) {
        html += '<tr>';
        for (const c of cols) html += `<td>${escape(r0[c.key])}</td>`;
        html += '</tr>';
      }
      html += '</tbody>';

      tbl.innerHTML = html;  // tek hamlede yaz: basit ve hızlı
    } catch (e) {
      // sessizce tekrar dene
    } finally {
      schedule();
    }
  }
  function schedule(){ setTimeout(tick, 3000); }  // 1 sn
  tick();
})();
