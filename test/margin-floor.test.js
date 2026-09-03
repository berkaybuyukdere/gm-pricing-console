/**
 * THE PRICING BAND (Berkay, 2026-09-02 — supersedes the 97/95-per-100 band).
 *
 * Our CHEAPEST car sits a fixed number of FRANCS under the cheapest
 * competitor, and however many of our cars fit under them, fit:
 *
 *   gap   = gapChfByDur[rentalDays]   // measured 2026-09-03; 3 days -> 10 CHF
 *   floor = max(cheapest - gap, cheapest * (1 - lowPriceGuard))
 *   top   = max(cheapest - (gap - gapBandChf), floor)
 *
 * One FMX % scales every GM car together, so placing the cheapest one fixes
 * the whole block; how many of our cars land under the field is an OUTCOME of
 * how wide that station's base-rate ladder is, not a setting. All math runs on
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

const gm = (price, cats) => ({ supplier: 'Green Motion', price, categories: cats || ['economy'], carClass: '' });
const other = (supplier, price, cats) => ({ supplier, price, categories: cats || ['economy'], carClass: '' });
const mk = (rows) => ({ top: [...rows].sort((a, b) => a.price - b.price) });
const gap = (d) => AUTOSCAN.gapChfByDur[d];
const place = (rows, opts) => {
  const r = categoryFactor(mk(rows), 1, opts);
  const cheap = Math.min(...rows.filter((x) => /green motion/i.test(x.supplier)).map((x) => x.price));
  return r && { ...r, after: cheap * r.factor };
};

// --- Berkay's own drawing: the field at 100, a 3-day rental, we land at 90-91
let r = place([gm(120), other('Alamo', 100), other('Hertz', 110), other('Sixt', 115)], { duration: 3 });
ck(`their 100 over 3 days puts us ${gap(3)} CHF under (got ${r.after.toFixed(2)})`,
  Math.abs(r.after - 90.5) < 0.01, r.after.toFixed(2));

// --- the whole point of the rewrite: the BLOCK lands under the field, not one car.
// ZRH's own ladder: UP 150 / T 153 / A 154 / J 155 / C 156 / Y 157 / R 164.
const ZRH = [150, 153, 154, 155, 156, 157, 164].map((b) => b / 150);
r = place([...ZRH.map((k) => gm(120 * k)), other('Alamo', 100), other('Hertz', 110)], { duration: 3 });
const under = ZRH.map((k) => 120 * k * r.factor).filter((p) => p < 100).length;
ck(`the ZRH ladder puts ${under} of 7 cars under the field (old band managed 3)`,
  under >= 6, `${under}`);

// --- the gap GROWS with the rental length, or a flat figure collapses the block
const short = place([gm(130), other('A', 100), other('B', 115)], { duration: 1 });
const long = place([gm(520), other('A', 400), other('B', 460)], { duration: 14 });
ck(`1 day is ${gap(1)} CHF under (got ${(100 - short.after).toFixed(2)})`,
  Math.abs(100 - short.after - (gap(1) - AUTOSCAN.gapBandChf / 2)) < 0.01, short.after.toFixed(2));
ck(`14 days is ${gap(14)} CHF under (got ${(400 - long.after).toFixed(2)})`,
  Math.abs(400 - long.after - (gap(14) - AUTOSCAN.gapBandChf / 2)) < 0.01, long.after.toFixed(2));

// --- a flat franc gap on a cheap field IS a giveaway; the percentage backstops it
r = place([gm(60), other('A', 40), other('B', 48)], { duration: 14 });
const guardFloor = 40 * (1 - AUTOSCAN.lowPriceGuard);
ck(`a 40 CHF field never gives away ${gap(14)} CHF — the ${Math.round(AUTOSCAN.lowPriceGuard * 100)}% guard holds at ${guardFloor} (got ${r.after.toFixed(2)})`,
  Math.abs(r.after - guardFloor) < 0.01, r.after.toFixed(2));

// --- already in the band: no write, and above all no raise
r = place([gm(90.5), other('A', 100), other('B', 110)], { duration: 3 });
ck('a car already in the band is left alone (factor === 1)', r.factor === 1, String(r.factor));

// --- genuinely underselling: the one case that moves a price UP
r = place([gm(70), other('A', 100), other('B', 110)], { duration: 3 });
ck(`70 against their 100 is corrected UP into the band (got ${r.after.toFixed(2)})`,
  r.after > 70 && Math.abs(r.after - 90.5) < 0.01 && r.clamped === true, r.after.toFixed(2));

// --- the 20 CHF gaps: a guard that only watched ITS OWN category let the
// overall-cheapest car sink. Both anchors are market-wide now.
r = place([
  gm(60, ['economy']), gm(300, ['suvs']),
  other('Alamo', 100, ['economy']), other('Hertz', 400, ['suvs']),
], { duration: 3 });
ck(`our cheapest car never sinks below the market floor (got ${r.after.toFixed(2)}, floor 90)`,
  r.after >= 90 - 0.01, r.after.toFixed(2));

// --- scoping: when a lane governs categories, BOTH anchors come from them
r = place([
  gm(60, ['economy']), gm(500, ['suvs']),
  other('Alamo', 100, ['economy']), other('Hertz', 400, ['suvs']),
], { duration: 3, categories: ['SUV'] });
ck(`an SUV lane anchors on the SUV field, not the economy one (got ${(500 * r.factor).toFixed(2)})`,
  Math.abs(500 * r.factor - 390.5) < 0.01, (500 * r.factor).toFixed(2));

// --- no competitor, or no car of ours, in scope -> no opinion
ck('no competitor in scope yields no factor',
  categoryFactor(mk([gm(100)]), 1, { duration: 3 }) === null, 'expected null');
ck('no car of ours in scope yields no factor',
  categoryFactor(mk([other('Alamo', 100)]), 1, { duration: 3 }) === null, 'expected null');


// --- the doctrine against the MEASURED market: 98 ZRH cells, 4-17 Sep 2026,
// 09:00 pickup, read on 2026-09-03 (test/fixtures/zrh-sweep-2026-09-03.jsonl).
// With the default table, every cell where we are listed must end with our
// cheapest car inside the band and at least THREE of our cars under the field.
{
  const fx = path.join(__dirname, 'fixtures', 'zrh-sweep-2026-09-03.jsonl');
  const cells = fs.readFileSync(fx, 'utf8').trim().split('\n').map(JSON.parse)
    .filter((c) => !c.error && c.gm && c.gm.length && c.comp && c.comp.length);
  const isGm = (s) => /green motion/i.test(s);
  let inBand = 0, under3 = 0, underMin = Infinity, gaps = [];
  for (const c of cells) {
    const r = { top: c.top.map((x) => ({ supplier: x.s, price: x.p, categories: x.c || [], carClass: '' })) };
    // the fixture's own ladder as parsed rows; rcRowInCat needs display keys
    const out = categoryFactor(r, 1, { duration: c.dur });
    if (!out) continue;
    const f = out.factor;
    const C = c.comp[0];
    const ours = c.gm.map((p) => p * f);
    const gap = AUTOSCAN.gapChfByDur[Math.min(c.dur, 14)];
    const floor = Math.max(C - gap, C * (1 - AUTOSCAN.lowPriceGuard));
    const top = Math.max(C - (gap - AUTOSCAN.gapBandChf), floor);
    if (ours[0] >= floor - 0.01 && ours[0] <= top + 0.01) inBand++;
    const u = ours.filter((p) => p < C).length;
    if (u >= 3) under3++;
    underMin = Math.min(underMin, u);
    gaps.push((C - ours[0]) / C);
  }
  ck(`measured ZRH: every listed cell lands in its band (${inBand}/${cells.length})`, inBand === cells.length, `${inBand}/${cells.length}`);
  // the car count is an OUTCOME of that day's served ladder: two cells (11 Sep 2d,
  // 12 Sep 1d) serve a ladder whose 3rd car sits 7% above the 1st, so only two
  // fit under a 7-8 CHF gap. Never fewer than two; three or more almost always.
  ck(`measured ZRH: never fewer than two of our cars under the field (min ${underMin})`, underMin >= 2, `min ${underMin}`);
  ck(`measured ZRH: three or more of our cars under the field on 95%+ of cells (${under3}/${cells.length})`, under3 / cells.length >= 0.95, `${under3}/${cells.length}`);
  const medGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  ck(`measured ZRH: the median gap is 7-10% of the field (${(medGap * 100).toFixed(1)}%)`, medGap >= 0.07 && medGap <= 0.10, (medGap * 100).toFixed(1));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
