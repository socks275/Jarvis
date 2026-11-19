import MarkdownIt from './vendor/markdown-it.mjs';
import { createFormatter } from './format.mjs';
import { answerChat, cleanPrompt, conversationContext, createChat, newTurn, orderedChats, readChats, saveChats } from './chat.mjs';
import { communityEngine, getOnlineModels } from './community.mjs';
import { browserEngine, validateModel } from './engine.mjs';
import { embedUrl, playRequest, searchUrl, searchVideo, thumbnailUrl, watchUrl, youtubeId } from './youtube.mjs';
import { SERVICES, githubIdentity, isConnected, parseConnectorRequest, readConnectors, runConnector, summarise, testConnector, writeConnectors } from './connectors.mjs';
import { OAUTH_STATE_KEY, authorizeUrl, cleanUrl, readCallback, redeemCode } from './oauth.mjs';

const $ = (id) => document.getElementById(id);
const prompt = $('prompt');
const thread = $('thread');
const scroll = $('chat-scroll');
const engineOptions = [...$('engine-options').querySelectorAll('input')];
const mobile = matchMedia('(max-width: 700px)');
const format = createFormatter(MarkdownIt);
const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const templates = {
  explain: 'Explain how a black hole works using an everyday analogy.',
  write: 'Draft a friendly, concise email asking to reschedule a meeting. Give me two tone options.',
  ideas: 'Suggest five creative weekend projects I can finish at home, with a simple first step for each.',
  plan: 'Help me make a realistic four-week plan to learn a new skill. Start by asking which skill I want to learn.',
};

let storage;
try { storage = window.localStorage; } catch { /* some embedded contexts deny storage */ }
let connectors = readConnectors(storage);
let connectorRun = false;
let chats = readChats(storage);
let current;
const drafts = new Map();
let active;
let pendingNodes;
let streamFrame = 0;
let engine = 'community';
let localFile;
let validatingFile = false;
let deeper = false;
let communityAllowed = false;
let consentAction;
let statusController;
let models;
let networkError = '';
let retryAt = 0;
let retryTimer;
let removeTarget;
let desktopSidebar = true;
let mobileSidebar = false;
let warnedStorage = false;
let toastTimer;
let canvas = { code: '', language: '' };
let canvasTimer;
let canvasFocus;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function button(className, label, glyph, action) {
  const node = el('button', className);
  node.type = 'button';
  if (glyph) node.append(icon(glyph));
  node.append(label);
  if (action) node.addEventListener('click', action);
  return node;
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3100);
}

function save() {
  if (!saveChats(storage, chats) && !warnedStorage) {
    warnedStorage = true;
    toast('Browser storage is unavailable. Your chats will only last until you leave this page.');
  }
}

function sizePrompt() {
  prompt.style.height = 'auto';
  prompt.style.height = `${prompt.scrollHeight}px`;
}

function setSidebar(open, focus = false) {
  if (mobile.matches) mobileSidebar = open;
  else desktopSidebar = open;
  paintSidebar();
  if (focus) $(open ? 'new-chat' : 'sidebar-toggle').focus({ preventScroll: true });
}

function paintSidebar() {
  const open = mobile.matches ? mobileSidebar : desktopSidebar;
  document.body.dataset.sidebar = open ? 'open' : 'closed';
  $('sidebar').inert = !open;
  $('main').inert = mobile.matches && open;
  $('sidebar-backdrop').hidden = !(mobile.matches && open);
  const toggle = $('sidebar-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Hide sidebar' : 'Show sidebar');
  toggle.title = toggle.getAttribute('aria-label');
}

function historyButton(chat, search = false) {
  const node = el('button', 'history-button');
  node.type = 'button';
  node.title = chat.title;
  node.append(icon('chat'), el('span', 'history-title', chat.title));
  if (current === chat) node.setAttribute('aria-current', 'true');
  if (active?.chat === chat) {
    const mark = el('span', 'history-running');
    mark.setAttribute('aria-label', 'Reply in progress');
    node.append(mark);
  }
  if (search) node.append(el('span', 'search-date', date.format(chat.updatedAt)));
  node.addEventListener('click', () => {
    if (search) $('search-dialog').close();
    openChat(chat);
  });
  const li = el('li', search ? 'history-row' : 'history-row history-row-delete');
  li.append(node);
  if (!search) {
    const remove = el('button', 'history-delete');
    remove.type = 'button';
    remove.title = 'Delete chat';
    remove.setAttribute('aria-label', `Delete chat: ${chat.title}`);
    remove.disabled = active?.chat === chat;
    remove.append(icon('trash'));
    remove.addEventListener('click', () => confirmRemove(chat));
    li.append(remove);
  }
  return li;
}

function paintHistory() {
  $('history-empty').hidden = chats.length > 0;
  $('chat-list').replaceChildren(...orderedChats(chats).slice(0, 32).map((chat) => historyButton(chat)));
  if ($('search-dialog').open) paintSearch();
}

function paintSearch() {
  const query = $('search-input').value.trim().toLowerCase();
  const found = orderedChats(chats).filter((chat) => !query || chat.title.toLowerCase().includes(query)
    || chat.messages.some((m) => m.text.toLowerCase().includes(query)));
  $('search-empty').textContent = !found.length ? query ? 'No chats match that search.' : 'Start a chat to find it here later.' : '';
  $('search-empty').hidden = Boolean(found.length);
  $('search-results').replaceChildren(...found.slice(0, 32).map((chat) => historyButton(chat, true)));
}

function paintConnection() {
  const community = engine === 'community';
  const label = community ? 'Community AI' : 'On-device';
  $('sidebar-engine').textContent = $('top-engine').textContent = label;
  $('sidebar-engine-note').textContent = community ? 'Free · no key required' : localFile ? 'Model ready on this device' : 'Choose a GGUF file';
  for (const id of ['sidebar-engine-icon', 'top-engine-icon']) $(id).setAttribute('href', community ? '#i-globe' : '#i-device');
  paintComposer();
  paintSettings();
}

const cooling = () => engine === 'community' && retryAt > Date.now();
const unavailable = () => engine === 'local' && !localFile;
const blocked = () => Boolean(active || validatingFile || connectorRun || cooling() || unavailable());

function paintComposer() {
  const writing = Boolean(active && active.chat === current);
  const busyElsewhere = Boolean(active && !writing);
  const cooldown = cooling();
  const needsFile = unavailable();
  $('send-button').hidden = writing;
  $('send-button').disabled = blocked() || !prompt.value.trim();
  $('stop-button').hidden = !writing;
  $('deep-button').hidden = engine === 'local';
  $('deep-button').disabled = Boolean(active);
  $('deep-button').setAttribute('aria-pressed', String(deeper));
  $('composer-status').hidden = !(busyElsewhere || cooldown || needsFile);
  $('composer-note').textContent = busyElsewhere ? 'Chorus is replying in another chat.'
    : cooldown ? 'The community network asked us to wait. You can send again when the cooldown ends.'
      : needsFile ? 'Select a GGUF file to chat on-device.' : '';
  $('open-busy').hidden = !busyElsewhere;
  $('choose-model').hidden = busyElsewhere || !needsFile;
  for (const retry of thread.querySelectorAll('[data-retry]')) retry.disabled = blocked();
}

function showCooldown(seconds) {
  retryAt = Math.max(retryAt, Date.now() + seconds * 1000);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { retryAt = 0; paintComposer(); paintSettings(); }, retryAt - Date.now());
  paintComposer();
  paintSettings();
}

function paintSettings() {
  const locked = Boolean(active || validatingFile);
  for (const option of engineOptions) {
    option.checked = option.value === engine;
    option.disabled = locked;
  }
  $('settings-busy').hidden = !active;
  $('community-settings').hidden = engine !== 'community';
  $('local-settings').hidden = engine !== 'local';
  $('network-status').textContent = statusController ? 'Checking available models…' : networkError || (models === undefined
    ? 'Availability hasn’t been checked yet.' : models.length
      ? `${models.length} ${models.length === 1 ? 'text model was' : 'text models were'} online at the last check.`
      : 'No eligible text models were online at the last check.');
  $('online-models').replaceChildren(...(networkError ? [] : (models ?? []).slice(0, 5).map(({ id }) => el('li', '', id))));
  $('online-models').hidden = Boolean(networkError || !models?.length || statusController);
  $('check-network').disabled = Boolean(active || statusController || retryAt > Date.now());
  $('reset-permission').hidden = !communityAllowed;
  $('reset-permission').disabled = Boolean(active);
  $('model-file').disabled = locked;
  $('file-label').textContent = validatingFile ? 'Checking model file…' : localFile?.name ?? 'Choose a .gguf file';
  $('clear-model').hidden = !localFile;
  $('clear-model').disabled = locked;
  $('clear-chats').disabled = Boolean(active || !chats.length);
}

// GitHub sends the browser back here with ?code; the relay turns it into a token.
async function finishGithubSignIn() {
  const callback = readCallback(location.href);
  if (!callback) return;
  try { window.history.replaceState(null, '', cleanUrl(location.href)); } catch { /* embedded history can be restricted */ }
  const saved = connectors.github ?? {};
  const expected = (() => { try { return sessionStorage.getItem(OAUTH_STATE_KEY); } catch { return undefined; } })();
  if (callback.error) {
    toast(`GitHub sign-in was cancelled (${callback.error}).`);
    return;
  }
  if (!saved.relay) {
    toast('Add the OAuth relay URL in Settings, then sign in again.');
    return;
  }
  if (expected && callback.state !== expected) {
    toast('That sign-in link was not started in this browser. Try again.');
    return;
  }
  try {
    const token = await redeemCode({ relay: saved.relay, code: callback.code });
    connectors = { ...connectors, github: { ...saved, token } };
    writeConnectors(storage, connectors);
    paintConnectors();
    toast('Signed in to GitHub.');
    await verifyGithub();
  } catch (error) {
    toast(String(error?.message ?? error).slice(0, 170));
  } finally {
    try { sessionStorage.removeItem(OAUTH_STATE_KEY); } catch { /* storage can be denied */ }
  }
}

function paintConnectors() {
  const list = $('connector-list');
  if (!list) return;
  list.replaceChildren(...SERVICES.map((service) => {
    const saved = connectors[service.id] ?? {};
    const on = isConnected(service, connectors);
    const box = el('section', 'connector');
    box.dataset.service = service.id;
    const head = el('div', 'connector-head');
    const state = el('span', 'connector-state');
    state.dataset.on = String(on);
    state.setAttribute('aria-hidden', 'true');
    head.append(state, el('strong', 'connector-name', service.label));
    head.append(el('small', 'connector-status', service.fields.length ? (on ? 'Connected' : 'Not connected') : 'Public · no key needed'));
    box.append(head, el('p', 'fine-print', service.blurb));
    if (service.id === 'github' && saved.login) {
      const who = el('p', 'connector-account');
      if (saved.avatar) {
        const picture = el('img', 'connector-avatar');
        picture.src = saved.avatar;
        picture.alt = '';
        picture.width = 18;
        picture.height = 18;
        who.append(picture);
      }
      who.append(el('span', '', `Connected as @${saved.login}`));
      box.append(who);
    }
    for (const field of [...service.fields, ...(service.oauth?.fields ?? [])]) {
      const secret = field.key === 'token' || field.key === 'key';
      const input = el('input', 'text-field connector-input');
      input.id = `connector-${service.id}-${field.key}`;
      input.type = secret ? 'password' : field.key === 'url' ? 'url' : 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('autocorrect', 'off');
      input.dataset.connectorSecret = String(secret);
      if (secret) {
        // A saved key is never written back into the page: not in the field,
        // not in a value attribute, not anywhere the DOM can be read from.
        input.dataset.lpignore = 'true';
        input.setAttribute('data-1p-ignore', 'true');
        input.placeholder = saved[field.key]
          ? 'Saved in this browser — type a new one to replace it'
          : field.placeholder ?? field.hint ?? '';
        input.value = '';
      } else {
        input.placeholder = field.placeholder ?? field.hint ?? '';
        input.value = saved[field.key] ?? '';
      }
      const label = el('label', 'text-label', field.label);
      label.htmlFor = input.id;
      if (secret && saved[field.key]) label.append(el('span', 'connector-saved', 'saved'));
      box.append(label, input);
    }
    for (const flag of service.flags ?? []) {
      const wrap = el('label', 'connector-flag');
      const box = el('input');
      box.type = 'checkbox';
      box.id = `connector-${service.id}-${flag.key}`;
      box.checked = saved[flag.key] === true;
      box.addEventListener('change', () => {
        connectors = { ...connectors, [service.id]: { ...connectors[service.id], [flag.key]: box.checked } };
        writeConnectors(storage, connectors);
        toast(box.checked
          ? `${service.label} changes are on: a command in a chat will write to your account`
          : `${service.label} changes are off again`);
      });
      wrap.append(box, el('span', '', flag.label));
      if (flag.hint) wrap.append(el('small', 'connector-flag-hint', flag.hint));
    }
    if (service.writes?.length) {
      box.append(el('p', 'fine-print connector-example', `Edits, when allowed: ${service.writes.map((line) => `“${line}”`).join(' · ')}`));
    }
    if (service.tokenPage && !service.oauth) {
      const where = el('a', 'text-action', `Where do I find this? ${service.tokenLabel}`);
      where.href = service.tokenPage;
      where.target = '_blank';
      where.rel = 'noopener noreferrer';
      where.append(document.createTextNode(''));
      box.append(where);
    }
    if (service.oauth) {
      const oauthActions = el('div', 'settings-buttons');
      const start = el('button', 'button border-button', service.oauth.connect);
      start.type = 'button';
      start.dataset.oauthStart = service.oauth.provider;
      const instead = el('a', 'text-action', 'Get a token instead');
      instead.href = service.oauth.tokenPage;
      instead.target = '_blank';
      instead.rel = 'noopener noreferrer';
      const help = el('button', 'text-action', 'How this works');
      help.type = 'button';
      help.dataset.oauthHelp = service.oauth.provider;
      oauthActions.append(start, instead, help);
      box.append(oauthActions);
      box.append(el('p', 'fine-print', 'Sign-in runs through a relay you deploy once, because GitHub will not swap a code for a token inside a browser. The README has the whole function.'));
    }
    if (service.fields.length) {
      const actions = el('div', 'settings-buttons');
      const save = el('button', 'button border-button', on ? 'Update' : 'Save');
      save.type = 'button';
      save.dataset.connectorSave = service.id;
      const clear = el('button', 'text-action', 'Remove');
      clear.type = 'button';
      clear.hidden = !on;
      clear.dataset.connectorClear = service.id;
      const check = el('button', 'text-action', 'Test');
      check.type = 'button';
      check.dataset.connectorTest = service.id;
      actions.append(save, check, clear);
      box.append(actions);
    } else {
      const actions = el('div', 'settings-buttons');
      const check = el('button', 'text-action', 'Test');
      check.type = 'button';
      check.dataset.connectorTest = service.id;
      actions.append(check);
      box.append(actions);
    }
    box.append(el('p', 'fine-print connector-example', `Try “${service.examples[0]}”`));
    return box;
  }));
}

function nearEnd() { return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 110; }
function scrollToEnd() { scroll.scrollTop = scroll.scrollHeight; $('scroll-latest').hidden = true; }
function syncScroll() { $('scroll-latest').hidden = !current || nearEnd(); }

const roleActive = {
  triage: 'is choosing the team', answer: 'is answering', draft: 'is writing a draft',
  review: 'is checking the draft', final: 'is writing the final answer',
};
const roleDone = {
  triage: 'chose the team', answer: 'answered', draft: 'wrote a draft',
  review: 'checked the draft', final: 'wrote the final answer',
};
const pickedModels = { solo: 'one model', pair: 'a team of two', panel: 'a team of three' };

function modelName(model) {
  const name = typeof model === 'string' ? model.trim() : '';
  return name.length > 34 ? `${name.slice(0, 33)}…` : name;
}

const roleSubject = { triage: 'A model', answer: 'A model', draft: 'A model', review: 'Another model', final: 'A new model' };

function teamChip(step, live = false) {
  const who = modelName(step.model) || roleSubject[step.role];
  let action = live ? roleActive[step.role] : roleDone[step.role];
  // The decider's verdict is the interesting part, not the verb.
  if (!live && step.role === 'triage' && pickedModels[step.pick]) action = `chose ${pickedModels[step.pick]}`;
  const chip = el('span', 'team-step', `${who} ${action}`);
  if (step.model) chip.title = step.model;
  if (live) {
    chip.dataset.live = '';
    const dots = el('span', 'thinking-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(el('i'), el('i'), el('i'));
    chip.append(dots);
  }
  return chip;
}

// The trail of models that worked on one reply: who decided, drafted, checked, finished.
function teamParts(steps = [], current) {
  const live = current?.state === 'active';
  const entries = [...steps, ...(live ? [current] : [])];
  if (entries.length < 2) return [];
  // Count different models, since one model can appear twice (decider and drafter).
  const distinct = new Set(entries.map((step) => step.model).filter(Boolean)).size;
  return [
    ...(distinct > 1 ? [el('span', 'team-count', `${distinct} models`)] : []),
    ...steps.map((step) => teamChip(step)),
    ...(live ? [teamChip(current, true)] : []),
  ];
}

function teamNode(steps = [], current) {
  const node = el('p', 'team-steps');
  const parts = teamParts(steps, current);
  node.hidden = !parts.length;
  node.append(...parts);
  return node;
}

// The ETA is a provider estimate, not a promise; only show it while queued.
function queueText(job) {
  const position = job?.queue?.position;
  if (!position) return '';
  const seconds = job.queue?.seconds;
  const eta = seconds && (seconds < 60 ? `about ${seconds}s` : `about ${Math.ceil(seconds / 60)} min`);
  return `In the community queue${eta ? ` · ${eta}` : ''}`;
}

function phaseText(job) {
  const step = job?.step;
  if (step) {
    const named = modelName(step.model);
    const queue = queueText(job);
    if (step.role === 'triage') return `${named ? `${named} is choosing how many models should answer…` : 'Choosing how many models should answer…'}${queue ? ` · ${queue}` : ''}`;
    if (step.role === 'answer') return `${named ? `${named} is answering…` : 'Writing a reply…'}${queue ? ` · ${queue}` : ''}`;
    const base = `${named || roleSubject[step.role]} ${roleActive[step.role]}…`;
    return queue ? `${base} · ${queue}` : base;
  }
  switch (job?.phase) {
    case 'finding': return 'Finding an online model…';
    case 'waiting': return queueText(job) || 'Waiting for a community model…';
    case 'loading': return 'Loading your local model…';
    case 'generating': return 'Writing a reply…';
    default: return 'Getting ready…';
  }
}

async function copy(text, control) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const temporary = el('textarea', 'sr-only');
    temporary.value = text;
    temporary.readOnly = true;
    document.body.append(temporary);
    temporary.select();
    let done = false;
    try { done = document.execCommand('copy'); } catch { /* permission unavailable */ }
    temporary.remove();
    control?.focus({ preventScroll: true });
    if (!done) { toast('Clipboard unavailable. Select and copy the text instead.'); return; }
  }
  toast('Copied to clipboard');
}

function videoCard(video, { pending = false, onRetry } = {}) {
  const card = el('div', 'video-card');
  if (video.id) {
    const frame = el('div', 'video-frame');
    const poster = el('button', 'video-poster');
    poster.type = 'button';
    poster.setAttribute('aria-label', `Play ${video.title || 'video'}`);
    const image = el('img');
    image.src = thumbnailUrl(video.id);
    image.alt = '';
    image.width = 480;
    image.height = 270;
    image.loading = 'lazy';
    const badge = el('span', 'video-play');
    badge.append(icon('play'));
    poster.append(image, badge);
    poster.addEventListener('click', () => {
      const player = el('iframe', 'video-player');
      player.src = embedUrl(video.id);
      // Without a referrer YouTube answers with "Video player configuration
      // error" (153) instead of playing.
      player.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      player.referrerPolicy = 'strict-origin-when-cross-origin';
      player.title = video.title || 'YouTube video';
      player.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      player.allowFullscreen = true;
      // Closing the player removes the frame entirely, so YouTube stops running
      // and any cookies it held for the session are dropped with it.
      const close = el('button', 'video-close');
      close.type = 'button';
      close.title = 'Close the player';
      close.setAttribute('aria-label', 'Close the player');
      close.append(icon('close'));
      close.addEventListener('click', () => {
        frame.replaceChildren(poster);
        poster.focus({ preventScroll: true });
      });
      frame.replaceChildren(player, close);
      player.focus({ preventScroll: true });
    });
    frame.append(poster);
    card.append(frame);
  }
  const meta = el('div', 'video-meta');
  if (video.title) meta.append(el('strong', 'video-title', video.title));
  if (video.id) {
    const link = el('a', 'video-link', 'Open on YouTube');
    link.href = watchUrl(video.id);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const privacy = el('span', 'video-privacy');
    privacy.append(icon('lock'), document.createTextNode('No-cookie player'));
    privacy.title = 'Plays through youtube-nocookie.com, which sets no cookies before you press play';
    meta.append(link, privacy);
  } else if (video.query) {
    const link = el('a', 'video-link', `Search YouTube for “${video.query}”`);
    link.href = searchUrl(video.query);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    if (pending) {
      meta.append(link, el('small', 'video-hint', 'Looking for the video…'));
    } else {
      meta.append(link, el('small', 'video-hint', 'The video search is unavailable right now, so this opens YouTube instead.'));
      if (onRetry) {
        const retry = el('button', 'video-retry', 'Try again');
        retry.type = 'button';
        retry.addEventListener('click', onRetry);
        meta.append(retry);
      }
    }
  }
  card.append(meta);
  return card;
}

function connectorCard(data) {
  const card = el('div', 'connector-card');
  const label = SERVICES.find(({ id }) => id === data.service)?.label ?? 'Connector';
  const head = el('div', 'connector-head');
  head.append(el('span', 'connector-badge', label));
  if (data.title) head.append(el('strong', 'connector-title', data.title));
  card.append(head);
  if (data.error) card.append(el('p', 'connector-error', data.error));
  const list = el('ul', 'connector-items');
  for (const item of (data.items ?? []).slice(0, 10)) {
    const row = el('li');
    const name = el(item.url ? 'a' : 'span', 'connector-item', item.title);
    if (item.url) {
      name.href = item.url;
      name.target = '_blank';
      name.rel = 'noopener noreferrer';
    }
    row.append(name);
    if (item.detail) row.append(el('small', 'connector-detail', item.detail));
    list.append(row);
  }
  if (list.children.length) card.append(list);
  if (data.note) card.append(el('p', 'connector-note', data.note));
  return card;
}

// Preview documents for the canvas. Everything runs in a sandboxed frame, so
// scripts can't reach this page's storage or the chat.
function canvasDocument(code, language) {
  const lang = String(language || '').toLowerCase();
  if (['html', 'htm', 'svg'].includes(lang)) return code;
  if (lang === 'css') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>${code}</style></head><body><main class="demo"><h1>Canvas preview</h1><p>This heading, paragraph and button use the styles you wrote.</p><button>Button</button></main></body></html>`;
  }
  if (['js', 'javascript', 'mjs', 'ts', 'typescript', 'jsx', 'tsx'].includes(lang)) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#17141f;color:#e8dcf7;font:13px/1.6 ui-monospace,monospace}pre{white-space:pre-wrap;margin:0}</style></head><body><pre id="out"></pre><script>(function(){
      const out = document.getElementById('out');
      const line = (...parts) => { out.textContent += parts.map((part) => typeof part === 'string' ? part : (() => { try { return JSON.stringify(part); } catch { return String(part); } })()).join(' ') + '\n'; };
      console.log = console.info = console.warn = console.error = line;
      window.addEventListener('error', (event) => line('Error: ' + event.message));
    })();</script><script>${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  }
  return '';
}

const canvasName = { html: 'html', htm: 'html', css: 'css', js: 'js', javascript: 'js', mjs: 'js', ts: 'ts', typescript: 'ts', json: 'json', svg: 'svg', python: 'py', bash: 'sh', sh: 'sh' };

function setCanvasTab(tab) {
  const preview = tab === 'preview';
  $('canvas-preview-tab').setAttribute('aria-selected', String(preview));
  $('canvas-code-tab').setAttribute('aria-selected', String(!preview));
  $('canvas-preview').hidden = !preview;
  $('canvas-code').hidden = preview;
}

function renderCanvasPreview() {
  if (!canvas.code) return;
  const document_ = canvasDocument($('canvas-source').value, canvas.language);
  const frame = $('canvas-frame');
  if (document_) frame.srcdoc = document_;
}

function openCanvas({ code, language }) {
  canvas = { code: String(code ?? ''), language: String(language ?? '') };
  const preview = Boolean(canvasDocument(canvas.code, canvas.language));
  canvasFocus = document.activeElement;
  $('canvas').hidden = false;
  $('canvas-open').hidden = false;
  document.body.dataset.canvas = 'open';
  $('canvas-source').value = canvas.code;
  $('canvas-language').textContent = canvas.language ? canvas.language.toUpperCase() : 'Code';
  $('canvas-preview-tab').disabled = !preview;
  $('canvas-code-tab').disabled = false;
  $('canvas-note').hidden = preview;
  $('canvas-note').textContent = preview ? '' : 'Preview runs HTML, CSS and JavaScript in your browser. Other languages open here so you can edit, copy or download them.';
  $('canvas-run').hidden = !preview;
  if (preview) {
    renderCanvasPreview();
    setCanvasTab('preview');
  } else {
    $('canvas-frame').removeAttribute('srcdoc');
    setCanvasTab('code');
  }
  $('canvas-close').focus({ preventScroll: true });
}

function closeCanvas() {
  if ($('canvas').hidden) return;
  $('canvas').hidden = true;
  delete document.body.dataset.canvas;
  $('canvas-frame').removeAttribute('srcdoc');
  (canvasFocus instanceof HTMLElement ? canvasFocus : $('canvas-open')).focus({ preventScroll: true });
}

function renderMarkdown(body, text, withControls) {
  body.innerHTML = format(text);
  if (!withControls) return;
  for (const code of body.querySelectorAll('pre > code')) {
    const pre = code.parentElement;
    const language = [...code.classList].find((name) => name.startsWith('language-'))?.slice(9) || '';
    const frame = el('div', 'code-frame');
    const bar = el('div', 'code-tools');
    const actions = el('div', 'code-actions');
    const source = code.textContent;
    const control = button('', 'Copy code', '', () => copy(source, control));
    const edit = button('', 'Canvas', 'code', () => openCanvas({ code: source, language }));
    edit.setAttribute('aria-label', 'Open this code in the canvas');
    actions.append(edit, control);
    bar.append(el('span', '', language || 'Code'), actions);
    pre.replaceWith(frame);
    frame.append(bar, pre);
  }
}

function messageNode(message, last) {
  const user = message.role === 'user';
  const row = el('article', `message message-${user ? 'user' : 'assistant'}`);
  row.setAttribute('aria-label', user ? 'Your message' : 'Chorus’s reply');
  row.dataset.status = message.status ?? 'sent';
  if (user) { row.append(el('p', 'user-bubble', message.text)); return row; }
  const avatar = el('span', 'assistant-icon');
  avatar.append(icon('logo'));
  const content = el('div', 'assistant-content');
  const body = el('div', 'answer-body');
  row.append(avatar, content);
  content.append(el('p', 'assistant-name', 'Chorus'), body);
  body.hidden = !message.text;
  if (message.text) renderMarkdown(body, message.text, message.status !== 'pending');
  if (message.connector) content.append(connectorCard(message.connector));
  if (message.video) {
    const mine = current?.messages.includes(message);
    content.append(videoCard(message.video, {
      pending: message.status === 'pending',
      onRetry: mine && message.video.query ? () => findVideo(message) : undefined,
    }));
  } else if (message.status === 'complete' && message.text) {
    const linked = youtubeId(message.text);
    if (linked) content.append(videoCard({ id: linked }));
  }
  if (message.status === 'pending') {
    const waiting = el('div', 'thinking');
    const dots = el('span', 'thinking-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(el('i'), el('i'), el('i'));
    const label = el('span', '', phaseText(active));
    waiting.append(dots, label);
    waiting.hidden = !body.hidden;
    const trace = teamNode(active?.message === message ? active.steps : [], active?.message === message ? active.step : undefined);
    content.append(waiting, trace);
    if (active?.message === message) pendingNodes = { body, waiting, label, trace };
    return row;
  }
  const note = message.warning || (message.status === 'stopped' ? 'You stopped this reply.' : message.limited ? 'The model ran out of room before it finished. Ask it to continue.' : '');
  if (note) {
    const info = el('p', 'answer-note', note);
    if (message.status === 'error') info.dataset.tone = 'error';
    else if (message.warning) info.dataset.tone = 'warning';
    content.append(info);
  }
  if (message.team?.length) content.append(teamNode(message.team));
  const actions = el('div', 'message-actions');
  if (message.text) {
    const control = button('message-action', 'Copy', 'copy', () => copy(message.text, control));
    control.setAttribute('aria-label', 'Copy reply');
    actions.append(control);
  }
  if (last && message.engine === engine) {
    const retry = button('message-action', 'Try again', 'retry', () => tryReply('retry'));
    retry.dataset.retry = '';
    retry.disabled = blocked();
    actions.append(retry);
  }
  if (message.model) {
    const source = el('span', 'message-meta', message.model);
    source.title = `${message.engine === 'community' ? 'Community model' : 'Local model'}: ${message.model}`;
    actions.append(source);
  }
  if (actions.childNodes.length) content.append(actions);
  return row;
}

function paintThread(follow = false) {
  pendingNodes = undefined;
  thread.replaceChildren(...(current ? [el('h1', 'sr-only', current.title),
    ...current.messages.map((message, i, list) => messageNode(message, i === list.length - 1))] : []));
  if (follow) scrollToEnd();
  else syncScroll();
}

function refreshStream(job) {
  if (active !== job || current !== job.chat || streamFrame) return;
  streamFrame = requestAnimationFrame(() => {
    streamFrame = 0;
    if (active !== job || current !== job.chat || !pendingNodes) return;
    const follow = nearEnd();
    const { body, waiting, label, trace } = pendingNodes;
    label.textContent = phaseText(job);
    const text = job.message.text;
    body.hidden = !text;
    waiting.hidden = Boolean(text);
    if (trace) {
      const parts = teamParts(job.steps ?? [], job.step);
      trace.replaceChildren(...parts);
      trace.hidden = !parts.length;
    }
    if (text) renderMarkdown(body, text, false);
    if (follow) scrollToEnd();
    else syncScroll();
  });
}

function paintView(follow = false) {
  const writingInChat = Boolean(current);
  if (writingInChat) $('main').dataset.thread = '';
  else delete $('main').dataset.thread;
  $('welcome').hidden = writingInChat;
  thread.hidden = !writingInChat;
  $('chat-dock').hidden = !writingInChat;
  const mount = $(writingInChat ? 'chat-dock' : 'welcome-composer');
  if ($('composer').parentElement !== mount) mount.append($('composer'));
  $('chat-title').textContent = current?.title ?? 'New conversation';
  $('chat-title').title = current?.title ?? '';
  $('chat-options').hidden = !writingInChat;
  $('chat-options').disabled = Boolean(active && active.chat === current);
  prompt.placeholder = writingInChat ? 'Ask a follow-up…' : 'Ask Chorus anything…';
  paintThread(follow);
  sizePrompt();
  paintComposer();
}

function urlForChat(chat) {
  const next = chat ? `#chat/${encodeURIComponent(chat.id)}` : '';
  if (location.hash === next) return;
  try { window.history.pushState(null, '', `${location.pathname}${location.search}${next}`); } catch { /* embedded history can be restricted */ }
}

function openChat(chat, { fromUrl = false, focus = true } = {}) {
  if (current !== chat) {
    const key = current?.id ?? '';
    if (prompt.value) drafts.set(key, prompt.value);
    else drafts.delete(key);
    current = chat;
    prompt.value = drafts.get(current?.id ?? '') ?? '';
  }
  if (!fromUrl) urlForChat(chat);
  if (mobileSidebar) setSidebar(false);
  paintView(Boolean(current));
  if (!current) scroll.scrollTop = 0;
  paintHistory();
  if (focus) {
    if (mobile.matches) $('main').focus({ preventScroll: true });
    else prompt.focus({ preventScroll: true });
  }
}

function chatFromUrl() {
  const prefix = '#chat/';
  if (!location.hash.startsWith(prefix)) return undefined;
  try { return chats.find(({ id }) => id === decodeURIComponent(location.hash.slice(prefix.length))); }
  catch { return undefined; }
}

function startNewChat() {
  drafts.delete('');
  if (!current) prompt.value = '';
  openChat(undefined);
}

function tryReply(action) {
  if (blocked() || $('consent-dialog').open) return;
  const retry = action === 'retry';
  let text;
  if (retry) {
    if (current?.messages.at(-1)?.engine !== engine) return;
  } else {
    try { text = cleanPrompt(prompt.value); } catch { return; }
  }
  // Playing a video needs no model, so it happens immediately.
  if (!retry) {
    const play = playRequest(text);
    if (play) { startPlay(text, play); return; }
  }
  if (engine === 'community' && !communityAllowed) {
    consentAction = action;
    $('consent-dialog').showModal();
    return;
  }
  // A named connector is answered from the service itself, then explained.
  if (!retry) {
    const request = parseConnectorRequest(text);
    if (request) { startConnector(text, request); return; }
  }
  let reply;
  const deep = engine === 'community' && deeper;
  if (retry) {
    reply = current.messages.at(-1);
    Object.assign(reply, { deep, status: 'pending', text: '', model: undefined, warning: undefined, limited: undefined, team: undefined });
  } else {
    drafts.delete(current?.id ?? '');
    if (!current) {
      // Keep the browser history bounded even if storage is disabled.
      current = createChat(text);
      chats = [current, ...orderedChats(chats).slice(0, 31)];
      urlForChat(current);
    }
    reply = newTurn(current, text, engine, deep);
    prompt.value = '';
  }
  generate(current, reply);
}

async function startConnector(text, request) {
  connectorRun = true;
  try {
    await runConnectorTurn(text, request);
  } finally {
    connectorRun = false;
    paintComposer();
  }
}

async function runConnectorTurn(text, request) {
  drafts.delete(current?.id ?? '');
  if (!current) {
    current = createChat(text);
    chats = [current, ...orderedChats(chats).slice(0, 31)];
    urlForChat(current);
  }
  const reply = newTurn(current, text, engine, engine === 'community' && deeper);
  const question = current.messages.at(-2);
  prompt.value = '';
  sizePrompt();
  paintComposer();
  reply.status = 'pending';
  current.updatedAt = Date.now();
  save();
  paintView(true);
  paintHistory();
  $('announcer').textContent = 'Reading from the connector.';
  let result;
  try {
    result = await runConnector(request, connectors);
  } catch (error) {
    reply.connector = { service: request.service, error: String(error?.message ?? error).slice(0, 300) };
    reply.status = 'complete';
    save();
    paintView(true);
    paintHistory();
    $('announcer').textContent = 'The connector needs attention.';
    return;
  }
  reply.connector = result;
  // A write is reported by the card itself: a model retelling it could claim more.
  question.context = result.changed ? '' : summarise(result);
  save();
  paintView(true);
  paintHistory();
  if (!question.context) {
    // Nothing came back, so there is nothing for a model to talk about.
    reply.status = 'complete';
    save();
    paintView(true);
    return;
  }
  await generate(current, reply);
}

async function startPlay(text, play) {
  drafts.delete(current?.id ?? '');
  if (!current) {
    current = createChat(text);
    chats = [current, ...orderedChats(chats).slice(0, 31)];
    urlForChat(current);
  }
  const reply = newTurn(current, text, engine);
  prompt.value = '';
  sizePrompt();
  paintComposer();
  Object.assign(reply, { status: 'complete', video: play.id ? { id: play.id } : { query: play.query } });
  current.updatedAt = Date.now();
  save();
  paintView(true);
  paintHistory();
  if (!play.id) await findVideo(reply);
  $('announcer').textContent = play.id ? 'Playing the video.' : 'Finding the video.';
}

// No key needed: public front-ends answer the search when they can, and the
// card offers another attempt when none of them do.
async function findVideo(reply) {
  reply.status = 'pending';
  paintView(true);
  const found = await searchVideo(reply.video?.query).catch(() => undefined);
  if (found) {
    reply.video = found;
    delete reply.warning;
  }
  reply.status = 'complete';
  save();
  paintView(true);
  paintHistory();
}

async function generate(chat, message) {
  statusController?.abort();
  const controller = new AbortController();
  const job = { chat, message, controller, steps: [] };
  active = job;
  const onPhase = (phase, queue) => { job.phase = phase; job.queue = queue; refreshStream(job); };
  const runtime = message.engine === 'community' ? communityEngine({ onPhase, onLimit: showCooldown, onModels(list) {
    models = list;
    networkError = '';
    if ($('settings-dialog').open) paintSettings();
  } }) : browserEngine(localFile, onPhase);
  chat.updatedAt = Date.now();
  save();
  paintView(true);
  paintHistory();
  paintSettings();
  if (!mobile.matches) prompt.focus({ preventScroll: true });
  $('announcer').textContent = 'Chorus is preparing a reply.';
  try {
    // The on-device model answers alone: one local model per reply, no team.
    const answer = await answerChat({ messages: conversationContext(chat, message.engine), generate: runtime.generate,
      signal: controller.signal, deep: message.deep, mode: message.engine === 'local' ? 'solo' : undefined,
      decide: message.engine === 'community',
      onText(text) { message.text = text; refreshStream(job); },
      onStep(step) {
        job.step = step;
        if (step.state === 'done') job.steps.push(step);
        if (step.state === 'done' && step.role === 'draft' && job.steps.length === 1) {
          $('announcer').textContent = 'Another model is checking the draft.';
        }
        refreshStream(job);
      } });
    controller.signal.throwIfAborted();
    Object.assign(message, answer, { status: 'complete', warning: answer.warning?.slice(0, 600) });
    $('announcer').textContent = 'Reply ready.';
  } catch (error) {
    if (controller.signal.aborted) {
      message.status = 'stopped';
      message.text = message.text.trim();
      $('announcer').textContent = 'Reply stopped.';
    } else {
      // Provider stream errors can invalidate a partly delivered answer.
      message.status = 'error';
      message.text = '';
      message.warning = (error instanceof Error ? error.message : 'Could not complete the reply. Try again.').slice(0, 600);
      $('announcer').textContent = 'Could not complete the reply.';
    }
  } finally {
    runtime.dispose?.();
    if (streamFrame) cancelAnimationFrame(streamFrame);
    streamFrame = 0;
    const hadFocus = document.activeElement === $('stop-button');
    active = undefined;
    save();
    paintView(current === chat && nearEnd());
    paintHistory();
    paintSettings();
    if (hadFocus) prompt.focus({ preventScroll: true });
  }
}

function openSearch() {
  if ($('search-dialog').open) return;
  $('search-input').value = '';
  paintSearch();
  $('search-dialog').showModal();
  $('search-input').focus();
}

function confirmRemove(target) {
  removeTarget = target;
  const all = target === 'all';
  $('remove-title').textContent = all ? 'Clear all chats?' : 'Delete chat?';
  $('remove-description').textContent = all ? 'This permanently removes all chats saved in this browser.' : 'This permanently removes this chat from this browser.';
  $('confirm-remove').textContent = all ? 'Clear chats' : 'Delete chat';
  $('remove-dialog').showModal();
}

$('brand').addEventListener('click', startNewChat);
$('new-chat').addEventListener('click', startNewChat);
$('open-search').addEventListener('click', openSearch);
$('search-input').addEventListener('input', paintSearch);
$('search-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) $('search-results').querySelector('button')?.click();
});
$('sidebar-toggle').addEventListener('click', () => setSidebar(!(mobile.matches ? mobileSidebar : desktopSidebar), true));
for (const id of ['sidebar-backdrop', 'close-sidebar']) $(id).addEventListener('click', () => setSidebar(false, true));
mobile.addEventListener('change', () => { mobileSidebar = false; paintSidebar(); sizePrompt(); });
window.addEventListener('hashchange', () => openChat(chatFromUrl(), { fromUrl: true, focus: false }));
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  if (event.key === 'Escape' && !$('canvas').hidden && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    closeCanvas();
    return;
  }
  if (event.key === 'Escape' && mobileSidebar && !document.querySelector('dialog[open]')) setSidebar(false, true);
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    openSearch();
  }
});
if (/Mac|iPhone|iPad/.test(navigator.platform)) $('search-shortcut').textContent = '⌘ K';

for (const control of document.querySelectorAll('[data-settings]')) control.addEventListener('click', () => {
  paintSettings();
  $('settings-dialog').showModal();
});
for (const control of document.querySelectorAll('[data-close]')) control.addEventListener('click', () => control.closest('dialog').close());
$('open-privacy').addEventListener('click', () => $('privacy-dialog').showModal());
for (const control of document.querySelectorAll('[data-prompt]')) control.addEventListener('click', () => {
  prompt.value = templates[control.dataset.prompt];
  sizePrompt();
  paintComposer();
  prompt.focus();
});
$('deep-button').addEventListener('click', () => { deeper = !deeper; paintComposer(); });
$('canvas-close').addEventListener('click', closeCanvas);
$('canvas-open').addEventListener('click', () => {
  if (!$('canvas').hidden) { closeCanvas(); return; }
  if (!canvas.code) return;
  canvasFocus = document.activeElement;
  $('canvas').hidden = false;
  document.body.dataset.canvas = 'open';
  setCanvasTab($('canvas-preview-tab').disabled ? 'code' : 'preview');
  $('canvas-close').focus({ preventScroll: true });
});
$('canvas-preview-tab').addEventListener('click', () => { setCanvasTab('preview'); renderCanvasPreview(); });
$('canvas-code-tab').addEventListener('click', () => setCanvasTab('code'));
$('canvas-run').addEventListener('click', renderCanvasPreview);
$('canvas-copy').addEventListener('click', () => copy($('canvas-source').value, $('canvas-copy')));
$('canvas-download').addEventListener('click', () => {
  const extension = canvasName[String(canvas.language || '').toLowerCase()] || 'txt';
  const blob = new Blob([$('canvas-source').value], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `chorus-canvas.${extension}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast('Canvas downloaded');
});
$('canvas-source').addEventListener('input', () => {
  clearTimeout(canvasTimer);
  if ($('canvas-preview').hidden) return;
  canvasTimer = setTimeout(renderCanvasPreview, 350);
});
prompt.addEventListener('input', () => { sizePrompt(); paintComposer(); });
prompt.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  tryReply('new');
});
$('send-button').addEventListener('click', () => tryReply('new'));
$('stop-button').addEventListener('click', () => active?.controller.abort());
$('open-busy').addEventListener('click', () => { if (active) openChat(active.chat); });
$('accept-community').addEventListener('click', () => {
  communityAllowed = true;
  $('consent-dialog').close();
  tryReply(consentAction);
});
$('reset-permission').addEventListener('click', () => {
  communityAllowed = false;
  paintSettings();
  $('check-network').focus();
  toast('Chorus will ask next time you send a community message.');
});
function connectorValues(service) {
  const values = { ...(connectors[service.id] ?? {}) };
  for (const field of [...service.fields, ...(service.oauth?.fields ?? [])]) {
    const secret = field.key === 'token' || field.key === 'key';
    const value = document.getElementById(`connector-${service.id}-${field.key}`)?.value.trim().slice(0, 400) ?? '';
    if (value) values[field.key] = value;
    // An empty secret field means "keep the saved key"; Remove is how it goes.
    else if (!secret) delete values[field.key];
  }
  for (const flag of service.flags ?? []) {
    const box = document.getElementById(`connector-${service.id}-${flag.key}`);
    if (box) values[flag.key] = box.checked;
  }
  return values;
}

async function verifyGithub() {
  const token = connectors.github?.token;
  if (!token) return;
  const who = await githubIdentity(token).catch(() => undefined);
  if (!who) {
    toast('GitHub did not accept that token.');
    return;
  }
  if (connectors.github.login === who.login && connectors.github.avatar === who.avatar) return;
  connectors = { ...connectors, github: { ...connectors.github, login: who.login, ...(who.avatar ? { avatar: who.avatar } : {}) } };
  writeConnectors(storage, connectors);
  paintConnectors();
}

$('forget-connectors').addEventListener('click', () => {
  connectors = Object.fromEntries(SERVICES.map(({ id }) => [id, {}]));
  writeConnectors(storage, connectors);
  paintConnectors();
  toast('Every connector key was removed from this browser.');
});

$('connector-list').addEventListener('click', async (event) => {
  const test = event.target.closest('[data-connector-test]');
  if (test) {
    const service = SERVICES.find(({ id }) => id === test.dataset.connectorTest);
    if (!service) return;
    const probe = { ...connectors, [service.id]: connectorValues(service) };
    test.disabled = true;
    toast(`Checking ${service.label}…`);
    try {
      toast(await testConnector(service.id, probe));
    } catch (error) {
      toast(String(error?.message ?? error).slice(0, 170));
    } finally {
      test.disabled = false;
    }
    return;
  }
  if (event.target.closest('[data-oauth-help]')) {
    $('github-setup').showModal();
    return;
  }
  const start = event.target.closest('[data-oauth-start]');
  if (start) {
    const service = SERVICES.find(({ id }) => id === start.dataset.oauthStart);
    const saved = connectorValues(service);
    connectors = { ...connectors, [service.id]: saved };
    writeConnectors(storage, connectors);
    paintConnectors();
    if (!saved.clientId || !saved.relay) {
      toast('Add the OAuth client ID and relay URL first.');
      return;
    }
    const state = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
    try { sessionStorage.setItem(OAUTH_STATE_KEY, state); } catch { /* storage can be denied */ }
    location.assign(authorizeUrl({ clientId: saved.clientId, redirectUri: `${location.origin}${location.pathname}`, state }));
    return;
  }
  const save = event.target.closest('[data-connector-save]');
  const clear = event.target.closest('[data-connector-clear]');
  if (!save && !clear) return;
  const service = SERVICES.find(({ id }) => id === (save ?? clear).dataset.connectorSave
    || id === (save ?? clear).dataset.connectorClear);
  if (!service) return;
  if (clear) {
    connectors = { ...connectors, [service.id]: {} };
    writeConnectors(storage, connectors);
    paintConnectors();
    toast(`${service.label} disconnected`);
    return;
  }
  const next = connectorValues(service);
  const replaced = service.fields.some(({ key }) => Boolean(next[key])) && next[key] !== connectors[service.id]?.[key];
  if (replaced) delete next.login, next.avatar;
  connectors = { ...connectors, [service.id]: next };
  toast(writeConnectors(storage, connectors)
    ? `${service.label} saved in this browser`
    : 'This browser would not let Chorus save the key.');
  paintConnectors();
  if (service.id === 'github') void verifyGithub();
});

$('scroll-latest').addEventListener('click', () => { scrollToEnd(); prompt.focus({ preventScroll: true }); });
scroll.addEventListener('scroll', syncScroll, { passive: true });

for (const option of engineOptions) option.addEventListener('change', () => {
  if (active || validatingFile) return;
  engine = option.value;
  if (engine === 'local') statusController?.abort();
  paintConnection();
  paintThread();
});
$('check-network').addEventListener('click', async () => {
  if (active || statusController || retryAt > Date.now()) return;
  const check = new AbortController();
  statusController = check;
  networkError = '';
  paintSettings();
  try { models = await getOnlineModels({ signal: check.signal }); }
  catch (error) {
    if (!check.signal.aborted) {
      networkError = error.message;
      if (error.retryAfter) showCooldown(error.retryAfter);
    }
  } finally {
    statusController = undefined;
    paintSettings();
  }
});
$('model-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || active || validatingFile) return;
  validatingFile = true;
  paintComposer();
  $('model-error').hidden = true;
  paintSettings();
  try { await validateModel(file); localFile = file; }
  catch (error) {
    $('model-error').textContent = error.message;
    $('model-error').hidden = false;
  } finally {
    validatingFile = false;
    paintConnection();
  }
});
$('clear-model').addEventListener('click', () => {
  localFile = undefined;
  $('model-error').hidden = true;
  paintConnection();
  $('model-file').focus();
});

$('chat-options').addEventListener('click', () => {
  if (!current || active?.chat === current) return;
  $('rename-input').value = current.title;
  $('options-dialog').showModal();
  $('rename-input').select();
});
$('save-title').addEventListener('click', () => {
  const title = $('rename-input').value.trim();
  if (!current || !title) { $('rename-input').focus(); return; }
  current.title = title;
  save();
  paintView();
  paintHistory();
  $('options-dialog').close();
});
$('rename-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) $('save-title').click();
});
$('delete-chat').addEventListener('click', () => { if (current && active?.chat !== current) confirmRemove(current); });
$('clear-chats').addEventListener('click', () => { if (!active && chats.length) confirmRemove('all'); });
$('confirm-remove').addEventListener('click', () => {
  const all = removeTarget === 'all';
  if (!removeTarget || (all ? active : active?.chat === removeTarget)) return;
  $('remove-dialog').close();
  if (all) {
    $('settings-dialog').close();
    chats = [];
    drafts.clear();
    prompt.value = '';
  } else {
    $('options-dialog').close();
    chats = chats.filter((chat) => chat !== removeTarget);
    drafts.delete(removeTarget.id);
    prompt.value = '';
  }
  removeTarget = undefined;
  save();
  openChat(undefined);
  paintSettings();
  toast(all ? 'Chat history cleared' : 'Chat deleted');
});

paintSidebar();
openChat(chatFromUrl(), { fromUrl: true, focus: false });
paintConnection();
paintConnectors();
void finishGithubSignIn();
