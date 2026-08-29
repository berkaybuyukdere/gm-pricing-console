/**
 * FuseMetrix DPS client.
 *
 * Talks to the tenant's DPS host (`fmxBase`) with the user's session cookie and
 * replicates the exact form semantics of /bespoke/rate_manager/weekly_rules_edit.php:
 *   - create: POST with ruleid=0 (station binding comes from server-side session,
 *     so every write is preceded by a GET of the station's rule list to prime it)
 *   - update: POST with ruleid=N (full field set, checkbox fields omitted when off)
 *   - delete: GET weekly_rules.php?bulkdelete=true&recids=N
 * Every write is verified by reading the rule back.
 */
const cheerio = require('cheerio');

// fallback host only: the live one comes from the active tenant's `fmxBase`
// (server.js points the client at it), so a second franchise never writes
// prices into another's FuseMetrix.
const DEFAULT_BASE = 'https://zrh.dps.greenmotion.com';
const LIST_PATH = '/bespoke/rate_manager/weekly_rules.php';
const EDIT_PATH = '/bespoke/rate_manager/weekly_rules_edit.php';
// the rule form's "(select all)" checkbox — a UI helper, not a vehicle group
const SELECT_ALL_ID = '999999';
// the longest rental bucket is open-ended: this duration writes NumDaysOp '>='
// ("14 days or more"); every shorter one writes '='. Must match server.js.
const OPEN_DURATION = 14;

/** Which FMX comparison a duration's rule carries. The longest priced duration
 *  is the OPEN bucket (`>=`), everything below it is exact (`=`). Without an
 *  explicit `openDuration` the ceiling of the console's own scale is assumed. */
const ruleOpFor = (duration, openDuration) =>
  Number(duration) >= Number(openDuration || OPEN_DURATION) ? '>=' : '=';

class FmxError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 500;
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GM-Pricing-Console';

class FmxClient {
  constructor() {
    this.base = DEFAULT_BASE; // tenant's FuseMetrix host, set by the server
    this.validateStation = null; // station the post-login session check reads
    this.cookie = null;
    this.creds = null; // { username, password } — memory only, never persisted
    this.username = null;
    this.stationContext = null; // station id the FMX session is currently primed on
    this._inLogin = false;
    this.vehicleGroupsCache = null; // [{ id, code }] — the rule form's checkboxes
    this.vehicleIdsCache = null; // the same ids, comma-joined for a rule body
    this.detailCache = new Map(); // ruleid -> { stamp, detail }
    this.writeChain = Promise.resolve();
    this._saveTimer = null;
    this._persistFn = null;
  }

  /** Seed the rule-detail cache and register where to persist it. */
  loadDetailCache(obj, persistFn) {
    for (const [id, entry] of Object.entries(obj || {})) {
      this.detailCache.set(Number(id), entry);
    }
    this._persistFn = persistFn || null;
  }

  _persistDetailCache() {
    if (!this._persistFn) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const obj = {};
      for (const [id, entry] of this.detailCache) obj[id] = entry;
      this._persistFn(obj);
    }, 400);
  }

  setCookie(cookie) {
    this.cookie = String(cookie || '').replace(/^cookie:\s*/i, '').trim();
    this.vehicleGroupsCache = null;
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
          const loc = new URL(res.headers.get('location') || '/', this.base).href;
          res = await fetch(loc, {
            headers: { 'User-Agent': UA, Cookie: jarStr() },
            redirect: 'manual',
          });
          collect(res);
        }
        return res;
      };

      let res = await fetch(this.base + '/', {
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
      const action = new URL(am ? am[1] : '/home/login.php', this.base).href;

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
      // validate the session actually works — against a station this tenant
      // owns, never a hardcoded one the franchise may not have access to
      if (this.validateStation) await this.getRules(this.validateStation);
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
    const res = await fetch(this.base + path, {
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
    // a bulk delete's response is the FULL re-rendered rule list — megabytes a
    // batch on a runaway station. When the caller only needs the side effect,
    // skip the download instead of buffering it 60+ times in a row.
    if (opts.discardBody) {
      if (res.body) res.body.cancel().catch(() => {});
      return { redirect: null, html: '' };
    }
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

  /** Every station this FMX account can price, straight from the source: the
   *  weekly-rules page carries a station <select> (bes_price_override) listing
   *  all of them. This is what lets the console discover stations it was never
   *  seeded with. */
  async getStations() {
    const { html } = await this.fetchPage(LIST_PATH);
    const $ = cheerio.load(html);
    const out = [];
    $('select[name="bes_price_override"] option').each((_, el) => {
      const id = Number(String($(el).attr('value') || '').trim());
      const name = $(el).text().trim().replace(/\s+/g, ' ');
      if (id && name) out.push({ id, name });
    });
    if (!out.length) throw new FmxError('NO_STATIONS', 502);
    return out;
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

  /** Re-validate the cache entries for rules THIS process just wrote.
   *
   *  updateRule re-reads a rule to verify the write and caches that detail —
   *  but with no "Date Updated" stamp, because the stamp only exists on the
   *  list page. The next sync then asks getDetail(id, listStamp), compares it
   *  against '' , misses, and re-downloads a page it read seconds earlier.
   *  Measured 2026-08-29: 134 of 426 cached entries (31%) were stamp-less and
   *  therefore re-fetched on EVERY sync; straight after a bulk sweep it is
   *  effectively all of them, which is what made syncing take minutes.
   *
   *  One list request re-validates the whole batch. Only the ids passed in are
   *  touched, so a rule somebody edited in FMX directly is never adopted — its
   *  stamp stays unknown and the next sync re-reads it, exactly as before. */
  async restampWritten(stationId, ruleids) {
    const want = new Set((ruleids || []).map(Number));
    if (!want.size) return 0;
    const rules = await this.getRules(stationId);
    let n = 0;
    for (const r of rules) {
      const id = Number(r.ruleid);
      if (!want.has(id)) continue;
      const e = this.detailCache.get(id);
      if (!e || !r.updated || e.stamp === r.updated) continue;
      this.detailCache.set(id, { stamp: r.updated, detail: e.detail });
      n++;
    }
    if (n) this._persistDetailCache();
    return n;
  }

  async getVendors() {
    if (this.vendorsCache) return this.vendorsCache;
    const { html } = await this.fetchPage(EDIT_PATH); // blank add form
    const $ = cheerio.load(html);
    const vendors = $('select[name="vendor[]"] option')
      .map((_, o) => $(o).attr('value'))
      .get()
      .filter(Boolean);
    if (vendors.length) this.vendorsCache = vendors;
    return vendors;
  }

  /**
   * The rule form's vehicle groups: `value` is the numeric id a rule body
   * carries, `rel` is the group code the operator recognises (ZU-A, ZU-B, …).
   * The `999999` entry is the form's "(select all)" pseudo-checkbox, not a
   * group, so it never reaches a rule body.
   */
  async getVehicleGroups() {
    if (this.vehicleGroupsCache) return this.vehicleGroupsCache;
    const { html } = await this.fetchPage(EDIT_PATH); // blank add form
    const $ = cheerio.load(html);
    const groups = [];
    $('input[name="vehicles[]"]').each((_, el) => {
      const id = String($(el).attr('value') || '').trim();
      if (!/^\d+$/.test(id) || id === SELECT_ALL_ID) return;
      groups.push({ id, code: String($(el).attr('rel') || '').trim() || id });
    });
    if (!groups.length) throw new FmxError('NO_VEHICLE_IDS', 502);
    this.vehicleGroupsCache = groups;
    return this.vehicleGroupsCache;
  }

  async getAllVehicleIds() {
    if (this.vehicleIdsCache) return this.vehicleIdsCache;
    const groups = await this.getVehicleGroups();
    this.vehicleIdsCache = groups.map((g) => g.id).join(', ');
    return this.vehicleIdsCache;
  }

  /** A rule may target a subset of the groups: absent/empty means all of them
   *  (the console's original behaviour). Unknown ids are refused rather than
   *  silently dropped — a typo must not write a rule with the wrong coverage. */
  async resolveVehicleIds(list) {
    if (!Array.isArray(list) || !list.length) return this.getAllVehicleIds();
    const known = new Set((await this.getVehicleGroups()).map((g) => g.id));
    const picked = [...new Set(list.map((v) => String(v).trim()))];
    if (picked.some((v) => !known.has(v))) throw new FmxError('BAD_VEHICLE_GROUP', 400);
    return picked.join(', ');
  }

  // ---------- writes ----------

  /** `openDuration` is the OPEN-ENDED bucket: the longest duration the operator
   *  priced, which must carry `>=` so anything longer is still covered. It used
   *  to be hardcoded to 14, so a sweep that stopped at 9 wrote `= 9` and every
   *  rental of 10+ days fell through with no rule at all. */
  buildRuleBody({ ruleid, day, month, year, duration, pct, active, vehicleIds, vendors, groupLabel, openDuration }) {
    const dd = String(day).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    const p = new URLSearchParams();
    p.set('posted', '1');
    p.set('ruleid', String(ruleid || 0));
    p.set('vehicleIds', vehicleIds);
    // DD-----MM------01-----<duration>, plus the saved vehicle-group set's name
    // when the rule targets one, so the coverage is readable in FMX's own list
    const label = String(groupLabel || '').replace(/[^\w \-]/g, '').trim().slice(0, 24);
    p.set(
      'rulename',
      `${dd}-----${mm}------01-----${duration}` + (label ? `-----${label}` : '')
    );
    if (active) p.set('active', '1');
    for (const v of vendors && vendors.length ? vendors : ['ALL']) p.append('vendor[]', v);
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
    p.set('NumDaysOp', ruleOpFor(duration, openDuration));
    p.set('NumDays', String(duration));
    p.set('priceType', 'percent');
    p.set('priceChange', Number(pct).toFixed(2));
    return p.toString();
  }

  verifyDetail(detail, args) {
    const { day, month, year, duration, pct, active } = args;
    const dd = String(day).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    const problems = [];
    // FMX semantics: a day rule always spans 00:01 -> 23:59 of that single day.
    // Compare the whole window, times included — a wrong time silently changes
    // which pickups the rule covers.
    if (detail.datefrom !== `${year}-${mm}-${dd} 00:01`)
      problems.push(`datefrom=${detail.datefrom}`);
    if (detail.dateto !== `${year}-${mm}-${dd} 23:59`)
      problems.push(`dateto=${detail.dateto}`);
    if (String(detail.numDays) !== String(duration))
      problems.push(`numDays=${detail.numDays}`);
    if (Number(detail.priceChange).toFixed(2) !== Number(pct).toFixed(2))
      problems.push(`priceChange=${detail.priceChange}`);
    if (detail.active !== !!active) problems.push(`active=${detail.active}`);
    const expectedOp = ruleOpFor(duration, args.openDuration);
    if (detail.numDaysOp !== expectedOp) problems.push(`op=${detail.numDaysOp}`);
    const wantVendors = (args.vendors && args.vendors.length ? args.vendors : ['ALL']).slice().sort().join(',');
    const gotVendors = (detail.vendors || []).slice().sort().join(',');
    if (wantVendors !== gotVendors) problems.push(`vendors=${gotVendors || '—'}`);
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
      const vehicleIds = await this.resolveVehicleIds(args.vehicleIds);
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
      const vehicleIds = await this.resolveVehicleIds(args.vehicleIds);
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

  /** Delete MANY rules in one round-trip per hundred. FMX's own Delete button
   *  does exactly this (`bulkdelete=true&recids=a,b,c`); it only fails when the
   *  page tries to send thousands of ids in one URL. 100 ids keeps the URL
   *  near 800 bytes, and turns a station reset from hours of one-by-one
   *  deletes into a couple of minutes. */
  async deleteRules(stationId, ruleids, onBatch) {
    const BATCH = 100;
    let deleted = 0;
    for (let i = 0; i < ruleids.length; i += BATCH) {
      const slice = ruleids.slice(i, i + BATCH);
      await this.enqueueWrite(async () => {
        await this.primeStation(stationId);
        // the deletion happens server-side while FMX renders its response —
        // the multi-MB page itself is of no use here, so it is not downloaded
        await this.fetchPage(`${LIST_PATH}?bulkdelete=true&recids=${slice.join(',')}`, { discardBody: true });
        for (const id of slice) this.detailCache.delete(Number(id));
      });
      deleted += slice.length;
      if (onBatch) onBatch(deleted, slice.length);
    }
    return { deleted };
  }
}

module.exports = { FmxClient, FmxError, ruleOpFor, OPEN_DURATION };
