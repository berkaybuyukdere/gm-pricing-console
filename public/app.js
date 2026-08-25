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

function rentalcarsUrl(day, dur) {
  const cfg = RC_LOCATIONS[state.station];
  if (!cfg) return null;
  const [hh, mm] = nextRcTime();
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
    await loadGrid();
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

  const W = 268, H = 150, L = 28, R = 26, T = 6, B = 16;
  const x = (d) => L + ((d - 1) * (W - L - R)) / Math.max(days - 1, 1);
  const y = (v) => T + ((vMax - v) * (H - T - B)) / (vMax - vMin || 1);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price change per day and rental duration">`;
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const v = vMax - ((vMax - vMin) * i) / gridSteps;
    svg += `<line class="chart-grid-line" x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}"/>`;
    svg += `<text class="chart-axis-label" x="${L - 3}" y="${y(v) + 2.5}" text-anchor="end">${Math.round(v)}</text>`;
  }
  for (let d = 1; d <= days; d += days > 20 ? 5 : 2) {
    svg += `<text class="chart-axis-label" x="${x(d)}" y="${H - 4}" text-anchor="middle">${d}</text>`;
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
  svg += '</svg>';

  wrap.innerHTML = svg + '<div class="chart-tip" id="chartTip"></div>';

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

  // sidebar stats
  const cells = [...e.cells.values()];
  const activeCells = cells.filter((c) => c.active);
  const avg = activeCells.length
    ? (activeCells.reduce((a, c) => a + c.pct, 0) / activeCells.length).toFixed(1)
    : null;
  const conflictCount = [...e.conflictMap.values()].filter((v) => v.length > 1).length;
  $('sideStats').innerHTML = `
    <div class="stat-row"><span>TOTAL RULES</span><b>${e.totalRules}</b></div>
    <div class="stat-row"><span>GRID CELLS</span><b>${cells.length}</b></div>
    <div class="stat-row"><span>AVG CHANGE</span><b class="stat-accent">${avg != null ? avg + '%' : '—'}</b></div>
    <div class="stat-row"><span>INACTIVE</span><b>${cells.length - activeCells.length}</b></div>
    <div class="stat-row"><span>CONFLICTS</span><b class="${conflictCount ? 'stat-warn' : ''}">${conflictCount}</b></div>
    <div class="stat-row"><span>STAGED</span><b class="${state.staged.size ? 'stat-warn' : ''}">${state.staged.size}</b></div>`;
  scheduleChart();
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
    tdDay.innerHTML = `<div class="day-label" title="Click to fill entire row"><span>${String(day).padStart(2, '0')}<span class="day-dot" id="dayDot-${day}"></span></span><span class="dow">${DOW[dow]}</span></div>`;
    tdDay.onclick = () => fillRow(day);
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
          body: { station: state.station, day: ch.day, duration: ch.dur, month: state.month, year: state.year, pct: ch.pct, active: cell.active, prevPct: cell.pct },
        });
        state.cellMap.set(k, { ...cell, pct: ch.pct, op: ch.dur >= 6 ? '>=' : '=', opMismatch: false, vendors: ['ALL'] });
      } else {
        result = await api('/api/rule', {
          method: 'POST',
          body: { station: state.station, day: ch.day, duration: ch.dur, month: state.month, year: state.year, pct: ch.pct, active: true },
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

async function refreshLogs() {
  try {
    const { logs } = await (await fetch('/api/logs?limit=200')).json();
    const list = $('logsList');
    if (!logs.length) {
      list.innerHTML = '<div class="drawer-empty">No activity yet.</div>';
      return;
    }
    list.innerHTML = logs
      .map((l) => {
        const d = new Date(l.ts);
        const when = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const target = l.day
          ? `${String(l.day).padStart(2, '0')} ${MONTHS_SHORT[(l.month || 1) - 1]} ${l.year} · ${l.duration >= 6 ? l.duration + '+' : l.duration}D`
          : `#${l.ruleid || '—'}`;
        const fmt = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v + '%');
        const change = `<b>${fmt(l.before)}</b> &rarr; <b>${fmt(l.after)}</b>`;
        const status = l.ok
          ? `<span class="log-status-ok">OK${l.verified === false ? ' (unverified)' : ''}</span>`
          : `<span class="log-status-err">FAILED ${esc(l.error || '')}</span>`;
        return `<div class="log-entry">
          <div class="log-line1"><span>${when} · ${esc(l.user || '')}</span><span>${esc(l.stationName || '')}${l.ruleid ? ' · #' + l.ruleid : ''}</span></div>
          <div class="log-line2"><span class="log-action ${l.action}">${l.action.toUpperCase()}</span><span class="log-target">${target}</span><span class="log-change">${change}</span>${status}</div>
        </div>`;
      })
      .join('');
  } catch {}
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('logsBtn').onclick = () => {
  $('logsDrawer').classList.toggle('open');
  if ($('logsDrawer').classList.contains('open')) refreshLogs();
};

$('logsClose').onclick = () => $('logsDrawer').classList.remove('open');

// ---------- boot ----------

(async function init() {
  const meta = await api('/api/stations');
  state.stations = meta.stations;
  state.durations = meta.durations;
  state.station = meta.stations[0].id;
  renderStations();
  $('monthLabel').textContent = `${MONTHS[state.month - 1]} ${state.year}`;

  const s = await api('/api/session?check=1').catch(() => ({ ok: false }));
  setSession(!!s.ok);
  if (s.ok) await loadGrid();
  else openSessionModal('');
})();
