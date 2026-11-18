// Reading a play request and building the links a player needs. No API key is
// required for URLs, thumbnails or the embed itself.

const LINK_PATTERNS = [
  /youtu\.be\/([\w-]{11})/i,
  /youtube(?:-nocookie)?\.com\/watch\?(?:[^#]*&)?v=([\w-]{11})/i,
  /youtube(?:-nocookie)?\.com\/(?:shorts|embed|live|v)\/([\w-]{11})/i,
];
const PLAY = /^(?:please\s+)?(?:play|watch|put on|start)\b/i;

export function youtubeId(text) {
  const value = String(text ?? '');
  for (const pattern of LINK_PATTERNS) {
    const found = pattern.exec(value);
    if (found) return found[1];
  }
  return undefined;
}

/**
 * Understands "play <link>", "play <something>" and "watch <something> on YouTube".
 * Returns undefined when the message is not a request to play anything.
 */
export function playRequest(text) {
  const value = String(text ?? '').trim();
  if (!value) return undefined;
  if (!PLAY.test(value)) return undefined;
  const id = youtubeId(value);
  if (id) return { id };
  const query = value
    .replace(PLAY, '')
    .replace(/\b(?:on|in|from)\s+youtube\b/gi, '')
    .replace(/^\s*(?:the\s+)?(?:video|song|music|clip|track)\s+(?:of|by|called|named)\s+/i, '')
    .replace(/^\s*(?:me|us)\s+/i, '')
    .replace(/^[\s:,-]+|[\s.!?]+$/g, '')
    .trim();
  if (!query) return undefined;
  return { query };
}

export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
export const thumbnailUrl = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
export const searchUrl = (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
export const embedUrl = (id, { auto = true } = {}) => `https://www.youtube-nocookie.com/embed/${id}`
  + `?rel=0&modestbranding=1${auto ? '&autoplay=1' : ''}`;

/**
 * Looks up the top result with the official API when the reader has supplied a
 * key. Without a key the page falls back to a search link, so nothing breaks.
 */
export async function findVideo(query, { key, fetchImpl = globalThis.fetch, signal } = {}) {
  if (!key || !query) return undefined;
  const url = 'https://www.googleapis.com/youtube/v3/search'
    + `?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`;
  const response = await fetchImpl(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  if (!response.ok) throw new Error(`YouTube search failed (${response.status}).`);
  const data = await response.json();
  const item = data?.items?.[0];
  const id = item?.id?.videoId;
  if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) return undefined;
  const title = typeof item?.snippet?.title === 'string' ? item.snippet.title.slice(0, 200) : undefined;
  return { id, title };
}
