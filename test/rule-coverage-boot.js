// Boots the console against a fake FMX seeded with a CATEGORY-SCOPED weekly
// rule, and records every write's args to writes.json so the test can assert
// what actually reached FMX. Launched only by rule-coverage.test.js, inside its
// temp copy of the repo.
process.env.PORT = '4693';
process.env.AUTH_SECRET = 'testsecret-abc';
process.env.INTERNAL_SECRET = 'testinternal-abc';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const WORK = path.join(__dirname, '..', '..');
const WRITES = path.join(WORK, 'writes.json');

// one rule covering vehicle groups 3 and 7, named with its category
const RULE = {
  ruleid: 5001,
  rulename: '12-----09------01-----3-----SUV GRUBU',
  active: true,
  datefrom: '2026-09-12 00:01',
  dateto: '2026-09-12 23:59',
  chkNumDays: true,
  numDaysOp: '=',
  numDays: '3',
  priceType: 'percent',
  priceChange: '-20',
  vendors: ['ALL'],
  vehicleIds: '3, 7',
  chkWeekdays: false, chkWeekdays2: false, chkPickupTime: false, chkDropoffTime: false,
};

const record = (kind, args) => {
  const all = (() => { try { return JSON.parse(fs.readFileSync(WRITES, 'utf8')); } catch { return []; } })();
  all.push({ kind, args });
  fs.writeFileSync(WRITES, JSON.stringify(all, null, 1));
};

const fmxMod = require(REPO + '/lib/fmx.js');
const P = fmxMod.FmxClient.prototype;
P.hasCookie = () => true;
P.keepAlive = async () => {};
P.getVehicleGroups = async () =>
  Array.from({ length: 39 }, (_, i) => ({ id: String(i + 1), code: 'ZU-' + String.fromCharCode(65 + (i % 26)) }));
P.getRules = async () => [{ ruleid: RULE.ruleid, from: RULE.datefrom, to: RULE.dateto, updated: 'u1' }];
P.getDetail = async (ruleid) => {
  if (Number(ruleid) !== RULE.ruleid) throw new Error('NO_RULE');
  return { ...RULE };
};
// resolveVehicleIds is the real one — that is exactly the code path under test
P.createRule = async function (station, args) {
  record('create', { ...args, resolved: await this.resolveVehicleIds(args.vehicleIds) });
  return { ruleid: 9999, verified: true };
};
P.updateRule = async function (station, ruleid, args) {
  record('update', { ruleid, ...args, resolved: await this.resolveVehicleIds(args.vehicleIds) });
  return { ruleid, verified: true };
};

// seed a pending auto-scan proposal for the same cell, so the test can drive
// the mail/console one-click apply path as well as the plain PUT
const SEED = {
  id: 'seedset01',
  createdAt: new Date().toISOString(),
  source: 'auto',
  status: 'pending',
  items: [{
    station: 61489, stationName: 'Zurich Airport', year: 2026, month: 9, day: 12,
    duration: 3, curPct: -20, newPct: -28, direction: 'down',
  }],
  missing: [],
  appliedAt: null, appliedBy: null, result: null,
};
fs.writeFileSync(path.join(REPO, '.rc-watch.json'), JSON.stringify({ __proposals: [SEED] }));

const srv = require(REPO + '/server.js');
srv.booted.then(() => srv.app.listen(4693, () => console.log('BOOT_READY')));
