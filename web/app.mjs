import { EXAMPLES, demoGenerator } from './demo.mjs';
import { browserEngine, validateModel } from './engine.mjs';
import {
  HISTORY_KEY, MODE_LABELS, PLANS, PROMPT_LIMIT, STATE_LABELS,
  addToHistory, createRun, executeRelay, readHistory, resultStep, saveHistory,
} from './relay.mjs';

const $ = (id) => document.getElementById(id);
const form = $('relay-form');
const prompt = $('prompt');
const modelsDialog = $('models-dialog');
const modelButtons = document.querySelectorAll('[data-models]');
const modes = [...form.querySelectorAll('input[name="mode"]')];
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const mode = () => modes.find((radio) => radio.checked).value;
const engineName = (kind) => kind === 'local' ? 'Local AI' : 'Scripted demo';
const engine = () => files.driver ? 'local' : 'demo';
const modelName = (file) => file.name.replace(/\.gguf$/i, '').slice(0, 300);
const inHistory = () => location.hash === '#history';

let storage;
try { storage = window.localStorage; } catch { /* opaque or blocked browser context */ }
let history = readHistory(storage);
let files = { driver: null, reviewer: null };
let pendingFiles;
let setupEpoch = 0;
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

function modelError(message = '') {
  $('model-error').textContent = message;
  $('model-error').hidden = !message;
}

const exampleButtons = EXAMPLES.map((example) => {
  const button = element('button', 'example', example.label);
  button.type = 'button';
  button.addEventListener('click', () => {
    prompt.value = example.prompt;
    paintPrompt();
    prompt.focus();
  });
  $('examples').append(button);
  return button;
});

function paintPrompt() {
  setPromptError();
  $('prompt-count').textContent = `${prompt.value.length.toLocaleString('en-US')} / ${PROMPT_LIMIT.toLocaleString('en-US')}`;
  exampleButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(EXAMPLES[i].prompt === prompt.value.trim())));
}

function setBusy(active) {
  prompt.readOnly = active;
  for (const control of [...modes, ...exampleButtons, ...modelButtons]) control.disabled = active;
  $('run-button').disabled = active;
  $('run-button').querySelector('use').setAttribute('href', active ? '#i-wave' : '#i-play');
  $('run-label').textContent = active ? 'Running…' : engine() === 'local' ? 'Run relay' : 'Run demo';
  $('stop-button').hidden = !active;
}

function paintModels() {
  const local = engine() === 'local';
  const driver = local ? modelName(files.driver) : 'Demo driver';
  const reviewer = local ? (files.reviewer ? modelName(files.reviewer) : 'Same as driver') : 'Demo reviewer';
  $('driver-name').textContent = $('driver-name').title = driver;
  $('reviewer-name').textContent = $('reviewer-name').title = reviewer;
  $('note-title').textContent = local ? 'Running on your device' : 'You’re in demo mode';
  $('note-body').textContent = local
    ? 'Relays use your CPU. Keep this tab open while a model is working.'
    : 'Try a scripted relay with no setup, or load a free model for real AI responses.';
  $('note-action').firstChild.textContent = local ? 'Manage models ' : 'Use local AI ';
  setBusy(Boolean(controller));
}

function activeTimeline() {
  const plan = PLANS[visibleRun?.mode ?? mode()];
  return plan.map((stage, i) => {
    const state = visibleRun?.steps[i].state ?? 'waiting';
    let detail = stage.detail;
    if (state === 'running') {
      const name = visibleRun.names[stage.role];
      detail = visibleRun.engine === 'demo' ? 'Playing the scripted response…'
        : livePhase?.key === stage.key && livePhase.phase === 'generating' ? `${name} is writing…` : `Loading ${name}…`;
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
  $('result-description').textContent = `${MODE_LABELS[run.mode]} · ${engineName(run.engine)} · ${STATE_LABELS[run.state]}`;
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
    const meta = element('p', 'history-meta', `${MODE_LABELS[run.mode]} · ${engineName(run.engine)} · ${dateFormat.format(run.createdAt)}`);
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
  const current = inHistory() ? 'history' : 'workspace';
  $('view-workspace').hidden = current !== 'workspace';
  $('view-history').hidden = current !== 'history';
  $('breadcrumb').textContent = current === 'workspace' ? 'Relay desk' : 'Run history';
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (current === 'history') paintHistory();
  if (current === 'workspace' && jumpToResult) {
    jumpToResult = false;
    $('result-title').focus({ preventScroll: true });
    $('result').scrollIntoView({ block: 'nearest' });
  } else if (moveFocus) {
    window.scrollTo(0, 0);
    $(current === 'history' ? 'history-title' : 'main').focus({ preventScroll: true });
  }
}

function paintFileChoices() {
  for (const role of ['driver', 'reviewer']) {
    const file = pendingFiles[role];
    const label = $(`${role}-file-name`);
    label.textContent = file ? file.name : role === 'driver' ? 'No file selected' : 'Reuse driver model';
    label.title = file?.name ?? '';
  }
  $('reuse-driver').hidden = !pendingFiles.reviewer;
}

function openModels() {
  if (controller) return;
  setupEpoch += 1;
  pendingFiles = { ...files };
  $('models-form').reset();
  $('apply-models').disabled = false;
  modelError();
  paintFileChoices();
  modelsDialog.showModal();
}

for (const button of modelButtons) button.addEventListener('click', openModels);
for (const button of document.querySelectorAll('[data-guide]')) button.addEventListener('click', () => $('guide-dialog').showModal());
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const role of ['driver', 'reviewer']) {
  $(`${role}-file`).addEventListener('change', (event) => {
    if (event.target.files[0]) pendingFiles[role] = event.target.files[0];
    modelError();
    paintFileChoices();
  });
}
$('reuse-driver').addEventListener('click', () => {
  pendingFiles.reviewer = null;
  $('reviewer-file').value = '';
  paintFileChoices();
  $('reviewer-file').focus();
  modelError();
});
$('use-demo').addEventListener('click', () => {
  files = { driver: null, reviewer: null };
  modelsDialog.close();
  paintModels();
  toast('Switched to the scripted demo.');
});
$('models-form').addEventListener('submit', (event) => event.preventDefault());
$('apply-models').addEventListener('click', async () => {
  const epoch = setupEpoch;
  const chosen = { ...pendingFiles };
  $('apply-models').disabled = true;
  modelError();
  try {
    await validateModel(chosen.driver);
    if (chosen.reviewer) await validateModel(chosen.reviewer);
    if (epoch !== setupEpoch || !modelsDialog.open || chosen.driver !== pendingFiles.driver || chosen.reviewer !== pendingFiles.reviewer) return;
    files = chosen;
    modelsDialog.close();
    paintModels();
    toast('Local models selected. Run a relay to start them.');
  } catch (error) {
    if (epoch === setupEpoch && modelsDialog.open) modelError(error instanceof Error ? error.message : 'Could not read that file.');
  } finally {
    if (epoch === setupEpoch) $('apply-models').disabled = false;
  }
});
modelsDialog.addEventListener('close', () => {
  if (modelsDialog.open) return;
  setupEpoch += 1;
  $('models-form').reset();
  pendingFiles = undefined;
});

// No native form submission: the same actions work in iframe previews without allow-forms.
form.addEventListener('submit', (event) => event.preventDefault());
$('run-button').addEventListener('click', runRelay);
async function runRelay() {
  if (controller) return;
  const useLocal = engine() === 'local';
  if (!prompt.value.trim() && !useLocal) {
    prompt.value = EXAMPLES[0].prompt;
    paintPrompt();
  }
  let run;
  try {
    // A timestamp and tab-local sequence also work in non-secure preview contexts.
    run = createRun({
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++runSequence}`,
      prompt: prompt.value, mode: mode(), engine: engine(),
      names: useLocal
        ? { driver: modelName(files.driver), reviewer: modelName(files.reviewer ?? files.driver) }
        : { driver: 'Demo driver', reviewer: 'Demo reviewer' },
    });
  } catch (error) {
    setPromptError(error.message);
    prompt.focus();
    return;
  }
  controller = new AbortController();
  visibleRun = run;
  livePhase = selection = undefined;
  let runtime;
  const buttonHadFocus = document.activeElement === $('run-button');
  setBusy(true);
  if (buttonHadFocus) $('stop-button').focus({ preventScroll: true });
  paintHistory();
  announce(`${engineName(run.engine)} relay started.`);
  if (useLocal) runtime = browserEngine(files, (key, phase) => { livePhase = { key, phase }; paintTimeline(); });
  try {
    await executeRelay(run, {
      generate: runtime?.generate ?? demoGenerator(run.prompt),
      signal: controller.signal,
      onUpdate: paintRun,
    });
    history = addToHistory(history, run);
    const saved = saveHistory(storage, history);
    announce(`Relay ${STATE_LABELS[run.state].toLowerCase()}. See relay output.`);
    if (!saved) toast('Browser storage is unavailable. History will only last in this tab.');
  } finally {
    runtime?.dispose();
    controller = undefined;
    const restoreFocus = document.activeElement === $('stop-button');
    setBusy(false);
    if (restoreFocus) $('run-button').focus({ preventScroll: true });
    paintHistory();
    if (!inHistory() && run.state !== 'stopped') $('result').scrollIntoView({ block: 'nearest' });
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
  if (inHistory()) paintHistory();
});
window.addEventListener('hashchange', () => {
  if (!location.hash || ['#workspace', '#history'].includes(location.hash)) route(true);
});

if (/Mac|iPhone|iPad/.test(navigator.platform)) $('modifier').textContent = '⌘';
paintPrompt();
paintModels();
paintRun();
route();
