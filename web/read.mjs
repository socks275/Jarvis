// Reading a page the person linked: fetch it through the relay (a browser
// cannot read another site's HTML directly), keep the words, drop everything else.

const MAX_TEXT = 6000;
const MAX_HTML = 400_000;

/** http(s) links in a message, newest first, without duplicates or trailing punctuation. */
export function findUrls(text, { limit = 3 } = {}) {
  const found = [];
  const pattern = /https?:\/\/[^\s<>"'`)\]]+/gi;
  for (const match of String(text ?? '').matchAll(pattern)) {
    const url = match[0].replace(/[.,;:!?*_]+$/, '');
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    if (!parsed.hostname.includes('.')) continue;
    // Model output often wraps a bare domain in Markdown; the path is what matters.
    const clean = parsed.toString();
    if (!found.includes(clean)) found.push(clean);
    if (found.length >= limit) break;
  }
  return found;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };

/** The readable part of an HTML page: its title, and its text without markup. */
export function readerText(html, { limit = MAX_TEXT } = {}) {
  const source = String(html ?? '').slice(0, MAX_HTML);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const text = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isSafeInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[name.toLowerCase()] ?? ' ';
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: decodeTitle(title), text: text.slice(0, limit) };
}

const decodeTitle = (value) => value.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isSafeInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
  }
  return ENTITIES[name.toLowerCase()] ?? ' ';
});

/** Fetches one page through the relay. Throws a sentence a person can read. */
export async function fetchPage({ relay, url, signal, fetchImpl = globalThis.fetch, timeout = 15_000 }) {
  const base = String(relay ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+/i.test(base)) throw new Error('Add your reader relay URL in Settings → Reading pages first.');
  const target = `${base}/read?url=${encodeURIComponent(url)}`;
  const connection = new AbortController();
  const stop = () => connection.abort(signal?.reason);
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => connection.abort(new Error('That page took too long to answer.')), timeout);
  try {
    const response = await fetchImpl(target, {
      headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'omit',
      referrerPolicy: 'no-referrer', redirect: 'error', signal: connection.signal,
    });
    const data = await response.json().catch(() => null);
    connection.signal.throwIfAborted();
    if (!response.ok) throw new Error(String(data?.error_description ?? 'That page could not be read.'));
    const text = typeof data?.text === 'string' ? data.text.trim() : '';
    if (!text) throw new Error('That page had no readable text.');
    const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    const title = typeof data?.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 200) : host;
    return { url, title, text: text.slice(0, MAX_TEXT) };
  } catch (error) {
    connection.signal.throwIfAborted();
    throw error instanceof Error ? error : new Error('That page could not be read.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

/** The context line a reply sees, or '' when nothing was read. */
export function sourceContext(pages) {
  const read = (pages ?? []).filter((page) => page?.text);
  if (!read.length) return '';
  return read.map((page) => `Source: ${page.title} <${page.url}>\n${page.text}`).join('\n\n---\n\n');
}
