/**
 * THE PRICING BAND (Berkay, 2026-09-02/03 — supersedes the 97/95-per-100 band).
 *
 * Be #1, but NEVER more than a fixed number of francs under the cheapest
 * competitor. The franc figure is a LIMIT, not a target:
 *
 *   limit = gapChfByDur[rentalDays]   // measured 2026-09-03; 3 days -> 10 CHF
 *   floor = max(cheapest - limit, cheapest * (1 - lowPriceGuard))
 *   band  = [floor, cheapest)
 *
 *   in the band       -> nothing (factor 1)
 *   not #1            -> down to JUST under the field (smallest move)
 *   past the limit    -> UP to just inside it
 *
 * "kac araba girdigi umrumda degil, onemli olan limiti asan ucuzlukta
 * olmamak." The number of our cars under the field is asserted nowhere here.
 * All math runs on DISPLAYED prices, so an active campaign discount is inside.
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
const limit = (d) => AUTOSCAN.gapChfByDur[d];
const justUnder = (C) => Math.max(C * AUTOSCAN.justUnderPct, AUTOSCAN.justUnderMinChf);
const place = (rows, opts) => {
  const r = categoryFactor(mk(rows), 1, opts);
  const cheap = Math.min(...rows.filter((x) => /green motion/i.test(x.supplier)).map((x) => x.price));
  return r && { ...r, after: cheap * r.factor };
};
const near = (a, b) => Math.abs(a - b) < 0.01;

// --- Berkay's 09 Oct 4D case, the one that exposed the target mistake: we sit
// 5.16 CHF under a 134.70 field with a 13 CHF limit -> that is INSIDE. Leave it.
let r = place([gm(129.54), gm(132.13), other('Dollar', 134.70), other('Dollar', 134.70)], { duration: 4 });
ck(`5.16 under with a ${limit(4)} CHF limit is left alone (factor ${r.factor})`, r.factor === 1, String(r.factor));

// --- not #1: come down to JUST under the field, never to the bottom of the band
r = place([gm(120), other('Alamo', 100), other('Hertz', 110), other('Sixt', 115)], { duration: 3 });
ck(`120 against their 100 comes down to just under (got ${r.after.toFixed(2)}, want ${(100 - justUnder(100)).toFixed(2)})`,
  near(r.after, 100 - justUnder(100)), r.after.toFixed(2));
ck('...and nowhere near the limit', 100 - r.after < limit(3) / 2, r.after.toFixed(2));

// --- a tie with the cheapest competitor is not #1 either
r = place([gm(100), other('Alamo', 100), other('Hertz', 110)], { duration: 3 });
ck(`a tie at 100 is broken downward (got ${r.after.toFixed(2)})`, r.after < 100, r.after.toFixed(2));

// --- past the limit: pulled back UP to just inside it — the one case that raises
r = place([gm(85), other('Alamo', 100), other('Hertz', 110)], { duration: 3 });
ck(`85 against their 100 (limit ${limit(3)}) comes UP to ${100 - limit(3) + AUTOSCAN.gapBandChf} (got ${r.after.toFixed(2)})`,
  near(r.after, 100 - limit(3) + AUTOSCAN.gapBandChf) && r.clamped === true, r.after.toFixed(2));

// --- the limit GROWS with the rental length; a breach at each length is
// corrected to that length's own floor, so a 1-day cell and a 14-day cell that
// both sit 50 under land in different places
const d1 = place([gm(50), other('A', 100), other('B', 115)], { duration: 1 });
const d14 = place([gm(350), other('A', 400), other('B', 460)], { duration: 14 });
ck(`1 day: 50 under is pulled up to ${100 - limit(1) + 1} (got ${d1.after.toFixed(2)})`, near(d1.after, 100 - limit(1) + 1), d1.after.toFixed(2));
ck(`14 days: 50 under is pulled up to ${400 - limit(14) + 1} (got ${d14.after.toFixed(2)})`, near(d14.after, 400 - limit(14) + 1), d14.after.toFixed(2));
// ...and 30 under on a 14-day field is INSIDE its 40 CHF limit: untouched
r = place([gm(370), other('A', 400), other('B', 460)], { duration: 14 });
ck('14 days: 30 under is inside the 40 CHF limit and left alone', r.factor === 1, String(r.factor));

// --- a flat franc limit on a cheap field IS a giveaway; the percentage backstops it
r = place([gm(25), other('A', 40), other('B', 48)], { duration: 14 });
const guardFloor = 40 * (1 - AUTOSCAN.lowPriceGuard);
ck(`a 40 CHF field never allows ${limit(14)} under — the ${Math.round(AUTOSCAN.lowPriceGuard * 100)}% guard holds at ${guardFloor} (got ${r.after.toFixed(2)})`,
  near(r.after, guardFloor + AUTOSCAN.gapBandChf), r.after.toFixed(2));

// --- the 20 CHF gaps: a guard that only watched ITS OWN category let the
// overall-cheapest car sink. Both anchors are market-wide now.
r = place([
  gm(60, ['economy']), gm(300, ['suvs']),
  other('Alamo', 100, ['economy']), other('Hertz', 400, ['suvs']),
], { duration: 3 });
ck(`our cheapest car never sits past the market limit (got ${r.after.toFixed(2)}, floor 90)`, r.after >= 90 - 0.01, r.after.toFixed(2));

// --- scoping: when a lane governs categories, BOTH anchors come from them
r = place([
  gm(60, ['economy']), gm(500, ['suvs']),
  other('Alamo', 100, ['economy']), other('Hertz', 400, ['suvs']),
], { duration: 3, categories: ['SUV'] });
ck(`an SUV lane anchors on the SUV field, not the economy one (got ${(500 * r.factor).toFixed(2)})`,
  near(500 * r.factor, 400 - justUnder(400)), (500 * r.factor).toFixed(2));

// --- no competitor, or no car of ours, in scope -> no opinion
ck('no competitor in scope yields no factor', categoryFactor(mk([gm(100)]), 1, { duration: 3 }) === null, 'expected null');
ck('no car of ours in scope yields no factor', categoryFactor(mk([other('Alamo', 100)]), 1, { duration: 3 }) === null, 'expected null');

// --- the doctrine against the MEASURED market: 98 ZRH cells, 4-17 Sep 2026,
// 09:00 pickup, read on 2026-09-03 (test/fixtures/zrh-sweep-2026-09-03.jsonl).
// Every listed cell must end inside its band; a cell already inside must not be
// touched; a cell that was not #1 must move by the smallest amount.
{
  const fx = path.join(__dirname, 'fixtures', 'zrh-sweep-2026-09-03.jsonl');
  const cells = fs.readFileSync(fx, 'utf8').trim().split('\n').map(JSON.parse)
    .filter((c) => !c.error && c.gm && c.gm.length && c.comp && c.comp.length);
  let inBand = 0, untouched = 0, wasIn = 0, downs = 0, ups = 0, worstDown = 0;
  for (const c of cells) {
    const r = { top: c.top.map((x) => ({ supplier: x.s, price: x.p, categories: x.c || [], carClass: '' })) };
    const out = categoryFactor(r, 1, { duration: c.dur });
    if (!out) continue;
    const C = c.comp[0], g0 = c.gm[0], after = g0 * out.factor;
    const lim = AUTOSCAN.gapChfByDur[Math.min(c.dur, 14)];
    const floor = Math.max(C - lim, C * (1 - AUTOSCAN.lowPriceGuard));
    if (after >= floor - 0.01 && after < C) inBand++;
    const was = g0 >= floor && g0 < C;
    if (was) { wasIn++; if (out.factor === 1) untouched++; }
    else if (g0 >= C) { downs++; worstDown = Math.max(worstDown, C - after); }
    else ups++;
  }
  ck(`measured ZRH: every listed cell ends inside its band (${inBand}/${cells.length})`, inBand === cells.length, `${inBand}/${cells.length}`);
  ck(`measured ZRH: every cell already inside is left untouched (${untouched}/${wasIn})`, untouched === wasIn, `${untouched}/${wasIn}`);
  ck(`measured ZRH: the ${downs} cells that were not #1 move by the smallest step (deepest landing ${worstDown.toFixed(2)} CHF under)`,
    worstDown <= Math.max(0.5, 0.005 * 450) + 0.01, worstDown.toFixed(2));
  console.log(`      (${wasIn} in band, ${downs} not #1, ${ups} past the limit — of ${cells.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
