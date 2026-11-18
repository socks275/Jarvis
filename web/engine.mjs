const MAX_MODEL_BYTES = 1_200_000_000;
const STAGE_TIMEOUT = 5 * 60 * 1000;

export async function validateModel(file) {
  if (!file || !file.name.toLowerCase().endsWith('.gguf')) throw new Error('Choose a .gguf model file.');
  if (/-\d{5}-of-\d{5}\.gguf$/i.test(file.name)) throw new Error('Choose a single-file GGUF model, not a piece of a split model.');
  if (file.size > MAX_MODEL_BYTES) throw new Error('Choose a model smaller than 1.2 GB. A small Q4_K_M model is a good starting point.');
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (file.size < 24 || header.join(',') !== '71,71,85,70') {
    throw new Error('That file is not a valid GGUF model. Download the full .gguf file and try again.');
  }
}

// This per-run worker is disposable, including while a model is still being read.
// The File handle is cloned between threads; no HTTP request includes model or prompt data.
export function browserEngine(files, onPhase) {
  let worker;
  let nextId = 0;
  const dispose = () => {
    worker?.terminate();
    worker = undefined;
  };

  return {
    dispose,
    async generate({ stage, input, signal }) {
      signal.throwIfAborted();
      const slot = stage.role === 'reviewer' && files.reviewer ? 'reviewer' : 'driver';
      worker ??= new Worker(new URL('./model.worker.mjs', import.meta.url), { type: 'module' });
      const active = worker;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        function finish(error, answer) {
          clearTimeout(timer);
          active.removeEventListener('message', message);
          active.removeEventListener('messageerror', broken);
          active.removeEventListener('error', broken);
          signal.removeEventListener('abort', stop);
          if (error) { dispose(); reject(error); }
          else resolve(answer);
        }
        function message(event) {
          const data = event.data;
          if (data?.id !== id) return;
          if (data.type === 'phase') onPhase(stage.key, data.phase);
          else if (data.type === 'result') finish(null, data.text);
          else if (data.type === 'error') finish(new Error(data.message));
        }
        function broken() { finish(new Error('Could not start browser AI. Open the site in a current desktop Chrome or Edge window and try again.')); }
        function stop() { finish(signal.reason); }
        const timer = setTimeout(() => finish(new Error('This model did not finish in five minutes. Try a smaller quantized GGUF file or a shorter prompt.')), STAGE_TIMEOUT);
        active.addEventListener('message', message);
        active.addEventListener('error', broken);
        active.addEventListener('messageerror', broken);
        signal.addEventListener('abort', stop, { once: true });
        try { active.postMessage({ id, slot, file: files[slot], input, maxTokens: stage.tokens }); }
        catch { broken(); }
      });
    },
  };
}
