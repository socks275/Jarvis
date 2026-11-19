import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserEngine, contextWindow, disposeLocal, validateModel } from '../web/engine.mjs';

const text = (value) => [...new TextEncoder().encode(value)];
const u32 = (value) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value, true); return [...b]; };
const u64 = (value) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(value), true); return [...b]; };
const str = (value) => [...u64(text(value).length), ...text(value)];
const withMetadata = (context) => new Uint8Array([
  ...text('GGUF'), ...u32(3), ...u64(0), ...u64(2),
  ...str('general.architecture'), ...u32(8), ...str('llama'),
  ...str('llama.context_length'), ...u32(4), ...u32(context),
]);
const fixture = (name = 'small-model.gguf', magic = 'GGUF', extra = new Uint8Array(20)) => new File([magic, extra], name);

test('the local picker accepts only small, single-file GGUFs with a valid header', async () => {
  await validateModel(fixture());
  await assert.rejects(validateModel(), /Choose a .gguf/);
  await assert.rejects(validateModel(fixture('weights.bin')), /Choose a .gguf/);
  await assert.rejects(validateModel(fixture('model-00001-of-00002.gguf')), /single-file/);
  await assert.rejects(validateModel(fixture('not-really.gguf', 'HTML')), /not a valid GGUF/);
  await assert.rejects(validateModel({ name: 'huge.gguf', size: 2e9 }), /smaller than 1.2 GB/);
});

test('the picker reports the window the file was trained for', async () => {
  assert.deepEqual(await validateModel(new File([withMetadata(32768)], 'typing.gguf')), { context: 32768 });
  assert.deepEqual(await validateModel(fixture()), { context: undefined });
});

test('the window is the model’s own, capped by what the machine can hold', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const setMemory = (deviceMemory) => Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { deviceMemory } });
  try {
    setMemory(16);
    assert.equal(contextWindow(32768), 16_384);
    assert.equal(contextWindow(8192), 8192);
    assert.equal(contextWindow(undefined), 4096);
    setMemory(4);
    assert.equal(contextWindow(32768), 8192);
    setMemory(1);
    assert.equal(contextWindow(32768), 4096);
    // A file claiming an unusable window falls back rather than failing.
    assert.equal(contextWindow(7), 4096);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator.deviceMemory;
  }
});

test('the worker keeps the model loaded between replies and is dropped on stop', async () => {
  const previous = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class extends EventTarget {
    constructor() { super(); workers.push(this); }
    postMessage(payload) { this.payload = payload; }
    terminate() { this.terminated = true; }
  };
  const controller = new AbortController();
  const file = fixture('local-model.gguf');
  const phases = [], snapshots = [];
  const engine = browserEngine(file, (phase) => phases.push(phase), { context: 8192 });
  const messages = [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Test prompt' }];
  const respond = (worker, data) => worker.dispatchEvent(new MessageEvent('message', { data }));
  try {
    const request = () => engine.generate({ messages, signal: controller.signal, onText: (text) => snapshots.push(text) });
    const first = request();
    const worker = workers.at(-1);
    assert.equal(worker.payload.file, file);
    assert.equal(worker.payload.context, 8192);
    assert.deepEqual(worker.payload.messages, messages);
    respond(worker, { type: 'phase', phase: 'loading' });
    respond(worker, { type: 'text', text: 'Re' });
    respond(worker, { type: 'result', text: 'Response', limited: false });
    assert.deepEqual(await first, { text: 'Response', model: 'local-model', limited: false });
    assert.deepEqual(phases, ['loading']);
    assert.deepEqual(snapshots, ['Re']);
    // The model stays warm: the same worker answers the next message.
    assert.notEqual(worker.terminated, true);
    const second = request();
    assert.equal(workers.length, 1);
    respond(worker, { type: 'result', text: 'Second', limited: false });
    assert.equal((await second).text, 'Second');
    // Stopping really stops: a warm model cannot be interrupted, so it is dropped.
    const third = request();
    controller.abort();
    await assert.rejects(third, { name: 'AbortError' });
    assert.equal(worker.terminated, true);
    // And the next reply starts a fresh worker.
    const fourth = engine.generate({ messages, signal: new AbortController().signal });
    assert.equal(workers.length, 2);
    respond(workers[1], { type: 'result', text: 'Fresh', limited: false });
    assert.equal((await fourth).text, 'Fresh');
  } finally {
    disposeLocal();
    assert.equal(workers.at(-1).terminated, true);
    if (previous) globalThis.Worker = previous;
    else delete globalThis.Worker;
  }
});
