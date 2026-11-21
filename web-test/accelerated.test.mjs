import test from 'node:test';
import assert from 'node:assert/strict';
import { chromeAIEngine, webLLMEngine, WEBLLM_MODELS, disposeWebLLM } from '../web/accelerated.mjs';
import { createChat, newTurn, conversationContext, readChats, saveChats } from '../web/chat.mjs';

test('Chrome Prompt API streams, sends instructions, and destroys session', async () => {
  let options, history, destroyed = false, output;
  const api = { availability: async () => 'available', create: async (o) => {
    options = o;
    return { promptStreaming: (h) => { history = h; return (async function* () { yield 'Hello'; yield ' world'; })(); }, destroy: () => { destroyed = true; } };
  } };
  const result = await chromeAIEngine(() => {}, api).generate({ messages: [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Hi' }], signal: new AbortController().signal, onText: (t) => { output = t; } });
  assert.equal(options.initialPrompts[0].content, 'Be helpful');
  assert.deepEqual(history, [{ role: 'user', content: 'Hi' }]);
  assert.equal(result.text, 'Hello world'); assert.equal(output, result.text); assert.ok(destroyed);
});

test('Chrome unavailable and abort are reported without creating a session', async () => {
  const api = { availability: async () => 'unavailable', create: () => assert.fail('must not create') };
  await assert.rejects(chromeAIEngine(() => {}, api).generate({ messages: [], signal: new AbortController().signal }), /unavailable/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(chromeAIEngine(() => {}, api).generate({ messages: [], signal: controller.signal }), { name: 'AbortError' });
});

test('WebLLM rejects unknown models and reports missing WebGPU', async () => {
  const args = { messages: [], signal: new AbortController().signal };
  await assert.rejects(webLLMEngine('not-a-model').generate(args), /supported/);
  await assert.rejects(webLLMEngine(WEBLLM_MODELS[0]).generate(args), /WebGPU/);
  disposeWebLLM();
});

test('new local engines see prior turns but community does not receive local history', () => {
  const chat = createChat('private');
  const first = newTurn(chat, 'private', 'webllm'); first.text = 'local answer'; first.status = 'complete';
  newTurn(chat, 'follow up', 'chrome');
  assert.ok(conversationContext(chat, 'chrome').some(m => m.content === 'private'));
  assert.ok(!conversationContext(chat, 'community').some(m => m.content === 'private'));
});

test('WebLLM coder choices are present in the bundled MLC model catalog', async () => {
  const { readFile } = await import('node:fs/promises');
  const catalog = await readFile(new URL('../node_modules/@mlc-ai/web-llm/lib/index.js', import.meta.url), 'utf8');
  for (const size of ['1.5B', '3B', '7B']) {
    const id = `Qwen2.5-Coder-${size}-Instruct-q4f32_1-MLC`;
    assert.ok(WEBLLM_MODELS.includes(id));
    assert.ok(catalog.includes(`model_id: "${id}"`));
  }
});
