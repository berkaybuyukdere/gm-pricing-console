/**
 * PRICE LANES. Pricing is per vehicle-group set: an ECONOMY weekly rule and a
 * COMPACT weekly rule live on the same day+duration and must both work.
 *
 * Before this, any two rules on one cell were a CONFLICT, so the moment a
 * second category was opened the console refused to price either — which is
 * what Berkay ran into on 2026-08-27.
 *
 * Pure-function checks on laneKey / groupsOverlap / shapeCells, lifted out of
 * server.js — no FMX, no network.
 *
 *   node test/lanes.test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const pick = (re, what) => {
  const m = src.match(re);
  if (!m) { console.error('FAIL  could not lift ' + what + ' out of server.js'); process.exit(1); }
  return m[0];
};
const laneKey = pick(/const laneKey = \(ids, allIds\) => \{[\s\S]*?\n\};/, 'laneKey');
const overlap = pick(/const groupsOverlap = \(a, b\) => \{[\s\S]*?\n\};/, 'groupsOverlap');
const groupIdList = pick(/const groupIdList = \(s\) =>[\s\S]*?\n\s*\.filter\(\(v\) => \/\^\\d\+\$\/\.test\(v\) && v !== '999999'\);/, 'groupIdList');
const ruleLabel = pick(/const ruleLabel = \(name\) => \{[\s\S]*?\n\};/, 'ruleLabel');
const parseRuleDate = pick(/const parseRuleDate = \(s\) => \{[\s\S]*?\n\};/, 'parseRuleDate');
const shapeCells = pick(/function shapeCells\(rules, getDetail, year, month, dupes, wantLane, allIds\) \{[\s\S]*?\n\}/, 'shapeCells');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-lanes-'));
const tmp = path.join(dir, 'l.js');
fs.writeFileSync(tmp, `
const DURATIONS = [1,2,3,4,5,6,7,8,9,10,11,12,13,14];
const OPEN_DURATION = 14;
${laneKey}
${overlap}
${groupIdList}
${ruleLabel}
${parseRuleDate}
${shapeCells}
module.exports = { laneKey, groupsOverlap, shapeCells, ruleLabel };
`);
const { laneKey: LK, groupsOverlap: OV, shapeCells: SC, ruleLabel: RL } = require(tmp);

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };

const ALL = Array.from({ length: 39 }, (_, i) => String(i + 1));

// --- lane keys: "every group" arrives in three shapes and must fold to one
ck('an absent coverage is the ALL lane', LK(null, ALL) === 'ALL', LK(null, ALL));
ck('an empty coverage is the ALL lane', LK([], ALL) === 'ALL', LK([], ALL));
ck('the full 39-id list is ALSO the ALL lane (this is what the console writes)',
  LK(ALL, ALL) === 'ALL', LK(ALL, ALL));
ck('a subset is its own lane', LK(['7', '3'], ALL) === '3,7', LK(['7', '3'], ALL));
ck('lane keys ignore order and duplicates',
  LK(['7', '3', '7'], ALL) === LK(['3', '7'], ALL), LK(['7', '3', '7'], ALL));

// --- overlap is what FMX genuinely cannot resolve
ck('disjoint group sets do NOT overlap', OV(['1', '2'], ['3', '4']) === false, '');
ck('sets sharing a group DO overlap', OV(['1', '2'], ['2', '9']) === true, '');
ck('an all-groups rule overlaps everything', OV([], ['5']) === true, '');

// --- shapeCells over a realistic month: economy + compact on the SAME cell
const mkRule = (ruleid, day, dur, pct, ids, label) => ({
  ruleid, from: `2026-09-${String(day).padStart(2, '0')} 00:01`,
  to: `2026-09-${String(day).padStart(2, '0')} 23:59`, updated: 'u' + ruleid,
  detail: {
    rulename: `${String(day).padStart(2, '0')}-----09------01-----${dur}` + (label ? `-----${label}` : ''),
    numDays: dur, chkNumDays: true, priceType: 'percent', priceChange: pct,
    active: true, vendors: ['ALL'], vehicleIds: ids.join(', '),
    chkWeekdays: false, chkWeekdays2: false, chkPickupTime: false, chkDropoffTime: false,
  },
});
const rules = [
  mkRule(1, 12, 3, -20, ['1', '2', '3'], 'EKONOMI'),
  mkRule(2, 12, 3, -35, ['4', '5'], 'KOMPAKT'),
  mkRule(3, 13, 3, -10, ['1', '2', '3'], 'EKONOMI'),
];
const get = (id) => (rules.find((r) => r.ruleid === id) || {}).detail;
const asRules = rules.map(({ ruleid, from, to, updated }) => ({ ruleid, from, to, updated }));

let dupes = new Set();
const all = SC(asRules, get, 2026, 9, dupes, null, ALL);
ck('two categories on one cell are NOT a conflict', dupes.size === 0, [...dupes].join());

dupes = new Set();
const eco = SC(asRules, get, 2026, 9, dupes, '1,2,3', ALL);
ck('the ECONOMY lane sees only its own rules', eco.size === 2, `size=${eco.size}`);
ck('the ECONOMY cell carries the economy price', eco.get('12:3').pct === -20, eco.get('12:3').pct);
ck('the ECONOMY cell keeps its label', eco.get('12:3').label === 'EKONOMI', eco.get('12:3').label);

dupes = new Set();
const comp = SC(asRules, get, 2026, 9, dupes, '4,5', ALL);
ck('the COMPACT lane sees only its own rule', comp.size === 1, `size=${comp.size}`);
ck('the COMPACT cell carries the compact price', comp.get('12:3').pct === -35, comp.get('12:3').pct);
ck('reading one lane never invents a conflict', dupes.size === 0, [...dupes].join());

// --- a genuine clash: two rules fighting over the SAME cars
const clash = [...rules, mkRule(4, 12, 3, -50, ['2', '9'], 'CAKISAN')];
const getC = (id) => (clash.find((r) => r.ruleid === id) || {}).detail;
dupes = new Set();
SC(clash.map(({ ruleid, from, to, updated }) => ({ ruleid, from, to, updated })), getC, 2026, 9, dupes, null, ALL);
ck('overlapping coverage IS still reported as a conflict', dupes.has('12:3'), [...dupes].join());

// --- the label parser
ck('a labelled rule name yields its label', RL('12-----09------01-----3-----EKONOMI') === 'EKONOMI', '');
ck('an unlabelled rule name yields null', RL('12-----09------01-----3') === null, '');
ck('a name FMX wrote itself yields null', RL('some manual rule') === null, '');

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
