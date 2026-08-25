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
  vendor `ALL`, every vehicle group, full-day date window. Every write is
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

## Setup

```bash
npm install
npm start          # http://localhost:4646
```

Sign in with your FMX account on first load. The password is held in memory
only (used for login and automatic session renewal); only the session cookie
is persisted to `.session`.

Stations and durations are configured at the top of `server.js`:

```js
const STATIONS = [
  { id: 61489, name: 'Zurich Airport' },
  { id: 61551, name: 'Zurich Downtown' },
];
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
