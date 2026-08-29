# GM Pricing Console

A fast, Palantir-style pricing panel for **Green Motion Zurich**'s FuseMetrix
Dynamic Pricing System (FMX DPS). It replaces the slow Weekly Rules workflow
with a month × duration grid: type a percentage, hit apply, and the change is
written to FuseMetrix as a proper weekly rule — verified by reading it back.

## What it does

- **Month grid** — rows are the days of the month, columns are rental
  durations (2, 3, 4, 5, 6+ days). Each cell is the % price change for
  pickups on that day with that duration.
- **Fast edits** — click a cell and type; click a column header to fill the
  whole month; click a day label to fill every duration of that day. Changes
  are staged locally and pushed in one batch with **APPLY TO FMX**.
- **Correct FMX writes** — creates/updates/deletes real weekly rules via the
  same form endpoints the FMX UI uses (`weekly_rules_edit.php`), with the
  documented semantics: duration 2–5 uses `NumDaysOp "="`, 6 uses `">= 6"`,
  vendor `ALL`, every vehicle group unless a subset is chosen, full-day date
  window. Every write is
  verified by re-reading the rule; results are shown per cell.
- **Streaming loads** — the grid paints cell-by-cell as rule details resolve
  (SSE). Loaded months are cached client-side (instant back/forward
  navigation) and server-side on disk (only rules whose FMX `Date Updated`
  stamp changed are re-fetched).
- **Price curve chart** — sidebar line chart of the month's % changes, one
  line per duration, with crosshair tooltip. Palette validated for
  colorblind-safety in both themes.
- **Activity log** — every create/update/delete with timestamp, user, target
  date/duration, before → after values, and success/failure. Persisted to
  `.logs.json`, browsable in the LOGS drawer.
- **rentalcars.com compare** — right-click any cell to open a rentalcars
  search for exactly that pickup day + duration at the panel's station, sorted
  by lowest price. Pickup/dropoff times rotate per click:
  19:00 → 18:30 → … → 16:00 → back to 19:00.
- **Firebase sign-in + roles** — the console opens behind a Firebase Auth
  (e-mail/password) gate. Two roles: `admin` and `staff`; admin-only surfaces
  (station management) are hidden or read-only for staff. The FuseMetrix login
  is the *second* step and only binds the FMX session.
- **Multi-franchise stations** — stations live in a `tenants` record, not in
  the source. Settings → **STATIONS** (admin) edits the list and picks each
  station's rentalcars location from a live airport/city search.
- **Bulk weekly rules** — **WEEKLY RULES** in the grid controls creates a
  whole horizon at once: a start date, 30/60/90/120/180 calendar days, the
  durations you pick, one percentage, optionally a subset of vehicle groups.
  It runs as a background job with a live progress bar and a cancel button,
  logs everything under one batch (so **REVERT ALL** undoes it), and then
  offers to run the competitor SCAN over exactly the days it just created.
- **Vehicle groups** — rules can target a subset of FMX's 39 vehicle groups
  instead of all of them. Cells whose rule covers only part of the fleet carry
  a small marker and name the covered groups in their tooltip.
- **User management** — Settings-level **USERS** view (admin only): create
  operators, change roles, enable/disable and delete, all scoped to the
  admin's own franchise.
- **Franchise management** — admins see their tenant; a superadmin can create
  new franchises together with the airports they use.
- **Report mails, per account** — every operator can switch the automatic
  scan / market-watch mails off for their own address without affecting
  anyone else.
- **Dark & light themes**, viewport-fit layout (a full month fits one screen).

## Architecture

```
server.js         Express server: session, SSE grid stream, rule writes, logs
lib/fmx.js        FuseMetrix client: login, HTML parsing, rule CRUD, caching
public/index.html Panel UI (no framework, no build step)
public/app.js     Grid, staging, streaming, chart, logs, theme
public/style.css  Dark/light themes, layout
```

### How the FMX integration works

FuseMetrix has no API — the panel drives the same PHP form endpoints the FMX
UI posts to, discovered by tracing the real UI's network traffic:

- **Read**: `weekly_rules.php?vehicle_override_location_id=<station>` lists
  rules; `weekly_rules_edit.php?ruleid=N` yields one rule's full field set.
- **Create**: `POST weekly_rules_edit.php` with `ruleid=0`. The target
  station comes from the **server-side PHP session** (whichever station list
  was opened last), so the client primes the station context before creating
  and serializes all writes through a queue.
- **Update**: same POST with `ruleid=N`.
- **Delete**: `weekly_rules.php?bulkdelete=true&recids=N`.
- **Verify**: after every write the rule is fetched again and compared field
  by field; mismatches are surfaced in the UI and the activity log.

Rule details are cached in `.cache-details.json` keyed by
`ruleid + Date Updated`, so a rule is only ever re-fetched after it actually
changed in FMX (including edits made directly in the FMX UI).

### Bulk weekly rules — the dates have to be exact

`POST /api/rules/bulk` takes `{station, startDate, days, durations, pct,
vehicleIds?, vendors?, skipExisting}` and returns a `{jobId}` immediately;
`GET /api/rules/bulk/:jobId` reports `{status, done, total, ok, fail, batch,
error}` and `POST /api/rules/bulk/:jobId/cancel` stops it. `days` counts
calendar days **including** the start date.

Both the server and the client's preview line walk the calendar the same
UTC-safe way, so what the modal promises and what gets written can never
diverge:

```js
const [y, m, d] = startDate.split('-').map(Number);
for (let n = 0; n < days; n++) {
  const t = new Date(Date.UTC(y, m - 1, d + n));   // the calendar resolves overflow
  const iso = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
```

`Date.UTC` handles month lengths and leap years itself, and reading the parts
back with `getUTC*` means no local timezone or DST transition can shift a date
by a day. The same round-trip is how `startDate` is validated: if the UTC
read-back doesn't match the input, the date doesn't exist (`2026-02-30`).

Vehicle groups come from `GET /api/vehicle-groups` → `[{id, code}]`, parsed
from the rule form's checkbox `value` + `rel` attributes (the `999999`
"select all" pseudo-entry is dropped). Rule writes accept an optional
`vehicleIds` array of those ids; empty or absent still means *all groups*, so
existing behaviour is unchanged.

### Users, franchises and report mails

`GET|POST /api/users`, `PATCH|DELETE /api/users/:uid`, `GET|POST /api/tenants`
and `PATCH /api/tenants/:id` are admin-only. The role is read **only** from
the server-signed session cookie — nothing in a request body can grant
privilege — and every operation is scoped to the caller's tenant. A caller
cannot demote, disable or delete themselves (`400 SELF_LOCKOUT`), and
passwords are never returned or logged. One seeded account carries a
`superadmin` flag: it may list every tenant's users, assign tenants freely and
create new franchises. A tenant that still has users cannot be deleted.

Mail preferences are per operator: the `prefs` record is keyed by uid
(`{ <uid>: { mailTo, reports } }`, migrated from the old flat `{mailTo}` on
boot) and `reports: false` drops just that address from the automatic-scan and
market-watch mails. With no opted-in recipients the mailer falls back to
`SMTP_TO`.


## Production

Live: **https://sentinelpricing.web.app** — the marketing page is the public
entry, `/console` is the operator console.

| Piece | Where it runs |
|---|---|
| Landing + entry gate | Firebase Hosting (`landing/`) |
| Console (UI + API) | Cloud Functions v2 / Cloud Run, `europe-west6`, exported from `index.js` |
| Durable state (activity log, restore points, watch baseline, FMX session) | Firestore (`state/*`, `backups/*`) |
| Caches (rule details, rentalcars responses) | `/tmp` on the instance, rebuilt after a cold start |
| Secrets (`AUTH_SECRET`, `SMTP_*`, `RELAY_SECRET`, `INTERNAL_SECRET`) | `.env` at deploy time → function env vars (never committed, never bundled). `RELAY_SECRET` must use only `A-Za-z0-9_-` — it is substituted verbatim into the downloadable relay installers |
| Heartbeat | Cloud Scheduler → `tick` function → `/api/internal/tick` every 4 min (FMX keep-alive, hourly market watch, keeps the instance warm) |

Auth: the app gate is **Firebase Auth** (Identity Platform, e-mail/password).
The client signs in, posts the ID token to `POST /api/auth/session`, and the
server verifies it with `firebase-admin` and issues the operator cookie — an
HMAC-signed token named `__session`, because Firebase Hosting forwards no other
cookie to a rewritten function. The payload carries `{u, uid, role, exp, g}`;
the role comes from the `role` custom claim, falling back to Firestore
`users/<uid>.role` and then to `staff`. Every `/api/*` call requires that
cookie (only `GET /api/session` and `POST /api/auth/session` are exempt), and
`req.operator = {u, uid, role}` is available to the routes; admin-only routes
answer 403 `FORBIDDEN`. The client refreshes the ID token every 50 minutes and
re-posts it, so the operator cookie never outlives the Firebase session.

`POST /api/login` is now the **second** step: it needs a valid operator cookie
and only binds the FuseMetrix session. It stays rate-limited per IP (8 failed
tries / 15 min). The console function is pinned to a single instance
(`maxInstances: 1`) because the FMX write queue, the relay job queue and the
rate limiter are in-memory by design.

FMX sessions are **single-device**: each successful `/api/login` bumps a
persisted session generation (`authGen`), and every cookie from an older generation gets 401
`SESSION_REPLACED` immediately — the old device shows a clear "signed in from
another device" message. Two consequences worth knowing: cookies issued before
this mechanism existed carry no generation, so after the first deploy every
operator sees that message exactly once (nobody actually signed in elsewhere);
and a second operator completing the FMX step kills the first one's cookie, so
both the FMX modal and `api()` re-mint the operator cookie from the live
Firebase session once before showing any error.

The marketing page at `/` (Firebase Hosting serves `landing/` at the site root)
has **no** sign-in of its own any more — it is a plain link to `/console`, and
the console's Firebase gate is the only entry check.

Stations are per **tenant**: the durable `tenants` record holds
`{name, fmxBase, stations:[{id, name, rc:{type, loc, label}}]}` for each
franchise, seeded on first boot from the previous hardcoded Zurich values. The
operator's tenant comes from `users/<uid>.tenant` (default `gmzurich`), and
`GET /api/stations` returns `{stations, durations, tenant, role}`. An admin
edits the list in Settings → STATIONS; the location picker proxies rentalcars'
`FTSAutocomplete.do` through `GET /api/places?q=` (direct fetch, or the relay
when the cloud IP is blocked — same path as `rcQuery`), mapping airports to
`{type:'IATA', loc:<iata>}` and everything else to
`{type:'LATLONG', loc:'<lat>,<lng>'}`. Saving via `PUT /api/stations` validates
the list, logs the change, and invalidates cached rentalcars entries for
removed or relocated stations.

Restore points are created through `GET /api/backup/stream` (SSE) with live
`meta`/`progress`/`done`/`fail` events, so the button shows real progress (e.g.
`120/415`); the `done` event reports how many rule details failed, and a lossy
restore point is flagged instead of looking clean. After grid APPLY, activity
REVERT or a RESTORE, the server-side rentalcars cache for the touched days is
invalidated and the dashboard RC MARKET RANK strip re-streams; while the relay
is offline, stale rank cells are dimmed/dashed. Returning to the tab
(focus/visibility) auto-refreshes logs older than 60 s and the grid/rank strip
older than 10 min — and surfaces the "signed in elsewhere" message if the
session was taken over meanwhile.

### rentalcars relay

rentalcars.com answers requests from datacenter IPs (Google Cloud included) with
HTTP 405, so the deployed console cannot query it directly. Instead it hands each
query to **relay workers** running on the operator's own machines — as many as
you like, macOS and Windows alike.

**Install (once per machine)** from Settings → SYSTEM → RELAY: download the
installer for your OS and run it —

```bash
bash ~/Downloads/install-gm-relay.sh        # macOS — paste into Terminal
```

On Windows the download is a double-clickable `install-gm-relay.bat` — no
terminal or PowerShell window needed; it extracts and runs its embedded
PowerShell payload itself.

The installer registers an auto-starting service (macOS: LaunchAgent
`com.gm.pricing-relay` with files in `~/GMPricingRelay/`; Windows: Scheduled
Task "GM Pricing Relay" with files in `%LOCALAPPDATA%\GMPricingRelay\`) that
starts at login, restarts on crashes, keeps running on battery, and only
reports OK after the relay's first successful poll. The downloaded installer
embeds `RELAY_SECRET`, so it deletes itself from Downloads on success — delete
it manually if the install fails. Several relays may be online at once; each
job goes to whichever polls first. Every relay identifies itself with
`x-relay-name` (its hostname): connected workers are listed in Settings and
the first names appear on the dashboard's RC RELAY row.

**Raw protocol**: the console hands each poller `{id, url, headers}`; the relay
fetches exactly that URL (host pinned to `www.rentalcars.com` — anything else
is refused as `BAD_URL`) over outbound HTTPS (no inbound ports), authenticated
with `RELAY_SECRET`, and posts back `{id, ok, status, body}` with the raw
response text. All parsing happens server-side — which is why the Windows
relay is pure PowerShell 5.1 with no Node dependency. Legacy relays posting
parsed `{id, ok, data}` results are still accepted. The PowerShell relay runs
one job at a time (the Node relay runs 4), so a Windows-only fleet walks the
month sweep more slowly — expected.

The repo relay still works for development:

```bash
npm run relay      # or just `npm start` — it auto-starts the relay when
                   # .secrets.json has a "relay": { "url", "secret" } block
```

Running `npm start` on a machine that also has the installed agent yields two
pollers with the same name — harmless.

While no relay is online the console serves the last cached market data marked
`STALE` (the topbar shows an `RC RELAY OFFLINE` chip) and explains what to do;
the FMX pricing grid is unaffected either way.

**Remove**: macOS — `launchctl bootout gui/$UID/com.gm.pricing-relay`, then
delete the plist and `~/GMPricingRelay/`. Windows —
`Unregister-ScheduledTask "GM Pricing Relay"`, then delete
`%LOCALAPPDATA%\GMPricingRelay\`.

**Rotate `RELAY_SECRET`**: set the new value in `.env` (charset `A-Za-z0-9_-`
only — it is embedded verbatim into the installer templates), redeploy the
function, then re-download and re-run the installer on every machine. Relays
still holding the old secret log the 60 s 401-backoff line until reinstalled.

**Rollout order**: deploy the function **before** restarting or reinstalling
any relay. A raw relay polling an old server receives jobs without `url` and
posts `{ok:false, error:'NO_URL'}`; the console then falls back to the stale
cache until the new server is live.

Deploy:

```bash
firebase deploy --only functions --project sentinelpricing
```

Local development still works unchanged (`npm start` → http://localhost:4646);
without the cloud env vars the same code falls back to JSON files in the repo.

## Setup

```bash
npm install
npm start          # http://localhost:4646
```

Sign in with your Firebase account first (the gate in front of the console),
then with your FMX account when the FuseMetrix modal appears. The FMX password
is held in memory only (used for login and automatic session renewal); only the
session cookie is persisted to `.session`.

Stations are **not** source constants any more — they live in the durable
`tenants` record (`.tenants.json` locally, Firestore in the cloud), seeded on
first boot with the two Zurich stations so nothing regresses:

```js
{ gmzurich: {
    name: 'Green Motion Zürich',
    fmxBase: 'https://zrh.dps.greenmotion.com',
    stations: [
      { id: 61489, name: 'Zurich Airport',
        rc: { type: 'IATA', loc: 'ZRH', label: 'Zurich Airport' } },
      { id: 61551, name: 'Zurich Downtown',
        rc: { type: 'LATLONG', loc: '47.37798309326172,8.539767265319824',
              label: 'Main Railway Station Zurich' } },
    ] } }
```

Edit them in Settings → **STATIONS** (admin only); the location picker searches
rentalcars through `GET /api/places?q=` and writes the list back with
`PUT /api/stations`. Operators live in Firebase Auth + Firestore `users/<uid>`
and are managed from the **USERS** view; whole franchises are managed from
Settings → **FRANCHISES** (creating one is superadmin-only). Durations stay in
`server.js`:

```js
const DURATIONS = [2, 3, 4, 5, 6];
```

## Notes & safety

- `.session`, `.logs.json` and `.cache-details.json` are local state and
  gitignored.
- Rules that don't fit the grid shape (date ranges, weekday filters, pickup
  time windows, non-percent changes) are never touched — they are listed
  under **OTHER RULES**.
- If two FMX rules target the same day+duration the cell locks as
  **CONFLICT** until resolved in FMX.
- FMX price changes propagate to brokers (rentalcars.com etc.) on their next
  XML rate query; the panel writes rules, FMX serves the rates.
