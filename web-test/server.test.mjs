import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { staticSite } from '../scripts/serve-web.mjs';

test('preview serves static assets on proxy hosts and not files outside the site', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frenemy-serve-test-'));
  const root = join(dir, 'dist');
  await mkdir(root);
  await writeFile(join(root, 'index.html'), '<title>Chorus</title>');
  await writeFile(join(root, 'app.mjs'), 'export {};');
  await writeFile(join(root, 'engine.wasm'), new Uint8Array([0, 97, 115, 109]));
  await copyFile(new URL('../web/glass-spark-small.webp', import.meta.url), join(root, 'spark.webp'));
  await writeFile(join(dir, 'private.txt'), 'must not be served');
  const server = staticSite(root).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const home = await fetch(url, { headers: { Host: '3000-test.e2b.app' } });
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('x-frame-options'), null);
    // YouTube rejects embeds that arrive with no referrer (error 153).
    assert.equal(home.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.match(await home.text(), /Chorus/);
    const script = await fetch(`${url}/app.mjs`);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.equal(await script.text(), 'export {};');
    const wasm = await fetch(`${url}/engine.wasm`, { method: 'HEAD' });
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    assert.equal(wasm.headers.get('content-length'), '4');
    assert.equal(await wasm.text(), '');
    const artwork = await fetch(`${url}/spark.webp`);
    assert.equal(artwork.status, 200);
    assert.equal(artwork.headers.get('content-type'), 'image/webp');
    assert.equal(Buffer.from(await artwork.arrayBuffer()).toString('ascii', 8, 12), 'WEBP');
    for (const path of ['/..%2Fprivate.txt', '/private.txt', '/desktop/install.mjs', '/.git/config']) {
      const rejected = await fetch(`${url}${path}`);
      assert.equal(rejected.status, 404, path);
      await rejected.text();
    }
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
