/* Runs the six real sync functions against a stubbed @netlify/blobs and a
 * stubbed Netlify Identity endpoint.
 *
 * These are the whole of account sync, and when they fail they fail all at
 * once, so the paths that matter are:
 *   - a request with no valid token is refused, and the refusal says nothing
 *     about configuration (a stranger must not learn whether the site's Blobs
 *     credentials are set)
 *   - a request WITH a valid token is let through and reads/writes under
 *     user-<id>
 *   - Identity being unreachable is NOT reported as "not authenticated"
 *   - a rejected Blobs credential keeps err.name, the half that identifies it
 *   - a junk or oversized body is a clean 4xx, not a 500 that looks like the
 *     store broke
 *   - responses carrying account data are never cacheable, and never echo the
 *     raw error message back to the client
 *
 * WHY THIS FILE WAS REWRITTEN (2026-09-03)
 *
 * It used to hand the handler a made-up context: { clientContext: { user: {
 * sub: 'abc123' } } }. That tested the code's ASSUMPTION about the platform
 * rather than the platform's behaviour, and the assumption was false —
 * clientContext belongs to the V1 Lambda signature and does not exist on a V2
 * context object. So from 2026-09-02 every logged-in request got a 401 for a
 * month while this file reported all green.
 *
 * The lesson is baked into the scenarios below: authentication is exercised
 * through the same door a real caller uses (an Authorization header, verified
 * against Identity), and scenario A2 fails the build if any function reaches
 * for clientContext again.
 *
 * The functions are V2 ES modules, so @netlify/blobs cannot be stubbed by
 * patching Module._load — an ESM import goes straight past it. Instead each
 * function's source is read, its import line swapped for the injected stub, and
 * the module body evaluated. Same trick sync-test.js and alarm-test.js use.
 *
 * Run with: node tests/functions-test.js
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'netlify', 'functions');
const FILES = fs.readdirSync(DIR).filter(f => f.endsWith('.mjs')).sort();

let getStoreImpl = () => ({});
let getStoreCalls = [];
let fetchImpl = async () => { throw new Error('no fetch stub set'); };
let fetchCalls = [];

/* Turns the ES module into something new Function can evaluate: drop the import
   (getStore arrives as a parameter instead) and turn the default export into a
   value we can return. `fetch` is injected too, because verifying the caller's
   token means calling Identity. Deliberately strict — if the shape of these
   files ever drifts from the template, this throws rather than silently
   testing nothing. */
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
  return new Function('getStore', 'fetch', body)(
    (opts) => { getStoreCalls.push(opts); return getStoreImpl(opts); },
    (url, opts) => { fetchCalls.push({ url: String(url), opts }); return fetchImpl(url, opts); }
  );
}

// A V2 handler takes a real Request and returns a real Response.
function request(method, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  return new Request('https://rotulus.netlify.app/.netlify/functions/x', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
}

// Same, but with the body passed through verbatim - for junk and oversized payloads.
function rawRequest(method, text, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  return new Request('https://rotulus.netlify.app/.netlify/functions/x', {
    method, body: text, headers,
  });
}

async function readBody(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return text; }
}

/* Strips comments so a source assertion inspects CODE, not prose. The functions
   carry a long comment explaining the clientContext outage, and a plain
   substring search would match that explanation and fail forever — punishing
   the file for documenting the bug it fixed. Naive about /* inside string
   literals; there are none in these files, and a false positive here is a
   loud test failure rather than a silent pass. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ---- Identity stubs ----

/* The real id from a live token, 2026-09-03. It is the same value the JWT calls
   "sub", which is what existing blobs are filed under — see scenario G. */
const USER_ID = '0e92f37e-e6e2-4674-a6a7-7df75729412f';

const identityAccepts = async () => new Response(
  JSON.stringify({ id: USER_ID, email: 'a@b.c' }),
  { status: 200, headers: { 'Content-Type': 'application/json' } }
);
const identityRejects = async () => new Response('{}', { status: 401 });
const identityDown = async () => { throw new TypeError('fetch failed'); };
const identityErrors = async () => new Response('upstream boom', { status: 502 });

// ---- tiny assert harness, matching the other tests in this folder ----

let failures = 0;
function check(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected: ${JSON.stringify(expected)}, actual: ${JSON.stringify(actual)}`);
}

const TOKEN = 'a-valid-looking-jwt';

// ---- scenarios ----

(async () => {
  for (const file of FILES) {
    console.log(`\n=== ${file} ===`);
    const handler = loadHandler(file);
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');

    /* A. No token at all. The body must not reveal anything about
          configuration, and nothing may touch the store. */
    getStoreCalls = []; fetchCalls = [];
    let res = await handler(request('GET'), {});
    check('A. no token -> 401', 401, res.status);
    check('A. no token -> says nothing about Blobs config', false, /BLOBS|Blobs/.test(await res.clone().text()));
    check('A. no token -> never touches the store', 0, getStoreCalls.length);

    /* A2. The regression guard for the month-long outage. clientContext is a V1
           Lambda property; reading it on a V2 context refuses every real user
           while looking exactly like a correct 401. */
    check('A2. does not read context.clientContext', false, /clientContext/.test(codeOnly(src)));

    // A3. A header that is not a Bearer token is refused without calling Identity.
    fetchCalls = [];
    res = await handler(new Request('https://rotulus.netlify.app/.netlify/functions/x',
      { headers: { Authorization: 'Basic abc' } }), {});
    check('A3. non-Bearer auth -> 401', 401, res.status);
    check('A3. non-Bearer auth -> Identity not called', 0, fetchCalls.length);

    // B. A token Identity does not recognise.
    fetchImpl = identityRejects;
    getStoreCalls = [];
    res = await handler(request('GET', undefined, TOKEN), {});
    check('B. rejected token -> 401', 401, res.status);
    check('B. rejected token -> never touches the store', 0, getStoreCalls.length);

    /* C. Identity unreachable. This must NOT look like a bad token: an
          infrastructure failure wearing a 401 is what hid the outage. */
    fetchImpl = identityDown;
    getStoreCalls = [];
    res = await handler(request('GET', undefined, TOKEN), {});
    check('C. Identity unreachable -> 503, not 401', 503, res.status);
    check('C. Identity unreachable -> named so it can be diagnosed', 'IdentityUnavailable', (await readBody(res)).name);
    check('C. Identity unreachable -> never touches the store', 0, getStoreCalls.length);

    fetchImpl = identityErrors;
    res = await handler(request('GET', undefined, TOKEN), {});
    check('C2. Identity 5xx -> 503, not 401', 503, res.status);

    /* D. A valid token is verified against Identity, at the right URL, with the
          caller's token forwarded. */
    fetchImpl = identityAccepts;
    fetchCalls = [];
    getStoreImpl = () => ({ get: async () => ({ hello: 'world' }), set: async () => {} });
    res = await handler(request('GET', undefined, TOKEN), {});
    check('D. valid token -> 200', 200, res.status);
    check('D. verified against the Identity user endpoint',
      'https://rotulus.netlify.app/.netlify/identity/user', fetchCalls[0] && fetchCalls[0].url);
    check('D. forwards the caller token to Identity', 'Bearer ' + TOKEN,
      fetchCalls[0] && fetchCalls[0].opts && fetchCalls[0].opts.headers.Authorization);
    check('D. GET -> returns stored data', { hello: 'world' }, await readBody(res));

    /* E. There is no env-var branch left to test: V2 configures Blobs itself, so
          BLOBS_SITE_ID/BLOBS_TOKEN are gone and cannot expire. What replaces that
          scenario is proving getStore is called WITHOUT credentials — passing a
          stale siteID/token back in would quietly reintroduce the whole problem. */
    getStoreCalls = [];
    res = await handler(request('GET', undefined, TOKEN), {});
    check('E. getStore is called with only a store name', ['name'], Object.keys(getStoreCalls[0] || {}));

    /* F. Credentials rejected: getStore throws. This used to happen outside the
          try and crash the function before anything could report the cause. */
    getStoreImpl = () => { const e = new Error('environment has not been configured'); e.name = 'MissingBlobsEnvironmentError'; throw e; };
    res = await handler(request('GET', undefined, TOKEN), {});
    check('F. getStore throws -> 500, not a crash', 500, res.status);
    check('F. getStore throws -> keeps err.name', 'MissingBlobsEnvironmentError', (await readBody(res)).name);

    /* G. Happy path POST. The key must stay user-<id>, because that is the same
          value the JWT calls "sub" and every existing blob is filed under it —
          change it and all synced data is orphaned. */
    let written = null;
    getStoreImpl = () => ({ get: async () => null, set: async (k, v) => { written = { k, v }; } });
    res = await handler(request('POST', { a: 1 }, TOKEN), {});
    check('G. POST -> 200 ok', { ok: true }, await readBody(res));
    check('G. POST -> writes under user-<id>', 'user-' + USER_ID, written && written.k);
    check('G. POST -> writes the body it was sent', { a: 1 },
      written ? JSON.parse(written.v) : null);

    // H. Empty store still returns this page's own default shape, not null.
    getStoreImpl = () => ({ get: async () => null, set: async () => {} });
    res = await handler(request('GET', undefined, TOKEN), {});
    check('H. empty store -> 200 with an object', 'object', typeof (await readBody(res)));

    // I. Anything but GET/POST.
    res = await handler(request('DELETE', undefined, TOKEN), {});
    check('I. DELETE -> 405', 405, res.status);

    /* J. Bodies that are not a JSON object. These used to go straight into the
          store: JSON.stringify(undefined) is not a string, and a bare array or
          number is not a shape any page can read back. */
    written = null;
    res = await handler(rawRequest('POST', 'not json at all', TOKEN), {});
    check('J. junk body -> 400', 400, res.status);
    check('J. junk body -> nothing written', null, written);

    res = await handler(request('POST', [1, 2, 3], TOKEN), {});
    check('J. array body -> 400', 400, res.status);
    check('J. array body -> nothing written', null, written);

    /* K. A sanity cap on size. Real payloads are a few KB; Blobs bills by what
          it holds, and an authenticated caller could otherwise park megabytes
          in each of the six stores. */
    res = await handler(rawRequest('POST', '"' + 'x'.repeat(600 * 1024) + '"', TOKEN), {});
    check('K. oversized body -> 413', 413, res.status);
    check('K. oversized body -> nothing written', null, written);

    /* L. These bodies are somebody's whole diary. Netlify's default is
          "no-cache", which means revalidate - not "do not keep a copy". */
    getStoreImpl = () => ({ get: async () => ({ hello: 'world' }), set: async () => {} });
    res = await handler(request('GET', undefined, TOKEN), {});
    check('L. GET -> private, no-store', 'private, no-store', res.headers.get('Cache-Control'));

    /* M. The raw message can carry internal Blobs detail. err.name stays,
          because that is the half that identifies the failure in the browser. */
    getStoreImpl = () => { const e = new Error('bucket rotulus-xyz at internal.host rejected'); e.name = 'BlobsInternalError'; throw e; };
    res = await handler(request('GET', undefined, TOKEN), {});
    const leaked = await readBody(res);
    check('M. 500 keeps err.name', 'BlobsInternalError', leaked.name);
    check('M. 500 does not echo err.message', false, JSON.stringify(leaked).indexOf('internal.host') !== -1);

    getStoreImpl = () => ({});
  }

  console.log(failures === 0 ? '\nALL FUNCTION SCENARIOS PASS' : `\n${failures} FUNCTION FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
