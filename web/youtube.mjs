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

// Public front-ends that answer a search without an account or an API key.
// Each one is tried in turn and the first usable answer wins.
const INSTANCES = [
  { kind: 'invidious', url: 'https://inv.nadeko.net/api/v1/search?type=video&q=' },
  { kind: 'piped', url: 'https://pipedapi.adminforge.de/search?filter=videos&q=' },
  { kind: 'invidious', url: 'https://yewtu.be/api/v1/search?type=video&q=' },
];
const SEARCH_TIMEOUT = 6000;
const VIDEO_ID = /^[\w-]{11}$/;

function fromInvidious(data) {
  if (!Array.isArray(data)) return undefined;
  for (const item of data) {
    const id = item?.videoId;
    if (typeof id !== 'string' || !VIDEO_ID.test(id)) continue;
    const title = typeof item.title === 'string' ? item.title.slice(0, 200) : undefined;
    return { id, ...(title ? { title } : {}) };
  }
  return undefined;
}

function fromPiped(data) {
  const items = data?.items;
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    const id = /(?:v=|\/)([\w-]{11})(?:[&?]|$)/.exec(String(item?.url ?? ''))?.[1];
    if (!id || !VIDEO_ID.test(id)) continue;
    const title = typeof item.title === 'string' ? item.title.slice(0, 200) : undefined;
    return { id, ...(title ? { title } : {}) };
  }
  return undefined;
}

/**
 * Finds the first video for a description using public front-ends, so no API
 * key is needed. Returns undefined when every instance is unavailable, and the
 * page then offers a plain YouTube search instead.
 */
export async function searchVideo(query, { fetchImpl = globalThis.fetch, signal, instances = INSTANCES, timeout = SEARCH_TIMEOUT } = {}) {
  const clean = String(query ?? '').trim();
  if (!clean) return undefined;
  for (const instance of instances) {
    if (signal?.aborted) return undefined;
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(instance.url + encodeURIComponent(clean), {
        signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
      });
      if (!response.ok) continue;
      const found = instance.kind === 'piped' ? fromPiped(await response.json()) : fromInvidious(await response.json());
      if (found) return found;
    } catch { /* an instance that fails or times out is simply skipped */ }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }
  return undefined;
}
