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
 * @netlify/blobs is not installed locally, so it is stubbed at require time.
 * Run with: node tests/functions-test.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const DIR = path.join(__dirname, '..', 'netlify', 'functions');
const FILES = fs.readdirSync(DIR).filter(f => f.endsWith('.js')).sort();

// ---- stub @netlify/blobs before any function is loaded ----

let getStoreImpl = () => ({});
let getStoreCalls = [];

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@netlify/blobs') {
    return { getStore: (opts) => { getStoreCalls.push(opts); return getStoreImpl(opts); } };
  }
  return origLoad.apply(this, arguments);
};

function loadHandler(file) {
  const p = path.join(DIR, file);
  delete require.cache[require.resolve(p)];
  return require(p).handler;
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

function setEnv(siteID, token) {
  if (siteID === null) delete process.env.BLOBS_SITE_ID; else process.env.BLOBS_SITE_ID = siteID;
  if (token === null) delete process.env.BLOBS_TOKEN; else process.env.BLOBS_TOKEN = token;
}

// ---- scenarios ----

(async () => {
  for (const file of FILES) {
    console.log(`\n=== ${file} ===`);
    const handler = loadHandler(file);

    // A. Unauthenticated, with config ALSO missing: auth must win, and the body
    //    must not reveal anything about the site's configuration.
    setEnv(null, null);
    getStoreCalls = [];
    let res = await handler({ httpMethod: 'GET' }, NO_USER);
    check('A. no user -> 401', 401, res.statusCode);
    check('A. no user -> says nothing about Blobs config', false, /BLOBS|Blobs/.test(res.body));
    check('A. no user -> never touches the store', 0, getStoreCalls.length);

    // B. Authenticated but the env vars are gone - the likeliest real cause.
    setEnv(null, null);
    getStoreCalls = [];
    res = await handler({ httpMethod: 'GET' }, USER);
    check('B. missing env vars -> 500', 500, res.statusCode);
    check('B. missing env vars -> names both', ['BLOBS_SITE_ID', 'BLOBS_TOKEN'], JSON.parse(res.body).missing);
    check('B. missing env vars -> never calls getStore', 0, getStoreCalls.length);

    // C. Credentials present but rejected: getStore throws. This used to happen
    //    outside the try and crash the function.
    setEnv('site-1', 'tok-1');
    getStoreImpl = () => { const e = new Error('environment has not been configured'); e.name = 'MissingBlobsEnvironmentError'; throw e; };
    res = await handler({ httpMethod: 'GET' }, USER);
    check('C. getStore throws -> 500, not a crash', 500, res.statusCode);
    check('C. getStore throws -> keeps err.name', 'MissingBlobsEnvironmentError', JSON.parse(res.body).name);

    // D. Happy path GET.
    setEnv('site-1', 'tok-1');
    getStoreCalls = [];
    getStoreImpl = () => ({ get: async () => ({ hello: 'world' }), set: async () => {} });
    res = await handler({ httpMethod: 'GET' }, USER);
    check('D. GET -> 200', 200, res.statusCode);
    check('D. GET -> returns stored data', { hello: 'world' }, JSON.parse(res.body));
    check('D. GET -> passes siteID and token through', ['site-1', 'tok-1'], [getStoreCalls[0].siteID, getStoreCalls[0].token]);

    // E. Happy path POST, and the per-user key must be right.
    let written = null;
    getStoreImpl = () => ({ get: async () => null, set: async (k, v) => { written = { k, v }; } });
    res = await handler({ httpMethod: 'POST', body: JSON.stringify({ a: 1 }) }, USER);
    check('E. POST -> 200 ok', { ok: true }, JSON.parse(res.body));
    check('E. POST -> writes under user-<sub>', 'user-abc123', written && written.k);

    // F. Empty store still returns this page's own default shape, not null.
    getStoreImpl = () => ({ get: async () => null, set: async () => {} });
    res = await handler({ httpMethod: 'GET' }, USER);
    check('F. empty store -> 200 with an object', 'object', typeof JSON.parse(res.body));

    getStoreImpl = () => ({});
  }

  Module._load = origLoad;
  console.log(failures === 0 ? '\nALL FUNCTION SCENARIOS PASS' : `\n${failures} FUNCTION FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
