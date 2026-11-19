import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedOrigins, handle } from '../relay/worker.js';

const env = {
  GITHUB_CLIENT_ID: 'Iv1.abc',
  GITHUB_CLIENT_SECRET: 'shh',
  ALLOWED_ORIGIN: 'https://example.com, https://staging.example.com',
};
const call = (init = {}) => new Request('https://relay.test/github', {
  method: 'POST',
  headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: 'the-code' }),
  ...init,
});

test('reads more than one allowed origin', () => {
  assert.deepEqual(allowedOrigins(env), ['https://example.com', 'https://staging.example.com']);
  assert.deepEqual(allowedOrigins({}), []);
});

test('turns a code into a token and echoes the origin', async () => {
  const seen = [];
  const response = await handle(call(), env, async (url, options) => {
    seen.push({ url, body: options.body.toString() });
    return Response.json({ access_token: 'gho_test', token_type: 'bearer', scope: 'repo' });
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://example.com');
  assert.deepEqual(await response.json(), { access_token: 'gho_test', token_type: 'bearer', scope: 'repo' });
  assert.equal(seen[0].url, 'https://github.com/login/oauth/access_token');
  const sent = new URLSearchParams(seen[0].body);
  assert.equal(sent.get('client_id'), 'Iv1.abc');
  assert.equal(sent.get('client_secret'), 'shh');
  assert.equal(sent.get('code'), 'the-code');
});

test('answers a preflight without calling GitHub', async () => {
  const response = await handle(call({ method: 'OPTIONS', body: undefined }), env, async () => {
    throw new Error('must not be called');
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'content-type');
});

test('refuses another site, another method and a missing code', async () => {
  const stranger = await handle(call({ headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' } }), env, async () => {
    throw new Error('must not be called');
  });
  assert.equal(stranger.status, 403);
  const wrongMethod = await handle(call({ method: 'GET', body: undefined }), env, async () => new Response('{}'));
  assert.equal(wrongMethod.status, 405);
  const noCode = await handle(call({ body: JSON.stringify({}) }), env, async () => new Response('{}'));
  assert.equal(noCode.status, 400);
});

test('passes a refusal through in words the page can show', async () => {
  const response = await handle(call(), env, async () => Response.json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
  const offline = await handle(call(), env, async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(offline.status, 502);
});
