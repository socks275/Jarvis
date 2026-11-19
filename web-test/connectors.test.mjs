import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONNECTOR_KEY, SERVICES, githubIdentity, isConnected, parseConnectorRequest, readConnectors, runConnector, summarise, writeConnectors,
} from '../web/connectors.mjs';

const fakeStorage = () => {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)) };
};

const answer = (body, init) => Response.json(body, init);

test('reads the four services and their fields', () => {
  assert.deepEqual(SERVICES.map(({ id }) => id), ['github', 'supabase', 'cloudflare', 'reddit']);
  assert.deepEqual(SERVICES.find(({ id }) => id === 'supabase').fields.map(({ key }) => key), ['url', 'key']);
  assert.equal(SERVICES.find(({ id }) => id === 'reddit').fields.length, 0);
});

test('saves and reads connector keys without trusting storage', () => {
  const storage = fakeStorage();
  const saved = { github: { token: '  ghp_test  ' }, supabase: { url: 'https://demo.supabase.co' }, cloudflare: {}, reddit: {} };
  assert.equal(writeConnectors(storage, saved), true);
  const back = readConnectors(storage);
  assert.deepEqual(back.github, { token: 'ghp_test' });
  assert.deepEqual(back.supabase, { url: 'https://demo.supabase.co' });
  assert.deepEqual(back.cloudflare, {});
  storage.setItem(CONNECTOR_KEY, 'not json');
  assert.deepEqual(readConnectors(storage).github, {});
  assert.equal(readConnectors(undefined).github.token, undefined);
  assert.equal(isConnected(SERVICES[0], back), true);
  assert.equal(isConnected(SERVICES[0], { github: {} }), false);
  assert.equal(isConnected(SERVICES[3], {}), true);
});

test('recognises a named service, and leaves ordinary questions alone', () => {
  assert.deepEqual(parseConnectorRequest('list my GitHub repos'), { service: 'github', action: 'repos' });
  assert.deepEqual(parseConnectorRequest('GitHub commits in socks275/Jarvis'), { service: 'github', action: 'commits', repo: 'socks275/Jarvis' });
  assert.deepEqual(parseConnectorRequest('github issues in socks275/Jarvis'), { service: 'github', action: 'issues', repo: 'socks275/Jarvis' });
  assert.deepEqual(parseConnectorRequest('my github notifications'), { service: 'github', action: 'notifications' });
  assert.deepEqual(parseConnectorRequest('Supabase rows from profiles'), { service: 'supabase', action: 'rows', table: 'profiles' });
  assert.deepEqual(parseConnectorRequest('connect to supabase'), { service: 'supabase', action: 'help' });
  assert.deepEqual(parseConnectorRequest('my Cloudflare zones'), { service: 'cloudflare', action: 'zones' });
  assert.deepEqual(parseConnectorRequest('Cloudflare DNS for example.com'), { service: 'cloudflare', action: 'dns', zone: 'example.com' });
  assert.deepEqual(parseConnectorRequest('hot in r/webdev'), { service: 'reddit', action: 'listing', subreddit: 'webdev' });
  assert.deepEqual(parseConnectorRequest('search Reddit for mechanical keyboards'), { service: 'reddit', action: 'search', query: 'mechanical keyboards' });
  assert.equal(parseConnectorRequest('what is GitHub?'), undefined);
  assert.equal(parseConnectorRequest('explain reddit karma'), undefined);
  assert.equal(parseConnectorRequest(''), undefined);
});

test('reads GitHub repositories with the saved token', async () => {
  const seen = [];
  const result = await runConnector({ service: 'github', action: 'repos' }, { github: { token: 'ghp_test' } }, {
    fetchImpl: async (url, options) => {
      seen.push({ url, headers: options.headers });
      return answer([{ full_name: 'socks275/Jarvis', description: 'AI chat', language: 'JavaScript', stargazers_count: 3, private: false, html_url: 'https://github.com/socks275/Jarvis' }]);
    },
  });
  assert.equal(seen[0].url, 'https://api.github.com/user/repos?per_page=8&sort=updated&affiliation=owner,collaborator,organization_member');
  assert.equal(seen[0].headers.Authorization, 'Bearer ghp_test');
  assert.equal(result.title, 'Your most recently updated repositories');
  assert.deepEqual(result.items[0], {
    title: 'socks275/Jarvis',
    detail: 'JavaScript · 3 stars · public · AI chat',
    url: 'https://github.com/socks275/Jarvis',
  });
});

test('explains a missing key instead of calling the service', async () => {
  await assert.rejects(() => runConnector({ service: 'github', action: 'repos' }, {}, { fetchImpl: async () => { throw new Error('should not run'); } }),
    /Settings → Connectors/);
});

test('reports a rejected token in plain words', async () => {
  await assert.rejects(() => runConnector({ service: 'github', action: 'repos' }, { github: { token: 'bad' } }, {
    fetchImpl: async () => new Response('nope', { status: 401 }),
  }), /rejected the key \(401\)/);
});

test('turns a blocked cross-origin request into plain words', async () => {
  await assert.rejects(() => runConnector({ service: 'cloudflare', action: 'zones' }, { cloudflare: { token: 'cf' } }, {
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
  }), /Cloudflare couldn’t be reached from this browser/);
  await assert.rejects(() => runConnector({ service: 'reddit', action: 'listing', subreddit: 'webdev' }, {}, {
    fetchImpl: async () => new Response('<html>rate limited</html>', { status: 200 }),
  }), /Reddit answered with something that isn’t JSON/);
});

test('formats Supabase rows and checks the project URL', async () => {
  const result = await runConnector({ service: 'supabase', action: 'rows', table: 'profiles' },
    { supabase: { url: 'https://demo.supabase.co', key: 'anon' } }, {
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://demo.supabase.co/rest/v1/profiles?select=*&limit=10');
        assert.equal(options.headers.apikey, 'anon');
        return answer([{ id: 1, name: 'Ada', tags: ['math'], note: 'first' }, { id: 2, name: 'Grace', a: 1, b: 2, c: 3 }]);
      },
    });
  assert.equal(result.title, 'Rows from profiles');
  assert.equal(result.items[0].title, 'id: 1 · name: Ada · tags: ["math"] · note: first');
  assert.equal(result.items[0].detail, '');
  assert.equal(result.items[1].detail, '5 columns');
  await assert.rejects(() => runConnector({ service: 'supabase', action: 'rows', table: 'x' },
    { supabase: { url: 'https://evil.test', key: 'anon' } }, { fetchImpl: async () => answer([]) }),
  /should look like https:\/\/yourproject\.supabase\.co/);
});

test('reads Cloudflare zones and their DNS records', async () => {
  const zones = await runConnector({ service: 'cloudflare', action: 'zones' }, { cloudflare: { token: 'cf' } }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.cloudflare.com/client/v4/zones?per_page=10');
      assert.equal(options.headers.Authorization, 'Bearer cf');
      return answer({ success: true, result: [{ name: 'example.com', status: 'active', plan: { name: 'Free' } }] });
    },
  });
  assert.deepEqual(zones.items[0], { title: 'example.com', detail: 'active · Free' });

  const dns = await runConnector({ service: 'cloudflare', action: 'dns', zone: 'example.com' }, { cloudflare: { token: 'cf' } }, {
    fetchImpl: async (url) => (url.includes('dns_records')
      ? answer({ success: true, result: [{ type: 'A', name: 'example.com', content: '1.2.3.4', proxied: true, ttl: 1 }] })
      : answer({ success: true, result: [{ id: 'zone-1', name: 'example.com' }] })),
  });
  assert.deepEqual(dns.items[0], { title: 'A example.com', detail: '1.2.3.4 · proxied · TTL 1' });

  await assert.rejects(() => runConnector({ service: 'cloudflare', action: 'zones' }, { cloudflare: { token: 'cf' } }, {
    fetchImpl: async () => answer({ success: false, errors: [{ message: 'Invalid API Token' }] }),
  }), /Cloudflare refused that: Invalid API Token/);
});

test('reads a public subreddit without any key', async () => {
  const result = await runConnector({ service: 'reddit', action: 'listing', subreddit: 'webdev' }, {}, {
    fetchImpl: async (url) => {
      assert.equal(url, 'https://www.reddit.com/r/webdev/hot.json?limit=8');
      return answer({ data: { children: [{ data: { title: 'A post', subreddit: 'webdev', score: 42, num_comments: 7, permalink: '/r/webdev/comments/abc/a_post/' } }] } });
    },
  });
  assert.equal(result.title, 'Hot in r/webdev');
  assert.deepEqual(result.items[0], {
    title: 'A post', detail: 'r/webdev · 42 points · 7 comments', url: 'https://www.reddit.com/r/webdev/comments/abc/a_post/',
  });
});

test('summarises a result for the model, and nothing when it failed', () => {
  const text = summarise({ title: 'Your repositories', service: 'github', items: [{ title: 'a/b', detail: 'JavaScript' }] });
  assert.equal(text, 'Your repositories:\n- a/b (JavaScript)');
  assert.equal(summarise({ error: 'nope' }), '');
  assert.equal(summarise({ title: 'x', items: [] }), '');
});

test('checks which account a GitHub token belongs to', async () => {
  const seen = [];
  const who = await githubIdentity(' ghp_test ', { fetchImpl: async (url, options) => {
    seen.push({ url, auth: options.headers.Authorization });
    return Response.json({ login: 'socks275' });
  } });
  assert.deepEqual(who, { login: 'socks275' });
  assert.equal(seen[0].url, 'https://api.github.com/user');
  assert.equal(seen[0].auth, 'Bearer ghp_test');
  assert.equal(await githubIdentity('bad', { fetchImpl: async () => new Response('{}', { status: 401 }) }), undefined);
  assert.equal(await githubIdentity('', {}), undefined);
});

test('keeps the OAuth settings next to the token', () => {
  const storage = fakeStorage();
  writeConnectors(storage, {
    github: { clientId: 'Iv1.abc', relay: 'https://relay.test', login: 'socks275' },
    supabase: {}, cloudflare: {}, reddit: {},
  });
  assert.deepEqual(readConnectors(storage).github, {
    clientId: 'Iv1.abc', relay: 'https://relay.test', login: 'socks275',
  });
});

test('keeps the GitHub avatar only from GitHub itself', async () => {
  const fine = await githubIdentity('ghp', { fetchImpl: async () => Response.json({ login: 'ada', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }) });
  assert.deepEqual(fine, { login: 'ada', avatar: 'https://avatars.githubusercontent.com/u/1?v=4' });
  const odd = await githubIdentity('ghp', { fetchImpl: async () => Response.json({ login: 'ada', avatar_url: 'https://evil.test/a.png' }) });
  assert.deepEqual(odd, { login: 'ada' });
});
