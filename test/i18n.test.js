/**
 * Every i18n key the UI references must exist in ALL THREE language blocks.
 * The class of bug this pins: `data-i18n="purge_hint"` shipped with no
 * purge_hint anywhere, so applyLang() destroyed the DELETE ALL safety copy at
 * boot and painted the literal key instead (found 2026-08-28).
 *
 *   node test/i18n.test.js
 */
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { console.log('PASS ', n); pass++; } else { console.log('FAIL ', n, '--', d); fail++; } };

// keys defined per language block: scan the I18N literal between block markers
function blockKeys(lang) {
  const startRe = new RegExp(`^  ${lang}: \\{`, 'm');
  const start = app.search(startRe);
  if (start < 0) return null;
  // the block ends at the next "  <lang>: {" or the closing "};"
  const rest = app.slice(start + 6);
  const end = rest.search(/^  [a-z]{2}: \{|^\};/m);
  const body = rest.slice(0, end < 0 ? undefined : end);
  const keys = new Set();
  // keys may share a line ("username: '…', cancel: '…',") — match a key
  // wherever it follows a line start, comma or brace, and opens a string
  for (const m of body.matchAll(/(?:^|[,{])\s*([A-Za-z_][A-Za-z0-9_]*):\s*['"]/gm)) keys.add(m[1]);
  return keys;
}

const en = blockKeys('en'), de = blockKeys('de'), tr = blockKeys('tr');
ck('all three language blocks found', en && de && tr, 'block parse failed');
if (!en || !de || !tr) process.exit(1);

// referenced keys: t('key'...) in app.js + data-i18n / data-i18n-ph in index.html
const used = new Set();
for (const m of app.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) used.add(m[1]);
for (const m of html.matchAll(/data-i18n(?:-ph)?="([A-Za-z0-9_]+)"/g)) used.add(m[1]);
// keys referenced through the category display table
for (const m of app.matchAll(/i18n: '([A-Za-z0-9_]+)'/g)) used.add(m[1]);

const missing = [];
for (const k of used) {
  for (const [name, set] of [['en', en], ['de', de], ['tr', tr]])
    if (!set.has(k)) missing.push(`${k} (missing in ${name})`);
}
ck(`every referenced key exists in every language (${used.size} keys checked)`,
  missing.length === 0, missing.slice(0, 12).join('; '));

// the three blocks must be identical key sets — a key in one but not another
// is a translation someone forgot
const diff = [];
for (const k of en) { if (!de.has(k)) diff.push(k + ' en-only vs de'); if (!tr.has(k)) diff.push(k + ' en-only vs tr'); }
for (const k of de) if (!en.has(k)) diff.push(k + ' de-only');
for (const k of tr) if (!en.has(k)) diff.push(k + ' tr-only');
ck(`the three blocks carry identical key sets (en=${en.size} de=${de.size} tr=${tr.size})`,
  diff.length === 0, diff.slice(0, 12).join('; '));

// Brand scrub (Berkay, 2026-08-28): the FuseMetrix name must not appear in any
// user-visible UI text — the neutral name is DPS. Lowercase identifiers
// (apply_fmx, fmxSession) are code contracts and deliberately exempt.
const branded = [];
for (const [name, txt] of [['app.js', app], ['index.html', html]]) {
  for (const m of txt.matchAll(/FuseMetrix|FUSEMETRIX|\bFMX\b/g))
    branded.push(`${name}@${txt.slice(0, m.index).split('\n').length}`);
}
ck('no FuseMetrix/FMX branding in user-visible UI files', branded.length === 0, branded.slice(0, 8).join(', '));

console.log(fail ? fail + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
