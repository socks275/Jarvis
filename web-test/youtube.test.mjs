import assert from 'node:assert/strict';
import { test } from 'node:test';
import { embedUrl, findVideo, playRequest, searchUrl, thumbnailUrl, youtubeId } from '../web/youtube.mjs';

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
  assert.deepEqual(playRequest('watch the video of a cat on YouTube'), { query: 'a cat' });
  assert.deepEqual(playRequest('play me some jazz'), { query: 'some jazz' });
  assert.equal(playRequest('what is YouTube'), undefined);
  assert.equal(playRequest('how do I play the piano'), undefined);
  assert.equal(playRequest('play'), undefined);
});

test('builds embed, thumbnail and search links', () => {
  assert.equal(embedUrl('dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&autoplay=1');
  assert.equal(embedUrl('dQw4w9WgXcQ', { auto: false }), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1');
  assert.equal(thumbnailUrl('dQw4w9WgXcQ'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(searchUrl('lofi hip hop'), 'https://www.youtube.com/results?search_query=lofi%20hip%20hop');
});

test('finds the top result only when a key is supplied', async () => {
  assert.equal(await findVideo('lofi'), undefined);
  let called;
  const found = await findVideo('lofi hip hop', { key: 'KEY', fetchImpl: async (url) => {
    called = url;
    return Response.json({ items: [{ id: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'Lofi beats' } }] });
  } });
  assert.match(called, /^https:\/\/www\.googleapis\.com\/youtube\/v3\/search\?part=snippet&type=video/);
  assert.match(called, /key=KEY/);
  assert.match(called, /q=lofi%20hip%20hop/);
  assert.deepEqual(found, { id: 'dQw4w9WgXcQ', title: 'Lofi beats' });
  await assert.rejects(findVideo('x', { key: 'K', fetchImpl: async () => new Response('nope', { status: 403 }) }), /403/);
});
