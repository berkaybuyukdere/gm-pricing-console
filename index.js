/**
 * Cloud entry point — runs the console as a 2nd-gen HTTPS function
 * (Cloud Run under the hood, so SSE streaming works as it does locally).
 */
const { onRequest } = require('firebase-functions/v2/https');
const { app, booted } = require('./server');

exports.console = onRequest(
  {
    region: 'europe-west6',
    timeoutSeconds: 300,
    memory: '512MiB',
    minInstances: 0,
    concurrency: 20,
    secrets: [],
  },
  async (req, res) => {
    await booted; // persisted state loaded before the first request is served
    return app(req, res);
  }
);
