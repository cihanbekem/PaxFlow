const fmt = n => (typeof n === "number" ? Math.round(n*100)/100 : n);

function classForLevel(levelTR){
  if(levelTR === "YEŞİL") return "green";
  if(levelTR === "SARI")  return "yellow";
  return "red";
}

// küçük, bağımsız sparkline (n_t trendi)
function px(val, min, max, H){
  if(max === min) return H/2;
  return H - ((val - min) * (H/(max - min)));
}
function sparklineSVG(series, width=320, height=48){
  if(!series || series.length === 0) return `<svg class="spark" viewBox="0 0 ${width} ${height}"></svg>`;
  const n = series.length, W = width, H = height, pad = 4, ys = series.map(s => s.y);
  const yMin = Math.min(...ys), yMax = Math.max(...ys), step = (W - pad*2) / Math.max(1, n - 1);
  let points = "";
  for(let i=0;i<n;i++){
    const x = pad + i*step;
    const y = px(series[i].y, yMin, yMax, H - pad*2) + pad;
    points += `${x.toFixed(1)},${y.toFixed(1)} `;
  }
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline fill="none" stroke="#94a3b8" stroke-width="2" points="${points.trim()}"></polyline>
  </svg>`;
}

async function apiSummary(){
  const r = await fetch('/api/summary?minutes=30');
  return await r.json();
}
async function apiLatest(){
  const r = await fetch('/api/latest?minutes=120');
  return await r.json();
}
async function apiSetOfficers(cp, count){
  await fetch('/api/capacity', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ checkpoint_id: cp, officers: count })
  });
}

function groupLatestByCp(latest){
  // (ts_minute, cp) bazında son kaydı tut
  const map = {};
  for(const r of latest){
    const k = r.checkpoint_id + "|" + r.ts_minute;
    map[k] = r;
  }
  const byCp = {};
  for(const k in map){
    const [cp] = k.split("|");
    (byCp[cp] ||= []).push(map[k]);
  }
  for(const cp in byCp){ byCp[cp].sort((a,b)=> a.ts_minute < b.ts_minute ? -1 : 1); }
  return byCp;
}

async function render(){
  const [summary, latest] = await Promise.all([apiSummary(), apiLatest()]);
  document.getElementById('lastUpdated').textContent = "Güncelleme: " + new Date().toLocaleTimeString('tr-TR');

  const latestByCp = groupLatestByCp(latest);
  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  // her CP için en güncel summary
  const byCpSummary = {};
  for(const s of summary){ byCpSummary[s.checkpoint_id] = s; }

  for(const cp in byCpSummary){
    const s = byCpSummary[cp];
    const cls = classForLevel(s.level);
    const series = (latestByCp[cp] || []).slice(-30).map(r => ({x:r.ts_minute, y:(r.n_t ?? 0)}));
    const spark = sparklineSVG(series);

    // officers sayısını detail'den al (alternatif: ayrık /api eklenebilir)
    const officers = s.detail.match(/görevli:\s*(\d+)/)?.[1] || "1";
    const rhoTxt = `ρ ${fmt(s.rho)}×`;

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="row">
        <div class="title">${s.emoji} ${cp}</div>
        <div class="level ${cls}">${s.level}</div>
      </div>

      <div class="row" style="margin-top:6px;">
        <div class="big">${rhoTxt}</div>
        <div class="controls">
          <button class="btn" data-op="-">−</button>
          <div class="badge">Görevli: <b class="off">${officers}</b></div>
          <button class="btn" data-op="+">+</button>
        </div>
      </div>

      <div class="muted" style="margin-top:8px;">${s.detail}</div>
      <div style="margin-top:8px">${spark}</div>

      <div class="footer">
        <div class="advice">${s.advice}</div>
        <div class="time">Zaman: ${s.time}</div>
      </div>
    `;

    // +/- event
    const offEl = card.querySelector('.off');
    card.querySelector('[data-op="-"]').addEventListener('click', async ()=>{
      const curr = parseInt(offEl.textContent || "1", 10);
      const nxt = Math.max(1, curr - 1);
      await apiSetOfficers(cp, nxt);
      offEl.textContent = String(nxt);
      await render();
    });
    card.querySelector('[data-op="+"]').addEventListener('click', async ()=>{
      const curr = parseInt(offEl.textContent || "1", 10);
      const nxt = curr + 1;
      await apiSetOfficers(cp, nxt);
      offEl.textContent = String(nxt);
      await render();
    });

    grid.appendChild(card);
  }

  if(Object.keys(byCpSummary).length === 0){
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.innerHTML = `<div class="title">Henüz veri yok</div>
      <div class="muted">CSV'ye kayıt düştükçe burada görünecek.</div>`;
    grid.appendChild(empty);
  }
}

// tema düğmesi (basit)
document.getElementById('themeToggle').addEventListener('click', ()=>{
  document.body.classList.toggle('light');
});

// ilk yük ve periyodik yenileme
render();
setInterval(render, 3000);
