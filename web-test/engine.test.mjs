import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserEngine, validateModel } from '../web/engine.mjs';

const fixture = (name = 'small-model.gguf', magic = 'GGUF') => new File([magic, new Uint8Array(20)], name);

test('the local picker accepts only small, single-file GGUFs with a valid header', async () => {
  await validateModel(fixture());
  await assert.rejects(validateModel(), /Choose a .gguf/);
  await assert.rejects(validateModel(fixture('weights.bin')), /Choose a .gguf/);
  await assert.rejects(validateModel(fixture('model-00001-of-00002.gguf')), /single-file/);
  await assert.rejects(validateModel(fixture('not-really.gguf', 'HTML')), /not a valid GGUF/);
  await assert.rejects(validateModel({ name: 'huge.gguf', size: 2e9 }), /smaller than 1.2 GB/);
});

test('the worker receives the on-device conversation, streams output and is terminated on stop', async () => {
  const previous = globalThis.Worker;
  let worker;
  globalThis.Worker = class extends EventTarget {
    constructor() { super(); worker = this; }
    postMessage(payload) { this.payload = payload; }
    terminate() { this.terminated = true; }
  };
  const controller = new AbortController();
  const file = fixture('local-model.gguf');
  const phases = [], snapshots = [];
  const engine = browserEngine(file, (phase) => phases.push(phase));
  const messages = [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Test prompt' }];
  try {
    const request = () => engine.generate({ messages, signal: controller.signal, onText: (text) => snapshots.push(text) });
    const first = request();
    assert.equal(worker.payload.file, file);
    assert.deepEqual(worker.payload.messages, messages);
    const respond = (data) => worker.dispatchEvent(new MessageEvent('message', { data }));
    respond({ type: 'phase', phase: 'loading' });
    respond({ type: 'text', text: 'Re' });
    respond({ type: 'result', text: 'Response', limited: false });
    assert.deepEqual(await first, { text: 'Response', model: 'local-model', limited: false });
    assert.deepEqual(phases, ['loading']);
    assert.deepEqual(snapshots, ['Re']);
    assert.equal(worker.terminated, true);
    const second = request();
    controller.abort();
    await assert.rejects(second, { name: 'AbortError' });
    assert.equal(worker.terminated, true);
  } finally {
    engine.dispose();
    if (previous) globalThis.Worker = previous;
    else delete globalThis.Worker;
  }
});
