// Chorus offline shell.
//
// The app is a handful of modules and two fonts, so it is cached whole: after
// the first visit it opens without a network. Pages and scripts are fetched
// first and fall back to the cache, so a deploy is picked up on the next load
// rather than being stuck behind a stale copy. Fonts, the WASM runtime and the
// WebAssembly model library never change between builds, so they are served
// from the cache and refreshed in the background.

const VERSION = 'chorus-v2';
const SHELL = [
  './', './index.html', './styles.css', './app.mjs', './chat.mjs', './community.mjs', './connectors.mjs',
  './engine.mjs', './accelerated.mjs', './webllm.worker.mjs', './vendor/webllm.mjs', './format.mjs', './game.mjs', './gguf.mjs', './oauth.mjs', './read.mjs', './youtube.mjs',
  './favicon.svg', './manifest.webmanifest', './glass-spark-small.webp', './glass-spark.webp',
  './fonts/manrope.woff2', './fonts/instrument-serif-italic.woff2', './fonts/jetbrains-mono.woff2',
];
const IMMUTABLE = /\.(?:woff2|wasm|webp|png|svg)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // One missing file must not stop the app from installing.
    await Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function networkFirst(request, cache) {
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw new Error('offline');
  }
}

async function cacheFirst(request, cache) {
  const cached = await cache.match(request);
  if (cached) {
    // Refresh quietly for the next visit.
    fetch(request).then((response) => { if (response.ok) cache.put(request, response.clone()); }).catch(() => {});
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only this app's own files: API calls and other sites are never cached.
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(new URL('./', self.location).pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    return IMMUTABLE.test(url.pathname) ? cacheFirst(request, cache) : networkFirst(request, cache);
  })());
});
