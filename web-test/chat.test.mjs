import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerChat, cleanPrompt, conversationContext, createChat, HISTORY_KEY, newTurn, readChats, saveChats } from '../web/chat.mjs';

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

test('deeper chat uses draft and review internally and shows only the final answer', async () => {
  const chat = createChat('hello');
  newTurn(chat, 'Explain it simply', 'community', true);
  const calls = [], output = [];
  const result = await answerChat({
    messages: conversationContext(chat, 'community'), deep: true, signal: signal(), onText: (text) => output.push(text),
    generate: async (request) => {
      calls.push(request.purpose);
      if (request.purpose === 'draft') {
        assert.equal(request.onText, undefined);
        return { text: 'Draft only', model: 'first-model' };
      }
      if (request.purpose === 'review') {
        assert.match(request.messages.at(-1).content, /Explain it simply[\s\S]*Draft only/);
        assert.equal(request.preferOtherThan, 'first-model');
        assert.equal(request.onText, undefined);
        return { text: 'Specific correction', model: 'different-model' };
      }
      assert.match(request.messages.at(-1).content, /Explain it simply[\s\S]*Draft only[\s\S]*Specific correction/);
      request.onText('Final answer');
      return { text: 'Final answer', model: 'final-model' };
    },
  });
  assert.deepEqual(calls, ['draft', 'review', 'final']);
  assert.deepEqual(output, ['Final answer']);
  assert.equal(result.text, 'Final answer');
});

test('a deeper answer keeps the draft when an extra check fails, but does not continue after Stop', async () => {
  const messages = [{ role: 'system', content: 'test' }, { role: 'user', content: 'Hello' }];
  const result = await answerChat({
    messages, deep: true, signal: signal(), generate: async ({ purpose }) => {
      if (purpose === 'draft') return { text: 'Keep this' };
      throw new Error('Network busy.');
    },
  });
  assert.equal(result.text, 'Keep this');
  assert.match(result.warning, /follow-up check couldn’t finish/);
  const abort = new AbortController();
  let calls = 0;
  await assert.rejects(answerChat({ messages, deep: true, signal: abort.signal, generate: async () => {
    calls++;
    abort.abort();
    return { text: 'Do not continue' };
  } }), { name: 'AbortError' });
  assert.equal(calls, 1);
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
