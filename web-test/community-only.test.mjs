import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the app offers community AI only and does not bundle local engines', async () => {
  const [html, app, build, pkg, sw] = await Promise.all([
    read('../web/index.html'), read('../web/app.mjs'), read('../scripts/build-web.mjs'),
    read('../package.json'), read('../web/sw.js'),
  ]);
  assert.match(html, /id="community-settings"/);
  assert.doesNotMatch(html, /id="(?:engine-options|local-settings|webllm-settings|chrome-settings|model-file)"/);
  assert.doesNotMatch(app, /browserEngine|webLLMEngine|chromeAIEngine|validateModel/);
  assert.doesNotMatch(build + pkg + sw, /wllama|web-llm|webllm|gguf/i);
  assert.match(sw, /chorus-v3/);
});
