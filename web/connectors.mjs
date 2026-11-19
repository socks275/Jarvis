// Connectors let a chat read from services the user already uses. Everything
// runs in this browser: a key is only ever sent to the service it belongs to,
// never to a model, and it is never put in a chat message.

export const CONNECTOR_KEY = 'chorus-web:connectors:v1';

export const SERVICES = [
  {
    id: 'github',
    label: 'GitHub',
    blurb: 'Read your repositories, notifications, issues and commits.',
    fields: [{ key: 'token', label: 'Personal access token', hint: 'a token with repo and read:user' }],
    // Sign-in state that is not a secret: the OAuth client id, the relay that
    // swaps the code for a token, and the account name we checked.
    oauth: {
      provider: 'github',
      fields: [
        { key: 'clientId', label: 'OAuth client ID' },
        { key: 'relay', label: 'OAuth relay URL', placeholder: 'https://chorus-oauth.your-name.workers.dev' },
      ],
      connect: 'Sign in with GitHub',
      // Remembered for display only: the account the token belongs to.
      keep: [{ key: 'login' }, { key: 'avatar' }],
      flags: ['allowWrite'],
      tokenPage: 'https://github.com/settings/tokens/new?scopes=repo,read:user&description=Chorus',
    },
    flags: [{ key: 'allowWrite', label: 'Allow changes', hint: 'off until you tick it' }],
    writes: ['open an issue in owner/repo: title', 'comment on owner/repo#12: text', 'set the description of owner/repo to …'],
    examples: ['list my GitHub repos', 'GitHub commits in owner/repo'],
  },
  {
    id: 'supabase',
    label: 'Supabase',
    blurb: 'Read rows from a table in your project.',
    tokenPage: 'https://supabase.com/dashboard/project/_/settings/api',
    tokenLabel: 'Open your API settings',
    fields: [
      { key: 'url', label: 'Project URL', placeholder: 'https://yourproject.supabase.co' },
      { key: 'key', label: 'Anon key', placeholder: 'the anon public key' },
    ],
    examples: ['Supabase rows from profiles'],
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    blurb: 'Read your zones and the DNS records inside them.',
    tokenPage: 'https://dash.cloudflare.com/profile/api-tokens',
    tokenLabel: 'Create an API token',
    fields: [{ key: 'token', label: 'API token', hint: 'a token with Zone:Read and DNS:Read' }],
    examples: ['my Cloudflare zones', 'Cloudflare DNS for example.com'],
  },
  {
    id: 'reddit',
    label: 'Reddit',
    blurb: 'Read public subreddits and search. No account or key needed.',
    fields: [],
    examples: ['hot in r/webdev', 'search Reddit for mechanical keyboards'],
  },
];

const FIELD_LIMIT = 400;
const CONTEXT_LIMIT = 1800;

const serviceById = new Map(SERVICES.map((service) => [service.id, service]));

export function readConnectors(storage) {
  const saved = Object.fromEntries(SERVICES.map(({ id }) => [id, {}]));
  let raw;
  try { raw = JSON.parse(storage?.getItem?.(CONNECTOR_KEY) ?? 'null'); } catch { return saved; }
  if (!raw || typeof raw !== 'object') return saved;
  for (const service of SERVICES) {
    const entry = raw[service.id];
    if (!entry || typeof entry !== 'object') continue;
    const values = {};
    for (const { key } of [...service.fields, ...(service.oauth?.fields ?? []), ...(service.oauth?.keep ?? [])]) {
      const text = typeof entry[key] === 'string' ? entry[key].trim().slice(0, FIELD_LIMIT) : '';
      if (text) values[key] = text;
    }
    for (const key of service.oauth?.flags ?? []) {
      if (entry[key] === true) values[key] = true;
    }
    if (Object.keys(values).length) saved[service.id] = values;
  }
  return saved;
}

export function writeConnectors(storage, connectors) {
  try {
    storage?.setItem?.(CONNECTOR_KEY, JSON.stringify(connectors));
    return true;
  } catch { return false; }
}

export function isConnected(service, connectors) {
  if (!service.fields.length) return true;
  return service.fields.every(({ key }) => Boolean(connectors?.[service.id]?.[key]));
}

const REPO = /\b([\w.-]{1,60}\/[\w.-]{1,60})\b/;
const TABLE = /\b(?:rows?\s+(?:from|in)|table|from)\s+([a-z][a-z0-9_]{1,59})\b/i;
const SUBREDDIT = /\br\/([a-z0-9_]{2,30})\b/i;
const SUBREDDIT_WORD = /\bsubreddit\s+([a-z0-9_]{2,30})\b/i;
const DOMAIN = /\b((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|co|uk|xyz|me|site|cloud))\b/i;

/**
 * Reads a short request such as "list my GitHub repos" or "hot in r/webdev".
 * The service has to be named, so ordinary questions about GitHub or Reddit
 * still go to the model.
 */
export const WRITE_ACTIONS = ['create-issue', 'comment', 'write-file', 'describe'];
export const isWrite = (request) => Boolean(request) && WRITE_ACTIONS.includes(request.action);

const REPO_PAIR = '([\\w.-]{1,60}/[\\w.-]{1,60})';

export function parseConnectorRequest(text) {
  const value = String(text ?? '').trim();
  if (!value || value.length > 900) return undefined;
  const lower = value.toLowerCase();

  // Write requests first: they are explicit commands, and they say the repo.
  const issue = new RegExp(`\\b(?:open|create|file|add|raise)\\s+(?:an?\\s+)?(?:new\\s+)?issue\\s+(?:in|on)\\s+${REPO_PAIR}\\s*[:\\-—,]?\\s*([\\s\\S]+)`, 'i').exec(value);
  if (issue) return { service: 'github', action: 'create-issue', repo: issue[1], title: issue[2].trim().slice(0, 200) };
  const comment = new RegExp(`\\bcomment\\s+on\\s+${REPO_PAIR}#(\\d{1,7})\\s*[:\\-—,]?\\s*([\\s\\S]+)`, 'i').exec(value);
  if (comment) return { service: 'github', action: 'comment', repo: comment[1], number: Number(comment[2]), body: comment[3].trim().slice(0, 2000) };
  const file = new RegExp(`\\b(?:create|write|update|add)\\s+(?:the\\s+)?file\\s+([\\w./-]{1,200})\\s+(?:in|to)\\s+${REPO_PAIR}\\s+(?:with|containing)?\\s*[:\\-—]?\\s*([\\s\\S]+)`, 'i').exec(value);
  if (file) return { service: 'github', action: 'write-file', path: file[1], repo: file[2], content: file[3] };
  const describe = new RegExp(`\\b(?:change|set|update)\\s+(?:the\\s+)?description\\s+(?:of|for)\\s+${REPO_PAIR}\\s+to\\s+([\\s\\S]+)`, 'i').exec(value);
  if (describe) return { service: 'github', action: 'describe', repo: describe[1], description: describe[2].trim().slice(0, 350) };
  const repo = REPO.exec(value)?.[1];
  const table = TABLE.exec(value)?.[1];
  const subreddit = SUBREDDIT.exec(value)?.[1] ?? SUBREDDIT_WORD.exec(value)?.[1];
  const domain = DOMAIN.exec(value)?.[1];

  if (/\bgithub\b/.test(lower)) {
    if (/\b(?:notifications?|inbox)\b/.test(lower)) return { service: 'github', action: 'notifications' };
    if (repo) {
      if (/\b(?:issues?|tickets?)\b/.test(lower)) return { service: 'github', action: 'issues', repo };
      if (/\b(?:pulls?|pull requests?|prs?)\b/.test(lower)) return { service: 'github', action: 'pulls', repo };
      if (/\bcommits?\b/.test(lower)) return { service: 'github', action: 'commits', repo };
      if (/\b(?:repo|repository|about|stars?)\b/.test(lower)) return { service: 'github', action: 'repo', repo };
    }
    if (/\b(?:repos?|repositories|projects)\b/.test(lower) || /\bmy\s+github\b/.test(lower)) return { service: 'github', action: 'repos' };
    return undefined;
  }
  if (/\bsupabase\b/.test(lower)) {
    return table ? { service: 'supabase', action: 'rows', table } : { service: 'supabase', action: 'help' };
  }
  if (/\bcloudflare\b/.test(lower)) {
    if (/\b(?:dns|records?)\b/.test(lower) && domain) return { service: 'cloudflare', action: 'dns', zone: domain.toLowerCase() };
    return { service: 'cloudflare', action: 'zones' };
  }
  if (subreddit) return { service: 'reddit', action: 'listing', subreddit: subreddit.toLowerCase() };
  if (/\breddit\b/.test(lower) && /\b(?:search|find|look\s+up)\b/.test(lower)) {
    const query = value
      .replace(/^.*?\breddit\b/i, '')
      .replace(/^\s*(?:search|find|look\s+up)\b/i, '')
      .replace(/^\s*(?:for|about)\b/i, '')
      .replace(/^[\s:,-]+/, '')
      .trim();
    if (query) return { service: 'reddit', action: 'search', query: query.slice(0, 120) };
  }
  return undefined;
}

const flat = (value, max = 180) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function cell(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return flat(JSON.stringify(value), 60);
  return flat(value, 60);
}

function credentials(connectors, id) {
  const service = serviceById.get(id);
  const saved = connectors?.[id] ?? {};
  const missing = service.fields.filter(({ key }) => !saved[key]).map(({ label }) => label.toLowerCase());
  if (missing.length) {
    throw new Error(`Connect ${service.label} first: Settings → Connectors needs the ${missing.join(' and ')}.`);
  }
  return saved;
}

async function read(response, name) {
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${name} rejected the key (${response.status}). Update it in Settings → Connectors.`);
    }
    if (response.status === 404) throw new Error(`${name} couldn’t find that (404).`);
    if (response.status === 429) throw new Error(`${name} is rate limiting this browser. Try again in a minute.`);
    throw new Error(`${name} answered with ${response.status}.`);
  }
  return response.json();
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

async function github(request, connectors, { fetchImpl, signal }) {
  const { token } = credentials(connectors, 'github');
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const get = async (path) => read(await fetchImpl(`https://api.github.com${path}`, {
    headers, credentials: 'omit', signal,
  }), 'GitHub');

  if (isWrite(request)) {
    // Reading is harmless; writing is not. It stays off until it is turned on.
    if (connectors?.github?.allowWrite !== true) {
      throw new Error('Changes are switched off. Tick “Allow changes” in Settings → Connectors → GitHub, then ask again.');
    }
    const call = async (path, method, body) => read(await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      signal,
    }), 'GitHub');

    if (request.action === 'create-issue') {
      const created = await call(`/repos/${request.repo}/issues`, 'POST', { title: request.title });
      return {
        service: 'github', title: `Opened an issue in ${request.repo}`, changed: true,
        items: [{ title: flat(created?.title || request.title), detail: `#${created?.number ?? '?'} · just now`, url: created?.html_url ?? undefined }],
      };
    }
    if (request.action === 'comment') {
      const created = await call(`/repos/${request.repo}/issues/${request.number}/comments`, 'POST', { body: request.body });
      return {
        service: 'github', title: `Commented on ${request.repo}#${request.number}`, changed: true,
        items: [{ title: flat(request.body, 180), detail: 'your comment', url: created?.html_url ?? undefined }],
      };
    }
    if (request.action === 'describe') {
      const updated = await call(`/repos/${request.repo}`, 'PATCH', { description: request.description });
      return {
        service: 'github', title: `Changed the description of ${request.repo}`, changed: true,
        items: [{ title: flat(request.description, 180), detail: updated?.description ? 'saved' : 'cleared', url: updated?.html_url ?? undefined }],
      };
    }
    // A file needs the current SHA to be replaced, and none to be created.
    const existing = await fetchImpl(`https://api.github.com/repos/${request.repo}/contents/${request.path}`, {
      headers, credentials: 'omit', signal,
    });
    let sha;
    if (existing.ok) {
      const data = await existing.json().catch(() => ({}));
      sha = typeof data?.sha === 'string' ? data.sha : undefined;
    } else if (existing.status !== 404) {
      await read(existing, 'GitHub');
    }
    const saved = await call(`/repos/${request.repo}/contents/${request.path}`, 'PUT', {
      message: `${sha ? 'Update' : 'Add'} ${request.path} from Chorus`,
      content: toBase64(request.content),
      ...(sha ? { sha } : {}),
    });
    return {
      service: 'github', title: `${sha ? 'Updated' : 'Created'} ${request.path}`, changed: true,
      items: [{
        title: request.path,
        detail: `${sha ? 'updated' : 'added'} in ${request.repo}`,
        url: saved?.content?.html_url ?? saved?.commit?.html_url ?? undefined,
      }],
    };
  }

  if (request.action === 'notifications') {
    const data = await get('/notifications?per_page=8');
    return {
      service: 'github', title: 'Your GitHub notifications',
      items: (Array.isArray(data) ? data : []).map((item) => ({
        title: flat(item?.subject?.title || 'Notification'),
        detail: [item?.repository?.full_name, item?.subject?.type, item?.reason].filter(Boolean).join(' · '),
        url: item?.subject?.url?.replace('api.github.com/repos', 'github.com') ?? undefined,
      })),
    };
  }
  if (request.action === 'issues' || request.action === 'pulls') {
    const kind = request.action === 'pulls' ? 'pulls' : 'issues';
    const data = await get(`/repos/${request.repo}/${kind}?state=open&per_page=8`);
    return {
      service: 'github', title: `${kind === 'pulls' ? 'Open pull requests' : 'Open issues'} in ${request.repo}`,
      items: (Array.isArray(data) ? data : []).map((item) => ({
        title: flat(item?.title || 'Untitled'),
        detail: [`#${item?.number}`, item?.user?.login, item?.comments ? `${item.comments} comments` : ''].filter(Boolean).join(' · '),
        url: item?.html_url ?? undefined,
      })),
    };
  }
  if (request.action === 'commits') {
    const data = await get(`/repos/${request.repo}/commits?per_page=8`);
    return {
      service: 'github', title: `Latest commits in ${request.repo}`,
      items: (Array.isArray(data) ? data : []).map((item) => ({
        title: flat(item?.commit?.message?.split('\n')[0] || 'Commit'),
        detail: [item?.commit?.author?.name, item?.sha?.slice(0, 7)].filter(Boolean).join(' · '),
        url: item?.html_url ?? undefined,
      })),
    };
  }
  if (request.action === 'repo') {
    const data = await get(`/repos/${request.repo}`);
    return {
      service: 'github', title: data?.full_name || request.repo,
      items: [{
        title: flat(data?.description || 'No description'),
        detail: [data?.language, `${data?.stargazers_count ?? 0} stars`, `${data?.open_issues_count ?? 0} open issues`, data?.private ? 'private' : 'public'].filter(Boolean).join(' · '),
        url: data?.html_url ?? undefined,
      }],
    };
  }
  const data = await get('/user/repos?per_page=8&sort=updated&affiliation=owner,collaborator,organization_member');
  return {
    service: 'github', title: 'Your most recently updated repositories',
    items: (Array.isArray(data) ? data : []).map((repo) => ({
      title: repo?.full_name || 'Repository',
      detail: [repo?.language, `${repo?.stargazers_count ?? 0} stars`, repo?.private ? 'private' : 'public', flat(repo?.description, 90)].filter(Boolean).join(' · '),
      url: repo?.html_url ?? undefined,
    })),
  };
}

async function supabase(request, connectors, { fetchImpl, signal }) {
  if (request.action === 'help') {
    return {
      service: 'supabase', title: 'Which table should I read?',
      items: [],
      note: 'Say it with a table name, for example “Supabase rows from profiles”.',
    };
  }
  const { url, key } = credentials(connectors, 'supabase');
  const base = url.replace(/\/+$/, '');
  if (!/^https:\/\/[\w.-]+\.supabase\.co$/.test(base)) {
    throw new Error('The Supabase project URL should look like https://yourproject.supabase.co');
  }
  const rows = await read(await fetchImpl(`${base}/rest/v1/${encodeURIComponent(request.table)}?select=*&limit=10`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
    credentials: 'omit', signal,
  }), 'Supabase');
  if (!Array.isArray(rows)) throw new Error('Supabase returned something unexpected for that table.');
  return {
    service: 'supabase', title: `Rows from ${request.table}`,
    items: rows.map((row) => ({
      title: Object.entries(row ?? {}).slice(0, 4).map(([name, value]) => `${name}: ${cell(value)}`).join(' · ') || 'Empty row',
      detail: Object.keys(row ?? {}).length > 4 ? `${Object.keys(row).length} columns` : '',
    })),
    note: rows.length ? undefined : 'That table is empty, or row level security hides its rows.',
  };
}

async function cloudflare(request, connectors, { fetchImpl, signal }) {
  const { token } = credentials(connectors, 'cloudflare');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const call = async (path) => {
    const body = await read(await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      headers, credentials: 'omit', signal,
    }), 'Cloudflare');
    if (body?.success === false) throw new Error(`Cloudflare refused that: ${flat(body?.errors?.[0]?.message || 'permission denied', 160)}`);
    return body?.result;
  };
  if (request.action === 'dns') {
    const zones = await call(`/zones?name=${encodeURIComponent(request.zone)}&per_page=1`);
    const zone = Array.isArray(zones) ? zones[0] : undefined;
    if (!zone) throw new Error(`No Cloudflare zone named ${request.zone} is visible to this token.`);
    const records = await call(`/zones/${zone.id}/dns_records?per_page=20`);
    return {
      service: 'cloudflare', title: `DNS records for ${request.zone}`,
      items: (Array.isArray(records) ? records : []).map((record) => ({
        title: `${record?.type ?? '?'} ${record?.name ?? ''}`,
        detail: [record?.content, record?.proxied ? 'proxied' : 'DNS only', `TTL ${record?.ttl ?? 'auto'}`].filter(Boolean).join(' · '),
      })),
    };
  }
  const zones = await call('/zones?per_page=10');
  return {
    service: 'cloudflare', title: 'Your Cloudflare zones',
    items: (Array.isArray(zones) ? zones : []).map((zone) => ({
      title: zone?.name || 'Zone',
      detail: [zone?.status, zone?.plan?.name, zone?.paused ? 'paused' : ''].filter(Boolean).join(' · '),
    })),
  };
}

async function reddit(request, _connectors, { fetchImpl, signal }) {
  const target = request.action === 'search'
    ? `https://www.reddit.com/search.json?q=${encodeURIComponent(request.query)}&limit=8&sort=relevance`
    : `https://www.reddit.com/r/${encodeURIComponent(request.subreddit)}/hot.json?limit=8`;
  const body = await read(await fetchImpl(target, {
    headers: { Accept: 'application/json' }, credentials: 'omit', signal,
  }), 'Reddit');
  const posts = (body?.data?.children ?? []).map((child) => child?.data).filter(Boolean);
  return {
    service: 'reddit',
    title: request.action === 'search' ? `Reddit search: ${request.query}` : `Hot in r/${request.subreddit}`,
    items: posts.map((post) => ({
      title: flat(post?.title || 'Post', 160),
      detail: [`r/${post?.subreddit}`, `${post?.score ?? 0} points`, `${post?.num_comments ?? 0} comments`].filter(Boolean).join(' · '),
      url: post?.permalink ? `https://www.reddit.com${post.permalink}` : undefined,
    })),
    note: posts.length ? undefined : 'That subreddit is empty or private.',
  };
}

/**
 * Reads the account a token belongs to, so "Connected as …" is a fact rather
 * than a guess, and a bad token is caught straight away.
 */
export async function githubIdentity(token, { fetchImpl = globalThis.fetch, signal } = {}) {
  const trimmed = String(token ?? '').trim();
  if (!trimmed) return undefined;
  let response;
  try {
    response = await fetchImpl('https://api.github.com/user', {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${trimmed}`, 'X-GitHub-Api-Version': '2022-11-28' },
      credentials: 'omit', signal,
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const data = await response.json().catch(() => ({}));
  const login = typeof data?.login === 'string' ? data.login : undefined;
  if (!login) return undefined;
  const avatar = typeof data?.avatar_url === 'string' && /^https:\/\/avatars\.githubusercontent\.com\//.test(data.avatar_url)
    ? data.avatar_url
    : undefined;
  return { login, ...(avatar ? { avatar } : {}) };
}

/** Runs one parsed request and returns what the chat card should show. */
export async function runConnector(request, connectors = {}, { fetchImpl = globalThis.fetch, signal } = {}) {
  const service = serviceById.get(request?.service);
  if (!service) throw new Error('That connector isn’t available.');
  const options = { fetchImpl, signal };
  try {
    if (request.service === 'github') return await github(request, connectors, options);
    if (request.service === 'supabase') return await supabase(request, connectors, options);
    if (request.service === 'cloudflare') return await cloudflare(request, connectors, options);
    return await reddit(request, connectors, options);
  } catch (error) {
    // A browser reports a blocked cross-origin request as a bare TypeError.
    if (error instanceof TypeError) {
      throw new Error(`${service.label} couldn’t be reached from this browser. It may block cross-origin requests, or the connection is down.`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${service.label} answered with something that isn’t JSON.`);
    }
    throw error;
  }
}

/**
 * A harmless request that proves a connector works, so "connected" is something
 * the user checked rather than something the page assumes.
 */
export async function testConnector(id, connectors = {}, { fetchImpl = globalThis.fetch, signal } = {}) {
  const options = { fetchImpl, signal };
  if (id === 'github') {
    const who = await githubIdentity(credentials(connectors, 'github').token, options);
    if (!who) throw new Error('GitHub did not accept that token.');
    return `GitHub works: connected as @${who.login}`;
  }
  if (id === 'reddit') {
    const posts = await reddit({ action: 'listing', subreddit: 'popular' }, connectors, options);
    return `Reddit works: read ${posts.items.length} posts from r/popular`;
  }
  if (id === 'supabase') {
    const { url, key } = credentials(connectors, 'supabase');
    const base = url.replace(/\/+$/, '');
    if (!/^https:\/\/[\w.-]+\.supabase\.co$/.test(base)) {
      throw new Error('That project URL should look like https://yourproject.supabase.co');
    }
    const response = await fetchImpl(`${base}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
      credentials: 'omit', signal,
    });
    if (!response.ok) throw new Error(`Supabase answered with ${response.status}. Check the URL and the anon key.`);
    return 'Supabase works: that project answers with that key';
  }
  if (id === 'cloudflare') {
    const zones = await cloudflare({ action: 'zones' }, connectors, options);
    return `Cloudflare works: ${zones.items.length} zones visible`;
  }
  throw new Error('That connector isn’t available.');
}

/** Short text handed to the model, so it can talk about what was fetched. */
export function summarise(result) {
  if (!result || result.error || !result.items?.length) return '';
  const lines = result.items.slice(0, 8).map((item) => `- ${item.title}${item.detail ? ` (${item.detail})` : ''}`);
  return `${result.title}:\n${lines.join('\n')}`.slice(0, CONTEXT_LIMIT);
}
