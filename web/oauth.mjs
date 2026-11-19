// Real OAuth, as far as a static page can take it.
//
// GitHub's sign-in endpoints send no CORS headers (github/isaacs issue #330),
// so a browser cannot exchange an OAuth code for a token by itself: the
// exchange has to happen somewhere that is allowed to hold the client secret.
// That is what the relay is. It is a tiny function you deploy once; it does one
// thing — swap a code for a token — and Chorus talks to it and nothing else.
//
// With a relay configured the flow is ordinary OAuth:
//   authorize -> github.com -> back to this page with ?code -> relay -> token.

export const OAUTH_STATE_KEY = 'chorus-web:oauth:state';
export const GITHUB_SCOPES = 'repo read:user';

export function authorizeUrl({ clientId, redirectUri, state, scope = GITHUB_SCOPES }) {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', String(clientId).trim());
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

/** Finds an OAuth callback in a URL, or undefined when there isn't one. */
export function readCallback(href) {
  let url;
  try { url = new URL(String(href)); } catch { return undefined; }
  const code = url.searchParams.get('code');
  if (!code) return undefined;
  return { code, state: url.searchParams.get('state') ?? undefined, error: url.searchParams.get('error') ?? undefined };
}

/** The same URL without the OAuth parameters, so they don't linger in history. */
export function cleanUrl(href) {
  const url = new URL(String(href));
  for (const key of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Swaps the code for a token through the relay. Never invents a token: if the
 * relay or GitHub says no, the error goes straight to the caller.
 */
export async function redeemCode({ relay, code, fetchImpl = globalThis.fetch, signal }) {
  let response;
  try {
    response = await fetchImpl(String(relay).trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, provider: 'github' }),
      credentials: 'omit',
      signal,
    });
  } catch {
    throw new Error('The OAuth relay could not be reached. Check the relay URL, or paste a token instead.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    const reason = data?.error_description || data?.error || `status ${response.status}`;
    throw new Error(`The sign-in was refused: ${reason}`);
  }
  const token = data?.access_token ?? data?.token;
  if (typeof token !== 'string' || !token.trim()) throw new Error('The OAuth relay replied without a token.');
  return token.trim();
}
