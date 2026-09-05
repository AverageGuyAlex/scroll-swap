/*
 * Proves that stored text can never become markup.
 *
 * Every page builds its HTML with template strings and innerHTML. Until
 * 2026-09-03 several of those interpolations were raw: a task name, a
 * subcategory name, a goal name and the habit slot labels all went into the
 * page as HTML. That matters more than a broken layout — the Netlify Identity
 * widget keeps the login token in localStorage, so script running on this
 * origin can take the account and read the diary. The realistic way hostile
 * text gets in is restoring a tampered backup file, which checks key NAMES but
 * never values.
 *
 * This runs each page's REAL script against a fake DOM (the same trick as
 * sync-test.js), seeds localStorage with payloads, records every innerHTML
 * write and asserts none of them contain markup.
 *
 * The "payload reached the render" assertion is not decoration: without it a
 * page that threw before drawing anything would pass by rendering nothing.
 *
 * Run with: node tests/escaping-test.js
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.ROTULUS_DIR || path.join(__dirname, '..');

// ---- the payloads -------------------------------------------------------
const IMG = '<img src=x onerror=alert(1)>';          // classic text-context escape
const TA = '</textarea><script>alert(2)</script>';   // breaks out of a <textarea>
const ATTR = '" onmouseover="alert(3)';              // breaks out of an attribute

function extractScript(page) {
  const html = fs.readFileSync(path.join(DIR, page + '.html'), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  return blocks[blocks.length - 1][1]; // the big app IIFE
}

/* Like sync-test.js's fake DOM, with the two additions this test needs: every
   innerHTML write is recorded, and getElementById hands back the SAME object
   for a given id, so a handler registered on it can be fired later. */
function makeDom() {
  const writes = [];
  const byId = new Map();

  function fakeEl() {
    const listeners = {};
    const target = {
      textContent: '', innerHTML: '', value: '', checked: false, hidden: false,
      style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; }, display: '' },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      dataset: {}, children: [], parentNode: null,
      addEventListener(evt, cb) { (listeners[evt] || (listeners[evt] = [])).push(cb); },
      removeEventListener() {}, appendChild() {}, remove() {},
      focus() {}, blur() {}, click() {}, setAttribute() {}, getAttribute() { return null; },
      querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
      closest() { return null; }, scrollIntoView() {}, getBoundingClientRect() { return {}; },
      clientWidth: 340, clientHeight: 260, offsetWidth: 340, offsetHeight: 260,
      getTotalLength() { return 1000; },
      /* Only the LAST binding, deliberately. Each re-render attaches a fresh
         handler to what is, in a real browser, a brand new element; running
         every one of them would toggle a subcategory open and shut again. */
      _fire(evt) {
        const list = listeners[evt] || [];
        if (list.length) list[list.length - 1]({ target: null, closest: () => null });
      },
    };
    return new Proxy(target, {
      get(t, k) {
        if (k in t) return t[k];
        if (typeof k === 'symbol') return undefined;
        return () => fakeEl();
      },
      set(t, k, v) {
        if (k === 'innerHTML' && typeof v === 'string' && v) writes.push(v);
        t[k] = v;
        return true;
      },
    });
  }

  return { writes, byId, fakeEl };
}

function makeLocalStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] || null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
  };
}

/* Runs one page and returns every innerHTML string it produced.

   `clickIds` fires the click handler on those element ids afterwards, which is
   how the views behind a button (the habit editor, the to-do archive) get
   rendered without a real DOM.

   `selectorStubs` does the same for elements a page finds by class rather than
   by id, listing the dataset each one should carry. To-do's task rows only
   render inside an EXPANDED subcategory, and expansion is in-memory state
   toggled by a click on .subcat-header — so without this the task text is
   never drawn and the most important escape in the file goes untested. A
   deliberately removed escape proved exactly that. */
function render({ page, seed, clickIds, selectorStubs }) {
  const { writes, byId, fakeEl } = makeDom();
  const localStorage = makeLocalStorage(seed);
  const handlers = {};
  const bySelector = new Map();

  function getElementById(id) {
    if (!byId.has(id)) byId.set(id, fakeEl());
    return byId.get(id);
  }

  function querySelectorAll(sel) {
    const spec = selectorStubs && selectorStubs[sel];
    if (!spec) return [];
    if (!bySelector.has(sel)) {
      bySelector.set(sel, spec.map(data => {
        const el = fakeEl();
        Object.assign(el.dataset, data);
        return el;
      }));
    }
    return bySelector.get(sel);
  }

  const fetchStub = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  const netlifyIdentity = {
    on(evt, cb) { handlers[evt] = cb; },
    init() { if (handlers.init) handlers.init(null); },
    open() {}, close() {}, logout() {}, currentUser() { return null; },
  };

  const win = {
    addEventListener(evt, cb) { (handlers['win:' + evt] || (handlers['win:' + evt] = [])).push(cb); },
    removeEventListener() {},
    localStorage, fetch: fetchStub, netlifyIdentity,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    location: { href: '', origin: 'https://rotulus.netlify.app', pathname: '/', hash: '' },
    requestAnimationFrame: (cb) => { cb(0); return 0; },
    rotulus: { applyTheme() {}, getTheme() { return 'light'; }, snackbar() {}, onReconnect() {} },
  };

  const doc = new Proxy({
    getElementById,
    querySelector: () => fakeEl(),
    querySelectorAll,
    createElement: () => fakeEl(),
    addEventListener(evt, cb) { (handlers['doc:' + evt] || (handlers['doc:' + evt] = [])).push(cb); },
    documentElement: fakeEl(),
    body: fakeEl(),
    hidden: false,
  }, { get(t, k) { return k in t ? t[k] : () => fakeEl(); } });

  const fn = new Function(
    'window', 'document', 'localStorage', 'fetch', 'netlifyIdentity', 'console',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'matchMedia',
    'requestAnimationFrame', 'alert', 'confirm', 'navigator', 'getComputedStyle',
    'ResizeObserver',
    extractScript(page)
  );
  fn(win, doc, localStorage, fetchStub, netlifyIdentity, { log() {}, error() {}, warn() {} },
     setTimeout, clearTimeout, () => 0, clearInterval, win.matchMedia,
     win.requestAnimationFrame, () => {}, () => true, { userAgent: 'test', onLine: true },
     () => ({ borderTopLeftRadius: '20px', height: '260px', width: '340px', getPropertyValue() { return ''; } }),
     class { observe() {} unobserve() {} disconnect() {} });

  (handlers['win:DOMContentLoaded'] || []).forEach(cb => cb());
  Object.keys(selectorStubs || {}).forEach(sel => querySelectorAll(sel).forEach(el => el._fire('click')));
  (clickIds || []).forEach(id => getElementById(id)._fire('click'));

  return writes;
}

// ---- assertions ---------------------------------------------------------

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label);
  if (!ok && detail) console.log('        ' + detail);
}

/* Neither of these tags is ever produced by a render in this app, so finding
   one means a payload became markup.

   Note what is NOT on this list: 'onerror='. Correctly escaped output still
   contains those letters — "&lt;img src=x onerror=alert(1)&gt;" is inert text
   that a naive substring search flags anyway. What actually distinguishes safe
   from unsafe is whether the payload survived VERBATIM, which is the next
   check. */
const FORBIDDEN_TAGS = ['<img', '<script'];

const RAW_PAYLOADS = [
  ['<img> payload', IMG],
  ['</textarea> break-out payload', TA],
  ['attribute break-out payload', ATTR],
];

function audit(name, writes) {
  const html = writes.join('\n');

  check(name + ': rendered something', html.length > 0, 'no innerHTML was written at all');

  for (const bad of FORBIDDEN_TAGS) {
    const at = html.indexOf(bad);
    check(name + ': no ' + bad + ' tag formed', at === -1,
      at === -1 ? '' : 'around: ' + JSON.stringify(html.slice(Math.max(0, at - 70), at + 70)));
  }

  /* The real test. If any of these appears byte-for-byte then it was written
     into the page as-is, which means the browser would parse it as markup. */
  for (const [label, raw] of RAW_PAYLOADS) {
    const at = html.indexOf(raw);
    check(name + ': ' + label + ' did not survive raw', at === -1,
      at === -1 ? '' : 'around: ' + JSON.stringify(html.slice(Math.max(0, at - 70), at + 70)));
  }

  /* index.html legitimately emits <textarea>...</textarea>, so a plain string
     search would false-positive. An injected closing tag shows up as an
     imbalance instead. */
  const opens = (html.match(/<textarea/g) || []).length;
  const closes = (html.match(/<\/textarea>/g) || []).length;
  check(name + ': <textarea> tags balanced', opens === closes, opens + ' open, ' + closes + ' close');

  /* Without this, a page that threw before drawing anything would pass every
     check above by rendering nothing at all. */
  check(name + ': payload reached the render, escaped',
    html.indexOf('&lt;img src=x onerror=alert(1)&gt;') !== -1,
    'the escaped payload is not in the output — did the render actually run?');
}

// ---- the three pages that interpolate stored text -----------------------

console.log('\n=== index.html (habit slot labels) ===');
audit('index', render({
  page: 'index',
  seed: {
    'scrollswap__labels': JSON.stringify({
      wake: { time: IMG, swap: TA + IMG },
      morning: { time: 'Morning', swap: ATTR },
    }),
  },
  clickIds: ['editBtn'],   // the editor puts slot text inside a <textarea>
}));

console.log('\n=== todo.html (category, subcategory, task, archive) ===');
audit('todo', render({
  page: 'todo',
  seed: {
    'scrollswap_todo_state': JSON.stringify({
      categories: [{
        id: 'c1' + ATTR, name: IMG, group: 'purple', createdAt: 1,
        subcategories: [{
          id: 's1' + ATTR, name: IMG,
          tasks: [
            { id: 't1' + ATTR, text: IMG, recurring: false, completedDate: '2026-09-01' },
            { id: 't2', text: IMG, recurring: true },
          ],
        }],
      }],
      completions: { '2026-09-01': { t2: true } },
    }),
    'scrollswap_todo_collapsed_groups': '[]',
  },
  // Expands the subcategory, which is the only way task rows get drawn.
  selectorStubs: { '.subcat-header': [{ catId: 'c1' + ATTR, subcatId: 's1' + ATTR }] },
  clickIds: ['archiveToggleBtn'],   // the archive panel renders task text + path
}));

console.log('\n=== goals.html (goal names and logged hours) ===');
audit('goals', render({
  page: 'goals',
  seed: {
    'scrollswap_goals_state': JSON.stringify({
      goals: [{
        id: 'g1' + ATTR, name: IMG, completed: false, dueDate: '',
        dailyHours: { '2026-09-01': 2 }, linkedCategoryIds: [], milestones: [],
      }],
    }),
  },
}));

console.log(failures === 0
  ? '\nALL ESCAPING SCENARIOS PASS'
  : '\n' + failures + ' ESCAPING FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
