/* Runs the six real sync functions against a stubbed @netlify/blobs.
 *
 * These had no test before. They are the whole of account sync, and when they
 * fail they fail all at once, so the paths that matter are:
 *   - 401 comes first, and says nothing about configuration (a stranger must not
 *     learn whether the site's Blobs credentials are set)
 *   - a missing env var is reported by name instead of crashing the function
 *   - a rejected credential keeps err.name, which is the half that identifies it
 *   - the happy path still reads and writes under user-<sub>
 *
 * The functions became V2 ES modules on 2026-09-02, so @netlify/blobs can no
 * longer be stubbed by patching Module._load — an ESM import goes straight past
 * it. Instead each function's source is read, its single import line swapped for
 * the injected stub, and the module body evaluated. That is the same trick
 * sync-test.js and alarm-test.js already use to run page scripts, and it keeps
 * the tests dependency-free.
 * Run with: node tests/functions-test.js
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'netlify', 'functions');
const FILES = fs.readdirSync(DIR).filter(f => f.endsWith('.mjs')).sort();

let getStoreImpl = () => ({});
let getStoreCalls = [];

/* Turns the ES module into something new Function can evaluate: drop the import
   (getStore arrives as a parameter instead) and turn the default export into a
   value we can return. Deliberately strict — if the shape of these files ever
   drifts from the template, this throws rather than silently testing nothing. */
function loadHandler(file) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  if (!/^import \{ getStore \} from '@netlify\/blobs';/m.test(src)) {
    throw new Error(file + ': expected the @netlify/blobs import at the top');
  }
  if (!/^export default async \(req, context\) => \{/m.test(src)) {
    throw new Error(file + ': expected a V2 "export default async (req, context)" handler');
  }
  const body = src
    .replace(/^import \{ getStore \} from '@netlify\/blobs';/m, '')
    .replace(/^export default /m, 'return ');
  return new Function('getStore', body)(
    (opts) => { getStoreCalls.push(opts); return getStoreImpl(opts); }
  );
}

// A V2 handler takes a real Request and returns a real Response.
function request(method, body) {
  return new Request('https://rotulus.netlify.app/.netlify/functions/x', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
}

async function readBody(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return text; }
}

// ---- tiny assert harness, matching the other tests in this folder ----

let failures = 0;
function check(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected: ${JSON.stringify(expected)}, actual: ${JSON.stringify(actual)}`);
}

const USER = { clientContext: { user: { sub: 'abc123' } } };
const NO_USER = { clientContext: {} };

// ---- scenarios ----

(async () => {
  for (const file of FILES) {
    console.log(`\n=== ${file} ===`);
    const handler = loadHandler(file);

    // A. Unauthenticated. The body must not reveal anything about configuration.
    getStoreCalls = [];
    let res = await handler(request('GET'), NO_USER);
    check('A. no user -> 401', 401, res.status);
    check('A. no user -> says nothing about Blobs config', false, /BLOBS|Blobs/.test(await res.clone().text()));
    check('A. no user -> never touches the store', 0, getStoreCalls.length);

    // B. There is no env-var branch left to test: V2 configures Blobs itself, so
    //    BLOBS_SITE_ID/BLOBS_TOKEN are gone and cannot expire. What replaces that
    //    scenario is proving getStore is called WITHOUT credentials — passing a
    //    stale siteID/token here would quietly reintroduce the whole problem.
    getStoreCalls = [];
    getStoreImpl = () => ({ get: async () => ({ hello: 'world' }), set: async () => {} });
    res = await handler(request('GET'), USER);
    check('B. getStore is called with only a store name', ['name'], Object.keys(getStoreCalls[0] || {}));

    // C. Credentials rejected: getStore throws. This used to happen outside the
    //    try and crash the function before anything could report the cause.
    getStoreImpl = () => { const e = new Error('environment has not been configured'); e.name = 'MissingBlobsEnvironmentError'; throw e; };
    res = await handler(request('GET'), USER);
    check('C. getStore throws -> 500, not a crash', 500, res.status);
    check('C. getStore throws -> keeps err.name', 'MissingBlobsEnvironmentError', (await readBody(res)).name);

    // D. Happy path GET.
    getStoreImpl = () => ({ get: async () => ({ hello: 'world' }), set: async () => {} });
    res = await handler(request('GET'), USER);
    check('D. GET -> 200', 200, res.status);
    check('D. GET -> returns stored data', { hello: 'world' }, await readBody(res));

    // E. Happy path POST, and the per-user key must be right.
    let written = null;
    getStoreImpl = () => ({ get: async () => null, set: async (k, v) => { written = { k, v }; } });
    res = await handler(request('POST', { a: 1 }), USER);
    check('E. POST -> 200 ok', { ok: true }, await readBody(res));
    check('E. POST -> writes under user-<sub>', 'user-abc123', written && written.k);
    check('E. POST -> writes the body it was sent', { a: 1 }, JSON.parse(written.v));

    // F. Empty store still returns this page's own default shape, not null.
    getStoreImpl = () => ({ get: async () => null, set: async () => {} });
    res = await handler(request('GET'), USER);
    check('F. empty store -> 200 with an object', 'object', typeof (await readBody(res)));

    // G. Anything but GET/POST.
    res = await handler(request('DELETE'), USER);
    check('G. DELETE -> 405', 405, res.status);

    getStoreImpl = () => ({});
  }

  console.log(failures === 0 ? '\nALL FUNCTION SCENARIOS PASS' : `\n${failures} FUNCTION FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
