import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerChat, chatToJson, chatToMarkdown, cleanPrompt, conversationContext, createChat, HISTORY_KEY, instructionsFor, isCodeRequest, isRefusal, joinContinuation, newTurn, orderedChats, planAnswer, readChats, readDecision, rewindTo, saveChats } from '../web/chat.mjs';

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

test('knows when a message is about code', () => {
  for (const text of ['Why does my npm test fail?', 'fix this python', '```js\nconst a = 1\n```', 'what is a race condition in go', 'refactor this function']) {
    assert.equal(isCodeRequest(text), true, text);
  }
  for (const text of ['hi', 'thanks!', 'what is a rainbow?', 'write a poem about rain']) {
    assert.equal(isCodeRequest(text), false, text);
  }
});

test('a coding message carries the coding rules and the other messages do not', () => {
  const chat = createChat('x');
  turn(chat, 'How do I sort a list in python?', 'Use sorted().');
  newTurn(chat, 'Now make it stable for one key', 'community');
  assert.match(conversationContext(chat, 'community')[0].content, /senior engineer whose code has to run/);

  const small = createChat('y');
  turn(small, 'What is a rainbow?', 'Light bending.');
  newTurn(small, 'And why is it curved?', 'community');
  assert.doesNotMatch(conversationContext(small, 'community')[0].content, /senior engineer/);
});

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

test('a long artifact is summarised for the conversation, not pasted whole', () => {
  const chat = createChat('x');
  const reply = turn(chat, 'make a 3d shooter', `${'<'.repeat(50)} a very long game file`);
  reply.summary = 'Built a complete 3D shooter as one HTML file.';
  newTurn(chat, 'can it have a shotgun?', 'community');
  const messages = conversationContext(chat, 'community');
  assert.equal(messages[2].content, 'Built a complete 3D shooter as one HTML file.');
  assert.doesNotMatch(JSON.stringify(messages), /a very long game file/);
});

test('turns older than the window are condensed instead of forgotten', () => {
  const chat = createChat('x');
  for (let i = 0; i < 12; i++) turn(chat, `question ${i}`, `answer ${i}`);
  newTurn(chat, 'latest', 'community');
  const messages = conversationContext(chat, 'community');
  const digest = messages.find((m) => m.role === 'system' && m.content.startsWith('Earlier in this conversation'));
  assert.ok(digest, 'no digest');
  assert.match(digest.content, /question 0/);
  assert.match(digest.content, /answer 0/);
  // The recent turns are still sent in full, and the digest does not repeat them.
  assert.equal(messages[2].content, 'question 5');
  assert.doesNotMatch(digest.content, /question 5/);
  // The digest stays inside its budget.
  assert.ok(digest.content.length < 1000, String(digest.content.length));
  // Everything is still in order: system, digest, then the recent turns.
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1], digest);
  assert.equal(messages.at(-1).content, 'latest');
});

test('an online turn keeps no private local history and no half-written answers', () => {
  const chat = createChat('First chat');
  turn(chat, 'User text', 'private local answer', 'local');
  turn(chat, 'Interrupted prompt', 'stopped partial answer', 'community', 'stopped');
  for (let i = 0; i < 9; i++) turn(chat, `question ${i}`, `answer ${i}`);
  newTurn(chat, 'latest', 'community');
  const messages = conversationContext(chat, 'community');
  // A local answer and a cut-off answer never leave the machine.
  assert.doesNotMatch(JSON.stringify(messages), /private local answer|stopped partial answer/);
  // The question from the stopped turn is still there, and so are older turns.
  const all = JSON.stringify(messages);
  assert.match(all, /Interrupted prompt/);
  assert.match(all, /question 0/);
  // The window is still seven turns of full text: system, digest, 14 turns, latest.
  assert.equal(messages.length, 17);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[1].content, /^Earlier in this conversation/);
  assert.equal(messages.at(-1).content, 'latest');
});

test('the on-device model reads the community turns already in the chat', () => {
  const chat = createChat('x');
  turn(chat, 'What is a rainbow?', 'Light bending in raindrops.', 'community');
  turn(chat, 'And what is a local model?', 'One that runs here.', 'local');
  newTurn(chat, 'Keep going on the local model.', 'local');
  const local = JSON.stringify(conversationContext(chat, 'local'));
  assert.match(local, /Light bending in raindrops\./);
  assert.match(local, /One that runs here\./);
  // The reverse must still never happen: a local answer never reaches the pool.
  newTurn(chat, 'Ask the pool again?', 'community');
  const online = JSON.stringify(conversationContext(chat, 'community'));
  assert.match(online, /Light bending in raindrops\./);
  assert.doesNotMatch(online, /One that runs here\./);
});

test('a follow-up keeps the question it refers to even when that answer was stopped', () => {
  const chat = createChat('x');
  turn(chat, 'Compare Postgres and MySQL for billing', 'Postgres is better becau', 'community', 'stopped');
  // An answer that errored never wrote a word, but the question was still asked.
  turn(chat, 'Which licence does Postgres use?', '', 'community', 'error');
  newTurn(chat, 'So which one did you pick, and why?', 'community');
  const messages = conversationContext(chat, 'community');
  assert.deepEqual(messages.slice(1).map((m) => m.content), [
    'Compare Postgres and MySQL for billing',
    'Which licence does Postgres use?',
    'So which one did you pick, and why?',
  ]);
  // A half-written answer is not passed off as one, and still nothing local.
  assert.doesNotMatch(JSON.stringify(messages), /Postgres is better becau/);
});

test('every model in a team reads the earlier turns, not only the draft it is given', async () => {
  const chat = createChat('x');
  turn(chat, 'Earlier question about caching', 'A cache keeps a reusable copy.');
  newTurn(chat, 'And what about invalidation?', 'community');
  const messages = conversationContext(chat, 'community');
  const seen = [];
  await answerChat({
    messages, signal: signal(), deep: true,
    generate: async (request) => {
      seen.push(request);
      if (request.purpose === 'draft') return { text: 'Draft text', model: 'model-a' };
      if (request.purpose === 'review') return { text: 'Review notes', model: 'model-b' };
      return { text: 'Final text', model: 'model-c' };
    },
  });
  assert.deepEqual(seen.map((r) => r.purpose), ['draft', 'review', 'final']);
  for (const request of seen) {
    const contents = request.messages.map((m) => m.content);
    assert.ok(contents.includes('Earlier question about caching'), `${request.purpose} lost the earlier question`);
    assert.ok(contents.some((c) => c.includes('A cache keeps a reusable copy.')), `${request.purpose} lost the earlier answer`);
    assert.match(request.messages[0].content, /conversation so far/, `${request.purpose} lost the conversation rules`);
  }
  // The two checking models keep their role instructions as well.
  assert.match(seen[1].messages[0].content, /second of three/);
  assert.match(seen[2].messages[0].content, /third of three/);
});

test('a coding task is checked for bugs and finished as runnable code', async () => {
  const seen = [];
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Why does my npm test fail with a TypeError?' }];
  await answerChat({
    messages, signal: signal(), deep: true,
    generate: async (request) => {
      seen.push(request);
      if (request.purpose === 'draft') return { text: 'draft', model: 'model-a', limited: true };
      if (request.purpose === 'review') return { text: 'notes', model: 'model-b' };
      return { text: 'final', model: 'model-c' };
    },
  });
  for (const request of seen) assert.equal(request.code, true, request.purpose);
  const by = Object.fromEntries(seen.map((r) => [r.purpose, r]));
  assert.deepEqual(Object.keys(by).sort(), ['continue', 'draft', 'final', 'review']);
  assert.match(by.review.messages[0].content, /fail to compile or run/);
  assert.match(by.final.messages[0].content, /complete, runnable code/);
  // The rules are stated once, not prepended twice.
  assert.equal((by.final.messages[0].content.match(/rules/g) || []).length, 1);
});

test('a question that is not about code keeps the ordinary team instructions', async () => {
  const seen = [];
  await answerChat({
    messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Why is the sky blue?' }],
    signal: signal(), deep: true,
    generate: async (request) => {
      seen.push(request);
      if (request.purpose === 'draft') return { text: 'draft', model: 'model-a' };
      if (request.purpose === 'review') return { text: 'notes', model: 'model-b' };
      return { text: 'final', model: 'model-c' };
    },
  });
  assert.equal(seen[0].code, false);
  assert.doesNotMatch(seen[1].messages[0].content, /fail to compile/);
});

test('a refusal is recognised, an answer that merely apologises is not', () => {
  for (const text of [
    'I cannot help with that.',
    "I'm sorry, but I can't do that.",
    'As an AI language model, I cannot write that.',
    'I am unable to provide this.',
    '',
  ]) assert.equal(isRefusal(text), true, text);
  for (const text of [
    'Rainbows form when light bends in raindrops.',
    'I can\'t run this here, but here it is:\n```js\nconst a = 1;\n```',
    'Sure — here is the function you asked for, with the imports it needs.',
  ]) assert.equal(isRefusal(text), false, text);
});

test('a model that declines is asked again, by another model and more plainly', async () => {
  const seen = [];
  const result = await answerChat({
    messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Write a Python web scraper.' }],
    signal: signal(), mode: 'solo',
    generate: async (request) => {
      seen.push(request);
      if (seen.length === 1) return { text: 'I cannot help with that.', model: 'model-a', limited: false };
      return { text: 'Here it is:\n```python\nimport requests\nhtml = requests.get(url).text\n```', model: 'model-b' };
    },
  });
  assert.equal(seen.length, 2);
  assert.match(result.text, /import requests/);
  assert.equal(result.model, 'model-b');
  // The retry says what is wanted and avoids the model that declined.
  assert.ok(seen[1].messages.some((m) => m.role === 'system' && /not a refusal/.test(m.content)));
  assert.deepEqual(seen[1].preferOtherThan, ['model-a']);
});

test('a coding request answered in prose is asked again for the code itself', async () => {
  const seen = [];
  const result = await answerChat({
    messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Write a function that reverses a string in Python.' }],
    signal: signal(), mode: 'solo',
    generate: async (request) => {
      seen.push(request);
      return seen.length === 1
        ? { text: 'You can reverse a string with slicing.', model: 'model-a' }
        : { text: '```python\ndef reverse(text):\n    return text[::-1]\n```', model: 'model-b' };
    },
  });
  assert.equal(seen.length, 2);
  assert.match(result.text, /text\[::-1\]/);
  assert.ok(seen[1].messages.some((m) => m.role === 'system' && /fenced block containing the complete/.test(m.content)));
});

test('when every model declines the reader is told what to do, not left with a refusal', async () => {
  let calls = 0;
  const result = await answerChat({
    messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Write a Python web scraper.' }],
    signal: signal(), mode: 'solo',
    generate: async () => { calls++; return { text: "I'm sorry, but I can't do that.", model: `model-${calls}` }; },
  });
  assert.equal(calls, 3);
  assert.doesNotMatch(result.text, /I cannot|can't do that/i);
  assert.match(result.text, /rephrasing usually gets through/);
});

test('a final pass that declines does not replace a draft that answered', async () => {
  const result = await answerChat({
    messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Why is the sky blue?' }],
    signal: signal(), mode: 'pair',
    generate: async (request) => {
      if (request.purpose === 'draft') return { text: 'Sunlight scatters off air molecules.', model: 'model-a' };
      return { text: 'I cannot help with that.', model: 'model-b' };
    },
  });
  assert.equal(result.text, 'Sunlight scatters off air molecules.');
  assert.match(result.warning ?? '', /rephrasing usually gets through/);
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
  assert.equal(planAnswer('what is a race condition in go').mode, 'panel');
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

test('a decider can choose one model for a non-coding question and the trail records it', async () => {
  const calls = [];
  const result = await answerChat({
    messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'Why do clouds form?' }],
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

test('a reply cut off at the output limit is continued instead of being left short', async () => {
  const output = [], calls = [];
  const result = await answerChat({
    messages: [{ role: 'user', content: 'hi' }], signal: signal(), onText: (text) => output.push(text),
    generate: async (request) => {
      calls.push(request.purpose);
      if (request.purpose === 'answer') {
        request.onText('function add(a, b) {\n  retur');
        return { text: 'function add(a, b) {\n  retur', model: 'model-a', limited: true };
      }
      assert.equal(request.purpose, 'continue');
      assert.match(request.messages.at(-1).content, /Continue exactly where/);
      assert.equal(request.messages.at(-2).role, 'assistant');
      request.onText('n a + b;\n}');
      return { text: 'n a + b;\n}', model: 'model-b' };
    },
  });
  assert.deepEqual(calls, ['answer', 'continue']);
  assert.equal(result.text, 'function add(a, b) {\n  return a + b;\n}');
  assert.equal(result.limited, undefined);
  assert.equal(output.at(-1), result.text);
});

test('a continuation that restarts the answer does not duplicate it', () => {
  const head = 'Here is a careful explanation of caching that goes on for a while';
  assert.equal(joinContinuation(head, head.slice(-40) + ' and then some more'),
    head + ' and then some more');
  assert.equal(joinContinuation('abc', ''), 'abc');
});

test('a failed continuation keeps the part that already streamed', async () => {
  const result = await answerChat({
    messages: [{ role: 'user', content: 'hi' }], signal: signal(),
    generate: async (request) => {
      if (request.purpose === 'continue') throw new Error('The network dropped.');
      return { text: 'Half an answer', model: 'model-a', limited: true };
    },
  });
  assert.equal(result.text, 'Half an answer');
  assert.equal(result.limited, true);
});

test('a reply is continued as many times as the model still has something to add', async () => {
  let calls = 0;
  const parts = [];
  const result = await answerChat({
    messages: [{ role: 'user', content: 'hi' }], signal: signal(),
    generate: async (request) => {
      calls++;
      request.onText?.(`part ${calls} `);
      if (request.purpose === 'continue') parts.push(request.messages.at(-2).content);
      return { text: `part ${calls} `, model: 'model-a', limited: calls < 4 };
    },
  });
  assert.equal(calls, 4);
  assert.equal(result.limited, undefined);
  assert.equal(result.text, 'part 1 part 2 part 3 part 4 ');
  // Each pass is handed the answer so far.
  assert.deepEqual(parts, ['part 1 ', 'part 1 part 2 ', 'part 1 part 2 part 3 ']);
});

test('a model that keeps asking for more room cannot loop forever', async () => {
  let calls = 0;
  const result = await answerChat({
    messages: [{ role: 'user', content: 'hi' }], signal: signal(),
    generate: async () => { calls++; return { text: `part ${calls} `, model: 'model-a', limited: true }; },
  });
  assert.equal(calls, 9);
  assert.equal(result.limited, true);
  assert.equal(result.text, 'part 1 part 2 part 3 part 4 part 5 part 6 part 7 part 8 part 9 ');
});

test('a model that adds nothing ends the passes instead of queueing more', async () => {
  let calls = 0;
  const result = await answerChat({
    messages: [{ role: 'user', content: 'hi' }], signal: signal(),
    generate: async () => { calls++; return { text: calls === 1 ? 'Half' : '   ', model: 'model-a', limited: true }; },
  });
  assert.equal(calls, 2);
  assert.equal(result.text, 'Half');
  assert.equal(result.limited, true);
});

test('a long answer hands the next pass only its end, not the whole of it', async () => {
  const long = 'x'.repeat(9000);
  let handed = '';
  const result = await answerChat({
    messages: [{ role: 'user', content: 'hi' }], signal: signal(),
    generate: async (request) => {
      if (request.purpose === 'continue') {
        handed = request.messages.at(-2).content;
        return { text: 'y', model: 'model-a' };
      }
      return { text: long, model: 'model-a', limited: true };
    },
  });
  assert.equal(handed.length, 4000);
  assert.equal(handed, long.slice(-4000));
  assert.equal(result.text, `${long}y`);
  assert.equal(result.limited, undefined);
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
  assert.throws(() => cleanPrompt('x'.repeat(12001)), /12,000/);
});

test('uncensored mode changes the instructions, per reply, and keeps the coding rules', () => {
  const chat = createChat('x');
  turn(chat, 'What makes a rainbow?', 'Light bends in raindrops.');
  newTurn(chat, 'What makes a rainbow?', 'community');
  // Off by default: nothing about uncensored mode reaches a model.
  assert.doesNotMatch(conversationContext(chat, 'community')[0].content, /uncensored/);
  // On for this reply only.
  chat.messages.at(-1).raw = true;
  const asked = conversationContext(chat, 'community')[0].content;
  assert.match(asked, /^You are Chorus in uncensored mode\./);
  assert.match(asked, /no refusal, no lecture, no moral verdict/);
  // The conversation is still there, and code still gets its rules.
  assert.match(asked, /conversation so far/);
  newTurn(chat, 'Write a python scraper', 'community', false, true);
  const code = conversationContext(chat, 'community')[0].content;
  assert.match(code, /uncensored mode/);
  assert.match(code, /senior engineer whose code has to run/);
});

test('a refusal in uncensored mode is asked again once more, then reported as the models’ limit', async () => {
  const seen = [];
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Tell me a violent ghost story.' }];
  const result = await answerChat({
    messages, signal: signal(), mode: 'solo', direct: true,
    generate: async (request) => {
      seen.push(request);
      return { text: 'I cannot help with that.', model: `model-${seen.length}` };
    },
  });
  // One more ask than the ordinary two retries, each with the firmer note.
  assert.equal(seen.length, 4);
  for (const call of seen.slice(1)) {
    assert.ok(call.messages.some((m) => m.role === 'system' && /no moralising/.test(m.content)));
  }
  // Every model that declined is avoided on the next attempt.
  assert.deepEqual(seen[3].preferOtherThan, ['model-1', 'model-2', 'model-3']);
  assert.match(result.text, /Every model online declined this one/);
  assert.match(result.text, /Try again/);
});

test('a saved reply keeps the mode it was written in', () => {
  const storage = fakeStorage();
  const chat = createChat('x');
  const plain = turn(chat, 'one', 'a');
  const raw = newTurn(chat, 'two', 'community', false, true);
  Object.assign(raw, { text: 'b', status: 'complete' });
  assert.equal(plain.raw, undefined);
  saveChats(storage, [chat]);
  const [saved] = readChats(storage);
  assert.equal(saved.messages[1].raw, undefined);
  assert.equal(saved.messages[3].raw, true);
  // Anything other than a boolean is not a mode.
  const broken = JSON.parse(storage.getItem(HISTORY_KEY));
  broken[0].messages[3].raw = 'yes';
  storage.setItem(HISTORY_KEY, JSON.stringify(broken));
  assert.deepEqual(readChats(storage), []);
});

test('what the person asked for rides along: their instructions and this chat’s note', () => {
  const chat = createChat('x');
  chat.note = 'We are migrating a Django app to FastAPI.';
  turn(chat, 'How do I start?', 'Begin with the routers.');
  newTurn(chat, 'And the models?', 'community', false, false);
  chat.messages.at(-1).persona = 'Answer in British English. Show the code first.';
  const rules = conversationContext(chat, 'community')[0].content;
  assert.match(rules, /About this chat, written by the person: We are migrating a Django app to FastAPI\./);
  assert.match(rules, /How this person wants you to answer.*British English/);
  // The default still reads like the default.
  const plain = createChat('y');
  newTurn(plain, 'hi');
  assert.doesNotMatch(conversationContext(plain, 'community')[0].content, /About this chat|How this person/);
  // Long text is cut to the limit instead of being sent whole.
  const capped = instructionsFor({ persona: 'x'.repeat(5000), note: 'y'.repeat(5000) });
  assert.equal(capped.split('How this person wants you to answer')[1].trim().length, 600 + ' (follow it unless it contradicts the request):'.length);
  assert.equal(capped.split('About this chat, written by the person: ')[1].split('\n')[0].length, 300);
});

test('a question can be asked again: the turn is replaced, not appended', () => {
  const chat = createChat('x');
  turn(chat, 'first question', 'first answer');
  turn(chat, 'second question', 'second answer');
  assert.equal(chat.messages.length, 4);
  assert.equal(rewindTo(chat, 2), true);
  assert.equal(chat.messages.length, 2);
  newTurn(chat, 'second question, better', 'community');
  assert.equal(chat.messages.length, 4);
  assert.equal(chat.messages[2].text, 'second question, better');
  // Only user turns exist at even indexes, and nothing else rewinds.
  assert.equal(rewindTo(chat, 1), false);
  assert.equal(rewindTo(chat, 99), false);
  assert.equal(rewindTo(chat, -1), false);
  assert.equal(chat.messages.length, 4);
});

test('a chat leaves the browser as readable Markdown or as its own JSON', () => {
  const chat = createChat('How do I sort a dict?');
  turn(chat, 'How do I sort a dict?', 'Use `sorted(d.items(), key=lambda kv: kv[1])`.');
  chat.messages[1].model = 'small/Model-7B';
  const markdown = chatToMarkdown(chat);
  assert.match(markdown, /^# How do I sort a dict\?/);
  assert.match(markdown, /## You\n\nHow do I sort a dict\?/);
  assert.match(markdown, /## Chorus · small\/Model-7B\n\nUse `sorted/);
  const json = JSON.parse(chatToJson(chat));
  assert.equal(json.app, 'chorus');
  assert.equal(json.chat.messages.length, 2);
});

test('pinned chats stay at the top, and notes and pins survive a reload', () => {
  const older = createChat('older'); older.updatedAt = 100;
  const newer = createChat('newer'); newer.updatedAt = 200;
  assert.deepEqual(orderedChats([older, newer]).map((c) => c.title), ['newer', 'older']);
  older.pinned = true;
  assert.deepEqual(orderedChats([older, newer]).map((c) => c.title), ['older', 'newer']);

  const storage = fakeStorage();
  const chat = createChat('pinned chat');
  turn(chat, 'pinned chat', 'an answer');
  chat.pinned = true;
  chat.note = 'A note for the models';
  saveChats(storage, [chat]);
  const [saved] = readChats(storage);
  assert.equal(saved.pinned, true);
  assert.equal(saved.note, 'A note for the models');
});


test('coding and coding follow-ups keep the panel even if the vote says one', async () => {
  for (const messages of [
    [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Explain the Python exception' }],
    [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Write a Java function' }, { role: 'assistant', content: 'a function' }, { role: 'user', content: 'now fix it' }],
  ]) {
    const calls = [];
    const result = await answerChat({ messages, signal: signal(), decide: true, generate: async (r) => {
      calls.push(r.purpose);
      if (r.purpose === 'triage') return { text: 'one', model: 'a' };
      if (r.purpose === 'review') return { text: 'Check the return value', model: 'b' };
      return { text: '```java\nreturn 1;\n```', model: r.purpose === 'draft' ? 'a' : 'c' };
    } });
    assert.deepEqual(calls, ['triage', 'draft', 'review', 'final']);
    assert.equal(result.team[0].pick, 'solo'); // report what was voted, not what was enforced
  }
});

test('a code-writing final pass that drops or truncates code keeps the complete draft and warns', async () => {
  for (const final of ['Here is what to change.', '```python\ndef f():\n    pass']) {
    const draft = '```python\ndef f():\n    return 42\n```';
    const result = await answerChat({ messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Write a Python function' }], signal: signal(), deep: true,
      generate: async ({ purpose }) => ({ text: purpose === 'draft' ? draft : purpose === 'review' ? 'Review' : final, model: purpose }) });
    assert.equal(result.text, draft);
    assert.match(result.warning, /draft.*complete code block/);
    assert.equal(result.team.at(-1).model, 'final');
  }
});

test('recognises more programming languages without forcing code on explanations', () => {
  assert.equal(isCodeRequest('Explain C++ templates'), true);
  assert.equal(isCodeRequest('What is a Java compiler?'), true);
  assert.equal(isCodeRequest('How does this app work?'), true);
});

test('code continuation preserves indentation and repairs an unclosed fence', async () => {
  const seen = [], live = [];
  const result = await answerChat({
    messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Write a Python function' }],
    signal: signal(), mode: 'solo', onText: text => live.push(text),
    generate: async (request) => {
      seen.push(request.purpose);
      if (request.purpose === 'answer') return { text: '```python\ndef f():\n', model: 'a' };
      request.onText?.('    return 42\n```');
      return { text: '    return 42\n```', model: 'a' };
    },
  });
  assert.deepEqual(seen, ['answer', 'continue']);
  assert.equal(result.text, '```python\ndef f():\n    return 42\n```');
  assert.equal(live.at(-1), result.text);
  assert.equal(result.limited, undefined);
});

test('an unclosed code fence that cannot be finished is marked incomplete', async () => {
  const result = await answerChat({ messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Write Python code' }], signal: signal(), mode: 'solo',
    generate: async ({ purpose }) => { if (purpose === 'continue') throw new Error('offline'); return { text: '```python\nprint(', model: 'a' }; },
  });
  assert.equal(result.limited, true);
  assert.equal(result.text, '```python\nprint(');
});

test('long code messages fit the composer limit and survive saved chat reload', () => {
  const storage = fakeStorage(), source = 'def f():\n' + '    pass\n'.repeat(800);
  assert.ok(source.length > 4000);
  assert.equal(cleanPrompt(source), source.trim());
  const chat = createChat('code');
  const reply = newTurn(chat, cleanPrompt(source), 'community'); reply.status = 'complete'; reply.text = 'done';
  assert.equal(saveChats(storage, [chat]), true);
  assert.equal(readChats(storage)[0].messages[0].text, source.trim());
});

test('legacy local, WebLLM, and Chrome chats stay saved and never enter community context', () => {
  const storage = fakeStorage();
  const chat = createChat('Legacy history');
  for (const engine of ['local', 'webllm', 'chrome']) turn(chat, `secret ${engine} question`, `secret ${engine} answer`, engine);
  turn(chat, 'community question', 'community answer');
  newTurn(chat, 'new community request', 'community');
  assert.equal(saveChats(storage, [chat]), true);
  const restored = readChats(storage)[0];
  assert.equal(restored.messages.filter(m => m.role === 'assistant' && m.engine !== 'community').length, 3);
  const context = JSON.stringify(conversationContext(restored, 'community'));
  for (const engine of ['local', 'webllm', 'chrome']) assert.doesNotMatch(context, new RegExp(`secret ${engine}`));
  assert.match(context, /community question/);
  assert.match(context, /new community request/);
});
