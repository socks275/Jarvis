import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXAMPLES, demoGenerator } from '../web/demo.mjs';
import {
  addToHistory, createRun, executeRelay, HISTORY_KEY, PROMPT_LIMIT, readHistory, resultStep, saveHistory,
} from '../web/relay.mjs';

const makeRun = (overrides = {}) => createRun({
  id: 'test', prompt: 'Explain caching.', mode: 'review', engine: 'local',
  names: { driver: 'Driver model', reviewer: 'Reviewer model' }, ...overrides,
});

const execute = (run, options) => executeRelay(run, { signal: new AbortController().signal, ...options });

test('a review passes actual text from the draft and review to the next model', async () => {
  const run = makeRun();
  const calls = [];
  await execute(run, {
    generate: async ({ stage, input }) => {
      calls.push({ role: stage.role, input });
      return { draft: 'The first draft.', review: 'A specific change.', final: 'The revised answer.' }[stage.key];
    },
  });
  assert.deepEqual(calls.map(({ role }) => role), ['driver', 'reviewer', 'driver']);
  assert.ok(calls.every(({ input }) => input.includes('Explain caching.')));
  assert.match(calls[1].input, /Draft:\nThe first draft\./);
  assert.match(calls[2].input, /Draft:\nThe first draft\.\n\nReview:\nA specific change\./);
  assert.equal(run.state, 'complete');
  assert.deepEqual(run.steps.map(({ state }) => state), ['done', 'done', 'done']);
  assert.equal(run.steps[2].text, 'The revised answer.');
  assert.equal(resultStep(run), 'final');
  assert.equal(resultStep(run, 'draft'), 'draft');
});

test('compare mode does not let the reviewer see the driver’s response', async () => {
  const run = makeRun({ mode: 'compare' });
  await execute(run, {
    generate: async ({ stage, input }) => {
      assert.match(input, /Explain caching\./);
      assert.doesNotMatch(input, /First model’s answer/);
      return stage.role === 'driver' ? 'First model’s answer' : 'Second model’s answer';
    },
  });
  assert.equal(run.state, 'complete', run.error);
  assert.deepEqual(run.steps.map(({ text }) => text), ['First model’s answer', 'Second model’s answer']);
});

test('stop preserves finished stages and does not start a subsequent stage', async () => {
  const run = makeRun();
  const controller = new AbortController();
  await execute(run, {
    signal: controller.signal,
    generate: async ({ stage }) => {
      if (stage.key === 'review') controller.abort();
      assert.notEqual(stage.key, 'final');
      return 'First response';
    },
  });
  assert.equal(run.state, 'stopped');
  assert.deepEqual(run.steps.map(({ state, text }) => [state, text]), [['done', 'First response'], ['stopped', ''], ['waiting', '']]);
  assert.equal(resultStep(run), 'draft');
});

test('empty or failed model replies do not show a successful relay', async () => {
  for (const generate of [async () => '  ', async () => { throw new Error('Unsupported model'); }]) {
    const run = makeRun();
    await execute(run, { generate });
    assert.equal(run.state, 'failed');
    assert.equal(run.steps[0].state, 'failed');
    assert.equal(run.steps[1].state, 'waiting');
    assert.match(run.error, /no text|Unsupported model/);
  }
});

test('the demo shows sample answers or identifies custom prompts as demonstration only', async () => {
  const sample = EXAMPLES[0];
  const run = makeRun({ engine: 'demo', prompt: sample.prompt });
  const custom = makeRun({ engine: 'demo' });
  await execute(run, { generate: demoGenerator(run.prompt, 0) });
  await execute(custom, { generate: demoGenerator(custom.prompt, 0) });
  assert.equal(run.steps[2].text, sample.final);
  assert.match(custom.steps[0].text, /This demo does not generate an answer/);
});

test('rejects invalid prompts and relay types', () => {
  assert.throws(() => makeRun({ prompt: '  ' }), /Enter a prompt/);
  assert.throws(() => makeRun({ prompt: 'a'.repeat(PROMPT_LIMIT + 1) }), /Enter a prompt/);
  assert.throws(() => makeRun({ mode: '__proto__' }), /Choose a relay type/);
});

test('history is capped, tolerates bad storage and can be cleared', async () => {
  const stored = new Map();
  const storage = {
    getItem: (key) => stored.get(key),
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };
  const run = await execute(makeRun(), { generate: async () => 'Text' });
  let items = [];
  for (let i = 0; i < 24; i++) items = addToHistory(items, { ...run, id: `run-${i}` });
  assert.equal(items.length, 16);
  assert.equal(addToHistory(items, items[0]).length, 16);
  assert.ok(saveHistory(storage, items));
  assert.deepEqual(readHistory(storage), items);
  stored.set(HISTORY_KEY, JSON.stringify([{}, { ...run, mode: 'constructor' }, items[0]]));
  assert.deepEqual(readHistory(storage), [items[0]]);
  stored.set(HISTORY_KEY, '<broken>');
  assert.deepEqual(readHistory(storage), []);
  assert.equal(saveHistory(null, items), false);
  assert.ok(saveHistory(storage, []));
  assert.equal(stored.has(HISTORY_KEY), false);
});
