/**
 * THE PICKUP RING. The competitor analysis starts at 09:00 and the ring is
 * stepped in HALF-HOUR slots (Berkay, 2026-08-30: "saat değişimleri her yarım
 * saatte bir olsun 1 saat değil" — the 2026-08-29 ring was hourly). It wraps
 * at both ends and never leaves 09:00-19:00.
 *
 * The slot is part of the rc cache key, so a slot that escaped the ring would
 * silently create snapshots nothing else can ever read back.
 *
 * app.js is a browser script, so the ring is lifted out of it and run bare.
 *
 *   node test/pickup-ring.test.js
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const block = src.match(
  /const RC_START_HOUR = 9;[\s\S]*?^function rcFallbackTimes\(fromHour\) \{[\s\S]*?^\}/m
);
if (!block) {
  console.log('FAIL  could not lift the ring out of public/app.js');
  process.exit(1);
}
const {
  RC_START_HOUR, RC_END_HOUR, RC_HOURS, rcPad, rcHH, rcMM, RC_CANON, rcHourAt, rcFallbackTimes,
} = new Function(
  `${block[0]}; return { RC_START_HOUR, RC_END_HOUR, RC_HOURS, rcPad, rcHH, rcMM, RC_CANON, rcHourAt, rcFallbackTimes };`
)();

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };

// --- the ring itself
ck('starts at 09:00', RC_START_HOUR === 9, String(RC_START_HOUR));
ck('ends at 19:00', RC_END_HOUR === 19, String(RC_END_HOUR));
ck('half an hour apart, 21 slots', RC_HOURS.length === 21 && RC_HOURS.every((h, i) => i === 0 || h === RC_HOURS[i - 1] + 0.5), JSON.stringify(RC_HOURS));
ck('hours are zero-padded for the API', rcPad(9) === '09' && rcPad(19) === '19', `${rcPad(9)} ${rcPad(19)}`);
ck('a half slot renders as :30', rcHH(9.5) === '09' && rcMM(9.5) === '30', `${rcHH(9.5)}:${rcMM(9.5)}`);
ck('a whole slot renders as :00', rcHH(14) === '14' && rcMM(14) === '00', `${rcHH(14)}:${rcMM(14)}`);
ck('the canonical query hour is 09:00', RC_CANON === 'hh=09&mm=00', RC_CANON);

// --- stepping, including both wraps
ck('+ from 09:00 is 09:30', rcHourAt(9, 1) === 9.5, String(rcHourAt(9, 1)));
ck('+ from 09:30 is 10:00', rcHourAt(9.5, 1) === 10, String(rcHourAt(9.5, 1)));
ck('+ from 18:30 is 19:00', rcHourAt(18.5, 1) === 19, String(rcHourAt(18.5, 1)));
ck('+ from 19:00 WRAPS to 09:00', rcHourAt(19, 1) === 9, String(rcHourAt(19, 1)));
ck('- from 09:00 WRAPS to 19:00', rcHourAt(9, -1) === 19, String(rcHourAt(9, -1)));
ck('- from 09:30 is 09:00', rcHourAt(9.5, -1) === 9, String(rcHourAt(9.5, -1)));

// a full lap returns to the start and visits every slot exactly once
let h = RC_START_HOUR;
const lap = [h];
for (let i = 0; i < RC_HOURS.length - 1; i++) { h = rcHourAt(h, 1); lap.push(h); }
ck('a full lap visits every slot once', new Set(lap).size === RC_HOURS.length, JSON.stringify(lap));
ck('...and one more step is back at 09:00', rcHourAt(h, 1) === RC_START_HOUR, String(rcHourAt(h, 1)));

// stepping can never leave the ring, from anywhere, in either direction
let escaped = null;
for (const start of RC_HOURS) {
  for (const dir of [-1, 1]) {
    let cur = start;
    for (let i = 0; i < 60 && !escaped; i++) {
      cur = rcHourAt(cur, dir);
      if (!RC_HOURS.includes(cur)) escaped = `${start} ${dir > 0 ? '+' : '-'} -> ${cur}`;
    }
  }
}
ck('no sequence of steps escapes 09:00-19:00', !escaped, escaped);

// --- the empty-slot fallback walks the ring, bounded
for (const from of [9, 17.5, 18.5, 19]) {
  const fb = rcFallbackTimes(from);
  ck(`fallback from ${rcHH(from)}:${rcMM(from)} is bounded to 3`, fb.length === 3, String(fb.length));
  ck(`  …stays on the ring`, fb.every(([hh, mm]) => RC_HOURS.includes(Number(hh) + (mm === '30' ? 0.5 : 0))), JSON.stringify(fb));
  ck(`  …never re-offers the slot that was empty`, fb.every(([hh, mm]) => Number(hh) + (mm === '30' ? 0.5 : 0) !== from), JSON.stringify(fb));
  ck(`  …every slot lands on :00 or :30`, fb.every(([, mm]) => mm === '00' || mm === '30'), JSON.stringify(fb));
}
ck('fallback from 19:00 wraps to the morning', rcFallbackTimes(19)[0][0] === '09' && rcFallbackTimes(19)[0][1] === '00', JSON.stringify(rcFallbackTimes(19)));
ck('fallback from 09:00 offers the half slot first', rcFallbackTimes(9)[0][0] === '09' && rcFallbackTimes(9)[0][1] === '30', JSON.stringify(rcFallbackTimes(9)));

console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
