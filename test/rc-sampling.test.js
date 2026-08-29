/**
 * THE MODAL SHOWS WHAT THE CUSTOMER SEES — AND A REFRESH CANNOT RE-ROLL IT.
 *
 * rentalcars answers the same search two ways, drawn per request (measured
 * 2026-08-29, ZRH 10 Sep): ~200 offers carrying a -12% Green Motion campaign,
 * or ~231 offers with no campaign at all. The campaign answer's struck-through
 * price is exactly the clean answer's price — 131.03 either way on the 3-day.
 *
 * Which shape is TRUE for a customer was settled live the same day, eleven
 * page-loads side by side: every fresh session showed the campaign — Safari
 * incognito (3×), fresh in-app tabs (3×), and a LOGGED-IN booking.com account
 * (same backend, same -12%, same prices to the franc). The only campaign-free
 * views came from one stale-cookie session that also priced ×1.05 high.
 *
 * So the sampler prefers the CAMPAIGN answer and stops on it; only an
 * all-clean draw set (campaign genuinely off) keeps the fullest clean
 * catalogue. Berkay's rule stays: comparisons run on the BLACK number — "asil
 * onemli rakam bu olacak siyah olan, kirmizi olan indirimsiz fiyati degil."
 *
 *   node test/rc-sampling.test.js
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const block = src.match(/^const rcHasCampaign = [\s\S]*?^async function rcSampled\(fetchOne, want\) \{[\s\S]*?^\}/m);
if (!block) { console.log('FAIL  could not lift the sampler out of server.js'); process.exit(1); }
class FmxError extends Error { constructor(m, c) { super(m); this.code = c; } }
const { rcGmMark, rcSampled, rcHasCampaign } = new Function('FmxError',
  `${block[0]}; return { rcGmMark, rcSampled, rcHasCampaign };`)(FmxError);

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };

// an answer shaped like the real thing: GM plus the stable competitors
const answer = (gmList, { campaign = true, total = 200 } = {}) => ({
  total,
  top: [
    { supplier: 'Green Motion', vehicle: 'Renault Clio', price: campaign ? +(gmList * 0.88).toFixed(2) : gmList, before: campaign ? gmList : null },
    { supplier: 'Dollar', vehicle: 'Smart #1', price: 149.83, before: null },
    { supplier: 'Thrifty', vehicle: 'Smart #1', price: 151.45, before: null },
    { supplier: 'Hertz', vehicle: 'Kia EV3', price: 153.07, before: null },
  ],
});
const feed = (list) => { let i = 0; const f = async () => { f.calls++; const v = list[i++]; if (v instanceof Error) throw v; return v; }; f.calls = 0; return f; };

(async () => {
  // --- the black number is what a comparison is made on
  ck('a draw is marked by the BLACK price, not the struck red one',
    rcGmMark(answer(131.03, { campaign: true })) === 115.31 &&
    rcGmMark(answer(131.03, { campaign: false })) === 131.03,
    `${rcGmMark(answer(131.03, { campaign: true }))} / ${rcGmMark(answer(131.03, { campaign: false }))}`);

  // --- one sample is still one call: sweeps and scans must not get dearer
  let f = feed([answer(131.03), answer(153.03), answer(131.03)]);
  let r = await rcSampled(f, 1);
  ck('samples=1 costs exactly one call', f.calls === 1, `${f.calls} calls`);

  // --- THE CORE RULE: a clean draw must not hide a running campaign
  f = feed([answer(131.03, { campaign: false, total: 231 }), answer(131.03, { campaign: true, total: 200 })]);
  r = await rcSampled(f, 5);
  ck('the campaign answer beats the clean one', r.total === 200, `${r.total} offers`);
  ck('  …so the badge the customer sees is shown', r.top[0].before === 131.03, String(r.top[0].before));
  ck('  …and the price is the one the customer pays', rcGmMark(r) === 115.31, String(rcGmMark(r)));

  // --- a campaign-bearing answer ends the sampling immediately: the common case is cheap
  f = feed([answer(131.03, { campaign: true, total: 200 }), answer(131.03, { campaign: false, total: 231 })]);
  r = await rcSampled(f, 5);
  ck('a campaign answer stops the sampling at once', f.calls === 1, `${f.calls} calls`);
  ck('  …and is kept', rcGmMark(r) === 115.31, String(rcGmMark(r)));

  // --- campaign genuinely off: every draw clean → the fullest catalogue wins
  f = feed([
    answer(131.03, { campaign: false, total: 229 }),
    answer(130.62, { campaign: false, total: 232 }),
    answer(131.03, { campaign: false, total: 231 }),
  ]);
  r = await rcSampled(f, 3);
  ck('an all-clean market keeps the fullest catalogue', r.total === 232, `${r.total} offers`);
  ck('  …with no badge invented', !r.top.some((x) => x.before != null), 'a struck price appeared');
  ck('  …and it cost every sample', f.calls === 3, `${f.calls} calls`);

  // --- the wobble marker: disagreeing draws are reported, never hidden
  f = feed([answer(131.03, { campaign: false, total: 231 }), answer(131.03, { campaign: true, total: 200 })]);
  r = await rcSampled(f, 5);
  ck('a clean+campaign draw pair reports its spread', r.spread > 0, String(r.spread));
  ck('  …and counts both samples', r.sampled === 2, String(r.sampled));

  // --- a failed EXTRA sample must never fail a query that already answered
  f = feed([answer(131.03, { campaign: false, total: 231 }), new Error('RC_HTTP_500'), answer(131.03)]);
  r = await rcSampled(f, 3);
  ck('a failed extra sample still returns an answer', rcGmMark(r) === 131.03, String(rcGmMark(r)));
  ck('  …counted honestly as one sample', r.sampled === 1, String(r.sampled));

  // --- but a first-call failure must propagate, not be swallowed
  let threw = null;
  try { await rcSampled(feed([new Error('RC_UNAVAILABLE')]), 3); } catch (e) { threw = e.message; }
  ck('a first-call failure propagates', threw === 'RC_UNAVAILABLE', String(threw));

  // --- competitors are never touched by any of this
  f = feed([answer(131.03, { campaign: false, total: 231 }), answer(131.03, { campaign: true, total: 200 })]);
  r = await rcSampled(f, 5);
  const comp = r.top.filter((x) => !/green motion/i.test(x.supplier)).map((x) => x.price);
  ck('competitor prices pass through unchanged', JSON.stringify(comp) === JSON.stringify([149.83, 151.45, 153.07]), JSON.stringify(comp));

  console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
