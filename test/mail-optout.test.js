/**
 * Report-mail opt-out. Berkay turned report mails off in Settings and kept
 * receiving them (2026-08-28): his prefs had no custom address, so the opt-out
 * never covered the deploy-default SMTP_TO he was actually reached through.
 *
 *   node test/mail-optout.test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const fn = src.match(/function mailRecipients\(\) \{[\s\S]*?\n\}/);
if (!fn) { console.error('FAIL  could not lift mailRecipients out of server.js'); process.exit(1); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-mail-'));
const tmp = path.join(dir, 'm.js');
fs.writeFileSync(tmp, `
let PREFS = {};
let SMTP_TO = null;
const smtpCfg = { get to() { return SMTP_TO; } };
const store = { get: () => PREFS };
${fn[0]}
module.exports = (prefs, dflt) => { PREFS = prefs; SMTP_TO = dflt; return mailRecipients(); };
`);
const recipients = require(tmp);

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// the reported bug: reports off, NO custom address -> the default must go silent
ck('opt-out with no custom address silences the deploy default',
  eq(recipients({ u1: { reports: false } }, 'berkay@x.com'), []),
  JSON.stringify(recipients({ u1: { reports: false } }, 'berkay@x.com')));

// opt-out with a custom address silences that address (already worked)
ck('opt-out with a custom address stays silent',
  eq(recipients({ u1: { mailTo: 'a@x.com', reports: false } }, 'dflt@x.com'), []),
  JSON.stringify(recipients({ u1: { mailTo: 'a@x.com', reports: false } }, 'dflt@x.com')));

// nobody configured anything -> the default still receives
ck('untouched install still mails the default',
  eq(recipients({}, 'dflt@x.com'), ['dflt@x.com']), JSON.stringify(recipients({}, 'dflt@x.com')));

// one operator on, one off — only the on one receives
ck('mixed prefs mail only the opted-in operator',
  eq(recipients({ u1: { mailTo: 'on@x.com' }, u2: { mailTo: 'off@x.com', reports: false } }, 'dflt@x.com'), ['on@x.com']),
  JSON.stringify(recipients({ u1: { mailTo: 'on@x.com' }, u2: { mailTo: 'off@x.com', reports: false } }, 'dflt@x.com')));

// an opt-out via the default must not silence a DIFFERENT custom address
ck('default opt-out does not silence another operator\'s own address',
  eq(recipients({ u1: { reports: false }, u2: { mailTo: 'keep@x.com' } }, 'dflt@x.com'), ['keep@x.com']),
  JSON.stringify(recipients({ u1: { reports: false }, u2: { mailTo: 'keep@x.com' } }, 'dflt@x.com')));

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
