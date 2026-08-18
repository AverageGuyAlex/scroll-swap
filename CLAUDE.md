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
fake DOM and asserts how many uploads each scenario produces. Run it with
`node tests/sync-test.js` (needs nothing installed). `tests/syntax-check.js`
parses every inline `<script>` — worth running after any hand edit to the HTML.

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
- **The keep-alive is why the alarm lands on time.** `assets/alarm-keepalive.wav`
  is a looping, near-inaudible track — not digital silence, which iOS optimises
  away. Media playback is what stops iOS suspending a backgrounded page, so
  `tick()` keeps running with the screen off. It hangs off
  `startDisplayTicker()`/`stopDisplayTicker()` rather than the individual
  buttons, because those two already mean "a timer is counting" and cover all
  seven call sites without being able to drift.
  **This is an empirical trick, not a guaranteed API.** If iOS suspends the
  page anyway, the alarm fires on reopen — the pre-feature behaviour, so the
  worst case is no regression.
- **A keep-alive left playing is a permanent battery drain.** `tests/alarm-test.js`
  guards the stop path by firing the Reset and Pause handlers directly. It
  cannot be checked in a browser: `new Audio()` returns a **detached** element,
  so `document.querySelectorAll('audio')` never finds it.
- **`sw.js` exists only because iOS has no `Notification` constructor** — a
  banner must come from `ServiceWorkerRegistration.showNotification()`. There
  is no push and **no `fetch` handler**, so it cannot cache and cannot serve
  stale content. Never add one: a caching service worker survives a redeploy
  and no `?v=` bump would rescue it. Removing it from devices that already have
  it requires shipping a version that calls `self.registration.unregister()` —
  deleting the file is not enough.
- **The alarm setting key is `scrollswap_pomodoro_alarm`** (`'on'`/`'off'`,
  default on). The prefix is mandatory — see the key-prefix trap above.
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
  them** — `netlify.toml` sets `no-cache` on `/css/*` and `/js/*` (this app
  was bitten before by stale-CSS bugs from aggressive browser caching).
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
  every load, so a page can never go stale. `/css/*` and `/js/*` stay
  `no-store` — bump `?v=` there instead.
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
- **Line-ending trap when committing:** the GitHub repo stores files with
  **CRLF**, this folder is **LF**. Copying edited files straight into a fresh
  clone marks every line of every file as changed and makes the diff
  unreviewable. Copy only the files actually edited, then convert them with
  `perl -pi -e 's/(?<!\r)\n\z/\r\n/' <file>`. Check `git diff --stat` before
  committing — a sane diff is tens of lines, not thousands.
- The user generates mockups/images themselves (AI-generated) and supplies
  them on request — when a design needs an asset, list exact filenames and
  dimensions and wait for them to drop the files in.
