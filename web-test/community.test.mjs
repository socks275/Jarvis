import assert from 'node:assert/strict';
import { test } from 'node:test';
import { communityEngine, describeWait, eligibleCommunityModels, getOnlineModels, planCommunityRequest, waitEstimate } from '../web/community.mjs';
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
    if (url.endsWith('/models')) return list(card('openai/gpt-oss-20b'));
    const body = JSON.parse(options.body);
    sizes.push(body.max_tokens);
    if (body.max_tokens > 512) return refusal('KudosUpfront', 402);
    return stream([event({ model: 'openai/gpt-oss-20b', choices: [{ delta: { content: 'Shorter answer' } }] }), event({ model: 'openai/gpt-oss-20b', choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\r\n\r\n']);
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
    if (url.endsWith('/models')) return list(card('ignored/non-gpt'), card('openai/gpt-oss-120b'));
    sent = JSON.parse(options.body);
    return stream([event({ choices: [{ delta: { content: 'ok' } }] }), event({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\r\n\r\n']);
  } });
  await generate({ messages, purpose: 'answer', signal: signal(), code: true });
  assert.deepEqual(sent.models, ['openai/gpt-oss-120b']);
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
    if (url.endsWith('/models')) return list(card('openai/gpt-oss-20b'), card('openai/gpt-oss-120b'));
    assert.equal(url, `${api}/chat/completions`);
    posts++;
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.equal(new Headers(options.headers).has('Authorization'), false);
    assert.equal(options.headers['X-Title'], 'Chorus Web');
    assert.deepEqual(JSON.parse(options.body).messages, messages);
    return stream([
      ': horde queue_position=7 wait_time=42\r\n\r\n',
      event({ model: 'openai/gpt-oss-120b', choices: [{ delta: { role: 'assistant' } }] }),
      event({ choices: [{ delta: { reasoning_content: 'Not shown.' } }] }),
      event({ choices: [{ delta: { content: 'Light bends ' } }] }),
      event({ choices: [{ delta: { content: '🌈 in raindrops.' } }] }),
      event({ model: 'openai/gpt-oss-120b', choices: [{ delta: {}, finish_reason: 'length' }] }),
      'data: [DONE]\r\n\r\n',
    ]);
  } });
  const result = await generate({ messages, purpose: 'answer', signal: signal(), onText: (text) => updates.push(text) });
  assert.equal(posts, 1);
  assert.deepEqual(phases, [['finding'], ['waiting'], ['waiting', { position: 7, seconds: 42 }]]);
  assert.deepEqual(updates, ['Light bends ', 'Light bends 🌈 in raindrops.']);
  assert.deepEqual(result, { text: 'Light bends 🌈 in raindrops.', model: 'openai/gpt-oss-120b', limited: true });
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
      ? list(card('openai/gpt-oss-20b'))
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
      if (url.endsWith('/models')) return list(card('openai/gpt-oss-20b'));
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
    if (url.endsWith('/models')) return list(card('openai/gpt-oss-20b'));
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
    if (url.endsWith('/models')) { lookups++; return list(card('openai/gpt-oss-20b'), card('openai/gpt-oss-120b')); }
    return stream([event({ choices: [{ delta: { content: 'ok' } }] }), event({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\r\n\r\n']);
  } });
  for (const purpose of ['draft', 'review', 'final']) await generate({ messages, signal: signal(), purpose });
  assert.equal(lookups, 1);
});

test('reroutes a stale unqueued model once when the roster changed', async () => {
  for (const replacement of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']) {
    let lookups = 0;
    const requests = [];
    const { generate } = communityEngine({ fetchImpl: async (url, options) => {
      if (url.endsWith('/models')) return list(card(lookups++ ? replacement : 'openai/gpt-oss-120b'));
      requests.push(JSON.parse(options.body).models);
      return requests.length === 1 ? refusal('UnknownChatModel', 404) : completion(replacement, 'A direct answer.');
    } });
    const result = generate({ messages, signal: signal(), purpose: 'answer' });
    if (replacement === 'openai/gpt-oss-120b') {
      await assert.rejects(result);
      assert.deepEqual(requests, [['openai/gpt-oss-120b']]);
    } else {
      assert.equal((await result).model, replacement);
      assert.deepEqual(requests, [['openai/gpt-oss-120b'], ['openai/gpt-oss-20b']]);
    }
    assert.equal(lookups, 2);
  }
});

test('does not submit when no model is available', async () => {
  const { generate } = communityEngine({ fetchImpl: async (url) => {
    assert.ok(url.endsWith('/models'));
    return list();
  } });
  await assert.rejects(generate({ messages, signal: signal(), purpose: 'answer' }), /No supported community models are online/);
});

test('Stop aborts the request', async () => {
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const controller = new AbortController();
  const { generate } = communityEngine({ fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return list(card('openai/gpt-oss-20b'));
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
    ? list(card('openai/gpt-oss-20b'))
    : stream([
      event({ model: 'openai/gpt-oss-20b', choices: [{ delta: { content: 'Rainbows come from ' } }] }),
      event({ model: 'openai/gpt-oss-20b', choices: [{ delta: { content: 'light bending in raindrops.' } }] }),
      event({ model: 'openai/gpt-oss-20b', choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]) });
  const answer = await answerChat({
    messages, mode: 'solo', signal: signal(), generate,
    onText: () => {},
  });
  assert.equal(answer.text, 'Rainbows come from light bending in raindrops.');
  assert.equal(answer.model, 'openai/gpt-oss-20b');
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
      if (url.endsWith('/models')) return list(card('openai/gpt-oss-20b'));
      if (!streamed) return completion('openai/gpt-oss-20b', '    return 42\n');
      return stream([event({ model: 'openai/gpt-oss-20b', choices: [{ delta: { content: '    return 42\n' } }] }), event({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\r\n\r\n']);
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

test('coding falls back to another eligible model after a documented stale-model refusal', async () => {
  let requests = 0, lookups = 0;
  const sent = [];
  const newer = 'openai/gpt-oss-120b';
  const older = 'openai/gpt-oss-20b';
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
      if (url.endsWith('/models')) return list(card('openai/gpt-oss-120b'), card('openai/gpt-oss-20b'));
      requests++;
      return response;
    } });
    await assert.rejects(generate({ messages, signal: signal(), purpose: 'draft', code: true }));
    assert.equal(requests, 1);
  }
});

test('recognises GPT-OSS and open-weight fallback families without pretending to provide proprietary models', () => {
  const names = ['openai/gpt-oss-120b', 'gpt-oss-20b', 'openai/gpt-oss-20b-q4', 'koboldcpp/gpt-oss-20b-Q4_K_M', 'llamacpp/openai/gpt-oss-120b', 'Qwen/Qwen3-Coder-30B', 'anthropic/claude-sonnet', 'openai/gpt-4o', 'fake/gpt-oss-120b', 'gpt-oss-120b:free', 'openai/gpt-oss-120b/other'];
  assert.deepEqual(eligibleCommunityModels(names.map(id => ({ id }))).map(m => m.id), names.slice(0, 6));
});

test('a definitive pre-queue model quota rejection tries another eligible model without disclosing the quota', async () => {
  const attempts = [];
  const { generate } = communityEngine({ fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return list(card('openai/gpt-oss-120b'), card('openai/gpt-oss-20b'), card('unrelated'));
    const body = JSON.parse(options.body); attempts.push(body);
    if (body.models[0] === 'openai/gpt-oss-120b') return refusal('no_eligible_worker', 400);
    return completion('openai/gpt-oss-20b', 'Done.');
  } });
  const result = await generate({ messages, signal: signal(), purpose: 'answer' });
  assert.equal(result.text, 'Done.');
  assert.deepEqual(attempts.map(a => a.models), [['openai/gpt-oss-120b'], ['openai/gpt-oss-20b']]);
});

test('fallback never uses a banned or unrelated model, and reports when none are left', async () => {
  let posts = 0;
  const { generate } = communityEngine({ preference: { banned: ['openai/gpt-oss-20b'] }, fetchImpl: async (url) => {
    if (url.endsWith('/models')) return list(card('openai/gpt-oss-120b'), card('openai/gpt-oss-20b'), card('other/model'));
    posts++; return refusal('no_eligible_worker', 400);
  } });
  await assert.rejects(generate({ messages, signal: signal(), purpose: 'answer' }), /No online model could handle/);
  assert.equal(posts, 1);
});

test('unexpected provider model is rejected in JSON and before streaming its text', async () => {
  for (const streamed of [false, true]) {
    const seen = [];
    const { generate } = communityEngine({ fetchImpl: async (url) => {
      if (url.endsWith('/models')) return list(card('openai/gpt-oss-20b'));
      if (!streamed) return completion('other/model', 'wrong');
      return stream([event({ model: 'other/model', choices: [{ delta: { content: 'wrong' } }] }), 'data: [DONE]\r\n\r\n']);
    } });
    await assert.rejects(generate({ messages, signal: signal(), purpose: 'answer', onText: text => seen.push(text) }), /unexpected model/);
    assert.deepEqual(seen, []);
  }
});


test('GPT-OSS worker-prefixed IDs are discovered and sent unchanged', async () => {
  const id = 'koboldcpp/gpt-oss-20b-Q4_K_M';
  let sent;
  const { generate } = communityEngine({ fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return list(card('koboldcpp/Qwen3-14B'), card(id));
    sent = JSON.parse(options.body);
    return completion(id, 'Ready.');
  } });
  const answer = await generate({ messages, signal: signal(), purpose: 'answer' });
  assert.deepEqual(sent.models, [id]);
  assert.equal(answer.model, id);
  assert.equal(answer.text, 'Ready.');
});

test('when GPT-OSS is offline, Qwen and other recognised model families are available', async () => {
  const ids = [
    'koboldcpp/Qwen/Qwen3.8-27B', 'koboldcpp/Qwen3-14B', 'koboldcpp/gemma-4-E4B-it',
    'llamacpp/DeepSeek-R1-70B', 'koboldcpp/Devstral-Small-2-24B', 'llamacpp/Llama-3.3-70B-Instruct',
    'koboldcpp/Qwen3-14B-Base', 'random-claude-sonnet', 'random/gpt-oss-20b',
  ];
  assert.deepEqual(eligibleCommunityModels(ids.map(id => ({ id }))).map(m => m.id), ids.slice(0, 6));
  let sent;
  const { generate } = communityEngine({ fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return list(...ids.map(id => card(id)));
    sent = JSON.parse(options.body);
    return completion(sent.models[0], 'A response');
  } });
  const result = await generate({ messages, purpose: 'answer', signal: signal() });
  assert.ok(ids.slice(0, 6).includes(result.model));
  assert.deepEqual(sent.models, [result.model]);
});

test('GPT-OSS remains preferred when a fallback family is also online', async () => {
  let sent;
  const { generate } = communityEngine({ fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return list(card('koboldcpp/Qwen/Qwen3.8-27B'), card('openai/gpt-oss-20b', { max: 512 }));
    sent = JSON.parse(options.body);
    return completion(sent.models[0], 'OK');
  } });
  await generate({ messages, purpose: 'draft', signal: signal(), code: true });
  assert.deepEqual(sent.models, ['openai/gpt-oss-20b']);
});

test('several definitive pre-queue refusals try distinct supported alternatives', async () => {
  const attempts = [];
  const ids = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'koboldcpp/Qwen3-14B'];
  const { generate } = communityEngine({ fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return list(...ids.map(id => card(id)));
    const id = JSON.parse(options.body).models[0]; attempts.push(id);
    return attempts.length < 3 ? refusal('no_eligible_worker', 400) : completion(id, 'Answer');
  } });
  const result = await generate({ messages, signal: signal(), purpose: 'answer' });
  assert.deepEqual(attempts, ids);
  assert.equal(result.model, ids[2]);
});
