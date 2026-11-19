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

// --- reading a page -------------------------------------------------------

const readCall = (url, init = {}) => new Request(`https://relay.test/read?url=${encodeURIComponent(url)}`, {
  method: 'GET',
  headers: { Origin: 'https://example.com' },
  ...init,
});
const page = (body, type = 'text/html; charset=utf-8') => new Response(body, { headers: { 'Content-Type': type } });

test('reads a linked page and returns its words, not its markup', async () => {
  const html = '<html><head><title>Example &amp; Co</title><style>p{color:red}</style></head>'
    + '<body><script>alert(1)</script><h1>Hello</h1><p>First paragraph.</p><p>Second.</p></body></html>';
  let asked;
  const response = await handle(readCall('https://example.com/article'), env, async (url) => { asked = url; return page(html); });
  assert.equal(response.status, 200);
  assert.equal(asked, 'https://example.com/article');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://example.com');
  const data = await response.json();
  assert.equal(data.title, 'Example & Co');
  assert.match(data.text, /Hello/);
  assert.match(data.text, /First paragraph\./);
  assert.doesNotMatch(data.text, /alert|color:red|<p>/);
});

test('the reader refuses private hosts, odd schemes and non-pages', async () => {
  const never = async () => { throw new Error('must not be called'); };
  for (const url of ['http://localhost:8080/admin', 'http://192.168.0.1/', 'http://10.0.0.5/', 'file:///etc/passwd', 'ftp://example.com/x', 'http://metadata.internal/']) {
    const response = await handle(readCall(url), env, never);
    assert.equal(response.status, 400, url);
    assert.equal((await response.json()).error, 'invalid_url');
  }
  const pdf = await handle(readCall('https://example.com/a.pdf'), env, async () => page('%PDF', 'application/pdf'));
  assert.equal(pdf.status, 415);
  const broken = await handle(readCall('https://example.com/x'), env, async () => page('nope', 'text/html'), );
  assert.equal(broken.status, 200);
  const down = await handle(readCall('https://example.com/x'), env, async () => new Response('gone', { status: 404 }));
  assert.equal(down.status, 502);
});

test('the reader stays origin-locked and only answers GET', async () => {
  const wrong = await handle(new Request('https://relay.test/read?url=https%3A%2F%2Fexample.com', { headers: { Origin: 'https://evil.test' } }), env, async () => page('<p>x</p>'));
  assert.equal(wrong.status, 403);
  const post = await handle(readCall('https://example.com', { method: 'POST' }), env, async () => page('<p>x</p>'));
  assert.equal(post.status, 405);
  const preflight = await handle(readCall('https://example.com', { method: 'OPTIONS' }), env, async () => { throw new Error('must not be called'); });
  assert.equal(preflight.status, 204);
});
