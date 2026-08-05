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

## Design system (added in the Rotulus redesign)

- **`css/rotulus.css`** — all shared tokens (colors, radii, shadows, motion,
  fonts) and shared components (nav, dropdowns, header, auth card, buttons,
  pills, card/background layer, animations, reduced-motion). Linked from
  every page as `<link rel="stylesheet" href="/css/rotulus.css?v=1">`.
  Page-specific CSS (timer digits, calendar grid, goal cards, etc.) stays
  inline in each page's own `<style>` block.
- **`js/rotulus-shared.js`** — theme apply/toggle and nav/gear dropdown
  logic, loaded with `defer` on every page. Exposes `window.rotulus.applyTheme(theme)`
  and `window.rotulus.getTheme()`. Don't re-duplicate this logic per-page.
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
- The user generates mockups/images themselves (AI-generated) and supplies
  them on request — when a design needs an asset, list exact filenames and
  dimensions and wait for them to drop the files in.
