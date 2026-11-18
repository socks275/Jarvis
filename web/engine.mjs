import { estimateTokens, OUTPUT_LIMIT, shorterContext } from './chat.mjs';

const MAX_MODEL_BYTES = 1_200_000_000;
const TIMEOUT = 5 * 60 * 1000;
const TOKENS = 384;
export const LOCAL_CONTEXT = 4096;

export async function validateModel(file) {
  if (!file || !file.name.toLowerCase().endsWith('.gguf')) throw new Error('Choose a .gguf model file.');
  if (/-\d{5}-of-\d{5}\.gguf$/i.test(file.name)) throw new Error('Choose a single-file GGUF model, not a piece of a split model.');
  if (file.size > MAX_MODEL_BYTES) throw new Error('Choose a model smaller than 1.2 GB. A small Q4_K_M model is a good starting point.');
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (file.size < 24 || header.join(',') !== '71,71,85,70') {
    throw new Error('That file is not a valid GGUF model. Download the full .gguf file and try again.');
  }
}

// Only the browser's own worker receives the file and messages.
export function browserEngine(file, onPhase = () => {}) {
  let worker;
  const dispose = () => {
    worker?.terminate();
    worker = undefined;
  };
  return {
    dispose,
    async generate({ messages, signal, onText = () => {} }) {
      signal.throwIfAborted();
      while (messages.length > 2 && estimateTokens(messages) + TOKENS > LOCAL_CONTEXT) messages = shorterContext(messages);
      if (estimateTokens(messages) + TOKENS > LOCAL_CONTEXT) throw new Error('This message is too long for the local model. Try shortening it.');
      worker = new Worker(new URL('./model.worker.mjs', import.meta.url), { type: 'module' });
      const active = worker;
      return new Promise((resolve, reject) => {
        function finish(error, answer) {
          clearTimeout(timer);
          active.removeEventListener('message', message);
          active.removeEventListener('messageerror', broken);
          active.removeEventListener('error', broken);
          signal.removeEventListener('abort', stop);
          dispose();
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
        function stop() { finish(signal.reason); }
        const timer = setTimeout(() => finish(new Error('The local model took more than five minutes. Try a smaller quantized GGUF file.')), TIMEOUT);
        active.addEventListener('message', message);
        active.addEventListener('error', broken);
        active.addEventListener('messageerror', broken);
        signal.addEventListener('abort', stop, { once: true });
        try { active.postMessage({ file, messages, maxTokens: TOKENS, context: LOCAL_CONTEXT }); }
        catch { broken(); }
      });
    },
  };
}
