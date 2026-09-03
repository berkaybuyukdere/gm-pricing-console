#!/bin/bash
# GM Pricing Relay — macOS installer (downloaded from the console's Settings page).
# The console URL and relay secret below were baked in server-side at download time.
# Run with: bash ~/Downloads/install-gm-relay.sh
set -euo pipefail

CONSOLE_URL='__CONSOLE_URL__'
DIR="$HOME/GMPricingRelay"
PLIST="$HOME/Library/LaunchAgents/com.gm.pricing-relay.plist"
LABEL='com.gm.pricing-relay'

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo 'Node.js bulunamadi — kurulum: brew install node / Node.js not found — install with: brew install node' >&2
  exit 1
fi
MAJOR="$("$NODE" -p 'parseInt(process.versions.node)')"
if [ "$MAJOR" -lt 18 ]; then
  echo "Node.js >= 18 gerekli / required (bulunan/found: $("$NODE" -v)) — brew upgrade node" >&2
  exit 1
fi

mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$DIR"

# quoted delimiter: the embedded JS keeps its backticks and ${} verbatim
cat > "$DIR/relay.js" <<'RELAY_EOF'
// GM Pricing Relay — standalone raw worker (written by install-gm-relay.sh).
// Long-polls the console for rentalcars jobs, fetches each URL from this
// machine's IP and posts the raw response back. Outbound HTTPS only.
const os = require('os');

const CONSOLE_URL = '__CONSOLE_URL__';
const RELAY_SECRET = '__RELAY_SECRET__';
// undici rejects non-ISO-8859-1 header values — keep the name plain ASCII
const NAME = os.hostname().replace(/[^\x20-\x7E]/g, '').slice(0, 64) || 'relay';

const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

let inFlight = 0;

async function runJob(job) {
  inFlight++;
  let body;
  try {
    if (!job.url) {
      body = { id: job.id, ok: false, error: 'NO_URL' }; // console build predates the raw protocol
    } else if (new URL(job.url).hostname !== 'www.rentalcars.com') {
      body = { id: job.id, ok: false, error: 'BAD_URL' }; // only rentalcars is ever fetched
    } else {
      // rentalcars fronts the search API with AWS WAF; a rate rule answers 202 +
      // `x-amzn-waf-action: challenge` (2026-09-03). A browser on this machine
      // passes that challenge and holds an `aws-waf-token` cookie; with that
      // cookie a plain fetch is served again (measured: 202 -> 200, 240 rows).
      // The token lives in waf-token.txt beside this file; refresh it from a
      // browser when the log shows 202/challenge again.
      const headers = { ...job.headers };
      try {
        const tok = fs.readFileSync(path.join(__dirname, 'waf-token.txt'), 'utf8').trim();
        if (tok) headers.Cookie = 'aws-waf-token=' + tok;
      } catch {}
      const r = await fetch(job.url, { headers, signal: AbortSignal.timeout(25000) });
      const text = await r.text();
      const waf = r.headers.get('x-amzn-waf-action');
      if (r.status !== 200 || waf) log(`[relay] rentalcars answered ${r.status}${waf ? ' waf=' + waf : ''} bytes=${text.length}`);
      body = { id: job.id, ok: true, status: r.status, body: text }; // 4xx/5xx flow through as status
    }
  } catch (e) {
    body = { id: job.id, ok: false, error: e.message };
  }
  inFlight--;
  // The console parks on this job for 90s. It runs on a single Cloud Run
  // instance, so a burst can refuse this POST outright (429 "no available
  // instance") — the request never reached the app, so resending is safe and
  // is the difference between an answer and a 90s stall the operator sees as
  // a dead cell.
  const payload = JSON.stringify(body);
  const delays = [700, 2000, 5000, 11000];
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    try {
      const r = await fetch(CONSOLE_URL + '/api/relay/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-relay-secret': RELAY_SECRET, 'x-relay-name': NAME },
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
  let connected = false; // '[relay] connected' is only logged after a real HTTP 200 poll
  while (true) {
    try {
      if (inFlight >= 4) {
        await sleep(300); // cap concurrent rentalcars fetches
        continue;
      }
      const r = await fetch(CONSOLE_URL + '/api/relay/poll', {
        headers: { 'x-relay-secret': RELAY_SECRET, 'x-relay-name': NAME },
        signal: AbortSignal.timeout(40000),
      });
      if (r.status === 429) {
        // the console had no instance free — backing off here is what keeps a
        // burst from turning into a poll storm that prolongs it
        await sleep(3000 + Math.random() * 4000);
        continue;
      }
      if (r.status === 401 || r.status === 404) {
        connected = false;
        log(`[relay] console refused (${r.status}) — retrying in 60s`);
        await sleep(60000);
        continue;
      }
      if (!connected && r.status === 200) {
        connected = true;
        log(`[relay] connected to ${CONSOLE_URL} — waiting for rentalcars jobs`);
      }
      const { job } = await r.json();
      if (job) runJob(job); // deliberately not awaited: keep polling while it runs
    } catch (e) {
      await sleep(5000); // network hiccup / poll timeout — just reconnect
    }
  }
})();
RELAY_EOF
chmod 600 "$DIR/relay.js" # embeds RELAY_SECRET
touch "$DIR/relay.log"
chmod 600 "$DIR/relay.log"

# unquoted delimiter: $NODE and $HOME must expand — LaunchAgents get no PATH
# and no cwd, so every path in the plist has to be absolute
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$HOME/GMPricingRelay/relay.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/GMPricingRelay/relay.log</string>
  <key>StandardErrorPath</key><string>$HOME/GMPricingRelay/relay.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1 # bootstrap right after bootout intermittently fails with I/O error 5
: > "$DIR/relay.log" # a stale 'connected' line must not pass the check below
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl kickstart -k "gui/$(id -u)/$LABEL"

# an idle console holds the first poll for 25s before answering — allow 40s
for i in $(seq 1 20); do
  sleep 2
  if grep -qF '[relay] connected' "$DIR/relay.log" 2>/dev/null; then
    echo "OK — relay calisiyor / relay running ($(hostname)) -> $CONSOLE_URL"
    rm -f -- "$0" 2>/dev/null || true
    echo 'Not: Bu kurulum dosyasi erisim anahtari icerdigi icin Downloads klasorunden silindi.'
    echo 'Note: this installer contained an access key and was removed from Downloads.'
    exit 0
  fi
done
echo 'Relay 40 sn icinde baglanamadi / did not connect within 40s — log:' >&2
tail -5 "$DIR/relay.log" >&2 || true
exit 1
