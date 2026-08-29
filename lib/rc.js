/**
 * rentalcars.com public search API — split into three pieces so the fetch can
 * run anywhere while parsing stays server-side:
 *   - rcUrl(args)         -> { url, headers, meta } for a raw relay job
 *   - rcParse(json, meta) -> the console's shape (top list + GM rank)
 *   - rcFetch(args)       -> rcUrl + fetch + rcParse (direct; works from
 *     residential IPs — rentalcars answers datacenter IPs, Google Cloud
 *     included, with HTTP 405 regardless of headers)
 * The location autocomplete (placesUrl/placesParse/placesFetch) lives on the
 * same host, so the relay's `www.rentalcars.com` pin already covers it.
 */

// the console's reasoning currency — every rule, floor and comparison is CHF
const RC_CURRENCY = 'CHF';

const RC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Stations are tenant data now (server.js owns the registry), but rcUrl is also
// reached by callers that only know a station id — they resolve through this
// hook, which server.js installs at boot.
let resolveStation = () => null;
/** Install the tenant-backed `id -> {type, loc, label}` lookup. */
function setStationResolver(fn) {
  resolveStation = typeof fn === 'function' ? fn : () => null;
}

// raw rentalcars category value -> display category key. The same table lives in
// public/app.js (RC_CAT_MAP) for the competitor modal; the server-side auto-scan
// needs it too (it builds a price ladder per display category), so the canonical
// copy is exported from here. Keep the two in sync.
const RC_CAT_MAP = {
  economy: 'ECONOMY',
  compact: 'COMPACT',
  intermediate: 'MIDSIZE', standard: 'MIDSIZE',
  full_size: 'LARGE', premium: 'LARGE', luxury: 'LARGE', special: 'LARGE',
  estate: 'WAGON',
  suvs: 'SUV',
  carriers: 'MINIVAN', carriers_5: 'MINIVAN', carriers_5_2: 'MINIVAN',
  carriers_7: 'MINIVAN', carriers_8: 'MINIVAN', carriers_9: 'MINIVAN',
};
// display order, same as the client's RC_CAT_DISPLAY
const RC_CAT_KEYS = ['ECONOMY', 'COMPACT', 'MIDSIZE', 'LARGE', 'WAGON', 'SUV', 'MINIVAN'];

const rcIsGm = (x) => /green motion/i.test((x && x.supplier) || '');
/** does one parsed `top` row belong to a display category? (a car can be in two) */
const rcRowInCat = (x, cat) =>
  !!(x && Array.isArray(x.categories) && x.categories.some((v) => RC_CAT_MAP[v] === cat));

class RcError extends Error {
  constructor(message, { status = 0, blocked = false } = {}) {
    super(message);
    this.status = status;
    this.blocked = blocked; // true when the edge refused us (IP block), not a bad query
  }
}

const fmtDt = (d, hh, mm) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${hh}:${mm}:00`;

/** Build one search URL + headers; meta carries the label strings for rcParse.
 *  `rc` is the station's rentalcars location ({type, loc, label}); callers that
 *  pass only `station` fall back to the tenant resolver. */
function rcUrl({ station, rc, year, month, day, duration, hh, mm }) {
  const cfg = rc || resolveStation(station);
  if (!cfg || !cfg.type || !cfg.loc) throw new RcError('BAD_STATION', { status: 400 });

  const pu = new Date(year, month - 1, day);
  const dr = new Date(pu.getTime() + duration * 86400000);
  const sc = JSON.stringify({
    driversAge: 30,
    pickUpLocation: cfg.loc,
    pickUpDateTime: fmtDt(pu, hh, mm),
    pickUpLocationType: cfg.type,
    dropOffLocation: cfg.loc,
    dropOffLocationType: cfg.type,
    dropOffDateTime: fmtDt(dr, hh, mm),
    searchMetadata: '{}',
  });
  const fc = JSON.stringify({ sortBy: 'PRICE', sortAscending: true });
  // Ask EXACTLY what a plain visitor's browser asks. Pinning the currency and a
  // language header looked harmless on 2026-08-29 and measurably was not: with
  // either one attached, ZRH answered 199-200 offers carrying the -12% campaign,
  // and with neither it answered 231 offers with no campaign at all — the second
  // being what rentalcars.com actually shows the operator. Currency is verified
  // instead, in rcParse: a foreign-currency answer is flagged, never silently
  // compared. Do not re-add request parameters without measuring the catalogue.
  return {
    url: `https://www.rentalcars.com/api/search-results?searchCriteria=${encodeURIComponent(sc)}&filterCriteria=${encodeURIComponent(fc)}`,
    headers: { 'User-Agent': RC_UA, Accept: 'application/json' },
    meta: {
      cfgName: cfg.label || cfg.name || String(station ?? ''),
      pickUp: fmtDt(pu, hh, mm),
      dropOff: fmtDt(dr, hh, mm),
    },
  };
}

/** Reduce one raw search response to the console's shape (top list + GM rank). */
function rcParse(j, meta) {
  j = j || {}; // relay bodies are untrusted input — a null root must not throw here
  const rows = (j.matches || [])
    .map((m) => {
      const depot = (j.depots || {})[m.route && m.route.pickUpDepotId] || {};
      const sup = (j.suppliers || {})[depot.supplierId] || {};
      const price =
        (m.vehicle && m.vehicle.driveAwayPrice && m.vehicle.driveAwayPrice.amount) ??
        (m.vehicle && m.vehicle.price && m.vehicle.price.amount);
      const before = m.vehicle && m.vehicle.priceBefore && m.vehicle.priceBefore.amount;
      // `price` is the EFFECTIVE price — what the customer actually pays, i.e.
      // rentalcars' campaign quote when one is running. Ranking and the band
      // both work on it, deliberately: the operator competes on the number
      // shoppers see. `before` carries the pre-discount price so the table can
      // show "134 -> 118" exactly as rentalcars.com does.
      //
      // Whether a given response carries the campaign is a COIN FLIP per
      // request (measured 2026-08-29: 12 of 14 identical ZRH queries came back
      // discounted, 2 clean), so stability cannot come from this parse. It comes
      // from pinning the day's snapshot client-side and from rcQuery preferring
      // a campaign-bearing response — see RC_PIN_MIN in public/app.js.
      const quoted = Number(price);
      const listed = before != null && Number(before) > quoted ? Number(before) : null;
      return {
        supplier: sup.name || '?',
        // path-only concat: a hostile logoUrl must not steer the browser to another host
        logo:
          sup.logoUrl && String(sup.logoUrl).startsWith('/')
            ? 'https://cdn2.rcstatic.com' + sup.logoUrl
            : null,
        price: quoted,
        // the pre-discount price, only when a campaign is genuinely running
        before: listed,
        currency: (m.vehicle && m.vehicle.price && m.vehicle.price.currency) || 'CHF',
        vehicle: (m.vehicle && m.vehicle.makeAndModel) || '',
        rating: depot.rating ? depot.rating.average : null,
        // gearbox + fuel columns (Berkay, 2026-08-29) — single letters / short
        // strings so the cached entry stays small; 'N/A' fuel becomes null
        gear:
          m.vehicle && m.vehicle.transmission === 'AUTOMATIC' ? 'A'
          : m.vehicle && m.vehicle.transmission === 'MANUAL' ? 'M'
          : null,
        fuel:
          m.vehicle && m.vehicle.fuel && m.vehicle.fuel !== 'N/A'
            ? String(m.vehicle.fuel)
            : null,
        // raw API groupings — the client maps these to display categories
        categories: Array.isArray(m.vehicle && m.vehicle.carCategories)
          ? m.vehicle.carCategories.map(String)
          : [],
        // carClass deliberately NOT kept: it was never read anywhere and cost
        // ~8% of every cached entry's size (measured 2026-08-28)
      };
    })
    .filter((x) => isFinite(x.price))
    .sort((a, b) => a.price - b.price);

  const isGm = rcIsGm;
  const gmIdx = rows.findIndex(isGm);
  // category aggregates over the FULL parsed list (rows sorted price-asc, so the
  // first offer seen in each category is the cheapest) — one entry per raw value
  const catMap = new Map();
  for (const x of rows) {
    const gm = isGm(x);
    for (const value of x.categories) {
      let c = catMap.get(value);
      if (!c) {
        c = { value, count: 0, priceFrom: null, gmCount: 0, gmPriceFrom: null };
        catMap.set(value, c);
      }
      c.count += 1;
      if (c.priceFrom == null) c.priceFrom = x.price;
      if (gm) {
        c.gmCount += 1;
        if (c.gmPriceFrom == null) c.gmPriceFrom = x.price;
      }
    }
  }
  const categories = [...catMap.values()].sort((a, b) => b.count - a.count);
  // a currency other than the console's would make every comparison meaningless
  const cur = rows[0] ? rows[0].currency : RC_CURRENCY;
  const currencyMismatch = cur !== RC_CURRENCY;
  return {
    station: meta.cfgName,
    pickUp: meta.pickUp,
    dropOff: meta.dropOff,
    total: rows.length,
    // the FULL price-sorted ladder: the client slices what it displays, but
    // category views need every row — a category whose cheapest offer sits
    // deep in the global ladder was invisible when this was capped at 52
    top: rows.slice(0, 250),
    // full GM fleet + competitor price ladder: lets the console place N GM
    // cars inside the top-10 (one % rule scales every GM offer together)
    gmOffers: rows.filter(isGm).slice(0, 12).map((x) => ({ vehicle: x.vehicle, price: x.price })),
    compPrices: rows.filter((x) => !isGm(x)).slice(0, 30).map((x) => x.price),
    gmRank: gmIdx >= 0 ? gmIdx + 1 : null,
    gmPrice: gmIdx >= 0 ? rows[gmIdx].price : null,
    categories,
    currency: cur,
    currencyMismatch,
  };
}

/** Run one search and reduce it to the console's shape (top list + GM rank). */
async function rcFetch(args) {
  const { url, headers, meta } = rcUrl(args);
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  if (!r.ok) {
    // 403/405/429 from their edge = source-IP refusal, not a query problem
    const blocked = r.status === 403 || r.status === 405 || r.status === 429;
    throw new RcError('RC_HTTP_' + r.status, { status: r.status, blocked });
  }
  return rcParse(await r.json(), meta);
}

// ---------- location autocomplete (the airport/station picker) ----------
// Same public rentalcars host as the search API — and the same IP politics, so
// from the cloud this also has to travel through the relay.

/** Build the autocomplete URL + headers (raw relay job shape, no meta). */
function placesUrl(q) {
  return {
    url:
      'https://www.rentalcars.com/FTSAutocomplete.do?solrIndex=fts_en&solrRows=8&solrTerm=' +
      encodeURIComponent(String(q || '')),
    headers: { 'User-Agent': RC_UA, Accept: 'application/json' },
  };
}

/** Reduce one autocomplete response to the console's picker shape.
 *  placeType 'A' is an airport (carries an IATA code); everything else — city,
 *  district, POI — is pinned by coordinates, exactly like the rc station config. */
function placesParse(j) {
  const docs = (j && j.results && j.results.docs) || [];
  return docs
    .map((d) => {
      const iata = String((d && d.iata) || '').toUpperCase();
      const airport = String((d && d.placeType) || '') === 'A' && /^[A-Z]{3}$/.test(iata);
      const label = String((d && d.name) || (d && d.city) || '').trim();
      const parts = [d && d.city, d && d.country]
        .map((x) => String(x || '').trim())
        .filter((x) => x && x !== label);
      return {
        label,
        sublabel: [...new Set(parts)].join(', '),
        type: airport ? 'IATA' : 'LATLONG',
        loc: airport ? iata : `${d && d.lat},${d && d.lng}`,
        iata: airport ? iata : null,
        country: (d && d.country) || null,
      };
    })
    .filter((x) => x.label && /^([A-Z]{3}|-?\d+(\.\d+)?,-?\d+(\.\d+)?)$/.test(x.loc))
    .slice(0, 8);
}

/** Run one autocomplete query (direct; blocked from datacenter IPs like rcFetch). */
async function placesFetch(q) {
  const { url, headers } = placesUrl(q);
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok) {
    const blocked = r.status === 403 || r.status === 405 || r.status === 429;
    throw new RcError('RC_HTTP_' + r.status, { status: r.status, blocked });
  }
  return placesParse(await r.json());
}

module.exports = {
  RC_CAT_MAP, RC_CAT_KEYS, RcError, setStationResolver,
  rcIsGm, rcRowInCat, rcUrl, rcParse, rcFetch,
  placesUrl, placesParse, placesFetch,
};
