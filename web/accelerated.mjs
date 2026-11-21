import { OUTPUT_LIMIT } from './chat.mjs';

export const WEBLLM_MODELS = [
  'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
  'Qwen2.5-3B-Instruct-q4f32_1-MLC',
  'Llama-3.2-3B-Instruct-q4f32_1-MLC',
];
let workerSession;
export function disposeWebLLM() {
  workerSession?.worker.terminate();
  workerSession = undefined;
}

export function webLLMEngine(model, onPhase = () => {}, onProgress = () => {}) {
  return { async generate({ messages, signal, onText = () => {} }) {
    signal.throwIfAborted();
    if (!WEBLLM_MODELS.includes(model)) throw new Error('Choose a supported WebLLM model.');
    if (!globalThis.navigator?.gpu) throw new Error('WebLLM needs WebGPU. Try a current desktop Chrome or Edge with hardware acceleration enabled.');
    if (workerSession?.model !== model) {
      disposeWebLLM();
      workerSession = { model, worker: new Worker(new URL('./webllm.worker.mjs', import.meta.url), { type: 'module' }) };
    }
    const worker = workerSession.worker;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        worker.removeEventListener('message', receive);
        worker.removeEventListener('error', broken);
        worker.removeEventListener('messageerror', broken);
        signal.removeEventListener('abort', stop);
        if (error) reject(error); else resolve(result);
      };
      const stop = () => { disposeWebLLM(); finish(signal.reason); };
      const broken = () => { disposeWebLLM(); finish(new Error('WebLLM could not start. Check WebGPU, available memory, and your connection, then try again.')); };
      const receive = ({ data }) => {
        if (data.type === 'progress') { onPhase('loading'); onProgress(data.text); }
        else if (data.type === 'text') onText(data.text.slice(0, OUTPUT_LIMIT));
        else if (data.type === 'result') finish(null, { text: data.text.slice(0, OUTPUT_LIMIT), model, limited: data.limited || data.text.length > OUTPUT_LIMIT });
        else if (data.type === 'error') { disposeWebLLM(); finish(new Error(`WebLLM could not run: ${data.message}`)); }
      };
      const timer = setTimeout(() => { disposeWebLLM(); finish(new Error('WebLLM took too long. Check your connection or try a smaller model.')); }, 15 * 60 * 1000);
      worker.addEventListener('message', receive);
      worker.addEventListener('error', broken);
      worker.addEventListener('messageerror', broken);
      signal.addEventListener('abort', stop, { once: true });
      onPhase('loading');
      try { worker.postMessage({ model, messages }); } catch { broken(); }
    });
  } };
}

export function chromeAIEngine(onPhase = () => {}, api = globalThis.LanguageModel ?? globalThis.ai?.languageModel) {
  return { async generate({ messages, signal, onText = () => {} }) {
    signal.throwIfAborted();
    if (!api?.create) throw new Error('Chrome Built-in AI is not available in this browser. Use a supported desktop Chrome version with the Prompt API enabled, or choose another engine.');
    let session;
    try {
      const availability = api.availability ? await api.availability() : (await api.capabilities?.())?.available;
      if (availability === 'unavailable' || availability === 'no') throw new Error('Chrome Built-in AI is unavailable on this device. Check Chrome’s Prompt API and device requirements.');
      signal.throwIfAborted();
      onPhase('loading');
      const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const history = messages.filter(m => m.role !== 'system');
      // Chrome's Prompt API accepts structured roles; each request uses a fresh
      // session so changing chats never leaks context between conversations.
      session = await api.create({ ...(system ? { initialPrompts: [{ role: 'system', content: system }] } : {}), signal });
      signal.throwIfAborted();
      let text = '';
      const stream = session.promptStreaming(history, { signal });
      for await (const chunk of stream) {
        signal.throwIfAborted();
        text += chunk;
        onText(text.slice(0, OUTPUT_LIMIT));
      }
      if (!text.trim()) throw new Error('Chrome Built-in AI returned no text.');
      return { text: text.trim().slice(0, OUTPUT_LIMIT), model: 'Chrome Built-in AI', limited: text.length > OUTPUT_LIMIT };
    } finally { session?.destroy(); }
  } };
}
