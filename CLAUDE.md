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
inline `<script>`, and `tests/functions-test.js` covers the serverless half (see
the next section). Nothing needs installing for any of them:

```bash
node tests/functions-test.js && node tests/sync-test.js && node tests/cache-version-check.js && node tests/syntax-check.js && node tests/alarm-test.js
```

## The sync functions (`netlify/functions/`)

All six (`todos`, `goals`, `habits`, `pomodoro`, `diary`, `lockin`) are the same
file with two things swapped: the Blobs store name and the empty-state default a
`GET` returns. Change one and you almost certainly need to change all six —
`tests/functions-test.js` runs every one of them, so it will tell you.

- **They are legacy V1 functions** (`exports.handler = async (event, context)`,
  reading `context.clientContext.user`). That matters: V2 functions get Netlify
  Blobs configured automatically, **V1 ones do not**. So `BLOBS_SITE_ID` and
  `BLOBS_TOKEN` (set in the Netlify UI, not in `netlify.toml`) are required, not
  optional.
- **`BLOBS_TOKEN` is a personal access token, and those expire or get revoked.**
  When that happens all six functions fail at once, on every device, with no code
  change on your side — the app shows "Sync failed" everywhere and nothing in the
  repo explains why. That is the first thing to check when sync breaks.
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

## Design system (added in the Rotulus redesign)

- **`css/rotulus.css`** — all shared tokens (colors, radii, shadows, motion,
  fonts) and shared components (nav, dropdowns, header, auth card, buttons,
  pills, card/background layer, animations, reduced-motion). Linked from
  every page as `<link rel="stylesheet" href="/css/rotulus.css?v=2">`.
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
  (Nunito, everything else), loaded via Google Fonts with `display=swap`
  and a `ui-rounded` fallback for offline iOS PWA use.
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
- **Line-ending trap when committing:** this folder is **LF** throughout, but the
  GitHub repo is **mixed** — `netlify.toml` and `package.json` are **LF** there,
  every HTML/CSS/JS/test/Markdown file is **CRLF**. Copying edited files straight
  into a fresh clone marks every line of every file as changed and makes the diff
  unreviewable. Copy only the files actually edited, then convert **only the CRLF
  ones** with `perl -pi -e 's/(?<!\r)\n\z/\r\n/' <file>` — running that over
  `netlify.toml` or `package.json` rewrites them whole for no reason. Check
  `git diff --stat` before committing — a sane diff is tens of lines, not
  thousands. **Never run the conversion over a binary file** such as a `.wav`; it
  corrupts it. Verify a copied binary with `cmp -s` against the source.
- The user generates mockups/images themselves (AI-generated) and supplies
  them on request — when a design needs an asset, list exact filenames and
  dimensions and wait for them to drop the files in.
