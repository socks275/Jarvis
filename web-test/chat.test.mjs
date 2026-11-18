import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerChat, cleanPrompt, conversationContext, createChat, HISTORY_KEY, newTurn, planAnswer, readChats, readDecision, saveChats } from '../web/chat.mjs';

const signal = () => new AbortController().signal;
const fakeStorage = () => {
  const map = new Map();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, val) => map.set(key, val), removeItem: (key) => map.delete(key) };
};

function turn(chat, question, text, engine = 'community', status = 'complete') {
  const reply = newTurn(chat, question, engine);
  Object.assign(reply, { text, status });
  return reply;
}

test('a follow-up includes recent messages with user and assistant roles', () => {
  const chat = createChat('Please explain caching.');
  turn(chat, 'Please explain caching.', 'A cache keeps a reusable copy.');
  newTurn(chat, 'Give me an example.', 'community');
  const messages = conversationContext(chat, 'community');
  assert.equal(messages[0].role, 'system');
  assert.deepEqual(messages.slice(1), [
    { role: 'user', content: 'Please explain caching.' }, { role: 'assistant', content: 'A cache keeps a reusable copy.' },
    { role: 'user', content: 'Give me an example.' },
  ]);
});

test('an online turn does not include private local history, stopped replies, or older context', () => {
  const chat = createChat('First chat');
  turn(chat, 'User text', 'private local answer', 'local');
  turn(chat, 'Interrupted prompt', 'stopped partial answer', 'community', 'stopped');
  for (let i = 0; i < 9; i++) turn(chat, `question ${i}`, `answer ${i}`);
  newTurn(chat, 'latest', 'community');
  const messages = conversationContext(chat, 'community');
  assert.equal(messages.length, 16);
  assert.equal(messages[1].content, 'question 2');
  assert.equal(messages.at(-1).content, 'latest');
  assert.doesNotMatch(JSON.stringify(messages), /local answer|stopped partial answer/);
});

test('normal chat asks a single model and passes live output through', async () => {
  const emitted = [];
  const result = await answerChat({
    messages: [{ role: 'user', content: 'Hello' }], signal: signal(), onText: (text) => emitted.push(text),
    generate: async ({ purpose, onText }) => {
      assert.equal(purpose, 'answer');
      onText('Good ');
      onText('Good morning.');
      return { text: 'Good morning.', model: 'one-model' };
    },
  });
  assert.deepEqual(emitted, ['Good ', 'Good morning.']);
  assert.deepEqual(result, { text: 'Good morning.', model: 'one-model' });
});

test('picks the team size from the message: only small talk alone, requests in pairs, code as a panel', () => {
  assert.equal(planAnswer('hi').mode, 'solo');
  assert.equal(planAnswer('thanks, that helps a lot').mode, 'solo');
  assert.equal(planAnswer('nice!').mode, 'solo');
  assert.equal(planAnswer('Explain how rainbows form').mode, 'pair');
  assert.equal(planAnswer('explain gravity').mode, 'pair');
  assert.equal(planAnswer('Explain caching to me?').mode, 'pair');
  assert.equal(planAnswer('What is a cache').mode, 'pair');
  assert.equal(planAnswer('tell me about Rome').mode, 'pair');
  assert.equal(planAnswer('x'.repeat(259)).mode, 'pair');
  assert.equal(planAnswer('x'.repeat(300)).mode, 'panel');
  assert.equal(planAnswer('Why does this npm test fail?').mode, 'panel');
  assert.equal(planAnswer('```js\nconst a = 1;\n```').mode, 'panel');
  assert.equal(planAnswer('hi', { deep: true }).mode, 'panel');
});

test('reads the decider’s one-word verdict however it is written', () => {
  assert.equal(readDecision('two'), 'pair');
  assert.equal(readDecision('2'), 'pair');
  assert.equal(readDecision('Three models.'), 'panel');
  assert.equal(readDecision('**one**'), 'solo');
  assert.equal(readDecision('single'), 'solo');
  assert.equal(readDecision('Two models, not three.'), 'pair');
  assert.equal(readDecision('I cannot help'), undefined);
  assert.equal(readDecision(''), undefined);
});

test('one model decides the team size, and its verdict overrides the built-in guess', async () => {
  const calls = [], triagePrompts = [];
  const result = await answerChat({
    messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'hi' }],
    signal: signal(), decide: true,
    generate: async (request) => {
      calls.push(request.purpose);
      if (request.purpose === 'triage') {
        triagePrompts.push(request.messages);
        return { text: 'two', model: 'decider-model' };
      }
      if (request.purpose === 'draft') return { text: 'Draft', model: 'model-a' };
      return { text: 'Final', model: 'model-b' };
    },
  });
  // "hi" would be answered alone, but the decider asked for a second model.
  assert.deepEqual(calls, ['triage', 'draft', 'final']);
  assert.equal(triagePrompts[0].length, 2);
  assert.match(triagePrompts[0].at(-1).content, /hi/);
  assert.deepEqual(result.team, [{ role: 'triage', model: 'decider-model', pick: 'pair' },
    { role: 'draft', model: 'model-a' }, { role: 'final', model: 'model-b' }]);
  assert.equal(result.text, 'Final');
});

test('a decider that chooses one model is taken at its word and the trail records it', async () => {
  const calls = [];
  const result = await answerChat({
    messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'Why does my npm test fail?' }],
    signal: signal(), decide: true,
    generate: async (request) => {
      calls.push(request.purpose);
      if (request.purpose === 'triage') return { text: 'one', model: 'decider-model' };
      return { text: 'Single answer', model: 'model-a' };
    },
  });
  assert.deepEqual(calls, ['triage', 'answer']);
  assert.equal(result.text, 'Single answer');
  assert.deepEqual(result.team, [{ role: 'triage', model: 'decider-model', pick: 'solo' },
    { role: 'answer', model: 'model-a' }]);
});

test('a broken or unreadable decider falls back to the built-in guess', async () => {
  const messages = [{ role: 'system', content: 'test' }, { role: 'user', content: 'Why does my npm test fail?' }];
  for (const verdict of [null, 'banana']) {
    const calls = [];
    await answerChat({
      messages, signal: signal(), decide: true,
      generate: async (request) => {
        calls.push(request.purpose);
        if (request.purpose === 'triage') {
          if (verdict === null) throw new Error('No model could decide.');
          return { text: verdict, model: 'decider-model' };
        }
        if (request.purpose === 'draft') return { text: 'Draft', model: 'model-a' };
        if (request.purpose === 'review') return { text: 'Notes', model: 'model-b' };
        return { text: 'Final', model: 'model-c' };
      },
    });
    // The message is code, so the guess is the three-model panel.
    assert.deepEqual(calls, ['triage', 'draft', 'review', 'final']);
  }
});

test('Think deeper skips the vote and goes straight to the full panel', async () => {
  const calls = [];
  await answerChat({
    messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'hi' }],
    signal: signal(), decide: true, deep: true,
    generate: async (request) => {
      calls.push(request.purpose);
      if (request.purpose === 'draft') return { text: 'Draft', model: 'model-a' };
      if (request.purpose === 'review') return { text: 'Notes', model: 'model-b' };
      return { text: 'Final', model: 'model-c' };
    },
  });
  assert.deepEqual(calls, ['draft', 'review', 'final']);
});

test('a normal question has one model draft and a second model finish it', async () => {
  const calls = [], output = [], steps = [];
  const result = await answerChat({
    messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'Explain caching to me?' }],
    signal: signal(), onText: (text) => output.push(text), onStep: (step) => steps.push(`${step.role}:${step.state}`),
    generate: async (request) => {
      calls.push(request.purpose);
      if (request.purpose === 'draft') {
        assert.equal(request.preferOtherThan, undefined);
        assert.equal(typeof request.onText, 'function');
        request.onText('A draft answer');
        return { text: 'A draft answer', model: 'first-model' };
      }
      assert.equal(request.purpose, 'final');
      assert.equal(request.preferOtherThan, 'first-model');
      assert.match(request.messages.at(-1).content, /Explain caching to me\?[\s\S]*A draft answer/);
      request.onText('The finished answer');
      return { text: 'The finished answer', model: 'second-model' };
    },
  });
  assert.deepEqual(calls, ['draft', 'final']);
  assert.deepEqual(output, ['A draft answer', 'The finished answer']);
  assert.deepEqual(steps, ['draft:active', 'draft:done', 'final:active', 'final:done']);
  assert.equal(result.text, 'The finished answer');
  assert.deepEqual(result.team, [{ role: 'draft', model: 'first-model' }, { role: 'final', model: 'second-model' }]);
});

test('a coding question brings in a third model to review before the final answer', async () => {
  const calls = [];
  const result = await answerChat({
    messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'Why does my npm test fail with this error?' }],
    signal: signal(),
    generate: async (request) => {
      calls.push(request.purpose);
      if (request.purpose === 'draft') return { text: 'Draft fix', model: 'model-a' };
      if (request.purpose === 'review') {
        assert.equal(request.preferOtherThan, 'model-a');
        assert.match(request.messages.at(-1).content, /npm test fail[\s\S]*Draft fix/);
        return { text: 'Check the import', model: 'model-b' };
      }
      assert.equal(request.purpose, 'final');
      assert.deepEqual(request.preferOtherThan, ['model-a', 'model-b']);
      assert.match(request.messages.at(-1).content, /Draft fix[\s\S]*Check the import/);
      request.onText('Final fix');
      return { text: 'Final fix', model: 'model-c' };
    },
  });
  assert.deepEqual(calls, ['draft', 'review', 'final']);
  assert.deepEqual(result.team.map((step) => step.model), ['model-a', 'model-b', 'model-c']);
  assert.equal(result.text, 'Final fix');
});

test('a local reply stays with one model even for a coding question', async () => {
  const calls = [];
  const result = await answerChat({
    messages: [{ role: 'user', content: 'Why does my npm test fail?' }], signal: signal(), mode: 'solo',
    generate: async ({ purpose }) => { calls.push(purpose); return { text: 'Local answer', model: 'local-model' }; },
  });
  assert.deepEqual(calls, ['answer']);
  assert.equal(result.team, undefined);
});

test('a team answer keeps the draft when a later model fails, but does not continue after Stop', async () => {
  const messages = [{ role: 'system', content: 'test' }, { role: 'user', content: 'Why does my npm test fail?' }];
  const result = await answerChat({
    messages, signal: signal(), generate: async ({ purpose }) => {
      if (purpose === 'draft') return { text: 'Keep this', model: 'model-a' };
      throw new Error('Network busy.');
    },
  });
  assert.equal(result.text, 'Keep this');
  assert.match(result.warning, /Showing one model’s draft/);
  assert.deepEqual(result.team, [{ role: 'draft', model: 'model-a' }]);
  const abort = new AbortController();
  let calls = 0;
  await assert.rejects(answerChat({ messages, signal: abort.signal, generate: async () => {
    calls++;
    abort.abort();
    return { text: 'Do not continue', model: 'model-a' };
  } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('team trails are saved and reloaded, and a malformed trail is not rendered', () => {
  const storage = fakeStorage();
  const chat = createChat('Explain caching to me?');
  const reply = newTurn(chat, 'Explain caching to me?', 'community');
  Object.assign(reply, { text: 'An answer', status: 'complete', team: [{ role: 'draft', model: 'a' }, { role: 'final', model: 'b' }] });
  assert.equal(saveChats(storage, [chat]), true);
  assert.deepEqual(readChats(storage)[0].messages[1].team, [{ role: 'draft', model: 'a' }, { role: 'final', model: 'b' }]);
  const bad = { ...chat, messages: chat.messages.map((m) => (m.role === 'assistant' ? { ...m, team: [{ role: 'hack' }] } : m)) };
  storage.setItem(HISTORY_KEY, JSON.stringify([bad]));
  assert.deepEqual(readChats(storage), []);
});

test('saved chats are reloadable, sorted and bounded; requests still in progress restore as stopped', () => {
  const storage = fakeStorage();
  const chats = Array.from({ length: 40 }, (_, i) => {
    const chat = createChat(`Chat ${i}`);
    newTurn(chat, 'Still waiting', 'community');
    chat.updatedAt = i;
    return chat;
  });
  assert.equal(saveChats(storage, chats), true);
  const restored = readChats(storage);
  assert.equal(restored.length, 32);
  assert.equal(restored[0].title, 'Chat 39');
  assert.equal(restored[0].messages.at(-1).status, 'stopped');
  assert.equal(chats[0].messages.at(-1).status, 'pending');
  assert.equal(saveChats(storage, []), true);
  assert.deepEqual(readChats(storage), []);
  storage.setItem(HISTORY_KEY, 'bad json');
  assert.deepEqual(readChats(storage), []);
});

test('existing local and community answers are migrated into chats without keeping demos or reviews', () => {
  const storage = fakeStorage();
  const key = 'frenemy-web:runs:v1';
  const run = {
    prompt: 'My old prompt', createdAt: 100, engine: 'community', steps: [
      { key: 'draft', state: 'done', text: 'Original draft' }, { key: 'review', state: 'done', text: 'Reviewer notes' },
      { key: 'final', state: 'done', text: 'The final answer', model: 'served-model' },
    ],
  };
  storage.setItem(key, JSON.stringify([run, { ...run, engine: 'demo' }]));
  const saved = readChats(storage);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].messages[0].text, run.prompt);
  assert.equal(saved[0].messages[1].text, 'The final answer');
  assert.equal(saved[0].messages[1].model, 'served-model');
  assert.equal(storage.getItem(key), null);
  assert.deepEqual(readChats(storage), saved);
});

test('checks prompt limits independently of the textarea', () => {
  assert.equal(cleanPrompt('  hello  '), 'hello');
  assert.throws(() => cleanPrompt(' '.repeat(8)), /Enter a message/);
  assert.throws(() => cleanPrompt('x'.repeat(4001)), /4,000/);
});
