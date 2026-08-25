/**
 * Pricing Sentinel — FMX auth gate.
 *
 * Verifies the username/password the landing page collects against the real
 * FuseMetrix login (zrh.dps.greenmotion.com), exactly like the local console's
 * lib/fmx.js login flow: fetch the login page (session cookie + dynamic
 * username_<n> field), POST the credentials, follow redirects, and check
 * whether a login form still comes back.
 *
 * It returns ONLY {ok:true|false} — it never stores credentials, never returns
 * the FMX session, and keeps nothing. The landing page uses ok:true purely to
 * unlock the static marketing content.
 */
const { onRequest } = require('firebase-functions/v2/https');

const BASE = 'https://zrh.dps.greenmotion.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 PricingSentinel';

async function fmxLogin(username, password) {
  const jar = new Map();
  const collect = (res) => {
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  const jarStr = () =>
    [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const follow = async (res, maxHops) => {
    let hops = 0;
    while (res.status >= 300 && res.status < 400 && hops++ < maxHops) {
      const loc = new URL(res.headers.get('location') || '/', BASE).href;
      res = await fetch(loc, {
        headers: { 'User-Agent': UA, Cookie: jarStr() },
        redirect: 'manual',
      });
      collect(res);
    }
    return res;
  };

  let res = await fetch(BASE + '/', {
    headers: { 'User-Agent': UA },
    redirect: 'manual',
  });
  collect(res);
  res = await follow(res, 5);
  const loginHtml = await res.text();

  const um = /name=["'](username_\d+)["']/.exec(loginHtml);
  if (!um) throw new Error('LOGIN_FORM_NOT_FOUND');
  const am =
    /<form[^>]*id=["']loginForm["'][^>]*action=["']([^"']+)["']/.exec(loginHtml);
  const action = new URL(am ? am[1] : '/home/login.php', BASE).href;

  const body = new URLSearchParams();
  body.set('screenheight', '1080');
  body.set('screenwidth', '1920');
  body.set(um[1], username);
  body.set('password', password);

  res = await fetch(action, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Cookie: jarStr(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    redirect: 'manual',
  });
  collect(res);
  res = await follow(res, 6);
  const finalHtml = await res.text();

  // still on a login form -> credentials rejected
  if (/id=["']loginForm["']/.test(finalHtml) || /name=["']username_\d+/.test(finalHtml)) {
    return false;
  }
  return true;
}

exports.login = onRequest(
  { region: 'europe-west6', cors: true, timeoutSeconds: 30 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'POST only' });
      return;
    }
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: 'MISSING_CREDENTIALS' });
      return;
    }
    try {
      const ok = await fmxLogin(String(username), String(password));
      res.json({ ok });
    } catch (e) {
      res.status(502).json({ error: e.message || 'FMX_UNREACHABLE' });
    }
  }
);
