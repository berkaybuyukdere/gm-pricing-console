/**
 * Persistence layer for the console.
 *
 * Local run   : exactly the legacy behaviour — JSON files in the repo root
 *               (.logs.json, .rc-watch.json, .cache-details.json, …).
 * Cloud run   : ephemeral caches live in /tmp (rebuilt after a cold start),
 *               durable state (activity log, watch baseline, restore points)
 *               lives in Firestore so nothing is lost when an instance dies.
 *
 * Everything is read once at boot into memory, so the rest of the server keeps
 * using plain synchronous getters; writes are debounced and fire-and-forget.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const IS_CLOUD =
  process.env.RUNTIME === 'cloud' ||
  !!(process.env.K_SERVICE || process.env.FUNCTION_TARGET || process.env.K_REVISION);
const ROOT = path.join(__dirname, '..');
const CACHE_DIR = IS_CLOUD ? '/tmp' : ROOT;

// key -> { file, durable, json }
const KEYS = {
  session: { file: '.session', durable: true, json: false },
  logs: { file: '.logs.json', durable: true, json: true },
  watch: { file: '.rc-watch.json', durable: true, json: true },
  details: { file: '.cache-details.json', durable: false, json: true },
  rc: { file: '.rc-cache.json', durable: false, json: true },
};

let db = null;
if (IS_CLOUD) {
  const { Firestore } = require('@google-cloud/firestore');
  db = new Firestore();
}

const mem = new Map();
const timers = new Map();
let readyPromise = null;

const localPath = (key) =>
  path.join(KEYS[key].durable && !IS_CLOUD ? ROOT : CACHE_DIR, KEYS[key].file);

function readLocal(key) {
  try {
    const raw = fs.readFileSync(localPath(key), 'utf8');
    return KEYS[key].json ? JSON.parse(raw) : raw;
  } catch {
    return undefined;
  }
}

async function readCloudDurable(key) {
  try {
    const snap = await db.collection('state').doc(key).get();
    if (!snap.exists) return undefined;
    const d = snap.data();
    return KEYS[key].json ? JSON.parse(d.value) : d.value;
  } catch {
    return undefined;
  }
}

/** Load every key into memory. Safe to call repeatedly. */
function ready() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    for (const key of Object.keys(KEYS)) {
      let val;
      if (IS_CLOUD && KEYS[key].durable) val = await readCloudDurable(key);
      else val = readLocal(key);
      if (val !== undefined) mem.set(key, val);
    }
  })();
  return readyPromise;
}

function get(key, fallback) {
  return mem.has(key) ? mem.get(key) : fallback;
}

async function persist(key) {
  const val = mem.get(key);
  if (val === undefined) return;
  const raw = KEYS[key].json ? JSON.stringify(val) : String(val);
  if (IS_CLOUD && KEYS[key].durable) {
    await db.collection('state').doc(key).set({ value: raw, at: new Date() });
  } else {
    await fs.promises.writeFile(localPath(key), raw, 'utf8');
  }
}

/** Update a key in memory and schedule a write. */
function set(key, value, { immediate = false, debounceMs = 400 } = {}) {
  mem.set(key, value);
  clearTimeout(timers.get(key));
  if (immediate) return persist(key).catch(() => {});
  timers.set(
    key,
    setTimeout(() => persist(key).catch(() => {}), debounceMs)
  );
}

/** Write a key through immediately, surfacing any error. */
async function setNow(key, value) {
  mem.set(key, value);
  clearTimeout(timers.get(key));
  await persist(key);
}

// ---------- restore points ----------
// Local: .backups/<file>.json — Cloud: Firestore docs holding gzipped JSON.

const BACKUP_DIR = path.join(ROOT, '.backups');

async function backupPut(file, snapshot) {
  const raw = JSON.stringify(snapshot);
  if (IS_CLOUD) {
    const gz = zlib.gzipSync(Buffer.from(raw, 'utf8')).toString('base64');
    await db.collection('backups').doc(file).set({
      file,
      gz,
      size: raw.length,
      at: new Date(),
    });
    return;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(path.join(BACKUP_DIR, file), raw);
}

async function backupList() {
  if (IS_CLOUD) {
    const snap = await db.collection('backups').orderBy('file', 'desc').limit(50).get();
    return snap.docs.map((d) => {
      const v = d.data();
      return { file: v.file, size: v.size || 0, ts: v.at ? v.at.toDate().toISOString() : null };
    });
  }
  let files = [];
  try {
    files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {
    return [];
  }
  return files.map((f) => {
    try {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, size: st.size, ts: st.mtime.toISOString() };
    } catch {
      return { file: f, size: 0, ts: null };
    }
  });
}

async function backupGet(file) {
  const safe = path.basename(String(file));
  if (IS_CLOUD) {
    const snap = await db.collection('backups').doc(safe).get();
    if (!snap.exists) return null;
    const raw = zlib.gunzipSync(Buffer.from(snap.data().gz, 'base64')).toString('utf8');
    return JSON.parse(raw);
  }
  const p = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

module.exports = {
  IS_CLOUD,
  ready,
  get,
  set,
  setNow,
  backupPut,
  backupList,
  backupGet,
};
