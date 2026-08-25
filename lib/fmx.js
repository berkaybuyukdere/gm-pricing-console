/**
 * FuseMetrix DPS client.
 *
 * Talks to zrh.dps.greenmotion.com with the user's pasted session cookie and
 * replicates the exact form semantics of /bespoke/rate_manager/weekly_rules_edit.php:
 *   - create: POST with ruleid=0 (station binding comes from server-side session,
 *     so every write is preceded by a GET of the station's rule list to prime it)
 *   - update: POST with ruleid=N (full field set, checkbox fields omitted when off)
 *   - delete: GET weekly_rules.php?bulkdelete=true&recids=N
 * Every write is verified by reading the rule back.
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const BASE = 'https://zrh.dps.greenmotion.com';
const CACHE_FILE = path.join(__dirname, '..', '.cache-details.json');
const LIST_PATH = '/bespoke/rate_manager/weekly_rules.php';
const EDIT_PATH = '/bespoke/rate_manager/weekly_rules_edit.php';

class FmxError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 500;
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GM-Pricing-Console';

class FmxClient {
  constructor() {
    this.cookie = null;
    this.creds = null; // { username, password } — memory only, never persisted
    this.username = null;
    this.stationContext = null; // station id the FMX session is currently primed on
    this._inLogin = false;
    this.vehicleIdsCache = null;
    this.detailCache = new Map(); // ruleid -> { stamp, detail }
    this.writeChain = Promise.resolve();
    this._saveTimer = null;
    this._loadDetailCache();
  }

  _loadDetailCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      for (const [id, entry] of Object.entries(raw)) {
        this.detailCache.set(Number(id), entry);
      }
    } catch {
      /* no cache yet */
    }
  }

  _persistDetailCache() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const obj = {};
      for (const [id, entry] of this.detailCache) obj[id] = entry;
      fs.writeFile(CACHE_FILE, JSON.stringify(obj), () => {});
    }, 400);
  }

  setCookie(cookie) {
    this.cookie = String(cookie || '').replace(/^cookie:\s*/i, '').trim();
    this.vehicleIdsCache = null;
    // detailCache survives re-login: entries are keyed by ruleid + the list's
    // "Date Updated" stamp, which invalidates them independently of the session
  }

  hasCookie() {
    return !!this.cookie;
  }

  /**
   * Log in to FuseMetrix: fetch the login page (session cookie + the
   * dynamic username_<n> field name), POST credentials, follow redirects,
   * and keep the resulting session cookie jar.
   */
  async login(username, password) {
    this._inLogin = true;
    try {
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
      if (!um) throw new FmxError('LOGIN_FORM_NOT_FOUND', 502);
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

      if (/id=["']loginForm["']/.test(finalHtml) || /name=["']username_\d+/.test(finalHtml)) {
        throw new FmxError('LOGIN_FAILED', 401);
      }

      this.setCookie(jarStr());
      await this.getRules(61489); // validate the session actually works
      this.creds = { username, password };
      this.username = username;
      return true;
    } finally {
      this._inLogin = false;
    }
  }

  async keepAlive() {
    if (!this.cookie) return;
    try {
      await this.fetchPage('/home/liteTop_fmx3.php?mwoid=4&checksession=true');
    } catch {
      /* auto-relogin already attempted inside fetchPage when creds exist */
    }
  }

  /** Serialize writes: FMX station context lives in the PHP session, so two
   *  concurrent creates for different stations would race. */
  enqueueWrite(fn) {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(() => {}, () => {});
    return run;
  }

  async fetchPage(path, opts = {}, _retried = false) {
    try {
      return await this._fetchPage(path, opts);
    } catch (e) {
      // transparent re-login once when the session died and we hold creds
      if (e.code === 401 && this.creds && !this._inLogin && !_retried) {
        await this.login(this.creds.username, this.creds.password);
        return this.fetchPage(path, opts, true);
      }
      throw e;
    }
  }

  async _fetchPage(path, opts = {}) {
    if (!this.cookie) throw new FmxError('NO_SESSION', 401);
    const res = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers: {
        Cookie: this.cookie,
        'User-Agent': UA,
        ...(opts.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: opts.body || undefined,
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      if (/login/i.test(loc)) throw new FmxError('SESSION_EXPIRED', 401);
      return { redirect: loc, html: '' };
    }
    if (res.status >= 400) throw new FmxError('FMX_HTTP_' + res.status, 502);
    const html = await res.text();
    if (html.trim() === 'LOGOUT') throw new FmxError('SESSION_EXPIRED', 401);
    if (/id=["']loginForm["']/i.test(html) && /name=["']?password/i.test(html)) {
      throw new FmxError('SESSION_EXPIRED', 401);
    }
    return { redirect: null, html };
  }

  // ---------- reads ----------

  async getRules(stationId) {
    const { html } = await this.fetchPage(
      `${LIST_PATH}?vehicle_override_location_id=${stationId}`
    );
    const $ = cheerio.load(html);
    if (!/Rule name/i.test($('table').first().text())) {
      throw new FmxError('UNEXPECTED_LIST_PAGE', 502);
    }
    const rules = [];
    $('input.rule_checkbox').each((_, el) => {
      const $tr = $(el).closest('tr');
      const cells = $tr
        .find('td')
        .map((__, c) => $(c).text().trim().replace(/\s+/g, ' '))
        .get();
      const ruleid = Number($(el).attr('value'));
      if (!ruleid) return;
      rules.push({
        ruleid,
        name: cells[1] || '',
        active: (cells[2] || '') === 'Yes',
        from: cells[3] || '',
        to: cells[4] || '',
        added: cells[5] || '',
        updated: cells[7] || '',
      });
    });
    this.stationContext = Number(stationId);
    return rules;
  }

  /** GET the station's rule list only when the session isn't already primed
   *  on it — the list request is what binds new rules to a station. */
  async primeStation(stationId) {
    if (this.stationContext === Number(stationId)) return;
    await this.getRules(stationId);
  }

  async getDetail(ruleid, stamp) {
    const cached = this.detailCache.get(ruleid);
    if (cached && stamp && cached.stamp === stamp) return cached.detail;

    const { html } = await this.fetchPage(`${EDIT_PATH}?ruleid=${ruleid}`);
    const $ = cheerio.load(html);
    const val = (n) => $(`input[name="${n}"]`).attr('value') || '';
    const sel = (n) => {
      const o = $(`select[name="${n}"] option[selected]`);
      if (!o.length) return '';
      return o.attr('value') !== undefined ? o.attr('value') : o.text().trim();
    };
    const chk = (n) => $(`input[name="${n}"]`).is('[checked]');

    const detail = {
      ruleid,
      rulename: val('rulename'),
      active: chk('active'),
      datefrom: val('datefrom'),
      dateto: val('dateto'),
      chkNumDays: chk('chkNumDays'),
      numDaysOp: sel('NumDaysOp'),
      numDays: val('NumDays'),
      priceType: sel('priceType'),
      priceChange: val('priceChange'),
      vendors: $('select[name="vendor[]"] option[selected]')
        .map((_, o) => $(o).attr('value'))
        .get(),
      vehicleIds: val('vehicleIds'),
      chkWeekdays: chk('chkWeekdays'),
      chkWeekdays2: chk('chkWeekdays2'),
      chkPickupTime: chk('chkPickupTime'),
      chkDropoffTime: chk('chkDropoffTime'),
    };
    this.detailCache.set(ruleid, { stamp: stamp || '', detail });
    this._persistDetailCache();
    return detail;
  }

  async getAllVehicleIds() {
    if (this.vehicleIdsCache) return this.vehicleIdsCache;
    const { html } = await this.fetchPage(EDIT_PATH); // blank add form
    const $ = cheerio.load(html);
    const ids = $('input[name="vehicles[]"]')
      .map((_, el) => $(el).attr('value'))
      .get()
      .filter((v) => v && /^\d+$/.test(v));
    if (!ids.length) throw new FmxError('NO_VEHICLE_IDS', 502);
    this.vehicleIdsCache = ids.join(', ');
    return this.vehicleIdsCache;
  }

  // ---------- writes ----------

  buildRuleBody({ ruleid, day, month, year, duration, pct, active, vehicleIds }) {
    const dd = String(day).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    const p = new URLSearchParams();
    p.set('posted', '1');
    p.set('ruleid', String(ruleid || 0));
    p.set('vehicleIds', vehicleIds);
    p.set('rulename', `${dd}-----${mm}------01-----${duration}`);
    if (active) p.set('active', '1');
    p.append('vendor[]', 'ALL');
    p.set('datefrom', `${year}-${mm}-${dd} 00:01`);
    p.set('d_datefrom', dd);
    p.set('m_datefrom', mm);
    p.set('y_datefrom', String(year));
    p.set('datefrom_justtime', '00:01');
    p.set('dateto', `${year}-${mm}-${dd} 23:59`);
    p.set('d_dateto', dd);
    p.set('m_dateto', mm);
    p.set('y_dateto', String(year));
    p.set('dateto_justtime', '23:59');
    p.set('weekdaytype', 'contain');
    p.set('weekday2type', 'contain');
    p.set('pickupArTime', '00:00');
    p.set('pickupDeTime', '00:00');
    p.set('dropoffArTime', '00:00');
    p.set('dropoffDeTime', '00:00');
    p.set('chkNumDays', '1');
    p.set('NumDaysOp', duration >= 6 ? '>=' : '=');
    p.set('NumDays', String(duration));
    p.set('priceType', 'percent');
    p.set('priceChange', Number(pct).toFixed(2));
    return p.toString();
  }

  verifyDetail(detail, { day, month, year, duration, pct, active }) {
    const dd = String(day).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    const problems = [];
    if (!detail.datefrom.startsWith(`${year}-${mm}-${dd}`))
      problems.push(`datefrom=${detail.datefrom}`);
    if (String(detail.numDays) !== String(duration))
      problems.push(`numDays=${detail.numDays}`);
    if (Number(detail.priceChange).toFixed(2) !== Number(pct).toFixed(2))
      problems.push(`priceChange=${detail.priceChange}`);
    if (detail.active !== !!active) problems.push(`active=${detail.active}`);
    const expectedOp = duration >= 6 ? '>=' : '=';
    if (detail.numDaysOp !== expectedOp) problems.push(`op=${detail.numDaysOp}`);
    return problems;
  }

  extractRuleId(redirect, html) {
    const m1 = /ruleid=(\d+)/.exec(redirect || '');
    if (m1) return Number(m1[1]);
    if (html) {
      const $ = cheerio.load(html);
      const v = $('input[name="ruleid"]').attr('value');
      if (v && Number(v) > 0) return Number(v);
    }
    return null;
  }

  async createRule(stationId, args) {
    return this.enqueueWrite(async () => {
      await this.primeStation(stationId); // skipped when already on this station
      const vehicleIds = await this.getAllVehicleIds();
      const body = this.buildRuleBody({ ...args, ruleid: 0, vehicleIds });
      const { redirect, html } = await this.fetchPage(EDIT_PATH, {
        method: 'POST',
        body,
      });
      const newId = this.extractRuleId(redirect, html);
      if (!newId) throw new FmxError('CREATE_NO_RULEID', 502);

      this.detailCache.delete(newId);
      const detail = await this.getDetail(newId);
      const problems = this.verifyDetail(detail, args);
      return { ruleid: newId, verified: problems.length === 0, problems, detail };
    });
  }

  async updateRule(stationId, ruleid, args) {
    return this.enqueueWrite(async () => {
      // updates bind via ruleid — no station priming needed
      const vehicleIds = await this.getAllVehicleIds();
      const body = this.buildRuleBody({ ...args, ruleid, vehicleIds });
      await this.fetchPage(EDIT_PATH, { method: 'POST', body });
      this.detailCache.delete(ruleid);
      const detail = await this.getDetail(ruleid);
      const problems = this.verifyDetail(detail, args);
      return { ruleid, verified: problems.length === 0, problems, detail };
    });
  }

  async deleteRule(stationId, ruleid) {
    return this.enqueueWrite(async () => {
      await this.primeStation(stationId);
      await this.fetchPage(`${LIST_PATH}?bulkdelete=true&recids=${ruleid}`);
      this.detailCache.delete(Number(ruleid));
      return { ruleid: Number(ruleid), deleted: true };
    });
  }
}

module.exports = { FmxClient, FmxError };
