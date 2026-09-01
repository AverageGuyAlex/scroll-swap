/*
 * Runs the REAL pomodoro page script inside a fake browser and asserts what the
 * completion alarm does. Deliberately NOT sharing sync-test.js's harness: this
 * needs a different fake environment (a recording Audio, a seeded clock)
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
    classList: {
      _c: new Set(),
      add(n) { this._c.add(n); }, remove(n) { this._c.delete(n); },
      toggle() {}, contains(n) { return this._c.has(n); },
    },
    dataset: {}, children: [], parentNode: null, offsetWidth: 340,
    // Recorded so a test can fire a control the way a tap would. Without this
    // there is no way to prove the keep-alive audio actually stops — and one
    // left running is a permanent battery drain.
    _listeners: {},
    addEventListener(type, cb) { (this._listeners[type] = this._listeners[type] || []).push(cb); },
    removeEventListener() {}, appendChild() {}, remove() {},
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
  const locks = [];                // every screen wake lock the page requests
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
  /* The real one is released by iOS on its own whenever the page hides, so the
     fake records releases rather than just existing. A lock left held is the
     same class of battery bug as a keep-alive left playing. */
  const wakeLock = {
    request: (type) => {
      const sentinel = {
        type, released: false,
        release() { this.released = true; (this._h.release || []).forEach((cb) => cb()); return Promise.resolve(); },
        addEventListener(t, cb) { (this._h[t] = this._h[t] || []).push(cb); },
        _h: {},
      };
      locks.push(sentinel);
      return Promise.resolve(sentinel);
    },
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
     () => 0, () => {}, () => 0, () => {}, win.matchMedia,
     win.requestAnimationFrame, () => {}, () => true, { userAgent: 'test', wakeLock },
     () => ({ borderTopLeftRadius: '20px', getPropertyValue: () => '' }),
     class { observe() {} unobserve() {} disconnect() {} });

  (win._h['DOMContentLoaded'] || []).forEach((cb) => cb());
  return { audios, els, store, locks };
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

/* The keep-alive is inaudible but is still real audio, so iOS hands the page the
   audio focus and pauses Spotify for the whole session. It defaults OFF for that
   reason — these scenarios are the guard on that default. */
console.log('\n=== Keep-alive is OFF by default (music is not interrupted) ===');
{
  const running = JSON.stringify({
    category: 'productivity', mode: 'focus',
    durationSeconds: 1500, focusDurationSeconds: 1500,
    remainingAtAnchor: 1500,
    anchorTimestamp: Date.now() - 60 * 1000, // 1 minute in, 24 to go
    running: true,
  });
  const { audios } = run({ 'scrollswap_pomodoro_timer': running });
  check('no keep-alive audio is created at all',
    audios.some((a) => a.src.includes('alarm-keepalive')), false);
  check('no chime for a timer still running',
    audios.some((a) => a.src.includes('alarm-chime')), false);
}

console.log('\n=== ...and the chime still fires with the keep-alive off ===');
{
  const { audios } = run({ 'scrollswap_pomodoro_timer': expiredTimerState() });
  const chimes = audios.filter((a) => a.src.includes('alarm-chime'));
  check('a finished session still chimes', chimes.length > 0 && chimes[0].playCount > 0, true);
}

console.log('\n=== Keep-alive when switched on in Settings ===');
{
  const running = JSON.stringify({
    category: 'productivity', mode: 'focus',
    durationSeconds: 1500, focusDurationSeconds: 1500,
    remainingAtAnchor: 1500,
    anchorTimestamp: Date.now() - 60 * 1000,
    running: true,
  });
  const { audios } = run({
    'scrollswap_pomodoro_timer': running,
    'scrollswap_pomodoro_keepalive': 'on',
  });
  const keep = audios.filter((a) => a.src.includes('alarm-keepalive'));
  check('keep-alive audio is created', keep.length > 0, true);
  check('keep-alive is looping', keep.length > 0 && keep[0].loop, true);
  check('keep-alive is playing', keep.length > 0 && keep[0].playCount > 0, true);
}

/* A keep-alive left playing is a permanent battery drain, so the stop path
   needs a real test rather than an eyeball. It cannot be checked in a browser:
   new Audio() produces a DETACHED element, so document.querySelectorAll('audio')
   never finds it. Firing the control's recorded handler here is the only way to
   see it happen. */
function runningTimerState() {
  return JSON.stringify({
    category: 'productivity', mode: 'focus',
    durationSeconds: 1500, focusDurationSeconds: 1500,
    remainingAtAnchor: 1500,
    anchorTimestamp: Date.now() - 60 * 1000,
    running: true,
  });
}

function fireClick(els, id) {
  const handlers = els[id] && els[id]._listeners && els[id]._listeners.click;
  if (!handlers || !handlers.length) throw new Error('no click handler recorded on #' + id);
  handlers.forEach((cb) => cb({ preventDefault() {}, stopPropagation() {} }));
}

console.log('\n=== Keep-alive stops when the timer does ===');
for (const control of ['resetBtn', 'pauseBtn']) {
  const { audios, els } = run({
    'scrollswap_pomodoro_timer': runningTimerState(),
    'scrollswap_pomodoro_keepalive': 'on',
  });
  const keep = audios.find((a) => a.src.includes('alarm-keepalive'));
  check(`[${control}] keep-alive is playing to begin with`, !!keep && !keep.paused, true);
  fireClick(els, control);
  check(`[${control}] keep-alive is paused afterwards`, !!keep && keep.paused, true);
}

/* The wake lock is what replaces the keep-alive, without touching audio.
   requestWakeLock() awaits, so these assertions have to run a microtask later —
   the harness's setTimeout is a no-op stub, so flush with a resolved promise. */
(async function () {
  console.log('\n=== Screen wake lock while a timer runs ===');
  {
    const { locks } = run({ 'scrollswap_pomodoro_timer': runningTimerState() });
    await Promise.resolve(); await Promise.resolve();
    check('a screen wake lock is requested', locks.length > 0, true);
    check('it is a screen lock', locks.length > 0 && locks[0].type, 'screen');
    check('it is still held while the timer runs', locks.length > 0 && locks[0].released, false);
  }

  console.log('\n=== Wake lock is released when the timer stops ===');
  for (const control of ['resetBtn', 'pauseBtn']) {
    const { els, locks } = run({ 'scrollswap_pomodoro_timer': runningTimerState() });
    await Promise.resolve(); await Promise.resolve();
    check(`[${control}] wake lock is held to begin with`,
      locks.length > 0 && !locks[0].released, true);
    fireClick(els, control);
    check(`[${control}] wake lock is released afterwards`,
      locks.length > 0 && locks[0].released, true);
  }

  console.log('\n=== A finished timer never takes a wake lock ===');
  {
    const { locks } = run({ 'scrollswap_pomodoro_timer': expiredTimerState() });
    await Promise.resolve(); await Promise.resolve();
    check('no wake lock held for a session that already ended',
      locks.some((l) => !l.released), false);
  }

  console.log(failures === 0 ? '\nALL ALARM SCENARIOS PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
