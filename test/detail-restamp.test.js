/**
 * The detail cache must not re-download pages it already read.
 *
 * updateRule re-reads a rule to verify the write, but the "Date Updated" stamp
 * only exists on the LIST page, so that read lands in the cache with stamp ''.
 * The next sync asks getDetail(id, listStamp), compares against '', misses, and
 * re-downloads it. Measured on the live cache 2026-08-29: 134 of 426 entries
 * (31%) were stamp-less — every one re-fetched on every single sync, and after
 * a bulk sweep it is effectively the whole station.
 *
 * restampWritten() closes that with ONE list request, and must only ever adopt
 * stamps for the ids it was handed.
 *
 *   node test/detail-restamp.test.js
 */
const { FmxClient } = require('../lib/fmx.js');

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };

const editPage = (pct) => ({
  html: `<html><body>
    <input name="rulename" value="01-----09------01-----3">
    <input name="datefrom" value="01/09/2026"><input name="dateto" value="01/09/2026">
    <input name="chkNumDays" checked><input name="NumDays" value="3">
    <select name="NumDaysOp"><option value="=" selected>=</option></select>
    <select name="priceType"><option value="percent" selected>percent</option></select>
    <input name="priceChange" value="${pct}">
    <input name="vehicleIds" value="1,2,3">
  </body></html>`,
});

function client() {
  const c = new FmxClient();
  c.fetches = 0;
  c.fetchPage = async () => { c.fetches++; return editPage(-40); };
  c.getRules = async () => [
    { ruleid: 101, updated: '29/08/2026 09:15', name: 'a' },
    { ruleid: 102, updated: '29/08/2026 09:15', name: 'b' },
    { ruleid: 999, updated: '29/08/2026 09:15', name: 'untouched-by-us' },
  ];
  return c;
}

(async () => {
  // --- the miss this fixes ---
  let c = client();
  await c.getDetail(101);                       // the post-write verification read
  ck('a stampless read is cached', c.detailCache.has(101), 'not cached');
  ck('...with an empty stamp', c.detailCache.get(101).stamp === '', JSON.stringify(c.detailCache.get(101).stamp));

  const before = c.fetches;
  await c.getDetail(101, '29/08/2026 09:15');   // what the next sync asks
  ck('without re-stamping the next sync RE-FETCHES', c.fetches === before + 1, `fetches ${c.fetches} vs ${before}`);

  // --- with re-stamping ---
  c = client();
  await c.getDetail(101);
  await c.getDetail(102);
  const n = await c.restampWritten(7, [101, 102]);
  ck('re-stamp reports what it adopted', n === 2, String(n));
  ck('entry 101 carries the list stamp', c.detailCache.get(101).stamp === '29/08/2026 09:15', JSON.stringify(c.detailCache.get(101).stamp));

  const after = c.fetches;
  await c.getDetail(101, '29/08/2026 09:15');
  await c.getDetail(102, '29/08/2026 09:15');
  ck('the next sync now reads BOTH from cache', c.fetches === after, `${c.fetches - after} extra fetches`);

  // --- and it must not vouch for rules we did not write ---
  c = client();
  await c.getDetail(999);                       // read for some other reason
  await c.restampWritten(7, [101, 102]);        // 999 deliberately not passed
  ck('a rule we did not write keeps its unknown stamp', c.detailCache.get(999).stamp === '', JSON.stringify(c.detailCache.get(999).stamp));
  const solo = c.fetches;
  await c.getDetail(999, '29/08/2026 09:15');
  ck('...so it is still re-read, exactly as before', c.fetches === solo + 1, 'was served from cache — stale data risk');

  // --- a rule with no cache entry must not be invented ---
  c = client();
  const none = await c.restampWritten(7, [101]);
  ck('re-stamping an uncached id is a no-op', none === 0 && !c.detailCache.has(101), `${none}`);
  ck('re-stamping nothing costs no list request', (await c.restampWritten(7, [])) === 0, 'made a request');

  console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
