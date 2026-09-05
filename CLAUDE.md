# Rotulus (formerly Scroll Swap)

A personal productivity PWA: habit tracker, dashboard, Pomodoro timer, diary,
to-do list, goals, a distraction-free "Lock In" mode, and settings. Started
as a plain habit tracker to replace passive scrolling with better defaults,
then grew into a full multi-page suite. Core philosophy: **beat the reflex,
not the urge** — make better options as easy to reach as the phone, at daily
anchor points (wake up, morning, afternoon, evening, before bed).

- **Repo:** github.com/AverageGuyAlex/scroll-swap (branch `main`)
- **Live site:** rotulus.netlify.app (renamed 2026-08-04 from the old
  auto-generated fluffy-faun-7f647b.netlify.app, which no longer resolves)
- **Hosting:** Netlify, GitHub-based deploy (commit → auto-deploy)

## Tech stack

Plain HTML/CSS/JS, no framework, no build step. Each page (`index.html`,
`dashboard.html`, `pomodoro.html`, `diary.html`, `todo.html`, `goals.html`,
`lock-in.html`, `settings.html`) is mostly self-contained, but **shared
styling and behavior now live in `css/rotulus.css` and `js/rotulus-shared.js`**
(see Design System below) — don't duplicate them back into pages.

- **Auth:** Netlify Identity (`netlify-identity-widget.js`)
- **Storage:** local-first. Reads from `localStorage` instantly, then syncs
  with Netlify Blobs via serverless functions (`netlify/functions/`) once
  login is confirmed.

## CRITICAL: never rename localStorage keys

All data keys are prefixed `scrollswap_`, `pomodoro_`, or `diary_` (e.g.
`scrollswap_theme`, `scrollswap_todo_state`, `scrollswap_goals_state`,
`scrollswap_lockin_total_minutes`, `scrollswap_pomodoro_timer`,
`STORAGE_PREFIX` in index.html, `isScrollSwapOwnKey()`). **Do not rename
these, ever** — even though the app is now branded "Rotulus" everywhere
user-visible, the storage keys stay `scrollswap_*`. Renaming would silently
wipe every existing user's habit streaks, tasks, goals, diary entries, and
pomodoro history. Only rename what's on-screen (titles, headers, nav links,
PWA metadata) — never touch a string that looks like a storage key.

Same rule for Netlify function names/routes and the repo name — don't touch.

## CRITICAL: the sync upload rule

Every data page (`index`, `todo`, `goals`, `pomodoro`, `diary`) syncs the same
way: on login it downloads (`pullFromServer`) and then uploads
(`pushToServer`). **The upload must never run unless the download provably
succeeded.** `pullFromServer` returns `true`/`false` for exactly this reason,
and each login handler guards with:

```js
if (pulled && hasLocalData()) await pushToServer();
```

Both halves matter. Without `pulled`, a failed download is followed by an
upload of whatever this device holds — overwriting good server data with
nothing. Without `hasLocalData()`, a device that legitimately has no data yet
(new browser, or a **new domain** — localStorage is per-domain) uploads
emptiness over everyone else's. This is not hypothetical: it wiped the server
copy on 2026-08-04 after the site was renamed to rotulus.netlify.app.

Note the upload guard belongs to the *login* path only. Uploads triggered by a
user edit (`persist()`, toggling a slot) must still send empty state — that's
how deleting your last task syncs.

Downloads are deliberately non-destructive: they only add keys or replace
state when the server actually returned something. Keep it that way.

Regression test: `tests/sync-test.js` runs each page's real script against a
fake DOM and asserts how many uploads each scenario produces — it is the guard
against reintroducing the 2026-08-04 wipe. `tests/syntax-check.js` parses every
inline `<script>`, `tests/functions-test.js` covers the serverless half (see
the next section), and `tests/escaping-test.js` + `tests/csp-hash-check.js`
guard the two halves of the XSS defence (see Security). Nothing needs installing for any of them:

```bash
node tests/functions-test.js && node tests/sync-test.js && node tests/escaping-test.js && node tests/csp-hash-check.js && node tests/cache-version-check.js && node tests/syntax-check.js && node tests/alarm-test.js
```

## The sync functions (`netlify/functions/`)

All six (`todos`, `goals`, `habits`, `pomodoro`, `diary`, `lockin`) are the same
file with two things swapped: the Blobs store name and the empty-state default a
`GET` returns. Change one and you almost certainly need to change all six —
`tests/functions-test.js` runs every one of them, so it will tell you.

- **They are V2 functions** (`export default async (req, context)`, `.mjs`,
  Request in and Response out), converted from V1 on 2026-09-02. **That was the
  whole point:** V1 does not get Netlify Blobs configured for it, so every one of
  these files needed `BLOBS_SITE_ID` and a `BLOBS_TOKEN` personal access token
  set by hand — and when that token expired on 2026-08-19, all six failed at once
  on every device, with no code change and nothing in the repo to explain it. V2
  configures Blobs itself: `getStore({ name })` takes no credentials, there is no
  env-var branch left, and **that outage cannot recur**.
- **`.mjs`, not `.js`** — V2 requires ES module syntax, and `package.json` has no
  `"type": "module"` (adding one would break every `require()` in `tests/`). The
  route is the filename minus its extension, so `/.netlify/functions/todos` is
  unchanged. Do not rename the basenames.
- **Testing them needs a source transform.** `@netlify/blobs` used to be stubbed
  by patching `Module._load`, which an ESM `import` walks straight past.
  `tests/functions-test.js` now reads each file, swaps the single import line for
  an injected `getStore`, and evaluates the body — the same trick `sync-test.js`
  and `alarm-test.js` already use on page scripts. It asserts the shape of these
  files strictly and throws if they drift from the template.
- **One test guards the whole point of the migration:** getStore must be called
  with `['name']` and nothing else. Passing a siteID or token back in would
  quietly reintroduce the expiring credential.
- **The 401 check must stay first**, before the env-var check and before any store
  access. It is the only thing standing between a stranger and the data, and its
  body deliberately says nothing about configuration — an unauthenticated caller
  must not learn whether the site's credentials are set. Tested.
- **`getStore()` belongs inside the `try`.** It used to sit above it, so a
  rejected credential crashed the whole function before the `catch` could report
  anything, and the client saw a bare failure with no cause. The `catch` now
  returns `err.name` too — the SDK throws `MissingBlobsEnvironmentError` by name,
  which is the half that actually identifies the problem.
- **Diagnosing a sync failure from the browser:** the status code names the layer.
  `401` = Identity isn't populating `clientContext`; `500` with a `missing` array
  = env vars absent; `500` with a `name` = credentials rejected; a bare platform
  `502` = something threw outside the handler entirely.
- **`package-lock.json` pins `@netlify/blobs` to 8.2.0.** Before it existed,
  `^8.1.0` re-resolved on every deploy. Keep the lockfile committed. The package
  is on 11.x now, so an upgrade is a real (and separate) piece of work — the V1
  functions and the manual siteID/token setup are what make it non-trivial.

## Pomodoro timer state

`localStorage['scrollswap_pomodoro_timer']` holds the whole timer:
`{ category, mode, durationSeconds, focusDurationSeconds, remainingAtAnchor,
anchorTimestamp, running }`. It's anchor-based, so a session survives
navigation, reloads and backgrounding without a running interval.

- **`mode`** is `'focus'` or `'break'` — the break reuses the same clock rather
  than running a second timer.
- **`durationSeconds`** is the length of whatever is currently counting, so
  during a break it holds the *break* length. **`focusDurationSeconds`**
  remembers the focus length across a break — read that one when populating the
  Minutes input, never `durationSeconds`, or a break will overwrite the user's
  focus setting.
- `loadTimerState()` backfills both fields when they're missing so a session
  saved by an older build keeps running instead of resetting.
- Break time is **never** logged. Starting a break banks the focus minutes
  already done; starting focus during a break discards the break.

**Key-prefix trap:** `collectAllLocalHistory()` in `pomodoro.html` sweeps every
`pomodoro_*` key and treats the suffix as a date, with no validation (unlike
`index.html`, which guards with `isScrollSwapOwnKey()`). Any *setting* must
therefore live under `scrollswap_` — that's why the keys are
`scrollswap_pomodoro_timer` and `scrollswap_pomodoro_break_minutes`. A key like
`pomodoro_break_minutes` would sync as a bogus day entry and corrupt the totals
and the pie chart.

## Pomodoro completion alarm

Three independent channels fire when a session ends, so one failing never
silences the others: a chime (`assets/alarm-chime.wav`), a lock-screen banner,
and a `.flash-highlight` pulse on the timer card.

- **Two completion paths, and they differ.** `completeTimer()` is the live one
  and fires all three. `displayTimerFromLocal()` handles a session that ended
  while the app was closed — it chimes and flashes but deliberately shows **no
  banner**, because you are already looking at the screen by then.
- **The keep-alive is why the alarm lands on time — and it is OFF by default.**
  `assets/alarm-keepalive.wav` is a looping, near-inaudible track — not digital
  silence, which iOS optimises away. Media playback is what stops iOS suspending
  a backgrounded page, so `tick()` keeps running with the screen off.
  **Inaudible to a person is still real audio to the phone**: iOS hands the page
  the audio focus the moment it starts, which pauses Spotify and every other app's
  music for the whole session. That is one mechanism, not two — no browser API
  separates "keeps the page awake" from "interrupts other apps" — so a reliable
  alarm and uninterrupted music cannot both be had on iOS. Music wins by default
  (changed 2026-09-01, after the interruption was reported as a bug).
  `scrollswap_pomodoro_keepalive` = `'on'` buys the on-time alarm back.
  **This is an empirical trick, not a guaranteed API.** If iOS suspends the
  page anyway, the alarm fires on reopen — the pre-feature behaviour, so the
  worst case is no regression.
- **The screen wake lock is what carries the alarm now.** It touches no audio, so
  music is unaffected; it only stops the screen auto-locking while the page is
  visible and a timer is counting, which covers a phone face-up on the desk. iOS
  releases it on its own whenever the page hides, so it can only hold a screen
  that was already on — hence no setting for it. Re-acquiring is free: the
  existing `visibilitychange` handler calls `displayTimerFromLocal()`, which
  restarts the ticker. It needs no new listener.
  **Liveness is tracked by `wakeLockWanted`, deliberately not by
  `timerDisplayHandle`.** A timer id is only guaranteed non-zero in a browser;
  reading one as "a timer is running" made the lock release itself the instant it
  resolved, under a test harness whose `setInterval` returns `0`.
- **A keep-alive left playing, or a wake lock left held, is a permanent battery
  drain.** `tests/alarm-test.js` guards both stop paths by firing the Reset and
  Pause handlers directly. Neither can be checked in a browser: `new Audio()`
  returns a **detached** element, so `document.querySelectorAll('audio')` never
  finds it. The wake-lock assertions are `async` — `requestWakeLock()` awaits,
  and the harness's `setTimeout` is a no-op stub, so they flush with
  `await Promise.resolve()` and own the file's summary and exit code.
- **`sw.js` exists only because iOS has no `Notification` constructor** — a
  banner must come from `ServiceWorkerRegistration.showNotification()`. There
  is no push and **no `fetch` handler**, so it cannot cache and cannot serve
  stale content. Never add one: a caching service worker survives a redeploy
  and no `?v=` bump would rescue it. Removing it from devices that already have
  it requires shipping a version that calls `self.registration.unregister()` —
  deleting the file is not enough.
- **Two setting keys, with opposite defaults, and that is easy to get backwards.**
  `scrollswap_pomodoro_alarm` (the chime) defaults **on** and is read `!== 'off'`;
  `scrollswap_pomodoro_keepalive` defaults **off** and is read `=== 'on'`. Both
  live in `pomodoro.html` and `settings.html` and must agree in both places.
  The prefix is mandatory — see the key-prefix trap above.
  `Notification.permission` is the only source of truth for whether a banner can
  show; there is deliberately no second flag that could disagree with it.
- **The alarm toggle uses `.seg-btn`, not `.theme-btn`.** `applyTheme()` clears
  `selected` from every `.theme-btn` whose `dataset.theme` does not match the
  current choice, which would silently wipe the alarm setting's highlight on any
  theme change.
- Regenerate the sounds with `node tools/make-alarm-audio.js`. Because
  `/assets/*` is cached for a year, a changed sound needs a **new filename**,
  not an overwrite.

## Backup and restore (`settings.html`)

The only way data leaves the app, and the reason the rest of the 2026-09-02 batch
was safe to ship. Everything lives in localStorage plus Blobs; clearing site data
used to be unrecoverable.

- **Export sweeps all three prefixes wholesale** (`scrollswap_`, `pomodoro_`,
  `diary_`) and writes `{ app, version, exportedAt, keys }`, values kept as raw
  strings so nothing is reparsed. **Deliberately NOT `isScrollSwapOwnKey()`** from
  `index.html`: that narrows to habit dates and the labels key, which is right for
  the habit sync and would silently drop tasks, goals, the diary and every setting
  from a backup.
- **Import refuses anything it does not recognise** — wrong `app`, unknown
  `version`, no matching keys — rather than guessing, and it drops any key outside
  the three prefixes whatever the file claims. It clears our own keys first, so
  items deleted since the backup do not survive the restore.
- Confirmation is a **second tap on the relabelled button**, not `confirm()`.

## To-Do and Goals merge (the data-loss fix)

Until 2026-09-02 both pages did `state = serverState; saveLocal()` on every pull.
Last writer won and the other device's work vanished with no error, on any
divergence — aeroplane mode, a dead signal, or just phone-then-laptop.

- Merge is **by item `id`** (`uid()` has always produced stable ones), with
  `updatedAt` settling conflicts and **tombstones** (`state.deletedIds`) so a
  delete is not resurrected by the other device's copy.
- **A missing `updatedAt` counts as 0**, so anything saved before this shipped
  loses to a stamped edit rather than winning by accident.
- **A tombstone loses to an item edited after it** — re-adding something on one
  device survives a stale delete from the other.
- **Children merge regardless of which parent won**, or renaming a category on one
  device would drop the other's new tasks along with it.
- Tombstones are pruned at 90 days; without that they grow forever.
- Goals additionally merges `dailyHours` key by key and unions
  `linkedCategoryIds` — hours logged on two devices on different days are both
  real, and losing a link silently is worse than keeping both.
- **Habits, Pomodoro and Diary need none of this** and were never affected: one
  key per day means a pull only ever adds days, so they heal on their own.
- 13 scenarios in `tests/sync-test.js` guard it. The login-path guard
  `if (pulled && hasLocalData())` is unchanged — merging changes what a pull
  *does*, never whether an upload may run.

## To-Do colour groups and sorting

- **The colour IS the group.** A category carries a group **id** (`cat.group`),
  not a hex string, so its swatch follows the light/dark palette instead of
  freezing a shade. Six fixed colours replace the old free `<input type="color">`,
  which let every category be its own colour — that was the clutter.
- Categories saved before this hold arbitrary hex and are snapped to the nearest
  palette colour once by RGB distance, inside the same `try`/`catch` as the local
  render. **`initApp()` must not be able to throw.**
- **Only non-empty groups render**, so six headings never appear before use.
- Group names live in the synced blob (`state.groupNames`); collapsed state is a
  per-device preference (`scrollswap_todo_collapsed_groups`), as is the sort
  (`scrollswap_todo_sort`). Both are read **before** the first render, or the list
  paints unsorted and expanded and then visibly rearranges itself.
- Sorting is within a group. "Newest" reads `createdAt`, falling back to decoding
  the timestamp out of `uid()` (`Date.now().toString(36)` plus five characters)
  for categories that predate the field.
- `escapeHtml()` was added here — names were being interpolated into markup raw.

## Goals: linked To-Do categories

Milestones were free text you had to tick a second time, in a second place. A goal
now points at the To-Do categories that move it forward, and the tick comes from
the tasks themselves.

- `goal.linkedCategoryIds`; the To-Do state is read straight out of localStorage
  the way `dashboard.html` reads other pages' keys. No second sync.
- **Progress is derived on every render and never stored**, so it cannot drift.
- A category deleted in To-Do renders as "Category removed" with an unlink button
  — it must not vanish silently or throw on the missing object.
- **The stored `milestones` array is deliberately left in place**, just not
  rendered, so nothing is thrown away and this is reversible.
- The row markup reuses the `.milestone-*` styles; only the source of the tick
  changed.

## Undo, offline, and the shared snackbar

- **`confirm()` is gone from the app.** A modal you must dismiss before you can
  look at anything trains you to tap OK without reading, which is the opposite of
  a safeguard. `window.rotulus.snackbar(text, onUndo, onCommit)` in
  `rotulus-shared.js` replaces it on all three deletes.
- **The delete is persisted immediately and undo persists the restore**, so memory
  and storage never disagree even if you navigate away mid-countdown. Undo also
  clears the tombstone.
- Only one snackbar at a time — opening a second commits the first, so rapid
  deletes cannot leave two pending undos racing.
- Every call site is **guarded** (`if (window.rotulus && window.rotulus.snackbar)`)
  because the test harnesses run page scripts without `rotulus-shared.js`.
- **Offline:** a page opts in with `<span class="offline-pill">` next to its sync
  note; the shared script toggles it on `online`/`offline` and re-runs whatever
  `window.rotulus.onReconnect(fn)` was given.
- Sync notes are `role="status" aria-live="polite"` — nothing announced "Sync
  failed" before. The Pomodoro countdown is `role="timer"` + `aria-live="polite"`;
  **polite, not assertive**, or a screen reader would interrupt itself every
  second.
- **Pinch-zoom stays disabled** (`maximum-scale=1, user-scalable=no`). This was
  raised as an accessibility problem and the user explicitly chose to keep it.
  Do not "fix" it.

## Weekly trends (`dashboard.html`) and diary search (`diary.html`)

Added 2026-09-02. Both read data the app already stores one key per day, so
neither needed new storage, new sync or a new function — and both are entirely
page-specific CSS/JS, so **neither needed a `?v=` bump.**

- **Trends are plain flexbox bars**, not a charting library: no build step, no
  dependencies, and eight bars do not justify either. Heights are a percentage of
  the tallest week in view, so the shape reads at any scale.
- **Weeks start Monday** (`mondayOf()` shifts `getDay()`, which is 0 on Sunday),
  and days in the future are never counted.
- **The week in progress is drawn differently and excluded from the average.**
  Comparing a part-week against finished ones would read as a collapse in effort
  every Monday morning. The summary line says "this week so far" against "usual
  week" for exactly that reason.
- Four metrics — focus minutes (`pomodoro_*`), habits ticked (`scrollswap_<date>`,
  counting `true` values), goal hours (`dailyHours` across goals) and diary
  entries. Each sets `--acc`/`--acc-soft` on the card so the bars recolour.
- **`initChartToggle()` had to be scoped to `#rangeToggleRow`.** The trend buttons
  reuse `.range-btn` for its styling, and the old unscoped
  `querySelectorAll('.range-btn')` would have wired both rows to both handlers.
- **Diary search filters `diaryEntries`**, which is already the whole diary in
  memory — nothing to fetch, no index to keep in step. Results replace the
  calendar while a query is active and restore it when the box is emptied.
- **The query is regex-escaped before it reaches `new RegExp`**, or typing a bare
  `(` throws mid-search. Snippets are a window around the first match rather than
  the opening words, so the hit is visible even in a long entry.
- **Opening a hit moves `viewYear`/`viewMonth` too.** The calendar tracks its own
  month independently of `selectedDate`, so without that it stays on the current
  month and the day you just opened is not on screen.
- In the wide layouts, `.search-results:not(:empty)` takes `grid-column: 1` — the
  calendar's slot. Without it the entry card sits in column 2 beside an empty
  column 1. A named class beats the zero-specificity `:where(#app) > *` default.
- A server pull can bring in entries this device has never seen, so the pull path
  re-runs `renderSearch()` rather than leaving stale hits on screen.

## Design system (added in the Rotulus redesign)

- **`css/rotulus.css`** — all shared tokens (colors, radii, shadows, motion,
  fonts) and shared components (nav, dropdowns, header, auth card, buttons,
  pills, card/background layer, animations, reduced-motion). Linked from
  every page as `<link rel="stylesheet" href="/css/rotulus.css?v=7">`.
  Page-specific CSS (timer digits, calendar grid, goal cards, etc.) stays
  inline in each page's own `<style>` block.
- **`js/rotulus-shared.js`** — theme apply/toggle, the gear dropdown, and the
  bottom tab bar + swipe navigation (see Navigation below). Loaded with
  `defer` on every page except `lock-in.html`. Exposes
  `window.rotulus.applyTheme(theme)` and `window.rotulus.getTheme()`.
  Don't re-duplicate this logic per-page.
- **Bump `?v=` on `rotulus.css`/`rotulus-shared.js` links whenever you edit
  them, in all seven pages that load them.** `netlify.toml` now serves
  `/css/*` and `/js/*` as `max-age=31536000, immutable`, so the `?v=` number
  is the *only* thing that gets anyone onto a new copy — miss the bump and
  they keep the old one for a year. They used to be `no-store`, which forbids
  the browser from keeping any copy at all: every tab switch re-downloaded
  both files before the page could paint, which the slide animation turned
  into a visible pause. `tests/cache-version-check.js` fails if either file
  changes without the bump, and records what shipped in
  `tests/asset-versions.json` — commit that file with the change. Re-record
  by hand with `node tests/cache-version-check.js --update` (only correct
  while the current version has not been deployed yet).
- **Theme:** `:root` = light tokens (default), `:root.theme-dark` = dark
  overrides. Saved as `localStorage['scrollswap_theme']` = `'light'` /
  `'dark'`, or absent for **Auto** (follows `prefers-color-scheme`). Every
  page has a 3-line pre-paint snippet in `<head>` to avoid a flash of the
  wrong theme before the stylesheet loads — copy that snippet exactly when
  adding a new page.
- **Legacy variable aliases** exist in `rotulus.css` (`--gold`, `--sage`,
  `--card-line`, `--cat-productivity`, etc. all alias to the new palette)
  so nothing needs a rewrite just to pick up color changes.
- **Palette:** indigo-violet primary (`--primary`), green (`--green`),
  danger/overdue red (`--danger`), and seven accent colors (`--acc-orange`,
  `--acc-sky`, `--acc-purple`, `--acc-green`, `--acc-pink`, `--acc-red`,
  `--acc-yellow`) each with a `-soft` pastel variant for icon tiles. Slot
  accents on the home tracker: wake=orange, morning=sky, afternoon=purple,
  evening=green, before-bed=pink.
- **Type:** `--font-display` (Baloo 2, headings/numbers), `--font-body`
  (Nunito, everything else). **Self-hosted since 2026-09-02** as two variable
  woff2 files in `assets/fonts/`, declared `@font-face` at the top of
  `rotulus.css` with `font-display: swap`. They used to come from a
  render-blocking `<link>` to `fonts.googleapis.com` in every page's `<head>` —
  precisely what the Navigation section says not to do, since that stretched the
  frozen gap on every tab switch with a DNS lookup and TLS handshake before
  anything could paint. One file per family covers every weight; the latin subset
  starts at `U+0000-00FF`, so Norwegian æ/ø/å are included. The app now also
  renders in its own fonts offline. `/assets/*` is immutable for a year, so
  **replacing a font file needs a new filename.** The `ui-rounded` fallback stays.
- **Motion:** transform/opacity-only transitions (`--t-fast`/`--t-med` +
  `--ease`), `:active { transform: scale(0.96) }` press feedback on all
  buttons, `@media (prefers-reduced-motion: reduce)` kills everything.
  Hot-path interactions (toggling a habit slot, checking a to-do task) use
  **optimistic UI** — flip the class immediately, run localStorage
  save/server sync after — so taps never feel laggy waiting on a re-render
  or network round trip.

## Navigation (bottom tab bar, swipe, deep links)

The old hamburger + 8-item dropdown is gone. Page switching is a fixed bottom
tab bar, and the gear button (top right) holds the things that aren't places
you spend time: **Lock In, Settings, account/logout**.

- **`TABS` in `js/rotulus-shared.js` is the single source of truth** — tab
  order, labels, icons, the swipe order, the prefetch targets and the active
  highlight all read that one array. Add or reorder a tab there and nothing
  else needs touching. The bar is injected into `<body>` on
  `DOMContentLoaded`; the gear menu stays hardcoded per page so Settings and
  Lock In survive a JS failure.
- Six tabs: Home, To-Do, Pomodoro, Goals, Diary, Dashboard. `settings.html`
  shows the bar with **nothing active** and is not in the swipe order.
  `lock-in.html` loads neither the shared CSS nor JS, so the focus screen
  stays bare by construction — keep it that way.
- **The swipe is a drag, not a flick-and-guess.** `#app` tracks the finger 1:1,
  resists at `0.3x` past the first and last tab, and on release either springs
  back or flings the rest of the way and navigates (commit at 30% of the
  viewport width, or a flick over 0.5 px/ms past 15%).
  **`touch-action: pan-y` on `#app` is load-bearing**: it hands vertical
  scrolling to the browser and horizontal movement to us, which is why no
  listener ever calls `preventDefault()` and all of them stay passive. The
  first ~10px locks the axis; once vertical, the gesture is the browser's for
  good. `html, body { overflow-x: hidden }` stops a page dragged off-screen
  growing a scrollbar.
- Still ignored at touchstart: the 24px screen-edge zone (the OS back-swipe),
  `input`/`textarea`/`select`/`[contenteditable]`/`[data-no-swipe]`, and a
  second finger. **Put `data-no-swipe` on any new horizontally-draggable
  control.**
- **Page-to-page animation is the browser's cross-document View Transitions**
  (`@view-transition { navigation: auto; }` in `rotulus.css`), not JS —
  nothing calls `startViewTransition()`. Below iOS 18.2 / Chrome 126 the app
  just navigates with no animation, which is a fine fallback.
  Direction comes from `data-vt-dir` on `<html>`, written **before first
  paint** by the pre-paint `<head>` snippet from a `sessionStorage`
  `rotulus_vt_dir` key that the swipe sets. Tapping a tab deliberately leaves
  it unset, which gives a cross-fade. Copy that whole two-statement head
  snippet exactly when adding a page.
- **The outgoing page must not be animated.** The drag already carried `#app`
  off-screen before the navigation, so the outgoing snapshot is nothing but the
  shared blob background: `::view-transition-old(root)` is set to
  `animation: none` and only the incoming page moves. Animating both is what
  made the two pages look like they were sliding over each other.
- `netlify.toml` serves HTML as `no-cache` (revalidate) rather than
  `no-store`, so a swipe gets a `304` instead of re-downloading the page, and
  the two neighbouring tabs can be `rel="prefetch"`ed. It still revalidates
  every load, so a page can never go stale. `/css/*` and `/js/*` are cached
  hard and busted by `?v=` — see the Design System section.
- **The frozen gap is the thing to protect.** During a cross-document view
  transition the browser holds the *outgoing* page as a still bitmap until
  the incoming document is ready to paint, which means every render-blocking
  resource in its `<head>` extends the pause — and nothing can animate during
  it, so a spinner there would sit motionless. Shortening the critical path
  is the only lever. Don't add render-blocking resources to `<head>`, and
  don't put `/css/*` or `/js/*` back on a header that forces a re-fetch.
- **Dashboard stat cards are links** into the page their number came from.
  Two carry a hash the target page acts on: `todo.html#archive` opens the
  completed-tasks archive through the real toggle button (so `archiveOpen`
  and the label stay in step), and `goals.html#completed` scrolls to the
  first completed goal and pulses it. Both fire **after the render that
  follows the login pull**, never on the first local render — on a synced
  device the pull replaces everything underneath. The "locked in for X
  minutes" pill asks before entering Lock In, since Lock In is full-screen
  and starts counting immediately.

## Wide layouts (phone landscape and desktop)

Phone portrait is the default and is what the rest of this file describes. Two
wide layouts sit on top of it, sharing one idea: **the bottom tab bar becomes a
left rail.** That reclaims the 58px the bar was eating and puts the wasted
horizontal space to work. Before this existed, 812×375 gave 317px of usable
height and three full screens of scrolling on the dashboard; it's now ~1.1.

- Breakpoints are **deliberately disjoint** so they can never both match:
  desktop is `(min-width: 900px)`, phone landscape is
  `(orientation: landscape) and (max-height: 560px) and (max-width: 899px)`.
  A tablet in portrait falls through to the phone layout on purpose.
- **The rail is the same `.tabbar` element, only restyled** — `buildTabBar()`
  already emits the markup it needs, so there is no JS branch for any of this.
  Desktop shows labels at 200px; phone landscape is icon-only at 64px, with the
  labels moved off-screen rather than `display: none` so the six links keep
  their accessible names.
- **`#app` becomes a two-column grid, and everything opts out by default**
  (`:where(#app) > * { grid-column: 1 / -1 }`). A page names the cards it wants
  side by side. Written as `#app > *` that default would carry ID specificity
  and **silently beat every per-page placement rule** — which it did, until the
  layouts were measured rather than eyeballed. `:where()` zeroes it.
- Where two panels must sit side by side, they are **adjacent siblings** with
  `grid-column: 1` and `2` — grid auto-placement then puts them on one row with
  no explicit row numbers to go stale. `.pomo-side`, `.dash-main` and
  `.dash-chart` are wrappers that exist purely to make that true; the
  alternative, spanning explicit rows, breaks the moment the auth card hides on
  login or the pie chart is toggled.
- Card lists that just want more columns get one shared rule in `rotulus.css`:
  `.slots`, `#categoriesList`, `#goalsList`. Note it is **`.slots`, not
  `#tracker`** — the slot cards are nested one level down.
- The compact landscape layout also floats `.nav-row` out of the flow and hides
  the eyebrow and subtitle. On a 375px-tall screen the chrome was spending
  153px before any content appeared.
- Pomodoro's timer ring needs no work here: `initTimerRing()` already watches
  `#timerCard` with a `ResizeObserver`, so it rebuilds across a breakpoint
  change or a device rotation on its own (verified, 1286 → 1592).

## Image assets (`assets/` folder)

The app must look complete with **zero image files present** — every
background/illustration reference has a CSS fallback or `onerror` handler.
See `assets/README.txt` and `assets/icons/README.txt` for the exact expected
filenames (backgrounds, header illustration, future per-slot icons). Only
`assets/app-icon.png` (512×512, the home-screen icon) currently exists.
`netlify.toml` caches `/assets/*` for 1 year — **if replacing an existing
image, give it a new filename** rather than overwriting, or the CDN cache
will keep serving the old one.

## First paint: every page renders from localStorage

Storage is local-first, and that has to include the *render*. Every data page
paints from `localStorage` in its `initApp()` on `DOMContentLoaded` — before
Netlify Identity initialises and before any server pull — then re-renders when
the pull lands. `todo.html` was the exception until 2026-08-19: it printed
"Loading your tasks…" and waited on `netlifyIdentity.init()` plus a
`pullFromServer()` round trip to show tasks that were already on the device.
Don't reintroduce that pattern on a new page.

- **`initApp()` must not be able to throw.** In `todo.html` the local render is
  wrapped in `try`/`catch`, because it now runs *before* `initIdentity()` in the
  same `DOMContentLoaded` handler. An exception on oddly-shaped stored data (a
  category with no `subcategories` array, say) would otherwise stop Identity
  initialising and cost the user login and sync entirely — not just the head
  start it was meant to gain.
- **Loading placeholders are deliberately rare** — `.skeleton-card` and
  `.is-syncing` in `rotulus.css`. Where a page already has local data a skeleton
  flashes for a single frame and reads as a flicker, so they are used in exactly
  two places: `todo.html` on a first-ever load, where there is genuinely nothing
  local yet and "No categories yet" would be a lie until the pull answers
  (`firstSyncPending`, with a 6s timeout so a widget that never fires `init`
  cannot strand the skeleton); and `dashboard.html` while it refreshes numbers
  it is already showing.
- Skeletons are built from `var(--card)` plus the real card border and shadow,
  **not** `var(--line)` as a fill. As a fill that token rendered `#E5E1F4` on the
  `#EDEBF7` light background — about 8/255 per channel, which is invisible.
- Both pulse animations **end on their resting state** (`opacity: 1`). The
  reduced-motion rule collapses every animation to `0.01ms` with one iteration,
  which snaps to the final keyframe, so they degrade to a calm solid block
  rather than freezing mid-pulse.
- Side effect worth knowing: `todo.html` no longer needs Identity to render, so
  it now works on `localhost`, where Netlify Identity can never initialise. Seed
  `scrollswap_todo_state` and it renders.

## Habit tracker (`index.html`) specifics

- **A checked slot glows in its own accent.** `.slot.checked` sets
  `border-color` and a two-layer `box-shadow` from `--slot-accent` — the same
  token `.slot-time` uses for its text, so the glow always matches the words above
  it. It mirrors the Pomodoro timer card, which gets its look from
  `filter: drop-shadow(0 0 4px var(--ring-color))` on the progress ring's 2.5px
  stroke. `box-shadow` and `border-color` had to be added to `.slot`'s transition,
  which only listed `transform` and `opacity`. Slot styles are inline in
  `index.html`, so this needed no `?v=` bump on its own.

- Slots start with **no real text** until the user writes their own via the
  "edit text" button. Until then each shows a greyed-out italic placeholder
  — a habit-stacking example ("After [daily anchor], do [replacement
  habit]") — stored in `DEFAULT_SLOTS[].placeholder`, not saved to
  localStorage.
- Tapping the placeholder text (when a slot is still unset) opens the edit
  screen focused on that slot. Once a slot has real text, tapping anywhere
  on the card (including the text) toggles the checkbox as normal; editing
  then only happens via the "edit text" button.
- Custom text lives in `localStorage['scrollswap__labels']`; blanking a
  slot's text in the editor deletes its entry, reverting it to placeholder.

## Security (audit, 2026-09-03)

The whole app was reviewed: every page's inline script, `rotulus-shared.js`,
`sw.js`, the six functions, `netlify.toml`, the backup/restore path, and the
live site's actual HTTP responses. Four things were wrong. All four are fixed;
the rules below are what stops them coming back.

**Escape everything that reaches markup — no exceptions.** Every page builds
HTML with template strings and `innerHTML`, so anything interpolated is markup
until it is escaped. Task names, subcategory names, goal names, the habit slot
labels and `user.email` were all going in raw. So were the `data-*` ids, which
matters just as much: those come back off the server, so a crafted `id` could
close its attribute and add a handler. `escapeHtml()` now lives in **all seven
pages** — deliberately per page, not in `rotulus-shared.js`, because the test
harnesses run page scripts without the shared file and a shared helper would
need guarding at every call site.

- Impact is higher than "a broken layout": the Identity widget keeps the GoTrue
  JWT in `localStorage`, so script on this origin is account takeover plus a
  readable diary.
- The realistic delivery route is **Settings → Restore**. Import checks key
  *names* against the three prefixes; it has never checked values.
- **`getArchiveItemsForDate()` builds its path with a plain `>`**, not a
  `&gt;` entity as it used to. The entity was baked in before the value was
  escaped, so escaping it now would render `&gt;` as visible text.
- `tests/escaping-test.js` guards it: each page's real script runs against
  hostile seed data and every `innerHTML` write is checked. It has teeth — the
  first version of it missed `renderTaskRow` entirely, because task rows only
  draw inside an *expanded* subcategory, and removing an escape on purpose
  proved the gap. That is why it stubs `.subcat-header` and fires its click.

**The CSP has no `'unsafe-inline'`, and that is the point.** `script-src` is
`'self'`, `identity.netlify.com`, and one SHA-256 hash per inline `<script>`.
An injected `onerror=""` cannot run even if an escape is ever missed.

- **Edit any inline script and the hash changes.** Ship without regenerating
  and the browser refuses the page's own script — a blank app for everyone
  until the next deploy. `node tests/csp-hash-check.js --update`, then commit
  `netlify.toml`. `tests/csp-hash-check.js` fails the build otherwise.
- **Every block gets two hashes, LF and CRLF.** A hash must match the bytes
  actually served, and the failure mode if it does not is a blank site rather
  than anything legible. In practice **LF is the one that matches** — the repo
  stores LF and Netlify serves the blob (see Working conventions; the belief
  that the repo was CRLF was wrong, and this dual hashing was originally added
  to hedge it). It is kept because it costs ~600 bytes of header, needs no
  thought from whoever edits a script next, and an unused hash permits nothing:
  a hash only ever allows the exact script it was computed from.
- **No inline `onerror=""` anywhere.** The seven `<img class="header-art">`
  handlers moved into `hideMissingArt()` in `rotulus-shared.js`; an inline
  handler would need `'unsafe-hashes'`, which hands an *injected* handler the
  same permission. That function checks `complete && naturalWidth === 0`
  first, because the script is deferred and a missing image may already have
  failed — `error` does not fire twice. `header-illustration.png` is genuinely
  absent, so this path runs on every page load.
- `style-src` keeps `'unsafe-inline'` on purpose: the Identity widget injects
  an inline `<style>` and the pages use `style=""` throughout. Style injection
  is a far smaller problem than script injection.
- Verified in a browser before shipping, because a wrong CSP blanks the site:
  all eight pages served with the real policy as a `<meta>`, zero violations,
  every script ran, and `netlifyIdentity` loaded and built its iframes.
  Measured, not assumed — the widget injects **no** inline script, one inline
  `<style>`, two `about:blank` iframes, and touches only two origins.
- Headers sit on `for = "/*"`, **not `"/*.html"`**: Netlify serves every page
  at `/goals` as well as `/goals.html`, and a `.html` rule misses the bare
  form. Same pretty-URL trap that has already cost a deploy here.
- `Strict-Transport-Security` is deliberately absent — Netlify already sends it.

**The repo root was the web root.** `publish = "."` meant `CLAUDE.md`,
`package.json`, `tests/` and `docs/` were all being served publicly (verified:
they returned 200 — this file was readable by anyone). Netlify has no
ignore-list for a publish directory, so `netlify.toml` now has forced 404
redirects for each. **Add one for any new non-site folder.**

**The six functions validate and no longer leak.** A POST body is read as text,
capped at 512 KB (413) and rejected unless it parses to a plain object (400) —
before that, any authenticated account could park megabytes in each store.
Data responses carry `Cache-Control: private, no-store`; Netlify's default
`no-cache` only means revalidate, and these bodies are somebody's whole diary.
The `catch` still returns `err.name` (the half that identifies a Blobs failure)
but no longer echoes `err.message`, which can carry internal detail — the
`console.error` puts the full thing in the function log instead.

**Accepted, not fixed: the Identity widget has no integrity check.** All eight
pages load `identity.netlify.com/v1/netlify-identity-widget.js` unpinned. An
SRI hash on a mutable `/v1/` path would break login the day Netlify updates it,
and you would only find out by failing to log in. Self-hosting a pinned copy
trades that for owning security updates to an auth widget by hand. Decided
2026-09-03 to leave it: Netlify's CDN already serves the whole site.

**Checked and clean, so don't re-audit these:** no committed secrets; `sw.js`
has no fetch handler so it cannot serve stale or hostile content; the 401 runs
before anything touches the store; bearer-token auth means the sync endpoints
are not CSRF-able; backup import correctly drops keys outside the three
prefixes; and there is no reachable prototype-pollution path — the merge code
`Object.assign`s onto fresh objects, which cannot reach `Object.prototype`.

**Two things only you can do, in the Netlify UI:** set Identity → Registration
to **Invite only** (open registration lets strangers create accounts on the
site and use its Blobs storage), and delete the now-unused `BLOBS_SITE_ID` /
`BLOBS_TOKEN` variables. Note also that the diary is stored unencrypted in
Blobs — inherent to the design, but anyone with your Netlify account can read it.

## Working conventions (established with this user)

- **Beginner-friendly explanations** — the user built this app from zero
  coding experience; avoid unexplained jargon.
- **Batch deploys** — the user commits everything in one batched commit
  (Netlify Personal plan charges 15 credits per deploy regardless of size),
  then checks the Netlify **Deploys** tab before testing (a failed deploy
  silently leaves the old version live).
- **This folder has no `.git`** — it was a plain download, not a clone. To
  push changes, clone `AverageGuyAlex/scroll-swap` fresh to a temp location,
  copy changed/new files over, commit, and push from there — don't `git init`
  in place (would lose history / diverge from the real repo).
- **Line endings: copy files straight in, convert nothing.** Both this folder and
  **every blob in the GitHub repo are LF**. Copy only the files actually edited,
  then check `git diff --stat` — a sane diff is tens or hundreds of lines, not
  thousands.
  **This entry used to say the opposite** ("the repo is mixed, HTML/CSS/JS are
  CRLF, convert them with `perl -pi -e 's/(?<!\r)\n\z/\r\n/'`") and that was
  wrong. What misled it: a fresh clone on Windows has `core.autocrlf=true`, so
  git rewrites LF to CRLF **on checkout**. Reading the working tree — with
  `file`, `grep -U $'\r'`, even `git cat-file` piped through `od` — therefore
  reports CRLF for files that are LF in the repo. The authoritative check is
  `git ls-files --eol` (`i/` is the blob, `w/` is the working tree), or compare
  `git cat-file -s HEAD:<file>` against the byte length of each form.
  It matters beyond a noisy diff: **Netlify serves the blob, so the served bytes
  are LF**, which is what a CSP script hash has to match. Running the old
  conversion on a machine with `autocrlf=false` would have flipped every line of
  every file. **Never run any such conversion over a binary** such as a `.wav`;
  it corrupts it. Verify a copied binary with `cmp -s` against the source.
- The user generates mockups/images themselves (AI-generated) and supplies
  them on request — when a design needs an asset, list exact filenames and
  dimensions and wait for them to drop the files in.
