// boots the scratch copy of the console with a stateful fake FMX:
// rules live in rules.json so they survive a SIGKILL, like the real FMX does.
process.env.PORT = '4692';
process.env.AUTH_SECRET = 'testsecret-abc';
process.env.INTERNAL_SECRET = 'testinternal-abc';
const fs = require('fs');
const path = require('path');
// only ever launched by bulk-resume.test.js inside its temp COPY of the repo
const REPO = path.join(__dirname, '..');
const DB = path.join(__dirname, '..', '..', 'rules.json'); // the test's temp work dir
const WLOG = path.join(__dirname, '..', '..', 'writes.log');
const readDb = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return { nextId: 9000, rules: [] }; } };
const writeDb = (db) => fs.writeFileSync(DB, JSON.stringify(db));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fmxMod = require(REPO + '/lib/fmx.js');
const P = fmxMod.FmxClient.prototype;
P.hasCookie = () => true;
P.keepAlive = async () => {};
P.getVehicleGroups = async () => [{ id: '1', code: 'ZU-A' }];
P.getRules = async () => readDb().rules.map(({ ruleid, from, to, updated }) => ({ ruleid, from, to, updated }));
P.getDetail = async (ruleid) => {
  const r = readDb().rules.find((x) => x.ruleid === Number(ruleid));
  if (!r) { const e = new Error('NO_RULE'); throw e; }
  return r.detail;
};
P.createRule = async (station, a) => {
  await sleep(120); // give the harness a window to SIGKILL mid-sweep
  const db = readDb();
  const ruleid = db.nextId++;
  const day = `${a.year}-${String(a.month).padStart(2, '0')}-${String(a.day).padStart(2, '0')}`;
  db.rules.push({
    ruleid, from: `${day} 00:01`, to: `${day} 23:59`, updated: new Date().toISOString(),
    detail: {
      numDays: a.duration, chkNumDays: true, priceType: 'percent',
      priceChange: a.pct, active: a.active !== false, vendors: a.vendors || ['ALL'],
      vehicleIds: (a.vehicleIds || ['1']).join(','),
      chkWeekdays: false, chkWeekdays2: false, chkPickupTime: false, chkDropoffTime: false,
    },
  });
  writeDb(db);
  fs.appendFileSync(WLOG, `C ${day} ${a.duration}\n`);
  return { ruleid, verified: true };
};
P.updateRule = async (station, ruleid, a) => {
  await sleep(120);
  const db = readDb();
  const r = db.rules.find((x) => x.ruleid === Number(ruleid));
  if (!r) throw new Error('NO_RULE');
  r.detail.priceChange = a.pct;
  r.detail.active = a.active !== false;
  writeDb(db);
  fs.appendFileSync(WLOG, `U ${r.from.slice(0, 10)} ${a.duration}\n`);
  return { ruleid, verified: true };
};

const srv = require(REPO + '/server.js');
srv.booted.then(() => {
  srv.app.listen(4692, () => console.log('BOOT_READY'));
});
