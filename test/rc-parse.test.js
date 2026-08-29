/**
 * Locks the rcParse price contract against a real captured rentalcars response
 * (test/fixtures/rc-search-zrh.json, ZRH 2026-09-20 17:30, 3 days).
 *
 * THE CONTRACT:
 *  - `price` is the EFFECTIVE price — the campaign quote when rentalcars is
 *    running one. Ranking and the band both work on it: Green Motion competes
 *    on the number shoppers actually see.
 *  - `before` is the pre-discount price, set only when genuinely higher, so the
 *    table can render "134 -> 118, -12%" the way rentalcars.com does.
 *  - the ladder is price-ascending and gmRank/gmPrice agree with it.
 *
 *    node test/rc-parse.test.js
 */
const { rcParse, rcIsGm } = require('../lib/rc.js');
const raw = require('./fixtures/rc-search-zrh.json');

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };

const r = rcParse(raw, { cfgName: 'Zurich Airport', pickUp: '2026-09-20T17:30:00', dropOff: '2026-09-23T17:30:00' });

ck('every raw match survives the parse', r.total === raw.matches.length, `${r.total} != ${raw.matches.length}`);
ck('ladder is price-ascending', r.top.every((x, i) => i === 0 || r.top[i - 1].price <= x.price), JSON.stringify(r.top.map((x) => x.price)));

const gmIdx = r.top.findIndex(rcIsGm);
ck('gmRank matches the ladder', r.gmRank === gmIdx + 1, `${r.gmRank} vs idx ${gmIdx}`);
ck('gmPrice matches the ladder', r.gmPrice === r.top[gmIdx].price, `${r.gmPrice} vs ${r.top[gmIdx].price}`);

// every parsed price must be the EFFECTIVE (campaign) price for its match
let mismatched = [];
for (const m of raw.matches) {
  const v = m.vehicle;
  const quoted = (v.driveAwayPrice && v.driveAwayPrice.amount) ?? (v.price && v.price.amount);
  if (!r.top.some((x) => x.vehicle === v.makeAndModel && Math.abs(x.price - Number(quoted)) < 0.01))
    mismatched.push(`${v.makeAndModel} expected ${quoted}`);
}
ck('every parsed price is the EFFECTIVE price', mismatched.length === 0, mismatched.join('; '));

// the pre-discount price is carried alongside so the table can show both
const discounted = r.top.filter((x) => x.before != null);
ck('campaign rows are still recognisable', discounted.length > 0, 'fixture lost its discounted rows');
ck('before is always strictly above price', discounted.every((x) => x.before > x.price), JSON.stringify(discounted.map((x) => [x.price, x.before])));

// GM carries the -12% targeted campaign in this capture
const gmRows = r.top.filter(rcIsGm);
ck('all GM rows carry the campaign price', gmRows.every((x) => x.before != null), `${gmRows.filter((x) => x.before == null).length} without`);
ck('GM campaign is ~12% off', gmRows.every((x) => Math.abs(x.price / x.before - 0.88) < 0.005), JSON.stringify(gmRows.map((x) => (x.price / x.before).toFixed(4))));

// HOW MUCH the campaign moves the picture — this is why an answer that arrives
// with the discount and one that arrives without it are not interchangeable, and
// why the day's snapshot is pinned (public/app.js RC_PIN_MIN) instead of being
// re-queried on every duration click. Measured live 2026-08-29: 12 of 14
// identical ZRH queries came back discounted and 2 clean, which is exactly how
// one refresh showed 9 GM cars in the top 10 and the next showed 4.
const EFF = (x) => x.price;
const LIST = (x) => (x.before != null ? x.before : x.price);
const top10Gm = (f) => r.top.map((x) => ({ gm: rcIsGm(x), p: f(x) })).sort((a, b) => a.p - b.p).slice(0, 10).filter((x) => x.gm).length;
ck(
  'the campaign materially changes the top-10 GM count',
  top10Gm(EFF) !== top10Gm(LIST),
  `effective=${top10Gm(EFF)} list=${top10Gm(LIST)} — fixture no longer demonstrates the drift`
);

// category aggregates must count offers consistently
for (const c of r.categories) {
  const rows = r.top.filter((x) => x.categories.includes(c.value));
  if (c.count !== rows.length) ck(`category ${c.value} count`, false, `${c.count} != ${rows.length}`);
}
ck('category aggregates consistent with the ladder', true, '');

console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
