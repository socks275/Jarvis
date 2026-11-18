const API = 'https://oai.aihorde.net/v1';
const MAX_CANDIDATES = 5;
// Stay within the Horde's default free output floor. This includes any reasoning tokens.
const FREE_TOKENS = 512;
const MIN_TOKENS = 64;
const STAGE_TOKENS = { answer: 512, draft: 512, review: 352, final: 512, peer: 512 };
const DISCOVERY_TIMEOUT = 12000;
const RESPONSE_TIMEOUT = 150000;
const size = new TextEncoder();

function waitSeconds(value) {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(3600, Math.ceil(seconds)) : 0;
}

class CommunityError extends Error {
  constructor(message, { refresh = false, retryAfter = 0 } = {}) {
    super(message);
    this.refresh = refresh;
    this.retryAfter = retryAfter;
  }
}

function providerError(response, payload) {
  const { status, headers } = response;
  const code = payload?.error?.code;
  const retryAfter = waitSeconds(headers.get('Retry-After'));
  const wait = retryAfter ? ` Try again in about ${retryAfter} seconds.` : ' Try again later.';
  let message;
  if (status === 429 || ['FrontAtCapacity', 'queue_unavailable'].includes(code)) {
    message = `AI Horde is busy or limiting anonymous requests.${wait}`;
  } else if (code === 'no_eligible_worker' || code === 'no_worker_supports_limit') {
    message = `No online worker could handle this step.${wait} A shorter prompt or Quick answer may help.`;
  } else if (code === 'KudosUpfront' || status === 402) {
    message = 'This request exceeds AI Horde’s current free allowance. Try a shorter prompt or Quick answer.';
  } else if (status === 401 || status === 403) {
    message = 'AI Horde did not allow this anonymous request. No account or key was sent.';
  } else if (status === 408 || status === 504) {
    message = 'AI Horde timed out before a reply arrived. Try Quick answer or wait and retry.';
  } else if (status === 400 || status === 413) {
    message = 'AI Horde declined this request. Try a shorter prompt or another mode.';
  } else {
    message = `AI Horde couldn’t complete the request (${status}).${wait}`;
  }
  // Refresh only a documented pre-queue model lookup refusal. A timed-out or refused
  // generation might still have reached a worker; never send a duplicate in that case.
  const refresh = status === 404 && ['UnknownChatModel', 'model_not_found'].includes(code)
    && !retryAfter && headers.get('x-should-retry') !== 'false';
  return new CommunityError(message, { refresh, retryAfter });
}

async function request(path, { fetchImpl, signal, body, timeout }) {
  signal?.throwIfAborted();
  const connection = new AbortController();
  const stop = () => connection.abort(signal.reason);
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => connection.abort(new CommunityError(body
    ? 'No reply arrived within 2½ minutes. Try Quick answer or wait and retry.'
    : 'AI Horde did not return its model list. Try again in a moment.')), timeout);
  try {
    const response = await fetchImpl(API + path, {
      method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'Content-Type': 'application/json', 'X-Title': 'Frenemy Web' }, body: JSON.stringify(body) } : {}),
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: connection.signal,
    });
    const data = await response.json().catch(() => null);
    connection.signal.throwIfAborted();
    if (!response.ok) throw providerError(response, data);
    if (!data || typeof data !== 'object') throw new CommunityError('AI Horde returned an unreadable response. Please try again.');
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
  // This is a capacity ranking, not a claim about model quality.
  return [...models.values()].sort((a, b) => (a.queue / a.count - b.queue / b.count) || b.count - a.count || a.id.localeCompare(b.id));
}

export function planCommunityRequest(models, { stage, input, driver }) {
  if (!models.length) throw new CommunityError('No eligible text models are online on AI Horde. Try again later or use local files in Settings.');
  // A rough, conservative fit; the provider still checks the real token count.
  const inputEstimate = Math.ceil(size.encode(input).length / 2) + 64;
  const desired = Math.min(FREE_TOKENS, STAGE_TOKENS[stage.key] ?? FREE_TOKENS);
  let choices = models.map((model) => ({ ...model, room: Math.floor(Math.min(desired, model.tokens, model.context - inputEstimate)) }))
    .filter((model) => model.room >= MIN_TOKENS);
  if (!choices.length) throw new CommunityError('The models online right now cannot fit this step. Try a shorter prompt or Quick answer.');
  if (stage.role === 'reviewer' && driver && choices.some((model) => model.id !== driver)) {
    choices = choices.filter((model) => model.id !== driver);
  }
  const fitting = choices.filter((model) => model.room >= desired);
  const candidates = (fitting.length ? fitting : choices).slice(0, MAX_CANDIDATES);
  return {
    models: candidates.map(({ id }) => id),
    messages: [{ role: 'user', content: input }],
    max_tokens: Math.min(...candidates.map(({ room }) => room)),
    horde: { context_fit: 'grow', include_reasoning: false },
  };
}

export function communityEngine({ onPhase = () => {}, onModels = () => {}, onLimit = () => {}, fetchImpl = globalThis.fetch } = {}) {
  let driver;
  return {
    async generate({ stage, input, signal }) {
      const plan = async () => {
        onPhase(stage.key, 'selecting');
        const models = await getOnlineModels({ signal, fetchImpl });
        onModels(models);
        return planCommunityRequest(models, { stage, input, driver });
      };
      const complete = (body) => {
        onPhase(stage.key, 'waiting');
        return request('/chat/completions', { body, fetchImpl, signal, timeout: RESPONSE_TIMEOUT });
      };
      try {
        const first = await plan();
        let data;
        try {
          data = await complete(first);
        } catch (error) {
          if (!error.refresh) throw error;
          const next = await plan();
          if (next.models.length === first.models.length && next.models.every((id) => first.models.includes(id))) throw error;
          data = await complete(next);
        }
        if (stage.key === 'draft' && typeof data.model === 'string') driver = data.model;
        const choice = data.choices?.[0];
        const text = choice?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw new CommunityError('The volunteer model returned no answer. Try Quick answer or try again later.');
        return { text, model: data.model, limited: choice.finish_reason === 'length' };
      } catch (error) {
        if (error.retryAfter) onLimit(error.retryAfter);
        throw error;
      }
    },
  };
}
