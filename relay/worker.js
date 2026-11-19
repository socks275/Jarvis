// Chorus OAuth relay.
//
// GitHub will not swap an OAuth code for a token from a browser: its sign-in
// endpoints send no CORS headers, and the exchange needs the app's secret.
// This worker is that one missing piece. It does two things — takes a code from
// the page and returns a token, and reads a public page the person linked —
// and it never stores anything.
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

export function corsHeaders(origin, methods = 'POST, OPTIONS') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

const json = (body, status, headers) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

const READ_TIMEOUT = 12_000;
const MAX_BYTES = 400_000;
const MAX_TEXT = 12_000;

/** Hosts a relay must never be asked to fetch: anything pointing back inside. */
export function isPublicUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.length > 200) return false;
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/.test(host)) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  if (host.startsWith('[') || host.includes(':')) return false;
  return true;
}

const strip = (html) => String(html)
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/[ \t]+/g, ' ')
  .replace(/\s*\n\s*/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim()
  .slice(0, MAX_TEXT);

/**
 * Reads a page for the app: the same origin rules, no storage, no secrets.
 * The browser cannot fetch another site's HTML itself, which is the only
 * reason this endpoint exists.
 */
export async function handleRead(request, env, fetchImpl = fetch) {
  const origins = allowedOrigins(env);
  const origin = request.headers.get('Origin') ?? '';
  if (!origins.includes(origin)) {
    return json({ error: 'origin_not_allowed', error_description: 'This page is not allowed to use this relay.' }, 403, corsHeaders(origins[0] ?? 'null', 'GET, OPTIONS'));
  }
  const headers = corsHeaders(origin, 'GET, OPTIONS');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, headers);
  const target = new URL(request.url).searchParams.get('url') ?? '';
  if (!isPublicUrl(target)) return json({ error: 'invalid_url', error_description: 'Only public http and https pages can be read.' }, 400, headers);

  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), READ_TIMEOUT);
  try {
    const page = await fetchImpl(target, {
      signal: stop.signal, redirect: 'follow',
      headers: { Accept: 'text/html,text/plain;q=0.9', 'User-Agent': 'ChorusReader/1.0' },
    });
    if (!page.ok) return json({ error: 'unreachable', error_description: `That page answered ${page.status}.` }, 502, headers);
    const type = page.headers.get('Content-Type') ?? '';
    if (!/^(text\/html|text\/plain|application\/xhtml)/i.test(type)) {
      return json({ error: 'unsupported_type', error_description: 'That link is not a web page.' }, 415, headers);
    }
    const buffer = await page.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES * 8) return json({ error: 'too_large', error_description: 'That page is too large to read.' }, 413, headers);
    const html = new TextDecoder().decode(buffer.slice(0, MAX_BYTES));
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
    return json({ url: target, title: strip(title).slice(0, 200), text: strip(html) }, 200, headers);
  } catch {
    return json({ error: 'unreachable', error_description: 'That page could not be reached.' }, 502, headers);
  } finally {
    clearTimeout(timer);
  }
}

/** The whole relay: a token exchange and a page reader, both origin-locked. */
export async function handle(request, env, fetchImpl = fetch) {
  if (new URL(request.url).pathname.replace(/\/+$/, '').endsWith('/read')) return handleRead(request, env, fetchImpl);
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
