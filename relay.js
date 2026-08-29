/**
 * RC relay — run this on any machine whose IP rentalcars actually serves
 * (your own computer): `npm run relay`.
 *
 * rentalcars.com refuses requests coming from datacenter IPs (the deployed
 * console on Google Cloud gets HTTP 405 no matter what), so the cloud console
 * hands its rentalcars queries to this worker instead: the relay long-polls
 * the console over plain outbound HTTPS (no ports opened, nothing inbound)
 * and runs each query from this machine's IP. RAW protocol: the console sends
 * `{ id, url, headers }`, the relay fetches that URL verbatim and posts back
 * `{ id, ok, status, body }` — all parsing happens server-side, so the relay
 * needs nothing beyond Node's built-in fetch. Both endpoints require the
 * shared RELAY_SECRET.
 *
 * Configuration (env wins over .secrets.json):
 *   RELAY_URL    e.g. https://sentinelpricing.web.app
 *   RELAY_SECRET the same value the console function is deployed with
 * or in .secrets.json: { "relay": { "url": "...", "secret": "..." } }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// undici rejects non-ISO-8859-1 header values — keep the name plain ASCII
const NAME = os.hostname().replace(/[^\x20-\x7E]/g, '').slice(0, 64) || 'relay';

function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.secrets.json'), 'utf8')).relay || {};
  } catch {}
  const url = (process.env.RELAY_URL || fileCfg.url || '').replace(/\/+$/, '');
  const secret = process.env.RELAY_SECRET || fileCfg.secret || '';
  return url && secret ? { url, secret } : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startRelay(cfg, log = console.log) {
  let inFlight = 0;
  let stopped = false;

  async function runJob(job) {
    inFlight++;
    let body;
    try {
      if (!job.url) {
        body = { id: job.id, ok: false, error: 'NO_URL' }; // console build predates the raw protocol
      } else if (new URL(job.url).hostname !== 'www.rentalcars.com') {
        body = { id: job.id, ok: false, error: 'BAD_URL' }; // only rentalcars is ever fetched
      } else {
        const r = await fetch(job.url, { headers: job.headers, signal: AbortSignal.timeout(25000) });
        body = { id: job.id, ok: true, status: r.status, body: await r.text() }; // 4xx/5xx flow through as status
      }
    } catch (e) {
      body = { id: job.id, ok: false, error: e.message };
    }
    inFlight--;
    // Pushing the result back matters more than fetching it did: the console is
    // parked on this job and only gives up after 90s. The console runs on a
    // single Cloud Run instance, so a burst can refuse this POST outright
    // (429 "no available instance") — the request never reached the app, so
    // resending it is safe and is the difference between an answer and a 90s
    // stall the operator sees as a dead cell.
    const payload = JSON.stringify(body);
    const delays = [700, 2000, 5000, 11000];
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      try {
        const r = await fetch(cfg.url + '/api/relay/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-relay-secret': cfg.secret, 'x-relay-name': NAME },
          body: payload,
          signal: AbortSignal.timeout(30000), // raw bodies are ~1MB
        });
        status = r.status;
        if (r.ok) {
          log(`[relay] job ${job.id.slice(0, 8)} ${body.ok ? 'ok' : 'failed: ' + body.error}`);
          break;
        }
      } catch (e) {
        log(`[relay] result push failed: ${e.message}`);
      }
      if (attempt >= delays.length) {
        log(`[relay] job ${job.id.slice(0, 8)} result abandoned after ${attempt + 1} tries`);
        break;
      }
      if (status && status !== 429 && status < 500) break; // a real rejection, not back-pressure
      await sleep(delays[attempt] * (0.75 + Math.random() * 0.5));
    }
  }

  (async () => {
    log(`[relay] connected to ${cfg.url} — waiting for rentalcars jobs`);
    while (!stopped) {
      try {
        if (inFlight >= 4) {
          await sleep(300); // cap concurrent rentalcars fetches
          continue;
        }
        const r = await fetch(cfg.url + '/api/relay/poll', {
          headers: { 'x-relay-secret': cfg.secret, 'x-relay-name': NAME },
          signal: AbortSignal.timeout(40000),
        });
        if (r.status === 429) {
          // the console had no instance free — backing off here is what keeps a
          // burst from turning into a poll storm that prolongs it
          await sleep(3000 + Math.random() * 4000);
          continue;
        }
        if (r.status === 401) {
          log('[relay] RELAY_SECRET rejected by the console — retrying in 60s');
          await sleep(60000);
          continue;
        }
        if (r.status === 404) {
          log('[relay] console has no relay endpoints (RELAY_SECRET not deployed) — retrying in 60s');
          await sleep(60000);
          continue;
        }
        const { job } = await r.json();
        if (job) runJob(job); // deliberately not awaited: keep polling while it runs
      } catch (e) {
        await sleep(5000); // network hiccup / poll timeout — just reconnect
      }
    }
  })();

  return () => { stopped = true; };
}

if (require.main === module) {
  const cfg = loadConfig();
  if (!cfg) {
    console.error('relay: set RELAY_URL + RELAY_SECRET (env or .secrets.json "relay" block).');
    process.exit(1);
  }
  startRelay(cfg);
}

module.exports = { startRelay, loadConfig };
