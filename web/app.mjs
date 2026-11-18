import { browserEngine, validateModel } from './engine.mjs';
import {
  HISTORY_KEY, MODE_LABELS, PLANS, PROMPT_LIMIT, STATE_LABELS,
  addToHistory, createRun, executeRelay, readHistory, resultStep, saveHistory,
} from './relay.mjs';

const $ = (id) => document.getElementById(id);
const form = $('relay-form');
const prompt = $('prompt');
const modelForm = $('models-form');
const modelRoles = ['driver', 'reviewer'];
const views = {
  workspace: { name: 'Relay desk', focus: 'main' },
  history: { name: 'Run history', focus: 'history-title' },
  settings: { name: 'Settings', focus: 'settings-title' },
};
const modes = [...form.querySelectorAll('input[name="mode"]')];
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const mode = () => modes.find((radio) => radio.checked).value;
const modelName = (file) => (file.name.replace(/\.gguf$/i, '') || file.name).slice(0, 300);

let storage;
try { storage = window.localStorage; } catch { /* opaque or blocked browser context */ }
let history = readHistory(storage);
let files = { driver: null, reviewer: null };
let pendingFiles = { ...files };
let verifyingFiles = false;
let currentView = 'workspace';
let visibleRun;
let selection;
let controller;
let livePhase;
let toastTimer;
let jumpToResult = false;
let runSequence = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function announce(text) { $('announcer').textContent = text; }
function toast(text) {
  announce(text);
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
}

function setPromptError(message = '') {
  $('prompt-message').textContent = message;
  $('prompt-message').hidden = !message;
  if (message) prompt.setAttribute('aria-invalid', 'true');
  else prompt.removeAttribute('aria-invalid');
}

function modelError(message = '', role) {
  $('model-error').textContent = message;
  $('model-error').hidden = !message;
  for (const name of modelRoles) {
    const input = $(`${name}-file`);
    if (name === role && message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function paintPrompt() {
  setPromptError();
  $('prompt-count').textContent = `${prompt.value.length.toLocaleString('en-US')} / ${PROMPT_LIMIT.toLocaleString('en-US')}`;
}

function setBusy(active) {
  prompt.readOnly = active;
  for (const radio of modes) radio.disabled = active;
  $('run-button').disabled = active || !files.driver;
  $('run-button').querySelector('use').setAttribute('href', active ? '#i-wave' : '#i-play');
  $('run-label').textContent = active ? 'Running…' : 'Run relay';
  $('stop-button').hidden = !active;
  paintSettings();
}

function paintModels() {
  const ready = Boolean(files.driver);
  const driver = ready ? modelName(files.driver) : 'Not set';
  const reviewer = files.reviewer ? modelName(files.reviewer) : ready ? 'Same as driver' : 'Not set';
  $('driver-name').textContent = $('driver-name').title = driver;
  $('reviewer-name').textContent = $('reviewer-name').title = reviewer;
  $('setup-button').hidden = ready;
  $('configure-models').hidden = !ready;
  $('run-button').hidden = !ready;
  $('run-hotkey').hidden = !ready;
  $('note-title').textContent = ready ? 'Models run on your device' : 'No models loaded';
  $('note-body').textContent = ready
    ? 'Relays use your CPU. Keep this tab open while a model is working.'
    : 'Choose a GGUF model in Settings to run a relay. One file can play both roles.';
  $('note-action').hidden = ready;
  setBusy(Boolean(controller));
}

function activeTimeline() {
  const plan = PLANS[visibleRun?.mode ?? mode()];
  return plan.map((stage, i) => {
    const state = visibleRun?.steps[i].state ?? 'waiting';
    let detail = stage.detail;
    if (state === 'running') {
      const name = visibleRun.names[stage.role];
      detail = livePhase?.key === stage.key && livePhase.phase === 'generating' ? `${name} is writing…` : `Loading ${name}…`;
    } else if (state === 'done') detail = visibleRun.names[stage.role];
    else if (state === 'failed' || state === 'stopped') detail = STATE_LABELS[state];
    else if (visibleRun?.state === 'failed' || visibleRun?.state === 'stopped') detail = 'Not run';
    return { ...stage, state, detail };
  });
}

function paintTimeline() {
  const state = visibleRun?.state ?? 'idle';
  $('run-state').dataset.state = state;
  $('run-state-text').textContent = STATE_LABELS[state];
  const segments = [];
  const rows = activeTimeline().map((stage, i) => {
    const segment = element('span', 'progress-segment');
    segment.dataset.state = stage.state;
    segments.push(segment);
    const row = element('li', 'step');
    row.dataset.state = stage.state;
    const index = element('span', 'step-index', stage.state === 'done' ? '✓' : String(i + 1).padStart(2, '0'));
    index.setAttribute('aria-hidden', 'true');
    const info = element('div');
    info.append(element('strong', 'step-name', stage.label), element('span', 'step-meta', stage.detail));
    row.append(index, info);
    if (stage.state === 'done') info.append(element('span', 'sr-only', 'Completed'));
    if (stage.state === 'running') row.setAttribute('aria-current', 'step');
    return row;
  });
  $('progress').replaceChildren(...segments);
  $('steps').replaceChildren(...rows);
}

function paintResult() {
  const run = visibleRun;
  $('result').hidden = !run;
  if (!run) return;
  const shown = resultStep(run, selection);
  $('result-description').textContent = `${MODE_LABELS[run.mode]} · ${STATE_LABELS[run.state]}`;
  const selectedStep = run.steps.find((step) => step.key === shown);
  const tabs = $('result-tabs');
  const focusedKey = tabs.contains(document.activeElement) && document.activeElement.dataset.key;
  const options = PLANS[run.mode].map((stage) => {
    const active = stage.key === shown;
    const button = element('button', 'tab', stage.tab);
    button.type = 'button';
    button.id = `tab-${stage.key}`;
    button.dataset.key = stage.key;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(active));
    button.setAttribute('aria-controls', 'result-panel');
    button.tabIndex = active ? 0 : -1;
    return button;
  });
  tabs.replaceChildren(...options);
  if (focusedKey) options.find((tab) => tab.dataset.key === focusedKey)?.focus({ preventScroll: true });
  const panel = $('result-panel');
  panel.setAttribute('aria-labelledby', `tab-${shown}`);
  panel.dataset.empty = String(!selectedStep.text);
  panel.textContent = selectedStep.text || ({
    running: 'Working on this stage…',
    waiting: run.state === 'running' ? 'This stage hasn’t started.' : 'This stage did not run.',
    failed: 'This stage did not return a response.',
    stopped: 'This stage was stopped.',
  }[selectedStep.state] ?? 'No response.');
  $('copy-result').disabled = !selectedStep.text;
  $('result-error').hidden = !run.error;
  $('result-error').textContent = run.error;
}

function paintRun() { paintTimeline(); paintResult(); }

function paintHistory() {
  $('history-empty').hidden = Boolean(history.length);
  $('clear-history').hidden = !history.length;
  $('clear-history').disabled = Boolean(controller);
  $('history-list').replaceChildren(...history.map((run) => {
    const row = element('li', 'panel history-item');
    const content = element('div');
    const badge = element('span', 'run-state', STATE_LABELS[run.state]);
    badge.dataset.state = run.state;
    const message = element('p', 'history-prompt', run.prompt);
    message.title = run.prompt;
    const meta = element('p', 'history-meta', `${MODE_LABELS[run.mode]} · ${dateFormat.format(run.createdAt)}`);
    content.append(badge, message, meta);
    const open = element('button', 'button border-button history-open', 'Open run');
    open.type = 'button';
    open.disabled = Boolean(controller);
    open.addEventListener('click', () => {
      visibleRun = run;
      selection = undefined;
      for (const radio of modes) radio.checked = radio.value === run.mode;
      prompt.value = run.prompt;
      paintPrompt();
      paintRun();
      jumpToResult = true;
      location.hash = 'workspace';
    });
    row.append(content, open);
    return row;
  }));
}

function route(moveFocus = false) {
  const requested = location.hash.slice(1);
  currentView = Object.hasOwn(views, requested) ? requested : 'workspace';
  for (const name of Object.keys(views)) $(`view-${name}`).hidden = currentView !== name;
  $('breadcrumb').textContent = views[currentView].name;
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === currentView) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (currentView === 'history') paintHistory();
  if (currentView === 'workspace' && jumpToResult) {
    jumpToResult = false;
    $('result-title').focus({ preventScroll: true });
    $('result').scrollIntoView({ block: 'nearest' });
  } else if (moveFocus) {
    window.scrollTo(0, 0);
    $(views[currentView].focus).focus({ preventScroll: true });
  }
}

function paintSettings() {
  const locked = Boolean(controller) || verifyingFiles;
  for (const role of modelRoles) {
    const file = pendingFiles[role];
    const label = $(`${role}-file-name`);
    label.textContent = file ? file.name : role === 'driver' ? 'No file selected' : 'Uses the driver if left empty';
    label.title = file?.name ?? '';
    $(`${role}-file`).disabled = locked;
  }
  $('reuse-driver').hidden = !pendingFiles.reviewer;
  $('clear-models').hidden = !files.driver && !pendingFiles.driver && !pendingFiles.reviewer;
  for (const id of ['reuse-driver', 'clear-models', 'apply-models']) $(id).disabled = locked;
  $('apply-label').textContent = verifyingFiles ? 'Checking files…' : 'Use models';
  $('settings-busy').hidden = !controller;
}

for (const button of document.querySelectorAll('[data-guide]')) button.addEventListener('click', () => $('guide-dialog').showModal());
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const role of modelRoles) {
  $(`${role}-file`).addEventListener('change', (event) => {
    const input = event.target;
    if (!input.files[0]) return;
    pendingFiles[role] = input.files[0];
    input.value = '';
    modelError();
    paintSettings();
  });
}
$('reuse-driver').addEventListener('click', () => {
  pendingFiles.reviewer = null;
  paintSettings();
  $('reviewer-file').focus();
  modelError();
});
$('clear-models').addEventListener('click', () => {
  files = { driver: null, reviewer: null };
  pendingFiles = { ...files };
  modelError();
  paintModels();
  $('driver-file').focus();
  toast('Model selections cleared. Downloaded files were not deleted.');
});
modelForm.addEventListener('submit', (event) => event.preventDefault());
$('apply-models').addEventListener('click', async () => {
  if (controller || verifyingFiles) return;
  const chosen = { ...pendingFiles };
  verifyingFiles = true;
  modelError();
  paintSettings();
  let role = 'driver';
  let invalid;
  try {
    await validateModel(chosen.driver);
    if (chosen.reviewer) {
      role = 'reviewer';
      await validateModel(chosen.reviewer);
    }
    if (currentView !== 'settings') return;
    files = chosen;
    paintModels();
    location.hash = 'workspace';
    toast('Models are ready for this tab.');
  } catch (error) {
    if (currentView === 'settings') {
      invalid = role;
      const message = error instanceof Error ? error.message : 'Could not read that file.';
      modelError(`${role === 'driver' ? 'Driver' : 'Reviewer'} model: ${message}`, role);
    }
  } finally {
    verifyingFiles = false;
    paintSettings();
    if (invalid) $(`${invalid}-file`).focus();
  }
});

// No native form submission: the same actions work in iframe previews without allow-forms.
form.addEventListener('submit', (event) => event.preventDefault());
$('run-button').addEventListener('click', runRelay);
async function runRelay() {
  if (controller || currentView !== 'workspace') return;
  if (!files.driver) {
    location.hash = 'settings';
    return;
  }
  let run;
  try {
    // A timestamp and tab-local sequence also work in non-secure preview contexts.
    run = createRun({
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++runSequence}`,
      prompt: prompt.value, mode: mode(),
      names: { driver: modelName(files.driver), reviewer: modelName(files.reviewer ?? files.driver) },
    });
  } catch (error) {
    setPromptError(error.message);
    prompt.focus();
    return;
  }
  controller = new AbortController();
  visibleRun = run;
  livePhase = selection = undefined;
  const runtime = browserEngine(files, (key, phase) => { livePhase = { key, phase }; paintTimeline(); });
  const buttonHadFocus = document.activeElement === $('run-button');
  setBusy(true);
  if (buttonHadFocus) $('stop-button').focus({ preventScroll: true });
  paintHistory();
  announce('Local relay started.');
  try {
    await executeRelay(run, {
      generate: runtime.generate,
      signal: controller.signal,
      onUpdate: paintRun,
    });
    history = addToHistory(history, run);
    const saved = saveHistory(storage, history);
    announce(`Relay ${STATE_LABELS[run.state].toLowerCase()}. See relay output.`);
    if (!saved) toast('Browser storage is unavailable. History will only last in this tab.');
  } finally {
    runtime.dispose();
    controller = undefined;
    const restoreFocus = document.activeElement === $('stop-button');
    setBusy(false);
    if (restoreFocus) $('run-button').focus({ preventScroll: true });
    paintHistory();
    if (currentView === 'workspace' && run.state !== 'stopped') $('result').scrollIntoView({ block: 'nearest' });
  }
}

$('stop-button').addEventListener('click', () => controller?.abort());
form.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    runRelay();
  }
});
for (const radio of modes) radio.addEventListener('change', () => { visibleRun = undefined; selection = undefined; paintRun(); });
prompt.addEventListener('input', paintPrompt);

$('result-tabs').addEventListener('click', (event) => {
  if (event.target.dataset.key && visibleRun) { selection = event.target.dataset.key; paintResult(); }
});
$('result-tabs').addEventListener('keydown', (event) => {
  if (!event.target.matches('[role="tab"]') || !visibleRun) return;
  const keys = PLANS[visibleRun.mode].map((stage) => stage.key);
  const index = keys.indexOf(event.target.dataset.key);
  const next = { ArrowLeft: (index - 1 + keys.length) % keys.length, ArrowRight: (index + 1) % keys.length, Home: 0, End: keys.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  selection = keys[next];
  paintResult();
  $(`tab-${selection}`).focus({ preventScroll: true });
});
$('copy-result').addEventListener('click', async () => {
  if (!visibleRun) return;
  const key = resultStep(visibleRun, selection);
  const text = visibleRun.steps.find((step) => step.key === key)?.text;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Response copied.');
  } catch {
    const input = element('textarea', 'sr-only');
    input.value = text;
    document.body.append(input);
    input.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* not supported */ }
    input.remove();
    $('copy-result').focus({ preventScroll: true });
    toast(copied ? 'Response copied.' : 'Clipboard unavailable. Select the response to copy it manually.');
  }
});
$('clear-history').addEventListener('click', () => $('clear-dialog').showModal());
$('confirm-clear').addEventListener('click', () => {
  $('clear-dialog').close();
  history = [];
  const saved = saveHistory(storage, history);
  if (visibleRun?.prompt === prompt.value.trim()) { prompt.value = ''; paintPrompt(); }
  visibleRun = undefined;
  selection = undefined;
  paintRun();
  paintHistory();
  $('history-title').focus({ preventScroll: true });
  toast(saved ? 'Run history cleared.' : 'History cleared from this tab. Browser storage was unavailable.');
});
window.addEventListener('storage', (event) => {
  if (event.storageArea !== storage || (event.key !== HISTORY_KEY && event.key !== null)) return;
  history = readHistory(storage);
  if (currentView === 'history') paintHistory();
});
window.addEventListener('hashchange', () => {
  if (!location.hash || Object.hasOwn(views, location.hash.slice(1))) route(true);
});

if (/Mac|iPhone|iPad/.test(navigator.platform)) $('modifier').textContent = '⌘';
paintPrompt();
paintModels();
paintRun();
route();
