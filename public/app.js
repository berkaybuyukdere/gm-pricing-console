/* GM Pricing Console — frontend */

// the longest column is open-ended (">= 14 days"); every shorter one is exact
const OPEN_DURATION = 14;
const MONTHS = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
const DOW = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

const state = {
  stations: [],
  durations: [],
  station: null,
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1, // 1-12
  grid: null,          // { year, month, daysInMonth }
  entry: null,         // current month-cache entry
  cellMap: new Map(),  // "day:dur" -> cell (points at entry.cells)
  conflictSet: new Set(),
  pendingByDay: new Map(), // day -> count of rules still resolving
  monthCache: new Map(),   // "station:year:month" -> {cells, conflictMap, others, totalRules, complete}
  staged: new Map(),   // "day:dur" -> { pct: number|null }  (null = delete)
  applying: false,
  session: false,      // DPS session (step 2)
  account: null,       // console account e-mail (Firebase, step 1)
  role: null,          // 'admin' | 'staff'
  superadmin: false,   // seeded owner: may cross tenant boundaries
  tenant: null,        // { id, name }
  vehicleGroups: [],   // [{id, code}] — DPS vehicle groups, loaded once per session
  reports: true,       // this operator receives auto-scan / market-watch mails
  view: 'dashboard',
  vendor: 'ALL',       // vendor code applied to writes
  vendors: [],
  pendingCopy: null,   // {targetKey, cells:[{day,dur,pct}], fromLabel}
};

const $ = (id) => document.getElementById(id);
const key = (day, dur) => `${day}:${dur}`;

// focus resync (P5): epoch ms of the last load per surface — stamped where
// each load actually runs, so paired focus+visibility events cannot double-run
let lastSync = { logs: 0, grid: 0, rank: 0 };

// ---------- i18n (EN / DE / TR) ----------
// Interface chrome only — DPS rule names, log payloads and technical codes
// stay untranslated on purpose. Keys map 1:1 to data-i18n attributes in the
// HTML plus the dynamic strings below. Missing keys fall back to English.

const I18N = {
  en: {
    nav_dashboard: 'DASHBOARD', nav_grid: 'PRICING GRID', nav_analytics: 'ANALYTICS',
    nav_activity: 'ACTIVITY', nav_settings: 'SETTINGS',
    open_fmx: 'OPEN DPS &nearr;',
    side_hint: 'Click a grid cell &rarr; both market views follow it. Double-click &rarr; set the %; the ranking preview updates live.',
    user_role: 'OPERATOR · DPS', not_signed_in: 'NOT SIGNED IN',
    rc_market_rank: 'RC MARKET RANK', price_curve: 'PRICE CURVE', restore_points: 'RESTORE POINTS',
    create: 'CREATE', no_backups: 'No restore points yet.', market_watch: 'MARKET WATCH',
    run_now: 'RUN NOW', test_mail: 'TEST MAIL', recent_activity: 'RECENT ACTIVITY', view_all: 'VIEW ALL',
    no_activity: 'No activity yet.', no_activity2: 'No activity yet.', open_grid_first: 'Open the grid to load data.',
    copy: 'COPY', top10_sweep: 'TOP-10 SWEEP', vendor: 'VENDOR',
    grid_empty: 'Connect your DPS session to load the pricing grid.',
    staged_changes: 'STAGED CHANGES', discard: 'DISCARD', apply_fmx: 'APPLY TO DPS',
    activity_log: 'ACTIVITY LOG', refresh: 'REFRESH',
    login_title: 'DPS LOGIN',
    login_text: 'Sign in with your <b>zrh.dps.greenmotion.com</b> account. The console opens its own DPS session and keeps it alive; your password is held in memory only and never written to disk.',
    username: 'USERNAME', password: 'PASSWORD', cancel: 'CANCEL', sign_in: 'SIGN IN',
    ok: 'CONFIRM', select_all: 'ALL',
    lane_bar: 'VEHICLE GROUPS', lane_all: 'ALL VEHICLES', lane_groups: '{n} GROUPS',
    bulk_horizon_ph: 'or: 45 / 2 weeks',
    scan_floor_note2: '{n} date(s) were corrected UP to the pricing floor: never more than {u}% or {chf} CHF under the cheapest competitor.',
    scan_failed_cells: '{n} date(s) could not be queried — run SCAN again to cover them.',
    scan_confirm_q: 'Run the competitor scan? {n} date/duration cell(s) will be queried and price proposals staged on the grid.',
    grid_purge_running: 'A station reset is still running — the numbers you see in DPS are it working through the list. The grid loads itself when it finishes (checking again in 20s).',
    conflict_cell_tip: 'Two rules cover the same vehicles here ({ids}). Click to fix: pick the rule that stays, the rest are deleted.',
    conflict_fix_q: 'Conflict on {d} — which rule should KEEP this cell?',
    conflict_all_q: '{n} conflicted cell(s) — one rule stays per cell, the rest are deleted. Which one stays?',
    conflict_all_old: 'KEEP THE OLDEST (recommended after a copy)',
    conflict_all_old_d: 'The cell\'s ORIGINAL rule stays; later duplicates (a COPY TO lands as the newest) are deleted.',
    conflict_all_new: 'KEEP THE NEWEST',
    conflict_all_new_d: 'The most recently created rule stays; the older ones are deleted.',
    conflict_all_confirm: '{n} rule(s) across {cells} cell(s) will be DELETED from DPS. Are you sure?',
    conflict_all_done: '{n} rule(s) deleted — the grid is re-syncing.',
    conflict_keep: 'KEEP #{id}',
    conflict_inactive: 'inactive',
    conflict_fix_confirm: 'Delete the other {n} rule(s) and keep #{id}?',
    conflict_fixed: 'Conflict fixed — {n} duplicate rule(s) deleted.',
    conflict_fix_fail: '{n} rule(s) could not be deleted — the cell reloads with the live state.',
    gt_live: 'LIVE', gt_staged: 'STAGED', gt_empty: 'NO RULE', gt_pct: 'PRICE RULE',
    gt_op: 'MATCH', gt_updated: 'UPDATED',
    gt_hint: 'click: edit · right-click: rentalcars',
    cap_busy: 'MARKET QUEUE FULL · {s}s',
    fleet_gm_absent: 'Green Motion is not listed for this date/duration — there is no price here to place or edit. Check availability in DPS.',
    pickup_fallback: '19:00 was empty — nearest hour with offers',
    querying_at: 'Querying rentalcars for {time} pickup…',
    proj_tag: '(projected)',
    currency_warn: 'PRICES IN {c} — NOT COMPARABLE',
    refresh_rc: 'REFRESH',
    hour_prev: 'Earlier pickup hour',
    hour_next: 'Later pickup hour (wraps at 19:00)',
    refreshing: 'REFRESHING…',
    pinned: 'pinned',
    cap_limit: 'QUERY LIMIT REACHED · {s}s',
    scan_capped: 'The console paced itself to protect the site — {n} date(s) waited for a free slot. Nothing was skipped.',
    presence_viewing: '{u} is viewing',
    grid_too_many: 'This station holds too many rules to display — run RESET to clean it up, then the grid will load.',
    fleet_floored: 'Held at the price floor — never more than 5% or 10 CHF under the cheapest competitor.',
    fleet_raised: 'Raise planned: the surplus cars move just above the top-10 line, the {k} cheapest stay in and keep competing.',
    fleet_exact_hard: 'GM prices sit too close together for exactly {k} — raised as far as the band allows; check the simulated ladder.',
    no_rc_station: 'This station has no rentalcars location yet — set one in Settings to enable market features.',
    reset_btn: 'RESET', copy_btn: 'COPY TO…',
    reset_confirm: 'Delete ALL console-written weekly rules at {s}? A restore point is taken first; hand-made DPS rules are not touched.',
    copy_pick_q: 'Copy the weekly rules to which station?',
    copy_confirm: 'Copy all console-written weekly rules from {from} to {to}? {to} is a LIVE station — these rules will price it on rentalcars immediately.',
    copy_no_target: 'No other station to copy to.',
    copy_none: 'No console-written weekly rules to copy.',
    copy_started: 'Copying {n} rule(s) to {s}…',
    copy_progress: 'COPYING', copy_done: 'Copy finished: {ok} ok, {fail} failed.',
    copy_failed: 'Copy failed: {code}',
    purge_title: 'RESET WEEKLY RULES', purge_btn: 'DELETE ALL',
    purge_ph: 'Type the station name to confirm',
    purge_hint: 'Deletes every console-written weekly rule at the selected station — one-day, percentage rules only. Rules you built by hand in DPS (date ranges, weekday or fixed-price rules) are left untouched. A restore point is taken first.',
    purge_ph_named: 'Type: {s}',
    purge_pick: 'Pick a station first.',
    purge_confirm_bad: 'Type the station name exactly: {s}',
    purge_confirm_q: 'Delete EVERY console-written weekly rule at {s}? A restore point is taken first, but this cannot be undone with one click.',
    purge_started: 'Deleting {n} rule(s) — a restore point was taken first.',
    purge_running: 'Taking a restore point…', purge_progress: 'DELETED', purge_backup: 'RESTORE POINT',
    purge_none: 'No console-written weekly rules at this station.',
    purge_done: 'Done: {ok} deleted, {fail} failed.',
    purge_failed: 'Reset failed: {code}',
    lane_switch_staged: 'You have unapplied changes in this vehicle group. Switching groups discards them. Continue?',
    scan_cat_pick_q: 'Which categories should SCAN price?',
    scan_cat_pick_note: 'One DPS rule scales every Green Motion car together, so chasing a category you do not really compete in drags the price down everywhere. Pick only the categories you actually sell.',
    scan_cat_gm: '{n} Green Motion cars · cheapest {p}',
    scan_cat_none: 'Green Motion has no car listed in any category for this date.',
    scan_floor_note: '{n} date(s) were held back by the margin floor: matching the weakest category would have put another one more than {u}% under its rank-{r} competitor.',
    scan_throttled: 'The server was busy on {n} date(s) — each one was retried and none were skipped.',
    scan_cat_scoped: 'Priced against {c} — the categories this vehicle group sells in.',
    scan_overloaded: 'Stopped at {done} of {total}: the server kept refusing requests. Everything priced so far is staged and safe to apply — run SCAN again in a minute to finish the rest.',
    open_rc: 'OPEN ON RENTALCARS', target_rank: 'TARGET RANK', durations: 'DURATIONS',
    sweep_hint: 'Max 6-day rentals — every searchable day of this month.',
    set_account: 'ACCOUNT', set_appearance: 'APPEARANCE', set_theme: 'THEME',
    set_language: 'LANGUAGE', set_system: 'SYSTEM',
    set_hud_hint: 'HUD scale resizes the whole console — 100% fits a full month on one screen.',
    set_lang_hint: 'Interface language only — rule names, logs and DPS data stay as they are.',
    reconnect: 'RECONNECT', logout: 'SIGN OUT',
    th_dark: 'DARK', th_light: 'LIGHT',
    acc_fmx_session: 'DPS SESSION', acc_active: 'ACTIVE', acc_none: 'NOT CONNECTED',
    acc_tenant: 'TENANT', acc_stations: 'STATIONS',
    sys_env: 'ENVIRONMENT', sys_env_cloud: 'CLOUD (Firebase)', sys_env_local: 'LOCAL',
    sys_relay: 'RC RELAY', sys_relay_on: 'ONLINE', sys_relay_off: 'OFFLINE — install it from Settings on any of your computers',
    sys_mail: 'ALERT MAIL', sys_baseline: 'WATCH BASELINE', sys_days: 'day-snapshots',
    tile_rank_today: 'GM RANK TODAY', tile_market1: 'MARKET #1 TODAY', tile_watch: 'MARKET WATCH',
    tile_restore: 'RESTORE POINTS', of_offers: 'of {n} offers', no_data_yet: 'no data yet',
    alerts_sent: 'alerts sent', baseline_w: 'baseline', last_w: 'last', none_yet: 'none yet',
    active_w: 'ACTIVE', off_w: 'OFF',
    w_status: 'STATUS', w_not_conf: 'MAIL NOT CONFIGURED', w_sweep: 'SWEEP',
    w_every: 'every {m} min · next {d} days · {dur}D',
    w_triggers: 'TRIGGERS', w_triggers_v: '&plusmn;{p}% price · {r}+ rank moves · new #1',
    w_baseline: 'BASELINE', w_lastsweep: 'LAST SWEEP', w_alerts: 'ALERTS SENT', w_mailto: 'MAIL TO',
    w_relay: 'RC RELAY',
    querying: 'QUERYING RENTALCARS…', pick_duration: 'Pick a duration.',
    no_offers: 'No offers returned for these dates.',
    rc_past: 'This pickup date has already passed — rentalcars only quotes future pickups.',
    rc_err_offline: 'rentalcars refuses queries from cloud servers and no relay machine is online. Install the relay once from <b>Settings</b> on any computer you use (it auto-starts from then on) — or right-click the grid cell to open rentalcars directly.',
    rc_err_timeout: 'The local relay did not answer in time — check that it is still running, then retry.',
    rc_err_rejected: 'rentalcars rejected the query ({code}) — retry in a moment or right-click the grid cell to open rentalcars directly.',
    rc_err_generic: 'Query failed: {code} — right-click the grid cell to open rentalcars directly.',
    rc_hint_click: "Click a competitor row — or drag the Green Motion row onto one — to take that position. You can also click Green Motion's own price to type a target price directly; the DPS rule change is computed automatically.",
    rc_session_note: 'Prices are what a fresh anonymous visitor sees for this exact pickup time. rentalcars targets campaign discounts (e.g. −12%) per session — a browser with old cookies may see the undiscounted price. To compare 1:1, use a private window and the OPEN ON RENTALCARS button (it carries the same pickup time).',
    rc_price_click: 'Click to type a target price',
    rc_price_prompt: 'Target price in {ccy} — rank and the required DPS % are computed from it:',
    rc_price_bad: 'Invalid price.',
    dur_pct_hint: 'click the % to type a new value and preview the ranking live',
    rc_dur_pct_prompt: 'New % for {dur} on this pickup day — live preview until you CONFIRM:',
    proj_bar: 'LIVE PROJECTION · rule {dur}: {cur}% &rarr; <b>{new}%</b> — competitors are live, GM prices computed from the base. Cheapest GM <b>{p1} {ccy}</b>.',
    proj_applied: 'APPLIED &#10003; — this IS the current ranking: competitors live, GM at the applied price. rentalcars.com shows it on the site once its own quote cache refreshes (minutes).',
    stale_cache: 'STALE CACHE (relay offline)', cached: 'CACHED', offers: 'OFFERS', pickup: 'PICKUP',
    gm_rank: 'GM RANK', gm_not_listed: 'GM NOT LISTED',
    fleet_label: 'GM CARS IN TOP 10', fleet_now: 'now {n}',
    fleet_bar: '<b>{k} GM cars</b> in the top 10 · DPS rule {dur}D: {cur}% &rarr; <b>{new}%</b> · cheapest GM {p0} &rarr; <b>{p1} {ccy}</b>',
    fleet_already: 'Already done — {k} Green Motion cars are in the top 10 at the current price.',
    fleet_no_data: 'Fleet data not in this cached result — press a duration button to re-query, then try again.',
    fleet_not_enough: 'Only {n} Green Motion car(s) are listed for these dates.',
    confirm_fmx: 'CONFIRM &rarr; DPS', reset: 'RESET', drag_hint: '&#8597; DRAG', simulated: 'SIMULATED POSITION', target_tag: 'TARGET',
    t_connected: 'DPS session connected.', t_reverted: 'Reverted.',
    t_load_grid_first: 'Load the grid first.',
    days: 'DAYS',
    rank_strip_empty: "Green Motion's daily rentalcars rank loads here for the current month.",
    rank_legend: 'click a day for the full top-10 · pickup 19:00 · cached 6h',
    rank_no_days: 'No searchable days in this month (past dates cannot be queried).',
    session_replaced: 'Signed in from another device — this session has ended. Sign in again to take over.',
    backup_running: 'CREATING… {done}/{total}',
    backup_done: 'Restore point created.',
    backup_done_failed: 'Restore point created — {failed} rule(s) could not be read and are missing from it.',
    relay_chip_off: 'RC RELAY OFFLINE',
    rank_stale_note: 'stale — relay offline',
    query_at: 'QUERIED {time}',
    discount_hint: "CUSTOMER is what a fresh visitor pays on rentalcars (their targeted campaign applied) — LIST is the base rate without it. Sessions outside the campaign see the LIST side.",
    rc_col_list: 'LIST',
    rc_col_customer: 'CUSTOMER',
    rc_col_gear: 'GEAR',
    rc_col_fuel: 'FUEL',
    sel_cells: '{n} CELLS',
    sel_hint: 'Enter apply · Esc cancel',
    sel_staged: '{n} cells staged at {pct} — APPLY TO DPS writes them',
    rc_before_title: 'NOW — BEFORE THE CHANGE (as rentalcars serves it)',
    rc_after_title: 'PROJECTED — AFTER THE CHANGE',
    sim_apply_hint: 'APPLY TO DPS (bottom right) writes this',
    rc_live_open: 'rentalcars → {d}.{dur}D · {h}:00',
    rc_live_real: 'Open the real rentalcars page (same search, same hour)',
    rules_del_btn: 'DELETE RULES',
    rules_delete_sel: 'DELETE SELECTED',
    rules_loading: 'Loading the rule list…',
    rules_selected: '{n} of {total} selected — shift-click for a range, Delete removes',
    rules_confirm: '{n} rule(s) will be DELETED from DPS. Are you sure?',
    rules_deleted: '{n} rule(s) deleted — the grid is re-syncing.',
    rules_too_many: 'More than 500 rules selected — narrow the range.',
    sel_scan: 'CHECK RANKS',
    sel_price: 'PRICE THIS AREA',
    scan_busy: 'Another pricing operation is already running — wait for it to finish.',
    sel_price_confirm: 'Re-price {n} rule(s) in {range} against the live competitor field? Proposals are staged in orange — nothing is written until APPLY TO DPS.',
    sel_scanning: 'Scanning {n} selected cell(s) live…',
    sel_scanned: '{n} cell(s) scanned — {bad} sent to multi-hour confirmation.',
    sel_scan_cap: 'Selection capped at 40 cells per scan.',
    sel_scan_unruled: 'No weekly rules in the selection — nothing to check.',
    suspect_reason: 'Outside the top 10 at {bad} of {total} hours (ranks {ranks})',
    relay_card_title: 'RC RELAY MACHINES',
    relay_workers: 'CONNECTED WORKERS',
    relay_none: 'No relay machines connected.',
    relay_ago: '{t} ago',
    relay_install_hint: 'Install once per computer — the relay auto-starts at login and restarts after crashes. Several machines can be online at once; whichever is on serves the queries. After downloading, run the command below (Windows: paste it into a PowerShell window).',
    relay_dl_failed: 'Installer download failed: {code}',
    relay_win_dblclick: 'double-click the downloaded install-gm-relay.bat — no terminal needed',
    // Firebase sign-in gate (step 1) + roles + tenant stations
    auth_title: 'CONSOLE SIGN-IN',
    auth_text: 'Sign in with your console account. Access, roles and stations are managed centrally — this is not your DPS login.',
    auth_email: 'E-MAIL', auth_pass: 'PASSWORD', auth_signin: 'SIGN IN',
    auth_signing_in: 'SIGNING IN…',
    auth_missing: 'Enter both e-mail and password.',
    auth_wrong: 'Wrong e-mail or password.',
    auth_failed: 'Sign-in failed: {code}',
    auth_expired: 'Your console session expired — sign in again.',
    auth_sdk_failed: 'Sign-in service unavailable — reload the page.',
    auth_step2_hint: 'After this step the console asks for your DPS login — that is a second, separate session.',
    role_admin: 'ADMIN', role_staff: 'STAFF', acc_role: 'ROLE',
    set_stations: 'STATIONS',
    st_add: '+ ADD', st_remove: 'REMOVE',
    st_id: 'DPS ID', st_name_ph: 'Station name',
    st_pick_ph: 'Search an airport, city or address…',
    st_no_loc: 'no rentalcars location', st_none: 'No stations configured for this tenant.',
    st_searching: 'Searching…', st_no_results: 'No location found.',
    st_type_more: 'Type at least 2 characters.',
    st_saved: 'Stations saved.',
    st_save_failed: 'Stations could not be saved: {code}',
    st_remove_confirm: 'Remove station {name} from this tenant?',
    st_bad_id: 'Every station needs a positive DPS id.',
    st_bad_name: 'Every station needs a name (1-60 characters).',
    st_bad_rc: 'Pick a rentalcars location for every station.',
    st_hint_admin: 'These stations drive the pricing grid and every rentalcars query. The location picker searches rentalcars directly — airports are marked with an aeroplane.',
    st_hint_staff: 'Read-only: only an admin can change the tenant\'s stations.',
    set_mail: 'ALERT MAIL', save: 'SAVE',
    set_mail_hint: 'Market-watch alerts and test mails go to this address. Leave empty and save to fall back to the system default.',
    mail_current: 'ACTIVE RECIPIENT', mail_default: 'SYSTEM DEFAULT', mail_saved: 'Alert mail recipient saved.',
    price_curve2: 'PRICE CURVE', open_grid_first2: 'Open the grid to load data.', duration_avgs: 'DURATION AVERAGES',
    insights_title: 'INSIGHTS & COMMENTARY',
    insights_empty: 'Load the grid and the market rank strip — the commentary builds itself from that data.',
    signout_confirm: 'Sign out of the console on this device?',
    more_w: 'more', less_w: 'less',
    ins_avg: 'This month carries <b>{cells}</b> priced cells averaging <b>{avg}%</b>. By duration the range runs from <b>{min}%</b> ({minDur}) to <b>{max}%</b> ({maxDur}).',
    ins_deep: 'The single deepest cut is <b>{pct}%</b> on <b>{day} · {dur}</b> — check that this day really needs to be the cheapest.',
    ins_weekend: 'Weekend pickups average <b>{wk}%</b> vs <b>{wd}%</b> on weekdays — weekends are priced {rel} aggressively.',
    ins_cover: '<b>{n}</b> future day(s) still have no rule: those pickups sell at base price. The warning chip on the grid lists them.',
    ins_cover_ok: 'Every future day of the month is covered by at least one rule.',
    ins_rank: 'On the rank strip Green Motion is <b>#1 on {top1}</b> of {days} tracked days (average rank <b>#{avg}</b>, worst <b>#{worst}</b> on day {worstDay}).',
    ins_rank_bad: '{n} day(s) sit at rank 8 or worse — natural first candidates for a TOP-10 SWEEP or a fleet placement from the day\'s modal.',
    ins_inactive: '<b>{n}</b> rule(s) in this month are inactive — they show in the grid but do not price.',
    scan_btn: 'SCAN',
    scan_tip: 'Crowd 4 Green Motion cars into the top 10 for every searchable day of this month — proposals stage in orange, nothing is written until APPLY TO DPS.',
    scan_running: 'SCANNING {done}/{total}',
    scan_done: '{n} scan proposal(s) staged — review the orange cells, then APPLY TO DPS.',
    scan_mode_q: 'How should SCAN price this month?',
    scan_mode_overall: 'Overall ranking',
    scan_mode_overall_d: 'Plain rentalcars search, no categories — get several Green Motion cars into the overall top 10.',
    scan_mode_cat: 'Every category',
    scan_mode_cat_d: 'Push Green Motion into the top 3 of EVERY category it competes in (economy, compact, mid-size, SUV…), on every date.',
    scan_mode_pick: 'Pick a category',
    scan_mode_pick_d: 'Price ONE vehicle-group set. The list is read from the weekly rules that exist in DPS, so it only offers categories you actually created.',
    scan_pick_q: 'Which vehicle group should SCAN price?',
    scan_pick_none: 'No weekly rules in this month yet — create them first, then SCAN can price them.',
    scan_pick_cells: '{n} priced cells · {g}',
    scan_pick_cats: 'competitor analysis: {c}',
    scan_pick_cats_all: 'competitor analysis: every category',
    scan_done_cat: '{n} category-based proposal(s) staged — review the orange cells, then APPLY.',
    scan_none: 'Scan finished — nothing to lower: the top 10 is already as crowded as it can get.',
    batch_autoscan_label: 'AUTO-SCAN · {n} CHANGES',
    batch_scan_label: 'SCAN SWEEP · {n} CHANGES',
    revert_batch_confirm: 'Revert all {n} change(s) of this scan sweep in DPS?',
    revert_batch_done: 'Batch revert finished: {ok} ok, {fail} failed.',
    cat_all: 'ALL', cat_economy: 'ECONOMY', cat_compact: 'COMPACT',
    cat_midsize: 'MID-SIZE', cat_large: 'LARGE', cat_wagon: 'STATION WAGON',
    cat_suv: 'SUV', cat_minivan: 'MINIVAN',
    rank_in_cat: 'Green Motion rank within {cat}',
    discard_confirm: 'Discard {n} staged change(s)? This cannot be undone.',
    sweep_cancel_confirm: 'Stop the running top-10 sweep? Changes already written stay applied.',
    scan_cancel_confirm: 'Stop the running scan? Proposals staged so far are kept.',
    rc_close_confirm: 'Close and lose the un-applied placement? It has not been written to DPS.',
    cancelled: 'Cancelled.',
    cmp_title: 'BEFORE / AFTER — APPLIED SCAN PROPOSALS',
    cmp_summary: '{cells} day/duration cell(s) written · average move {avg}%',
    cmp_cat: 'CATEGORY', cmp_before: 'BEFORE (avg. rank)', cmp_after: 'AFTER (avg. rank)',
    cmp_improve: 'IMPROVEMENT',
    cmp_gain: '▲ {n} place(s)',
    cmp_no_change: 'No category ladder moved — the applied percentages were too small to change a rank.',
    cmp_mail_btn: 'MAIL THE REPORT',
    cmp_mailed: 'Report e-mailed.',
    cmp_mail_failed: 'Report mail failed: {msg}',
    cmp_close: 'CLOSE',
    w_autoscan: 'AUTO-SCAN', w_as_lastrun: 'LAST AUTO-SCAN', w_as_pending: 'PENDING PROPOSALS',
    w_as_missing: 'GM NOT LISTED', w_as_horizon: 'SCAN HORIZON', w_as_days: '{n} DAYS',
    autoscan_off: 'OFF',
    autoscan_apply: 'APPLY {n} PROPOSAL(S)',
    autoscan_confirm: 'Apply the {n} pending auto-scan proposal(s) to DPS?',
    autoscan_done: 'Auto-scan proposals applied: {ok} ok, {fail} failed.',
    autoscan_running: 'Writing {n} proposal(s) to DPS — this can take a few minutes.',
    autoscan_failed: 'Auto-scan apply failed: {msg}',
    // ---- Sprint 7: users, franchises, vehicle groups, bulk weekly rules ----
    nav_users: 'USERS', users_title: 'CONSOLE USERS',
    usr_col_user: 'USER', usr_col_role: 'ROLE', usr_col_status: 'STATUS', usr_col_last: 'LAST SIGN-IN',
    usr_enabled: 'ENABLED', usr_disabled: 'DISABLED', usr_never: 'never', usr_you: 'YOU',
    usr_none: 'No users in this franchise yet.',
    usr_make_admin: 'MAKE ADMIN', usr_make_staff: 'MAKE STAFF',
    usr_disable: 'DISABLE', usr_enable: 'ENABLE', usr_delete: 'DELETE',
    usr_role_confirm: 'Change {email} to {role}?',
    usr_disable_confirm: 'Disable {email}? This account can no longer sign in.',
    usr_enable_confirm: 'Re-enable {email}?',
    usr_delete_confirm: 'Delete {email} permanently? The console account is removed for good.',
    usr_saved: 'User updated.', usr_deleted: 'User deleted.',
    usr_save_failed: 'User update failed: {code}',
    usr_load_failed: 'Users could not be loaded: {code}',
    usr_create: 'CREATE USER', usr_create_btn: 'CREATE USER',
    usr_created: 'User {email} created.',
    usr_create_failed: 'User could not be created: {code}',
    usr_bad_email: 'Enter a valid e-mail address.',
    usr_bad_pass: 'The password needs at least 8 characters.',
    usr_hint: 'Passwords are set once here and never shown again — the new operator changes it from their own account.',
    usr_hint_super: 'Superadmin: every franchise is listed and a user may be moved to another tenant.',
    usr_tenant: 'FRANCHISE', usr_self_lockout: 'You cannot demote or disable your own account.',
    set_franchises: 'FRANCHISES', fr_new: '+ NEW',
    fr_none: 'No franchises visible for this account.',
    fr_stations_n: '{n} station(s)', fr_users_n: '{n} user(s)',
    fr_create_btn: 'CREATE FRANCHISE',
    fr_created: 'Franchise {id} created.',
    fr_create_failed: 'Franchise could not be created: {code}',
    fr_bad_id: 'The franchise id must be 2-32 characters of a-z, 0-9 or a dash.',
    fr_bad_name: 'Give the franchise a name (1-60 characters).',
    fr_bad_base: 'The DPS base must be an https:// URL.',
    fr_bad_stations: 'Add at least one airport/location, each with a positive DPS id and a name.',
    fr_hint_super: 'A franchise is created together with the airport(s) it uses — search the location, then give that station its DPS id.',
    fr_hint_admin: 'Only a superadmin creates franchises. You may rename your own.',
    fr_rename: 'RENAME', fr_rename_prompt: 'New name for {id}:',
    fr_saved: 'Franchise saved.', fr_save_failed: 'Franchise could not be saved: {code}',
    fr_load_failed: 'Franchises could not be loaded: {code}',
    set_reports: 'REPORT MAILS',
    set_reports_hint: 'Turning report mails off only stops auto-scan and market-watch mails to <b>this</b> account — other operators keep receiving them.',
    reports_saved: 'Report-mail preference saved.',
    vg_all: 'ALL GROUPS', vg_all_btn: 'ALL', vg_none_btn: 'NONE',
    vg_save_btn: 'SAVE SET', vg_save_ph: 'Set name (e.g. Economy fleet)',
    vg_saved: 'Set "{name}" saved.', vg_del_confirm: 'Delete the set "{name}"?',
    vg_pick_first: 'Pick at least one vehicle group first.',
    vg_name_first: 'Give the set a name first.',
    vg_presets_hint: 'Saved sets — click one to select exactly those groups.',
    vg_selected: '{n}/{total} selected',
    vg_loading: 'Loading vehicle groups…',
    vg_unavailable: 'Vehicle groups need a live DPS session — leave this empty to target every group.',
    vg_groups: 'groups',
    bulk_btn: 'WEEKLY RULES', bulk_title: 'WEEKLY RULES',
    bulk_start: 'START DATE',
    bulk_end: 'END DATE',
    bulk_range_bad: 'End date is before the start date.',
    bulk_range_long: 'That range is too long — pick at most 400 days.',
    bulk_horizon: 'HORIZON', bulk_pct: 'PERCENT',
    bulk_groups: 'VEHICLE GROUPS', bulk_skip: 'SKIP EXISTING',
    bulk_apply: 'APPLY', bulk_cancel: 'CANCEL RUN',
    bulk_preview: 'Creates up to <b>{n}</b> rules — {from} &rarr; {to}',
    bulk_preview_bad: 'Pick a start date, at least one duration and a percentage.',
    bulk_confirm: 'Create up to {n} rule(s) at {pct}% for {station} — {from} to {to} · {groups}?',
    bulk_running: 'CREATING {done}/{total} · {ok} ok · {fail} failed',
    bulk_done: 'Weekly rules created: {ok} ok, {fail} failed.',
    bulk_skipped_cov: '{n} cell(s) skipped: the existing rule has different group coverage.',
    bulk_failed: 'Bulk creation failed: {code}',
    bulk_cancel_confirm: 'Stop the running bulk creation? Rules already written stay in DPS.',
    bulk_cancelled: 'Bulk creation cancelled.',
    bulk_bad_date: 'Pick a real start date no more than 24 months out.',
    bulk_bad_pct: 'Enter a percentage between -95 and 100.',
    bulk_bad_durs: 'Pick at least one duration.',
    batch_bulk_label: 'WEEKLY RULES · {n} CREATED',
    bulk_fu_q: 'The rules are in DPS. How should they be priced?',
    bulk_fu_manual: 'MANUEL', bulk_fu_manual_d: 'Close here — you price the new rules by hand in the grid.',
    bulk_fu_scan: 'RAKİP ANALİZİ',
    bulk_fu_scan_d: 'Run the category SCAN over exactly these days and durations, then review the orange proposals and APPLY.',
    bulk_fu_scope: 'The scan covers the {n} day(s) of this batch inside {month} — proposals stage one month at a time.',
    bulk_fu_none: 'None of the new days fall inside the month on screen — open that month and run SCAN there.',
  },
  de: {
    nav_dashboard: 'DASHBOARD', nav_grid: 'PREISRASTER', nav_analytics: 'ANALYTIK',
    nav_activity: 'AKTIVITÄT', nav_settings: 'EINSTELLUNGEN',
    open_fmx: 'DPS ÖFFNEN &nearr;',
    side_hint: 'Klick auf eine Rasterzelle &rarr; beide Marktansichten folgen. Doppelklick &rarr; % setzen; die Rangvorschau folgt live.',
    user_role: 'OPERATOR · DPS', not_signed_in: 'NICHT ANGEMELDET',
    rc_market_rank: 'RC-MARKTRANG', price_curve: 'PREISKURVE', restore_points: 'WIEDERHERSTELLUNGSPUNKTE',
    create: 'ERSTELLEN', no_backups: 'Noch keine Wiederherstellungspunkte.', market_watch: 'MARKTÜBERWACHUNG',
    run_now: 'JETZT PRÜFEN', test_mail: 'TEST-MAIL', recent_activity: 'LETZTE AKTIVITÄT', view_all: 'ALLE ANSEHEN',
    no_activity: 'Noch keine Aktivität.', no_activity2: 'Noch keine Aktivität.', open_grid_first: 'Raster öffnen, um Daten zu laden.',
    copy: 'KOPIEREN', top10_sweep: 'TOP-10-SWEEP', vendor: 'KANAL',
    grid_empty: 'DPS-Sitzung verbinden, um das Preisraster zu laden.',
    staged_changes: 'VORGEMERKTE ÄNDERUNGEN', discard: 'VERWERFEN', apply_fmx: 'AN DPS SENDEN',
    activity_log: 'AKTIVITÄTSPROTOKOLL', refresh: 'AKTUALISIEREN',
    login_title: 'DPS-ANMELDUNG',
    login_text: 'Mit dem <b>zrh.dps.greenmotion.com</b>-Konto anmelden. Die Konsole öffnet ihre eigene DPS-Sitzung und hält sie aktiv; das Passwort bleibt nur im Speicher und wird nie auf die Festplatte geschrieben.',
    username: 'BENUTZERNAME', password: 'PASSWORT', cancel: 'ABBRECHEN', sign_in: 'ANMELDEN',
    ok: 'BESTÄTIGEN', select_all: 'ALLE',
    lane_bar: 'FAHRZEUGGRUPPEN', lane_all: 'ALLE FAHRZEUGE', lane_groups: '{n} GRUPPEN',
    bulk_horizon_ph: 'oder: 45 / 2 Wochen',
    scan_floor_note2: '{n} Datum/Daten wurden auf die Preisuntergrenze KORRIGIERT: nie mehr als {u}% oder {chf} CHF unter dem günstigsten Wettbewerber.',
    scan_failed_cells: '{n} Datum/Daten konnten nicht abgefragt werden — SCAN erneut ausführen.',
    scan_confirm_q: 'Konkurrenz-Scan starten? {n} Datum/Dauer-Zellen werden abgefragt und Preisvorschläge im Grid vorgemerkt.',
    grid_purge_running: 'Ein Stations-Reset läuft noch — das Grid lädt sich selbst, sobald er fertig ist (nächster Versuch in 20s).',
    conflict_cell_tip: 'Zwei Regeln decken hier dieselben Fahrzeuge ab ({ids}). Klicken zum Beheben: eine Regel bleibt, der Rest wird gelöscht.',
    conflict_fix_q: 'Konflikt am {d} — welche Regel soll die Zelle BEHALTEN?',
    conflict_all_q: '{n} Zellen mit Konflikt — pro Zelle bleibt EINE Regel, der Rest wird gelöscht. Welche bleibt?',
    conflict_all_old: 'DIE ÄLTESTE BEHALTEN (nach einem Copy empfohlen)',
    conflict_all_old_d: 'Die URSPRÜNGLICHE Regel der Zelle bleibt; spätere Duplikate (ein COPY TO landet als neueste) werden gelöscht.',
    conflict_all_new: 'DIE NEUESTE BEHALTEN',
    conflict_all_new_d: 'Die zuletzt erstellte Regel bleibt; die älteren werden gelöscht.',
    conflict_all_confirm: '{n} Regel(n) in {cells} Zelle(n) werden aus DPS GELÖSCHT. Sicher?',
    conflict_all_done: '{n} Regel(n) gelöscht — das Raster synchronisiert sich neu.',
    conflict_keep: '#{id} BEHALTEN',
    conflict_inactive: 'inaktiv',
    conflict_fix_confirm: 'Die anderen {n} Regel(n) löschen und #{id} behalten?',
    conflict_fixed: 'Konflikt behoben — {n} doppelte Regel(n) gelöscht.',
    conflict_fix_fail: '{n} Regel(n) konnten nicht gelöscht werden — die Zelle lädt den Live-Stand.',
    gt_live: 'LIVE', gt_staged: 'VORGEMERKT', gt_empty: 'KEINE REGEL', gt_pct: 'PREISREGEL',
    gt_op: 'BEDINGUNG', gt_updated: 'AKTUALISIERT',
    gt_hint: 'Klick: bearbeiten · Rechtsklick: rentalcars',
    cap_busy: 'MARKT-WARTESCHLANGE VOLL · {s}s',
    fleet_gm_absent: 'Green Motion ist für dieses Datum/diese Dauer nicht gelistet — hier gibt es keinen Preis zum Platzieren oder Bearbeiten. Verfügbarkeit in DPS prüfen.',
    pickup_fallback: '19:00 war leer — nächste Stunde mit Angeboten',
    querying_at: 'rentalcars wird für Abholung {time} abgefragt…',
    proj_tag: '(projiziert)',
    currency_warn: 'PREISE IN {c} — NICHT VERGLEICHBAR',
    refresh_rc: 'AKTUALISIEREN',
    hour_prev: 'Frühere Abholzeit',
    hour_next: 'Spätere Abholzeit (springt bei 19:00 zurück)',
    refreshing: 'WIRD AKTUALISIERT…',
    pinned: 'fixiert',
    cap_limit: 'ABFRAGELIMIT ERREICHT · {s}s',
    scan_capped: 'Die Konsole hat sich selbst gedrosselt — {n} Datum/Daten warteten auf einen freien Slot. Nichts wurde übersprungen.',
    presence_viewing: '{u} sieht sich das an',
    grid_too_many: 'Diese Station hält zu viele Regeln zum Anzeigen — RESET ausführen, danach lädt das Grid.',
    fleet_floored: 'An der Preisuntergrenze gehalten — nie mehr als 5% oder 10 CHF unter dem günstigsten Wettbewerber.',
    fleet_raised: 'Erhöhung geplant: die überzähligen Autos rücken knapp über die Top-10-Linie, die {k} günstigsten bleiben drin.',
    fleet_exact_hard: 'GM-Preise liegen zu dicht beieinander für genau {k} — so weit erhöht, wie das Band erlaubt; simulierte Liste prüfen.',
    no_rc_station: 'Diese Station hat noch keinen rentalcars-Standort — in den Einstellungen setzen, um Marktfunktionen zu aktivieren.',
    reset_btn: 'ZURÜCKSETZEN', copy_btn: 'KOPIEREN NACH…',
    reset_confirm: 'ALLE von der Konsole geschriebenen Wochenregeln bei {s} löschen? Ein Wiederherstellungspunkt wird vorher erstellt; handgemachte DPS-Regeln bleiben unberührt.',
    copy_pick_q: 'Wochenregeln zu welcher Station kopieren?',
    copy_confirm: 'Alle Konsolen-Wochenregeln von {from} nach {to} kopieren? {to} ist eine LIVE-Station — diese Regeln bepreisen sie sofort auf rentalcars.',
    copy_no_target: 'Keine andere Station zum Kopieren.',
    copy_none: 'Keine Konsolen-Wochenregeln zum Kopieren.',
    copy_started: '{n} Regel(n) werden nach {s} kopiert…',
    copy_progress: 'KOPIEREN', copy_done: 'Kopieren fertig: {ok} ok, {fail} fehlgeschlagen.',
    copy_failed: 'Kopieren fehlgeschlagen: {code}',
    purge_title: 'WOCHENREGELN ZURÜCKSETZEN', purge_btn: 'ALLE LÖSCHEN',
    purge_ph: 'Stationsnamen zur Bestätigung eingeben',
    purge_hint: 'Löscht alle von der Konsole geschriebenen Wochenregeln der gewählten Station — nur Ein-Tages-Prozentregeln. Von Hand in DPS gebaute Regeln (Datumsbereiche, Wochentags- oder Festpreisregeln) bleiben unberührt. Vorher wird ein Wiederherstellungspunkt erstellt.',
    purge_ph_named: 'Eingeben: {s}',
    purge_pick: 'Zuerst eine Station wählen.',
    purge_confirm_bad: 'Stationsnamen exakt eingeben: {s}',
    purge_confirm_q: 'ALLE von der Konsole geschriebenen Wochenregeln bei {s} löschen? Ein Wiederherstellungspunkt wird vorher erstellt, rückgängig geht es aber nicht per Klick.',
    purge_started: '{n} Regel(n) werden gelöscht — Wiederherstellungspunkt wurde erstellt.',
    purge_running: 'Wiederherstellungspunkt wird erstellt…', purge_progress: 'GELÖSCHT', purge_backup: 'WIEDERHERSTELLUNGSPUNKT',
    purge_none: 'Keine von der Konsole geschriebenen Wochenregeln an dieser Station.',
    purge_done: 'Fertig: {ok} gelöscht, {fail} fehlgeschlagen.',
    purge_failed: 'Zurücksetzen fehlgeschlagen: {code}',
    lane_switch_staged: 'In dieser Fahrzeuggruppe gibt es nicht angewandte Änderungen. Beim Wechsel gehen sie verloren. Fortfahren?',
    scan_cat_pick_q: 'Welche Kategorien soll SCAN bepreisen?',
    scan_cat_pick_note: 'Eine DPS-Regel skaliert alle Green-Motion-Fahrzeuge gemeinsam. Eine Kategorie zu verfolgen, in der man gar nicht wirklich antritt, drückt den Preis überall. Nur die Kategorien wählen, die wirklich verkauft werden.',
    scan_cat_gm: '{n} Green-Motion-Fahrzeuge · günstigstes {p}',
    scan_cat_none: 'Für dieses Datum ist kein Green-Motion-Fahrzeug in einer Kategorie gelistet.',
    scan_floor_note: '{n} Datum/Daten wurden von der Margenuntergrenze gehalten: die schwächste Kategorie zu erreichen hätte eine andere mehr als {u}% unter ihren Rang-{r}-Wettbewerber gedrückt.',
    scan_throttled: 'Der Server war bei {n} Datum/Daten ausgelastet — jedes wurde wiederholt, keines übersprungen.',
    scan_cat_scoped: 'Bepreist gegen {c} — die Kategorien, in denen diese Fahrzeuggruppe verkauft.',
    scan_overloaded: 'Bei {done} von {total} gestoppt: der Server hat Anfragen weiter abgewiesen. Alles bisher Bepreiste ist vorgemerkt und kann angewandt werden — SCAN in einer Minute erneut starten, um den Rest zu erledigen.',
    open_rc: 'AUF RENTALCARS ÖFFNEN', target_rank: 'ZIELRANG', durations: 'MIETDAUERN',
    sweep_hint: 'Max. 6-Tage-Mieten — jeder suchbare Tag dieses Monats.',
    set_account: 'KONTO', set_appearance: 'DARSTELLUNG', set_theme: 'THEMA',
    set_language: 'SPRACHE', set_system: 'SYSTEM',
    set_hud_hint: 'Die HUD-Skalierung ändert die Größe der gesamten Konsole — bei 100 % passt ein ganzer Monat auf einen Bildschirm.',
    set_lang_hint: 'Nur die Oberflächensprache — Regelnamen, Protokolle und DPS-Daten bleiben unverändert.',
    reconnect: 'NEU VERBINDEN', logout: 'ABMELDEN',
    th_dark: 'DUNKEL', th_light: 'HELL',
    acc_fmx_session: 'DPS-SITZUNG', acc_active: 'AKTIV', acc_none: 'NICHT VERBUNDEN',
    acc_tenant: 'MANDANT', acc_stations: 'STATIONEN',
    sys_env: 'UMGEBUNG', sys_env_cloud: 'CLOUD (Firebase)', sys_env_local: 'LOKAL',
    sys_relay: 'RC-RELAY', sys_relay_on: 'ONLINE', sys_relay_off: 'OFFLINE — über EINSTELLUNGEN auf einem deiner Rechner installieren',
    sys_mail: 'ALARM-MAIL', sys_baseline: 'WATCH-BASELINE', sys_days: 'Tages-Snapshots',
    tile_rank_today: 'GM-RANG HEUTE', tile_market1: 'MARKT-#1 HEUTE', tile_watch: 'MARKTÜBERWACHUNG',
    tile_restore: 'WIEDERHERSTELLUNG', of_offers: 'von {n} Angeboten', no_data_yet: 'noch keine Daten',
    alerts_sent: 'Alarme gesendet', baseline_w: 'Baseline', last_w: 'zuletzt', none_yet: 'noch keiner',
    active_w: 'AKTIV', off_w: 'AUS',
    w_status: 'STATUS', w_not_conf: 'MAIL NICHT KONFIGURIERT', w_sweep: 'PRÜFLAUF',
    w_every: 'alle {m} Min · nächste {d} Tage · {dur}T',
    w_triggers: 'AUSLÖSER', w_triggers_v: '&plusmn;{p} % Preis · {r}+ Rangbewegungen · neue #1',
    w_baseline: 'BASELINE', w_lastsweep: 'LETZTER LAUF', w_alerts: 'ALARME GESENDET', w_mailto: 'MAIL AN',
    w_relay: 'RC-RELAY',
    querying: 'RENTALCARS WIRD ABGEFRAGT…', pick_duration: 'Mietdauer wählen.',
    no_offers: 'Keine Angebote für diese Daten.',
    rc_past: 'Dieses Abholdatum liegt in der Vergangenheit — rentalcars zeigt nur zukünftige Abholungen.',
    rc_err_offline: 'rentalcars lehnt Anfragen von Cloud-Servern ab und kein Relay-Rechner ist online. Das Relay einmalig über <b>EINSTELLUNGEN</b> auf einem deiner Rechner installieren (startet danach automatisch) — oder die Rasterzelle rechtsklicken, um rentalcars direkt zu öffnen.',
    rc_err_timeout: 'Das lokale Relay hat nicht rechtzeitig geantwortet — prüfen, ob es noch läuft, dann erneut versuchen.',
    rc_err_rejected: 'rentalcars hat die Anfrage abgelehnt ({code}) — gleich erneut versuchen oder die Rasterzelle rechtsklicken, um rentalcars direkt zu öffnen.',
    rc_err_generic: 'Abfrage fehlgeschlagen: {code} — die Rasterzelle rechtsklicken, um rentalcars direkt zu öffnen.',
    rc_hint_click: 'Auf eine Konkurrenzzeile klicken — oder die Green-Motion-Zeile darauf ziehen — um diese Position zu übernehmen. Alternativ auf den eigenen Green-Motion-Preis klicken und einen Zielpreis direkt eintippen; die DPS-Regeländerung wird automatisch berechnet.',
    rc_session_note: 'Die Preise entsprechen dem, was ein neuer anonymer Besucher für genau diese Abholzeit sieht. rentalcars steuert Kampagnenrabatte (z. B. −12%) pro Sitzung — ein Browser mit alten Cookies sieht evtl. den Preis ohne Rabatt. Für einen 1:1-Vergleich ein privates Fenster und AUF RENTALCARS ÖFFNEN verwenden (gleiche Abholzeit).',
    rc_price_click: 'Klicken, um einen Zielpreis einzugeben',
    rc_price_prompt: 'Zielpreis in {ccy} — Rang und nötige DPS-% werden daraus berechnet:',
    rc_price_bad: 'Ungültiger Preis.',
    dur_pct_hint: 'auf die % klicken, neuen Wert eintippen und das Ranking live in der Vorschau sehen',
    rc_dur_pct_prompt: 'Neuer %-Wert für {dur} an diesem Abholtag — Live-Vorschau bis BESTÄTIGEN:',
    proj_bar: 'LIVE-PROJEKTION · Regel {dur}: {cur}% &rarr; <b>{new}%</b> — Konkurrenz live, GM-Preise aus der Basis berechnet. Günstigstes GM <b>{p1} {ccy}</b>.',
    proj_applied: 'ANGEWENDET &#10003; — das IST das aktuelle Ranking: Konkurrenz live, GM zum angewendeten Preis. rentalcars.com zeigt es auf der Website, sobald der eigene Angebots-Cache auffrischt (Minuten).',
    stale_cache: 'VERALTETER CACHE (Relay offline)', cached: 'AUS CACHE', offers: 'ANGEBOTE', pickup: 'ABHOLUNG',
    gm_rank: 'GM-RANG', gm_not_listed: 'GM NICHT GELISTET',
    fleet_label: 'GM-AUTOS IN TOP 10', fleet_now: 'aktuell {n}',
    fleet_bar: '<b>{k} GM-Autos</b> in den Top 10 · DPS-Regel {dur}T: {cur} % &rarr; <b>{new} %</b> · günstigstes GM {p0} &rarr; <b>{p1} {ccy}</b>',
    fleet_already: 'Bereits erreicht — {k} Green-Motion-Autos sind zum aktuellen Preis in den Top 10.',
    fleet_no_data: 'Flottendaten fehlen in diesem Cache-Ergebnis — Mietdauer neu abfragen und erneut versuchen.',
    fleet_not_enough: 'Für diese Daten sind nur {n} Green-Motion-Auto(s) gelistet.',
    confirm_fmx: 'BESTÄTIGEN &rarr; DPS', reset: 'ZURÜCKSETZEN', drag_hint: '&#8597; ZIEHEN', simulated: 'SIMULIERTE POSITION', target_tag: 'ZIEL',
    t_connected: 'DPS-Sitzung verbunden.', t_reverted: 'Rückgängig gemacht.',
    t_load_grid_first: 'Zuerst das Raster laden.',
    days: 'TAGE',
    rank_strip_empty: 'Der tägliche rentalcars-Rang von Green Motion lädt hier für den aktuellen Monat.',
    rank_legend: 'Tag anklicken für die vollen Top 10 · Abholung 19:00 · 6 h Cache',
    rank_no_days: 'Keine suchbaren Tage in diesem Monat (vergangene Daten können nicht abgefragt werden).',
    session_replaced: 'Von einem anderen Gerät angemeldet — diese Sitzung wurde beendet. Zum Übernehmen erneut anmelden.',
    backup_running: 'WIRD ERSTELLT… {done}/{total}',
    backup_done: 'Wiederherstellungspunkt erstellt.',
    backup_done_failed: 'Wiederherstellungspunkt erstellt — {failed} Regel(n) konnten nicht gelesen werden und fehlen darin.',
    relay_chip_off: 'RC-RELAY OFFLINE',
    rank_stale_note: 'veraltet — Relay offline',
    query_at: 'ABFRAGE {time}',
    discount_hint: 'KUNDE ist, was ein neuer Besucher auf rentalcars zahlt (deren gezielte Kampagne angewendet) — LISTE ist der Grundpreis ohne sie. Sitzungen außerhalb der Kampagne sehen die LISTE-Seite.',
    rc_col_list: 'LISTE',
    rc_col_customer: 'KUNDE',
    rc_col_gear: 'GETRIEBE',
    rc_col_fuel: 'TREIBSTOFF',
    sel_cells: '{n} ZELLEN',
    sel_hint: 'Enter übernehmen · Esc abbrechen',
    sel_staged: '{n} Zellen mit {pct} vorgemerkt — APPLY TO DPS schreibt sie',
    rc_before_title: 'JETZT — VOR DER ÄNDERUNG (wie rentalcars sie ausliefert)',
    rc_after_title: 'PROGNOSE — NACH DER ÄNDERUNG',
    sim_apply_hint: 'APPLY TO DPS (unten rechts) schreibt das',
    rc_live_open: 'rentalcars → {d}.{dur}T · {h}:00',
    rc_live_real: 'Die echte rentalcars-Seite öffnen (gleiche Suche, gleiche Stunde)',
    rules_del_btn: 'REGELN LÖSCHEN',
    rules_delete_sel: 'AUSWAHL LÖSCHEN',
    rules_loading: 'Regelliste wird geladen…',
    rules_selected: '{n} von {total} ausgewählt — Shift-Klick für Bereich, Entf löscht',
    rules_confirm: '{n} Regel(n) werden aus DPS GELÖSCHT. Sicher?',
    rules_deleted: '{n} Regel(n) gelöscht — das Raster synchronisiert sich neu.',
    rules_too_many: 'Mehr als 500 Regeln ausgewählt — Bereich verkleinern.',
    sel_scan: 'RÄNGE PRÜFEN',
    sel_price: 'BEREICH BEPREISEN',
    scan_busy: 'Es läuft bereits ein Bepreisungsvorgang — bitte abwarten.',
    sel_price_confirm: '{n} Regel(n) in {range} gegen das Live-Konkurrenzfeld neu bepreisen? Vorschläge werden orange vorgemerkt — geschrieben wird erst mit APPLY TO DPS.',
    sel_scanning: '{n} ausgewählte Zelle(n) werden live geprüft…',
    sel_scanned: '{n} Zelle(n) geprüft — {bad} in die Mehr-Stunden-Bestätigung.',
    sel_scan_cap: 'Auswahl pro Scan auf 40 Zellen begrenzt.',
    sel_scan_unruled: 'Keine Wochenregeln in der Auswahl — nichts zu prüfen.',
    suspect_reason: 'Außerhalb der Top 10 in {bad} von {total} Stunden (Ränge {ranks})',
    relay_card_title: 'RC-RELAY-RECHNER',
    relay_workers: 'VERBUNDENE WORKER',
    relay_none: 'Keine Relay-Rechner verbunden.',
    relay_ago: 'vor {t}',
    relay_install_hint: 'Einmal pro Computer installieren — das Relay startet bei der Anmeldung automatisch und nach Abstürzen neu. Mehrere Rechner können gleichzeitig online sein; wer eingeschaltet ist, bedient die Abfragen. Nach dem Download den Befehl unten ausführen (Windows: in ein PowerShell-Fenster einfügen).',
    relay_dl_failed: 'Installer-Download fehlgeschlagen: {code}',
    relay_win_dblclick: 'die heruntergeladene install-gm-relay.bat doppelklicken — kein Terminal nötig',
    // Firebase-Anmeldung (Schritt 1) + Rollen + Mandanten-Stationen
    auth_title: 'KONSOLEN-ANMELDUNG',
    auth_text: 'Mit dem Konsolen-Konto anmelden. Zugriff, Rollen und Stationen werden zentral verwaltet — das ist nicht die DPS-Anmeldung.',
    auth_email: 'E-MAIL', auth_pass: 'PASSWORT', auth_signin: 'ANMELDEN',
    auth_signing_in: 'ANMELDUNG…',
    auth_missing: 'E-Mail und Passwort eingeben.',
    auth_wrong: 'Falsche E-Mail oder falsches Passwort.',
    auth_failed: 'Anmeldung fehlgeschlagen: {code}',
    auth_expired: 'Die Konsolen-Sitzung ist abgelaufen — bitte neu anmelden.',
    auth_sdk_failed: 'Anmeldedienst nicht erreichbar — Seite neu laden.',
    auth_step2_hint: 'Danach fragt die Konsole die DPS-Anmeldung ab — das ist eine zweite, separate Sitzung.',
    role_admin: 'ADMIN', role_staff: 'STAFF', acc_role: 'ROLLE',
    set_stations: 'STATIONEN',
    st_add: '+ NEU', st_remove: 'ENTFERNEN',
    st_id: 'DPS-ID', st_name_ph: 'Stationsname',
    st_pick_ph: 'Flughafen, Stadt oder Adresse suchen…',
    st_no_loc: 'kein rentalcars-Standort', st_none: 'Für diesen Mandanten sind keine Stationen konfiguriert.',
    st_searching: 'Suche…', st_no_results: 'Kein Standort gefunden.',
    st_type_more: 'Mindestens 2 Zeichen eingeben.',
    st_saved: 'Stationen gespeichert.',
    st_save_failed: 'Stationen konnten nicht gespeichert werden: {code}',
    st_remove_confirm: 'Station {name} aus diesem Mandanten entfernen?',
    st_bad_id: 'Jede Station braucht eine positive DPS-ID.',
    st_bad_name: 'Jede Station braucht einen Namen (1-60 Zeichen).',
    st_bad_rc: 'Für jede Station einen rentalcars-Standort wählen.',
    st_hint_admin: 'Diese Stationen steuern das Preisraster und jede rentalcars-Abfrage. Der Standort-Picker sucht direkt bei rentalcars — Flughäfen sind mit einem Flugzeug markiert.',
    st_hint_staff: 'Nur lesbar: Stationen des Mandanten ändert ausschließlich ein Admin.',
    set_mail: 'ALARM-MAIL', save: 'SPEICHERN',
    set_mail_hint: 'Marktalarm- und Testmails gehen an diese Adresse. Leer speichern = zurück zum Systemstandard.',
    mail_current: 'AKTIVER EMPFÄNGER', mail_default: 'SYSTEMSTANDARD', mail_saved: 'Alarm-Mail-Empfänger gespeichert.',
    price_curve2: 'PREISKURVE', open_grid_first2: 'Raster öffnen, um Daten zu laden.', duration_avgs: 'DURCHSCHNITT JE MIETDAUER',
    insights_title: 'ANALYSE & KOMMENTAR',
    insights_empty: 'Raster und Rangleiste laden — der Kommentar baut sich aus diesen Daten selbst auf.',
    signout_confirm: 'Auf diesem Gerät von der Konsole abmelden?',
    more_w: 'stärker', less_w: 'schwächer',
    ins_avg: 'Dieser Monat enthält <b>{cells}</b> bepreiste Zellen mit im Schnitt <b>{avg}%</b>. Je Mietdauer reicht die Spanne von <b>{min}%</b> ({minDur}) bis <b>{max}%</b> ({maxDur}).',
    ins_deep: 'Der tiefste Einzelabschlag ist <b>{pct}%</b> am <b>{day} · {dur}</b> — prüfen, ob dieser Tag wirklich der günstigste sein muss.',
    ins_weekend: 'Wochenend-Abholungen liegen im Schnitt bei <b>{wk}%</b> vs. <b>{wd}%</b> an Werktagen — Wochenenden sind {rel} bepreist.',
    ins_cover: '<b>{n}</b> zukünftige(r) Tag(e) ohne Regel: diese Abholungen verkaufen zum Basispreis. Der Warn-Chip im Raster listet sie.',
    ins_cover_ok: 'Jeder zukünftige Tag des Monats ist durch mindestens eine Regel abgedeckt.',
    ins_rank: 'Auf der Rangleiste ist Green Motion an <b>{top1}</b> von {days} Tagen <b>#1</b> (Durchschnittsrang <b>#{avg}</b>, schlechtester <b>#{worst}</b> an Tag {worstDay}).',
    ins_rank_bad: '{n} Tag(e) stehen auf Rang 8 oder schlechter — natürliche Kandidaten für einen TOP-10-SWEEP oder eine Flottenplatzierung aus dem Tagesmodal.',
    ins_inactive: '<b>{n}</b> Regel(n) dieses Monats sind inaktiv — sie erscheinen im Raster, bepreisen aber nicht.',
    scan_btn: 'SCAN',
    scan_tip: 'Drängt für jeden suchbaren Tag dieses Monats 4 Green-Motion-Autos in die Top 10 — Vorschläge erscheinen orange, geschrieben wird erst mit AN DPS SENDEN.',
    scan_running: 'SCAN {done}/{total}',
    scan_done: '{n} Scan-Vorschläge vorgemerkt — orange Zellen prüfen, dann AN DPS SENDEN.',
    scan_mode_q: 'Wie soll SCAN diesen Monat bepreisen?',
    scan_mode_overall: 'Gesamtranking',
    scan_mode_overall_d: 'Normale rentalcars-Suche ohne Kategorien — mehrere Green-Motion-Autos in die Gesamt-Top-10 bringen.',
    scan_mode_cat: 'Alle Kategorien',
    scan_mode_cat_d: 'Green Motion in JEDER Kategorie, in der es antritt (Economy, Kompakt, Mittelklasse, SUV…), an jedem Datum in die Top 3 bringen.',
    scan_mode_pick: 'Kategorie wählen',
    scan_mode_pick_d: 'EINE Fahrzeuggruppe bepreisen. Die Liste stammt aus den Wochenregeln in DPS und bietet daher nur wirklich angelegte Kategorien an.',
    scan_pick_q: 'Welche Fahrzeuggruppe soll SCAN bepreisen?',
    scan_pick_none: 'In diesem Monat gibt es noch keine Wochenregeln — zuerst anlegen, dann kann SCAN sie bepreisen.',
    scan_pick_cells: '{n} bepreiste Zellen · {g}',
    scan_pick_cats: 'Konkurrenzanalyse: {c}',
    scan_pick_cats_all: 'Konkurrenzanalyse: alle Kategorien',
    scan_done_cat: '{n} kategoriebasierte(r) Vorschlag(e) vorgemerkt — orange Zellen prüfen, dann ANWENDEN.',
    scan_none: 'Scan beendet — nichts zu senken: die Top 10 sind schon so voll wie möglich.',
    batch_autoscan_label: 'AUTO-SCAN · {n} ÄNDERUNGEN',
    batch_scan_label: 'SCAN-SWEEP · {n} ÄNDERUNGEN',
    revert_batch_confirm: 'Alle {n} Änderung(en) dieses Scan-Sweeps in DPS rückgängig machen?',
    revert_batch_done: 'Sammel-Revert beendet: {ok} ok, {fail} fehlgeschlagen.',
    cat_all: 'ALLE', cat_economy: 'ECONOMY', cat_compact: 'KOMPAKT',
    cat_midsize: 'MITTELKLASSE', cat_large: 'GROSS', cat_wagon: 'KOMBI',
    cat_suv: 'SUV', cat_minivan: 'MINIVAN',
    rank_in_cat: 'Green-Motion-Rang innerhalb {cat}',
    discard_confirm: '{n} vorgemerkte Änderung(en) verwerfen? Das kann nicht rückgängig gemacht werden.',
    sweep_cancel_confirm: 'Laufenden Top-10-Sweep stoppen? Bereits geschriebene Änderungen bleiben aktiv.',
    scan_cancel_confirm: 'Laufenden Scan stoppen? Bisher vorgemerkte Vorschläge bleiben erhalten.',
    rc_close_confirm: 'Schließen und die nicht angewandte Platzierung verwerfen? Sie wurde nicht an DPS gesendet.',
    cancelled: 'Abgebrochen.',
    cmp_title: 'VORHER / NACHHER — ANGEWANDTE SCAN-VORSCHLÄGE',
    cmp_summary: '{cells} Tag/Dauer-Zelle(n) geschrieben · durchschnittliche Änderung {avg}%',
    cmp_cat: 'KATEGORIE', cmp_before: 'VORHER (Ø Rang)', cmp_after: 'NACHHER (Ø Rang)',
    cmp_improve: 'VERBESSERUNG',
    cmp_gain: '▲ {n} Rang/Ränge',
    cmp_no_change: 'Keine Kategorie-Rangliste bewegt sich — die angewandten Prozente waren zu klein für einen Rangwechsel.',
    cmp_mail_btn: 'BERICHT MAILEN',
    cmp_mailed: 'Bericht per E-Mail verschickt.',
    cmp_mail_failed: 'Bericht-Mail fehlgeschlagen: {msg}',
    cmp_close: 'SCHLIESSEN',
    w_autoscan: 'AUTO-SCAN', w_as_lastrun: 'LETZTER AUTO-SCAN', w_as_pending: 'OFFENE VORSCHLÄGE',
    w_as_missing: 'GM NICHT GELISTET', w_as_horizon: 'SCAN-HORIZONT', w_as_days: '{n} TAGE',
    autoscan_off: 'AUS',
    autoscan_apply: '{n} VORSCHLAG/VORSCHLÄGE ANWENDEN',
    autoscan_confirm: 'Die {n} offenen Auto-Scan-Vorschläge an DPS senden?',
    autoscan_done: 'Auto-Scan-Vorschläge angewandt: {ok} ok, {fail} fehlgeschlagen.',
    autoscan_running: '{n} Vorschlag/Vorschläge werden nach DPS geschrieben — das dauert einige Minuten.',
    autoscan_failed: 'Auto-Scan-Anwendung fehlgeschlagen: {msg}',
    // ---- Sprint 7: Benutzer, Franchises, Fahrzeuggruppen, Sammel-Wochenregeln ----
    nav_users: 'BENUTZER', users_title: 'KONSOLEN-BENUTZER',
    usr_col_user: 'BENUTZER', usr_col_role: 'ROLLE', usr_col_status: 'STATUS', usr_col_last: 'LETZTE ANMELDUNG',
    usr_enabled: 'AKTIV', usr_disabled: 'GESPERRT', usr_never: 'nie', usr_you: 'DU',
    usr_none: 'Für dieses Franchise gibt es noch keine Benutzer.',
    usr_make_admin: 'ZU ADMIN', usr_make_staff: 'ZU STAFF',
    usr_disable: 'SPERREN', usr_enable: 'ENTSPERREN', usr_delete: 'LÖSCHEN',
    usr_role_confirm: '{email} zu {role} ändern?',
    usr_disable_confirm: '{email} sperren? Dieses Konto kann sich dann nicht mehr anmelden.',
    usr_enable_confirm: '{email} wieder entsperren?',
    usr_delete_confirm: '{email} endgültig löschen? Das Konsolen-Konto ist danach weg.',
    usr_saved: 'Benutzer aktualisiert.', usr_deleted: 'Benutzer gelöscht.',
    usr_save_failed: 'Benutzer konnte nicht aktualisiert werden: {code}',
    usr_load_failed: 'Benutzer konnten nicht geladen werden: {code}',
    usr_create: 'BENUTZER ANLEGEN', usr_create_btn: 'BENUTZER ANLEGEN',
    usr_created: 'Benutzer {email} angelegt.',
    usr_create_failed: 'Benutzer konnte nicht angelegt werden: {code}',
    usr_bad_email: 'Gültige E-Mail-Adresse eingeben.',
    usr_bad_pass: 'Das Passwort braucht mindestens 8 Zeichen.',
    usr_hint: 'Passwörter werden hier einmalig gesetzt und nie wieder angezeigt — der neue Operator ändert es im eigenen Konto.',
    usr_hint_super: 'Superadmin: alle Franchises werden gelistet, Benutzer können den Mandanten wechseln.',
    usr_tenant: 'FRANCHISE', usr_self_lockout: 'Das eigene Konto kann nicht herabgestuft oder gesperrt werden.',
    set_franchises: 'FRANCHISES', fr_new: '+ NEU',
    fr_none: 'Für dieses Konto sind keine Franchises sichtbar.',
    fr_stations_n: '{n} Station(en)', fr_users_n: '{n} Benutzer',
    fr_create_btn: 'FRANCHISE ANLEGEN',
    fr_created: 'Franchise {id} angelegt.',
    fr_create_failed: 'Franchise konnte nicht angelegt werden: {code}',
    fr_bad_id: 'Die Franchise-ID muss 2-32 Zeichen aus a-z, 0-9 oder Bindestrich sein.',
    fr_bad_name: 'Dem Franchise einen Namen geben (1-60 Zeichen).',
    fr_bad_base: 'Die DPS-Basis muss eine https://-URL sein.',
    fr_bad_stations: 'Mindestens einen Flughafen/Standort hinzufügen, je mit positiver DPS-ID und Namen.',
    fr_hint_super: 'Ein Franchise entsteht zusammen mit den Flughäfen, die es nutzt — Standort suchen, dann der Station ihre DPS-ID geben.',
    fr_hint_admin: 'Franchises legt nur ein Superadmin an. Das eigene darf umbenannt werden.',
    fr_rename: 'UMBENENNEN', fr_rename_prompt: 'Neuer Name für {id}:',
    fr_saved: 'Franchise gespeichert.', fr_save_failed: 'Franchise konnte nicht gespeichert werden: {code}',
    fr_load_failed: 'Franchises konnten nicht geladen werden: {code}',
    set_reports: 'BERICHT-MAILS',
    set_reports_hint: 'Bericht-Mails auszuschalten stoppt Auto-Scan- und Marktüberwachungs-Mails nur für <b>dieses</b> Konto — andere Operatoren bekommen sie weiter.',
    reports_saved: 'Bericht-Mail-Einstellung gespeichert.',
    vg_all: 'ALLE GRUPPEN', vg_all_btn: 'ALLE', vg_none_btn: 'KEINE',
    vg_save_btn: 'SET SPEICHERN', vg_save_ph: 'Set-Name (z. B. Economy-Flotte)',
    vg_saved: 'Set \u201e{name}\u201c gespeichert.', vg_del_confirm: 'Set \u201e{name}\u201c l\u00f6schen?',
    vg_pick_first: 'Zuerst mindestens eine Fahrzeuggruppe w\u00e4hlen.',
    vg_name_first: 'Dem Set zuerst einen Namen geben.',
    vg_presets_hint: 'Gespeicherte Sets \u2014 anklicken, um genau diese Gruppen zu w\u00e4hlen.',
    vg_selected: '{n}/{total} gewählt',
    vg_loading: 'Fahrzeuggruppen werden geladen…',
    vg_unavailable: 'Fahrzeuggruppen brauchen eine aktive DPS-Sitzung — leer lassen heißt: alle Gruppen.',
    vg_groups: 'Gruppen',
    bulk_btn: 'WOCHENREGELN', bulk_title: 'WOCHENREGELN',
    bulk_start: 'STARTDATUM',
    bulk_end: 'ENDDATUM',
    bulk_range_bad: 'Das Enddatum liegt vor dem Startdatum.',
    bulk_range_long: 'Der Zeitraum ist zu lang \u2014 h\u00f6chstens 400 Tage.',
    bulk_horizon: 'HORIZONT', bulk_pct: 'PROZENT',
    bulk_groups: 'FAHRZEUGGRUPPEN', bulk_skip: 'VORHANDENE ÜBERSPRINGEN',
    bulk_apply: 'ANWENDEN', bulk_cancel: 'LAUF ABBRECHEN',
    bulk_preview: 'Erstellt bis zu <b>{n}</b> Regeln — {from} &rarr; {to}',
    bulk_preview_bad: 'Startdatum, mindestens eine Mietdauer und einen Prozentwert wählen.',
    bulk_confirm: 'Bis zu {n} Regel(n) mit {pct}% für {station} anlegen — {from} bis {to} · {groups}?',
    bulk_running: 'ERSTELLE {done}/{total} · {ok} ok · {fail} fehlgeschlagen',
    bulk_done: 'Wochenregeln erstellt: {ok} ok, {fail} fehlgeschlagen.',
    bulk_skipped_cov: '{n} Zelle(n) übersprungen: die vorhandene Regel deckt andere Fahrzeuggruppen ab.',
    bulk_failed: 'Sammelerstellung fehlgeschlagen: {code}',
    bulk_cancel_confirm: 'Laufende Sammelerstellung stoppen? Bereits geschriebene Regeln bleiben in DPS.',
    bulk_cancelled: 'Sammelerstellung abgebrochen.',
    bulk_bad_date: 'Ein echtes Startdatum wählen, höchstens 24 Monate in der Zukunft.',
    bulk_bad_pct: 'Prozentwert zwischen -95 und 100 eingeben.',
    bulk_bad_durs: 'Mindestens eine Mietdauer wählen.',
    batch_bulk_label: 'WOCHENREGELN · {n} ERSTELLT',
    bulk_fu_q: 'Die Regeln liegen in DPS. Wie sollen sie bepreist werden?',
    bulk_fu_manual: 'MANUEL', bulk_fu_manual_d: 'Hier schließen — die neuen Regeln werden im Raster von Hand bepreist.',
    bulk_fu_scan: 'RAKİP ANALİZİ',
    bulk_fu_scan_d: 'Den Kategorie-SCAN über genau diese Tage und Mietdauern laufen lassen, dann die orangen Vorschläge prüfen und ANWENDEN.',
    bulk_fu_scope: 'Der Scan deckt die {n} Tag(e) dieses Laufs innerhalb {month} ab — Vorschläge entstehen pro Monat.',
    bulk_fu_none: 'Keiner der neuen Tage liegt im angezeigten Monat — diesen Monat öffnen und dort SCAN starten.',
  },
  tr: {
    nav_dashboard: 'PANO', nav_grid: 'FİYAT TABLOSU', nav_analytics: 'ANALİZ',
    nav_activity: 'AKTİVİTE', nav_settings: 'AYARLAR',
    open_fmx: 'DPS AÇ &nearr;',
    side_hint: 'Hücreye tek tık &rarr; iki pazar görünümü de o güne gelir. Çift tık &rarr; yüzdeyi yaz; sıralama tahmini canlı güncellenir.',
    user_role: 'OPERATÖR · DPS', not_signed_in: 'GİRİŞ YAPILMADI',
    rc_market_rank: 'RC PAZAR SIRASI', price_curve: 'FİYAT EĞRİSİ', restore_points: 'GERİ DÖNÜŞ NOKTALARI',
    create: 'OLUŞTUR', no_backups: 'Henüz geri dönüş noktası yok.', market_watch: 'PAZAR TAKİBİ',
    run_now: 'ŞİMDİ TARA', test_mail: 'TEST MAİLİ', recent_activity: 'SON AKTİVİTE', view_all: 'TÜMÜNÜ GÖR',
    no_activity: 'Henüz aktivite yok.', no_activity2: 'Henüz aktivite yok.', open_grid_first: 'Veri için önce tabloyu aç.',
    copy: 'KOPYALA', top10_sweep: 'TOP-10 TARAMA', vendor: 'KANAL',
    grid_empty: 'Fiyat tablosunu yüklemek için DPS oturumunu bağla.',
    staged_changes: 'BEKLEYEN DEĞİŞİKLİK', discard: 'VAZGEÇ', apply_fmx: "DPS'E UYGULA",
    activity_log: 'AKTİVİTE KAYDI', refresh: 'YENİLE',
    login_title: 'DPS GİRİŞİ',
    login_text: '<b>zrh.dps.greenmotion.com</b> hesabınla giriş yap. Konsol kendi DPS oturumunu açar ve canlı tutar; şifren yalnızca bellekte tutulur, asla diske yazılmaz.',
    username: 'KULLANICI ADI', password: 'ŞİFRE', cancel: 'İPTAL', sign_in: 'GİRİŞ YAP',
    ok: 'ONAYLA', select_all: 'TÜMÜ',
    lane_bar: 'ARAÇ GRUPLARI', lane_all: 'TÜM ARAÇLAR', lane_groups: '{n} GRUP',
    bulk_horizon_ph: 'veya: 45 / 2 hafta',
    scan_floor_note2: '{n} tarih fiyat tabanına YUKARI düzeltildi: en ucuz rakibin en fazla %{u} veya {chf} CHF altı.',
    scan_failed_cells: '{n} tarih sorgulanamadı — kalanlar için TARA\'yı bir daha çalıştır.',
    scan_confirm_q: 'Rakip taraması başlasın mı? {n} tarih/süre hücresi sorgulanacak ve fiyat önerileri gride hazırlanacak.',
    grid_purge_running: 'İstasyon sıfırlama hâlâ çalışıyor — DPS\'te gördüğün sayılar listeyi silerken azalıyor. Bitince grid kendiliğinden yüklenecek (20 sn\'de bir kontrol ediliyor).',
    conflict_cell_tip: 'Burada iki kural aynı araçları kapsıyor ({ids}). Düzeltmek için tıkla: kalacak kuralı seç, diğerleri silinir.',
    conflict_fix_q: '{d} çakışması — bu hücreyi hangi kural TUTSUN?',
    conflict_all_q: '{n} çakışan hücre — her hücrede BİR kural kalacak, diğerleri silinecek. Hangisi kalsın?',
    conflict_all_old: 'EN ESKİYİ TUT (kopya sonrası önerilen)',
    conflict_all_old_d: 'Hücrenin ASIL kuralı kalır; sonradan gelen kopyalar (COPY TO en yeni olarak iner) silinir.',
    conflict_all_new: 'EN YENİYİ TUT',
    conflict_all_new_d: 'En son oluşturulan kural kalır, eskiler silinir.',
    conflict_all_confirm: "{cells} hücrede {n} kural DPS'ten SİLİNECEK. Emin misin?",
    conflict_all_done: '{n} kural silindi — grid yeniden eşitleniyor.',
    conflict_keep: '#{id} KALSIN',
    conflict_inactive: 'pasif',
    conflict_fix_confirm: 'Diğer {n} kural silinip #{id} kalsın mı?',
    conflict_fixed: 'Çakışma düzeltildi — {n} kopya kural silindi.',
    conflict_fix_fail: '{n} kural silinemedi — hücre canlı durumla yeniden yükleniyor.',
    gt_live: 'CANLI', gt_staged: 'HAZIRDA', gt_empty: 'KURAL YOK', gt_pct: 'FİYAT KURALI',
    gt_op: 'KOŞUL', gt_updated: 'GÜNCELLEME',
    gt_hint: 'tık: düzenle · sağ tık: rentalcars',
    cap_busy: 'PAZAR KUYRUĞU DOLU · {s}sn',
    fleet_gm_absent: 'Bu tarih/sürede Green Motion listelenmiyor — yerleştirilecek ya da düzenlenecek bir fiyat yok. DPS\'te müsaitliği kontrol et.',
    pickup_fallback: '19:00 boştu — teklif olan en yakın saat',
    querying_at: 'rentalcars {time} alış için sorgulanıyor…',
    proj_tag: '(projeksiyon)',
    currency_warn: 'FİYATLAR {c} — KARŞILAŞTIRILAMAZ',
    refresh_rc: 'YENİLE',
    hour_prev: 'Önceki alış saati',
    hour_next: 'Sonraki alış saati (19:00 sonrası 09:00)',
    refreshing: 'YENİLENİYOR…',
    pinned: 'sabit',
    cap_limit: 'SORGU LİMİTİNE ULAŞILDI · {s}sn',
    scan_capped: 'Konsol siteyi korumak için kendini yavaşlattı — {n} tarih boş slot bekledi. Hiçbiri atlanmadı.',
    presence_viewing: '{u} görüntülüyor',
    grid_too_many: 'Bu istasyonda gösterilemeyecek kadar çok kural var — SIFIRLA\'yı çalıştır, sonra grid yüklenir.',
    fleet_floored: 'Fiyat tabanında tutuldu — en ucuz rakibin en fazla %5 veya 10 CHF altı.',
    fleet_raised: 'Zam planlandı: fazla araçlar top-10 çizgisinin hemen üstüne çıkıyor, en ucuz {k} araç içeride kalıp yarışmaya devam ediyor.',
    fleet_exact_hard: 'GM fiyatları tam {k} için fazla yakın — bandın izin verdiği kadar zam yapıldı; simüle listeye bak.',
    no_rc_station: 'Bu istasyonun henüz rentalcars konumu yok — pazar özellikleri için Ayarlar\'dan bir konum ata.',
    reset_btn: 'SIFIRLA', copy_btn: 'KOPYALA…',
    reset_confirm: '{s} istasyonundaki konsol tarafından yazılmış TÜM haftalık kurallar silinsin mi? Önce geri dönüş noktası alınır; DPS\'te elle yaptıkların silinmez.',
    copy_pick_q: 'Haftalık kurallar hangi istasyona kopyalansın?',
    copy_confirm: '{from} istasyonundaki tüm konsol kuralları {to} istasyonuna kopyalansın mı? {to} CANLI bir istasyon — bu kurallar orada rentalcars fiyatlarını hemen değiştirir.',
    copy_no_target: 'Kopyalanacak başka istasyon yok.',
    copy_none: 'Kopyalanacak konsol kuralı yok.',
    copy_started: '{n} kural {s} istasyonuna kopyalanıyor…',
    copy_progress: 'KOPYALANAN', copy_done: 'Kopyalama bitti: {ok} tamam, {fail} başarısız.',
    copy_failed: 'Kopyalama başarısız: {code}',
    purge_title: 'HAFTALIK KURALLARI SIFIRLA', purge_btn: 'HEPSİNİ SİL',
    purge_ph: 'Onaylamak için istasyon adını yaz',
    purge_hint: 'Seçili istasyondaki konsol tarafından yazılmış tüm haftalık kuralları siler — yalnızca tek günlük yüzde kuralları. DPS\'te elle yaptığın kurallara (tarih aralığı, haftanın günü, sabit fiyat) dokunulmaz. Önce geri dönüş noktası alınır.',
    purge_ph_named: 'Şunu yaz: {s}',
    purge_pick: 'Önce bir istasyon seç.',
    purge_confirm_bad: 'İstasyon adını birebir yaz: {s}',
    purge_confirm_q: '{s} istasyonundaki konsol tarafından yazılmış TÜM haftalık kurallar silinsin mi? Önce geri dönüş noktası alınır, ama tek tıkla geri alınamaz.',
    purge_started: '{n} kural siliniyor — önce geri dönüş noktası alındı.',
    purge_running: 'Geri dönüş noktası alınıyor…', purge_progress: 'SİLİNEN', purge_backup: 'GERİ DÖNÜŞ NOKTASI',
    purge_none: 'Bu istasyonda konsolun yazdığı haftalık kural yok.',
    purge_done: 'Bitti: {ok} silindi, {fail} başarısız.',
    purge_failed: 'Sıfırlama başarısız: {code}',
    lane_switch_staged: 'Bu araç grubunda uygulanmamış değişiklikler var. Grup değiştirirsen silinirler. Devam edilsin mi?',
    scan_cat_pick_q: 'TARA hangi kategorileri fiyatlasın?',
    scan_cat_pick_note: 'Tek bir DPS kuralı bütün Green Motion araçlarını birlikte ölçekler; gerçekte yarışmadığın bir kategoriyi kovalamak fiyatı her yerde aşağı çeker. Yalnızca gerçekten sattığın kategorileri seç.',
    scan_cat_gm: '{n} Green Motion aracı · en ucuzu {p}',
    scan_cat_none: 'Bu tarihte hiçbir kategoride listelenen Green Motion aracı yok.',
    scan_floor_note: '{n} tarih marj tabanı tarafından tutuldu: en zayıf kategoriyi yakalamak, başka bir kategoriyi {r}. sıradaki rakibinin %{u} altına düşürecekti.',
    scan_throttled: 'Sunucu {n} tarihte meşguldü — her biri tekrar denendi, hiçbiri atlanmadı.',
    scan_cat_scoped: '{c} kategorisine göre fiyatlandı — bu araç grubunun sattığı kategoriler.',
    scan_overloaded: '{total} tarihin {done} tanesinde durdu: sunucu istekleri reddetmeye devam etti. Buraya kadar fiyatlananlar hazır ve uygulanabilir — kalanı bitirmek için bir dakika sonra TARA\'yı tekrar çalıştır.',
    open_rc: "RENTALCARS'TA AÇ", target_rank: 'HEDEF SIRA', durations: 'SÜRELER',
    sweep_hint: 'En fazla 6 günlük kiralamalar — bu ayın aranabilir her günü.',
    set_account: 'HESAP', set_appearance: 'GÖRÜNÜM', set_theme: 'TEMA',
    set_language: 'DİL', set_system: 'SİSTEM',
    set_hud_hint: "HUD ölçeği tüm konsolu yeniden boyutlandırır — %100'de tam bir ay tek ekrana sığar.",
    set_lang_hint: 'Yalnızca arayüz dili — kural adları, kayıtlar ve DPS verileri olduğu gibi kalır.',
    reconnect: 'YENİDEN BAĞLAN', logout: 'ÇIKIŞ YAP',
    th_dark: 'KOYU', th_light: 'AÇIK',
    acc_fmx_session: 'DPS OTURUMU', acc_active: 'AKTİF', acc_none: 'BAĞLI DEĞİL',
    acc_tenant: 'TENANT', acc_stations: 'İSTASYONLAR',
    sys_env: 'ORTAM', sys_env_cloud: 'BULUT (Firebase)', sys_env_local: 'YEREL',
    sys_relay: 'RC RELAY', sys_relay_on: 'ÇEVRİMİÇİ', sys_relay_off: 'KAPALI — AYARLAR sayfasından herhangi bir bilgisayarına kur',
    sys_mail: 'UYARI MAİLİ', sys_baseline: 'TAKİP TEMELİ', sys_days: 'gün anlık görüntüsü',
    tile_rank_today: 'GM SIRASI BUGÜN', tile_market1: 'PAZAR #1 BUGÜN', tile_watch: 'PAZAR TAKİBİ',
    tile_restore: 'GERİ DÖNÜŞ', of_offers: '{n} teklif içinde', no_data_yet: 'henüz veri yok',
    alerts_sent: 'uyarı gönderildi', baseline_w: 'temel', last_w: 'son', none_yet: 'henüz yok',
    active_w: 'AKTİF', off_w: 'KAPALI',
    w_status: 'DURUM', w_not_conf: 'MAİL AYARLI DEĞİL', w_sweep: 'TARAMA',
    w_every: 'her {m} dk · önümüzdeki {d} gün · {dur}G',
    w_triggers: 'TETİKLEYİCİLER', w_triggers_v: '&plusmn;%{p} fiyat · {r}+ sıra değişimi · yeni #1',
    w_baseline: 'TEMEL', w_lastsweep: 'SON TARAMA', w_alerts: 'GÖNDERİLEN UYARI', w_mailto: 'MAİL ADRESİ',
    w_relay: 'RC RELAY',
    querying: 'RENTALCARS SORGULANIYOR…', pick_duration: 'Bir süre seç.',
    no_offers: 'Bu tarihler için teklif dönmedi.',
    rc_past: 'Bu alış tarihi geçmişte kaldı — rentalcars yalnızca gelecekteki alışları fiyatlar.',
    rc_err_offline: "rentalcars bulut sunucularından gelen sorguları reddediyor ve hiçbir relay bilgisayarı çevrimiçi değil. Relay'i <b>AYARLAR</b> sayfasından kullandığın herhangi bir bilgisayara bir kez kur (sonrasında otomatik başlar) — ya da grid hücresine sağ tıklayıp rentalcars'ı doğrudan aç.",
    rc_err_timeout: 'Yerel relay zamanında yanıt vermedi — hâlâ çalıştığını kontrol edip tekrar dene.',
    rc_err_rejected: "rentalcars sorguyu reddetti ({code}) — birazdan tekrar dene veya grid hücresine sağ tıklayıp rentalcars'ı doğrudan aç.",
    rc_err_generic: "Sorgu başarısız: {code} — grid hücresine sağ tıklayıp rentalcars'ı doğrudan aç.",
    rc_hint_click: 'O konumu almak için bir rakip satırına tıkla — veya Green Motion satırını üstüne sürükle. İstersen Green Motion fiyatına tıklayıp doğrudan hedef fiyat da girebilirsin; gereken DPS kural değişikliği otomatik hesaplanır.',
    rc_session_note: 'Fiyatlar, tam bu alış saati için yeni (çerezsiz) bir ziyaretçinin gördüğü fiyatlardır. rentalcars kampanya indirimlerini (örn. −12%) oturuma göre hedefler — eski çerezli bir tarayıcı indirimsiz fiyatı görebilir. Birebir karşılaştırma için gizli pencere ve RENTALCARS\'TA AÇ düğmesini kullan (aynı alış saatini taşır).',
    rc_price_click: 'Hedef fiyat girmek için tıkla',
    rc_price_prompt: 'Hedef fiyat ({ccy}) — sıralama ve gereken DPS yüzdesi buna göre hesaplanır:',
    rc_price_bad: 'Geçersiz fiyat.',
    dur_pct_hint: "%'ye tıkla, yeni değeri yaz ve sıralamayı canlı önizle",
    rc_dur_pct_prompt: 'Bu alış günü için {dur} yeni yüzdesi — ONAYLA diyene kadar canlı önizleme:',
    proj_bar: 'CANLI PROJEKSİYON · kural {dur}: %{cur} &rarr; <b>%{new}</b> — rakipler canlı, GM fiyatları tabandan hesaplandı. En ucuz GM <b>{p1} {ccy}</b>.',
    proj_applied: 'UYGULANDI &#10003; — şu anki GERÇEK sıralama bu: rakipler canlı, GM uygulanan fiyatta. rentalcars.com kendi teklif önbelleğini tazeleyince (dakikalar) sitede de böyle görünür.',
    stale_cache: 'ESKİ ÖNBELLEK (relay kapalı)', cached: 'ÖNBELLEK', offers: 'TEKLİF', pickup: 'ALIŞ',
    gm_rank: 'GM SIRASI', gm_not_listed: 'GM LİSTEDE YOK',
    fleet_label: "TOP 10'DA GM ARACI", fleet_now: 'şu an {n}',
    fleet_bar: "Top 10 içinde <b>{k} GM aracı</b> · DPS kuralı {dur}G: %{cur} &rarr; <b>%{new}</b> · en ucuz GM {p0} &rarr; <b>{p1} {ccy}</b>",
    fleet_already: 'Zaten tamam — mevcut fiyatla {k} Green Motion aracı top 10 içinde.',
    fleet_no_data: 'Bu önbellek sonucunda filo verisi yok — süre düğmesiyle yeniden sorgula ve tekrar dene.',
    fleet_not_enough: 'Bu tarihler için yalnızca {n} Green Motion aracı listelenmiş.',
    confirm_fmx: 'ONAYLA &rarr; DPS', reset: 'SIFIRLA', drag_hint: '&#8597; SÜRÜKLE', simulated: 'SİMÜLE POZİSYON', target_tag: 'HEDEF',
    t_connected: 'DPS oturumu bağlandı.', t_reverted: 'Geri alındı.',
    t_load_grid_first: 'Önce tabloyu yükle.',
    days: 'GÜN',
    rank_strip_empty: "Green Motion'ın günlük rentalcars sırası bu ay için burada yüklenir.",
    rank_legend: 'tam top-10 için güne tıkla · alış 19:00 · 6 sa önbellek',
    rank_no_days: 'Bu ayda aranabilir gün yok (geçmiş tarihler sorgulanamaz).',
    session_replaced: 'Başka bir cihazdan giriş yapıldı — bu oturum sonlandı. Devralmak için tekrar giriş yap.',
    backup_running: 'OLUŞTURULUYOR… {done}/{total}',
    backup_done: 'Geri dönüş noktası oluşturuldu.',
    backup_done_failed: 'Geri dönüş noktası oluşturuldu — {failed} kural okunamadı ve içinde eksik.',
    relay_chip_off: 'RC RELAY KAPALI',
    rank_stale_note: 'eski — relay kapalı',
    query_at: 'SORGU {time}',
    discount_hint: "MÜŞTERİ, taze bir ziyaretçinin rentalcars'ta ödediği fiyattır (kendi hedefli kampanyaları uygulanmış) — LİSTE, kampanyasız taban fiyattır. Kampanya dışındaki oturumlar LİSTE tarafını görür.",
    rc_col_list: 'LİSTE',
    rc_col_customer: 'MÜŞTERİ',
    rc_col_gear: 'VİTES',
    rc_col_fuel: 'YAKIT',
    sel_cells: '{n} HÜCRE',
    sel_hint: 'Enter uygula · Esc iptal',
    sel_staged: '{n} hücre {pct} ile hazırlandı — APPLY TO DPS yazar',
    rc_before_title: 'ŞU AN — DEĞİŞİKLİKTEN ÖNCE (rentalcars böyle satıyor)',
    rc_after_title: 'TAHMİN — DEĞİŞİKLİKTEN SONRA',
    sim_apply_hint: 'APPLY TO DPS (sağ altta) bunu yazar',
    rc_live_open: 'rentalcars → {d}.{dur}G · {h}:00',
    rc_live_real: 'Gerçek rentalcars sayfasını aç (aynı arama, aynı saat)',
    rules_del_btn: 'KURAL SİL',
    rules_delete_sel: 'SEÇİLİLERİ SİL',
    rules_loading: 'Kural listesi yükleniyor…',
    rules_selected: '{total} kuraldan {n} seçili — shift-tık aralık seçer, Delete siler',
    rules_confirm: "{n} kural DPS'ten SİLİNECEK. Emin misin?",
    rules_deleted: '{n} kural silindi — grid yeniden eşitleniyor.',
    rules_too_many: "500'den fazla kural seçildi — aralığı daralt.",
    sel_scan: 'SIRALARI KONTROL ET',
    sel_price: 'BU ALANI FİYATLA',
    scan_busy: 'Zaten bir fiyatlama işlemi sürüyor — bitmesini bekle.',
    sel_price_confirm: '{range} aralığındaki {n} kural canlı rakip alanına göre yeniden fiyatlansın mı? Öneriler turuncu olarak hazırlanır — APPLY TO DPS demeden hiçbir şey yazılmaz.',
    sel_scanning: '{n} seçili hücre canlı taranıyor…',
    sel_scanned: '{n} hücre tarandı — {bad} tanesi çok-saatli teyide alındı.',
    sel_scan_cap: 'Tarama başına seçim 40 hücreyle sınırlı.',
    sel_scan_unruled: 'Seçimde weekly rule yok — kontrol edilecek bir şey yok.',
    suspect_reason: '{total} saatin {bad} tanesinde top-10 dışı (sıralar {ranks})',
    relay_card_title: 'RC RELAY MAKİNELERİ',
    relay_workers: 'BAĞLI MAKİNELER',
    relay_none: 'Bağlı relay makinesi yok.',
    relay_ago: '{t} önce',
    relay_install_hint: 'Her bilgisayara bir kez kur — relay oturum açılışında otomatik başlar, çökerse yeniden başlar. Aynı anda birden çok makine çevrimiçi olabilir; hangisi açıksa sorguları o karşılar. İndirdikten sonra aşağıdaki komutu çalıştır (Windows: bir PowerShell penceresine yapıştır).',
    relay_dl_failed: 'Kurulum dosyası indirilemedi: {code}',
    relay_win_dblclick: 'indirilen install-gm-relay.bat dosyasına çift tıkla — terminal gerekmez',
    // Firebase girişi (1. adım) + roller + kiracı istasyonları
    auth_title: 'KONSOL GİRİŞİ',
    auth_text: 'Konsol hesabınla giriş yap. Erişim, roller ve istasyonlar merkezî olarak yönetilir — bu DPS girişi değildir.',
    auth_email: 'E-POSTA', auth_pass: 'PAROLA', auth_signin: 'GİRİŞ YAP',
    auth_signing_in: 'GİRİŞ YAPILIYOR…',
    auth_missing: 'E-posta ve parolayı gir.',
    auth_wrong: 'E-posta veya parola hatalı.',
    auth_failed: 'Giriş başarısız: {code}',
    auth_expired: 'Konsol oturumunun süresi doldu — tekrar giriş yap.',
    auth_sdk_failed: 'Giriş servisi erişilemiyor — sayfayı yenile.',
    auth_step2_hint: 'Bu adımdan sonra konsol DPS girişini ister — o ayrı, ikinci bir oturumdur.',
    role_admin: 'YÖNETİCİ', role_staff: 'PERSONEL', acc_role: 'ROL',
    set_stations: 'İSTASYONLAR',
    st_add: '+ EKLE', st_remove: 'KALDIR',
    st_id: 'DPS ID', st_name_ph: 'İstasyon adı',
    st_pick_ph: 'Havalimanı, şehir veya adres ara…',
    st_no_loc: 'rentalcars konumu yok', st_none: 'Bu kiracı için tanımlı istasyon yok.',
    st_searching: 'Aranıyor…', st_no_results: 'Konum bulunamadı.',
    st_type_more: 'En az 2 karakter yaz.',
    st_saved: 'İstasyonlar kaydedildi.',
    st_save_failed: 'İstasyonlar kaydedilemedi: {code}',
    st_remove_confirm: '{name} istasyonu bu kiracıdan kaldırılsın mı?',
    st_bad_id: 'Her istasyonun pozitif bir DPS id\'si olmalı.',
    st_bad_name: 'Her istasyonun adı olmalı (1-60 karakter).',
    st_bad_rc: 'Her istasyon için bir rentalcars konumu seç.',
    st_hint_admin: 'Bu istasyonlar fiyat ızgarasını ve her rentalcars sorgusunu besler. Konum seçici doğrudan rentalcars\'ta arar — havalimanları uçak işaretiyle gösterilir.',
    st_hint_staff: 'Salt okunur: kiracının istasyonlarını yalnızca yönetici değiştirebilir.',
    set_mail: 'UYARI MAİLİ', save: 'KAYDET',
    set_mail_hint: 'Pazar takibi uyarıları ve test mailleri bu adrese gider. Boş bırakıp kaydedersen sistem varsayılanına döner.',
    mail_current: 'AKTİF ALICI', mail_default: 'SİSTEM VARSAYILANI', mail_saved: 'Uyarı maili alıcısı kaydedildi.',
    price_curve2: 'FİYAT EĞRİSİ', open_grid_first2: 'Veri için önce tabloyu aç.', duration_avgs: 'SÜRE ORTALAMALARI',
    insights_title: 'YORUM & DEĞERLENDİRME',
    insights_empty: 'Tabloyu ve sıralama şeridini yükle — yorum bu verilerden kendiliğinden oluşur.',
    signout_confirm: 'Bu cihazda konsoldan çıkış yapılsın mı?',
    more_w: 'daha agresif', less_w: 'daha temkinli',
    ins_avg: 'Bu ayda ortalaması <b>%{avg}</b> olan <b>{cells}</b> fiyatlı hücre var. Süre bazında aralık <b>%{min}</b> ({minDur}) ile <b>%{max}</b> ({maxDur}) arasında.',
    ins_deep: 'En derin tekil indirim <b>{day} · {dur}</b> gününde <b>%{pct}</b> — bu günün gerçekten en ucuz olması gerekip gerekmediğini kontrol et.',
    ins_weekend: 'Hafta sonu alışları ortalama <b>%{wk}</b>, hafta içi <b>%{wd}</b> — hafta sonları {rel} fiyatlanmış.',
    ins_cover: '<b>{n}</b> gelecek günde hâlâ kural yok: o günler taban fiyattan satılıyor. Tablodaki uyarı rozeti bu günleri listeler.',
    ins_cover_ok: 'Ayın gelecekteki her günü en az bir kuralla kapsanıyor.',
    ins_rank: 'Sıralama şeridinde Green Motion izlenen {days} günün <b>{top1}</b>\'inde <b>#1</b> (ortalama sıra <b>#{avg}</b>, en kötüsü {worstDay}. günde <b>#{worst}</b>).',
    ins_rank_bad: '{n} gün 8. sıra veya daha kötüde — TOP-10 TARAMA ya da günün modalından filo yerleştirme için doğal adaylar.',
    ins_inactive: 'Bu ayda <b>{n}</b> kural pasif — tabloda görünüyor ama fiyatlamıyor.',
    scan_btn: 'TARA',
    scan_tip: "Bu ayın aranabilir her günü için top 10'a 4 Green Motion aracı sokar — öneriler turuncu bekler, DPS'E UYGULA diyene kadar hiçbir şey yazılmaz.",
    scan_running: 'TARAMA {done}/{total}',
    scan_done: "{n} tarama önerisi beklemede — turuncu hücreleri incele, sonra DPS'E UYGULA.",
    scan_mode_q: 'TARA bu ayı nasıl fiyatlasın?',
    scan_mode_overall: 'Genel sıralama',
    scan_mode_overall_d: 'Normal rentalcars araması, kategorisiz — birkaç Green Motion aracını genel ilk 10\'a sokar.',
    scan_mode_cat: 'Tüm kategoriler',
    scan_mode_cat_d: 'Green Motion\'ı yarıştığı HER kategoride (ekonomi, kompakt, orta boy, SUV…) ve her tarihte ilk 3\'e sokar.',
    scan_mode_pick: 'Kategori seç',
    scan_mode_pick_d: 'TEK bir araç grubunu fiyatlar. Liste DPS\'te var olan haftalık kurallardan okunur; yani yalnızca gerçekten oluşturduğun kategorileri gösterir.',
    scan_pick_q: 'TARA hangi araç grubunu fiyatlasın?',
    scan_pick_none: 'Bu ayda henüz haftalık kural yok — önce oluştur, sonra TARA onları fiyatlayabilir.',
    scan_pick_cells: '{n} fiyatlı hücre · {g}',
    scan_pick_cats: 'rakip analizi: {c}',
    scan_pick_cats_all: 'rakip analizi: tüm kategoriler',
    scan_done_cat: '{n} kategori bazlı öneri hazırlandı — turuncu hücreleri incele, sonra UYGULA.',
    scan_none: 'Tarama bitti — düşürülecek bir şey yok: top 10 mümkün olan her yerde zaten dolu.',
    batch_autoscan_label: 'OTOMATİK TARAMA · {n} DEĞİŞİKLİK',
    batch_scan_label: 'TOPLU TARAMA · {n} DEĞİŞİKLİK',
    revert_batch_confirm: "Bu taramanın {n} değişikliğinin tümü DPS'te geri alınsın mı?",
    revert_batch_done: 'Toplu geri alma bitti: {ok} tamam, {fail} başarısız.',
    cat_all: 'TÜMÜ', cat_economy: 'EKONOMİ', cat_compact: 'KOMPAKT',
    cat_midsize: 'ORTA BOY', cat_large: 'BÜYÜK', cat_wagon: 'STATION',
    cat_suv: 'SUV', cat_minivan: 'MİNİVAN',
    rank_in_cat: '{cat} içinde Green Motion sırası',
    discard_confirm: '{n} bekleyen değişiklik iptal edilsin mi? Bu geri alınamaz.',
    sweep_cancel_confirm: 'Çalışan top-10 taraması durdurulsun mu? Zaten yazılan değişiklikler uygulanmış kalır.',
    scan_cancel_confirm: 'Çalışan tarama durdurulsun mu? Şu ana dek beklemeye alınan öneriler korunur.',
    rc_close_confirm: 'Kapatılıp uygulanmamış yerleşim kaybedilsin mi? DPS\'e yazılmadı.',
    cancelled: 'İptal edildi.',
    cmp_title: 'ÖNCE / SONRA — UYGULANAN TARAMA ÖNERİLERİ',
    cmp_summary: '{cells} gün/süre hücresi yazıldı · ortalama değişim %{avg}',
    cmp_cat: 'KATEGORİ', cmp_before: 'ÖNCE (ort. sıra)', cmp_after: 'SONRA (ort. sıra)',
    cmp_improve: 'İYİLEŞME',
    cmp_gain: '▲ {n} sıra',
    cmp_no_change: 'Hiçbir kategoride sıra değişmedi — uygulanan yüzdeler sıralamayı oynatacak kadar büyük değildi.',
    cmp_mail_btn: 'RAPORU MAİLLE',
    cmp_mailed: 'Rapor maillendi.',
    cmp_mail_failed: 'Rapor maili gitmedi: {msg}',
    cmp_close: 'KAPAT',
    w_autoscan: 'OTOMATİK TARAMA', w_as_lastrun: 'SON OTOMATİK TARAMA', w_as_pending: 'BEKLEYEN ÖNERİ',
    w_as_missing: 'GM LİSTEDE YOK', w_as_horizon: 'TARAMA UFKU', w_as_days: '{n} GÜN',
    autoscan_off: 'KAPALI',
    autoscan_apply: '{n} ÖNERİYİ UYGULA',
    autoscan_confirm: "Bekleyen {n} otomatik tarama önerisi DPS'e uygulansın mı?",
    autoscan_done: 'Otomatik tarama önerileri uygulandı: {ok} tamam, {fail} başarısız.',
    autoscan_running: "{n} öneri DPS'e yazılıyor — birkaç dakika sürebilir.",
    autoscan_failed: 'Otomatik tarama uygulanamadı: {msg}',
    // ---- Sprint 7: kullanıcılar, franchise, araç grupları, toplu haftalık kurallar ----
    nav_users: 'KULLANICILAR', users_title: 'KONSOL KULLANICILARI',
    usr_col_user: 'KULLANICI', usr_col_role: 'ROL', usr_col_status: 'DURUM', usr_col_last: 'SON GİRİŞ',
    usr_enabled: 'AKTİF', usr_disabled: 'KAPALI', usr_never: 'hiç', usr_you: 'SEN',
    usr_none: 'Bu franchise için henüz kullanıcı yok.',
    usr_make_admin: 'YÖNETİCİ YAP', usr_make_staff: 'PERSONEL YAP',
    usr_disable: 'KAPAT', usr_enable: 'AÇ', usr_delete: 'SİL',
    usr_role_confirm: '{email} rolü {role} olsun mu?',
    usr_disable_confirm: '{email} kapatılsın mı? Bu hesap artık giriş yapamaz.',
    usr_enable_confirm: '{email} yeniden açılsın mı?',
    usr_delete_confirm: '{email} kalıcı olarak silinsin mi? Konsol hesabı tamamen kaldırılır.',
    usr_saved: 'Kullanıcı güncellendi.', usr_deleted: 'Kullanıcı silindi.',
    usr_save_failed: 'Kullanıcı güncellenemedi: {code}',
    usr_load_failed: 'Kullanıcılar yüklenemedi: {code}',
    usr_create: 'KULLANICI OLUŞTUR', usr_create_btn: 'KULLANICI OLUŞTUR',
    usr_created: '{email} kullanıcısı oluşturuldu.',
    usr_create_failed: 'Kullanıcı oluşturulamadı: {code}',
    usr_bad_email: 'Geçerli bir e-posta adresi gir.',
    usr_bad_pass: 'Parola en az 8 karakter olmalı.',
    usr_hint: 'Parolalar burada bir kez belirlenir ve bir daha gösterilmez — yeni operatör kendi hesabından değiştirir.',
    usr_hint_super: 'Superadmin: tüm franchise’lar listelenir, kullanıcı başka bir tenant’a taşınabilir.',
    usr_tenant: 'FRANCHISE', usr_self_lockout: 'Kendi hesabının rolünü düşüremez veya hesabını kapatamazsın.',
    set_franchises: 'FRANCHISE’LAR', fr_new: '+ YENİ',
    fr_none: 'Bu hesap için görünür franchise yok.',
    fr_stations_n: '{n} istasyon', fr_users_n: '{n} kullanıcı',
    fr_create_btn: 'FRANCHISE OLUŞTUR',
    fr_created: '{id} franchise’ı oluşturuldu.',
    fr_create_failed: 'Franchise oluşturulamadı: {code}',
    fr_bad_id: 'Franchise id’si 2-32 karakter a-z, 0-9 veya tire olmalı.',
    fr_bad_name: 'Franchise’a bir ad ver (1-60 karakter).',
    fr_bad_base: 'DPS adresi https:// ile başlamalı.',
    fr_bad_stations: 'En az bir havalimanı/konum ekle; her biri pozitif DPS id ve ad ister.',
    fr_hint_super: 'Franchise, kullanacağı havalimanlarıyla birlikte oluşturulur — konumu ara, sonra istasyona DPS id’sini ver.',
    fr_hint_admin: 'Franchise yalnızca superadmin tarafından oluşturulur. Kendi franchise’ının adını değiştirebilirsin.',
    fr_rename: 'ADINI DEĞİŞTİR', fr_rename_prompt: '{id} için yeni ad:',
    fr_saved: 'Franchise kaydedildi.', fr_save_failed: 'Franchise kaydedilemedi: {code}',
    fr_load_failed: 'Franchise’lar yüklenemedi: {code}',
    set_reports: 'RAPOR MAİLLERİ',
    set_reports_hint: 'Rapor maillerini kapatmak otomatik tarama ve pazar takibi maillerini yalnızca <b>bu</b> hesap için durdurur — diğer operatörler almaya devam eder.',
    reports_saved: 'Rapor maili tercihi kaydedildi.',
    vg_all: 'TÜM GRUPLAR', vg_all_btn: 'TÜMÜ', vg_none_btn: 'HİÇBİRİ',
    vg_save_btn: 'SET\u0130 KAYDET', vg_save_ph: 'Set ad\u0131 (\u00f6r. Ekonomi filo)',
    vg_saved: '"{name}" seti kaydedildi.', vg_del_confirm: '"{name}" seti silinsin mi?',
    vg_pick_first: '\u00d6nce en az bir ara\u00e7 grubu se\u00e7.',
    vg_name_first: '\u00d6nce sete bir isim ver.',
    vg_presets_hint: 'Kay\u0131tl\u0131 setler \u2014 t\u0131klad\u0131\u011f\u0131nda tam olarak o gruplar se\u00e7ilir.',
    vg_selected: '{n}/{total} seçili',
    vg_loading: 'Araç grupları yükleniyor…',
    vg_unavailable: 'Araç grupları için canlı bir DPS oturumu gerekir — boş bırakırsan tüm gruplar hedeflenir.',
    vg_groups: 'grup',
    bulk_btn: 'HAFTALIK KURALLAR', bulk_title: 'HAFTALIK KURALLAR',
    bulk_start: 'BAŞLANGIÇ TARİHİ',
    bulk_end: 'B\u0130T\u0130\u015e TAR\u0130H\u0130',
    bulk_range_bad: 'Biti\u015f tarihi ba\u015flang\u0131\u00e7tan \u00f6nce olamaz.',
    bulk_range_long: 'Bu aral\u0131k \u00e7ok uzun \u2014 en fazla 400 g\u00fcn se\u00e7.',
    bulk_horizon: 'UFUK', bulk_pct: 'YÜZDE',
    bulk_groups: 'ARAÇ GRUPLARI', bulk_skip: 'VAR OLANI ATLA',
    bulk_apply: 'UYGULA', bulk_cancel: 'ÇALIŞMAYI DURDUR',
    bulk_preview: 'En fazla <b>{n}</b> kural oluşturur — {from} &rarr; {to}',
    bulk_preview_bad: 'Başlangıç tarihi, en az bir süre ve bir yüzde seç.',
    bulk_confirm: '{station} için {pct}% ile en fazla {n} kural oluşturulsun mu — {from} ile {to} arası · {groups}?',
    bulk_running: 'OLUŞTURULUYOR {done}/{total} · {ok} tamam · {fail} başarısız',
    bulk_done: 'Haftalık kurallar oluşturuldu: {ok} tamam, {fail} başarısız.',
    bulk_skipped_cov: '{n} hücre atlandı: mevcut kural farklı araç gruplarını kapsıyor.',
    bulk_failed: 'Toplu oluşturma başarısız: {code}',
    bulk_cancel_confirm: 'Çalışan toplu oluşturma durdurulsun mu? Yazılmış kurallar DPS’te kalır.',
    bulk_cancelled: 'Toplu oluşturma iptal edildi.',
    bulk_bad_date: 'Gerçek bir başlangıç tarihi seç, en fazla 24 ay ilerisi.',
    bulk_bad_pct: '-95 ile 100 arasında bir yüzde gir.',
    bulk_bad_durs: 'En az bir süre seç.',
    batch_bulk_label: 'HAFTALIK KURALLAR · {n} OLUŞTURULDU',
    bulk_fu_q: 'Kurallar DPS’te. Nasıl fiyatlansın?',
    bulk_fu_manual: 'MANUEL', bulk_fu_manual_d: 'Burada kapat — yeni kuralları tabloda elle fiyatlarsın.',
    bulk_fu_scan: 'RAKİP ANALİZİ',
    bulk_fu_scan_d: 'Kategori TARAMASINI tam olarak bu günler ve süreler üzerinde çalıştırır; turuncu önerileri incele ve UYGULA.',
    bulk_fu_scope: 'Tarama bu partinin {month} içindeki {n} gününü kapsar — öneriler ay ay hazırlanır.',
    bulk_fu_none: 'Yeni günlerin hiçbiri ekrandaki ayda değil — o ayı aç ve TARA’yı orada çalıştır.',
  },
};

let LANG = localStorage.getItem('lang') || 'en';
if (!I18N[LANG]) LANG = 'en';

function t(k, vars) {
  let s = (I18N[LANG] && I18N[LANG][k]) || I18N.en[k] || k;
  if (vars) for (const [name, v] of Object.entries(vars)) s = s.replaceAll(`{${name}}`, v);
  return s;
}

function applyLang(lang) {
  if (!I18N[lang]) return;
  LANG = lang;
  localStorage.setItem('lang', lang);
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18n);
  });
  if ($('scanBtn')) $('scanBtn').title = t('scan_tip'); // titles are outside data-i18n

  // re-render the dynamic surfaces that hold visible text
  renderSideUser();
  if (typeof renderDashTiles === 'function' && state.stations.length) {
    try { renderDashTiles(); renderDashboard(); } catch {}
  }
  if (state.watchInfo) try { renderWatchRows(state.watchInfo); renderRelayChip(); } catch {}
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  if (state.view === 'settings') try { renderSettings(); } catch {}
  if (state.view === 'users') try { renderUsersView(); } catch {}
  if (state.view === 'analytics') try { renderInsights(); } catch {}
}

// rentalcars.com deep-link templates (formats verified live against their
// search widget; opening these is plain browsing in the user's own browser).
// Hand-tuned Zurich entries only — rcLocationOf() uses them purely as extra
// precision on top of the tenant's rc config, never instead of it.
const RC_LOCATIONS = {
  61489: {
    ftsType: 'A', ftsEntry: 'ZRH', iata: 'ZRH',
    name: 'Zurich Airport',
    coords: '47.451900482177734,8.562809944152832',
  },
  61551: {
    ftsType: 'L', ftsEntry: '', iata: '',
    name: 'Zürich Hauptbahnhof',
    coords: '47.37798309326172,8.539767265319824',
  },
};

// Pickup/dropoff clock, Berkay's spec (2026-08-28): start at 19:00, step DOWN
// half an hour per rentalcars open (modal query, OPEN ON RENTALCARS, grid
// right-click) until 10:00, then wrap back to 19:00. Same-hour pickup and
// dropoff. 19 steps: 19:00, 18:30, … 10:30, 10:00.
// THE PICKUP RING: 09:00 through 19:00, HALF an hour apart (Berkay,
// 2026-08-30: "saat değişimleri her yarım saatte bir olsun 1 saat değil" —
// the 2026-08-29 ring was hourly). 21 slots, wrapping at both ends.
//
// Every query starts at 09:00. The ring advances on every cell/duration
// change, on REFRESH and after an APPLY; each slot is its own rentalcars
// search key, so a stepped clock is a question nobody can serve stale. The
// grid, the watcher and the auto-scan stay on RC_CANON (09:00) and the footer
// always names the slot that actually answered.
//
// A pricing rule is a PERCENTAGE covering every hour of the day, so one
// representative slot is not a compromise — it is the right unit of decision.
// Slots are DECIMAL hours (9, 9.5, …, 19); rcHH/rcMM render them for URLs.
const RC_START_HOUR = 9;
const RC_END_HOUR = 19;
const RC_HOURS = Array.from(
  { length: (RC_END_HOUR - RC_START_HOUR) * 2 + 1 },
  (_, i) => RC_START_HOUR + i / 2
);
const rcPad = (h) => String(h).padStart(2, '0');
const rcHH = (h) => rcPad(Math.floor(h));
const rcMM = (h) => (h % 1 ? '30' : '00');
// the canonical hour, for every query that must agree with the grid
const RC_CANON = `hh=${rcPad(RC_START_HOUR)}&mm=00`;

// the slot the analysis is currently asking about. Resets to 09:00 on reload;
// a stepped value persists while the console stays open so several days can be
// compared at the same slot without re-stepping each time.
let rcHour = RC_START_HOUR;

function currentRcTime() {
  return [rcHH(rcHour), rcMM(rcHour)];
}

/** move `h` around the ring by `dir` places, wrapping at both ends */
function rcHourAt(h, dir) {
  const n = RC_HOURS.length;
  const i = RC_HOURS.indexOf(h);
  return RC_HOURS[(((i < 0 ? 0 : i) + dir) % n + n) % n];
}

// rentalcars occasionally returns an EMPTY slot for one hour (measured 29 Aug,
// 19:00: zero offers market-wide). A blank table would read as "the market is
// gone", so the query walks the ring for the next hour that answers and the
// footer names it. Bounded to 3 steps: a market that is genuinely empty must
// not cost ten round trips.
function rcFallbackTimes(fromHour) {
  const out = [];
  let h = fromHour;
  for (let i = 0; i < 3; i++) {
    h = rcHourAt(h, 1);
    out.push([rcHH(h), rcMM(h)]);
  }
  return out;
}

/** the -/+ control in the analysis header */
function renderRcHour() {
  const el = $('rcHour');
  if (!el) return;
  el.innerHTML =
    `<button class="rc-hour-step" onclick="stepRcHour(-1)" title="${t('hour_prev')}">&minus;</button>` +
    `<span class="rc-hour-val">${rcHH(rcHour)}:${rcMM(rcHour)}</span>` +
    `<button class="rc-hour-step" onclick="stepRcHour(1)" title="${t('hour_next')}">+</button>`;
}

function stepRcHour(dir) {
  rcHour = rcHourAt(rcHour, dir);
  renderRcHour();
  // stepping while no cell is open just moves the ring; there is nothing to
  // re-query, and firing one would spend a market call on nobody's question.
  // ONE shared hour (Berkay, 2026-08-30): the pane follows the same step —
  // via the mirror when it sits on the panel's cell, else with its own draw.
  if (rcCtx) runRcAnalysis();
  if (rcWeb.day != null && !$('rcWeb').classList.contains('hidden') &&
      !(rcCtx && rcCtx.day === rcWeb.day && rcCtx.dur === rcWeb.dur)) runRcWeb();
}

// ---------- the embedded rentalcars pane (Berkay, 2026-08-30) ----------
// The pane shows rentalcars IN THE PAGE, between the grid and the analysis
// panel — "websitesinin içinde embed olması lazım". The real page cannot be
// iframed (rentalcars sends X-Frame-Options: SAMEORIGIN, measured
// 2026-08-30), so the pane renders the answer rentalcars serves instead.
//
// Round 5 (same day): ONE left-click drives BOTH views onto the same cell,
// at the SAME shared hour (`rcHour` — the panel's ring is the only clock),
// and the pane MIRRORS the panel's own answer rather than drawing its own:
// one query, one draw, two renderings — the two views can never disagree
// ("sonuçları eşit olması lazım doğruluktan dolayı"). The pane only fetches
// for itself in the rare moment it is pointed at a cell the panel does not
// own. The ↗ opens the real page 1:1 for eyeball checks.
const rcWeb = { day: null, dur: null, data: null, seq: 0 };

/** the animated loader both market views share while a live draw is running */
function rcLoadingHtml(label) {
  return `<div class="rc-loading"><span class="rc-spinner"></span><span class="rc-loading-txt">${label}</span></div>`;
}

function rcWebShow(day, dur) {
  // phones have no room for a third pane — hand the real site to a new tab
  if (window.innerWidth <= 780) {
    const url = rentalcarsUrl(day, dur, rcHH(rcHour), rcMM(rcHour));
    if (url) window.open(url, '_blank');
    return;
  }
  const prev = rcWeb.day != null ? { day: rcWeb.day, dur: rcWeb.dur } : null;
  rcWeb.day = day;
  rcWeb.dur = dur;
  $('rcWeb').classList.remove('hidden');
  $('rcWebSplitter').classList.remove('hidden');
  if (prev) refreshCell(prev.day, prev.dur); // the blue ring follows the pane
  refreshCell(day, dur);
  runRcWeb();
}

function rcWebHide() {
  const prev = rcWeb.day != null ? { day: rcWeb.day, dur: rcWeb.dur } : null;
  rcWeb.day = null;
  rcWeb.seq++; // orphan any in-flight answer
  $('rcWeb').classList.add('hidden');
  $('rcWebSplitter').classList.add('hidden');
  if (prev) refreshCell(prev.day, prev.dur); // drop the blue ring
}

/** Both side panes are PERMANENT on desktop (Berkay, 2026-08-30): the grid
 *  opens them by itself on the first future day, and a month or station
 *  switch re-targets them. The operator resizes; nothing closes. */
function ensureSidePanes() {
  if (window.innerWidth <= 780 || !state.grid || state.view !== 'grid') return;
  // the default cell must still be BOOKABLE: a 09:00 pickup that already
  // passed today answers "no offers", so the first day whose canonical
  // pickup lies in the future wins (today before 09:00, else tomorrow)
  const now = new Date();
  let d = 1;
  for (let i = 1; i <= state.grid.daysInMonth; i++) {
    if (new Date(state.year, state.month - 1, i, RC_START_HOUR, 0) > now) { d = i; break; }
  }
  const panelStale =
    !rcCtx || $('rcModal').classList.contains('hidden') ||
    rcCtx.station !== state.station || rcCtx.year !== state.year || rcCtx.month !== state.month;
  if (panelStale) openRcAnalysis(d, rcCtx ? rcCtx.dur : 3);
  if (rcWeb.day == null || $('rcWeb').classList.contains('hidden') || panelStale) {
    rcWebShow(rcCtx.day, rcCtx.dur); // the pane always sits on the panel's cell
  }
}

/** the pane's -/+ steps the SHARED hour — both views move together */
function rcWebStep(dir) {
  stepRcHour(dir);
}
window.rcWebStep = rcWebStep;

function rcWebHead(hh, mm) {
  $('rcWebTitle').textContent =
    `RENTALCARS — ${String(rcWeb.day).padStart(2, '0')} ${MONTHS_SHORT[state.month - 1]} · ` +
    `${rcWeb.dur >= OPEN_DURATION ? OPEN_DURATION + '+' : rcWeb.dur}D`;
  $('rcWebHour').textContent = `${hh}:${mm || '00'}`;
  const real = $('rcWebReal');
  real.href = rentalcarsUrl(rcWeb.day, rcWeb.dur, hh, mm || '00') || '#';
  real.title = t('rc_live_real');
}

async function runRcWeb() {
  const { day, dur } = rcWeb;
  if (day == null) return;
  const [hh, mm] = currentRcTime();
  rcWebHead(hh, mm);
  const seq = ++rcWeb.seq;
  const t0 = new Date();
  t0.setHours(0, 0, 0, 0);
  if (new Date(state.year, state.month - 1, day) < t0) {
    $('rcWebBody').innerHTML = `<div class="drawer-empty">${t('rc_past')}</div>`;
    $('rcWebMeta').textContent = '';
    return;
  }
  // MIRROR-FIRST: when the panel owns this cell, its (fresh, sampled) answer
  // is the single source for both views — render it, or wait for it to land
  // (renderRcTable mirrors on arrival). No second draw, no disagreement.
  if (rcCtx && rcCtx.day === day && rcCtx.dur === dur && !$('rcModal').classList.contains('hidden')) {
    if (rcCtx.data) rcWebMirror();
    else {
      $('rcWebBody').innerHTML = rcLoadingHtml(t('querying_at', { time: `${hh}:${mm}` }));
      $('rcWebMeta').textContent = '';
    }
    return;
  }
  $('rcWebBody').innerHTML = rcLoadingHtml(t('querying_at', { time: `${hh}:${mm}` }));
  $('rcWebMeta').textContent = '';
  try {
    // fallback for a cell the panel does not own: one fresh draw of its own
    const r = await api(
      `/api/rc-top?station=${state.station}&year=${state.year}&month=${state.month}&day=${day}&duration=${dur}&hh=${hh}&mm=${mm}&fresh=1&samples=2`
    );
    if (seq !== rcWeb.seq) return;
    rcWeb.data = r;
    renderRcWebList(r, `${hh}:${mm}`);
  } catch (e) {
    if (seq !== rcWeb.seq) return;
    $('rcWebBody').innerHTML = `<div class="drawer-empty">${rcErrorText(e.message)}</div>`;
  }
}

/** re-render the pane from the panel's OWN data — called by renderRcTable
 *  whenever the panel's answer changes, so the two views always show the
 *  same draw, the same hour, the same francs */
function rcWebMirror() {
  if ($('rcWeb').classList.contains('hidden') || rcWeb.day == null) return;
  if (!rcCtx || rcCtx.day !== rcWeb.day || rcCtx.dur !== rcWeb.dur || !rcCtx.data) return;
  rcWeb.seq++; // a mirror supersedes any in-flight own fetch
  rcWeb.data = rcCtx.data;
  rcWebHead(rcCtx.hh, String(rcCtx.mm).padStart(2, '0')); // the slot that ANSWERED
  renderRcWebList(rcCtx.data, `${rcCtx.hh}:${String(rcCtx.mm).padStart(2, '0')}`);
}

/** the pane's shop-style list: EVERY row the answer carries, GM highlighted,
 *  the same LIST/CUSTOMER convention as the analysis table */
function renderRcWebList(r, slot) {
  if (!r || !r.top || !r.top.length) {
    $('rcWebBody').innerHTML = `<div class="drawer-empty">${t('no_offers')}</div>`;
    return;
  }
  const rows = r.top
    .map((x, i) => {
      const isGm = /green motion/i.test(x.supplier || '');
      const before = typeof x.before === 'number' && x.before > x.price ? x.before : null;
      return `<tr class="${isGm ? 'rc-gm' : ''}">
        <td class="rc-rank">${i + 1}</td>
        <td class="rc-sup">${logoImg(x)}${esc(x.supplier)}</td>
        <td>${esc(x.vehicle)}</td>
        <td class="rc-gear">${x.gear === 'A' ? 'AUTO' : x.gear === 'M' ? 'MAN' : '—'}</td>
        <td class="rc-price rc-list">${(before != null ? before : x.price).toFixed(2)}</td>
        <td class="rc-price rc-cust">${x.price.toFixed(2)}&nbsp;${esc(x.currency)}</td>
      </tr>`;
    })
    .join('');
  $('rcWebBody').innerHTML = `<table class="rc-table rc-web-table">
    <thead><tr><th></th><th>SUPPLIER</th><th>VEHICLE</th><th class="rc-gear">${t('rc_col_gear')}</th><th class="rc-price rc-list">${t('rc_col_list')}</th><th class="rc-price">${t('rc_col_customer')}</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  const atTs = r.at || r.cachedAt;
  $('rcWebMeta').textContent =
    `${r.total} ${t('offers')} · ${t('pickup')} ${slot || `${rcHH(rcHour)}:${rcMM(rcHour)}`}` +
    (atTs ? ` · ${t('query_at', { time: new Date(atTs).toLocaleTimeString('de-CH', { hour12: false }) })}` : '') +
    (r.stale ? ` · ${t('stale_cache')}` : '') +
    (r.spread ? ` · GM ±${r.spread}%` : '');
}

// After an APPLY both views follow on their own (Berkay: "onayladığında
// saatler otomatik değişip refreshlenip ekrana gelsin"): the apply handler
// steps the shared hour and re-queries the panel (the pane mirrors it), and
// ~90s later — when rentalcars has had time to propagate — one more shared
// step re-asks again. Two hours, refreshed without a click.
let rcLiveTimer = null;

function rcLiveFollowUp(day, dur) {
  rcWebShow(day, dur); // opens the pane if closed; mirrors the panel's query
  clearTimeout(rcLiveTimer);
  rcLiveTimer = setTimeout(() => {
    if (rcWeb.day !== day || rcWeb.dur !== dur) return; // the operator moved on
    if (!rcCtx || rcCtx.day !== day || rcCtx.dur !== dur) return;
    rcHour = rcHourAt(rcHour, 1);
    renderRcHour();
    runRcAnalysis(); // the pane mirrors the landing
  }, 90 * 1000);
}

window.stepRcHour = stepRcHour;

/** Deep-link config for a station: the tenant's own rc config decides where the
 *  link points — otherwise repointing a station in Settings would keep opening
 *  the old city. The hand-tuned table below only survives while it still names
 *  the same place (it carries exact coordinates the rc config has no room for). */
function rcLocationOf(id) {
  const st = state.stations.find((x) => x.id === id);
  if (!st || !st.rc || !st.rc.loc) return RC_LOCATIONS[id] || null;
  const tuned = RC_LOCATIONS[id];
  if (tuned && st.rc.loc === (st.rc.type === 'IATA' ? tuned.iata : tuned.coords)) return tuned;
  return st.rc.type === 'IATA'
    ? { ftsType: 'A', ftsEntry: st.rc.loc, iata: st.rc.loc, name: st.rc.label || st.name, coords: '' }
    : { ftsType: 'L', ftsEntry: '', iata: '', name: st.rc.label || st.name, coords: st.rc.loc };
}

function rentalcarsUrl(day, dur, fixedHh, fixedMm) {
  const cfg = rcLocationOf(state.station);
  if (!cfg) return null;
  const [hh, mm] = fixedHh != null ? [fixedHh, fixedMm] : currentRcTime();
  const pu = new Date(state.year, state.month - 1, day, 10, 0);
  const dropoff = new Date(pu.getTime() + dur * 86400000);
  const p = new URLSearchParams();
  p.set('puDay', pu.getDate());
  p.set('puMonth', pu.getMonth() + 1);
  p.set('puYear', pu.getFullYear());
  p.set('puHour', hh);
  p.set('puMinute', mm);
  p.set('doDay', dropoff.getDate());
  p.set('doMonth', dropoff.getMonth() + 1);
  p.set('doYear', dropoff.getFullYear());
  p.set('doHour', hh);
  p.set('doMinute', mm);
  p.set('driversAge', '30');
  p.set('filterCriteria_sortBy', 'PRICE');
  p.set('filterCriteria_sortAscending', 'true');
  p.set('ftsType', cfg.ftsType);
  p.set('dropFtsType', cfg.ftsType);
  if (cfg.ftsEntry) p.set('ftsEntry', cfg.ftsEntry);
  p.set('locationName', cfg.name);
  p.set('dropLocationName', cfg.name);
  if (cfg.iata) {
    p.set('locationIata', cfg.iata);
    p.set('dropLocationIata', cfg.iata);
  }
  if (cfg.coords) {
    p.set('coordinates', cfg.coords);
    p.set('dropCoordinates', cfg.coords);
  }
  return 'https://www.rentalcars.com/search-results?' + p.toString();
}

// ---------- dialogs (prompt/confirm are unavailable in some embedded browsers) ----------

function dialogBox({ text, input = false, value = '' }) {
  return new Promise((resolve) => {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    bd.innerHTML = `<div class="modal modal-sm">
      <div class="modal-body">
        <p class="modal-text">${text}</p>
        ${input ? '<input type="text" class="field-input" id="dlgInput" spellcheck="false">' : ''}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="dlgCancel">CANCEL</button>
        <button class="btn btn-primary" id="dlgOk">OK</button>
      </div></div>`;
    document.body.appendChild(bd);
    const inp = bd.querySelector('#dlgInput');
    if (inp) {
      inp.value = value;
      inp.focus();
      inp.select();
    }
    const done = (v) => {
      bd.remove();
      resolve(v);
    };
    bd.querySelector('#dlgOk').onclick = () => done(input ? inp.value : true);
    bd.querySelector('#dlgCancel').onclick = () => done(null);
    bd.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') { e.preventDefault(); done(input ? inp.value : true); }
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
      },
      true
    );
  });
}

const confirmBox = (text) => dialogBox({ text });
const inputBox = (text, value) => dialogBox({ text, input: true, value });

/** Modal with N labelled choices; resolves the chosen value (null on cancel). */
function choiceBox(text, options) {
  return new Promise((resolve) => {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    bd.innerHTML = `<div class="modal modal-sm">
      <div class="modal-body">
        <p class="modal-text">${text}</p>
        <div class="choice-list">${options
          .map(
            (o, i) => `<button class="choice-opt" data-i="${i}">
              <span class="choice-title">${esc(o.title)}</span>
              <span class="choice-desc">${esc(o.desc || '')}</span>
            </button>`
          )
          .join('')}</div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="dlgCancel">${t('cancel')}</button>
      </div></div>`;
    document.body.appendChild(bd);
    const done = (v) => { bd.remove(); resolve(v); };
    bd.querySelectorAll('.choice-opt').forEach((b) =>
      (b.onclick = () => done(options[Number(b.dataset.i)].value))
    );
    bd.querySelector('#dlgCancel').onclick = () => done(null);
    bd.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    }, true);
  });
}

/** Multi-select dialog. `options` are {value,title,desc,ico,checked}; resolves
 *  to the chosen values, or null when the operator backs out. */
function multiChoiceBox(text, options, { note = '' } = {}) {
  return new Promise((resolve) => {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    bd.innerHTML = `<div class="modal modal-sm">
      <div class="modal-body">
        <p class="modal-text">${text}</p>
        <div class="multi-list">${options
          .map(
            (o, i) => `<label class="multi-opt">
              <input type="checkbox" data-i="${i}"${o.checked ? ' checked' : ''}>
              <span class="multi-ico">${o.ico || ''}</span>
              <span class="multi-text">
                <span class="multi-title">${esc(o.title)}</span>
                <span class="multi-desc">${esc(o.desc || '')}</span>
              </span>
            </label>`
          )
          .join('')}</div>
        ${note ? `<p class="multi-note">${note}</p>` : ''}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="dlgCancel">${t('cancel')}</button>
        <button class="btn btn-ghost" id="dlgAll">${t('select_all')}</button>
        <button class="btn btn-primary" id="dlgOk">${t('ok')}</button>
      </div></div>`;
    document.body.appendChild(bd);
    const boxes = [...bd.querySelectorAll('input[type=checkbox]')];
    const ok = bd.querySelector('#dlgOk');
    // an empty selection would price nothing, so it cannot be confirmed
    const sync = () => (ok.disabled = !boxes.some((b) => b.checked));
    boxes.forEach((b) => (b.onchange = sync));
    sync();
    const done = (v) => { bd.remove(); resolve(v); };
    bd.querySelector('#dlgAll').onclick = () => { boxes.forEach((b) => (b.checked = true)); sync(); };
    ok.onclick = () => done(boxes.filter((b) => b.checked).map((b) => options[Number(b.dataset.i)].value));
    bd.querySelector('#dlgCancel').onclick = () => done(null);
    bd.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    }, true);
  });
}

// ---------- toasts ----------

function toast(msg, cls) {
  const el = document.createElement('div');
  el.className = 'toast' + (cls ? ' toast-' + cls : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ---------- api ----------

// Cloud Run runs this console on a single instance on purpose (the DPS write
// queue and the relay job queue are in-memory). The cost is that while that one
// instance is replaced — a deploy, or a restart — there is no spare capacity,
// and every request in that window comes back 429 "Rate exceeded". The window
// is seconds, so it is a transient to ride out, not an error to show the
// operator. 502/503/504 from the same swap are treated the same way.
// A 429 here is Cloud Run's "The request was aborted because there was no
// available instance": the console is pinned to ONE instance (its DPS write
// queue and relay job queue live in that process's memory), so a burst has no
// second instance to spill into. The request never reached the app — nothing
// ran, nothing was written — so replaying it is safe for ANY method.
// 502/503/504 are different: those can mean the request DID execute and the
// answer was lost, so only reads are replayed on those.
const API_RETRY_ANY_METHOD = new Set([429]);
const API_RETRY_READS_ONLY = new Set([502, 503, 504]);
// ~30s of cover. A scan that dies halfway leaves the price table half-written,
// so waiting out a burst beats surfacing an error.
const API_RETRY_DELAYS = [600, 1500, 3500, 7000, 15000];
const jitter = (ms) => ms * (0.75 + Math.random() * 0.5); // spread retries out

// how much back-pressure the server is under right now, so callers that loop
// (the SCAN) can slow themselves down instead of making it worse
const apiPressure = { hits: 0, until: 0, reason: null };
const apiThrottled = () => Date.now() < apiPressure.until;

/** A visible "the console is pacing itself" chip. Silence during a self-imposed
 *  wait is what makes a limit feel like a crash — the operator must be able to
 *  see that the app is deliberately waiting, and for how long. */
function renderPressureChip() {
  const el = $('pressureChip');
  if (!el) return;
  const left = Math.ceil((apiPressure.until - Date.now()) / 1000);
  if (left <= 0) {
    el.classList.add('hidden');
    apiPressure.reason = null;
    return;
  }
  el.classList.remove('hidden');
  el.textContent = t(apiPressure.reason === 'limit' ? 'cap_limit' : 'cap_busy', { s: left });
}
setInterval(renderPressureChip, 1000);

async function api(path, opts = {}) {
  const body = opts.body ? JSON.stringify(opts.body) : undefined;
  const idempotent = !opts.method || String(opts.method).toUpperCase() === 'GET';
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body,
    });
    const retryable =
      API_RETRY_ANY_METHOD.has(res.status) ||
      (idempotent && API_RETRY_READS_ONLY.has(res.status));
    if (!retryable || attempt >= API_RETRY_DELAYS.length) break;
    let wait = jitter(API_RETRY_DELAYS[attempt]);
    if (res.status === 429) {
      // tell the looping callers to ease off for a while
      apiPressure.hits++;
      apiPressure.until = Date.now() + 20000;
      // OUR OWN capacity guard answers with Retry-After — honour it exactly
      // instead of guessing, and let the operator see why they are waiting
      const ra = Number(res.headers.get('Retry-After'));
      if (isFinite(ra) && ra > 0) {
        wait = Math.min(ra * 1000, 30000);
        apiPressure.until = Date.now() + wait + 2000;
        apiPressure.reason = ra >= 10 ? 'limit' : 'busy';
      }
    }
    await new Promise((r) => setTimeout(r, wait));
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // NOT_SIGNED_IN = the operator cookie is gone, i.e. the Firebase layer —
    // re-mint it from the live Firebase session instead of dumping the
    // operator at the DPS modal, which is the wrong step entirely.
    if (data.error === 'NOT_SIGNED_IN') {
      const u = fbAuth() && fbAuth().currentUser;
      if (u) {
        try { await postAuthSession(u, true); } catch { showAuthGate(t('auth_expired')); }
      } else {
        showAuthGate('');
      }
      throw new Error('NOT_SIGNED_IN');
    }
    // SESSION_REPLACED = another operator's DPS login bumped the generation, so
    // this cookie died while the Firebase identity behind it is still valid.
    // Re-mint it too; only when that fails is the DPS modal the right step.
    if (data.error === 'SESSION_REPLACED') {
      const u = fbAuth() && fbAuth().currentUser;
      if (u) {
        let reminted = false;
        try { await postAuthSession(u, true); reminted = true; } catch {}
        if (reminted) throw new Error('SESSION_REPLACED');
      }
    }
    setSession(false);
    openSessionModal(
      data.error === 'SESSION_REPLACED'
        ? t('session_replaced')
        : data.error === 'SESSION_EXPIRED' ? 'Session expired — paste a fresh cookie.' : ''
    );
    throw new Error(data.error || 'NO_SESSION');
  }
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

// ---------- Firebase sign-in gate (step 1: the console itself) ----------
// Firebase Auth is the app gate. The verified ID token is exchanged for the
// console's own operator cookie by POST /api/auth/session, which also resolves
// the account's role. The DPS login below is a SECOND, separate step.

const fbAuth = () => (window.firebase && firebase.apps.length ? firebase.auth() : null);
let authTimer = null;  // 50-min ID-token refresh
let booted = false;    // init() runs exactly once, after the first exchange

function showAuthGate(err) {
  $('authGate').classList.remove('hidden');
  $('authError').classList.toggle('hidden', !err);
  $('authError').textContent = err || '';
  if (!$('authEmail').value) $('authEmail').focus();
}

function hideAuthGate() {
  $('authGate').classList.add('hidden');
  $('authError').classList.add('hidden');
  $('authError').textContent = '';
}

/** Trade the Firebase ID token for the operator cookie; resolves {email, role}. */
async function postAuthSession(user, fresh) {
  const idToken = await user.getIdToken(!!fresh);
  // This re-mints the operator cookie, and it must ride out a 429 the same way
  // every other call does. It used to be a bare fetch: one aborted request
  // during a burst read as "signed out", which dropped the session and killed
  // whatever long run (a SCAN) was in progress.
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (res.status !== 429 || attempt >= API_RETRY_DELAYS.length) break;
    apiPressure.hits++;
    apiPressure.until = Date.now() + 20000;
    await new Promise((r) => setTimeout(r, jitter(API_RETRY_DELAYS[attempt])));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || 'HTTP ' + res.status);
  state.account = data.email || user.email || null;
  state.role = data.role === 'admin' ? 'admin' : 'staff';
  renderSideUser();
  applyRoleUi();
  return data;
}

function startAuth() {
  const auth = fbAuth();
  if (!auth) { showAuthGate(t('auth_sdk_failed')); return; }
  auth.onAuthStateChanged(async (user) => {
    clearInterval(authTimer);
    authTimer = null;
    if (!user) {
      state.account = null;
      state.role = null;
      showAuthGate('');
      return;
    }
    try {
      await postAuthSession(user, false);
    } catch (e) {
      showAuthGate(t('auth_failed', { code: e.message }));
      return;
    }
    hideAuthGate();
    // the operator cookie must never outlive the Firebase session
    authTimer = setInterval(() => {
      const u = fbAuth() && fbAuth().currentUser;
      if (u) postAuthSession(u, true).catch(() => {});
    }, 50 * 60 * 1000);
    if (!booted) { booted = true; init(); }
    else loadStationMeta().catch(() => {});
  });
}

async function doAuthSignIn() {
  const email = $('authEmail').value.trim();
  const pass = $('authPass').value;
  if (!email || !pass) { showAuthGate(t('auth_missing')); return; }
  const btn = $('authBtn');
  btn.disabled = true;
  btn.textContent = t('auth_signing_in');
  $('authGate').classList.add('auth-busy');
  try {
    await fbAuth().signInWithEmailAndPassword(email, pass);
    $('authPass').value = ''; // onAuthStateChanged takes it from here
  } catch (e) {
    const code = String((e && e.code) || '');
    showAuthGate(
      /wrong-password|user-not-found|invalid-credential|invalid-email/.test(code)
        ? t('auth_wrong')
        : t('auth_failed', { code: code || e.message })
    );
  } finally {
    btn.disabled = false;
    btn.textContent = t('auth_signin');
    $('authGate').classList.remove('auth-busy');
  }
}

$('authBtn').onclick = doAuthSignIn;
$('authEmail').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('authPass').focus(); }
});
$('authPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doAuthSignIn();
});

/** Sign out of both layers — Firebase first, so nothing re-mints the cookie. */
async function signOutAll() {
  clearInterval(authTimer);
  authTimer = null;
  const a = fbAuth();
  if (a) { try { await a.signOut(); } catch {} }
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  location.reload();
}

const isAdmin = () => state.role === 'admin';
const isSuperadmin = () => isAdmin() && state.superadmin === true;

// every routable view id, in sidebar order — 'users' is admin-only and the
// router bounces staff off it even if they type the hash by hand
const VIEWS = ['dashboard', 'grid', 'analytics', 'activity', 'users', 'settings'];

/** Show/hide everything the role decides. Safe to call before the DOM settles. */
function applyRoleUi() {
  const admin = isAdmin();
  if ($('navUsers')) $('navUsers').classList.toggle('hidden', !admin);
  // C3: the relay card is an admin tool — the topbar relay chip stays for all
  if ($('setRelayCardWrap')) $('setRelayCardWrap').classList.toggle('hidden', !admin);
  if ($('setFranchiseCard')) $('setFranchiseCard').classList.toggle('hidden', !admin);
  if ($('setPurgeCard')) {
    $('setPurgeCard').classList.toggle('hidden', !admin);
    if (admin) renderPurgeCard();
  }
  if ($('gridResetBtn')) $('gridResetBtn').classList.toggle('hidden', !admin);
  if ($('gridCopyBtn')) $('gridCopyBtn').classList.toggle('hidden', !admin);
  if (!admin && state.view === 'users') showView('dashboard');
}

// ---------- station rule reset (admin only, destructive) ----------

function renderPurgeCard() {
  const sel = $('purgeStation');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = state.stations
    .map((st) => `<option value="${st.id}">${esc(st.name)}</option>`)
    .join('');
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  syncPurgePlaceholder();
}

/** Spell out the exact words to type. A confirmation the operator has to guess
 *  is a trap, not a safeguard. */
function syncPurgePlaceholder() {
  const sel = $('purgeStation');
  const box = $('purgeConfirm');
  if (!sel || !box) return;
  const st = state.stations.find((x) => x.id === Number(sel.value));
  box.placeholder = st ? t('purge_ph_named', { s: st.name }) : t('purge_ph');
}

if ($('purgeStation')) $('purgeStation').addEventListener('change', syncPurgePlaceholder);

async function runPurge() {
  const sel = $('purgeStation');
  const station = Number(sel && sel.value);
  const st = state.stations.find((x) => x.id === station);
  if (!st) { toast(t('purge_pick'), 'warn'); return; }
  // the typed name is the confirmation the server checks too — a mistyped or
  // absent one is refused there, so this can never fire on the wrong station
  const norm = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (norm($('purgeConfirm').value) !== norm(st.name)) {
    toast(t('purge_confirm_bad', { s: st.name }), 'warn');
    return;
  }
  if (!(await confirmBox(t('purge_confirm_q', { s: st.name })))) return;

  $('purgeBtn').disabled = true;
  $('purgeRows').innerHTML = `<div class="stat-row"><span>${t('purge_running')}</span><b>…</b></div>`;
  try {
    const r = await api('/api/rules/purge', {
      method: 'POST',
      body: { station, confirm: st.name },
    });
    if (!r.jobId) {
      $('purgeRows').innerHTML = `<div class="stat-row"><span>${t('purge_none')}</span><b>0</b></div>`;
      toast(t('purge_none'));
      return;
    }
    toast(t('purge_started', { n: r.total }));
    let last = null;
    for (let i = 0; i < 900; i++) {
      await new Promise((res) => setTimeout(res, i < 10 ? 1500 : 4000));
      let s2;
      try { s2 = await api(`/api/rules/purge/${encodeURIComponent(r.jobId)}`); }
      catch { continue; }
      last = s2;
      $('purgeRows').innerHTML =
        `<div class="stat-row"><span>${t('purge_progress')}</span><b>${s2.done} / ${s2.total}</b></div>` +
        `<div class="stat-row"><span>${t('purge_backup')}</span><b>${esc(s2.backup || '—')}</b></div>`;
      if (s2.status !== 'running') break;
    }
    if (last && last.status === 'done') {
      toast(t('purge_done', { ok: last.ok, fail: last.fail }), last.fail ? 'warn' : undefined);
    } else if (last) {
      toast(t('purge_failed', { code: last.error || last.status }), 'error');
    }
    // the grid must not keep showing rules that are gone
    state.monthCache.clear();
    if (state.view === 'grid') loadGrid();
  } catch (e) {
    toast(t('purge_failed', { code: String((e && e.message) || '') }), 'error');
  } finally {
    $('purgeBtn').disabled = false;
    $('purgeConfirm').value = '';
  }
}

if ($('purgeBtn')) $('purgeBtn').onclick = runPurge;

// ---------- grid-topbar station maintenance (admin only) ----------

/** RESET on the grid: wipe this station's console-written weekly rules, fast.
 *  One "are you sure" (Berkay asked for speed here); the server still takes a
 *  restore point first and never touches hand-made DPS rules. */
async function gridReset() {
  const st = state.stations.find((x) => x.id === state.station);
  if (!st) return;
  if (!(await confirmBox(t('reset_confirm', { s: st.name })))) return;
  $('gridResetBtn').disabled = true;
  try {
    const r = await api('/api/rules/purge', {
      method: 'POST',
      body: { station: st.id, confirm: st.name },
    });
    if (!r.jobId) { toast(t('purge_none')); return; }
    toast(t('purge_started', { n: r.total }));
    let last = null;
    for (let i = 0; i < 900; i++) {
      await new Promise((res) => setTimeout(res, i < 10 ? 1500 : 4000));
      try { last = await api(`/api/rules/purge/${encodeURIComponent(r.jobId)}`); } catch { continue; }
      $('syncChip').classList.remove('hidden');
      $('syncChip').textContent = `${t('purge_progress')} ${last.done}/${last.total}`;
      if (last.status !== 'running') break;
    }
    $('syncChip').classList.add('hidden');
    if (last && last.status === 'done') toast(t('purge_done', { ok: last.ok, fail: last.fail }), last.fail ? 'warn' : undefined);
    else toast(t('purge_failed', { code: (last && (last.error || last.status)) || '?' }), 'error');
    state.monthCache.clear();
    loadGrid();
  } catch (e) {
    toast(t('purge_failed', { code: String((e && e.message) || '') }), 'error');
  } finally {
    $('gridResetBtn').disabled = false;
  }
}

/** COPY TO…: paste this station's weekly rules onto a sibling station — the
 *  "back them up onto Downtown before resetting the Airport" flow. The target
 *  is a LIVE station, so the confirm says exactly that. */
async function gridCopy() {
  const from = state.stations.find((x) => x.id === state.station);
  const targets = state.stations.filter((x) => x.id !== state.station);
  if (!from || !targets.length) { toast(t('copy_no_target'), 'warn'); return; }
  const to = targets.length === 1
    ? targets[0].id
    : await choiceBox(t('copy_pick_q'), targets.map((x) => ({ value: x.id, title: x.name, desc: '' })));
  if (!to) return;
  const target = targets.find((x) => x.id === to);
  if (!(await confirmBox(t('copy_confirm', { from: from.name, to: target.name })))) return;
  $('gridCopyBtn').disabled = true;
  try {
    const r = await api('/api/rules/copy', { method: 'POST', body: { from: from.id, to } });
    if (!r.jobId) { toast(t('copy_none')); return; }
    toast(t('copy_started', { n: r.total, s: target.name }));
    let last = null;
    for (let i = 0; i < 900; i++) {
      await new Promise((res) => setTimeout(res, i < 10 ? 2000 : 5000));
      try { last = await api(`/api/rules/copy/${encodeURIComponent(r.jobId)}`); } catch { continue; }
      $('syncChip').classList.remove('hidden');
      $('syncChip').textContent = `${t('copy_progress')} ${last.done}/${last.total}`;
      if (last.status !== 'running') break;
    }
    $('syncChip').classList.add('hidden');
    if (last && last.status === 'done') toast(t('copy_done', { ok: last.ok, fail: last.fail }), last.fail ? 'warn' : undefined);
    else toast(t('copy_failed', { code: (last && (last.error || last.status)) || '?' }), 'error');
  } catch (e) {
    toast(t('copy_failed', { code: String((e && e.message) || '') }), 'error');
  } finally {
    $('gridCopyBtn').disabled = false;
  }
}

if ($('gridResetBtn')) $('gridResetBtn').onclick = gridReset;
if ($('gridCopyBtn')) $('gridCopyBtn').onclick = gridCopy;

// ---------- session ----------

function setSession(ok) {
  state.session = ok;
  if (!ok) state.user = null;
  $('sessionChip').innerHTML = ok
    ? '<span class="dot dot-green"></span>SESSION ACTIVE'
    : '<span class="dot dot-red"></span>NO SESSION';
  $('sessionBtn').textContent = ok ? 'RECONNECT' : 'CONNECT';
  renderSideUser();
}

function openSessionModal(err) {
  $('loginError').classList.toggle('hidden', !err);
  $('loginError').textContent = err || '';
  $('sessionModal').classList.remove('hidden');
  $('userInput').focus();
}

$('sessionBtn').onclick = () => openSessionModal('');
$('loginCancel').onclick = () => $('sessionModal').classList.add('hidden');

async function doLogin(retried) {
  const username = $('userInput').value.trim();
  const password = $('passInput').value;
  if (!username || !password) {
    $('loginError').classList.remove('hidden');
    $('loginError').textContent = 'Enter both username and password.';
    return;
  }
  $('loginSave').disabled = true;
  $('loginSave').textContent = 'SIGNING IN…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    $('sessionModal').classList.add('hidden');
    $('passInput').value = '';
    state.user = username;
    setSession(true);
    toast(t('t_connected'));
    if (!state.stations.length) { location.reload(); return; } // init ran unauthenticated
    loadVendors();
    loadVehicleGroups();
    await loadGrid();
    renderDashboard();
  } catch (e) {
    // This raw fetch bypasses api(), so it has to heal the operator cookie
    // itself: /api/login sits behind the middleware, and the cookie can die
    // between opening this modal and submitting it (another operator's DPS
    // login bumped the generation, or the 12h TTL ran out in a background
    // tab). Re-mint from the live Firebase session and retry once.
    if (!retried && (e.message === 'NOT_SIGNED_IN' || e.message === 'SESSION_REPLACED')) {
      const u = fbAuth() && fbAuth().currentUser;
      if (u) {
        try {
          await postAuthSession(u, true);
          return await doLogin(true);
        } catch { showAuthGate(t('auth_expired')); return; }
      }
      showAuthGate('');
      return;
    }
    $('loginError').classList.remove('hidden');
    $('loginError').textContent =
      e.message === 'LOGIN_FAILED'
        ? 'Login failed — check username / password.'
        : 'Connection failed: ' + e.message;
  } finally {
    $('loginSave').disabled = false;
    $('loginSave').textContent = 'SIGN IN';
  }
}

$('loginSave').onclick = () => doLogin();
$('passInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

// ---------- controls ----------

function renderStations() {
  const wrap = $('stationTabs');
  wrap.innerHTML = '';
  for (const s of state.stations) {
    const b = document.createElement('button');
    b.className = 'station-tab' + (s.id === state.station ? ' on' : '');
    // the rentalcars location rides along: every rc query for this tab uses it
    const loc = s.rc && s.rc.label ? s.rc.label : '';
    b.innerHTML = esc(String(s.name).toUpperCase()) +
      (loc ? `<span class="st-loc">${s.rc.type === 'IATA' ? '&#9992; ' : ''}${esc(loc)}</span>` : '');
    b.title = loc ? `${s.id} · ${loc}` : String(s.id);
    b.onclick = async () => {
      if (state.applying) return;
      if (state.staged.size && !(await confirmBox('Discard staged changes?'))) return;
      state.staged.clear();
      state.station = s.id;
      renderStations();
      loadGrid();
    };
    wrap.appendChild(b);
  }
}

async function shiftMonth(delta) {
  if (state.applying) return;
  if (state.staged.size && !(await confirmBox('Discard staged changes?'))) return;
  state.staged.clear();
  let m = state.month + delta;
  if (m < 1) { m = 12; state.year--; }
  if (m > 12) { m = 1; state.year++; }
  state.month = m;
  loadGrid();
}

$('prevMonth').onclick = () => shiftMonth(-1);
$('nextMonth').onclick = () => shiftMonth(1);
$('reloadBtn').onclick = () => !state.applying && loadGrid();

// ---------- grid ----------

let es = null; // active EventSource stream

const cacheKey = () => `${state.station}:${state.year}:${state.month}`;

function setSyncing(on, done, total) {
  const chip = $('syncChip');
  chip.classList.toggle('hidden', !on);
  if (on) chip.textContent = total ? `SYNCING ${done}/${total}` : 'SYNCING';
}

// ---------- price curve chart (SVG, palette validated for both themes) ----------

let chartRaf = null;

function scheduleChart() {
  if (chartRaf) return;
  chartRaf = requestAnimationFrame(() => {
    chartRaf = null;
    renderChart();
  });
}

function renderChart() {
  const wrap = $('chartWrap');
  if (!wrap || !state.grid) return;
  $('chartMonth').textContent = `${MONTHS_SHORT[state.month - 1]} ${state.year}`;

  const days = state.grid.daysInMonth;
  const series = state.durations.map((dur) => {
    const pts = [];
    for (let d = 1; d <= days; d++) {
      const c = state.cellMap.get(key(d, dur));
      pts.push(c ? c.pct : null);
    }
    return { dur, pts };
  });

  const vals = series.flatMap((s) => s.pts).filter((v) => v != null);
  if (!vals.length) {
    wrap.innerHTML = '<div class="chart-empty">No data for this month.</div>';
    $('chartLegend').innerHTML = '';
    return;
  }
  let vMax = Math.max(...vals);
  let vMin = Math.min(...vals);
  vMin = Math.floor((vMin - 2) / 5) * 5;
  vMax = Math.ceil((vMax + 2) / 5) * 5;
  if (vMax === vMin) vMax += 5;

  const W = 320, H = 200, L = 34, R = 30, T = 12, B = 22;
  const x = (d) => L + ((d - 1) * (W - L - R)) / Math.max(days - 1, 1);
  const y = (v) => T + ((vMax - v) * (H - T - B)) / (vMax - vMin || 1);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price change per day and rental duration">`;
  const gridSteps = 5;
  for (let i = 0; i <= gridSteps; i++) {
    const v = vMax - ((vMax - vMin) * i) / gridSteps;
    svg += `<line class="chart-grid-line" x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}"/>`;
    svg += `<text class="chart-axis-label" x="${L - 4}" y="${y(v) + 2.5}" text-anchor="end">${Math.round(v)}</text>`;
  }
  svg += `<text class="chart-axis-label" x="${L - 4}" y="${T - 4}" text-anchor="end">%</text>`;
  const xticks = [];
  for (let d = 1; d <= days; d += 5) xticks.push(d);
  if (!xticks.includes(days)) xticks.push(days);
  for (const d of xticks) {
    svg += `<text class="chart-axis-label" x="${x(d)}" y="${H - 6}" text-anchor="middle">${d}</text>`;
  }
  // today marker
  const now = new Date();
  if (state.year === now.getFullYear() && state.month === now.getMonth() + 1) {
    const tx = x(now.getDate());
    svg += `<line class="chart-today" x1="${tx}" y1="${T}" x2="${tx}" y2="${H - B}"/>`;
    svg += `<text class="chart-axis-label chart-today-label" x="${tx}" y="${T - 4}" text-anchor="middle">TODAY</text>`;
  }

  const labelYs = [];
  for (const s of series) {
    let path = '';
    let pen = false;
    let last = null;
    for (let d = 1; d <= days; d++) {
      const v = s.pts[d - 1];
      if (v == null) { pen = false; continue; }
      path += `${pen ? 'L' : 'M'}${x(d).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
      last = { d, v };
    }
    if (!path) continue;
    svg += `<path class="chart-series s-${s.dur}" d="${path.trim()}"/>`;
    if (last) {
      // direct label at line end, nudged to avoid collisions
      let ly = y(last.v) + 2.5;
      while (labelYs.some((p) => Math.abs(p - ly) < 8)) ly += 8;
      labelYs.push(ly);
      svg += `<text class="chart-label" x="${W - R + 3}" y="${ly}">${s.dur >= OPEN_DURATION ? OPEN_DURATION + '+' : s.dur}D</text>`;
    }
  }
  svg += `<line class="chart-cross" id="chartCross" x1="0" y1="${T}" x2="0" y2="${H - B}" style="display:none"/>`;
  for (const s of series) {
    svg += `<circle class="chart-dot" id="chartDot-${s.dur}" r="3.2" fill="var(--s${s.dur})" style="display:none"/>`;
  }
  svg += '</svg>';

  wrap.innerHTML = svg + '<div class="chart-tip" id="chartTip"></div>';
  window.__lastChartSvg = svg;
  if (state.view === 'dashboard') {
    $('dashChart').innerHTML = svg;
    $('dashChartMonth').textContent = `${MONTHS_SHORT[state.month - 1]} ${state.year}`;
  }

  // per-duration stats for the analytics page
  const durHtml = series
    .map((s) => {
      const v = s.pts.filter((x) => x != null);
      if (!v.length) return '';
      const avg = (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1);
      return `<div class="stat-row"><span><span class="legend-chip chip-s-${s.dur}"></span> ${s.dur >= OPEN_DURATION ? OPEN_DURATION + '+' : s.dur} DAYS</span><b>avg ${avg}% · min ${Math.min(...v)}% · max ${Math.max(...v)}%</b></div>`;
    })
    .join('');
  $('durStats').innerHTML = durHtml || '<div class="drawer-empty">No data.</div>';

  $('chartLegend').innerHTML = state.durations
    .map((dur) => `<span class="legend-item"><span class="legend-chip chip-s-${dur}"></span>${dur >= OPEN_DURATION ? OPEN_DURATION + '+' : dur} DAYS</span>`)
    .join('');

  // hover: crosshair + tooltip with every duration's value for the nearest day
  const svgEl = wrap.querySelector('svg');
  const tip = wrap.querySelector('#chartTip');
  const cross = wrap.querySelector('#chartCross');
  svgEl.onmousemove = (ev) => {
    const rect = svgEl.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const d = Math.max(1, Math.min(days, Math.round((px - L) / ((W - L - R) / Math.max(days - 1, 1))) + 1));
    cross.style.display = '';
    cross.setAttribute('x1', x(d));
    cross.setAttribute('x2', x(d));
    for (const s of series) {
      const dot = wrap.querySelector(`#chartDot-${s.dur}`);
      const v = s.pts[d - 1];
      if (dot) {
        if (v == null) dot.style.display = 'none';
        else {
          dot.style.display = '';
          dot.setAttribute('cx', x(d));
          dot.setAttribute('cy', y(v));
        }
      }
    }
    const rows = series
      .filter((s) => s.pts[d - 1] != null)
      .map((s) => `<div class="tip-row"><span class="legend-chip chip-s-${s.dur}"></span>${s.dur >= OPEN_DURATION ? OPEN_DURATION + '+' : s.dur}D<b>${s.pts[d - 1]}%</b></div>`)
      .join('');
    tip.innerHTML = `<div class="tip-day">DAY ${String(d).padStart(2, '0')}</div>` + (rows || '<div class="tip-row">no rules</div>');
    tip.style.display = 'block';
    const tipX = (x(d) / W) * rect.width;
    tip.style.left = Math.min(tipX + 10, rect.width - 110) + 'px';
    tip.style.top = '8px';
  };
  svgEl.onmouseleave = () => {
    tip.style.display = 'none';
    cross.style.display = 'none';
    for (const s of series) {
      const dot = wrap.querySelector(`#chartDot-${s.dur}`);
      if (dot) dot.style.display = 'none';
    }
  };
}

function updateChips() {
  const e = state.entry;
  if (!e) return;
  $('ruleCountChip').textContent = `${e.totalRules} RULES`;
  // conflictMap values are { ruleids, lane } now — only the lane on screen
  // is what the operator can act on, so that is what the chip counts
  const conflicts = [...e.conflictMap.values()].filter(
    (v) => (v.ruleids || []).length > 1 && (!v.lanes || v.lanes.includes(e.lane))
  ).length;
  $('conflictChip').classList.toggle('hidden', !conflicts);
  $('conflictChip').textContent = `${conflicts} CONFLICTS`;
  $('othersChip').classList.toggle('hidden', !e.others.length);
  $('othersChip').textContent = `${e.others.length} OTHER RULES`;
  $('othersChip').title = e.others
    .slice(0, 20)
    .map((o) => `#${o.ruleid} ${o.name} (${o.from || ''} → ${o.to || ''}) ${o.note || ''}`)
    .join('\n');

  updateWarnings();
  scheduleChart();
}

// warn about future days that have no pricing rules at all
function updateWarnings() {
  if (!state.grid || !state.entry) return;
  const now = new Date();
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const list = [];
  for (let d = 1; d <= state.grid.daysInMonth; d++) {
    const future = new Date(state.year, state.month - 1, d) >= t0;
    const covered = state.durations.some((dur) => state.entry.cells.has(key(d, dur)));
    const show = future && !covered && state.entry.complete;
    const ico = document.getElementById(`dayWarn-${d}`);
    if (ico) ico.classList.toggle('hidden', !show);
    if (show) list.push(d);
  }
  $('warnChip').classList.toggle('hidden', !list.length);
  $('warnChip').textContent = `${list.length} UNCOVERED`;
  $('warnChip').title = 'Future days with no pricing rules: ' + list.join(', ');
}

function decPending(day) {
  const n = (state.pendingByDay.get(day) || 0) - 1;
  if (n <= 0) state.pendingByDay.delete(day);
  else state.pendingByDay.set(day, n);
  const dot = document.getElementById(`dayDot-${day}`);
  if (dot) dot.classList.toggle('on', state.pendingByDay.has(day));
  const total = state._streamTotal || 0;
  state._streamDone = (state._streamDone || 0) + 1;
  setSyncing(true, state._streamDone, total);
}

function renderDayDots() {
  if (!state.grid) return;
  for (let d = 1; d <= state.grid.daysInMonth; d++) {
    const dot = document.getElementById(`dayDot-${d}`);
    if (dot) dot.classList.toggle('on', state.pendingByDay.has(d));
  }
}

function loadGrid() {
  $('monthLabel').textContent = `${MONTHS[state.month - 1]} ${state.year}`;
  if (!state.session) return;
  lastSync.grid = Date.now();
  if (es) { es.close(); es = null; }

  state.grid = {
    year: state.year,
    month: state.month,
    daysInMonth: new Date(state.year, state.month, 0).getDate(),
  };

  // month cache: render instantly from cache, then revalidate in background
  let entry = state.monthCache.get(cacheKey());
  if (!entry) {
    entry = {
      cells: new Map(), conflictMap: new Map(), others: [], totalRules: 0, complete: false,
      // PRICE LANES: one vehicle-group set = one lane. `cells` above is the
      // ACTIVE lane's map, so every existing reader of state.cellMap keeps
      // working; `lanes` holds them all.
      lanes: new Map(),   // laneKey -> { lane, label, groupIds, cells: Map }
      lane: 'ALL',        // which one the grid is showing
    };
    state.monthCache.set(cacheKey(), entry);
  }
  state.entry = entry;
  useLane(entry, entry.lane);
  state.pendingByDay = new Map();
  state._streamDone = 0;
  state._streamTotal = 0;

  // presence is per station+month: markers and our own broadcast focus from
  // the previous view must not survive into this one (they used to be painted
  // onto the wrong month until the next beat — or forever if a beat failed)
  state.remotePresence = [];
  presenceCtx.day = null;
  presenceCtx.dur = null;

  $('gridEmpty').classList.add('hidden');
  $('gridTable').classList.remove('hidden');
  renderGrid();
  attachGridTip(); // delegated once; survives every re-render
  renderLaneBar(); // from cache: the switcher is up before the stream finishes
  updateChips();
  renderApplyBar();
  ensureSidePanes(); // both side panes are permanent on desktop
  suspectSweep(); // background rank check paints the amber attention flags

  // month-copy landing: stage the copied cells onto this month
  if (state.pendingCopy && state.pendingCopy.targetKey === cacheKey()) {
    const pc = state.pendingCopy;
    state.pendingCopy = null;
    let n = 0;
    for (const c of pc.cells) {
      if (c.day <= state.grid.daysInMonth) {
        state.staged.set(key(c.day, c.dur), { pct: c.pct });
        refreshCell(c.day, c.dur);
        n++;
      }
    }
    renderApplyBar();
    toast(`${n} change(s) staged from ${pc.fromLabel}. Review, then APPLY TO DPS.`);
  }

  // stream fresh data; cells paint one by one as they resolve
  setSyncing(true);
  es = new EventSource(`/api/grid/stream?station=${state.station}&year=${state.year}&month=${state.month}`);
  const boundKey = cacheKey();
  const finish = () => {
    if (es) { es.close(); es = null; }
    setSyncing(false);
  };
  const stillCurrent = () => boundKey === cacheKey();

  es.addEventListener('meta', (ev) => {
    if (!stillCurrent()) return;
    const m = JSON.parse(ev.data);
    entry.totalRules = m.totalRules;
    entry.others = m.others;
    state.pendingByDay = new Map();
    for (const p of m.pending)
      state.pendingByDay.set(p.day, (state.pendingByDay.get(p.day) || 0) + 1);
    state._streamTotal = m.pending.length;
    renderDayDots();
    updateChips();
  });

  es.addEventListener('cell', (ev) => {
    if (!stillCurrent()) return;
    const c = JSON.parse(ev.data);
    decPending(c.day);
    const k = key(c.day, c.dur);
    // each cell belongs to ONE vehicle-group set; two categories on the same
    // day+duration are two lanes, not a clash
    const l = laneOf(entry, c.lane || 'ALL');
    if (!l.label && c.label) l.label = c.label;
    const existing = l.cells.get(k);
    if (existing && existing.ruleid !== c.ruleid) {
      // two rules on the same cell in the SAME lane: they fight over the same
      // cars, so DPS picks one unpredictably — that is a real conflict
      entry.conflictMap.set(k, {
        ruleids: [existing.ruleid, c.ruleid],
        lanes: [l.lane],
        rules: [
          { ruleid: existing.ruleid, pct: existing.pct, label: existing.label, active: existing.active },
          { ruleid: c.ruleid, pct: c.pct, label: c.label, active: c.active },
        ],
      });
      if (l.lane === entry.lane) state.conflictSet.add(k);
      refreshCell(c.day, c.dur);
      updateChips();
      return;
    }
    if (
      !existing ||
      existing.pct !== c.pct ||
      existing.active !== c.active ||
      existing.op !== c.op ||
      existing.updated !== c.updated
    ) {
      l.cells.set(k, c);
      if (l.lane === entry.lane) refreshCell(c.day, c.dur); // paint as it arrives
    }
  });

  es.addEventListener('skip', (ev) => {
    if (!stillCurrent()) return;
    const s = JSON.parse(ev.data);
    decPending(s.day);
    if (!entry.others.some((o) => o.ruleid === s.ruleid)) entry.others.push(s);
    updateChips();
  });

  es.addEventListener('done', (ev) => {
    if (!stillCurrent()) return finish();
    const d = JSON.parse(ev.data);
    // drop cached cells whose DPS rules disappeared since last visit. Keys are
    // "day:dur:lane" now, so a rule removed from ONE lane does not evict the
    // cell another lane still owns.
    const valid = new Set(d.keys);
    for (const l of entry.lanes.values()) {
      for (const k of [...l.cells.keys()]) {
        if (!valid.has(`${k}:${l.lane}`)) {
          l.cells.delete(k);
          if (l.lane === entry.lane) {
            const [dd, du] = k.split(':').map(Number);
            refreshCell(dd, du);
          }
        }
      }
    }
    // lanes the server saw this month, with the names their rules carry
    for (const ln of d.lanes || []) {
      const l = laneOf(entry, ln.lane);
      if (ln.label) l.label = ln.label;
      if (ln.groupIds) l.groupIds = ln.groupIds;
    }
    // a lane that vanished entirely must not linger in the switcher
    for (const [k, l] of [...entry.lanes]) {
      if (!l.cells.size && k !== entry.lane) entry.lanes.delete(k);
    }
    if (!entry.lanes.has(entry.lane)) {
      const first = [...entry.lanes.keys()][0] || 'ALL';
      useLane(entry, first);
      renderGrid();
    }
    entry.conflictMap = new Map(
      d.conflicts.map((c) => [key(c.day, c.dur), { ruleids: c.ruleids, lanes: c.lanes || null, rules: c.rules || null }])
    );
    state.conflictSet = conflictKeysFor(entry, entry.lane);
    for (const c of d.conflicts) refreshCell(c.day, c.dur);
    renderLaneBar();
    entry.complete = true;
    state.pendingByDay.clear();
    renderDayDots();
    updateChips();
    if (state.view === 'dashboard') renderDashboard();
    finish();
  });

  es.addEventListener('fail', (ev) => {
    const d = JSON.parse(ev.data);
    finish();
    if (d.code === 401) {
      setSession(false);
      openSessionModal('Session expired — sign in again.');
    } else if (d.code === 'PURGE_RUNNING') {
      // a station reset/copy is still running server-side (it survives any
      // refresh) — show that instead of an error, and come back on our own
      $('gridTable').classList.add('hidden');
      $('gridEmpty').classList.remove('hidden');
      $('gridEmpty').innerHTML = `<div class="empty-code">[ RESET ]</div><div class="empty-text">${t('grid_purge_running')}</div>`;
      setTimeout(() => { if (state.view === 'grid') loadGrid(); }, 20000);
    } else if (d.code === 'TOO_MANY_RULES') {
      $('gridTable').classList.add('hidden');
      $('gridEmpty').classList.remove('hidden');
      $('gridEmpty').innerHTML = `<div class="empty-code">[ ${esc(String(d.error || ''))} ]</div><div class="empty-text">${t('grid_too_many')}</div>`;
    } else {
      toast('Sync failed: ' + d.error, 'error');
    }
  });

  es.onerror = () => finish();
}

function fmtPct(v) {
  const n = Number(v);
  return (n > 0 ? '+' : '') + (Number.isInteger(n) ? String(n) : n.toFixed(2)) + '%';
}

// ---------- C5: vehicle-group coverage of a rule ----------
// The stream sends `groups` (how many groups the rule targets) and `groupIds`.
// A rule written before that field existed has neither — it reads as full
// coverage, which is exactly what those rules do in DPS.

function cellGroupCount(cell) {
  const n = cell && cell.groups != null ? Number(cell.groups) : null;
  return Number.isFinite(n) ? n : null;
}

const totalVehicleGroups = () => state.vehicleGroups.length;

function isPartialCoverage(cell) {
  const n = cellGroupCount(cell);
  const total = totalVehicleGroups();
  return n != null && total > 0 && n > 0 && n < total;
}

/** "3/39: ZU-A, ZU-B, ZU-C" — or ALL GROUPS when the rule covers everything. */
function groupCoverageText(cell) {
  const n = cellGroupCount(cell);
  const total = totalVehicleGroups();
  if (n == null || !total || n >= total) return t('vg_all');
  const codes = (cell.groupIds || []).map((gid) => {
    const g = state.vehicleGroups.find((x) => x.id === String(gid));
    return g ? g.code : String(gid);
  });
  // a count without ids (some stream fallbacks) must not render "3/39: "
  if (!codes.length) return `${n}/${total}`;
  return `${n}/${total}: ${codes.slice(0, 8).join(', ')}${codes.length > 8 ? ' …' : ''}`;
}

function renderGrid() {
  const g = state.grid;
  const head = $('gridHead');
  head.innerHTML = '';
  const dayTh = document.createElement('th');
  dayTh.className = 'day-col';
  dayTh.textContent = 'DAY';
  head.appendChild(dayTh);
  for (const dur of state.durations) {
    const th = document.createElement('th');
    th.textContent = dur >= OPEN_DURATION ? `${dur}+ DAYS` : dur === 1 ? '1 DAY' : `${dur} DAYS`;
    th.title = 'Click to fill entire column';
    th.onclick = () => fillColumn(dur);
    head.appendChild(th);
  }

  const body = $('gridBody');
  body.innerHTML = '';
  for (let day = 1; day <= g.daysInMonth; day++) {
    const tr = document.createElement('tr');
    const dow = new Date(g.year, g.month - 1, day).getDay();
    if (dow === 0 || dow === 6) tr.className = 'weekend';

    const tdDay = document.createElement('td');
    tdDay.innerHTML = `<div class="day-label" title="Click to fill entire row"><span>${String(day).padStart(2, '0')}<span class="day-dot" id="dayDot-${day}"></span><span class="day-warn-ico hidden" id="dayWarn-${day}" title="No pricing rules for this future day">!</span></span><span><span class="day-analyze" data-day="${day}" title="rentalcars top-10 competitor analysis">&#8981;</span><span class="dow">${DOW[dow]}</span></span></div>`;
    tdDay.onclick = (e) => {
      if (e.target.classList && e.target.classList.contains('day-analyze')) {
        e.stopPropagation();
        openRcAnalysis(day);
      } else {
        fillRow(day);
      }
    };
    tr.appendChild(tdDay);

    for (const dur of state.durations) {
      tr.appendChild(renderCell(day, dur));
    }
    body.appendChild(tr);
  }
}

/** The OPEN-ENDED bucket for the month on screen: the longest duration that
 *  actually carries a rule. A station priced up to 9 days has `>= 9`, not
 *  `>= 14` — judging every rule against a hardcoded 14 flagged correct rules
 *  as mismatched and wrote the wrong operator on new ones. */
function openDurationNow() {
  let max = 0;
  for (const c of state.cellMap.values()) if (c.dur > max) max = c.dur;
  return max || OPEN_DURATION;
}

const opForDur = (dur, open) => (Number(dur) >= Number(open || openDurationNow()) ? '>=' : '=');

function renderCell(day, dur) {
  const td = document.createElement('td');
  td.dataset.day = day;
  td.dataset.dur = dur;
  // Berkay, 2026-08-30: the cell the analysis panel is on (solid ring) and
  // the cell the embedded rentalcars pane is on (blue inner ring) stay
  // visibly marked on the grid — the operator always sees WHERE the two
  // side views are looking and where the preview/apply is happening
  if (rcCtx && rcCtx.day === day && rcCtx.dur === dur && !$('rcModal').classList.contains('hidden'))
    td.classList.add('cell-active');
  if (rcWeb.day === day && rcWeb.dur === dur && !$('rcWeb').classList.contains('hidden'))
    td.classList.add('cell-live');
  // a background scan asked for this cell to be looked at (amber pulse) —
  // but never on a cell whose rule has since been deleted (unpriced != drifted)
  if (cellFlags.has(flagKey(day, dur)) && state.cellMap.has(`${day}:${dur}`))
    td.classList.add('cell-suspect');
  const k = key(day, dur);

  td.oncontextmenu = (e) => {
    e.preventDefault();
    // Berkay, 2026-08-30 round 5: ONE left click drives BOTH side views, so
    // right-click is just an alias — no separate gesture for the pane, no
    // separate hour ring. The shared hour moves only via the -/+ controls,
    // REFRESH, and the post-apply follow-up.
    selectAnalysisCell(day, dur);
  };

  if (state.conflictSet.has(k)) {
    td.className = 'cell-conflict';
    td.textContent = 'CONFLICT';
    const cf = (state.entry && state.entry.conflictMap.get(k)) || {};
    const ids = cf.ruleids || [];
    td.title = t('conflict_cell_tip', { ids: '#' + ids.join(', #') });
    // click to FIX: pick the rule that keeps the cell, the others are deleted
    td.onclick = () => resolveConflict(day, dur);
    return td;
  }

  const cell = state.cellMap.get(k);
  const staged = state.staged.get(k);

  if (staged !== undefined) {
    td.classList.add('cell-staged');
    if (staged.pct === null) {
      td.classList.add('cell-staged-del');
      td.innerHTML = cell ? `<span class="cell-old">${fmtPct(cell.pct)}</span>—` : '—';
    } else if (staged.scan) {
      // SCAN proposal: old value struck, new value in orange — distinct from
      // the green user-staged path so the operator sees what the scan wants
      td.classList.add('cell-staged-scan');
      td.innerHTML =
        (cell && Number(cell.pct) !== Number(staged.pct) ? `<span class="cell-old">${fmtPct(cell.pct)}</span>` : '') +
        `<span class="cell-scan-new">${fmtPct(staged.pct)}</span>`;
    } else if (cell && Number(cell.pct) !== Number(staged.pct)) {
      // old value struck in orange, staged new value in green
      td.innerHTML = `<span class="cell-old">${fmtPct(cell.pct)}</span><span class="cell-new">${fmtPct(staged.pct)}</span>`;
    } else {
      td.innerHTML = `<span class="cell-new">${fmtPct(staged.pct)}</span>`;
    }
  } else if (cell) {
    td.textContent = fmtPct(cell.pct);
    td.classList.add(cell.pct < 0 ? 'cell-neg' : 'cell-pos');
    // band coding for quick visual checks (Berkay, 2026-08-28): the NORMAL
    // discount range is -40..-60 and stays green. Anything OUTSIDE the band —
    // too shallow (-39 and up) or too deep (-61 and down) — turns Palantir
    // blue, so the eye lands on what needs checking before reading a number.
    if (cell.pct < 0 && cell.pct > -40) td.classList.add('cell-out-mild');
    else if (cell.pct <= -80) td.classList.add('cell-out-crit');   // red: giving it away
    else if (cell.pct <= -70) td.classList.add('cell-out-hot');    // orange: nearly there
    else if (cell.pct < -60) td.classList.add('cell-out-deep');    // blue: over the band
    if (!cell.active) td.classList.add('cell-inactive');
    if (cell.numDaysOp && cell.numDaysOp !== opForDur(dur)) {
      td.classList.add('cell-op-mismatch');
      td.dataset.op = cell.numDaysOp;
    }
    // a rule that only targets some vehicle groups gets a visible edge marker
    if (isPartialCoverage(cell)) td.classList.add('cell-partial');
    // no native title here: the grid tip card (see gridTip below) carries the
    // detail — two tooltips fighting over the same hover reads as a glitch
  } else {
    td.classList.add('cell-empty');
    td.textContent = '—';
    td.title = 'Click: competitor panel · Double-click: set % · Right-click: open on rentalcars.com';
  }

  // Berkay, 2026-08-30: ONE click loads this cell's day into the docked
  // competitor panel; DOUBLE-click opens the % editor (with -/+ steppers).
  // The first click of a double-click pair already selects the same cell, so
  // the panel is loading the right ladder by the time the editor opens.
  td.onclick = () => selectAnalysisCell(day, dur);
  td.ondblclick = () => editCell(td, day, dur);

  // someone else is on this cell (or this whole day, from their analysis
  // modal): an orange live trace. Applied here, in renderCell, so every
  // refresh keeps it — bolted-on classes die with refreshCell's replaceWith.
  const rp = (state.remotePresence || []).find(
    (o) => o.day === day && (o.dur == null || o.dur === dur)
  );
  if (rp) {
    td.classList.add('cell-remote');
    td.dataset.ruser = rp.user || '?';
  }
  return td;
}

// ---------- live presence: who else is looking at what ----------
// A light heartbeat carries this operator's focus; the answer carries every
// other operator on the same station+month, painted as an orange trace.
const presenceCtx = { day: null, dur: null };

function setPresenceFocus(day, dur) {
  presenceCtx.day = day || null;
  presenceCtx.dur = dur || null;
}

async function presenceBeat() {
  if (!state.session || document.hidden) return;
  // the open analysis modal outranks the last grid touch
  const modalOpen = rcCtx && !$('rcModal').classList.contains('hidden');
  // only broadcast a cell while actually looking at cells: the open analysis
  // modal, or the grid view — an operator on Settings is present, not editing
  const onGrid = state.view === 'grid';
  const day = modalOpen ? rcCtx.day : onGrid ? presenceCtx.day : null;
  const dur = modalOpen ? rcCtx.dur : onGrid ? presenceCtx.dur : null;
  try {
    const r = await api('/api/presence', {
      method: 'POST',
      body: { station: state.station, year: state.year, month: state.month, day, dur, view: state.view },
    });
    const before = state.remotePresence || [];
    state.remotePresence = Array.isArray(r.others) ? r.others : [];
    // repaint only the cells whose remote marker changed
    const keys = (list) => new Set(list.filter((o) => o.day).map((o) => `${o.day}:${o.dur || ''}`));
    const a = keys(before), b = keys(state.remotePresence);
    for (const kk of new Set([...a, ...b])) {
      if (a.has(kk) && b.has(kk)) continue;
      const [d2, du2] = kk.split(':');
      if (du2) refreshCell(Number(d2), Number(du2));
      else for (const dur2 of state.durations) refreshCell(Number(d2), dur2);
    }
  } catch {}
}
setInterval(presenceBeat, 5000);

/** ONE grid click = show that cell's day in the docked competitor panel,
 *  without touching anything. Re-clicking the shown cell is a no-op, so the
 *  first click of a double-click pair never re-rolls the analysis. */
function selectAnalysisCell(day, dur) {
  if (gridSel.justSelected) return; // end of a rectangle drag, not a request
  setPresenceFocus(day, dur);
  const samePanel =
    !$('rcModal').classList.contains('hidden') && rcCtx && rcCtx.day === day && rcCtx.dur === dur;
  if (!samePanel) openRcAnalysis(day, dur);
  // ONE click, BOTH views (Berkay, 2026-08-30): the booking pane follows the
  // same cell at the same shared hour and mirrors the same answer
  if (
    window.innerWidth > 780 &&
    (rcWeb.day !== day || rcWeb.dur !== dur || $('rcWeb').classList.contains('hidden'))
  ) {
    rcWebShow(day, dur);
  }
}

/** Live ranking preview while the grid editor is open: the docked panel
 *  re-ranks on every stepper tick / keystroke. If the panel's data is still
 *  in flight, the wish is parked on rcCtx and applied the moment it lands. */
function gridLivePreview(day, dur, pct) {
  if (!rcCtx || rcCtx.day !== day || rcCtx.dur !== dur) return;
  if ($('rcModal').classList.contains('hidden')) return;
  const r = rcCtx.view || rcCtx.data;
  if (r && r.gmPrice != null) projectPlacement(pct);
  else rcCtx.previewPct = pct;
}

function editCell(td, day, dur) {
  // a rectangle drag ends with the browser firing this cell's click — that
  // click is the end of the selection gesture, not a request to edit one cell
  if (gridSel.justSelected) return;
  setPresenceFocus(day, dur);
  if (state.applying) return;
  const k = key(day, dur);
  if (state.conflictSet.has(k)) return;
  if (td.querySelector('input')) return;

  const cell = state.cellMap.get(k);
  const staged = state.staged.get(k);
  const current = staged !== undefined ? (staged.pct === null ? '' : staged.pct) : cell ? cell.pct : '';

  td.textContent = '';
  // [−] input [+] — Berkay, 2026-08-30: the steppers tick 0.5 points and the
  // docked panel re-ranks after every tick; typing still works as before
  const wrap = document.createElement('span');
  wrap.className = 'cell-edit-wrap';
  wrap.innerHTML =
    `<span class="cell-step" data-s="-1">&minus;</span>` +
    `<input class="cell-input" placeholder="-62" spellcheck="false">` +
    `<span class="cell-step" data-s="1">+</span>`;
  td.appendChild(wrap);
  // pricing starts here — quietly verify the panel's ladder against live
  // rentalcars so the projection stands on a just-checked market
  if (rcCtx && rcCtx.day === day && rcCtx.dur === dur) ensureFreshBase();
  const input = wrap.querySelector('input');
  // empty cell: pre-type the minus so the operator only types digits
  input.value = current === '' ? '-' : current;
  input.focus();
  if (current === '') {
    input.setSelectionRange(1, 1); // caret after the minus, nothing selected
  } else {
    // the minus is a default, not a lock: select everything so a positive
    // value can be typed straight over it
    input.select();
  }

  let done = false;
  let previewed = false; // whether this editor projected into the panel
  const parse = () => {
    const raw = input.value.trim().replace(',', '.').replace(/^\+/, '');
    if (raw === '' || raw === '-') return null;
    const num = Number(raw);
    return isFinite(num) ? Math.round(num * 100) / 100 : null;
  };
  const clamp = (n) => Math.max(-95, Math.min(100, n));
  const preview = (n) => {
    previewed = true;
    gridLivePreview(day, dur, n);
  };
  let previewTimer = null;

  const closeEditor = () => {
    wrap.remove(); // refreshCell skips cells that hold an open editor
    refreshCell(day, dur);
  };
  const commit = () => {
    if (done) return;
    done = true;
    const raw = input.value.trim().replace(',', '.').replace(/^\+/, '');
    clearTimeout(previewTimer);
    if (raw === '-') { cancel(true); return; } // untouched pre-filled minus
    if (raw === '') {
      // empty: delete if a rule exists, otherwise unstage
      if (cell) state.staged.set(k, { pct: null });
      else state.staged.delete(k);
      if (previewed) dropEditorPreview(day, dur);
    } else {
      const num = Number(raw);
      if (!isFinite(num)) { cancel(true); return; }
      const pct = clamp(Math.round(num * 100) / 100);
      if (cell && Number(cell.pct) === pct && staged === undefined) state.staged.delete(k);
      else state.staged.set(k, { pct });
      // the committed value IS the projection now — the panel keeps showing
      // the projected ladder with its CONFIRM bar until applied or reset
      gridLivePreview(day, dur, pct);
    }
    closeEditor();
    renderApplyBar();
  };
  const cancel = (already) => {
    if (done && !already) return;
    done = true;
    clearTimeout(previewTimer);
    if (previewed) dropEditorPreview(day, dur);
    closeEditor();
  };

  wrap.querySelectorAll('.cell-step').forEach((b) => {
    // mousedown would blur the input and commit mid-step — block it
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = (e) => {
      e.stopPropagation();
      const base = parse();
      const from = base != null ? base : Number(cell ? cell.pct : 0) || 0;
      const next = clamp(Math.round((from + Number(b.dataset.s) * 0.5) * 100) / 100);
      input.value = String(next);
      preview(next);
    };
  });

  input.oninput = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const n = parse();
      if (n != null && n >= -95 && n <= 100) preview(n);
    }, 250);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); wrap.querySelector('.cell-step[data-s="1"]').onclick(e); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); wrap.querySelector('.cell-step[data-s="-1"]').onclick(e); }
  };
  input.onblur = commit;
  // a double-click lands on the wrap after the editor opens — keep it inert
  wrap.ondblclick = (e) => e.stopPropagation();
}

/** An abandoned editor preview must not leave the panel simulating: clear the
 *  un-applied projection it created (and only that — an applied one stays). */
function dropEditorPreview(day, dur) {
  if (rcCtx && rcCtx.day === day && rcCtx.dur === dur) {
    rcCtx.previewPct = null;
    if (rcCtx.placed && rcCtx.placed.proj && !rcCtx.placed.applied) resetGmSim();
  }
}

// ---------- collapsible sidebar ----------
(() => {
  const KEY = 'sideCollapsed.v1';
  const btn = $('sideCollapse');
  if (!btn) return;
  const apply = (on) => {
    document.body.classList.toggle('side-collapsed', on);
    btn.innerHTML = on ? '&#187;' : '&#171;';
  };
  let on = false;
  try { on = localStorage.getItem(KEY) === '1'; } catch (_) { /* default open */ }
  apply(on);
  btn.onclick = () => {
    on = !on;
    apply(on);
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (_) { /* session-only */ }
  };
})();

// ---------- draggable boundaries: grid | rentalcars pane | analysis panel ----------
// Berkay, 2026-08-30: "sağdaki panel ile grid boyutu oynanabilir olsun" —
// and since the embedded rentalcars pane, the middle boundary drags too.
// Each pane's width lives in a CSS variable on the split container and is
// remembered per browser; dragging clamps so no pane can disappear.
(() => {
  const split = $('gridSplit');
  if (!split) return;
  const wire = (barId, cssVar, storeKey, minPx, rightEdgeEl) => {
    const bar = $(barId);
    if (!bar) return;
    const clampW = (px) => Math.max(minPx, Math.min(px, Math.round(window.innerWidth * 0.6)));
    const apply = (px) => split.style.setProperty(cssVar, clampW(px) + 'px');
    let saved = 0;
    try { saved = Number(localStorage.getItem(storeKey)) || 0; } catch (_) { /* default width */ }
    if (saved) apply(saved);
    bar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.body.classList.add('dock-resizing');
      let last = 0;
      const move = (ev) => {
        // the pane being resized sits RIGHT of its bar: width = its right edge − cursor
        const edge = rightEdgeEl().getBoundingClientRect().right;
        last = clampW(edge - ev.clientX);
        apply(last);
      };
      const up = () => {
        document.body.classList.remove('dock-resizing');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (last) {
          saved = last;
          try { localStorage.setItem(storeKey, String(last)); } catch (_) { /* session-only */ }
        }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  };
  // right splitter resizes the analysis panel; middle one the rentalcars pane
  wire('gridSplitter', '--rc-dock-w', 'rcDockW.v1', 380, () => $('rcModal'));
  wire('rcWebSplitter', '--rc-web-w', 'rcWebW.v1', 320, () => $('rcWeb'));
})();

// ---------- Excel-style rectangular selection on the grid ----------
// Hold the left button on a cell and drag: every cell in the day x duration
// rectangle highlights; release and type one percentage — it is STAGED into
// every selected cell (same green staged path as a single edit), and the
// normal APPLY TO DPS bar writes the batch. A plain click (no drag) loads the
// cell into the docked panel; double-click opens the single-cell editor;
// right-click still opens rentalcars (at a random hour).
// ---------- suspicious-cell flags (Berkay, 2026-08-30) ----------
// A background sweep (and the selection scan below) checks whether the served
// ranking is what the doctrine wants (GM inside the top 10). Cells that fail
// get a pulsing amber ring — several at once when several days drifted — and
// the ring clears when the cell is edited+applied or a later scan finds it
// healthy again.
const cellFlags = new Map(); // `${station}:${year}:${month}:${day}:${dur}` -> reason
const flagKey = (d, du) => `${state.station}:${state.year}:${state.month}:${d}:${du}`;

// The system stays SILENT while work is in flight (Berkay, 2026-08-30: "şüphe
// her şey bittiğinde çıksın") — a scan mid-run, un-applied staged cells, an
// apply in progress or fresh propagation all make rank readings provisional.
// flagsPause() clears the board when an operation starts; flagsResume()
// schedules the next sweep once the dust settles.
const suspect = { busy: false, timer: null };

function flagsPause() {
  suspect.busy = true;
  clearTimeout(suspect.timer);
  if (suspectEs) { suspectEs.close(); suspectEs = null; }
  if (cellFlags.size) {
    const had = [...cellFlags.keys()];
    cellFlags.clear();
    for (const k of had) {
      const parts = k.split(':');
      refreshCell(Number(parts[3]), Number(parts[4]));
    }
  }
}

function flagsResume(delayMs) {
  suspect.busy = false;
  clearTimeout(suspect.timer);
  suspect.timer = setTimeout(suspectSweep, Math.max(0, delayMs || 0));
}

function suspectQuiet() {
  return !suspect.busy && !state.applying && !scan.running && !bulk.running && state.staged.size === 0;
}

function setCellFlag(day, dur, reason) {
  const k = flagKey(day, dur);
  const had = cellFlags.has(k);
  if (reason) cellFlags.set(k, reason);
  else cellFlags.delete(k);
  if (had !== !!reason) refreshCell(day, dur);
}

let suspectEs = null;
function suspectSweep() {
  if (state.view !== 'grid' || !state.session || !stationHasRc() || document.hidden) return;
  // silence while anything is still moving — the sweep re-arms afterwards
  if (!suspectQuiet()) return;
  if (suspectEs) { suspectEs.close(); suspectEs = null; }
  const dur = (rcCtx && rcCtx.dur) || 3;
  // a month with no rules at this duration has nothing to drift — probing 31
  // empty days would only spend the relay budget on the UNCOVERED story
  if (![...state.cellMap.keys()].some((k) => k.endsWith(':' + dur))) return;
  const ctx = { station: state.station, year: state.year, month: state.month, dur };
  const es = new EventSource(
    `/api/rc-month-stream?station=${ctx.station}&year=${ctx.year}&month=${ctx.month}&duration=${dur}`
  );
  suspectEs = es;
  es.addEventListener('day', (ev) => {
    if (ctx.station !== state.station || ctx.year !== state.year || ctx.month !== state.month) return;
    try {
      const d = JSON.parse(ev.data);
      if (d.error) return; // a failed probe proves nothing — never flag on it
      // no weekly rule on the cell = UNPRICED, not drifted — the UNCOVERED
      // chip owns that story; a flag would just repeat it in amber (Berkay:
      // an empty October lit up with suspicion)
      if (!state.cellMap.has(`${d.day}:${ctx.dur}`)) { setCellFlag(d.day, ctx.dur, null); return; }
      const ok = d.rank != null && d.rank <= 10;
      if (ok) setCellFlag(d.day, ctx.dur, null);
      // one hour alone must never raise the amber: rentalcars re-prices GM by
      // the hour (measured ±6.9%), so the SAME date is re-checked at other
      // hours and the flag needs a majority of bad readings
      else queueSuspectConfirm(d.day, ctx.dur, d.rank);
    } catch (_) { /* malformed event — skip */ }
  });
  es.onerror = () => { es.close(); if (suspectEs === es) suspectEs = null; };
}
// re-sweep every 15 minutes while the grid is on screen
setInterval(suspectSweep, 15 * 60 * 1000);

// ---------- the multi-hour confirmation (Berkay, 2026-08-30) ----------
// A cell only turns amber after the SAME date fails at a MAJORITY of hours:
// the first (canonical) reading plus two more slots spread across the
// shopper's day. Confirmations run one at a time — a sweep that finds ten
// candidates must not burst twenty draws at the relay.
const SUSPECT_SLOTS = [11, 16.5]; // 11:00 and 16:30, far from the 09:00 canon
let suspectChain = Promise.resolve();

function queueSuspectConfirm(day, dur, firstRank) {
  suspectChain = suspectChain
    .then(() => confirmSuspect(day, dur, firstRank))
    .catch(() => { /* a dead confirmation must not break the chain */ });
}

async function confirmSuspect(day, dur, firstRank) {
  if (!suspectQuiet()) return; // work started meanwhile — stand down
  if (!state.cellMap.has(`${day}:${dur}`)) return;
  const ranks = [firstRank == null ? '—' : '#' + firstRank];
  let bad = 1; // the reading that nominated this cell
  let good = 0;
  for (const h of SUSPECT_SLOTS) {
    try {
      const r = await api(
        `/api/rc-top?station=${state.station}&year=${state.year}&month=${state.month}&day=${day}&duration=${dur}&hh=${rcHH(h)}&mm=${rcMM(h)}&fresh=1&samples=1`
      );
      const ok = r.gmRank != null && r.gmRank <= 10;
      ranks.push(r.gmRank == null ? '—' : '#' + r.gmRank);
      if (ok) good++;
      else bad++;
    } catch (_) { /* a failed draw is no vote either way */ }
  }
  const confirmed = bad >= 2 && bad > good;
  setCellFlag(
    day, dur,
    confirmed ? t('suspect_reason', { bad, total: bad + good, ranks: ranks.join(' · ') }) : null
  );
}

/** the selection-scan: analyze ONLY the drag-selected cells, fresh, and flag
 *  the ones whose ranking is off */
async function scanSelection(cells) {
  const ruled = cells.filter((c) => state.cellMap.has(`${c.day}:${c.dur}`));
  for (const c of cells) if (!state.cellMap.has(`${c.day}:${c.dur}`)) setCellFlag(c.day, c.dur, null);
  if (!ruled.length) { toast(t('sel_scan_unruled'), 'warn'); return; }
  const todo = ruled.slice(0, 40);
  if (ruled.length > todo.length) toast(t('sel_scan_cap'), 'warn');
  toast(t('sel_scanning', { n: todo.length }));
  let done = 0, bad = 0;
  const t0 = new Date();
  t0.setHours(0, 0, 0, 0);
  for (const c of todo) {
    if (new Date(state.year, state.month - 1, c.day) < t0) continue;
    try {
      const r = await api(
        `/api/rc-top?station=${state.station}&year=${state.year}&month=${state.month}&day=${c.day}&duration=${c.dur}&${RC_CANON}&fresh=1&samples=2`
      );
      const ok = r.gmRank != null && r.gmRank <= 10;
      if (ok) setCellFlag(c.day, c.dur, null);
      else { queueSuspectConfirm(c.day, c.dur, r.gmRank); bad++; }
      done++;
    } catch (_) { /* one failed cell must not kill the pass */ }
  }
  toast(t('sel_scanned', { n: done, bad }), bad ? 'warn' : undefined);
}

/** Run the band SCAN over a drag-selected rectangle and stage its proposals.
 *  Cells with no weekly rule are skipped by the scan itself (there is nothing
 *  to re-price), so the count shown is the rules the rectangle actually
 *  covers. Everything lands as orange staged proposals — nothing is written
 *  until APPLY TO DPS. */
async function priceSelection(days, durs) {
  if (state.applying || scan.running) { toast(t('scan_busy'), 'warn'); return; }
  if (!state.entry) { toast(t('t_load_grid_first'), 'warn'); return; }
  const ruled = [];
  for (const d of days) for (const du of durs) if (state.cellMap.has(`${d}:${du}`)) ruled.push([d, du]);
  if (!ruled.length) { toast(t('sel_scan_unruled'), 'warn'); return; }
  const label = `${String(days[0]).padStart(2, '0')}–${String(days[days.length - 1]).padStart(2, '0')} ${MONTHS_SHORT[state.month - 1]} · ` +
    `${durs[0]}–${durs[durs.length - 1]}D`;
  if (!(await confirmBox(t('sel_price_confirm', { n: ruled.length, range: label })))) return;
  await runScan({ mode: 'category', days, durs });
}

const gridSel = { active: false, moved: false, a: null, b: null, justSelected: false };

function gridSelCells() {
  if (!gridSel.a || !gridSel.b) return [];
  const d1 = Math.min(gridSel.a.day, gridSel.b.day), d2 = Math.max(gridSel.a.day, gridSel.b.day);
  const durs = state.durations;
  const i1 = Math.min(durs.indexOf(gridSel.a.dur), durs.indexOf(gridSel.b.dur));
  const i2 = Math.max(durs.indexOf(gridSel.a.dur), durs.indexOf(gridSel.b.dur));
  const out = [];
  for (let d = d1; d <= d2; d++)
    for (let i = i1; i <= i2; i++) out.push({ day: d, dur: durs[i] });
  return out;
}

function gridSelPaint() {
  for (const td of document.querySelectorAll('#gridBody td.cell-sel')) td.classList.remove('cell-sel');
  for (const c of gridSelCells()) {
    const td = document.querySelector(`td[data-day="${c.day}"][data-dur="${c.dur}"]`);
    if (td) td.classList.add('cell-sel');
  }
}

function gridSelClear() {
  gridSel.active = false;
  gridSel.moved = false;
  gridSel.a = gridSel.b = null;
  document.body.classList.remove('grid-selecting');
  for (const td of document.querySelectorAll('#gridBody td.cell-sel')) td.classList.remove('cell-sel');
  const box = $('gridSelBox');
  if (box) box.remove();
}

function gridSelPrompt(x, y) {
  const cells = gridSelCells();
  if (cells.length < 2) { gridSelClear(); return; }
  const old = $('gridSelBox');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'gridSelBox';
  // Berkay, 2026-08-31: the drag selection is where re-pricing happens now —
  // the base rates moved, so every rule percentage produces a different shelf
  // price and the band has to be re-solved cell by cell. PRICE runs the real
  // category SCAN over exactly this rectangle (orange proposals, APPLY writes
  // them); CHECK only reads ranks and raises attention flags.
  box.innerHTML =
    `<span class="gridsel-n">${t('sel_cells', { n: cells.length })}</span>` +
    `<input class="gridsel-input" value="-" spellcheck="false">` +
    `<span class="gridsel-hint">${t('sel_hint')}</span>` +
    `<span class="gridsel-acts">` +
      `<button class="btn btn-primary btn-xs gridsel-price">${t('sel_price')}</button>` +
      `<button class="btn btn-ghost btn-xs gridsel-scan">${t('sel_scan')}</button>` +
    `</span>`;
  document.body.appendChild(box);
  const pad = 12;
  box.style.left = Math.min(x + pad, window.innerWidth - box.offsetWidth - pad) + 'px';
  box.style.top = Math.min(y + pad, window.innerHeight - box.offsetHeight - pad) + 'px';
  // analyze ONLY the selected cells (Berkay, 2026-08-30) — flags the ones
  // whose served ranking is off, without staging anything
  box.querySelector('.gridsel-scan').onclick = () => {
    const cs = gridSelCells();
    gridSelClear();
    scanSelection(cs);
  };
  // …and the pricing pass: the SAME band SCAN the toolbar runs, scoped to the
  // rectangle. A drag rectangle IS days x durations, which is exactly the
  // scope shape runScan already takes.
  box.querySelector('.gridsel-price').onclick = () => {
    const cs = gridSelCells();
    const days = [...new Set(cs.map((c) => c.day))].sort((a, b) => a - b);
    const durs = [...new Set(cs.map((c) => c.dur))].sort((a, b) => a - b);
    gridSelClear();
    priceSelection(days, durs);
  };
  const input = box.querySelector('input');
  input.focus();
  input.setSelectionRange(1, 1);
  input.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); gridSelClear(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const raw = input.value.trim().replace(',', '.').replace(/^\+/, '');
    const num = Number(raw);
    if (raw === '' || raw === '-' || !isFinite(num)) { gridSelClear(); return; }
    const pct = Math.max(-95, Math.min(100, Math.round(num * 100) / 100));
    let staged = 0, conflicts = 0;
    for (const c of cells) {
      const k = key(c.day, c.dur);
      if (state.conflictSet.has(k)) { conflicts++; continue; }
      const cell = state.cellMap.get(k);
      if (cell && Number(cell.pct) === pct) state.staged.delete(k);
      else state.staged.set(k, { pct });
      staged++;
      refreshCell(c.day, c.dur);
    }
    gridSelClear();
    renderApplyBar();
    toast(t('sel_staged', { n: staged, pct: fmtPct(pct) }) + (conflicts ? ` (${conflicts} CONFLICT)` : ''));
  };
  // clicking anywhere outside the box abandons the selection
  setTimeout(() => {
    const away = (e) => {
      if (!box.contains(e.target)) { gridSelClear(); document.removeEventListener('mousedown', away, true); }
    };
    document.addEventListener('mousedown', away, true);
  }, 0);
}

(() => {
  const table = $('gridTable');
  if (!table) return;
  table.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const td = e.target.closest('td[data-day][data-dur]');
    if (!td || td.querySelector('input') || state.applying) return;
    gridSel.active = true;
    gridSel.moved = false;
    gridSel.a = gridSel.b = { day: Number(td.dataset.day), dur: Number(td.dataset.dur) };
  });
  table.addEventListener('mouseover', (e) => {
    if (!gridSel.active) return;
    const td = e.target.closest('td[data-day][data-dur]');
    if (!td) return;
    const cur = { day: Number(td.dataset.day), dur: Number(td.dataset.dur) };
    if (cur.day === gridSel.a.day && cur.dur === gridSel.a.dur && !gridSel.moved) return;
    gridSel.moved = true;
    document.body.classList.add('grid-selecting');
    gridSel.b = cur;
    gridSelPaint();
  });
  document.addEventListener('mouseup', (e) => {
    if (!gridSel.active) return;
    gridSel.active = false;
    if (gridSel.moved) {
      // the td's own click handler fires right after mouseup — squelch it once
      gridSel.justSelected = true;
      setTimeout(() => { gridSel.justSelected = false; }, 0);
      gridSelPrompt(e.clientX, e.clientY);
    }
  });
})();

function refreshCell(day, dur) {
  const old = document.querySelector(`td[data-day="${day}"][data-dur="${dur}"]`);
  // an OPEN editor owns its cell: the live panel preview stages on every
  // stepper tick, and replacing the td here would destroy the input mid-type.
  // The editor's own commit/cancel removes the input first, then re-renders.
  if (old && old.querySelector('.cell-input')) return;
  if (old) old.replaceWith(renderCell(day, dur));
  // the tip card is only fed on mouseover — if the cursor is sitting still on
  // this very cell while the stream/apply swaps it, the card would keep
  // asserting the OLD state ("NO RULE" over a cell now showing -45%)
  if (
    gridTipEl && gridTipEl.style.display === 'block' &&
    Number(gridTipEl.dataset.day) === day && Number(gridTipEl.dataset.dur) === dur
  ) {
    gridTipEl.innerHTML = gridTipHtml(day, dur);
  }
  scheduleChart();
}

async function fillColumn(dur) {
  if (state.applying || !state.grid) return;
  const raw = await inputBox(`Set ${dur >= OPEN_DURATION ? dur + '+' : dur}-day % for EVERY day of ${MONTHS[state.month - 1]}:`);
  if (raw === null || raw.trim() === '') return;
  const num = Number(raw.trim().replace(',', '.'));
  if (!isFinite(num)) { toast('Invalid number.', 'error'); return; }
  for (let day = 1; day <= state.grid.daysInMonth; day++) {
    const k = key(day, dur);
    if (state.conflictSet.has(k)) continue;
    const cell = state.cellMap.get(k);
    if (cell && Number(cell.pct) === num) state.staged.delete(k);
    else state.staged.set(k, { pct: num });
    refreshCell(day, dur);
  }
  renderApplyBar();
}

async function fillRow(day) {
  if (state.applying || !state.grid) return;
  const raw = await inputBox(`Set % for ALL durations on day ${String(day).padStart(2, '0')}:`);
  if (raw === null || raw.trim() === '') return;
  const num = Number(raw.trim().replace(',', '.'));
  if (!isFinite(num)) { toast('Invalid number.', 'error'); return; }
  for (const dur of state.durations) {
    const k = key(day, dur);
    if (state.conflictSet.has(k)) continue;
    const cell = state.cellMap.get(k);
    if (cell && Number(cell.pct) === num) state.staged.delete(k);
    else state.staged.set(k, { pct: num });
    refreshCell(day, dur);
  }
  renderApplyBar();
}

// ---------- apply ----------

function renderApplyBar() {
  $('applyBar').classList.toggle('hidden', state.staged.size === 0);
  $('stagedCount').textContent = state.staged.size;
  $('applyBtn').disabled = state.applying;
  $('discardBtn').disabled = state.applying;
  if (state.entry) updateChips();
}

$('discardBtn').onclick = async () => {
  if (state.applying) return;
  // R6: staged edits (often a whole SCAN's worth of cells) are wiped here —
  // confirm before discarding them.
  if (state.staged.size && !(await confirmBox(t('discard_confirm', { n: state.staged.size })))) return;
  const keys = [...state.staged.keys()];
  state.staged.clear();
  for (const k of keys) {
    const [day, dur] = k.split(':').map(Number);
    refreshCell(day, dur);
  }
  renderApplyBar();
  // the docked panel may be simulating one of the discarded cells — a ladder
  // still showing TARGET rows for a change that no longer exists would lie
  if (rcCtx && rcCtx.placed && !rcCtx.placed.applied) resetGmSim();
  flagsResume(60 * 1000); // nothing staged any more — suspicion may re-arm
};

$('applyBtn').onclick = async () => {
  if (state.applying || !state.staged.size) return;
  const changes = [...state.staged.entries()].map(([k, v]) => {
    const [day, dur] = k.split(':').map(Number);
    return { day, dur, pct: v.pct, scan: !!v.scan };
  });
  if (!(await confirmBox(`Apply ${changes.length} change(s) to DPS (${stationName()})?`))) return;

  state.applying = true;
  renderApplyBar();
  flagsPause(); // ranks are provisional from here until propagation settles
  let ok = 0, fail = 0;
  const okDays = new Set();
  const okCells = new Set(); // which exact cells landed — the dock check needs one
  // Captured BEFORE any write: the docked panel's guarded base divides the
  // served price by the rule the market actually served. The loop below
  // overwrites cellMap with the NEW pct, after which gmServedBase would
  // divide by a rule rentalcars has never served — the invented-base trap.
  let dockBase = null;
  if (rcCtx && rcCtx.data && !$('rcModal').classList.contains('hidden')) {
    const v0 = rcCtx.view || rcCtx.data;
    if (v0 && v0.gmPrice != null) dockBase = gmServedBase(v0);
  }
  const applied = []; // C1: the scan proposals that really landed, for the popup
  // scan-born entries share one batch id so the activity log can collapse
  // them into a single row with a one-click REVERT ALL
  const batchId = changes.some((c) => c.scan)
    ? Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
    : null;

  // Every write belongs to the lane on screen. A CREATE has to say so — a new
  // rule with no coverage would be written across all 39 groups and silently
  // become a second, overlapping rule on cells another category already owns.
  const activeLane = state.entry && state.entry.lanes.get(state.entry.lane);
  const laneCoverage =
    activeLane && activeLane.lane !== 'ALL' && activeLane.groupIds && activeLane.groupIds.length
      ? { vehicleIds: activeLane.groupIds, groupName: activeLane.label || undefined }
      : {};
  for (const ch of changes) {
    const batchFields = ch.scan && batchId ? { batch: batchId, batchTag: 'scan' } : {};
    const k = key(ch.day, ch.dur);
    const td = document.querySelector(`td[data-day="${ch.day}"][data-dur="${ch.dur}"]`);
    if (td) { td.className = 'cell-applying'; td.textContent = '…'; }
    const cell = state.cellMap.get(k);
    try {
      let result;
      if (ch.pct === null) {
        if (cell) {
          const q = `station=${state.station}&day=${ch.day}&duration=${ch.dur}&month=${state.month}&year=${state.year}&prevPct=${cell.pct}`;
          result = await api(`/api/rule/${cell.ruleid}?${q}`, { method: 'DELETE' });
          state.cellMap.delete(k);
        }
      } else if (cell) {
        result = await api(`/api/rule/${cell.ruleid}`, {
          method: 'PUT',
          body: { station: state.station, day: ch.day, duration: ch.dur, month: state.month, year: state.year, pct: ch.pct, active: cell.active, prevPct: cell.pct, vendors: [state.vendor], ...batchFields },
        });
        state.cellMap.set(k, { ...cell, pct: ch.pct, numDaysOp: opForDur(ch.dur), opMismatch: false, vendors: ['ALL'] });
      } else {
        result = await api('/api/rule', {
          method: 'POST',
          body: { station: state.station, day: ch.day, duration: ch.dur, month: state.month, year: state.year, pct: ch.pct, active: true, vendors: [state.vendor], ...laneCoverage, ...batchFields },
        });
        state.cellMap.set(k, {
          day: ch.day, dur: ch.dur, ruleid: result.ruleid, name: result.detail.rulename,
          pct: ch.pct, active: true, numDaysOp: opForDur(ch.dur), opMismatch: false, vendors: ['ALL'], updated: '',
          lane: state.entry ? state.entry.lane : 'ALL',
          groupIds: laneCoverage.vehicleIds || null,
          label: laneCoverage.groupName || null,
        });
      }
      if (result && result.verified === false) {
        toast(`#${result.ruleid} saved but verification mismatch: ${result.problems.join(', ')}`, 'warn');
      }
      state.staged.delete(k);
      refreshCell(ch.day, ch.dur);
      const fresh = document.querySelector(`td[data-day="${ch.day}"][data-dur="${ch.dur}"]`);
      if (fresh) fresh.classList.add('cell-ok');
      ok++;
      okDays.add(ch.day);
      okCells.add(k);
      // an edited+applied cell is acknowledged — the amber flag comes off
      if (cellFlags.delete(`${state.station}:${state.year}:${state.month}:${k}`)) refreshCell(ch.day, ch.dur);
      const cmp = ch.scan ? scan.compare.get(k) : null;
      // a stale record from an earlier month/station could never describe this write
      if (cmp && cmp.station === state.station && cmp.year === state.year && cmp.month === state.month) {
        applied.push(cmp);
      }
    } catch (e) {
      fail++;
      if (td) { td.className = 'cell-error'; td.textContent = 'ERR'; td.title = e.message; }
      toast(`Day ${ch.day} / ${ch.dur}d failed: ${e.message}`, 'error');
      if (String(e.message).includes('SESSION')) break;
    }
    renderApplyBar();
  }

  state.applying = false;
  renderApplyBar();
  toast(`Apply finished: ${ok} ok, ${fail} failed.`, fail ? 'warn' : undefined);
  // Berkay, 2026-08-30: an APPLY that wrote the cell the docked panel is
  // showing starts the live-sync check right there — the panel verifies the
  // landing on its own (canonical hour at 2/5/10 min, then a second random
  // hour), exactly like a CONFIRM from inside the panel does.
  let dockApplied = null;
  if (ok && dockBase && dockBase.base != null && rcCtx && !$('rcModal').classList.contains('hidden')) {
    const done = changes.find(
      (c) => c.day === rcCtx.day && c.dur === rcCtx.dur && c.pct !== null && okCells.has(key(c.day, c.dur))
    );
    if (done) {
      const target = Math.round(dockBase.base * (1 + done.pct / 100) * 100) / 100;
      startRcSync(rcCtx.day, rcCtx.dur, target, done.pct, dockBase.servedPct);
      dockApplied = { day: rcCtx.day, dur: rcCtx.dur, pct: done.pct };
    }
  }
  if (ok) {
    // the server rc cache for the touched days is stale now — purge it, and
    // only re-stream the rank strip once every invalidate has landed
    await Promise.all([...okDays].map((day) => fetch('/api/rc-invalidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ station: state.station, year: state.year, month: state.month, day }),
    }).catch(() => {})));
    rcMonth.loadedKey = null;
    if (state.view === 'dashboard') startRcMonth(true);
  }
  // With CONFIRM retired from the panel, the APPLY bar owns its follow-up:
  // step the SHARED hour (a new hour is a search nobody can serve stale) and
  // re-query fresh AFTER the invalidates above. Berkay, 2026-08-30: the panel
  // shows ONLY what rentalcars actually serves — the applied price appears
  // when it provably lands (sync bar tracks it; checkRcSync swaps the data
  // in), never as a projected overlay pretending to be the market. Both views
  // render the same answer, so they can never disagree.
  if (ok && rcCtx && !$('rcModal').classList.contains('hidden') &&
      (dockApplied || okDays.has(rcCtx.day))) {
    rcHour = rcHourAt(rcHour, 1);
    renderRcHour();
    const cell = dockApplied || { day: rcCtx.day, dur: rcCtx.dur };
    rcLiveFollowUp(cell.day, cell.dur); // the pane follows; +90s second look
    await runRcAnalysis({ fresh: true });
  }
  // suspicion re-arms after the propagation window: only a settled market may
  // nominate cells for attention ("her şey bittiğinde")
  flagsResume(ok ? 10 * 60 * 1000 : 60 * 1000);
  // no full reload — cells were updated in place from the verified responses
  refreshLogs();
  // C1: an apply that carried scan proposals ends in the before/after popup
  if (applied.length) openCompareModal(applied, batchId, ok, fail);
};

function stationName() {
  const s = state.stations.find((x) => x.id === state.station);
  return s ? s.name : state.station;
}

// ---------- theme ----------

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('theme', t);
  $('themeBtn').textContent = t === 'dark' ? 'LIGHT' : 'DARK';
}

$('themeBtn').onclick = () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

applyTheme(localStorage.getItem('theme') || 'dark');

// ---------- HUD scale ----------

const HUD_STEPS = [85, 100, 115, 130];

function applyHud(pct) {
  const z = pct / 100;
  document.body.style.zoom = z;
  // zoom multiplies 100vh past the real viewport — compensate so the
  // flex layout (and every inner scroller) still fits exactly
  document.body.style.height = z === 1 ? '' : `calc(100vh / ${z})`;
  localStorage.setItem('hudScale', String(pct));
  $('hudBtn').textContent = `HUD ${pct}%`;
  if ($('setHud')) { $('setHud').value = pct; $('setHudVal').textContent = pct + '%'; }
}

$('hudBtn').onclick = () => {
  const cur = Number(localStorage.getItem('hudScale') || 100);
  const next = HUD_STEPS[(HUD_STEPS.indexOf(cur) + 1) % HUD_STEPS.length];
  applyHud(next);
};

applyHud(Number(localStorage.getItem('hudScale') || 100));

// ---------- settings & user ----------

function initialsOf(name) {
  if (!name) return '—';
  const parts = String(name).replace(/[@._-]+/g, ' ').trim().split(/\s+/);
  return ((parts[0] || '')[0] || '').toUpperCase() + ((parts[1] || '')[0] || (parts[0] || '')[1] || '').toUpperCase();
}

function renderSideUser() {
  // the DPS username when there is one, otherwise the console account (step 1)
  const u = state.user || state.account;
  $('sideUserAvatar').textContent = initialsOf(u);
  $('sideUserName').textContent = u || t('not_signed_in');
  $('sideUserRole').innerHTML = roleBadge() + t('user_role');
  $('sideUser').classList.toggle('side-user-off', !u);
  $('sideSignout').classList.toggle('hidden', !u);
}

/** Role pill (empty until /api/auth/session has answered). */
function roleBadge() {
  if (!state.role) return '';
  return `<span class="role-badge role-${state.role}">${t(isAdmin() ? 'role_admin' : 'role_staff')}</span> `;
}

function renderTenantChip() {
  const tn = state.tenant;
  $('tenantChip').textContent = tn && tn.name
    ? tn.name.toUpperCase()
    : (tn && tn.id ? String(tn.id).toUpperCase() : '—');
  $('tenantChip').title = tn && tn.id ? String(tn.id) : '';
}

$('sideUser').onclick = () => showView('settings');

function renderSettings() {
  const u = state.user || state.account;
  $('setAvatar').textContent = initialsOf(u);
  $('setUserName').textContent = u || t('not_signed_in');
  $('setUserSub').textContent =
    state.account && state.account !== u ? state.account : (u ? 'zrh.dps.greenmotion.com' : '—');
  $('setAccountRows').innerHTML = `
    <div class="stat-row"><span>${t('acc_fmx_session')}</span><b class="${state.session ? 'stat-accent' : 'stat-warn'}">${state.session ? t('acc_active') : t('acc_none')}</b></div>
    <div class="stat-row"><span>${t('acc_role')}</span><b>${roleBadge() || '—'}</b></div>
    <div class="stat-row"><span>${t('acc_tenant')}</span><b>${esc(state.tenant ? (state.tenant.name || state.tenant.id) : '—')}</b></div>
    <div class="stat-row"><span>${t('acc_stations')}</span><b>${state.stations.map((s) => esc(s.name)).join(' · ') || '—'}</b></div>`;
  const th = document.documentElement.dataset.theme || 'dark';
  $('setTheme').innerHTML = ['dark', 'light']
    .map((x) => `<button class="rc-dur ${th === x ? 'on' : ''}" onclick="setThemeChoice('${x}')">${t(x === 'dark' ? 'th_dark' : 'th_light')}</button>`)
    .join('');
  const hv = Number(localStorage.getItem('hudScale') || 100);
  $('setHud').value = hv;
  $('setHudVal').textContent = hv + '%';
  $('setLang').innerHTML = [['en', 'ENGLISH'], ['de', 'DEUTSCH'], ['tr', 'TÜRKÇE']]
    .map(([c, label]) => `<button class="rc-dur set-lang-btn ${LANG === c ? 'on' : ''}" onclick="setLangChoice('${c}')">${label}</button>`)
    .join('');
  renderStationsCard();
  renderFranchiseCard();
  renderSystemRows();
  renderMailPrefs();
}

async function renderSystemRows() {
  const cloud = !/^(localhost|127\.)/.test(location.hostname);
  let w = state.watchInfo;
  if (!w && state.session) {
    // signed-out / replaced responses are {error:...} — never store those
    try {
      const r = await (await fetch('/api/watch-status')).json();
      if (!r.error) { w = r; state.watchInfo = w; }
    } catch {}
  }
  const relayRow = cloud
    ? `<div class="stat-row"><span>${t('sys_relay')}</span><b class="${w && w.relayOnline ? 'stat-accent' : 'stat-warn'}">${w ? (w.relayOnline ? t('sys_relay_on') : t('sys_relay_off')) : '—'}</b></div>`
    : '';
  $('setSystemRows').innerHTML = `
    <div class="stat-row"><span>${t('sys_env')}</span><b>${cloud ? t('sys_env_cloud') : t('sys_env_local')}</b></div>
    ${relayRow}
    <div class="stat-row"><span>${t('sys_mail')}</span><b class="${w && w.enabled ? 'stat-accent' : 'stat-warn'}">${w ? (w.enabled ? t('acc_active') : t('w_not_conf')) : '—'}</b></div>
    <div class="stat-row"><span>${t('sys_baseline')}</span><b>${w ? `${w.baseline} ${t('sys_days')}` : '—'}</b></div>`;
  renderRelayCard();
}

// ---------- settings: tenant stations + rentalcars location picker ----------
// Admin-only editor over the active tenant's station list. The picker queries
// GET /api/places?q= (rentalcars FTSAutocomplete, proxied through the server /
// relay exactly like rcQuery) and writes the chosen location into station.rc.

let stEdit = null;   // working copy: [{ id, name, rc:{type,loc,label}, isNew }]
let stDirty = false; // keeps in-progress edits alive across re-renders
let stTimer = null;  // shared debounce for the location search
let stSeq = 0;       // only the newest search may paint its results

const stationsFromState = () =>
  state.stations.map((s) => ({
    id: s.id,
    name: s.name,
    rc: s.rc ? { type: s.rc.type, loc: s.rc.loc, label: s.rc.label || '' } : null,
  }));

function stLocLabel(rc) {
  if (!rc || !rc.loc) return t('st_no_loc');
  return (rc.type === 'IATA' ? '✈ ' : '') + (rc.label || rc.loc);
}

function renderStationsCard() {
  if (!$('setStationsCard')) return;
  const admin = isAdmin();
  if (!stDirty) stEdit = stationsFromState();
  $('stAddBtn').classList.toggle('hidden', !admin);
  $('stSaveBtn').classList.toggle('hidden', !admin);
  $('stHint').textContent = t(admin ? 'st_hint_admin' : 'st_hint_staff');
  const dis = admin ? '' : 'disabled';
  $('stList').innerHTML = stEdit.length
    ? stEdit
        .map((x, i) => `
      <div class="st-row" data-i="${i}">
        ${x.isNew
          ? `<input class="field-input st-id" data-f="id" inputmode="numeric" value="${esc(x.id)}" placeholder="${t('st_id')}" ${dis}>`
          : `<span class="st-id">${esc(x.id)}</span>`}
        <input class="field-input st-name" data-f="name" value="${esc(x.name)}" placeholder="${t('st_name_ph')}" maxlength="60" ${dis}>
        <div class="st-pick">
          <input class="field-input st-search" placeholder="${t('st_pick_ph')}" spellcheck="false" autocomplete="off" ${dis}>
          <div class="place-drop hidden"></div>
        </div>
        <span class="st-loc" title="${esc(x.rc ? x.rc.loc : '')}">${esc(stLocLabel(x.rc))}</span>
        <div class="st-actions">${admin ? `<button class="btn btn-ghost btn-xs st-del">${t('st_remove')}</button>` : ''}</div>
      </div>`)
        .join('')
    : `<div class="st-empty">${t('st_none')}</div>`;
}

/** Debounced rentalcars location search painted into `drop` (>=300 ms, newest
 *  query wins). Shared by the STATIONS card and the franchise creator (C2). */
function placeSearch(drop, q) {
  clearTimeout(stTimer);
  if (q.length < 2) {
    drop.innerHTML = `<div class="place-empty">${t('st_type_more')}</div>`;
    drop.classList.remove('hidden');
    return;
  }
  drop.innerHTML = `<div class="place-empty place-loading">${t('st_searching')}</div>`;
  drop.classList.remove('hidden');
  const seq = ++stSeq;
  stTimer = setTimeout(async () => {
    let list = [];
    try {
      list = await api('/api/places?q=' + encodeURIComponent(q));
    } catch (e) {
      if (seq !== stSeq) return;
      drop.innerHTML = `<div class="place-empty">${esc(e.message)}</div>`;
      return;
    }
    if (seq !== stSeq) return; // a newer keystroke already won
    if (!Array.isArray(list) || !list.length) {
      drop.innerHTML = `<div class="place-empty">${t('st_no_results')}</div>`;
      return;
    }
    drop._places = list;
    drop.innerHTML = list
      .map((p, i) => `
        <button class="place-item" data-p="${i}">
          ${p.type === 'IATA' && p.iata ? `<span class="place-iata">✈ ${esc(p.iata)}</span>` : ''}
          <b>${esc(p.label)}</b>
          <span class="place-sub">${esc(p.sublabel || p.country || '')}</span>
        </button>`)
      .join('');
  }, 320);
}

/** Debounced location search for one station row. */
const stSearch = (row, q) => placeSearch(row.querySelector('.place-drop'), q);

const stCloseDrops = () =>
  document.querySelectorAll('#stList .place-drop, #frDrop').forEach((d) => d.classList.add('hidden'));

$('stList').addEventListener('input', (e) => {
  const row = e.target.closest('.st-row');
  if (!row || !isAdmin()) return;
  const x = stEdit[Number(row.dataset.i)];
  if (!x) return;
  if (e.target.classList.contains('st-search')) { stSearch(row, e.target.value.trim()); return; }
  const f = e.target.dataset.f;
  if (f === 'id') x.id = e.target.value.replace(/[^0-9]/g, '');
  else if (f === 'name') x.name = e.target.value;
  stDirty = true;
});

$('stList').addEventListener('click', async (e) => {
  const row = e.target.closest('.st-row');
  if (!row || !isAdmin()) return;
  const i = Number(row.dataset.i);
  const x = stEdit[i];
  if (!x) return;
  const item = e.target.closest('.place-item');
  if (item) {
    const drop = row.querySelector('.place-drop');
    const p = (drop._places || [])[Number(item.dataset.p)];
    if (p) {
      x.rc = { type: p.type, loc: p.loc, label: p.label };
      stDirty = true;
      const loc = row.querySelector('.st-loc');
      loc.textContent = stLocLabel(x.rc);
      loc.title = p.loc;
      row.querySelector('.st-search').value = '';
    }
    drop.classList.add('hidden');
    return;
  }
  if (e.target.closest('.st-del')) {
    if (!(await confirmBox(t('st_remove_confirm', { name: esc(x.name || x.id || '—') })))) return;
    stEdit.splice(i, 1);
    stDirty = true;
    renderStationsCard();
  }
});

document.addEventListener('click', (e) => {
  if (e.target instanceof Element && !e.target.closest('.st-pick')) stCloseDrops();
});

$('stAddBtn').onclick = () => {
  if (!isAdmin()) return;
  if (!stDirty) stEdit = stationsFromState();
  stEdit.push({ id: '', name: '', rc: null, isNew: true });
  stDirty = true;
  renderStationsCard();
};

$('stSaveBtn').onclick = async () => {
  if (!isAdmin()) return;
  const stations = [];
  for (const x of stEdit) {
    const id = Number(x.id);
    if (!Number.isInteger(id) || id <= 0) { toast(t('st_bad_id'), 'error'); return; }
    const name = String(x.name || '').trim();
    if (!name || name.length > 60) { toast(t('st_bad_name'), 'error'); return; }
    if (!x.rc || !x.rc.loc || !['IATA', 'LATLONG'].includes(x.rc.type)) { toast(t('st_bad_rc'), 'error'); return; }
    stations.push({ id, name, rc: { type: x.rc.type, loc: x.rc.loc, label: x.rc.label || name } });
  }
  $('stSaveBtn').disabled = true;
  try {
    await api('/api/stations', { method: 'PUT', body: { stations } });
    stDirty = false;
    toast(t('st_saved'));
    await loadStationMeta();
    // the station list drives every rc query — the rank strip's cache is void
    rcMonth.loadedKey = null;
    state.monthCache.clear();
    if (state.view === 'dashboard') startRcMonth(true);
    renderStationsCard();
    renderDashboard();
  } catch (e) {
    toast(t('st_save_failed', { code: e.message }), 'error');
  } finally {
    $('stSaveBtn').disabled = false;
  }
};

// ---------- C1: USERS view (admin only) ----------
// Every route below is admin-only AND tenant-scoped on the server; the client
// decides nothing about authorisation, it only hides what it must not offer.
// The seeded superadmin additionally sees other tenants and may move a user.

let usrRows = [];

/** 'DD.MM.YY HH:MM' for a Firebase sign-in stamp (ISO or epoch ms). */
function fmtWhen(v) {
  if (!v) return t('usr_never');
  const d = new Date(typeof v === 'number' ? v : String(v));
  if (isNaN(d.getTime())) return t('usr_never');
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const usrIsSelf = (u) =>
  !!state.account && String(u.email || '').toLowerCase() === String(state.account).toLowerCase();

async function loadUsers() {
  if (!isAdmin() || !$('usrTable')) return;
  try {
    const res = await api('/api/users');
    usrRows = Array.isArray(res) ? res : Array.isArray(res && res.users) ? res.users : [];
  } catch (e) {
    usrRows = [];
    $('usrTable').innerHTML = `<div class="drawer-empty">${esc(t('usr_load_failed', { code: e.message }))}</div>`;
    return;
  }
  renderUsersView();
}

function renderUsersView() {
  const el = $('usrTable');
  if (!el) return;
  $('usrHint').textContent = t(isSuperadmin() ? 'usr_hint_super' : 'usr_hint');
  $('usrTenant').classList.toggle('hidden', !isSuperadmin());
  if (!usrRows.length) {
    el.innerHTML = `<div class="drawer-empty">${t('usr_none')}</div>`;
    return;
  }
  const head = `<div class="usr-row usr-head">
    <span>${t('usr_col_user')}</span><span>${t('usr_tenant')}</span><span>${t('usr_col_role')}</span>
    <span>${t('usr_col_status')}</span><span>${t('usr_col_last')}</span><span></span>
  </div>`;
  el.innerHTML = head + usrRows
    .map((u) => {
      const role = u.role === 'admin' ? 'admin' : 'staff';
      const self = usrIsSelf(u);
      const uid = esc(u.uid || '');
      const actions = self
        ? `<span class="usr-self">${t('usr_you')}</span>`
        : `<button class="btn btn-ghost btn-xs" data-act="role" data-uid="${uid}">${t(role === 'admin' ? 'usr_make_staff' : 'usr_make_admin')}</button>
           <button class="btn btn-ghost btn-xs" data-act="disabled" data-uid="${uid}">${t(u.disabled ? 'usr_enable' : 'usr_disable')}</button>
           <button class="btn btn-ghost btn-xs" data-act="delete" data-uid="${uid}">${t('usr_delete')}</button>`;
      return `<div class="usr-row" data-uid="${uid}">
        <span class="usr-user"><b>${esc(u.email || '—')}</b><span class="usr-name">${esc(u.displayName || '')}</span></span>
        <span class="usr-tenant">${esc(u.tenant || '—')}</span>
        <span><span class="usr-role usr-role-${role}">${t(role === 'admin' ? 'role_admin' : 'role_staff')}</span></span>
        <span class="${u.disabled ? 'stat-warn' : 'stat-accent'}">${t(u.disabled ? 'usr_disabled' : 'usr_enabled')}</span>
        <span class="usr-last">${esc(fmtWhen(u.lastSignIn))}</span>
        <span class="usr-actions">${actions}</span>
      </div>`;
    })
    .join('');
}

/** PATCH one user; SELF_LOCKOUT is the server refusing an admin's own demotion. */
async function usrPatch(u, body) {
  try {
    await api('/api/users/' + encodeURIComponent(u.uid), { method: 'PATCH', body });
    toast(t('usr_saved'));
    loadUsers();
  } catch (e) {
    toast(e.message === 'SELF_LOCKOUT' ? t('usr_self_lockout') : t('usr_save_failed', { code: e.message }), 'error');
  }
}

$('usrTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !isAdmin()) return;
  const u = usrRows.find((x) => String(x.uid) === btn.dataset.uid);
  if (!u || usrIsSelf(u)) return;
  const mail = esc(u.email || u.uid);
  if (btn.dataset.act === 'role') {
    const role = u.role === 'admin' ? 'staff' : 'admin';
    if (!(await confirmBox(t('usr_role_confirm', { email: mail, role: t(role === 'admin' ? 'role_admin' : 'role_staff') })))) return;
    await usrPatch(u, { role });
  } else if (btn.dataset.act === 'disabled') {
    const disabled = !u.disabled;
    if (!(await confirmBox(t(disabled ? 'usr_disable_confirm' : 'usr_enable_confirm', { email: mail })))) return;
    await usrPatch(u, { disabled });
  } else if (btn.dataset.act === 'delete') {
    if (!(await confirmBox(t('usr_delete_confirm', { email: mail })))) return;
    try {
      await api('/api/users/' + encodeURIComponent(u.uid), { method: 'DELETE' });
      toast(t('usr_deleted'));
      loadUsers();
    } catch (err) {
      toast(t('usr_save_failed', { code: err.message }), 'error');
    }
  }
});

$('usrRefresh').onclick = loadUsers;

$('usrCreateBtn').onclick = async () => {
  if (!isAdmin()) return;
  const email = $('usrEmail').value.trim();
  const password = $('usrPass').value;
  const displayName = $('usrName').value.trim();
  const role = $('usrRoleSel').value === 'admin' ? 'admin' : 'staff';
  const tenant = isSuperadmin() ? $('usrTenant').value.trim() : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast(t('usr_bad_email'), 'error'); return; }
  if (!password || password.length < 8) { toast(t('usr_bad_pass'), 'error'); return; }
  const body = { email, password, role };
  if (displayName) body.displayName = displayName;
  if (tenant) body.tenant = tenant;
  $('usrCreateBtn').disabled = true;
  try {
    await api('/api/users', { method: 'POST', body });
    // the password lives exactly as long as this request — never logged, never
    // echoed back, and wiped from the form the moment the user exists
    $('usrPass').value = '';
    $('usrEmail').value = '';
    $('usrName').value = '';
    toast(t('usr_created', { email }));
    loadUsers();
  } catch (e) {
    toast(t('usr_create_failed', { code: e.message }), 'error');
  } finally {
    $('usrCreateBtn').disabled = false;
  }
};

// ---------- C2: franchises (tenants) in Settings ----------
// A normal admin sees (and may rename) their own franchise. The superadmin also
// creates new ones — together with the airport(s) they will use, through the
// same /api/places picker the STATIONS card uses.

let frRows = [];
let frStations = []; // create form: [{ id, name, rc:{type,loc,label} }]

async function loadTenants() {
  if (!isAdmin() || !$('frList')) return;
  try {
    const res = await api('/api/tenants');
    frRows = Array.isArray(res) ? res : Array.isArray(res && res.tenants) ? res.tenants : [];
  } catch (e) {
    frRows = [];
    $('frList').innerHTML = `<div class="drawer-empty">${esc(t('fr_load_failed', { code: e.message }))}</div>`;
    return;
  }
  renderFranchiseList();
}

function renderFranchiseList() {
  const el = $('frList');
  if (!el) return;
  el.innerHTML = frRows.length
    ? frRows
        .map((f) => `<div class="fr-row" data-id="${esc(f.id)}">
          <span class="fr-name"><b>${esc(f.name || f.id)}</b><span class="fr-id">${esc(f.id)}</span></span>
          <span class="fr-base">${esc(f.fmxBase || '—')}</span>
          <span class="fr-chips">${t('fr_stations_n', { n: f.stationCount != null ? f.stationCount : 0 })} · ${t('fr_users_n', { n: f.userCount != null ? f.userCount : 0 })}</span>
          <span class="fr-actions"><button class="btn btn-ghost btn-xs" data-act="rename" data-id="${esc(f.id)}">${t('fr_rename')}</button></span>
        </div>`)
        .join('')
    : `<div class="drawer-empty">${t('fr_none')}</div>`;
}

function renderFranchiseCard() {
  const card = $('setFranchiseCard');
  if (!card) return;
  card.classList.toggle('hidden', !isAdmin());
  $('frNewBtn').classList.toggle('hidden', !isSuperadmin());
  $('frHint').textContent = t(isSuperadmin() ? 'fr_hint_super' : 'fr_hint_admin');
  if (!isSuperadmin()) $('frCreate').classList.add('hidden');
  renderFrStations();
  renderFranchiseList();
  if (isAdmin()) loadTenants();
}

function renderFrStations() {
  const el = $('frStations');
  if (!el) return;
  el.innerHTML = frStations
    .map((x, i) => `<div class="fr-st-row" data-i="${i}">
      <input class="field-input st-id" data-f="id" inputmode="numeric" value="${esc(x.id)}" placeholder="${t('st_id')}">
      <input class="field-input st-name" data-f="name" value="${esc(x.name)}" placeholder="${t('st_name_ph')}" maxlength="60">
      <span class="st-loc" title="${esc(x.rc ? x.rc.loc : '')}">${esc(stLocLabel(x.rc))}</span>
      <button class="btn btn-ghost btn-xs fr-st-del">${t('st_remove')}</button>
    </div>`)
    .join('');
}

$('frNewBtn').onclick = () => {
  if (!isSuperadmin()) return;
  $('frCreate').classList.toggle('hidden');
};

$('frCancelBtn').onclick = () => {
  $('frCreate').classList.add('hidden');
  frStations = [];
  renderFrStations();
};

$('frSearch').addEventListener('input', (e) => {
  if (!isSuperadmin()) return;
  placeSearch($('frDrop'), e.target.value.trim());
});

$('frDrop').addEventListener('click', (e) => {
  const item = e.target.closest('.place-item');
  if (!item || !isSuperadmin()) return;
  const p = ($('frDrop')._places || [])[Number(item.dataset.p)];
  if (p) {
    frStations.push({ id: '', name: p.label, rc: { type: p.type, loc: p.loc, label: p.label } });
    renderFrStations();
  }
  $('frDrop').classList.add('hidden');
  $('frSearch').value = '';
});

$('frStations').addEventListener('input', (e) => {
  const row = e.target.closest('.fr-st-row');
  if (!row) return;
  const x = frStations[Number(row.dataset.i)];
  if (!x) return;
  if (e.target.dataset.f === 'id') x.id = e.target.value.replace(/[^0-9]/g, '');
  else if (e.target.dataset.f === 'name') x.name = e.target.value;
});

$('frStations').addEventListener('click', (e) => {
  const row = e.target.closest('.fr-st-row');
  if (!row || !e.target.closest('.fr-st-del')) return;
  frStations.splice(Number(row.dataset.i), 1);
  renderFrStations();
});

$('frList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="rename"]');
  if (!btn || !isAdmin()) return;
  const f = frRows.find((x) => String(x.id) === btn.dataset.id);
  if (!f) return;
  const name = await inputBox(t('fr_rename_prompt', { id: esc(f.id) }), f.name || '');
  if (name === null) return;
  const clean = String(name).trim();
  if (!clean || clean.length > 60) { toast(t('fr_bad_name'), 'error'); return; }
  try {
    await api('/api/tenants/' + encodeURIComponent(f.id), { method: 'PATCH', body: { name: clean } });
    toast(t('fr_saved'));
    loadTenants();
    if (state.tenant && state.tenant.id === f.id) loadStationMeta().catch(() => {});
  } catch (err) {
    toast(t('fr_save_failed', { code: err.message }), 'error');
  }
});

$('frCreateBtn').onclick = async () => {
  if (!isSuperadmin()) return;
  const id = $('frId').value.trim().toLowerCase();
  const name = $('frName').value.trim();
  const fmxBase = $('frBase').value.trim().replace(/\/+$/, '');
  if (!/^[a-z0-9-]{2,32}$/.test(id)) { toast(t('fr_bad_id'), 'error'); return; }
  if (!name || name.length > 60) { toast(t('fr_bad_name'), 'error'); return; }
  if (!/^https:\/\/[^\s]+$/.test(fmxBase)) { toast(t('fr_bad_base'), 'error'); return; }
  const stations = [];
  for (const x of frStations) {
    const sid = Number(x.id);
    if (!Number.isInteger(sid) || sid <= 0) { toast(t('fr_bad_stations'), 'error'); return; }
    const sname = String(x.name || '').trim();
    if (!sname || sname.length > 60) { toast(t('fr_bad_stations'), 'error'); return; }
    if (!x.rc || !x.rc.loc) { toast(t('fr_bad_stations'), 'error'); return; }
    stations.push({ id: sid, name: sname, rc: { type: x.rc.type, loc: x.rc.loc, label: x.rc.label || sname } });
  }
  if (!stations.length) { toast(t('fr_bad_stations'), 'error'); return; }
  $('frCreateBtn').disabled = true;
  try {
    await api('/api/tenants', { method: 'POST', body: { id, name, fmxBase, stations } });
    toast(t('fr_created', { id }));
    $('frId').value = '';
    $('frName').value = '';
    $('frBase').value = '';
    frStations = [];
    renderFrStations();
    $('frCreate').classList.add('hidden');
    loadTenants();
  } catch (e) {
    toast(t('fr_create_failed', { code: e.message }), 'error');
  } finally {
    $('frCreateBtn').disabled = false;
  }
};

// ---------- relay machines card (per-machine installers + connected workers) ----------

function fmtAgo(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return s < 120 ? `${s}s` : `${Math.floor(s / 60)}m`;
}

function renderRelayCard() {
  const el = $('setRelayCard');
  if (!el) return;
  const w = state.watchInfo;
  // during rollout the live server may not send relays yet — treat as empty
  const relays = w && Array.isArray(w.relays) ? w.relays.filter((x) => x && x.name) : [];
  const rows = relays.length
    ? relays.map((x) => `<div class="stat-row"><span>${esc(x.name)}</span><b>${t('relay_ago', { t: fmtAgo(x.agoSec) })}</b></div>`).join('')
    : `<div class="stat-row"><span>${t('relay_none')}</span></div>`;
  const isMac = /mac/i.test(navigator.platform || '');
  const dis = state.session ? '' : 'disabled';
  el.innerHTML = `
    <div class="stat-rows">
      <div class="stat-row"><span>${t('relay_workers')}</span><b>${relays.length}</b></div>
      ${rows}
    </div>
    <div class="relay-dl">
      <button class="btn btn-ghost relay-dl-btn${isMac ? ' on' : ''}" ${dis} onclick="relayInstall('mac')">MAC</button>
      <button class="btn btn-ghost relay-dl-btn${isMac ? '' : ' on'}" ${dis} onclick="relayInstall('windows')">WINDOWS</button>
    </div>
    <div class="relay-cmds">
      <div class="relay-cmd"><span>MAC</span><code>bash ~/Downloads/install-gm-relay.sh</code></div>
      <div class="relay-cmd"><span>WIN</span><code>${t('relay_win_dblclick')}</code></div>
    </div>
    <div class="set-hint">${t('relay_install_hint')}</div>`;
}

// fetch + blob instead of location.href: a 401/404 must show a toast, not
// navigate the SPA to a bare JSON error page (only 200 carries the attachment)
async function relayInstall(os) {
  if (!state.session) { openSessionModal(''); return; }
  const mac = os === 'mac';
  try {
    const res = await fetch(mac ? '/api/relay-install/mac' : '/api/relay-install/windows');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setSession(false);
        openSessionModal(data.error === 'SESSION_REPLACED' ? t('session_replaced') : '');
      }
      throw new Error(data.error || 'HTTP ' + res.status);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = mac ? 'install-gm-relay.sh' : 'install-gm-relay.bat';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    toast(t('relay_dl_failed', { code: e.message }), 'error');
  }
}
window.relayInstall = relayInstall;

window.setThemeChoice = (x) => { applyTheme(x); renderSettings(); };
window.setLangChoice = (c) => applyLang(c);

$('setHud').addEventListener('input', (e) => applyHud(Number(e.target.value)));
$('setReconnect').onclick = () => openSessionModal('');
$('setLogout').onclick = signOutAll;

// ---------- activity logs ----------

const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

let lastLogs = [];
// batch id -> { n, ok } over the WHOLE server-side history: a bulk sweep is
// longer than the page we fetch, so the collapsed row must not count the slice
let lastBatchTotals = {};

function logEntryHtml(l, i, compact) {
  const d = new Date(l.ts);
  const when = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const target = l.day
    ? `${String(l.day).padStart(2, '0')} ${MONTHS_SHORT[(l.month || 1) - 1]} ${l.year} · ${l.duration >= OPEN_DURATION ? l.duration + '+' : l.duration}D`
    : l.file ? esc(l.file) : `#${l.ruleid || '—'}`;
  const fmt = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v + '%');
  const change = l.action === 'backup' ? '' : `<span class="log-change"><b>${fmt(l.before)}</b> &rarr; <b>${fmt(l.after)}</b></span>`;
  const status = l.ok
    ? `<span class="log-status-ok">OK${l.verified === false ? ' (unverified)' : ''}</span>`
    : `<span class="log-status-err">FAILED ${esc(l.error || '')}</span>`;
  const canRevert =
    !compact && l.ok && ['create', 'update', 'delete'].includes(l.action) &&
    l.day && l.station;
  const revertBtn = canRevert
    ? `<button class="btn btn-ghost btn-xs" onclick="revertLog(${i})" title="Undo this change in DPS">REVERT</button>`
    : '';
  const vendor = l.vendor && l.vendor !== 'ALL' ? ` · ${esc(l.vendor)}` : '';
  const actionCls = l.action.startsWith('restore') ? 'update' : l.action;
  return `<div class="log-entry">
    <div class="log-line1"><span>${when} · ${esc(l.user || '')}</span><span>${esc(l.stationName || '')}${l.ruleid ? ' · #' + l.ruleid : ''}${vendor}</span></div>
    <div class="log-line2"><span class="log-action ${actionCls}">${l.action.toUpperCase()}</span><span class="log-target">${target}</span>${change}${status}${revertBtn}</div>
  </div>`;
}

// batchTag -> i18n label for the collapsed row (anything else reads as a scan)
const BATCH_LABELS = { autoscan: 'batch_autoscan_label', bulk: 'batch_bulk_label' };

// one collapsed row for a whole scan batch: newest entry's station/timestamp,
// ok/fail counts and (full view only) a single REVERT ALL
function logBatchHtml(group, compact) {
  const batchSafe = /^[a-z0-9-]{1,32}$/i.test(String(group[0].batch || '')) ? group[0].batch : null;
  const l = group[0]; // logs arrive newest-first
  const d = new Date(l.ts);
  const when = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // the batch may continue past this page — count it server-wide when we know
  const tot = (batchSafe && lastBatchTotals[batchSafe]) || null;
  const n = tot ? tot.n : group.length;
  const ok = tot ? tot.ok : group.filter((x) => x.ok).length;
  const fail = n - ok;
  const status = fail
    ? `<span class="log-status-err">${ok} OK · ${fail} FAILED</span>`
    : `<span class="log-status-ok">${ok} OK</span>`;
  const revertBtn = compact
    ? ''
    : (batchSafe ? `<button class="btn btn-ghost btn-xs" onclick="revertBatch('${batchSafe}')">REVERT ALL</button>` : '');
  return `<div class="log-entry log-batch">
    <div class="log-line1"><span>${when} · ${esc(l.user || '')}</span><span>${esc(l.stationName || '')}</span></div>
    <div class="log-line2"><span class="log-batch-ico">&#8982;</span><span class="log-target">${t(BATCH_LABELS[group[0].batchTag] || 'batch_scan_label', { n })}</span>${status}${revertBtn}</div>
  </div>`;
}

// consecutive entries sharing the same l.batch collapse into one batch row
function renderLogList(logs, compact) {
  const out = [];
  let i = 0;
  while (i < logs.length) {
    const l = logs[i];
    if (l.batch) {
      let j = i;
      while (j < logs.length && logs[j].batch === l.batch) j++;
      out.push(logBatchHtml(logs.slice(i, j), compact));
      i = j;
    } else {
      out.push(logEntryHtml(l, i, compact));
      i++;
    }
  }
  return out.join('');
}

async function refreshLogs() {
  lastSync.logs = Date.now();
  try {
    const { logs, batchTotals } = await (await fetch('/api/logs?limit=200')).json();
    lastLogs = logs;
    lastBatchTotals = batchTotals || {};
    const list = $('logsList');
    list.innerHTML = logs.length
      ? renderLogList(logs, false)
      : '<div class="drawer-empty">No activity yet.</div>';
    $('dashActivity').innerHTML = logs.length
      ? renderLogList(logs.slice(0, 8), true)
      : '<div class="drawer-empty">No activity yet.</div>';
  } catch {}
}

// undo one log entry in DPS (create -> delete, update -> put back, delete -> recreate)
// — shared by the per-entry REVERT and the batch REVERT ALL
async function revertOne(l) {
  const base = { station: l.station, day: l.day, duration: l.duration, month: l.month, year: l.year };
  // a rule written against a subset of the vehicle groups goes back with that
  // same coverage — omitting it would silently widen it to all 39
  if (Array.isArray(l.groupIds) && l.groupIds.length) base.vehicleIds = l.groupIds;
  if (l.action === 'create') {
    await api(`/api/rule/${l.ruleid}?station=${l.station}&day=${l.day}&duration=${l.duration}&month=${l.month}&year=${l.year}&prevPct=${l.after}`, { method: 'DELETE' });
  } else if (l.action === 'update') {
    await api(`/api/rule/${l.ruleid}`, { method: 'PUT', body: { ...base, pct: l.before, active: true, prevPct: l.after, vendors: l.vendor ? l.vendor.split(',') : ['ALL'] } });
  } else if (l.action === 'delete') {
    await api('/api/rule', { method: 'POST', body: { ...base, pct: l.before, active: true, vendors: l.vendor ? l.vendor.split(',') : ['ALL'] } });
  }
}

async function revertLog(i) {
  const l = lastLogs[i];
  if (!l) return;
  const fmt = (v) => (v == null ? '—' : v + '%');
  if (!(await confirmBox(`Revert this ${l.action}? ${String(l.day).padStart(2, '0')} ${MONTHS_SHORT[(l.month || 1) - 1]} ${l.year} · ${l.duration}D will go back to ${fmt(l.before)} (${l.stationName}).`)))
    return;
  try {
    await revertOne(l);
    toast(t('t_reverted'));
    // the server rc cache is keyed by the log row's own station/date — always
    // purge it; only the visible refresh depends on what is selected
    await fetch('/api/rc-invalidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ station: l.station, year: l.year, month: l.month, day: l.day }),
    }).catch(() => {});
    state.monthCache.delete(`${l.station}:${l.year}:${l.month}`);
    if (l.station === state.station && l.year === state.year && l.month === state.month) {
      loadGrid();
      rcMonth.loadedKey = null;
      if (state.view === 'dashboard') startRcMonth(true);
    }
    refreshLogs();
  } catch (e) {
    toast('Revert failed: ' + e.message, 'error');
  }
}
window.revertLog = revertLog;

// one-click revert of a whole scan batch: single confirm, then every entry of
// the batch in lastLogs order (newest first — the oldest change lands last)
async function revertBatch(batch) {
  // the batch is fetched whole from the server, never sliced out of the page:
  // a 180d x 5D sweep writes 900 rows and lastLogs only holds the newest 200
  let rows;
  try {
    rows = (await api(`/api/logs?batch=${encodeURIComponent(batch)}`)).logs || [];
  } catch (e) {
    toast('Revert failed: ' + e.message, 'error');
    return;
  }
  const entries = rows.filter(
    (l) => l.ok && ['create', 'update', 'delete'].includes(l.action) && l.day && l.station
  );
  if (!entries.length) return;
  if (!(await confirmBox(t('revert_batch_confirm', { n: entries.length })))) return;
  let ok = 0, fail = 0;
  for (const l of entries) {
    try {
      await revertOne(l);
      ok++;
    } catch (e) {
      fail++;
      if (String(e.message).includes('SESSION')) break;
    }
  }
  // purge the server rc cache once per touched day, like the apply flow does
  const seen = new Set();
  const uniqDays = [];
  for (const l of entries) {
    const dk = `${l.station}:${l.year}:${l.month}:${l.day}`;
    if (!seen.has(dk)) { seen.add(dk); uniqDays.push(l); }
  }
  await Promise.all(uniqDays.map((l) => fetch('/api/rc-invalidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ station: l.station, year: l.year, month: l.month, day: l.day }),
  }).catch(() => {})));
  rcMonth.loadedKey = null;
  const monthKeys = new Set(entries.map((l) => `${l.station}:${l.year}:${l.month}`));
  for (const mk of monthKeys) state.monthCache.delete(mk);
  if (monthKeys.has(`${state.station}:${state.year}:${state.month}`)) {
    loadGrid();
    if (state.view === 'dashboard') startRcMonth(true);
  }
  refreshLogs();
  toast(t('revert_batch_done', { ok, fail }), fail ? 'warn' : undefined);
}
window.revertBatch = revertBatch;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('logsRefresh').onclick = refreshLogs;

// ---------- view router ----------

function pageTransition() {
  const fx = $('pageFx');
  if (!fx) return;
  fx.classList.remove('on');
  void fx.offsetWidth; // restart the animation
  fx.classList.add('on');
  clearTimeout(pageTransition._t);
  pageTransition._t = setTimeout(() => fx.classList.remove('on'), 520);
}

function showView(name) {
  // USERS is admin-only — a staff hash lands on the dashboard instead
  if (name === 'users' && !isAdmin()) name = 'dashboard';
  if (state.view !== name) pageTransition();
  state.view = name;
  for (const v of VIEWS) {
    $('view-' + v).classList.toggle('hidden', v !== name);
  }
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.classList.toggle('on', b.dataset.view === name)
  );
  if (name === 'activity') refreshLogs();
  if (name === 'dashboard') { renderDashboard(); startRcMonth(); refreshWatchStatus(); }
  if (name === 'analytics') { scheduleChart(); renderInsights(); }
  if (name === 'users') loadUsers();
  if (name === 'settings') renderSettings();
  if (location.hash !== '#' + name) location.hash = name;
}

document.querySelectorAll('[data-view]').forEach((b) => {
  if (b.dataset.view) b.addEventListener('click', () => showView(b.dataset.view));
});

window.addEventListener('hashchange', () => {
  const h = location.hash.replace('#', '');
  if (VIEWS.includes(h) && h !== state.view) showView(h);
});

// ---------- dashboard ----------

function renderDashTiles() {
  const today = new Date();
  const isCurMonth = state.year === today.getFullYear() && state.month === today.getMonth() + 1;
  const todayData = isCurMonth ? rcMonth.days.get(today.getDate()) : null;
  const w = state.watchInfo;
  const rankCls = todayData && todayData.rank ? (todayData.rank <= 3 ? 'tile-accent' : todayData.rank <= 7 ? 'tile-warn' : 'tile-error') : '';
  $('dashTiles').innerHTML = `
    <div class="tile">
      <div class="tile-label">${t('tile_rank_today')} · ${rcMonth.dur}D</div>
      <div class="tile-value ${rankCls}">${todayData && todayData.rank ? '#' + todayData.rank : '—'}</div>
      <div class="tile-sub">${todayData && todayData.price ? todayData.price.toFixed(2) + ' ' + todayData.currency + ' · ' + t('of_offers', { n: todayData.total }) : t('no_data_yet')}</div>
    </div>
    <div class="tile">
      <div class="tile-label">${t('tile_market1')}</div>
      <div class="tile-value">${todayData && todayData.top1 ? (todayData.top1.logo ? `<img class="rc-logo" src="${esc(todayData.top1.logo)}" onerror="this.style.display='none'">` : '') + esc(todayData.top1.supplier) : '—'}</div>
      <div class="tile-sub">${todayData && todayData.top1 ? todayData.top1.price.toFixed(2) + ' ' + todayData.currency : ''}</div>
    </div>
    <div class="tile">
      <div class="tile-label">${t('tile_watch')}</div>
      <div class="tile-value ${w && w.enabled ? 'tile-accent' : 'tile-warn'}">${w ? (w.enabled ? t('active_w') : t('off_w')) : '—'}</div>
      <div class="tile-sub">${w ? w.alertsSent + ' ' + t('alerts_sent') + ' · ' + t('baseline_w') + ' ' + w.baseline : ''}</div>
    </div>
    <div class="tile">
      <div class="tile-label">${t('tile_restore')}</div>
      <div class="tile-value">${state.backupsCount != null ? state.backupsCount : '—'}</div>
      <div class="tile-sub">${state.lastBackupTs ? t('last_w') + ' ' + new Date(state.lastBackupTs).toLocaleString('de-CH', { hour12: false }).slice(0, 17) : t('none_yet')}</div>
    </div>`;
}

function renderDashboard() {
  renderDashTiles();
  // station cards from month cache (current month)
  const wrap = $('dashStations');
  wrap.innerHTML = state.stations
    .map((s) => {
      const entry = state.monthCache.get(`${s.id}:${state.year}:${state.month}`);
      let body;
      if (entry && entry.cells.size) {
        const cells = [...entry.cells.values()];
        const act = cells.filter((c) => c.active);
        const pcts = act.map((c) => c.pct);
        const avg = act.length ? (pcts.reduce((a, b) => a + b, 0) / act.length).toFixed(1) + '%' : '—';
        const uncovered = countUncovered(entry);
        const daysTotal = state.grid ? state.grid.daysInMonth : 31;
        const coveredDays = new Set([...entry.cells.values()].map((c) => c.day)).size;
        const covPct = Math.round((coveredDays / daysTotal) * 100);
        body = `<div class="stat-big">${avg}</div>
          <div class="stat-rows">
            <div class="stat-row"><span>AVG CHANGE · ${MONTHS_SHORT[state.month - 1]} ${state.year}</span><b>min ${act.length ? Math.min(...pcts) : '—'}% · max ${act.length ? Math.max(...pcts) : '—'}%</b></div>
            <div class="stat-row"><span>GRID CELLS / RULES</span><b>${cells.length} / ${entry.totalRules}</b></div>
            <div class="stat-row"><span>INACTIVE CELLS</span><b>${cells.length - act.length}</b></div>
            <div class="stat-row"><span>UNCOVERED FUTURE DAYS</span><b class="${uncovered ? 'stat-warn' : 'stat-accent'}">${uncovered}</b></div>
            <div class="stat-row"><span>DAY COVERAGE</span><b>${coveredDays}/${daysTotal} (${covPct}%)</b></div>
          </div>
          <div class="cov-bar"><div class="cov-bar-fill" style="width:${covPct}%"></div></div>`;
      } else {
        body = `<div class="stat-big">—</div><div class="stat-rows"><div class="stat-row"><span>Not loaded — click to open the grid.</span></div></div>`;
      }
      return `<div class="card stat-card" onclick="openStation(${s.id})">
        <div class="card-title">${s.name.toUpperCase()}</div>${body}</div>`;
    })
    .join('');

  // mini chart copy
  if (window.__lastChartSvg) {
    $('dashChart').innerHTML = window.__lastChartSvg;
    $('dashChartMonth').textContent = `${MONTHS_SHORT[state.month - 1]} ${state.year}`;
  }
  refreshBackups();
  refreshLogs();
}

function openStation(id) {
  state.station = id;
  renderStations();
  showView('grid');
  loadGrid();
}
window.openStation = openStation;

function countUncovered(entry) {
  if (!state.grid) return 0;
  const today = new Date();
  let n = 0;
  for (let d = 1; d <= state.grid.daysInMonth; d++) {
    const dt = new Date(state.year, state.month - 1, d);
    if (dt < new Date(today.getFullYear(), today.getMonth(), today.getDate())) continue;
    if (!state.durations.some((dur) => entry.cells.has(key(d, dur)))) n++;
  }
  return n;
}

// ---------- restore points ----------

async function refreshBackups() {
  try {
    const { backups } = await (await fetch('/api/backups')).json();
    state.backupsCount = backups.length;
    state.lastBackupTs = backups[0] ? backups[0].ts : null;
    renderDashTiles();
    $('backupList').innerHTML = backups.length
      ? backups
          .map((b) => {
            const d = new Date(b.ts);
            const when = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            return `<div class="backup-row"><span>${when} · ${(b.size / 1024).toFixed(0)} KB</span>
              <button class="btn btn-ghost btn-xs" onclick="restoreFlow('${esc(b.file)}')">RESTORE</button></div>`;
          })
          .join('')
      : '<div class="drawer-empty">No restore points yet.</div>';
  } catch {}
}

let backupEs = null; // active backup progress stream

$('backupBtn').onclick = () => {
  if (!state.session) return openSessionModal('');
  if (backupEs) return;
  $('backupBtn').disabled = true;
  $('backupBtn').textContent = t('backup_running', { done: 0, total: '…' });
  const bes = new EventSource('/api/backup/stream');
  backupEs = bes;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    // close BEFORE anything else — EventSource auto-reconnects on a server
    // res.end and would silently start a second full backup in a loop
    bes.close();
    if (backupEs === bes) backupEs = null;
    $('backupBtn').disabled = false;
    // keep the data-i18n span so a later language switch still re-translates it
    $('backupBtn').innerHTML = `+ <span data-i18n="create">${t('create')}</span>`;
  };
  bes.addEventListener('meta', (ev) => {
    const m = JSON.parse(ev.data);
    $('backupBtn').textContent = t('backup_running', { done: 0, total: m.total });
  });
  bes.addEventListener('progress', (ev) => {
    const p = JSON.parse(ev.data);
    $('backupBtn').textContent = t('backup_running', { done: p.done, total: p.total });
  });
  bes.addEventListener('done', (ev) => {
    const d = JSON.parse(ev.data);
    finish();
    const failed = d.failed || 0;
    toast(failed ? t('backup_done_failed', { failed }) : t('backup_done'), failed ? 'warn' : undefined);
    refreshBackups();
  });
  bes.addEventListener('fail', (ev) => {
    const d = JSON.parse(ev.data);
    finish();
    toast('Backup failed: ' + d.error, 'error');
    refreshBackups();
  });
  bes.onerror = () => {
    if (finished) return;
    finish();
    toast('Backup failed: STREAM_ERROR', 'error');
    // the function may still have completed the backup after a cut stream —
    // the refreshed list then shows the truth instead of a false "failed"
    refreshBackups();
    // a middleware 401 reaches EventSource only as a silent onerror
    if (state.session) {
      fetch('/api/session').then((r) => r.json()).then((s) => {
        if (s.replaced === true) { setSession(false); openSessionModal(t('session_replaced')); }
      }).catch(() => {});
    }
  };
};

async function restoreFlow(file) {
  const stName = stationName();
  const mLabel = `${MONTHS[state.month - 1]} ${state.year}`;
  if (!(await confirmBox(`Restore ${stName} / ${mLabel} from ${file}? A dry-run diff will be shown first.`))) return;
  try {
    const dry = await api('/api/restore', { method: 'POST', body: { file, station: state.station, year: state.year, month: state.month, dryRun: true } });
    if (!dry.actions.length) { toast('Nothing to restore — current grid already matches this restore point.'); return; }
    const counts = { create: 0, update: 0, delete: 0 };
    dry.actions.forEach((a) => counts[a.type]++);
    if (!(await confirmBox(`Restore will apply ${dry.actions.length} change(s): ${counts.create} create, ${counts.update} update, ${counts.delete} delete. Proceed?`))) return;
    toast('Restoring…');
    const r = await api('/api/restore', { method: 'POST', body: { file, station: state.station, year: state.year, month: state.month } });
    const fail = r.results.filter((x) => !x.ok).length;
    toast(`Restore finished: ${r.results.length - fail} ok, ${fail} failed.`, fail ? 'warn' : undefined);
    // month-wide server rc purge (no day) — await it so the forced re-stream
    // below cannot re-serve the entries just scheduled for deletion
    await fetch('/api/rc-invalidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ station: state.station, year: state.year, month: state.month }),
    }).catch(() => {});
    rcMonth.loadedKey = null;
    if (state.view === 'dashboard') startRcMonth(true);
    state.monthCache.delete(cacheKey());
    loadGrid();
    refreshLogs();
  } catch (e) {
    toast('Restore failed: ' + e.message, 'error');
  }
}
window.restoreFlow = restoreFlow;

// ---------- vendor selector ----------

async function loadVendors() {
  try {
    const { vendors } = await api('/api/vendors');
    state.vendors = vendors;
    const sel = $('vendorSel');
    const opts = (vendors.includes('ALL') ? vendors : ['ALL', ...vendors])
      .map((v) => `<option ${v === 'ALL' ? 'selected' : ''}>${esc(v)}</option>`)
      .join('');
    sel.innerHTML = opts;
  } catch {}
}

$('vendorSel').onchange = (e) => {
  state.vendor = e.target.value;
  if (state.vendor !== 'ALL')
    toast(`Writes now target vendor ${state.vendor} (grid still shows all rules).`, 'warn');
};

// ---------- copy month ----------

$('copyMonthBtn').onclick = async () => {
  if (!state.entry || !state.entry.cells.size) {
    toast('Nothing to copy in this month.', 'warn');
    return;
  }
  let m = state.month + 1, y = state.year;
  if (m > 12) { m = 1; y++; }
  const raw = await inputBox(
    `Copy ${MONTHS[state.month - 1]} ${state.year} (${state.entry.cells.size} cells) to month (MM.YYYY):`,
    `${String(m).padStart(2, '0')}.${y}`
  );
  if (!raw) return;
  const mt = /^(\d{1,2})[./-](\d{4})$/.exec(raw.trim());
  if (!mt) { toast('Use the format MM.YYYY', 'error'); return; }
  const tm = Number(mt[1]), ty = Number(mt[2]);
  if (tm < 1 || tm > 12) { toast('Invalid month.', 'error'); return; }
  if (tm === state.month && ty === state.year) { toast('Target equals source.', 'error'); return; }
  if (state.staged.size && !(await confirmBox('Discard currently staged changes?'))) return;
  state.staged.clear();
  state.pendingCopy = {
    targetKey: `${state.station}:${ty}:${tm}`,
    cells: [...state.entry.cells.values()].map((c) => ({ day: c.day, dur: c.dur, pct: c.pct })),
    fromLabel: `${MONTHS_SHORT[state.month - 1]} ${state.year}`,
  };
  state.month = tm;
  state.year = ty;
  loadGrid();
};

// ---------- rentalcars top-10 analysis (runs ONLY on explicit icon click) ----------

// raw rentalcars category value -> display category key. The server returns the
// RAW api values on every top row (row.categories); the client groups them here.
// A car can carry several raw values, so it may belong to two display categories.
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
// display order + icon + i18n label key (ALL is the pseudo-category, always first)
const RC_CAT_DISPLAY = [
  { key: 'ECONOMY', ico: '🚗', i18n: 'cat_economy' },
  { key: 'COMPACT', ico: '🚙', i18n: 'cat_compact' },
  { key: 'MIDSIZE', ico: '🚘', i18n: 'cat_midsize' },
  { key: 'LARGE', ico: '🏎', i18n: 'cat_large' },
  { key: 'WAGON', ico: '🚐', i18n: 'cat_wagon' },
  { key: 'SUV', ico: '🛻', i18n: 'cat_suv' },
  { key: 'MINIVAN', ico: '🚌', i18n: 'cat_minivan' },
];

const rcIsGm = (x) => /green motion/i.test(x.supplier);

function rowInCat(x, cat) {
  return Array.isArray(x.categories) && x.categories.some((v) => RC_CAT_MAP[v] === cat);
}

// category-scoped copy of the server data. ALL -> the raw data (today's
// behaviour: full-list gmOffers/compPrices). A specific display category ->
// top/gmOffers/compPrices/gmRank/gmPrice recomputed from the annotated top rows,
// so placement + fleet math target that category's own price ladder.
function rcBuildView() {
  const r = rcCtx && rcCtx.data;
  if (!r) { if (rcCtx) rcCtx.view = null; return; }
  if (!rcCtx.cat || rcCtx.cat === 'ALL') { rcCtx.view = r; return; }
  const cat = rcCtx.cat;
  const rowsF = (r.top || []).filter((x) => rowInCat(x, cat));
  if (!rowsF.length) { rcCtx.cat = 'ALL'; rcCtx.view = r; return; }
  const gmIdx = rowsF.findIndex(rcIsGm);
  rcCtx.view = {
    ...r,
    top: rowsF,
    gmOffers: rowsF.filter(rcIsGm).map((x) => ({ vehicle: x.vehicle, price: x.price })),
    compPrices: rowsF.filter((x) => !rcIsGm(x)).map((x) => x.price),
    gmRank: gmIdx >= 0 ? gmIdx + 1 : null,
    gmPrice: gmIdx >= 0 ? rowsF[gmIdx].price : null,
    total: rowsF.length,
  };
}

// which display categories are actually present in the top list, in display
// order, each with GM's rank inside it (from the price-sorted filtered rows)
function rcCatsPresent(r, projFactor) {
  const out = [];
  for (const d of RC_CAT_DISPLAY) {
    const rowsF = r.top.filter((x) => rowInCat(x, d.key));
    if (!rowsF.length) continue;
    // with a projection live, re-price GM's rows by the same factor and re-sort:
    // the operator sees what the new % does to EVERY category at once
    const rows = projFactor
      ? rowsF
          .map((x) => (rcIsGm(x) ? { ...x, price: x.price * projFactor } : x))
          .sort((a, b) => a.price - b.price)
      : rowsF;
    const gmIdx = rows.findIndex(rcIsGm);
    out.push({
      ...d, count: rows.length, projected: !!projFactor,
      rank: gmIdx >= 0 ? gmIdx + 1 : null,
    });
  }
  return out;
}

/** price multiplier an active projection applies to every GM offer */
function rcProjFactor() {
  const sim = rcCtx.placed;
  const r = rcCtx.data;
  if (!sim || !sim.proj || !r || r.gmPrice == null) return null;
  // the SAME guarded base as the table (gmServedBase) — rebuilding it from raw
  // cellMap here made the category chips rank GM at the old price (#8) while
  // the table showed the projected one (#2) during every post-confirm window
  const { base } = gmServedBase(r);
  if (base == null) return null;
  const f = (base * (1 + sim.newPct / 100)) / r.gmPrice;
  return isFinite(f) && f > 0 ? f : null;
}

// category chip row (R3): ALL first, then every present display category, each
// showing icon + label + GM's rank-within-category badge. Active chip = .on.
function rcCatsHtml() {
  const r = rcCtx.data;
  if (!r || !Array.isArray(r.top) || !r.top.length) return '';
  const cur = rcCtx.cat || 'ALL';
  const chip = (cat, ico, label, rank, projected) => {
    const badge = rank != null ? `#${rank}` : '—';
    return `<button class="rc-cat${cat === cur ? ' on' : ''}" onclick="setRcCat('${cat}')" title="${esc(t('rank_in_cat', { cat: label }))}">` +
      `<span class="rc-cat-ico">${ico}</span><span class="rc-cat-label">${esc(label)}</span>` +
      `<span class="rc-cat-rank${projected ? ' rc-cat-rank-proj' : ''}">${badge}</span></button>`;
  };
  const f = rcProjFactor();
  let allRank = r.gmRank;
  if (f) {
    const rows = r.top
      .map((x) => (rcIsGm(x) ? { ...x, price: x.price * f } : x))
      .sort((a, b) => a.price - b.price);
    const i = rows.findIndex(rcIsGm);
    allRank = i >= 0 ? i + 1 : null;
  }
  let html = chip('ALL', '🌐', t('cat_all'), allRank, !!f);
  for (const c of rcCatsPresent(r, f)) html += chip(c.key, c.ico, t(c.i18n), c.rank, !!f);
  return `<div class="rc-cats">${html}</div>`;
}

// alias: the category chip row builder (contract name)
const renderRcCats = rcCatsHtml;

function setRcCat(cat) {
  if (!rcCtx || !rcCtx.data) return;
  // one DPS rule % moves every GM car in every category, so an un-applied
  // projection survives a category switch — it is recomputed in the new view
  const keepPct = rcCtx.placed && rcCtx.placed.proj ? rcCtx.placed.newPct : null;
  const wasApplied = !!(rcCtx.placed && rcCtx.placed.applied);
  rcCtx.cat = cat;
  rcCtx.placed = null;
  rcBuildView();
  if (keepPct != null) projectPlacement(keepPct, wasApplied); // re-renders
  else renderRcTable();
}
window.setRcCat = setRcCat;

let rcCtx = null;

// ---------- grid tip card: the hover detail, Palantir-styled ----------
// One element for the whole grid, fed from state on mouseover — native titles
// are gone from priced cells so this is THE surface for cell detail.
let gridTipEl = null;

function gridTip() {
  if (!gridTipEl) {
    gridTipEl = document.createElement('div');
    gridTipEl.id = 'gridTip';
    gridTipEl.className = 'grid-tip';
    document.body.appendChild(gridTipEl);
  }
  return gridTipEl;
}

function gridTipHtml(day, dur) {
  const k = key(day, dur);
  const cell = state.cellMap.get(k);
  const staged = state.staged.get(k);
  const conflict = state.conflictSet.has(k);
  const dd = `${String(day).padStart(2, '0')}.${String(state.month).padStart(2, '0')}.${state.year}`;
  const durL = dur >= OPEN_DURATION ? OPEN_DURATION + '+' : dur;
  const rows = [];
  const row = (l, v, cls) => rows.push(`<div class="gt-row${cls ? ' ' + cls : ''}"><span>${l}</span><b>${v}</b></div>`);
  let status = t('gt_live'), statusCls = 'gt-ok';
  if (conflict) { status = 'CONFLICT'; statusCls = 'gt-bad'; }
  else if (staged !== undefined) { status = t('gt_staged'); statusCls = 'gt-warn'; }
  else if (!cell) { status = t('gt_empty'); statusCls = 'gt-dim'; }
  if (cell) {
    row(t('gt_pct'), fmtPct(cell.pct), cell.pct <= -80 ? 'gt-bad' : cell.pct <= -70 ? 'gt-warn' : '');
    if (staged !== undefined && staged.pct !== null && Number(staged.pct) !== Number(cell.pct))
      row(t('gt_staged'), fmtPct(staged.pct), 'gt-warn');
    row('RULE', '#' + cell.ruleid);
    row(t('gt_op'), `${cell.numDaysOp || opForDur(dur)} ${durL}D`);
    row('VENDOR', esc(cell.vendors && cell.vendors.length ? cell.vendors.join(',') : 'ALL'));
    row(t('vg_groups'), esc(groupCoverageText(cell)));
    if (cell.active === false) row('', t('conflict_inactive'), 'gt-warn');
    if (cell.updated) row(t('gt_updated'), esc(cell.updated));
  } else if (staged !== undefined && staged.pct !== null) {
    row(t('gt_staged'), fmtPct(staged.pct), 'gt-warn');
  }
  const remote = (state.remotePresence || []).find((o) => o.day === day && (o.dur == null || o.dur === dur));
  if (remote) row('', t('presence_viewing', { u: esc(remote.user || '?') }), 'gt-warn');
  return `
    <div class="gt-head"><span class="gt-title">${dd} · ${durL}D</span><span class="gt-status ${statusCls}">${status}</span></div>
    ${rows.join('')}
    <div class="gt-foot">${t('gt_hint')}</div>`;
}

function attachGridTip() {
  const body = $('gridBody');
  if (!body || body.__tipWired) return;
  body.__tipWired = true;
  body.addEventListener('mouseover', (e) => {
    const td = e.target.closest('td[data-day]');
    if (!td || td.querySelector('input')) { gridTip().style.display = 'none'; return; }
    const day = Number(td.dataset.day);
    const dur = Number(td.dataset.dur);
    if (!day || !dur) return;
    const tip = gridTip();
    tip.dataset.day = day;
    tip.dataset.dur = dur;
    tip.innerHTML = gridTipHtml(day, dur);
    tip.style.display = 'block';
    const r = td.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.right + 10, y = r.top - 4;
    if (x + tw > window.innerWidth - 8) x = r.left - tw - 10;
    if (y + th > window.innerHeight - 8) y = window.innerHeight - th - 8;
    if (y < 8) y = 8;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  });
  body.addEventListener('mouseleave', () => { gridTip().style.display = 'none'; });
  body.addEventListener('mousedown', () => { gridTip().style.display = 'none'; });
}

/** Fix a CONFLICT cell in place: the operator picks the rule that keeps the
 *  cell, everything else covering the same vehicles on it is deleted. This is
 *  the "click it and repair it" path — no trip into DPS needed. */
/** ONE click on the CONFLICTS chip fixes ALL of them (Berkay, 2026-08-31:
 *  71 conflicts after the killed COPY TO): per cell one rule is kept and the
 *  rest are deleted in a single bulk request. The keep-strategy is a choice —
 *  DPS ruleids are sequential, so OLDEST (min id) = the cell's original rule
 *  and NEWEST (max id) = the latest write (a copy lands as the newest). */
async function resolveAllConflicts() {
  if (state.applying) return;
  const e = state.entry;
  if (!e || !state.conflictSet.size) return;
  const cells = [...state.conflictSet]
    .map((k) => ({ k, cf: e.conflictMap.get(k) }))
    .filter((x) => x.cf && Array.isArray(x.cf.ruleids) && x.cf.ruleids.length > 1);
  if (!cells.length) return;
  const strat = await choiceBox(t('conflict_all_q', { n: cells.length }), [
    { value: 'old', title: t('conflict_all_old'), desc: t('conflict_all_old_d') },
    { value: 'new', title: t('conflict_all_new'), desc: t('conflict_all_new_d') },
  ]);
  if (!strat) return;
  const doomed = [];
  for (const { cf } of cells) {
    const ids = [...new Set(cf.ruleids.map(Number))].sort((a, b) => a - b);
    const keep = strat === 'old' ? ids[0] : ids[ids.length - 1];
    for (const id of ids) if (id !== keep) doomed.push(id);
  }
  if (!(await confirmBox(t('conflict_all_confirm', { cells: cells.length, n: doomed.length })))) return;
  flagsPause(); // ranks are provisional while the cleanup lands
  try {
    const r = await api('/api/rules-delete', { method: 'POST', body: { station: state.station, ruleids: doomed } });
    toast(t('conflict_all_done', { n: r.deleted }));
  } catch (err) {
    toast('Resolve failed: ' + err.message, 'error');
  }
  // re-sync from the supplier system: the kept rules own their cells now —
  // and if a cell carried MORE than two rules, the fresh sync surfaces the
  // remainder as a (much smaller) conflict count for a second click
  state.monthCache.delete(cacheKey());
  loadGrid();
  refreshLogs();
  flagsResume(60 * 1000);
}
$('conflictChip').onclick = resolveAllConflicts;
$('conflictChip').title = 'Click: resolve ALL conflicts (keep one rule per cell)';

async function resolveConflict(day, dur) {
  const k = key(day, dur);
  const cf = state.entry && state.entry.conflictMap.get(k);
  if (!cf || !Array.isArray(cf.ruleids) || cf.ruleids.length < 2) return;
  const parties = (cf.rules && cf.rules.length ? cf.rules : cf.ruleids.map((id) => ({ ruleid: id })))
    .filter((r) => r && r.ruleid);
  const keep = await choiceBox(
    t('conflict_fix_q', { d: `${String(day).padStart(2, '0')}.${String(state.month).padStart(2, '0')} · ${dur >= OPEN_DURATION ? OPEN_DURATION + '+' : dur}D` }),
    parties.map((r) => ({
      value: r.ruleid,
      title: t('conflict_keep', { id: r.ruleid }),
      desc:
        (r.pct != null ? fmtPct(r.pct) : '?') +
        (r.label ? ` · ${r.label}` : '') +
        (r.active === false ? ` · ${t('conflict_inactive')}` : ''),
    }))
  );
  if (!keep) return;
  const doomed = parties.filter((r) => r.ruleid !== keep);
  if (!(await confirmBox(t('conflict_fix_confirm', { n: doomed.length, id: keep })))) return;
  const td = document.querySelector(`td[data-day="${day}"][data-dur="${dur}"]`);
  if (td) { td.className = 'cell-applying'; td.textContent = '…'; }
  let failed = 0;
  for (const r of doomed) {
    try {
      const q = `station=${state.station}&day=${day}&duration=${dur}&month=${state.month}&year=${state.year}` +
        (r.pct != null ? `&prevPct=${r.pct}` : '');
      await api(`/api/rule/${r.ruleid}?${q}`, { method: 'DELETE' });
    } catch (e) {
      failed++;
    }
  }
  if (failed) {
    toast(t('conflict_fix_fail', { n: failed }), 'error');
  } else {
    // the cell is clean now: the kept rule owns it
    state.entry.conflictMap.delete(k);
    state.conflictSet.delete(k);
    const kept = parties.find((r) => r.ruleid === keep);
    if (kept && kept.pct != null) {
      state.cellMap.set(k, {
        day, dur, ruleid: kept.ruleid, name: '', pct: kept.pct,
        active: kept.active !== false, op: dur >= OPEN_DURATION ? '>=' : '=',
        opMismatch: false, vendors: ['ALL'], updated: '',
        label: kept.label || null, groupIds: null, lane: state.entry.lane,
      });
    } else {
      state.cellMap.delete(k); // unknown survivor: the re-stream below fills it in
    }
    toast(t('conflict_fixed', { n: doomed.length }));
  }
  refreshCell(day, dur);
  updateChips();
  // truth check: re-stream the month so the cell shows exactly what DPS holds
  state.monthCache.delete(cacheKey());
  loadGrid();
}
window.resolveConflict = resolveConflict;

/** A station freshly discovered from DPS has no rentalcars location yet —
 *  market features stay off for it (with a pointer to Settings) until an
 *  admin maps it. The grid and weekly rules work regardless. */
function stationHasRc() {
  const st = state.stations.find((x) => x.id === state.station);
  return !!(st && st.rc && st.rc.loc);
}

function openRcAnalysis(day, dur) {
  if (!stationHasRc()) { toast(t('no_rc_station'), 'warn'); return; }
  // the panel is docked INSIDE the grid view — a dashboard rank-strip click
  // must land where the panel actually lives
  if (state.view !== 'grid') showView('grid');
  const prevCell = rcCtx ? { day: rcCtx.day, dur: rcCtx.dur } : null;
  // Berkay, 2026-08-30: EVERY cell change walks the shared hour one step on
  // the ring — a new question gets a new hour that nobody (rentalcars edge or
  // a cached generation) can serve stale. The very first open keeps 09:00.
  const nd = dur || 3;
  if (prevCell && (prevCell.day !== day || prevCell.dur !== nd)) rcHour = rcHourAt(rcHour, 1);
  rcCtx = {
    day, dur: dur || 3, cat: 'ALL', pendingPct: {},
    // which grid this analysis belongs to — ensureSidePanes re-targets the
    // permanent panes when the operator lands on another month or station
    station: state.station, year: state.year, month: state.month,
  };
  // the hour lives in its own -/+ control beside the title, and the footer
  // reports the hour that actually ANSWERED — so the two never say the same
  // thing twice, and a fallback is visible as a difference between them
  $('rcTitle').textContent =
    `RENTALCARS TOP 10 — ${String(day).padStart(2, '0')} ${MONTHS_SHORT[state.month - 1]} ${state.year}` +
    ` · ${stationName().toUpperCase()}`;
  $('rcModal').classList.remove('hidden');
  $('gridSplitter').classList.remove('hidden');
  // the active-cell ring follows the selection
  if (prevCell) refreshCell(prevCell.day, prevCell.dur);
  refreshCell(rcCtx.day, rcCtx.dur);
  renderRcHour();
  renderRcDurs();
  runRcAnalysis();
}

function renderRcDurs() {
  // Berkay, 2026-08-30: the duration row and the % chips are a PREVIEW only —
  // not clickable, not editable. Cell selection and % editing live on the
  // grid; this row just mirrors the selected cell's neighborhood.
  $('rcDurs').classList.add('rc-inert');
  const buttons = state.durations
    .map((d) => `<button class="rc-dur ${rcCtx.dur === d ? 'on' : ''}" tabindex="-1">${d >= OPEN_DURATION ? OPEN_DURATION + '+' : d} ${t('days')}</button>`)
    .join('');
  // the rule % per duration lives on its own orange chip row under the buttons:
  // active chip -> open the % editor; inactive chip -> switch duration and
  // auto-open the editor once fresh data has arrived (pendingPctEdit)
  const chips = state.durations
    .map((d) => {
      const c = state.cellMap.get(key(rcCtx.day, d));
      const active = rcCtx.dur === d;
      // R4: the active chip reflects an un-applied projection live (pending
      // style + value); settled durations show the applied rule %.
      const pend = active && rcCtx.pendingPct ? rcCtx.pendingPct[d] : undefined;
      // a MANUAL grid edit that has not been applied yet shows here too, in
      // the same staged orange the grid uses — the modal and the grid must
      // never tell two different stories about the same cell
      const stg = pend == null ? state.staged.get(key(rcCtx.day, d)) : undefined;
      const shown =
        pend != null ? pend : stg !== undefined ? stg.pct : c ? c.pct : null;
      const pct = shown == null ? '—' : fmtPct(shown);
      // the same band blues as the grid, so a check reads identically in both
      // places — pending/staged orange outranks them. -40..-60 is home (green);
      // outside the band turns blue.
      const depth =
        pend != null || stg !== undefined ? '' :
        shown == null ? '' :
        shown <= -80 ? ' rc-chip-out-crit' :
        shown <= -70 ? ' rc-chip-out-hot' :
        shown < -60 ? ' rc-chip-out-deep' :
        shown < 0 && shown > -40 ? ' rc-chip-out-mild' : '';
      const cls =
        `rc-dur-pct-chip ${active ? 'on' : ''}` +
        `${pend != null || stg !== undefined ? ' rc-dur-pct-pending' : ''}${depth}`;
      return `<button class="${cls}" data-d="${d}" tabindex="-1">${pct}</button>`;
    })
    .join('');
  // two sibling rows, each a flex track of 14 equal columns: the % chip under a
  // duration lines up with it by construction rather than by matching widths,
  // so all 14 durations stay on ONE line at any modal width.
  $('rcDurs').innerHTML =
    `<div class="rc-dur-row">${buttons}</div><div class="rc-dur-pcts">${chips}</div>`;
}

// R4 pending-% override map: reflects an un-applied projected rule % on the
// active duration chip; cleared on confirm success (chip re-reads the settled
// cellMap value) or when the projection is reset / a new query lands.
function markPendingPct(pct) {
  if (!rcCtx) return;
  if (!rcCtx.pendingPct) rcCtx.pendingPct = {};
  rcCtx.pendingPct[rcCtx.dur] = pct;
  renderRcDurs();
}
function clearPendingPct(d) {
  if (rcCtx && rcCtx.pendingPct) delete rcCtx.pendingPct[d];
  renderRcDurs();
}

function rcPctChip(d) {
  if (rcCtx.dur === d) { editDurPct(d); return; }
  rcCtx.pendingPctEdit = d; // runRcAnalysis opens the editor once data lands
  setRcDur(d);
}
window.rcPctChip = rcPctChip;

// what base price is rentalcars' CURRENT GM quote built on? If a just-applied
// rule is still propagating (live-sync pending), the sync target is the truth;
// otherwise the grid's rule % against the live quote.
// rentalcars' targeted campaign discount: a campaign-free draw serves the LIST
// basis, exactly this factor above the customer basis every anchor lives on
const RC_CAMPAIGN_RATE = 0.88;

/** Judge a pending apply against a FULL ladder (never a category view — the
 *  sync's anchors are the OVERALL-cheapest GM as served at apply time, and the
 *  target may be a per-car price from a category placement, so absolute-price
 *  comparison against "whatever car is cheapest now" was comparing two
 *  different cars). Returns { cls, servedUnderPct }:
 *    'live'       — the market serves the applied price (anchor x ratio)
 *    'prev'       — it still serves a rule it provably had (prevPct, or a
 *                   replaced-but-written intermediate apply from alsoPcts);
 *                   servedUnderPct names WHICH, so a base can divide by it
 *    'ambiguous'  — the change is smaller than the 2.5% quote noise: the same
 *                   draw matches both readings, so it proves nothing (this is
 *                   how a -45 -> -46 nudge was once confirmed "live" against
 *                   the untouched old quote)
 *    'genlive'    — matches the target only through the concurrent-generation
 *                   offset (2.4-2.7%): looks live, not provable — never a strike
 *    'silent'     — GM absent from the ladder: contradicts nothing
 *    'contradict' — matches neither side: the target never described this cell
 *  A campaign-free draw is also tested x0.88, because every anchor is customer-
 *  basis and rcParse leaves before=null on clean draws — without the conversion
 *  a landed 121.08-list price failed a 106.55 customer target by exactly 13.6%. */
function syncClassify(sync, data) {
  const gmRow = ((data && data.top) || []).find((x) => /green motion/i.test(x.supplier || ''));
  let served = [data && data.gmPrice, gmRow && gmRow.price, gmRow && gmRow.before]
    .filter((v) => typeof v === 'number' && v > 0);
  if (!served.length) return { cls: 'silent', servedUnderPct: null };
  const campaignFree = ((data && data.top) || []).every((x) => x.before == null);
  if (campaignFree) served = served.concat(served.map((v) => v * RC_CAMPAIGN_RATE));
  const near = (v, e, tol) => e > 0 && Math.abs(v - e) / e < tol;
  const liveExp = [sync.allServed * sync.ratio]
    .concat(sync.allBefore != null ? [sync.allBefore * sync.ratio] : [])
    .filter((v) => typeof v === 'number' && v > 0);
  // every rule the market may legitimately still serve: the one it provably had
  // at apply time, plus any replaced-but-written intermediate applies
  const prevVariants = [{ pct: sync.prevPct, f: 1 }].concat(
    (sync.alsoPcts || []).map((p) => ({ pct: p, f: (1 + p / 100) / (1 + sync.prevPct / 100) }))
  );
  const liveHit = served.some((v) => liveExp.some((e) => near(v, e, 0.025)));
  let prevHit = null;
  for (const pv of prevVariants) {
    const exps = [sync.allServed * pv.f].concat(sync.allBefore != null ? [sync.allBefore * pv.f] : []);
    if (served.some((v) => exps.some((e) => near(v, e, 0.025)))) { prevHit = pv; break; }
  }
  if (liveHit && prevHit) return { cls: 'ambiguous', servedUnderPct: prevHit.pct };
  if (liveHit) return { cls: 'live', servedUnderPct: null };
  if (prevHit) return { cls: 'prev', servedUnderPct: prevHit.pct };
  if (served.some((v) => liveExp.some((e) => near(v, e, 0.04)))) return { cls: 'genlive', servedUnderPct: null };
  return { cls: 'contradict', servedUnderPct: null };
}

function gmServedBase(r) {
  const cellPct = Number((state.cellMap.get(key(rcCtx.day, rcCtx.dur)) || {}).pct ?? 0);
  const marketBase = r.gmPrice != null ? r.gmPrice / (1 + cellPct / 100) : null;
  const sync = rcSync.get(syncKeyOf(rcCtx.day, rcCtx.dur));
  // A pending apply is a legitimate base source ONLY while rentalcars has not
  // caught up: what it serves still carries the PREVIOUS rule, so dividing it
  // by the new cellPct would invent a base. But the proxy has to keep earning
  // that trust, or a target that never lands becomes a permanent self-feeding
  // base — measured 2026-08-29 (01 Sep, 1D): a stuck target of 122.06 held a
  // base of 141.93 while rentalcars served GM at 74, so every new percentage
  // projected GM to #107 at 117.80 when the site had it #4 at 65.
  if (sync && sync.appliedPct != null && !sync.live && !sync.expired && sync.allServed != null) {
    const { cls, servedUnderPct } = syncClassify(sync, rcCtx.data || r);
    if (cls === 'contradict') {
      sync.expired = true; // stale proxy — never let it price another projection
    } else if (cls === 'live' || cls === 'genlive') {
      // the market already serves the applied price, so the normal division by
      // cellPct (== appliedPct after a confirm) is the truthful base again
      return { base: marketBase, rulePct: cellPct, servedPct: cellPct };
    } else if (r.gmPrice != null) {
      // still on a previous rule: THIS view's own served price divided by the
      // rule that provably produced it — correct in the ALL view AND in a
      // category view (each view's car keeps its own basis), and correct for
      // chained applies (servedUnderPct names which rule actually landed)
      const under = servedUnderPct != null ? servedUnderPct : (sync.prevPct ?? cellPct);
      return { base: r.gmPrice / (1 + under / 100), rulePct: sync.appliedPct, servedPct: under };
    } else {
      // GM absent from the view — the case the proxy exists for
      const under = sync.prevPct ?? 0;
      return { base: sync.allServed / (1 + under / 100), rulePct: sync.appliedPct, servedPct: under };
    }
  }
  return { base: marketBase, rulePct: cellPct, servedPct: cellPct };
}

// live projection: competitors stay as freshly queried, every GM offer is
// re-priced from the base at pct p — this is exactly what rentalcars will
// serve once its own cache refreshes, so the preview is always correct
function projectPlacement(p, applied) {
  const r = rcCtx.view || rcCtx.data;
  if (!r || r.gmPrice == null) return;
  const { base, rulePct, servedPct } = gmServedBase(r);
  const f = (base * (1 + p / 100)) / r.gmPrice;
  const offers = (r.gmOffers && r.gmOffers.length ? r.gmOffers : [{ vehicle: '', price: r.gmPrice }]);
  const newPrices = offers.map((g) => Math.round(g.price * f * 100) / 100);
  rcCtx.placed = {
    fleet: true, proj: true, applied: !!applied,
    // servedPct: the rule the market last provably served — what a subsequent
    // CONFIRM must hand to startRcSync as prevPct (curPct may be a pending
    // apply's pct that rentalcars has NEVER served)
    newPct: p, curPct: rulePct, servedPct, target: newPrices[0], newPrices,
  };
  // R4: an applied projection settles the chip (read from the updated cellMap);
  // an un-applied one shows the projected value in the pending style.
  if (applied) clearPendingPct(rcCtx.dur);
  else markPendingPct(p);
  // ...and the GRID shows it too, in the same staged orange. A price changed in
  // the analysis modal is a staged change like any other — leaving the grid
  // green made the two surfaces disagree about the same cell.
  syncProjectionToGrid(applied ? null : p);
  renderRcTable();
}

/** Mirror the modal's un-applied projection into the grid as a staged cell.
 *  `null` clears it (the projection was applied or reset). */
function syncProjectionToGrid(pct) {
  if (!rcCtx || rcCtx.day == null) return;
  const k = key(rcCtx.day, rcCtx.dur);
  const prior = state.staged.get(k);
  if (pct == null) {
    // only drop what the modal itself staged — a manual grid edit stays
    if (prior && prior.fromModal) state.staged.delete(k);
  } else {
    state.staged.set(k, { pct, fromModal: true });
  }
  refreshCell(rcCtx.day, rcCtx.dur);
  updateChips();
  renderApplyBar();
}

// Berkay, 2026-08-30: "estimated ... çok iyi olması lazım — direkt baksın
// rentalcars'dan arkadan doğru mu diye." A projection is only as good as the
// ladder under it, and a pinned snapshot can be hours old. So the moment the
// operator starts pricing (cell editor, chip editor, row click, fleet
// button), ONE background fresh draw re-asks rentalcars; when it lands, the
// data is swapped in and the same pct re-laid, so the estimate stands on a
// just-verified market instead of a stale pin. One check per cell per query.
const RC_FRESH_MS = 10 * 60 * 1000;

async function ensureFreshBase() {
  if (!rcCtx || !rcCtx.data) return;
  const at = rcCtx.data.at || rcCtx.data.cachedAt;
  if (at && Date.now() - at < RC_FRESH_MS) return; // recent enough already
  if (rcCtx.freshCheck) return;
  rcCtx.freshCheck = true;
  const day = rcCtx.day, dur = rcCtx.dur, seq = rcCtx.seq, hh = rcCtx.hh, mm = rcCtx.mm;
  try {
    const r = await api(
      `/api/rc-top?station=${state.station}&year=${state.year}&month=${state.month}&day=${day}&duration=${dur}&hh=${hh}&mm=${mm}&fresh=1&samples=2`
    );
    if (!rcCtx || rcCtx.day !== day || rcCtx.dur !== dur || rcCtx.seq !== seq) return;
    if (!r || !r.total) return; // an empty slot proves nothing — keep the pin
    rcCtx.data = r;
    rcSnapPut(day, dur, hh, String(mm).padStart(2, '0'), r);
    rcBuildView();
    const v = rcCtx.view || rcCtx.data;
    if (rcCtx.placed && !rcCtx.placed.applied && rcCtx.placed.newPct != null && v.gmPrice != null) {
      projectPlacement(rcCtx.placed.newPct); // same pct, re-laid on the live ladder
    } else {
      renderRcTable();
    }
  } catch (_) { /* background check — the pinned answer stands */ }
}

function editDurPct(d) {
  if (rcCtx.dur !== d) { setRcDur(d); return; }
  const r = rcCtx.data;
  // the editor projects GM's whole ladder from its current price — without a
  // GM offer there is no base to project from. A silent no-op here is what
  // made the +/- controls look deleted.
  if (!r) { toast(t('fleet_no_data'), 'warn'); return; }
  if (r.gmPrice == null) { toast(t('fleet_gm_absent'), 'warn'); return; }
  const chip = $('rcDurs').querySelector(`.rc-dur-pct-chip[data-d="${d}"]`);
  if (!chip || chip.querySelector('input')) return; // already editing
  // EDIT IN PLACE: the chip itself becomes the input, in the same staged
  // orange — no dialog in the middle of the screen (Berkay, 2026-08-28)
  // pre-fill EXACTLY what the chip shows: a staged grid edit or a pending
  // projection outranks the applied rule — otherwise clicking a chip that
  // says -55 opened an editor saying -45 and Enter silently threw the -55 away
  const stgV = state.staged.get(key(rcCtx.day, d));
  const cur =
    rcCtx.pendingPct && rcCtx.pendingPct[d] != null ? rcCtx.pendingPct[d] :
    stgV !== undefined && stgV.pct !== null ? stgV.pct :
    (state.cellMap.get(key(rcCtx.day, d)) || {}).pct ?? 0;
  ensureFreshBase(); // pricing starts here — verify the ladder behind it live
  chip.classList.add('rc-dur-pct-pending', 'chip-editing');
  // [−] value [+] : the steppers move the price in 0.5-point ticks, and every
  // tick re-projects the whole ladder below, so the ranking answers live
  // spans, not buttons: the chip itself is a <button>, and nested interactive
  // elements are invalid HTML that some parsers silently restructure
  chip.innerHTML =
    `<span class="chip-wrap">` +
    `<span class="chip-step" role="button" data-s="-1">−</span>` +
    `<input class="chip-input" value="${cur}" inputmode="text" spellcheck="false">` +
    `<span class="chip-step" role="button" data-s="1">+</span>` +
    `</span>`;
  const input = chip.querySelector('input');
  input.focus();
  input.select();
  // what to fall back to on Escape/blur: the projection as it stood before
  const p0 = rcCtx.pendingPct ? rcCtx.pendingPct[d] : undefined;
  let done = false;
  const parse = () => {
    const raw = input.value.trim();
    if (raw === '' || raw === '-') return null;
    const num = Number(raw.replace(',', '.'));
    return isFinite(num) ? Math.round(num * 100) / 100 : null;
  };
  const clamp = (n) => Math.max(-95, Math.min(100, n));
  const project = (n) => {
    // markPendingPct re-renders the row, but the open-editor guard holds the
    // input in place — only the TABLE re-ranks, which is the whole point
    projectPlacement(n);
  };
  chip.querySelectorAll('.chip-step').forEach((b) => {
    // mousedown would steal focus from the input and fire its blur — block it
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      const base = parse();
      const from = base != null ? base : (p0 != null ? p0 : cur);
      const next = clamp(Math.round((Number(from) + Number(b.dataset.s) * 0.5) * 100) / 100);
      input.value = String(next);
      project(next); // live: the ladder below re-ranks on every tick
    };
  });
  // three exits, three meanings:
  //   Enter  -> COMMIT the typed value as the projection
  //   Escape -> REVERT to what stood before the editor opened
  //   blur   -> KEEP: close the editor, leave the current projection alone.
  // blur used to revert — so clicking CONFIRM (whose mousedown blurs the
  // input) first threw the stepped value away and then confirmed the OLD one,
  // and clicking empty space silently undid the operator's steps.
  const finish = (mode) => {
    if (done) return;
    done = true;
    renderRcDursForce();
    if (mode === 'commit') {
      const num = parse();
      const raw = input.value.trim();
      if (raw !== '' && raw !== '-' && (num == null || num < -95 || num > 100)) {
        toast(t('rc_price_bad'), 'error');
        return;
      }
      if (num != null && num >= -95 && num <= 100) project(num);
    } else if (mode === 'revert') {
      if (p0 != null) project(p0);
      else if (rcCtx.placed && !rcCtx.placed.applied) resetGmSim();
    }
    // mode 'keep': nothing — the stepped projection stands, CONFIRM will
    // write exactly what the ladder below is showing
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish('commit'); }
    else if (e.key === 'Escape') { e.preventDefault(); finish('revert'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); chip.querySelector('.chip-step[data-s="1"]').onclick(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); chip.querySelector('.chip-step[data-s="-1"]').onclick(); }
  };
  input.onblur = () => finish('keep');
}

/** re-render the chip row even while an editor is open — only the editor's own
 *  commit/cancel path may do this, hence the separate name */
function renderRcDursForce() {
  const stray = $('rcDurs').querySelector('.chip-input');
  if (stray) stray.remove(); // drop the guard's trigger, then render normally
  renderRcDurs();
}
window.editDurPct = editDurPct;

// the ONLY path back to the live market — everything else reads the snapshot
async function refreshRcAnalysis() {
  // Berkay, 2026-08-29 (evening): REFRESH always walks one hour toward 19:00
  // before asking. rentalcars serves cached generations per exact (date, hour)
  // search key, so re-asking the SAME hour can hand back the generation it
  // already answered with — a stepped hour is the only question nobody can
  // serve stale. The footer names the hour that answered, as always.
  if (rcCtx) {
    // drop the OUTGOING hour's snapshot too: with the step, REFRESH never
    // re-queries the hour it was pressed on, so a stale pin there would
    // otherwise survive every refresh and greet the operator on step-back
    rcSnapDrop(rcCtx.day, rcCtx.dur, rcHH(rcHour), rcMM(rcHour));
    rcHour = rcHourAt(rcHour, 1);
    renderRcHour();
    rcSnapDrop(rcCtx.day, rcCtx.dur, rcHH(rcHour), rcMM(rcHour));
  }
  const b = $('rcRefresh');
  if (b) { b.disabled = true; b.textContent = t('refreshing'); }
  try { await runRcAnalysis({ fresh: true }); }
  finally { if (b) { b.disabled = false; b.textContent = t('refresh_rc'); } }
}
window.refreshRcAnalysis = refreshRcAnalysis;

function setRcDur(d) {
  const oldDur = rcCtx.dur;
  if (d !== oldDur) {
    rcHour = rcHourAt(rcHour, 1); // a duration switch is a new question too
    renderRcHour();
  }
  rcCtx.dur = d;
  refreshCell(rcCtx.day, oldDur); // the ring follows the duration switch
  refreshCell(rcCtx.day, d);
  // the pane follows the duration switch too — it always sits on the panel's
  // cell, or the mirror would leave it frozen on the previous duration
  if (window.innerWidth > 780 && !$('rcWeb').classList.contains('hidden')) {
    rcWebShow(rcCtx.day, d);
  }
  renderRcDurs();
  runRcAnalysis();
}
window.setRcDur = setRcDur;

function logoImg(x) {
  return x.logo
    ? `<img class="rc-logo" src="${esc(x.logo)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : '';
}

// server-side failure codes -> operator-readable explanations
function rcErrorText(msg) {
  if (/RC_UNAVAILABLE|RC_RELAY_OFFLINE/.test(msg)) return t('rc_err_offline');
  if (/RC_RELAY_TIMEOUT/.test(msg)) return t('rc_err_timeout');
  if (/RC_HTTP_4\d\d|RC_HTTP_5\d\d/.test(msg)) return t('rc_err_rejected', { code: esc(msg) });
  return t('rc_err_generic', { code: esc(msg) });
}

// The day's answer, pinned in the OPERATOR'S OWN browser.
//
// The server cache lives in one Cloud Run instance's memory and is written back
// on a 30s debounce, so a recycled instance re-rolls rentalcars' dice on the
// next open — which is how the same 12:00 cell read 131.03 one minute and
// 134.19 the next. Keeping the answer here as well means a cell that has been
// looked at once keeps showing that answer, across reloads and across
// instances, until the operator presses REFRESH.
// v2, 2026-08-29: every v1 snapshot predates the day the base rates were
// rewritten in DPS — some of them froze the minutes when rentalcars served
// RULE-LESS prices (GM at base×0.55×0.88 = rank #77), and a pinned snapshot
// would have shown that for 12 hours. A version bump orphans them everywhere.
const RC_SNAP_KEY = 'rcSnap.v2';
try { localStorage.removeItem('rcSnap.v1'); } catch (_) { /* nothing to drop */ }
const RC_SNAP_MAX = 60;              // LRU cap; a month of cells is well under this
const RC_SNAP_TTL = 12 * 3600 * 1000; // a snapshot older than a working day is stale

function rcSnapAll() {
  // every access is guarded: private mode and blocked site data both throw here
  try { return JSON.parse(localStorage.getItem(RC_SNAP_KEY) || '{}') || {}; }
  catch (_) { return {}; }
}
const rcSnapKey = (day, dur, hh, mm) =>
  `${state.station}:${state.year}-${state.month}-${day}:${hh}${mm || '00'}:${dur}`;

function rcSnapGet(day, dur, hh, mm) {
  const e = rcSnapAll()[rcSnapKey(day, dur, hh, mm)];
  if (!e || !e.data || Date.now() - e.savedAt > RC_SNAP_TTL) return null;
  return { ...e.data, cachedAt: e.savedAt };
}

function rcSnapPut(day, dur, hh, mm, data) {
  try {
    const all = rcSnapAll();
    all[rcSnapKey(day, dur, hh, mm)] = { savedAt: Date.now(), data };
    const keys = Object.keys(all);
    if (keys.length > RC_SNAP_MAX) {
      keys
        .sort((a, b) => (all[a].savedAt || 0) - (all[b].savedAt || 0))
        .slice(0, keys.length - RC_SNAP_MAX)
        .forEach((k) => delete all[k]);
    }
    localStorage.setItem(RC_SNAP_KEY, JSON.stringify(all));
  } catch (_) { /* no browser storage — the server pin still applies */ }
}

/** REFRESH must drop this cell's snapshot, or it would be re-served instantly */
function rcSnapDrop(day, dur, hh, mm) {
  try {
    const all = rcSnapAll();
    delete all[rcSnapKey(day, dur, hh, mm)];
    localStorage.setItem(RC_SNAP_KEY, JSON.stringify(all));
  } catch (_) { /* nothing to drop */ }
}

// The panel queries the LIVE market on every open (Berkay, 2026-08-30:
// "rakip analizinde tamamen buradan gelen veriyle analiz yapılacak" — and the
// complaint that the panel only showed the right prices after a few
// refreshes, because it used to serve a pinned snapshot for up to 6 hours).
// The old re-roll problem the pin solved is now handled by the SAMPLER:
// campaign draws are confirmed, split generations settle by continuity, and
// a clean market stops at two agreeing draws — so a fresh query is stable
// enough to be the default. Snapshots remain as an OFFLINE FALLBACK only
// (relay down → last known answer, marked stale).

async function runRcAnalysis(opts) {
  // nothing to answer for when no cell is open — guarded here rather than at
  // each caller so every future one is safe too
  if (!rcCtx) return;
  // A fresh snapshot is sampled. rentalcars answers the same search either as
  // ~200 offers with a -12% Green Motion campaign or ~231 offers with none, at
  // random per request — and fresh sessions (incognito, booking.com logged-in)
  // overwhelmingly see the campaign one. The server keeps the first
  // campaign-bearing draw (falling back to the fullest clean draw only when
  // every sample is clean, i.e. the campaign is genuinely off), so this is ~1
  // call in practice and a REFRESH cannot flip the ladder on a re-roll. Only
  // this path samples; grid scans and sweeps stay at one call per cell.
  const freshness = 'fresh=1&samples=5';
  const [hh, mm] = currentRcTime();
  rcCtx.hh = hh;
  rcCtx.mm = mm;
  rcCtx.placed = null;
  rcCtx.freshCheck = false; // each query earns its own background verification
  rcCtx.pendingPct = {}; // a fresh query abandons any un-applied projection
  // the PREVIOUS answer must not survive into this query: a failed fetch used
  // to leave 3-day prices behind, and a chip edit then projected 7-day cells
  // against them. And two quick duration clicks race — only the latest wins.
  rcCtx.data = null;
  rcCtx.view = null;
  const seq = (rcCtx.seq = (rcCtx.seq || 0) + 1);
  $('rcMeta').textContent = '';
  $('rcFleet').innerHTML = '';
  const t0 = new Date();
  t0.setHours(0, 0, 0, 0);
  if (new Date(state.year, state.month - 1, rcCtx.day) < t0) {
    $('rcBody').innerHTML = `<div class="drawer-empty">${t('rc_past')}</div>`;
    return;
  }
  const loadingLbl = t('querying_at', { time: `${hh}:${String(mm).padStart(2, '0')}` });
  $('rcBody').innerHTML = rcLoadingHtml(loadingLbl);
  // the pane mirrors this cell — it must visibly refresh WITH the panel
  if (rcWeb.day === rcCtx.day && rcWeb.dur === rcCtx.dur && !$('rcWeb').classList.contains('hidden')) {
    rcWebHead(hh, mm);
    $('rcWebBody').innerHTML = rcLoadingHtml(loadingLbl);
    $('rcWebMeta').textContent = '';
  }
  try {
    let r = await api(
      `/api/rc-top?station=${state.station}&year=${state.year}&month=${state.month}&day=${rcCtx.day}&duration=${rcCtx.dur}&hh=${hh}&mm=${mm}&${freshness}`
    );
    if (seq !== rcCtx.seq) return; // a newer query superseded this one
    // rentalcars sometimes returns an EMPTY slot for an hour (measured: 29 Aug,
    // 19:00, zero offers across the whole market). Showing a blank table there
    // would read as "the market is gone" — step to the next hour instead, and
    // the footer labels which hour actually answered.
    if (!r.total) {
      for (const [fh, fm] of rcFallbackTimes(rcHour)) {
        const alt = await api(
          `/api/rc-top?station=${state.station}&year=${state.year}&month=${state.month}&day=${rcCtx.day}&duration=${rcCtx.dur}&hh=${fh}&mm=${String(fm).padStart(2, '0')}&${freshness}`
        );
        if (seq !== rcCtx.seq) return;
        if (alt.total) { r = alt; rcCtx.hh = fh; rcCtx.mm = fm; break; }
      }
    }
    rcCtx.data = r;
    rcSnapPut(rcCtx.day, rcCtx.dur, rcCtx.hh, String(rcCtx.mm).padStart(2, '0'), r);
    // an empty-slot fallback changed the hour — the header must say so too
    $('rcTitle').textContent =
      `RENTALCARS TOP 10 — ${String(rcCtx.day).padStart(2, '0')} ${MONTHS_SHORT[state.month - 1]} ${state.year}` +
      ` · ${stationName().toUpperCase()}`;
    rcBuildView(); // resolve the category-scoped view before the first render
    renderRcTable();
    // a grid editor asked for a preview while this query was in flight —
    // honour it now that there is a ladder to project onto
    if (rcCtx.previewPct != null) {
      const p = rcCtx.previewPct;
      rcCtx.previewPct = null;
      const v = rcCtx.view || rcCtx.data;
      if (v && v.gmPrice != null) projectPlacement(p);
    }
    if (rcCtx.pendingPctEdit != null && rcCtx.pendingPctEdit === rcCtx.dur) {
      rcCtx.pendingPctEdit = null;
      // the operator may have closed the modal while the query was in flight —
      // an editor opened into display:none can never blur, and its guard would
      // freeze the chip row for the rest of the session
      if (!$('rcModal').classList.contains('hidden')) editDurPct(rcCtx.dur);
    }
  } catch (e) {
    if (seq !== rcCtx.seq) return;
    rcCtx.pendingPctEdit = null; // a failed fetch cancels the pending chip auto-open
    // offline fallback: the last known answer for this cell, clearly stale —
    // better than a blank panel while the relay recovers
    const snap = rcSnapGet(rcCtx.day, rcCtx.dur, hh, mm);
    if (snap) {
      rcCtx.data = { ...snap, stale: true };
      rcBuildView();
      renderRcTable();
      return;
    }
    $('rcBody').innerHTML = `<div class="drawer-empty">${rcErrorText(e.message)}</div>`;
  }
}

// ---------- fleet targeting: put N Green Motion cars inside the top 10 ----------
// One DPS % rule scales every GM offer by the same factor, so "K cars in the
// top 10" reduces to: the K-th cheapest GM car must undercut the price of the
// (10-K+1)-th cheapest competitor. Aim 0.5% under it, like single placement.

function gmCountInTop10(r) {
  return r.top.slice(0, 10).filter((x) => /green motion/i.test(x.supplier)).length;
}

function renderRcFleet() {
  // the GM CARS IN TOP 10 buttons are retired (Berkay, 2026-08-30) — the row
  // stays empty; placeFleet itself survives for the planned P4 loop
  const el = $('rcFleet');
  if (el) el.innerHTML = '';
}

function placeFleet(k) {
  ensureFreshBase(); // re-lay on the live ladder when the check lands
  const r = rcCtx.view || rcCtx.data;
  if (!r || r.gmPrice == null) return;
  if (!Array.isArray(r.gmOffers) || !r.gmOffers.length || !Array.isArray(r.compPrices)) {
    toast(t('fleet_no_data'), 'warn');
    return;
  }
  if (r.gmOffers.length < k) {
    toast(t('fleet_not_enough', { n: r.gmOffers.length }), 'warn');
    k = r.gmOffers.length;
    if (!k) return;
  }
  const now = gmCountInTop10(r);
  if (now === k) {
    toast(t('fleet_already', { k: now }));
    return;
  }
  const comp = r.compPrices;
  // the guarded base, not raw cellMap: right after a confirm cellMap already
  // holds the NEW pct while rentalcars still serves the OLD price — dividing
  // served by the new pct invented a base and wrote a pct that missed the
  // promised prices (measured 12.5% deep in the placeGm sibling)
  const { base: gmBase, rulePct: curPct, servedPct } = gmServedBase(r);
  if (gmBase == null || r.gmPrice == null) return;
  const bases = r.gmOffers.map((g) => g.price * (gmBase / r.gmPrice));
  // the pricing band's floor, on displayed prices: whatever K asks for, the
  // cheapest GM car never lands more than 5% or 10 CHF under the cheapest
  // competitor — crowding the top 10 must not mean giving cars away
  const floorPrice = comp.length ? Math.max(comp[0] * 0.95, comp[0] - 10) : null;
  let newPct;
  if (comp.length <= 10 - k) {
    // fewer competitors than free top-10 slots: K GM cars fit with no change,
    // and there is nothing to price against for a raise either
    newPct = curPct;
  } else {
    const threshold = comp[10 - k]; // with K GM cars inside, this is the first competitor OUT
    if (now < k) {
      // DOWN: the K-th GM car undercuts the threshold competitor...
      const target = threshold - Math.max(0.01, threshold * 0.005);
      newPct = (target / bases[k - 1] - 1) * 100;
      // ...but never through the band's floor
      if (floorPrice != null) {
        const minPct = (floorPrice / bases[0] - 1) * 100;
        if (newPct < minPct) {
          newPct = minPct;
          toast(t('fleet_floored'), 'warn');
        }
      }
    } else {
      // UP (now > k): a RAISE that lifts the surplus cars out of the top 10
      // while the K cheapest stay in — priced to keep competing, not to flee.
      // The (K+1)-th car goes just ABOVE the threshold competitor; the K-th
      // must stay just below it, which caps how far the raise may go when GM
      // prices sit close together.
      const up = (threshold * 1.005) / bases[k];
      const cap = (threshold * 0.995) / bases[k - 1];
      const f = Math.min(up, cap);
      newPct = (f - 1) * 100;
      if (up > cap) toast(t('fleet_exact_hard', { k }), 'warn');
      else toast(t('fleet_raised', { k }));
    }
    newPct = Math.max(-95, Math.min(100, Math.round(newPct * 100) / 100));
  }
  if (newPct === curPct) {
    toast(t('fleet_already', { k }));
    return;
  }
  const newFactor = 1 + newPct / 100;
  const newPrices = bases.map((b) => Math.round(b * newFactor * 100) / 100);
  rcCtx.placed = { fleet: true, k, newPct, curPct, servedPct, target: newPrices[0], newPrices };
  markPendingPct(newPct);
  syncProjectionToGrid(newPct); // staged — the bottom-right APPLY bar writes it
  renderRcTable();
}
window.placeFleet = placeFleet;

/**
 * Re-rank simulation: click any competitor row to place Green Motion just
 * ahead of it. The needed DPS % is derived from the current rule:
 *   base = gmPrice / (1 + currentPct/100);  newPct = (target/base - 1) * 100
 */
/** Fuel strings from the API are long ("Self-charging hybrid") — shorten for the column. */
function fuelShort(f) {
  if (!f) return '—';
  const s = String(f).toLowerCase();
  if (s.includes('plug')) return 'P-HYB';
  if (s.includes('hybrid')) return 'HYBRID';
  if (s.includes('electric')) return 'EV';
  if (s.includes('petrol')) return 'PETROL';
  if (s.includes('diesel')) return 'DIESEL';
  return esc(String(f).toUpperCase().slice(0, 8));
}

function renderRcTable() {
  const r = rcCtx.view || rcCtx.data; // category-scoped when a category is active
  if (!r || !r.top.length) {
    $('rcBody').innerHTML = `<div class="drawer-empty">${t('no_offers')}</div>`;
    renderRcFleet();
    return;
  }
  const durLabel = rcCtx.dur >= OPEN_DURATION ? OPEN_DURATION + '+' : rcCtx.dur;
  const others = r.top.filter((x) => !/green motion/i.test(x.supplier));
  const sim = rcCtx.placed; // single: {rank, target, newPct, curPct} — fleet: {fleet, k, newPct, curPct, target, newPrices}
  const gmLogo = (r.top.find((x) => /green motion/i.test(x.supplier)) || {}).logo;

  let displayRows;
  if (sim && sim.fleet) {
    // merge every simulated GM price into the competitor ladder
    const simGm = (r.gmOffers || []).slice(0, 8).map((g, i) => ({
      supplier: 'Green Motion', vehicle: esc(g.vehicle || ''), rating: null,
      price: sim.newPrices[i], currency: r.currency, gm: true, simulated: true, logo: gmLogo,
    }));
    displayRows = [...others, ...simGm].sort((a, b) => a.price - b.price).slice(0, 11);
  } else if (sim) {
    displayRows = others.slice();
    const gmVehicle = (r.top.find((x) => /green motion/i.test(x.supplier)) || {}).vehicle || '';
    displayRows.splice(sim.rank - 1, 0, {
      supplier: 'Green Motion', vehicle: gmVehicle, rating: null,
      price: sim.target, currency: r.currency, gm: true, simulated: true,
      logo: gmLogo,
    });
    displayRows = displayRows.slice(0, 11);
  } else {
    displayRows = r.top.slice(0, 10);
  }

  const rows = displayRows
    .map((x, i) => {
      const isGm = x.gm || /green motion/i.test(x.supplier);
      const clickable = !isGm && r.gmPrice != null;
      // Two price columns (Berkay, 2026-08-29): LIST is the base rate, CUSTOMER
      // is what a shopper actually pays — rentalcars' campaign applied when one
      // runs, identical to LIST when none does. No struck price, no badge; the
      // two columns carry both truths and ranking stays on CUSTOMER.
      const before = typeof x.before === 'number' && x.before > x.price ? x.before : null;
      return `<tr class="${isGm ? 'rc-gm' : ''} ${x.simulated ? 'rc-sim' : ''} ${clickable ? 'rc-clickable' : ''}"
        data-idx="${i}" data-gm="${isGm ? 1 : 0}" ${isGm && r.gmPrice != null ? 'draggable="true"' : ''}
        ${clickable ? `onclick="placeGm(${i})" title="Click or drop Green Motion here to take this position"` : ''}>
        <td class="rc-rank">${i + 1}</td>
        <td class="rc-sup">${logoImg(x)}${esc(x.supplier)}${x.simulated ? ` <span class="rc-sim-tag">${t('target_tag')}</span>` : ''}${isGm && !x.simulated && !(sim && sim.fleet) ? ` <span class="rc-drag-hint">${t('drag_hint')}</span>` : ''}</td>
        <td>${x.simulated && sim && sim.fleet ? x.vehicle : esc(x.vehicle)}</td>
        <td>${x.rating != null ? x.rating.toFixed(1) : '—'}</td>
        <td class="rc-gear">${x.gear === 'A' ? 'AUTO' : x.gear === 'M' ? 'MAN' : '—'}</td>
        <td class="rc-fuel">${fuelShort(x.fuel)}</td>
        <td class="rc-price rc-list">${(before != null ? before : x.price).toFixed(2)}</td>
        <td class="rc-price rc-cust${isGm && !x.simulated ? ' rc-price-click' : ''}"${isGm && !x.simulated ? ` onclick="editGmPrice()" title="${t('rc_price_click')}"` : ''}>${x.price.toFixed(2)}&nbsp;${esc(x.currency)}</td>
      </tr>`;
    })
    .join('');

  const cell = state.cellMap.get(key(rcCtx.day, rcCtx.dur));
  const curPct = cell ? cell.pct : 0;

  let simBar = '';
  if (sim && sim.proj) {
    const info = t(sim.applied ? 'proj_applied' : 'proj_bar', {
      dur: durLabel + 'D', cur: sim.curPct, new: sim.newPct,
      p1: sim.target.toFixed(2), ccy: r.currency,
    });
    simBar = `<div class="rc-simbar${sim.applied ? ' rc-sim-applied' : ''}">
      <span>${info}</span>
      ${sim.applied ? '' : `<span class="rc-simbar-btns">
        <span class="rc-apply-hint">${t('sim_apply_hint')}</span>
        <button class="btn btn-ghost btn-xs" onclick="resetGmSim()">${t('reset')}</button>
      </span>`}
    </div>`;
  } else if (sim && sim.fleet) {
    simBar = `<div class="rc-simbar">
      <span>${t('fleet_bar', {
        k: sim.k, dur: durLabel, cur: sim.curPct, new: sim.newPct,
        p0: r.gmPrice != null ? r.gmPrice.toFixed(2) : '—',
        p1: sim.target.toFixed(2), ccy: r.currency,
      })}${cell ? '' : ' (new rule)'}</span>
      <span class="rc-simbar-btns">
        <span class="rc-apply-hint">${t('sim_apply_hint')}</span>
        <button class="btn btn-ghost btn-xs" onclick="resetGmSim()">${t('reset')}</button>
      </span>
    </div>`;
  } else if (sim) {
    simBar = `<div class="rc-simbar">
      <span>GM #${r.gmRank || '—'} &rarr; <b>#${sim.rank}</b> · ${r.gmPrice.toFixed(2)} &rarr; <b>${sim.target.toFixed(2)} ${r.currency}</b>
      · DPS RULE ${durLabel}D: ${curPct}% &rarr; <b>${sim.newPct}%</b>${cell ? '' : ' (new rule)'}</span>
      <span class="rc-simbar-btns">
        <span class="rc-apply-hint">${t('sim_apply_hint')}</span>
        <button class="btn btn-ghost btn-xs" onclick="resetGmSim()">${t('reset')}</button>
      </span>
    </div>`;
  }
  // no explainer paragraphs above the table (Berkay, 2026-08-28): the footer
  // meta (offers · pickup · queried · rank) stays, the prose goes

  const sk = syncKeyOf(rcCtx.day, rcCtx.dur);
  const sync = rcSync.get(sk);
  let syncBar = '';
  // an expired sync is one whose target never arrived: saying "rentalcars still
  // serves its cached quote" about it would be a claim the market contradicts
  if (sync && !sync.expired) {
    // the second-hour confirmation (Berkay, 2026-08-30: "farklı saatlerde de
    // onay alınsın") reports right here, beside the primary verdict
    const h2 = sync.hour2
      ? sync.hour2.state === 'checking'
        ? ` · ${rcPad(sync.hour2.hh)}:00 …`
        : sync.hour2.state === 'ok'
          ? ` · ${rcPad(sync.hour2.hh)}:00 &#10003;`
          : ` · ${rcPad(sync.hour2.hh)}:00 ${sync.hour2.price != null ? sync.hour2.price.toFixed(2) : '—'} &#9888;`
      : '';
    syncBar = sync.live
      ? `<div class="rc-syncbar rc-sync-live">RENTALCARS LIVE &#10003; — Green Motion is now #${sync.liveRank} at the applied price.${h2}</div>`
      : `<div class="rc-syncbar">DPS APPLIED &#10003; (target ${sync.target.toFixed(2)}) — rentalcars still serves its cached quote; auto-recheck at 2/5/10 min.${h2}
         <button class="btn btn-ghost btn-xs" onclick="checkRcSyncManual('${sk}')">${sync.checking ? 'CHECKING…' : 'CHECK NOW'}</button></div>`;
  }

  // hint keyed to the unsimulated data so it cannot flicker while a sim is on
  const hasDisc = r.top.some((x) => typeof x.before === 'number' && x.before > x.price);
  const discHint = hasDisc ? `<div class="rc-hint">${t('discount_hint')}</div>` : '';

  const table = `<table class="rc-table">
    <thead><tr><th></th><th>SUPPLIER</th><th>VEHICLE</th><th>RATING</th><th class="rc-gear">${t('rc_col_gear')}</th><th class="rc-fuel">${t('rc_col_fuel')}</th><th class="rc-price rc-list">${t('rc_col_list')}</th><th class="rc-price">${t('rc_col_customer')} ${durLabel}D</th></tr></thead>
    <tbody>${rows}</tbody></table>`;

  // Berkay, 2026-08-30: with a projection on screen BOTH states must be
  // visible — the projected ladder on top (interactive, CONFIRM writes it) and
  // the served ladder below it, muted, exactly as rentalcars answers today.
  let afterTitle = '';
  let beforeHtml = '';
  if (sim) {
    afterTitle = `<div class="rc-sec-title rc-sec-after">${t('rc_after_title')}</div>`;
    const beforeRows = r.top.slice(0, 10).map((x, i) => {
      const isGm = /green motion/i.test(x.supplier || '');
      return `<tr class="${isGm ? 'rc-gm' : ''}">
        <td class="rc-rank">${i + 1}</td>
        <td class="rc-sup">${logoImg(x)}${esc(x.supplier)}</td>
        <td>${esc(x.vehicle)}</td>
        <td class="rc-price rc-cust">${x.price.toFixed(2)}&nbsp;${esc(x.currency)}</td>
      </tr>`;
    }).join('');
    beforeHtml = `<div class="rc-sec-title">${t('rc_before_title')}</div>
      <div class="rc-before-wrap"><table class="rc-table">
      <thead><tr><th></th><th>SUPPLIER</th><th>VEHICLE</th><th class="rc-price">${t('rc_col_customer')} ${durLabel}D</th></tr></thead>
      <tbody>${beforeRows}</tbody></table></div>`;
  }

  // R3 category chips first, then R5 confirm/sim bar ABOVE the table so CONFIRM
  // is visible without scrolling, then the sync bar, table and discount hint.
  // category chips and fleet buttons are gone (Berkay, 2026-08-30) — the
  // panel is a viewer; actions live on the grid
  $('rcBody').innerHTML = `${simBar}${syncBar}${afterTitle}${table}${discHint}${beforeHtml}`;

  // drag & drop: grab the Green Motion row and drop it onto any competitor row
  const trs = [...$('rcBody').querySelectorAll('tbody tr')];
  for (const tr of trs) {
    if (tr.dataset.gm === '1') {
      tr.addEventListener('dragstart', (e) => {
        tr.classList.add('rc-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      tr.addEventListener('dragend', () => tr.classList.remove('rc-dragging'));
    } else {
      tr.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        tr.classList.add('rc-dropover');
      });
      tr.addEventListener('dragleave', () => tr.classList.remove('rc-dropover'));
      tr.addEventListener('drop', (e) => {
        e.preventDefault();
        tr.classList.remove('rc-dropover');
        placeGm(Number(tr.dataset.idx));
      });
    }
  }

  // when this result was actually fetched from rentalcars (r.at; cachedAt as
  // fallback for entries cached before the server started stamping `at`)
  const atTs = r.at || r.cachedAt;
  const fellBack = rcCtx.hh !== rcHH(rcHour) || String(rcCtx.mm).padStart(2, '0') !== rcMM(rcHour);
  $('rcMeta').textContent =
    `${r.total} ${t('offers')} · ${t('pickup')} ${rcCtx.hh}:${String(rcCtx.mm).padStart(2, '0')}` +
    // an hour other than the requested one only ever appears because that hour
    // came back empty — say so, or the number reads as the one that was asked for
    (fellBack ? ` (${t('pickup_fallback')})` : '') +
    (atTs ? ` · ${t('query_at', { time: new Date(atTs).toLocaleTimeString('de-CH', { hour12: false }) })}` : '') +
    (r.stale ? ` · ${t('stale_cache')}` : r.cachedAt ? ` · ${t('cached')}` : '') +
    (r.currencyMismatch ? ` · ${t('currency_warn', { c: r.currency })}` : '') +
    (r.cachedAt ? ` · ${t('pinned')}` : '') +
    // how much rentalcars moved GM across the samples — 0 means it is settled
    (r.spread ? ` · GM ±${r.spread}%` : '') +
    // With a projection on screen the raw gmRank/gmPrice are the PRE-change
    // numbers — the footer used to report those under a table showing the new
    // ones ("GM RANK #1 (81.11)" above a 85.53 row). Describe what is displayed.
    (() => {
      const sim = rcCtx.placed;
      if (sim && Array.isArray(sim.newPrices) && sim.newPrices.length) {
        const merged = [
          ...(r.top || []).filter((x) => !rcIsGm(x)).map((x) => x.price),
          ...sim.newPrices,
        ].sort((a, b) => a - b);
        const rank = merged.indexOf(sim.newPrices[0]) + 1;
        return ` · ${t('gm_rank')} #${rank} (${sim.newPrices[0].toFixed(2)} ${r.currency})` +
          (sim.applied ? '' : ` ${t('proj_tag')}`);
      }
      return r.gmRank ? ` · ${t('gm_rank')} #${r.gmRank} (${r.gmPrice.toFixed(2)} ${r.currency})` : ` · ${t('gm_not_listed')}`;
    })();
  renderRcFleet();
  rcWebMirror(); // the pane re-renders from the SAME answer — never a second draw
}

function placeGm(rowIndex) {
  ensureFreshBase(); // re-lay on the live ladder when the check lands
  const r = rcCtx.view || rcCtx.data;
  if (!r || r.gmPrice == null) return;
  const others = r.top.filter((x) => !/green motion/i.test(x.supplier));
  const targetRank = Math.min(rowIndex + 1, others.length + 1);
  const hi = others[targetRank - 1] ? others[targetRank - 1].price : null; // row GM goes ahead of
  const lo = others[targetRank - 2] ? others[targetRank - 2].price : 0;
  let target;
  if (hi == null) target = lo * 1.02; // placed last
  else {
    target = hi - Math.max(0.01, hi * 0.005); // just under that competitor
    if (target <= lo) target = (lo + hi) / 2; // tight gap: midpoint
  }
  // gmServedBase, not raw cellMap: during a pending apply the cellMap pct has
  // never been served, and dividing the still-old price by it invented a base
  // — a click promising 59.70 wrote a pct that landed GM at 52.24
  const { base, rulePct: curPct, servedPct } = gmServedBase(r);
  if (base == null) return;
  let newPct = (target / base - 1) * 100;
  newPct = Math.max(-95, Math.min(100, Math.round(newPct * 100) / 100));
  rcCtx.placed = { rank: targetRank, target, newPct, curPct, servedPct };
  markPendingPct(newPct);
  // CONFIRM lives in the bottom-right APPLY TO DPS bar now (Berkay,
  // 2026-08-30) — a placement must stage itself or it would have no way out
  syncProjectionToGrid(newPct);
  renderRcTable();
}
window.placeGm = placeGm;

// type a target price on Green Motion's own price cell: the rank falls out of
// where that price lands among the listed competitors, the DPS % from the base
async function editGmPrice() {
  ensureFreshBase(); // re-lay on the live ladder when the check lands
  const r = rcCtx.view || rcCtx.data;
  if (!r || r.gmPrice == null) return;
  const raw = await inputBox(t('rc_price_prompt', { ccy: r.currency }), r.gmPrice.toFixed(2));
  if (raw === null || raw.trim() === '') return;
  const target = Number(raw.trim().replace(',', '.'));
  if (!isFinite(target) || target <= 0) { toast(t('rc_price_bad'), 'error'); return; }
  const others = r.top.filter((x) => !/green motion/i.test(x.supplier));
  const rank = others.filter((o) => o.price < target).length + 1;
  // same guarded base as placeGm/projectPlacement — see the comment there
  const { base, rulePct: curPct, servedPct } = gmServedBase(r);
  if (base == null) return;
  let newPct = (target / base - 1) * 100;
  newPct = Math.max(-95, Math.min(100, Math.round(newPct * 100) / 100));
  rcCtx.placed = { rank, target, newPct, curPct, servedPct, manual: true };
  markPendingPct(newPct);
  syncProjectionToGrid(newPct); // staged — the bottom-right APPLY bar writes it
  renderRcTable();
}
window.editGmPrice = editGmPrice;

function resetGmSim() {
  rcCtx.placed = null;
  clearPendingPct(rcCtx.dur);
  syncProjectionToGrid(null); // the grid's orange goes with it
  // …and only NOW can the chips be redrawn: clearPendingPct already rendered
  // them, but that ran while state.staged still held the projection, so the
  // chip kept showing a percentage nothing was staging any more — a reset that
  // looked like it had not happened.
  renderRcDurs();
  renderRcTable();
}
window.resetGmSim = resetGmSim;

// confirmGmSim is retired (Berkay, 2026-08-30): every projection stages
// itself and the ONLY write path is the bottom-right APPLY TO DPS bar — its
// handler starts the live-sync check for the panel's cell, steps the hour,
// re-queries fresh and re-lays the applied projection (see applyBtn).

// R6: closing while an un-applied placement/projection is staged asks first —
// an applied projection (already written to DPS) closes without a prompt.
async function closeRcModal() {
  rcCtx && (rcCtx.pendingPctEdit = null); // never auto-open an editor into a hidden modal
  if ($('rcDurs').querySelector('.chip-input')) renderRcDursForce(); // drop an open editor cleanly
  if (rcCtx && rcCtx.placed && !rcCtx.placed.applied) {
    if (!(await confirmBox(t('rc_close_confirm')))) return;
    // the confirm says the placement is lost — so it must actually be lost,
    // grid marker included, or the orange would outlive the thing it marks
    rcCtx.placed = null;
    syncProjectionToGrid(null);
  }
  $('rcModal').classList.add('hidden');
  $('gridSplitter').classList.add('hidden');
  if (rcCtx) refreshCell(rcCtx.day, rcCtx.dur); // drop the active-cell ring
}
// Both side panes are PERMANENT on desktop (Berkay, 2026-08-30: "her daim
// açık kalacak, sadece büyütme küçültme") — no close buttons, no backdrop
// close; ensureSidePanes() opens them with the grid and re-targets them on a
// month/station switch. closeRcModal/rcWebHide stay for the mobile overlay.

// OPEN ON RENTALCARS is gone (Berkay, 2026-08-30) — the grid's right-click
// live window replaced it; the panel keeps only REFRESH, which still steps
// the hour before re-asking (see refreshRcAnalysis).

// ---------- rentalcars live-sync: verify an applied price is actually served ----------

const rcSync = new Map(); // "station:y:m:day:dur" -> {day,dur,target,live,liveRank,tries,checking}

const syncKeyOf = (day, dur) => `${state.station}:${state.year}:${state.month}:${day}:${dur}`;

function startRcSync(day, dur, target, appliedPct, prevPct) {
  const k = syncKeyOf(day, dur);
  const old = rcSync.get(k);
  // Anchors: the OVERALL-cheapest GM as served at apply time. Verification must
  // compare the same car it anchored on — sim.target may be a per-car price
  // from a category placement (an SUV at 150 while the overall GM serves 90),
  // and comparing that against "whatever car is cheapest later" expired every
  // category apply as never-landed. ratio = what the applied rule does to any
  // served GM price, so anchor x ratio is the expected post-apply serve.
  const data = rcCtx && rcCtx.data;
  const gmRow = ((data && data.top) || []).find((x) => /green motion/i.test(x.supplier || ''));
  rcSync.set(k, {
    day, dur, target, appliedPct: appliedPct ?? null, prevPct: prevPct ?? null,
    // the cell this sync verifies — the recheck must query IT, not whatever
    // station/month the operator happens to be looking at minutes later
    station: state.station, year: state.year, month: state.month,
    allServed: data && data.gmPrice != null ? data.gmPrice : null,
    allBefore: gmRow && typeof gmRow.before === 'number' ? gmRow.before : null,
    ratio: (1 + (appliedPct ?? 0) / 100) / (1 + (prevPct ?? 0) / 100),
    // a replaced still-pending apply WAS written to DPS and may land for a few
    // minutes before this one — its price must read as "not yet", not "never"
    alsoPcts: old && !old.live && !old.expired && old.appliedPct != null
      ? [old.appliedPct].concat(old.alsoPcts || []).slice(0, 3)
      : [],
    live: false, expired: false, tries: 0, checking: false,
  });
  // rentalcars refreshes its quote cache on its own schedule — recheck at 2/5/10 min
  for (const delay of [2, 5, 10]) setTimeout(() => checkRcSync(k, false), delay * 60 * 1000);
}

/** does this sync describe the cell the operator is currently looking at? */
const syncSameCell = (s) =>
  (s.station ?? state.station) === state.station &&
  (s.year ?? state.year) === state.year &&
  (s.month ?? state.month) === state.month;

async function checkRcSync(k, manual) {
  const s = rcSync.get(k);
  if (!s || s.live || s.expired || s.checking) return;
  s.checking = true;
  if (manual) renderRcTableIfOpen(s);
  try {
    // the SYNC's cell, never live state: a station/month switch inside the
    // 10-minute window used to verify another cell's price against this target
    const st = s.station ?? state.station, yr = s.year ?? state.year, mo = s.month ?? state.month;
    const r = await api(
      `/api/rc-top?station=${st}&year=${yr}&month=${mo}&day=${s.day}&duration=${s.dur}&${RC_CANON}&fresh=1`
    );
    s.tries++;
    const { cls } = s.allServed != null
      ? syncClassify(s, r)
      : { cls: [r.gmPrice].filter((v) => v != null).some((v) => Math.abs(v - s.target) / s.target < 0.025) ? 'live' : 'prev' };
    if (cls === 'live') {
      s.live = true;
      s.liveRank = r.gmRank;
      toast(`rentalcars LIVE ✓ ${String(s.day).padStart(2, '0')}.${mo} · ${s.dur}D now #${r.gmRank} (${r.gmPrice.toFixed(2)} ${r.currency})`);
      if (syncSameCell(s) && rcMonth.dur === s.dur) {
        rcMonth.days.set(s.day, {
          day: s.day, rank: r.gmRank, price: r.gmPrice, total: r.total,
          currency: r.currency, top1: r.top[0] ? { supplier: r.top[0].supplier, price: r.top[0].price, logo: r.top[0].logo } : null,
        });
        renderRankStrip();
        renderDashTiles();
      }
      if (syncSameCell(s) && rcCtx && rcCtx.day === s.day && rcCtx.dur === s.dur) {
        rcCtx.data = r; // live now — the projection overlay is no longer needed
        rcBuildView(); // keep the category-scoped view in sync with fresh data
        if (rcCtx.placed && rcCtx.placed.proj) rcCtx.placed = null;
      }
      // Berkay, 2026-08-30: the landing is confirmed at a SECOND, random hour
      // too — rentalcars caches per (date, hour), so one hour agreeing could
      // still be one cached generation talking to itself
      confirmSecondHour(s);
    } else if (cls === 'genlive') {
      // matches the target only through the concurrent-generation offset:
      // looks live, not provable — neither a confirmation nor a strike
      if (manual) toast(`GM serves ${r.gmPrice != null ? r.gmPrice.toFixed(2) : '—'} — within the other price generation of target ${s.target.toFixed(2)}; waiting for a settling draw.`);
    } else if (cls === 'ambiguous') {
      // the change is smaller than rentalcars' 2.5% quote noise: this draw can
      // never prove it landed. Declaring live here once showed the untouched
      // OLD ladder as the verified applied state.
      if (s.tries >= 3) s.expired = true;
      if (manual) toast(`the applied change is smaller than rentalcars' quote noise — cannot be verified against the live quote (GM ${r.gmPrice != null ? r.gmPrice.toFixed(2) : '—'}).`, 'warn');
    } else {
      // 'prev' / 'silent' / 'contradict': the last scheduled recheck has run
      // and the target never arrived — stop treating it as "about to land".
      // It must not go on seeding bases for projections hours later.
      if (s.tries >= 3) s.expired = true;
      if (manual) {
        toast(`rentalcars still serves the old quote (GM ${r.gmPrice != null ? r.gmPrice.toFixed(2) : '—'}, target ${s.target.toFixed(2)}) — their cache refreshes within minutes.`, 'warn');
      }
    }
  } catch {}
  s.checking = false;
  renderRcTableIfOpen(s);
}

/** After the canonical hour confirms LIVE, ask ONE more random hour on the
 *  ring. Each (date, hour) is its own rentalcars search key with its own
 *  cache, so a second hour agreeing is genuinely independent evidence that
 *  the applied price is what shoppers get — not one generation echoing. */
async function confirmSecondHour(s) {
  if (s.hour2) return; // one confirmation per sync
  const pool = RC_HOURS.filter((h) => h !== RC_START_HOUR);
  const h = pool[Math.floor(Math.random() * pool.length)];
  s.hour2 = { hh: h, state: 'checking' };
  renderRcTableIfOpen(s);
  try {
    const st = s.station ?? state.station, yr = s.year ?? state.year, mo = s.month ?? state.month;
    const r = await api(
      `/api/rc-top?station=${st}&year=${yr}&month=${mo}&day=${s.day}&duration=${s.dur}&hh=${rcHH(h)}&mm=${rcMM(h)}&fresh=1&samples=2`
    );
    const { cls } = s.allServed != null
      ? syncClassify(s, r)
      : { cls: [r.gmPrice].filter((v) => v != null).some((v) => Math.abs(v - s.target) / s.target < 0.025) ? 'live' : 'prev' };
    // live/genlive agree; ambiguous/silent prove nothing either way — only a
    // draw that positively serves the OLD rule is worth an operator's glance
    s.hour2 = {
      hh: h,
      state: cls === 'live' || cls === 'genlive' || cls === 'ambiguous' || cls === 'silent' ? 'ok' : 'diff',
      price: r.gmPrice != null ? r.gmPrice : null,
    };
  } catch (_) {
    s.hour2 = null; // a failed query is no verdict — allow a retry next check
  }
  renderRcTableIfOpen(s);
}

function renderRcTableIfOpen(s) {
  if (syncSameCell(s) && rcCtx && rcCtx.day === s.day && rcCtx.dur === s.dur && !$('rcModal').classList.contains('hidden')) {
    renderRcTable();
  }
}

window.checkRcSyncManual = (k) => checkRcSync(k, true);

// ---------- dashboard market-rank sweep (whole month, streamed & cached) ----------

const rcMonth = { dur: 3, days: new Map(), pending: [], es: null, loadedKey: null };

function rankKey() {
  return `${state.station}:${state.year}:${state.month}:${rcMonth.dur}`;
}

function startRcMonth(force) {
  if (!state.session) return;
  if (!force && rcMonth.loadedKey === rankKey() && rcMonth.days.size) {
    renderRankStrip();
    return;
  }
  if (rcMonth.es) { rcMonth.es.close(); rcMonth.es = null; }
  rcMonth.days = new Map();
  rcMonth.pending = [];
  rcMonth.loadedKey = rankKey();
  $('rankMonth').textContent = `${MONTHS_SHORT[state.month - 1]} ${state.year} · ${stationName().toUpperCase()}`;
  renderRankDurs();
  renderRankStrip();

  if (!stationHasRc()) return; // no market mapping — nothing to stream
  lastSync.rank = Date.now();
  const es = new EventSource(
    `/api/rc-month-stream?station=${state.station}&year=${state.year}&month=${state.month}&duration=${rcMonth.dur}`
  );
  rcMonth.es = es;
  es.addEventListener('meta', (ev) => {
    const m = JSON.parse(ev.data);
    rcMonth.pending = m.days.slice();
    renderRankStrip();
  });
  es.addEventListener('day', (ev) => {
    const d = JSON.parse(ev.data);
    rcMonth.pending = rcMonth.pending.filter((x) => x !== d.day);
    rcMonth.days.set(d.day, d);
    renderRankStrip();
    if (d.day === new Date().getDate()) renderDashTiles();
  });
  es.addEventListener('done', () => { es.close(); if (rcMonth.es === es) rcMonth.es = null; });
  es.onerror = () => { es.close(); if (rcMonth.es === es) rcMonth.es = null; };
}

function renderRankDurs() {
  $('rankDurs').innerHTML = state.durations
    .map((d) => `<button class="rc-dur ${rcMonth.dur === d ? 'on' : ''}" onclick="setRankDur(${d})">${d >= OPEN_DURATION ? OPEN_DURATION + '+' : d}D</button>`)
    .join('');
}

function setRankDur(d) {
  rcMonth.dur = d;
  startRcMonth(true);
}
window.setRankDur = setRankDur;

function rankClass(rank) {
  if (rank == null) return 'rank-none';
  if (rank <= 3) return 'rank-good';
  if (rank <= 7) return 'rank-mid';
  return 'rank-bad';
}

function renderRankStrip() {
  const wrap = $('rankStrip');
  const all = [...rcMonth.pending, ...rcMonth.days.keys()];
  if (!all.length) {
    wrap.innerHTML = `<div class="drawer-empty">${t('rank_no_days')}</div>`;
    return;
  }
  const days = [...new Set(all)].sort((a, b) => a - b);
  wrap.innerHTML = days
    .map((day) => {
      const d = rcMonth.days.get(day);
      if (!d) {
        return `<div class="rank-cell rank-pending"><span class="rank-day">${String(day).padStart(2, '0')}</span><span class="rank-num">…</span></div>`;
      }
      const staleCls = d.stale ? ' rank-stale' : '';
      const staleNote = d.stale ? ' · ' + t('rank_stale_note') : '';
      if (d.error || d.rank == null) {
        return `<div class="rank-cell rank-none${staleCls}" onclick="openRcAnalysis(${day}, ${rcMonth.dur})" title="${esc(d.error || 'Green Motion not listed')}${staleNote}"><span class="rank-day">${String(day).padStart(2, '0')}</span><span class="rank-num">—</span></div>`;
      }
      return `<div class="rank-cell ${rankClass(d.rank)}${staleCls}" onclick="openRcAnalysis(${day}, ${rcMonth.dur})"
        title="GM #${d.rank} of ${d.total} · ${d.price.toFixed(2)} ${d.currency}${d.top1 ? ' · #1 ' + esc(d.top1.supplier) + ' ' + d.top1.price.toFixed(2) : ''}${staleNote}">
        <span class="rank-day">${String(day).padStart(2, '0')}</span>
        <span class="rank-num">#${d.rank}</span>
        <span class="rank-price">${Math.round(d.price)}</span>
      </div>`;
    })
    .join('');
}

$('rankRefresh').onclick = () => startRcMonth(true);

// ---------- market watch (competitor price-change alerts by email) ----------

/** One vehicle-group set = one price LANE. Rules for the economy groups and
 *  rules for the compact groups sit on the same day+duration and are priced
 *  independently, so the grid shows exactly one lane at a time. */
function laneOf(entry, key) {
  let l = entry.lanes.get(key);
  if (!l) {
    l = { lane: key, label: null, groupIds: key === 'ALL' ? null : key.split(','), cells: new Map() };
    entry.lanes.set(key, l);
  }
  return l;
}

/** Point the grid (and everything that reads state.cellMap) at one lane. */
/** Cells the given lane cannot be written to. A clash can span two lanes when
 *  their coverage overlaps without being identical, so both are blocked. */
function conflictKeysFor(entry, lane) {
  return new Set(
    [...entry.conflictMap.keys()].filter((k) => {
      const v = entry.conflictMap.get(k) || {};
      return !v.lanes || v.lanes.includes(lane);
    })
  );
}

function useLane(entry, key) {
  const l = laneOf(entry, key);
  entry.lane = key;
  entry.cells = l.cells;
  state.cellMap = l.cells;
  state.conflictSet = conflictKeysFor(entry, key);
  return l;
}

/** Which display categories a lane should be priced against.
 *
 *  The operator already answered this when they named the vehicle-group set —
 *  a set called "Ekonomi" is the economy cars — so SCAN reads the name instead
 *  of asking a second time. An unnamed set, or a name that matches nothing,
 *  falls back to every category (the behaviour before lanes existed).
 *  Names are matched in all three interface languages plus the raw key. */
function laneCategories(l) {
  if (!l || l.lane === 'ALL' || !l.label) return null;
  const norm = (x) =>
    String(x || '').toLowerCase()
      .replace(/[ıİ]/g, 'i').replace(/[şŞ]/g, 's').replace(/[ğĞ]/g, 'g')
      .replace(/[üÜ]/g, 'u').replace(/[öÖ]/g, 'o').replace(/[çÇ]/g, 'c')
      .replace(/[^a-z0-9]/g, '');
  const want = norm(l.label);
  if (!want) return null;
  const hit = RC_CAT_DISPLAY.filter((d) => {
    const names = [d.key, ...Object.keys(I18N).map((lg) => I18N[lg][d.i18n])].filter(Boolean).map(norm);
    return names.some((nm) => nm && (want === nm || want.includes(nm) || nm.includes(want)));
  }).map((d) => d.key);
  return hit.length ? hit : null;
}

/** What to call a lane in the switcher: the operator's own group-set name when
 *  the rules carry one, otherwise how many groups it covers. */
function laneTitle(l) {
  if (l.lane === 'ALL') return t('lane_all');
  if (l.label) return l.label;
  return t('lane_groups', { n: (l.groupIds || []).length });
}

/** The lane switcher above the grid. Hidden while only one lane exists — a
 *  single-category station should look exactly as it always did. */
function renderLaneBar() {
  const bar = $('laneBar');
  if (!bar) return;
  // Retired 2026-08-28 (Berkay): weekly rules always cover ALL vehicle groups
  // now, so there is exactly one lane and the switcher only added noise. The
  // lane model itself stays — it is what keeps a hand-made subset rule in DPS
  // from colliding with the console's own rules.
  bar.classList.add('hidden');
  bar.innerHTML = '';
  return;
  /* eslint-disable no-unreachable */
  const e = state.entry;
  const lanes = e ? [...e.lanes.values()].filter((l) => l.cells.size || l.lane === e.lane) : [];
  if (!e || lanes.length < 2) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  lanes.sort((a, b) => (a.lane === 'ALL' ? -1 : b.lane === 'ALL' ? 1 : b.cells.size - a.cells.size));
  bar.classList.remove('hidden');
  bar.innerHTML =
    `<span class="lane-label">${t('lane_bar')}</span>` +
    lanes
      .map(
        (l) => `<button class="lane-chip ${l.lane === e.lane ? 'on' : ''}" data-lane="${esc(l.lane)}">
          ${esc(laneTitle(l))}<span class="lane-count">${l.cells.size}</span>
        </button>`
      )
      .join('');
  bar.querySelectorAll('.lane-chip').forEach((b) => (b.onclick = () => switchLane(b.dataset.lane)));
}

/** Switch the grid to another vehicle-group set. Staged edits belong to the
 *  lane they were made in, so switching with unapplied work asks first. */
async function switchLane(key) {
  const e = state.entry;
  if (!e || key === e.lane) return;
  if (state.staged.size && !(await confirmBox(t('lane_switch_staged')))) return;
  state.staged.clear();
  scan.compare.clear();
  useLane(e, key);
  renderGrid();
  renderLaneBar();
  updateChips();
  renderApplyBar();
}

function renderWatchRows(w) {
  const fmtTs = (x) => (x ? new Date(x).toLocaleString('de-CH', { hour12: false }).slice(0, 17) : '—');
  const cloud = !/^(localhost|127\.)/.test(location.hostname);
  // relays may be absent on a pre-sprint-2 server — plain ONLINE label then
  const relays = Array.isArray(w.relays) ? w.relays.filter((x) => x && x.name) : [];
  const names = relays.slice(0, 2).map((x) => esc(x.name)).join(', ');
  const relayRow = cloud
    ? `<div class="stat-row"><span>${t('w_relay')}</span><b class="${w.relayOnline ? 'stat-accent' : 'stat-warn'}">${w.relayOnline ? t('sys_relay_on') + (names ? ' · ' + names : '') : t('sys_relay_off')}</b></div>`
    : '';
  // C2: the hourly auto-scan (S6) — absent on a pre-sprint-5 server, so every read is guarded
  const as = w.autoScan && typeof w.autoScan === 'object' ? w.autoScan : null;
  const asPending = as ? Number(as.pendingCount || 0) : 0;
  const asMissing = as ? Number(as.missingCount || 0) : 0;
  const asRows = as
    ? `<div class="stat-row"><span>${t('w_autoscan')}</span><b class="${as.enabled ? 'stat-accent' : 'stat-warn'}">${as.enabled ? t('active_w') : t('autoscan_off')}</b></div>
      ${as.horizonDays ? `<div class="stat-row"><span>${t('w_as_horizon')}</span><b>${t('w_as_days', { n: as.horizonDays })}</b></div>` : ''}
      <div class="stat-row"><span>${t('w_as_lastrun')}</span><b>${fmtTs(as.lastRun)}</b></div>
      <div class="stat-row"><span>${t('w_as_pending')}</span><b class="${asPending ? 'stat-warn' : ''}">${asPending}</b></div>
      ${asMissing ? `<div class="stat-row"><span>${t('w_as_missing')}</span><b class="stat-warn">${asMissing}</b></div>` : ''}
      ${asPending && as.pending
        ? `<div class="stat-row"><button class="btn btn-primary btn-xs" id="autoscanApplyBtn" onclick="applyAutoscan()">${esc(t('autoscan_apply', { n: asPending }))}</button></div>`
        : ''}`
    : '';
  $('watchStatus').innerHTML = `
      <div class="stat-row"><span>${t('w_status')}</span><b class="${w.enabled ? 'stat-accent' : 'stat-warn'}">${w.enabled ? t('active_w') : t('w_not_conf')}</b></div>
      ${relayRow}
      <div class="stat-row"><span>${t('w_sweep')}</span><b>${t('w_every', { m: w.intervalMin, d: w.daysAhead, dur: w.duration })}</b></div>
      <div class="stat-row"><span>${t('w_triggers')}</span><b>${t('w_triggers_v', { p: w.pctThreshold, r: w.rankThreshold })}</b></div>
      <div class="stat-row"><span>${t('w_baseline')}</span><b>${w.baseline} ${t('sys_days')}</b></div>
      <div class="stat-row"><span>${t('w_lastsweep')}</span><b>${fmtTs(w.lastRun)}</b></div>
      <div class="stat-row"><span>${t('w_alerts')}</span><b class="${w.alertsSent ? 'stat-warn' : ''}">${w.alertsSent}${w.lastAlert ? ' · ' + t('last_w') + ' ' + fmtTs(w.lastAlert) : ''}</b></div>
      <div class="stat-row"><span>${t('w_mailto')}</span><b>${esc(w.mailTo || '—')}</b></div>
      ${asRows}`;
}

// the apply runs in the background on the server; poll the stored set until it
// records its {ok,fail}. Null when it is still running after the window — the
// activity list and the confirmation mail carry the result either way.
async function waitForProposal(id, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await new Promise((s) => setTimeout(s, 3000));
    try {
      const d = await api('/api/proposals');
      const s = (d.proposals || []).find((x) => x.id === id);
      if (s && s.status === 'applied' && s.result) return s.result;
    } catch {}
  }
  return null;
}

// C2: apply the pending auto-scan proposal set from the dashboard — the same
// engine the one-click mail approval uses, just with the operator cookie.
async function applyAutoscan() {
  const as = state.watchInfo && state.watchInfo.autoScan;
  if (!as || !as.pending || !as.pendingCount) return;
  if (!(await confirmBox(t('autoscan_confirm', { n: Number(as.pendingCount) })))) return;
  const btn = $('autoscanApplyBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await api(`/api/proposals/${encodeURIComponent(as.pending)}/apply`, { method: 'POST', body: {} });
    // a set of 50-150 cells takes minutes of DPS writes and hosting cuts the
    // request at 60s, so the server queues the loop and answers `queued` — wait
    // for the stored result instead of reporting the empty acknowledgement
    let rs = (r && typeof r.result === 'object' && r.result) || r || {};
    if (r && r.queued) {
      toast(t('autoscan_running', { n: Number(r.count) || Number(as.pendingCount) }));
      rs = (await waitForProposal(as.pending)) || {};
    }
    // the counters come back either flat or under `result` ({ok,fail} of the stored set)
    const okN = typeof rs.ok === 'number' ? rs.ok : 0;
    const failN = typeof rs.fail === 'number' ? rs.fail : 0;
    if (rs.ok != null || rs.fail != null)
      toast(t('autoscan_done', { ok: okN, fail: failN }), failN ? 'warn' : undefined);
    // the writes span months and both stations — drop every cached month and
    // re-stream the rank strip (the server already purged its rc cache)
    state.monthCache.clear();
    rcMonth.loadedKey = null;
    if (state.entry) loadGrid();
    if (state.view === 'dashboard') startRcMonth(true);
    refreshLogs();
    refreshWatchStatus();
  } catch (e) {
    toast(t('autoscan_failed', { msg: e.message }), 'error');
    if (btn) btn.disabled = false;
  }
}
window.applyAutoscan = applyAutoscan;

async function refreshWatchStatus() {
  try {
    const w = await (await fetch('/api/watch-status')).json();
    if (w.error === 'SESSION_REPLACED' && state.session) {
      // the 3-min tick doubles as the replaced-session signal for idle devices
      setSession(false);
      openSessionModal(t('session_replaced'));
      return;
    }
    if (w.error) return;
    state.watchInfo = w;
    // a running reset/copy outlives page refreshes — surface it in the topbar
    if (w.purge && w.purge.running) {
      $('syncChip').classList.remove('hidden');
      $('syncChip').textContent = `${t('purge_progress')} ${w.purge.done}/${w.purge.total}`;
    } else if (w.copy && w.copy.running) {
      $('syncChip').classList.remove('hidden');
      $('syncChip').textContent = `${t('copy_progress')} ${w.copy.done}/${w.copy.total}`;
    }
    renderRelayChip();
    renderDashTiles();
    renderWatchRows(w);
    // the settings worker list must not freeze while that view sits open
    if (state.view === 'settings') renderSystemRows();
  } catch {}
}

// topbar chip: an offline relay is otherwise invisible until an RC query fails
function renderRelayChip() {
  const cloud = !/^(localhost|127\.)/.test(location.hostname);
  const off = cloud && state.watchInfo && state.watchInfo.relayOnline === false;
  $('relayChip').classList.toggle('hidden', !off);
  if (off) $('relayChip').textContent = t('relay_chip_off');
}

setInterval(refreshWatchStatus, 180000);

$('testMailBtn').onclick = async () => {
  $('testMailBtn').disabled = true;
  $('testMailBtn').textContent = 'SENDING…';
  try {
    const r = await api('/api/test-mail', { method: 'POST', body: {} });
    toast(`Test mail sent to ${r.accepted.join(', ')} — server said: ${r.response}`);
    refreshLogs();
  } catch (e) {
    toast('Mail failed: ' + e.message, 'error');
  } finally {
    $('testMailBtn').disabled = false;
    $('testMailBtn').textContent = 'TEST MAIL';
  }
};

$('watchRunBtn').onclick = async () => {
  $('watchRunBtn').disabled = true;
  $('watchRunBtn').textContent = 'RUNNING…';
  try {
    await api('/api/watch-run', { method: 'POST', body: {} });
    toast('Market sweep finished — baseline updated; alerts (if any) were emailed.');
    refreshWatchStatus();
  } catch (e) {
    toast('Sweep failed: ' + e.message, 'error');
  } finally {
    $('watchRunBtn').disabled = false;
    $('watchRunBtn').textContent = 'RUN NOW';
  }
};

// ---------- top-10 sweep: push GM into the top-N for the whole month, one click ----------

const sweep = { durs: new Set([2, 3, 4, 5, 6]), plan: [], running: false, cancel: false };

$('sweepBtn').onclick = () => {
  if (!state.entry) { toast(t('t_load_grid_first'), 'warn'); return; }
  sweep.plan = [];
  $('sweepTitle').textContent = `TOP-10 SWEEP — ${MONTHS[state.month - 1]} ${state.year} · ${stationName().toUpperCase()}`;
  $('sweepBody').innerHTML = '<div class="drawer-empty">SCAN queries rentalcars for each day &amp; duration, then shows the planned DPS changes before anything is written.</div>';
  $('sweepMeta').textContent = '';
  $('sweepApplyBtn').classList.add('hidden');
  renderSweepDurs();
  $('sweepModal').classList.remove('hidden');
};

function renderSweepDurs() {
  $('sweepDurs').innerHTML = state.durations
    .map((d) => `<button class="rc-dur ${sweep.durs.has(d) ? 'on' : ''}" onclick="toggleSweepDur(${d})">${d >= OPEN_DURATION ? OPEN_DURATION + '+' : d}D</button>`)
    .join('');
}

function toggleSweepDur(d) {
  if (sweep.durs.has(d)) sweep.durs.delete(d);
  else sweep.durs.add(d);
  renderSweepDurs();
}
window.toggleSweepDur = toggleSweepDur;

$('sweepClose').onclick = async () => {
  if (!sweep.running) { $('sweepModal').classList.add('hidden'); return; }
  // R6: a running scan/apply is a multi-step operation — confirm the abort,
  // then raise the cancel flag the loops honour between iterations.
  if (!(await confirmBox(t('sweep_cancel_confirm')))) return;
  sweep.cancel = true;
};

function sweepDays() {
  const now = new Date();
  const first =
    state.year === now.getFullYear() && state.month === now.getMonth() + 1
      ? now.getDate()
      : new Date(state.year, state.month - 1, 1) < now
        ? state.grid.daysInMonth + 1
        : 1;
  const days = [];
  for (let d = first; d <= state.grid.daysInMonth; d++) days.push(d);
  return days;
}

$('sweepScanBtn').onclick = async () => {
  if (sweep.running) return;
  const targetRank = Math.max(1, Math.min(20, Number($('sweepRank').value) || 10));
  const durs = [...sweep.durs].sort((a, b) => a - b);
  if (!durs.length) { toast('Pick at least one duration.', 'error'); return; }
  const days = sweepDays();
  if (!days.length) { toast('No searchable days in this month.', 'warn'); return; }

  sweep.running = true;
  sweep.cancel = false;
  sweep.plan = [];
  $('sweepScanBtn').disabled = true;
  $('sweepApplyBtn').classList.add('hidden');
  const cells = [];
  for (const day of days) for (const dur of durs) cells.push([day, dur]);
  const total = cells.length;
  let done = 0, planned = 0, already = 0, skipped = 0, floored = 0;

  const sweepCell = async (day, dur) => {
      done++;
      $('sweepMeta').textContent = `SCANNING ${done}/${total} · ${planned} planned`;
      // the same back-pressure manners as SCAN: ease off when the single
      // instance is pushing back, so a sweep can never become a 429 storm
      if (apiThrottled()) await new Promise((r2) => setTimeout(r2, 1500));
      try {
        // pricing decisions ride on these numbers — 30-minute tolerance, not 6h
        const r = await api(
          `/api/rc-top?station=${state.station}&year=${state.year}&month=${state.month}&day=${day}&duration=${dur}&${RC_CANON}&fresh=1&samples=2`
        );
        const others = r.top.filter((x) => !/green motion/i.test(x.supplier));
        if (r.gmPrice == null) { skipped++; return; }
        if (r.gmRank != null && r.gmRank <= targetRank) { already++; return; }
        const anchor = others[Math.min(targetRank, others.length) - 1];
        if (!anchor) { skipped++; return; }
        let target = anchor.price * 0.99; // land just inside the target rank
        // the pricing band's floor: chasing the rank must never sell the car
        // away — no more than 5% or 10 CHF under the cheapest competitor
        const cheapest = others[0].price;
        const floorPrice = Math.max(cheapest * 0.95, cheapest - 10);
        if (target < floorPrice) { target = floorPrice; floored++; }
        const cell = state.cellMap.get(key(day, dur));
        const curPct = cell ? cell.pct : 0;
        const base = r.gmPrice / (1 + curPct / 100);
        let newPct = Math.max(-95, Math.min(100, Math.round((target / base - 1) * 10000) / 100));
        if (Math.abs(newPct - curPct) < 0.5) { already++; return; } // nothing worth writing
        planned++;
        sweep.plan.push({
          day, dur, gmRank: r.gmRank, curPct, newPct,
          target, currency: r.currency, ruleid: cell ? cell.ruleid : null,
          active: cell ? cell.active : true, status: 'PLANNED',
        });
      } catch (e) {
        skipped++;
      }
      renderSweepList();
  };

  // 3 in flight fills the relay's pipe without queueing on it — same number,
  // same reasoning as SCAN's pool
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, cells.length) }, async () => {
      while (!sweep.cancel && cursor < cells.length) {
        const [day, dur] = cells[cursor++];
        await sweepCell(day, dur);
      }
    })
  );

  const cancelled = sweep.cancel;
  sweep.running = false;
  sweep.cancel = false;
  $('sweepScanBtn').disabled = false;
  $('sweepMeta').textContent = cancelled
    ? `CANCELLED · ${done}/${total} scanned · ${planned} changes planned`
    : `${total} scanned · ${planned} planned · ${already} already ok · ${skipped} skipped` +
      (floored ? ` · ${floored} held at the price floor` : '');
  if (cancelled) toast(t('cancelled'));
  if (planned) {
    $('sweepApplyBtn').textContent = `APPLY ${planned} CHANGES`;
    $('sweepApplyBtn').classList.remove('hidden');
  } else if (!cancelled) {
    $('sweepBody').innerHTML += '<div class="rc-hint">Nothing to do — Green Motion is already inside the target rank everywhere it is listed.</div>';
  }
};

function renderSweepList() {
  if (!sweep.plan.length) return;
  $('sweepBody').innerHTML = `<div class="sweep-list">${sweep.plan
    .map(
      (p) => `<div class="sweep-row ${p.status === 'OK' ? 'sw-ok' : p.status === 'ERR' ? 'sw-err' : ''}">
        <span class="sw-day">${String(p.day).padStart(2, '0')} ${MONTHS_SHORT[state.month - 1]} · ${p.dur >= OPEN_DURATION ? OPEN_DURATION + '+' : p.dur}D</span>
        <span>#${p.gmRank || '—'} &rarr; top</span>
        <span><b>${p.curPct}%</b> &rarr; <span class="sw-target">${p.newPct}%</span></span>
        <span>${p.target.toFixed(2)} ${esc(p.currency)}</span>
        <span class="sw-status">${p.status}</span>
      </div>`
    )
    .join('')}</div>`;
}

$('sweepApplyBtn').onclick = async () => {
  if (sweep.running || !sweep.plan.length) return;
  if (!(await confirmBox(`Write ${sweep.plan.length} rule change(s) to DPS (${stationName()})?`))) return;
  sweep.running = true;
  sweep.cancel = false;
  $('sweepApplyBtn').disabled = true;
  $('sweepScanBtn').disabled = true;
  let ok = 0, fail = 0;

  for (const p of sweep.plan) {
    if (sweep.cancel) break;
    p.status = 'WRITING…';
    renderSweepList();
    const body = {
      station: state.station, day: p.day, duration: p.dur,
      month: state.month, year: state.year, pct: p.newPct,
      active: true, vendors: [state.vendor],
    };
    try {
      let result;
      const k = key(p.day, p.dur);
      const cell = state.cellMap.get(k);
      if (cell) {
        result = await api(`/api/rule/${cell.ruleid}`, { method: 'PUT', body: { ...body, prevPct: cell.pct } });
        state.cellMap.set(k, { ...cell, pct: p.newPct, active: true });
      } else {
        result = await api('/api/rule', { method: 'POST', body });
        state.cellMap.set(k, {
          day: p.day, dur: p.dur, ruleid: result.ruleid, name: result.detail.rulename,
          pct: p.newPct, active: true, numDaysOp: opForDur(p.dur), opMismatch: false,
          vendors: [state.vendor], updated: '',
        });
      }
      refreshCell(p.day, p.dur);
      p.status = result.verified === false ? 'OK (unverified)' : 'OK';
      ok++;
    } catch (e) {
      p.status = 'ERR';
      p.error = e.message;
      fail++;
      if (String(e.message).includes('SESSION')) break;
    }
    renderSweepList();
    $('sweepMeta').textContent = `APPLYING… ${ok + fail}/${sweep.plan.length} · ${ok} ok · ${fail} failed`;
  }

  const cancelled = sweep.cancel;
  sweep.running = false;
  sweep.cancel = false;
  $('sweepApplyBtn').disabled = false;
  $('sweepScanBtn').disabled = false;
  $('sweepApplyBtn').classList.add('hidden');
  $('sweepMeta').textContent = `${cancelled ? 'CANCELLED' : 'DONE'} · ${ok} applied · ${fail} failed — rentalcars will reflect after their next cache refresh.`;
  toast(cancelled ? t('cancelled') : `Top-10 sweep finished: ${ok} ok, ${fail} failed.`, fail ? 'warn' : undefined);
  // drop our stale rentalcars cache for every touched day so the next
  // rank-strip refresh / modal open re-queries live data
  const touchedDays = [...new Set(sweep.plan.filter((p) => p.status.startsWith('OK')).map((p) => p.day))];
  await Promise.all(touchedDays.map((day) => fetch('/api/rc-invalidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ station: state.station, year: state.year, month: state.month, day }),
  }).catch(() => {})));
  rcMonth.loadedKey = null; // next dashboard visit re-streams post-sweep ranks
  refreshLogs();
};

// ---------- SCAN: crowd 4 GM cars into the top 10 for the whole visible month ----------
// Proposals only STAGE (orange cells) — the normal apply bar + its confirm is
// the write path, and scan-born writes carry a shared batch id for one-click
// revert from the activity log. Scan never raises a price and never deletes.

// `compare` (C1): "day:dur" -> the before/after picture of the proposal staged
// for that cell, kept until the APPLY loop turns it into the comparison popup.
const scan = { running: false, cancel: false, compare: new Map() };

// GM's rank in every display category it competes in, now and after all of its
// offers are scaled by `factor` (one DPS % moves every GM car by the same
// amount). `anchor` is the competitor price at the target rank — the number the
// canonical category factor is built from.
function scanCatCompare(r, factor, targetRank) {
  const out = [];
  for (const d of RC_CAT_DISPLAY) {
    const rowsF = (r.top || []).filter((x) => rowInCat(x, d.key)); // already price-sorted
    if (!rowsF.length) continue;
    const gmIdx = rowsF.findIndex(rcIsGm);
    if (gmIdx < 0) continue; // GM has no car in this category
    const comp = rowsF.filter((x) => !rcIsGm(x)).map((x) => x.price);
    if (!comp.length) continue; // server skips a category with no competitor — mirror it
    const after = rowsF
      .map((x) => (rcIsGm(x) ? { ...x, price: x.price * factor } : x))
      .sort((a, b) => a.price - b.price);
    const afterIdx = after.findIndex(rcIsGm);
    out.push({
      cat: d.key,
      rankNow: gmIdx + 1,
      rankAfter: afterIdx >= 0 ? afterIdx + 1 : null,
      gmPrice: rowsF[gmIdx].price,
      anchor: comp.length ? comp[Math.min(targetRank, comp.length) - 1] : null,
    });
  }
  return out;
}

/** SCAN over the visible month. `scope` (optional, used by the bulk follow-up)
 *  pins the run to an explicit set of days/durations and skips the mode dialog:
 *  `{ mode:'category'|'overall', days:[dayOfMonth], durs:[2,3] }`. Scoped days
 *  are still intersected with the searchable days — rentalcars cannot quote the
 *  past. Resolves `{ n, cancelled }`. */
async function runScan(scope) {
  // R6: while a scan is already running the button becomes its cancel
  // affordance (confirmed) — raise the flag the loop checks between cells.
  if (scan.running) {
    if (await confirmBox(t('scan_cancel_confirm'))) scan.cancel = true;
    return { n: 0, cancelled: true };
  }
  if (!state.entry) { toast(t('t_load_grid_first'), 'warn'); return { n: 0, cancelled: false }; }
  if (state.applying) return { n: 0, cancelled: false };
  if (!stationHasRc()) { toast(t('no_rc_station'), 'warn'); return { n: 0, cancelled: false }; }
  // One strategy, no questions (Berkay, 2026-08-28): SCAN always runs the
  // all-category band — just under the cheapest competitor in every category
  // GM competes in, on the days that have weekly rules. The operator's choices
  // live where they belong: dates and durations in the weekly-rules modal, and
  // per-cell price revisions on the staged grid before APPLY.
  const mode = 'category';
  // THE PRICING BAND (same numbers as the server's auto-scan, 2026-08-28):
  // sit JUST under the cheapest competitor — "if they are at 100, be at 95-97,
  // never 70". Target 97 per 100; floor 95 per 100 and never more than 10 CHF
  // under. The math runs on displayed prices, so an active campaign discount
  // (the -12%) is already inside every number it compares.
  const UNDERCUT_TARGET = 0.03;
  const MAX_UNDERCUT = 0.05;
  const CAT_RANK = 1; // rank bookkeeping for the compare popup: the target IS #1
  // ...and the HARD floor: whatever the percentages say, Green Motion never
  // sits more than this many CHF under the cheapest competitor. On a 1-3 day
  // rental a percentage is a small number of francs, so the percentage floor
  // alone still allowed half-price days (40 CHF against an 80 CHF field).
  const MAX_UNDERCUT_CHF = 10;
  const searchable = sweepDays();
  const days = scope && Array.isArray(scope.days)
    ? searchable.filter((d) => scope.days.includes(d))
    : searchable;
  const durs = scope && Array.isArray(scope.durs)
    ? state.durations.filter((d) => scope.durs.includes(d))
    : state.durations;

  // SCAN prices the weekly rules that EXIST — nothing else. Walking the whole
  // month meant 420 competitor lookups for a lane that only had rules on 7
  // days: 322 of them queried a market for a cell there was nothing to reprice
  // on. The grid, DPS and the scan now agree on the same work list.
  const priced = [];
  for (const day of days)
    for (const dur of durs)
      if (state.cellMap.has(key(day, dur))) priced.push([day, dur]);
  // a lane with no rules at all still scans the month, so a fresh month can be
  // priced from scratch the way it always could
  const cells = priced.length ? priced : days.flatMap((day) => durs.map((dur) => [day, dur]));
  const total = cells.length;
  if (!total) { toast(t('scan_none')); return { n: 0, cancelled: false }; }

  // one deliberate click, with the real size of what is about to run — a scan
  // fires dozens of market queries and stages price changes, so it must never
  // start off a stray tap. Programmatic callers (scope) skip the question.
  if (!scope && !(await confirmBox(t('scan_confirm_q', { n: total })))) {
    return { n: 0, cancelled: false };
  }

  // Which categories SCAN prices is NOT asked here: the operator already made
  // that choice when they picked the vehicle groups for this lane's weekly
  // rules. SCAN prices the lane on screen, so it targets exactly the display
  // categories that lane's own Green Motion cars appear in — asking again
  // would be a second answer to a question already settled.
  const activeLaneObj = state.entry && state.entry.lanes.get(state.entry.lane);
  const govern = (scope && Array.isArray(scope.categories))
    ? scope.categories
    : laneCategories(activeLaneObj);
  const governSet = govern && govern.length ? new Set(govern) : null;

  let floored = 0;   // cells the margin floor held back, reported at the end
  let throttled = 0; // cells that had to wait out server back-pressure
  let overloaded = false; // the run gave up because the server kept refusing
  const SCAN_MAX_CELL_RETRIES = 4;
  // Concurrency: the answers come through one relay that caps itself at 4
  // parallel rentalcars fetches, so 3 in flight keeps the pipe full without
  // queueing on it; under back-pressure the pool degrades to serial because
  // every worker sits in the same apiThrottled() pause.
  const SCAN_POOL = 3;
  const failedCells = []; // cells lost to non-transient errors — retried once at the end
  scan.running = true;
  flagsPause(); // a scan mid-run repaints the board — no amber until it lands
  scan.cancel = false;
  scan.compare.clear(); // the popup only ever describes the run that just went out
  let done = 0, n = 0;

  // one cell, complete with its own retry ladder — shared state (staged,
  // compare, counters) is safe because JS runs these interleaved, not parallel
  const runCell = async (day, dur, isRetryPass) => {
      {
        if (scan.cancel) return;
        done++;
        setSyncing(true, Math.min(done, total), total);
        $('syncChip').textContent = t('scan_running', { done: Math.min(done, total), total });
        // one attempt per pass; a refused cell comes back round rather than
        // being dropped, so a burst costs time instead of coverage
        let cellRetries = 0;
        let redo = true;
        let cellFloored = false; // this cell is being pulled back up to the floor
        while (redo) {
        redo = false;
        cellFloored = false;
        // the console shares ONE Cloud Run instance, so a scan that fires as
        // fast as it can is competing with the operator's own page. When the
        // server has just pushed back, pace this loop down instead.
        if (apiThrottled()) await new Promise((r) => setTimeout(r, 1200));
        try {
          // pricing decisions ride on these numbers, so the cache tolerance is
          // 30 minutes here — not the grid's lazy 6 hours
          const r = await api(
            `/api/rc-top?station=${state.station}&year=${state.year}&month=${state.month}&day=${day}&duration=${dur}&${RC_CANON}&fresh=1&samples=2`
          );
          if (r.gmPrice == null) continue;
          const k = key(day, dur);
          if (state.conflictSet.has(k)) continue; // conflicted cells: resolve in DPS first
          // skip cells the operator already staged manually — their green edit wins
          const prior = state.staged.get(k);
          if (prior && !prior.scan) continue;
          const cell = state.cellMap.get(k);
          const curPct = cell ? Number(cell.pct) : 0;
          if (!Array.isArray(r.gmOffers) || !r.gmOffers.length) continue;
          let newPct;
          if (mode === 'category') {
            // one DPS % scales every GM car together, so "just under the
            // cheapest firm in EVERY category" reduces to the tightest
            // target across the categories GM competes in, clamped to the
            // floor of whichever category would be pushed under its band
            const cats = new Set();
            for (const x of r.top) {
              if (!Array.isArray(x.categories)) continue;
              for (const c of x.categories) if (RC_CAT_MAP[c]) cats.add(RC_CAT_MAP[c]);
            }
            let factor = null;
            let floor = null; // highest per-category floor across the set
            for (const cat of cats) {
              if (governSet && !governSet.has(cat)) continue; // not a category we price
              const rowsF = r.top.filter((x) => rowInCat(x, cat));
              const gmF = rowsF.filter((x) => /green motion/i.test(x.supplier));
              if (!gmF.length) continue; // no GM car in this category
              const compF = rowsF.filter((x) => !/green motion/i.test(x.supplier)).map((x) => x.price);
              if (!compF.length) continue; // GM alone here — already first
              const cheapest = compF[0];
              const f = (cheapest * (1 - UNDERCUT_TARGET)) / gmF[0].price; // 97 per their 100
              if (isFinite(f) && f > 0 && (factor == null || f < factor)) factor = f;
              // the band's floor: 95 per 100, and never >10 CHF under
              const fl = Math.max(cheapest * (1 - MAX_UNDERCUT), cheapest - MAX_UNDERCUT_CHF) / gmF[0].price;
              if (isFinite(fl) && fl > 0 && (floor == null || fl > floor)) floor = fl;
            }
            if (factor == null) continue;
            if (floor != null && floor > factor) {
              // Below the band — either one category's target would bury
              // another, or GM is simply selling too cheap (the 40-vs-80 CHF
              // days). Both are corrections that have to be WRITTEN, so the
              // floor becomes the target — the one case where SCAN moves a
              // price up.
              factor = floor;
              cellFloored = true;
              floored++;
            } else if (Math.abs(factor - 1) < 0.005) continue; // already in the band
            // p' = p * factor  =>  (1 + new/100) = (1 + cur/100) * factor
            newPct = Math.round(((1 + curPct / 100) * factor - 1) * 10000) / 100;
          } else {
            if (r.top.slice(0, 10).filter((x) => /green motion/i.test(x.supplier)).length >= K) continue;
            const comp = r.compPrices;
            if (!Array.isArray(comp) || comp.length <= 10 - K) continue;
            const target = comp[10 - K] * 0.995; // the K-th cheapest GM car must undercut this
            const kOffer = r.gmOffers[K - 1] || r.gmOffers[r.gmOffers.length - 1];
            const baseK = kOffer.price / (1 + curPct / 100);
            newPct = Math.round((target / baseK - 1) * 10000) / 100;
          }
          newPct = Math.max(-95, Math.min(100, newPct));
          // SCAN never raises a price — except to pull one back above the
          // floor, which is a correction of an unsafe price, not margin-taking
          if (newPct >= curPct && !cellFloored) continue;
          if (Math.abs(newPct - curPct) < 0.5) continue; // nothing worth writing
          state.staged.set(k, { pct: newPct, scan: true });
          // C1: remember the rank picture this proposal buys — the factor is the
          // one the WRITTEN percent actually applies (after clamp + rounding)
          scan.compare.set(k, {
            station: state.station, stationName: stationName(),
            year: state.year, month: state.month, day, dur, curPct, newPct,
            cats: scanCatCompare(r, (1 + newPct / 100) / (1 + curPct / 100), CAT_RANK),
          });
          refreshCell(day, dur);
          n++;
        } catch (e) {
          const msg = String((e && e.message) || '');
          // The console runs on a single Cloud Run instance, so a burst can be
          // refused outright ("no available instance" -> 429). api() already
          // waited that out; if it still surfaced here the server is genuinely
          // under pressure — pause and retry this SAME cell instead of losing
          // it. A scan that quietly skips days leaves the table half-priced.
          if (/HTTP 429|no available instance/i.test(msg)) {
            if (cellRetries < SCAN_MAX_CELL_RETRIES) {
              cellRetries++;
              throttled++;
              await new Promise((r) => setTimeout(r, 5000 + Math.random() * 5000));
              redo = true; // re-run this (day, dur) rather than skipping it
            } else {
              // still refused after several waits — stop cleanly with what we
              // have rather than grinding through the month for nothing
              scan.cancel = true;
              overloaded = true;
              return;
            }
          }
          // session died mid-scan: stop instead of spamming the login modal
          else if (/SESSION|NOT_SIGNED_IN/.test(msg)) { scan.cancel = true; overloaded = false; return; }
          // anything else (relay hiccup, one bad response): the cell is NOT
          // silently dropped — it goes on the end-of-run retry list
          else if (!isRetryPass) failedCells.push([day, dur]);
        }
        } // end per-cell retry
      }
  };

  try {
    // the worker pool: a shared cursor, SCAN_POOL drainers
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(SCAN_POOL, cells.length) }, async () => {
        while (!scan.cancel && cursor < cells.length) {
          const [day, dur] = cells[cursor++];
          await runCell(day, dur, false);
        }
      })
    );
    // second chance for cells lost to transient errors — serial, once
    if (!scan.cancel && failedCells.length) {
      const again = failedCells.splice(0);
      for (const [day, dur] of again) {
        if (scan.cancel) break;
        await runCell(day, dur, true);
      }
    }
  } finally {
    scan.running = false;
    setSyncing(false);
  }
  renderApplyBar();
  const cancelled = scan.cancel;
  toast(cancelled ? t('cancelled') : n ? t(mode === 'category' ? 'scan_done_cat' : 'scan_done', { n }) : t('scan_none'));
  if (!cancelled && floored)
    toast(t('scan_floor_note2', {
      n: floored, u: Math.round(MAX_UNDERCUT * 100), chf: MAX_UNDERCUT_CHF,
    }), 'warn');
  if (!cancelled && govern && govern.length)
    toast(t('scan_cat_scoped', {
      c: govern.map((k) => t((RC_CAT_DISPLAY.find((d) => d.key === k) || {}).i18n || k)).join(', '),
    }));
  if (overloaded) toast(t('scan_overloaded', { done: Math.min(done, total), total }), 'warn');
  else if (throttled) toast(t('scan_throttled', { n: throttled }), 'warn');
  if (!cancelled && failedCells.length)
    toast(t('scan_failed_cells', { n: failedCells.length }), 'warn');
  scan.cancel = false;
  return { n, cancelled };
}

// bare arrow: the click Event must never arrive as the `scope` argument
if ($('scanBtn')) $('scanBtn').onclick = () => runScan();

// ---------- C6: bulk weekly-rule creation ----------
// DATE CORRECTNESS is the whole point of this block: every date in the horizon
// is built with Date.UTC() and read back with getUTC*, so a 31-day month, a
// leap day or a DST switch can never shift a day by one. The preview line the
// operator confirms comes out of the SAME walk the server runs, so the two
// cannot disagree — the client sends only `startDate` + `days` and both sides
// derive the identical calendar from them.

const BULK_HORIZONS = [30, 60, 90, 120, 180];
// the server refuses anything longer (server.js: BULK_MAX_DAYS) — reject it
// here too so a typed horizon fails in the box rather than at apply time
const BULK_MAX_DAYS = 400;

/** Parse 'YYYY-MM-DD' — null unless it is a REAL calendar date (2026-02-30 is
 *  not: Date.UTC rolls it into March and the read-back catches that). */
function parseISODate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() + 1 !== mo || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

const isoOfUTC = (t) =>
  `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;

/** `days` calendar days from startDate INCLUSIVE → [{iso, y, m, d}]. */
function walkDays(startISO, days) {
  const s = parseISODate(startISO);
  const n = Number(days);
  if (!s || !Number.isInteger(n) || n <= 0) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(Date.UTC(s.y, s.m - 1, s.d + i));
    out.push({ iso: isoOfUTC(t), y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
  }
  return out;
}

function todayISO() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

const bulk = {
  days: 30,
  durs: new Set(),
  groups: new Set(), // selected group ids; empty = every group (server default)
  skip: true,
  jobId: null,
  running: false,
  lastDates: [],
  lastDurs: [],
};

/** The percent field, or null while it is empty / out of range. */
function bulkPct() {
  const raw = $('bulkPct').value.trim().replace(',', '.');
  if (raw === '' || raw === '-') return null;
  const n = Number(raw);
  if (!isFinite(n) || n < -95 || n > 100) return null;
  return n;
}

/** A horizon typed by hand: a plain day count, or a span in the operator's own
 *  words — "2 hafta", "3 weeks", "1 ay", "2w". Returns days, or null. */
function parseHorizon(raw) {
  const txt = String(raw || '').trim().toLowerCase()
    .replace(/[ıİ]/g, 'i').replace(/[şŞ]/g, 's').replace(/[ğĞ]/g, 'g')
    .replace(/[üÜ]/g, 'u').replace(/[öÖ]/g, 'o').replace(/[çÇ]/g, 'c');
  if (!txt) return null;
  const m = /^(\d+(?:[.,]\d+)?)\s*([a-z]*)$/.exec(txt);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  if (!isFinite(n) || n <= 0) return null;
  const unit = m[2];
  // tr: gun/hafta/ay · en: day/week/month · de: tag/woche/monat
  let mult = 1;
  if (/^(g|gun|gunluk|d|day|days|t|tag|tage)$/.test(unit)) mult = 1;
  else if (/^(h|hafta|haftalik|w|week|weeks|wo|woche|wochen)$/.test(unit)) mult = 7;
  else if (/^(a|ay|aylik|m|month|months|mo|monat|monate)$/.test(unit)) mult = 30;
  else if (unit) return null; // an unknown word is a typo, not a horizon
  const days = Math.round(n * mult);
  if (days < 1 || days > BULK_MAX_DAYS) return null;
  return days;
}

function renderBulkChips() {
  $('bulkDays').innerHTML = BULK_HORIZONS
    .map((d) => `<button class="rc-dur ${bulk.days === d ? 'on' : ''}" data-h="${d}">${d}</button>`)
    .join('');
  // the free-text box mirrors the chips: whichever was touched last wins, and
  // the box shows the current horizon so the two can never disagree on screen
  const box = $('bulkDaysCustom');
  if (box && document.activeElement !== box) box.value = String(bulk.days);
  $('bulkDurs').innerHTML = state.durations
    .map((d) => `<button class="rc-dur ${bulk.durs.has(d) ? 'on' : ''}" data-d="${d}">${d >= OPEN_DURATION ? OPEN_DURATION + '+' : d}D</button>`)
    .join('');
  $('bulkSkip').classList.toggle('on', bulk.skip);
  $('bulkSkip').setAttribute('aria-checked', bulk.skip ? 'true' : 'false');
}

// named vehicle-group sets, per franchise
let vgPresetList = [];

async function loadVgPresets() {
  try {
    vgPresetList = (await api('/api/vg-presets')).presets || [];
  } catch {
    vgPresetList = [];
  }
  renderVgPresets();
}

function renderVgPresets() {
  const el = $('vgPresets');
  if (!el) return;
  if (!vgPresetList.length) { el.innerHTML = ''; return; }
  el.innerHTML =
    `<span class="vg-presets-hint">${t('vg_presets_hint')}</span>` +
    vgPresetList
      .map(
        (p) => {
          // a set counts as "chosen" when exactly its groups are selected —
          // that is what turns it orange, the same way the chips go orange
          const on =
            bulk.groups.size === p.ids.length && p.ids.every((id) => bulk.groups.has(id));
          return (
            `<span class="vg-preset"><button class="vg-preset-use ${on ? 'on' : ''}" data-p="${esc(p.id)}">${esc(p.name)} <i>${p.ids.length}</i></button>` +
            `<button class="vg-preset-del" data-pd="${esc(p.id)}">&times;</button></span>`
          );
        }
      )
      .join('');
}

function renderVgList() {
  renderVgPresets(); // keep the "chosen set" highlight in step with the chips
  const el = $('vgList');
  const groups = state.vehicleGroups;
  if (!groups.length) {
    el.innerHTML = `<div class="drawer-empty">${t('vg_unavailable')}</div>`;
    $('vgCount').textContent = t('vg_all');
    return;
  }
  el.innerHTML = groups
    .map((g) => `<button class="vg-item ${bulk.groups.has(g.id) ? 'vg-on' : ''}" data-g="${esc(g.id)}">${esc(g.code)}</button>`)
    .join('');
  // 0 selected and "all selected" mean the same thing to DPS — say ALL GROUPS
  // for both, and only show the counter while the selection is a real subset
  $('vgCount').textContent = bulk.groups.size && bulk.groups.size < groups.length
    ? t('vg_selected', { n: bulk.groups.size, total: groups.length })
    : t('vg_all');
}

/** inclusive day count between two YYYY-MM-DD values (UTC-safe), or null */
function bulkRangeDays() {
  const a = $('bulkStart').value;
  const z = $('bulkEnd') ? $('bulkEnd').value : '';
  if (!a || !z) return null;
  const p = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  };
  const s0 = p(a);
  const e0 = p(z);
  if (s0 == null || e0 == null) return null;
  return Math.round((e0 - s0) / 86400000) + 1;
}

/** end date implied by the active horizon chip — keeps the two inputs agreeing */
function syncEndFromHorizon() {
  const dates = walkDays($('bulkStart').value, bulk.days);
  if (!dates.length || !$('bulkEnd')) return;
  const last = dates[dates.length - 1];
  $('bulkEnd').value = last.iso || last; // walkDays yields {iso, y, m, d}
}

function renderBulkPreview() {
  // an explicit range wins over the chip, so the operator can pick any span
  const range = bulkRangeDays();
  if (range != null && range > 0) bulk.days = range;
  const dates = walkDays($('bulkStart').value, bulk.days);
  const durs = [...bulk.durs].sort((a, b) => a - b);
  const pct = bulkPct();
  const rangeErr =
    range != null && range <= 0 ? t('bulk_range_bad')
      : range != null && range > 400 ? t('bulk_range_long')
        : null;
  if (rangeErr) {
    $('bulkPreview').innerHTML = `<span class="bulk-invalid">${rangeErr}</span>`;
    $('bulkApplyBtn').disabled = true;
    return;
  }
  $('bulkApplyBtn').disabled = bulk.running;
  $('bulkPreview').innerHTML = dates.length && durs.length && pct !== null
    ? t('bulk_preview', { n: dates.length * durs.length, from: dates[0].iso, to: dates[dates.length - 1].iso })
    : t('bulk_preview_bad');
}

function renderBulkProgress(st) {
  const total = Number(st.total) || 0;
  const done = Number(st.done) || 0;
  $('bulkProg').classList.remove('hidden');
  $('bulkBarFill').style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
  $('bulkProgMeta').textContent = t('bulk_running', {
    done, total, ok: st.ok || 0, fail: st.fail || 0,
  });
}

// ---------- the weekly-rules DELETE surface (Berkay, 2026-08-30) ----------
// The DPS-style full rule list: click selects, shift-click selects a range,
// ctrl/cmd-click toggles, Delete (or the button) asks "emin misin" and bulk-
// deletes; afterwards the grid re-syncs by itself.
const rulesUi = { list: [], sel: new Set(), anchor: null, busy: false };

async function openRulesModal() {
  $('rulesModal').classList.remove('hidden');
  rulesUi.sel.clear();
  rulesUi.anchor = null;
  $('rulesBody').innerHTML = rcLoadingHtml(t('rules_loading'));
  $('rulesMeta').textContent = '';
  try {
    const r = await api(`/api/rules-list?station=${state.station}`);
    rulesUi.list = Array.isArray(r.rules) ? r.rules : [];
    renderRulesList();
  } catch (e) {
    $('rulesBody').innerHTML = `<div class="drawer-empty">${esc(e.message)}</div>`;
  }
}

function renderRulesList() {
  const rows = rulesUi.list
    .map((r, i) => `<tr data-i="${i}" class="${rulesUi.sel.has(r.ruleid) ? 'rules-sel' : ''}">
      <td class="rc-rank">${i + 1}</td>
      <td class="rules-name">${esc(r.name)}</td>
      <td>${r.active ? 'YES' : '—'}</td>
      <td>${esc(r.from)}</td><td>${esc(r.to)}</td><td>${esc(r.updated || r.added || '')}</td>
    </tr>`)
    .join('');
  $('rulesBody').innerHTML = `<table class="rc-table rules-table">
    <thead><tr><th></th><th>RULE NAME</th><th>ACTIVE</th><th>FROM</th><th>TO</th><th>UPDATED</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  // selection updates flip classes in place — a full re-render would throw the
  // scroll back to the top of an 800-row list on every click
  $('rulesBody').querySelectorAll('tbody tr').forEach((tr) => {
    tr.onclick = (e) => {
      const i = Number(tr.dataset.i);
      const id = rulesUi.list[i].ruleid;
      if (e.shiftKey && rulesUi.anchor != null) {
        const a = Math.min(rulesUi.anchor, i);
        const b = Math.max(rulesUi.anchor, i);
        if (!e.ctrlKey && !e.metaKey) rulesUi.sel.clear();
        for (let j = a; j <= b; j++) rulesUi.sel.add(rulesUi.list[j].ruleid);
      } else if (e.ctrlKey || e.metaKey) {
        if (rulesUi.sel.has(id)) rulesUi.sel.delete(id);
        else rulesUi.sel.add(id);
        rulesUi.anchor = i;
      } else {
        rulesUi.sel.clear();
        rulesUi.sel.add(id);
        rulesUi.anchor = i;
      }
      updateRulesSelection();
    };
  });
  updateRulesSelection();
}

function updateRulesSelection() {
  $('rulesBody').querySelectorAll('tbody tr').forEach((tr) => {
    const id = rulesUi.list[Number(tr.dataset.i)].ruleid;
    tr.classList.toggle('rules-sel', rulesUi.sel.has(id));
  });
  $('rulesMeta').textContent = t('rules_selected', { n: rulesUi.sel.size, total: rulesUi.list.length });
  $('rulesDeleteBtn').disabled = rulesUi.sel.size === 0 || rulesUi.busy;
}

async function rulesDeleteSelected() {
  if (rulesUi.busy) return;
  const ids = [...rulesUi.sel];
  if (!ids.length) return;
  if (ids.length > 500) { toast(t('rules_too_many'), 'warn'); return; }
  rulesUi.busy = true;
  updateRulesSelection();
  try {
    if (!(await confirmBox(t('rules_confirm', { n: ids.length })))) return;
    const r = await api('/api/rules-delete', { method: 'POST', body: { station: state.station, ruleids: ids } });
    toast(t('rules_deleted', { n: r.deleted }));
    rulesUi.sel.clear();
    rulesUi.anchor = null;
    await openRulesModal(); // the list re-reads from the supplier system
    loadGrid();             // …and the grid re-syncs automatically
    refreshLogs();
  } catch (e) {
    toast('Delete failed: ' + e.message, 'error');
  } finally {
    rulesUi.busy = false;
    updateRulesSelection();
  }
}

if ($('rulesListBtn')) $('rulesListBtn').onclick = openRulesModal;
if ($('rulesClose')) $('rulesClose').onclick = () => $('rulesModal').classList.add('hidden');
if ($('rulesDeleteBtn')) $('rulesDeleteBtn').onclick = rulesDeleteSelected;
if ($('rulesModal')) $('rulesModal').addEventListener('click', (e) => {
  if (e.target === $('rulesModal')) $('rulesModal').classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if ($('rulesModal').classList.contains('hidden')) return;
  if (rulesUi.busy) return;
  e.preventDefault();
  rulesDeleteSelected();
});

$('bulkBtn').onclick = async () => {
  if (!state.session) { openSessionModal(''); return; }
  if (!state.station) { toast(t('t_load_grid_first'), 'warn'); return; }
  if (bulk.running) { $('bulkModal').classList.remove('hidden'); return; }
  if (!$('bulkStart').value) $('bulkStart').value = todayISO();
  if (!$('bulkEnd').value) syncEndFromHorizon();
  if (!bulk.durs.size) for (const d of state.durations) bulk.durs.add(d);
  $('bulkTitle').textContent = `${t('bulk_title')} — ${stationName().toUpperCase()}`;
  $('bulkProg').classList.add('hidden');
  $('bulkMeta').textContent = '';
  $('bulkCancelBtn').classList.add('hidden');
  $('bulkApplyBtn').classList.remove('hidden');
  $('bulkApplyBtn').disabled = false;
  renderBulkChips();
  renderVgList();
  renderBulkPreview();
  $('bulkModal').classList.remove('hidden');
  await loadVehicleGroups();
  renderVgList();
  loadVgPresets();
};

$('bulkDays').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-h]');
  if (!b) return;
  bulk.days = Number(b.dataset.h);
  syncEndFromHorizon(); // the chip is a shortcut for "end date = start + N"
  renderBulkChips();
  renderBulkPreview();
});

if ($('bulkDaysCustom')) {
  const applyCustom = () => {
    const box = $('bulkDaysCustom');
    const days = parseHorizon(box.value);
    box.classList.toggle('field-bad', box.value.trim() !== '' && days == null);
    if (days == null) return;
    bulk.days = days;
    syncEndFromHorizon();
    renderBulkChips();
    renderBulkPreview();
  };
  $('bulkDaysCustom').addEventListener('input', applyCustom);
  $('bulkDaysCustom').addEventListener('change', applyCustom);
  $('bulkDaysCustom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyCustom(); }
  });
}

for (const id of ['bulkStart', 'bulkEnd']) {
  $(id).addEventListener('change', () => {
    if (id === 'bulkStart' && !$('bulkEnd').value) syncEndFromHorizon();
    renderBulkChips();
    renderBulkPreview();
  });
}

$('bulkDurs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-d]');
  if (!b) return;
  const d = Number(b.dataset.d);
  if (bulk.durs.has(d)) bulk.durs.delete(d);
  else bulk.durs.add(d);
  renderBulkChips();
  renderBulkPreview();
});

$('bulkSkip').onclick = () => {
  bulk.skip = !bulk.skip;
  renderBulkChips();
};

$('vgList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-g]');
  if (!b) return;
  const id = b.dataset.g;
  if (bulk.groups.has(id)) bulk.groups.delete(id);
  else bulk.groups.add(id);
  bulk.groupName = null; // a hand-picked selection is no longer that saved set
  renderVgList();
});

$('vgAllBtn').onclick = () => {
  bulk.groups = new Set(state.vehicleGroups.map((g) => g.id));
  bulk.groupName = null;
  renderVgList();
};

$('vgNoneBtn').onclick = () => {
  bulk.groups.clear();
  bulk.groupName = null;
  renderVgList();
};

$('vgPresets').addEventListener('click', async (e) => {
  const use = e.target.closest('button[data-p]');
  if (use) {
    const p = vgPresetList.find((x) => x.id === use.dataset.p);
    if (!p) return;
    // a set means EXACTLY those groups — replace the selection, don't merge
    bulk.groups = new Set(p.ids.filter((id) => state.vehicleGroups.some((g) => g.id === id)));
    bulk.groupName = p.name; // written into the DPS rule name
    renderVgList();
    renderBulkPreview();
    return;
  }
  const del = e.target.closest('button[data-pd]');
  if (!del) return;
  const p = vgPresetList.find((x) => x.id === del.dataset.pd);
  if (!p || !(await confirmBox(t('vg_del_confirm', { name: p.name })))) return;
  try {
    await api(`/api/vg-presets/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    vgPresetList = vgPresetList.filter((x) => x.id !== p.id);
    renderVgPresets();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('vgSaveBtn').onclick = async () => {
  const name = $('vgPresetName').value.trim();
  if (!name) { toast(t('vg_name_first'), 'warn'); return; }
  if (!bulk.groups.size) { toast(t('vg_pick_first'), 'warn'); return; }
  $('vgSaveBtn').disabled = true;
  try {
    const r = await api('/api/vg-presets', { method: 'POST', body: { name, ids: [...bulk.groups] } });
    vgPresetList = vgPresetList.filter((x) => x.name.toLowerCase() !== name.toLowerCase());
    vgPresetList.push(r.preset);
    $('vgPresetName').value = '';
    bulk.groupName = name;
    renderVgPresets();
    toast(t('vg_saved', { name }));
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    $('vgSaveBtn').disabled = false;
  }
};

$('bulkStart').addEventListener('change', renderBulkPreview);
$('bulkStart').addEventListener('input', renderBulkPreview);
$('bulkPct').addEventListener('input', renderBulkPreview);

$('bulkClose').onclick = async () => {
  if (!bulk.running) { $('bulkModal').classList.add('hidden'); return; }
  await bulkCancel();
};

$('bulkCancelBtn').onclick = () => bulkCancel();

async function bulkCancel() {
  if (!bulk.running || !bulk.jobId) return;
  if (!(await confirmBox(t('bulk_cancel_confirm')))) return;
  try {
    await api(`/api/rules/bulk/${encodeURIComponent(bulk.jobId)}/cancel`, { method: 'POST' });
    toast(t('bulk_cancelled'));
  } catch (e) {
    toast(e.message, 'error');
  }
}

$('bulkApplyBtn').onclick = async () => {
  if (bulk.running) return;
  const startDate = $('bulkStart').value;
  const dates = walkDays(startDate, bulk.days);
  const durs = [...bulk.durs].sort((a, b) => a - b);
  const pct = bulkPct();
  if (!dates.length) { toast(t('bulk_bad_date'), 'error'); return; }
  if (!durs.length) { toast(t('bulk_bad_durs'), 'error'); return; }
  if (pct === null) { toast(t('bulk_bad_pct'), 'error'); return; }
  // "not more than 24 months out", measured the same UTC-safe way
  const s = parseISODate(startDate);
  const now = new Date();
  const limit = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 24, now.getUTCDate());
  if (Date.UTC(s.y, s.m - 1, s.d) > limit) { toast(t('bulk_bad_date'), 'error'); return; }

  // vehicle-group selection retired 2026-08-28: every rule covers ALL groups
  const groupsLabel = t('vg_all');
  const okToRun = await confirmBox(t('bulk_confirm', {
    n: dates.length * durs.length,
    pct,
    station: esc(stationName()),
    from: dates[0].iso,
    to: dates[dates.length - 1].iso,
    groups: groupsLabel,
  }));
  if (!okToRun) return;

  const body = {
    station: state.station,
    startDate,
    days: bulk.days,
    durations: durs,
    // the longest duration in this sweep is the open-ended bucket (`>=`), so
    // rentals longer than it stay covered — the server derives it too, this is
    // belt and braces and makes the preview honest
    openDuration: Math.max(...durs),
    pct,
    skipExisting: bulk.skip,
    vendors: [state.vendor],
  };
  if ($('bulkEnd').value) body.endDate = $('bulkEnd').value;
  // vehicle-group selection retired 2026-08-28: every weekly rule covers ALL
  // groups. No vehicleIds in the payload = the server writes full coverage.

  bulk.running = true;
  bulk.lastDates = dates;
  bulk.lastDurs = durs;
  $('bulkApplyBtn').disabled = true;
  $('bulkCancelBtn').classList.remove('hidden');
  $('bulkProg').classList.remove('hidden');
  $('bulkBarFill').style.width = '0%';
  $('bulkProgMeta').textContent = t('bulk_running', { done: 0, total: dates.length * durs.length, ok: 0, fail: 0 });

  let job;
  try {
    job = await api('/api/rules/bulk', { method: 'POST', body });
  } catch (e) {
    bulk.running = false;
    $('bulkApplyBtn').disabled = false;
    $('bulkCancelBtn').classList.add('hidden');
    $('bulkProg').classList.add('hidden');
    toast(t('bulk_failed', { code: e.message }), 'error');
    return;
  }
  bulk.jobId = job && job.jobId;
  if (!bulk.jobId) {
    bulk.running = false;
    $('bulkApplyBtn').disabled = false;
    $('bulkCancelBtn').classList.add('hidden');
    toast(t('bulk_failed', { code: 'NO_JOB' }), 'error');
    return;
  }
  await bulkFinish(await bulkWatch());
};

/** How often to ask the server how the sweep is going. A sweep runs for
 *  minutes to an hour, and the console is pinned to ONE Cloud Run instance —
 *  polling every 1.5s for the whole run cost thousands of requests and ate the
 *  headroom the sweep's own DPS writes needed (the operator saw those as 429s
 *  on /api/rules/bulk/<id>). Poll fast while the operator is watching the
 *  first moments, then settle down; back right off while the server is
 *  pushing back. Progress is durable server-side, so a slower poll loses
 *  nothing but a little smoothness. */
function bulkPollDelay(elapsedMs) {
  if (apiThrottled()) return 15000;
  if (elapsedMs < 15000) return 1500;   // responsive start
  if (elapsedMs < 60000) return 4000;
  return 8000;                          // long haul
}

/** Poll the job until it stops running. A run of failed polls (server restart,
 *  cookie churn) gives up rather than spinning forever. */
async function bulkWatch() {
  let misses = 0;
  const startedAt = Date.now();
  while (bulk.running && bulk.jobId) {
    await new Promise((r) => setTimeout(r, bulkPollDelay(Date.now() - startedAt)));
    if (!bulk.running || !bulk.jobId) break;
    let st;
    try {
      st = await api(`/api/rules/bulk/${encodeURIComponent(bulk.jobId)}`);
      misses = 0;
    } catch (e) {
      // the sweep itself keeps running on the server and checkpoints durably,
      // so a lost poll is only a lost progress frame — be patient about it
      if (++misses >= 30) return null;
      continue;
    }
    renderBulkProgress(st);
    if (st.status !== 'running') return st;
  }
  return null;
}

async function bulkFinish(st) {
  bulk.running = false;
  bulk.jobId = null;
  $('bulkApplyBtn').disabled = false;
  $('bulkCancelBtn').classList.add('hidden');
  const ok = st ? Number(st.ok) || 0 : 0;
  const fail = st ? Number(st.fail) || 0 : 0;
  if (!st) toast(t('bulk_failed', { code: 'NO_STATUS' }), 'error');
  else if (st.status === 'failed') toast(t('bulk_failed', { code: st.error || 'FAILED' }), 'error');
  else toast(t('bulk_done', { ok, fail }), fail ? 'warn' : undefined);
  // cells the job refused to narrow: say so, they are NOT priced
  const cov = st ? Number(st.skippedCoverage) || 0 : 0;
  $('bulkMeta').textContent = `${ok} ok · ${fail} failed` + (cov ? ` · ${t('bulk_skipped_cov', { n: cov })}` : '');
  if (cov) toast(t('bulk_skipped_cov', { n: cov }), 'warn');

  // the new rules are DPS facts now: repaint the month, void the rank cache
  state.monthCache.delete(cacheKey());
  rcMonth.loadedKey = null;
  if (state.session) loadGrid();
  if (state.view === 'dashboard') startRcMonth(true);
  refreshLogs();

  if (!ok) { $('bulkModal').classList.add('hidden'); return; }
  await bulkFollowUp();
}

/** Wait for the grid stream to finish so the scan reads real current values. */
async function waitForGrid(ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (state.entry && state.entry.complete) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** The follow-up the operator asked for: price the fresh rules by hand, or run
 *  the existing category SCAN over exactly the days/durations just created.
 *  Proposals stage per month (state.staged is the visible month's), so the scan
 *  covers this batch's days inside the month on screen and says so. */
async function bulkFollowUp() {
  const inMonth = bulk.lastDates
    .filter((x) => x.y === state.year && x.m === state.month)
    .map((x) => x.d);
  const scopeNote = inMonth.length
    ? t('bulk_fu_scope', { n: inMonth.length, month: `${MONTHS_SHORT[state.month - 1]} ${state.year}` })
    : t('bulk_fu_none');
  // the creation window goes first — the choice dialog must stand alone over
  // the grid, not stack on a spent modal (Berkay, 2026-08-30)
  $('bulkModal').classList.add('hidden');
  const choice = await choiceBox(t('bulk_fu_q'), [
    { value: 'manual', title: t('bulk_fu_manual'), desc: t('bulk_fu_manual_d') },
    { value: 'scan', title: t('bulk_fu_scan'), desc: `${t('bulk_fu_scan_d')} ${scopeNote}` },
  ]);
  if (choice !== 'scan') return;
  if (!inMonth.length) { toast(t('bulk_fu_none'), 'warn'); return; }
  showView('grid');
  await waitForGrid();
  await runScan({ mode: 'category', days: inMonth, durs: bulk.lastDurs });
}

// ---------- C1: before/after popup for an apply that carried scan proposals ----------
// Built dynamically (like choiceBox) so it can open on top of whatever view the
// operator applied from. It answers one question: what did those writes buy us
// in the category ladders? The same payload also goes out as a mail report.

const catLabel = (k) => {
  const d = RC_CAT_DISPLAY.find((x) => x.key === k);
  return d ? t(d.i18n) : k;
};

function openCompareModal(items, batch, ok, fail) {
  const sign = (v) => (v > 0 ? '+' : '') + Math.round(v * 10) / 10;
  const rank1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const avg = items.reduce((s, x) => s + (x.newPct - x.curPct), 0) / items.length;

  // one row per display category: mean GM rank over the applied cells it appears in
  const agg = new Map();
  for (const it of items) {
    for (const c of it.cats || []) {
      if (c.rankNow == null || c.rankAfter == null) continue;
      const a = agg.get(c.cat) || { before: 0, after: 0, n: 0 };
      a.before += c.rankNow;
      a.after += c.rankAfter;
      a.n++;
      agg.set(c.cat, a);
    }
  }
  const rows = RC_CAT_DISPLAY.filter((d) => agg.has(d.key)).map((d) => {
    const a = agg.get(d.key);
    const before = a.before / a.n;
    const after = a.after / a.n;
    return { d, before, after, gain: Math.round((before - after) * 10) / 10 };
  });
  const moved = rows.some((x) => x.gain >= 0.05);

  const tableHtml = rows.length
    ? `<table class="cmp-table">
        <thead><tr>
          <th>${t('cmp_cat')}</th><th>${t('cmp_before')}</th><th>${t('cmp_after')}</th><th>${t('cmp_improve')}</th>
        </tr></thead>
        <tbody>${rows
          .map(
            (x) => `<tr>
              <td>${x.d.ico} ${esc(t(x.d.i18n))}</td>
              <td>#${rank1(x.before)}</td>
              <td>#${rank1(x.after)}</td>
              <td>${x.gain >= 0.05
                ? `<span class="cmp-up">${esc(t('cmp_gain', { n: x.gain }))}</span>`
                : '<span class="cmp-flat">&mdash;</span>'}</td>
            </tr>`
          )
          .join('')}</tbody>
      </table>`
    : '';

  const detailHtml = items
    .slice()
    .sort((a, b) => a.day - b.day || a.dur - b.dur)
    .map((it) => {
      const movedCats = (it.cats || [])
        .filter((c) => c.rankNow != null && c.rankAfter != null && c.rankAfter < c.rankNow)
        .map((c) => `${catLabel(c.cat)} #${c.rankNow}→#${c.rankAfter}`);
      return `<li>
        <b>${String(it.day).padStart(2, '0')} ${MONTHS_SHORT[(it.month || 1) - 1]} · ${it.dur}D</b>
        <span>${sign(it.curPct)}% → ${sign(it.newPct)}%</span>
        <span class="${movedCats.length ? 'cmp-up' : 'cmp-flat'}">${movedCats.length ? esc(movedCats.join(' · ')) : '&mdash;'}</span>
      </li>`;
    })
    .join('');

  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.innerHTML = `<div class="modal modal-rc">
    <div class="modal-head"><span>${t('cmp_title')}</span>
      <button class="btn btn-ghost btn-xs" id="cmpX">&times;</button>
    </div>
    <div class="modal-body">
      <div class="cmp-summary">${t('cmp_summary', { cells: `<b>${items.length}</b>`, avg: `<b>${sign(avg)}</b>` })}</div>
      ${tableHtml}
      ${moved ? '' : `<div class="cmp-summary cmp-flat">${t('cmp_no_change')}</div>`}
      <ul class="cmp-detail">${detailHtml}</ul>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="cmpClose">${t('cmp_close')}</button>
      <button class="btn btn-primary" id="cmpMail">${t('cmp_mail_btn')}</button>
    </div></div>`;
  document.body.appendChild(bd);

  // S5 payload — the mail says exactly what the popup shows
  const payload = {
    batch: batch || null,
    ok, fail,
    items: items.map((x) => ({
      station: x.station, stationName: x.stationName, year: x.year, month: x.month,
      day: x.day, duration: x.dur, curPct: x.curPct, newPct: x.newPct,
      cats: (x.cats || []).map((c) => ({ cat: c.cat, rankNow: c.rankNow, rankAfter: c.rankAfter })),
    })),
  };
  const sendReport = async (btn) => {
    if (btn) btn.disabled = true;
    try {
      await api('/api/report/scan-apply', { method: 'POST', body: payload });
      toast(t('cmp_mailed'));
    } catch (e) {
      toast(t('cmp_mail_failed', { msg: e.message }), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  const close = () => bd.remove();
  bd.querySelector('#cmpX').onclick = close;
  bd.querySelector('#cmpClose').onclick = close;
  bd.querySelector('#cmpMail').onclick = () => sendReport(bd.querySelector('#cmpMail'));
  bd.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }, true);
  bd.querySelector('#cmpClose').focus(); // so Escape lands on the popup, not the grid
  // the operator asked for the report to leave on its own after an apply —
  // the button is only there to send it again
  sendReport(null);
}

// ---------- focus resync (P5): fresh data whenever the operator returns ----------

async function focusResync() {
  if (!state.session || state.applying || sweep.running || focusResync._busy) return;
  if (document.querySelector('.cell-input')) return; // an in-progress cell edit would be wiped
  const now = Date.now();
  const needLogs = now - lastSync.logs > 60000;
  const needGrid = now - lastSync.grid > 600000;
  const needRank = now - lastSync.rank > 600000;
  if (!needLogs && !needGrid && !needRank) return;
  focusResync._busy = true;
  try {
    // probe the session first — every refresh below swallows a middleware 401
    const s = await (await fetch('/api/session')).json();
    if (s.replaced === true) {
      setSession(false);
      openSessionModal(t('session_replaced'));
      return;
    }
    if (needLogs) { refreshLogs(); refreshWatchStatus(); }
    if (needGrid) loadGrid();
    if (needRank) startRcMonth(true);
  } catch {} finally {
    focusResync._busy = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) focusResync();
});
window.addEventListener('focus', focusResync);

// ---------- sidebar sign-out ----------

$('sideSignout').onclick = async () => {
  if (!(await confirmBox(t('signout_confirm')))) return;
  signOutAll();
};

// ---------- alert-mail recipient (Settings) ----------

// prefs are per-uid (S6): mailTo is this operator's alert address and reports
// is their own opt-out from auto-scan / market-watch report mails. Both need
// only the operator cookie — the DPS session is a different layer.

function renderReportsSwitch() {
  const el = $('setReports');
  if (!el) return;
  const on = state.reports !== false;
  el.classList.toggle('on', on);
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}

async function renderMailPrefs() {
  try {
    const r = await api('/api/prefs');
    $('setMailInput').value = r.mailTo || '';
    state.reports = r.reports !== false;
    renderReportsSwitch();
    $('setMailRows').innerHTML = `
      <div class="stat-row"><span>${t('mail_current')}</span><b class="stat-accent">${esc(r.mailTo || r.mailDefault || '—')}</b></div>
      <div class="stat-row"><span>${t('mail_default')}</span><b>${esc(r.mailDefault || '—')}</b></div>`;
  } catch {
    $('setMailRows').innerHTML = '';
    renderReportsSwitch();
  }
}

$('setMailSave').onclick = async () => {
  $('setMailSave').disabled = true;
  try {
    await api('/api/prefs', { method: 'POST', body: { mailTo: $('setMailInput').value.trim() } });
    toast(t('mail_saved'));
    renderMailPrefs();
    refreshWatchStatus();
  } catch (e) {
    toast(e.message === 'BAD_EMAIL' ? 'Invalid e-mail address.' : e.message, 'error');
  } finally {
    $('setMailSave').disabled = false;
  }
};

$('setReports').onclick = async () => {
  const next = state.reports === false;
  $('setReports').disabled = true;
  try {
    await api('/api/prefs', { method: 'POST', body: { reports: next } });
    state.reports = next;
    renderReportsSwitch();
    toast(t('reports_saved'));
    refreshWatchStatus();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    $('setReports').disabled = false;
  }
};

// ---------- analytics insights ----------

const fmtP = (v) => (Math.round(v * 10) / 10).toString();

function renderInsights() {
  const el = $('insightsList');
  const cells = [...state.cellMap.values()];
  if (!state.grid || !cells.length) {
    el.innerHTML = `<div class="drawer-empty">${t('insights_empty')}</div>`;
    return;
  }
  const out = [];
  const active = cells.filter((c) => c.active !== false && isFinite(Number(c.pct)));
  const avg = active.reduce((s, c) => s + Number(c.pct), 0) / (active.length || 1);

  const byDur = new Map();
  for (const c of active) {
    const b = byDur.get(c.dur) || { s: 0, n: 0 };
    b.s += Number(c.pct); b.n++;
    byDur.set(c.dur, b);
  }
  const durAvgs = [...byDur.entries()].map(([dur, b]) => ({ dur, avg: b.s / b.n }));
  if (durAvgs.length) {
    const minD = durAvgs.reduce((a, b) => (a.avg < b.avg ? a : b));
    const maxD = durAvgs.reduce((a, b) => (a.avg > b.avg ? a : b));
    const durL = (x) => (x.dur >= OPEN_DURATION ? OPEN_DURATION + '+' : x.dur) + 'D';
    out.push(t('ins_avg', { cells: active.length, avg: fmtP(avg), min: fmtP(minD.avg), minDur: durL(minD), max: fmtP(maxD.avg), maxDur: durL(maxD) }));
  }

  const deepest = active.reduce((a, c) => (a == null || Number(c.pct) < Number(a.pct) ? c : a), null);
  if (deepest && Number(deepest.pct) < 0) {
    out.push(t('ins_deep', { pct: fmtP(Number(deepest.pct)), day: `${String(deepest.day).padStart(2, '0')} ${MONTHS_SHORT[state.month - 1]}`, dur: (deepest.dur >= OPEN_DURATION ? OPEN_DURATION + '+' : deepest.dur) + 'D' }));
  }

  let wkS = 0, wkN = 0, wdS = 0, wdN = 0;
  for (const c of active) {
    const dow = new Date(state.year, state.month - 1, c.day).getDay();
    if (dow === 0 || dow === 6) { wkS += Number(c.pct); wkN++; } else { wdS += Number(c.pct); wdN++; }
  }
  if (wkN && wdN) {
    const wk = wkS / wkN, wd = wdS / wdN;
    out.push(t('ins_weekend', { wk: fmtP(wk), wd: fmtP(wd), rel: wk < wd ? t('more_w') : t('less_w') }));
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const covered = new Set(active.map((c) => c.day));
  let uncovered = 0;
  for (let day = 1; day <= state.grid.daysInMonth; day++) {
    if (new Date(state.year, state.month - 1, day) >= today && !covered.has(day)) uncovered++;
  }
  out.push(uncovered ? t('ins_cover', { n: uncovered }) : t('ins_cover_ok'));

  const inactive = cells.filter((c) => c.active === false).length;
  if (inactive) out.push(t('ins_inactive', { n: inactive }));

  if (rcMonth.loadedKey === rankKey() && rcMonth.days.size) {
    const ranked = [...rcMonth.days.values()].filter((x) => x.rank != null);
    if (ranked.length) {
      const top1 = ranked.filter((x) => x.rank === 1).length;
      const avgR = ranked.reduce((s, x) => s + x.rank, 0) / ranked.length;
      const worst = ranked.reduce((a, x) => (x.rank > a.rank ? x : a));
      out.push(t('ins_rank', { top1, days: ranked.length, avg: fmtP(avgR), worst: worst.rank, worstDay: String(worst.day).padStart(2, '0') }));
      const bad = ranked.filter((x) => x.rank >= 8).length;
      if (bad) out.push(t('ins_rank_bad', { n: bad }));
    }
  }

  el.innerHTML = out.map((h) => `<div class="insight-row"><span class="insight-dot"></span><span>${h}</span></div>`).join('');
}

// ---------- boot ----------

/** Tenant + stations + role, straight from /api/stations. */
async function loadStationMeta() {
  const meta = await api('/api/stations').catch(() => ({ stations: [], durations: [2, 3, 4, 5, 6] }));
  state.stations = meta.stations || [];
  state.durations = meta.durations || state.durations;
  state.tenant = meta.tenant || state.tenant;
  if (meta.role) state.role = meta.role === 'admin' ? 'admin' : 'staff';
  state.superadmin = meta.superadmin === true;
  // keep the operator on their station whenever it survived an edit
  if (!state.stations.some((x) => x.id === state.station)) {
    state.station = state.stations[0] ? state.stations[0].id : null;
  }
  renderTenantChip();
  renderStations();
  renderSideUser();
  applyRoleUi();
  return meta;
}

/** DPS vehicle groups, once per console session — the bulk dialog and the grid
 *  cell tooltips both read them from state. Needs the DPS session, so a
 *  failure here is silent: an empty list simply means "all groups". */
async function loadVehicleGroups() {
  if (state.vehicleGroups.length) return state.vehicleGroups;
  try {
    const r = await api('/api/vehicle-groups');
    state.vehicleGroups = Array.isArray(r.groups)
      ? r.groups.filter((g) => g && g.id).map((g) => ({ id: String(g.id), code: String(g.code || g.id) }))
      : [];
  } catch {
    state.vehicleGroups = [];
  }
  // the coverage marker needs the total — repaint cells that painted without it
  if (state.grid && state.cellMap.size && !document.querySelector('.cell-input')) {
    try { renderGrid(); } catch {}
  }
  return state.vehicleGroups;
}

async function init() {
  applyLang(LANG); // translate the static chrome before anything renders
  await loadStationMeta();
  $('monthLabel').textContent = `${MONTHS[state.month - 1]} ${state.year}`;

  const h = location.hash.replace('#', '');
  showView(VIEWS.includes(h) ? h : 'dashboard');

  const s = await api('/api/session?check=1').catch(() => ({ ok: false }));
  state.user = s.user || null;
  if (s.role) state.role = s.role === 'admin' ? 'admin' : 'staff';
  if (s.email) state.account = s.email;
  setSession(!!s.ok);
  applyRoleUi();
  if (s.ok) {
    loadVendors();
    loadVehicleGroups(); // cheap, cached server-side; the grid tooltips want it
    refreshWatchStatus(); // relay chip must appear whatever the starting view
    await loadGrid();
    renderDashboard();
    if (state.view === 'dashboard') startRcMonth();
  } else {
    // step 2: the DPS session, asked for only once past the auth gate
    openSessionModal(s.replaced ? t('session_replaced') : '');
  }
}

// nothing renders until Firebase reports a signed-in user: the gate translates
// itself first, then startAuth() runs init() after the cookie exchange.
applyLang(LANG);
startAuth();
