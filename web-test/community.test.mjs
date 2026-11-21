import assert from 'node:assert/strict';
import { test } from 'node:test';
import { communityEngine, describeWait, getOnlineModels, planCommunityRequest, waitEstimate } from '../web/community.mjs';
import { answerChat } from '../web/chat.mjs';

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

test('a coding message is offered the code models first and sampled less', () => {
  const models = [
    { id: 'chatty/general', count: 9, context: 8192, tokens: 1024, queue: 0 },
    { id: 'Qwen2.5-Coder-32B', count: 1, context: 8192, tokens: 1024, queue: 40 },
  ];
  const code = planCommunityRequest(models, { messages, purpose: 'answer', code: true });
  assert.equal(code.models[0], 'Qwen2.5-Coder-32B');
  assert.equal(code.temperature, 0.2);
  const chat = planCommunityRequest(models, { messages, purpose: 'answer' });
  assert.equal(chat.models[0], 'chatty/general');
  assert.equal(chat.temperature, 0.55);
});

test('the engine sends the code flag through to the request it builds', async () => {
  let sent;
  const { generate } = communityEngine({ fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return list(card('plain/chat'), card('deepseek-coder-33b'));
    sent = JSON.parse(options.body);
    return stream([event({ choices: [{ delta: { content: 'ok' } }] }), event({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\r\n\r\n']);
  } });
  await generate({ messages, purpose: 'answer', signal: signal(), code: true });
  assert.equal(sent.models[0], 'deepseek-coder-33b');
  assert.equal(sent.temperature, 0.2);
});

test('the pass that finishes a reply prefers a stronger model that is in reach', () => {
  const models = [
    { id: 'small/Model-7B', count: 6, context: 8192, tokens: 1024, queue: 0 },
    { id: 'Llama-3.1-70B-Instruct', count: 2, context: 8192, tokens: 1024, queue: 4 },
    { id: 'huge/Model-405B', count: 1, context: 8192, tokens: 1024, queue: 300 },
  ];
  const finished = planCommunityRequest(models, { messages, purpose: 'final' });
  assert.equal(finished.models[0], 'Llama-3.1-70B-Instruct');
  // A model buried in a queue of 300 jobs is not in reach, so it goes last.
  assert.equal(finished.models.at(-1), 'huge/Model-405B');
  // Ordinary passes still go by capacity.
  assert.equal(planCommunityRequest(models, { messages, purpose: 'answer' }).models[0], 'small/Model-7B');
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

test('a reply the provider finished without a closing sentinel is not called interrupted', async () => {
  const bodies = [
    // Some releases close the body right after the finish_reason.
    [event({ choices: [{ delta: { content: 'All done' } }] }), event({ choices: [{ delta: {}, finish_reason: 'stop' }] })],
    // The closing event arrives without its final newline.
    [event({ choices: [{ delta: { content: 'All done' } }] }), 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'],
    // [DONE] itself can be the unterminated last line.
    [event({ choices: [{ delta: { content: 'All done' } }] }), 'data: [DONE]'],
  ];
  for (const events of bodies) {
    const { generate } = communityEngine({ fetchImpl: async (url) => url.endsWith('/models')
      ? list(card('worker/A'))
      : stream(events) });
    const result = await generate({ messages, purpose: 'answer', signal: signal() });
    assert.equal(result.text, 'All done');
    assert.equal(result.model, undefined);
    assert.equal(result.limited, false);
  }
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

test('one reply asks for the roster once, not once per pass', async () => {
  let lookups = 0;
  const { generate } = communityEngine({ fetchImpl: async (url) => {
    if (url.endsWith('/models')) { lookups++; return list(card('worker/A'), card('worker/B')); }
    return stream([event({ choices: [{ delta: { content: 'ok' } }] }), event({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\r\n\r\n']);
  } });
  for (const purpose of ['draft', 'review', 'final']) await generate({ messages, signal: signal(), purpose });
  assert.equal(lookups, 1);
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

test('the page shows the finished reply when a provider closes without [DONE]', async () => {
  const { generate } = communityEngine({ fetchImpl: async (url) => url.endsWith('/models')
    ? list(card('worker/A'))
    : stream([
      event({ model: 'worker/A', choices: [{ delta: { content: 'Rainbows come from ' } }] }),
      event({ model: 'worker/A', choices: [{ delta: { content: 'light bending in raindrops.' } }] }),
      event({ model: 'worker/A', choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]) });
  const answer = await answerChat({
    messages, mode: 'solo', signal: signal(), generate,
    onText: () => {},
  });
  assert.equal(answer.text, 'Rainbows come from light bending in raindrops.');
  assert.equal(answer.model, 'worker/A');
  assert.equal(answer.warning, undefined);
  assert.equal(answer.limited, undefined);
});

test('a pinned model leads its pass, and a banned one never answers', () => {
  const models = [
    { id: 'small/Model-7B', count: 8, context: 8192, tokens: 1024, queue: 0 },
    { id: 'Llama-3.1-70B-Instruct', count: 2, context: 8192, tokens: 1024, queue: 4 },
  ];
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Explain cache invalidation.' }];
  // Without a preference, capacity decides and the busy 70B is not first.
  assert.equal(planCommunityRequest(models, { messages, purpose: 'answer', code: false }).models[0], 'small/Model-7B');
  // A pin puts it in front even when it is the busier model…
  const pinned = planCommunityRequest(models, { messages, purpose: 'answer', pinned: 'Llama-3.1-70B-Instruct' });
  assert.equal(pinned.models[0], 'Llama-3.1-70B-Instruct');
  // …but never decides the one-word triage vote.
  assert.equal(planCommunityRequest(models, { messages, purpose: 'triage', pinned: 'Llama-3.1-70B-Instruct' }).models[0], 'small/Model-7B');
  // …and never breaks the rule that the final pass is written by someone else.
  const avoid = planCommunityRequest(models, { messages, purpose: 'final', preferOtherThan: ['Llama-3.1-70B-Instruct'], pinned: 'Llama-3.1-70B-Instruct' });
  assert.ok(!avoid.models.includes('Llama-3.1-70B-Instruct'));

  const banned = planCommunityRequest(models, { messages, purpose: 'answer', banned: ['small/Model-7B'] });
  assert.deepEqual(banned.models, ['Llama-3.1-70B-Instruct']);
  // Banning everything that is online is said plainly rather than silently answered.
  assert.throws(() => planCommunityRequest(models, { messages, purpose: 'answer', banned: models.map((m) => m.id) }), /never-use list/);
});

test('the wait estimate is drawn from the queue and stays a rounded estimate', () => {
  const models = [
    { id: 'a', count: 2, queue: 10, context: 8192, tokens: 1024 },
    { id: 'b', count: 4, queue: 40, context: 8192, tokens: 1024 },
  ];
  // The best queue per worker wins: 10/2 = 5 jobs, not 40/4 = 10.
  const estimate = waitEstimate(models);
  assert.equal(estimate.models, 2);
  assert.ok(estimate.seconds > 100 && estimate.seconds < 200, String(estimate.seconds));
  assert.equal(waitEstimate([]), undefined);
  assert.equal(waitEstimate([{ id: 'a', count: 1, queue: Infinity }]), undefined);
  assert.match(describeWait(estimate), /^2 models online · about \d+ minutes?$/);
  assert.equal(describeWait(waitEstimate([{ id: 'a', count: 1, queue: 0 }], { tokens: 64 })), '1 model online · under 20 seconds');
  assert.equal(describeWait(undefined), '');
});

test('code routing prioritises explicitly code-trained names, not every general Qwen model', () => {
  const models = [
    { id: 'Qwen2.5-70B-Instruct', count: 5, context: 8192, tokens: 1024, queue: 0 },
    { id: 'Qwen2.5-Coder-7B-Instruct', count: 3, context: 8192, tokens: 1024, queue: 0 },
  ];
  const request = planCommunityRequest(models, { messages, purpose: 'review', code: true });
  assert.equal(request.models[0], 'Qwen2.5-Coder-7B-Instruct');
  assert.equal(request.max_tokens, 512);
});

test('resizing preserves the latest request with optional system messages or fails explicitly', () => {
  const current = { role: 'user', content: 'my current request ' + 'x'.repeat(1000) };
  const history = [{ role: 'system', content: 'rules' }, { role: 'system', content: 'source data' }, current];
  const planned = planCommunityRequest([{ id: 'm', context: 700, tokens: 128, count: 1, queue: 0 }], { messages: history });
  assert.equal(planned.messages.at(-1), current);
  assert.throws(() => planCommunityRequest([{ id: 'm', context: 128, tokens: 128, count: 1, queue: 0 }], { messages: history }), /cannot fit/);
});

test('resizing a continuation never loses the original task or partial code', () => {
  const latest = { role: 'user', content: 'Write a function' };
  const partial = { role: 'assistant', content: '```python\ndef f():' };
  const resume = { role: 'user', content: 'Continue exactly where the previous answer stopped. Do not repeat anything, do not apologise, and do not start over.' };
  const history = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'old'.repeat(900) }, { role: 'assistant', content: 'old answer' }, latest, partial, resume];
  const planned = planCommunityRequest([{ id: 'm', context: 600, tokens: 128, count: 1, queue: 0 }], { messages: history });
  assert.deepEqual(planned.messages.slice(-3), [latest, partial, resume]);
  assert.throws(() => planCommunityRequest([{ id: 'm', context: 80, tokens: 128, count: 1, queue: 0 }], { messages: history }), /cannot fit/);
});

test('community continuations retain whitespace in JSON and streamed replies', async () => {
  for (const streamed of [false, true]) {
    const { generate } = communityEngine({ fetchImpl: async (url) => {
      if (url.endsWith('/models')) return list(card('worker/A'));
      if (!streamed) return completion('worker/A', '    return 42\n');
      return stream([event({ model: 'worker/A', choices: [{ delta: { content: '    return 42\n' } }] }), event({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\r\n\r\n']);
    } });
    const result = await generate({ messages, purpose: 'continue', signal: signal() });
    assert.equal(result.text, '    return 42\n');
  }
});

test('coding uses the newer available families as the actual candidate set', () => {
  const models = [
    { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', count: 3, context: 8192, tokens: 1024, queue: 0 },
    { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', count: 1, context: 8192, tokens: 512, queue: 2 },
    { id: 'mistralai/Devstral-Small-2-24B-Instruct', count: 1, context: 8192, tokens: 1024, queue: 4 },
    { id: 'Qwen/Qwen3-Coder-30B-A3B-Base', count: 1, context: 8192, tokens: 1024, queue: 0 },
    { id: 'general/70B-Instruct', count: 1, context: 8192, tokens: 1024, queue: 0 },
  ];
  const request = planCommunityRequest(models, { messages, purpose: 'draft', code: true });
  assert.deepEqual(new Set(request.models), new Set([models[1].id, models[2].id]));
  assert.equal(request.max_tokens, 512);
  assert.ok(!request.models.includes(models[0].id));
  const review = planCommunityRequest(models, { messages, purpose: 'review', code: true, preferOtherThan: models[1].id });
  assert.deepEqual(review.models, [models[2].id]);
  const pinned = planCommunityRequest(models, { messages, purpose: 'draft', code: true, pinned: models[0].id });
  assert.equal(pinned.models[0], models[0].id);
  const lowerBudgetPin = planCommunityRequest([{ ...models[0], tokens: 512 }, models[2]], { messages, purpose: 'draft', code: true, pinned: models[0].id });
  assert.equal(lowerBudgetPin.models[0], models[0].id);
  const banned = planCommunityRequest(models, { messages, purpose: 'draft', code: true, banned: [models[1].id, models[2].id] });
  assert.deepEqual(banned.models, [models[0].id]);
});

test('coding falls back to the rest of the roster after a documented stale-model refusal', async () => {
  let requests = 0, lookups = 0;
  const sent = [];
  const newer = 'Qwen/Qwen3-Coder-30B-A3B-Instruct';
  const older = 'Qwen/Qwen2.5-Coder-32B-Instruct';
  const { generate } = communityEngine({ fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) { lookups++; return list(card(newer), card(older), card('general')); }
    sent.push(JSON.parse(options.body).models); requests++;
    return requests === 1 ? refusal('UnknownChatModel', 404) : completion(older, 'working answer');
  } });
  const result = await generate({ messages, signal: signal(), purpose: 'draft', code: true });
  assert.equal(result.model, older);
  assert.deepEqual(sent, [[newer], [older]]);
  assert.equal(lookups, 2);
});

test('a coding-model timeout or cooldown never triggers an alternate submission', async () => {
  for (const response of [refusal('rate_limit_exceeded', 429, { 'Retry-After': '12' }), refusal('request_timeout', 504)]) {
    let requests = 0;
    const { generate } = communityEngine({ fetchImpl: async (url) => {
      if (url.endsWith('/models')) return list(card('Qwen3-Coder-30B'), card('general'));
      requests++;
      return response;
    } });
    await assert.rejects(generate({ messages, signal: signal(), purpose: 'draft', code: true }));
    assert.equal(requests, 1);
  }
});
