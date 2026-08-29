/**
 * Cloud entry point — runs the console as a 2nd-gen HTTPS function
 * (Cloud Run under the hood, so SSE streaming works as it does locally).
 */
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { app, booted } = require('./server');

exports.console = onRequest(
  {
    region: 'europe-west6',
    timeoutSeconds: 300,
    // 512MiB was not enough: the instance was OOM-killed at 621MiB on
    // 2026-08-27, and with maxInstances:1 there is no second instance to serve
    // traffic while a killed one is replaced — every request in that window
    // came back 429 "Rate exceeded". The caches (rc answers + rule details) are
    // what grows, so give them room rather than letting the process die.
    memory: '1GiB',
    // Left at 0 deliberately: the 4-minute scheduler tick already keeps this
    // instance warm, so it practically never scales to zero. minInstances:1
    // would also cover the seconds while Cloud Run recycles an instance on its
    // own, but it bills an always-on instance around the clock — not worth it
    // while the tick plus the client's 429 retry cover the same window.
    minInstances: 0,
    // one instance, always: the FMX write queue, the relay job queue and the
    // login rate limiter are all in-memory — a second instance would reopen
    // the station-context race and split the relay from its jobs
    maxInstances: 1,
    // the relay long-polls (up to 95s per hold) and each worker parks one slot,
    // so the ceiling has to clear those with room for real traffic on top
    concurrency: 60,
    secrets: [],
  },
  async (req, res) => {
    await booted; // persisted state loaded before the first request is served
    return app(req, res);
  }
);

// A min-instances-0 function has no reliable timers, so Cloud Scheduler is the
// heartbeat: every 4 minutes it calls the console's /api/internal/tick, which
// keeps the FMX session alive, runs the hourly market-watch sweep when due,
// and — as a side effect — keeps the single console instance (and its relay
// connection + /tmp caches) warm.
exports.tick = onSchedule(
  {
    region: 'europe-west6',
    schedule: 'every 4 minutes',
    timeoutSeconds: 540, // a sweep routed through the relay can take minutes
    memory: '256MiB',
    maxInstances: 1,
  },
  async () => {
    const url = (process.env.CONSOLE_URL || 'https://sentinelpricing.web.app') + '/api/internal/tick';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'x-internal-secret': process.env.INTERNAL_SECRET || '' },
      signal: AbortSignal.timeout(500 * 1000),
    });
    const body = await r.text();
    if (!r.ok) throw new Error(`tick -> ${r.status} ${body.slice(0, 200)}`);
    console.log('tick:', body.slice(0, 200));
  }
);
