import assert from 'node:assert/strict';
import { test } from 'node:test';
import { communityEngine, getOnlineModels, planCommunityRequest } from '../web/community.mjs';
import { createRun, executeRelay, PLANS, resultStep } from '../web/relay.mjs';

const api = 'https://oai.aihorde.net/v1';
const signal = () => new AbortController().signal;
const card = (id, { workers = 2, queued = 0, context = 8192, max = 1024 } = {}) => ({
  id, context_length: context, top_provider: { max_completion_tokens: max }, x_horde: { workers, queued },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
});
const json = (data, init) => Response.json(data, init);
const list = (...cards) => json({ data: cards });
const completion = (model, text, finish_reason = 'stop') => json({ model, choices: [{ message: { content: text }, finish_reason }] });
const refusal = (code, status, headers) => json({ error: { code } }, { status, headers });

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

test('offers up to five context-compatible models and stays within free output limits', async () => {
  const models = await getOnlineModels({ fetchImpl: async () => list(
    card('small-context', { context: 96 }),
    ...Array.from({ length: 8 }, (_, index) => card(`model-${index}`)),
  ) });
  const request = planCommunityRequest(models, { stage: PLANS.review[0], input: 'Test message' });
  assert.equal(request.models.length, 5);
  assert.ok(!request.models.includes('small-context'));
  assert.equal(request.max_tokens, 512);
  assert.deepEqual(request.messages, [{ role: 'user', content: 'Test message' }]);
  assert.equal(request.horde.include_reasoning, false);
  const lowLimit = planCommunityRequest([{ id: 'limited', context: 2048, tokens: 96 }], { stage: PLANS.quick[0], input: 'Small request' });
  assert.equal(lowLimit.max_tokens, 96);
});

test('rediscovers models each step, prefers another reviewer and records the serving model', async () => {
  const replies = [
    ['driver', 'A draft.'], ['peer', 'Reviewer feedback.'], ['replacement', 'A final answer.', 'length'],
  ];
  const batches = [[card('driver'), card('peer')], [card('driver'), card('peer')], [card('replacement')]];
  const bodies = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/models')) return list(...batches.shift());
    assert.equal(url, `${api}/chat/completions`);
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers['X-Title'], 'Frenemy Web');
    assert.equal(new Headers(options.headers).has('Authorization'), false);
    bodies.push(JSON.parse(options.body));
    return completion(...replies.shift());
  };
  const { generate } = communityEngine({ fetchImpl });
  const run = createRun({ id: 'network', prompt: 'Explain caching.', mode: 'review', engine: 'community', names: { driver: 'Auto', reviewer: 'Auto' } });
  await executeRelay(run, { generate, signal: signal() });
  assert.equal(run.state, 'complete', run.error);
  assert.deepEqual(bodies.map(({ models }) => models), [['driver', 'peer'], ['peer'], ['replacement']]);
  assert.match(bodies[1].messages[0].content, /A draft\./);
  assert.match(bodies[2].messages[0].content, /Reviewer feedback\./);
  assert.deepEqual(run.steps.map(({ model }) => model), ['driver', 'peer', 'replacement']);
  assert.equal(run.steps[2].limited, true);
});

test('retains the draft as an answer when the provider rate-limits a later stage', async () => {
  let requests = 0;
  const pauses = [];
  const { generate } = communityEngine({
    fetchImpl: async (url) => {
      if (url.endsWith('/models')) return list(card('only-model'));
      requests += 1;
      return requests === 1 ? completion('only-model', 'A useful draft.') : refusal('rate_limit_exceeded', 429, { 'Retry-After': '12' });
    },
    onLimit: (time) => pauses.push(time),
  });
  const run = createRun({ id: 'network', prompt: 'Explain caching.', mode: 'review', engine: 'community', names: { driver: 'Auto', reviewer: 'Auto' } });
  await executeRelay(run, { generate, signal: signal() });
  assert.equal(run.state, 'partial');
  assert.equal(resultStep(run), 'draft');
  assert.equal(run.steps[0].model, 'only-model');
  assert.match(run.error, /Try again in about 12 seconds/);
  assert.equal(requests, 2);
  assert.deepEqual(pauses, [12]);
});

test('reroutes a stale unqueued model once, and then only if the roster changed', async () => {
  for (const replacement of ['different', 'stale']) {
    let lookups = 0;
    const requests = [];
    const { generate } = communityEngine({ fetchImpl: async (url, options) => {
      if (url.endsWith('/models')) return list(card(lookups++ ? replacement : 'stale'));
      requests.push(JSON.parse(options.body).models);
      return requests.length === 1 ? refusal('UnknownChatModel', 404) : completion(replacement, 'A direct answer.');
    } });
    const result = generate({ stage: PLANS.quick[0], input: 'Hello', signal: signal() });
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

test('the client does not submit to an empty pool or duplicate uncertain requests', async () => {
  let posts = 0;
  const { generate } = communityEngine({ fetchImpl: async (url) => {
    if (url.endsWith('/models')) return list();
    posts += 1;
  } });
  await assert.rejects(generate({ stage: PLANS.quick[0], input: 'Hello', signal: signal() }), /No eligible text models/);
  assert.equal(posts, 0);
  for (const failure of [() => refusal('no_eligible_worker', 503, { 'x-should-retry': 'false' }), () => { throw new TypeError('network'); }]) {
    const { generate: ask } = communityEngine({ fetchImpl: async (url) => {
      if (url.endsWith('/models')) return list(card('served'));
      posts += 1;
      return failure();
    } });
    await assert.rejects(ask({ stage: PLANS.quick[0], input: 'Hello', signal: signal() }));
  }
  assert.equal(posts, 2);
});

test('stopping a run aborts the browser’s community request', async () => {
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const controller = new AbortController();
  const { generate } = communityEngine({ fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return list(card('online'));
    started();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const reply = generate({ stage: PLANS.quick[0], input: 'Hello', signal: controller.signal });
  await waiting;
  controller.abort();
  await assert.rejects(reply, { name: 'AbortError' });
});
