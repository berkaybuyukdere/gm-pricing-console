/**
 * GM Pricing Console - local server.
 * Serves the panel UI and proxies reads/writes to FuseMetrix DPS
 * using the session cookie the user pastes in.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');
const { FmxClient, FmxError } = require('./lib/fmx');
const store = require('./lib/store');
const {
  RC_CAT_KEYS, setStationResolver, rcUrl, rcParse, rcFetch, rcIsGm, rcRowInCat,
  placesUrl, placesParse, placesFetch,
} = require('./lib/rc');

const PORT = process.env.PORT || 4646;

// 1..13 are exact rental lengths; 14 is the open bucket (NumDaysOp '>=' 14)
const OPEN_DURATION = 14;
const DURATIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, OPEN_DURATION];

// ---------- tenants (multi-franchise) ----------
// One durable store key holds every franchise: its name, its FuseMetrix host and
// its stations (each with the rentalcars location the market data is read from).
// Seeded on first boot from the values that used to be hardcoded here.

const DEFAULT_TENANT = 'gmzurich';
const TENANT_SEED = {
  gmzurich: {
    name: 'Green Motion Zürich',
    fmxBase: 'https://zrh.dps.greenmotion.com',
    stations: [
      {
        id: 61489,
        name: 'Zurich Airport',
        rc: { type: 'IATA', loc: 'ZRH', label: 'Zurich Airport' },
      },
      {
        id: 61551,
        name: 'Zurich Downtown',
        rc: {
          type: 'LATLONG',
          loc: '47.37798309326172,8.539767265319824',
          label: 'Main Railway Station Zurich',
        },
      },
    ],
  },
};

let tenants = JSON.parse(JSON.stringify(TENANT_SEED)); // replaced at boot by the store
// uid -> tenant id, filled by /api/auth/session from users/<uid>.tenant. The
// cookie payload is a fixed contract, so the mapping lives here instead (safe:
// the console function is pinned to a single instance).
const uidTenants = new Map();

const tenantIdOf = (req) => {
  // the signed cookie is authoritative: the in-memory map is empty after a cold
  // start, which would otherwise silently drop an operator into the default tenant
  const signed = req && req.operator && req.operator.tn;
  if (signed && tenants[signed]) return signed;
  const uid = req && req.operator && req.operator.uid;
  const id = uid ? uidTenants.get(uid) : null;
  return id && tenants[id] ? id : DEFAULT_TENANT;
};
const tenantOf = (idOrReq) => {
  const id = typeof idOrReq === 'string' ? idOrReq : tenantIdOf(idOrReq);
  return tenants[id] || tenants[DEFAULT_TENANT] || TENANT_SEED[DEFAULT_TENANT];
};
/** The active tenant's stations. Background jobs (watcher, auto-scan, backup)
 *  have no request context, so they run against the default tenant. */
const tenantStations = (idOrReq) => tenantOf(idOrReq).stations || [];
/** id -> the station's rentalcars location config, across every tenant. */
function stationRc(id) {
  for (const t of Object.values(tenants))
    for (const s of t.stations || []) if (s.id === Number(id)) return s.rc || null;
  return null;
}
// lib/rc.js only ever knows a station id — let it resolve through the registry
setStationResolver(stationRc);

// The canonical pickup hour. The grid, the watcher and the auto-scan all ask
// about this one hour so they can never disagree with the analysis modal's
// default view; the modal alone can step around the 09:00-19:00 ring, and it
// labels the hour it is showing. Changed from 19:00 on 2026-08-29.
const RC_HOUR = '09';

const fmx = new FmxClient();
// the shared FMX session belongs to exactly one franchise at a time — this is
// which one, so a station edit in another tenant cannot repoint it
let fmxTenant = DEFAULT_TENANT;
/** Point the shared FMX client at a tenant: its FuseMetrix host, and a station
 *  it actually owns for the post-login session check (a hardcoded one would
 *  fail for every franchise but Zurich, and after an admin removes it). */
function bindFmxTenant(idOrReq) {
  const id = typeof idOrReq === 'string' ? idOrReq : tenantIdOf(idOrReq);
  const t = tenantOf(id);
  fmxTenant = tenants[id] ? id : DEFAULT_TENANT;
  if (t.fmxBase) fmx.base = t.fmxBase;
  const first = (t.stations || [])[0];
  fmx.validateStation = first ? first.id : null;
}

// machine-to-machine secrets: the RC relay worker and the scheduler tick.
// Compared timing-safe; endpoints are disabled entirely when a secret is unset.
// Hoisted above the body parsers: /api/relay/result gates its big limit on them.
const RELAY_SECRET = process.env.RELAY_SECRET || null;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || null;
const safeEqual = (a, b) => {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const requireSecret = (req, res, secret, header) => {
  if (!secret || !safeEqual(req.headers[header], secret)) {
    res.status(secret ? 401 : 404).json({ error: secret ? 'BAD_SECRET' : 'DISABLED' });
    return false;
  }
  return true;
};

const app = express();
// raw relay bodies run ~1-2MB, so only /api/relay/result gets a large parser —
// and only after the relay secret checks out: an unauthenticated request must
// never make this single 512MiB instance buffer a 12MB body.
app.use('/api/relay/result', (req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0'); // the /api middleware runs later
  if (!requireSecret(req, res, RELAY_SECRET, 'x-relay-secret')) return;
  next();
});
app.use('/api/relay/result', express.json({ limit: '12mb' }));
app.use(express.json());
// no-cache, NOT max-age: without an explicit header the CDN stamped
// `public, max-age=300` on app.js, so every deploy left operators running the
// PREVIOUS console for up to 5 minutes (measured 2026-08-30: the served file
// was new while the executed one stayed old through two reloads). no-cache
// still allows storing — the ETag turns revalidation into a cheap 304 — but
// every reload provably runs the code that was just deployed.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res) { res.set('Cache-Control', 'no-cache'); },
}));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    const code = e instanceof FmxError ? e.code : 500;
    // a self-imposed 429 says WHEN to come back — that is what separates it
    // from Cloud Run's blind refusal, and it is what the client waits on
    if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
    res.status(code).json({
      error: e.message,
      ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}),
    });
  });

// ---------- operator auth ----------
// The console controls live pricing, so on a public deployment every API call
// must carry proof that this browser passed the Firebase sign-in. The proof is
// a stateless HMAC-signed cookie (no server-side session table needed); the
// FuseMetrix login is a SECOND step behind it, binding the shared FMX session.

// Firebase Auth is the app gate: the browser signs in with the client SDK and
// trades its ID token for the operator cookie at /api/auth/session.
if (!admin.apps.length) {
  try {
    // cloud: ADC. local: no credentials needed to verify an ID token's
    // signature, but the project must be known for the audience check.
    admin.initializeApp(
      store.IS_CLOUD
        ? undefined
        : {
            projectId:
              process.env.GOOGLE_CLOUD_PROJECT ||
              process.env.GCLOUD_PROJECT ||
              'sentinelpricing',
          }
    );
  } catch (e) {
    console.log('firebase-admin init failed:', e.message);
  }
}
const ROLES = ['admin', 'staff'];
const asRole = (r) => (ROLES.includes(r) ? r : 'staff');

// Resolved during boot: env var if set, otherwise (cloud) a secret persisted
// in Firestore — a random per-boot value would silently log every operator out
// on each cold start and never match across restarts.
let authSecret = process.env.AUTH_SECRET || null;
// single-session generation: every login bumps it, and a cookie carrying an
// older g is dead (SESSION_REPLACED) — resolved from the store during boot.
let authGen = 1;
const AUTH_TTL_MS = 12 * 60 * 60 * 1000;
// Firebase Hosting forwards exactly one cookie to a rewritten function —
// it must be called __session, so that is the operator cookie's name.
const COOKIE = '__session';

const b64u = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function signToken({ u, uid = null, role = 'staff', tn = null }) {
  const payload = b64u(
    JSON.stringify({ u, uid, role, tn, exp: Date.now() + AUTH_TTL_MS, g: authGen })
  );
  const sig = b64u(crypto.createHmac('sha256', authSecret).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!authSecret) return null;
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = b64u(crypto.createHmac('sha256', authSecret).update(payload).digest());
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    if (!data.exp || data.exp < Date.now()) return null;
    if (data.g !== authGen) return 'REPLACED'; // signed elsewhere since — dead cookie
    return data;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

const operatorOf = (req) => verifyToken(readCookie(req, COOKIE));
// cookies minted before roles existed carry no uid/role — they are plain staff
const operatorInfo = (op) => ({ u: op.u, uid: op.uid || null, role: asRole(op.role), tn: op.tn || null });

// every /api route except the Firebase handshake requires a valid operator
// cookie (/login included: FMX is the second step, behind the app gate);
// /relay/* and /internal/* authenticate with their own shared secret instead
app.use('/api', (req, res, next) => {
  // never let a CDN cache live pricing data or an auth handshake
  res.set('Cache-Control', 'no-store, max-age=0');
  if (req.path === '/session' || req.path === '/auth/session') return next();
  if (req.path.startsWith('/relay/') || req.path.startsWith('/internal/')) return next();
  // 'REPLACED' is a truthy string — it must never fall through to next()
  const op = operatorOf(req);
  if (op === 'REPLACED') return res.status(401).json({ error: 'SESSION_REPLACED' });
  if (op) {
    // disabling/deleting an account must take effect NOW, not when its 12h
    // operator cookie expires (the cookie is stateless, so this is the brake)
    if (op.uid && revokedUids.has(op.uid))
      return res.status(401).json({ error: 'ACCOUNT_DISABLED' });
    // role/franchise changed under this cookie: it still carries the OLD role,
    // so refuse it — the console re-mints one from the live Firebase session
    if (op.uid && staleUids.has(op.uid))
      return res.status(401).json({ error: 'NOT_SIGNED_IN' });
    req.operator = operatorInfo(op);
    return next();
  }
  res.status(401).json({ error: 'NOT_SIGNED_IN' });
});

// uids whose account was disabled or deleted through /api/users while their
// cookie was still alive. In-memory is enough: the console runs as a single
// instance, and a cold start re-reads the account state at the next sign-in.
const revokedUids = new Set();
// uids whose role or franchise changed while their cookie was alive — the
// signed cookie carries the old one, so it has to be re-minted before use
const staleUids = new Set();

/** Gate for the admin-only surfaces. Returns false after answering with 403.
 *  The role comes from the signed cookie only — never from the request body. */
function requireAdmin(req, res) {
  if (req.operator && req.operator.role === 'admin') return true;
  res.status(403).json({ error: 'FORBIDDEN' });
  return false;
}

// The seeded owner account may move users between franchises and see every
// tenant. The flag lives in Firestore (`users/<uid>.superadmin === true`), so
// like the role it can never be asserted by the browser.
const SEED_SUPERADMIN_UID = 'p7r1tSFsvuTcsc22MGruMjH6wh53';
const SUPERADMIN_TTL_MS = 5 * 60 * 1000;
const superadminCache = new Map(); // uid -> { at, val }
const noteSuperadmin = (uid, val) => {
  if (uid) superadminCache.set(uid, { at: Date.now(), val: !!val });
};

async function isSuperadmin(req) {
  const op = req.operator;
  if (!op || !op.uid || op.role !== 'admin') return false;
  const hit = superadminCache.get(op.uid);
  if (hit && Date.now() - hit.at < SUPERADMIN_TTL_MS) return hit.val;
  let val = false;
  try {
    const snap = await admin.firestore().collection('users').doc(op.uid).get();
    val = !!(snap.exists && snap.data().superadmin === true);
  } catch (e) {
    console.log('superadmin read failed:', e.message);
  }
  noteSuperadmin(op.uid, val);
  return val;
}

/** Gate for the franchise-owner surfaces. Answers 403 and returns false. */
async function requireSuperadmin(req, res) {
  if (!requireAdmin(req, res)) return false;
  if (await isSuperadmin(req)) return true;
  res.status(403).json({ error: 'FORBIDDEN' });
  return false;
}

// ---------- login rate limit ----------
// /api/login forwards credentials to FuseMetrix; without a brake a public URL
// invites brute-force (and could lock the real FMX account). In-memory is
// enough: the console function runs as a single instance (maxInstances: 1).

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_TRIES = 8;
const loginTries = new Map(); // ip -> [timestamps of failed attempts]

function loginLimited(ip) {
  const now = Date.now();
  const list = (loginTries.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  loginTries.set(ip, list);
  return list.length >= LOGIN_MAX_TRIES;
}
const loginFailed = (ip) => loginTries.get(ip).push(Date.now());
const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();

// ---------- session ----------

app.get(
  '/api/session',
  wrap(async (req, res) => {
    const op = operatorOf(req);
    // replaced cookies must short-circuit before the check branch can touch FMX
    if (op === 'REPLACED') return res.json({ ok: false, replaced: true });
    if (!op) return res.json({ ok: false });
    const info = operatorInfo(op);
    // who is signed in travels with every answer: the FMX step below is second,
    // so the client needs the role even while `ok` is still false
    const who = { user: info.u, email: info.u, role: info.role };
    if (!fmx.hasCookie()) return res.json({ ok: false, ...who });
    if (req.query.check === '1') {
      const first = tenantStations(tenantIdOf({ operator: info }))[0];
      try {
        if (first) await fmx.getRules(first.id);
        return res.json({ ok: true, ...who });
      } catch (e) {
        return res.json({ ok: false, error: e.message, ...who });
      }
    }
    res.json({ ok: true, unchecked: true, ...who });
  })
);

// Firebase sign-in -> operator cookie. The only unauthenticated write surface,
// so it shares /api/login's per-IP brake.
app.post(
  '/api/auth/session',
  wrap(async (req, res) => {
    const idToken = String((req.body && req.body.idToken) || '');
    if (!idToken) throw new FmxError('MISSING_ID_TOKEN', 400);
    const ip = clientIp(req);
    if (loginLimited(ip)) throw new FmxError('TOO_MANY_ATTEMPTS', 429);
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      loginFailed(ip); // loginLimited() above always seeds the ip's list
      throw new FmxError('BAD_ID_TOKEN', 401);
    }
    loginTries.delete(ip);
    // the mirrored profile is authoritative: PATCH /api/users writes it
    // synchronously, while a custom claim only reaches the client on its NEXT
    // token refresh — trusting the claim would let a demoted admin replay a
    // pre-demotion ID token and get their admin cookie back
    // (and the only place the operator's franchise is recorded)
    let role = null; // resolved from the profile below; claim is the fallback
    let tenant = null;
    try {
      const snap = await admin.firestore().collection('users').doc(decoded.uid).get();
      const d = (snap.exists && snap.data()) || {};
      if (ROLES.includes(d.role)) role = d.role;
      if (d.tenant) tenant = String(d.tenant);
      noteSuperadmin(decoded.uid, d.superadmin === true);
    } catch (e) {
      console.log('user profile read failed:', e.message); // claim-only sign-in
    }
    // no profile row (or an unreadable one): fall back to the signed claim
    if (!role && ROLES.includes(decoded.role)) role = decoded.role;
    role = asRole(role);
    const email = decoded.email || decoded.uid;
    // an ID token minted before the account was disabled still verifies, so a
    // revoked uid has to be checked against Firebase before it gets a cookie
    if (revokedUids.has(decoded.uid)) {
      let disabled = true;
      try {
        disabled = (await admin.auth().getUser(decoded.uid)).disabled === true;
      } catch (e) {
        console.log('disabled-check failed:', e.message); // stay locked out
      }
      if (disabled) throw new FmxError('ACCOUNT_DISABLED', 403);
      revokedUids.delete(decoded.uid);
    }
    // a role/tenant change lands in the fresh cookie minted right here
    staleUids.delete(decoded.uid);
    uidTenants.set(decoded.uid, tenant && tenants[tenant] ? tenant : DEFAULT_TENANT);
    res.cookie(COOKIE, signToken({ u: email, uid: decoded.uid, role, tn: uidTenants.get(decoded.uid) }), {
      httpOnly: true,
      sameSite: 'lax',
      secure: store.IS_CLOUD,
      maxAge: AUTH_TTL_MS,
      path: '/',
    });
    res.json({ ok: true, email, role });
  })
);

/** Pull the station list out of FuseMetrix itself and fold any station the
 *  registry has never seen into the active tenant. FMX is the source of truth
 *  for WHICH stations exist; the registry only adds what FMX cannot know (the
 *  rentalcars location) — so existing entries are never overwritten, and a new
 *  one arrives without a market mapping until an admin sets it in Settings. */
let lastStationSync = 0; // daily refresh stamp for the tick

async function syncStationsFromFmx(reason) {
  try {
    const found = await fmx.getStations();
    const t = tenants[fmxTenant];
    if (!t || !Array.isArray(t.stations)) return;
    const known = new Set(t.stations.map((x) => Number(x.id)));
    const added = [];
    for (const st of found) {
      if (known.has(Number(st.id))) continue;
      t.stations.push({ id: Number(st.id), name: st.name, rc: null });
      added.push(`${st.id} ${st.name}`);
    }
    if (added.length) {
      await store.setNow('tenants', tenants);
      addLog({
        action: 'stations-sync', station: null, stationName: 'FMX',
        day: null, month: null, year: null, duration: null,
        before: null, after: null, ok: true,
        file: `${added.length} yeni istasyon (${reason}): ${added.join(', ').slice(0, 180)}`,
      });
    }
  } catch (e) {
    console.log('station sync failed:', e.message);
  }
}

app.post(
  '/api/login',
  wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) throw new FmxError('MISSING_CREDENTIALS', 400);
    const ip = clientIp(req);
    if (loginLimited(ip)) throw new FmxError('TOO_MANY_ATTEMPTS', 429);
    // the FMX session belongs to whoever signs in: bind host + validation
    // station to that operator's franchise before the handshake
    bindFmxTenant(req);
    try {
      await fmx.login(username, password); // throws LOGIN_FAILED / validates session
    } catch (e) {
      loginFailed(ip); // loginLimited() above always seeds the ip's list
      throw e;
    }
    loginTries.delete(ip);
    store.set('session', fmx.cookie, { immediate: true }); // cookie only, never the password
    // FMX knows which stations exist — fold new ones in while the session is
    // fresh (fire-and-forget: login must not wait on a second FMX page)
    syncStationsFromFmx('login').catch(() => {});
    // single-session takeover: bump the generation so every older cookie dies.
    // A lost persist would revert gen on a cold start (spuriously replacing the
    // newest cookie — re-login heals it), so at least make the failure visible.
    authGen += 1;
    store.setNow('auth', { gen: authGen }).catch((e) =>
      console.log('authGen persist failed:', e.message)
    );
    // the bumped generation kills this browser's cookie too, so re-issue it —
    // with the Firebase identity it already carries, not the FMX username
    res.cookie(COOKIE, signToken(req.operator), {
      httpOnly: true,
      sameSite: 'lax',
      secure: store.IS_CLOUD,
      maxAge: AUTH_TTL_MS,
      path: '/',
    });
    res.json({ ok: true });
  })
);

// runtime diagnostics — confirms which persistence backend is actually live
app.get(
  '/api/diag',
  wrap(async (req, res) => {
    let durable = 'unknown';
    try {
      watchBase.__probe = new Date().toISOString();
      await store.setNow('watch', watchBase);
      delete watchBase.__probe;
      durable = 'ok';
    } catch (e) {
      durable = 'FAILED: ' + e.message;
    }
    res.json({
      cloud: store.IS_CLOUD,
      runtime: process.env.RUNTIME || null,
      kService: process.env.K_SERVICE || null,
      durableWrite: durable,
      fmxSession: fmx.hasCookie(),
      logs: activityLog.length,
      mail: !!mailer,
    });
  })
);

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

// keep the FMX session alive while the console is running.
// Local runs use a plain interval; in the cloud a min-instances-0 function has
// no reliable timers, so Cloud Scheduler drives /api/internal/tick instead.
if (!store.IS_CLOUD) setInterval(() => fmx.keepAlive(), 4 * 60 * 1000);

// the function itself is killed at 300s (index.js), and the hourly slot runs the
// watcher sweep AND an auto-scan slice, so both stages share ONE budget. Any
// deadline check can still be overshot by a single relay-served rc query, so
// each stage is told to stop RELAY_MAX_MS before the wall.
const TICK_RUN_MS = 270 * 1000;
const RELAY_MAX_MS = 95 * 1000;

// scheduler-driven heartbeat: FMX keep-alive + the hourly market watch.
// Hitting this endpoint also keeps the single console instance warm, which is
// what lets the relay long-poll and the /tmp caches survive between visits.
app.post(
  '/api/internal/tick',
  wrap(async (req, res) => {
    if (!requireSecret(req, res, INTERNAL_SECRET, 'x-internal-secret')) return;
    const tickDeadline = Date.now() + TICK_RUN_MS;
    await fmx.keepAlive();
    let ranWatcher = false;
    let ranScan = false;
    const last = Date.parse(WATCH.lastRun || 0) || 0;
    if (WATCH.enabled && Date.now() - last >= WATCH.intervalMin * 60 * 1000 - 30000) {
      await runWatcher(tickDeadline - RELAY_MAX_MS);
      ranWatcher = true;
      // same hourly slot: one budgeted slice of the auto-scan horizon, capped by
      // whatever the watcher left of the shared budget
      ranScan = await autoScan(tickDeadline - RELAY_MAX_MS - Date.now());
    }
    // stations can appear in FMX at any time — refresh the registry once a day
    // so they show up without waiting for someone to re-login
    if (fmx.hasCookie() && Date.now() - lastStationSync > 24 * 60 * 60 * 1000) {
      lastStationSync = Date.now();
      syncStationsFromFmx('tick').catch(() => {});
    }
    // every tick (not just the hourly watcher/auto-scan slot): pick a lost
    // bulk sweep back up. Runs on the leftover budget so a normal 4-min tick
    // (which skips the hourly block above) gives it nearly the full window.
    const resumedBulk = await resumeBulkJobIfLost(tickDeadline);
    pruneWorkers();
    res.json({
      ok: true, ranWatcher, ranScan, resumedBulk, relayOnline: relayOnline(),
      workers: relayState.workers.size, fmxSession: fmx.hasCookie(),
    });
  })
);

// ---------- mail (SMTP config from local .secrets.json, never committed) ----------

const SECRETS_FILE = path.join(__dirname, '.secrets.json');
let smtpCfg = null;
let mailer = null;
try {
  // cloud: SMTP_* env vars — local: .secrets.json (never committed)
  if (process.env.SMTP_HOST) {
    smtpCfg = {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: process.env.SMTP_TO || process.env.SMTP_USER,
    };
  } else {
    smtpCfg = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')).smtp;
  }
  mailer = nodemailer.createTransport({
    host: smtpCfg.host,
    port: smtpCfg.port,
    secure: false, // STARTTLS
    requireTLS: true,
    auth: { user: smtpCfg.user, pass: smtpCfg.pass },
  });
} catch {
  console.log('No .secrets.json — mail alerts disabled.');
}

// Plain, light, mobile-friendly HTML email in Turkish (inline styles only,
// email-client safe). `intro` is a short plain-Turkish sentence explaining what
// happened and what to do; sections may pass `note` for a one-line explanation
// under their table. Cell strings may carry inline <span> color markup from the
// mailUp/mailDown helpers below (green = GM lehine, red = tehdit — subtle).
const MAIL_GREEN = '#1a9d6a';
const MAIL_ORANGE = '#b7791f';
const MAIL_RED = '#d64545';
const MAIL_FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const mailUp = (s) => `<span style="color:${MAIL_GREEN};font-weight:600;">${s}</span>`;
const mailDown = (s) => `<span style="color:${MAIL_RED};font-weight:600;">${s}</span>`;
const mailWarn = (s) => `<span style="color:${MAIL_ORANGE};font-weight:600;">${s}</span>`;

// public base URL of the console — used by mails that must link back to a route
// (the one-click proposal approval page). req.protocol is meaningless here.
const consoleBase = () =>
  String(process.env.CONSOLE_URL || 'https://sentinelpricing.web.app').replace(/\/+$/, '');

// `extra` is optional raw HTML rendered between the tables and the standard
// "Konsolu aç" button (the auto-scan mail puts its approval button there).
function alertMailHtml(title, sections, intro, extra) {
  const row = (cells, header) =>
    `<tr>${cells
      .map(
        (c, i) =>
          `<t${header ? 'h' : 'd'} style="padding:8px 10px;border-bottom:1px solid #e6e8eb;font-size:14px;line-height:1.45;color:${header ? '#6b7280' : '#1f2933'};text-align:left;vertical-align:top;${header ? 'font-weight:600;text-transform:uppercase;letter-spacing:.4px;font-size:12px;' : 'font-weight:normal;'}${i === 0 && !header ? 'color:#52606d;white-space:nowrap;' : ''}">${c}</t${header ? 'h' : 'd'}>`
      )
      .join('')}</tr>`;
  const secHtml = sections
    .map(
      (s) => `
      <div style="margin:24px 0 8px;font-size:14px;font-weight:600;color:#1a9d6a;">${s.title}</div>
      <table style="border-collapse:collapse;width:100%;border:1px solid #e6e8eb;border-radius:6px;">
        ${row(s.header, true)}
        ${s.rows.map((r) => row(r)).join('')}
      </table>
      ${s.note ? `<div style="margin-top:6px;font-size:12px;color:#7b8794;line-height:1.5;">${s.note}</div>` : ''}`
    )
    .join('');
  return `
  <div style="background:#f4f5f7;padding:20px 12px;font-family:${MAIL_FONT};">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e6e8eb;border-radius:8px;padding:22px 20px;">
      <div>
        <span style="display:inline-block;width:9px;height:9px;background:${MAIL_GREEN};border-radius:50%;margin-right:8px;vertical-align:middle;"></span>
        <span style="font-size:15px;font-weight:700;color:#1f2933;vertical-align:middle;">Pricing Console</span>
        <span style="font-size:12px;color:#9aa5b1;vertical-align:middle;"> &nbsp;GM Zürih · Pazar takibi</span>
      </div>
      <div style="margin-top:14px;font-size:17px;font-weight:700;color:#1f2933;line-height:1.35;">${title}</div>
      ${intro ? `<div style="margin-top:8px;font-size:14px;line-height:1.6;color:#52606d;">${intro}</div>` : ''}
      ${secHtml}
      ${extra || ''}
      <div style="margin-top:24px;">
        <a href="https://sentinelpricing.web.app/console" style="display:inline-block;background:${MAIL_GREEN};color:#ffffff;font-size:14px;font-weight:600;padding:11px 20px;border-radius:6px;text-decoration:none;">Konsolu aç</a>
      </div>
      <div style="margin-top:22px;padding-top:12px;border-top:1px solid #e6e8eb;font-size:12px;color:#9aa5b1;line-height:1.5;">
        Otomatik bildirim · GM Pricing Console · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC
      </div>
    </div>
  </div>`;
}

// Alert recipients: every operator who put an address in Settings and did not
// turn their report mails off. Nobody configured (or everyone opted out with a
// different address) -> the deploy-time SMTP_TO default.
function mailRecipients() {
  const list = [];
  const off = new Set(); // addresses that explicitly said "no report mails"
  const dflt = ((smtpCfg && smtpCfg.to) || '').trim() || null;
  for (const p of Object.values(store.get('prefs', {}))) {
    if (!p || typeof p !== 'object') continue;
    // An operator with no address of their own is reached through the deploy
    // default — so their opt-out must silence that address too. This was the
    // "I turned report mails off and still get them" bug: the opt-out only
    // registered when a custom address had been typed in.
    const to = String(p.mailTo || '').trim() || dflt;
    if (!to) continue;
    if (p.reports === false) off.add(to);
    else if (!list.includes(to)) list.push(to);
  }
  // The deploy default is a fallback for an UNCONFIGURED install, not a back
  // door: the moment any operator has said "no report mails", an empty list
  // means silence — falling back to the default here was the second way the
  // opted-out operator kept receiving mail.
  if (!list.length && dflt && !off.size) list.push(dflt);
  return list.filter((a) => !off.has(a));
}

async function sendMail(subject, html, to) {
  if (!mailer) throw new FmxError('MAIL_NOT_CONFIGURED', 400);
  const rcpts = Array.isArray(to) && to.length ? to : mailRecipients();
  if (!rcpts.length) throw new FmxError('MAIL_NO_RECIPIENT', 400);
  return mailer.sendMail({
    from: `"GM Pricing Console" <${smtpCfg.from}>`,
    to: rcpts.join(', '),
    subject,
    html,
  });
}

// ---------- operator preferences ----------
// Per-uid: `{ <uid>: { mailTo, reports } }`. A cookie minted before uids
// existed has none — those operators fall back to the shared default rather
// than writing a bucket nobody can address.

const prefsOf = (req) => {
  const uid = req.operator && req.operator.uid;
  const p = uid ? store.get('prefs', {})[uid] : null;
  return p && typeof p === 'object' ? p : {};
};

app.get('/api/prefs', (req, res) => {
  const p = prefsOf(req);
  res.json({
    mailTo: p.mailTo || null,
    reports: p.reports !== false,
    mailDefault: smtpCfg ? smtpCfg.to : null,
    effective: mailRecipients().join(', ') || null,
  });
});

app.post(
  '/api/prefs',
  wrap(async (req, res) => {
    const uid = req.operator && req.operator.uid;
    if (!uid) throw new FmxError('NO_UID', 400);
    const all = { ...store.get('prefs', {}) };
    const prefs = { ...(all[uid] && typeof all[uid] === 'object' ? all[uid] : {}) };
    if ('mailTo' in req.body) {
      const v = String(req.body.mailTo || '').trim();
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new FmxError('BAD_EMAIL', 400);
      if (v) prefs.mailTo = v;
      else delete prefs.mailTo; // empty = back to the deploy default
    }
    if ('reports' in req.body) prefs.reports = req.body.reports !== false;
    all[uid] = prefs;
    store.set('prefs', all, { immediate: true });
    addLog({
      action: 'prefs', station: null, stationName: 'SETTINGS', day: null,
      month: null, year: null, duration: null, before: null, after: null,
      ok: true,
      file: `mailTo=${prefs.mailTo || '(default)'} reports=${prefs.reports !== false ? 'on' : 'off'}`,
    });
    res.json({
      ok: true,
      mailTo: prefs.mailTo || null,
      reports: prefs.reports !== false,
      effective: mailRecipients().join(', ') || null,
    });
  })
);

app.post(
  '/api/test-mail',
  wrap(async (req, res) => {
    const html = alertMailHtml(
      'Test e-postası — her şey doğru kurulmuş.',
      [
        {
          title: 'BAĞLANTI TESTİ',
          header: ['KONTROL', 'DURUM'],
          rows: [
            ['SMTP sunucusu', smtpCfg ? smtpCfg.host : '—'],
            ['STARTTLS', 'Açık'],
            ['Pazar takibi', WATCH.enabled ? 'Aktif' : 'Kapalı'],
            ['Eşik', WATCH.pctThreshold + '% fiyat / ' + WATCH.rankThreshold + ' sıra'],
          ],
        },
      ],
      'Bu bir test e-postasıdır. Bu mesajı aldıysanız SMTP ayarları çalışıyor ve pazar takibi uyarıları bu adrese ulaşabilir. Yapmanız gereken bir şey yok.'
    );
    // a test belongs to whoever pressed the button — it must not spam the
    // other operators, so the caller's own address wins when there is one
    const own = prefsOf(req).mailTo;
    const to = own ? [own] : mailRecipients();
    const info = await sendMail('[GM] Test e-postası — pazar takibi çalışıyor', html, to);
    addLog({
      action: 'mail-test', station: null, stationName: 'MAIL', day: null,
      month: null, year: null, duration: null, before: null, after: null,
      ok: true, file: to.join(', '),
    });
    res.json({ ok: true, accepted: info.accepted, response: info.response });
  })
);

// ---------- competitor price watcher ----------

const WATCH = {
  enabled: !!mailer,
  intervalMin: 60,     // sweep cadence
  daysAhead: 14,       // watch the next N pickup days
  duration: 3,         // rental length to watch
  pctThreshold: 5,     // alert when a top-5 supplier price moves more than this %
  rankThreshold: 2,    // alert when GM's rank moves this many positions
  lastRun: null,
  lastAlert: null,
  alertsSent: 0,
};

let watchBase = {};

function saveWatchBase() {
  store.set('watch', watchBase);
}

// `deadline` (epoch ms) caps the sweep so it cannot eat the whole tick and leave
// nothing for the auto-scan slice; days it did not reach are swept next hour.
let watcherBusy = false; // one sweep at a time — see below

async function runWatcher(deadline = Infinity) {
  if (!WATCH.enabled) return;
  // The scheduler fires every 4 minutes, but a sweep over a station with
  // thousands of rules takes far longer than that: every tick then started ANOTHER
  // full sweep on top of the one still running, and the pile-up starved the
  // single Cloud Run instance until it stopped accepting requests at all
  // (Cloud Run answers those with 429 "no available instance"). autoScan has had
  // this guard from the start; the watcher never did.
  if (watcherBusy) return;
  watcherBusy = true;
  try {
    return await runWatcherInner(deadline);
  } finally {
    watcherBusy = false;
  }
}

async function runWatcherInner(deadline = Infinity) {
  if (!WATCH.enabled) return;
  WATCH.lastRun = new Date().toISOString();
  watchBase.__lastRun = WATCH.lastRun; // survives cold starts via the store
  const changes = []; // {station, dateLabel, text: [old,new,delta]}
  const now = new Date();

  // one task per station × day, drained by a small worker pool
  const tasks = [];
  // unmapped stations (fresh from FMX, no rentalcars location yet) have no
  // market to watch
  for (const st of tenantStations().filter((x) => x.rc && x.rc.loc)) {
    for (let i = 0; i < WATCH.daysAhead; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      tasks.push({ st, y: d.getFullYear(), mo: d.getMonth() + 1, day: d.getDate() });
    }
  }

  let rcDown = false; // rentalcars unreachable (cloud blocked + relay offline) — stop the sweep
  const marketNow = []; // current top-3 + GM position for each day that changed
  const sweepOne = async ({ st, y, mo, day }) => {
      const wkey = `${st.id}:${y}-${mo}-${day}:${WATCH.duration}`;
      let r;
      try {
        r = await rcQuery({
          station: st.id, year: y, month: mo, day,
          duration: WATCH.duration, hh: RC_HOUR, mm: '00', ttlMs: 0,
        });
      } catch (e) {
        if (e.message === 'RC_UNAVAILABLE') rcDown = true;
        return;
      }
      if (r.stale) return; // cached leftovers prove nothing about the market now
      const snap = {
        ts: Date.now(),
        gmRank: r.gmRank,
        gmPrice: r.gmPrice,
        top: r.top.slice(0, 5).map((x) => ({ supplier: x.supplier, price: x.price })),
      };
      const old = watchBase[wkey];
      if (old) {
        const dateLabel = `${String(day).padStart(2, '0')}.${String(mo).padStart(2, '0')}.${y}`;
        const changesBefore = changes.length;
        // per-supplier price moves in the top 5
        for (const nowRow of snap.top) {
          const oldRow = old.top.find((x) => x.supplier === nowRow.supplier);
          if (!oldRow) continue;
          const deltaPct = ((nowRow.price - oldRow.price) / oldRow.price) * 100;
          if (Math.abs(deltaPct) >= WATCH.pctThreshold) {
            // a competitor raising prices is an advantage for GM (green),
            // a competitor undercutting is a threat (red)
            const deltaTxt = `${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(1)}%`;
            changes.push({
              station: st.name, dateLabel,
              row: [
                `<b>${nowRow.supplier}</b> fiyatını ${deltaPct > 0 ? 'yükseltti' : 'düşürdü'}`,
                `${oldRow.price.toFixed(2)} &rarr; <b>${nowRow.price.toFixed(2)} ${r.currency}</b>`,
                deltaPct > 0 ? mailUp('&#9650; ' + deltaTxt) : mailDown('&#9660; ' + deltaTxt),
              ],
            });
          }
        }
        // GM rank shifts
        if (old.gmRank != null && snap.gmRank != null &&
            Math.abs(snap.gmRank - old.gmRank) >= WATCH.rankThreshold) {
          changes.push({
            station: st.name, dateLabel,
            row: [
              '<b>Green Motion</b> pazar sırası',
              `#${old.gmRank} &rarr; <b>#${snap.gmRank}</b>`,
              snap.gmRank < old.gmRank ? mailUp('&#9650; YÜKSELDİ') : mailDown('&#9660; GERİLEDİ'),
            ],
          });
        }
        // new market leader
        if (old.top[0] && snap.top[0] && old.top[0].supplier !== snap.top[0].supplier) {
          changes.push({
            station: st.name, dateLabel,
            row: [
              mailWarn('YENİ EN UCUZ TEDARİKÇİ'),
              `${old.top[0].supplier} &rarr; <b>${snap.top[0].supplier}</b>`,
              `${snap.top[0].price.toFixed(2)} ${r.currency}`,
            ],
          });
        }
        // any trigger on this day -> include its full market picture in the mail
        if (changes.length > changesBefore) {
          marketNow.push({
            station: st.name, dateLabel,
            row: [
              snap.top.slice(0, 3).map((x, i) => `${i + 1}. ${x.supplier} ${x.price.toFixed(2)}`).join(' &middot; '),
              snap.gmRank != null
                ? `#${snap.gmRank} &middot; ${snap.gmPrice.toFixed(2)} ${r.currency}`
                : 'LİSTEDE YOK',
            ],
          });
        }
      }
      watchBase[wkey] = snap;
  };

  const queue = tasks.slice();
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (queue.length && !rcDown && Date.now() < deadline) await sweepOne(queue.shift());
    })
  );
  saveWatchBase();
  if (rcDown) {
    console.log('Market watch: rentalcars unreachable (relay offline?) — sweep skipped.');
    return;
  }

  if (changes.length) {
    const byStation = {};
    for (const c of changes) {
      const k = `${c.station}`;
      if (!byStation[k]) byStation[k] = [];
      byStation[k].push([c.dateLabel, ...c.row]);
    }
    const sections = Object.entries(byStation).map(([station, rows]) => ({
      title: station.toUpperCase() + ' · NE DEĞİŞTİ (' + WATCH.duration + ' GÜNLÜK KİRALAMA)',
      header: ['TARİH', 'NE OLDU', 'ESKİ &rarr; YENİ', 'ETKİ'],
      rows,
      note: `${mailUp('&#9650; yeşil')} = rakip pahalandı ya da GM yükseldi (GM lehine) · ${mailDown('&#9660; kırmızı')} = bir rakip altına indi ya da GM geriledi (dikkat gerekir).`,
    }));
    // one snapshot section per station: where the market stands *right now*
    // on every day that triggered — so the mail explains itself without
    // having to open the console
    const snapByStation = {};
    for (const m of marketNow) {
      if (!snapByStation[m.station]) snapByStation[m.station] = [];
      snapByStation[m.station].push([m.dateLabel, ...m.row]);
    }
    for (const [station, rows] of Object.entries(snapByStation)) {
      sections.push({
        title: station.toUpperCase() + ' · ŞU ANKİ PAZAR',
        header: ['TARİH', 'EN UCUZ 3 TEDARİKÇİ', 'GREEN MOTION KONUMU'],
        rows,
        note: 'Uyarı tetikleyen her gün için pazarın tarama anındaki durumu — bu e-posta konsolu açmadan kendini anlatsın diye.',
      });
    }
    try {
      const stationsTouched = [...new Set(changes.map((c) => c.station))].join(' & ');
      await sendMail(
        `[GM] Pazarda ${changes.length} değişiklik — ${stationsTouched}`,
        alertMailHtml(
          `rentalcars.com'da ${changes.length} pazar değişikliği`,
          sections,
          `Saatlik pazar takibi, önümüzdeki ${WATCH.daysAhead} alış günü için ${WATCH.duration} günlük kiralama fiyatlarını bir önceki taramayla karşılaştırdı ve eşiklerinizi aşan ${changes.length} hareket buldu (&plusmn;${WATCH.pctThreshold}% fiyat, ${WATCH.rankThreshold}+ sıra ya da yeni en ucuz tedarikçi). Aşağıdaki tablolar ne olduğunu ve pazarın şu anki durumunu gösterir; ayrıntı için Konsolu açın.`
        )
      );
      WATCH.alertsSent++;
      WATCH.lastAlert = new Date().toISOString();
      addLog({
        action: 'mail-alert', station: null, stationName: 'MARKET WATCH',
        day: null, month: null, year: null, duration: null,
        before: null, after: null, ok: true, file: `${changes.length} changes`,
      });
    } catch (e) {
      console.log('Alert mail failed:', e.message);
    }
  }
}

// ---------- live presence (who is looking at what, right now) ----------
// One instance by design, so a Map is the whole implementation. Each client
// heartbeats its focus (station + month + day/cell) every few seconds; peers
// paint it. Entries expire fast — presence that lingers is worse than none.
const presence = new Map(); // uid -> { user, station, year, month, day, dur, view, ts }
const PRESENCE_TTL_MS = 12 * 1000;

app.post('/api/presence', (req, res) => {
  const op = req.operator || {};
  if (!op.uid) return res.json({ ok: false });
  const b = req.body || {};
  // the same ownership gate every station-scoped route has: without it, any
  // operator could name another franchise's station id and read a live feed
  // of who works where in a tenant they have no access to
  if (!tenantStations(req).some((x) => x.id === Number(b.station)))
    return res.json({ ok: false });
  presence.set(op.uid, {
    user: String(op.u || '').split('@')[0].slice(0, 24),
    station: Number(b.station) || null,
    year: Number(b.year) || null,
    month: Number(b.month) || null,
    day: Number(b.day) || null,
    dur: Number(b.dur) || null,
    view: typeof b.view === 'string' ? b.view.slice(0, 16) : null,
    ts: Date.now(),
  });
  // answer with everyone ELSE on the same station+month — one round-trip
  const others = [];
  for (const [uid, p] of presence) {
    if (uid === op.uid) continue;
    if (Date.now() - p.ts > PRESENCE_TTL_MS) { presence.delete(uid); continue; }
    if (p.station === Number(b.station) && p.year === Number(b.year) && p.month === Number(b.month))
      others.push({ user: p.user, day: p.day, dur: p.dur, view: p.view });
  }
  res.json({ ok: true, others });
});

// Event-loop stall telemetry: a blocked loop is the one failure Cloud Run
// reports only as opaque 429 bursts. lagMaxMs says whether the process itself
// froze (big stringify, giant cheerio parse, GC pause) or the platform did.
const { monitorEventLoopDelay } = require('perf_hooks');
const loopLag = monitorEventLoopDelay({ resolution: 100 });
loopLag.enable();
let loopLagMaxSinceRead = 0;
setInterval(() => {
  loopLagMaxSinceRead = Math.max(loopLagMaxSinceRead, loopLag.max / 1e6);
  loopLag.reset();
}, 5000).unref();

app.get('/api/watch-status', (req, res) => {
  pruneWorkers();
  const relays = [...relayState.workers.entries()]
    .sort((a, b) => b[1] - a[1]) // freshest first
    .map(([name, ts]) => ({ name, agoSec: Math.round((Date.now() - ts) / 1000) }));
  res.json({
    enabled: WATCH.enabled,
    intervalMin: WATCH.intervalMin,
    daysAhead: WATCH.daysAhead,
    duration: WATCH.duration,
    pctThreshold: WATCH.pctThreshold,
    rankThreshold: WATCH.rankThreshold,
    lastRun: WATCH.lastRun,
    lastAlert: WATCH.lastAlert,
    alertsSent: WATCH.alertsSent,
    baseline: Object.keys(watchBase).filter((k) => !k.startsWith('__')).length,
    mailTo: mailRecipients().join(', ') || null,
    relayOnline: relayOnline(),
    relayLastSeen: relayState.lastSeen ? new Date(relayState.lastSeen).toISOString() : null,
    relays,
    // worst single event-loop stall since the last read of this endpoint —
    // >1000 here during a 429 burst means the process froze, not the platform
    loopLagMaxMs: (() => { const v = Math.round(Math.max(loopLagMaxSinceRead, loopLag.max / 1e6)); loopLagMaxSinceRead = 0; loopLag.reset(); return v; })(),
    // a station reset or copy outlives any page refresh — the client shows
    // this instead of a grid that cannot load while the job runs
    purge: (() => {
      const j = [...purgeJobs.values()].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))[0];
      return j && j.status === 'running'
        ? { running: true, station: j.station, done: j.done, total: j.total }
        : null;
    })(),
    copy: (() => {
      const j = [...copyJobs.values()].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))[0];
      return j && j.status === 'running'
        ? { running: true, to: j.to, done: j.done, total: j.total }
        : null;
    })(),
    autoScan: autoScanStatus(),
  });
});

app.post(
  '/api/watch-run',
  wrap(async (req, res) => {
    await runWatcher();
    res.json({ ok: true, lastRun: WATCH.lastRun, baseline: Object.keys(watchBase).length });
  })
);

// local runs sweep on their own timers; in the cloud /api/internal/tick decides
if (WATCH.enabled && !store.IS_CLOUD) {
  setTimeout(runWatcher, 90 * 1000); // first baseline sweep shortly after boot
  setInterval(runWatcher, WATCH.intervalMin * 60 * 1000);
}

// ---------- meta ----------

app.get(
  '/api/stations',
  wrap(async (req, res) => {
    const id = tenantIdOf(req);
    const t = tenantOf(id);
    res.json({
      stations: tenantStations(id),
      durations: DURATIONS,
      tenant: { id, name: t.name || id },
      role: (req.operator && req.operator.role) || 'staff',
      superadmin: await isSuperadmin(req),
    });
  })
);

const RC_LOC_OK = {
  IATA: /^[A-Z]{3}$/,
  LATLONG: /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/,
};

/** Validate + normalize an incoming station list (PUT /api/stations body).
 *  `ownerId` is the franchise the list is being written to: a station id that
 *  already belongs to a DIFFERENT franchise is refused, otherwise an admin
 *  could claim another tenant's station and then read and price its grid
 *  through every `tenantStations(req)` gate. */
function shapeStations(input, ownerId) {
  if (!Array.isArray(input) || !input.length || input.length > 40)
    throw new FmxError('BAD_STATIONS', 400);
  const seen = new Set();
  return input.map((s) => {
    const id = Number(s && s.id);
        if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647)
      throw new FmxError('BAD_STATION_ID', 400);
    if (seen.has(id)) throw new FmxError('DUPLICATE_STATION_ID', 400);
    seen.add(id);
    for (const [tid, t] of Object.entries(tenants))
      if (tid !== ownerId && (t.stations || []).some((x) => x.id === id))
        throw new FmxError('STATION_IN_USE', 409);
    const name = String((s && s.name) || '').trim();
    if (!name || name.length > 60) throw new FmxError('BAD_STATION_NAME', 400);
    const rc = (s && s.rc) || {};
    const type = String(rc.type || '');
    const loc = String(rc.loc || '').trim();
    if (!RC_LOC_OK[type] || !RC_LOC_OK[type].test(loc)) throw new FmxError('BAD_STATION_RC', 400);
    return { id, name, rc: { type, loc, label: String(rc.label || name).trim().slice(0, 80) } };
  });
}

// admin only: rewrite the active tenant's station list
app.put(
  '/api/stations',
  wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = tenantIdOf(req);
    const t = tenants[id];
    if (!t) throw new FmxError('BAD_TENANT', 400);
    const next = shapeStations(req.body && req.body.stations, id);
    const before = t.stations || [];
    // cached market data is keyed by station id, so anything that moved (or
    // left) would otherwise keep serving the old location's prices
    let invalidated = 0;
    for (const s of before) {
      const n = next.find((x) => x.id === s.id);
      const rc = s.rc || {};
      if (!n || n.rc.type !== rc.type || n.rc.loc !== rc.loc)
        invalidated += rcInvalidateStation(s.id);
    }
    t.stations = next;
    // the live FMX session's validation station may have just been removed
    if (id === fmxTenant) bindFmxTenant(id);
    await store.setNow('tenants', tenants);
    addLog({
      action: 'stations-save', station: null, stationName: 'STATIONS', day: null,
      month: null, year: null, duration: null, before: before.length, after: next.length,
      ok: true, file: `${id}: ${next.map((s) => `${s.id} ${s.rc.type}:${s.rc.loc}`).join(', ')}`,
    });
    res.json({
      ok: true, stations: next, tenant: { id, name: t.name || id }, invalidated,
    });
  })
);

// ---------- rentalcars location picker ----------
// Autocomplete for the station editor: airports come back as IATA codes, every
// other place as coordinates — exactly the two rc location shapes.

const placesCache = new Map(); // lowercased query -> { ts, list }
const PLACES_TTL_MS = 30 * 60 * 1000;

app.get(
  '/api/places',
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) return res.json([]);
    const key = q.toLowerCase();
    const hit = placesCache.get(key);
    if (hit && Date.now() - hit.ts < PLACES_TTL_MS) return res.json(hit.list);

    let list;
    try {
      list = await placesFetch(q); // direct — always works from residential IPs
    } catch (e) {
      if (!(e.blocked && store.IS_CLOUD)) throw new FmxError(e.message || 'RC_FETCH_FAILED', 502);
      // cloud egress refused, same as the search API: go through the relay
      if (!relayOnline()) throw new FmxError('RC_UNAVAILABLE', 503);
      const { url, headers } = placesUrl(q);
      list = await relayJob({ url, headers, parse: placesParse });
    }
    if (placesCache.size > 300) placesCache.clear();
    placesCache.set(key, { ts: Date.now(), list });
    res.json(list);
  })
);

app.get(
  '/api/vendors',
  wrap(async (req, res) => {
    res.json({ vendors: await fmx.getVendors() });
  })
);

// the rule form's vehicle groups (ZU-A, ZU-B, …) — a rule may target a subset
app.get(
  '/api/vehicle-groups',
  wrap(async (req, res) => {
    res.json({ groups: await fmx.getVehicleGroups() });
  })
);

// ---------- saved vehicle-group sets ----------
// An operator names a subset once ("Ekonomi filo") and then prices it by name
// instead of re-picking 12 checkboxes. Stored per franchise next to its
// stations, so every operator of that tenant shares the same named sets.

const vgPresets = (req) => (tenantOf(req).vgPresets || []).slice();

app.get(
  '/api/vg-presets',
  wrap(async (req, res) => {
    res.json({ presets: vgPresets(req) });
  })
);

app.post(
  '/api/vg-presets',
  wrap(async (req, res) => {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
    if (!name) throw new FmxError('BAD_PRESET_NAME', 400);
    const known = new Set((await fmx.getVehicleGroups()).map((g) => g.id));
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String))]
      .filter((id) => known.has(id));
    if (!ids.length) throw new FmxError('NO_VEHICLE_GROUPS', 400);
    const tid = tenantIdOf(req);
    const t = tenants[tid];
    if (!t) throw new FmxError('BAD_TENANT', 400);
    const list = (t.vgPresets || []).filter((p) => p.name.toLowerCase() !== name.toLowerCase());
    if (list.length >= 40) throw new FmxError('TOO_MANY_PRESETS', 400);
    const preset = { id: crypto.randomBytes(4).toString('hex'), name, ids };
    list.push(preset);
    t.vgPresets = list;
    await store.setNow('tenants', tenants);
    addLog({
      action: 'vg-preset', station: null, stationName: 'VEHICLE GROUPS', day: null,
      month: null, year: null, duration: null, before: null, after: null,
      ok: true, file: `${name} (${ids.length})`,
    });
    res.json({ ok: true, preset });
  })
);

app.delete(
  '/api/vg-presets/:id',
  wrap(async (req, res) => {
    const tid = tenantIdOf(req);
    const t = tenants[tid];
    if (!t) throw new FmxError('BAD_TENANT', 400);
    const before = (t.vgPresets || []).length;
    t.vgPresets = (t.vgPresets || []).filter((p) => p.id !== req.params.id);
    if (t.vgPresets.length === before) throw new FmxError('NO_SUCH_PRESET', 404);
    await store.setNow('tenants', tenants);
    res.json({ ok: true });
  })
);

// ---------- user management (admin only) ----------
// Firebase Auth holds the credential and the disabled flag; Firestore
// `users/<uid>` mirrors the profile and is the only place the franchise lives.
// Every route here is admin-only AND tenant-scoped: an admin sees and touches
// their own franchise's operators, nobody else's. The seeded owner account
// (users/<uid>.superadmin) is the single exception.

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const usersCol = () => admin.firestore().collection('users');

/** Firestore timestamps, ISO strings and plain dates all read back as ISO. */
const tsIso = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  return null;
};

/** The mirrored profiles, with the franchise resolved (a doc written before
 *  tenants existed, or pointing at a deleted one, belongs to the default). */
async function userDocs() {
  const snap = await usersCol().get();
  return snap.docs.map((d) => {
    const v = d.data() || {};
    return {
      uid: d.id,
      email: v.email || null,
      displayName: v.displayName || null,
      role: asRole(v.role),
      tenant: v.tenant && tenants[v.tenant] ? String(v.tenant) : DEFAULT_TENANT,
      superadmin: v.superadmin === true,
      createdAt: tsIso(v.createdAt),
    };
  });
}

/** Fill in what only Firebase Auth knows. A profile whose auth user is gone is
 *  reported, not hidden — it is exactly the row an admin needs to clean up. */
async function enrichUser(row) {
  try {
    const u = await admin.auth().getUser(row.uid);
    const meta = u.metadata || {};
    return {
      ...row,
      email: u.email || row.email,
      displayName: u.displayName || row.displayName,
      disabled: !!u.disabled,
      createdAt: row.createdAt || (meta.creationTime ? new Date(meta.creationTime).toISOString() : null),
      lastSignIn: meta.lastSignInTime ? new Date(meta.lastSignInTime).toISOString() : null,
    };
  } catch (e) {
    return { ...row, disabled: null, lastSignIn: null, missing: true };
  }
}

/** Which franchise a write may land in: your own, unless you are the owner. */
async function targetTenant(req, wanted) {
  const mine = tenantIdOf(req);
  const w = wanted == null || wanted === '' ? null : String(wanted);
  if (!w || w === mine) return mine;
  if (!(await isSuperadmin(req))) throw new FmxError('FORBIDDEN', 403);
  if (!tenants[w]) throw new FmxError('BAD_TENANT', 400);
  return w;
}

/** Look up one user inside the caller's scope. Out of scope reads as absent,
 *  so probing uids cannot map another franchise's operators. The owner account
 *  is off limits to everyone but itself: an admin of its own franchise could
 *  otherwise demote, disable or delete it, and nothing in-product re-grants the
 *  flag (seedSuperadmin only patches a doc that still exists). */
async function scopedUser(req, uid) {
  const row = (await userDocs()).find((u) => u.uid === uid);
  if (!row) throw new FmxError('NO_SUCH_USER', 404);
  const owner = await isSuperadmin(req);
  if (row.tenant !== tenantIdOf(req) && !owner) throw new FmxError('NO_SUCH_USER', 404);
  if (row.superadmin === true && !owner) throw new FmxError('FORBIDDEN', 403);
  return row;
}

const userLog = (action, row, note) =>
  addLog({
    action, station: null, stationName: 'USERS', day: null, month: null,
    year: null, duration: null, before: null, after: null, ok: true,
    file: `${row.email || row.uid} ${row.role}@${row.tenant}${note ? ' ' + note : ''}`,
  });

app.get(
  '/api/users',
  wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const all = await isSuperadmin(req);
    const tn = tenantIdOf(req);
    const rows = (await userDocs()).filter((u) => all || u.tenant === tn);
    res.json(await Promise.all(rows.map(enrichUser)));
  })
);

app.post(
  '/api/users',
  wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL_OK.test(email) || email.length > 120) throw new FmxError('BAD_EMAIL', 400);
    // the password is never logged, never echoed and never stored by us
    const password = String(b.password || '');
    if (password.length < 8 || password.length > 200) throw new FmxError('BAD_PASSWORD', 400);
    if (!ROLES.includes(b.role)) throw new FmxError('BAD_ROLE', 400);
    const role = b.role;
    const displayName = String(b.displayName || '').trim().slice(0, 60);
    const tenant = await targetTenant(req, b.tenant);

    let rec;
    try {
      rec = await admin.auth().createUser({
        email, password, displayName: displayName || undefined,
      });
    } catch (e) {
      if (e.code === 'auth/email-already-exists') throw new FmxError('EMAIL_EXISTS', 409);
      if (e.code === 'auth/invalid-password') throw new FmxError('BAD_PASSWORD', 400);
      throw new FmxError(e.code || 'CREATE_USER_FAILED', 502);
    }
    await admin.auth().setCustomUserClaims(rec.uid, { role });
    const doc = {
      email, role, displayName: displayName || null,
      createdAt: new Date().toISOString(), tenant,
    };
    await usersCol().doc(rec.uid).set(doc);
    const row = { uid: rec.uid, ...doc, superadmin: false };
    userLog('user-create', row);
    res.json(await enrichUser(row));
  })
);

app.patch(
  '/api/users/:uid',
  wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const uid = String(req.params.uid || '');
    const b = req.body || {};
    // an admin must never be able to lock themselves out of their own console
    // — refused before anything is read, let alone written
    const self = uid === (req.operator && req.operator.uid);
    if (self && (('role' in b && b.role !== 'admin') || b.disabled === true))
      throw new FmxError('SELF_LOCKOUT', 400);
    const row = await scopedUser(req, uid);
    const authPatch = {};
    const docPatch = {};
    const notes = [];

    if ('role' in b) {
      if (!ROLES.includes(b.role)) throw new FmxError('BAD_ROLE', 400);
      if (b.role !== row.role) {
        docPatch.role = b.role;
        notes.push(`role=${b.role}`);
      }
    }
    if ('disabled' in b) {
      const disabled = b.disabled === true;
      authPatch.disabled = disabled;
      notes.push(disabled ? 'disabled' : 'enabled');
    }
    if ('displayName' in b) {
      const n = String(b.displayName || '').trim().slice(0, 60);
      authPatch.displayName = n || null;
      docPatch.displayName = n || null;
    }
    if ('tenant' in b) {
      const tn = await targetTenant(req, b.tenant);
      if (tn !== row.tenant) {
        docPatch.tenant = tn;
        notes.push(`tenant=${tn}`);
      }
    }

    if (Object.keys(authPatch).length) await admin.auth().updateUser(uid, authPatch);
    if (docPatch.role) await admin.auth().setCustomUserClaims(uid, { role: docPatch.role });
    if (Object.keys(docPatch).length) await usersCol().doc(uid).set(docPatch, { merge: true });

    if (authPatch.disabled === true) {
      revokedUids.add(uid);
      await admin.auth().revokeRefreshTokens(uid).catch(() => {});
    } else if (authPatch.disabled === false) revokedUids.delete(uid);
    // the operator cookie carries role + franchise, so a changed one is dead:
    // the console re-mints it from the live Firebase session on the next call
    if (docPatch.role || docPatch.tenant) staleUids.add(uid);
    if (docPatch.tenant) uidTenants.set(uid, docPatch.tenant);

    const next = { ...row, ...docPatch };
    userLog('user-update', next, notes.join(' '));
    res.json(await enrichUser(next));
  })
);

app.delete(
  '/api/users/:uid',
  wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const uid = String(req.params.uid || '');
    if (uid === (req.operator && req.operator.uid)) throw new FmxError('SELF_LOCKOUT', 400);
    const row = await scopedUser(req, uid);
    await admin.auth().deleteUser(uid).catch((e) => {
      if (e.code !== 'auth/user-not-found') throw new FmxError(e.code || 'DELETE_FAILED', 502);
    });
    await usersCol().doc(uid).delete();
    revokedUids.add(uid); // a live cookie of a deleted account dies with it
    staleUids.delete(uid);
    uidTenants.delete(uid);
    superadminCache.delete(uid);
    userLog('user-delete', row);
    res.json({ ok: true, uid });
  })
);

// ---------- franchise (tenant) management (admin only) ----------

const TENANT_ID_OK = /^[a-z0-9-]{2,32}$/;

const tenantRow = (id, counts) => ({
  id,
  name: tenants[id].name || id,
  fmxBase: tenants[id].fmxBase || null,
  stationCount: (tenants[id].stations || []).length,
  userCount: counts[id] || 0,
});

app.get(
  '/api/tenants',
  wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const all = await isSuperadmin(req);
    const mine = tenantIdOf(req);
    const counts = {};
    try {
      for (const u of await userDocs()) counts[u.tenant] = (counts[u.tenant] || 0) + 1;
    } catch (e) {
      console.log('tenant user count failed:', e.message); // counts stay 0
    }
    const ids = Object.keys(tenants).filter((id) => all || id === mine);
    res.json(ids.map((id) => tenantRow(id, counts)));
  })
);

/** Validate a franchise's FuseMetrix host: an https origin, nothing else — it
 *  is where this console posts live prices. */
function shapeFmxBase(v) {
  let u;
  try {
    u = new URL(String(v || ''));
  } catch {
    throw new FmxError('BAD_FMX_BASE', 400);
  }
  if (u.protocol !== 'https:' || u.search || u.hash) throw new FmxError('BAD_FMX_BASE', 400);
  return u.origin;
}

app.post(
  '/api/tenants',
  wrap(async (req, res) => {
    if (!(await requireSuperadmin(req, res))) return;
    const b = req.body || {};
    const id = String(b.id || '').trim().toLowerCase();
    if (!TENANT_ID_OK.test(id)) throw new FmxError('BAD_TENANT_ID', 400);
    if (tenants[id]) throw new FmxError('TENANT_EXISTS', 409);
    const name = String(b.name || '').trim();
    if (!name || name.length > 60) throw new FmxError('BAD_TENANT_NAME', 400);
    const fmxBase = shapeFmxBase(b.fmxBase);
    // a franchise is created together with the airport(s) it prices
    const stations = shapeStations(b.stations, id);
    tenants[id] = { name, fmxBase, stations };
    await store.setNow('tenants', tenants);
    addLog({
      action: 'tenant-create', station: null, stationName: 'FRANCHISE', day: null,
      month: null, year: null, duration: null, before: null, after: null, ok: true,
      file: `${id} "${name}" ${fmxBase} · ${stations.length} station(s)`,
    });
    res.json(tenantRow(id, {}));
  })
);

app.patch(
  '/api/tenants/:id',
  wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = String(req.params.id || '');
    const t = tenants[id];
    if (!t) throw new FmxError('NO_SUCH_TENANT', 404);
    const owner = await isSuperadmin(req);
    // a normal admin may only edit their own franchise, and never its FMX host
    if (!owner && id !== tenantIdOf(req)) throw new FmxError('FORBIDDEN', 403);
    const b = req.body || {};
    if ('fmxBase' in b && !owner) throw new FmxError('FORBIDDEN', 403);

    const changes = [];
    if ('name' in b) {
      const name = String(b.name || '').trim();
      if (!name || name.length > 60) throw new FmxError('BAD_TENANT_NAME', 400);
      t.name = name;
      changes.push(`name="${name}"`);
    }
    if ('fmxBase' in b) {
      t.fmxBase = shapeFmxBase(b.fmxBase);
      changes.push(`fmxBase=${t.fmxBase}`);
    }
    let invalidated = 0;
    if ('stations' in b) {
      const next = shapeStations(b.stations, id);
      // cached market data is keyed by station id, so anything that moved (or
      // left) would otherwise keep serving the old location's prices
      for (const s of t.stations || []) {
        const n = next.find((x) => x.id === s.id);
        const rc = s.rc || {};
        if (!n || n.rc.type !== rc.type || n.rc.loc !== rc.loc)
          invalidated += rcInvalidateStation(s.id);
      }
      t.stations = next;
      changes.push(`${next.length} station(s)`);
    }
    // the live FMX session may have just lost its host or validation station
    if (id === fmxTenant) bindFmxTenant(id);
    await store.setNow('tenants', tenants);
    addLog({
      action: 'tenant-update', station: null, stationName: 'FRANCHISE', day: null,
      month: null, year: null, duration: null, before: null, after: null, ok: true,
      file: `${id}: ${changes.join(', ') || 'no change'}`,
    });
    res.json({ ...tenantRow(id, {}), invalidated, stations: t.stations });
  })
);

app.delete(
  '/api/tenants/:id',
  wrap(async (req, res) => {
    if (!(await requireSuperadmin(req, res))) return;
    const id = String(req.params.id || '');
    if (!tenants[id]) throw new FmxError('NO_SUCH_TENANT', 404);
    if (id === DEFAULT_TENANT) throw new FmxError('TENANT_IN_USE', 409);
    // a franchise with operators still in it must not vanish under them
    const users = (await userDocs()).filter((u) => u.tenant === id).length;
    if (users) throw new FmxError('TENANT_HAS_USERS', 409);
    delete tenants[id];
    if (fmxTenant === id) bindFmxTenant(DEFAULT_TENANT);
    await store.setNow('tenants', tenants);
    addLog({
      action: 'tenant-delete', station: null, stationName: 'FRANCHISE', day: null,
      month: null, year: null, duration: null, before: null, after: null, ok: true,
      file: id,
    });
    res.json({ ok: true, id });
  })
);

// ---------- rentalcars market data (user-initiated, plain public API GETs) ----------

let rcCache = {};
// The cache is memory-first; the file is only a nicety for restarts (in cloud
// it lands on RAM-backed /tmp and dies with the instance anyway). Persisting it
// per result was THE 429 engine: a full-cache JSON.stringify — 90-200ms of
// blocked event loop — fired 32x/min during a month sweep, and every stall the
// relay hit made it re-send the same 2MB body, which persisted again.
function saveRcCache() {
  // In the cloud this file lives in /tmp, which dies WITH the instance — the
  // write can never help a successor, yet stringifying a full cache (hundreds
  // of ~50KB snapshots after a scan day) blocks the event loop for seconds,
  // and a blocked loop is exactly when Cloud Run answers everyone else with
  // 429 "no available instance" (measured 2026-08-29 evening: recurring
  // 20-40s reject bursts). Persist only where it can outlive the process.
  if (!store.IS_CLOUD) store.set('rc', rcCache, { debounceMs: 30000 });
}

// relay bridge: rentalcars answers datacenter IPs (Google Cloud included) with
// HTTP 405, so on the deployed console the queries are executed by a relay
// worker running on the operator's own machine (`npm run relay`). The worker
// long-polls /api/relay/poll over outbound HTTPS and posts each result to
// /api/relay/result. Jobs live in memory, which is safe because the console
// function is pinned to a single instance (maxInstances: 1).
const relayState = {
  lastSeen: 0,        // last authenticated contact from any worker
  workers: new Map(), // name -> lastSeenMs, only for relays that send x-relay-name
  jobs: new Map(),    // id -> { args, url, headers, meta, resolve, reject, timer }
  backlog: [],        // job ids not yet handed to a worker
  pollers: [],        // parked /relay/poll responses waiting for a job
  // worker key -> untilMs. A worker whose IP rentalcars is refusing (WAF
  // challenge / block) gets no jobs for RC_BREAKER_MS; the others carry on.
  // Measured 2026-09-03: two relays were online — the Mac one carrying a
  // browser's aws-waf-token (served) and a Windows PowerShell one without
  // (202 on every fetch) — and one 202 from the second tripped the GLOBAL
  // breaker, so nobody got answers although one worker could deliver them.
  quarantine: new Map(),
  strikes: new Map(), // worker key -> consecutive refusals (cleared by a served answer)
  seen: new Map(),    // worker key -> lastSeenMs, every worker (named or not)
};
/** who a relay request comes from: its name header, else its user agent */
const relayWorkerKey = (req) => {
  const ua = String(req.headers['user-agent'] || '');
  const fam = /PowerShell/i.test(ua) ? 'ps' : /^node/i.test(ua) ? 'node' : 'other';
  const n = req.headers['x-relay-name'];
  if (n != null) return `name:${String(n).replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 64)}|${fam}`;
  return 'ua:' + ua.slice(0, 80);
};
const relayQuarantined = (key) => (relayState.quarantine.get(key) || 0) > Date.now();
/** is any worker online that is NOT quarantined? */
// "seen lately": a worker that polled within 5 minutes counts as present. 75s
// was too tight — a worker busy with four fetches, or one whose parked poll
// the single instance answered late, dropped out and the cloud fell through to
// a DIRECT fetch it could never win (2026-09-04, three global trips that way).
const RELAY_SEEN_MS = 5 * 60 * 1000;
function relayHealthyWorkerOnline() {
  const cut = Date.now() - RELAY_SEEN_MS;
  for (const [k, ts] of relayState.seen) if (ts >= cut && !relayQuarantined(k)) return true;
  return false;
}
function relayAnyWorkerSeen(ms = RELAY_SEEN_MS) {
  const cut = Date.now() - ms;
  for (const ts of relayState.seen.values()) if (ts >= cut) return true;
  return false;
}
function relayWorkersNote() {
  const now = Date.now();
  return [...relayState.seen].map(([k, ts]) =>
    `${k} seen ${Math.round((now - ts) / 1000)}s ago${relayQuarantined(k) ? ` QUARANTINED ${Math.round((relayState.quarantine.get(k) - now) / 1000)}s` : ''}`
  ).join('; ') || 'none';
}
const relayOnline = () => Date.now() - relayState.lastSeen < 75 * 1000;

const pruneWorkers = () => {
  const cut = Date.now() - 10 * 60 * 1000;
  for (const [n, ts] of relayState.workers) if (ts < cut) relayState.workers.delete(n);
};

// called only after requireSecret passed — an unauthenticated request must not
// refresh lastSeen or plant names in the operator-rendered worker list. Names
// are whitelisted; a nameless legacy relay stays online via lastSeen but never
// enters the list (a missing header must not surface as the name "undefined").
function relayRegister(req) {
  relayState.lastSeen = Date.now();
  relayState.seen.set(relayWorkerKey(req), Date.now());
  if (relayState.seen.size > 40) { // bounded, like everything else here
    const cut = Date.now() - 10 * 60 * 1000;
    for (const [k, ts] of relayState.seen) if (ts < cut) relayState.seen.delete(k);
  }
  if (req.headers['x-relay-name'] == null) return;
  const name =
    String(req.headers['x-relay-name']).replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 64) || 'unnamed';
  if (relayState.workers.size >= 20 && !relayState.workers.has(name)) return; // capped
  relayState.workers.set(name, Date.now());
  pruneWorkers();
}

function relayHandOut() {
  while (relayState.backlog.length) {
    // a quarantined worker is left parked (its poll times out to "no job" as
    // usual); the job goes to the first worker rentalcars is still serving.
    // With nothing but quarantined workers parked, the job waits in the
    // backlog for a healthy poll or its own 90s timer — never to a worker
    // that will only hand back another 202.
    const i = relayState.pollers.findIndex((p) => !relayQuarantined(p.worker));
    if (i < 0) return;
    const p = relayState.pollers.splice(i, 1)[0];
    clearTimeout(p.timer);
    const id = relayState.backlog.shift();
    const job = relayState.jobs.get(id);
    if (!job) continue;
    job.worker = p.worker;
    // url/headers drive the raw relays; args keep an old relay binary working
    p.res.json({ job: { id, url: job.url, headers: job.headers, args: job.args } });
  }
}

function relayDispatch(args) {
  const { url, headers, meta } = rcUrl(args); // meta feeds rcParse when the raw body returns
  return relayJob({ args, url, headers, meta });
}

/** Queue one raw rentalcars fetch for a relay worker. `parse` turns the body
 *  into the caller's shape; without one the body is a search result (rcParse).
 *  The worker only ever fetches www.rentalcars.com — relay.js pins the host. */
function relayJob({ args = null, url, headers, meta = null, parse = null }) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      relayState.jobs.delete(id);
      const i = relayState.backlog.indexOf(id);
      if (i >= 0) relayState.backlog.splice(i, 1);
      reject(new FmxError('RC_RELAY_TIMEOUT', 504));
      // 90s, not 45: the PowerShell relay works one job at a time, so under a
      // month-sweep burst a queued job can legitimately wait a while
    }, 90 * 1000);
    relayState.jobs.set(id, { args, url, headers, meta, parse, resolve, reject, timer });
    relayState.backlog.push(id);
    relayHandOut();
  });
}

// How long an idle poll parks before answering "no job". This is pure request
// volume: the console is pinned to ONE Cloud Run instance, so every avoidable
// request eats headroom a scan needs. Parking longer means each worker costs
// far fewer requests per hour while an idle relay stays just as responsive —
// a job still wakes a parked poll instantly via relayHandOut().
// Kept under the relay client's own 40s fetch timeout so the worker never
// times out on a poll that was about to answer normally.
const RELAY_POLL_PARK_MS = 32 * 1000;

app.get('/api/relay/poll', (req, res) => {
  if (!requireSecret(req, res, RELAY_SECRET, 'x-relay-secret')) return;
  relayRegister(req);
  const p = { res, worker: relayWorkerKey(req) };
  p.timer = setTimeout(() => {
    const i = relayState.pollers.indexOf(p);
    if (i >= 0) relayState.pollers.splice(i, 1);
    res.json({ job: null });
  }, RELAY_POLL_PARK_MS);
  relayState.pollers.push(p);
  relayHandOut();
});

app.post('/api/relay/result', (req, res) => {
  // the route-scoped parser gate already checked the secret; harmless re-check
  if (!requireSecret(req, res, RELAY_SECRET, 'x-relay-secret')) return;
  relayRegister(req);
  const { id, ok, data, status, body, error } = req.body || {};
  const job = relayState.jobs.get(id);
  if (!job) return res.json({ ok: false, note: 'unknown or expired job' });
  relayState.jobs.delete(id);
  // the 90s timer keeps running for a job that is about to be requeued — it
  // is cleared only on the paths that settle the job below
  const settle = () => clearTimeout(job.timer);
  // every rejection below is logged with what the relay actually saw — on
  // 2026-09-03 hundreds of them went by as bare 502s and nobody could tell a
  // WAF challenge from a parse error
  const relayNote = (why) => {
    const now = Date.now();
    if (now - (relayState.lastNote || 0) < 5000) return;
    relayState.lastNote = now;
    console.warn(`[relay] job rejected: ${why} status=${status} bytes=${body ? String(body).length : 0} head=${JSON.stringify(String(body || '').slice(0, 80))}`);
  };
  if (!ok) {
    relayNote('worker: ' + (error || 'FAILED'));
    settle(); job.reject(new FmxError('RC_RELAY_' + (error || 'FAILED'), 502));
  } else if (data !== undefined) {
    // legacy relay: parsed on the worker — the weakest accepted shape defines
    // what reaches .toFixed downstream, so prices must be real numbers. Only
    // search jobs have a worker-side parser; anything else needs the raw body.
    if (
      !job.parse && data && Array.isArray(data.top) &&
      data.top.every((r) => r && Number.isFinite(r.price)) &&
      (data.gmPrice == null || Number.isFinite(data.gmPrice))
    ) { settle(); job.resolve(data); }
    else { settle(); job.reject(new FmxError('RC_RELAY_BAD_RESULT', 502)); }
  } else {
    // raw relay: the worker fetched but never parsed — classify + parse here
    const st = Number(status);
    const kind = rcRefusalKind(st, body);
    if (kind) {
      // THIS worker's IP is being refused: quarantine it, and let another
      // worker have the job once. Only when no healthy worker is online does
      // the refusal mean rentalcars is closed to us altogether.
      const who = job.worker || relayWorkerKey(req);
      // repeated refusals from the same worker back off geometrically (5, 10,
      // 20 … minutes, capped at two hours): a Windows relay without its own
      // WAF token was being handed one doomed job every five minutes all night
      const strikes = (relayState.strikes.get(who) || 0) + 1;
      relayState.strikes.set(who, strikes);
      const hold = Math.min(RC_BREAKER_MS * 2 ** (strikes - 1), 2 * 60 * 60 * 1000);
      relayState.quarantine.set(who, Date.now() + hold);
      relayNote(`${kind} from ${who} — quarantined ${Math.round(hold / 1000)}s (strike ${strikes}); workers: ${relayWorkersNote()}`);
      if (!job.retried) {
        // a job already handed out once goes back to the front of the queue;
        // the first healthy poll takes it, or its own 90s timer ends it — the
        // GLOBAL breaker is not for this: a refused WORKER is not a refused
        // console, and holding everyone for five minutes because one relay
        // lacks a token is what made 2026-09-04 look like an outage
        job.retried = true;
        relayState.jobs.set(id, job);
        relayState.backlog.unshift(id);
        relayHandOut();
        return res.json({ ok: true, requeued: true });
      }
      settle(); job.reject(new FmxError('RC_RELAY_' + kind, 502));
    } else if (st !== 200 || !(body && String(body).trim())) {
      // a non-200, or a 200 with nothing in it: rentalcars hiccups like this
      // (500 "{}" and empty 200s were both seen on 2026-09-04) — a bad result
      // for THIS query, not a verdict on the worker's IP
      relayNote(st === 200 ? 'empty 200' : 'HTTP ' + st);
      settle(); job.reject(new FmxError('RC_RELAY_BAD_RESULT', 502));
    } else {
      let parsed = null;
      try {
        const raw = JSON.parse(body);
        parsed = job.parse ? job.parse(raw) : rcParse(raw, job.meta);
      } catch {}
      const good = job.parse ? Array.isArray(parsed) : !!parsed && Array.isArray(parsed.top);
      if (good) { relayState.strikes.delete(job.worker || relayWorkerKey(req)); settle(); job.resolve(parsed); }
      else { relayNote('unparsable 200'); settle(); job.reject(new FmxError('RC_RELAY_BAD_RESULT', 502)); }
    }
  }
  res.json({ ok: true });
});

// ---------- relay installer downloads (operator-cookie-authed) ----------
// deliberately NOT under /api/relay/ (that prefix bypasses operator auth);
// each download embeds CONSOLE_URL + RELAY_SECRET into a script template.

const INSTALLERS = {
  mac: { file: 'install-mac.sh', name: 'install-gm-relay.sh', type: 'text/x-shellscript' },
  // windows ships as a double-clickable .bat: a small cmd header that extracts
  // and runs the PowerShell payload appended after its #GMPS1# marker line
  windows: {
    file: 'install-win.ps1', name: 'install-gm-relay.bat',
    type: 'application/octet-stream', batWrap: 'install-win.bat',
  },
};

app.get(
  '/api/relay-install/:os',
  wrap(async (req, res) => {
    const spec = INSTALLERS[req.params.os];
    if (!spec) throw new FmxError('NOT_FOUND', 404);
    // a cross-site top-level navigation must not force a secret-bearing
    // download into a signed-in operator's Downloads folder
    if ((req.headers['sec-fetch-site'] || '') === 'cross-site')
      throw new FmxError('FORBIDDEN', 403);
    if (!RELAY_SECRET) return res.status(404).json({ error: 'DISABLED' });
    // the secret lands inside bash/JS/PS string literals — one safe charset
    // beats three per-language escaping regimes
    if (!/^[A-Za-z0-9_-]+$/.test(RELAY_SECRET))
      throw new FmxError('RELAY_SECRET_UNSAFE_CHARS', 500);
    // req.protocol is meaningful ONLY locally (no trust proxy is set): in the
    // cloud the installer must always point at the public console URL
    const consoleUrl = store.IS_CLOUD
      ? process.env.CONSOLE_URL || 'https://sentinelpricing.web.app'
      : `${req.protocol}://${req.get('host')}`;
    const tpl = fs.readFileSync(path.join(__dirname, 'relay-clients', spec.file), 'utf8');
    // split/join: each placeholder occurs several times and String.replace
    // with a string pattern only touches the first occurrence
    let out = tpl
      .split('__CONSOLE_URL__').join(consoleUrl)
      .split('__RELAY_SECRET__').join(RELAY_SECRET);
    if (spec.batWrap) {
      // cmd.exe parses its own lines only up to `exit /b`, so the PowerShell
      // payload rides after the marker; the whole file must be CRLF for cmd
      const bat = fs.readFileSync(path.join(__dirname, 'relay-clients', spec.batWrap), 'utf8');
      out = (bat + out).replace(/\r?\n/g, '\r\n');
    }
    res.set('Content-Type', spec.type);
    res.set('Content-Disposition', `attachment; filename="${spec.name}"`);
    res.send(out);
  })
);

/** did this answer come back carrying rentalcars' targeted campaign? */
const rcHasCampaign = (d) => !!(d && (d.top || []).some((x) => x.before != null));

/** The number the wobble actually moves: Green Motion's cheapest price as a
 *  SHOPPER SEES IT — the black number on the card, campaign applied when one is
 *  running. Berkay, 2026-08-29: "asil onemli rakam bu olacak siyah olan,
 *  kirmizi olan indirimsiz fiyati degil." Every comparison the console makes is
 *  on this number; `before` (the struck red one) is display only. */
function rcGmMark(d) {
  const gm = ((d && d.top) || []).filter((x) => /green motion/i.test(x.supplier || ''));
  return gm.length ? Math.min(...gm.map((x) => x.price)) : null;
}

/** Ask the same question a few times and keep the CUSTOMER's view of the market.
 *
 *  rentalcars answers this endpoint two different ways, drawn at random per
 *  request (measured 2026-08-29 for ZRH 10 Sep): either ~200 offers with a -12%
 *  campaign on Green Motion, or ~231 offers with no campaign at all — and the
 *  campaign answer's struck-through price is exactly the clean answer's price
 *  (131.03 either way, 153.03 on the 4-day). Same rate, two presentations.
 *
 *  WHICH shape a real customer sees was settled live on 2026-08-29, eleven
 *  page-loads side by side: every fresh session carried the CAMPAIGN — Safari
 *  incognito (3×), fresh in-app tabs (3×), and a LOGGED-IN booking.com account
 *  (same backend, same -12%, same prices to the franc). The only campaign-free
 *  views came from one stale-cookie browser session that also priced ×1.05
 *  high. The campaign answer IS what the reservation we compete for sees; the
 *  clean answer is the minority/stale segment.
 *
 *  So a campaign-bearing answer wins over clean draws. Only when every draw
 *  comes back clean is the campaign considered genuinely off, and then the
 *  fullest clean catalogue is kept.
 *
 *  A SECOND independent lottery exists on top of the shape: rentalcars serves
 *  two price GENERATIONS concurrently, ~2-3% apart, per request — measured
 *  2026-08-29 twice, each time in the same minute: 13:00/15:00 answers three
 *  seconds apart carried GM list 186.36 and 190.77, and at 16:08 the console
 *  drew list 197.34 while the operator's browser was served 192.00 (exactly
 *  ×1.0278, Unirent moving the OPPOSITE way). So a single campaign draw is not
 *  an answer yet: the sampler takes ONE confirmation draw. Tiers agreeing
 *  (≤1%) settle it at two calls; tiers disagreeing mean both generations are
 *  live RIGHT NOW — then the draw matching the PREVIOUS snapshot's tier wins
 *  (continuity; a real rule change makes both draws agree on the new tier
 *  once rentalcars finishes propagating), else the cheaper one (conservative),
 *  and the footer's `GM ±x%` marker shows the true spread so a mismatch with
 *  any one browser reads as "the market is split", not "the console is wrong".
 *
 *  Do NOT flip this back toward the clean answer (tried 2026-08-29, reverted
 *  the same day: two REFRESHes in a row showed a ladder neither incognito nor
 *  booking.com showed). And do NOT merge the shapes: the clean shape's extra
 *  rows are duplicate trims except ~1 vehicle, and a merged offer count
 *  matches nothing the site ever displays. Only the analysis modal's FRESH
 *  path samples at all; grid scans and sweeps stay at one call per cell.
 */

/** GM's cheapest LIST price — the struck number when a campaign runs, the
 *  plain price otherwise. Identifies which price GENERATION a draw carries,
 *  independent of its campaign presentation. */
function rcGmList(d) {
  const gm = ((d && d.top) || []).filter((x) => /green motion/i.test(x.supplier || ''));
  return gm.length ? Math.min(...gm.map((x) => (x.before != null ? x.before : x.price))) : null;
}

/** same generation = GM list prices within 1% (sub-franc wobble is ~0.3%,
 *  the concurrent generations sit 2-3% apart) */
const rcSameTier = (a, b) => a != null && b != null && Math.abs(a - b) / Math.max(a, b) <= 0.01;

async function rcSampled(fetchOne, want, prevList) {
  const taken = [];
  const campaign = [];
  let firstErr = null;
  for (let i = 0; i < want; i++) {
    try {
      taken.push(await fetchOne());
    } catch (e) {
      if (!taken.length) { firstErr = e; }
      break; // a failed extra sample never fails a query that already answered
    }
    const d = taken[taken.length - 1];
    if (rcHasCampaign(d)) {
      campaign.push(d);
      if (campaign.length >= 2) break; // one confirmation draw is enough
    } else if (!campaign.length && taken.length >= 2) {
      // two agreeing clean draws settle a campaign-free market too — without
      // this, a month with no campaign (December, the promo-free lab) paid
      // all five draws on EVERY fresh query, 15-22s per refresh measured
      // 2026-08-30 morning. Cost of the shortcut: while a campaign runs, two
      // clean same-tier draws in a row (~1.7% of refreshes) end a query early
      // in the clean shape; the next refresh corrects it, and the two-column
      // display keeps even that state honest (LIST == CUSTOMER, no badge).
      const prev = taken[taken.length - 2];
      if (!rcHasCampaign(prev) && rcSameTier(rcGmList(d), rcGmList(prev))) break;
    }
  }
  if (!taken.length) throw firstErr || new FmxError('RC_FETCH_FAILED', 502);

  let winner;
  if (campaign.length >= 2 && !rcSameTier(rcGmList(campaign[0]), rcGmList(campaign[1]))) {
    // both generations are live right now: continuity first, then conservative
    winner =
      campaign.find((d) => rcSameTier(rcGmList(d), prevList)) ||
      campaign.slice().sort((a, b) => (rcGmMark(a) ?? Infinity) - (rcGmMark(b) ?? Infinity))[0];
  } else {
    // agreeing campaign draws (keep the first), or no campaign at all — then
    // the fullest clean catalogue is the best picture of a campaign-free market
    winner = campaign[0] || taken.slice().sort((a, b) => (b.total || 0) - (a.total || 0))[0];
  }

  const marks = taken.map(rcGmMark).filter((v) => typeof v === 'number');
  const lo = marks.length ? Math.min(...marks) : 0;
  const hi = marks.length ? Math.max(...marks) : 0;
  winner.sampled = taken.length;
  winner.offersSeen = taken.map((d) => d.total || 0);
  // how far apart the draws were on the number that matters — 0 means settled
  winner.spread = lo > 0 ? Number((((hi - lo) / lo) * 100).toFixed(1)) : 0;
  return winner;
}

// ---------- rentalcars refusals and the circuit breaker (2026-09-03) ----------
// rentalcars fronts its search API with AWS WAF. When an IP exceeds a rate
// rule the edge answers HTTP 202 with an EMPTY body and `x-amzn-waf-action:
// challenge` — a JavaScript challenge only a browser can pass. Measured on the
// relay's own IP at 11:54 UTC after a morning in which the console had pushed
// 100+ queries a minute through it: every fetch came back 202/empty in 60 ms,
// the server turned each into a 502, the client retried, the relay kept
// fetching, and the IP never went quiet enough for the challenge to lift.
//
// So a refusal now trips a breaker: for RC_BREAKER_MS no rentalcars query is
// dispatched at all — fresh callers get the stale snapshot when there is one
// and a clear RC_CHALLENGED (503, Retry-After) when there is not. Silence is
// the only thing that lifts the challenge.
const RC_BREAKER_MS = 5 * 60 * 1000;
const rcBreaker = { until: 0, kind: null, trips: 0, lastNote: 0 };

/** What a rentalcars answer means, from its status and body alone. */
function rcRefusalKind(status, body) {
  const st = Number(status);
  if (st === 202 && !(body && String(body).trim())) return 'CHALLENGE'; // AWS WAF challenge
  if (st === 403 || st === 405 || st === 429) return 'BLOCKED_' + st;
  return null;
}

function rcTripBreaker(kind, detail) {
  const now = Date.now();
  rcBreaker.until = now + RC_BREAKER_MS;
  rcBreaker.kind = kind;
  rcBreaker.trips++;
  if (now - rcBreaker.lastNote > 30 * 1000) {
    rcBreaker.lastNote = now;
    console.warn(`[rc] breaker tripped (${kind}) — no rentalcars queries for ${RC_BREAKER_MS / 1000}s; ${detail || ''}`);
  }
}
const rcBreakerOpen = () => Date.now() < rcBreaker.until;
const rcBreakerError = () => {
  const e = new FmxError('RC_CHALLENGED', 503);
  e.retryAfter = Math.max(5, Math.ceil((rcBreaker.until - Date.now()) / 1000));
  return e;
};

// one line per minute at most: the direct path's failure reason belongs in the
// logs (it was invisible on 2026-09-03), but a scan must not write 300 of them
let rcDirectNoteAt = 0;
function rcDirectFailureNote(e) {
  const now = Date.now();
  if (now - rcDirectNoteAt < 60 * 1000) return;
  rcDirectNoteAt = now;
  console.warn(`[rc] direct fetch failed: ${e && e.message} status=${e && e.status} blocked=${!!(e && e.blocked)} relayOnline=${relayOnline()}`);
}

async function rcQuery({ station, year, month, day, duration, hh, mm, ttlMs, samples }) {
  if (!stationRc(station)) throw new FmxError('BAD_STATION', 400);
  // hh/mm are part of the key: the modal rotates pickup times, and a 19:00
  // answer must never be served labeled as an 18:30 one. Ordering keeps the
  // /api/rc-invalidate day- and month-prefixes working unchanged.
  const cacheKey = `${station}:${year}-${month}-${day}:${hh}${mm}:${duration}`;
  const hit = rcCache[cacheKey];
  if (hit && Date.now() - hit.ts < ttlMs) return { ...hit.data, cachedAt: hit.ts };
  // the breaker: while rentalcars is refusing the relay's IP, asking again only
  // keeps the refusal alive. Serve what we have, say why when we have nothing.
  if (rcBreakerOpen()) {
    if (hit) return { ...hit.data, cachedAt: hit.ts, stale: true, challenged: true };
    throw rcBreakerError();
  }

  const args = { station, year, month, day, duration, hh, mm };
  // In the cloud the relay IS the path (rentalcars refuses datacenter egress);
  // direct is only for the operator's own machine. Until 2026-09-03 the cloud
  // still tried direct first and handed the query to the relay ONLY when the
  // refusal came back as a 403/405/429 (`blocked`). When rentalcars started
  // dropping the connection instead — a plain `fetch failed`, no status — the
  // relay was skipped and every fresh query died in 20 ms as a 502; the /tmp
  // cache hid it until four deploys in an hour wiped that cache. Now: relay
  // first when it is online; direct only as the last resort; whatever the
  // direct failure looks like, an online relay gets the query.
  // In the cloud the relay layer is the path whenever ANY worker has been seen
  // lately — even if every worker is quarantined right now, a job parked in
  // the backlog can still be picked up by the first healthy poll, and a 90s
  // relay timeout is an honest answer. A direct fetch from a datacenter IP is
  // never going to be served and only trips the global breaker.
  // ...and a freshly booted instance has not been polled yet: for its first
  // two minutes it assumes the relays that were there a moment ago still are,
  // and parks the job for their first poll instead of going direct. Every
  // deploy used to hand a 15-second burst of 503s to whoever was clicking
  // (2026-09-04 10:20:58–10:21:06, sixteen of them, `relayOnline=false`).
  let viaRelay = store.IS_CLOUD && (relayAnyWorkerSeen() || process.uptime() < 120);
  const fetchOne = async () => {
    if (viaRelay) return relayDispatch(args);
    try {
      return await rcFetch(args); // direct — always works from residential IPs
    } catch (e) {
      // only a real refusal trips the breaker — and only when there is no relay
      // at all to hand the query to (the direct path runs in that case alone)
      if (e && e.blocked) rcTripBreaker('BLOCKED_' + e.status, 'direct: ' + e.message + '; workers: ' + relayWorkersNote());
      if (store.IS_CLOUD && relayOnline()) {
        rcDirectFailureNote(e);
        const d = await relayDispatch(args);
        viaRelay = true;
        return d;
      }
      rcDirectFailureNote(e);
      // no relay to fall back on: say which it was, so the operator can tell
      // "rentalcars refused the cloud" from "the relay is not running"
      if (store.IS_CLOUD) throw new FmxError('RC_UNAVAILABLE', 503);
      throw new FmxError(e.message || 'RC_FETCH_FAILED', 502);
    }
  };

  // Cap 5, not 3. Sampling STOPS at the first campaign-bearing answer, so
  // raising the cap costs almost nothing while a campaign runs (~1.2 calls at
  // the observed 6-of-7 rate) while cutting the chance of keeping a clean
  // answer the customer does not see from ~1/7 per refresh to ~(1/7)^5.
  const want = Math.min(Math.max(Number(samples) || 1, 1), 5);
  let data;
  try {
    // the previous snapshot's tier (even if expired) breaks generation ties
    data = await rcSampled(fetchOne, want, hit ? rcGmList(hit.data) : null);
  } catch (err) {
    // fall back to the last snapshot rather than a dead modal
    if (hit) return { ...hit.data, cachedAt: hit.ts, stale: true };
    throw err;
  }

  // Single-sample paths (scan, sweep) get one cheap correction: if the previous
  // snapshot for THIS cell carried the campaign and this answer is the clean
  // shape, ask once more — a scan must not flip a cell into the minority view
  // on a 1-in-7 draw. One retry, only on that contradiction, so nothing gets
  // more expensive in the steady state. (A clean-preferring retry lived here
  // for a few hours on 2026-08-29; it optimised for a stale-cookie session and
  // made the modal disagree with incognito AND booking.com — see rcSampled.)
  if (want === 1 && hit && rcHasCampaign(hit.data) && !rcHasCampaign(data)) {
    try {
      const again = await fetchOne();
      if (rcHasCampaign(again)) data = again; // back to the customer's view
    } catch (_) {
      /* the clean answer stands — a retry failure must never fail a query */
    }
  }
  data.at = Date.now(); // when the answer was actually fetched — clients render it
  rcCache[cacheKey] = { ts: Date.now(), data };
  pruneRcCache();
  saveRcCache();
  return data;
}

// The cache had NO eviction: the scan horizon slides forward daily, past days
// were never touched again but stayed resident forever — unbounded heap growth
// (the 621MiB OOM) and an ever-fatter stringify. Two rules now bound it:
// yesterday is deleted outright, and a hard cap evicts the oldest entries.
// 300, not 1000: a scan day fills this with ~50KB snapshots, and on a 1GiB
// single instance the difference between a ~15MB and a ~50MB cache is the
// difference between smooth GC and stop-the-world pauses that read as 429s
const RC_CACHE_MAX = 300;
let rcPruneCount = 0;

function pruneRcCache() {
  if (++rcPruneCount % 25 !== 0) return; // amortised: a scan of 1000 keys is not free either
  const today = new Date();
  const cutDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const keys = Object.keys(rcCache);
  for (const k of keys) {
    const m = /^\d+:(\d{4})-(\d{1,2})-(\d{1,2}):/.exec(k);
    if (m && new Date(+m[1], +m[2] - 1, +m[3]) < cutDate) delete rcCache[k];
  }
  const left = Object.keys(rcCache);
  if (left.length > RC_CACHE_MAX) {
    left
      .sort((a, b) => (rcCache[a].ts || 0) - (rcCache[b].ts || 0))
      .slice(0, left.length - RC_CACHE_MAX)
      .forEach((k) => delete rcCache[k]);
  }
}

// ---------- capacity guard: the console is ONE instance, so it protects
// itself rather than letting Cloud Run refuse whole page loads ----------
//
// A scan, a sweep and two operators can otherwise pile market queries onto the
// same relay until the event loop is the bottleneck and Cloud Run starts
// aborting UNRELATED requests with its own 429 ("no available instance") —
// which is what the operator experiences as the site crashing. Better to
// refuse ONE market query, with a reason the client can show, than to let the
// console take the whole page down with it.
const rcGuard = {
  live: 0,                 // market queries in flight right now
  max: 6,                  // ceiling — the relay itself only fetches 4 at once
  hits: new Map(),         // uid -> [timestamps], a per-operator burst brake
  windowMs: 60 * 1000,
  perMinute: 120,          // one operator's ceiling per minute
};

function rcGuardTake(req) {
  const uid = (req.operator && req.operator.uid) || 'anon';
  const now = Date.now();
  const list = (rcGuard.hits.get(uid) || []).filter((t) => now - t < rcGuard.windowMs);
  if (list.length >= rcGuard.perMinute) {
    rcGuard.hits.set(uid, list);
    const e = new FmxError('RC_RATE_LIMIT', 429);
    e.retryAfter = Math.ceil((rcGuard.windowMs - (now - list[0])) / 1000);
    throw e;
  }
  if (rcGuard.live >= rcGuard.max) {
    const e = new FmxError('RC_BUSY', 429);
    e.retryAfter = 2;
    throw e;
  }
  list.push(now);
  rcGuard.hits.set(uid, list);
  // The brake's own bookkeeping must be bounded too — a guard that leaks is
  // just a slower version of the problem it exists to prevent. Stale entries
  // go first; if that is not enough, the least-recently-active ones follow.
  if (rcGuard.hits.size > 200) {
    for (const [k, v] of rcGuard.hits)
      if (!v.length || now - v[v.length - 1] > rcGuard.windowMs) rcGuard.hits.delete(k);
    if (rcGuard.hits.size > 200) {
      [...rcGuard.hits.entries()]
        .sort((a, b) => (a[1][a[1].length - 1] || 0) - (b[1][b[1].length - 1] || 0))
        .slice(0, rcGuard.hits.size - 200)
        .forEach(([k]) => rcGuard.hits.delete(k));
    }
  }
  rcGuard.live++;
  return () => { rcGuard.live = Math.max(0, rcGuard.live - 1); };
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
      hh: String(req.query.hh || RC_HOUR).padStart(2, '0'),
      mm: String(req.query.mm || '00').padStart(2, '0'),
      ttlMs:
        req.query.fresh === '1'
          ? 0
          : Math.min(Number(req.query.ttlMin) || 10, 360) * 60 * 1000,
      // only the analysis modal asks for more than one sample, and only when it
      // is taking a FRESH snapshot — sweeps and scans stay at one call per cell
      samples: req.query.samples,
    };
    if (!args.year || !args.month || !args.day || !args.duration)
      throw new FmxError('BAD_PARAMS', 400);
    // a cache hit costs nothing — only real market queries take a slot
    const release = rcGuardTake(req);
    try {
      res.json(await rcQuery(args));
    } finally {
      release();
    }
  })
);

// what the guard is doing right now — the client shows this as a capacity chip
app.get('/api/capacity', (req, res) => {
  const uid = (req.operator && req.operator.uid) || 'anon';
  const now = Date.now();
  const mine = (rcGuard.hits.get(uid) || []).filter((t) => now - t < rcGuard.windowMs);
  res.json({
    live: rcGuard.live,
    max: rcGuard.max,
    usedThisMinute: mine.length,
    perMinute: rcGuard.perMinute,
    busy: rcGuard.live >= rcGuard.max,
    // rentalcars refusing the relay's IP: how long the console is holding off
    challenged: rcBreakerOpen() ? Math.ceil((rcBreaker.until - Date.now()) / 1000) : 0,
    challengeKind: rcBreakerOpen() ? rcBreaker.kind : null,
  });
});

// drop cached rentalcars data for one day (all durations) after an FMX write,
// so the panel's next look at that day is guaranteed fresh. Without a day the
// whole month goes: `61489:2026-1-` cannot match `2026-10-…` (digit after the
// month would have to be '-'), so no cross-month collision.
function rcInvalidate({ station, year, month, day }) {
  const prefix =
    day == null ? `${station}:${year}-${month}-` : `${station}:${year}-${month}-${day}:`;
  let removed = 0;
  for (const k of Object.keys(rcCache)) {
    if (k.startsWith(prefix)) {
      delete rcCache[k];
      removed++;
    }
  }
  saveRcCache();
  return removed;
}

app.post('/api/rc-invalidate', (req, res) => {
  res.json({ ok: true, removed: rcInvalidate(req.body || {}) });
});

/** Drop every cached day of one station — used when its rentalcars location
 *  changes (or the station goes away), because the key only carries the id. */
function rcInvalidateStation(station) {
  const prefix = `${Number(station)}:`;
  let removed = 0;
  for (const k of Object.keys(rcCache)) {
    if (k.startsWith(prefix)) {
      delete rcCache[k];
      removed++;
    }
  }
  saveRcCache();
  return removed;
}

// whole-month GM rank sweep, streamed day by day (6h cache per day)
app.get(
  '/api/rc-month-stream',
  wrap(async (req, res) => {
    const station = Number(req.query.station);
    if (!tenantStations(req).some((x) => x.id === station))
      throw new FmxError('BAD_STATION', 400);
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    const duration = Number(req.query.duration) || 3;
    if (!stationRc(station) || !year || !month) throw new FmxError('BAD_PARAMS', 400);

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
            hh: RC_HOUR, mm: '00', ttlMs: 6 * 60 * 60 * 1000,
          });
          const t1 = r.top[0] || null;
          send('day', {
            day,
            rank: r.gmRank,
            price: r.gmPrice,
            total: r.total,
            currency: r.currency,
            stale: r.stale === true,
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

const parseRuleDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2}) /.exec(s || '');
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
};

// the vehicle-group set's name a console-written rule carries, from the
// `DD-----MM------01-----<dur>-----<label>` name buildRuleBody writes. Null for
// a plain all-groups rule (and for anything FMX's own UI wrote).
const ruleLabel = (name) => {
  const m = /^\d{2}-----\d{2}------01-----\d+-----(.+)$/.exec(String(name || '').trim());
  return m ? m[1].trim() || null : null;
};

// map a station's rules+details to grid cells for one month.
// Only the FIRST gridable rule per cell is kept; pass `dupes` to learn which
// cells had more than one (the grid stream reports those as CONFLICTS and the
// console refuses to write them, so the auto-scan must not write them either).
function shapeCells(rules, getDetail, year, month, dupes, wantLane, allIds) {
  const cells = new Map(); // "day:dur" -> {day, dur, pct, active, ruleid, vendors}
  const perCell = new Map(); // "day:dur" -> [groupIds], for overlap detection
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
    const groupIds = groupIdList(d.vehicleIds);
    const lane = laneKey(groupIds, allIds);
    // Pricing is per vehicle-group set. A caller writing the ECONOMY lane must
    // see the ECONOMY rule on this cell, not whatever rule happened to be read
    // first — otherwise it reads a COMPACT price as "the" current price.
    if (wantLane && lane !== wantLane) continue;
    // overlap, not mere co-existence, is what FMX cannot resolve: two rules
    // covering DIFFERENT groups both apply cleanly, each to its own cars
    const seenHere = perCell.get(k);
    if (seenHere) {
      if (dupes && seenHere.some((g) => groupsOverlap(g, groupIds))) dupes.add(k);
      seenHere.push(groupIds);
    } else perCell.set(k, [groupIds]);
    if (!cells.has(k))
      cells.set(k, {
        day: f.d, dur, pct: Number(d.priceChange), active: d.active,
        ruleid: r.ruleid, vendors: d.vendors || ['ALL'],
        groupIds, // the rule's own group coverage
        lane,
        // the vehicle-group set's name as it stands in FMX. An update REBUILDS
        // the rulename, so without this every rewrite strips the category name
        // the operator created the rule with.
        label: ruleLabel(d.rulename),
        // '=' or '>=': an update also rewrites the operator, and the open
        // bucket can legally sit BELOW 14 (a 1..10 sweep writes '>= 10') — a
        // caller re-pricing that rule must restate '>=' or it silently
        // unprices every longer rental. See applyProposalSet.
        op: d.numDaysOp,
      });
  }
  return cells;
}

// A station whose rule list has run away (duplicate sweeps) can hold many
// thousands of rules, and reading a detail page for each one ties this single
// instance up for minutes. Past this point the sweep is refused instead: the
// console stays responsive and the operator is told to clean the station up
// (Settings -> RESET WEEKLY RULES) rather than watching everything time out.
const DETAIL_SWEEP_CAP = 3000;

async function fetchDetails(rules, onOne) {
  if (rules.length > DETAIL_SWEEP_CAP)
    throw new FmxError('TOO_MANY_RULES_' + rules.length, 507);
  const details = {};
  const q = rules.slice();
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      while (q.length) {
        const r = q.shift();
        try {
          details[r.ruleid] = await fmx.getDetail(r.ruleid, r.updated);
          if (onOne) onOne(true);
        } catch (e) {
          if (e.code === 401) throw e;
          if (onOne) onOne(false);
        }
      }
    })
  );
  return details;
}

// one backup at a time: runBackup outlives a disconnected client, so without
// this an impatient reload + re-click runs two full FMX sweeps concurrently
let backupBusy = false;

// shared by POST /api/backup and GET /api/backup/stream. `send` (optional)
// receives SSE-shaped events: meta / progress (every 10 settled details).
// Failed (non-401) details are counted, not hidden: a snapshot missing rules
// turns them into delete actions at restore time, so it must not look clean.
async function runBackup(send) {
  const snap = { ts: new Date().toISOString(), stations: {} };
  const ruleLists = new Map();
  const stationMeta = [];
  const stationList = tenantStations();
  for (const s of stationList) {
    const rules = await fmx.getRules(s.id);
    ruleLists.set(s.id, rules);
    stationMeta.push({ id: s.id, name: s.name, rules: rules.length });
  }
  const total = stationMeta.reduce((n, s) => n + s.rules, 0);
  if (send) send('meta', { stations: stationMeta, total });
  let done = 0;
  let failed = 0;
  const onOne = (ok) => {
    done++;
    if (!ok) failed++;
    if (send && (done % 10 === 0 || done === total)) send('progress', { done, total });
  };
  for (const s of stationList) {
    const details = await fetchDetails(ruleLists.get(s.id), onOne);
    snap.stations[s.id] = { name: s.name, rules: ruleLists.get(s.id), details };
  }
  snap.failed = failed; // a lossy restore point stays identifiable later
  const file = 'backup-' + snap.ts.replace(/[:.]/g, '-') + '.json';
  await store.backupPut(file, snap);
  // let fmx's trailing 400ms detail-cache debounce fire, then write the fresh
  // details store through durably before the response ends — post-response CPU
  // can be throttled in cloud, which would drop the very cache S3 protects.
  await new Promise((r) => setTimeout(r, 450));
  await store.setNow('details', store.get('details', {}));
  addLog({
    action: 'backup', station: null, stationName: 'ALL STATIONS',
    day: null, month: null, year: null, duration: null,
    before: null, after: null, ok: true, file,
  });
  return {
    file,
    counts: Object.fromEntries(stationList.map((s) => [s.name, snap.stations[s.id].rules.length])),
    failed,
  };
}

app.post(
  '/api/backup',
  wrap(async (req, res) => {
    if (backupBusy) throw new FmxError('BACKUP_RUNNING', 409);
    backupBusy = true;
    let out;
    try {
      out = await runBackup(null);
    } finally {
      backupBusy = false;
    }
    res.json({ ok: true, ...out });
  })
);

/**
 * Delete EVERY console-shaped weekly rule at ONE station.
 *
 * This is the blunt reset for a station whose rule list has grown so large that
 * FuseMetrix starts rejecting requests. It is destructive and admin-only, and
 * it takes a full restore point first so the whole set can be put back.
 *
 * Deliberately narrow: it only removes rules the grid recognises — a single
 * calendar day, a percent price change, no weekday/time conditions. Anything
 * hand-built in FMX (date ranges, weekday rules, fixed prices) is left alone,
 * because this must never quietly delete work the console did not create.
 */
const purgeJobs = new Map(); // jobId -> job
let purgeBusy = false;

app.post(
  '/api/rules/purge',
  wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const station = Number((req.body || {}).station);
    if (!tenantStations(req).some((x) => x.id === station))
      throw new FmxError('BAD_STATION', 400);
    // the operator has to name the station they mean — this cannot be a stray
    // click, and it cannot land on the wrong station. Matching is forgiving
    // about case and spacing: the point is to prove intent, not to make the
    // operator lose to a capital letter while a station is stuck.
    const norm = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (norm((req.body || {}).confirm) !== norm(stationName(station)))
      throw new FmxError('CONFIRM_MISMATCH', 400);
    if (purgeBusy) throw new FmxError('PURGE_RUNNING', 409);
    for (const j of bulkJobs.values())
      if (j.status === 'running') throw new FmxError('BULK_BUSY', 409);

    // Identify targets from the RULE LIST alone. Reading a detail page for each
    // rule would mean thousands of extra FMX round-trips on the very station
    // that is already too big to load — the runaway case this exists for. The
    // list carries everything needed: a console-written rule is named
    // DD-----MM------01-----<dur>[-----LABEL] and covers exactly one day.
    const rules = await fmx.getRules(station);
    const CONSOLE_NAME = /^(\d{2})-----(\d{2})------01-----(\d+)(?:-----(.*))?$/;
    const doomed = [];
    let kept = 0;
    for (const r of rules) {
      const f = parseRuleDate(r.from);
      const t = parseRuleDate(r.to);
      const oneDay = f && t && f.y === t.y && f.mo === t.mo && f.d === t.d;
      const m = CONSOLE_NAME.exec(String(r.name || '').trim());
      // anything hand-built in FMX fails one of these and is left untouched
      if (!oneDay || !m || !DURATIONS.includes(Number(m[3]))) {
        kept++;
        continue;
      }
      doomed.push({ ruleid: r.ruleid, day: f.d, month: f.mo, year: f.y, dur: Number(m[3]) });
    }
    if (!doomed.length) return res.json({ ok: true, deleted: 0, kept, note: 'NOTHING_TO_DELETE' });

    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      batch: 'purge-' + crypto.randomBytes(5).toString('hex'),
      status: 'running', done: 0, total: doomed.length, ok: 0, fail: 0,
      station, tenant: tenantIdOf(req), by: (req.operator && req.operator.u) || null,
      backup: null, backupNote: null, error: null,
      startedAt: new Date().toISOString(), finishedAt: null,
    };
    purgeJobs.set(job.id, job);
    addLog({
      action: 'purge-start', station, stationName: stationName(station),
      day: null, month: null, year: null, duration: null,
      before: null, after: null, ok: true,
      file: `${job.batch} · ${doomed.length} kural`,
    });
    // answer now, delete after: this can take minutes and Hosting cuts at 60s
    // ANSWER FIRST. The old order took the restore point before responding,
    // and on the runaway station that snapshot walk ran past Hosting's 60s
    // cut — the operator saw a 504, refreshed, and the refreshed page piled
    // onto an instance already grinding through thousands of FMX pages.
    // That pile-up WAS the "Rate exceeded" storm.
    res.status(202).json({ ok: true, jobId: job.id, total: doomed.length, kept });

    purgeBusy = true;
    (async () => {
      try {
        // The restore point, now in the background — and scoped to THIS
        // station only (the old full-tenant runBackup walked every station's
        // details; on 6000+ rules that alone was half an hour of FMX pages).
        // Past the detail cap a snapshot is not attemptable at all: the rules
        // are console-written, their names carry day+duration, and the log
        // records the reset — that is the accepted trade for a runaway
        // station, and it is spelled out on the job as backupNote.
        if (doomed.length <= DETAIL_SWEEP_CAP) {
          try {
            const doomedIds = new Set(doomed.map((d) => d.ruleid));
            const doomedRules = rules.filter((r) => doomedIds.has(r.ruleid));
            const details = await fetchDetails(doomedRules);
            const snap = {
              ts: new Date().toISOString(),
              stations: { [station]: { name: stationName(station), rules: doomedRules, details } },
              failed: doomedRules.filter((r) => !details[r.ruleid]).length,
            };
            const file = 'backup-' + snap.ts.replace(/[:.]/g, '-') + '.json';
            await store.backupPut(file, snap);
            job.backup = file;
          } catch (e) {
            job.backupNote = e.message;
            console.log('purge: restore point unavailable —', e.message);
          }
        } else {
          job.backupNote = 'TOO_MANY_RULES_FOR_SNAPSHOT';
        }
        // one request per hundred rules (FMX's own bulk-delete protocol) —
        // a 6000-rule runaway station clears in minutes instead of hours.
        // Per-rule log rows would drown the activity view at this size, so a
        // single collapsed row records the whole reset; the restore point is
        // the undo, not per-row reverts.
        await fmx.deleteRules(
          station,
          doomed.map((d) => d.ruleid),
          (done) => { job.done = done; job.ok = done; }
        );
        job.status = 'done';
      } catch (e) {
        job.status = 'failed';
        job.error = e.message;
        job.fail = job.total - job.done;
      } finally {
        addLog({
          action: 'purge-done', station, stationName: stationName(station),
          day: null, month: null, year: null, duration: null,
          before: null, after: null, ok: job.status === 'done',
          file: `${job.batch} · ${job.ok}/${job.total} silindi · yedek: ${job.backup || (job.backupNote || '—')}${job.error ? ' · ' + job.error : ''}`,
        });
        job.finishedAt = new Date().toISOString();
        purgeBusy = false;
        // every day of this station just changed price — rcInvalidate() needs a
        // year/month to build its prefix, so the station-wide variant is the
        // only correct one here
        rcInvalidateStation(station);
      }
    })();
  })
);

/**
 * Copy every console-written weekly rule from one station to another —
 * Berkay's "paste it onto Downtown as a backup before resetting the Airport"
 * flow. Deliberate caveats, stated in the client confirm as well:
 *   - the target is a LIVE station: these rules price it on rentalcars
 *   - only console-shaped rules travel (single day, percent, no conditions)
 *   - rules land as new creates; anything already at the target stays put
 */
const copyJobs = new Map();
let copyBusy = false;

app.post(
  '/api/rules/copy',
  wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const from = Number((req.body || {}).from);
    const to = Number((req.body || {}).to);
    const mine = tenantStations(req);
    if (!mine.some((x) => x.id === from) || !mine.some((x) => x.id === to) || from === to)
      throw new FmxError('BAD_STATION', 400);
    if (copyBusy || purgeBusy) throw new FmxError('COPY_RUNNING', 409);
    for (const j of bulkJobs.values())
      if (j.status === 'running') throw new FmxError('BULK_BUSY', 409);

    const rules = await fmx.getRules(from);
    const CONSOLE_NAME = /^(\d{2})-----(\d{2})------01-----(\d+)(?:-----(.*))?$/;
    const picked = [];
    for (const r of rules) {
      const f = parseRuleDate(r.from);
      const t = parseRuleDate(r.to);
      const oneDay = f && t && f.y === t.y && f.mo === t.mo && f.d === t.d;
      const m = CONSOLE_NAME.exec(String(r.name || '').trim());
      if (oneDay && m && DURATIONS.includes(Number(m[3])))
        picked.push({ r, day: f.d, month: f.mo, year: f.y, dur: Number(m[3]), label: m[4] ? m[4].trim() : null });
    }
    if (!picked.length) return res.json({ ok: true, copied: 0, note: 'NOTHING_TO_COPY' });
    // the copy needs each rule's percent, which lives on the detail page — the
    // sweep cap protects the instance from doing this on a runaway station
    if (picked.length > DETAIL_SWEEP_CAP) throw new FmxError('TOO_MANY_RULES_' + picked.length, 507);

    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      status: 'running', done: 0, total: picked.length, ok: 0, fail: 0,
      from, to, tenant: tenantIdOf(req), error: null,
      startedAt: new Date().toISOString(), finishedAt: null,
    };
    copyJobs.set(job.id, job);
    addLog({
      action: 'copy-start', station: from, stationName: stationName(from),
      day: null, month: null, year: null, duration: null,
      before: null, after: null, ok: true,
      file: `${picked.length} kural -> ${stationName(to)}`,
    });
    res.status(202).json({ ok: true, jobId: job.id, total: picked.length });

    copyBusy = true;
    (async () => {
      try {
        const details = await fetchDetails(picked.map((p) => p.r));
        for (const it of picked) {
          const d = details[it.r.ruleid];
          try {
            if (!d) throw new FmxError('DETAIL_UNREADABLE', 502);
            await fmx.createRule(to, {
              day: it.day, month: it.month, year: it.year, duration: it.dur,
              pct: Number(d.priceChange),
              active: d.active !== false,
              vendors: d.vendors && d.vendors.length ? d.vendors : ['ALL'],
              vehicleIds: null, // target station has its own groups — ALL is the only safe coverage
              groupLabel: it.label,
            });
            job.ok++;
          } catch (e) {
            if (e.code === 401) throw e;
            job.fail++;
          } finally {
            job.done++;
          }
        }
        job.status = 'done';
      } catch (e) {
        job.status = 'failed';
        job.error = e.message;
      } finally {
        addLog({
          action: 'copy-done', station: to, stationName: stationName(to),
          day: null, month: null, year: null, duration: null,
          before: null, after: null, ok: job.status === 'done',
          file: `${job.ok}/${job.total} kural kopyalandı${job.error ? ' · ' + job.error : ''}`,
        });
        job.finishedAt = new Date().toISOString();
        copyBusy = false;
        rcInvalidateStation(to);
      }
    })();
  })
);

app.get(
  '/api/rules/copy/:jobId',
  wrap(async (req, res) => {
    const job = copyJobs.get(String(req.params.jobId || ''));
    if (!job || job.tenant !== tenantIdOf(req)) throw new FmxError('NO_SUCH_JOB', 404);
    res.json({
      jobId: job.id, status: job.status, done: job.done, total: job.total,
      ok: job.ok, fail: job.fail, error: job.error,
    });
  })
);

app.get(
  '/api/rules/purge/:jobId',
  wrap(async (req, res) => {
    const job = purgeJobs.get(String(req.params.jobId || ''));
    if (!job || job.tenant !== tenantIdOf(req)) throw new FmxError('NO_SUCH_JOB', 404);
    res.json({
      jobId: job.id, status: job.status, done: job.done, total: job.total,
      ok: job.ok, fail: job.fail, backup: job.backup, backupNote: job.backupNote, error: job.error,
      startedAt: job.startedAt, finishedAt: job.finishedAt,
    });
  })
);

// same backup, but with live progress for the panel (EventSource sends the
// operator cookie, so the standard /api middleware already guards this)
app.get(
  '/api/backup/stream',
  wrap(async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    if (backupBusy) {
      send('fail', { error: 'BACKUP_RUNNING' });
      return res.end();
    }
    backupBusy = true;
    try {
      send('done', await runBackup(send));
    } catch (e) {
      send('fail', { error: e.message });
    } finally {
      backupBusy = false;
    }
    res.end();
  })
);

app.get(
  '/api/backups',
  wrap(async (req, res) => {
    res.json({ backups: await store.backupList() });
  })
);

app.post(
  '/api/restore',
  wrap(async (req, res) => {
    const { file, station, year, month, dryRun } = req.body;
    if (!tenantStations(req).some((s) => s.id === Number(station)))
      throw new FmxError('BAD_STATION', 400);
    const snap = await store.backupGet(file);
    if (!snap) throw new FmxError('BACKUP_NOT_FOUND', 404);
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

// one bulk sweep writes up to 900 rows (180 days x 5 durations), so the history
// must be deep enough to hold a whole batch AND what came before it — at ~270B
// per row this still fits the 1MiB Firestore doc the `logs` key lives in
// one sweep can now write 180 days x 14 durations = 2520 rows, and REVERT ALL
// can only undo what the log still holds — keep comfortably above a full sweep
const LOG_MAX = 6000;

function addLog(entry) {
  activityLog.unshift({
    ts: new Date().toISOString(),
    user: fmx.username || 'session',
    ...entry,
  });
  if (activityLog.length > LOG_MAX) activityLog.length = LOG_MAX;
  store.set('logs', activityLog, { debounceMs: 250 });
}

const stationName = (id) => {
  const s = tenantStations().find((x) => x.id === Number(id));
  return s ? s.name : String(id);
};

// `?batch=<id>` returns every row of that batch, however long the sweep was:
// REVERT ALL must undo the whole thing, not the part that fit on the page.
// Otherwise: one page, plus the true size of each batch it can see, so the
// collapsed row and the REVERT ALL confirm count the sweep, not the slice.
app.get('/api/logs', (req, res) => {
  const batch = String(req.query.batch || '');
  if (batch) return res.json({ logs: activityLog.filter((l) => l.batch === batch) });
  const logs = activityLog.slice(0, Number(req.query.limit) || 200);
  const batchTotals = {};
  for (const l of logs) if (l.batch) batchTotals[l.batch] = { n: 0, ok: 0 };
  for (const l of activityLog) {
    const b = l.batch ? batchTotals[l.batch] : null;
    if (b) {
      b.n++;
      if (l.ok) b.ok++;
    }
  }
  res.json({ logs, batchTotals });
});

// ---------- grid (streamed via SSE: cells appear as they resolve) ----------

app.get(
  '/api/grid/stream',
  wrap(async (req, res) => {
    const station = Number(req.query.station);
    if (!tenantStations(req).some((x) => x.id === station))
      throw new FmxError('BAD_STATION', 400);
    const year = Number(req.query.year);
    const month = Number(req.query.month); // 1-12
    if (!tenantStations(req).some((s) => s.id === station))
      throw new FmxError('BAD_STATION', 400);
    if (!year || !month) throw new FmxError('BAD_DATE', 400);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (ev, data) =>
      res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      // While a station reset (or copy) is running, the rule list is a moving
      // target and walking it floods the FMX queue the deletion is using —
      // this is exactly what a mid-purge page refresh used to do, and the
      // resulting pile-up starved the single instance into 429s.
      if (purgeBusy || copyBusy) {
        send('fail', { error: 'PURGE_RUNNING', code: 'PURGE_RUNNING' });
        return res.end();
      }
      const rules = await fmx.getRules(station);
      // needed to fold the three shapes of "every group" into one lane key
      const allIds = (await fmx.getVehicleGroups().catch(() => [])).map((g) => g.id);
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

      // a runaway station (thousands of duplicate rules) cannot be streamed:
      // one detail page per rule would occupy this instance for half an hour.
      // Tell the operator to reset it instead of quietly drowning.
      if (candidates.length > DETAIL_SWEEP_CAP) {
        send('fail', { error: 'TOO_MANY_RULES_' + candidates.length, code: 'TOO_MANY_RULES' });
        return res.end();
      }
      send('meta', {
        totalRules: rules.length,
        pending: candidates.map((c) => ({ day: c.day, ruleid: c.r.ruleid })),
        others,
      });

      // details stream out as each one resolves; cached ones burst instantly
      const seen = new Map(); // "day:dur" -> [{ruleid, groupIds}]
      const laneIndex = new Map(); // laneKey -> { lane, label, groupIds, cells }
      const ruleInfo = new Map(); // ruleid -> { pct, label, active } — names a conflict's parties
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
            // which vehicle groups this rule governs — pricing is per group set
            // now, so this is what separates one price lane from another
            const groupIds = groupIdList(detail.vehicleIds);
            if (!seen.has(k)) seen.set(k, []);
            seen.get(k).push({ ruleid: item.r.ruleid, groupIds });
            ruleInfo.set(item.r.ruleid, {
              pct: Number(detail.priceChange),
              label: ruleLabel(detail.rulename),
              active: detail.active,
            });
            const lk = laneKey(groupIds, allIds);
            const lane = laneIndex.get(lk) || { lane: lk, label: null, groupIds, cells: 0 };
            lane.cells++;
            // the first rule that carries a name defines the lane's label; a
            // rule written outside the console has none and stays unnamed
            if (!lane.label) lane.label = ruleLabel(detail.rulename);
            laneIndex.set(lk, lane);
            send('cell', {
              day: item.day,
              dur,
              ruleid: item.r.ruleid,
              name: detail.rulename,
              // the vehicle-group set's own name, so the console can label the
              // lane with what the operator called it
              label: ruleLabel(detail.rulename),
              lane: laneKey(groupIds, allIds),
              pct: Number(detail.priceChange),
              active: detail.active,
              op: detail.numDaysOp,
              // judged later, once the month's real open bucket is known —
              // a station priced only up to 9 has `>= 9`, not `>= 14`
              numDaysOp: detail.numDaysOp,
              vendors: detail.vendors,
              groups: groupIds.length,
              groupIds,
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

      // Two rules on the same day+duration are only a CONFLICT when their
      // vehicle-group sets OVERLAP — then FMX has two candidate prices for the
      // same car and picks one unpredictably. Rules covering DIFFERENT groups
      // (economy vs compact) are the normal per-category setup, not a clash,
      // and used to be rejected as conflicts by this very check.
      const conflicts = [];
      const keys = [];
      for (const [k, list] of seen) {
        const [day, dur] = k.split(':').map(Number);
        for (const it of list) keys.push(`${k}:${laneKey(it.groupIds, allIds)}`);
        const clashing = new Set();
        const clashLanes = new Set();
        for (let i = 0; i < list.length; i++)
          for (let j = i + 1; j < list.length; j++)
            if (groupsOverlap(list[i].groupIds, list[j].groupIds)) {
              clashing.add(list[i].ruleid);
              clashing.add(list[j].ruleid);
              clashLanes.add(laneKey(list[i].groupIds, allIds));
              clashLanes.add(laneKey(list[j].groupIds, allIds));
            }
        // a clash can span two lanes (overlapping but not identical coverage),
        // so the console blocks the cell in every lane that is party to it
        if (clashing.size)
          conflicts.push({
            day, dur, ruleids: [...clashing], lanes: [...clashLanes],
            // who the parties are, so the console can offer "keep this one"
            rules: [...clashing].map((id) => ({ ruleid: id, ...(ruleInfo.get(id) || {}) })),
          });
      }
      // every distinct group set seen this month, so the console can offer one
      // price lane per set with the name the operator gave it
      const lanes = [...laneIndex.values()].sort((a, b) => b.cells - a.cells);
      send('done', { keys, conflicts, lanes });
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

// optional batch markers (SCAN sweeps, auto-scan proposal sets) — validated or
// silently dropped. The activity log collapses one batch into a REVERT ALL row.
const BATCH_TAGS = ['scan', 'autoscan', 'bulk'];
const batchFields = (src) => {
  const out = {};
  if (typeof src.batch === 'string' && /^[a-z0-9-]{1,32}$/i.test(src.batch)) out.batch = src.batch;
  if (BATCH_TAGS.includes(src.batchTag)) out.batchTag = src.batchTag;
  return out;
};

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
  // optional vehicle-group subset; null = every group (unchanged behaviour)
  vehicleIds:
    Array.isArray(body.vehicleIds) && body.vehicleIds.length
      ? body.vehicleIds.map(String)
      : null,
  // the saved set's name, written into the FMX rule name (sanitised there)
  groupLabel: body.groupName ? String(body.groupName) : null,
  // the open-ended bucket for THIS station/month — the caller knows which
  // duration is the longest one priced; absent means the console's own ceiling
  openDuration: DURATIONS.includes(Number(body.openDuration))
    ? Number(body.openDuration)
    : undefined,
});

/** Check a requested vehicle-group subset against the ids FMX actually offers,
 *  before anything is logged or written. null (= all groups) passes through. */
async function checkVehicleGroups(list) {
  if (!list) return null;
  const known = new Set((await fmx.getVehicleGroups()).map((g) => g.id));
  const out = [...new Set(list.map((v) => String(v).trim()))];
  if (!out.length || out.some((v) => !known.has(v)))
    throw new FmxError('BAD_VEHICLE_GROUP', 400);
  return out;
}

// how a write's group coverage reads in the activity log
const groupsField = (ids) => (ids && ids.length ? ids.length : 'ALL');
// the `vehicleIds` a rule detail carries, as a plain list of group ids. Rules
// written before this sprint may still carry the form's "(select all)" pseudo
// id — it is not a group, so it must not count towards the coverage either.
const groupIdList = (s) =>
  String(s || '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => /^\d+$/.test(v) && v !== '999999');
/** A price LANE is one vehicle-group set. Pricing is per group set now (economy
 *  rules and compact rules coexist on the same day+duration), so this key is
 *  what separates one lane from another.
 *
 *  "Every group" reaches us in three different shapes — an absent list, FMX's
 *  own "(select all)" pseudo-id (which groupIdList strips to nothing), and the
 *  full 39 ids the console writes — so all three MUST fold to the same key or
 *  an all-groups sweep would stop recognising its own rules. */
const laneKey = (ids, allIds) => {
  const list = [...new Set((ids || []).map(String))];
  if (!list.length) return 'ALL';
  if (allIds && allIds.length && allIds.every((a) => list.includes(String(a)))) return 'ALL';
  return list.sort((a, b) => Number(a) - Number(b)).join(',');
};

/** Do two coverages share at least one vehicle group? Overlapping sets are a
 *  real FMX conflict (two candidate prices for one car); disjoint sets are the
 *  normal per-category setup. An empty set means ALL groups, so it overlaps
 *  everything. */
const groupsOverlap = (a, b) => {
  if (!a || !a.length || !b || !b.length) return true; // one of them covers all
  const s = new Set(a.map(String));
  return b.some((v) => s.has(String(v)));
};

// do two coverages name the same groups? (order and duplicates are irrelevant)
const sameGroups = (a, b) => {
  const x = new Set(a || []);
  const y = new Set(b || []);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

app.post(
  '/api/rule',
  wrap(async (req, res) => {
    const station = Number(req.body.station);
    if (!tenantStations(req).some((x) => x.id === station))
      throw new FmxError('BAD_STATION', 400);
    const args = ruleArgs(req.body);
    if (!DURATIONS.includes(args.duration))
      throw new FmxError('BAD_DURATION', 400);
    if (!isFinite(args.pct)) throw new FmxError('BAD_PCT', 400);
    args.vehicleIds = await checkVehicleGroups(args.vehicleIds);
    const base = {
      action: 'create', station, stationName: stationName(station),
      day: args.day, month: args.month, year: args.year,
      duration: args.duration, before: null, after: args.pct,
      vendor: args.vendors.join(','), groups: groupsField(args.vehicleIds),
      ...batchFields(req.body),
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
    if (!tenantStations(req).some((x) => x.id === station))
      throw new FmxError('BAD_STATION', 400);
    const ruleid = Number(req.params.id);
    const args = ruleArgs(req.body);
    if (!isFinite(args.pct)) throw new FmxError('BAD_PCT', 400);
    args.vehicleIds = await checkVehicleGroups(args.vehicleIds);
    // An FMX update REWRITES the rule's group coverage and rebuilds its name.
    // A caller that says nothing about coverage means "leave it alone" — before
    // this, such an update silently widened a category rule to all 39 groups
    // and stripped the category name out of its title.
    if (!Array.isArray(req.body.vehicleIds)) {
      const live = await fmx.getDetail(ruleid).catch(() => null);
      if (live) {
        const ids = groupIdList(live.vehicleIds);
        if (ids.length) args.vehicleIds = ids;
        if (args.groupLabel == null) args.groupLabel = ruleLabel(live.rulename);
        // Re-pricing must not silently change WHICH rentals a rule covers.
        // If this rule is already the open bucket (`>=`), keep it open; the
        // caller only asked to change the percentage.
        if (args.openDuration === undefined && live.numDaysOp === '>=')
          args.openDuration = args.duration;
      }
    }
    const before = req.body.prevPct != null ? Number(req.body.prevPct) : null;
    const base = {
      action: 'update', station, stationName: stationName(station),
      day: args.day, month: args.month, year: args.year,
      duration: args.duration, before, after: args.pct, ruleid,
      vendor: args.vendors.join(','), groups: groupsField(args.vehicleIds),
      ...batchFields(req.body),
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
    if (!tenantStations(req).some((x) => x.id === station))
      throw new FmxError('BAD_STATION', 400);
    const q = req.query;
    const base = {
      action: 'delete', station, stationName: stationName(station),
      day: Number(q.day) || null, month: Number(q.month) || null,
      year: Number(q.year) || null, duration: Number(q.duration) || null,
      before: q.prevPct != null ? Number(q.prevPct) : null, after: null,
      ruleid: Number(req.params.id),
      ...batchFields(q),
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

// ---------- the rules list + bulk delete (Berkay, 2026-08-30) ----------
// The DELETE side of the weekly-rules split: the operator sees the station's
// FULL rule list exactly as the supplier system shows it, shift-selects a
// range and deletes it. The list is the raw list page (name/active/from/to/
// updated) — no per-rule detail reads, so an 840-rule station answers in one
// round trip.

app.get(
  '/api/rules-list',
  wrap(async (req, res) => {
    const station = Number(req.query.station);
    if (!tenantStations(req).some((x) => x.id === station))
      throw new FmxError('BAD_STATION', 400);
    const rules = await fmx.getRules(station);
    res.json({ rules });
  })
);

app.post(
  '/api/rules-delete',
  wrap(async (req, res) => {
    const station = Number((req.body || {}).station);
    if (!tenantStations(req).some((x) => x.id === station))
      throw new FmxError('BAD_STATION', 400);
    const ids = [
      ...new Set(
        (Array.isArray(req.body.ruleids) ? req.body.ruleids : [])
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0)
      ),
    ];
    if (!ids.length) throw new FmxError('NO_RULES', 400);
    // the modal is for pruning ranges, not resetting stations — that flow
    // (confirm-by-name, restore point, purge job) lives on RESET's successor
    if (ids.length > 500) throw new FmxError('TOO_MANY_RULES', 400);
    const base = {
      action: 'bulk-delete', station, stationName: stationName(station),
      day: null, month: null, year: null, duration: null,
      before: null, after: null,
    };
    try {
      const r = await fmx.deleteRules(station, ids, () => {});
      addLog({ ...base, ok: true, file: `${r.deleted} kural listeden silindi` });
      // every one of those days just lost its price rule — all cached market
      // answers for the station are stale now
      rcInvalidateStation(station);
      res.json({ ok: true, deleted: r.deleted });
    } catch (e) {
      addLog({ ...base, ok: false, error: e.message });
      throw e;
    }
  })
);

// ---------- bulk weekly-rule creation ----------
// "Give every day of the next N days a rule at X%": hundreds of FMX writes, so
// the POST only starts a background job and answers with its id; the console
// polls the job for progress and can cancel it. Jobs live in memory — the
// console runs as a single instance (maxInstances: 1) — and the last 5 are kept.

const BULK_DAY_OPTIONS = [30, 60, 90, 120, 180];
// an explicit end date may sit anywhere inside this span (the chips are shortcuts)
const BULK_MAX_DAYS = 400;
// hard ceiling on one sweep so its rows always fit in the activity log
// (and therefore stay revertable in one click)
const BULK_MAX_CELLS = 4000;

/** Inclusive calendar-day count between two YYYY-MM-DD dates, UTC-safe. */
function daysBetween(startDate, endDate) {
  const parse = (v, err) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
    if (!m) throw new FmxError(err, 400);
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() + 1 !== mo || t.getUTCDate() !== d)
      throw new FmxError(err, 400);
    return t.getTime();
  };
  const a = parse(startDate, 'BAD_START_DATE');
  const z = parse(endDate, 'BAD_END_DATE');
  if (z < a) throw new FmxError('END_BEFORE_START', 400);
  return Math.round((z - a) / 86400000) + 1; // inclusive of both ends
}
const BULK_MAX_JOBS = 5;
const BULK_MAX_MONTHS_AHEAD = 24;
const bulkJobs = new Map(); // jobId -> job

/**
 * The calendar walk. Every date is built with `Date.UTC` and read back with
 * getUTC*, so a month length or a DST jump can never shift a day — the same
 * walk runs in the browser for the preview, and the two must agree exactly.
 * `days` counts calendar days INCLUDING startDate.
 */
function bulkDays(startDate, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startDate || ''));
  if (!m) throw new FmxError('BAD_START_DATE', 400);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const first = new Date(Date.UTC(y, mo - 1, d));
  // an impossible date (2026-02-30) overflows into the next month, so it reads
  // back as something else — that is the rejection
  if (
    first.getUTCFullYear() !== y ||
    first.getUTCMonth() + 1 !== mo ||
    first.getUTCDate() !== d
  )
    throw new FmxError('BAD_START_DATE', 400);
  const now = new Date();
  const limit = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + BULK_MAX_MONTHS_AHEAD,
    now.getUTCDate()
  );
  if (first.getTime() > limit) throw new FmxError('START_DATE_TOO_FAR', 400);
  const out = [];
  for (let i = 0; i < days; i++) {
    const dt = new Date(Date.UTC(y, mo - 1, d + i)); // day overflow rolls the month
    out.push({
      year: dt.getUTCFullYear(),
      month: dt.getUTCMonth() + 1,
      day: dt.getUTCDate(),
    });
  }
  return out;
}

const bulkStatus = (job) => ({
  jobId: job.id,
  status: job.status,
  done: job.done,
  total: job.total,
  ok: job.ok,
  fail: job.fail,
  skipped: job.skipped,
  // cells left alone because the rule there covers a different set of groups
  skippedCoverage: job.skippedCoverage,
  batch: job.batch,
  error: job.error,
  cancelled: job.cancelled,
  station: job.station,
  from: job.from,
  to: job.to,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
});

/** Walk day x duration through the console's own verified-write path, logging
 *  every write under one batch id so the Activity view offers REVERT ALL. */
async function runBulkJob(job, opts, deadline) {
  // the coverage an 'all groups' write actually produces, for the guard below
  const allGroupIds = (await fmx.getVehicleGroups()).map((g) => g.id);
  const grid = newGridCache();
  const touched = new Map();
  // rules this run wrote — re-stamped in one list request at the end so the
  // next sync reads them from cache instead of re-downloading every page
  const wrote = new Set();
  // flattened once so a resume (after an instance recycle) is a plain index
  // into one list, not two nested cursors
  const cells = opts.dayList.flatMap((d) => opts.durations.map((duration) => ({ d, duration })));
  let lastCheckpoint = Date.now();
  let paused = false; // ran out of this run's time slice, not actually done
  // "in bulkJobs" is not the same as "running right now": a sweep that paused
  // on a tick boundary sits in the map with status 'running' until the next
  // tick picks it up. Without this flag the resume treated it as already alive
  // and skipped it forever, stalling the sweep at whatever cell it reached.
  job.active = true;
  try {
    for (let idx = job.cursor || 0; idx < cells.length; idx++) {
      if (job.cancel) {
        job.cancelled = true;
        break;
      }
      // a bounded resume (driven by the scheduler tick) must hand control back
      // before its own slice of the tick's budget runs out, not run to completion
      if (deadline && Date.now() >= deadline) {
        job.cursor = idx;
        paused = true;
        console.log(`bulk ${job.id}: paused at ${idx}/${cells.length} (out of tick budget)`);
        break;
      }
      const { d, duration } = cells[idx];
      const base = {
        action: 'create', station: opts.station,
        stationName: stationName(opts.station),
        day: d.day, month: d.month, year: d.year, duration,
        before: null, after: opts.pct,
        vendor: (opts.vendors || ['ALL']).join(','),
        groups: groupsField(opts.vehicleIds),
        // the exact coverage written, so a revert can put it back
        groupIds: opts.vehicleIds || null,
        batch: job.batch, batchTag: 'bulk',
      };
      try {
        // read only the lane this sweep writes: an economy sweep must not see a
        // compact rule as "the" rule on this cell (it used to, and then skipped
        // the cell as a coverage mismatch — so a second category could never be
        // priced once the first one existed)
        const cg = await stationCells(opts.station, d.year, d.month, grid, opts.lane);
        const ckey = `${d.day}:${duration}`;
        // two gridable rules already govern this cell: FMX decides which one
        // serves the price, so the console never writes it — nor does this
        if (cg.conflicts.has(ckey)) {
          job.skipped++;
          continue;
        }
        const cell = cg.cells.get(ckey);
        if (cell && opts.skipExisting) {
          job.skipped++;
          continue;
        }
        // an update REWRITES the rule's vehicleIds, so any sweep whose
        // coverage differs from the rule already there would silently
        // rewrite it (a subset sweep strips 39 -> 3; an ALL sweep widens
        // 3 -> 39) with no way back. Either direction: leave the cell alone.
        if (cell && !sameGroups(cell.groupIds, opts.vehicleIds || allGroupIds)) {
          job.skippedCoverage++;
          continue;
        }
        const args = {
          day: d.day, month: d.month, year: d.year, duration, pct: opts.pct,
          openDuration: opts.openDuration,
          // an existing rule keeps its activation state, a new one starts active
          active: cell ? cell.active !== false : true,
          vendors: opts.vendors || (cell && cell.vendors) || ['ALL'],
          vehicleIds: opts.vehicleIds,
          groupLabel: opts.groupName,
        };
        base.vendor = args.vendors.join(',');
        if (cell) {
          // skipExisting off: re-price the rule that is already there rather
          // than adding a second one, which would conflict the cell
          base.action = 'update';
          base.before = cell.pct;
          const r = await fmx.updateRule(opts.station, cell.ruleid, args);
          addLog({ ...base, ruleid: cell.ruleid, ok: true, verified: r.verified });
          wrote.add(cell.ruleid);
        } else {
          const r = await fmx.createRule(opts.station, args);
          addLog({ ...base, ruleid: r.ruleid, ok: true, verified: r.verified });
          if (r.ruleid) wrote.add(r.ruleid);
        }
        job.ok++;
        touched.set(`${opts.station}:${d.year}-${d.month}-${d.day}`, {
          station: opts.station, year: d.year, month: d.month, day: d.day,
        });
      } catch (e) {
        // a dead FMX session fails every remaining write — stop the job
        // instead of logging hundreds of identical failures
        if (e.code === 401) throw e;
        addLog({ ...base, ok: false, error: e.message });
        job.fail++;
      } finally {
        job.done++;
      }
      job.cursor = idx + 1;
      // durable checkpoint at most every 15s: if this process is recycled
      // mid-sweep (Cloud Run can throttle CPU once a request has responded),
      // the scheduler tick resumes from here instead of losing the sweep
      if (Date.now() - lastCheckpoint > 15000) {
        lastCheckpoint = Date.now();
        persistBulkJob(job, opts);
      }
    }
    if (!paused) job.status = 'done';
  } catch (e) {
    job.status = 'failed';
    job.error = e.message;
  } finally {
    // Every rule we just wrote was re-read to verify it, but cached WITHOUT the
    // list's "Date Updated" stamp — so the next grid sync would miss on all of
    // them and re-download hundreds of pages it already had. One list request
    // re-validates the whole batch instead. Best-effort: a failure here only
    // costs the old behaviour, so it must never fail the sweep.
    if (wrote.size) {
      try {
        const n = await fmx.restampWritten(opts.station, [...wrote]);
        if (n) console.log(`sync: re-stamped ${n} detail entries after the sweep`);
      } catch (e) {
        console.log('sync: re-stamp after sweep failed:', e.message);
      }
    }
    // the panel's next look at those days must not read pre-write prices
    for (const t of touched.values()) rcInvalidate(t);
    if (!paused) job.finishedAt = new Date().toISOString();
    job.active = false;
    // terminal (done/failed/cancelled): clears the durable checkpoint.
    // paused (deadline hit, still 'running'): writes the latest cursor.
    persistBulkJob(job, opts);
  }
}

/** Durable checkpoint for a running bulk job, so a lost in-memory job (the
 *  process that started it was recycled) can be resumed by the next tick
 *  instead of leaving a half-applied sweep with no way to finish or revert. */
function persistBulkJob(job, opts) {
  if (job.status === 'running' && !job.cancel) {
    watchBase.__bulkJob = {
      job: {
        id: job.id, batch: job.batch, status: job.status,
        done: job.done, total: job.total, ok: job.ok, fail: job.fail,
        skipped: job.skipped, skippedCoverage: job.skippedCoverage,
        cursor: job.cursor || 0, error: job.error, cancel: job.cancel,
        cancelled: job.cancelled, station: job.station, tenant: job.tenant,
        by: job.by, from: job.from, to: job.to, startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      },
      opts: {
        station: opts.station, dayList: opts.dayList, durations: opts.durations,
        pct: opts.pct, vehicleIds: opts.vehicleIds, vendors: opts.vendors,
        openDuration: opts.openDuration,
        lane: opts.lane, groupName: opts.groupName, skipExisting: opts.skipExisting,
      },
    };
  } else if (watchBase.__bulkJob && watchBase.__bulkJob.job.id === job.id) {
    delete watchBase.__bulkJob;
  }
  saveWatchBase();
}

let bulkResuming = false; // in-process guard: at most one resume attempt at a time

/** Called every tick: if a bulk job's process died mid-sweep, pick it back up
 *  from its durable checkpoint. No-op when the job is still alive in this
 *  process (bulkJobs still has it) or nothing was left running. */
async function resumeBulkJobIfLost(deadline) {
  const saved = watchBase.__bulkJob;
  if (!saved || bulkResuming) return false;
  const live = bulkJobs.get(saved.job.id);
  // only a sweep that is EXECUTING right now is left alone. One that merely
  // exists in the map is either from a dead process (nothing in memory) or
  // paused between ticks — both need picking up.
  if (live && live.active) return false;
  if (Date.now() >= deadline) return false;
  bulkResuming = true;
  try {
    // carry the in-memory job forward when there is one, so its counters and
    // id stay continuous for whoever is polling it
    const job = live || { ...saved.job };
    job.status = 'running';
    bulkJobs.set(job.id, job);
    await runBulkJob(job, saved.opts, deadline);
    return true;
  } finally {
    bulkResuming = false;
  }
}

app.post(
  '/api/rules/bulk',
  wrap(async (req, res) => {
    const b = req.body || {};
    const station = Number(b.station);
    // tenant scoping: an operator may only bulk-write their own franchise
    if (!tenantStations(req).some((s) => s.id === station))
      throw new FmxError('BAD_STATION', 400);
    // horizon chip OR an explicit end date — the range wins when both arrive
    let days;
    if (b.endDate) {
      days = daysBetween(b.startDate, b.endDate); // throws on a bad/reversed range
      if (days > BULK_MAX_DAYS) throw new FmxError('RANGE_TOO_LONG', 400);
    } else {
      days = Number(b.days);
      if (!BULK_DAY_OPTIONS.includes(days)) throw new FmxError('BAD_DAYS', 400);
    }
    // DESCENDING: FMX lists rules oldest-first, so writing the longest bucket
    // first puts the open bucket at the top of a day's block and 1 at the bottom
    const durations = Array.isArray(b.durations)
      ? [...new Set(b.durations.map(Number))].sort((x, y) => y - x)
      : [];
    if (!durations.length || durations.some((d) => !DURATIONS.includes(d)))
      throw new FmxError('BAD_DURATION', 400);
    const pct = Number(b.pct);
    if (!isFinite(pct) || pct < -95 || pct > 100) throw new FmxError('BAD_PCT', 400);
    const vehicleIds = await checkVehicleGroups(
      Array.isArray(b.vehicleIds) && b.vehicleIds.length ? b.vehicleIds.map(String) : null
    );
    // the sweep's own lane, normalised the same way the rules it reads are
    const sweepLane = laneKey(vehicleIds, (await fmx.getVehicleGroups()).map((g) => g.id));
    const vendors =
      Array.isArray(b.vendors) && b.vendors.length ? b.vendors.map(String) : null;
    // The LONGEST duration in this sweep is the open-ended bucket and must be
    // written with `>=`, so rentals longer than it are still covered. This was
    // pinned to 14, so a sweep that stopped at 9 left every 10+ day rental
    // ruleless (reported 2026-08-29).
    const openDuration = Math.max(...durations);
    const dayList = bulkDays(b.startDate, days);
    // one sweep at a time: two jobs would share the FMX write queue and race
    // each other's "does this cell already have a rule" decisions
    for (const j of bulkJobs.values())
      if (j.status === 'running') throw new FmxError('BULK_BUSY', 409);

    const last = dayList[dayList.length - 1];
    if (dayList.length * durations.length > BULK_MAX_CELLS)
      throw new FmxError('SWEEP_TOO_LARGE', 400);
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      batch: 'bulk-' + crypto.randomBytes(5).toString('hex'),
      status: 'running',
      done: 0,
      total: dayList.length * durations.length,
      ok: 0,
      fail: 0,
      skipped: 0,
      skippedCoverage: 0,
      cursor: 0, // resume point into the flattened (day, duration) cell list
      error: null,
      cancel: false,
      cancelled: false,
      station,
      tenant: tenantIdOf(req),
      by: (req.operator && req.operator.u) || null,
      from: b.startDate,
      to: `${last.year}-${pad2(last.month)}-${pad2(last.day)}`,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    bulkJobs.set(job.id, job);
    for (const id of [...bulkJobs.keys()].slice(0, Math.max(0, bulkJobs.size - BULK_MAX_JOBS)))
      if (bulkJobs.get(id).status !== 'running') bulkJobs.delete(id);
    // the sweep's own marker. It carries the batch id as text, not as `batch`:
    // the batch id is what the Activity view collapses into one REVERT ALL row,
    // and this entry is not one of the writes that row counts.
    addLog({
      action: 'bulk-start', station, stationName: stationName(station),
      day: null, month: null, year: null, duration: null,
      before: null, after: pct, ok: true,
      file: `${job.batch} · ${job.from} → ${job.to} · ${durations.join('/')}D · ${job.total} cells · groups=${groupsField(vehicleIds)}`,
    });
    // fire and forget: the client polls the job for progress
    runBulkJob(job, {
      station, dayList, durations, pct, vehicleIds, vendors,
      openDuration,
      lane: sweepLane,
      groupName: b.groupName ? String(b.groupName).slice(0, 40) : null,
      skipExisting: b.skipExisting !== false,
    }).catch((e) => {
      job.status = 'failed';
      job.error = e.message;
    });
    res.json(bulkStatus(job)); // carries jobId — the console polls it from here
  })
);

/** A job belongs to the franchise it was started for — nobody else may read
 *  its progress or stop it. */
function bulkJobOf(req) {
  const job = bulkJobs.get(String(req.params.jobId || ''));
  if (!job || job.tenant !== tenantIdOf(req)) throw new FmxError('NO_SUCH_JOB', 404);
  return job;
}

app.get(
  '/api/rules/bulk/:jobId',
  wrap(async (req, res) => res.json(bulkStatus(bulkJobOf(req))))
);

app.post(
  '/api/rules/bulk/:jobId/cancel',
  wrap(async (req, res) => {
    const job = bulkJobOf(req);
    if (job.status === 'running') job.cancel = true; // stops before the next write
    res.json(bulkStatus(job));
  })
);

// ---------- auto-scan engine + proposal store ----------
// One FMX rule % scales EVERY Green Motion offer by the same factor, so "be
// inside rank R of every category" collapses to a single number (the category
// factor). The hourly tick walks a slice of the horizon, proposes the moves it
// finds, and mails them with a two-step one-click approval link.

const AUTOSCAN = {
  // OFF (Berkay, 2026-08-28): prices change ONLY when an operator changes
  // them. The hourly engine kept producing proposal mails whose one-click
  // approval rewrote rules "by itself" from the operator's point of view.
  // The market watcher (informational mail) is untouched; flip this back on
  // only when Berkay explicitly asks for automated proposals again.
  enabled: false,
  targetRank: 3,        // GM's cheapest car should sit here in EVERY category
  // tiered horizon: the near future carries every rental length and a daily
  // sample (most bookings land there), the far horizon thins out so the hourly
  // fresh budget still reaches 6 months ahead. `untilDay` is days from today
  // (exclusive), `step` samples every Nth day of the tier.
  tiers: [
    { untilDay: 21, durations: [1, 3, 5, 7, 10, 14], step: 1 },
    { untilDay: 60, durations: [3, 7, 14], step: 1 },
    { untilDay: 120, durations: [3, 7, 14], step: 2 },
    { untilDay: 180, durations: [7, 14], step: 3 },
  ],
  // propose a raise only past this. It was 0.08 when raises chased margin; a
  // raise now only ever means the LIMIT was breached, and "ne olursa olsun
  // limiti asmasin" does not tolerate sitting 8% under it. 2% keeps the
  // rentalcars quote noise (~2-3% between generations) from causing churn.
  raiseThreshold: 0.02,
  freshBudget: 40,      // rc queries that actually go out, per run
  minChangePct: 1.5,
  ratingWarn: 8.2,      // rentalcars' "8.0+" filter cliff, with a safety margin
  // THE PRICING BAND (Berkay, 2026-09-02/03 — supersedes the 97/95-per-100 band):
  // be #1, but NEVER more than a fixed number of FRANCS under the cheapest
  // competitor. The franc figure is a LIMIT, not a target: a cell already
  // under the field and inside the limit is left alone, a cell that is not #1
  // comes down to JUST under the field (the smallest move), and a cell that has
  // breached the limit is pulled back UP to it. How many of our cars land under
  // the field is nobody's goal — "kac araba girdigi umrumda degil, onemli olan
  // limiti asan ucuzlukta olmamak". (The first cut of this band treated the
  // figure as a target and pushed a cell sitting 5 CHF under down to 12.5 —
  // exactly the giveaway the limit exists to stop.)
  //
  // The old band put 3% on our cheapest car and let the base-rate ladder carry
  // the fleet upward, so against a 100 CHF field we sat at 97/99/100/100/101/
  // 102/106 — three cars under out of seven. Worse, the floor was computed PER
  // CATEGORY, so when the binding category was some other one our cheapest car
  // could sit 20 CHF under the field. Both anchors are market-wide now.
  //
  // THE LIMIT: 10 CHF AT EVERY LENGTH (Berkay, 2026-09-03: "her gunluk islemde
  // max 10 CHF ucuz olsun, maximum!"). The table stays per length because the
  // operator may still shape it in Settings, but the default is flat.
  //
  // For the record, the 2026-09-03 sweep of 98 ZRH cells measured what it
  // would cost to put FIVE of our cars under the field at each length — 1d 4,
  // 2d 8, 3d 10, 5d 15, 7d 19, 10d 26, 14d 40 CHF — and that table shipped for
  // an hour. Berkay rejected it on sight: 20 CHF under a 209 CHF field at 8
  // days is a giveaway, however many cars it buys. The car count is nobody's
  // goal; the limit is. An operator's own table is stored per tenant
  // (autoState().gapChfByDur) and overrides these entry by entry.
  gapChfByDur: { 1: 10, 2: 10, 3: 10, 4: 10, 5: 10, 6: 10, 7: 10, 8: 10, 9: 10, 10: 10, 11: 10, 12: 10, 13: 10, 14: 10 },
  gapBandChf: 1,  // a breached limit is corrected to this far INSIDE it, not onto the edge
  // "just under the field" when a cell is not #1: half a percent, never less
  // than half a franc — the smallest move that makes us the cheapest
  justUnderPct: 0.005,
  justUnderMinChf: 0.5,
  // A flat franc gap on a cheap enough field IS the giveaway the franc rule
  // guards against (10 off a 40 CHF field is a quarter of the price), so a
  // percentage still backstops the bottom. It only bites under ~67 CHF.
  lowPriceGuard: 0.15,
  //
  // All of this runs on the prices rentalcars actually DISPLAYS — when a
  // campaign discount (the session-targeted -12%) is active, the API's `price`
  // already carries it, and an FMX % change scales the displayed price
  // proportionally. So "win after the discount" is inherent to the math, not a
  // special case.
  // which display categories the factor is allowed to chase. null = all of them;
  // an operator picks their own in the console and it is stored per tenant.
  categories: null,
};
const AUTOSCAN_HORIZON_DAYS = AUTOSCAN.tiers[AUTOSCAN.tiers.length - 1].untilDay;
const AUTOSCAN_TTL_MS = 6 * 60 * 60 * 1000; // cache hits are free, so re-walking is cheap
// the scheduler tick times out at 300s and runWatcher already spent part of it;
// the deadline is checked between cells, and one relay-served cell can still add
// up to 90s on top, so 120s keeps the worst case inside the budget
const AUTOSCAN_RUN_MS = 120 * 1000;
// below this there is no room for even one relay-served cell, so skip the slice
const AUTOSCAN_MIN_RUN_MS = 10 * 1000;
// a new mail retires the previous mail's approval link, so when only the numbers
// moved (same cells) the pending set is refreshed silently for this long
const AUTOSCAN_MAIL_MIN_MS = 4 * 60 * 60 * 1000;

const round2 = (n) => Math.round(n * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');
const pctTxt = (n) => `${n > 0 ? '+' : ''}${Number(n).toFixed(1)}%`;
const dayLabel = (it) => `${pad2(it.day)}.${pad2(it.month)}.${it.year}`;
const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// display category -> the word the operator reads in the mail
const CAT_TR = {
  ECONOMY: 'ekonomi', COMPACT: 'kompakt', MIDSIZE: 'orta boy',
  LARGE: 'büyük', WAGON: 'station', SUV: 'SUV', MINIVAN: 'minivan',
};
const catTr = (c) => CAT_TR[c] || String(c || '').toLowerCase();

// State (rotating cursor, proposal sets, mail stamps) rides in the durable
// `watch` store under __-prefixed meta keys — exactly like __lastRun, which
// /api/watch-status already filters out of the baseline count. lib/store.js
// owns the key table and this sprint does not touch that file.
function autoState() {
  const st = watchBase.__autoscan;
  if (!st || typeof st !== 'object' || Array.isArray(st))
    watchBase.__autoscan = { cursor: null, lastRun: null, lastMail: null };
  return watchBase.__autoscan;
}

/** Display categories the engine is allowed to chase. The operator picks their
 *  own in the console; empty/absent means every category (the original
 *  behaviour), so an untouched install keeps working unchanged. */
function autoCategories() {
  const picked = autoState().categories;
  const clean = Array.isArray(picked) ? picked.filter((c) => RC_CAT_KEYS.includes(c)) : [];
  return clean.length ? clean : AUTOSCAN.categories;
}

/** The live gap table: the operator's per-duration francs over the measured
 *  defaults, entry by entry, so a half-filled table still prices every column.
 *  Read through the durable state so it survives the next cold start. */
function autoGapTable() {
  const own = autoState().gapChfByDur;
  const out = { ...AUTOSCAN.gapChfByDur };
  if (own && typeof own === 'object') {
    for (let d = 1; d <= 14; d++) {
      const v = Number(own[d]);
      if (isFinite(v) && v >= 0 && v <= 200) out[d] = v;
    }
  }
  return out;
}

/** The live low-price backstop. Read through the durable state, not a module
 *  field: an operator's setting has to survive the next cold start. */
function autoLowGuard() {
  const st = autoState();
  const v = Number(st.lowPriceGuard != null ? st.lowPriceGuard : st.maxUndercut);
  // the band has changed meaning twice (0.40 rank-guard -> 0.05 "95 per 100"
  // -> a franc gap with a percentage backstop). A stored 0.05 belongs to the
  // middle world and is far too tight to be a backstop, so only a value in the
  // new range is honoured.
  return isFinite(v) && v >= 0.1 && v <= 0.3 ? v : AUTOSCAN.lowPriceGuard;
}
function proposalSets() {
  if (!Array.isArray(watchBase.__proposals)) watchBase.__proposals = [];
  return watchBase.__proposals;
}
const pendingSet = () => [...proposalSets()].reverse().find((s) => s.status === 'pending') || null;
const findSet = (id) => proposalSets().find((s) => s.id === id) || null;

const PROP_MAX_SETS = 10;
const PROP_MAX_BYTES = 260000; // the whole watch store shares one Firestore doc

/** Keep the last 10 sets, shedding detail from the old ones before the durable
 *  watch document grows anywhere near Firestore's 1MiB limit. */
function saveProposals(list) {
  let out = list.slice(-PROP_MAX_SETS);
  if (JSON.stringify(out).length > PROP_MAX_BYTES)
    out = out.map((s) =>
      s.status === 'pending'
        ? s
        : { ...s, items: (s.items || []).map(({ cats, ...rest }) => rest) }
    );
  while (out.length > 1 && JSON.stringify(out).length > PROP_MAX_BYTES) out.shift();
  watchBase.__proposals = out;
  saveWatchBase();
  return out;
}

const itemKey = (it) => `${it.station}:${it.year}-${it.month}-${it.day}:${it.duration}`;
const itemOrder = (a, b) =>
  a.station - b.station ||
  new Date(a.year, a.month - 1, a.day) - new Date(b.year, b.month - 1, b.day) ||
  a.duration - b.duration;
// what makes two proposal sets "the same decision" — same cells, same target %
const propCells = (items) => (items || []).map(itemKey).join('|');
const propSig = (items) =>
  (items || []).map((it) => `${itemKey(it)}:${it.newPct}`).join('|');
// ...but newPct is a continuous function of live competitor prices, so comparing
// it to the cent calls every hourly slice a new decision: a fresh mail every
// hour, each one retiring the previous mail's approval link. Same cells and no
// target moved by a full minChangePct (the step the engine itself treats as
// meaningful) means nothing worth re-mailing happened.
const propSame = (a, b) => {
  if (propCells(a) !== propCells(b)) return false;
  if (propSig(a) === propSig(b)) return true;
  const prev = new Map((a || []).map((it) => [itemKey(it), Number(it.newPct)]));
  return (b || []).every((it) => {
    const p = prev.get(itemKey(it));
    return p != null && Math.abs(Number(it.newPct) - p) < AUTOSCAN.minChangePct;
  });
};

/**
 * THE BAND: BE #1, NEVER MORE THAN THE LIMIT UNDER (Berkay, 2026-09-02/03).
 *
 *   cheapest  = the cheapest COMPETITOR price in scope (displayed price — any
 *               active campaign discount is already inside it)
 *   gmCheap   = our cheapest offer in scope, same basis
 *   limit     = gapChfByDur[rentalDays]     // francs, per length, operator-editable
 *   floor     = max(cheapest - limit, cheapest * (1 - lowPriceGuard))
 *   band      = [floor, cheapest)           // under the field, inside the limit
 *
 *   gmCheap in band      -> factor 1, nothing to write
 *   gmCheap >= cheapest  -> not #1: come down to JUST under the field
 *                           (justUnderPct / justUnderMinChf) — the smallest move
 *   gmCheap <  floor     -> limit breached: come UP to gapBandChf inside it
 *
 * The limit is a ceiling on depth, never a target. One FMX % scales every GM
 * car together, so placing the CHEAPEST one fixes the whole block; how many of
 * our cars end up under the field is nobody's goal here.
 *
 * Both anchors are market-wide. The previous version took min(target_c) over
 * display categories and clamped up to max(floor_c): each category guarded
 * only ITSELF, so whenever the binding category was some other one our overall
 * cheapest car could sit far below the overall cheapest competitor — the 20
 * CHF gaps Berkay reported. `categories` now only narrows WHICH rows count;
 * both anchors then come from the same narrowed set, because anchoring our
 * cheapest SUV on a mini's field price would be a catastrophe, not a discount.
 *
 * factor > 1 means we are selling for LESS than the band and the price should
 * come UP; factor < 1 means we are above the field and come down to just under.
 */
function categoryFactor(r, targetRank, opts = {}) {
  const only = Array.isArray(opts.categories) && opts.categories.length
    ? new Set(opts.categories)
    : null;
  const days = Math.min(Math.max(Math.round(Number(opts.duration) || 1), 1), 14);
  const table = opts.gapChfByDur && typeof opts.gapChfByDur === 'object' ? opts.gapChfByDur : AUTOSCAN.gapChfByDur;
  const gap = isFinite(opts.gapChf)
    ? Number(opts.gapChf)
    : Number(table[days] != null ? table[days] : AUTOSCAN.gapChfByDur[days]);
  const guard = isFinite(opts.lowPriceGuard) ? Number(opts.lowPriceGuard) : AUTOSCAN.lowPriceGuard;
  const slack = isFinite(opts.gapBandChf) ? Number(opts.gapBandChf) : AUTOSCAN.gapBandChf;

  const inScope = (x) => {
    if (!only) return true;
    for (const cat of only) if (rcRowInCat(x, cat)) return true;
    return false;
  };
  const rows = (r.top || []).filter(inScope);
  const comp = rows.filter((x) => !rcIsGm(x)).map((x) => x.price);
  const gmRows = rows.filter(rcIsGm);
  if (!comp.length || !gmRows.length) return null; // we are absent here, or alone at the top

  const cheapest = Math.min(...comp);
  const gmCheap = Math.min(...gmRows.map((x) => x.price));
  if (!isFinite(cheapest) || !isFinite(gmCheap) || gmCheap <= 0) return null;

  const floor = Math.max(cheapest - gap, cheapest * (1 - guard));
  // "just under": the smallest move that makes us the cheapest
  const justUnder = Math.max(cheapest * AUTOSCAN.justUnderPct, AUTOSCAN.justUnderMinChf);
  const top = Math.max(cheapest - justUnder, floor);
  // a breached limit is corrected to just INSIDE it, not onto the edge
  const upTo = Math.min(floor + slack, top);

  // inside the band: nothing to write, and above all no move in either direction
  const inBand = gmCheap >= floor && gmCheap < cheapest;
  let factor = 1;
  if (!inBand) factor = (gmCheap >= cheapest ? top : upTo) / gmCheap;
  if (!isFinite(factor) || factor <= 0) return null;
  const clamped = gmCheap < floor; // limit breached — this is a correction UP

  // per-category rank bookkeeping for the report, unchanged in shape
  const cats = [];
  for (const cat of RC_CAT_KEYS) {
    if (only && !only.has(cat)) continue;
    const rowsC = (r.top || []).filter((x) => rcRowInCat(x, cat));
    if (!rowsC.length) continue;
    const gmC = rowsC.filter(rcIsGm);
    const compC = rowsC.filter((x) => !rcIsGm(x));
    if (!gmC.length || !compC.length) continue;
    const scaled = rowsC
      .map((x) => (rcIsGm(x) ? { ...x, price: x.price * factor } : x))
      .sort((a, b) => a.price - b.price);
    cats.push({
      cat,
      rankNow: rowsC.findIndex(rcIsGm) + 1,
      rankAfter: scaled.findIndex(rcIsGm) + 1,
      gmPrice: round2(gmC[0].price),
      anchor: round2(compC[0].price),
    });
  }
  return { factor, cats, clamped };
}

// the category that produced min(f_c) — recomputed from the stored numbers so
// the item shape stays exactly as specced
const govCat = (it) =>
  (it.cats || []).reduce(
    (best, c) =>
      best == null || c.anchor / c.gmPrice < best.anchor / best.gmPrice ? c : best,
    null
  );

// ---------- current FMX percentages (curPct) ----------
// getRules + fetchDetails are expensive, so one cache serves a whole run:
// per station for the rule/detail sweep, per station+month for the shaped cells.

const newGridCache = () => ({ station: new Map(), month: new Map() });

/** `lane` scopes the read to ONE vehicle-group set (see laneKey). A sweep that
 *  prices the economy groups must compare against the economy rules only. */
async function stationCells(station, year, month, cache, lane = null) {
  if (!cache.station.has(station)) {
    const rules = await fmx.getRules(station);
    cache.station.set(station, { rules, details: await fetchDetails(rules) });
  }
  if (!cache.allIds) cache.allIds = (await fmx.getVehicleGroups()).map((g) => g.id);
  const mk = `${station}:${year}-${month}:${lane || '*'}`;
  if (!cache.month.has(mk)) {
    const s = cache.station.get(station);
    const conflicts = new Set(); // cells whose rules fight over the same cars
    cache.month.set(mk, {
      cells: shapeCells(s.rules, (id) => s.details[id], year, month, conflicts, lane, cache.allIds),
      conflicts,
    });
  }
  return cache.month.get(mk);
}

// ---------- horizon ----------

function horizonEndDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + AUTOSCAN_HORIZON_DAYS - 1);
}
const horizonEnd = () => {
  const e = horizonEndDate();
  return `${e.getFullYear()}-${pad2(e.getMonth() + 1)}-${pad2(e.getDate())}`;
};

/** today -> today + horizon, both stations, tier-dependent durations.
 *  A far day skipped by its tier's step today drifts into the sampled class
 *  within a few days (offsets shift daily), so nothing stays unwatched. */
function autoScanTasks() {
  const now = new Date();
  const tasks = [];
  for (let off = 0; off < AUTOSCAN_HORIZON_DAYS; off++) {
    const tier = AUTOSCAN.tiers.find((t) => off < t.untilDay);
    if (!tier || off % tier.step) continue;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off);
    // a station discovered from FMX but not yet mapped to a rentalcars
    // location has no market to scan — skip it instead of erroring on every cell
    for (const st of tenantStations().filter((x) => x.rc && x.rc.loc))
      for (const duration of tier.durations)
        tasks.push({
          station: st.id, stationName: st.name, year: d.getFullYear(),
          month: d.getMonth() + 1, day: d.getDate(), duration,
        });
  }
  return tasks;
}

let autoScanBusy = false;

/**
 * One budgeted slice of the horizon. Cache hits are free, so only queries that
 * actually left the machine (no `cachedAt`) count against freshBudget; the
 * cursor rotates so the following runs continue where this one stopped and the
 * full horizon is covered over a few hours.
 * `budgetMs` is whatever the caller has left of the tick's 300s wall.
 */
async function autoScan(budgetMs) {
  if (!AUTOSCAN.enabled || autoScanBusy) return false;
  // no budget given (local boot) = the full slice; an overspent tick hands this
  // a negative number, which must skip the slice, not run the full 120s
  const run = budgetMs == null ? AUTOSCAN_RUN_MS : Math.min(AUTOSCAN_RUN_MS, Number(budgetMs) || 0);
  if (run < AUTOSCAN_MIN_RUN_MS) return false; // the watcher used up this tick
  autoScanBusy = true;
  const deadline = Date.now() + run;
  try {
    const tasks = autoScanTasks();
    if (!tasks.length) return false;
    const st = autoState();
    const at = tasks.findIndex((t) => itemKey(t) === st.cursor);
    let i = at >= 0 ? at : 0;
    let cursorAt = i; // only cells this run really looked at move the cursor on
    const grid = newGridCache();
    const noGrid = new Set(); // stations whose FMX rules could not be read this run
    const scanned = new Set();
    const found = [];
    const missing = []; // cells where rentalcars lists competitors but no GM at all
    const ratings = {}; // station -> GM depot rating seen this run
    let fresh = 0;
    let walked = 0;
    let lastCheckpoint = Date.now(); // throttles the durable cursor write
    let staleRun = 0;
    while (walked < tasks.length && fresh < AUTOSCAN.freshBudget && Date.now() < deadline) {
      const t = tasks[i % tasks.length];
      i++;
      walked++;
      if (noGrid.has(t.station)) continue;
      let cg;
      try {
        cg = await stationCells(t.station, t.year, t.month, grid);
      } catch (e) {
        // no FMX session / FMX down: curPct is unknowable, so proposing would
        // be guessing. Skip the station, keep the cursor, retry next hour.
        noGrid.add(t.station);
        continue;
      }
      let r;
      try {
        r = await rcQuery({
          station: t.station, year: t.year, month: t.month, day: t.day,
          duration: t.duration, hh: RC_HOUR, mm: '00', ttlMs: AUTOSCAN_TTL_MS,
          // proposals become PRICES: a single draw can catch the wrong shape or
          // generation (~2-12% off) — one confirmation draw is cheap insurance
          samples: 2,
        });
      } catch (e) {
        if (e.message === 'RC_UNAVAILABLE') break; // relay offline — stop, keep the cursor
        continue;
      }
      cursorAt = i; // this cell was really visited; the next run resumes after it
      // persist as we go: the tick shares a 300s wall with runWatcher, and a
      // cursor that only lands after the loop is lost when the instance is
      // killed — every run would then restart at the same slice and the far
      // horizon would never be scanned at all.
      st.cursor = itemKey(tasks[cursorAt % tasks.length]);
      st.lastRun = new Date().toISOString();
      // checkpoint at most every 15s: this doc is durable (a Firestore write
      // in the cloud) and a per-cell save would be a write storm
      if (Date.now() - lastCheckpoint > 15000) {
        lastCheckpoint = Date.now();
        saveWatchBase();
      }
      if (r.cachedAt == null) fresh++;
      if (r.stale) {
        // relay offline: every answer is a stale leftover. Bail after a few
        // rather than walking the whole horizon on futile lookups.
        if (++staleRun >= 5) break;
        continue;
      }
      staleRun = 0;
      scanned.add(itemKey(t));
      if (r.gmPrice == null) {
        // competitors are selling this day and GM is nowhere on the list —
        // no % rule can fix that, so it goes out as its own alarm
        if (r.total > 0)
          missing.push({
            station: t.station, stationName: t.stationName, year: t.year,
            month: t.month, day: t.day, duration: t.duration, competitors: r.total,
          });
        continue;
      }
      const gmRow = (r.top || []).find(rcIsGm);
      if (gmRow && gmRow.rating != null) ratings[t.station] = Number(gmRow.rating);
      const cf = categoryFactor(r, AUTOSCAN.targetRank, {
        categories: autoCategories(),
        duration: t.duration,          // the gap is per rental length
        gapChfByDur: autoGapTable(),
        lowPriceGuard: autoLowGuard(),
      });
      if (!cf) continue; // no category has both a GM offer and a competitor
      const ckey = `${t.day}:${t.duration}`;
      // two gridable rules on one cell: FMX decides which one serves the price,
      // so neither curPct nor the effect of a write is knowable. The console
      // refuses these cells (CONFLICTS chip); so does the engine.
      if (cg.conflicts.has(ckey)) continue;
      const cell = cg.cells.get(ckey);
      // an inactive rule carries no discount on the live price and is parked on
      // purpose — moving it would silently switch it back on
      if (cell && cell.active === false) continue;
      const curPct = cell ? Number(cell.pct) : 0;
      if (!isFinite(curPct)) continue;
      const down = cf.factor < 1;
      if (!down && cf.factor <= 1 + AUTOSCAN.raiseThreshold) continue; // close enough
      const newPct = Math.max(
        -95,
        Math.min(100, round2(((1 + curPct / 100) * cf.factor - 1) * 100))
      );
      if (Math.abs(newPct - curPct) < AUTOSCAN.minChangePct) continue;
      found.push({
        station: t.station, stationName: t.stationName, year: t.year, month: t.month,
        day: t.day, duration: t.duration, curPct: round2(curPct), newPct,
        direction: down ? 'down' : 'up',
        factor: Math.round(cf.factor * 10000) / 10000,
        cats: cf.cats,
      });
    }
    st.cursor = itemKey(tasks[cursorAt % tasks.length]);
    st.lastRun = new Date().toISOString();
    // the rating only moves on real reviews, so the latest sighting stands
    st.ratings = { ...(st.ratings || {}), ...ratings };
    await recordProposals(found, scanned, tasks, missing);
    saveWatchBase();
    return true;
  } catch (e) {
    console.log('Auto-scan failed:', e.message);
    return false;
  } finally {
    autoScanBusy = false;
  }
}

/**
 * Fold this slice's findings into the pending set and mail only when the set
 * really changed. A run covers a slice of the horizon, so proposals for cells
 * this run did not revisit are carried over — otherwise the "set" would shrink
 * to one slice every hour and mail on every tick.
 */
async function recordProposals(found, scanned, tasks, foundMissing = []) {
  const horizon = new Set(tasks.map(itemKey));
  const sets = proposalSets();
  const prev = pendingSet();
  const kept = (prev && Array.isArray(prev.items) ? prev.items : []).filter(
    (it) => horizon.has(itemKey(it)) && !scanned.has(itemKey(it))
  );
  const items = [...kept, ...found].sort(itemOrder);
  // "GM not listed" alarms carry over exactly like price proposals: a slice
  // only re-decides the cells it revisited
  const keptMissing = (prev && Array.isArray(prev.missing) ? prev.missing : []).filter(
    (it) => horizon.has(itemKey(it)) && !scanned.has(itemKey(it))
  );
  const missing = [...keptMissing, ...foundMissing].sort(itemOrder);

  if (!items.length && !missing.length) {
    // the market no longer needs any of it — retire the pending set instead of
    // leaving an emailed link that would apply nothing
    if (prev) {
      prev.status = 'superseded';
      saveProposals(sets);
    }
    return;
  }
  if (prev && propSame(prev.items, items) && propCells(prev.missing) === propCells(missing)) {
    prev.items = items; // same decisions, fresher numbers — refresh silently, keep the id
    prev.missing = missing;
    saveProposals(sets);
    return;
  }
  // the decisions changed, so this is worth re-mailing — but never more often
  // than the cadence floor, whatever changed. Refresh the pending set silently
  // until the floor passes; the emailed link keeps pointing at fresh numbers.
  if (
    prev &&
    Date.now() - (Date.parse(autoState().lastMail) || 0) < AUTOSCAN_MAIL_MIN_MS
  ) {
    prev.items = items;
    prev.missing = missing;
    saveProposals(sets);
    return;
  }

  const set = {
    id: crypto.randomBytes(6).toString('hex'),
    createdAt: new Date().toISOString(),
    source: 'auto',
    status: 'pending',
    items,
    missing,
    appliedAt: null,
    appliedBy: null,
    result: null,
  };
  for (const s of sets) if (s.status === 'pending') s.status = 'superseded';
  sets.push(set);
  saveProposals(sets);
  if (!mailer) return;
  try {
    const subj = items.length
      ? `[GM] Otomatik tarama — ${items.length} fiyat önerisi` +
        (missing.length ? ` · ${missing.length} günde GM listede yok` : '')
      : `[GM] UYARI — ${missing.length} gün/sürede GM rentalcars'ta listelenmiyor`;
    await sendMail(subj, autoScanMailHtml(set));
    autoState().lastMail = new Date().toISOString();
    addLog({
      action: 'mail-proposals', station: null, stationName: 'AUTO SCAN',
      day: null, month: null, year: null, duration: null,
      before: null, after: null, ok: true, file: `${items.length} öneri · ${set.id}`,
    });
  } catch (e) {
    console.log('Auto-scan mail failed:', e.message);
  }
}

// ---------- auto-scan mail ----------

function autoScanMailHtml(set) {
  const byStation = new Map();
  for (const it of set.items) {
    const k = it.stationName || stationName(it.station);
    if (!byStation.has(k)) byStation.set(k, []);
    byStation.get(k).push(it);
  }
  let budget = 40; // a mail nobody scrolls to the end of helps nobody
  let dropped = 0;
  const sections = [];
  for (const [name, list] of byStation) {
    const rows = [];
    for (const it of list) {
      if (budget <= 0) {
        dropped++;
        continue;
      }
      budget--;
      const c = govCat(it);
      const reason = c
        ? `${catTr(c.cat)}: #${c.rankNow} &rarr; #${c.rankAfter}`
        : it.direction === 'down' ? 'sıra kaybı' : 'marj boşluğu';
      rows.push([
        dayLabel(it),
        `${it.duration} gün`,
        `${pctTxt(it.curPct)} &rarr; <b>${pctTxt(it.newPct)}</b>`,
        it.direction === 'down' ? mailUp(reason) : mailWarn(reason),
      ]);
    }
    if (!rows.length) continue;
    sections.push({
      title: name.toUpperCase() + ' · FİYAT ÖNERİLERİ',
      header: ['TARİH', 'SÜRE', 'ŞİMDİ &rarr; ÖNERİ', 'NEDEN'],
      rows,
      // the legend belongs under the first table only — repeating it under
      // every station just makes the mail longer
      note: sections.length
        ? ''
        : `${mailUp('yeşil')} = fiyat inmeli, GM o kategoride en ucuz rakibin üstünde kalıyor · ` +
          `${mailWarn('turuncu')} = GM gereğinden ucuz, marj bırakıyorsun · ` +
          'NEDEN sütunu durumu belirleyen kategoriyi ve GM\'in o kategorideki sırasının nereden nereye gideceğini gösterir.',
    });
  }
  if (dropped) {
    const lastSec = sections[sections.length - 1];
    lastSec.note = `&hellip; ve ${dropped} kayıt daha (konsolda hepsi görünür). ` + lastSec.note;
  }

  // GM absent while competitors sell: the biggest reservation leak there is,
  // and no % rule fixes it — its own red section so it can't be missed
  const missing = Array.isArray(set.missing) ? set.missing : [];
  if (missing.length) {
    sections.push({
      title: 'GM LİSTEDE YOK · MÜSAİTLİK ALARMI',
      header: ['TARİH', 'SÜRE', 'İSTASYON', 'DURUM'],
      rows: missing.slice(0, 30).map((it) => [
        dayLabel(it),
        `${it.duration} gün`,
        it.stationName || stationName(it.station),
        mailDown(`${it.competitors} rakip satıyor, GM yok`),
      ]),
      note:
        (missing.length > 30 ? `&hellip; ve ${missing.length - 30} kayıt daha. ` : '') +
        'Bu gün/sürelerde rakipler rentalcars\'ta satarken GM hiç listelenmiyor — ' +
        'fiyat kuralı bunu çözmez; FMX\'te müsaitlik/stop-sale ve araç havuzunu kontrol et.',
    });
  }

  // rating below the 8.0 search-filter cliff loses every filtered search
  const ratings = autoState().ratings || {};
  const lowRated = Object.entries(ratings).filter(([, v]) => v != null && v < AUTOSCAN.ratingWarn);
  if (lowRated.length) {
    sections.push({
      title: 'MÜŞTERİ PUANI UYARISI',
      header: ['İSTASYON', 'PUAN', 'RİSK'],
      rows: lowRated.map(([stn, v]) => [
        stationName(Number(stn)),
        `<b>${Number(v).toFixed(1)}</b>`,
        mailDown('8.0+ filtresinde görünmeme riski'),
      ]),
      note:
        'rentalcars\'ta kullanıcılar sık sık "8.0+ puan" filtresiyle arar; puan bu eşiğin altına ' +
        'düşerse GM bu aramaların hiçbirinde görünmez. Yorum ve operasyon kalitesine öncelik ver.',
    });
  }

  const tok = set.items.length ? proposalToken(set) : null;
  const url = `${consoleBase()}/p/${set.id}?t=${encodeURIComponent(tok || '')}`;
  const extra = tok
    ? `
      <div style="margin-top:26px;padding:16px;background:#f2fbf7;border:1px solid #bfe6d4;border-radius:8px;">
        <div style="font-size:14px;line-height:1.6;color:#1f2933;">Hepsini tek tıkla uygulamak istersen:</div>
        <div style="margin-top:12px;">
          <a href="${escHtml(url)}" style="display:inline-block;background:${MAIL_GREEN};color:#ffffff;font-size:15px;font-weight:700;padding:13px 22px;border-radius:6px;text-decoration:none;">${set.items.length} ÖNERİYİ ONAYLA</a>
        </div>
        <div style="margin-top:10px;font-size:12px;line-height:1.55;color:#7b8794;">
          Bu bağlantı yalnızca bir onay sayfası açar &mdash; tıklaman tek başına hiçbir fiyatı değiştirmez, sayfada bir kez daha onaylaman gerekir. Bağlantı 72 saat geçerlidir.
        </div>
      </div>`
    : '';
  const title = set.items.length
    ? `${set.items.length} fiyat önerisi hazır`
    : `${missing.length} gün/sürede GM listelenmiyor`;
  const intro = set.items.length
    ? `Saatlik otomatik tarama önümüzdeki ${AUTOSCAN_HORIZON_DAYS} günü (bugünden ${horizonEnd()} tarihine kadar; yakın günler her kiralama süresiyle, uzak günler seyrek örneklemle) tarıyor ve en ucuz aracımızı en ucuz rakibin hemen altına oturtmak için (#1 olup en ucuz rakibin en fazla ${autoGapTable()[3]} CHF altında kalmak — her sürede) fiyatın hareket etmesi gereken ${set.items.length} gün/süre kombinasyonu buldu. Aşağıdaki tablolar hangi günde ne yapılması gerektiğini gösterir; hepsini birden onaylamak için tablonun altındaki düğmeyi kullanabilir, tek tek bakmak istersen Konsolu açabilirsin.`
    : `Saatlik otomatik tarama fiyat değişikliği gerektiren bir gün bulamadı, ancak aşağıdaki gün/sürelerde rakipler satarken GM rentalcars'ta hiç listelenmiyor — bu doğrudan rezervasyon kaybıdır ve fiyat kuralıyla çözülmez.`;
  return alertMailHtml(title, sections, intro, extra);
}

function appliedMailHtml(set, result) {
  const rows = set.items.slice(0, 40).map((it) => [
    dayLabel(it),
    `${it.stationName || stationName(it.station)} · ${it.duration} gün`,
    `${pctTxt(it.curPct)} &rarr; <b>${pctTxt(it.newPct)}</b>`,
  ]);
  return alertMailHtml(
    `${result.ok} fiyat kuralı güncellendi`,
    [
      {
        title: 'UYGULANAN ÖNERİLER',
        header: ['TARİH', 'İSTASYON &middot; SÜRE', 'ESKİ &rarr; YENİ'],
        rows,
        note:
          (set.items.length > 40 ? `&hellip; ve ${set.items.length - 40} kayıt daha. ` : '') +
          (result.fail
            ? `${mailDown(result.fail + ' kayıt yazılamadı')} — konsoldaki Aktivite listesinde hata sebebi görünür.`
            : 'Hepsi FuseMetrix üzerinde doğrulandı.'),
      },
    ],
    `Onayladığın ${set.items.length} önerinin ${result.ok} tanesi FuseMetrix'e yazıldı${result.fail ? `, ${result.fail} tanesi başarısız oldu` : ''}. rentalcars.com yeni fiyatları birkaç dakika içinde göstermeye başlar; hemen kontrol edersen eski fiyatı görebilirsin. Değişikliklerin tamamını konsoldaki Aktivite listesinden tek tıkla geri alabilirsin.`
  );
}

// ---------- one-click approval (token + two-step apply) ----------

const PROP_TTL_MS = 72 * 60 * 60 * 1000;

/** b64u(HMAC(authSecret, 'proposal:<id>:<createdAt>')), first 32 chars */
function proposalToken(set) {
  if (!authSecret || !set) return null;
  return b64u(
    crypto.createHmac('sha256', authSecret).update(`proposal:${set.id}:${set.createdAt}`).digest()
  ).slice(0, 32);
}
const proposalTokenOk = (set, tok) => {
  const want = proposalToken(set);
  return !!want && safeEqual(tok, want); // timing-safe
};
const proposalExpired = (set) => Date.now() - (Date.parse(set.createdAt) || 0) > PROP_TTL_MS;

// one in-flight apply per proposal id: a double-tapped mail button must not
// run the FMX write loop twice
const applyInFlight = new Set();

/** Apply one set through the same create/update + verify + addLog path the
 *  console uses, then invalidate the rc cache for the touched days. */
async function applyProposalSet(set, by) {
  // claim durably BEFORE writing: a second POST (or an instance recycle
  // mid-loop) must never replay the same set of live price writes
  set.status = 'applying';
  set.appliedAt = new Date().toISOString();
  set.appliedBy = by;
  saveProposals(proposalSets());
  const grid = newGridCache();
  const touched = new Map();
  // rules this run wrote — re-stamped in one list request at the end so the
  // next sync reads them from cache instead of re-downloading every page
  const wrote = new Map(); // station -> Set(ruleid): a set can span stations
  let ok = 0;
  let fail = 0;
  for (const it of set.items) {
    const base = {
      action: 'update', station: it.station,
      stationName: it.stationName || stationName(it.station),
      day: it.day, month: it.month, year: it.year, duration: it.duration,
      before: it.curPct != null ? Number(it.curPct) : null, after: it.newPct,
      batch: set.id, batchTag: 'autoscan',
    };
    try {
      if (!DURATIONS.includes(Number(it.duration))) throw new FmxError('BAD_DURATION', 400);
      if (!isFinite(Number(it.newPct))) throw new FmxError('BAD_PCT', 400);
      const cg = await stationCells(it.station, it.year, it.month, grid);
      const ckey = `${it.day}:${it.duration}`;
      // the console refuses to write a conflicted cell and so does this path:
      // FMX picks which of the two rules serves the price, so a half-applied
      // write leaves an unpredictable live price. Log it as a failure instead.
      if (cg.conflicts.has(ckey)) throw new FmxError('CELL_CONFLICT', 409);
      const liveCell = cg.cells.get(ckey);
      if (liveCell && liveCell.active === false) throw new FmxError('RULE_INACTIVE', 409);
      const cell = cg.cells.get(ckey);
      // The proposal may be up to 72h old and its stored factor is anchored to
      // the DISPLAYED price the SCAN-TIME rule (it.curPct) produced. Plugging
      // the CURRENT rule pct into that formula wrote a price off the band by
      // exactly (1+livePct)/(1+curPct) — a rule edited from -20 to -10 turned a
      // "land at 97" proposal into a 109.13 write, ABOVE the 100 anchor. A rule
      // that changed (or vanished) since the scan means the snapshot no longer
      // describes the market: skip the cell so the receipt says re-scan it,
      // never replay a stale factor onto a basis it was not computed from.
      const drift = cell
        ? Math.abs(Number(cell.pct) - Number(it.curPct))
        : (Number(it.curPct) !== 0 && it.curPct != null ? Infinity : 0);
      if (isFinite(Number(it.curPct)) && drift > 0.005) {
        throw new FmxError('RULE_CHANGED_SINCE_SCAN', 409);
      }
      // rule unchanged: the stored newPct IS the band-target pct
      const pct = Math.max(-95, Math.min(100, Number(it.newPct)));
      base.after = pct;
      const args = {
        day: it.day, month: it.month, year: it.year, duration: it.duration,
        pct,
        // mirror the console's PUT: an existing rule keeps its activation state,
        // a rule created here starts active
        active: cell ? cell.active !== false : true,
        vendors: (cell && cell.vendors) || ['ALL'],
        // An update REWRITES coverage and rebuilds the rulename. Without these
        // two, re-pricing a category-scoped weekly rule silently widened it to
        // ALL 39 groups and dropped the category name from its title — the
        // operator's whole per-category setup, erased by a price nudge.
        vehicleIds: (cell && cell.groupIds && cell.groupIds.length) ? cell.groupIds : null,
        groupLabel: (cell && cell.label) || null,
        // ...and coverage includes the OPERATOR: a swept day's longest rule is
        // the open bucket ('>= 10' after a 1..10 sweep). Omitting this rewrote
        // it as '= 10', silently unpricing 11-13 day rentals (+25% jump), and
        // verifyDetail could not catch it because it expects what it was sent.
        openDuration: cell && cell.op === '>=' ? it.duration : undefined,
      };
      base.vendor = args.vendors.join(',');
      if (cell) {
        base.before = cell.pct;
        const r = await fmx.updateRule(it.station, cell.ruleid, args);
        if (!wrote.has(it.station)) wrote.set(it.station, new Set());
        wrote.get(it.station).add(cell.ruleid);
        addLog({ ...base, ruleid: cell.ruleid, ok: true, verified: r.verified });
      } else {
        base.action = 'create';
        base.before = null;
        const r = await fmx.createRule(it.station, args);
        addLog({ ...base, ruleid: r.ruleid, ok: true, verified: r.verified });
      }
      ok++;
      touched.set(`${it.station}:${it.year}-${it.month}-${it.day}`, {
        station: it.station, year: it.year, month: it.month, day: it.day,
      });
    } catch (e) {
      addLog({ ...base, ok: false, error: e.message });
      fail++;
    }
  }
  // same as the sweep: re-validate what we just wrote so the next sync reads
  // it from cache instead of re-downloading every page we verified seconds ago
  for (const [st, ids] of wrote) {
    try {
      const n = await fmx.restampWritten(st, [...ids]);
      if (n) console.log(`sync: re-stamped ${n} detail entries after the apply`);
    } catch (e) {
      console.log('sync: re-stamp after apply failed:', e.message);
    }
  }
  // the panel's next look at those days must not read pre-write prices
  for (const t of touched.values()) rcInvalidate(t);
  set.status = 'applied';
  set.appliedAt = new Date().toISOString();
  set.appliedBy = by;
  set.result = { ok, fail };
  saveProposals(proposalSets());
  // the apply runs in the background now, so this mail is the operator's receipt
  // — it has to go out even when every write failed
  if (mailer && (ok || fail)) {
    try {
      await sendMail(`[GM] Öneriler uygulandı — ${ok} değişiklik`, appliedMailHtml(set, { ok, fail }));
    } catch (e) {
      console.log('Applied-confirmation mail failed:', e.message);
    }
  }
  return { ok, fail };
}

// ---------- proposal API (operator-cookie authed) ----------

const publicSet = (s) => ({
  id: s.id, createdAt: s.createdAt, source: s.source, status: s.status,
  appliedAt: s.appliedAt || null, appliedBy: s.appliedBy || null,
  result: s.result || null, count: (s.items || []).length, items: s.items || [],
});

app.get('/api/proposals', wrap(async (req, res) =>
  res.json({
    proposals: [...proposalSets()].reverse().map(publicSet),
    autoScan: autoScanStatus(),
  })
));

app.post(
  '/api/proposals/:id/apply',
  wrap(async (req, res) => {
    const set = findSet(String(req.params.id));
    if (!set) throw new FmxError('PROPOSAL_NOT_FOUND', 404);
    if (set.status === 'applied') throw new FmxError('PROPOSAL_ALREADY_APPLIED', 409);
    if (set.status !== 'pending') throw new FmxError('PROPOSAL_NOT_PENDING', 409);
    if (applyInFlight.has(set.id)) throw new FmxError('PROPOSAL_APPLY_RUNNING', 409);
    applyInFlight.add(set.id);
    // Firebase Hosting cuts a rewritten request at 60s whatever the function's
    // own timeout is, and a pending set of 50-150 cells (one FMX write plus a
    // verification read each) blows straight through that — the browser would
    // get a 504 on a run that actually succeeded. So: answer now, write after.
    // The result lands in the stored set, the activity log and the confirmation
    // mail; the client polls /api/proposals for it.
    res.status(202).json({ ok: true, queued: true, id: set.id, count: (set.items || []).length });
    applyProposalSet(set, 'console')
      .catch((e) => console.log('Proposal apply failed:', e.message))
      .finally(() => applyInFlight.delete(set.id));
  })
);

// ---------- one-click approval pages (NOT under /api: no operator cookie) ----------
// Mail clients and security scanners prefetch every GET link they see, so the
// GET is a confirmation PAGE ONLY — it never writes. The page posts the token
// back to /p/:id/apply, which is what actually applies.

function proposalPage(title, body) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escHtml(title)} · GM Pricing Console</title></head>
<body style="margin:0;background:#f4f5f7;font-family:${MAIL_FONT};">
  <div style="max-width:600px;margin:0 auto;padding:20px 12px;">
    <div style="background:#ffffff;border:1px solid #e6e8eb;border-radius:8px;padding:22px 20px;">
      <div>
        <span style="display:inline-block;width:9px;height:9px;background:${MAIL_GREEN};border-radius:50%;margin-right:8px;vertical-align:middle;"></span>
        <span style="font-size:15px;font-weight:700;color:#1f2933;vertical-align:middle;">Pricing Console</span>
        <span style="font-size:12px;color:#9aa5b1;vertical-align:middle;"> &nbsp;GM Zürih · Fiyat önerileri</span>
      </div>
      <div style="margin-top:14px;font-size:19px;font-weight:700;color:#1f2933;line-height:1.35;">${escHtml(title)}</div>
      ${body}
      <div style="margin-top:24px;">
        <a href="${escHtml(consoleBase())}/console" style="display:inline-block;background:#ffffff;color:#1f2933;font-size:14px;font-weight:600;padding:11px 20px;border:1px solid #cbd2d9;border-radius:6px;text-decoration:none;">Konsolu aç</a>
      </div>
    </div>
  </div>
</body></html>`;
}

const proposalNote = (s) =>
  `<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#52606d;">${s}</div>`;

function proposalTable(set) {
  const cell = (c, header) =>
    `<t${header ? 'h' : 'd'} style="padding:8px 10px;border-bottom:1px solid #e6e8eb;font-size:14px;line-height:1.45;text-align:left;vertical-align:top;color:${header ? '#6b7280' : '#1f2933'};${header ? 'font-weight:600;text-transform:uppercase;letter-spacing:.4px;font-size:12px;' : 'font-weight:normal;'}">${c}</t${header ? 'h' : 'd'}>`;
  const rows = set.items
    .slice(0, 60)
    .map((it) => {
      const c = govCat(it);
      return `<tr>${[
        escHtml(dayLabel(it)),
        escHtml(`${it.stationName || stationName(it.station)} · ${it.duration} gün`),
        `${escHtml(pctTxt(it.curPct))} &rarr; <b>${escHtml(pctTxt(it.newPct))}</b>`,
        c ? escHtml(`${catTr(c.cat)}: #${c.rankNow} → #${c.rankAfter}`) : '&mdash;',
      ].map((x) => cell(x)).join('')}</tr>`;
    })
    .join('');
  return `
    <table style="border-collapse:collapse;width:100%;border:1px solid #e6e8eb;border-radius:6px;margin-top:16px;">
      <tr>${['TARİH', 'İSTASYON &middot; SÜRE', 'ESKİ &rarr; YENİ', 'KATEGORİ ETKİSİ'].map((h) => cell(h, true)).join('')}</tr>
      ${rows}
    </table>
    ${set.items.length > 60 ? proposalNote(`&hellip; ve ${set.items.length - 60} kayıt daha.`) : ''}`;
}

// the /p/* pair is the only unauthenticated surface that can move prices —
// throttle it per IP so a stolen link cannot be hammered
const pTries = new Map(); // ip -> [timestamps]
app.use('/p', (req, res, next) => {
  const ip = clientIp(req);
  const now = Date.now();
  const list = (pTries.get(ip) || []).filter((x) => now - x < 60 * 1000);
  list.push(now);
  pTries.set(ip, list);
  if (list.length > 20) return res.status(429).send('Çok fazla istek — biraz sonra tekrar dene.');
  next();
});

app.get('/p/:id', (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Referrer-Policy', 'no-referrer'); // the token must not leak in a Referer
  const set = findSet(String(req.params.id));
  // one wrong-or-unknown answer: an invalid token must not reveal whether the id exists
  if (!set || !proposalTokenOk(set, req.query.t))
    return res.status(404).send(
      proposalPage('Bağlantı geçersiz', proposalNote('Bu onay bağlantısı geçerli değil. E-postadaki en son bağlantıyı kullan ya da konsoldan devam et.'))
    );
  if (proposalExpired(set))
    return res.status(410).send(
      proposalPage('Bağlantının süresi doldu', proposalNote('Bu öneri seti 72 saatten eski. Fiyatlar o günden beri değişmiş olabilir, bu yüzden bağlantı kapandı — konsoldan güncel önerilere bakabilirsin.'))
    );
  if (set.status === 'applied')
    return res.send(
      proposalPage('Bu öneri zaten uygulandı', proposalNote(`${(set.result || {}).ok || 0} değişiklik ${escHtml(String(set.appliedAt || '').slice(0, 16).replace('T', ' '))} UTC itibarıyla uygulanmış durumda. Yeniden uygulanmayacak.`))
    );
  if (set.status !== 'pending')
    return res.send(
      proposalPage('Bu öneri güncelliğini yitirdi', proposalNote('Pazar bu set hazırlandıktan sonra değişti ve daha yeni bir öneri seti oluştu. En son e-postadaki bağlantıyı kullan.'))
    );
  const tok = escHtml(String(req.query.t));
  res.send(
    proposalPage(
      `${set.items.length} fiyat önerisini onayla`,
      proposalNote(
        `Aşağıdaki ${set.items.length} kural FuseMetrix'e yazılacak. Bu sayfayı açman hiçbir şeyi değiştirmedi — değişiklikler yalnızca düğmeye bastığında uygulanır, ve sonrasında konsoldaki Aktivite listesinden tek tıkla geri alınabilir.`
      ) +
        proposalTable(set) +
        `<form method="POST" action="/p/${escHtml(set.id)}/apply" style="margin-top:22px;">
          <input type="hidden" name="t" value="${tok}">
          <button type="submit" style="background:${MAIL_GREEN};color:#ffffff;font-size:15px;font-weight:700;padding:13px 22px;border:0;border-radius:6px;cursor:pointer;">ONAYLA VE UYGULA</button>
        </form>`
    )
  );
});

app.post('/p/:id/apply', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Referrer-Policy', 'no-referrer');
  const send = (code, title, note) => res.status(code).send(proposalPage(title, proposalNote(note)));
  const set = findSet(String(req.params.id));
  const tok = (req.body || {}).t;
  if (!set || !proposalTokenOk(set, tok))
    return send(404, 'Bağlantı geçersiz', 'Bu onay bağlantısı geçerli değil. Hiçbir şey uygulanmadı.');
  if (proposalExpired(set))
    return send(410, 'Bağlantının süresi doldu', 'Bu öneri seti 72 saatten eski, bu yüzden uygulanmadı. Konsoldan güncel önerilere bakabilirsin.');
  if (set.status === 'applied')
    return send(200, 'Bu öneri zaten uygulandı', `${(set.result || {}).ok || 0} değişiklik daha önce uygulandı; ikinci kez uygulanmadı.`);
  if (set.status !== 'pending')
    return send(200, 'Bu öneri güncelliğini yitirdi', 'Daha yeni bir öneri seti oluştuğu için bu set uygulanmadı.');
  if (applyInFlight.has(set.id))
    return send(200, 'Uygulama sürüyor', 'Bu öneri seti şu anda uygulanıyor. Birkaç saniye sonra konsoldaki Aktivite listesinden sonucu görebilirsin.');
  applyInFlight.add(set.id);
  // A set of 50-150 cells takes minutes of FMX writes, and Firebase Hosting cuts
  // this request at 60s — waiting for the loop would answer "Uygulanamadı" on a
  // run that is going through fine. Confirm the approval now; the confirmation
  // mail and the activity log carry the outcome.
  applyProposalSet(set, 'mail')
    .catch((e) => console.log('Proposal apply failed:', e.message))
    .finally(() => applyInFlight.delete(set.id));
  return send(
    202,
    `${set.items.length} öneri uygulanıyor`,
    `Onayın alındı. ${set.items.length} fiyat kuralı şu anda FuseMetrix'e yazılıyor; bu birkaç dakika sürebilir. Sonucu konsoldaki Aktivite listesinde ve az sonra gelecek onay mailinde göreceksin — bu sayfayı kapatabilirsin. Değişikliklerin tamamı Aktivite listesinden tek tıkla geri alınabilir.`
  );
});

// ---------- manual scan-apply report (S5) ----------
// The console fires this after an apply that included scan proposals. It must
// never break the caller's apply flow, so it answers ok even when mail fails.

app.post(
  '/api/report/scan-apply',
  wrap(async (req, res) => {
    const b = req.body || {};
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 200);
    const ok = Number(b.ok) || 0;
    const fail = Number(b.fail) || 0;
    let mailed = false;
    if (items.length && mailer) {
      const rows = items.slice(0, 40).map((it) => {
        const cats = (Array.isArray(it.cats) ? it.cats : [])
          .filter((c) => c && c.rankNow != null && c.rankAfter != null)
          .map((c) => `${escHtml(catTr(c.cat))} #${c.rankNow}&rarr;#${c.rankAfter}`)
          .join(', ');
        const cur = Number(it.curPct) || 0;
        const nxt = Number(it.newPct) || 0;
        return [
          dayLabel({ day: Number(it.day), month: Number(it.month), year: Number(it.year) }),
          `${it.stationName ? String(it.stationName) + ' · ' : ''}${Number(it.duration)} gün`,
          `${pctTxt(cur)} &rarr; <b>${pctTxt(nxt)}</b>`,
          cats ? (nxt < cur ? mailUp(cats) : mailWarn(cats)) : '&mdash;',
        ].map((c) => (typeof c === 'string' ? c : String(c)));
      });
      const html = alertMailHtml(
        `İşlem tamamlandı — ${ok} fiyat güncellendi`,
        [
          {
            title: 'UYGULANAN DEĞİŞİKLİKLER',
            header: ['TARİH', 'SÜRE', 'ESKİ &rarr; YENİ', 'KATEGORİ ETKİSİ'],
            rows,
            note:
              (items.length > 40 ? `&hellip; ve ${items.length - 40} kayıt daha. ` : '') +
              'rentalcars.com yeni fiyatları hemen göstermez — arama sonuçlarına yansıması birkaç dakika sürer, o yüzden hemen kontrol edersen hâlâ eski fiyatı görebilirsin.',
          },
        ],
        `Konsoldan yaptığın tarama sonrası ${ok} fiyat kuralı FuseMetrix'e yazıldı${fail ? `, ${fail} tanesi başarısız oldu` : ''}. Aşağıdaki tablo hangi gün için hangi yüzdenin uygulandığını ve GM'in kategori sıralarının nasıl değiştiğini gösterir. Tamamını konsoldaki Aktivite listesinden tek tıkla geri alabilirsin.`
      );
      try {
        await sendMail(`[GM] İşlem tamamlandı — ${ok} fiyat güncellendi`, html);
        mailed = true;
        addLog({
          action: 'mail-scan-apply', station: null, stationName: 'SCAN',
          day: null, month: null, year: null, duration: null,
          before: null, after: null, ok: true,
          file: `${ok} değişiklik${b.batch ? ' · ' + String(b.batch).slice(0, 32) : ''}`,
        });
      } catch (e) {
        console.log('Scan-apply report mail failed:', e.message);
      }
    }
    res.json({ ok: true, mailed });
  })
);

// ---------- category governance API ----------

app.get(
  '/api/autoscan/categories',
  wrap(async (req, res) => {
    res.json({
      all: RC_CAT_KEYS,
      selected: autoCategories() || [], // [] = every category
      lowPriceGuard: autoLowGuard(),
      gapChfByDur: autoGapTable(),          // effective: the operator's over the defaults
      own: autoState().gapChfByDur || {},   // only what the operator actually set
      gapDefaults: AUTOSCAN.gapChfByDur,
      gapBandChf: AUTOSCAN.gapBandChf,
      targetRank: AUTOSCAN.targetRank,
    });
  })
);

app.post(
  '/api/autoscan/categories',
  wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = req.body || {};
    const list = Array.isArray(body.categories) ? body.categories.map(String) : [];
    const clean = [...new Set(list)].filter((c) => RC_CAT_KEYS.includes(c));
    if (list.length && !clean.length) throw new FmxError('BAD_CATEGORY', 400);
    // empty list = govern every category, the engine's original behaviour
    autoState().categories = clean;
    // the low-price backstop, not a target: below ~67 CHF it is what stops a
    // flat franc gap turning into a quarter off the price
    if (body.lowPriceGuard != null) {
      const g = Number(body.lowPriceGuard);
      if (!isFinite(g) || g < 0.1 || g > 0.3) throw new FmxError('BAD_UNDERCUT', 400);
      autoState().lowPriceGuard = g;
    }
    // the per-duration gap table: francs under the cheapest competitor for our
    // cheapest car. Entries are stored one by one; a missing or empty entry
    // falls back to the measured default for that duration.
    if (body.gapChfByDur != null) {
      if (typeof body.gapChfByDur !== 'object') throw new FmxError('BAD_GAP', 400);
      const tbl = {};
      for (let d = 1; d <= 14; d++) {
        const raw = body.gapChfByDur[d];
        if (raw == null || raw === '') continue;
        const v = Number(raw);
        if (!isFinite(v) || v < 0 || v > 200) throw new FmxError('BAD_GAP', 400);
        tbl[d] = Math.round(v * 10) / 10;
      }
      autoState().gapChfByDur = tbl;
    }
    saveWatchBase();
    addLog({
      action: 'autoscan-categories', station: null, stationName: 'AUTO SCAN',
      day: null, month: null, year: null, duration: null,
      before: null, after: null, ok: true,
      file: clean.length ? clean.join(', ') : 'TÜM KATEGORİLER',
    });
    res.json({ ok: true, selected: clean, lowPriceGuard: autoLowGuard(), gapChfByDur: autoGapTable() });
  })
);

function autoScanStatus() {
  const st = autoState();
  const pending = pendingSet();
  return {
    enabled: AUTOSCAN.enabled,
    lastRun: st.lastRun || null,
    horizonEnd: horizonEnd(),
    horizonDays: AUTOSCAN_HORIZON_DAYS,
    pending: pending ? pending.id : null,
    pendingCount: pending && Array.isArray(pending.items) ? pending.items.length : 0,
    missingCount: pending && Array.isArray(pending.missing) ? pending.missing.length : 0,
    ratings: st.ratings || {},
    lastMail: st.lastMail || null,
  };
}

// ---------- boot migrations ----------

/** Preferences used to be one flat `{ mailTo }` for the whole console. They are
 *  per-uid now, so the old address moves under the seeded admin account — the
 *  operator who set it — and keeps working without anyone re-entering it. */
async function migratePrefs() {
  const prefs = store.get('prefs', {});
  if (typeof prefs.mailTo !== 'string') return;
  const next = { ...prefs };
  const mine = { ...(next[SEED_SUPERADMIN_UID] || {}) };
  if (!mine.mailTo) mine.mailTo = prefs.mailTo;
  delete next.mailTo;
  next[SEED_SUPERADMIN_UID] = mine;
  await store.setNow('prefs', next).catch((e) =>
    console.log('prefs migration persist failed:', e.message)
  );
  console.log('prefs migrated to per-uid shape');
}

/** The seeded owner account carries the superadmin flag; set it once if the
 *  mirrored profile predates it. Never granted to anyone else automatically. */
async function seedSuperadmin() {
  try {
    const ref = usersCol().doc(SEED_SUPERADMIN_UID);
    const snap = await ref.get();
    if (!snap.exists) {
      // the profile is gone but the account is not: rebuild it, otherwise a
      // deleted doc would strip the owner flag with no way back in-product
      const u = await admin.auth().getUser(SEED_SUPERADMIN_UID).catch(() => null);
      if (!u) return; // no such account — nothing to flag
      await ref.set({
        email: u.email || null,
        role: 'admin',
        displayName: u.displayName || null,
        createdAt: new Date().toISOString(),
        tenant: DEFAULT_TENANT,
        superadmin: true,
      });
      noteSuperadmin(SEED_SUPERADMIN_UID, true);
      console.log('superadmin profile restored for the seeded admin');
      return;
    }
    if (snap.data().superadmin === true) {
      noteSuperadmin(SEED_SUPERADMIN_UID, true);
      return;
    }
    await ref.set({ superadmin: true }, { merge: true });
    noteSuperadmin(SEED_SUPERADMIN_UID, true);
    console.log('superadmin flag set on the seeded admin profile');
  } catch (e) {
    console.log('superadmin seed skipped:', e.message);
  }
}

// SPA entry: any non-API, non-file path serves the console shell
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/** Load persisted state, then hand back the ready Express app. */
const booted = store.ready().then(async () => {
  if (!authSecret) {
    // cloud without AUTH_SECRET: use one stable secret persisted in Firestore
    // so operator cookies survive cold starts; local: per-run random is fine.
    authSecret = store.IS_CLOUD
      ? await store.getOrCreateSecret('authSecret')
      : crypto.randomBytes(32).toString('hex');
  }
  // franchise registry: seeded on first boot from TENANT_SEED, so a fresh
  // deployment comes up with exactly the stations this console always had
  const saved = store.get('tenants');
  if (saved && typeof saved === 'object' && Object.keys(saved).length) tenants = saved;
  else await store.setNow('tenants', tenants).catch((e) =>
    console.log('tenant seed persist failed:', e.message)
  );
  // a restored FMX cookie belongs to the default franchise until someone signs
  // in again, so bind host + validation station before it is used
  bindFmxTenant(DEFAULT_TENANT);
  const cookie = store.get('session');
  if (cookie) fmx.setCookie(cookie);
  authGen = store.get('auth', { gen: 1 }).gen || 1;
  await migratePrefs();
  seedSuperadmin(); // fire and forget: Firestore may be unreachable locally
  activityLog = store.get('logs', []);
  watchBase = store.get('watch', {});
  rcCache = store.get('rc', {});
  WATCH.lastRun = watchBase.__lastRun || null;
  fmx.loadDetailCache(store.get('details', {}), (data) => store.set('details', data));
  return app;
});

// local run: start listening. cloud: index.js awaits `booted` and exports it.
if (require.main === module) {
  booted.then(() => {
    app.listen(PORT, () => {
      console.log(`GM Pricing Console -> http://localhost:${PORT}`);
    });
    // if a relay target is configured, this machine also serves the deployed
    // console's rentalcars queries while the local console is running
    const relay = require('./relay');
    const rcfg = relay.loadConfig();
    if (rcfg) relay.startRelay(rcfg);
  });
}

module.exports = { app, booted, store };
