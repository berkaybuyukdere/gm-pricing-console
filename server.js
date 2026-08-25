/**
 * GM Pricing Console - local server.
 * Serves the panel UI and proxies reads/writes to FuseMetrix DPS
 * using the session cookie the user pastes in.
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const { FmxClient, FmxError } = require('./lib/fmx');

const PORT = process.env.PORT || 4646;
const SESSION_FILE = path.join(__dirname, '.session');
const LOGS_FILE = path.join(__dirname, '.logs.json');

const STATIONS = [
  { id: 61489, name: 'Zurich Airport' },
  { id: 61551, name: 'Zurich Downtown' },
];
const DURATIONS = [2, 3, 4, 5, 6];

const fmx = new FmxClient();
if (fs.existsSync(SESSION_FILE)) {
  try {
    fmx.setCookie(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {}
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    const code = e instanceof FmxError ? e.code : 500;
    res.status(code).json({ error: e.message });
  });

// ---------- session ----------

app.get(
  '/api/session',
  wrap(async (req, res) => {
    if (!fmx.hasCookie()) return res.json({ ok: false });
    if (req.query.check === '1') {
      try {
        await fmx.getRules(STATIONS[0].id);
        return res.json({ ok: true });
      } catch (e) {
        return res.json({ ok: false, error: e.message });
      }
    }
    res.json({ ok: true, unchecked: true });
  })
);

app.post(
  '/api/login',
  wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) throw new FmxError('MISSING_CREDENTIALS', 400);
    await fmx.login(username, password); // throws LOGIN_FAILED / validates session
    fs.writeFileSync(SESSION_FILE, fmx.cookie, 'utf8'); // cookie only, never the password
    res.json({ ok: true });
  })
);

// keep the FMX session alive while the console is running
setInterval(() => fmx.keepAlive(), 4 * 60 * 1000);

// ---------- meta ----------

app.get('/api/stations', (req, res) =>
  res.json({ stations: STATIONS, durations: DURATIONS })
);

app.get(
  '/api/vendors',
  wrap(async (req, res) => {
    res.json({ vendors: await fmx.getVendors() });
  })
);

// ---------- rentalcars market data (user-initiated, plain public API GETs) ----------

const RC_SEARCH = {
  61489: { type: 'IATA', loc: 'ZRH', name: 'Zurich Airport' },
  61551: { type: 'LATLONG', loc: '47.37798309326172,8.539767265319824', name: 'Zurich Downtown' },
};

const RC_CACHE_FILE = path.join(__dirname, '.rc-cache.json');
let rcCache = {};
try {
  rcCache = JSON.parse(fs.readFileSync(RC_CACHE_FILE, 'utf8'));
} catch {}
let rcSaveTimer = null;
function saveRcCache() {
  clearTimeout(rcSaveTimer);
  rcSaveTimer = setTimeout(
    () => fs.writeFile(RC_CACHE_FILE, JSON.stringify(rcCache), () => {}),
    500
  );
}

async function rcQuery({ station, year, month, day, duration, hh, mm, ttlMs }) {
  const cfg = RC_SEARCH[station];
  if (!cfg) throw new FmxError('BAD_STATION', 400);
  const cacheKey = `${station}:${year}-${month}-${day}:${duration}`;
  const hit = rcCache[cacheKey];
  if (hit && Date.now() - hit.ts < ttlMs) return { ...hit.data, cachedAt: hit.ts };

  const pu = new Date(year, month - 1, day);
  const dr = new Date(pu.getTime() + duration * 86400000);
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${hh}:${mm}:00`;

  const sc = JSON.stringify({
    driversAge: 30,
    pickUpLocation: cfg.loc,
    pickUpDateTime: fmt(pu),
    pickUpLocationType: cfg.type,
    dropOffLocation: cfg.loc,
    dropOffLocationType: cfg.type,
    dropOffDateTime: fmt(dr),
    searchMetadata: '{}',
  });
  const fc = JSON.stringify({ sortBy: 'PRICE', sortAscending: true });
  const url = `https://www.rentalcars.com/api/search-results?searchCriteria=${encodeURIComponent(sc)}&filterCriteria=${encodeURIComponent(fc)}`;

  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'application/json',
    },
  });
  if (!r.ok) throw new FmxError('RC_HTTP_' + r.status, 502);
  const j = await r.json();

  const rows = (j.matches || [])
    .map((m) => {
      const depot = (j.depots || {})[m.route && m.route.pickUpDepotId] || {};
      const sup = (j.suppliers || {})[depot.supplierId] || {};
      const price =
        (m.vehicle && m.vehicle.driveAwayPrice && m.vehicle.driveAwayPrice.amount) ??
        (m.vehicle && m.vehicle.price && m.vehicle.price.amount);
      return {
        supplier: sup.name || '?',
        logo: sup.logoUrl ? 'https://cdn2.rcstatic.com' + sup.logoUrl : null,
        price: Number(price),
        currency: (m.vehicle && m.vehicle.price && m.vehicle.price.currency) || 'CHF',
        vehicle: (m.vehicle && m.vehicle.makeAndModel) || '',
        rating: depot.rating ? depot.rating.average : null,
      };
    })
    .filter((x) => isFinite(x.price))
    .sort((a, b) => a.price - b.price);

  const gmIdx = rows.findIndex((x) => /green motion/i.test(x.supplier));
  const data = {
    station: cfg.name,
    pickUp: fmt(pu),
    dropOff: fmt(dr),
    total: rows.length,
    top: rows.slice(0, 12),
    gmRank: gmIdx >= 0 ? gmIdx + 1 : null,
    gmPrice: gmIdx >= 0 ? rows[gmIdx].price : null,
    currency: rows[0] ? rows[0].currency : 'CHF',
  };
  rcCache[cacheKey] = { ts: Date.now(), data };
  saveRcCache();
  return data;
}

app.get(
  '/api/rc-top',
  wrap(async (req, res) => {
    const args = {
      station: Number(req.query.station),
      year: Number(req.query.year),
      month: Number(req.query.month),
      day: Number(req.query.day),
      duration: Number(req.query.duration),
      hh: String(req.query.hh || '19').padStart(2, '0'),
      mm: String(req.query.mm || '00').padStart(2, '0'),
      ttlMs: req.query.fresh === '1' ? 0 : 10 * 60 * 1000, // 10 min cache for repeat clicks
    };
    if (!args.year || !args.month || !args.day || !args.duration)
      throw new FmxError('BAD_PARAMS', 400);
    res.json(await rcQuery(args));
  })
);

// whole-month GM rank sweep, streamed day by day (6h cache per day)
app.get(
  '/api/rc-month-stream',
  wrap(async (req, res) => {
    const station = Number(req.query.station);
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    const duration = Number(req.query.duration) || 3;
    if (!RC_SEARCH[station] || !year || !month) throw new FmxError('BAD_PARAMS', 400);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

    const daysInMonth = new Date(year, month, 0).getDate();
    const now = new Date();
    const firstDay =
      year === now.getFullYear() && month === now.getMonth() + 1
        ? now.getDate()
        : new Date(year, month - 1, 1) < now
          ? daysInMonth + 1 // month entirely in the past: nothing searchable
          : 1;

    const days = [];
    for (let d = firstDay; d <= daysInMonth; d++) days.push(d);
    send('meta', { days, duration });

    const queue = days.slice();
    const workers = Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const day = queue.shift();
        try {
          const r = await rcQuery({
            station, year, month, day, duration,
            hh: '19', mm: '00', ttlMs: 6 * 60 * 60 * 1000,
          });
          const t1 = r.top[0] || null;
          send('day', {
            day,
            rank: r.gmRank,
            price: r.gmPrice,
            total: r.total,
            currency: r.currency,
            top1: t1 ? { supplier: t1.supplier, price: t1.price, logo: t1.logo } : null,
          });
        } catch (e) {
          send('day', { day, error: e.message });
        }
      }
    });
    await Promise.all(workers);
    send('done', {});
    res.end();
  })
);

// ---------- restore points (backups) ----------

const BACKUP_DIR = path.join(__dirname, '.backups');

const parseRuleDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2}) /.exec(s || '');
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
};

// map a station's rules+details to grid cells for one month
function shapeCells(rules, getDetail, year, month) {
  const cells = new Map(); // "day:dur" -> {day, dur, pct, active, ruleid, vendors}
  for (const r of rules) {
    const f = parseRuleDate(r.from);
    const t = parseRuleDate(r.to);
    if (!f || !t || f.y !== t.y || f.mo !== t.mo || f.d !== t.d) continue;
    if (f.y !== year || f.mo !== month) continue;
    const d = getDetail(r.ruleid);
    if (!d) continue;
    const dur = Number(d.numDays);
    const gridable =
      d.chkNumDays && DURATIONS.includes(dur) && d.priceType === 'percent' &&
      !d.chkWeekdays && !d.chkWeekdays2 && !d.chkPickupTime && !d.chkDropoffTime;
    if (!gridable) continue;
    const k = `${f.d}:${dur}`;
    if (!cells.has(k))
      cells.set(k, {
        day: f.d, dur, pct: Number(d.priceChange), active: d.active,
        ruleid: r.ruleid, vendors: d.vendors || ['ALL'],
      });
  }
  return cells;
}

async function fetchDetails(rules) {
  const details = {};
  const q = rules.slice();
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      while (q.length) {
        const r = q.shift();
        try {
          details[r.ruleid] = await fmx.getDetail(r.ruleid, r.updated);
        } catch (e) {
          if (e.code === 401) throw e;
        }
      }
    })
  );
  return details;
}

app.post(
  '/api/backup',
  wrap(async (req, res) => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const snap = { ts: new Date().toISOString(), stations: {} };
    for (const s of STATIONS) {
      const rules = await fmx.getRules(s.id);
      const details = await fetchDetails(rules);
      snap.stations[s.id] = { name: s.name, rules, details };
    }
    const file = 'backup-' + snap.ts.replace(/[:.]/g, '-') + '.json';
    fs.writeFileSync(path.join(BACKUP_DIR, file), JSON.stringify(snap));
    addLog({
      action: 'backup', station: null, stationName: 'ALL STATIONS',
      day: null, month: null, year: null, duration: null,
      before: null, after: null, ok: true, file,
    });
    res.json({
      ok: true, file,
      counts: Object.fromEntries(STATIONS.map((s) => [s.name, snap.stations[s.id].rules.length])),
    });
  })
);

app.get('/api/backups', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {}
  res.json({
    backups: files.map((f) => {
      try {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, size: st.size, ts: st.mtime.toISOString() };
      } catch {
        return { file: f };
      }
    }),
  });
});

app.post(
  '/api/restore',
  wrap(async (req, res) => {
    const { file, station, year, month, dryRun } = req.body;
    const snapPath = path.join(BACKUP_DIR, path.basename(String(file)));
    if (!fs.existsSync(snapPath)) throw new FmxError('BACKUP_NOT_FOUND', 404);
    if (!STATIONS.some((s) => s.id === Number(station)))
      throw new FmxError('BAD_STATION', 400);
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    const snapSt = snap.stations[station];
    if (!snapSt) throw new FmxError('STATION_NOT_IN_BACKUP', 400);

    const snapCells = shapeCells(snapSt.rules, (id) => snapSt.details[id], Number(year), Number(month));
    const curRules = await fmx.getRules(Number(station));
    const curDetails = await fetchDetails(curRules);
    const curCells = shapeCells(curRules, (id) => curDetails[id], Number(year), Number(month));

    const actions = [];
    for (const [k, s] of snapCells) {
      const c = curCells.get(k);
      if (!c) actions.push({ type: 'create', ...s, before: null });
      else if (c.pct !== s.pct || c.active !== s.active)
        actions.push({ type: 'update', ...s, ruleid: c.ruleid, before: c.pct });
    }
    for (const [k, c] of curCells) {
      if (!snapCells.has(k))
        actions.push({ type: 'delete', day: c.day, dur: c.dur, ruleid: c.ruleid, before: c.pct, pct: null });
    }

    if (dryRun) return res.json({ dryRun: true, actions });

    const results = [];
    for (const a of actions) {
      const args = {
        day: a.day, month: Number(month), year: Number(year),
        duration: a.dur, pct: a.pct, active: a.active !== false, vendors: a.vendors,
      };
      const base = {
        action: 'restore-' + a.type, station: Number(station),
        stationName: stationName(station), day: a.day, month: Number(month),
        year: Number(year), duration: a.dur, before: a.before ?? null,
        after: a.type === 'delete' ? null : a.pct,
      };
      try {
        if (a.type === 'create') {
          const r = await fmx.createRule(Number(station), args);
          addLog({ ...base, ruleid: r.ruleid, ok: true, verified: r.verified });
        } else if (a.type === 'update') {
          const r = await fmx.updateRule(Number(station), a.ruleid, args);
          addLog({ ...base, ruleid: a.ruleid, ok: true, verified: r.verified });
        } else {
          await fmx.deleteRule(Number(station), a.ruleid);
          addLog({ ...base, ruleid: a.ruleid, ok: true });
        }
        results.push({ ...a, ok: true });
      } catch (e) {
        addLog({ ...base, ruleid: a.ruleid, ok: false, error: e.message });
        results.push({ ...a, ok: false, error: e.message });
      }
    }
    res.json({ done: true, results });
  })
);

// ---------- activity log ----------

let activityLog = [];
try {
  activityLog = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
} catch {}

function addLog(entry) {
  activityLog.unshift({
    ts: new Date().toISOString(),
    user: fmx.username || 'session',
    ...entry,
  });
  if (activityLog.length > 1000) activityLog.length = 1000;
  fs.writeFile(LOGS_FILE, JSON.stringify(activityLog), () => {});
}

const stationName = (id) => {
  const s = STATIONS.find((x) => x.id === Number(id));
  return s ? s.name : String(id);
};

app.get('/api/logs', (req, res) =>
  res.json({ logs: activityLog.slice(0, Number(req.query.limit) || 200) })
);

// ---------- grid (streamed via SSE: cells appear as they resolve) ----------

app.get(
  '/api/grid/stream',
  wrap(async (req, res) => {
    const station = Number(req.query.station);
    const year = Number(req.query.year);
    const month = Number(req.query.month); // 1-12
    if (!STATIONS.some((s) => s.id === station))
      throw new FmxError('BAD_STATION', 400);
    if (!year || !month) throw new FmxError('BAD_DATE', 400);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (ev, data) =>
      res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      const rules = await fmx.getRules(station);
      const parseDate = (s) => {
        const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s || '');
        return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
      };

      // candidates: single-day rules whose day is inside the requested month
      const candidates = [];
      const others = [];
      for (const r of rules) {
        const f = parseDate(r.from);
        const t = parseDate(r.to);
        const sameDay = f && t && f.y === t.y && f.mo === t.mo && f.d === t.d;
        const inMonth = f && f.y === year && f.mo === month;
        const tInMonth = t && t.y === year && t.mo === month;
        if (sameDay && inMonth) candidates.push({ r, day: f.d });
        else if (inMonth || tInMonth)
          others.push({ ruleid: r.ruleid, name: r.name, from: r.from, to: r.to, active: r.active, note: 'date-range rule' });
      }

      send('meta', {
        totalRules: rules.length,
        pending: candidates.map((c) => ({ day: c.day, ruleid: c.r.ruleid })),
        others,
      });

      // details stream out as each one resolves; cached ones burst instantly
      const seen = new Map(); // "day:dur" -> [ruleids]
      const queue = candidates.slice();
      const workers = Array.from({ length: 10 }, async () => {
        while (queue.length) {
          const item = queue.shift();
          try {
            const detail = await fmx.getDetail(item.r.ruleid, item.r.updated);
            const dur = Number(detail.numDays);
            const gridable =
              detail.chkNumDays &&
              DURATIONS.includes(dur) &&
              detail.priceType === 'percent' &&
              !detail.chkWeekdays &&
              !detail.chkWeekdays2 &&
              !detail.chkPickupTime &&
              !detail.chkDropoffTime;
            if (!gridable) {
              send('skip', {
                day: item.day, ruleid: item.r.ruleid, name: item.r.name,
                from: item.r.from, to: item.r.to, active: item.r.active,
                note: 'not grid-shaped',
              });
              continue;
            }
            const k = `${item.day}:${dur}`;
            if (!seen.has(k)) seen.set(k, []);
            seen.get(k).push(item.r.ruleid);
            send('cell', {
              day: item.day,
              dur,
              ruleid: item.r.ruleid,
              name: detail.rulename,
              pct: Number(detail.priceChange),
              active: detail.active,
              op: detail.numDaysOp,
              opMismatch: detail.numDaysOp !== (dur >= 6 ? '>=' : '='),
              vendors: detail.vendors,
              updated: item.r.updated,
            });
          } catch (e) {
            if (e.code === 401) throw e;
            send('skip', {
              day: item.day, ruleid: item.r.ruleid, name: item.r.name, note: e.message,
            });
          }
        }
      });
      await Promise.all(workers);

      const conflicts = [...seen.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([k, ids]) => {
          const [day, dur] = k.split(':').map(Number);
          return { day, dur, ruleids: ids };
        });
      send('done', { keys: [...seen.keys()], conflicts });
    } catch (e) {
      send('fail', {
        error: e.message,
        code: e instanceof FmxError ? e.code : 500,
      });
    }
    res.end();
  })
);

// ---------- writes ----------

const ruleArgs = (body) => ({
  day: Number(body.day),
  month: Number(body.month),
  year: Number(body.year),
  duration: Number(body.duration),
  pct: Number(body.pct),
  active: body.active !== false,
  vendors:
    Array.isArray(body.vendors) && body.vendors.length
      ? body.vendors.map(String)
      : ['ALL'],
});

app.post(
  '/api/rule',
  wrap(async (req, res) => {
    const station = Number(req.body.station);
    const args = ruleArgs(req.body);
    if (!DURATIONS.includes(args.duration))
      throw new FmxError('BAD_DURATION', 400);
    if (!isFinite(args.pct)) throw new FmxError('BAD_PCT', 400);
    const base = {
      action: 'create', station, stationName: stationName(station),
      day: args.day, month: args.month, year: args.year,
      duration: args.duration, before: null, after: args.pct,
      vendor: args.vendors.join(','),
    };
    try {
      const result = await fmx.createRule(station, args);
      addLog({ ...base, ruleid: result.ruleid, ok: true, verified: result.verified });
      res.json(result);
    } catch (e) {
      addLog({ ...base, ok: false, error: e.message });
      throw e;
    }
  })
);

app.put(
  '/api/rule/:id',
  wrap(async (req, res) => {
    const station = Number(req.body.station);
    const ruleid = Number(req.params.id);
    const args = ruleArgs(req.body);
    if (!isFinite(args.pct)) throw new FmxError('BAD_PCT', 400);
    const before = req.body.prevPct != null ? Number(req.body.prevPct) : null;
    const base = {
      action: 'update', station, stationName: stationName(station),
      day: args.day, month: args.month, year: args.year,
      duration: args.duration, before, after: args.pct, ruleid,
      vendor: args.vendors.join(','),
    };
    try {
      const result = await fmx.updateRule(station, ruleid, args);
      addLog({ ...base, ok: true, verified: result.verified });
      res.json(result);
    } catch (e) {
      addLog({ ...base, ok: false, error: e.message });
      throw e;
    }
  })
);

app.delete(
  '/api/rule/:id',
  wrap(async (req, res) => {
    const station = Number(req.query.station);
    const q = req.query;
    const base = {
      action: 'delete', station, stationName: stationName(station),
      day: Number(q.day) || null, month: Number(q.month) || null,
      year: Number(q.year) || null, duration: Number(q.duration) || null,
      before: q.prevPct != null ? Number(q.prevPct) : null, after: null,
      ruleid: Number(req.params.id),
    };
    try {
      const result = await fmx.deleteRule(station, Number(req.params.id));
      addLog({ ...base, ok: true });
      res.json(result);
    } catch (e) {
      addLog({ ...base, ok: false, error: e.message });
      throw e;
    }
  })
);

app.listen(PORT, () => {
  console.log(`GM Pricing Console -> http://localhost:${PORT}`);
});
