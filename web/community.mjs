import { estimateTokens, OUTPUT_LIMIT, shorterContext } from './chat.mjs';

const API = 'https://oai.aihorde.net/v1';
const MAX_CANDIDATES = 5;
const FREE_TOKENS = 512; // The documented default free floor includes thinking tokens.
const ANSWER_TOKENS = 1024; // Long code answers need room; the model's own limit still applies.
const MIN_TOKENS = 64;
const DISCOVERY_TIMEOUT = 12_000;
const RESPONSE_TIMEOUT = 150_000;
// The decider only needs one word, so it must not stall the reply for a full queue wait.
const TRIAGE_TIMEOUT = 45_000;
const TRIAGE_TOKENS = 64;

function waitSeconds(value) {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(86_400, Math.ceil(seconds)) : 0;
}

class CommunityError extends Error {
  constructor(message, { refresh = false, retryAfter = 0, smaller = false } = {}) {
    super(message);
    this.refresh = refresh;
    this.retryAfter = retryAfter;
    this.smaller = smaller;
  }
}

function providerError(response, payload) {
  const { status, headers } = response;
  const code = payload?.error?.code;
  const retryAfter = waitSeconds(headers.get('Retry-After'));
  const wait = retryAfter ? ' Try again after the cooldown.' : ' Try again in a moment.';
  let message;
  if (status === 429 || ['FrontAtCapacity', 'queue_unavailable'].includes(code)) {
    message = `The community network is busy.${wait}`;
  } else if (code === 'no_eligible_worker' || code === 'no_worker_supports_limit') {
    message = `No online model could handle this message.${wait} A shorter message may help.`;
  } else if (code === 'KudosUpfront' || status === 402) {
    // Anonymous requests can be refused for asking for too many tokens; retry smaller once.
    message = 'This message exceeds the network’s current free allowance. Try a shorter message.';
  } else if (status === 401 || status === 403) {
    message = 'AI Horde isn’t accepting this anonymous request. No account or key was sent.';
  } else if (status === 408 || status === 504) {
    message = 'The community network timed out before a reply arrived. Try again in a moment.';
  } else if (status === 400 || status === 413) {
    message = 'The network declined this request. Try a shorter message or start a new chat.';
  } else {
    message = `AI Horde couldn’t complete the request (${status}).${wait}`;
  }
  // Only refresh on a documented pre-queue model refusal. Do not duplicate jobs after a timeout or disconnect.
  const refresh = status === 404 && ['UnknownChatModel', 'model_not_found'].includes(code)
    && !retryAfter && headers.get('x-should-retry') !== 'false';
  const smaller = status === 402 || ['KudosUpfront', 'KudosUpfrontRequired'].includes(code);
  return new CommunityError(message, { refresh, retryAfter, smaller });
}

function queueInfo(line) {
  if (!line.startsWith(': horde')) return null;
  const position = Number(/\bqueue_position=(\d+)\b/.exec(line)?.[1]);
  const seconds = Number(/\bwait_time=(\d+)\b/.exec(line)?.[1]);
  return {
    ...(Number.isSafeInteger(position) && position > 0 ? { position } : {}),
    ...(Number.isSafeInteger(seconds) && seconds > 0 ? { seconds } : {}),
  };
}

function reply(text, model, finish) {
  if (finish === 'content_filter') throw new CommunityError('The provider did not return a reply for this message.');
  if (typeof text !== 'string' || !text.trim()) throw new CommunityError('The online model returned no text. Try again or rephrase your message.');
  return {
    text: text.trim().slice(0, OUTPUT_LIMIT),
    ...(typeof model === 'string' && model.trim() ? { model: model.trim().slice(0, 300) } : {}),
    limited: finish === 'length' || text.length > OUTPUT_LIMIT,
  };
}

async function streamReply(response, signal, onText, onQueue) {
  const interrupted = () => new CommunityError('The online reply was interrupted before it finished. Try again in a moment.');
  if (!response.body) throw interrupted();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data = [], text = '', model, finish, done = false, capped = false;
  function line(raw) {
    if (raw.startsWith(':')) {
      const queue = queueInfo(raw);
      if (queue && !text) onQueue(queue);
      return;
    }
    if (raw.startsWith('data:')) data.push(raw.slice(5).replace(/^ /, ''));
    if (raw || !data.length) return;
    const event = data.join('\n');
    data = [];
    if (event === '[DONE]') { done = true; return; }
    let payload;
    try { payload = JSON.parse(event); } catch { throw interrupted(); }
    // Before any words arrived nothing was interrupted; say what happened instead.
    if (payload?.error) throw text ? interrupted() : new CommunityError('The online model stopped before it wrote anything. Try again in a moment.');
    if (typeof payload?.model === 'string') model = payload.model.trim().slice(0, 300);
    const choice = payload?.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    const added = choice?.delta?.content;
    if (typeof added === 'string' && added && !capped) {
      capped = text.length + added.length > OUTPUT_LIMIT;
      text = (text + added).slice(0, OUTPUT_LIMIT);
      onText(text);
    }
  }
  function drain(last = false) {
    let next;
    while (!done && (next = buffer.indexOf('\n')) !== -1) {
      const raw = buffer.slice(0, next).replace(/\r$/, '');
      buffer = buffer.slice(next + 1);
      line(raw);
    }
    // The closing event of a stream sometimes arrives without its newline, so
    // take whatever is left once the body is over instead of dropping it.
    if (last && !done && buffer) {
      const raw = buffer.replace(/\r$/, '');
      buffer = '';
      line(raw);
    }
    // An event is handed over on its blank line, so a body that stops right
    // after a data line still has one event waiting to be read.
    if (last && !done && data.length) line('');
  }
  try {
    while (!done) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        buffer += decoder.decode();
        drain(true);
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      drain();
      if (buffer.length > 128_000 || data.length > 64) throw interrupted();
    }
    // A finish_reason or a [DONE] sentinel is the provider saying the message is
    // complete. Some releases close the body after the finish_reason and never
    // send [DONE]; a finished reply is not an interrupted one.
    if (!done && !finish) throw interrupted();
    return reply(text, model, capped ? 'length' : finish);
  } finally {
    // Close the body when a stream ends early or the user stops it.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function request(path, { fetchImpl, signal, body, timeout, onText = () => {}, onQueue = () => {} }) {
  signal?.throwIfAborted();
  const connection = new AbortController();
  const stop = () => connection.abort(signal.reason);
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => connection.abort(new CommunityError(body
    ? 'No complete reply arrived within 2½ minutes. Try again in a moment.'
    : 'AI Horde did not return its model list. Try again in a moment.')), timeout);
  try {
    const response = await fetchImpl(API + path, {
      method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'Content-Type': 'application/json', 'X-Title': 'Chorus Web' }, body: JSON.stringify(body) } : {}),
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: connection.signal,
    });
    if (response.ok && body && response.headers.get('Content-Type')?.includes('text/event-stream')) {
      return await streamReply(response, connection.signal, onText, onQueue);
    }
    const data = await response.json().catch(() => null);
    connection.signal.throwIfAborted();
    if (!response.ok) throw providerError(response, data);
    if (!data || typeof data !== 'object') throw new CommunityError('AI Horde returned an unreadable response. Please try again.');
    if (body) {
      const choice = data.choices?.[0];
      return reply(choice?.message?.content, data.model, choice?.finish_reason);
    }
    return data;
  } catch (error) {
    connection.signal.throwIfAborted();
    if (error instanceof CommunityError) throw error;
    throw new CommunityError('Couldn’t reach AI Horde from this browser. Check your connection or try again later.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

export async function getOnlineModels({ signal, fetchImpl = globalThis.fetch } = {}) {
  const { data } = await request('/models', { fetchImpl, signal, timeout: DISCOVERY_TIMEOUT });
  if (!Array.isArray(data)) throw new CommunityError('AI Horde returned an unreadable model list. Please try again.');
  const models = new Map();
  for (const card of data) {
    const id = card?.id;
    const count = card?.x_horde?.workers;
    const context = card?.context_length;
    const tokens = card?.top_provider?.max_completion_tokens;
    const queue = card?.x_horde?.queued;
    if (typeof id !== 'string' || !id.trim() || id.length > 300 || id.includes(':') || !Number.isFinite(count) || count < 1
      || !Number.isFinite(context) || context < 1 || !Number.isFinite(tokens) || tokens < MIN_TOKENS) continue;
    if (Array.isArray(card.architecture?.output_modalities) && !card.architecture.output_modalities.includes('text')) continue;
    if (Array.isArray(card.architecture?.input_modalities) && !card.architecture.input_modalities.includes('text')) continue;
    models.set(id, { id, count, context, tokens, queue: Number.isFinite(queue) && queue >= 0 ? queue : Infinity });
  }
  // Capacity ranking, not a claim about model quality.
  return [...models.values()].sort((a, b) => (a.queue / a.count - b.queue / b.count) || b.count - a.count || a.id.localeCompare(b.id));
}

// Model names that say "trained on code". A coding task gives them the first
// slot; capacity still decides among equals, so a busy coder does not win.
const CODE_MODEL = /(?:coder|codestral|codeqwen|starcoder|codegen|devstral|deepseek|qwen|code-?llama|gemma-?code)/i;
const codeFit = (model) => (CODE_MODEL.test(model.id) ? 1 : 0);

export function planCommunityRequest(models, { messages, purpose, preferOtherThan, code = false }) {
  if (!models.length) throw new CommunityError('No text models are online in the community pool. Try again later.');
  const desired = purpose === 'review' ? 352 : purpose === 'triage' ? TRIAGE_TOKENS : ANSWER_TOKENS;
  let reduced;
  for (let context = messages; ; context = shorterContext(context)) {
    const input = estimateTokens(context);
    const fitting = models.map((m) => ({ ...m, room: Math.floor(Math.min(desired, m.tokens, m.context - input)) }))
      .filter((m) => m.room >= MIN_TOKENS);
    const full = fitting.filter((m) => m.room >= desired);
    if (full.length) return body(full, context);
    if (fitting.length && !reduced) reduced = body(fitting, context);
    if (context.length <= 2) break;
  }
  if (reduced) return reduced;
  throw new CommunityError('The models online right now cannot fit this message. Try shortening it or start a new chat.');

  function body(fitting, context) {
    // One or more earlier models to avoid, so a check or a final pass really is
    // written by a different model than the draft it is working from.
    const avoid = preferOtherThan ? [].concat(preferOtherThan) : [];
    const others = avoid.length ? fitting.filter((m) => !avoid.includes(m.id)) : [];
    const pool = others.length ? others : fitting;
    // A coding task also wants the roomier models: a long answer is cut short
    // by a small context just as surely as by a small token budget.
    const ordered = code
      ? [...pool].sort((a, b) => (codeFit(b) - codeFit(a)) || (b.room - a.room) || a.id.localeCompare(b.id))
      : pool;
    const candidates = ordered.slice(0, MAX_CANDIDATES);
    return {
      models: candidates.map(({ id }) => id), messages: context, stream: true,
      max_tokens: Math.min(...candidates.map(({ room }) => room)),
      // Code is written, not improvised: less sampling, fewer invented APIs.
      temperature: code ? 0.2 : 0.55,
      horde: { context_fit: 'grow', include_reasoning: false },
    };
  }
}

export function communityEngine({ onPhase = () => {}, onModels = () => {}, onLimit = () => {}, fetchImpl = globalThis.fetch } = {}) {
  return {
    async generate({ messages, signal, purpose, preferOtherThan, onText, code = false }) {
      const plan = async () => {
        onPhase('finding');
        const models = await getOnlineModels({ signal, fetchImpl });
        onModels(models);
        return planCommunityRequest(models, { messages, purpose, preferOtherThan, code });
      };
      const complete = async (body) => {
        onPhase('waiting');
        const timeout = purpose === 'triage' ? TRIAGE_TIMEOUT : RESPONSE_TIMEOUT;
        const send = (size) => request('/chat/completions', { body: { ...body, max_tokens: size }, fetchImpl, signal, timeout,
          onText, onQueue: (queue) => onPhase('waiting', queue) });
        try {
          return await send(body.max_tokens);
        } catch (error) {
          // Too big for the free allowance: one smaller attempt still beats no answer.
          if (error?.smaller && body.max_tokens > FREE_TOKENS) return await send(FREE_TOKENS);
          throw error;
        }
      };
      try {
        const first = await plan();
        try { return await complete(first); }
        catch (error) {
          if (!error.refresh) throw error;
          const next = await plan();
          if (next.models.length === first.models.length && next.models.every((id) => first.models.includes(id))) throw error;
          return await complete(next);
        }
      } catch (error) {
        if (error.retryAfter) onLimit(error.retryAfter);
        throw error;
      }
    },
  };
}
