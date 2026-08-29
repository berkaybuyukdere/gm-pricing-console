/**
 * THE PRICING BAND (Berkay, 2026-08-28): sit JUST under the cheapest
 * competitor. "If the cheapest firm is at 100 CHF, be at 95-97 — never 70."
 *
 *   target = cheapest x 0.97
 *   floor  = max(cheapest x 0.95, cheapest - 10 CHF)   // per category
 *
 * One FMX % scales every GM car together, so the tightest category's target
 * governs, clamped up to the highest category floor. All math runs on
 * DISPLAYED prices, so an active campaign discount is already inside it.
 *
 * Pure-function checks on categoryFactor, lifted out of server.js.
 *
 *   node test/margin-floor.test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const cfg = src.match(/const AUTOSCAN = \{[\s\S]*?\n\};/)[0];
const fn = src.match(/function categoryFactor\(r, targetRank, opts = \{\}\) \{[\s\S]*?\n\}\n/)[0];
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gm-band-')), 'f.js');
fs.writeFileSync(tmp, `
const { RC_CAT_KEYS, rcIsGm, rcRowInCat } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'rc.js'))});
${cfg}
const round2 = (n) => Math.round(n * 100) / 100;
${fn}
module.exports = { categoryFactor, AUTOSCAN };
`);
const { categoryFactor, AUTOSCAN } = require(tmp);

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };

const gm = (price, cats) => ({ supplier: 'Green Motion', price, categories: cats, carClass: '' });
const other = (supplier, price, cats) => ({ supplier, price, categories: cats, carClass: '' });
const mk = (rows) => ({ top: [...rows].sort((a, b) => a.price - b.price) });
const band = (cheapest) => [Math.max(cheapest * (1 - AUTOSCAN.maxUndercut), cheapest - AUTOSCAN.maxUndercutChf), cheapest];

// --- Berkay's own numbers: cheapest firm at 100, GM must land at 95-97
const c100 = mk([
  gm(120, ['economy']),
  other('Alamo', 100, ['economy']), other('Hertz', 110, ['economy']), other('Sixt', 115, ['economy']),
]);
let r = categoryFactor(c100, 1, {});
let after = 120 * r.factor;
ck(`GM above the cheapest comes DOWN to ~97 per their 100 (got ${after.toFixed(2)})`,
  Math.abs(after - 97) < 0.01, after.toFixed(2));

// --- GM far too cheap (their 100, GM at 70) is pulled UP into the band
const cheap = mk([
  gm(70, ['economy']),
  other('Alamo', 100, ['economy']), other('Hertz', 110, ['economy']), other('Sixt', 115, ['economy']),
]);
r = categoryFactor(cheap, 1, {});
after = 70 * r.factor;
ck(`GM at 70 against their 100 comes UP into the band (got ${after.toFixed(2)})`,
  after >= band(100)[0] - 0.01 && after <= 100, after.toFixed(2));

// --- the reported 40-vs-80 short-rental case
const short = mk([
  gm(40, ['economy']),
  other('Alamo', 80, ['economy']), other('Hertz', 88, ['economy']), other('Sixt', 95, ['economy']),
]);
r = categoryFactor(short, 1, {});
after = 40 * r.factor;
ck(`the 40-vs-80 day is corrected up into the band (got ${after.toFixed(2)})`,
  after >= band(80)[0] - 0.01 && after <= 80, after.toFixed(2));

// --- on an expensive rental the 10 CHF bound binds, not the 5%
const long = mk([
  gm(200, ['suvs']),
  other('Avis', 400, ['suvs']), other('Budget', 420, ['suvs']), other('Europcar', 450, ['suvs']),
]);
r = categoryFactor(long, 1, {});
after = 200 * r.factor;
ck(`the 200-vs-400 rental lands at 390+ (10 CHF bound, got ${after.toFixed(2)})`,
  after >= 390 - 0.01 && after <= 400, after.toFixed(2));
ck('...and the floor reports that it clamped', r.clamped === true, JSON.stringify(r.clamped));

// --- a price already inside the band gets only a tiny nudge, never a dive
const inBand = mk([
  gm(96, ['economy']),
  other('Alamo', 100, ['economy']), other('Hertz', 108, ['economy']),
]);
r = categoryFactor(inBand, 1, {});
after = 96 * r.factor;
ck(`96 against their 100 stays in the band (got ${after.toFixed(2)})`,
  after >= band(100)[0] - 0.01 && after <= 100, after.toFixed(2));

// --- multi-category: no category may end up under its own floor
const multi = mk([
  gm(90, ['economy']), other('Alamo', 100, ['economy']), other('Hertz', 105, ['economy']),
  gm(300, ['suvs']), other('Avis', 250, ['suvs']), other('Budget', 260, ['suvs']),
]);
r = categoryFactor(multi, 1, {});
for (const c of r.cats) {
  const [lo] = band(c.anchor);
  ck(`${c.cat}: result ${(c.gmPrice * r.factor).toFixed(2)} respects its floor ${lo.toFixed(2)}`,
    c.gmPrice * r.factor >= lo - 0.01, (c.gmPrice * r.factor).toFixed(2));
}

// --- the REAL captured ZRH market: every governed category respects its band
const { rcParse } = require('../lib/rc.js');
const live = rcParse(require('./fixtures/rc-search-zrh.json'), { cfgName: 'ZRH', pickUp: '', dropOff: '' });
r = categoryFactor(live, 1, {});
ck('the live market yields a finite positive factor', r && isFinite(r.factor) && r.factor > 0, r && r.factor);
let worst = null;
for (const c of r.cats) {
  const res = c.gmPrice * r.factor;
  const [lo] = band(c.anchor);
  if (res < lo - 0.01) worst = `${c.cat}: ${res.toFixed(2)} < floor ${lo.toFixed(2)}`;
}
ck('no live category ends up under its own floor', worst == null, worst);
ck('no live category ends up deep-undercutting (>10 CHF under its cheapest)',
  r.cats.every((c) => c.gmPrice * r.factor >= c.anchor - AUTOSCAN.maxUndercutChf - 0.01),
  JSON.stringify(r.cats.map((c) => [c.cat, (c.anchor - c.gmPrice * r.factor).toFixed(2)])));

fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
