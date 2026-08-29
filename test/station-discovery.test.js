/**
 * Station discovery: FuseMetrix is the source of truth for WHICH stations
 * exist. fmx.getStations() reads them off the weekly-rules page's station
 * <select>; the server folds unknown ones into the tenant registry at login
 * (rc: null until an admin maps a rentalcars location in Settings).
 *
 *   node test/station-discovery.test.js
 */
const { FmxClient } = require('../lib/fmx.js');

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };

(async () => {
  const fmx = new FmxClient();
  fmx.fetchPage = async () => ({
    html: `<html><body>
      <select name="bes_price_override">
        <option value="61489" selected>Zurich Airport</option>
        <option value="61551">Zurich Downtown</option>
        <option value="61600">Basel  Airport</option>
        <option value="61601">Geneva Airport</option>
        <option value="">choose…</option>
        <option value="abc">broken</option>
      </select>
      <select name="options"><option value="9">unrelated</option></select>
    </body></html>`,
  });

  const st = await fmx.getStations();
  ck('every real station is discovered', st.length === 4, JSON.stringify(st));
  ck('ids are numbers', st.every((x) => typeof x.id === 'number' && x.id > 0), JSON.stringify(st.map((x) => x.id)));
  ck('names survive with whitespace collapsed',
    st.some((x) => x.id === 61600 && x.name === 'Basel Airport'), JSON.stringify(st));
  ck('the empty and non-numeric options are dropped',
    st.every((x) => [61489, 61551, 61600, 61601].includes(x.id)), JSON.stringify(st));
  ck('the unrelated select is not read', !st.some((x) => x.id === 9), JSON.stringify(st));

  // the merge contract, lifted out of server.js
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ck('login triggers a station sync', /syncStationsFromFmx\('login'\)/.test(src), 'no login hook');
  ck('the tick refreshes stations daily', /syncStationsFromFmx\('tick'\)/.test(src), 'no tick hook');
  ck('existing registry entries are never overwritten',
    /known\.has\(Number\(st\.id\)\)\) continue;/.test(src), 'merge overwrites');
  ck('new stations arrive without a market mapping', /rc: null \}/.test(src), 'rc not null');
  ck('the auto-scan horizon skips unmapped stations',
    /tenantStations\(\)\.filter\(\(x\) => x\.rc && x\.rc\.loc\)/.test(src), 'no rc filter');

  console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
