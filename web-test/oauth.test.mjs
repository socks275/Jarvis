import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeUrl, cleanUrl, readCallback, redeemCode } from '../web/oauth.mjs';

test('builds a GitHub authorize URL with the state and redirect', () => {
  const url = new URL(authorizeUrl({ clientId: ' Iv1.abc ', redirectUri: 'https://example.com/Jarvis/', state: 'abc123' }));
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, '/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'Iv1.abc');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.com/Jarvis/');
  assert.equal(url.searchParams.get('state'), 'abc123');
  assert.equal(url.searchParams.get('scope'), 'repo read:user');
});

test('finds an OAuth callback and leaves other URLs alone', () => {
  assert.deepEqual(readCallback('https://example.com/Jarvis/?code=xyz&state=s1'), { code: 'xyz', state: 's1', error: undefined });
  assert.deepEqual(readCallback('https://example.com/Jarvis/?error=access_denied'), undefined);
  assert.deepEqual(readCallback('https://example.com/Jarvis/#chat/1'), undefined);
  assert.equal(readCallback('not a url'), undefined);
  assert.equal(cleanUrl('https://example.com/Jarvis/?code=xyz&state=s1#chat/1'), '/Jarvis/#chat/1');
  assert.equal(cleanUrl('https://example.com/Jarvis/?error=access_denied&error_description=no'), '/Jarvis/');
});

test('swaps the code through the relay and returns the token', async () => {
  const seen = [];
  const token = await redeemCode({ relay: ' https://relay.test/github ', code: 'xyz', fetchImpl: async (url, options) => {
    seen.push({ url, options });
    return Response.json({ access_token: 'gho_test' });
  } });
  assert.equal(token, 'gho_test');
  assert.equal(seen[0].url, 'https://relay.test/github');
  assert.equal(seen[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(seen[0].options.body), { code: 'xyz', provider: 'github' });
});

test('reports a refused sign-in instead of pretending it worked', async () => {
  await assert.rejects(() => redeemCode({ relay: 'https://relay.test', code: 'x', fetchImpl: async () => new Response('{}', { status: 400 }) }),
    /The sign-in was refused: status 400/);
  await assert.rejects(() => redeemCode({ relay: 'https://relay.test', code: 'x', fetchImpl: async () => Response.json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }) }),
    /The sign-in was refused: The code passed is incorrect or expired\./);
  await assert.rejects(() => redeemCode({ relay: 'https://relay.test', code: 'x', fetchImpl: async () => Response.json({ ok: true }) }),
    /without a token/);
  await assert.rejects(() => redeemCode({ relay: 'https://relay.test', code: 'x', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }),
    /relay could not be reached/);
});
