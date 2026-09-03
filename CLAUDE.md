# GM Pricing Console

## The three price planes (measured 2026-08-30, all three for the same search minutes apart)

1. **FMX retail** = Price Override `Day1_base × days` × (1 + weekly-rule %) [× promo when a
   promotion window covers the pickup]. One percent per (day, duration), all vendors, all groups.
2. **GM's own site** (greenmotion.com → api.greenmotion.com, engine = FMX) shows FMX retail TO
   THE CENT — 9 vehicle groups implied the identical USD/CHF rate to five decimals. A hand check
   against FMX math always matches here.
3. **rentalcars** shows FMX retail × **~1.037–1.051** (their own margin, two concurrent tiers
   ~1.3–2.8% apart, rounded to whole francs) — plus their per-session −12% campaign lottery.

The console's pct math anchors on SERVED prices (plane 3), so its targets already contain the
uplift and land exactly when the landing draw keeps the tier (139.94 → 139.95 verified). A
"console pct doesn't match FMX hand math" report is a cross-plane comparison, not a bug: the
~5% gap IS rentalcars' margin. Never "fix" the pct math to remove it.

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

That proxy must keep earning it. `syncClassify` judges a pending apply against the FULL ladder
(never a category view — the anchors are the overall-cheapest GM as served at apply time,
`allServed`/`allBefore`, times `ratio` = (1+applied)/(1+prev)): `live` hands the base back to
the market; `prev` divides the CURRENT view's served price by whichever rule provably produced
it (`servedUnderPct` — prevPct or a replaced-but-written intermediate from `alsoPcts`);
`ambiguous` (change smaller than the 2.5% quote noise) never confirms live; `genlive` (matches
only through the 2.4-2.7% concurrent-generation offset) is neither confirmation nor strike;
`contradict` retires the sync. Campaign-free draws are also tested ×`RC_CAMPAIGN_RATE` (0.88):
anchors are customer-basis, clean draws serve the list basis.

Hard-won rules pinned by `test/rc-projection.test.js` (19 checks — the 2026-08-29 evening audit
found and fixed all of these):
- EVERY path that turns a target price into a pct (`placeGm`, `editGmPrice`, `placeFleet`,
  `rcProjFactor`, `projectPlacement`) goes through `gmServedBase` — an inline
  `gmPrice/(1+cellMap.pct)` invents a base during the post-confirm window (a click promising
  59.70 wrote a pct that landed GM at 52.24).
- `startRcSync` gets `sim.servedPct ?? sim.curPct` as prevPct (during a chained apply curPct is
  a pct rentalcars never served) and snapshots its own station/year/month — `checkRcSync`
  queries THAT cell, never live state (a station switch mid-window once verified another
  station's price against a Zurich target).
- `checkRcSync` marks `expired` once its last scheduled recheck fails; an expired sync also
  hides the "DPS APPLIED" bar. The stuck-target regression stays pinned: a 122.06 target held a
  141.93 base while the site served GM at 74, projecting #107/117.80 when the site had #4/65.
- Server side, from the same audit: `applyProposalSet` refuses a cell whose rule changed since
  the scan (`RULE_CHANGED_SINCE_SCAN`) instead of replaying the factor onto the wrong basis,
  and restates `openDuration` so it cannot flip a `>=` bucket to `=`; `rcUrl` computes the
  drop-off in calendar days (ms arithmetic lost a day across DST); `rcParse` drops 0-priced
  phantom rows.

## Never widen a rule by accident

An FMX rule update is a full form POST: it REWRITES `vehicleIds` and rebuilds the
rule name. Any code path calling `fmx.updateRule` must restate `vehicleIds` and
`groupLabel`, or a category-scoped weekly rule silently becomes an all-39-groups
rule with its category name stripped. `PUT /api/rule/:id` now inherits both from
the live rule when the body omits them; an explicit `vehicleIds` array still wins.

## The pricing band (2026-09-02 — CURRENT, measured 2026-09-03)

Our CHEAPEST car sits a fixed number of FRANCS under the cheapest competitor —
francs PER RENTAL LENGTH — and however many of our cars fit under them, fit:

    gap    = gapChfByDur[days]           # measured, operator-editable, per tenant
    floor  = max(cheapest - gap, cheapest x 0.85)
    top    = max(cheapest - (gap - 1), floor)
    target = the middle; SCAN and the panel both use bandFor() / categoryFactor()

One FMX % scales every GM car together, so placing the cheapest one fixes the
whole block. **How many of our cars land under the field is an OUTCOME** of the
served ladder's width that day, never a setting. Berkay chose that explicitly
("sabit degil — tabana kadar kac arac sigarsa").

**The table is measured, not modelled.** 2026-09-03, read-only sweep of 98 ZRH
cells (4-17 Sep, 09:00, 1/2/3/5/7/10/14 days) straight from rentalcars via
`lib/rc.js` on the operator's machine — no Cloud Run load. Findings that set it:
- The served ladder keeps ONE shape at every length (our 5th car / our 1st is
  1.07-1.10), so "five of our cars under the field" costs ~8% of the field, and
  the field price grows with the length. A flat franc figure is 15% of a 1-day
  field and 2% of a 14-day one — it held 10 cars under on day-1 (a giveaway)
  and collapsed to 1 on 5+ days.
- Medians that put five of our cars under: 1d 4 · 2d 8 · **3d 10** · 5d 15 ·
  7d 19 · 10d 26 · 14d 40 CHF, interpolated between. Simulated back over every
  measured cell: 5 [3..6] cars under at every length, 7-9.5% of the field. The
  linear 4+2d guess it replaced fell to 3 cars at 14 days.
- What was live that day was inconsistent in BOTH directions: 14 of 77 listed
  cells were NOT #1 (0.3-8 CHF above the field), while 7 Sep 14d sat 83 CHF
  under with the first six ranks ours. And GM was absent from rentalcars on
  4-6 Sep at every length — a listing problem, not a pricing one.
- Raw sweep: `test/fixtures/zrh-sweep-2026-09-03.jsonl`; the band test replays
  it (every cell lands in band, never fewer than two cars under, 3+ on 95%+).

Where it lives: `server.js` (`AUTOSCAN.gapChfByDur`, `autoGapTable()`,
`categoryFactor`, GET/POST `/api/autoscan/categories`), `public/app.js`
(`GAP_DEFAULTS`, `BAND`, `bandFor()`, `loadPricingBand()` at boot, SCAN, the
panel's band line + `snapToBand()`, the Settings card `renderBandCard`).

**The panel says what SCAN would do** (2026-09-02): a band line under the sim
bar — cheapest competitor, this length's target gap, floor-top, where we sit,
and a verdict chip (BANTTA / PAHALI / ÇOK UCUZ); a projection adds "cars under
the field b0 → b1 · gap g0 → g1"; the projected ladder shows the whole block
through the first competitor; BANDA OTUR projects exactly what SCAN would write
for the cell. The grid's double-click editor already re-projects per tick
(`gridLivePreview`).

Two things the previous (97/95-per-100) band got wrong, both measured:
- It put 3% on our cheapest car and let the ladder carry the rest upward, so
  against a 100 CHF field we sat 97/99/100/100/101/102/106 — three under of 7.
- Its floor was PER CATEGORY and each category guarded only itself, so when the
  binding category was another one our overall cheapest car could sit 20 CHF
  under. **Both anchors are market-wide now**; `categories` only narrows WHICH
  rows count, and both anchors then come from that same set.

The 15% `lowPriceGuard` backstops the bottom and only bites under ~67 CHF.
`autoLowGuard()` refuses a stored value outside [0.10, 0.30] so a 0.05 from the
middle world cannot survive. Pinned by `test/margin-floor.test.js` (15 checks).

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
1. **Sampling** — a FRESH analysis query asks up to 5 times (`rcSampled`): campaign-bearing
   draws beat clean ones (settled live 2026-08-29, eleven side-by-side page-loads: every fresh
   session including a logged-in booking.com account showed the -12%; only one stale-cookie
   session was clean), and only an all-clean draw set keeps the fullest clean catalogue. On top
   of the shape, rentalcars serves two price GENERATIONS concurrently (~2-3% apart, per request
   — measured twice on 2026-08-29, incl. console 197.34 vs the operator's browser 192.00 in the
   same minute), so one campaign draw takes ONE confirmation draw: agreeing tiers settle at two
   calls; split tiers prefer the previous snapshot's tier (continuity), else the cheaper draw,
   and the footer's `GM ±x%` shows the split honestly. Do not re-prefer the clean shape and do
   not merge the shapes. Grid scans and sweeps still cost one call per cell (plus one
   campaign-restoring retry on a contradiction with the previous snapshot).
2. **Snapshots** — the answer is pinned in the operator's own browser (`RC_SNAP_KEY`, 12h, LRU 60)
   as well as the server cache, so a recycled Cloud Run instance cannot re-roll the dice. Only
   REFRESH drops a snapshot. The footer shows `GM ±x%` when the samples disagreed.

## The docked competitor panel (2026-08-30)

On desktop the analysis is not a floating modal any more: `#rcModal` (same element and ids) is
docked to the RIGHT of the grid inside `#view-grid`, behind a draggable splitter (`rcDockW.v1`).
One click on a grid cell loads that cell's day into the panel without changing anything;
double-click opens the cell's % editor with −/+ steppers whose every tick live-projects the
panel's ladder. While a projection is on screen the panel shows the projected ladder AND the
served ladder (muted, below) — both states, Berkay's explicit ask. When pricing starts on a
panel whose data is >10 min old, `ensureFreshBase` re-asks rentalcars once in the background
and re-lays the same pct on the live ladder. An APPLY that writes the panel's cell auto-starts
the live-sync check, and a sync that confirms LIVE re-verifies at one extra RANDOM hour
(`confirmSecondHour`). ≤780px keeps the full-screen overlay.

LIVE DATA EVERYWHERE (2026-08-30, supersedes the snapshot pin): the panel queries `fresh=1` on
every open — the 6h pinned-snapshot serving path is retired; the sampler's stability work
(campaign confirm, generation continuity, two-agreeing-clean) is what makes that viable, so do
not resurrect the pin. Snapshots remain only as an offline fallback (marked stale). SCAN and
TOP-10 SWEEP also price from `fresh=1`. Both side panes are PERMANENT on desktop: the grid
auto-opens them on the first BOOKABLE day (09:00 pickup still in the future) via
`ensureSidePanes` and re-targets on month/station switch; only resizing is allowed. The APPLY
bar always reserves its space (`.applybar.hidden` keeps display:flex + visibility:hidden) so
its appearance never shifts the grid mid-click.

The panel has NO confirm and NO open button (2026-08-30): every projection stages itself and
the bottom-right APPLY TO DPS bar is the only write path. rentalcars is EMBEDDED in the page
(`#rcWeb`, grid | rcWeb | panel with two draggable splitters): the real page cannot be iframed
(X-Frame-Options: SAMEORIGIN, measured), so the pane renders the full ladder rentalcars
serves; ↗ opens the real page, ≤780px falls back to a tab. ONE left click drives BOTH side
views onto the clicked cell (right-click is an alias), there is ONE shared hour (`rcHour`),
and the pane MIRRORS the panel's own answer (`rcWebMirror` in renderRcTable) — one query, two
renderings, so the views can never disagree. After an APPLY the panel shows ONLY what
rentalcars actually serves: no projected overlay pretends to be the market; the applied price
appears when `checkRcSync` proves the landing (plus a second-random-hour confirm), and the
follow-up steps the shared hour, re-queries fresh, and looks again ~90s later. The panel's
cell wears a solid accent ring on the grid (`cell-active`), the pane's cell a blue inner ring
(`cell-live`). Rollback checkpoints: a02f8dc (before round 5), 97abc34 (after);
**26e8ca1 = tag `rollback-pre-band-2026-09-03`** (the 97/95 band, deployed until
2026-09-03) → **2ee697a = tag `band-2026-09-03`** (the measured franc band).
Roll back with `git checkout rollback-pre-band-2026-09-03 && npx firebase deploy
--only functions --project sentinelpricing` — the function serves the client
bundle too, so one deploy moves both.

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
