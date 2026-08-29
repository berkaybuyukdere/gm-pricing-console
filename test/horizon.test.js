/**
 * The weekly-rules horizon typed by hand: a plain day count or a span in the
 * operator's own words ("2 hafta", "3 weeks", "1 ay"), on top of the preset
 * 30/60/90/120/180 chips.
 *
 *   node test/horizon.test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const fn = src.match(/function parseHorizon\(raw\) \{[\s\S]*?\n\}/);
if (!fn) { console.error('FAIL  could not lift parseHorizon out of public/app.js'); process.exit(1); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-horizon-'));
const tmp = path.join(dir, 'h.js');
fs.writeFileSync(tmp, `const BULK_MAX_DAYS = 400;\n${fn[0]}\nmodule.exports = parseHorizon;`);
const parseHorizon = require(tmp);

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };
const eq = (input, want) =>
  ck(`"${input}" -> ${want === null ? 'rejected' : want + ' days'}`, parseHorizon(input) === want, parseHorizon(input));

// plain numbers
eq('45', 45);
eq(' 7 ', 7);
eq('1', 1);
eq('400', 400);

// Turkish
eq('2 hafta', 14);
eq('2hafta', 14);
eq('1 ay', 30);
eq('10 gun', 10);
eq('3 GÜN', 3);
eq('6 HAFTA', 42);

// English
eq('2 weeks', 14);
eq('1 week', 7);
eq('3 months', 90);
eq('2w', 14);
eq('10 days', 10);

// German
eq('2 wochen', 14);
eq('1 monat', 30);
eq('5 tage', 5);

// rejected
eq('', null);
eq('0', null);
eq('-5', null);
eq('401', null);           // over the server's own BULK_MAX_DAYS
eq('60 hafta', null);      // 420 days, over the limit
eq('abc', null);
eq('2 elma', null);        // an unknown unit is a typo, not a horizon
eq('2 weeks please', null);

// the limit is the server's, so the two can never disagree
ck('the client limit matches the server BULK_MAX_DAYS', /const BULK_MAX_DAYS = 400;/.test(
  fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
), 'server BULK_MAX_DAYS is not 400 any more — update public/app.js too');

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
