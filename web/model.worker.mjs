import { Wllama } from './vendor/wllama.mjs';

const wasm = new URL('./vendor/wllama.wasm', import.meta.url).href;
const quiet = () => {};
let runtime;
let currentSlot;

self.addEventListener('message', async ({ data: { id, slot, file, input, maxTokens } }) => {
  const phase = (name) => self.postMessage({ type: 'phase', id, phase: name });
  try {
    if (!runtime || currentSlot !== slot) {
      phase('loading');
      // Keep only one model in memory at a time. Never fetch compatibility assets from a CDN.
      await runtime?.exit();
      runtime = new Wllama({ default: wasm }, {
        suppressNativeLog: true,
        logger: { debug: quiet, log: quiet, warn: quiet, error: quiet },
      });
      runtime.setCompat(null);
      await runtime.loadModel([file], { n_ctx: 4096, n_threads: 1, n_gpu_layers: 0 });
      currentSlot = slot;
    }
    phase('generating');
    const result = await runtime.createChatCompletion({
      messages: [{ role: 'user', content: input }],
      max_tokens: maxTokens,
      temperature: 0.55,
      top_p: 0.9,
    });
    self.postMessage({ type: 'result', id, text: result?.choices?.[0]?.message?.content ?? '' });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    self.postMessage({ type: 'error', id, message: `Local model could not run. ${message || 'Try a smaller instruction-tuned GGUF in current desktop Chrome or Edge.'}` });
    await runtime?.exit().catch(quiet);
    runtime = undefined;
    currentSlot = undefined;
  }
});
