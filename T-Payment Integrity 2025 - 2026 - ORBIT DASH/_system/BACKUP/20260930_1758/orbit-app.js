/* ============================================================
   PROJECT ORBIT — Application Logic
   Filtering · KPI Computation · Charts (Canvas) · Table

   Manager mapping design:
     D_PROD[m] = org-level manager as recorded in Fact_Productivity
                 for that specific period — PERIOD-AWARE.
     D_PROD[a] = associate name.
     D_ASSOC   = domain-ID → name lookup for QA resolution only.
     D_MANAGERS = union of all managers from D_PROD + D_QA.

   Manager is NEVER sourced from Dim_Associate (static).
   ============================================================ */

'use strict';

/* ── Enterprise Target engine ───────────────────────────────── */
// Rate and headcount are fixed business inputs — not derived from data.
// They do NOT respond to Manager or Associate filters.
// Only the selected month changes the business-day count.
const ENT = {
  RATE: 29.75,       // standard daily production rate per associate
  HEADCOUNT: 28,     // billable headcount (update when roster changes)

  // US Federal holidays observed in 2026 (date strings yyyy-MM-dd).
  // Observed rule applied: if holiday falls Sat → Fri, Sun → Mon.
  HOLIDAYS: new Set([
    '2026-01-01', // New Year's Day
    '2026-01-19', // MLK Day
    '2026-02-16', // Presidents' Day
    '2026-05-25', // Memorial Day
    '2026-06-19', // Juneteenth
    '2026-07-03', // Independence Day (Jul 4 Sat → observed Fri Jul 3)
    '2026-09-07', // Labor Day
    '2026-10-12', // Columbus Day
    '2026-11-11', // Veterans Day
    '2026-11-26', // Thanksgiving
    '2026-12-25', // Christmas
  ]),

  // Returns business days in a given 'yyyy-MM' string.
  // Excludes Saturdays, Sundays, and holidays from HOLIDAYS.
  bizDays(ym) {
    if (!ym || ym === 'all') return null;
    const [yr, mo] = ym.split('-').map(Number);
    const last = new Date(yr, mo, 0).getDate(); // days in month
    let count = 0;
    for (let d = 1; d <= last; d++) {
      const dt  = new Date(yr, mo - 1, d);
      const dow = dt.getDay(); // 0=Sun, 6=Sat
      if (dow === 0 || dow === 6) continue;
      const ds = `${yr}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if (!ENT.HOLIDAYS.has(ds)) count++;
    }
    return count;
  },

  // Returns { target, bizDays } for a ym, or null when ym === 'all'.
  compute(ym) {
    const bd = ENT.bizDays(ym);
    if (bd === null) return null;
    return { target: Math.round(ENT.RATE * ENT.HEADCOUNT * bd * 100) / 100, bizDays: bd };
  },
};

/* ── State ─────────────────────────────────────────────────── */
const STATE = {
  month:   'all',   // 'all' | 'yyyy-MM'
  manager: 'all',   // 'all' | manager name string (matches D_PROD[m])
  sortCol: 'prodPct',
  sortDir: 'desc',
};

let trendChart = null;
let qaChart    = null;

/* ── Helpers ────────────────────────────────────────────────── */
const fmt = {
  num:  v => v == null ? '—' : Number(v).toLocaleString('en-US', {maximumFractionDigits: 0}),
  pct:  v => v == null ? '—' : (v * 100).toFixed(1) + '%',
  sign: v => v > 0 ? '+' + fmt.num(v) : fmt.num(v),
};

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

/* ── QA Passing Threshold (Payment Integrity standard) ─────── */
// 98.50% is the fixed business threshold. Anything below is FAIL.
// Do NOT change this to a relative or percentile-based rule.
const QA_PASS = 0.985;

// Returns 'pass' | 'fail' | null (null = no QA data)
function qaStatus(score) {
  if (score == null) return null;
  return score >= QA_PASS ? 'pass' : 'fail';
}

/* ── Domain ID → name lookup (for QA only, not for manager) ── */
// Built once from D_ASSOC: id → associate name
const idToName = {};
D_ASSOC.forEach(r => { if (r.id && r.n) idToName[r.id] = r.n; });

/* ── Data filtering ─────────────────────────────────────────── */
// Manager filter matches D_PROD[m] directly — period-aware because
// each D_PROD row carries the manager valid for that specific ym.
function filterProd(month, manager) {
  return D_PROD.filter(r =>
    (manager === 'all' || r.m === manager) &&
    (month   === 'all' || r.ym === month)
  );
}

// QA manager filter matches D_QA[m] directly (same logic).
function filterQA(month, manager) {
  return D_QA.filter(r =>
    (manager === 'all' || r.m === manager) &&
    (month   === 'all' || r.d.startsWith(month))
  );
}

/* ── Group helpers ──────────────────────────────────────────── */
function uniqueSorted(arr, key) {
  return [...new Set(arr.map(r => r[key]))].filter(Boolean).sort();
}

function groupBy(arr, key) {
  return arr.reduce((acc, r) => {
    const k = r[key];
    if (!acc[k]) acc[k] = [];
    acc[k].push(r);
    return acc;
  }, {});
}

/* ── KPI computation ────────────────────────────────────────── */
function computeKPIs(prodRows, qaRows) {
  const totalAct = prodRows.reduce((s, r) => s + (r.act || 0), 0);
  const totalTgt = prodRows.reduce((s, r) => s + (r.tgt || 0), 0);
  const prodPct  = totalTgt > 0 ? totalAct / totalTgt : 0;

  // QA: group by domain ID to count distinct audited associates
  const qaByID = groupBy(qaRows, 'id');
  const qaIDKeys = Object.keys(qaByID).filter(k => k && k !== '');
  let totalCnt = 0, weightedScore = 0;
  qaIDKeys.forEach(id => {
    const rows = qaByID[id];
    const cnt  = rows.reduce((s, r) => s + (r.cnt || 0), 0);
    const wScr = rows.reduce((s, r) => s + (r.cnt || 0) * (r.scr || 0), 0);
    totalCnt      += cnt;
    weightedScore += wScr;
  });
  const avgQA   = totalCnt > 0 ? weightedScore / totalCnt : 0;
  const audited = qaIDKeys.length;

  return { totalAct, totalTgt, prodPct, avgQA, totalCnt, audited };
}

/* ── Associate table computation ───────────────────────────── */
// Manager = D_PROD[m] for the filtered period (period-aware).
// When month filter is active, each associate's manager reflects
// who managed them IN THAT MONTH — not a static Dim_Associate value.
function computeAssocTable(prodRows, qaRows) {
  const assocMap = {};

  // Build from prod rows — group by associate name
  // Manager for each associate = D_PROD[m] for rows in this filter window.
  // If an associate appears under different managers in different months
  // and month='all', we take the most recent manager (largest ym).
  const prodByAssoc = groupBy(prodRows, 'a');
  Object.entries(prodByAssoc).forEach(([name, rows]) => {
    if (!name) return;
    const act = rows.reduce((s, r) => s + (r.act || 0), 0);
    const tgt = rows.reduce((s, r) => s + (r.tgt || 0), 0);
    // Most recent manager for this associate in the filtered window
    const sorted  = [...rows].sort((a, b) => (a.ym > b.ym ? -1 : 1));
    const manager = sorted[0].m;
    assocMap[name] = { name, manager, act, tgt, qaCnt: 0, qaScr: 0 };
  });

  // Merge QA data — resolve domain ID → associate name via D_ASSOC lookup
  const qaByID = groupBy(qaRows, 'id');
  Object.entries(qaByID).forEach(([id, rows]) => {
    // Resolve name: D_ASSOC lookup first, fallback to D_QA[a], fallback to id
    const name = idToName[id] || rows[0].a || id;
    if (!name) return;
    const cnt  = rows.reduce((s, r) => s + (r.cnt || 0), 0);
    const wScr = rows.reduce((s, r) => s + (r.cnt || 0) * (r.scr || 0), 0);
    if (!assocMap[name]) {
      // QA-only associate: manager from D_QA[m]
      assocMap[name] = { name, manager: rows[0].m, act: 0, tgt: 0, qaCnt: 0, qaScr: 0 };
    }
    assocMap[name].qaCnt += cnt;
    assocMap[name].qaScr += wScr;
  });

  return Object.values(assocMap).map(r => ({
    ...r,
    variance: r.act - r.tgt,
    prodPct:  r.tgt > 0 ? r.act / r.tgt : 0,
    avgQA:    r.qaCnt > 0 ? r.qaScr / r.qaCnt : null,
  }));
}

/* ── Weekly trend data ──────────────────────────────────────── */
function computeWeeklyTrend(prodRows) {
  const byYMW = {};
  prodRows.forEach(r => {
    const key = `${r.ym}|${r.w}`;
    if (!byYMW[key]) byYMW[key] = { label: `${r.ym} ${r.w}`, ym: r.ym, w: r.w, act: 0, tgt: 0 };
    byYMW[key].act += r.act || 0;
    byYMW[key].tgt += r.tgt || 0;
  });
  return Object.values(byYMW).sort((a, b) => {
    if (a.ym !== b.ym) return a.ym < b.ym ? -1 : 1;
    return a.w < b.w ? -1 : 1;
  });
}

/* ── QA Overview data ───────────────────────────────────────── */
function computeQAOverview(qaRows) {
  const byMonth = {};
  qaRows.forEach(r => {
    const m = r.d ? r.d.substring(0, 7) : 'Unknown';
    if (!byMonth[m]) byMonth[m] = { label: m, cnt: 0, wScr: 0 };
    byMonth[m].cnt  += r.cnt || 0;
    byMonth[m].wScr += (r.cnt || 0) * (r.scr || 0);
  });
  return Object.values(byMonth)
    .sort((a, b) => a.label < b.label ? -1 : 1)
    .map(m => ({ ...m, avgScr: m.cnt > 0 ? m.wScr / m.cnt : 0 }));
}

/* ── Chart.js defaults ──────────────────────────────────────── */
Chart.defaults.color       = '#5A5470';
Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
Chart.defaults.font.size   = 11;
Chart.defaults.plugins.legend.display = false;

function destroyChart(ref) { if (ref) { try { ref.destroy(); } catch(e) {} } }

function renderTrendChart(weeklyData) {
  const canvas = document.getElementById('chart-trend');
  if (!canvas) return null;
  destroyChart(trendChart);
  const ctx    = canvas.getContext('2d');
  const MAX    = 24;
  const from   = Math.max(0, weeklyData.length - MAX);
  const labels = weeklyData.slice(from).map(d => d.label.replace(/\d{4}-/, '').replace('Week ', 'W'));
  const acts   = weeklyData.slice(from).map(d => Math.round(d.act * 10) / 10);
  const tgts   = weeklyData.slice(from).map(d => Math.round(d.tgt * 10) / 10);

  return new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Actual', data: acts, borderColor: '#44B8F3', backgroundColor: 'rgba(68,184,243,0.12)', borderWidth: 2.5, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: '#44B8F3', tension: 0.35, fill: true, order: 2 },
        { label: 'Target', data: tgts, borderColor: '#794CFF', backgroundColor: 'transparent', borderWidth: 2, borderDash: [5, 3], pointRadius: 2, pointHoverRadius: 5, pointBackgroundColor: '#794CFF', tension: 0.35, fill: false, order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: { backgroundColor: '#FFFFFF', borderColor: '#5009B5', borderWidth: 1, titleColor: '#231E33', bodyColor: '#231E33', padding: 12, callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt.num(ctx.parsed.y)}` } },
        legend: { display: false },
      },
      scales: {
        x: { grid: { color: 'rgba(225,237,255,0.35)' }, ticks: { color: '#5A5470', maxRotation: 45, maxTicksLimit: 12, font: { size: 10 } } },
        y: { grid: { color: 'rgba(225,237,255,0.35)' }, ticks: { color: '#5A5470', font: { size: 10 } }, beginAtZero: false },
      },
    },
  });
}

function renderQAChart(qaMonthData) {
  const canvas = document.getElementById('chart-qa');
  if (!canvas) return null;
  destroyChart(qaChart);
  const ctx    = canvas.getContext('2d');
  const labels = qaMonthData.map(d => d.label.replace(/^\d{4}-/, ''));
  const cnts   = qaMonthData.map(d => Math.round(d.cnt));
  const scrs   = qaMonthData.map(d => Math.round(d.avgScr * 1000) / 10);

  // Per-bar color: teal = PASS (≥98.5%), red = FAIL
  const QA_PCT = QA_PASS * 100; // 98.5
  const barColors = scrs.map(s => s >= QA_PCT ? 'rgba(0,188,187,0.70)' : 'rgba(248,113,113,0.70)');
  const barBorders = scrs.map(s => s >= QA_PCT ? '#00BBBA' : '#FA8072');

  // Threshold line plugin — draws a dashed horizontal rule at 98.5%
  const thresholdPlugin = {
    id: 'qaThreshold',
    afterDraw(chart) {
      const { ctx: c, chartArea: { left, right }, scales: { yScore } } = chart;
      if (!yScore) return;
      const y = yScore.getPixelForValue(QA_PCT);
      c.save();
      c.setLineDash([5, 4]);
      c.lineWidth   = 1.5;
      c.strokeStyle = 'rgba(248,113,113,0.75)';
      c.beginPath();
      c.moveTo(left,  y);
      c.lineTo(right, y);
      c.stroke();
      c.setLineDash([]);
      // Label
      c.font      = '600 9px Inter, sans-serif';
      c.fillStyle = '#FA8072';
      c.textAlign = 'right';
      c.fillText('98.5% threshold', right - 4, y - 4);
      c.restore();
    },
  };

  return new Chart(ctx, {
    type: 'bar',
    plugins: [thresholdPlugin],
    data: {
      labels,
      datasets: [
        {
          label: 'Audit Count',
          data: cnts,
          backgroundColor: 'rgba(68,184,243,0.5)',
          borderColor: '#44B8F3',
          borderWidth: 1,
          borderRadius: 4,
          yAxisID: 'yCount',
          order: 2,
        },
        {
          label: 'Avg Score %',
          data: scrs,
          type: 'line',
          // Color each point: pass=teal, fail=red
          borderColor: scrs.length === 1
            ? barBorders[0]
            : scrs.map(s => s >= QA_PCT ? '#00BBBA' : '#FA8072'),
          backgroundColor: scrs.map(s => s >= QA_PCT ? 'rgba(0,188,187,0.15)' : 'rgba(248,113,113,0.15)'),
          segment: {
            borderColor: ctx => {
              const s = scrs[ctx.p1DataIndex];
              return s >= QA_PCT ? '#00BBBA' : '#FA8072';
            },
          },
          pointBackgroundColor: scrs.map(s => s >= QA_PCT ? '#00BBBA' : '#FA8072'),
          pointBorderColor: '#231E33',
          pointBorderWidth: 1,
          borderWidth: 2.5,
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0.35,
          yAxisID: 'yScore',
          fill: false,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          backgroundColor: '#FFFFFF',
          borderColor: '#5009B5',
          borderWidth: 1,
          titleColor: '#231E33',
          bodyColor: '#231E33',
          padding: 12,
          callbacks: {
            label: ctx => {
              if (ctx.dataset.label === 'Avg Score %') {
                const s = ctx.parsed.y;
                const status = s >= QA_PCT ? '✓ PASS' : '✗ FAIL';
                return ` Score: ${s.toFixed(1)}%  ${status}`;
              }
              return ` Audits: ${fmt.num(ctx.parsed.y)}`;
            },
          },
        },
        legend: { display: false },
      },
      scales: {
        x: { grid: { color: 'rgba(225,237,255,0.35)' }, ticks: { color: '#5A5470', font: { size: 10 } } },
        yCount: { position: 'left', grid: { color: 'rgba(225,237,255,0.35)' }, ticks: { color: '#44B8F3', font: { size: 10 } }, beginAtZero: true },
        yScore: {
          position: 'right',
          min: 85,
          max: 105,
          grid: { display: false },
          ticks: { color: '#00BBBA', font: { size: 10 }, callback: v => v + '%' },
        },
      },
    },
  });
}

/* ── Table rendering ────────────────────────────────────────── */
function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sortAssocs(rows, col, dir) {
  return [...rows].sort((a, b) => {
    let av = a[col] ?? -Infinity;
    let bv = b[col] ?? -Infinity;
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return dir === 'asc' ? -1 :  1;
    if (av > bv) return dir === 'asc' ?  1 : -1;
    return 0;
  });
}

function renderTable(assocRows) {
  const tbody = document.getElementById('assoc-tbody');
  const meta  = document.getElementById('table-meta');
  if (!tbody) return;

  const sorted = sortAssocs(assocRows, STATE.sortCol, STATE.sortDir);
  if (meta) meta.textContent = sorted.length + ' associates';

  if (sorted.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="orbit-empty"><div class="orbit-empty__title">No data for current filters</div><div class="orbit-empty__desc">Try a different month or manager.</div></div></td></tr>`;
    return;
  }

  const maxPct = Math.max(...sorted.map(r => r.prodPct || 0), 0.01);
  const rows = sorted.map((r, i) => {
    const pct      = r.prodPct || 0;
    const barW     = clamp(Math.round((pct / Math.max(maxPct, 1.2)) * 100), 0, 100);
    const barClass = pct >= 1.0 ? 'is-above' : pct < 0.9 ? 'is-below' : '';
    const varClass = r.variance >= 0 ? 'is-positive' : 'is-negative';
    const qaScore  = r.avgQA;
    const qaSt     = qaStatus(qaScore);   // 'pass' | 'fail' | null
    const qaClass  = qaSt === 'pass' ? 'is-pass' : qaSt === 'fail' ? 'is-fail' : '';
    const qaStr    = qaScore != null ? fmt.pct(qaScore) : '—';
    // Badge: dot + label, tooltip shows threshold
    const qaBadge  = qaSt != null
      ? `<span class="qa-badge qa-badge--${qaSt}" title="PI QA threshold: 98.50%">${qaSt === 'pass' ? '● PASS' : '● FAIL'}</span>`
      : '';

    return `<tr>
      <td class="col-rank">${i + 1}</td>
      <td class="col-associate">${escHtml(r.name)}</td>
      <td class="col-manager">${escHtml(r.manager)}</td>
      <td class="col-num">${fmt.num(r.act)}</td>
      <td class="col-num">${fmt.num(r.tgt)}</td>
      <td class="col-variance ${varClass}">${fmt.sign(r.variance)}</td>
      <td class="col-pct">
        <div class="pct-cell">
          <span class="pct-cell__value">${fmt.pct(pct)}</span>
          <div class="pct-cell__bar-track">
            <div class="pct-cell__bar-fill ${barClass}" style="width:${barW}%"></div>
          </div>
        </div>
      </td>
      <td class="col-num">${r.qaCnt > 0 ? fmt.num(r.qaCnt) : '—'}</td>
      <td class="col-qa-score ${qaClass}">
        <div class="qa-score-cell">
          <span class="qa-score-cell__value">${qaStr}</span>
          ${qaBadge}
        </div>
      </td>
    </tr>`;
  });
  tbody.innerHTML = rows.join('');
}

/* ── KPI cards ──────────────────────────────────────────────── */
function renderKPIs(kpis) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('kpi-actual',   fmt.num(kpis.totalAct));
  set('kpi-target',   fmt.num(kpis.totalTgt));
  set('kpi-pct',      fmt.pct(kpis.prodPct));
  set('kpi-qa-score', kpis.avgQA > 0 ? fmt.pct(kpis.avgQA) : '—');
  set('kpi-qa-count', fmt.num(kpis.totalCnt));
  set('kpi-audited',  fmt.num(kpis.audited));

  const pctEl = document.getElementById('kpi-pct-sub');
  if (pctEl) {
    const delta = kpis.prodPct - 1.0;
    pctEl.className = delta >= 0 ? 'kpi-sub kpi-sub--up' : 'kpi-sub kpi-sub--down';
    pctEl.textContent = (delta >= 0 ? '+' : '') + (delta * 100).toFixed(1) + '% vs target';
  }

  // ── QA Score KPI card: strict 98.50% PI threshold ──────────
  const qaValEl = document.getElementById('kpi-qa-score');
  const qaEl    = document.getElementById('kpi-qa-score-sub');
  const qaCard  = document.querySelector('.kpi-card--qa-score');
  if (kpis.avgQA > 0) {
    const st = qaStatus(kpis.avgQA);
    // Value color driven by pass/fail
    if (qaValEl) {
      qaValEl.classList.remove('qa-kpi-pass', 'qa-kpi-fail');
      qaValEl.classList.add(st === 'pass' ? 'qa-kpi-pass' : 'qa-kpi-fail');
    }
    // Sub-text: PASS / FAILED
    if (qaEl) {
      if (st === 'pass') {
        qaEl.className = 'kpi-sub kpi-sub--up';
        qaEl.textContent = 'PASS — above 98.50%';
      } else {
        qaEl.className = 'kpi-sub kpi-sub--down';
        qaEl.textContent = 'FAILED — below 98.50%';
      }
    }
    // Card accent stripe
    if (qaCard) {
      qaCard.classList.remove('kpi-card--qa-pass', 'kpi-card--qa-fail');
      qaCard.classList.add(st === 'pass' ? 'kpi-card--qa-pass' : 'kpi-card--qa-fail');
    }
  } else {
    // No QA data
    if (qaValEl) qaValEl.classList.remove('qa-kpi-pass', 'qa-kpi-fail');
    if (qaEl) { qaEl.className = 'kpi-sub'; qaEl.textContent = 'No audit data'; }
    if (qaCard) qaCard.classList.remove('kpi-card--qa-pass', 'kpi-card--qa-fail');
  }

  // ── Enterprise Target & Variance ──────────────────────────
  // These cards are month-scoped ONLY.
  // Manager and Associate filters have NO effect — ENT.compute reads STATE.month directly.
  const entEl   = document.getElementById('kpi-ent-target');
  const entSub  = document.getElementById('kpi-ent-target-sub');
  const entVEl  = document.getElementById('kpi-ent-variance');
  const entVSub = document.getElementById('kpi-ent-variance-sub');

  const ent = ENT.compute(STATE.month);   // null when STATE.month === 'all'

  if (entEl) {
    entEl.textContent = ent ? fmt.num(ent.target) : '—';
  }
  if (entSub) {
    entSub.textContent = ent
      ? `${ENT.RATE} × ${ENT.HEADCOUNT} hc × ${ent.bizDays} days`
      : 'Select a single month';
    entSub.className = 'kpi-sub';
  }

  if (entVEl) {
    if (!ent) {
      entVEl.textContent = '—';
    } else {
      // Actual Production used here is the FULL-month total across ALL managers
      // (filter by month only, ignore manager filter) so it's a true enterprise view.
      const allMonthProd = D_PROD.filter(r => r.ym === STATE.month);
      const totalActFull = allMonthProd.reduce((s, r) => s + (r.act || 0), 0);
      const variance = Math.round((totalActFull - ent.target) * 100) / 100;
      entVEl.textContent = fmt.sign(variance);
    }
  }
  if (entVSub) {
    if (!ent) {
      entVSub.textContent = 'Select a single month';
      entVSub.className = 'kpi-sub';
    } else {
      const allMonthProd = D_PROD.filter(r => r.ym === STATE.month);
      const totalActFull = allMonthProd.reduce((s, r) => s + (r.act || 0), 0);
      const variance = Math.round((totalActFull - ent.target) * 100) / 100;
      entVSub.className = variance >= 0 ? 'kpi-sub kpi-sub--up' : 'kpi-sub kpi-sub--down';
      entVSub.textContent = variance >= 0 ? 'Above enterprise target' : 'Below enterprise target';
    }
  }
}

/* ── Period badge ───────────────────────────────────────────── */
function updatePeriodBadge() {
  const mgrText = STATE.manager === 'all' ? 'All Managers' : STATE.manager;
  const monText = STATE.month   === 'all' ? 'All Months'   : STATE.month;
  document.querySelectorAll('.chart-period-badge').forEach(el => {
    el.textContent = `${monText} · ${mgrText}`;
  });
}

/* ── Month pills ────────────────────────────────────────────── */
function buildMonthPills() {
  const container = document.getElementById('month-pills');
  if (!container) return;
  const months = uniqueSorted(D_PROD, 'ym');

  const allPill = document.createElement('button');
  allPill.className = 'orbit-pill is-active';
  allPill.textContent = 'All';
  allPill.dataset.month = 'all';
  allPill.addEventListener('click', () => setMonth('all'));
  container.appendChild(allPill);

  months.forEach(m => {
    const pill = document.createElement('button');
    pill.className = 'orbit-pill';
    const [yr, mo] = m.split('-');
    pill.textContent = new Date(parseInt(yr), parseInt(mo) - 1, 1)
      .toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    pill.dataset.month = m;
    pill.addEventListener('click', () => setMonth(m));
    container.appendChild(pill);
  });
}

function setMonth(m) {
  STATE.month = m;
  document.querySelectorAll('.orbit-pill').forEach(p => {
    p.classList.toggle('is-active', p.dataset.month === m);
  });
  refresh();
}

/* ── Manager dropdown ───────────────────────────────────────── */
// D_MANAGERS = union of all managers from D_PROD and D_QA (period-aware).
// Selecting a manager filters rows where D_PROD[m] or D_QA[m] === that manager.
function buildManagerSelect() {
  const sel = document.getElementById('manager-select');
  if (!sel) return;

  sel.innerHTML = '<option value="all">All Managers</option>';
  D_MANAGERS.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  });

  sel.addEventListener('change', () => {
    STATE.manager = sel.value;
    refresh();
  });
}

/* ── Sort ───────────────────────────────────────────────────── */
function initSortHeaders() {
  document.querySelectorAll('[data-sort]').forEach(th => {
    th.classList.add('is-sortable');
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      STATE.sortDir = STATE.sortCol === col
        ? (STATE.sortDir === 'asc' ? 'desc' : 'asc')
        : 'desc';
      STATE.sortCol = col;
      updateSortUI();
      const prod = filterProd(STATE.month, STATE.manager);
      const qa   = filterQA(STATE.month, STATE.manager);
      renderTable(computeAssocTable(prod, qa));
    });
  });
}

function updateSortUI() {
  document.querySelectorAll('[data-sort]').forEach(th => {
    th.classList.remove('is-sorted-asc', 'is-sorted-desc', 'is-sortable');
    if (th.dataset.sort === STATE.sortCol) {
      th.classList.add(STATE.sortDir === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
    } else {
      th.classList.add('is-sortable');
    }
  });
}

/* ── Table search ───────────────────────────────────────────── */
function initTableSearch() {
  const inp = document.getElementById('table-search');
  if (!inp) return;
  inp.addEventListener('input', () => {
    const q = inp.value.toLowerCase().trim();
    document.querySelectorAll('#assoc-tbody tr').forEach(tr => {
      tr.style.display = q === '' || tr.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

/* ── Main refresh ───────────────────────────────────────────── */
function refresh() {
  const prod     = filterProd(STATE.month, STATE.manager);
  const qa       = filterQA(STATE.month, STATE.manager);
  const kpis     = computeKPIs(prod, qa);
  const assocs   = computeAssocTable(prod, qa);
  const weekly   = computeWeeklyTrend(prod);
  const qaMonths = computeQAOverview(qa);

  renderKPIs(kpis);
  renderTable(assocs);
  updatePeriodBadge();
  trendChart = renderTrendChart(weekly);
  qaChart    = renderQAChart(qaMonths);

  const ts = document.getElementById('last-updated');
  if (ts) ts.textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/* ── Init ───────────────────────────────────────────────────── */
function init() {
  buildMonthPills();
  buildManagerSelect();
  initSortHeaders();
  initTableSearch();
  updateSortUI();
  refresh();

  const loader = document.getElementById('orbit-loading');
  if (loader) { loader.classList.add('is-hidden'); setTimeout(() => loader.remove(), 500); }
}

document.addEventListener('DOMContentLoaded', init);


/* ============================================================
   DAILY DETAIL PAGE — DD namespace
   Displays one row per D_PROD record (day-level grain).
   Fields: Date (ym+week), Associate, Manager, Actual, Target,
           Variance, Week, Month.
   Filters: Timeline (month pills), Manager, Associate, Search.
   Features: sortable columns, CSV export.
   ============================================================ */

const DD = (() => {
  /* ── Local state ── */
  const S = {
    month:   'all',
    manager: 'all',
    assoc:   'all',
    search:  '',
    sortCol: 'ym',
    sortDir: 'desc',
  };

  /* ── Filter ── */
  function filteredRows() {
    const q = S.search.toLowerCase().trim();
    return D_PROD.filter(r => {
      if (S.month   !== 'all' && r.ym !== S.month)   return false;
      if (S.manager !== 'all' && r.m  !== S.manager)  return false;
      if (S.assoc   !== 'all' && r.a  !== S.assoc)    return false;
      if (q) {
        const hay = ((r.a || '') + ' ' + (r.m || '') + ' ' + (r.ym || '') + ' ' + (r.w || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  /* ── Sort ── */
  function sorted(rows) {
    return [...rows].sort((a, b) => {
      let av, bv;
      // "date" sort key uses ym + w combined so chronological order is natural
      if (S.sortCol === 'date') {
        av = (a.ym || '') + (a.w || '');
        bv = (b.ym || '') + (b.w || '');
      } else if (S.sortCol === 'variance') {
        av = (a.act || 0) - (a.tgt || 0);
        bv = (b.act || 0) - (b.tgt || 0);
      } else {
        av = a[S.sortCol] ?? '';
        bv = b[S.sortCol] ?? '';
      }
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return S.sortDir === 'asc' ? -1 :  1;
      if (av > bv) return S.sortDir === 'asc' ?  1 : -1;
      return 0;
    });
  }

  /* ── Render table ── */
  function render() {
    const tbody = document.getElementById('dd-tbody');
    const meta  = document.getElementById('dd-meta');
    if (!tbody) return;

    const rows = sorted(filteredRows());
    if (meta) meta.textContent = rows.length.toLocaleString() + ' records';

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="orbit-dd-empty">No records match the current filters.</div></td></tr>`;
      updateSortHeaders();
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const variance  = (r.act || 0) - (r.tgt || 0);
      const varClass  = variance >= 0 ? 'is-positive' : 'is-negative';
      const dateLabel = `${r.ym || '—'} &middot; ${escHtml(r.w || '—')}`;
      return `<tr>
        <td class="col-num">${dateLabel}</td>
        <td class="col-associate">${escHtml(r.a || '—')}</td>
        <td class="col-manager">${escHtml(r.m || '—')}</td>
        <td class="col-num">${fmt.num(r.act)}</td>
        <td class="col-num">${fmt.num(r.tgt)}</td>
        <td class="col-num ${varClass}">${fmt.sign(variance)}</td>
        <td class="col-num">${escHtml(r.w || '—')}</td>
        <td class="col-num">${escHtml(r.ym || '—')}</td>
      </tr>`;
    }).join('');

    updateSortHeaders();
  }

  /* ── Sort header UI ── */
  function updateSortHeaders() {
    document.querySelectorAll('#dd-table [data-dd-sort]').forEach(th => {
      th.classList.remove('is-sorted-asc', 'is-sorted-desc');
      if (th.dataset.ddSort === S.sortCol) {
        th.classList.add(S.sortDir === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
      }
    });
  }

  /* ── Build month pills (mirrors Overview pills) ── */
  function buildMonthPills() {
    const container = document.getElementById('dd-month-pills');
    if (!container) return;
    const months = uniqueSorted(D_PROD, 'ym');

    const allBtn = document.createElement('button');
    allBtn.className = 'orbit-pill' + (S.month === 'all' ? ' is-active' : '');
    allBtn.textContent = 'All';
    allBtn.dataset.month = 'all';
    container.appendChild(allBtn);

    months.forEach(ym => {
      const btn = document.createElement('button');
      btn.className = 'orbit-pill' + (S.month === ym ? ' is-active' : '');
      btn.textContent = ym;
      btn.dataset.month = ym;
      container.appendChild(btn);
    });

    container.addEventListener('click', e => {
      const btn = e.target.closest('[data-month]');
      if (!btn) return;
      S.month = btn.dataset.month;
      container.querySelectorAll('[data-month]').forEach(b => b.classList.toggle('is-active', b === btn));
      rebuildAssocSelect();
      render();
    });
  }

  /* ── Build manager dropdown ── */
  function buildManagerSelect() {
    const sel = document.getElementById('dd-manager-select');
    if (!sel) return;
    sel.innerHTML = '<option value="all">All Managers</option>';
    D_MANAGERS.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      S.manager = sel.value;
      S.assoc   = 'all';
      rebuildAssocSelect();
      render();
    });
  }

  /* ── Build associate dropdown (responds to manager filter) ── */
  function buildAssocSelect() {
    rebuildAssocSelect();
    const sel = document.getElementById('dd-assoc-select');
    if (!sel) return;
    sel.addEventListener('change', () => {
      S.assoc = sel.value;
      render();
    });
  }

  function rebuildAssocSelect() {
    const sel = document.getElementById('dd-assoc-select');
    if (!sel) return;
    const prev = sel.value;
    const assocs = [...new Set(
      D_PROD
        .filter(r => (S.month === 'all' || r.ym === S.month) && (S.manager === 'all' || r.m === S.manager))
        .map(r => r.a)
        .filter(Boolean)
    )].sort();
    sel.innerHTML = '<option value="all">All Associates</option>';
    assocs.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      if (a === prev) opt.selected = true;
      sel.appendChild(opt);
    });
    if (!assocs.includes(S.assoc)) S.assoc = 'all';
  }

  /* ── Search input ── */
  function initSearch() {
    const inp = document.getElementById('dd-search');
    if (!inp) return;
    inp.addEventListener('input', () => {
      S.search = inp.value;
      render();
    });
  }

  /* ── Column sort ── */
  function initSortHeaders() {
    document.querySelectorAll('#dd-table [data-dd-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.ddSort;
        if (S.sortCol === col) {
          S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          S.sortCol = col;
          S.sortDir = col === 'a' || col === 'm' ? 'asc' : 'desc';
        }
        render();
      });
    });
  }

  /* ── CSV export ── */
  function initExport() {
    const btn = document.getElementById('dd-export-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const rows = sorted(filteredRows());
      const header = ['Date','Associate','Manager','Actual','Target','Variance','Week','Month'];
      const lines  = rows.map(r => {
        const v = (r.act || 0) - (r.tgt || 0);
        return [
          `"${r.ym} ${r.w}"`,
          `"${(r.a || '').replace(/"/g, '""')}"`,
          `"${(r.m || '').replace(/"/g, '""')}"`,
          r.act || 0,
          r.tgt || 0,
          v,
          `"${r.w || ''}"`,
          `"${r.ym || ''}"`,
        ].join(',');
      });
      const csv  = [header.join(','), ...lines].join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `ORBIT_Daily_Detail_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  /* ── Page-tab switching ── */
  function initPageNav() {
    document.querySelectorAll('.orbit-page-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.page;
        // Update tabs
        document.querySelectorAll('.orbit-page-tab').forEach(t => {
          t.classList.toggle('is-active', t === tab);
          t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
        });
        // Show / hide pages
        document.querySelectorAll('.orbit-page').forEach(p => {
          p.classList.toggle('is-hidden', p.id !== 'page-' + target);
        });
      });
    });
  }

  /* ── Init ── */
  function init() {
    initPageNav();
    buildMonthPills();
    buildManagerSelect();
    buildAssocSelect();
    initSearch();
    initSortHeaders();
    render();
  }

  return { init };
})();

/* ── Attach DD init to DOMContentLoaded alongside main init ── */
document.addEventListener('DOMContentLoaded', DD.init);


/* ============================================================
   MONTHLY PERFORMANCE PAGE — MP namespace
   Aggregates D_PROD + D_QA by associate × month.
   Business rules:
     Prod PASS  : prodPct >= 1.00  (100%)
     QA   PASS  : avgQA  >= 0.985  (98.50%)
   ============================================================ */

const MP = (() => {

  /* ── Local state ─────────────────────────────────────────── */
  const S = {
    month:   'all',
    manager: 'all',
    assoc:   'all',
    sortCol: 'ym',
    sortDir: 'desc',
  };

  let mpProdChart = null;
  let mpQAChart   = null;
  let mpDistChart = null;

  /* ── Month label formatter ─── */
  function fmtYM(ym) {
    if (!ym) return '—';
    const [yr, mo] = ym.split('-').map(Number);
    const label = new Date(yr, mo - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
    return label; // e.g. "Jul 2026"
  }

  /* ── Core computation ────────────────────────────────────── */
  // Returns one row per (associate × month): { a, m, ym, act, tgt, prodPct, avgQA }
  function computeRows() {
    const prodRows = D_PROD.filter(r =>
      (S.month   === 'all' || r.ym === S.month) &&
      (S.manager === 'all' || r.m  === S.manager) &&
      (S.assoc   === 'all' || r.a  === S.assoc)
    );
    const qaRows = D_QA.filter(r =>
      (S.month   === 'all' || r.d.startsWith(S.month)) &&
      (S.manager === 'all' || r.m  === S.manager)
    );

    // Aggregate prod by associate + month
    const prodMap = {};
    prodRows.forEach(r => {
      if (!r.a) return;
      const key = r.a + '|' + r.ym;
      if (!prodMap[key]) {
        const latestMgr = r.m;
        prodMap[key] = { a: r.a, m: latestMgr, ym: r.ym, act: 0, tgt: 0 };
      }
      prodMap[key].act += r.act || 0;
      prodMap[key].tgt += r.tgt || 0;
    });

    // Aggregate QA by associate + month (resolve name via idToName)
    const qaMap = {};
    qaRows.forEach(r => {
      const name = idToName[r.id] || r.a || r.id;
      if (!name) return;
      // Filter by assoc after name resolution
      if (S.assoc !== 'all' && name !== S.assoc) return;
      const ym = r.d ? r.d.substring(0, 7) : null;
      if (!ym) return;
      const key = name + '|' + ym;
      if (!qaMap[key]) qaMap[key] = { a: name, m: r.m, ym, cnt: 0, wScr: 0 };
      qaMap[key].cnt  += r.cnt || 0;
      qaMap[key].wScr += (r.cnt || 0) * (r.scr || 0);
    });

    // Merge into final rows keyed by assoc|ym
    const merged = { ...prodMap };
    Object.entries(qaMap).forEach(([key, q]) => {
      if (!merged[key]) merged[key] = { a: q.a, m: q.m, ym: q.ym, act: 0, tgt: 0 };
      merged[key].qaCnt = (merged[key].qaCnt || 0) + q.cnt;
      merged[key].qaScr = (merged[key].qaScr || 0) + q.wScr;
    });

    return Object.values(merged).map(r => ({
      ...r,
      prodPct: r.tgt > 0 ? r.act / r.tgt : null,
      avgQA:   (r.qaCnt > 0) ? r.qaScr / r.qaCnt : null,
    }));
  }

  /* ── Compute month-level aggregates (for trend charts) ────── */
  function computeMonthTrend(rows) {
    const byYM = {};
    rows.forEach(r => {
      if (!byYM[r.ym]) byYM[r.ym] = { ym: r.ym, act: 0, tgt: 0, qaCnt: 0, qaScr: 0 };
      byYM[r.ym].act   += r.act || 0;
      byYM[r.ym].tgt   += r.tgt || 0;
      byYM[r.ym].qaCnt += r.qaCnt || 0;
      byYM[r.ym].qaScr += r.qaScr || 0;
    });
    return Object.values(byYM)
      .sort((a, b) => a.ym < b.ym ? -1 : 1)
      .map(r => ({
        ...r,
        prodPct: r.tgt > 0 ? r.act / r.tgt : null,
        avgQA:   r.qaCnt > 0 ? r.qaScr / r.qaCnt : null,
      }));
  }

  /* ── KPI cards ───────────────────────────────────────────── */
  function renderKPIs(rows) {
    const withProd = rows.filter(r => r.prodPct != null);
    const passing  = withProd.filter(r => r.prodPct >= 1.0).length;
    const failing  = withProd.filter(r => r.prodPct < 1.0).length;

    const avgProd = withProd.length > 0
      ? withProd.reduce((s, r) => s + r.prodPct, 0) / withProd.length
      : null;

    const withQA  = rows.filter(r => r.avgQA != null);
    const totalQACnt = withQA.reduce((s, r) => s + (r.qaCnt || 0), 0);
    const totalQAScr = withQA.reduce((s, r) => s + (r.qaScr || 0), 0);
    const avgQA  = totalQACnt > 0 ? totalQAScr / totalQACnt : null;

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('mp-kpi-passing', passing);
    set('mp-kpi-failing', failing);
    set('mp-kpi-avg-prod', avgProd != null ? fmt.pct(avgProd) : '—');
    set('mp-kpi-avg-qa',   avgQA   != null ? fmt.pct(avgQA)   : '—');

    // Prod sub-text
    const prodSubEl = document.getElementById('mp-kpi-avg-prod-sub');
    if (prodSubEl && avgProd != null) {
      const delta = avgProd - 1.0;
      prodSubEl.className = delta >= 0 ? 'kpi-sub kpi-sub--up' : 'kpi-sub kpi-sub--down';
      prodSubEl.textContent = (delta >= 0 ? '+' : '') + (delta * 100).toFixed(1) + '% vs target';
    }

    // QA sub-text + value color
    const qaValEl  = document.getElementById('mp-kpi-avg-qa');
    const qaSubEl  = document.getElementById('mp-kpi-avg-qa-sub');
    if (avgQA != null) {
      const st = qaStatus(avgQA);
      if (qaValEl) {
        qaValEl.classList.remove('qa-kpi-pass', 'qa-kpi-fail');
        qaValEl.classList.add(st === 'pass' ? 'qa-kpi-pass' : 'qa-kpi-fail');
      }
      if (qaSubEl) {
        qaSubEl.className = st === 'pass' ? 'kpi-sub kpi-sub--up' : 'kpi-sub kpi-sub--down';
        qaSubEl.textContent = st === 'pass' ? 'PASS — above 98.50%' : 'FAILED — below 98.50%';
      }
    }

    // ── QA Pass / Fail counts (PI 98.50% threshold) ────────────
    const qaPassCount = withQA.filter(r => r.avgQA >= QA_PASS).length;
    const qaFailCount = withQA.filter(r => r.avgQA <  QA_PASS).length;

    const qaPassEl = document.getElementById('mp-kpi-qa-pass');
    const qaFailEl = document.getElementById('mp-kpi-qa-fail');
    if (qaPassEl) {
      qaPassEl.textContent = qaPassCount;
      qaPassEl.classList.remove('qa-kpi-pass', 'qa-kpi-fail');
      if (withQA.length > 0) qaPassEl.classList.add('qa-kpi-pass');
    }
    if (qaFailEl) {
      qaFailEl.textContent = qaFailCount;
      qaFailEl.classList.remove('qa-kpi-pass', 'qa-kpi-fail');
      if (qaFailCount > 0) qaFailEl.classList.add('qa-kpi-fail');
    }
  }

  /* ── Productivity Trend chart ────────────────────────────── */
  function renderProdChart(monthRows) {
    const canvas = document.getElementById('mp-chart-prod');
    if (!canvas) return null;
    if (mpProdChart) { mpProdChart.destroy(); mpProdChart = null; }
    const ctx    = canvas.getContext('2d');
    const labels = monthRows.map(r => fmtYM(r.ym));
    const vals   = monthRows.map(r => r.prodPct != null ? +(r.prodPct * 100).toFixed(2) : null);

    // Per-point colors
    const ptColors  = vals.map(v => v == null ? 'transparent' : v >= 100 ? '#00BBBA' : '#FA8072');
    const segColors = vals.map(v => v == null ? 'rgba(0,0,0,0)' : v >= 100 ? '#00BBBA' : '#FA8072');

    // Threshold plugin: dashed line at 100%
    const threshPlugin = {
      id: 'mpProdThresh',
      afterDraw(chart) {
        const { ctx: c, chartArea: { left, right }, scales: { y } } = chart;
        if (!y) return;
        const yp = y.getPixelForValue(100);
        c.save();
        c.setLineDash([5, 4]);
        c.lineWidth = 1.5;
        c.strokeStyle = 'rgba(248,113,113,0.6)';
        c.beginPath(); c.moveTo(left, yp); c.lineTo(right, yp); c.stroke();
        c.setLineDash([]);
        c.font = '600 9px Inter, sans-serif';
        c.fillStyle = '#FA8072';
        c.textAlign = 'right';
        c.fillText('100% target', right - 4, yp - 4);
        c.restore();
      },
    };

    mpProdChart = new Chart(ctx, {
      type: 'line',
      plugins: [threshPlugin],
      data: {
        labels,
        datasets: [{
          label: 'Productivity %',
          data: vals,
          borderColor: ctx => {
            const v = vals[ctx.dataIndex];
            return v == null ? 'transparent' : v >= 100 ? '#00BBBA' : '#FA8072';
          },
          segment: {
            borderColor: ctx => {
              const v = vals[ctx.p1DataIndex];
              return v == null ? 'transparent' : v >= 100 ? '#00BBBA' : '#FA8072';
            },
          },
          backgroundColor: vals.map(v => v == null ? 'transparent' : v >= 100
            ? 'rgba(0,188,187,0.12)' : 'rgba(248,113,113,0.08)'),
          pointBackgroundColor: ptColors,
          pointBorderColor: '#231E33',
          pointBorderWidth: 1,
          pointRadius: vals.length === 1 ? 6 : 4,
          pointHoverRadius: 7,
          borderWidth: 2.5,
          tension: 0.35,
          fill: true,
          spanGaps: true,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#FFFFFF',
            borderColor: '#5009B5', borderWidth: 1,
            titleColor: '#231E33', bodyColor: '#231E33', padding: 12,
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y;
                const st = v >= 100 ? '✓ PASS' : '✗ FAIL';
                return ` Productivity: ${v.toFixed(1)}%  ${st}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { color: 'rgba(225,237,255,0.35)' }, ticks: { color: '#5A5470', font: { size: 10 } } },
          y: {
            grid: { color: 'rgba(225,237,255,0.35)' },
            ticks: { color: '#5A5470', font: { size: 10 }, callback: v => v + '%' },
            beginAtZero: false,
          },
        },
      },
    });
    return mpProdChart;
  }

  /* ── QA Trend chart ──────────────────────────────────────── */
  function renderQATrendChart(monthRows) {
    const canvas = document.getElementById('mp-chart-qa');
    if (!canvas) return null;
    if (mpQAChart) { mpQAChart.destroy(); mpQAChart = null; }
    const ctx    = canvas.getContext('2d');
    const labels = monthRows.map(r => fmtYM(r.ym));
    const vals   = monthRows.map(r => r.avgQA != null ? +(r.avgQA * 100).toFixed(2) : null);
    const QA_PCT = QA_PASS * 100; // 98.5

    const threshPlugin = {
      id: 'mpQAThresh',
      afterDraw(chart) {
        const { ctx: c, chartArea: { left, right }, scales: { y } } = chart;
        if (!y) return;
        const yp = y.getPixelForValue(QA_PCT);
        c.save();
        c.setLineDash([5, 4]);
        c.lineWidth = 1.5;
        c.strokeStyle = 'rgba(248,113,113,0.6)';
        c.beginPath(); c.moveTo(left, yp); c.lineTo(right, yp); c.stroke();
        c.setLineDash([]);
        c.font = '600 9px Inter, sans-serif';
        c.fillStyle = '#FA8072';
        c.textAlign = 'right';
        c.fillText('98.5% threshold', right - 4, yp - 4);
        c.restore();
      },
    };

    mpQAChart = new Chart(ctx, {
      type: 'line',
      plugins: [threshPlugin],
      data: {
        labels,
        datasets: [{
          label: 'QA Score %',
          data: vals,
          segment: {
            borderColor: ctx => {
              const v = vals[ctx.p1DataIndex];
              return v == null ? 'transparent' : v >= QA_PCT ? '#00BBBA' : '#FA8072';
            },
          },
          backgroundColor: vals.map(v => v == null ? 'transparent' : v >= QA_PCT
            ? 'rgba(0,188,187,0.12)' : 'rgba(248,113,113,0.08)'),
          pointBackgroundColor: vals.map(v => v == null ? 'transparent' : v >= QA_PCT ? '#00BBBA' : '#FA8072'),
          pointBorderColor: '#231E33',
          pointBorderWidth: 1,
          pointRadius: vals.length === 1 ? 6 : 4,
          pointHoverRadius: 7,
          borderWidth: 2.5,
          tension: 0.35,
          fill: true,
          spanGaps: true,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#FFFFFF',
            borderColor: '#5009B5', borderWidth: 1,
            titleColor: '#231E33', bodyColor: '#231E33', padding: 12,
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y;
                const st = v >= QA_PCT ? '✓ PASS' : '✗ FAIL';
                return ` QA Score: ${v.toFixed(1)}%  ${st}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { color: 'rgba(225,237,255,0.35)' }, ticks: { color: '#5A5470', font: { size: 10 } } },
          y: {
            min: 85, max: 105,
            grid: { color: 'rgba(225,237,255,0.35)' },
            ticks: { color: '#5A5470', font: { size: 10 }, callback: v => v + '%' },
          },
        },
      },
    });
    return mpQAChart;
  }

  /* ── Pass/Fail Distribution donut chart ──────────────────── */
  function renderDistChart(rows) {
    const canvas = document.getElementById('mp-chart-dist');
    if (!canvas) return null;
    if (mpDistChart) { mpDistChart.destroy(); mpDistChart = null; }
    const ctx = canvas.getContext('2d');

    const withProd = rows.filter(r => r.prodPct != null);
    const prodPass = withProd.filter(r => r.prodPct >= 1.0).length;
    const prodFail = withProd.filter(r => r.prodPct < 1.0).length;

    const withQA   = rows.filter(r => r.avgQA != null);
    const qaPass   = withQA.filter(r => r.avgQA >= QA_PASS).length;
    const qaFail   = withQA.filter(r => r.avgQA < QA_PASS).length;

    mpDistChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Prod Pass', 'Prod Fail', 'QA Pass', 'QA Fail'],
        datasets: [{
          data: [prodPass, prodFail, qaPass, qaFail],
          backgroundColor: [
            'rgba(0,188,187,0.80)',
            'rgba(248,113,113,0.80)',
            'rgba(0,188,187,0.45)',
            'rgba(248,113,113,0.45)',
          ],
          borderColor: ['#00BBBA', '#FA8072', '#00BBBA', '#FA8072'],
          borderWidth: 1.5,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: '55%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#5A5470', font: { size: 10 }, padding: 10, boxWidth: 12 },
          },
          tooltip: {
            backgroundColor: '#FFFFFF',
            borderColor: '#5009B5', borderWidth: 1,
            titleColor: '#231E33', bodyColor: '#231E33', padding: 12,
          },
        },
      },
    });
    return mpDistChart;
  }

  /* ── Associate Performance Grid ──────────────────────────── */
  function renderGrid(rows) {
    const thead = document.getElementById('mp-grid-thead');
    const tbody = document.getElementById('mp-grid-tbody');
    const meta  = document.getElementById('mp-grid-meta');
    if (!thead || !tbody) return;

    // Derive sorted months from rows
    const months = [...new Set(rows.map(r => r.ym))].filter(Boolean).sort();

    // Unique associates (sorted), respecting current filters
    const assocs = [...new Set(rows.map(r => r.a))].filter(Boolean).sort();

    if (meta) meta.textContent = assocs.length + ' associates';

    if (assocs.length === 0 || months.length === 0) {
      thead.innerHTML = `<tr><th>Associate</th><th>Manager</th></tr>`;
      tbody.innerHTML = `<tr><td colspan="2"><div class="orbit-dd-empty">No data for current filters.</div></td></tr>`;
      return;
    }

    // Index rows by assoc+ym for fast lookup
    const idx = {};
    rows.forEach(r => { idx[r.a + '|' + r.ym] = r; });

    // Most-recent manager per associate (for display)
    const mgr = {};
    rows.forEach(r => { if (!mgr[r.a] || r.ym > (mgr[r.a].ym || '')) mgr[r.a] = r; });

    // Header
    const thMonths = months.map(ym =>
      `<th class="mp-month-col">${fmtYM(ym)}</th>`).join('');
    thead.innerHTML = `<tr>
      <th class="col-associate">Associate</th>
      <th class="col-manager">Manager</th>
      ${thMonths}
    </tr>`;

    // Body
    tbody.innerHTML = assocs.map(name => {
      const manager = mgr[name] ? escHtml(mgr[name].m) : '—';
      const cells   = months.map(ym => {
        const r = idx[name + '|' + ym];
        if (!r) return `<td class="mp-month-col"><div class="mp-cell mp-cell--empty">—</div></td>`;

        const pp = r.prodPct;
        const qa = r.avgQA;

        const prodPctStr   = pp != null ? fmt.pct(pp) : '—';
        const prodPassFail = pp != null ? (pp >= 1.0 ? 'pass' : 'fail') : null;
        const qaStr        = qa != null ? fmt.pct(qa) : '—';
        const qaSt         = qaStatus(qa);

        const prodValClass   = prodPassFail ? `is-${prodPassFail}` : '';
        const prodBadgeClass = prodPassFail ? `is-${prodPassFail}` : '';
        const qaClass        = qaSt ? `is-${qaSt}` : '';

        const prodBadgeLabel = prodPassFail ? prodPassFail.toUpperCase() : '';

        return `<td class="mp-month-col">
          <div class="mp-cell">
            <span class="mp-cell__prod ${prodValClass}">${prodPctStr}</span>
            ${prodPassFail ? `<span class="mp-cell__prod-badge ${prodBadgeClass}">${prodBadgeLabel}</span>` : ''}
            ${qa != null ? `<span class="mp-cell__qa ${qaClass}" title="QA: ${qaStr}">${qaStr}</span>` : ''}
          </div>
        </td>`;
      }).join('');

      return `<tr>
        <td class="col-associate">${escHtml(name)}</td>
        <td class="col-manager">${manager}</td>
        ${cells}
      </tr>`;
    }).join('');
  }

  /* ── Monthly Detail Trend table ──────────────────────────── */
  const DT = { sortCol: 'ym', sortDir: 'desc' };

  function sortedRows(rows) {
    return [...rows].sort((a, b) => {
      let av = a[DT.sortCol], bv = b[DT.sortCol];
      if (av == null) av = DT.sortDir === 'asc' ? Infinity : -Infinity;
      if (bv == null) bv = DT.sortDir === 'asc' ? Infinity : -Infinity;
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return DT.sortDir === 'asc' ? -1 :  1;
      if (av > bv) return DT.sortDir === 'asc' ?  1 : -1;
      return 0;
    });
  }

  function updateDetailSortUI() {
    document.querySelectorAll('#mp-detail-table [data-mp-sort]').forEach(th => {
      th.classList.remove('is-sorted-asc', 'is-sorted-desc');
      if (th.dataset.mpSort === DT.sortCol) {
        th.classList.add(DT.sortDir === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
      }
    });
  }

  function renderDetailTable(rows) {
    const tbody  = document.getElementById('mp-detail-tbody');
    const meta   = document.getElementById('mp-detail-meta');
    if (!tbody) return;

    const sorted = sortedRows(rows);
    if (meta) meta.textContent = sorted.length + ' rows';

    if (sorted.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="orbit-dd-empty">No data for current filters.</div></td></tr>`;
      updateDetailSortUI();
      return;
    }

    tbody.innerHTML = sorted.map(r => {
      const prodSt = r.prodPct != null ? (r.prodPct >= 1.0 ? 'pass' : 'fail') : null;
      const qaSt   = qaStatus(r.avgQA);

      const prodPill = prodSt
        ? `<span class="mp-status-pill is-${prodSt}">${prodSt.toUpperCase()}</span>`
        : `<span class="mp-status-pill is-na">—</span>`;
      const qaPill = qaSt
        ? `<span class="mp-status-pill is-${qaSt}">${qaSt.toUpperCase()}</span>`
        : `<span class="mp-status-pill is-na">—</span>`;

      const prodClass = r.prodPct != null ? (r.prodPct >= 1.0 ? 'is-positive' : 'is-negative') : '';
      const qaClass   = qaSt ? (qaSt === 'pass' ? 'is-pass' : 'is-fail') : '';

      return `<tr>
        <td class="col-num">${escHtml(fmtYM(r.ym))}</td>
        <td class="col-associate">${escHtml(r.a || '—')}</td>
        <td class="col-manager">${escHtml(r.m || '—')}</td>
        <td class="col-num">${fmt.num(r.act)}</td>
        <td class="col-num">${fmt.num(r.tgt)}</td>
        <td class="col-num ${prodClass}">${r.prodPct != null ? fmt.pct(r.prodPct) : '—'}</td>
        <td class="col-num ${qaClass}">${r.avgQA != null ? fmt.pct(r.avgQA) : '—'}</td>
        <td class="col-num">${prodPill}</td>
        <td class="col-num">${qaPill}</td>
      </tr>`;
    }).join('');

    updateDetailSortUI();
  }

  /* ── Detail table sort ───────────────────────────────────── */
  function initDetailSort(getRows) {
    document.querySelectorAll('#mp-detail-table [data-mp-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.mpSort;
        DT.sortDir = DT.sortCol === col ? (DT.sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
        DT.sortCol = col;
        renderDetailTable(getRows());
      });
    });
  }

  /* ── Master render ───────────────────────────────────────── */
  function render() {
    const rows       = computeRows();
    const monthRows  = computeMonthTrend(rows);
    renderKPIs(rows);
    renderGrid(rows);
    renderDetailTable(rows);
    renderProdChart(monthRows);
    renderQATrendChart(monthRows);
    renderDistChart(rows);
  }

  /* ── Filter controls ─────────────────────────────────────── */
  function buildMonthPills() {
    const container = document.getElementById('mp-month-pills');
    if (!container) return;
    const months = uniqueSorted(D_PROD, 'ym');

    const mkBtn = (val, label) => {
      const b = document.createElement('button');
      b.className = 'orbit-pill' + (S.month === val ? ' is-active' : '');
      b.textContent = label;
      b.dataset.month = val;
      return b;
    };

    container.appendChild(mkBtn('all', 'All'));
    months.forEach(ym => container.appendChild(mkBtn(ym, ym)));

    container.addEventListener('click', e => {
      const btn = e.target.closest('[data-month]');
      if (!btn) return;
      S.month = btn.dataset.month;
      container.querySelectorAll('[data-month]').forEach(b =>
        b.classList.toggle('is-active', b === btn));
      rebuildAssocSelect();
      render();
    });
  }

  function buildManagerSelect() {
    const sel = document.getElementById('mp-manager-select');
    if (!sel) return;
    sel.innerHTML = '<option value="all">All Managers</option>';
    D_MANAGERS.forEach(m => {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      S.manager = sel.value;
      S.assoc   = 'all';
      rebuildAssocSelect();
      render();
    });
  }

  function buildAssocSelect() {
    rebuildAssocSelect();
    document.getElementById('mp-assoc-select')
      ?.addEventListener('change', e => { S.assoc = e.target.value; render(); });
  }

  function rebuildAssocSelect() {
    const sel = document.getElementById('mp-assoc-select');
    if (!sel) return;
    const prev = sel.value;
    const assocs = [...new Set(
      D_PROD
        .filter(r =>
          (S.month   === 'all' || r.ym === S.month) &&
          (S.manager === 'all' || r.m  === S.manager))
        .map(r => r.a).filter(Boolean)
    )].sort();
    sel.innerHTML = '<option value="all">All Associates</option>';
    assocs.forEach(a => {
      const o = document.createElement('option');
      o.value = a; o.textContent = a;
      if (a === prev) o.selected = true;
      sel.appendChild(o);
    });
    if (!assocs.includes(S.assoc)) S.assoc = 'all';
  }

  /* ── Export CSV ──────────────────────────────────────────── */
  function initExport(getRows) {
    document.getElementById('mp-export-btn')
      ?.addEventListener('click', () => {
        const rows = sortedRows(getRows());
        const hdr  = ['Month','Associate','Manager','Actual','Target','Prod %','QA Score %','Prod Status','QA Status'];
        const lines = rows.map(r => {
          const prodSt = r.prodPct != null ? (r.prodPct >= 1.0 ? 'PASS' : 'FAIL') : '—';
          const qaSt   = r.avgQA   != null ? (r.avgQA >= QA_PASS ? 'PASS' : 'FAIL') : '—';
          return [
            `"${fmtYM(r.ym)}"`,
            `"${(r.a||'').replace(/"/g,'""')}"`,
            `"${(r.m||'').replace(/"/g,'""')}"`,
            r.act || 0, r.tgt || 0,
            r.prodPct != null ? (r.prodPct*100).toFixed(2) : '',
            r.avgQA   != null ? (r.avgQA*100).toFixed(2)   : '',
            prodSt, qaSt,
          ].join(',');
        });
        const csv  = [hdr.join(','), ...lines].join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `ORBIT_Monthly_Performance_${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      });
  }

  /* ── Init ────────────────────────────────────────────────── */
  function init() {
    buildMonthPills();
    buildManagerSelect();
    buildAssocSelect();
    initDetailSort(() => computeRows());
    initExport(() => computeRows());
    render();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', MP.init);


/* ============================================================
   RICH TOOLTIP — ORBIT_TT namespace
   Power BI-style tooltip driven by data-tt-title / data-tt-body
   and dynamic data-tt keys ('ent', 'ent-var').
   Positions BELOW the host card; flips above if no room.
   ============================================================ */

const ORBIT_TT = (() => {
  let tipEl = null;

  function ensureEl() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'orbit-tooltip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  // Build HTML for dynamic Enterprise cards
  function dynamicHTML(key) {
    if (key === 'ent') {
      const res = ENT.compute(STATE.month);
      if (!res) {
        return `<div class="orbit-tooltip__title">Enterprise Target</div>
          <div class="orbit-tooltip__body">Select a single month in the Timeline to compute the enterprise target.<br><br>
          Formula: ${ENT.RATE} × ${ENT.HEADCOUNT} headcount × business days.</div>`;
      }
      return `<div class="orbit-tooltip__title">Enterprise Target</div>
        <div class="orbit-tooltip__row"><span>Daily Target / Associate</span><b>${ENT.RATE}</b></div>
        <div class="orbit-tooltip__row"><span>Billable Headcount</span><b>${ENT.HEADCOUNT}</b></div>
        <div class="orbit-tooltip__row"><span>Business Days (${STATE.month})</span><b>${res.bizDays}</b></div>
        <div class="orbit-tooltip__formula">
          ${ENT.RATE} × ${ENT.HEADCOUNT} × ${res.bizDays}
          <strong>Enterprise Target: ${fmt.num(res.target)}</strong>
        </div>`;
    }
    if (key === 'ent-var') {
      const res = ENT.compute(STATE.month);
      if (!res) {
        return `<div class="orbit-tooltip__title">Enterprise Variance</div>
          <div class="orbit-tooltip__body">Select a single month in the Timeline to compute variance vs the enterprise target.</div>`;
      }
      const totalAct = filterProd(STATE.month, 'all').reduce((s, r) => s + (r.act || 0), 0);
      const variance = totalAct - res.target;
      const dir      = variance >= 0 ? 'above' : 'below';
      return `<div class="orbit-tooltip__title">Enterprise Variance</div>
        <div class="orbit-tooltip__row"><span>Actual Production</span><b>${fmt.num(totalAct)}</b></div>
        <div class="orbit-tooltip__row"><span>Enterprise Target</span><b>${fmt.num(res.target)}</b></div>
        <div class="orbit-tooltip__formula">
          Actual − Enterprise Target
          <strong>${fmt.sign(variance)} units ${dir} target</strong>
        </div>`;
    }
    return '';
  }

  function show(host) {
    const el = ensureEl();
    const key = host.dataset.tt;
    if (key) {
      el.innerHTML = dynamicHTML(key);
    } else {
      const title = host.dataset.ttTitle || '';
      const body  = host.dataset.ttBody  || '';
      if (!title && !body) return;
      el.innerHTML =
        (title ? `<div class="orbit-tooltip__title">${title}</div>` : '') +
        (body  ? `<div class="orbit-tooltip__body">${body}</div>`   : '');
    }

    // Position below the card, horizontally centered on it
    const r  = host.getBoundingClientRect();
    el.style.visibility = 'hidden';
    el.classList.add('is-visible');
    const tw = el.offsetWidth, th = el.offsetHeight;
    el.style.visibility = '';

    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));

    let top = r.bottom + 10;
    if (top + th > window.innerHeight - 8) {
      top = Math.max(8, r.top - th - 10); // flip above card
    }

    el.style.left = left + 'px';
    el.style.top  = top + 'px';
  }

  function hide() {
    if (tipEl) tipEl.classList.remove('is-visible');
  }

  function init() {
    const sel = '[data-tt-title], [data-tt]';
    document.querySelectorAll(sel).forEach(el => {
      el.addEventListener('mouseenter', () => show(el));
      el.addEventListener('mouseleave', hide);
      el.addEventListener('focus', () => show(el));
      el.addEventListener('blur', hide);
      // Make card focusable for keyboard accessibility
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', ORBIT_TT.init);
