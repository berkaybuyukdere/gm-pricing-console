/**
 * rentalcars refusals and the circuit breaker (2026-09-03).
 *
 * rentalcars fronts its search API with AWS WAF. Over a rate rule the edge
 * answers HTTP 202 with an EMPTY body and `x-amzn-waf-action: challenge` — a
 * JavaScript challenge no fetch can pass. rcRefusalKind() is the one place
 * that recognises a refusal from the status and body the relay hands back;
 * the breaker then stops dispatching for five minutes, because only silence
 * lets the challenge lift.
 *
 *   node test/rc-breaker.test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const fn = src.match(/function rcRefusalKind\(status, body\) \{[\s\S]*?\n\}\n/)[0];
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gm-breaker-')), 'f.js');
fs.writeFileSync(tmp, `${fn}\nmodule.exports = { rcRefusalKind };\n`);
const { rcRefusalKind } = require(tmp);

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };

// the measured signature: 202, content-length 0, "Error from cloudfront"
ck('202 + empty body is the WAF CHALLENGE', rcRefusalKind(202, '') === 'CHALLENGE', rcRefusalKind(202, ''));
ck('202 + whitespace body is still the CHALLENGE', rcRefusalKind('202', '  \n') === 'CHALLENGE', rcRefusalKind('202', '  \n'));
ck('202 WITH a body is not a refusal', rcRefusalKind(202, '{"x":1}') === null, rcRefusalKind(202, '{"x":1}'));
ck('403 is BLOCKED_403', rcRefusalKind(403, '<html>') === 'BLOCKED_403', rcRefusalKind(403, '<html>'));
ck('405 is BLOCKED_405', rcRefusalKind(405, '') === 'BLOCKED_405', rcRefusalKind(405, ''));
ck('429 is BLOCKED_429', rcRefusalKind(429, '') === 'BLOCKED_429', rcRefusalKind(429, ''));
ck('200 + empty body is NOT a refusal (a rentalcars hiccup, handled as a bad result)', rcRefusalKind(200, '') === null, rcRefusalKind(200, ''));
ck('200 + JSON is a normal answer', rcRefusalKind(200, '{"searchResults":[]}') === null, rcRefusalKind(200, '{"searchResults":[]}'));
ck('500 is not a refusal (a bad result, handled elsewhere)', rcRefusalKind(500, '') === null, rcRefusalKind(500, ''));
ck('undefined body on 200 is not a refusal either', rcRefusalKind(200, undefined) === null, rcRefusalKind(200, undefined));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
