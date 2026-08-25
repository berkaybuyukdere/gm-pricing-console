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
