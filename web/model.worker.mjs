import { Wllama } from './vendor/wllama.mjs';

const wasm = new URL('./vendor/wllama.wasm', import.meta.url).href;
const quiet = () => {};
// Kept between messages: the model and its cache are the expensive part.
let runtime;
let loadedKey;
let busy = false;

async function prepare(file, key, context) {
  if (runtime && loadedKey === key) return;
  runtime?.exit?.();
  runtime = undefined;
  loadedKey = undefined;
  runtime = new Wllama({ default: wasm }, {
    suppressNativeLog: true,
    logger: { debug: quiet, log: quiet, warn: quiet, error: quiet },
  });
  runtime.setCompat(null);
  await runtime.loadModel([file], { n_ctx: context, n_threads: 1, n_gpu_layers: 0 });
  loadedKey = key;
}

self.addEventListener('message', async ({ data: { key, file, messages, maxTokens, context } }) => {
  const phase = (name) => self.postMessage({ type: 'phase', phase: name });
  // One generation at a time: a second request waits for the first to finish.
  while (busy) await new Promise((done) => setTimeout(done, 50));
  busy = true;
  try {
    phase('loading');
    await prepare(file, key, context);
    phase('generating');
    let text = '', lastUpdate = 0, limited = false;
    await runtime.createChatCompletion({
      messages, max_tokens: maxTokens, temperature: 0.55, top_p: 0.9, stream: true,
      onData(chunk) {
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) text += choice.delta.content;
        if (choice?.finish_reason === 'length') limited = true;
        if (performance.now() - lastUpdate > 60 && text) {
          self.postMessage({ type: 'text', text });
          lastUpdate = performance.now();
        }
      },
    });
    self.postMessage({ type: 'result', text, limited });
  } catch (error) {
    // A model that failed to load is not kept: the next attempt starts clean.
    if (!loadedKey) { runtime = undefined; }
    const message = error instanceof Error ? error.message : '';
    self.postMessage({ type: 'error', message: `Local model could not run. ${message || 'Try a smaller instruction-tuned GGUF in current desktop Chrome or Edge.'}` });
  } finally {
    busy = false;
  }
});
