import assert from 'node:assert/strict';
import { test } from 'node:test';
import { communityEngine, getOnlineModels, planCommunityRequest } from '../web/community.mjs';

const api = 'https://oai.aihorde.net/v1';
const signal = () => new AbortController().signal;
const messages = [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'How do rainbows form?' }];
const card = (id, { workers = 2, queued = 0, context = 8192, max = 1024 } = {}) => ({
  id, context_length: context, top_provider: { max_completion_tokens: max }, x_horde: { workers, queued },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
});
const json = (data, init) => Response.json(data, init);
const list = (...cards) => json({ data: cards });
const completion = (model, text) => json({ model, choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const refusal = (code, status, headers) => json({ error: { code } }, { status, headers });

function stream(events) {
  const bytes = new TextEncoder().encode(events.join(''));
  let index = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (index >= bytes.length) controller.close();
    else { controller.enqueue(bytes.slice(index, index + 7)); index += 7; }
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
const event = (value) => `data: ${JSON.stringify(value)}\r\n\r\n`;

test('reads the official live model list without sending prompts or credentials', async () => {
  const models = await getOnlineModels({ fetchImpl: async (url, options) => {
    assert.equal(url, `${api}/models`);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.body, undefined);
    assert.equal(options.headers, undefined);
    return list(
      card('busy', { queued: 1200 }), card('offline', { workers: 0 }), card('free', { workers: 4 }),
      card('variant:other'), card('tiny', { max: 5 }), { ...card('image'), architecture: { output_modalities: ['image'] } },
    );
  } });
  assert.deepEqual(models.map(({ id }) => id), ['free', 'busy']);
});

test('selects at most five compatible models, respects the free limit and prefers a second model for a check', async () => {
  const models = await getOnlineModels({ fetchImpl: async () => list(card('tiny-context', { context: 96 }),
    ...Array.from({ length: 8 }, (_, index) => card(`model-${index}`))) });
  const request = planCommunityRequest(models, { messages, purpose: 'answer' });
  assert.equal(request.models.length, 5);
  assert.ok(!request.models.includes('tiny-context'));
  assert.equal(request.max_tokens, 1024);
  assert.equal(request.stream, true);
  assert.equal(request.horde.include_reasoning, false);
  const review = planCommunityRequest(models, { messages, purpose: 'review', preferOtherThan: 'model-0' });
  assert.ok(!review.models.includes('model-0'));
  assert.equal(review.max_tokens, 352);
});

test('a final pass avoids every model that already worked on the reply', async () => {
  const models = await getOnlineModels({ fetchImpl: async () => list(card('model-a'), card('model-b'), card('model-c')) });
  const request = planCommunityRequest(models, { messages, purpose: 'final', preferOtherThan: ['model-a', 'model-b'] });
  assert.deepEqual(request.models, ['model-c']);
  assert.equal(request.max_tokens, 1024);
});

test('a model that offers fewer tokens is still respected, and a free-tier refusal retries smaller', async () => {
  const limited = await getOnlineModels({ fetchImpl: async () => list(card('capped', { max: 512 })) });
  assert.equal(planCommunityRequest(limited, { messages, purpose: 'answer' }).max_tokens, 512);
  const sizes = [];
  const { generate } = communityEngine({ fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return list(card('worker/A'));
    const body = JSON.parse(options.body);
    sizes.push(body.max_tokens);
    if (body.max_tokens > 512) return refusal('KudosUpfront', 402);
    return stream([event({ model: 'worker/A', choices: [{ delta: { content: 'Shorter answer' } }] }), event({ model: 'worker/A', choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\r\n\r\n']);
  } });
  const result = await generate({ messages, purpose: 'answer', signal: signal() });
  assert.deepEqual(sizes, [1024, 512]);
  assert.equal(result.text, 'Shorter answer');
});

test('only complete older turns are removed when resizing conversation context', () => {
  const history = [messages[0], { role: 'user', content: 'Old '.repeat(1100) },
    { role: 'assistant', content: 'Old answer' }, ...messages.slice(1)];
  const request = planCommunityRequest([{ id: 'medium', context: 780, tokens: 512 }], { messages: history, purpose: 'answer' });
  assert.deepEqual(request.messages, messages);
  const small = planCommunityRequest([{ id: 'low-limit', context: 500, tokens: 96 }], { messages, purpose: 'answer' });
  assert.equal(small.max_tokens, 96);
  assert.throws(() => planCommunityRequest([{ id: 'no-fit', context: 128, tokens: 96 }], { messages, purpose: 'answer' }), /cannot fit/);
});

test('sends chat roles anonymously, reports queue hints, decodes actual deltas and records the final model', async () => {
  const phases = [], updates = [];
  let posts = 0;
  const { generate } = communityEngine({ onPhase: (...args) => phases.push(args), fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return list(card('worker/A'), card('worker/B'));
    assert.equal(url, `${api}/chat/completions`);
    posts++;
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.equal(new Headers(options.headers).has('Authorization'), false);
    assert.equal(options.headers['X-Title'], 'Chorus Web');
    assert.deepEqual(JSON.parse(options.body).messages, messages);
    return stream([
      ': horde queue_position=7 wait_time=42\r\n\r\n',
      event({ model: 'worker/B', choices: [{ delta: { role: 'assistant' } }] }),
      event({ choices: [{ delta: { reasoning_content: 'Not shown.' } }] }),
      event({ choices: [{ delta: { content: 'Light bends ' } }] }),
      event({ choices: [{ delta: { content: '🌈 in raindrops.' } }] }),
      event({ model: 'worker/B', choices: [{ delta: {}, finish_reason: 'length' }] }),
      'data: [DONE]\r\n\r\n',
    ]);
  } });
  const result = await generate({ messages, purpose: 'answer', signal: signal(), onText: (text) => updates.push(text) });
  assert.equal(posts, 1);
  assert.deepEqual(phases, [['finding'], ['waiting'], ['waiting', { position: 7, seconds: 42 }]]);
  assert.deepEqual(updates, ['Light bends ', 'Light bends 🌈 in raindrops.']);
  assert.deepEqual(result, { text: 'Light bends 🌈 in raindrops.', model: 'worker/B', limited: true });
});

test('a refused or broken stream does not report success or send a duplicate request', async () => {
  for (const trailer of [[], [event({ error: { code: 'ChatStreamDiverged' } }), 'data: [DONE]\n\n']]) {
    let posts = 0;
    const { generate } = communityEngine({ fetchImpl: async (url) => {
      if (url.endsWith('/models')) return list(card('worker/A'));
      posts++;
      return stream([event({ choices: [{ delta: { content: 'First words' } }] }), ...trailer]);
    } });
    await assert.rejects(generate({ messages, signal: signal(), purpose: 'answer' }), /interrupted/);
    assert.equal(posts, 1);
  }
});

test('honors Retry-After without retrying a failed generation', async () => {
  let requests = 0;
  const pauses = [];
  const { generate } = communityEngine({ fetchImpl: async (url) => {
    if (url.endsWith('/models')) return list(card('only-model'));
    requests++;
    return refusal('rate_limit_exceeded', 429, { 'Retry-After': '12' });
  }, onLimit: (time) => pauses.push(time) });
  await assert.rejects(generate({ messages, signal: signal(), purpose: 'answer' }), /after the cooldown/);
  assert.equal(requests, 1);
  assert.deepEqual(pauses, [12]);
});

test('reroutes a stale unqueued model once when the roster changed', async () => {
  for (const replacement of ['different', 'stale']) {
    let lookups = 0;
    const requests = [];
    const { generate } = communityEngine({ fetchImpl: async (url, options) => {
      if (url.endsWith('/models')) return list(card(lookups++ ? replacement : 'stale'));
      requests.push(JSON.parse(options.body).models);
      return requests.length === 1 ? refusal('UnknownChatModel', 404) : completion(replacement, 'A direct answer.');
    } });
    const result = generate({ messages, signal: signal(), purpose: 'answer' });
    if (replacement === 'stale') {
      await assert.rejects(result);
      assert.deepEqual(requests, [['stale']]);
    } else {
      assert.equal((await result).model, replacement);
      assert.deepEqual(requests, [['stale'], ['different']]);
    }
    assert.equal(lookups, 2);
  }
});

test('does not submit when no model is available', async () => {
  const { generate } = communityEngine({ fetchImpl: async (url) => {
    assert.ok(url.endsWith('/models'));
    return list();
  } });
  await assert.rejects(generate({ messages, signal: signal(), purpose: 'answer' }), /No text models/);
});

test('Stop aborts the request', async () => {
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const controller = new AbortController();
  const { generate } = communityEngine({ fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return list(card('online'));
    started();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const reply = generate({ messages, signal: controller.signal, purpose: 'answer' });
  await waiting;
  controller.abort();
  await assert.rejects(reply, { name: 'AbortError' });
});
