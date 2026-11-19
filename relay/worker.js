// Chorus OAuth relay.
//
// GitHub will not swap an OAuth code for a token from a browser: its sign-in
// endpoints send no CORS headers, and the exchange needs the app's secret.
// This worker is that one missing piece. It does a single thing — takes a code
// from the page and returns a token — and it never stores anything.
//
// Deploy it, then set:
//   GITHUB_CLIENT_ID      from your OAuth App
//   GITHUB_CLIENT_SECRET  from your OAuth App (a Worker secret)
//   ALLOWED_ORIGIN        where Chorus is served, comma separated if several
//
// Nothing else here is secret handling beyond the one call to GitHub.

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export function allowedOrigins(env) {
  return String(env?.ALLOWED_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

const json = (body, status, headers) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

/** The whole relay: one POST in, one token out. */
export async function handle(request, env, fetchImpl = fetch) {
  const origins = allowedOrigins(env);
  const origin = request.headers.get('Origin') ?? '';
  if (!origins.includes(origin)) {
    return json({ error: 'origin_not_allowed', error_description: 'This page is not allowed to use this relay.' }, 403, corsHeaders(origins[0] ?? 'null'));
  }
  const headers = corsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, headers);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_request', error_description: 'Send JSON.' }, 400, headers); }
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  if (!code || code.length > 200) return json({ error: 'invalid_request', error_description: 'No code was sent.' }, 400, headers);

  const exchange = await fetchImpl(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: String(env?.GITHUB_CLIENT_ID ?? ''),
      client_secret: String(env?.GITHUB_CLIENT_SECRET ?? ''),
      code,
    }),
  }).catch(() => undefined);
  if (!exchange) return json({ error: 'relay_unreachable', error_description: 'GitHub could not be reached.' }, 502, headers);

  const data = await exchange.json().catch(() => ({}));
  if (!data?.access_token) {
    return json({
      error: data?.error || 'access_denied',
      error_description: data?.error_description || 'GitHub did not return a token.',
    }, 400, headers);
  }
  return json({ access_token: data.access_token, token_type: data.token_type ?? 'bearer', scope: data.scope }, 200, headers);
}

export default {
  fetch: (request, env) => handle(request, env),
};
