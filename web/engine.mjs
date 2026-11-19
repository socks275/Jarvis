import { estimateTokens, OUTPUT_LIMIT, shorterContext } from './chat.mjs';
import { ggufContextLength } from './gguf.mjs';

const MAX_MODEL_BYTES = 1_200_000_000;
const TIMEOUT = 5 * 60 * 1000;
const TOKENS = 384;
export const LOCAL_CONTEXT = 4096;
const CONTEXT_FLOOR = 2048;
const HEADER_BYTES = 4_000_000;

export async function validateModel(file) {
  if (!file || !file.name.toLowerCase().endsWith('.gguf')) throw new Error('Choose a .gguf model file.');
  if (/-\d{5}-of-\d{5}\.gguf$/i.test(file.name)) throw new Error('Choose a single-file GGUF model, not a piece of a split model.');
  if (file.size > MAX_MODEL_BYTES) throw new Error('Choose a model smaller than 1.2 GB. A small Q4_K_M model is a good starting point.');
  if (file.size < 24) throw new Error('That file is not a valid GGUF model. Download the full .gguf file and try again.');
  // The metadata lives at the front of the file, so only that part is read.
  const header = await file.slice(0, Math.min(file.slice ? HEADER_BYTES : 0, file.size)).arrayBuffer();
  const magic = new Uint8Array(header, 0, 4).join(',');
  if (magic !== '71,71,85,70') throw new Error('That file is not a valid GGUF model. Download the full .gguf file and try again.');
  return { context: ggufContextLength(header) };
}

/**
 * How much conversation to ask for: the window the file was trained for, capped
 * by what this browser can hold. A model that was trained on 32k is used at 32k
 * only if the machine has the memory for it.
 */
export function contextWindow(detected) {
  const memory = Number(globalThis.navigator?.deviceMemory ?? 0);
  const ceiling = memory >= 8 ? 16_384 : memory >= 4 ? 8192 : 4096;
  const wanted = Number.isFinite(detected) && detected >= CONTEXT_FLOOR ? detected : LOCAL_CONTEXT;
  return Math.max(CONTEXT_FLOOR, Math.min(wanted, ceiling));
}

// The model stays loaded between replies: loading a GGUF costs more than the
// answer itself, so switching chats no longer reloads the file every time.
let session;

function workerFor(file) {
  if (session?.file === file) return session.worker;
  session?.worker.terminate();
  const worker = new Worker(new URL('./model.worker.mjs', import.meta.url), { type: 'module' });
  session = { file, worker };
  return worker;
}

/** Drops the loaded model — used when the file is replaced or removed. */
export function disposeLocal() {
  session?.worker.terminate();
  session = undefined;
}

const keyOf = (file) => `${file.name}:${file.size}:${file.lastModified ?? 0}`;

// Only the browser's own worker receives the file and messages.
export function browserEngine(file, onPhase = () => {}, { context = LOCAL_CONTEXT } = {}) {
  return {
    async generate({ messages, signal, onText = () => {} }) {
      signal.throwIfAborted();
      while (messages.length > 2 && estimateTokens(messages) + TOKENS > context) messages = shorterContext(messages);
      if (estimateTokens(messages) + TOKENS > context) throw new Error('This message is too long for the local model. Try shortening it.');
      const worker = workerFor(file);
      return new Promise((resolve, reject) => {
        function finish(error, answer) {
          clearTimeout(timer);
          worker.removeEventListener('message', message);
          worker.removeEventListener('messageerror', broken);
          worker.removeEventListener('error', broken);
          signal.removeEventListener('abort', stop);
          if (error) reject(error);
          else resolve(answer);
        }
        function message(event) {
          const data = event.data;
          if (data?.type === 'phase') onPhase(data.phase);
          else if (data?.type === 'text' && typeof data.text === 'string') onText(data.text.slice(0, OUTPUT_LIMIT));
          else if (data?.type === 'result') {
            const text = data.text?.trim();
            if (!text) { finish(new Error('The local model returned no text. Try rephrasing your message.')); return; }
            finish(null, { text: text.slice(0, OUTPUT_LIMIT), model: file.name.replace(/\.gguf$/i, '').slice(0, 300), limited: data.limited });
          } else if (data?.type === 'error') finish(new Error(data.message));
        }
        function broken() { finish(new Error('Could not start local AI. Open the site in current desktop Chrome or Edge and try again.')); }
        // Stopping has to actually stop: a warm worker cannot be interrupted,
        // so it is dropped and the next reply loads the model again.
        function stop() {
          if (session?.worker === worker) disposeLocal();
          finish(signal.reason);
        }
        const timer = setTimeout(() => {
          if (session?.worker === worker) disposeLocal();
          finish(new Error('The local model took more than five minutes. Try a smaller quantized GGUF file.'));
        }, TIMEOUT);
        worker.addEventListener('message', message);
        worker.addEventListener('error', broken);
        worker.addEventListener('messageerror', broken);
        signal.addEventListener('abort', stop, { once: true });
        try { worker.postMessage({ key: keyOf(file), file, messages, maxTokens: TOKENS, context }); }
        catch { broken(); }
      });
    },
  };
}
