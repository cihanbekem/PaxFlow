// ====== helpers ======
const fmt = n => (typeof n === "number" ? Math.round(n * 100) / 100 : n);
function classForLevel(levelTR) {
  if (levelTR === "YEŞİL") return "green";
  if (levelTR === "SARI") return "yellow";
  return "red";
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

/* toplam geçiş bar grafiği (son 60 dk, tüm CP toplamı) + SAYI ETİKETLERİ */
function barChartSVG(data, width = 1100, height = 180) {
  const pad = 28;
  const n = data.length;
  if (n === 0) return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:${height}px"></svg>`;

  const max = Math.max(...data.map(d => d.count), 1);
  const bw = (width - pad * 2) / n;

  // Etiket yoğunluğunu otomatik ayarla (ekran kalabalık olmasın)
  const showEvery = Math.max(1, Math.ceil(n / 12));  // ~12 label
  const tickEvery = Math.max(1, Math.ceil(n / 6));   // ~6 x-tick
  const rects = [];
  const labels = [];
  const ticks = [];

  for (let i = 0; i < n; i++) {
    const h = (data[i].count / max) * (height - pad * 2);
    const x = pad + i * bw;
    const y = height - pad - h;

    rects.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 3).toFixed(1)}" height="${h.toFixed(1)}"
             rx="4" ry="4" fill="#94a3b8" opacity="0.9"></rect>`
    );

    // sayı etiketi (bar üstüne)
    if (i % showEvery === 0 || bw >= 26) {
      const ly = Math.max(12, y - 6); // üstte yer yoksa çakışmasın
      labels.push(
        `<text x="${(x + Math.max(1, bw - 3) / 2).toFixed(1)}" y="${ly.toFixed(1)}"
               font-size="12" text-anchor="middle" fill="#cbd5e1">${data[i].count}</text>`
      );
    }

    // x-ekseni tick (saat:dakika)
    if (i % tickEvery === 0 || i === n - 1) {
      const t = new Date(data[i].ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      ticks.push(
        `<text x="${(x).toFixed(1)}" y="${(height - 8).toFixed(1)}" font-size="11" fill="#94a3b8">${t}</text>`
      );
    }
  }

  // alt eksen çizgisi
  const axis = `<line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#334155" stroke-width="1"/>`;

  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:${height}px" preserveAspectRatio="none">
    ${axis}
    ${rects.join("")}
    ${labels.join("")}
    ${ticks.join("")}
  </svg>`;
}

// ====== API helpers ======
async function apiSummary() {
  const r = await fetch('/api/summary?minutes=60');
  return await r.json();
}
async function apiLatest() {
  const r = await fetch('/api/latest?minutes=200');
  return await r.json();
}
async function apiSetOfficers(cp, count) {
  await fetch('/api/capacity', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkpoint_id: cp, officers: count })
  });
}
// Yeni: CSV tabanlı metrik (varsa kullan; yoksa fallback yapacağız)
async function apiMetricsLast(minutes = 60) {
  try {
    const r = await fetch(`/api/metrics/last_minutes?minutes=${minutes}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
// CSV canlı akış
async function apiCsvLatest(limit = 50) {
  const r = await fetch(`/api/csv/latest?limit=${limit}`);
  if (!r.ok) throw new Error(`csv/latest ${r.status}`);
  return await r.json();
}

// ====== data shaping ======
/* (ts_minute, cp) bazında son kaydı al → CP bazında dizi döndür */
function groupLatestByCp(latest) {
  const map = {};
  for (const r of latest) map[r.checkpoint_id + "|" + r.ts_minute] = r;
  const byCp = {};
  Object.values(map).forEach(r => { (byCp[r.checkpoint_id] ||= []).push(r); });
  for (const cp in byCp) byCp[cp].sort((a, b) => a.ts_minute < b.ts_minute ? -1 : 1);
  return byCp;
}

/* Fallback: tüm CP’leri toplayıp dakika bazında toplam geçiş (son 60 dk) */
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

// CSV tablo render
function renderCsvTable(data, prevIds) {
  const tbl = document.getElementById('csvTable');
  if (!tbl) return new Set(); // panel yoksa atla

  const cols = (data && data.columns) ? data.columns : [];
  const rows = (data && data.rows) ? data.rows : [];
  if (cols.length === 0) {
    tbl.innerHTML = `<tbody><tr><td class="muted">CSV boş veya okunamadı.</td></tr></tbody>`;
    return new Set();
  }

  // Header
  let thead = '<thead><tr>';
  cols.forEach(c => { if (c !== "__rowid") thead += `<th>${c}</th>`; });
  thead += '</tr></thead>';

  // Body
  let tbody = '<tbody>';
  rows.forEach(r => {
    const isNew = prevIds ? !prevIds.has(r.__rowid) : false;
    tbody += `<tr class="${isNew ? 'rowNew' : ''}">`;
    cols.forEach(c => { if (c !== "__rowid") tbody += `<td>${r[c] ?? ''}</td>`; });
    tbody += '</tr>';
  });
  tbody += '</tbody>';

  tbl.innerHTML = thead + tbody;

  return new Set(rows.map(r => r.__rowid));
}

// ====== render ======
async function render() {
  const [summary, latest, metrics, csvDataOrNull] = await Promise.all([
    apiSummary(),
    apiLatest(),
    apiMetricsLast(60),      // varsa kullanacağız
    (async () => { try { return await apiCsvLatest(50); } catch { return null; } })(),
  ]);

  document.getElementById('lastUpdated').textContent =
    "Güncelleme: " + new Date().toLocaleTimeString('tr-TR');

  // ---- ÜST KPI + BAR GRAFİĞİ ----
  let series, kpis;
  if (metrics && metrics.series && metrics.kpis) {
    // Backend'teki /api/metrics/last_minutes kullan
    series = metrics.series;               // [{ts, count}]
    kpis = metrics.kpis;                   // {total, avg_per_min, peak_count, peak_ts, cp_count}
  } else {
    // Fallback: /api/latest verisinden türet
    series = aggregateTotalPerMinute(latest);
    const total = series.reduce((s, d) => s + d.count, 0);
    const avg = series.length ? total / series.length : 0;
    let peak = { count: 0, ts: null };
    series.forEach(d => { if (d.count > peak.count) peak = d; });
    const byCpSummaryTmp = {};
    summary.forEach(s => { byCpSummaryTmp[s.checkpoint_id] = s; });
    kpis = {
      total,
      avg_per_min: fmt(avg),
      peak_count: peak.count || 0,
      peak_ts: peak.ts || null,
      cp_count: Object.keys(byCpSummaryTmp).length || 0
    };
  }

  // KPI yaz
  document.getElementById('kpiTotal').textContent = kpis.total ?? 0;
  document.getElementById('kpiAvg').textContent = `${fmt(kpis.avg_per_min ?? 0)} kişi/dk`;
  document.getElementById('kpiPeak').textContent = `${kpis.peak_count ?? 0} kişi`;
  document.getElementById('kpiPeakTime').textContent =
    kpis.peak_ts ? new Date(kpis.peak_ts).toLocaleTimeString('tr-TR', { hour: "2-digit", minute: "2-digit" }) : "—";
  document.getElementById('kpiCpCount').textContent = kpis.cp_count ?? "0";

  // Bar grafiği (responsive genişlik)
  const chartEl = document.getElementById('chartHour');
  if (chartEl) {
    const w = Math.max(chartEl.clientWidth || 1100, 600);
    chartEl.innerHTML = barChartSVG(series, w, 180);
  }

  // ---- CP KARTLARI ----
  const byCpSummary = {};
  summary.forEach(s => { byCpSummary[s.checkpoint_id] = s; });

  const latestByCp = groupLatestByCp(latest);
  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  for (const cp in byCpSummary) {
    const s = byCpSummary[cp];
    const cls = (s.level === "YEŞİL") ? 'green' : (s.level === "SARI" ? 'yellow' : 'red');

    // kart içi n_t sparkline (son 30 dk)
    const seriesNt = (latestByCp[cp] || []).slice(-30).map(r => ({ x: r.ts_minute, y: (r.n_t ?? 0) }));
    const spark = sparklineSVG(seriesNt);

    // officers sayısı (metinden)
    const officersMatch = s.detail.match(/görevli:\s*(\d+)/);
    const officers = officersMatch ? officersMatch[1] : "1";
    const rhoTxt = `ρ ${fmt(s.rho)}×`;

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="row">
        <div class="titleRow">${s.emoji} ${cp}</div>
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

      <div class="muted" style="margin-top:8px;">${s.detail}</div>
      <div style="margin-top:8px">${spark}</div>

      <div class="footer">
        <div class="advice">${s.advice}</div>
        <div class="time">Zaman: ${s.time}</div>
      </div>
    `;

    // +/− event
    const offEl = card.querySelector('.off');
    card.querySelector('[data-op="-"]').addEventListener('click', async () => {
      const curr = parseInt(offEl.textContent || "1", 10);
      const nxt = Math.max(1, curr - 1);
      await apiSetOfficers(cp, nxt);
      offEl.textContent = String(nxt);
      await render();
    });
    card.querySelector('[data-op="+"]').addEventListener('click', async () => {
      const curr = parseInt(offEl.textContent || "1", 10);
      const nxt = curr + 1;
      await apiSetOfficers(cp, nxt);
      offEl.textContent = String(nxt);
      await render();
    });

    grid.appendChild(card);
  }

  if (Object.keys(byCpSummary).length === 0) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.innerHTML = `<div class="titleRow">Henüz veri yok</div>
      <div class="muted">CSV'ye kayıt düştükçe burada görünecek.</div>`;
    grid.appendChild(empty);
  }

  // ---- CSV canlı akış tablosu ----
  if (csvDataOrNull) {
    window.__prevCsvIds = window.__prevCsvIds || new Set();
    window.__prevCsvIds = renderCsvTable(csvDataOrNull, window.__prevCsvIds);
  }
}

/* tema düğmesi */
document.getElementById('themeToggle').addEventListener('click', () => document.body.classList.toggle('light'));

/* ilk yük + periyodik */
render();
setInterval(render, 3000);
