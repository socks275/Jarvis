// Just enough of the GGUF header to know how much conversation a model can
// hold. Weights are never read: only the metadata block at the front.
//
// Layout: magic "GGUF", u32 version, u64 tensor count, u64 metadata count,
// then one entry per key (u64 length + UTF-8 name, u32 value type, value).

const MAGIC = [0x47, 0x47, 0x55, 0x46];
const MAX_KEYS = 20_000;
const MAX_STRING = 1_000_000;

const FIXED = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

class Reader {
  constructor(view, bytes) { this.view = view; this.bytes = bytes; this.at = 0; }
  need(size) { if (this.at + size > this.bytes.byteLength) throw new Error('gguf: out of data'); }
  u32() { this.need(4); const value = this.view.getUint32(this.at, true); this.at += 4; return value; }
  u64() { this.need(8); const value = Number(this.view.getBigUint64(this.at, true)); this.at += 8; return value; }
  bytesSlice(size) { this.need(size); const slice = this.bytes.subarray(this.at, this.at + size); this.at += size; return slice; }
  string() {
    const size = this.u64();
    if (size > MAX_STRING) throw new Error('gguf: string too long');
    return new TextDecoder().decode(this.bytesSlice(size));
  }
  skip(size) { this.need(size); this.at += size; }
}

/** Every metadata key whose name ends with the given suffix, as numbers or strings. */
function readEntries(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 24 || !MAGIC.every((byte, i) => bytes[i] === byte)) throw new Error('gguf: bad header');
  const reader = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes);
  reader.skip(4);
  reader.u32();
  reader.u64();
  const count = reader.u64();
  if (count > MAX_KEYS) throw new Error('gguf: too many keys');
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const key = reader.string();
    const type = reader.u32();
    entries.set(key, readValue(reader, type));
  }
  return entries;
}

function readValue(reader, type) {
  if (type === 8) return reader.string();
  if (type === 9) {
    const item = reader.u32();
    const length = reader.u64();
    if (length > MAX_KEYS) throw new Error('gguf: array too long');
    const values = [];
    for (let i = 0; i < length; i++) {
      // Only the shape matters here, so a long array is not held in memory.
      const value = readValue(reader, item);
      if (values.length < 4) values.push(value);
    }
    return values;
  }
  const size = FIXED[type];
  if (!size) throw new Error('gguf: unknown value type');
  const at = reader.at;
  reader.skip(size);
  if (type === 6) return reader.view.getFloat32(at, true);
  if (size === 1) return reader.bytes[at];
  if (size === 2) return reader.view.getUint16(at, true);
  if (size === 4) return reader.view.getUint32(at, true);
  return Number(reader.view.getBigUint64(at, true));
}

/**
 * The context window the file was trained for, or undefined when the metadata
 * does not say. `general.architecture` names the prefix, e.g. "qwen2.context_length".
 */
export function ggufContextLength(buffer) {
  try {
    const entries = readEntries(buffer);
    const arch = entries.get('general.architecture');
    const exact = typeof arch === 'string' ? entries.get(`${arch}.context_length`) : undefined;
    const value = exact ?? [...entries].find(([key]) => key.endsWith('.context_length'))?.[1];
    return Number.isSafeInteger(value) && value >= 256 && value <= 10_000_000 ? value : undefined;
  } catch { return undefined; }
}

/** The architecture name, when the file has one ("llama", "qwen2", …). */
export function ggufArchitecture(buffer) {
  try {
    const arch = readEntries(buffer).get('general.architecture');
    return typeof arch === 'string' && /^[a-z0-9_.]{1,40}$/i.test(arch) ? arch : undefined;
  } catch { return undefined; }
}
