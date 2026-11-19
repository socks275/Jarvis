import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPage, findUrls, readerText, sourceContext } from '../web/read.mjs';

test('finds the links in a message, newest first, without duplicates or trailing punctuation', () => {
  assert.deepEqual(findUrls('Is this right? https://example.com/a, and (https://example.org/b).'), [
    'https://example.com/a', 'https://example.org/b',
  ]);
  assert.deepEqual(findUrls('https://example.com/x https://example.com/x again'), ['https://example.com/x']);
  assert.deepEqual(findUrls('no links here, just example.com'), []);
  assert.deepEqual(findUrls('javascript:alert(1) http://localhost/x https://a.b/c/d?e=1#f'), ['https://a.b/c/d?e=1#f']);
  assert.deepEqual(findUrls('https://a.b/1 https://a.b/2 https://a.b/3 https://a.b/4', { limit: 2 }), ['https://a.b/1', 'https://a.b/2']);
  assert.deepEqual(findUrls(undefined), []);
});

test('reader text keeps the words and drops scripts, styles and markup', () => {
  const { title, text } = readerText('<html><head><title>  A &amp; B </title><style>x{}</style></head>'
    + '<body><!-- note --><script>evil()</script><h1>Head</h1><p>One</p><p>Two&nbsp;&mdash; three</p></body></html>');
  assert.equal(title, 'A & B');
  assert.match(text, /^Head/);
  assert.match(text, /One\nTwo — three/);
  assert.doesNotMatch(text, /evil|x\{\}|<|>/);
  assert.equal(readerText('').text, '');
  assert.equal(readerText('<p>' + 'x'.repeat(10_000) + '</p>', { limit: 100 }).text.length, 100);
});

test('a page is fetched through the relay and a readable sentence comes back when it fails', async () => {
  const seen = [];
  const page = await fetchPage({
    relay: 'https://relay.example/', url: 'https://example.com/a',
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return Response.json({ url: 'https://example.com/a', title: 'A page', text: 'Some words.' });
    },
  });
  assert.equal(seen[0].url, 'https://relay.example/read?url=https%3A%2F%2Fexample.com%2Fa');
  assert.deepEqual(page, { url: 'https://example.com/a', title: 'A page', text: 'Some words.' });
  assert.equal(sourceContext([page]), 'Source: A page <https://example.com/a>\nSome words.');

  await assert.rejects(fetchPage({ relay: '', url: 'https://example.com' }), /reader relay URL in Settings/);
  await assert.rejects(fetchPage({
    relay: 'https://relay.example', url: 'https://example.com',
    fetchImpl: async () => Response.json({ error: 'unreachable', error_description: 'That page answered 404.' }, { status: 502 }),
  }), /That page answered 404\./);
  await assert.rejects(fetchPage({
    relay: 'https://relay.example', url: 'https://example.com',
    fetchImpl: async () => Response.json({ text: '   ' }),
  }), /no readable text/);
});

test('a reply sees one source block per page, and nothing when nothing was read', () => {
  assert.equal(sourceContext([]), '');
  assert.equal(sourceContext([{ text: '' }]), '');
  const two = sourceContext([
    { title: 'One', url: 'https://a.b/1', text: 'first' },
    { title: 'Two', url: 'https://a.b/2', text: 'second' },
  ]);
  assert.match(two, /Source: One <https:\/\/a\.b\/1>\nfirst/);
  assert.match(two, /Source: Two <https:\/\/a\.b\/2>\nsecond/);
});
