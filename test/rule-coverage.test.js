/**
 * Regression: re-pricing a CATEGORY-SCOPED weekly rule must not widen it.
 *
 * An FMX update rewrites the rule's vehicle-group coverage and rebuilds its
 * name. Before this was fixed, any price nudge that did not restate the
 * coverage silently reset a category rule to ALL 39 groups and stripped the
 * category name out of the rule title — erasing the operator's per-category
 * setup. Reported live on 2026-08-27.
 *
 *   node test/rule-coverage.test.js
 */
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-rule-coverage-'));
const REPO = path.join(WORK, 'repo');
execFileSync('rsync', [
  '-a', '--exclude', 'node_modules', '--exclude', '.git',
  '--exclude', '.*.json', '--exclude', '.session', '--exclude', '.secrets.json',
  SRC + '/', REPO + '/',
]);
fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(REPO, 'node_modules'));
const WRITES = path.join(WORK, 'writes.json');

const base = 'http://127.0.0.1:4693';
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const payload = b64u(JSON.stringify({ u: 'smoke', uid: 'u1', role: 'admin', tn: 'gmzurich', exp: Date.now() + 3600000, g: 1 }));
const cookie = '__session=' + payload + '.' + b64u(crypto.createHmac('sha256', 'testsecret-abc').update(payload).digest());
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };

function boot() {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [path.join(REPO, 'test', 'rule-coverage-boot.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('BOOT_READY')) resolve(p); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => reject(new Error('boot died: ' + c + '\n' + out.slice(-2000))));
    setTimeout(() => reject(new Error('boot timeout\n' + out.slice(-2000))), 20000);
  });
}
const api = async (m, u, body) => {
  const r = await fetch(base + u, {
    method: m,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
// each row is {kind, args}; flatten so assertions read naturally
const writes = () => {
  try { return JSON.parse(fs.readFileSync(WRITES, 'utf8')).map((r) => ({ kind: r.kind, ...r.args })); }
  catch { return []; }
};
const reset = () => fs.rmSync(WRITES, { force: true });

(async () => {
  const srv = await boot();

  // --- 1. the grid's staged apply: a price-only PUT (no vehicleIds in the body)
  reset();
  const put = await api('PUT', '/api/rule/5001', {
    station: 61489, year: 2026, month: 9, day: 12, duration: 3, pct: -25, prevPct: -20,
  });
  ck('price-only update accepted', put.status === 200, JSON.stringify(put.body));
  const w1 = writes()[0];
  ck('update reached FMX', !!w1 && w1.kind === 'update', JSON.stringify(writes()));
  ck('coverage preserved (groups 3+7, NOT all 39)',
    w1 && w1.resolved === '3, 7', w1 && w1.resolved);
  ck('category name preserved in the rule title',
    w1 && w1.groupLabel === 'SUV GRUBU', w1 && JSON.stringify(w1.groupLabel));
  ck('the new price is the one that was asked for', w1 && Number(w1.pct) === -25, w1 && w1.pct);

  // --- 2. an EXPLICIT coverage still wins (bulk sweeps rely on this)
  reset();
  const put2 = await api('PUT', '/api/rule/5001', {
    station: 61489, year: 2026, month: 9, day: 12, duration: 3, pct: -30,
    vehicleIds: ['5'], groupName: 'YENI GRUP',
  });
  ck('explicit-coverage update accepted', put2.status === 200, JSON.stringify(put2.body));
  const w2 = writes()[0];
  ck('explicit coverage overrides the live rule', w2 && w2.resolved === '5', w2 && w2.resolved);
  ck('explicit label overrides too', w2 && w2.groupLabel === 'YENI GRUP', w2 && w2.groupLabel);

  // --- 3. the auto-scan proposal apply path (the seeded pending set)
  reset();
  const ap = await api('POST', '/api/proposals/seedset01/apply', {});
  ck('proposal apply accepted', ap.status === 202, JSON.stringify(ap.body));
  for (let i = 0; i < 60 && !writes().length; i++) await new Promise((r) => setTimeout(r, 100));
  const w3 = writes()[0];
  ck('auto-scan apply reached FMX', !!w3 && w3.kind === 'update', JSON.stringify(writes()));
  ck('auto-scan apply preserves coverage (3+7, NOT all 39)',
    w3 && w3.resolved === '3, 7', w3 && w3.resolved);
  ck('auto-scan apply preserves the category name',
    w3 && w3.groupLabel === 'SUV GRUBU', w3 && JSON.stringify(w3.groupLabel));

  srv.kill('SIGKILL');
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('DRIVER ERROR', e); process.exit(1); });
