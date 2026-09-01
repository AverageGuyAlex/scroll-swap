import { getStore } from '@netlify/blobs';

/* A V2 function (export default, Request in / Response out).

   It was a V1 one (exports.handler) until 2026-09-02, and that mattered: V1
   does NOT get Netlify Blobs configured for it, so this file used to need
   BLOBS_SITE_ID and a BLOBS_TOKEN personal access token set by hand. Those
   tokens expire, and when this one did every device lost sync at once with no
   code change and nothing in the repo to explain why. V2 configures Blobs
   itself, so there is no longer any credential here to go stale.

   All six functions in this folder are this same file with the store name and
   the empty-state default swapped. Change one and you almost certainly need to
   change all six; tests/functions-test.js runs every one of them. */
export default async (req, context) => {
  /* The 401 stays first, before anything touches the store. It is the only
     thing between a stranger and the data, and it deliberately says nothing
     about configuration — an unauthenticated caller must not be able to learn
     whether the site's credentials are set. */
  const user = context && context.clientContext && context.clientContext.user;
  if (!user) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const userKey = `user-${user.sub}`;

  try {
    /* Inside the try deliberately. getStore() throws when credentials are
       present but rejected, and it used to sit above it — so a bad credential
       crashed the whole function before the catch could report anything. */
    const store = getStore({ name: 'diary-data' });

    if (req.method === 'GET') {
      const data = await store.get(userKey, { type: 'json' });
      return Response.json(data || {});
    }

    if (req.method === 'POST') {
      const body = await req.json();
      await store.set(userKey, JSON.stringify(body));
      return Response.json({ ok: true });
    }

    return new Response('Method not allowed', { status: 405 });
  } catch (err) {
    /* err.name is the useful half: the Blobs SDK throws by name, which is
       otherwise indistinguishable from a network blip in the client's banner. */
    console.error('Blobs operation failed', err);
    return new Response(JSON.stringify({
      error: err.message || 'Server error',
      name: err.name || 'Error',
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
