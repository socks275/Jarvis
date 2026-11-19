import assert from 'node:assert/strict';
import { test } from 'node:test';
import { embedUrl, playRequest, searchUrl, searchVideo, thumbnailUrl, youtubeId } from '../web/youtube.mjs';

test('reads a video id from every common YouTube link', () => {
  assert.equal(youtubeId('play https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ?t=42'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://example.com/watch?v=dQw4w9WgXcQ'), undefined);
  assert.equal(youtubeId('no link here'), undefined);
});

test('only play requests are treated as play requests', () => {
  assert.deepEqual(playRequest('play https://youtu.be/dQw4w9WgXcQ'), { id: 'dQw4w9WgXcQ' });
  assert.deepEqual(playRequest('Play lofi hip hop'), { query: 'lofi hip hop' });
  assert.deepEqual(playRequest('watch the video of a cat on YouTube'), { query: 'cat' });
  assert.deepEqual(playRequest('play a jettism video'), { query: 'jettism' });
  assert.deepEqual(playRequest('play me some jazz'), { query: 'some jazz' });
  assert.equal(playRequest('what is YouTube'), undefined);
  assert.equal(playRequest('how do I play the piano'), undefined);
  assert.equal(playRequest('play'), undefined);
});

test('asks every instance at once and keeps the plain phrase when it can', async () => {
  const seen = [];
  const instances = [
    { kind: 'invidious', url: 'https://slow.test/?q=' },
    { kind: 'invidious', url: 'https://gone.test/?q=' },
    { kind: 'piped', url: 'https://fast.test/?q=' },
  ];
  const found = await searchVideo('a jettism video', { instances, fetchImpl: async (url) => {
    seen.push(url);
    if (url.startsWith('https://gone.test')) throw new Error('offline');
    if (url.startsWith('https://slow.test')) await new Promise((done) => setTimeout(done, 50));
    return url.startsWith('https://slow.test')
      ? Response.json([{ videoId: 'aaaaaaaaaaa', title: 'Slow' }])
      : Response.json({ items: [{ url: '/watch?v=dQw4w9WgXcQ', title: 'Fast' }] });
  } });
  assert.deepEqual(found, { id: 'dQw4w9WgXcQ', title: 'Fast' });
  assert.equal(seen.length, 3);
});

test('the player is the no-cookie one, on youtube-nocookie.com', () => {
  const url = new URL(embedUrl('dQw4w9WgXcQ'));
  assert.equal(url.origin, 'https://www.youtube-nocookie.com');
  assert.equal(url.pathname, '/embed/dQw4w9WgXcQ');
  assert.ok(!embedUrl('dQw4w9WgXcQ').includes('://www.youtube.com/embed'));
});

test('builds embed, thumbnail and search links', () => {
  assert.equal(embedUrl('dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&playsinline=1&autoplay=1');
  assert.equal(embedUrl('dQw4w9WgXcQ', { auto: false }), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&playsinline=1');
  assert.equal(thumbnailUrl('dQw4w9WgXcQ'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(searchUrl('lofi hip hop'), 'https://www.youtube.com/results?search_query=lofi%20hip%20hop');
});

test('finds a video through public instances without any key', async () => {
  const seen = [];
  const found = await searchVideo('lofi hip hop', { instances: [{ kind: 'invidious', url: 'https://a.test/s?q=' }], fetchImpl: async (url) => {
    seen.push(url);
    return Response.json([{ videoId: 'dQw4w9WgXcQ', title: 'Lofi beats' }, { videoId: 'aaaaaaaaaaa', title: 'Other' }]);
  } });
  assert.deepEqual(seen, ['https://a.test/s?q=lofi%20hip%20hop']);
  assert.deepEqual(found, { id: 'dQw4w9WgXcQ', title: 'Lofi beats' });
});

test('falls through broken instances and piped responses', async () => {
  const instances = [{ kind: 'invidious', url: 'https://down.test/?q=' }, { kind: 'piped', url: 'https://up.test/?q=' }];
  const found = await searchVideo('jazz', { instances, fetchImpl: async (url) => {
    if (url.startsWith('https://down.test')) throw new Error('offline');
    return Response.json({ items: [{ url: '/watch?v=dQw4w9WgXcQ', title: 'Jazz' }] });
  } });
  assert.deepEqual(found, { id: 'dQw4w9WgXcQ', title: 'Jazz' });
  assert.equal(await searchVideo('jazz', { instances, fetchImpl: async () => Response.json({ nope: true }) }), undefined);
  assert.equal(await searchVideo('   ', { instances: [] }), undefined);
});
