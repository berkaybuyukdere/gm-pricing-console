/**
 * The console is pinned to ONE Cloud Run instance (its FMX write queue and
 * relay job queue live in that process's memory), so a burst has no second
 * instance to spill into and Cloud Run aborts requests with
 *   429 "The request was aborted because there was no available instance."
 *
 * Berkay hit this twice on 2026-08-27: a grid SCAN died at cell 114, and the
 * bulk-job poller logged 429s. These checks pin the client's retry contract,
 * which is what makes those transients invisible.
 *
 * app.js is a browser script, so the pieces under test are lifted out of it and
 * run against a stub fetch — no server, no network.
 *
 *   node test/api-retry.test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const block = src.match(
  /const API_RETRY_ANY_METHOD[\s\S]*?^async function api\(path, opts = \{\}\) \{[\s\S]*?^  const data = await res\.json\(\)\.catch\(\(\) => \(\{\}\)\);/m
);
if (!block) { console.error('FAIL  could not lift the api() retry block out of public/app.js'); process.exit(1); }
const pollDelay = src.match(/function bulkPollDelay\(elapsedMs\) \{[\s\S]*?\n\}/);
if (!pollDelay) { console.error('FAIL  could not lift bulkPollDelay out of public/app.js'); process.exit(1); }

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-api-retry-'));
const tmp = path.join(tmpdir, 'api.js');
fs.writeFileSync(tmp, `
${block[0]}
  return { res, data };
}
${pollDelay[0]}
module.exports = { api, apiPressure, apiThrottled, bulkPollDelay, API_RETRY_DELAYS };
`);
const { api, apiPressure, apiThrottled, bulkPollDelay } = require(tmp);

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };

// make the retry sleeps instant so the suite stays fast
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);

/** a fetch that returns `codes` in order, then 200.
 *  `retryAfter` (seconds) models our own capacity guard's header — the real
 *  Response always has .headers, and api() reads it on a 429. */
function stubFetch(codes, retryAfter) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, method: (opts.method || 'GET').toUpperCase() });
    const code = calls.length <= codes.length ? codes[calls.length - 1] : 200;
    return {
      status: code,
      ok: code < 400,
      headers: { get: (h) => (/^retry-after$/i.test(h) && retryAfter ? String(retryAfter) : null) },
      json: async () => ({ code }),
    };
  };
  return calls;
}

(async () => {
  // --- a GET rides out a burst of 429s
  apiPressure.until = 0;
  let calls = stubFetch([429, 429, 429]);
  let r = await api('/api/rc-top?x=1');
  ck('a GET retries through 429s and succeeds', r.res.status === 200, `status=${r.res.status}`);
  ck('it really did retry (4 attempts)', calls.length === 4, `calls=${calls.length}`);

  // --- 429 is safe to replay on a WRITE too: the request never reached the app
  apiPressure.until = 0;
  calls = stubFetch([429, 429]);
  r = await api('/api/rule/5001', { method: 'PUT', body: { pct: -20 } });
  ck('a write is replayed on 429 (nothing ran, so nothing double-applies)',
    r.res.status === 200 && calls.length === 3, `status=${r.res.status} calls=${calls.length}`);
  ck('the replay kept the method', calls.every((c) => c.method === 'PUT'), JSON.stringify(calls.map((c) => c.method)));

  // --- 502/503/504 may have EXECUTED, so a write must NOT be replayed blind
  apiPressure.until = 0;
  calls = stubFetch([502, 502]);
  r = await api('/api/rule/5001', { method: 'PUT', body: { pct: -20 } });
  ck('a write is NOT replayed on 502 (it may already have applied)',
    calls.length === 1 && r.res.status === 502, `calls=${calls.length} status=${r.res.status}`);

  // --- ...but a read is
  apiPressure.until = 0;
  calls = stubFetch([503, 504]);
  r = await api('/api/grid');
  ck('a read IS replayed on 503/504', r.res.status === 200 && calls.length === 3, `calls=${calls.length}`);

  // --- give-up: a permanent 429 must surface rather than loop forever
  apiPressure.until = 0;
  calls = stubFetch(Array(50).fill(429));
  r = await api('/api/rc-top?x=2');
  ck('a permanent 429 gives up instead of spinning', r.res.status === 429 && calls.length <= 7,
    `calls=${calls.length}`);

  // --- back-pressure is advertised so looping callers can slow down
  ck('sustained 429s raise the throttle flag', apiThrottled() === true, 'apiThrottled() false');

  // --- OUR OWN capacity guard answers with Retry-After; api() must wait that
  // long instead of guessing, and must advertise the reason to the operator
  apiPressure.until = 0;
  apiPressure.reason = null;
  calls = stubFetch([429], 25);
  r = await api('/api/rc-top?x=3');
  ck('a guarded 429 still succeeds after the advertised wait', r.res.status === 200, r.res.status);
  ck('a long Retry-After is reported as a query limit, not a blip',
    apiPressure.reason === 'limit', apiPressure.reason);
  apiPressure.until = 0;
  apiPressure.reason = null;
  calls = stubFetch([429], 2);
  await api('/api/rc-top?x=4');
  ck('a short Retry-After is reported as a busy queue', apiPressure.reason === 'busy', apiPressure.reason);

  // --- the bulk poller must back off, and back off HARD under pressure
  const underPressure = bulkPollDelay(120000);
  apiPressure.until = 0;
  ck('bulk polling starts responsive', bulkPollDelay(0) <= 2000, bulkPollDelay(0));
  ck('bulk polling backs off on a long run', bulkPollDelay(120000) >= 8000, bulkPollDelay(120000));
  ck('bulk polling backs off further under back-pressure',
    underPressure > bulkPollDelay(120000), `${underPressure} vs ${bulkPollDelay(120000)}`);
  // the concrete win: an hour-long sweep no longer costs thousands of polls
  let t = 0, polls = 0;
  while (t < 3600000) { t += bulkPollDelay(t); polls++; }
  ck('an hour-long sweep costs far fewer polls than the old 1.5s loop (2400)',
    polls < 600, `polls=${polls}`);

  global.setTimeout = realSetTimeout;
  fs.rmSync(tmpdir, { recursive: true, force: true });
  console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
