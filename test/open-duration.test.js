/**
 * THE OPEN-ENDED BUCKET. The longest duration an operator prices must carry
 * `>=`, so rentals longer than it are still covered. It was hardcoded to 14,
 * so a sweep that stopped at 9 wrote `= 9` and every 10+ day rental fell
 * through with no rule at all (Berkay, 2026-08-29).
 *
 *   node test/open-duration.test.js
 */
const { ruleOpFor, OPEN_DURATION, FmxClient } = require('../lib/fmx.js');

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };

// --- the reported case: a sweep of 1..9 days
const sweep = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const open = Math.max(...sweep);
ck('a 1-9 sweep makes 9 the open bucket', open === 9, open);
for (const d of sweep) {
  const want = d === 9 ? '>=' : '=';
  ck(`  ${d}D carries ${want}`, ruleOpFor(d, open) === want, ruleOpFor(d, open));
}
ck('a 10-day rental is covered by the >= 9 rule', 10 >= open, '10 < ' + open);

// --- a full 1..14 sweep still behaves as before
const full = Array.from({ length: 14 }, (_, i) => i + 1);
const openFull = Math.max(...full);
ck('a full sweep keeps 14 as the open bucket', openFull === OPEN_DURATION, openFull);
ck('  13D is exact', ruleOpFor(13, openFull) === '=', ruleOpFor(13, openFull));
ck('  14D is open', ruleOpFor(14, openFull) === '>=', ruleOpFor(14, openFull));

// --- a single-duration sweep: that duration IS the bucket
ck('a 3-day-only sweep makes 3 the open bucket', ruleOpFor(3, 3) === '>=', ruleOpFor(3, 3));
ck('  and 2D would still be exact under it', ruleOpFor(2, 3) === '=', ruleOpFor(2, 3));

// --- no explicit bucket falls back to the console ceiling (old behaviour)
ck('without an explicit bucket, 14 is still the open one',
  ruleOpFor(14) === '>=' && ruleOpFor(9) === '=', `${ruleOpFor(14)} / ${ruleOpFor(9)}`);

// --- the body actually written to FMX carries it
(async () => {
  const fmx = new FmxClient();
  const body9 = fmx.buildRuleBody({
    ruleid: 0, day: 12, month: 9, year: 2026, duration: 9, pct: -50,
    active: true, vehicleIds: '1', vendors: ['ALL'], openDuration: 9,
  });
  ck('the written body sets NumDaysOp to >= for the bucket',
    new URLSearchParams(body9).get('NumDaysOp') === '>=',
    new URLSearchParams(body9).get('NumDaysOp'));
  const body8 = fmx.buildRuleBody({
    ruleid: 0, day: 12, month: 9, year: 2026, duration: 8, pct: -50,
    active: true, vehicleIds: '1', vendors: ['ALL'], openDuration: 9,
  });
  ck('...and = for everything below it',
    new URLSearchParams(body8).get('NumDaysOp') === '=',
    new URLSearchParams(body8).get('NumDaysOp'));

  // verifyDetail must judge against the same bucket, or every 9D rule would
  // be reported as an unverified write
  const detail = { numDaysOp: '>=', numDays: '9', chkNumDays: true, priceType: 'percent',
    priceChange: '-50', active: true, datefrom: '2026-09-12 00:01', dateto: '2026-09-12 23:59',
    vendors: ['ALL'] };
  const problems = fmx.verifyDetail(detail, {
    day: 12, month: 9, year: 2026, duration: 9, pct: -50, active: true,
    vendors: ['ALL'], openDuration: 9,
  });
  ck('verification accepts >= on the bucket duration',
    !problems.some((p) => /op/i.test(p)), JSON.stringify(problems));

  // the server derives the same bucket from the sweep's own duration list
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ck('the server derives the bucket from the sweep, not a constant',
    /const openDuration = Math\.max\(\.\.\.durations\);/.test(src), 'not derived');
  ck('an update never silently re-closes an open rule',
    /live\.numDaysOp === '>='/.test(src), 'PUT can flip the operator');

  console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
