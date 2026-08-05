/*
 * Runs the REAL page script from each Rotulus page inside a fake browser,
 * fires the Netlify Identity 'login' event, and records which HTTP calls
 * the page makes. Proves the login sequence can no longer upload an empty
 * (or unverified) state over the server copy.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.ROTULUS_DIR || 'C:/Users/gamer/OneDrive/Dokumenter/claude code/scroll-swap-main';

function extractScript(page) {
  const html = fs.readFileSync(path.join(DIR, page + '.html'), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  return blocks[blocks.length - 1][1]; // the big app IIFE
}

// --- fake DOM: any property access returns something harmless & chainable ---
function fakeEl() {
  const target = {
    textContent: '', innerHTML: '', value: '', checked: false,
    style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {}, children: [], parentNode: null,
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    focus() {}, blur() {}, click() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    closest() { return null; }, scrollIntoView() {}, getBoundingClientRect() { return {}; },
    // Layout/SVG bits the pomodoro progress ring reads:
    clientWidth: 340, clientHeight: 260, offsetWidth: 340, offsetHeight: 260,
    getTotalLength() { return 1000; },
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

function makeLocalStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
    _dump() { return Object.fromEntries(map); },
  };
}

/* Run one scenario. Returns the list of HTTP calls the page made. */
function run({ page, localSeed, serverReply, pullFails }) {
  const calls = [];
  const localStorage = makeLocalStorage(localSeed);
  const handlers = {};

  const fetchStub = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body });
    if (method === 'GET') {
      if (pullFails) throw new Error('simulated network failure');
      return { ok: true, status: 200, json: async () => serverReply, text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
  };

  const netlifyIdentity = {
    on(evt, cb) { handlers[evt] = cb; },
    init() { if (handlers.init) handlers.init(null); },
    open() {}, close() {}, logout() {}, currentUser() { return null; },
  };

  const win = {
    addEventListener(evt, cb) { (handlers['win:' + evt] ||= []).push(cb); },
    removeEventListener() {},
    localStorage, fetch: fetchStub, netlifyIdentity,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    location: { href: '', origin: 'https://rotulus.netlify.app', pathname: '/' },
    requestAnimationFrame: (cb) => { cb(0); return 0; },
    rotulus: { applyTheme() {}, getTheme() { return 'light'; } },
  };
  const doc = new Proxy({
    getElementById: () => fakeEl(),
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    createElement: () => fakeEl(),
    addEventListener(evt, cb) { (handlers['doc:' + evt] ||= []).push(cb); },
    documentElement: fakeEl(),
    body: fakeEl(),
    hidden: false,
  }, { get(t, k) { return k in t ? t[k] : () => fakeEl(); } });

  const src = extractScript(page);
  const getComputedStyleStub = () => ({
    borderTopLeftRadius: '20px', height: '260px', width: '340px',
    getPropertyValue() { return ''; },
  });

  const fn = new Function(
    'window', 'document', 'localStorage', 'fetch', 'netlifyIdentity', 'console',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'matchMedia',
    'requestAnimationFrame', 'alert', 'confirm', 'navigator', 'getComputedStyle',
    'ResizeObserver',
    src
  );
  fn(win, doc, localStorage, fetchStub, netlifyIdentity, { log() {}, error() {}, warn() {} },
     setTimeout, clearTimeout, () => 0, clearInterval, win.matchMedia,
     win.requestAnimationFrame, () => {}, () => true, { userAgent: 'test' },
     getComputedStyleStub,
     class { observe() {} unobserve() {} disconnect() {} });

  // fire DOMContentLoaded -> initApp() + initIdentity()
  (handlers['win:DOMContentLoaded'] || []).forEach(cb => cb());

  return { calls, handlers, localStorage };
}

async function scenario(name, cfg, expectation) {
  const { calls, handlers } = run(cfg);
  const before = calls.length;
  if (handlers.login) {
    await handlers.login({ email: 'a@b.c', jwt: async () => 'fake-token', user_metadata: {} });
  }
  const loginCalls = calls.slice(before);
  const posts = loginCalls.filter(c => c.method === 'POST');
  const ok = expectation.uploads === posts.length;
  const emptyPost = posts.find(p => {
    try { const b = JSON.parse(p.body || '{}');
      return Object.keys(b).length === 0 ||
        (b.categories && !b.categories.length && b.completions && !Object.keys(b.completions).length) ||
        (b.goals && !b.goals.length);
    } catch { return false; }
  });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  console.log(`        expected uploads: ${expectation.uploads}, actual: ${posts.length}` +
              (emptyPost ? '  <-- EMPTY PAYLOAD UPLOADED' : ''));
  return ok && !(expectation.uploads === 0 && posts.length > 0);
}

(async () => {
  console.log('\n=== Habit tracker (index.html) ===');
  const results = [];
  results.push(await scenario(
    'A. download FAILS, device empty  -> must not upload',
    { page: 'index', localSeed: {}, serverReply: {}, pullFails: true },
    { uploads: 0 }));
  results.push(await scenario(
    'B. download ok but server empty, device empty -> must not upload',
    { page: 'index', localSeed: {}, serverReply: {}, pullFails: false },
    { uploads: 0 }));
  results.push(await scenario(
    'C. download FAILS, device HAS data -> must not upload (server unknown)',
    { page: 'index', localSeed: { 'scrollswap_2026-08-01': '{"wake":true}' }, serverReply: {}, pullFails: true },
    { uploads: 0 }));
  results.push(await scenario(
    'D. download ok, server empty, device HAS data -> MUST upload (the phone case)',
    { page: 'index', localSeed: { 'scrollswap_2026-08-01': '{"wake":true}' }, serverReply: {}, pullFails: false },
    { uploads: 1 }));
  results.push(await scenario(
    'E. download ok with server data, device empty -> uploads merged copy back',
    { page: 'index', localSeed: {}, serverReply: { '2026-08-01': { wake: true } }, pullFails: false },
    { uploads: 1 }));

  console.log('\n=== To-Do (todo.html) ===');
  results.push(await scenario(
    'A. download FAILS, device empty -> must not upload',
    { page: 'todo', localSeed: {}, serverReply: {}, pullFails: true },
    { uploads: 0 }));
  results.push(await scenario(
    'D. download ok, server empty, device HAS tasks -> MUST upload',
    { page: 'todo', localSeed: { 'scrollswap_todo_state': '{"categories":[{"id":"c1","name":"Home","color":"blue","dueDate":null,"subcategories":[{"id":"s1","name":"Kitchen","tasks":[{"id":"t1","text":"Dishes","recurring":true,"done":false}]}]}],"completions":{}}' }, serverReply: {}, pullFails: false },
    { uploads: 1 }));

  console.log('\n=== Goals (goals.html) ===');
  results.push(await scenario(
    'A. download FAILS, device empty -> must not upload',
    { page: 'goals', localSeed: {}, serverReply: {}, pullFails: true },
    { uploads: 0 }));
  results.push(await scenario(
    'D. download ok, server empty, device HAS goals -> MUST upload',
    { page: 'goals', localSeed: { 'scrollswap_goals_state': '{"goals":[{"id":"g1","name":"Run 10k","dueDate":null,"createdDate":"2026-08-01","completed":false,"milestones":[],"dailyHours":{}}]}' }, serverReply: {}, pullFails: false },
    { uploads: 1 }));

  console.log('\n=== Pomodoro (pomodoro.html) ===');
  results.push(await scenario(
    'A. download FAILS, device empty -> must not upload',
    { page: 'pomodoro', localSeed: {}, serverReply: {}, pullFails: true },
    { uploads: 0 }));
  results.push(await scenario(
    'D. download ok, server empty, device HAS sessions -> MUST upload',
    { page: 'pomodoro', localSeed: { 'pomodoro_2026-08-01': '{"productivity":50}' }, serverReply: {}, pullFails: false },
    { uploads: 1 }));

  console.log('\n=== Diary (diary.html) ===');
  results.push(await scenario(
    'A. download FAILS, device empty -> must not upload',
    { page: 'diary', localSeed: {}, serverReply: {}, pullFails: true },
    { uploads: 0 }));
  results.push(await scenario(
    'D. download ok, server empty, device HAS entries -> MUST upload',
    { page: 'diary', localSeed: { 'diary_2026-08-01': '{"title":"Hi","text":"x","rating":7}' }, serverReply: {}, pullFails: false },
    { uploads: 1 }));

  const failed = results.filter(r => !r).length;
  console.log(`\n${failed === 0 ? 'ALL SCENARIOS PASS' : failed + ' SCENARIO(S) FAILED'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
