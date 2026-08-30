/**
 * THE MODAL SHOWS WHAT THE CUSTOMER SEES — AND NAMES ITS UNCERTAINTY.
 *
 * Two independent lotteries sit behind every rentalcars search (both measured
 * live 2026-08-29, ZRH):
 *
 * 1. SHAPE: ~200 offers with a -12% Green Motion campaign, or ~231 offers with
 *    none. Every fresh session (incognito ×3, fresh tabs ×3, a logged-in
 *    booking.com account) showed the CAMPAIGN; only one stale-cookie session
 *    was clean. So a campaign draw beats clean draws, and clean wins only when
 *    every draw is clean (campaign genuinely off) — then fullest catalogue.
 *
 * 2. GENERATION: two price tiers ~2-3% apart served CONCURRENTLY, per request
 *    (13:00/15:00 answers three seconds apart carried GM list 186.36 and
 *    190.77; at 16:08 the console drew 197.34 while the operator's browser got
 *    192.00 — exactly ×1.0278). So one campaign draw is not an answer: the
 *    sampler takes ONE confirmation draw. Agreeing tiers settle it; split
 *    tiers prefer the PREVIOUS snapshot's tier (continuity), else the cheaper
 *    draw, and `spread` carries the honest ± for the footer.
 *
 *   node test/rc-sampling.test.js
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const block = src.match(/^const rcHasCampaign = [\s\S]*?^async function rcSampled\(fetchOne, want, prevList\) \{[\s\S]*?^\}/m);
if (!block) { console.log('FAIL  could not lift the sampler out of server.js'); process.exit(1); }
class FmxError extends Error { constructor(m, c) { super(m); this.code = c; } }
const { rcGmMark, rcGmList, rcSampled, rcHasCampaign } = new Function('FmxError',
  `${block[0]}; return { rcGmMark, rcGmList, rcSampled, rcHasCampaign };`)(FmxError);

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
  // --- the black number is what a comparison is made on; the LIST identifies the generation
  ck('a draw is marked by the BLACK price and tiered by the LIST price',
    rcGmMark(answer(131.03, { campaign: true })) === 115.31 &&
    rcGmList(answer(131.03, { campaign: true })) === 131.03 &&
    rcGmList(answer(131.03, { campaign: false })) === 131.03,
    `${rcGmMark(answer(131.03, { campaign: true }))} / ${rcGmList(answer(131.03, { campaign: true }))}`);

  // --- one sample is still one call: sweeps and scans must not get dearer
  let f = feed([answer(131.03), answer(153.03), answer(131.03)]);
  let r = await rcSampled(f, 1, null);
  ck('samples=1 costs exactly one call', f.calls === 1, `${f.calls} calls`);

  // --- a campaign draw takes exactly one confirmation draw
  f = feed([answer(131.03, { campaign: true }), answer(131.03, { campaign: true }), answer(131.03, { campaign: true })]);
  r = await rcSampled(f, 5, null);
  ck('agreeing campaign draws settle at two calls', f.calls === 2, `${f.calls} calls`);
  ck('  …keeping the first', rcGmMark(r) === 115.31 && r.spread === 0, `${rcGmMark(r)} ±${r.spread}`);

  // --- a clean draw must not hide a running campaign
  f = feed([answer(131.03, { campaign: false, total: 231 }), answer(131.03, { campaign: true }), answer(131.03, { campaign: true })]);
  r = await rcSampled(f, 5, null);
  ck('the campaign answer beats the clean one', r.total === 200 && r.top[0].before === 131.03, `${r.total} offers`);
  ck('  …and the clean draw is visible in the spread', r.spread > 0, String(r.spread));

  // --- THE 16:08 CASE: both generations live at once, previous tier wins
  f = feed([answer(197.34, { campaign: true }), answer(192.00, { campaign: true })]);
  r = await rcSampled(f, 5, 192.00);
  ck('split generations: the previous snapshot\'s tier wins (continuity)',
    rcGmList(r) === 192.00, String(rcGmList(r)));
  ck('  …with the split reported honestly', r.spread > 2 && r.spread < 4, `±${r.spread}%`);

  f = feed([answer(192.00, { campaign: true }), answer(197.34, { campaign: true })]);
  r = await rcSampled(f, 5, 197.34);
  ck('  …in either draw order', rcGmList(r) === 197.34, String(rcGmList(r)));

  // --- split generations with no previous snapshot: the cheaper draw wins
  f = feed([answer(197.34, { campaign: true }), answer(192.00, { campaign: true })]);
  r = await rcSampled(f, 5, null);
  ck('split generations without history keep the cheaper draw', rcGmList(r) === 192.00, String(rcGmList(r)));

  // --- a previous tier that matches NEITHER draw (a real rule change) falls back to cheaper
  f = feed([answer(197.34, { campaign: true }), answer(192.00, { campaign: true })]);
  r = await rcSampled(f, 5, 131.03);
  ck('a genuinely moved market ignores the stale previous tier', rcGmList(r) === 192.00, String(rcGmList(r)));

  // --- sub-franc wobble is NOT a generation split
  f = feed([answer(131.03, { campaign: true }), answer(130.62, { campaign: true })]);
  r = await rcSampled(f, 5, null);
  ck('sub-franc wobble does not trigger the tie-break', rcGmList(r) === 131.03, String(rcGmList(r)));

  // --- campaign genuinely off: two agreeing clean draws settle it (a
  // campaign-free month must not pay five draws per refresh — 15-22s measured)
  f = feed([
    answer(131.03, { campaign: false, total: 229 }),
    answer(130.62, { campaign: false, total: 232 }),
    answer(131.03, { campaign: false, total: 231 }),
  ]);
  r = await rcSampled(f, 5, null);
  ck('an all-clean market settles at two agreeing draws', f.calls === 2, `${f.calls} calls`);
  ck('  …keeping the fullest catalogue', r.total === 232, `${r.total} offers`);
  ck('  …with no badge invented', !r.top.some((x) => x.before != null), 'a struck price appeared');

  // --- clean draws from DIFFERENT generations do not settle: keep sampling
  f = feed([
    answer(131.03, { campaign: false, total: 229 }),
    answer(143.39, { campaign: false, total: 232 }),
    answer(143.39, { campaign: false, total: 231 }),
  ]);
  r = await rcSampled(f, 5, null);
  ck('clean draws across generations keep sampling until two agree', f.calls === 3, `${f.calls} calls`);

  // --- a failed EXTRA sample must never fail a query that already answered
  f = feed([answer(131.03, { campaign: true }), new Error('RC_HTTP_500')]);
  r = await rcSampled(f, 3, null);
  ck('a failed confirmation draw still returns an answer', rcGmMark(r) === 115.31, String(rcGmMark(r)));
  ck('  …counted honestly as one sample', r.sampled === 1, String(r.sampled));

  // --- but a first-call failure must propagate, not be swallowed
  let threw = null;
  try { await rcSampled(feed([new Error('RC_UNAVAILABLE')]), 3, null); } catch (e) { threw = e.message; }
  ck('a first-call failure propagates', threw === 'RC_UNAVAILABLE', String(threw));

  // --- competitors are never touched by any of this
  f = feed([answer(131.03, { campaign: true }), answer(131.03, { campaign: true })]);
  r = await rcSampled(f, 5, null);
  const comp = r.top.filter((x) => !/green motion/i.test(x.supplier)).map((x) => x.price);
  ck('competitor prices pass through unchanged', JSON.stringify(comp) === JSON.stringify([149.83, 151.45, 153.07]), JSON.stringify(comp));

  console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
