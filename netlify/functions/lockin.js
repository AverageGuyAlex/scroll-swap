const { getStore } = require('@netlify/blobs');

exports.handler = async (event, context) => {
  const user = context.clientContext && context.clientContext.user;

  if (!user) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Not authenticated' }),
    };
  }

  /* This is a legacy V1 function, so Blobs is NOT configured automatically the
     way it is for V2 functions — these two env vars are required, not optional.
     BLOBS_TOKEN is a Netlify personal access token, which can expire or be
     revoked, and when that happens every one of these six functions fails at
     once on every device with no code change. Naming the missing variable turns
     that from a mystery into an instruction. */
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  const missing = [];
  if (!siteID) missing.push('BLOBS_SITE_ID');
  if (!token) missing.push('BLOBS_TOKEN');
  if (missing.length) {
    console.error('Blobs not configured; missing: ' + missing.join(', '));
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Blobs not configured',
        missing,
        hint: 'Set these under Site configuration -> Environment variables, then redeploy.',
      }),
    };
  }

  const userKey = `user-${user.sub}`;

  try {
    /* Inside the try deliberately. getStore() throws when the credentials are
       present but rejected, and it used to sit outside — so that crashed the
       whole function before the catch below could report anything useful. */
    const store = getStore({ name: 'lockin-data', siteID, token });

    if (event.httpMethod === 'GET') {
      const data = await store.get(userKey, { type: 'json' });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data || { totalMinutes: 0 }),
      };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      await store.set(userKey, JSON.stringify(body));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      };
    }

    return { statusCode: 405, body: 'Method not allowed' };
  } catch (err) {
    /* err.name is the useful half: the Blobs SDK throws
       MissingBlobsEnvironmentError by name when configuration is wrong, which is
       otherwise indistinguishable from a network blip in the client's banner. */
    console.error('Blobs operation failed', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: err.message || 'Server error',
        name: err.name || 'Error',
      }),
    };
  }
};
