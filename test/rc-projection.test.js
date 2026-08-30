/**
 * A PROJECTION IS NEVER PRICED FROM A TARGET THE MARKET CONTRADICTS —
 * AND EVERY PATH THAT TURNS A TARGET PRICE INTO A PCT SHARES ONE GUARDED BASE.
 *
 * The live projection re-prices Green Motion from a BASE. Normally that is
 * served/(1+cellPct). Right after an apply that is wrong — rentalcars still
 * serves the PREVIOUS rule — so a pending apply supplies the base instead,
 * but only while it keeps EXPLAINING the market (syncClassify).
 *
 * Failures pinned here (all found/measured 2026-08-29):
 *  - a stuck 122.06 target held base 141.93 while the site served GM at 74,
 *    projecting #107/117.80 when the site had #4/65 (contradict -> expire);
 *  - a chained apply passed the pending pct as "previously served", expiring a
 *    healthy sync on first contact and showing old prices as applied
 *    (alsoPcts + servedUnderPct);
 *  - a -45 -> -46 nudge was confirmed "live" against the untouched old quote
 *    (2.5% tolerance ambiguity -> never live from an ambiguous draw);
 *  - a landed 121.08-list clean draw failed a 106.55 customer target by
 *    exactly /0.88 (campaign-free draws also tested x0.88);
 *  - the concurrent price generations (2.4-2.7% apart) straddled the
 *    tolerance and expired live targets (genlive: no strike, no confirm).
 *
 *   node test/rc-projection.test.js
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const grabFn = (name) => {
  const m = src.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  if (!m) { console.log('FAIL  could not lift ' + name + ' out of app.js'); process.exit(1); }
  return m[0];
};
const rateLine = src.match(/^const RC_CAMPAIGN_RATE = .*$/m);
if (!rateLine) { console.log('FAIL  could not lift RC_CAMPAIGN_RATE'); process.exit(1); }

// the functions under test, with their globals injected
const make = (cellPct, sync) => {
  const state = { cellMap: new Map([['k', { pct: cellPct }]]) };
  const rcCtx = { day: 1, dur: 1, data: null };
  const rcSync = new Map(sync ? [['k', sync]] : []);
  const inner = new Function(
    'state', 'rcCtx', 'rcSync', 'key', 'syncKeyOf',
    `${rateLine[0]}\n${grabFn('syncClassify')}\n${grabFn('gmServedBase')}\nreturn gmServedBase;`
  )(state, rcCtx, rcSync, () => 'k', () => 'k');
  // gmServedBase classifies against the FULL ladder (rcCtx.data)
  return { gmServedBase: (r) => { rcCtx.data = r; return inner(r); }, sync };
};

// a ladder shaped like the real thing (campaign draw unless told otherwise)
const market = (gmPrice, before, extra) => ({
  gmPrice,
  top: [
    { supplier: 'Unirent', price: 61.16, before: null },
    { supplier: 'Green Motion', price: gmPrice, before: before ?? null },
    { supplier: 'Europcar', price: 63.55, before: extra ?? null },
  ],
});

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };
const near = (a, b) => Math.abs(a - b) < 0.01;
// sync record builder with the new anchors
const mkSync = (o) => ({
  target: o.target, appliedPct: o.applied, prevPct: o.prev,
  allServed: o.allServed, allBefore: o.allBefore ?? null,
  ratio: (1 + o.applied / 100) / (1 + o.prev / 100),
  alsoPcts: o.alsoPcts || [], live: !!o.live, expired: !!o.expired,
});

// --- THE ORIGINAL BUG: a target the market contradicts must be dropped
{
  const stuck = mkSync({ target: 122.06, applied: -14, prev: -10, allServed: 126.5 });
  const { gmServedBase } = make(-14, stuck);
  const got = gmServedBase(market(74));
  ck('a target the market contradicts does not price the projection',
    near(got.base, 74 / 0.86), `base ${got.base.toFixed(2)}, wanted ${(74 / 0.86).toFixed(2)}`);
  ck('  …and it is retired so it cannot come back', stuck.expired === true, 'still live');
  ck('  …so -17% projects ~71, not the 117.80 that ranked GM #107',
    Math.abs(got.base * 0.83 - 71.5) < 1.5, `${(got.base * 0.83).toFixed(2)}`);
}

// --- the case the proxy EXISTS for: applied, rentalcars still on the old rule
{
  const pending = mkSync({ target: 80, applied: -20, prev: -14, allServed: 86 });
  const { gmServedBase } = make(-20, pending);
  const got = gmServedBase(market(86));
  ck('a pending apply still explaining the market keeps the true base',
    near(got.base, 100) && got.rulePct === -20 && got.servedPct === -14,
    `base ${got.base.toFixed(2)} pct ${got.rulePct} served ${got.servedPct}`);
  ck('  …and is NOT retired', pending.expired === false, 'wrongly retired');
}

// --- the target already landed: the market is the truth again
{
  const landed = mkSync({ target: 80, applied: -20, prev: -14, allServed: 86 });
  const { gmServedBase } = make(-20, landed);
  const got = gmServedBase(market(80));
  ck('a landed target hands the base back to the market',
    near(got.base, 100) && got.rulePct === -20, `base ${got.base.toFixed(2)} pct ${got.rulePct}`);
}

// --- CHAINED APPLY: the replaced-but-written intermediate rule stays explainable
{
  const chained = mkSync({ target: 60, applied: -40, prev: -20, allServed: 80, alsoPcts: [-30] });
  const { gmServedBase } = make(-40, chained);
  const got = gmServedBase(market(80));
  ck('chained apply: the still-served ORIGINAL rule keeps base 100 (was 133.33)',
    near(got.base, 100) && got.rulePct === -40, `base ${got.base.toFixed(2)}`);
  ck('  …and the sync survives first contact', chained.expired === false, 'expired');
}
{
  const chained = mkSync({ target: 60, applied: -40, prev: -20, allServed: 80, alsoPcts: [-30] });
  const { gmServedBase } = make(-40, chained);
  const got = gmServedBase(market(70));
  ck('chained apply: an INTERMEDIATE rule landing divides by ITS pct, not prevPct',
    near(got.base, 100) && got.servedPct === -30, `base ${got.base.toFixed(2)} served ${got.servedPct}`);
}

// --- CLEAN DRAW: a customer-basis target must accept the /0.88 list serve
// (change ratio 0.7778, deliberately away from the 0.88 campaign rate — a
// change whose ratio ≈ 0.88 is GENUINELY ambiguous against a clean draw)
{
  const pending = mkSync({ target: 68.44, applied: -30, prev: -10, allServed: 88, allBefore: 100 });
  const { gmServedBase } = make(-30, pending);
  const clean = { gmPrice: 77.78, top: [
    { supplier: 'Unirent', price: 95, before: null },
    { supplier: 'Green Motion', price: 77.78, before: null },
  ] };
  const got = gmServedBase(clean);
  ck('a landed clean (list-basis) draw is recognised as live via x0.88',
    near(got.base, 111.11) && got.rulePct === -30, `base ${got.base.toFixed(2)} pct ${got.rulePct}`);
  ck('  …without retiring the sync as contradicted', pending.expired === false, 'expired');
}

// --- AMBIGUOUS: a change smaller than quote noise must never confirm "live"
{
  const nudge = mkSync({ target: 108, applied: -46, prev: -45, allServed: 110 });
  const { gmServedBase } = make(-46, nudge);
  const got = gmServedBase(market(110));
  ck('a sub-noise nudge keeps pricing from the provably-served rule',
    near(got.base, 200) && got.rulePct === -46 && got.servedPct === -45,
    `base ${got.base.toFixed(2)} served ${got.servedPct}`);
  ck('  …neither live nor retired', nudge.expired === false && nudge.live === false, 'flipped state');
}

// --- GENERATION: a serve 2.75% off the target is inconclusive, not a contradiction
{
  const pending = mkSync({ target: 60, applied: -40, prev: -20, allServed: 80 });
  const { gmServedBase } = make(-40, pending);
  const got = gmServedBase(market(61.65));
  ck('a generation-shifted target reads as live-ish (market base, no expiry)',
    near(got.base, 61.65 / 0.60) && pending.expired === false,
    `base ${got.base.toFixed(2)} expired ${pending.expired}`);
}

// --- GM absent from the ladder contradicts nothing: the proxy stands
{
  const pending = mkSync({ target: 80, applied: -20, prev: -14, allServed: 86 });
  const { gmServedBase } = make(-20, pending);
  const got = gmServedBase({ gmPrice: null, top: [{ supplier: 'Unirent', price: 61, before: null }] });
  ck('GM missing from the ladder leaves the proxy standing', near(got.base, 100), `base ${got.base}`);
}

// --- an already-expired sync never prices anything again
{
  const dead = mkSync({ target: 122.06, applied: -14, prev: -10, allServed: 126.5, expired: true });
  const { gmServedBase } = make(-14, dead);
  const got = gmServedBase(market(74));
  ck('an expired sync is ignored outright', near(got.base, 74 / 0.86), `base ${got.base.toFixed(2)}`);
}

// --- a live sync reads the market, not the target
{
  const live = mkSync({ target: 80, applied: -20, prev: -14, allServed: 86, live: true });
  const { gmServedBase } = make(-20, live);
  const got = gmServedBase(market(80));
  ck('a live sync reads the market, not the target',
    near(got.base, 100) && got.rulePct === -20, `base ${got.base.toFixed(2)} pct ${got.rulePct}`);
}

// --- no sync at all: plain market math
{
  const { gmServedBase } = make(-47, null);
  const got = gmServedBase(market(133.71));
  ck('with no pending apply the base is market / rule',
    near(got.base, 133.71 / 0.53), `base ${got.base.toFixed(2)}`);
}

console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
