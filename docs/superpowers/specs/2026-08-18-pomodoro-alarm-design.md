# Pomodoro completion alarm — design

**Date:** 2026-08-18
**Status:** approved, not yet implemented

## Context

The Pomodoro timer runs to zero and nothing happens. You only find out the
session ended by looking at the screen. If you put the phone down — which is
the entire point of a focus timer — you either overrun or keep checking, which
defeats the purpose.

The app already handles a session that ended while you were away:
`displayTimerFromLocal()` (`pomodoro.html:886`) detects it, shows 00:00, and
holds the minutes in `pendingCompletion` until login state is known. What is
missing is being *told* at the moment it happens.

**The hard constraint:** when a phone locks or you switch apps, the browser
suspends the page's JavaScript. `setInterval` stops firing on time, so the
existing `tick()` loop cannot notice zero. Anything built here has to deal with
that, not assume it away.

## Decisions made with the user

| Decision | Choice |
|---|---|
| Platform | **iPhone, added to Home Screen** (installed PWA) |
| Approach | **Alarm + keep-alive**, no push server |
| Lock-screen banner | **Yes** — via a service worker, but no push backend |
| Vibration | **Dropped.** iOS has never supported the Vibration API |

## What happens at zero

Three independent channels, so any one can fail without taking the others down:

1. **Sound** — a short chime, repeated up to 3 times over ~6s so it isn't
   missed from across a desk. Stops early on any interaction with the page or
   any timer control.
2. **Lock-screen banner** — "Focus session done · 25 minutes logged". Break
   endings say "Break over · back to it". Tapping it focuses the app.
3. **Visual** — the timer card flashes, reusing the existing
   `.flash-highlight` animation in `rotulus.css`.

Break endings fire all three with different wording. Breaks are still never
logged — that rule is untouched.

## Keeping the page alive

Pressing Start also starts a looping, near-inaudible audio track. Media
playback is what stops iOS suspending the page, so `tick()` keeps running with
the app backgrounded or the screen off.

- **Near-inaudible, not digital silence.** iOS optimises true silence away;
  the loop is very low amplitude noise instead.
- **Start is already a user gesture**, which is what iOS requires to begin
  audio playback. No extra prompt.
- **Lifecycle:** starts on Start, stops on completion, Pause, Reset, and on
  starting a break (the break restarts it). It must never be left running —
  a stuck loop is a permanent battery drain.

**This is an empirical trick, not a guaranteed API.** iOS can still suspend a
long-lived page, and Apple has tightened this before. When that happens the
alarm fires on reopen instead of at zero — which is exactly today's behaviour,
so the feature degrades to no worse than the status quo. That is the accepted
trade; the only bulletproof alternative is a push backend, rejected because
Netlify's scheduler has one-minute granularity and would deliver a timer
notification up to ~60s late.

## The service worker

On iOS the `new Notification()` constructor does not exist — banners only come
from `ServiceWorkerRegistration.showNotification()`. So a service worker is
required for the banner, but **only** for that.

**`sw.js` deliberately has no `fetch` handler.** No fetch handler means no
caching, which means it cannot serve stale content. This matters: this app has
already been bitten twice by stale assets, and a caching service worker is by
far the worst version of that bug — it would survive a redeploy and there'd be
no `?v=` bump to save us. The whole file is a `notificationclick` handler that
focuses an existing window, plus the install/activate boilerplate that claims
control immediately.

It registers from `js/rotulus-shared.js` so every page has it, but it is only
ever *used* by the pomodoro page.

**Removal path:** if this ever needs to come out, shipping a `sw.js` that calls
`self.registration.unregister()` is the only reliable way to clear it from
devices that already installed it. Deleting the file is not enough.

## Permission

Requested from a **button in Settings**, never sprung mid-session:

- iOS requires a user gesture for `Notification.requestPermission()`.
- Hitting Start is the wrong moment for a permission sheet — it interrupts
  precisely the action the app exists to make frictionless.
- Settings shows the current state: not asked / granted / blocked, with a note
  that a blocked permission can only be undone in iOS Settings.

Settings also gets an **alarm sound on/off toggle**. An alarm you cannot
silence is hostile, and the sound is useless in a library.

## Storage keys

Two new keys, both **`scrollswap_`-prefixed — this is not cosmetic**:

- `scrollswap_pomodoro_alarm` — `'on'` / `'off'`, default on
- `scrollswap_pomodoro_notify` — `'on'` / `'off'`, default off until permission
  is granted

`collectAllLocalHistory()` in `pomodoro.html` sweeps every `pomodoro_*` key and
treats the suffix as a date with no validation. A key named
`pomodoro_alarm` would be read as a day's session totals and corrupt both the
totals list and the pie chart. Same reason `scrollswap_pomodoro_break_minutes`
is named the way it is.

## Assets

Two generated WAV files in `assets/`:

- `alarm-chime.wav` — ~1.2s two-tone chime
- `alarm-keepalive.wav` — ~1s near-inaudible loop, low sample rate to keep it
  small

They go in `assets/` specifically because `netlify.toml` caches that path for a
year. Audio inlined into `/js/` would be re-downloaded on every page load of
every page, since that path is `no-store`. Per the existing convention, an
asset that needs replacing gets a **new filename** rather than an overwrite —
the CDN cache is immutable.

The app must still work with both files missing: a failed `Audio` load is
caught and the banner and flash still fire.

## Hook points

- **`completeTimer(ts)`** (`pomodoro.html:753`) — the live path. Fires all
  three channels. `wasBreak` already distinguishes the wording.
- **`displayTimerFromLocal()`** (`pomodoro.html:888`) — the "finished while you
  were away" path, where `pendingCompletion` is set. Chime and flash here, but
  **no banner**: a notification about something that finished an hour ago is
  noise, and it would arrive as you are already looking at the screen.

## Non-goals

- No push backend, no VAPID, no subscription storage, no scheduled function.
- No offline caching. The service worker handles exactly one event.
- No change to any sync or logging behaviour. Break minutes stay unlogged; the
  `pulled && hasLocalData()` upload guard is untouched.
- No Android-specific work. It will work there too, but iPhone is the target.

## Testing

- `node tests/syntax-check.js` and `node tests/sync-test.js` must both pass.
  `sync-test.js` runs each page's real script against a fake DOM whose globals
  are a fixed list — `Audio` and `Notification` are **not** in it, and
  `navigator` is `{ userAgent: 'test' }`, so `navigator.serviceWorker` is
  undefined. A bare `new Audio(...)` on any code path the test reaches throws
  `ReferenceError` and fails the suite. Reach for them as `window.Audio` /
  `typeof Notification !== 'undefined'` / `navigator.serviceWorker &&` —
  which is what real browsers need anyway, since none of the three is
  universally available.
- In the browser preview: fake a completion by setting a timer state whose
  anchor is in the past, then confirm chime, flash, and banner. Confirm the
  keep-alive audio stops on completion, Pause and Reset.
- **On the actual iPhone, installed to the Home Screen** — this is the only
  place the real questions get answered: does the banner appear on the lock
  screen, and does the page survive backgrounding long enough to fire at zero.
  Neither can be verified from a desktop browser.
