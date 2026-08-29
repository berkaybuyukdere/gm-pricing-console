# GM Pricing Console

## Before touching pricing on a "wrong price" report

If anyone reports the console's competitor analysis disagreeing with rentalcars.com, run the
`rc-price-check` skill first. rentalcars targets its Green Motion campaign PER SESSION, so the
same query answers "discounted" or "clean" at random — measured 2026-08-29, 12 of 14 identical
ZRH queries came back with the -12% and 2 without. That is not a bug in the console and no
amount of re-querying makes it converge.

Two rules follow, and they are not in tension:

- **Rank on the effective (campaign) price.** `price` is what a shopper actually pays; `before`
  is the pre-discount base rate. Berkay's instruction, 2026-08-29: "indirimli fiyata gore rakip
  analizinde siralama ve yuzde degisimi yapilacak." Never re-base ranking or the band on
  `priceBefore`. DISPLAY (Berkay's pick, later the same day): TWO price columns — muted LIST
  (`before ?? price`) and black CUSTOMER (`price`) — no struck-through price and no -12% badge;
  the badge next to a session that saw none read as an error to the operator.
- **Stability comes from PINNING, not from normalising.** The analysis modal pins the day's
  snapshot (`RC_PIN_MIN`, 6h) and only the REFRESH button re-queries; `rcQuery` additionally
  retries once when the previous snapshot for that cell had a campaign and the new answer does
  not. Before this, every duration click sent `fresh=1`, so clicking "3 DAYS" twice 65 seconds
  apart produced two different ladders (9 GM cars in the top 10, then 4).

Pickup hour is canonical 09:00 (see "The pickup hour" below) with an empty-slot fallback; the
modal footer prints the hour that actually answered.

## A projection is never priced from a target the market contradicts

`gmServedBase` picks the base the live projection re-prices GM from. Normally that is what
rentalcars serves divided by the cell's rule. Right after an apply that is wrong — rentalcars
still serves the PREVIOUS rule — so a pending apply (`rcSync`) may supply the base instead.

That proxy must keep earning it. `syncExplainsMarket` requires the served price to be either the
target (it landed) or what `prevPct` produced (not landed yet), on the campaign or the list
basis; otherwise the sync is marked `expired` and the market wins. Without that check a target
that never lands is never retired and seeds a base forever: measured 2026-08-29 (01 Sep, 1D), a
stuck 122.06 at -14% held a base of 141.93 while rentalcars served GM at 74, so every new
percentage projected GM to #107 at 117.80 when the site had it #4 at 65.

`test/rc-projection.test.js` pins this. Two rules follow: `startRcSync` must always be passed
`prevPct` (use `sim.curPct` — the rule that produced the served price), and `checkRcSync` marks
`expired` once its last scheduled recheck fails. An expired sync also hides the "DPS APPLIED"
bar, which would otherwise claim something the market disproves.

## Never widen a rule by accident

An FMX rule update is a full form POST: it REWRITES `vehicleIds` and rebuilds the
rule name. Any code path calling `fmx.updateRule` must restate `vehicleIds` and
`groupLabel`, or a category-scoped weekly rule silently becomes an all-39-groups
rule with its category name stripped. `PUT /api/rule/:id` now inherits both from
the live rule when the body omits them; an explicit `vehicleIds` array still wins.

## The pricing band (2026-08-28 — CURRENT)

Sit JUST under the cheapest competitor: target = cheapest x 0.97, floor =
max(cheapest x 0.95, cheapest - 10 CHF) per category; min(targets) clamped up to
max(floors). Berkay's words: "if they are at 100, be at 95-97 — never 70." SCAN
writes upward corrections when a price is under the band. All math runs on
DISPLAYED prices, so campaign discounts are inherently accounted for.

Deliberate rollbacks — do not resurrect: weekly rules always cover ALL vehicle
groups (picker retired), the lane bar is off (the lane model stays), and SCAN
asks no questions (all categories, only cells with weekly rules, 30-min cache).
Station maintenance (RESET / COPY TO…) lives on the grid topbar, admin-only;
the purge deletes 100 rules per FMX request.

## Tests

`npm test` runs both suites and must pass before a deploy:

- `test/rc-parse.test.js` — rcParse price contract, against a real captured rentalcars response.
- `test/margin-floor.test.js` — the pricing band, with Berkay's literal 100->95-97 numbers.
- `test/mail-optout.test.js` — report-mail opt-out covers the deploy default.
- `test/api-retry.test.js` — the 429 retry contract and poll back-off.
- `test/horizon.test.js` — the free-text weekly-rules horizon ("2 hafta", "3 weeks", 45).
- `test/lanes.test.js` — price lanes: key folding, overlap, per-lane reads.
- `test/rule-coverage.test.js` — re-pricing never widens a category rule or drops its name.
- `test/bulk-resume.test.js` — a bulk sweep survives a SIGKILL and is resumed by the scheduler tick.
- `test/detail-restamp.test.js` — the detail cache never re-downloads a page it just read.
- `test/pickup-ring.test.js` — the 09:00-19:00 pickup ring wraps and never escapes.
- `test/rc-sampling.test.js` — a fresh snapshot keeps the price most shoppers get.

## Why only Green Motion's price moves

rentalcars prices GM per session and nobody else. Measured 2026-08-29, 14 identical ZRH queries
seconds apart: GM's list price returned 124.30 ten times, 118.29 twice, clean-catalogue twice,
while Dollar (149.83), Thrifty (151.45) and Hertz (153.07) returned the same franc every time.
FMX is NOT the cause and there is nothing to fix there — Price Overrides Hourly, Timing Rules,
Out Of Hours Rules and Seasonal Rules are all empty for Zurich Airport (verified read-only in DPS
on 2026-08-29), so GM has no hour-dependent pricing of its own.

Stability therefore comes from two places, neither of which rewrites a price:
1. **Sampling** — a FRESH analysis query asks up to 5 times and keeps the FIRST campaign-bearing
   draw (`rcSampled`); only an all-clean draw set (campaign genuinely off) keeps the fullest
   clean catalogue. Settled live 2026-08-29 with eleven side-by-side page-loads: every fresh
   session — incognito, fresh tabs, and a LOGGED-IN booking.com account — showed the -12%
   campaign at identical prices; only one stale-cookie session (also priced ×1.05 high) was
   clean. So the campaign answer is the customer's view, a REFRESH cannot flip the ladder on a
   re-roll (~(1/7)^5), and the common case still costs ~1 call. Do not re-prefer the clean shape
   and do not merge the shapes — a 1:1 incognito check must keep matching to the cent. Grid
   scans and sweeps still cost one call per cell (plus one campaign-restoring retry on a
   contradiction with the previous snapshot).
2. **Snapshots** — the answer is pinned in the operator's own browser (`RC_SNAP_KEY`, 12h, LRU 60)
   as well as the server cache, so a recycled Cloud Run instance cannot re-roll the dice. Only
   REFRESH drops a snapshot. The footer shows `GM ±x%` when the samples disagreed.

## The pickup hour (2026-08-29)

Canonical hour is **09:00** (`RC_HOUR` in server.js, `RC_START_HOUR`/`RC_CANON` in app.js). The
grid, the watcher and the auto-scan all query it, so they cannot disagree with the analysis
modal's default view. The modal alone carries a `-/+` stepper that walks a 09:00-19:00 ring in
1-hour steps and wraps at both ends; stepping re-runs the analysis, and because the hour is part
of the rc cache key each hour keeps its own pinned snapshot. The footer names the hour that
actually ANSWERED, which is how an empty-slot fallback stays visible. Nothing rotates the hour
automatically — an earlier build did, and a price that moves because our own clock moved reads
as the console being wrong.

## Why sync was slow

`updateRule` re-reads each rule to verify the write, but caches it with no "Date Updated"
stamp (the stamp only exists on the list page), so the next sync missed on every rule the
console had written and re-downloaded it. Measured 2026-08-29: 134 of 426 live cache entries
(31%) were stamp-less, and straight after a bulk sweep it is effectively the whole station.
`fmx.restampWritten(station, ruleids)` now re-validates the batch with ONE list request at the
end of a sweep and of an apply. It only ever adopts stamps for ids it is handed, so a rule
edited in FMX by someone else is still re-read.

## Deploy

`npx firebase deploy --only functions --project sentinelpricing`
