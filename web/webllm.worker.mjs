import { CreateMLCEngine } from './vendor/webllm.mjs';
let engine, current;
self.onmessage = async ({ data }) => {
  try {
    if (!engine || current !== data.model) {
      await engine?.unload();
      engine = await CreateMLCEngine(data.model, { initProgressCallback: (report) => self.postMessage({ type: 'progress', text: report.text }) });
      current = data.model;
    }
    let text = '', finish;
    const chunks = await engine.chat.completions.create({ messages: data.messages, stream: true, max_tokens: 1024, temperature: 0.2 });
    for await (const chunk of chunks) {
      text += chunk.choices[0]?.delta?.content || '';
      finish = chunk.choices[0]?.finish_reason || finish;
      self.postMessage({ type: 'text', text });
    }
    if (!text.trim()) throw new Error('The model returned no text.');
    self.postMessage({ type: 'result', text: data.preserveWhitespace ? text : text.trim(), limited: finish === 'length' });
  } catch (error) { self.postMessage({ type: 'error', message: String(error?.message || error) }); }
};
