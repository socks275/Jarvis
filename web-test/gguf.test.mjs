import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ggufArchitecture, ggufContextLength } from '../web/gguf.mjs';

const text = (value) => [...new TextEncoder().encode(value)];
const u32 = (value) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value, true); return [...b]; };
const u64 = (value) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(value), true); return [...b]; };
const str = (value) => [...u64(text(value).length), ...text(value)];

// A real header, without the gigabytes of weights behind it.
function gguf(entries, { magic = 'GGUF', version = 3 } = {}) {
  const body = [text(magic), u32(version), u64(0), u64(entries.length)];
  for (const [key, type, value] of entries) {
    body.push(str(key), u32(type));
    if (type === 8) body.push(str(value));
    else if (type === 4) body.push(u32(value));
    else if (type === 0) body.push([value]);
    else if (type === 9) body.push(u32(4), u64(value.length), ...value.flatMap(u32));
    else throw new Error(`no fixture writer for type ${type}`);
  }
  return new Uint8Array(body.flat());
}

const good = gguf([
  ['general.architecture', 8, 'qwen2'],
  ['general.name', 8, 'Fixture 0.5B'],
  ['qwen2.context_length', 4, 32768],
  ['qwen2.embedding_length', 4, 896],
  ['tokenizer.ggml.tokens', 9, ['a', 'b', 'c']],
  ['tokenizer.ggml.scores', 0, 1],
]);

test('reads the context window from the metadata, not from a fixed guess', () => {
  assert.equal(ggufContextLength(good), 32768);
  assert.equal(ggufArchitecture(good), 'qwen2');
  // The architecture prefix wins over another model's stray key.
  const mixed = gguf([['general.architecture', 8, 'llama'], ['qwen2.context_length', 4, 4096], ['llama.context_length', 4, 8192]]);
  assert.equal(ggufContextLength(mixed), 8192);
});

test('a file that does not say, or is not really a GGUF, gives no window rather than a guess', () => {
  assert.equal(ggufContextLength(gguf([['general.name', 8, 'no context here']])), undefined);
  assert.equal(ggufContextLength(gguf([['general.architecture', 8, 'llama']], { magic: 'HTML' })), undefined);
  assert.equal(ggufContextLength(new Uint8Array([0x47, 0x47, 0x55, 0x46])), undefined);
  assert.equal(ggufContextLength(new Uint8Array(0)), undefined);
  // A truncated key table is a bad file, not a crash.
  assert.equal(ggufContextLength(good.slice(0, 40)), undefined);
  // Nonsense values are refused.
  assert.equal(ggufContextLength(gguf([['general.architecture', 8, 'llama'], ['llama.context_length', 4, 7]])), undefined);
});

test('an enormous array in the metadata is bounded, not read in full', () => {
  const huge = gguf([['tokenizer.ggml.tokens', 9, Array.from({ length: 5000 }, (_, i) => i)]]);
  assert.equal(ggufContextLength(huge), undefined);
  assert.equal(ggufArchitecture(huge), undefined);
});
