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

test('recognises another and short-video requests without mistaking specific titles for next', async () => {
  assert.deepEqual(playRequest('play another'), { another: true });
  assert.deepEqual(playRequest('please play another one'), { another: true });
  assert.deepEqual(playRequest('play the next video'), { another: true });
  assert.deepEqual(playRequest('play another song by Adele'), { query: 'another song by Adele' });
  assert.deepEqual(playRequest('play some shorts'), { query: 'short videos', shorts: true });
  assert.deepEqual(playRequest('play some shorts about cats'), { query: 'cats shorts', shorts: true });
  assert.deepEqual(playRequest('play funny cat shorts on youtube'), { query: 'funny cat shorts', shorts: true });
  const { resolveAnother, videoIds } = await import('../web/youtube.mjs');
  assert.equal(resolveAnother([]), undefined);
  assert.equal(resolveAnother([{ id: 'dQw4w9WgXcQ' }]), undefined);
  assert.deepEqual(resolveAnother([{ query: 'jazz', id: 'dQw4w9WgXcQ' }]), { query: 'jazz', another: true });
  assert.deepEqual(resolveAnother([{ query: 'cat shorts', shorts: true, items: [{ id: 'aaaaaaaaaaa' }] }]), { query: 'cat shorts', shorts: true, another: true });
  assert.deepEqual(videoIds([{ id: 'dQw4w9WgXcQ' }, { items: [{ id: 'aaaaaaaaaaa' }, { id: 'dQw4w9WgXcQ' }] }]), ['dQw4w9WgXcQ', 'aaaaaaaaaaa']);
});

test('another result skips previously shown ids and short search only includes known short durations', async () => {
  const { searchVideos } = await import('../web/youtube.mjs');
  const instances = [{ kind: 'invidious', url: 'https://a.test/?q=' }];
  const options = { instances, fetchImpl: async () => Response.json([
    { type: 'video', videoId: 'aaaaaaaaaaa', title: 'old', lengthSeconds: 20 },
    { type: 'video', videoId: 'bbbbbbbbbbb', title: 'new', lengthSeconds: 59 },
    { type: 'video', videoId: 'bbbbbbbbbbb', title: 'duplicate', lengthSeconds: 59 },
    { type: 'video', videoId: 'ccccccccccc', title: 'long', lengthSeconds: 200 },
    { type: 'video', videoId: 'ddddddddddd', title: 'unknown' },
    { type: 'channel', videoId: 'eeeeeeeeeee', title: 'channel', lengthSeconds: 5 },
  ]) };
  assert.deepEqual(await searchVideos('cats', { ...options, exclude: ['aaaaaaaaaaa'], limit: 1 }), [{ id: 'bbbbbbbbbbb', title: 'new' }]);
  assert.deepEqual(await searchVideos('cats', { ...options, shorts: true, exclude: ['aaaaaaaaaaa'] }), [{ id: 'bbbbbbbbbbb', title: 'new' }]);
});

test('shorts search understands Piped durations and ignores unknown, live or long videos', async () => {
  const { searchVideos } = await import('../web/youtube.mjs');
  const results = await searchVideos('cats shorts', { shorts: true, instances: [{ kind: 'piped', url: 'https://a.test/?q=' }], fetchImpl: async () => Response.json({ items: [
    { type: 'stream', url: '/watch?v=aaaaaaaaaaa', duration: 22, title: 'short' },
    { type: 'stream', url: '/watch?v=bbbbbbbbbbb', duration: -1, title: 'live' },
    { type: 'stream', url: '/watch?v=ccccccccccc', duration: 120, title: 'long' },
  ] }) });
  assert.deepEqual(results, [{ id: 'aaaaaaaaaaa', title: 'short' }]);
});

test('search stops at timeout and abort even if a front-end ignores cancellation', async () => {
  const { searchVideos } = await import('../web/youtube.mjs');
  const options = { instances: [{ kind: 'invidious', url: 'https://stuck.test/?q=' }], fetchImpl: () => new Promise(() => {}), timeout: 20 };
  assert.deepEqual(await searchVideos('cats', options), []);
  const controller = new AbortController();
  const result = searchVideos('cats', { ...options, signal: controller.signal, timeout: 2000 });
  controller.abort();
  assert.deepEqual(await result, []);
});
