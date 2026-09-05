import { getStore } from '@netlify/blobs';

/* A V2 function (export default, Request in / Response out).

   All six functions in this folder are this same file with the store name and
   the empty-state default swapped. Change one and you almost certainly need to
   change all six; tests/functions-test.js runs every one of them. */

/* Every response carrying account data says private, no-store. These bodies
   are somebody's whole diary or task list, and "no-cache" — which is what
   Netlify sends by default — only means revalidate, not don't keep a copy. */
const DATA_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
};

/* A sanity cap, not a quota. Real Rotulus payloads are a few KB; anything near
   this is a bug or an abuse of the store, and Blobs bills by what it holds.
   Measured in characters rather than bytes on purpose — it is the number that
   cannot be misreported by a Content-Length header. */
const MAX_BODY_CHARS = 512 * 1024;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: DATA_HEADERS,
  });
}

/* Who is calling?

   READ THIS BEFORE CHANGING IT. From 2026-09-02 to 2026-09-03 these functions
   asked `context.clientContext.user`, and every single logged-in request got a
   401 for a month. `clientContext` belongs to the V1 Lambda signature
   (`exports.handler = async (event, context)`); the V2 context object is a
   different type entirely and has no such property — it carries account,
   cookies, deploy, geo, ip, params, requestId, server, site, url and waitUntil,
   and nothing about the caller's identity. So the check was reading undefined
   and refusing everyone.

   It hid for a month because an authenticated 401 and an unauthenticated 401
   are byte-identical, and the only live check ever run was the unauthenticated
   one. Do not "verify" these functions that way again — log in and read data.

   The token is therefore verified against Identity itself, which is the only
   thing that can actually vouch for it. `@netlify/identity`'s getUser() is not
   a substitute: server-side it reads an nf_jwt cookie or a Netlify-injected
   global, never the Authorization header these pages send. */
async function identityUser(req) {
  const header = req.headers.get('authorization') || '';
  const match = /^Bearer (.+)$/i.exec(header.trim());
  if (!match) return { user: null };

  let res;
  try {
    res = await fetch(new URL('/.netlify/identity/user', req.url), {
      headers: { Authorization: 'Bearer ' + match[1] },
    });
  } catch (err) {
    /* Identity itself is unreachable. This is NOT the same as a bad token, and
       must never be reported as one — an infrastructure failure wearing a 401
       is exactly what made the bug above invisible. */
    return { user: null, unavailable: true };
  }
  if (res.status >= 500) return { user: null, unavailable: true };
  if (!res.ok) return { user: null };

  const user = await res.json().catch(() => null);
  return { user: user && user.id ? user : null };
}

export default async (req, context) => {
  /* Auth stays first, before anything touches the store. It is the only thing
     between a stranger and the data, and the 401 body deliberately says nothing
     about configuration — an unauthenticated caller must not be able to learn
     whether the site's credentials are set. */
  const { user, unavailable } = await identityUser(req);
  if (unavailable) {
    return json({ error: 'Could not verify login', name: 'IdentityUnavailable' }, 503);
  }
  if (!user) {
    return json({ error: 'Not authenticated' }, 401);
  }

  /* user.id is the same value the JWT calls "sub" (verified against a live
     token, 2026-09-03). Existing blobs are filed under it — changing this key
     orphans everyone's data. */
  const userKey = `user-${user.id}`;

  try {
    /* Inside the try deliberately. getStore() throws when credentials are
       present but rejected, and it used to sit above it — so a bad credential
       crashed the whole function before the catch could report anything. */
    const store = getStore({ name: 'habit-data' });

    if (req.method === 'GET') {
      const data = await store.get(userKey, { type: 'json' });
      return json(data || {});
    }

    if (req.method === 'POST') {
      /* Read as text first so the size can be checked before anything parses
         or stores it, and so a malformed body is a clean 400 rather than a
         500 that looks like the store failed. */
      const raw = await req.text();
      if (raw.length > MAX_BODY_CHARS) {
        return json({ error: 'Payload too large' }, 413);
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch (e) {
        return json({ error: 'Body must be JSON' }, 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ error: 'Body must be a JSON object' }, 400);
      }
      await store.set(userKey, JSON.stringify(body));
      return json({ ok: true });
    }

    return new Response('Method not allowed', { status: 405 });
  } catch (err) {
    /* err.name is the useful half: the Blobs SDK throws by name, which is
       otherwise indistinguishable from a network blip in the client's banner.
       err.message is deliberately NOT returned — it can carry internal detail,
       and the console line below puts the whole thing in the Netlify function
       log, where only the site owner can read it. */
    console.error('Blobs operation failed', err);
    return json({ error: 'Server error', name: err.name || 'Error' }, 500);
  }
};
