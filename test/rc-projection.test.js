/**
 * A PROJECTION MUST NEVER BE PRICED FROM A TARGET THE MARKET CONTRADICTS.
 *
 * The live projection re-prices Green Motion from a BASE. That base normally
 * comes from what rentalcars serves, divided by the cell's rule. Right after an
 * apply that is wrong — rentalcars still serves the PREVIOUS rule's price — so
 * a pending apply is allowed to supply the base instead.
 *
 * Measured failure, 2026-08-29 (01 Sep, 1 day, 16:00): a pending target of
 * 122.06 at -14% had never landed and was never retired, so it held a base of
 * 141.93 forever. rentalcars was serving Green Motion at 74 (list) / 65
 * (campaign) — #4 on the site — while the console projected 117.80 and ranked
 * GM #107. Berkay: "yuzdeligi yazinca rakip analizi yerindeki siralamada hata
 * var gibi."
 *
 * So the proxy has to keep earning its trust: the served price must be either
 * the target (it landed) or what the previous rule produced (not yet), on
 * either the campaign or the list basis. Anything else retires it.
 *
 *   node test/rc-projection.test.js
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const grab = (name) => {
  const m = src.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  if (!m) { console.log('FAIL  could not lift ' + name + ' out of app.js'); process.exit(1); }
  return m[0];
};

// the two functions under test, with their globals injected
const make = (cellPct, sync) => {
  const state = { cellMap: new Map([['k', { pct: cellPct }]]) };
  const rcCtx = { day: 1, dur: 1 };
  const rcSync = new Map(sync ? [['k', sync]] : []);
  const fn = new Function(
    'state', 'rcCtx', 'rcSync', 'key', 'syncKeyOf',
    `${grab('gmServedBase')}\n${grab('syncExplainsMarket')}\nreturn gmServedBase;`
  )(state, rcCtx, rcSync, () => 'k', () => 'k');
  return { gmServedBase: fn, sync };
};

// a ladder shaped like the real thing
const market = (gmPrice, before) => ({
  gmPrice,
  top: [
    { supplier: 'Unirent', price: 61.16, before: null },
    { supplier: 'Green Motion', price: gmPrice, before: before ?? null },
    { supplier: 'Europcar', price: 63.55, before: null },
  ],
});

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };
const near = (a, b) => Math.abs(a - b) < 0.01;

// --- THE REPORTED BUG: a target the market flatly contradicts must be dropped
{
  const stuck = { target: 122.06, appliedPct: -14, prevPct: null, live: false, expired: false };
  const { gmServedBase } = make(-14, stuck);
  const got = gmServedBase(market(74));
  ck('a target the market contradicts does not price the projection',
    near(got.base, 74 / 0.86), `base ${got.base.toFixed(2)}, wanted ${(74 / 0.86).toFixed(2)}`);
  ck('  …and it is retired so it cannot come back', stuck.expired === true, 'still live');
  // the whole point: at -17% the projection must land near the market, not at 117.80
  ck('  …so -17% projects ~71, not the 117.80 that ranked GM #107',
    Math.abs(got.base * 0.83 - 71.5) < 1.5, `${(got.base * 0.83).toFixed(2)}`);
}

// --- the case the proxy EXISTS for: applied, rentalcars still on the old rule
{
  // base 100: old rule -14% served 86, new rule -20% targets 80
  const pending = { target: 80, appliedPct: -20, prevPct: -14, live: false, expired: false };
  const { gmServedBase } = make(-20, pending);
  const got = gmServedBase(market(86));
  ck('a pending apply still explaining the market keeps the base',
    near(got.base, 100) && got.rulePct === -20, `base ${got.base.toFixed(2)} pct ${got.rulePct}`);
  ck('  …and is NOT retired', pending.expired === false, 'wrongly retired');
}

// --- a big rule change is still legitimate: -14% -> -47% must not trip the check
{
  const pending = { target: 53, appliedPct: -47, prevPct: -14, live: false, expired: false };
  const { gmServedBase } = make(-47, pending);
  const got = gmServedBase(market(86));
  ck('a large but consistent rule change keeps its base', near(got.base, 100), `base ${got.base.toFixed(2)}`);
}

// --- the target already landed: the market is the truth, no proxy needed
{
  const landed = { target: 80, appliedPct: -20, prevPct: -14, live: false, expired: false };
  const { gmServedBase } = make(-20, landed);
  const got = gmServedBase(market(80));
  ck('a landed target still explains the market', near(got.base, 100), `base ${got.base.toFixed(2)}`);
}

// --- campaign basis: rentalcars serves 70.40 (-12%) whose list price IS the old 80
{
  const pending = { target: 80, appliedPct: -20, prevPct: -14, live: false, expired: false };
  const { gmServedBase } = make(-20, pending);
  const got = gmServedBase(market(70.4, 80)); // black 70.40, struck 80
  ck('a campaign-discounted quote is matched on its list basis too',
    near(got.base, 100), `base ${got.base.toFixed(2)}`);
}

// --- GM absent from the ladder contradicts nothing: the proxy is exactly for this
{
  const pending = { target: 80, appliedPct: -20, prevPct: -14, live: false, expired: false };
  const { gmServedBase } = make(-20, pending);
  const got = gmServedBase({ gmPrice: null, top: [{ supplier: 'Unirent', price: 61, before: null }] });
  ck('GM missing from the ladder leaves the proxy standing', near(got.base, 100), `base ${got.base}`);
}

// --- an already-expired sync never prices anything again
{
  const dead = { target: 122.06, appliedPct: -14, prevPct: null, live: false, expired: true };
  const { gmServedBase } = make(-14, dead);
  const got = gmServedBase(market(74));
  ck('an expired sync is ignored outright', near(got.base, 74 / 0.86), `base ${got.base.toFixed(2)}`);
}

// --- a live sync hands over to the market
{
  const live = { target: 80, appliedPct: -20, prevPct: -14, live: true, expired: false };
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
