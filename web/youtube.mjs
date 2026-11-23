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
  if (/^(?:please\s+)?(?:play|watch|put on|start)\s+(?:me\s+)?(?:another(?:\s+(?:one|video|song|short))?|the next(?:\s+(?:one|video|song|short))?|next(?:\s+(?:one|video|song|short))?)[.!?\s]*$/i.test(value)) return { another: true };
  if (/\bshorts\b/i.test(value)) {
    const topic = value.replace(PLAY, '').replace(/\b(?:on|in|from)\s+youtube\b/gi, '').replace(/\bshorts\b/gi, ' ')
      .replace(/^\s*(?:(?:me|us)\s+)?(?:(?:some|a few|the)\s+)?(?:about\s+|of\s+)?/i, '')
      .replace(/^[\s:,-]+|[\s.!?,-]+$/g, '').replace(/\s+/g, ' ').trim();
    return { query: topic ? `${topic.slice(0, 193)} shorts` : 'short videos', shorts: true };
  }
  const rest = value
    .replace(PLAY, '')
    .replace(/\b(?:on|in|from)\s+youtube\b/gi, '')
    .replace(/^\s*(?:the\s+)?(?:video|song|music|clip|track)\s+(?:of|by|called|named|for)\s+/i, '')
    .replace(/^\s*(?:me|us)\s+/i, '')
    .replace(/^[\s:,-]+|[\s.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!rest) return undefined;
  return { query: tidy(rest).slice(0, 200) };
}

/** Resolve a follow-up against this chat's earlier video cards, never another chat. */
export function resolveAnother(videos) {
  const previous = [...(videos ?? [])].reverse().find((video) => video && (video.id || video.query || video.items?.length));
  if (!previous) return undefined;
  const query = previous.query || previous.title || previous.items?.[0]?.title;
  if (!query) return undefined;
  return { query: query.slice(0, 200), ...(previous.shorts ? { shorts: true } : {}), another: true };
}

export function videoIds(videos) {
  return [...new Set((videos ?? []).flatMap((video) => [video?.id, ...(video?.items ?? []).map((item) => item.id)]).filter((id) => VIDEO_ID.test(String(id ?? ''))))].slice(-60);
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
// The no-cookie player. youtube-nocookie.com stores nothing until someone
// presses play, and it only ever receives this site's origin, never the chat.
// `modestbranding` is deprecated, and `playsinline` stops iOS hijacking the
// player into full screen.
export const PLAYER_ORIGIN = 'https://www.youtube-nocookie.com';
export const embedUrl = (id, { auto = true } = {}) => `${PLAYER_ORIGIN}/embed/${id}`
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

// A list is needed for "another" and for a scrollable feed. Public search
// front-ends do not prove that a video is a YouTube Short or portrait-shaped;
// only known, positive durations up to a minute count as short-form here.
function fromInvidious(data) {
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    const id = item?.videoId;
    if (typeof id !== 'string' || !VIDEO_ID.test(id) || item.type && item.type !== 'video') return [];
    const title = typeof item.title === 'string' ? item.title.slice(0, 200) : undefined;
    return [{ id, ...(title ? { title } : {}), duration: item.lengthSeconds }];
  });
}

function fromPiped(data) {
  if (!Array.isArray(data?.items)) return [];
  return data.items.flatMap((item) => {
    const id = /(?:v=|\/)([\w-]{11})(?:[&?]|$)/.exec(String(item?.url ?? ''))?.[1];
    if (!id || !VIDEO_ID.test(id) || item.type && item.type !== 'stream') return [];
    const title = typeof item.title === 'string' ? item.title.slice(0, 200) : undefined;
    return [{ id, ...(title ? { title } : {}), duration: item.duration }];
  });
}

async function ask(instance, query, fetchImpl, signal, { shorts, exclude, limit }) {
  const response = await fetchImpl(instance.url + encodeURIComponent(query), {
    signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
  });
  if (!response.ok) return [];
  const data = await response.json();
  const items = instance.kind === 'piped' ? fromPiped(data) : fromInvidious(data);
  const seen = new Set(exclude);
  return items.filter((item) => {
    if (seen.has(item.id) || (shorts && (!Number.isFinite(item.duration) || item.duration <= 0 || item.duration > 60))) return false;
    seen.add(item.id);
    return true;
  }).slice(0, limit).map(({ id, title }) => ({ id, ...(title ? { title } : {}) }));
}

/** Returns a bounded batch from the first search instance with usable results. */
export async function searchVideos(query, { fetchImpl = globalThis.fetch, signal, instances = INSTANCES, timeout = SEARCH_TIMEOUT, shorts = false, exclude = [], limit = 12 } = {}) {
  const clean = String(query ?? '').trim();
  if (!clean || !instances.length || signal?.aborted) return [];
  const ordered = preferred ? [...instances].sort((a, b) => Number(b.url === preferred) - Number(a.url === preferred)) : instances;
  const controller = new AbortController();
  const max = Math.max(1, Math.min(12, Number.isFinite(limit) ? Math.floor(limit) : 12));
  let timer;
  let stop;
  try {
    return await new Promise((resolve) => {
      let open = ordered.length, settled = false;
      const finish = (items) => {
        if (settled) return;
        settled = true;
        controller.abort();
        resolve(items);
      };
      stop = () => finish([]);
      signal?.addEventListener('abort', stop, { once: true });
      timer = setTimeout(stop, timeout);
      if (signal?.aborted) { stop(); return; }
      for (const instance of ordered) {
        ask(instance, clean, fetchImpl, controller.signal, { shorts, exclude, limit: max })
          .then((found) => { if (found.length && !settled) { preferred = instance.url; finish(found); } })
          .catch(() => {})
          .finally(() => { if (--open === 0) finish([]); });
      }
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (stop) signal?.removeEventListener('abort', stop);
  }
}

export async function searchVideo(query, options = {}) {
  return (await searchVideos(query, { ...options, limit: 1 }))[0];
}
