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
  constructor(message, { refresh = false, retryAfter = 0, smaller = false, fallback = false } = {}) {
    super(message);
    this.refresh = refresh;
    this.retryAfter = retryAfter;
    this.smaller = smaller;
    this.fallback = fallback;
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
  // These documented errors indicate that no job was queued. Do not switch
  // after rate limits, timeouts, or an uncertain stream.
  const fallback = [400, 402, 404, 422].includes(status) && ['no_eligible_worker', 'no_worker_supports_limit', 'KudosUpfront', 'KudosUpfrontRequired'].includes(code)
    && !retryAfter && headers.get('x-should-retry') !== 'false';
  return new CommunityError(message, { refresh, retryAfter, smaller, fallback });
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

function reply(text, model, finish, preserveWhitespace = false) {
  if (finish === 'content_filter') throw new CommunityError('The provider did not return a reply for this message.');
  if (typeof text !== 'string' || !text.trim()) throw new CommunityError('The online model returned no text. Try again or rephrase your message.');
  return {
    text: (preserveWhitespace ? text : text.trim()).slice(0, OUTPUT_LIMIT),
    ...(typeof model === 'string' && model.trim() ? { model: model.trim().slice(0, 300) } : {}),
    limited: finish === 'length' || text.length > OUTPUT_LIMIT,
  };
}

async function streamReply(response, signal, onText, onQueue, preserveWhitespace = false, allowedModels = []) {
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
    if (typeof payload?.model === 'string') {
      model = payload.model.trim().slice(0, 300);
      if (model && !allowedModels.includes(model)) throw new CommunityError('The provider reported an unexpected model. The reply was stopped.');
    }
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
    return reply(text, model, capped ? 'length' : finish, preserveWhitespace);
  } finally {
    // Close the body when a stream ends early or the user stops it.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function request(path, { fetchImpl, signal, body, timeout, onText = () => {}, onQueue = () => {}, preserveWhitespace = false }) {
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
      return await streamReply(response, connection.signal, onText, onQueue, preserveWhitespace, body.models);
    }
    const data = await response.json().catch(() => null);
    connection.signal.throwIfAborted();
    if (!response.ok) throw providerError(response, data);
    if (!data || typeof data !== 'object') throw new CommunityError('AI Horde returned an unreadable response. Please try again.');
    if (body) {
      const choice = data.choices?.[0];
      if (typeof data.model === 'string' && data.model.trim() && !body.models.includes(data.model.trim())) throw new CommunityError('The provider reported an unexpected model. The reply was stopped.');
      return reply(choice?.message?.content, data.model, choice?.finish_reason, preserveWhitespace);
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

// Roster names are reported by volunteers, not independently verified model
// identities. GPT-OSS is preferred; recognised open-weight families are
// allowed as fallbacks. This never claims access to proprietary GPT or Claude.
export function communityModelTier(id) {
  if (typeof id !== 'string') return 0;
  const name = id.replace(/^(?:koboldcpp|llamacpp)\//i, '');
  if (/^(?:openai\/)?gpt-oss-(?:20b|120b)(?:[-_.][a-z0-9._-]+)?$/i.test(name)) return 3;
  // Ignore base, embedding and reward models: these are not chat assistants.
  if (/(?:^|[-_/])(base|embedding|embed|reranker|reward)(?:$|[-_/.])/i.test(name)) return 0;
  const base = name.replace(/^(?:qwen|deepseek-ai|mistralai|meta-llama|google)\//i, '');
  if (/^(?:qwen[23](?:[._-][0-9]+)?[-_.]?coder|devstral|deepseek[-_.]?(?:r1|v3|coder))/i.test(base)) return 2;
  if (/^(?:qwen[23](?:[._-][0-9]+)?|gemma[-_.]?[234]|llama[-_.]?3(?:[._-][0-9]+)?|mistral[-_.]|mixtral[-_.])/i.test(base)) return 1;
  return 0;
}

export function eligibleCommunityModels(models) {
  return models.filter(({ id }) => communityModelTier(id) > 0);
}

export async function getEligibleOnlineModels(options = {}) {
  return eligibleCommunityModels(await getOnlineModels(options));
}

// Names are only a heuristic, not an evaluation of actual model quality.
// Prefer recent coding families when they are really present in the live roster.
const CODE_MODEL = /(?:coder|codestral|codeqwen|starcoder|codegen|devstral|deepseek[-_/ ]?code|code-?llama|gemma-?code)/i;
const RECENT_CODE_MODEL = /(?:qwen3[._-]?coder|devstral(?:[-_ ]?(?:small|medium))?(?:[-_ ]?2)(?![0-9]))/i;
const NON_CHAT_VARIANT = /(?:^|[-_/])(base|embedding|embed|reranker|reward)(?:$|[-_/.])/i;
const codeFit = (model) => NON_CHAT_VARIANT.test(model.id) ? 0 : RECENT_CODE_MODEL.test(model.id) ? 2 : CODE_MODEL.test(model.id) ? 1 : 0;

// The size in the name is the only quality signal the roster gives us: an idle
// 7B model is not the model to finish a hard answer with if a 70B is reachable.
const MODEL_SIZE = /(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/;
const sizeOf = (id) => {
  const match = MODEL_SIZE.exec(String(id ?? ''));
  return match ? Number(match[1]) : 0;
};
const STRONG_SIZE = 30;
const QUEUE_SLACK = 8;

/**
 * Prefers a strong model for the pass that matters, as long as its queue is in
 * the same league as the best one on offer. Capacity still decides the rest.
 */
function orderForQuality(pool) {
  const waits = pool.map((model) => model.queue / model.count).filter((wait) => Number.isFinite(wait));
  const best = waits.length ? Math.min(...waits) : 0;
  const reachable = (model) => {
    const wait = model.queue / model.count;
    return !Number.isFinite(wait) || wait <= best + QUEUE_SLACK;
  };
  const strength = (model) => (sizeOf(model.id) >= STRONG_SIZE && reachable(model) ? 1 : 0);
  const wait = (model) => model.queue / model.count;
  return pool.slice().sort((a, b) => {
    const strong = strength(b) - strength(a);
    if (strong) return strong;
    if (strength(a) && strength(b)) return sizeOf(b.id) - sizeOf(a.id) || wait(a) - wait(b) || a.id.localeCompare(b.id);
    return wait(a) - wait(b) || b.count - a.count || a.id.localeCompare(b.id);
  });
}

// The free pool gives no real timing, so this is calibrated rather than exact:
// one queued job per worker usually costs about twenty seconds, and a reply of
// roughly a thousand tokens takes around a minute to write. It is shown as an
// estimate, never as a promise.
const SECONDS_PER_JOB = 20;
const TOKENS_PER_SECOND = 18;

/** A rough wait for the best model on offer, or undefined when nothing is known. */
export function waitEstimate(models, { tokens = ANSWER_TOKENS } = {}) {
  const known = (models ?? []).filter((m) => Number.isFinite(m?.queue) && Number.isFinite(m?.count) && m.count > 0);
  if (!known.length) return undefined;
  const jobs = Math.min(...known.map((m) => m.queue / m.count));
  const seconds = Math.max(5, Math.round(Math.min(jobs, 60) * SECONDS_PER_JOB + Math.min(tokens, 1200) / TOKENS_PER_SECOND));
  return { seconds, models: known.length };
}

/** "about 40 seconds" — words a person can act on, never a false precision. */
export function describeWait({ seconds, models } = {}) {
  if (!seconds) return '';
  const when = seconds < 20 ? 'under 20 seconds' : seconds < 70 ? 'about a minute' : `about ${Math.round(seconds / 60)} minutes`;
  return `${models} ${models === 1 ? 'model' : 'models'} online · ${when}`;
}

export function planCommunityRequest(models, { messages, purpose, preferOtherThan, code = false, pinned = '', banned = [], excluded = [], maxCandidates = MAX_CANDIDATES, familyMode = false } = {}) {
  const bannedIds = [].concat(banned ?? []);
  if (bannedIds.length) models = models.filter((m) => !bannedIds.includes(m.id));
  if (!models.length) throw new CommunityError(bannedIds.length
    ? 'Every model that can answer here is on your never-use list. Clear it in Settings → Models.'
    : 'No text models are online in the community pool. Try again later.');
  if (excluded.length) models = models.filter((m) => !excluded.includes(m.id));
  if (!models.length) throw new CommunityError('No other compatible model is online right now. Try again later.');
  const desired = purpose === 'review' ? (code ? 512 : 352) : purpose === 'triage' ? TRIAGE_TOKENS : ANSWER_TOKENS;
  let reduced;
  for (let context = messages; ;) {
    const input = estimateTokens(context);
    const fitting = models.map((m) => ({ ...m, room: Math.floor(Math.min(desired, m.tokens, m.context - input)) }))
      .filter((m) => m.room >= MIN_TOKENS);
    const full = fitting.filter((m) => m.room >= desired);
    // Prefer a recent coder with a usable output budget over a general model
    // with a larger budget. Keep the whole current context and honour pin and
    // diversity preferences before making this trade-off.
    if (code || familyMode) {
      const adequate = fitting.filter((m) => m.room >= Math.min(desired, FREE_TOKENS));
      const avoid = preferOtherThan ? [].concat(preferOtherThan) : [];
      const others = adequate.filter((m) => !avoid.includes(m.id));
      const pool = others.length ? others : adequate;
      const hasPin = purpose !== 'triage' && pinned && !avoid.includes(pinned) && pool.some((m) => m.id === pinned);
      if (hasPin || (familyMode ? pool.some((m) => communityModelTier(m.id) === 3 || (code && communityModelTier(m.id) === 2)) : pool.some((m) => codeFit(m) === 2))) return body(pool, context);
    }
    if (full.length) return body(full, context);
    if (fitting.length && !reduced) reduced = body(fitting, context);
    const shorter = shorterContext(context);
    if (shorter === context) break;
    context = shorter;
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
    // by a small context just as surely as by a small token budget. The pass
    // that finishes a reply prefers a bigger model when one is reachable.
    const ranked = code || purpose === 'final' ? orderForQuality(pool) : pool;
    const ordered = familyMode
      ? [...ranked].sort((a, b) => (communityModelTier(b.id) - communityModelTier(a.id)) || (sizeOf(b.id) - sizeOf(a.id)))
      : code ? [...ranked].sort((a, b) => (codeFit(b) - codeFit(a)) || 0) : ranked;
    // A pinned model leads its pass, but never a triage vote and never a pass
    // that is meant to be written by a different model than the draft.
    const pin = purpose !== 'triage' && pinned && !avoid.includes(pinned)
      ? ordered.find((m) => m.id === pinned) : undefined;
    const lineup = pin ? [pin, ...ordered.filter((m) => m !== pin)] : ordered;
    // The API may pick ANY supplied model; merely sorting a mixed list does not
    // select the better family. Constrain the list to the best available tier.
    // An explicit pin still wins, and other passes can choose a different model.
    const bestTier = code && !pin && !familyMode ? codeFit(lineup[0]) : 0;
    const candidates = (bestTier ? lineup.filter((m) => codeFit(m) === bestTier) : lineup).slice(0, maxCandidates);
    return {
      models: candidates.map(({ id }) => id), messages: context, stream: true,
      max_tokens: Math.min(...candidates.map(({ room }) => room)),
      // Code is written, not improvised: less sampling, fewer invented APIs.
      temperature: code ? 0.2 : 0.55,
      horde: { context_fit: 'grow', include_reasoning: false },
    };
  }
}

// One reply makes several passes (draft, review, final); they can share a
// roster instead of asking the network for the same list each time.
const ROSTER_TTL = 45_000;

export function communityEngine({ onPhase = () => {}, onModels = () => {}, onLimit = () => {}, preference = {}, fetchImpl = globalThis.fetch } = {}) {
  let roster;
  let rosterAt = 0;
  return {
    async generate({ messages, signal, purpose, preferOtherThan, onText, code = false }) {
      const plan = async ({ fresh = false, excluded = [] } = {}) => {
        if (fresh || !roster || Date.now() - rosterAt > ROSTER_TTL) {
          onPhase('finding');
          roster = await getEligibleOnlineModels({ signal, fetchImpl });
          roster.sort((a, b) => sizeOf(b.id) - sizeOf(a.id));
          rosterAt = Date.now();
        }
        onModels(roster);
        if (!roster.length) throw new CommunityError('No supported community models are online right now. Try again later or check availability in Settings.');
        return planCommunityRequest(roster, { messages, purpose, preferOtherThan, code, pinned: preference.pinned, banned: preference.banned, excluded, maxCandidates: 1, familyMode: true });
      };
      const complete = async (body) => {
        onPhase('waiting');
        const timeout = purpose === 'triage' ? TRIAGE_TIMEOUT : RESPONSE_TIMEOUT;
        const send = (size) => request('/chat/completions', { body: { ...body, max_tokens: size }, fetchImpl, signal, timeout,
          onText, preserveWhitespace: purpose === 'continue', onQueue: (queue) => onPhase('waiting', queue) });
        try {
          return await send(body.max_tokens);
        } catch (error) {
          // Too big for the free allowance: one smaller attempt still beats no answer.
          if (error?.smaller && body.max_tokens > FREE_TOKENS) return await send(FREE_TOKENS);
          throw error;
        }
      };
      try {
        const excluded = [];
        let lastError;
        let refresh = false;
        // Only rotate on explicit pre-queue refusals. Avoid duplicating jobs
        // after a timeout, disconnect, cooldown or partially streamed answer.
        for (let attempt = 0; attempt < 4; attempt++) {
          let body;
          try { body = await plan({ fresh: refresh, excluded }); }
          catch (error) {
            if (lastError && error.message === 'No other compatible model is online right now. Try again later.') throw lastError;
            throw error;
          }
          refresh = false;
          try { return await complete(body); }
          catch (error) {
            if (!error.fallback && !error.refresh) throw error;
            lastError = error;
            excluded.push(...body.models);
            refresh = error.refresh;
          }
        }
        throw lastError;
      } catch (error) {
        if (error.retryAfter) onLimit(error.retryAfter);
        throw error;
      }
    },
  };
}
