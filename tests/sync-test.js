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

  /* ---- Merge ------------------------------------------------------------
     Until 2026-09-02 a pull did "state = serverState" on these two pages, so
     whichever device wrote last silently erased the other's work. These are the
     guard on the merge that replaced it. They assert the STATE after a login
     pull, not the upload count the scenarios above check. */
  console.log('\n=== To-Do / Goals merge (the data-loss guard) ===');

  function todoState(cats, extra) {
    return JSON.stringify(Object.assign({ categories: cats, completions: {} }, extra || {}));
  }
  function cat(id, name, updatedAt, subs) {
    return { id, name, group: 'purple', dueDate: null, updatedAt, subcategories: subs || [] };
  }
  function sub_(id, name, tasks, updatedAt) {
    return { id, name, updatedAt, tasks: tasks || [] };
  }
  function task(id, text, done, updatedAt) {
    return { id, text, done, recurring: false, updatedAt };
  }

  async function mergeCase(name, { localSeed, serverReply }, check) {
    const { handlers, localStorage } = run({ page: 'todo', localSeed, serverReply, pullFails: false });
    if (handlers.login) {
      await handlers.login({ email: 'a@b.c', jwt: async () => 'fake-token', user_metadata: {} });
    }
    let merged;
    try { merged = JSON.parse(localStorage.getItem('scrollswap_todo_state') || '{}'); }
    catch (e) { merged = {}; }
    let problem = null;
    try { problem = check(merged); } catch (e) { problem = e.message; }
    const ok = !problem;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        ${problem}`));
    return ok;
  }

  const now = Date.now();
  const names = st => (st.categories || []).map(c => c.name).sort();
  const ids = st => (st.categories || []).map(c => c.id).sort();

  results.push(await mergeCase(
    'an edit on each device survives the other (was: one silently erased)',
    {
      localSeed: { 'scrollswap_todo_state': todoState([cat('c1', 'Phone category', now)]) },
      serverReply: { categories: [cat('c2', 'Laptop category', now - 1000)], completions: {} },
    },
    st => ids(st).join() === 'c1,c2' ? null : `expected both c1 and c2, got [${ids(st)}]`));

  results.push(await mergeCase(
    'the newer edit of the SAME item wins',
    {
      localSeed: { 'scrollswap_todo_state': todoState([cat('c1', 'Newer name', now)]) },
      serverReply: { categories: [cat('c1', 'Older name', now - 5000)], completions: {} },
    },
    st => names(st).join() === 'Newer name' ? null : `expected "Newer name", got [${names(st)}]`));

  results.push(await mergeCase(
    'an older local edit loses to a newer server one',
    {
      localSeed: { 'scrollswap_todo_state': todoState([cat('c1', 'Stale local', now - 5000)]) },
      serverReply: { categories: [cat('c1', 'Fresh server', now)], completions: {} },
    },
    st => names(st).join() === 'Fresh server' ? null : `expected "Fresh server", got [${names(st)}]`));

  results.push(await mergeCase(
    'a legacy item with no updatedAt loses to a stamped edit',
    {
      localSeed: { 'scrollswap_todo_state': todoState([cat('c1', 'Stamped edit', now)]) },
      serverReply: { categories: [{ id: 'c1', name: 'Legacy unstamped', subcategories: [] }], completions: {} },
    },
    st => names(st).join() === 'Stamped edit' ? null : `expected "Stamped edit", got [${names(st)}]`));

  results.push(await mergeCase(
    'a deletion stays deleted instead of being resurrected',
    {
      localSeed: {
        'scrollswap_todo_state': todoState([], { deletedIds: { c1: now } }),
      },
      serverReply: { categories: [cat('c1', 'Deleted on the other device', now - 5000)], completions: {} },
    },
    st => (st.categories || []).length === 0 ? null : `expected it to stay deleted, got [${names(st)}]`));

  results.push(await mergeCase(
    'but an item re-added AFTER the delete survives',
    {
      localSeed: {
        'scrollswap_todo_state': todoState([], { deletedIds: { c1: now - 5000 } }),
      },
      serverReply: { categories: [cat('c1', 'Re-added later', now)], completions: {} },
    },
    st => names(st).join() === 'Re-added later' ? null : `expected the re-add to survive, got [${names(st)}]`));

  results.push(await mergeCase(
    'tasks added on both devices under one category are unioned',
    {
      localSeed: {
        'scrollswap_todo_state': todoState([
          cat('c1', 'Shared', now, [sub_('s1', 'Sub', [task('t1', 'Phone task', false, now)], now)]),
        ]),
      },
      serverReply: {
        categories: [cat('c1', 'Shared', now - 100, [sub_('s1', 'Sub', [task('t2', 'Laptop task', false, now - 100)], now - 100)])],
        completions: {},
      },
    },
    st => {
      const tasks = ((((st.categories || [])[0] || {}).subcategories || [])[0] || {}).tasks || [];
      const got = tasks.map(t => t.id).sort().join();
      return got === 't1,t2' ? null : `expected both t1 and t2, got [${got}]`;
    }));

  results.push(await mergeCase(
    'renaming a category on one device keeps the other device new tasks',
    {
      localSeed: {
        'scrollswap_todo_state': todoState([
          cat('c1', 'Renamed here', now, [sub_('s1', 'Sub', [], now - 100)]),
        ]),
      },
      serverReply: {
        categories: [cat('c1', 'Old name', now - 100, [sub_('s1', 'Sub', [task('t9', 'Their task', false, now - 50)], now - 100)])],
        completions: {},
      },
    },
    st => {
      const c = (st.categories || [])[0] || {};
      const tasks = ((c.subcategories || [])[0] || {}).tasks || [];
      if (c.name !== 'Renamed here') return `expected the rename to win, got "${c.name}"`;
      return tasks.length === 1 && tasks[0].id === 't9' ? null : `expected their task to survive the rename, got ${tasks.length}`;
    }));

  results.push(await mergeCase(
    'tombstones older than 90 days are pruned away',
    {
      localSeed: {
        'scrollswap_todo_state': todoState([], { deletedIds: { ancient: now - 200 * 24 * 60 * 60 * 1000 } }),
      },
      serverReply: { categories: [], completions: {} },
    },
    st => Object.keys(st.deletedIds || {}).length === 0 ? null : `expected pruning, got ${JSON.stringify(st.deletedIds)}`));

  async function goalCase(name, { localSeed, serverReply }, check) {
    const { handlers, localStorage } = run({ page: 'goals', localSeed, serverReply, pullFails: false });
    if (handlers.login) {
      await handlers.login({ email: 'a@b.c', jwt: async () => 'fake-token', user_metadata: {} });
    }
    let merged;
    try { merged = JSON.parse(localStorage.getItem('scrollswap_goals_state') || '{}'); }
    catch (e) { merged = {}; }
    let problem = null;
    try { problem = check(merged); } catch (e) { problem = e.message; }
    const ok = !problem;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        ${problem}`));
    return ok;
  }

  function goal(id, name2, updatedAt, extra) {
    return Object.assign({
      id, name: name2, dueDate: null, createdDate: '2026-08-01',
      completed: false, milestones: [], linkedCategoryIds: [], dailyHours: {}, updatedAt,
    }, extra || {});
  }
  const goalNames = st => (st.goals || []).map(g => g.name).sort();

  results.push(await goalCase(
    'a goal added on each device survives the other',
    {
      localSeed: { 'scrollswap_goals_state': JSON.stringify({ goals: [goal('g1', 'Phone goal', now)] }) },
      serverReply: { goals: [goal('g2', 'Laptop goal', now - 1000)] },
    },
    st => goalNames(st).join() === 'Laptop goal,Phone goal' ? null : `expected both, got [${goalNames(st)}]`));

  results.push(await goalCase(
    'hours logged on two devices on different days are BOTH kept',
    {
      localSeed: { 'scrollswap_goals_state': JSON.stringify({ goals: [goal('g1', 'Shared', now, { dailyHours: { '2026-09-01': 2 } })] }) },
      serverReply: { goals: [goal('g1', 'Shared', now - 1000, { dailyHours: { '2026-08-30': 3 } })] },
    },
    st => {
      const h = ((st.goals || [])[0] || {}).dailyHours || {};
      return (h['2026-09-01'] === 2 && h['2026-08-30'] === 3) ? null : `expected both days, got ${JSON.stringify(h)}`;
    }));

  results.push(await goalCase(
    'linked to-do categories from both devices are unioned',
    {
      localSeed: { 'scrollswap_goals_state': JSON.stringify({ goals: [goal('g1', 'Shared', now, { linkedCategoryIds: ['catA'] })] }) },
      serverReply: { goals: [goal('g1', 'Shared', now - 1000, { linkedCategoryIds: ['catB'] })] },
    },
    st => {
      const links = (((st.goals || [])[0] || {}).linkedCategoryIds || []).slice().sort();
      return links.join() === 'catA,catB' ? null : `expected both links, got [${links}]`;
    }));

  results.push(await goalCase(
    'a deleted goal is not resurrected by the other device',
    {
      localSeed: { 'scrollswap_goals_state': JSON.stringify({ goals: [], deletedIds: { g1: now } }) },
      serverReply: { goals: [goal('g1', 'Deleted elsewhere', now - 5000)] },
    },
    st => (st.goals || []).length === 0 ? null : `expected it to stay deleted, got [${goalNames(st)}]`));

  const failed = results.filter(r => !r).length;
  console.log(`\n${failed === 0 ? 'ALL SCENARIOS PASS' : failed + ' SCENARIO(S) FAILED'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
