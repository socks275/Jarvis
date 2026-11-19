import { createServer } from 'node:http';
import { stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const contentTypes = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}));

export function staticSite(directory) {
  const root = resolve(directory);
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // strict-origin: only the origin is sent cross-site. YouTube rejects an
    // embed that arrives with no referrer at all (error 153).
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://static.invalid').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    try {
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + sep) || !contentTypes.has(extname(file))) throw new Error('Not found');
      const target = await realpath(file);
      if (!target.startsWith(root + sep)) throw new Error('Not found');
      const info = await stat(target);
      if (!info.isFile()) throw new Error('Not found');
      res.writeHead(200, {
        'Content-Type': contentTypes.get(extname(file)),
        'Content-Length': info.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') res.end();
      else await pipeline(createReadStream(target), res);
    } catch {
      if (!res.headersSent) res.writeHead(404).end('Not found');
      else res.destroy();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  staticSite(fileURLToPath(new URL('../dist/', import.meta.url))).listen(port, '0.0.0.0', () => {
    console.log(`Chorus Web listening on port ${port}`);
  });
}
