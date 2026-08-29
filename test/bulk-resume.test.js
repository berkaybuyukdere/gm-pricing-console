/**
 * Proves a bulk sweep survives an instance recycle: the server process is
 * SIGKILLed mid-sweep, a fresh process boots (fresh memory, like a new Cloud
 * Run instance), and the scheduler tick resumes the sweep from its durable
 * checkpoint — every cell written exactly once.
 *
 * Runs against a COPY of the repo in a temp dir with a stateful fake FMX
 * (test/bulk-resume-boot.js), so it never touches real FMX, Firestore, or the
 * repo's own local state files.
 *
 *   node test/bulk-resume.test.js
 */
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bulk-resume-'));
const REPO = path.join(WORK, 'repo');
execFileSync('rsync', [
  '-a', '--exclude', 'node_modules', '--exclude', '.git',
  '--exclude', '.*.json', '--exclude', '.session', '--exclude', '.secrets.json',
  SRC + '/', REPO + '/',
]);
fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(REPO, 'node_modules'));

const base = 'http://127.0.0.1:4692';
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const payload = b64u(JSON.stringify({ u: 'smoke', uid: 'u1', role: 'admin', tn: 'gmzurich', exp: Date.now() + 3600000, g: 1 }));
const cookie = '__session=' + payload + '.' + b64u(crypto.createHmac('sha256', 'testsecret-abc').update(payload).digest());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };

function boot() {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [path.join(REPO, 'test', 'bulk-resume-boot.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    // surface the server's own log: when a sweep pauses it says so, and that
    // line is the difference between "flaky test" and "the resume is stuck"
    p.stdout.on('data', (d) => {
      out += d;
      String(d).split('\n').filter((l) => /bulk .*: paused/.test(l)).forEach((l) => console.log('  [server]', l.trim()));
      if (out.includes('BOOT_READY')) resolve(p);
    });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => reject(new Error('boot died: ' + c + '\n' + out.slice(-2000))));
    setTimeout(() => reject(new Error('boot timeout\n' + out.slice(-2000))), 20000);
  });
}
const api = async (m, u, body, hdr = {}) => {
  const r = await fetch(base + u, {
    method: m,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...hdr },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// a start date ~4 months out: far enough to never matter, inside BULK_MAX_MONTHS_AHEAD
const startD = new Date();
startD.setMonth(startD.getMonth() + 4);
startD.setDate(1);
const endD = new Date(startD);
endD.setDate(endD.getDate() + 199); // 200 days x 2 durations = 400 cells
const iso = (d) => d.toISOString().slice(0, 10);

(async () => {
  let p1 = await boot();
  const start = await api('POST', '/api/rules/bulk', {
    station: 61489, startDate: iso(startD), endDate: iso(endD), durations: [1, 2], pct: -20, skipExisting: true,
  });
  ck('sweep started', start.status === 200 && start.body.jobId, JSON.stringify(start.body));
  const jobId = start.body.jobId;

  // wait until real progress landed AND a durable checkpoint exists on disk
  let checkpointed = null;
  for (let i = 0; i < 300 && !checkpointed; i++) {
    await sleep(100);
    try {
      const wb = JSON.parse(fs.readFileSync(path.join(REPO, '.rc-watch.json'), 'utf8'));
      if (wb.__bulkJob && wb.__bulkJob.job.cursor > 0) checkpointed = wb.__bulkJob.job;
    } catch {}
  }
  ck('durable checkpoint written mid-sweep', !!checkpointed, 'no checkpoint appeared within 30s');

  p1.kill('SIGKILL'); // the instance recycle
  await sleep(300);
  const rulesAtKill = JSON.parse(fs.readFileSync(path.join(WORK, 'rules.json'), 'utf8')).rules.length;
  ck('progress existed at kill time', rulesAtKill > 0 && rulesAtKill < 400, 'rules=' + rulesAtKill);

  const p2 = await boot(); // fresh memory, like a new instance
  const gone = await api('GET', `/api/rules/bulk/${jobId}`);
  ck('new instance does not know the job in memory', gone.status === 404, gone.status);

  const tick = await api('POST', '/api/internal/tick', {}, { 'x-internal-secret': 'testinternal-abc' });
  ck('tick resumed the lost sweep', tick.status === 200 && tick.body.resumedBulk === true, JSON.stringify(tick.body));

  // A sweep bigger than one tick's budget PAUSES and is picked up by the next
  // tick — that is the design, and on a loaded machine this 400-cell sweep does
  // straddle two ticks. Keep ticking the way Cloud Scheduler would, so the test
  // proves the real contract (a sweep always finishes) instead of assuming one
  // tick is always enough.
  let st = await api('GET', `/api/rules/bulk/${jobId}`);
  for (let i = 0; i < 12 && st.status === 200 && st.body.status === 'running'; i++) {
    await api('POST', '/api/internal/tick', {}, { 'x-internal-secret': 'testinternal-abc' });
    st = await api('GET', `/api/rules/bulk/${jobId}`);
  }
  ck('job is back and finished', st.status === 200 && st.body.status === 'done', JSON.stringify(st.body));
  ck('all 400 cells accounted for (ok+skipped)', st.body && st.body.ok + st.body.skipped === 400, JSON.stringify(st.body));

  const db = JSON.parse(fs.readFileSync(path.join(WORK, 'rules.json'), 'utf8'));
  ck('exactly 400 rules exist (no duplicate creates)', db.rules.length === 400, 'rules=' + db.rules.length);
  const keys = new Set(db.rules.map((r) => r.from.slice(0, 10) + ':' + r.detail.numDays));
  ck('every (day,duration) cell is unique', keys.size === 400, 'unique=' + keys.size);

  await sleep(1000); // local store debounces writes by 400ms
  const wb2 = JSON.parse(fs.readFileSync(path.join(REPO, '.rc-watch.json'), 'utf8'));
  ck('durable checkpoint cleared after completion', !wb2.__bulkJob, JSON.stringify(wb2.__bulkJob));

  const tick2 = await api('POST', '/api/internal/tick', {}, { 'x-internal-secret': 'testinternal-abc' });
  ck('idle tick is a no-op', tick2.body && tick2.body.resumedBulk === false, JSON.stringify(tick2.body));

  p2.kill('SIGKILL');
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('DRIVER ERROR', e); process.exit(1); });
