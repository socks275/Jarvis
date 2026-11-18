import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserEngine, validateModel } from '../web/engine.mjs';
import { PLANS } from '../web/relay.mjs';

const fixture = (name = 'small-model.gguf', magic = 'GGUF') => new File([magic, new Uint8Array(20)], name);

test('the local model picker accepts only small, single-file GGUFs with a valid header', async () => {
  await validateModel(fixture());
  await assert.rejects(validateModel(), /Choose a .gguf/);
  await assert.rejects(validateModel(fixture('weights.bin')), /Choose a .gguf/);
  await assert.rejects(validateModel(fixture('model-00001-of-00002.gguf')), /single-file/);
  await assert.rejects(validateModel(fixture('not-really.gguf', 'HTML')), /not a valid GGUF/);
  await assert.rejects(validateModel({ name: 'huge.gguf', size: 2e9 }), /smaller than 1.2 GB/);
});

test('the worker receives the right role file and is terminated on stop', async () => {
  const previous = globalThis.Worker;
  let worker;
  globalThis.Worker = class extends EventTarget {
    constructor() { super(); worker = this; }
    postMessage(payload) { this.payload = payload; }
    terminate() { this.terminated = true; }
  };
  const controller = new AbortController();
  const driver = fixture('driver.gguf');
  const reviewer = fixture('reviewer.gguf');
  const phases = [];
  const engine = browserEngine({ driver, reviewer }, (...phase) => phases.push(phase));
  try {
    const request = (stage) => engine.generate({ stage, input: 'Test prompt', signal: controller.signal });
    const first = request(PLANS.review[0]);
    assert.equal(worker.payload.file, driver);
    const respond = (message) => worker.dispatchEvent(new MessageEvent('message', { data: { id: worker.payload.id, ...message } }));
    respond({ type: 'phase', phase: 'loading' });
    respond({ type: 'result', text: 'Response' });
    assert.equal(await first, 'Response');
    assert.deepEqual(phases, [['draft', 'loading']]);
    const second = request(PLANS.review[1]);
    assert.equal(worker.payload.file, reviewer);
    controller.abort();
    await assert.rejects(second, { name: 'AbortError' });
    assert.equal(worker.terminated, true);
  } finally {
    engine.dispose();
    if (previous) globalThis.Worker = previous;
    else delete globalThis.Worker;
  }
});
