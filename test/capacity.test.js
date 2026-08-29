/**
 * The capacity guard. The console runs on ONE Cloud Run instance, so when
 * market queries pile up it must refuse ONE query — with a Retry-After the
 * client can wait on — rather than let Cloud Run abort unrelated page loads
 * with its own blind 429 (what the operator experiences as the site crashing).
 *
 *   node test/capacity.test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const guard = src.match(/const rcGuard = \{[\s\S]*?\n\};/);
const take = src.match(/function rcGuardTake\(req\) \{[\s\S]*?\n\}/);
if (!guard || !take) { console.error('FAIL  could not lift the capacity guard out of server.js'); process.exit(1); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-cap-'));
const tmp = path.join(dir, 'c.js');
fs.writeFileSync(tmp, `
class FmxError extends Error { constructor(m, c) { super(m); this.code = c; } }
${guard[0]}
${take[0]}
module.exports = { rcGuard, rcGuardTake, FmxError };
`);
const { rcGuard, rcGuardTake } = require(tmp);

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };
const req = (uid) => ({ operator: { uid } });
const grab = (uid) => { try { return { ok: true, release: rcGuardTake(req(uid)) }; } catch (e) { return { ok: false, err: e }; } };

// --- concurrency ceiling
const held = [];
for (let i = 0; i < rcGuard.max; i++) held.push(grab('u1'));
ck(`the first ${rcGuard.max} concurrent queries are admitted`, held.every((h) => h.ok), JSON.stringify(held.map((h) => h.ok)));
const over = grab('u1');
ck('one past the ceiling is refused', !over.ok && over.err.message === 'RC_BUSY', over.ok ? 'admitted' : over.err.message);
ck('...with a 429 and a Retry-After the client can wait on',
  !over.ok && over.err.code === 429 && over.err.retryAfter > 0, over.err && over.err.retryAfter);

// releasing a slot lets the next one through — the guard must not latch
held[0].release();
const after = grab('u1');
ck('releasing a slot admits the next query', after.ok, after.err && after.err.message);
after.ok && after.release();
held.slice(1).forEach((h) => h.release());
ck('every slot is returned when the queries finish', rcGuard.live === 0, rcGuard.live);

// --- per-operator burst brake
rcGuard.hits.clear();
rcGuard.live = 0;
let admitted = 0, limited = null;
for (let i = 0; i < rcGuard.perMinute + 10; i++) {
  const g = grab('u2');
  if (g.ok) { admitted++; g.release(); } else if (g.err.message === 'RC_RATE_LIMIT') { limited = g.err; break; }
}
ck(`one operator is capped at ${rcGuard.perMinute} queries/minute`, admitted === rcGuard.perMinute, admitted);
ck('the cap answers RC_RATE_LIMIT with a wait in seconds',
  limited && limited.code === 429 && limited.retryAfter > 0, limited && limited.retryAfter);

// one operator hitting their cap must NOT lock anyone else out
const other = grab('u3');
ck('a second operator is unaffected by the first one\'s cap', other.ok, other.err && other.err.message);
other.ok && other.release();

// --- the brake's own bookkeeping cannot grow without bound
rcGuard.hits.clear();
rcGuard.live = 0;
for (let i = 0; i < 260; i++) { const g = grab('user' + i); if (g.ok) g.release(); }
ck('the per-operator table is pruned, not grown forever', rcGuard.hits.size <= 220, rcGuard.hits.size);

// --- the client contract: Retry-After is surfaced by the error wrapper
ck('the error wrapper sends Retry-After on self-imposed limits',
  /if \(e\.retryAfter\) res\.set\('Retry-After'/.test(src), 'wrap() does not set the header');
ck('the client honours Retry-After instead of guessing',
  /res\.headers\.get\('Retry-After'\)/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')),
  'app.js ignores the header');

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
