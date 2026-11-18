import MarkdownIt from './vendor/markdown-it.mjs';
import { createFormatter } from './format.mjs';
import { answerChat, cleanPrompt, conversationContext, createChat, newTurn, orderedChats, readChats, saveChats } from './chat.mjs';
import { communityEngine, getOnlineModels } from './community.mjs';
import { browserEngine, validateModel } from './engine.mjs';

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
  const li = el('li');
  li.append(node);
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
const blocked = () => Boolean(active || validatingFile || cooling() || unavailable());

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
  $('composer-note').textContent = busyElsewhere ? 'Frenemy is replying in another chat.'
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

function nearEnd() { return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 110; }
function scrollToEnd() { scroll.scrollTop = scroll.scrollHeight; $('scroll-latest').hidden = true; }
function syncScroll() { $('scroll-latest').hidden = !current || nearEnd(); }

function phaseText(job) {
  if (job?.message.deep) return 'Thinking it through…';
  switch (job?.phase) {
    case 'finding': return 'Finding an online model…';
    case 'waiting': {
      const position = job.queue?.position;
      // The ETA is a provider estimate, not a promise; only show it while queued.
      const seconds = position && job.queue?.seconds;
      const eta = seconds && (seconds < 60 ? `about ${seconds}s` : `about ${Math.ceil(seconds / 60)} min`);
      return position ? `In the community queue${eta ? ` · ${eta}` : ''}` : 'Waiting for a community model…';
    }
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

function renderMarkdown(body, text, withControls) {
  body.innerHTML = format(text);
  if (!withControls) return;
  for (const code of body.querySelectorAll('pre > code')) {
    const pre = code.parentElement;
    const language = [...code.classList].find((name) => name.startsWith('language-'))?.slice(9) || 'Code';
    const frame = el('div', 'code-frame');
    const bar = el('div', 'code-tools');
    const control = button('', 'Copy code', '', () => copy(code.textContent, control));
    bar.append(el('span', '', language), control);
    pre.replaceWith(frame);
    frame.append(bar, pre);
  }
}

function messageNode(message, last) {
  const user = message.role === 'user';
  const row = el('article', `message message-${user ? 'user' : 'assistant'}`);
  row.setAttribute('aria-label', user ? 'Your message' : 'Frenemy’s reply');
  row.dataset.status = message.status ?? 'sent';
  if (user) { row.append(el('p', 'user-bubble', message.text)); return row; }
  const avatar = el('span', 'assistant-icon');
  avatar.append(icon('logo'));
  const content = el('div', 'assistant-content');
  const body = el('div', 'answer-body');
  row.append(avatar, content);
  content.append(el('p', 'assistant-name', 'Frenemy'), body);
  body.hidden = !message.text;
  if (message.text) renderMarkdown(body, message.text, message.status !== 'pending');
  if (message.status === 'pending') {
    const waiting = el('div', 'thinking');
    const dots = el('span', 'thinking-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(el('i'), el('i'), el('i'));
    const label = el('span', '', phaseText(active));
    waiting.append(dots, label);
    waiting.hidden = !body.hidden;
    content.append(waiting);
    if (active?.message === message) pendingNodes = { body, waiting, label };
    return row;
  }
  const note = message.warning || (message.status === 'stopped' ? 'You stopped this reply.' : message.limited ? 'This reply reached the model’s output limit.' : '');
  if (note) {
    const info = el('p', 'answer-note', note);
    if (message.status === 'error') info.dataset.tone = 'error';
    else if (message.warning) info.dataset.tone = 'warning';
    content.append(info);
  }
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
    const { body, waiting, label } = pendingNodes;
    label.textContent = phaseText(job);
    const text = job.message.text;
    body.hidden = !text;
    waiting.hidden = Boolean(text);
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
  prompt.placeholder = writingInChat ? 'Ask a follow-up…' : 'Ask Frenemy anything…';
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
  if (engine === 'community' && !communityAllowed) {
    consentAction = action;
    $('consent-dialog').showModal();
    return;
  }
  let reply;
  const deep = engine === 'community' && deeper;
  if (retry) {
    reply = current.messages.at(-1);
    Object.assign(reply, { deep, status: 'pending', text: '', model: undefined, warning: undefined, limited: undefined });
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

async function generate(chat, message) {
  statusController?.abort();
  const controller = new AbortController();
  const job = { chat, message, controller };
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
  $('announcer').textContent = 'Frenemy is preparing a reply.';
  try {
    const answer = await answerChat({ messages: conversationContext(chat, message.engine), generate: runtime.generate,
      signal: controller.signal, deep: message.deep, onText(text) { message.text = text; refreshStream(job); } });
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
  toast('Frenemy will ask next time you send a community message.');
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
