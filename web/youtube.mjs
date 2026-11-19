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
  const rest = value
    .replace(PLAY, '')
    .replace(/\b(?:on|in|from)\s+youtube\b/gi, '')
    .replace(/^\s*(?:the\s+)?(?:video|song|music|clip|track)\s+(?:of|by|called|named|for)\s+/i, '')
    .replace(/^\s*(?:me|us)\s+/i, '')
    .replace(/^[\s:,-]+|[\s.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!rest) return undefined;
  return { query: tidy(rest) };
}

// People wrap a title in filler: "a jettism video" is really a search for
// "jettism". Dropping the filler finds the video far more often, and the plain
// phrase is kept whenever nothing would be left.
function tidy(value) {
  let text = value;
  for (let pass = 0; pass < 2; pass += 1) {
    text = text
      .replace(/^(?:a|an|the)\s+/i, '')
      .replace(/[\s,]+(?:video|clip|song|track)$/i, '')
      .trim();
  }
  return text || value;
}

export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
export const thumbnailUrl = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
export const searchUrl = (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
// The plain embed parameters YouTube documents today. `modestbranding` is
// deprecated, and `playsinline` keeps iOS from hijacking the player full screen.
export const embedUrl = (id, { auto = true } = {}) => `https://www.youtube-nocookie.com/embed/${id}`
  + `?rel=0&playsinline=1${auto ? '&autoplay=1' : ''}`;

// Public front-ends that answer a search without an account or an API key.
// Each one is tried in turn and the first usable answer wins.
// Public front-ends that answer a search without an account or an API key.
// They are asked at the same time and the first usable answer wins, so a slow
// or retired instance never holds up the reply. Keep this list in step with
// the connect-src list in web/index.html.
const INSTANCES = [
  { kind: 'invidious', url: 'https://inv.nadeko.net/api/v1/search?type=video&q=' },
  { kind: 'invidious', url: 'https://yewtu.be/api/v1/search?type=video&q=' },
  { kind: 'invidious', url: 'https://invidious.nerdvpn.de/api/v1/search?type=video&q=' },
  { kind: 'invidious', url: 'https://inv.tux.pizza/api/v1/search?type=video&q=' },
  { kind: 'piped', url: 'https://pipedapi.adminforge.de/search?filter=videos&q=' },
  { kind: 'piped', url: 'https://pipedapi.kavin.rocks/search?filter=videos&q=' },
  { kind: 'piped', url: 'https://api.piped.private.coffee/search?filter=videos&q=' },
  { kind: 'piped', url: 'https://pipedapi.reallyaweso.me/search?filter=videos&q=' },
];
const SEARCH_TIMEOUT = 6000;
const VIDEO_ID = /^[\w-]{11}$/;

// Whichever instance answered last is tried first next time.
let preferred;

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

async function ask(instance, query, fetchImpl, signal) {
  const response = await fetchImpl(instance.url + encodeURIComponent(query), {
    signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
  });
  if (!response.ok) return undefined;
  const data = await response.json();
  return instance.kind === 'piped' ? fromPiped(data) : fromInvidious(data);
}

/**
 * Finds the first video for a description using public front-ends, so no API
 * key is needed. Every instance is asked at once and the quickest usable answer
 * wins. Returns undefined only when none of them answer, and the page then
 * offers a plain YouTube search instead.
 */
export async function searchVideo(query, { fetchImpl = globalThis.fetch, signal, instances = INSTANCES, timeout = SEARCH_TIMEOUT } = {}) {
  const clean = String(query ?? '').trim();
  if (!clean || !instances.length || signal?.aborted) return undefined;
  const ordered = preferred
    ? [...instances].sort((a, b) => Number(b.url === preferred) - Number(a.url === preferred))
    : instances;
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timeout);
  try {
    return await new Promise((resolve) => {
      let open = ordered.length;
      for (const instance of ordered) {
        ask(instance, clean, fetchImpl, controller.signal)
          .then((found) => {
            if (!found) return;
            preferred = instance.url;
            resolve(found);
          })
          .catch(() => { /* a failed instance is simply skipped */ })
          .finally(() => {
            open -= 1;
            if (open === 0) resolve(undefined);
          });
      }
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', stop);
  }
}
