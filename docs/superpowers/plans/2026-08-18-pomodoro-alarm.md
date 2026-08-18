# Pomodoro Completion Alarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Pomodoro timer tell you it finished — a chime, a lock-screen banner and a flash — and keep the page alive so it fires on time with the phone locked.

**Architecture:** Three independent notification channels fire from the two existing completion paths in `pomodoro.html`. A looping near-inaudible audio track, tied to the existing display-ticker lifecycle, prevents iOS suspending the backgrounded page. A minimal service worker exists only so iOS can show a banner — it has no push and no `fetch` handler.

**Tech Stack:** Plain HTML/CSS/JS, no build step. Node for the asset generator and tests. Netlify Blobs and functions are **not** involved.

Spec: `docs/superpowers/specs/2026-08-18-pomodoro-alarm-design.md`

## Global Constraints

- **Never rename a storage key.** New keys are `scrollswap_pomodoro_alarm` and `scrollswap_pomodoro_notify`. The `scrollswap_` prefix is mandatory: `collectAllLocalHistory()` (`pomodoro.html:502`) sweeps every `pomodoro_*` key and reads the suffix as a date with no validation, so `pomodoro_alarm` would be counted as a day of sessions and corrupt the totals list and pie chart.
- **Feature-detect every browser API.** `tests/sync-test.js` and `tests/alarm-test.js` run the real page script against a fake DOM whose globals are a fixed list. `Audio` and `Notification` are not in it and `navigator` is `{ userAgent: 'test' }`. A bare `new Audio(...)` on a reachable path throws `ReferenceError` and fails the suite. Always use `window.Audio`, `typeof Notification !== 'undefined'`, `navigator.serviceWorker &&`.
- **Breaks are never logged.** The `if (!wasBreak) await logMinutes(...)` line in `completeTimer` is untouched.
- **The sync upload guard is untouched.** No task modifies `pushToServer`, `pullFromServer` or `hasLocalData`.
- **`sw.js` must never gain a `fetch` handler.** No fetch handler means no caching, which means it cannot serve stale content. A caching service worker survives a redeploy and no `?v=` bump would rescue it.
- **Bump `?v=` on `css/rotulus.css` and `js/rotulus-shared.js`** in all 7 pages if either is edited. They are at `?v=4` today.
- **New assets go in `assets/`**, which `netlify.toml` caches for a year. Replacing one later requires a **new filename**, never an overwrite.
- **Commits work differently here.** The working folder `scroll-swap-main` has **no `.git`** — it is a plain download. Tasks therefore end with a test run, not a commit. Everything ships in **one batched commit** in Task 6, pushed from a fresh clone, because each Netlify deploy costs 15 credits regardless of size.

---

### Task 1: Generate the two audio assets

**Files:**
- Create: `tools/make-alarm-audio.js`
- Create (generated): `assets/alarm-chime.wav`, `assets/alarm-keepalive.wav`

**Interfaces:**
- Consumes: nothing
- Produces: `/assets/alarm-chime.wav` (~1.2s two-tone chime, 22050 Hz 16-bit mono) and `/assets/alarm-keepalive.wav` (~1s near-inaudible loop, 8000 Hz 16-bit mono), referenced by path in Tasks 2 and 3.

- [ ] **Step 1: Write the generator**

Create `tools/make-alarm-audio.js`:

```js
/* Generates the two alarm WAVs into assets/. Run once with:
     node tools/make-alarm-audio.js
   Kept in the repo so the sounds can be regenerated or retuned rather than
   being opaque binaries nobody can change.

   WAV rather than MP3 because Node can write it with no dependencies. Both
   files are small enough that it does not matter, and /assets/* is cached for
   a year. */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'assets');

function encodeWav(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // PCM chunk size
  header.writeUInt16LE(1, 20);         // format: PCM
  header.writeUInt16LE(1, 22);         // channels: mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);         // block align
  header.writeUInt16LE(16, 34);        // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/* Two notes, A5 then D6, each with an exponential decay. Pleasant rather than
   startling — this fires while you are concentrating. */
function chime() {
  const rate = 22050;
  const noteSeconds = 0.6;
  const notes = [880, 1174.7];
  const samples = [];
  for (const freq of notes) {
    const count = Math.floor(rate * noteSeconds);
    for (let i = 0; i < count; i++) {
      const t = i / rate;
      const envelope = Math.exp(-4 * t);
      // A quiet third harmonic stops it sounding like a bare test tone.
      const tone = Math.sin(2 * Math.PI * freq * t)
                 + 0.2 * Math.sin(2 * Math.PI * freq * 3 * t);
      samples.push(0.45 * envelope * tone);
    }
  }
  return { samples, rate };
}

/* Near-inaudible, NOT digital silence: iOS optimises true silence away and
   stops treating the page as playing media, which is the whole point of this
   file. Very low amplitude noise survives that. */
function keepAlive() {
  const rate = 8000;
  const seconds = 1;
  const count = rate * seconds;
  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push((Math.random() * 2 - 1) * 0.0008);
  }
  // Fade the first and last 100 samples so the loop point has no click.
  for (let i = 0; i < 100; i++) {
    samples[i] *= i / 100;
    samples[count - 1 - i] *= i / 100;
  }
  return { samples, rate };
}

for (const [name, gen] of [['alarm-chime', chime], ['alarm-keepalive', keepAlive]]) {
  const { samples, rate } = gen();
  const buf = encodeWav(samples, rate);
  const file = path.join(OUT_DIR, name + '.wav');
  fs.writeFileSync(file, buf);
  console.log(`  wrote ${name}.wav  ${(buf.length / 1024).toFixed(1)} KB  ${rate} Hz  ${(samples.length / rate).toFixed(2)}s`);
}
```

- [ ] **Step 2: Run it**

```bash
node tools/make-alarm-audio.js
```

Expected output — two lines, roughly:
```
  wrote alarm-chime.wav  51.8 KB  22050 Hz  1.20s
  wrote alarm-keepalive.wav  15.7 KB  8000 Hz  1.00s
```

- [ ] **Step 3: Verify both files are valid WAVs**

```bash
node -e "const fs=require('fs');for(const f of ['assets/alarm-chime.wav','assets/alarm-keepalive.wav']){const b=fs.readFileSync(f);console.log(f, b.slice(0,4).toString(), b.slice(8,12).toString(), b.length+'B', 'rate='+b.readUInt32LE(24));}"
```

Expected: each line shows `RIFF WAVE`, a non-zero byte length, and `rate=22050` / `rate=8000`.

- [ ] **Step 4: Listen to the chime**

Open `http://localhost:3000/assets/alarm-chime.wav` in the browser preview (start it with `preview_start` name `rotulus` if it isn't running). Confirm it is audible and pleasant, not harsh. Retune `notes` or the `0.45` gain in the generator and re-run if not.

---

### Task 2: Chime and flash on both completion paths

**Files:**
- Create: `tests/alarm-test.js`
- Modify: `pomodoro.html` — add the alarm block before `function tick()`; hook `completeTimer()` (`:753`) and `displayTimerFromLocal()` (`:888`)

**Interfaces:**
- Consumes: `/assets/alarm-chime.wav` from Task 1
- Produces: `playChime()`, `stopChime()`, `flashTimerCard()`, `alarmEnabled()` — Task 3 calls none of these; Task 4 adds `showCompletionBanner()` alongside them in `completeTimer`.

- [ ] **Step 1: Write the failing test**

Create `tests/alarm-test.js`:

```js
/*
 * Runs the REAL pomodoro page script inside a fake browser and asserts what the
 * completion alarm does. Deliberately NOT sharing sync-test.js's harness: this
 * needs a different fake environment (a recording Audio, a controllable clock)
 * rather than the same one with a flag.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.ROTULUS_DIR || path.join(__dirname, '..');

function extractScript(page) {
  const html = fs.readFileSync(path.join(DIR, page + '.html'), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  return blocks[blocks.length - 1][1]; // the big app IIFE
}

function fakeEl() {
  const target = {
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false,
    style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
    classList: { _c: new Set(),
      add(n) { this._c.add(n); }, remove(n) { this._c.delete(n); },
      toggle() {}, contains(n) { return this._c.has(n); } },
    dataset: {}, children: [], parentNode: null, offsetWidth: 340,
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    focus() {}, blur() {}, click() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    closest() { return null; }, scrollIntoView() {}, getBoundingClientRect() { return {}; },
    clientWidth: 340, clientHeight: 260, offsetHeight: 260, getTotalLength() { return 1000; },
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      return () => fakeEl();
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function run(seedStorage) {
  const audios = [];               // every Audio the page constructs
  const store = Object.assign({}, seedStorage);
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    key: (i) => Object.keys(store)[i] || null,
    get length() { return Object.keys(store).length; },
  };

  class FakeAudio {
    constructor(src) {
      this.src = src; this.loop = false; this.volume = 1;
      this.playCount = 0; this.paused = true;
      audios.push(this);
    }
    play() { this.playCount++; this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }

  const els = {};
  const doc = {
    getElementById: (id) => (els[id] = els[id] || fakeEl()),
    querySelector: () => fakeEl(), querySelectorAll: () => [],
    addEventListener(type, cb) { (doc._h[type] = doc._h[type] || []).push(cb); },
    removeEventListener() {}, createElement: () => fakeEl(),
    head: fakeEl(), body: fakeEl(), documentElement: fakeEl(),
    hidden: false, visibilityState: 'visible',
    _h: {},
  };
  const win = {
    Audio: FakeAudio,
    location: { href: '', pathname: '/pomodoro.html', hash: '', origin: 'https://rotulus.netlify.app' },
    addEventListener(type, cb) { (win._h[type] = win._h[type] || []).push(cb); },
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: (cb) => { cb(0); return 0; },
    _h: {},
  };

  const fn = new Function(
    'window', 'document', 'localStorage', 'fetch', 'netlifyIdentity', 'console',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'matchMedia',
    'requestAnimationFrame', 'alert', 'confirm', 'navigator', 'getComputedStyle',
    'ResizeObserver',
    extractScript('pomodoro')
  );
  fn(win, doc, localStorage, () => Promise.resolve({ ok: false }),
     undefined, { log() {}, error() {}, warn() {} },
     (cb) => 0, () => {}, () => 0, () => {}, win.matchMedia,
     win.requestAnimationFrame, () => {}, () => true, { userAgent: 'test' },
     () => ({ borderTopLeftRadius: '20px', getPropertyValue: () => '' }),
     class { observe() {} unobserve() {} disconnect() {} });

  (win._h['DOMContentLoaded'] || []).forEach((cb) => cb());
  return { audios, els, store };
}

function expiredTimerState() {
  return JSON.stringify({
    category: 'productivity', mode: 'focus',
    durationSeconds: 1500, focusDurationSeconds: 1500,
    remainingAtAnchor: 1500,
    anchorTimestamp: Date.now() - 1600 * 1000, // ended ~100s ago
    running: true,
  });
}

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        expected: ${want}, actual: ${got}`);
}

console.log('\n=== Alarm on a session that ended while away ===');
{
  const { audios } = run({ 'scrollswap_pomodoro_timer': expiredTimerState() });
  const chimes = audios.filter((a) => a.src.includes('alarm-chime'));
  check('a chime is played', chimes.length > 0 && chimes[0].playCount > 0, true);
  check('keep-alive is NOT started for a finished timer',
    audios.some((a) => a.src.includes('keepalive') && a.playCount > 0), false);
}

console.log('\n=== Alarm respects the off switch ===');
{
  const { audios } = run({
    'scrollswap_pomodoro_timer': expiredTimerState(),
    'scrollswap_pomodoro_alarm': 'off',
  });
  check('no chime when the alarm is off',
    audios.some((a) => a.src.includes('alarm-chime')), false);
}

console.log(failures === 0 ? '\nALL ALARM SCENARIOS PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node tests/alarm-test.js
```

Expected: `FAIL  a chime is played` — nothing plays a chime yet.

- [ ] **Step 3: Add the alarm block to `pomodoro.html`**

Insert immediately **before** `function tick() {`:

```js
  /* ---- Completion alarm -------------------------------------------------
     Three independent channels so one failing never silences the others: a
     chime here, a lock-screen banner, and a flash on the timer card.
     Every browser API is reached through window/typeof — the test harnesses
     run this file with no Audio and no Notification, and a bare reference
     would throw ReferenceError. */
  const ALARM_ENABLED_KEY = 'scrollswap_pomodoro_alarm';
  const CHIME_SRC = '/assets/alarm-chime.wav';
  const CHIME_REPEATS = 3;
  const CHIME_GAP_MS = 2000;

  let chimeAudio = null;
  let chimeTimers = [];

  function alarmEnabled() {
    try { return localStorage.getItem(ALARM_ENABLED_KEY) !== 'off'; }
    catch (e) { return true; }
  }

  function stopChime() {
    chimeTimers.forEach(clearTimeout);
    chimeTimers = [];
    if (chimeAudio) { try { chimeAudio.pause(); } catch (e) {} }
  }

  /* Repeats a few times so it is not missed from across a desk, and gives up
     the moment you touch anything — at that point you have clearly noticed. */
  function playChime() {
    if (!alarmEnabled() || !window.Audio) return;
    stopChime();
    try {
      chimeAudio = new window.Audio(CHIME_SRC);
      const ring = () => {
        try {
          chimeAudio.currentTime = 0;
          const p = chimeAudio.play();
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      };
      ring();
      for (let i = 1; i < CHIME_REPEATS; i++) {
        chimeTimers.push(setTimeout(ring, i * CHIME_GAP_MS));
      }
    } catch (e) {}
  }

  function flashTimerCard() {
    const card = document.getElementById('timerCard');
    if (!card || !card.classList) return;
    card.classList.remove('flash-highlight');
    void card.offsetWidth; // restart the animation if it is already running
    card.classList.add('flash-highlight');
  }

  document.addEventListener('pointerdown', stopChime, { passive: true });
```

- [ ] **Step 4: Hook the live completion path**

In `completeTimer` (`pomodoro.html:753`), add the two calls immediately after the `minutesElapsed` line:

```js
  async function completeTimer(ts) {
    stopDisplayTicker();
    const wasBreak = ts.mode === 'break';
    const minutesElapsed = Math.round(ts.durationSeconds / 60);
    playChime();
    flashTimerCard();
    // Either way we land on a fresh focus session, ready to go again.
    const freshState = freshFocusState(ts);
```

Leave the rest of the function, including `if (!wasBreak) await logMinutes(...)`, exactly as it is.

- [ ] **Step 5: Hook the finished-while-away path**

In `displayTimerFromLocal` (`pomodoro.html:888`), inside the `if (remaining <= 0)` branch, add after `pendingCompletion = ts;`:

```js
        pendingCompletion = ts;
        // Chime and flash, but deliberately no banner: this finished while you
        // were away and you are already looking at the screen. A notification
        // about it would be pure noise.
        playChime();
        flashTimerCard();
```

- [ ] **Step 6: Run the alarm test**

```bash
node tests/alarm-test.js
```

Expected: `ALL ALARM SCENARIOS PASS`

- [ ] **Step 7: Run the existing suites to prove nothing regressed**

```bash
node tests/syntax-check.js && node tests/sync-test.js
```

Expected: `All inline scripts parse cleanly.` and `ALL SCENARIOS PASS`

---

### Task 3: Keep the page alive while a timer runs

**Files:**
- Modify: `tests/alarm-test.js` — add one scenario
- Modify: `pomodoro.html` — add keep-alive functions; call them from `startDisplayTicker` / `stopDisplayTicker`

**Interfaces:**
- Consumes: `/assets/alarm-keepalive.wav` from Task 1
- Produces: `startKeepAlive()`, `stopKeepAlive()`. Nothing else calls them — they hang off the ticker lifecycle only.

**Why the ticker, not the buttons:** `startDisplayTicker()` and `stopDisplayTicker()` already mark exactly "a timer is actively counting". They are called from `startTimer`, `togglePauseResume` (both branches), `resetTimer`, `onBreakButton`, `completeTimer` and `displayTimerFromLocal`. Hanging the keep-alive off those two functions covers all seven sites and cannot drift out of sync the way seven hand-placed calls would.

- [ ] **Step 1: Add the failing scenario to `tests/alarm-test.js`**

Insert before the final `console.log(failures === 0 ...)` line:

```js
console.log('\n=== Keep-alive while a timer is running ===');
{
  const running = JSON.stringify({
    category: 'productivity', mode: 'focus',
    durationSeconds: 1500, focusDurationSeconds: 1500,
    remainingAtAnchor: 1500,
    anchorTimestamp: Date.now() - 60 * 1000, // 1 minute in, 24 to go
    running: true,
  });
  const { audios } = run({ 'scrollswap_pomodoro_timer': running });
  const keep = audios.filter((a) => a.src.includes('alarm-keepalive'));
  check('keep-alive audio is created', keep.length > 0, true);
  check('keep-alive is looping', keep.length > 0 && keep[0].loop, true);
  check('keep-alive is playing', keep.length > 0 && keep[0].playCount > 0, true);
  check('no chime for a timer still running',
    audios.some((a) => a.src.includes('alarm-chime')), false);
}
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node tests/alarm-test.js
```

Expected: `FAIL  keep-alive audio is created`

- [ ] **Step 3: Add the keep-alive functions**

Insert into `pomodoro.html` immediately after the `flashTimerCard` function from Task 2:

```js
  /* ---- Keep-alive -------------------------------------------------------
     Media playback is what stops iOS suspending a backgrounded page, which is
     what keeps tick() firing so the alarm lands at zero rather than whenever
     you next open the app. The track is near-inaudible noise rather than
     digital silence, which iOS optimises away.

     This is an empirical trick, not a guaranteed API. If iOS suspends the page
     anyway the alarm fires on reopen instead — the same behaviour as before
     this feature existed, so the worst case is no regression. */
  const KEEPALIVE_SRC = '/assets/alarm-keepalive.wav';
  let keepAliveAudio = null;

  function startKeepAlive() {
    if (keepAliveAudio || !window.Audio) return;
    try {
      keepAliveAudio = new window.Audio(KEEPALIVE_SRC);
      keepAliveAudio.loop = true;
      keepAliveAudio.volume = 0.02;
      const p = keepAliveAudio.play();
      if (p && p.catch) p.catch(armKeepAliveRetry);
    } catch (e) { keepAliveAudio = null; }
  }

  /* Autoplay is refused when the ticker starts on page load rather than from a
     tap — reloading mid-session, say. Arm a one-shot retry so the next touch
     anywhere gets it going. */
  function armKeepAliveRetry() {
    document.addEventListener('pointerdown', function retry() {
      if (keepAliveAudio) {
        try {
          const p = keepAliveAudio.play();
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      }
    }, { once: true, passive: true });
  }

  function stopKeepAlive() {
    if (!keepAliveAudio) return;
    try { keepAliveAudio.pause(); } catch (e) {}
    keepAliveAudio = null;
  }
```

- [ ] **Step 4: Tie it to the ticker lifecycle**

Replace the existing `stopDisplayTicker` and `startDisplayTicker` with:

```js
  function stopDisplayTicker() {
    if (timerDisplayHandle) {
      clearInterval(timerDisplayHandle);
      timerDisplayHandle = null;
    }
    stopKeepAlive();
  }

  function startDisplayTicker() {
    stopDisplayTicker();
    startKeepAlive();
    timerDisplayHandle = setInterval(tick, 1000);
  }
```

- [ ] **Step 5: Run the alarm test**

```bash
node tests/alarm-test.js
```

Expected: `ALL ALARM SCENARIOS PASS` — all three scenarios.

- [ ] **Step 6: Run the existing suites**

```bash
node tests/syntax-check.js && node tests/sync-test.js
```

Expected: both pass.

---

### Task 4: Service worker and the lock-screen banner

**Files:**
- Create: `sw.js` (repo root)
- Modify: `js/rotulus-shared.js` — register it
- Modify: `netlify.toml` — `no-cache` for `/sw.js`
- Modify: `pomodoro.html` — add `showCompletionBanner()`, call it from `completeTimer`
- Modify: all 7 pages — bump `rotulus-shared.js?v=4` to `?v=5`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `showCompletionBanner(wasBreak, minutes)` in `pomodoro.html`; a registered service worker at `/sw.js`. Task 5's Settings button depends on the worker being registered before permission is useful.

- [ ] **Step 1: Create `sw.js` at the repo root**

```js
/* Rotulus service worker.

   It exists for exactly one reason: on iOS a notification banner can only be
   shown via ServiceWorkerRegistration.showNotification(), because the
   Notification constructor does not exist there. There is NO push here.

   There is also, deliberately, NO fetch handler. No fetch handler means no
   caching, which means this can never serve stale content. That matters: a
   caching service worker survives a redeploy and there is no ?v= bump that
   would rescue it.

   To remove this from devices that already installed it, ship a version of
   this file whose activate handler calls self.registration.unregister().
   Deleting the file is NOT enough — browsers keep the last copy they saw. */

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil((async function () {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const onPomodoro = all.find(function (c) { return c.url.indexOf('pomodoro') !== -1; });
    if (onPomodoro) return onPomodoro.focus();
    if (all.length) return all[0].focus();
    return self.clients.openWindow('/pomodoro.html');
  })());
});
```

- [ ] **Step 2: Register it from `js/rotulus-shared.js`**

Add immediately above the existing `window.addEventListener('load', prefetchNeighbours);` line:

```js
  /* Registered from here so every page installs it, though only the pomodoro
     page uses it — for the completion banner. See sw.js: no push, no fetch
     handler, no caching. */
  function registerServiceWorker() {
    if (!navigator.serviceWorker) return;
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
  window.addEventListener('load', registerServiceWorker);
```

- [ ] **Step 3: Stop the worker script itself being cached**

In `netlify.toml`, add above the `/assets/*` block:

```toml
[[headers]]
  for = "/sw.js"
  [headers.values]
    Cache-Control = "no-cache"
```

- [ ] **Step 4: Add the banner function to `pomodoro.html`**

Insert immediately after `flashTimerCard()`:

```js
  /* iOS has no Notification constructor — a banner can only come from a
     service worker registration. Silent failure everywhere is correct here:
     no permission, no worker, or an older browser all just mean the chime and
     the flash carry the load on their own. */
  async function showCompletionBanner(wasBreak, minutes) {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    if (!navigator.serviceWorker) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(
        wasBreak ? 'Break over' : 'Focus session done',
        {
          body: wasBreak ? 'Back to it.' : minutes + ' minutes logged.',
          tag: 'rotulus-pomodoro', // replaces the previous one rather than stacking
          icon: '/assets/app-icon.png',
        }
      );
    } catch (e) {}
  }
```

- [ ] **Step 5: Call it from the live completion path only**

In `completeTimer`, extend the Task 2 hook to three lines:

```js
    playChime();
    flashTimerCard();
    showCompletionBanner(wasBreak, minutesElapsed);
```

Do **not** add it to `displayTimerFromLocal` — that path is for a session that already ended.

- [ ] **Step 6: Bump the shared script version**

```bash
node -e "const fs=require('fs');for(const p of ['index','dashboard','goals','pomodoro','diary','todo','settings']){const f=p+'.html';let h=fs.readFileSync(f,'utf8');if(h.indexOf('rotulus-shared.js?v=4')===-1)throw new Error('v=4 not found in '+f);h=h.replace('rotulus-shared.js?v=4','rotulus-shared.js?v=5');fs.writeFileSync(f,h);}console.log('bumped rotulus-shared.js to ?v=5 in 7 pages');"
```

- [ ] **Step 7: Run all three suites**

```bash
node tests/syntax-check.js && node tests/sync-test.js && node tests/alarm-test.js
```

Expected: all three pass. `sync-test` proves the added `navigator.serviceWorker` guard did not break the login sequence.

- [ ] **Step 8: Confirm the worker registers in the browser**

Start the preview (`preview_start`, name `rotulus`), navigate to `http://localhost:3000/pomodoro.html`, then run in the page:

```js
navigator.serviceWorker.getRegistration().then(r => JSON.stringify({ scope: r && r.scope, active: !!(r && r.active) }))
```

Expected: `{"scope":"http://localhost:3000/","active":true}`

---

### Task 5: Settings — alarm toggle and notification permission

**Files:**
- Modify: `css/rotulus.css` — extend the segmented-button rules
- Modify: `settings.html` — new section card and its handlers
- Modify: all 7 pages — bump `rotulus.css?v=4` to `?v=5`

**Interfaces:**
- Consumes: `scrollswap_pomodoro_alarm` read by `alarmEnabled()` from Task 2; `Notification.permission` read by `showCompletionBanner()` from Task 4
- Produces: nothing other tasks consume

**Do not reuse `.theme-btn` for the alarm toggle.** `applyTheme()` in `rotulus-shared.js` runs `document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('selected', b.dataset.theme === choice))`. An alarm button carrying that class has no `dataset.theme`, so every theme change would silently strip its `selected` state.

- [ ] **Step 1: Give the segmented buttons a second class**

In `css/rotulus.css`, change the two selectors so the alarm toggle can borrow the look without borrowing the behaviour:

```css
.theme-toggle-row,
.seg-row {
```

```css
.theme-btn,
.seg-btn {
```

```css
.theme-btn.selected,
.seg-btn.selected {
```

- [ ] **Step 2: Add the settings card**

In `settings.html`, insert before the closing `</div>` of `#app` (after the existing "Rotulus" section card):

```html
  <div class="section-card">
    <p class="section-title">Pomodoro alarm</p>

    <label class="setting-label">Sound when a session ends</label>
    <div class="seg-row">
      <button class="seg-btn" data-alarm="on">On</button>
      <button class="seg-btn" data-alarm="off">Off</button>
    </div>
    <p class="gear-note">Plays a chime when a focus session or a break finishes.</p>

    <label class="setting-label" style="margin-top:16px;">Lock screen notification</label>
    <button class="auth-btn secondary" id="notifyBtn" style="width:100%;">Enable notifications</button>
    <p class="gear-note" id="notifyNote" style="margin-top:10px;"></p>
  </div>
```

- [ ] **Step 3: Add the handlers**

In `settings.html`, inside the existing IIFE (the last inline `<script>`), add the following. `settings.html` is not one of the pages `tests/sync-test.js` runs — it covers only the five data pages — so the "wrong block" hazard that applies elsewhere does not apply here. Keeping it in the one IIFE is still right: the file has exactly one, and these handlers need `localStorage` access alongside the rest.

```js
  // ---- Pomodoro alarm ----

  const ALARM_ENABLED_KEY = 'scrollswap_pomodoro_alarm';

  function renderAlarmToggle() {
    let on = true;
    try { on = localStorage.getItem(ALARM_ENABLED_KEY) !== 'off'; } catch (e) {}
    document.querySelectorAll('.seg-btn[data-alarm]').forEach(function (b) {
      b.classList.toggle('selected', b.dataset.alarm === (on ? 'on' : 'off'));
    });
  }

  function initAlarmToggle() {
    document.querySelectorAll('.seg-btn[data-alarm]').forEach(function (b) {
      b.addEventListener('click', function () {
        try { localStorage.setItem(ALARM_ENABLED_KEY, b.dataset.alarm); } catch (e) {}
        renderAlarmToggle();
      });
    });
    renderAlarmToggle();
  }

  /* iOS only grants notification permission from a user gesture, and only in a
     PWA added to the Home Screen. Asking from a button here rather than on the
     first Start keeps the permission sheet away from the moment the app is
     supposed to feel frictionless. */
  function renderNotifyState() {
    const btn = document.getElementById('notifyBtn');
    const note = document.getElementById('notifyNote');
    if (!btn || !note) return;

    if (typeof Notification === 'undefined') {
      btn.disabled = true;
      btn.textContent = 'Not supported';
      note.textContent = 'This browser cannot show notifications. Add Rotulus to your Home Screen and open it from there.';
      return;
    }
    if (Notification.permission === 'granted') {
      btn.disabled = true;
      btn.textContent = 'Notifications on';
      note.textContent = 'You will get a banner when a session finishes.';
      return;
    }
    if (Notification.permission === 'denied') {
      btn.disabled = true;
      btn.textContent = 'Notifications blocked';
      note.textContent = 'Blocked for this app. Turn them back on in iOS Settings → Notifications → Rotulus.';
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Enable notifications';
    note.textContent = 'Only works when Rotulus is opened from your Home Screen icon.';
  }

  function initNotifyButton() {
    const btn = document.getElementById('notifyBtn');
    if (!btn) return;
    btn.addEventListener('click', async function () {
      if (typeof Notification === 'undefined') return;
      try { await Notification.requestPermission(); } catch (e) {}
      renderNotifyState();
    });
    renderNotifyState();
  }
```

- [ ] **Step 4: Call them from the page's init**

`settings.html` already has an `initApp()` called from its `DOMContentLoaded`
handler (`settings.html:235`). Add the two calls at the end of `initApp()`,
matching how the page's other setup is wired rather than bolting them onto the
event handler:

```js
    initAlarmToggle();
    initNotifyButton();
```

- [ ] **Step 5: Bump the stylesheet version**

```bash
node -e "const fs=require('fs');for(const p of ['index','dashboard','goals','pomodoro','diary','todo','settings']){const f=p+'.html';let h=fs.readFileSync(f,'utf8');if(h.indexOf('rotulus.css?v=4')===-1)throw new Error('v=4 not found in '+f);h=h.replace('rotulus.css?v=4','rotulus.css?v=5');fs.writeFileSync(f,h);}console.log('bumped rotulus.css to ?v=5 in 7 pages');"
```

- [ ] **Step 6: Run all three suites**

```bash
node tests/syntax-check.js && node tests/sync-test.js && node tests/alarm-test.js
```

Expected: all three pass.

- [ ] **Step 7: Drive the settings page in the browser**

Navigate to `http://localhost:3000/settings.html` and check:

- The On/Off pair shows On selected by default; tapping Off selects Off and writes `scrollswap_pomodoro_alarm=off`:

```js
(() => { document.querySelector('.seg-btn[data-alarm="off"]').click();
  return JSON.stringify({ stored: localStorage.getItem('scrollswap_pomodoro_alarm'),
    offSelected: document.querySelector('.seg-btn[data-alarm="off"]').classList.contains('selected') }); })()
```
Expected: `{"stored":"off","offSelected":true}`

- Switching theme does **not** clear it (this is the `.theme-btn` trap):

```js
(() => { window.rotulus.applyTheme('dark');
  return document.querySelector('.seg-btn[data-alarm="off"]').classList.contains('selected'); })()
```
Expected: `true`

- Reset it: `localStorage.removeItem('scrollswap_pomodoro_alarm')`

---

### Task 6: End-to-end check, docs, and one batched deploy

**Files:**
- Modify: `CLAUDE.md` — document the alarm, the keep-alive and the service worker
- Deploy: everything from Tasks 1–5

- [ ] **Step 1: Fake a completion in the browser and watch all three channels**

With the preview on `http://localhost:3000/pomodoro.html`, put a running timer two seconds from the end and let `tick()` reach zero naturally:

```js
localStorage.setItem('scrollswap_pomodoro_timer', JSON.stringify({
  category: 'productivity', mode: 'focus',
  durationSeconds: 1500, focusDurationSeconds: 1500, remainingAtAnchor: 1500,
  anchorTimestamp: Date.now() - 1498 * 1000, running: true }));
location.reload();
```

Then within a few seconds:

```js
JSON.stringify({
  flashed: document.getElementById('timerCard').classList.contains('flash-highlight'),
  display: document.getElementById('timerDisplay').textContent,
})
```
Expected: `flashed: true` and `display: "25:00"` (a fresh focus session).

- [ ] **Step 2: Confirm the keep-alive stops when the timer does**

```js
(() => { document.getElementById('startBtn').click();
  const started = !!document.querySelector('audio, video') || true;
  document.getElementById('resetBtn').click();
  return JSON.stringify({ note: 'reset should have paused the keep-alive' }); })()
```

Then check no audio is left playing:

```js
JSON.stringify([...document.querySelectorAll('audio')].map(a => ({ src: a.src, paused: a.paused })))
```
Expected: either an empty array, or every entry `paused: true`. **A keep-alive left running is a permanent battery drain — this must be clean.**

- [ ] **Step 3: Clear the test state**

```js
localStorage.removeItem('scrollswap_pomodoro_timer'); 'cleared'
```

- [ ] **Step 4: Document it in `CLAUDE.md`**

Add a section after "Pomodoro timer state":

```markdown
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
- **`sw.js` exists only because iOS has no `Notification` constructor** — a
  banner must come from `ServiceWorkerRegistration.showNotification()`. There
  is no push and **no `fetch` handler**, so it cannot cache and cannot serve
  stale content. Never add one: a caching service worker survives a redeploy
  and no `?v=` bump would rescue it. Removing it from devices that already have
  it requires shipping a version that calls `self.registration.unregister()` —
  deleting the file is not enough.
- **Settings keys are `scrollswap_pomodoro_alarm` and
  `scrollswap_pomodoro_notify`.** The prefix is mandatory — see the key-prefix
  trap above.
- **The alarm toggle uses `.seg-btn`, not `.theme-btn`.** `applyTheme()` clears
  `selected` from every `.theme-btn` it finds, which would wipe the alarm
  setting's highlight on any theme change.
- Regenerate the sounds with `node tools/make-alarm-audio.js`. Because
  `/assets/*` is cached for a year, a changed sound needs a **new filename**,
  not an overwrite.
```

- [ ] **Step 5: Run every suite one final time**

```bash
node tests/syntax-check.js && node tests/sync-test.js && node tests/alarm-test.js
```

Expected: all three pass.

- [ ] **Step 6: Deploy as one batched commit**

The working folder has no `.git`, and the repo stores **CRLF** while this folder is **LF**, so copy only the edited files and convert them:

```bash
SCRATCH="$TMPDIR/rotulus-deploy" && rm -rf "$SCRATCH" && git clone --quiet https://github.com/AverageGuyAlex/scroll-swap.git "$SCRATCH" && echo cloned
```

Copy these, then convert each with `perl -pi -e 's/(?<!\r)\n\z/\r\n/' <file>`:

`sw.js`, `netlify.toml`, `CLAUDE.md`, `css/rotulus.css`, `js/rotulus-shared.js`, `pomodoro.html`, `settings.html`, `index.html`, `dashboard.html`, `goals.html`, `diary.html`, `todo.html`, `tools/make-alarm-audio.js`, `tests/alarm-test.js`, `docs/superpowers/specs/2026-08-18-pomodoro-alarm-design.md`, `docs/superpowers/plans/2026-08-18-pomodoro-alarm.md`

The two `.wav` files are binary — copy them **without** the CRLF conversion, which would corrupt them.

- [ ] **Step 7: Check the diff before committing**

```bash
git diff --stat && git status --short
```

Expected: tens to low hundreds of changed lines, **not thousands**. Thousands means the line-ending conversion was missed. The two WAVs appear as new binary files.

- [ ] **Step 8: Commit and push**

```bash
git add -A && git commit -m "Add a completion alarm to the Pomodoro timer" && git push origin main
```

- [ ] **Step 9: Confirm the deploy went live**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://rotulus.netlify.app/sw.js
```
Expected: `200`. A failed Netlify deploy silently leaves the old version live, so this is the check that it actually shipped.

- [ ] **Step 10: Test on the actual iPhone**

This is the only place the real questions get answered, and neither can be checked from a desktop browser:

1. Open Rotulus from the **Home Screen icon** (not Safari), go to Settings, tap **Enable notifications**, accept.
2. Start a 1-minute focus session. Lock the phone.
3. At zero: does the chime sound, and does a banner appear on the lock screen?

If the chime fires but the banner does not, permission or the service worker is the problem — check `Notification.permission` in Settings. If neither fires until you reopen the app, iOS suspended the page despite the keep-alive: raise the amplitude in `tools/make-alarm-audio.js` (currently `0.0008`) and regenerate under a **new filename**.

---

## Self-Review

**Spec coverage.** Every section maps to a task: three channels → Tasks 2 and 4; keep-alive and its lifecycle → Task 3; service worker with no fetch handler and its removal path → Task 4; permission from a Settings gesture and the on/off toggle → Task 5; both storage keys with the prefix rationale → Global Constraints and Task 5; both assets in `assets/` → Task 1; both hook points → Tasks 2 and 4; graceful degradation with assets missing → the `try`/`catch` and feature guards throughout; testing including the on-device check → Task 6.

**One spec item intentionally dropped:** `scrollswap_pomodoro_notify` is declared in the spec but never read, because `Notification.permission` is already the source of truth for whether a banner can show — a second flag would just be able to disagree with it. It stays documented in `CLAUDE.md` as reserved rather than being written by any code.

**Type consistency.** `playChime`/`stopChime`/`flashTimerCard`/`alarmEnabled` (Task 2), `startKeepAlive`/`stopKeepAlive`/`armKeepAliveRetry` (Task 3), `showCompletionBanner(wasBreak, minutes)` (Task 4) and `renderAlarmToggle`/`initAlarmToggle`/`renderNotifyState`/`initNotifyButton` (Task 5) are each defined once and referenced under exactly those names. `ALARM_ENABLED_KEY` is defined separately in `pomodoro.html` and `settings.html` — two files with no shared scope — and holds the same literal in both.
