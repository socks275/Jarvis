import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { staticSite } from '../scripts/serve-web.mjs';

test('preview serves static assets on proxy hosts and not files outside the site', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frenemy-serve-test-'));
  const root = join(dir, 'dist');
  await mkdir(root);
  await writeFile(join(root, 'index.html'), '<title>Frenemy</title>');
  await writeFile(join(root, 'app.mjs'), 'export {};');
  await writeFile(join(root, 'engine.wasm'), new Uint8Array([0, 97, 115, 109]));
  await writeFile(join(dir, 'private.txt'), 'must not be served');
  const server = staticSite(root).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const home = await fetch(url, { headers: { Host: '3000-test.e2b.app' } });
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('x-frame-options'), null);
    assert.match(await home.text(), /Frenemy/);
    const script = await fetch(`${url}/app.mjs`);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.equal(await script.text(), 'export {};');
    const wasm = await fetch(`${url}/engine.wasm`, { method: 'HEAD' });
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    assert.equal(wasm.headers.get('content-length'), '4');
    assert.equal(await wasm.text(), '');
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
