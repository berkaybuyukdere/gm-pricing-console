/* GM Pricing Console — frontend */

const MONTHS = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
const DOW = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

const state = {
  stations: [],
  durations: [],
  station: null,
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1, // 1-12
  grid: null,          // { year, month, daysInMonth }
  entry: null,         // current month-cache entry
  cellMap: new Map(),  // "day:dur" -> cell (points at entry.cells)
  conflictSet: new Set(),
  pendingByDay: new Map(), // day -> count of rules still resolving
  monthCache: new Map(),   // "station:year:month" -> {cells, conflictMap, others, totalRules, complete}
  staged: new Map(),   // "day:dur" -> { pct: number|null }  (null = delete)
  applying: false,
  session: false,
  view: 'dashboard',
  vendor: 'ALL',       // vendor code applied to writes
  vendors: [],
  pendingCopy: null,   // {targetKey, cells:[{day,dur,pct}], fromLabel}
};

const $ = (id) => document.getElementById(id);
const key = (day, dur) => `${day}:${dur}`;

// rentalcars.com deep-link templates (formats verified live against their
// search widget; opening these is plain browsing in the user's own browser)
const RC_LOCATIONS = {
  61489: {
    ftsType: 'A', ftsEntry: 'ZRH', iata: 'ZRH',
    name: 'Zurich Airport',
    coords: '47.451900482177734,8.562809944152832',
  },
  61551: {
    ftsType: 'L', ftsEntry: '', iata: '',
    name: 'Zürich Hauptbahnhof',
    coords: '47.37798309326172,8.539767265319824',
  },
};

// pickup/dropoff time rotates on every compare click:
// 19:00 -> 18:30 -> 18:00 -> 17:30 -> 17:00 -> 16:30 -> 16:00 -> back to 19:00
const RC_TIMES = [
  ['19', '0'], ['18', '30'], ['18', '0'], ['17', '30'],
  ['17', '0'], ['16', '30'], ['16', '0'],
];

function nextRcTime() {
  const i = Number(localStorage.getItem('rcTimeIdx') || 0) % RC_TIMES.length;
  localStorage.setItem('rcTimeIdx', String((i + 1) % RC_TIMES.length));
  return RC_TIMES[i];
}

function rentalcarsUrl(day, dur, fixedHh, fixedMm) {
  const cfg = RC_LOCATIONS[state.station];
  if (!cfg) return null;
  const [hh, mm] = fixedHh != null ? [fixedHh, fixedMm] : nextRcTime();
  const pu = new Date(state.year, state.month - 1, day, 10, 0);
  const dropoff = new Date(pu.getTime() + dur * 86400000);
  const p = new URLSearchParams();
  p.set('puDay', pu.getDate());
  p.set('puMonth', pu.getMonth() + 1);
  p.set('puYear', pu.getFullYear());
  p.set('puHour', hh);
  p.set('puMinute', mm);
  p.set('doDay', dropoff.getDate());
  p.set('doMonth', dropoff.getMonth() + 1);
  p.set('doYear', dropoff.getFullYear());
  p.set('doHour', hh);
  p.set('doMinute', mm);
  p.set('driversAge', '30');
  p.set('filterCriteria_sortBy', 'PRICE');
  p.set('filterCriteria_sortAscending', 'true');
  p.set('ftsType', cfg.ftsType);
  p.set('dropFtsType', cfg.ftsType);
  if (cfg.ftsEntry) p.set('ftsEntry', cfg.ftsEntry);
  p.set('locationName', cfg.name);
  p.set('dropLocationName', cfg.name);
  if (cfg.iata) {
    p.set('locationIata', cfg.iata);
    p.set('dropLocationIata', cfg.iata);
  }
  p.set('coordinates', cfg.coords);
  p.set('dropCoordinates', cfg.coords);
  return 'https://www.rentalcars.com/search-results?' + p.toString();
}

// ---------- dialogs (prompt/confirm are unavailable in some embedded browsers) ----------

function dialogBox({ text, input = false, value = '' }) {
  return new Promise((resolve) => {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    bd.innerHTML = `<div class="modal modal-sm">
      <div class="modal-body">
        <p class="modal-text">${text}</p>
        ${input ? '<input type="text" class="field-input" id="dlgInput" spellcheck="false">' : ''}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="dlgCancel">CANCEL</button>
        <button class="btn btn-primary" id="dlgOk">OK</button>
      </div></div>`;
    document.body.appendChild(bd);
    const inp = bd.querySelector('#dlgInput');
    if (inp) {
      inp.value = value;
      inp.focus();
      inp.select();
    }
    const done = (v) => {
      bd.remove();
      resolve(v);
    };
    bd.querySelector('#dlgOk').onclick = () => done(input ? inp.value : true);
    bd.querySelector('#dlgCancel').onclick = () => done(null);
    bd.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') { e.preventDefault(); done(input ? inp.value : true); }
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
      },
      true
    );
  });
}

const confirmBox = (text) => dialogBox({ text });
const inputBox = (text, value) => dialogBox({ text, input: true, value });

// ---------- toasts ----------

function toast(msg, cls) {
  const el = document.createElement('div');
  el.className = 'toast' + (cls ? ' toast-' + cls : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ---------- api ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setSession(false);
    openSessionModal(data.error === 'SESSION_EXPIRED' ? 'Session expired — paste a fresh cookie.' : '');
    throw new Error(data.error || 'NO_SESSION');
  }
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

// ---------- session ----------

function setSession(ok) {
  state.session = ok;
  $('sessionChip').innerHTML = ok
    ? '<span class="dot dot-green"></span>SESSION ACTIVE'
    : '<span class="dot dot-red"></span>NO SESSION';
  $('sessionBtn').textContent = ok ? 'RECONNECT' : 'CONNECT';
}

function openSessionModal(err) {
  $('loginError').classList.toggle('hidden', !err);
  $('loginError').textContent = err || '';
  $('sessionModal').classList.remove('hidden');
  $('userInput').focus();
}

$('sessionBtn').onclick = () => openSessionModal('');
$('loginCancel').onclick = () => $('sessionModal').classList.add('hidden');

async function doLogin() {
  const username = $('userInput').value.trim();
  const password = $('passInput').value;
  if (!username || !password) {
    $('loginError').classList.remove('hidden');
    $('loginError').textContent = 'Enter both username and password.';
    return;
  }
  $('loginSave').disabled = true;
  $('loginSave').textContent = 'SIGNING IN…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    $('sessionModal').classList.add('hidden');
    $('passInput').value = '';
    setSession(true);
    toast('FMX session connected.');
    loadVendors();
    await loadGrid();
    renderDashboard();
  } catch (e) {
    $('loginError').classList.remove('hidden');
    $('loginError').textContent =
      e.message === 'LOGIN_FAILED'
        ? 'Login failed — check username / password.'
        : 'Connection failed: ' + e.message;
  } finally {
    $('loginSave').disabled = false;
    $('loginSave').textContent = 'SIGN IN';
  }
}

$('loginSave').onclick = doLogin;
$('passInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

// ---------- controls ----------

function renderStations() {
  const wrap = $('stationTabs');
  wrap.innerHTML = '';
  for (const s of state.stations) {
    const b = document.createElement('button');
    b.className = 'station-tab' + (s.id === state.station ? ' on' : '');
    b.textContent = s.name.toUpperCase();
    b.onclick = async () => {
      if (state.applying) return;
      if (state.staged.size && !(await confirmBox('Discard staged changes?'))) return;
      state.staged.clear();
      state.station = s.id;
      renderStations();
      loadGrid();
    };
    wrap.appendChild(b);
  }
}

async function shiftMonth(delta) {
  if (state.applying) return;
  if (state.staged.size && !(await confirmBox('Discard staged changes?'))) return;
  state.staged.clear();
  let m = state.month + delta;
  if (m < 1) { m = 12; state.year--; }
  if (m > 12) { m = 1; state.year++; }
  state.month = m;
  loadGrid();
}

$('prevMonth').onclick = () => shiftMonth(-1);
$('nextMonth').onclick = () => shiftMonth(1);
$('reloadBtn').onclick = () => !state.applying && loadGrid();

// ---------- grid ----------

let es = null; // active EventSource stream

const cacheKey = () => `${state.station}:${state.year}:${state.month}`;

function setSyncing(on, done, total) {
  const chip = $('syncChip');
  chip.classList.toggle('hidden', !on);
  if (on) chip.textContent = total ? `SYNCING ${done}/${total}` : 'SYNCING';
}

// ---------- price curve chart (SVG, palette validated for both themes) ----------

let chartRaf = null;

function scheduleChart() {
  if (chartRaf) return;
  chartRaf = requestAnimationFrame(() => {
    chartRaf = null;
    renderChart();
  });
}

function renderChart() {
  const wrap = $('chartWrap');
  if (!wrap || !state.grid) return;
  $('chartMonth').textContent = `${MONTHS_SHORT[state.month - 1]} ${state.year}`;

  const days = state.grid.daysInMonth;
  const series = state.durations.map((dur) => {
    const pts = [];
    for (let d = 1; d <= days; d++) {
      const c = state.cellMap.get(key(d, dur));
      pts.push(c ? c.pct : null);
    }
    return { dur, pts };
  });

  const vals = series.flatMap((s) => s.pts).filter((v) => v != null);
  if (!vals.length) {
    wrap.innerHTML = '<div class="chart-empty">No data for this month.</div>';
    $('chartLegend').innerHTML = '';
    return;
  }
  let vMax = Math.max(...vals);
  let vMin = Math.min(...vals);
  vMin = Math.floor((vMin - 2) / 5) * 5;
  vMax = Math.ceil((vMax + 2) / 5) * 5;
  if (vMax === vMin) vMax += 5;

  const W = 320, H = 200, L = 34, R = 30, T = 12, B = 22;
  const x = (d) => L + ((d - 1) * (W - L - R)) / Math.max(days - 1, 1);
  const y = (v) => T + ((vMax - v) * (H - T - B)) / (vMax - vMin || 1);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price change per day and rental duration">`;
  const gridSteps = 5;
  for (let i = 0; i <= gridSteps; i++) {
    const v = vMax - ((vMax - vMin) * i) / gridSteps;
    svg += `<line class="chart-grid-line" x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}"/>`;
    svg += `<text class="chart-axis-label" x="${L - 4}" y="${y(v) + 2.5}" text-anchor="end">${Math.round(v)}</text>`;
  }
  svg += `<text class="chart-axis-label" x="${L - 4}" y="${T - 4}" text-anchor="end">%</text>`;
  const xticks = [];
  for (let d = 1; d <= days; d += 5) xticks.push(d);
  if (!xticks.includes(days)) xticks.push(days);
  for (const d of xticks) {
    svg += `<text class="chart-axis-label" x="${x(d)}" y="${H - 6}" text-anchor="middle">${d}</text>`;
  }
  // today marker
  const now = new Date();
  if (state.year === now.getFullYear() && state.month === now.getMonth() + 1) {
    const tx = x(now.getDate());
    svg += `<line class="chart-today" x1="${tx}" y1="${T}" x2="${tx}" y2="${H - B}"/>`;
    svg += `<text class="chart-axis-label chart-today-label" x="${tx}" y="${T - 4}" text-anchor="middle">TODAY</text>`;
  }

  const labelYs = [];
  for (const s of series) {
    let path = '';
    let pen = false;
    let last = null;
    for (let d = 1; d <= days; d++) {
      const v = s.pts[d - 1];
      if (v == null) { pen = false; continue; }
      path += `${pen ? 'L' : 'M'}${x(d).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
      last = { d, v };
    }
    if (!path) continue;
    svg += `<path class="chart-series s-${s.dur}" d="${path.trim()}"/>`;
    if (last) {
      // direct label at line end, nudged to avoid collisions
      let ly = y(last.v) + 2.5;
      while (labelYs.some((p) => Math.abs(p - ly) < 8)) ly += 8;
      labelYs.push(ly);
      svg += `<text class="chart-label" x="${W - R + 3}" y="${ly}">${s.dur >= 6 ? '6+' : s.dur}D</text>`;
    }
  }
  svg += `<line class="chart-cross" id="chartCross" x1="0" y1="${T}" x2="0" y2="${H - B}" style="display:none"/>`;
  for (const s of series) {
    svg += `<circle class="chart-dot" id="chartDot-${s.dur}" r="3.2" fill="var(--s${s.dur})" style="display:none"/>`;
  }
  svg += '</svg>';

  wrap.innerHTML = svg + '<div class="chart-tip" id="chartTip"></div>';
  window.__lastChartSvg = svg;
  if (state.view === 'dashboard') {
    $('dashChart').innerHTML = svg;
    $('dashChartMonth').textContent = `${MONTHS_SHORT[state.month - 1]} ${state.year}`;
  }

  // per-duration stats for the analytics page
  const durHtml = series
    .map((s) => {
      const v = s.pts.filter((x) => x != null);
      if (!v.length) return '';
      const avg = (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1);
      return `<div class="stat-row"><span><span class="legend-chip chip-s-${s.dur}"></span> ${s.dur >= 6 ? '6+' : s.dur} DAYS</span><b>avg ${avg}% · min ${Math.min(...v)}% · max ${Math.max(...v)}%</b></div>`;
    })
    .join('');
  $('durStats').innerHTML = durHtml || '<div class="drawer-empty">No data.</div>';

  $('chartLegend').innerHTML = state.durations
    .map((dur) => `<span class="legend-item"><span class="legend-chip chip-s-${dur}"></span>${dur >= 6 ? '6+' : dur} DAYS</span>`)
    .join('');

  // hover: crosshair + tooltip with every duration's value for the nearest day
  const svgEl = wrap.querySelector('svg');
  const tip = wrap.querySelector('#chartTip');
  const cross = wrap.querySelector('#chartCross');
  svgEl.onmousemove = (ev) => {
    const rect = svgEl.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const d = Math.max(1, Math.min(days, Math.round((px - L) / ((W - L - R) / Math.max(days - 1, 1))) + 1));
    cross.style.display = '';
    cross.setAttribute('x1', x(d));
    cross.setAttribute('x2', x(d));
    for (const s of series) {
      const dot = wrap.querySelector(`#chartDot-${s.dur}`);
      const v = s.pts[d - 1];
      if (dot) {
        if (v == null) dot.style.display = 'none';
        else {
          dot.style.display = '';
          dot.setAttribute('cx', x(d));
          dot.setAttribute('cy', y(v));
        }
      }
    }
    const rows = series
      .filter((s) => s.pts[d - 1] != null)
      .map((s) => `<div class="tip-row"><span class="legend-chip chip-s-${s.dur}"></span>${s.dur >= 6 ? '6+' : s.dur}D<b>${s.pts[d - 1]}%</b></div>`)
      .join('');
    tip.innerHTML = `<div class="tip-day">DAY ${String(d).padStart(2, '0')}</div>` + (rows || '<div class="tip-row">no rules</div>');
    tip.style.display = 'block';
    const tipX = (x(d) / W) * rect.width;
    tip.style.left = Math.min(tipX + 10, rect.width - 110) + 'px';
    tip.style.top = '8px';
  };
  svgEl.onmouseleave = () => {
    tip.style.display = 'none';
    cross.style.display = 'none';
    for (const s of series) {
      const dot = wrap.querySelector(`#chartDot-${s.dur}`);
      if (dot) dot.style.display = 'none';
    }
  };
}

function updateChips() {
  const e = state.entry;
  if (!e) return;
  $('ruleCountChip').textContent = `${e.totalRules} RULES`;
  const conflicts = [...e.conflictMap.values()].filter((v) => v.length > 1).length;
  $('conflictChip').classList.toggle('hidden', !conflicts);
  $('conflictChip').textContent = `${conflicts} CONFLICTS`;
  $('othersChip').classList.toggle('hidden', !e.others.length);
  $('othersChip').textContent = `${e.others.length} OTHER RULES`;
  $('othersChip').title = e.others
    .slice(0, 20)
    .map((o) => `#${o.ruleid} ${o.name} (${o.from || ''} → ${o.to || ''}) ${o.note || ''}`)
    .join('\n');

  updateWarnings();
  scheduleChart();
}

// warn about future days that have no pricing rules at all
function updateWarnings() {
  if (!state.grid || !state.entry) return;
  const now = new Date();
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const list = [];
  for (let d = 1; d <= state.grid.daysInMonth; d++) {
    const future = new Date(state.year, state.month - 1, d) >= t0;
    const covered = state.durations.some((dur) => state.entry.cells.has(key(d, dur)));
    const show = future && !covered && state.entry.complete;
    const ico = document.getElementById(`dayWarn-${d}`);
    if (ico) ico.classList.toggle('hidden', !show);
    if (show) list.push(d);
  }
  $('warnChip').classList.toggle('hidden', !list.length);
  $('warnChip').textContent = `${list.length} UNCOVERED`;
  $('warnChip').title = 'Future days with no pricing rules: ' + list.join(', ');
}

function decPending(day) {
  const n = (state.pendingByDay.get(day) || 0) - 1;
  if (n <= 0) state.pendingByDay.delete(day);
  else state.pendingByDay.set(day, n);
  const dot = document.getElementById(`dayDot-${day}`);
  if (dot) dot.classList.toggle('on', state.pendingByDay.has(day));
  const total = state._streamTotal || 0;
  state._streamDone = (state._streamDone || 0) + 1;
  setSyncing(true, state._streamDone, total);
}

function renderDayDots() {
  if (!state.grid) return;
  for (let d = 1; d <= state.grid.daysInMonth; d++) {
    const dot = document.getElementById(`dayDot-${d}`);
    if (dot) dot.classList.toggle('on', state.pendingByDay.has(d));
  }
}

function loadGrid() {
  $('monthLabel').textContent = `${MONTHS[state.month - 1]} ${state.year}`;
  if (!state.session) return;
  if (es) { es.close(); es = null; }

  state.grid = {
    year: state.year,
    month: state.month,
    daysInMonth: new Date(state.year, state.month, 0).getDate(),
  };

  // month cache: render instantly from cache, then revalidate in background
  let entry = state.monthCache.get(cacheKey());
  if (!entry) {
    entry = { cells: new Map(), conflictMap: new Map(), others: [], totalRules: 0, complete: false };
    state.monthCache.set(cacheKey(), entry);
  }
  state.entry = entry;
  state.cellMap = entry.cells;
  state.conflictSet = new Set(entry.conflictMap.keys());
  state.pendingByDay = new Map();
  state._streamDone = 0;
  state._streamTotal = 0;

  $('gridEmpty').classList.add('hidden');
  $('gridTable').classList.remove('hidden');
  renderGrid();
  updateChips();
  renderApplyBar();

  // month-copy landing: stage the copied cells onto this month
  if (state.pendingCopy && state.pendingCopy.targetKey === cacheKey()) {
    const pc = state.pendingCopy;
    state.pendingCopy = null;
    let n = 0;
    for (const c of pc.cells) {
      if (c.day <= state.grid.daysInMonth) {
        state.staged.set(key(c.day, c.dur), { pct: c.pct });
        refreshCell(c.day, c.dur);
        n++;
      }
    }
    renderApplyBar();
    toast(`${n} change(s) staged from ${pc.fromLabel}. Review, then APPLY TO FMX.`);
  }

  // stream fresh data; cells paint one by one as they resolve
  setSyncing(true);
  es = new EventSource(`/api/grid/stream?station=${state.station}&year=${state.year}&month=${state.month}`);
  const boundKey = cacheKey();
  const finish = () => {
    if (es) { es.close(); es = null; }
    setSyncing(false);
  };
  const stillCurrent = () => boundKey === cacheKey();

  es.addEventListener('meta', (ev) => {
    if (!stillCurrent()) return;
    const m = JSON.parse(ev.data);
    entry.totalRules = m.totalRules;
    entry.others = m.others;
    state.pendingByDay = new Map();
    for (const p of m.pending)
      state.pendingByDay.set(p.day, (state.pendingByDay.get(p.day) || 0) + 1);
    state._streamTotal = m.pending.length;
    renderDayDots();
    updateChips();
  });

  es.addEventListener('cell', (ev) => {
    if (!stillCurrent()) return;
    const c = JSON.parse(ev.data);
    decPending(c.day);
    const k = key(c.day, c.dur);
    const existing = entry.cells.get(k);
    if (existing && existing.ruleid !== c.ruleid) {
      // a second FMX rule landed on the same cell -> live conflict
      entry.conflictMap.set(k, [existing.ruleid, c.ruleid]);
      state.conflictSet.add(k);
      refreshCell(c.day, c.dur);
      updateChips();
      return;
    }
    if (
      !existing ||
      existing.pct !== c.pct ||
      existing.active !== c.active ||
      existing.op !== c.op ||
      existing.updated !== c.updated
    ) {
      entry.cells.set(k, c);
      refreshCell(c.day, c.dur); // paint as it arrives
    }
  });

  es.addEventListener('skip', (ev) => {
    if (!stillCurrent()) return;
    const s = JSON.parse(ev.data);
    decPending(s.day);
    if (!entry.others.some((o) => o.ruleid === s.ruleid)) entry.others.push(s);
    updateChips();
  });

  es.addEventListener('done', (ev) => {
    if (!stillCurrent()) return finish();
    const d = JSON.parse(ev.data);
    // drop cached cells whose FMX rules disappeared since last visit
    const valid = new Set(d.keys);
    for (const k of [...entry.cells.keys()]) {
      if (!valid.has(k)) {
        entry.cells.delete(k);
        const [dd, du] = k.split(':').map(Number);
        refreshCell(dd, du);
      }
    }
    entry.conflictMap = new Map(d.conflicts.map((c) => [key(c.day, c.dur), c.ruleids]));
    state.conflictSet = new Set(entry.conflictMap.keys());
    for (const c of d.conflicts) refreshCell(c.day, c.dur);
    entry.complete = true;
    state.pendingByDay.clear();
    renderDayDots();
    updateChips();
    if (state.view === 'dashboard') renderDashboard();
    finish();
  });

  es.addEventListener('fail', (ev) => {
    const d = JSON.parse(ev.data);
    finish();
    if (d.code === 401) {
      setSession(false);
      openSessionModal('Session expired — sign in again.');
    } else {
      toast('Sync failed: ' + d.error, 'error');
    }
  });

  es.onerror = () => finish();
}

function fmtPct(v) {
  const n = Number(v);
  return (n > 0 ? '+' : '') + (Number.isInteger(n) ? String(n) : n.toFixed(2)) + '%';
}

function renderGrid() {
  const g = state.grid;
  const head = $('gridHead');
  head.innerHTML = '';
  const dayTh = document.createElement('th');
  dayTh.className = 'day-col';
  dayTh.textContent = 'DAY';
  head.appendChild(dayTh);
  for (const dur of state.durations) {
    const th = document.createElement('th');
    th.textContent = dur >= 6 ? `${dur}+ DAYS` : `${dur} DAYS`;
    th.title = 'Click to fill entire column';
    th.onclick = () => fillColumn(dur);
    head.appendChild(th);
  }

  const body = $('gridBody');
  body.innerHTML = '';
  for (let day = 1; day <= g.daysInMonth; day++) {
    const tr = document.createElement('tr');
    const dow = new Date(g.year, g.month - 1, day).getDay();
    if (dow === 0 || dow === 6) tr.className = 'weekend';

    const tdDay = document.createElement('td');
    tdDay.innerHTML = `<div class="day-label" title="Click to fill entire row"><span>${String(day).padStart(2, '0')}<span class="day-dot" id="dayDot-${day}"></span><span class="day-warn-ico hidden" id="dayWarn-${day}" title="No pricing rules for this future day">!</span></span><span><span class="day-analyze" data-day="${day}" title="rentalcars top-10 competitor analysis">&#8981;</span><span class="dow">${DOW[dow]}</span></span></div>`;
    tdDay.onclick = (e) => {
      if (e.target.classList && e.target.classList.contains('day-analyze')) {
        e.stopPropagation();
        openRcAnalysis(day);
      } else {
        fillRow(day);
      }
    };
    tr.appendChild(tdDay);

    for (const dur of state.durations) {
      tr.appendChild(renderCell(day, dur));
    }
    body.appendChild(tr);
  }
}

function renderCell(day, dur) {
  const td = document.createElement('td');
  td.dataset.day = day;
  td.dataset.dur = dur;
  const k = key(day, dur);

  td.oncontextmenu = (e) => {
    e.preventDefault();
    const url = rentalcarsUrl(day, dur);
    if (url) window.open(url, '_blank');
  };

  if (state.conflictSet.has(k)) {
    td.className = 'cell-conflict';
    td.textContent = 'CONFLICT';
    const ids = (state.entry && state.entry.conflictMap.get(k)) || [];
    td.title = 'Multiple FMX rules match this cell: #' + ids.join(', #') + '\nResolve in FuseMetrix first.';
    return td;
  }

  const cell = state.cellMap.get(k);
  const staged = state.staged.get(k);

  if (staged !== undefined) {
    td.classList.add('cell-staged');
    if (staged.pct === null) {
      td.classList.add('cell-staged-del');
      td.textContent = cell ? fmtPct(cell.pct) : '—';
    } else {
      td.textContent = fmtPct(staged.pct);
    }
  } else if (cell) {
    td.textContent = fmtPct(cell.pct);
    td.classList.add(cell.pct < 0 ? 'cell-neg' : 'cell-pos');
    if (!cell.active) td.classList.add('cell-inactive');
    if (cell.opMismatch) {
      td.classList.add('cell-op-mismatch');
      td.dataset.op = cell.op;
    }
    td.title = `#${cell.ruleid} ${cell.name}\nop ${cell.op} ${dur} · vendors ${cell.vendors.join(',') || '—'}${cell.updated ? '\nupdated ' + cell.updated : ''}\nRight-click: compare on rentalcars.com`;
  } else {
    td.classList.add('cell-empty');
    td.textContent = '—';
    td.title = 'Click: set % · Right-click: compare on rentalcars.com';
  }

  td.onclick = () => editCell(td, day, dur);
  return td;
}

function editCell(td, day, dur) {
  if (state.applying) return;
  const k = key(day, dur);
  if (state.conflictSet.has(k)) return;
  if (td.querySelector('input')) return;

  const cell = state.cellMap.get(k);
  const staged = state.staged.get(k);
  const current = staged !== undefined ? (staged.pct === null ? '' : staged.pct) : cell ? cell.pct : '';

  td.textContent = '';
  const input = document.createElement('input');
  input.className = 'cell-input';
  input.value = current;
  input.placeholder = '-62';
  td.appendChild(input);
  input.focus();
  input.select();

  const commit = () => {
    const raw = input.value.trim().replace(',', '.');
    if (raw === '') {
      // empty: delete if a rule exists, otherwise unstage
      if (cell) state.staged.set(k, { pct: null });
      else state.staged.delete(k);
    } else {
      const num = Number(raw);
      if (!isFinite(num)) { cancel(); return; }
      if (cell && Number(cell.pct) === num) state.staged.delete(k);
      else state.staged.set(k, { pct: num });
    }
    refreshCell(day, dur);
    renderApplyBar();
  };
  const cancel = () => refreshCell(day, dur);

  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };
  input.onblur = commit;
}

function refreshCell(day, dur) {
  const old = document.querySelector(`td[data-day="${day}"][data-dur="${dur}"]`);
  if (old) old.replaceWith(renderCell(day, dur));
  scheduleChart();
}

async function fillColumn(dur) {
  if (state.applying || !state.grid) return;
  const raw = await inputBox(`Set ${dur >= 6 ? dur + '+' : dur}-day % for EVERY day of ${MONTHS[state.month - 1]}:`);
  if (raw === null || raw.trim() === '') return;
  const num = Number(raw.trim().replace(',', '.'));
  if (!isFinite(num)) { toast('Invalid number.', 'error'); return; }
  for (let day = 1; day <= state.grid.daysInMonth; day++) {
    const k = key(day, dur);
    if (state.conflictSet.has(k)) continue;
    const cell = state.cellMap.get(k);
    if (cell && Number(cell.pct) === num) state.staged.delete(k);
    else state.staged.set(k, { pct: num });
    refreshCell(day, dur);
  }
  renderApplyBar();
}

async function fillRow(day) {
  if (state.applying || !state.grid) return;
  const raw = await inputBox(`Set % for ALL durations on day ${String(day).padStart(2, '0')}:`);
  if (raw === null || raw.trim() === '') return;
  const num = Number(raw.trim().replace(',', '.'));
  if (!isFinite(num)) { toast('Invalid number.', 'error'); return; }
  for (const dur of state.durations) {
    const k = key(day, dur);
    if (state.conflictSet.has(k)) continue;
    const cell = state.cellMap.get(k);
    if (cell && Number(cell.pct) === num) state.staged.delete(k);
    else state.staged.set(k, { pct: num });
    refreshCell(day, dur);
  }
  renderApplyBar();
}

// ---------- apply ----------

function renderApplyBar() {
  $('applyBar').classList.toggle('hidden', state.staged.size === 0);
  $('stagedCount').textContent = state.staged.size;
  $('applyBtn').disabled = state.applying;
  $('discardBtn').disabled = state.applying;
  if (state.entry) updateChips();
}

$('discardBtn').onclick = () => {
  if (state.applying) return;
  const keys = [...state.staged.keys()];
  state.staged.clear();
  for (const k of keys) {
    const [day, dur] = k.split(':').map(Number);
    refreshCell(day, dur);
  }
  renderApplyBar();
};

$('applyBtn').onclick = async () => {
  if (state.applying || !state.staged.size) return;
  const changes = [...state.staged.entries()].map(([k, v]) => {
    const [day, dur] = k.split(':').map(Number);
    return { day, dur, pct: v.pct };
  });
  if (!(await confirmBox(`Apply ${changes.length} change(s) to FuseMetrix (${stationName()})?`))) return;

  state.applying = true;
  renderApplyBar();
  let ok = 0, fail = 0;

  for (const ch of changes) {
    const k = key(ch.day, ch.dur);
    const td = document.querySelector(`td[data-day="${ch.day}"][data-dur="${ch.dur}"]`);
    if (td) { td.className = 'cell-applying'; td.textContent = '…'; }
    const cell = state.cellMap.get(k);
    try {
      let result;
      if (ch.pct === null) {
        if (cell) {
          const q = `station=${state.station}&day=${ch.day}&duration=${ch.dur}&month=${state.month}&year=${state.year}&prevPct=${cell.pct}`;
          result = await api(`/api/rule/${cell.ruleid}?${q}`, { method: 'DELETE' });
          state.cellMap.delete(k);
        }
      } else if (cell) {
        result = await api(`/api/rule/${cell.ruleid}`, {
          method: 'PUT',
          body: { station: state.station, day: ch.day, duration: ch.dur, month: state.month, year: state.year, pct: ch.pct, active: cell.active, prevPct: cell.pct, vendors: [state.vendor] },
        });
        state.cellMap.set(k, { ...cell, pct: ch.pct, op: ch.dur >= 6 ? '>=' : '=', opMismatch: false, vendors: ['ALL'] });
      } else {
        result = await api('/api/rule', {
          method: 'POST',
          body: { station: state.station, day: ch.day, duration: ch.dur, month: state.month, year: state.year, pct: ch.pct, active: true, vendors: [state.vendor] },
        });
        state.cellMap.set(k, {
          day: ch.day, dur: ch.dur, ruleid: result.ruleid, name: result.detail.rulename,
          pct: ch.pct, active: true, op: ch.dur >= 6 ? '>=' : '=', opMismatch: false, vendors: ['ALL'], updated: '',
        });
      }
      if (result && result.verified === false) {
        toast(`#${result.ruleid} saved but verification mismatch: ${result.problems.join(', ')}`, 'warn');
      }
      state.staged.delete(k);
      refreshCell(ch.day, ch.dur);
      const fresh = document.querySelector(`td[data-day="${ch.day}"][data-dur="${ch.dur}"]`);
      if (fresh) fresh.classList.add('cell-ok');
      ok++;
    } catch (e) {
      fail++;
      if (td) { td.className = 'cell-error'; td.textContent = 'ERR'; td.title = e.message; }
      toast(`Day ${ch.day} / ${ch.dur}d failed: ${e.message}`, 'error');
      if (String(e.message).includes('SESSION')) break;
    }
    renderApplyBar();
  }

  state.applying = false;
  renderApplyBar();
  toast(`Apply finished: ${ok} ok, ${fail} failed.`, fail ? 'warn' : undefined);
  // no full reload — cells were updated in place from the verified responses
  refreshLogs();
};

function stationName() {
  const s = state.stations.find((x) => x.id === state.station);
  return s ? s.name : state.station;
}

// ---------- theme ----------

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('theme', t);
  $('themeBtn').textContent = t === 'dark' ? 'LIGHT' : 'DARK';
}

$('themeBtn').onclick = () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

applyTheme(localStorage.getItem('theme') || 'dark');

// ---------- activity logs ----------

const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

let lastLogs = [];

function logEntryHtml(l, i, compact) {
  const d = new Date(l.ts);
  const when = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const target = l.day
    ? `${String(l.day).padStart(2, '0')} ${MONTHS_SHORT[(l.month || 1) - 1]} ${l.year} · ${l.duration >= 6 ? l.duration + '+' : l.duration}D`
    : l.file ? esc(l.file) : `#${l.ruleid || '—'}`;
  const fmt = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v + '%');
  const change = l.action === 'backup' ? '' : `<span class="log-change"><b>${fmt(l.before)}</b> &rarr; <b>${fmt(l.after)}</b></span>`;
  const status = l.ok
    ? `<span class="log-status-ok">OK${l.verified === false ? ' (unverified)' : ''}</span>`
    : `<span class="log-status-err">FAILED ${esc(l.error || '')}</span>`;
  const canRevert =
    !compact && l.ok && ['create', 'update', 'delete'].includes(l.action) &&
    l.day && l.station;
  const revertBtn = canRevert
    ? `<button class="btn btn-ghost btn-xs" onclick="revertLog(${i})" title="Undo this change in FMX">REVERT</button>`
    : '';
  const vendor = l.vendor && l.vendor !== 'ALL' ? ` · ${esc(l.vendor)}` : '';
  const actionCls = l.action.startsWith('restore') ? 'update' : l.action;
  return `<div class="log-entry">
    <div class="log-line1"><span>${when} · ${esc(l.user || '')}</span><span>${esc(l.stationName || '')}${l.ruleid ? ' · #' + l.ruleid : ''}${vendor}</span></div>
    <div class="log-line2"><span class="log-action ${actionCls}">${l.action.toUpperCase()}</span><span class="log-target">${target}</span>${change}${status}${revertBtn}</div>
  </div>`;
}

async function refreshLogs() {
  try {
    const { logs } = await (await fetch('/api/logs?limit=200')).json();
    lastLogs = logs;
    const list = $('logsList');
    list.innerHTML = logs.length
      ? logs.map((l, i) => logEntryHtml(l, i, false)).join('')
      : '<div class="drawer-empty">No activity yet.</div>';
    $('dashActivity').innerHTML = logs.length
      ? logs.slice(0, 8).map((l, i) => logEntryHtml(l, i, true)).join('')
      : '<div class="drawer-empty">No activity yet.</div>';
  } catch {}
}

async function revertLog(i) {
  const l = lastLogs[i];
  if (!l) return;
  const fmt = (v) => (v == null ? '—' : v + '%');
  if (!(await confirmBox(`Revert this ${l.action}? ${String(l.day).padStart(2, '0')} ${MONTHS_SHORT[(l.month || 1) - 1]} ${l.year} · ${l.duration}D will go back to ${fmt(l.before)} (${l.stationName}).`)))
    return;
  try {
    const base = { station: l.station, day: l.day, duration: l.duration, month: l.month, year: l.year };
    if (l.action === 'create') {
      await api(`/api/rule/${l.ruleid}?station=${l.station}&day=${l.day}&duration=${l.duration}&month=${l.month}&year=${l.year}&prevPct=${l.after}`, { method: 'DELETE' });
    } else if (l.action === 'update') {
      await api(`/api/rule/${l.ruleid}`, { method: 'PUT', body: { ...base, pct: l.before, active: true, prevPct: l.after, vendors: l.vendor ? l.vendor.split(',') : ['ALL'] } });
    } else if (l.action === 'delete') {
      await api('/api/rule', { method: 'POST', body: { ...base, pct: l.before, active: true, vendors: l.vendor ? l.vendor.split(',') : ['ALL'] } });
    }
    toast('Reverted.');
    state.monthCache.delete(`${l.station}:${l.year}:${l.month}`);
    if (l.station === state.station && l.year === state.year && l.month === state.month) loadGrid();
    refreshLogs();
  } catch (e) {
    toast('Revert failed: ' + e.message, 'error');
  }
}
window.revertLog = revertLog;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('logsRefresh').onclick = refreshLogs;

// ---------- view router ----------

function showView(name) {
  state.view = name;
  for (const v of ['dashboard', 'grid', 'analytics', 'activity']) {
    $('view-' + v).classList.toggle('hidden', v !== name);
  }
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.classList.toggle('on', b.dataset.view === name)
  );
  if (name === 'activity') refreshLogs();
  if (name === 'dashboard') { renderDashboard(); startRcMonth(); }
  if (name === 'analytics') scheduleChart();
  if (location.hash !== '#' + name) location.hash = name;
}

document.querySelectorAll('[data-view]').forEach((b) => {
  if (b.dataset.view) b.addEventListener('click', () => showView(b.dataset.view));
});

window.addEventListener('hashchange', () => {
  const h = location.hash.replace('#', '');
  if (['dashboard', 'grid', 'analytics', 'activity'].includes(h) && h !== state.view) showView(h);
});

// ---------- dashboard ----------

function renderDashboard() {
  // station cards from month cache (current month)
  const wrap = $('dashStations');
  wrap.innerHTML = state.stations
    .map((s) => {
      const entry = state.monthCache.get(`${s.id}:${state.year}:${state.month}`);
      let body;
      if (entry && entry.cells.size) {
        const cells = [...entry.cells.values()];
        const act = cells.filter((c) => c.active);
        const avg = act.length ? (act.reduce((a, c) => a + c.pct, 0) / act.length).toFixed(1) + '%' : '—';
        const uncovered = countUncovered(entry);
        body = `<div class="stat-big">${avg}</div>
          <div class="stat-rows">
            <div class="stat-row"><span>AVG CHANGE · ${MONTHS_SHORT[state.month - 1]} ${state.year}</span></div>
            <div class="stat-row"><span>GRID CELLS</span><b>${cells.length}</b></div>
            <div class="stat-row"><span>TOTAL RULES</span><b>${entry.totalRules}</b></div>
            <div class="stat-row"><span>UNCOVERED DAYS</span><b class="${uncovered ? 'stat-warn' : ''}">${uncovered}</b></div>
          </div>`;
      } else {
        body = `<div class="stat-big">—</div><div class="stat-rows"><div class="stat-row"><span>Not loaded — click to open the grid.</span></div></div>`;
      }
      return `<div class="card stat-card" onclick="openStation(${s.id})">
        <div class="card-title">${s.name.toUpperCase()}</div>${body}</div>`;
    })
    .join('');

  // mini chart copy
  if (window.__lastChartSvg) {
    $('dashChart').innerHTML = window.__lastChartSvg;
    $('dashChartMonth').textContent = `${MONTHS_SHORT[state.month - 1]} ${state.year}`;
  }
  refreshBackups();
  refreshLogs();
}

function openStation(id) {
  state.station = id;
  renderStations();
  showView('grid');
  loadGrid();
}
window.openStation = openStation;

function countUncovered(entry) {
  if (!state.grid) return 0;
  const today = new Date();
  let n = 0;
  for (let d = 1; d <= state.grid.daysInMonth; d++) {
    const dt = new Date(state.year, state.month - 1, d);
    if (dt < new Date(today.getFullYear(), today.getMonth(), today.getDate())) continue;
    if (!state.durations.some((dur) => entry.cells.has(key(d, dur)))) n++;
  }
  return n;
}

// ---------- restore points ----------

async function refreshBackups() {
  try {
    const { backups } = await (await fetch('/api/backups')).json();
    $('backupList').innerHTML = backups.length
      ? backups
          .map((b) => {
            const d = new Date(b.ts);
            const when = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            return `<div class="backup-row"><span>${when} · ${(b.size / 1024).toFixed(0)} KB</span>
              <button class="btn btn-ghost btn-xs" onclick="restoreFlow('${esc(b.file)}')">RESTORE</button></div>`;
          })
          .join('')
      : '<div class="drawer-empty">No restore points yet.</div>';
  } catch {}
}

$('backupBtn').onclick = async () => {
  if (!state.session) return openSessionModal('');
  $('backupBtn').disabled = true;
  $('backupBtn').textContent = 'CREATING…';
  try {
    const r = await api('/api/backup', { method: 'POST', body: {} });
    toast(`Restore point created: ${Object.entries(r.counts).map(([k, v]) => `${k} ${v} rules`).join(', ')}`);
    refreshBackups();
  } catch (e) {
    toast('Backup failed: ' + e.message, 'error');
  } finally {
    $('backupBtn').disabled = false;
    $('backupBtn').textContent = '+ CREATE';
  }
};

async function restoreFlow(file) {
  const stName = stationName();
  const mLabel = `${MONTHS[state.month - 1]} ${state.year}`;
  if (!(await confirmBox(`Restore ${stName} / ${mLabel} from ${file}? A dry-run diff will be shown first.`))) return;
  try {
    const dry = await api('/api/restore', { method: 'POST', body: { file, station: state.station, year: state.year, month: state.month, dryRun: true } });
    if (!dry.actions.length) { toast('Nothing to restore — current grid already matches this restore point.'); return; }
    const counts = { create: 0, update: 0, delete: 0 };
    dry.actions.forEach((a) => counts[a.type]++);
    if (!(await confirmBox(`Restore will apply ${dry.actions.length} change(s): ${counts.create} create, ${counts.update} update, ${counts.delete} delete. Proceed?`))) return;
    toast('Restoring…');
    const r = await api('/api/restore', { method: 'POST', body: { file, station: state.station, year: state.year, month: state.month } });
    const fail = r.results.filter((x) => !x.ok).length;
    toast(`Restore finished: ${r.results.length - fail} ok, ${fail} failed.`, fail ? 'warn' : undefined);
    state.monthCache.delete(cacheKey());
    loadGrid();
    refreshLogs();
  } catch (e) {
    toast('Restore failed: ' + e.message, 'error');
  }
}
window.restoreFlow = restoreFlow;

// ---------- vendor selector ----------

async function loadVendors() {
  try {
    const { vendors } = await api('/api/vendors');
    state.vendors = vendors;
    const sel = $('vendorSel');
    const opts = (vendors.includes('ALL') ? vendors : ['ALL', ...vendors])
      .map((v) => `<option ${v === 'ALL' ? 'selected' : ''}>${esc(v)}</option>`)
      .join('');
    sel.innerHTML = opts;
  } catch {}
}

$('vendorSel').onchange = (e) => {
  state.vendor = e.target.value;
  if (state.vendor !== 'ALL')
    toast(`Writes now target vendor ${state.vendor} (grid still shows all rules).`, 'warn');
};

// ---------- copy month ----------

$('copyMonthBtn').onclick = async () => {
  if (!state.entry || !state.entry.cells.size) {
    toast('Nothing to copy in this month.', 'warn');
    return;
  }
  let m = state.month + 1, y = state.year;
  if (m > 12) { m = 1; y++; }
  const raw = await inputBox(
    `Copy ${MONTHS[state.month - 1]} ${state.year} (${state.entry.cells.size} cells) to month (MM.YYYY):`,
    `${String(m).padStart(2, '0')}.${y}`
  );
  if (!raw) return;
  const mt = /^(\d{1,2})[./-](\d{4})$/.exec(raw.trim());
  if (!mt) { toast('Use the format MM.YYYY', 'error'); return; }
  const tm = Number(mt[1]), ty = Number(mt[2]);
  if (tm < 1 || tm > 12) { toast('Invalid month.', 'error'); return; }
  if (tm === state.month && ty === state.year) { toast('Target equals source.', 'error'); return; }
  if (state.staged.size && !(await confirmBox('Discard currently staged changes?'))) return;
  state.staged.clear();
  state.pendingCopy = {
    targetKey: `${state.station}:${ty}:${tm}`,
    cells: [...state.entry.cells.values()].map((c) => ({ day: c.day, dur: c.dur, pct: c.pct })),
    fromLabel: `${MONTHS_SHORT[state.month - 1]} ${state.year}`,
  };
  state.month = tm;
  state.year = ty;
  loadGrid();
};

// ---------- rentalcars top-10 analysis (runs ONLY on explicit icon click) ----------

let rcCtx = null;

function openRcAnalysis(day, dur) {
  rcCtx = { day, dur: dur || 3 };
  $('rcTitle').textContent = `RENTALCARS TOP 10 — ${String(day).padStart(2, '0')} ${MONTHS_SHORT[state.month - 1]} ${state.year} · ${stationName().toUpperCase()}`;
  $('rcModal').classList.remove('hidden');
  renderRcDurs();
  runRcAnalysis();
}

function renderRcDurs() {
  $('rcDurs').innerHTML = state.durations
    .map((d) => `<button class="rc-dur ${rcCtx.dur === d ? 'on' : ''}" onclick="setRcDur(${d})">${d >= 6 ? '6+' : d} DAYS</button>`)
    .join('');
}

function setRcDur(d) {
  rcCtx.dur = d;
  renderRcDurs();
  runRcAnalysis();
}
window.setRcDur = setRcDur;

function logoImg(x) {
  return x.logo
    ? `<img class="rc-logo" src="${esc(x.logo)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : '';
}

async function runRcAnalysis() {
  const [hh, mm] = nextRcTime();
  rcCtx.hh = hh;
  rcCtx.mm = mm;
  rcCtx.placed = null;
  $('rcBody').innerHTML = '<div class="rc-loading">QUERYING RENTALCARS…</div>';
  $('rcMeta').textContent = '';
  $('rcOpen').href = rentalcarsUrl(rcCtx.day, rcCtx.dur, hh, mm) || '#';
  try {
    const r = await api(
      `/api/rc-top?station=${state.station}&year=${state.year}&month=${state.month}&day=${rcCtx.day}&duration=${rcCtx.dur}&hh=${hh}&mm=${mm}`
    );
    rcCtx.data = r;
    renderRcTable();
  } catch (e) {
    $('rcBody').innerHTML = `<div class="drawer-empty">Query failed: ${esc(e.message)} — use OPEN ON RENTALCARS instead.</div>`;
  }
}

/**
 * Re-rank simulation: click any competitor row to place Green Motion just
 * ahead of it. The needed FMX % is derived from the current rule:
 *   base = gmPrice / (1 + currentPct/100);  newPct = (target/base - 1) * 100
 */
function renderRcTable() {
  const r = rcCtx.data;
  if (!r || !r.top.length) {
    $('rcBody').innerHTML = '<div class="drawer-empty">No offers returned for these dates.</div>';
    return;
  }
  const durLabel = rcCtx.dur >= 6 ? '6+' : rcCtx.dur;
  const others = r.top.filter((x) => !/green motion/i.test(x.supplier));
  const sim = rcCtx.placed; // {rank, target, newPct, curPct}

  let displayRows;
  if (sim) {
    displayRows = others.slice();
    displayRows.splice(sim.rank - 1, 0, {
      supplier: 'Green Motion', vehicle: 'SIMULATED POSITION', rating: null,
      price: sim.target, currency: r.currency, gm: true, simulated: true,
      logo: (r.top.find((x) => /green motion/i.test(x.supplier)) || {}).logo,
    });
    displayRows = displayRows.slice(0, 11);
  } else {
    displayRows = r.top.slice(0, 10);
  }

  const rows = displayRows
    .map((x, i) => {
      const isGm = x.gm || /green motion/i.test(x.supplier);
      const clickable = !isGm && r.gmPrice != null;
      return `<tr class="${isGm ? 'rc-gm' : ''} ${x.simulated ? 'rc-sim' : ''} ${clickable ? 'rc-clickable' : ''}"
        ${clickable ? `onclick="placeGm(${i})" title="Place Green Motion just ahead of this row"` : ''}>
        <td class="rc-rank">${i + 1}</td>
        <td class="rc-sup">${logoImg(x)}${esc(x.supplier)}${x.simulated ? ' <span class="rc-sim-tag">TARGET</span>' : ''}</td>
        <td>${esc(x.vehicle)}</td>
        <td>${x.rating != null ? x.rating.toFixed(1) : '—'}</td>
        <td class="rc-price">${x.price.toFixed(2)} ${esc(x.currency)}</td>
      </tr>`;
    })
    .join('');

  const cell = state.cellMap.get(key(rcCtx.day, rcCtx.dur));
  const curPct = cell ? cell.pct : 0;

  let simBar = '';
  if (sim) {
    simBar = `<div class="rc-simbar">
      <span>GM #${r.gmRank || '—'} &rarr; <b>#${sim.rank}</b> · ${r.gmPrice.toFixed(2)} &rarr; <b>${sim.target.toFixed(2)} ${r.currency}</b>
      · FMX RULE ${durLabel}D: ${curPct}% &rarr; <b>${sim.newPct}%</b>${cell ? '' : ' (new rule)'}</span>
      <span class="rc-simbar-btns">
        <button class="btn btn-ghost btn-xs" onclick="resetGmSim()">RESET</button>
        <button class="btn btn-primary btn-xs" id="rcConfirmBtn" onclick="confirmGmSim()">CONFIRM &rarr; FMX</button>
      </span>
    </div>`;
  } else if (r.gmPrice != null) {
    simBar = `<div class="rc-hint">Click a competitor row to place Green Motion just ahead of it — the FMX rule change is computed automatically.</div>`;
  }

  $('rcBody').innerHTML = `<table class="rc-table">
    <thead><tr><th></th><th>SUPPLIER</th><th>VEHICLE</th><th>RATING</th><th class="rc-price">TOTAL ${durLabel}D</th></tr></thead>
    <tbody>${rows}</tbody></table>${simBar}`;

  $('rcMeta').textContent =
    `${r.total} OFFERS · PICKUP ${rcCtx.hh}:${String(rcCtx.mm).padStart(2, '0')}` +
    (r.cachedAt ? ' · CACHED' : '') +
    (r.gmRank ? ` · GM RANK #${r.gmRank} (${r.gmPrice.toFixed(2)} ${r.currency})` : ' · GM NOT LISTED');
}

function placeGm(rowIndex) {
  const r = rcCtx.data;
  if (!r || r.gmPrice == null) return;
  const others = r.top.filter((x) => !/green motion/i.test(x.supplier));
  const targetRank = Math.min(rowIndex + 1, others.length + 1);
  const hi = others[targetRank - 1] ? others[targetRank - 1].price : null; // row GM goes ahead of
  const lo = others[targetRank - 2] ? others[targetRank - 2].price : 0;
  let target;
  if (hi == null) target = lo * 1.02; // placed last
  else {
    target = hi - Math.max(0.01, hi * 0.005); // just under that competitor
    if (target <= lo) target = (lo + hi) / 2; // tight gap: midpoint
  }
  const cell = state.cellMap.get(key(rcCtx.day, rcCtx.dur));
  const curPct = cell ? cell.pct : 0;
  const base = r.gmPrice / (1 + curPct / 100);
  let newPct = (target / base - 1) * 100;
  newPct = Math.max(-95, Math.min(100, Math.round(newPct * 100) / 100));
  rcCtx.placed = { rank: targetRank, target, newPct, curPct };
  renderRcTable();
}
window.placeGm = placeGm;

function resetGmSim() {
  rcCtx.placed = null;
  renderRcTable();
}
window.resetGmSim = resetGmSim;

async function confirmGmSim() {
  const sim = rcCtx.placed;
  const r = rcCtx.data;
  if (!sim || !r) return;
  const btn = $('rcConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'APPLYING…';
  const cell = state.cellMap.get(key(rcCtx.day, rcCtx.dur));
  const body = {
    station: state.station, day: rcCtx.day, duration: rcCtx.dur,
    month: state.month, year: state.year, pct: sim.newPct,
    active: true, vendors: [state.vendor],
  };
  try {
    let result;
    if (cell) {
      result = await api(`/api/rule/${cell.ruleid}`, { method: 'PUT', body: { ...body, prevPct: cell.pct } });
      state.cellMap.set(key(rcCtx.day, rcCtx.dur), { ...cell, pct: sim.newPct });
    } else {
      result = await api('/api/rule', { method: 'POST', body });
      state.cellMap.set(key(rcCtx.day, rcCtx.dur), {
        day: rcCtx.day, dur: rcCtx.dur, ruleid: result.ruleid,
        name: result.detail.rulename, pct: sim.newPct, active: true,
        op: rcCtx.dur >= 6 ? '>=' : '=', opMismatch: false, vendors: [state.vendor], updated: '',
      });
    }
    refreshCell(rcCtx.day, rcCtx.dur);
    toast(
      `FMX updated: ${String(rcCtx.day).padStart(2, '0')}.${state.month} · ${rcCtx.dur}D → ${sim.newPct}%` +
      (result.verified === false ? ' (verification mismatch!)' : ' ✓ verified') +
      '. rentalcars will show it after their next cache refresh.'
    , result.verified === false ? 'warn' : undefined);
    rcCtx.placed = null;
    renderRcTable();
    refreshLogs();
  } catch (e) {
    toast('Apply failed: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'CONFIRM → FMX';
  }
}
window.confirmGmSim = confirmGmSim;

$('rcClose').onclick = () => $('rcModal').classList.add('hidden');
$('rcModal').addEventListener('click', (e) => {
  if (e.target === $('rcModal')) $('rcModal').classList.add('hidden');
});

// ---------- dashboard market-rank sweep (whole month, streamed & cached) ----------

const rcMonth = { dur: 3, days: new Map(), pending: [], es: null, loadedKey: null };

function rankKey() {
  return `${state.station}:${state.year}:${state.month}:${rcMonth.dur}`;
}

function startRcMonth(force) {
  if (!state.session) return;
  if (!force && rcMonth.loadedKey === rankKey() && rcMonth.days.size) {
    renderRankStrip();
    return;
  }
  if (rcMonth.es) { rcMonth.es.close(); rcMonth.es = null; }
  rcMonth.days = new Map();
  rcMonth.pending = [];
  rcMonth.loadedKey = rankKey();
  $('rankMonth').textContent = `${MONTHS_SHORT[state.month - 1]} ${state.year} · ${stationName().toUpperCase()}`;
  renderRankDurs();
  renderRankStrip();

  const es = new EventSource(
    `/api/rc-month-stream?station=${state.station}&year=${state.year}&month=${state.month}&duration=${rcMonth.dur}`
  );
  rcMonth.es = es;
  es.addEventListener('meta', (ev) => {
    const m = JSON.parse(ev.data);
    rcMonth.pending = m.days.slice();
    renderRankStrip();
  });
  es.addEventListener('day', (ev) => {
    const d = JSON.parse(ev.data);
    rcMonth.pending = rcMonth.pending.filter((x) => x !== d.day);
    rcMonth.days.set(d.day, d);
    renderRankStrip();
  });
  es.addEventListener('done', () => { es.close(); if (rcMonth.es === es) rcMonth.es = null; });
  es.onerror = () => { es.close(); if (rcMonth.es === es) rcMonth.es = null; };
}

function renderRankDurs() {
  $('rankDurs').innerHTML = state.durations
    .map((d) => `<button class="rc-dur ${rcMonth.dur === d ? 'on' : ''}" onclick="setRankDur(${d})">${d >= 6 ? '6+' : d}D</button>`)
    .join('');
}

function setRankDur(d) {
  rcMonth.dur = d;
  startRcMonth(true);
}
window.setRankDur = setRankDur;

function rankClass(rank) {
  if (rank == null) return 'rank-none';
  if (rank <= 3) return 'rank-good';
  if (rank <= 7) return 'rank-mid';
  return 'rank-bad';
}

function renderRankStrip() {
  const wrap = $('rankStrip');
  const all = [...rcMonth.pending, ...rcMonth.days.keys()];
  if (!all.length) {
    wrap.innerHTML = '<div class="drawer-empty">No searchable days in this month (past dates cannot be queried).</div>';
    return;
  }
  const days = [...new Set(all)].sort((a, b) => a - b);
  wrap.innerHTML = days
    .map((day) => {
      const d = rcMonth.days.get(day);
      if (!d) {
        return `<div class="rank-cell rank-pending"><span class="rank-day">${String(day).padStart(2, '0')}</span><span class="rank-num">…</span></div>`;
      }
      if (d.error || d.rank == null) {
        return `<div class="rank-cell rank-none" onclick="openRcAnalysis(${day}, ${rcMonth.dur})" title="${esc(d.error || 'Green Motion not listed')}"><span class="rank-day">${String(day).padStart(2, '0')}</span><span class="rank-num">—</span></div>`;
      }
      return `<div class="rank-cell ${rankClass(d.rank)}" onclick="openRcAnalysis(${day}, ${rcMonth.dur})"
        title="GM #${d.rank} of ${d.total} · ${d.price.toFixed(2)} ${d.currency}${d.top1 ? ' · #1 ' + esc(d.top1.supplier) + ' ' + d.top1.price.toFixed(2) : ''}">
        <span class="rank-day">${String(day).padStart(2, '0')}</span>
        <span class="rank-num">#${d.rank}</span>
        <span class="rank-price">${Math.round(d.price)}</span>
      </div>`;
    })
    .join('');
}

$('rankRefresh').onclick = () => startRcMonth(true);

// ---------- boot ----------

(async function init() {
  const meta = await api('/api/stations');
  state.stations = meta.stations;
  state.durations = meta.durations;
  state.station = meta.stations[0].id;
  renderStations();
  $('monthLabel').textContent = `${MONTHS[state.month - 1]} ${state.year}`;

  const h = location.hash.replace('#', '');
  showView(['dashboard', 'grid', 'analytics', 'activity'].includes(h) ? h : 'dashboard');

  const s = await api('/api/session?check=1').catch(() => ({ ok: false }));
  setSession(!!s.ok);
  if (s.ok) {
    loadVendors();
    await loadGrid();
    renderDashboard();
    if (state.view === 'dashboard') startRcMonth();
  } else {
    openSessionModal('');
  }
})();
