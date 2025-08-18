// ====== helpers ======
const fmt = n => (typeof n === "number" ? Math.round(n * 100) / 100 : n);
function classForLevel(levelTR) {
  if (levelTR === "YEŞİL") return "green";
  if (levelTR === "SARI") return "yellow";
  return "red";
}

// Seri dakikalık [{ts, count}] geliyor. Bunu 5 dk (veya istenen) kovalara toplayalım.
function bucketizeSeriesByMinutes(series, bucketMinutes = 5) {
  if (!series || series.length === 0) return [];
  const buckets = new Map();
  for (const p of series) {
    const d = new Date(p.ts);
    // kovayı bul: örn. 5 dk'lık: minute -> Math.floor(min/5)*5
    const m = d.getMinutes();
    const bucketMin = Math.floor(m / bucketMinutes) * bucketMinutes;
    const b = new Date(d);
    b.setMinutes(bucketMin, 0, 0);
    const key = b.toISOString();
    buckets.set(key, (buckets.get(key) || 0) + (p.count || 0));
  }
  // zamana göre sırala
  return Array.from(buckets.entries())
    .map(([ts, count]) => ({ ts, count }))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

// YENİ: Son 24 saat için her SAATTE toplam geçen kişi
function bucketizeSeriesByHour(series) {
  if (!series || series.length === 0) return [];
  const buckets = new Map();
  for (const p of series) {
    const d = new Date(p.ts);
    const b = new Date(d);
    b.setMinutes(0, 0, 0);             // saat başına sabitle
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

// Destinasyon istatistikleri API çağrısı
async function apiDestinations() {
  try {
    const r = await fetch('/api/destinations');
    return await r.json();
  } catch (e) {
    console.error('Destinasyon verisi alınamadı:', e);
    return { destinations: [] };
  }
}

// Anlık ρ API çağrısı
async function apiCurrentRho() {
  try {
    const r = await fetch('/api/current-rho');
    return await r.json();
  } catch (e) {
    console.error('Anlık ρ verisi alınamadı:', e);
    return { rho: 0.0, lambda_hat: 0.0, mu: 0.0 };
  }
}

// Pie chart oluşturma fonksiyonu
function createPieChart(data, width = 400, height = 300) {
  if (!data || data.length === 0) {
    return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:${height}px">
      <text x="${width/2}" y="${height/2}" text-anchor="middle" fill="var(--muted)" font-size="14">Veri yok</text>
    </svg>`;
  }

  const radius = Math.min(width, height) / 2 - 40;
  const centerX = width / 2;
  const centerY = height / 2;

  const colors = [
    '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
    '#06b6d4', '#84cc16', '#f97316', '#ec4899', '#6366f1'
  ];

  let currentAngle = 0;
  const total = data.reduce((sum, item) => sum + item.count, 0);

  const slices = [];
  const labels = [];
  const legend = [];

  data.forEach((item, index) => {
    const percentage = (item.count / total) * 100;
    const angle = (item.count / total) * 2 * Math.PI;
    const endAngle = currentAngle + angle;

    const x1 = centerX + radius * Math.cos(currentAngle);
    const y1 = centerY + radius * Math.sin(currentAngle);
    const x2 = centerX + radius * Math.cos(endAngle);
    const y2 = centerY + radius * Math.sin(endAngle);

    const largeArcFlag = angle > Math.PI ? 1 : 0;

    const pathData = [
      `M ${centerX} ${centerY}`,
      `L ${x1} ${y1}`,
      `A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2}`,
      'Z'
    ].join(' ');

    slices.push(
      `<path d="${pathData}" fill="${colors[index % colors.length]}" stroke="var(--border)" stroke-width="2"/>`
    );

    if (percentage > 5) {
      const labelAngle = currentAngle + angle / 2;
      const labelRadius = radius * 0.7;
      const labelX = centerX + labelRadius * Math.cos(labelAngle);
      const labelY = centerY + labelRadius * Math.sin(labelAngle);

      labels.push(
        `<text x="${labelX}" y="${labelY}" text-anchor="middle" dominant-baseline="middle" 
               fill="white" font-size="12" font-weight="bold">${item.destination}</text>`
      );
    }

    const legendY = 20 + index * 20;
    legend.push(
      `<rect x="10" y="${legendY - 8}" width="12" height="12" fill="${colors[index % colors.length]}" rx="2"/>`,
      `<text x="30" y="${legendY}" fill="currentColor" font-size="12">${item.destination} (${item.count} - %${item.percentage})</text>`
    );

    currentAngle = endAngle;
  });

  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:${height}px">
    ${slices.join('')}
    ${labels.join('')}
    <g transform="translate(${width - 200}, 0)">
      ${legend.join('')}
    </g>
  </svg>`;
}

// Gauge chart oluşturma fonksiyonu (ρ göstergesi için)
function createGaugeChart(rho, width = 200, height = 150) {
  const radius = Math.min(width, height) * 0.8;
  const centerX = width / 2;
  const centerY = height * 0.8;

  const maxRho = 3.0;
  const clampedRho = Math.min(rho, maxRho);
  const percentage = (clampedRho / maxRho) * 100;

  let color = "#16a34a"; // GREEN
  if (rho >= 0.9) color = "#ef4444";       // RED
  else if (0.9 > rho >= 0.7) color = "#eab308"; // YELLOW
  else if (0.7 > rho) color = "#16a34a";   // GREEN

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
    <line x1="${centerX}" y1="${centerY}" x2="${needleX}" y2="${needleY}" 
          stroke="#e5e7eb" stroke-width="2" stroke-linecap="round"/>
    <circle cx="${centerX}" cy="${centerY}" r="4" fill="#e5e7eb"/>
    <text x="${centerX}" y="${centerY + radius * 0.25}" text-anchor="middle" fill="currentColor" font-size="14" font-weight="bold">ρ ${rho}</text>
    <text x="${centerX}" y="${centerY + radius * 0.4}" text-anchor="middle" fill="var(--muted)" font-size="10">${percentage.toFixed(1)}%</text>
  </svg>`;
}

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
  if (!tbl) return new Set();

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
  const [summary, latest, metrics, csvDataOrNull, destinations, currentRho] = await Promise.all([
    apiSummary(),
    apiLatest(),
    apiMetricsLast(60),      // varsa kullanacağız
    (async () => { try { return await apiCsvLatest(50); } catch { return null; } })(),
    apiDestinations(),       // destinasyon istatistikleri
    apiCurrentRho(),         // anlık ρ
  ]);

  document.getElementById('lastUpdated').textContent =
    "Güncelleme: " + new Date().toLocaleTimeString('tr-TR');

  // ---- ÜST KPI + BAR GRAFİĞİ ----
  let series, kpis;
  if (metrics && metrics.series && metrics.kpis) {
    series = metrics.series;               // [{ts, count}]
    kpis = metrics.kpis;                   // {total, avg_per_min, peak_count, peak_ts, cp_count}
  } else {
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

  // ---- Son 24 saat: HER SAATTE toplam geçen kişi grafiği ----
  const metrics24 = await apiMetricsLast(60 * 24);  // backend'den dakika serisi
  if (metrics24 && metrics24.series) {
    const hourlySeries = bucketizeSeriesByHour(metrics24.series);
    const last24 = hourlySeries.slice(-24);         // son 24 bar (24 saat)
    const dayEl = document.getElementById('chartDay');
    if (dayEl) {
      const w2 = Math.max(dayEl.clientWidth || 1100, 600);
      dayEl.innerHTML = barChartSVG(last24, w2, 180); // etiketler HH:00 görünecek
    }
  }

  // Destinasyon pie chart
  const destinationsChartEl = document.getElementById('destinationsChart');
  if (destinationsChartEl && destinations.destinations) {
    const w = Math.max(destinationsChartEl.clientWidth || 600, 400);
    const h = Math.max(destinationsChartEl.clientHeight || 200, 150);
    destinationsChartEl.innerHTML = createPieChart(destinations.destinations, w, h);
  }

  // Anlık ρ gauge chart
  const rhoGaugeEl = document.getElementById('rhoGauge');
  if (rhoGaugeEl && currentRho) {
    const w = Math.max(rhoGaugeEl.clientWidth || 200, 150);
    rhoGaugeEl.innerHTML = createGaugeChart(currentRho.rho, w, 150);
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

    const seriesNt = (latestByCp[cp] || []).slice(-30).map(r => ({ x: r.ts_minute, y: (r.n_t ?? 0) }));
    const spark = sparklineSVG(seriesNt);

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
document.getElementById('themeToggle').addEventListener('click', () => {
  const body = document.body;
  const toggleBtn = document.getElementById('themeToggle');

  body.classList.toggle('light');

  if (body.classList.contains('light')) {
    toggleBtn.innerHTML = '🌙';
    toggleBtn.title = 'Koyu Temaya Geç';
  } else {
    toggleBtn.innerHTML = '☀️';
    toggleBtn.title = 'Açık Temaya Geç';
  }

  localStorage.setItem('theme', body.classList.contains('light') ? 'light' : 'dark');
});

// Sayfa yüklendiğinde tema tercihini yükle
document.addEventListener('DOMContentLoaded', () => {
  const savedTheme = localStorage.getItem('theme');
  const body = document.body;
  const toggleBtn = document.getElementById('themeToggle');

  if (savedTheme === 'light') {
    body.classList.add('light');
    toggleBtn.innerHTML = '🌙';
    toggleBtn.title = 'Koyu Temaya Geç';
  } else {
    toggleBtn.innerHTML = '☀️';
    toggleBtn.title = 'Açık Temaya Geç';
  }
});

/* ilk yük + periyodik */
render();
setInterval(render, 3000);
