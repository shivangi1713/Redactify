import {
  DEFAULT_SETTINGS,
  applyMasks,
  detectDeterministic,
  isDomainAllowed,
  mergeDetections,
  normalizeSettings
} from '../utils/regex-rules.js';

const PLACEHOLDER_PATTERN = /\[REDACTED_[A-Z_]+\]|\[REDACTED\]/;
const MAX_NER_CHARS = 4500;
const MAX_SYNC_DETECTION_CHARS = 100000;
const stateByElement = new WeakMap();
const timers = new WeakMap();
const submittingForms = new WeakSet();

let settings = normalizeSettings(DEFAULT_SETTINGS);
let activeEditable = null;
let internalEdit = false;
let badge;

init();

async function init() {
  await loadSettings();
  injectBadge();

  window.addEventListener('paste', handlePaste, true);
  document.addEventListener('focusin', handleFocusIn, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('paste', handlePaste, true);
  document.addEventListener('submit', handleSubmit, true);
  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('keydown', handleKeyDown, true);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.settings) return;
    settings = normalizeSettings(changes.settings.newValue || DEFAULT_SETTINGS);
    updateBadge();
  });
}

async function loadSettings() {
  const result = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS });
  settings = normalizeSettings(result.settings);
}

function handleFocusIn(event) {
  const editable = findEditable(event.target);
  if (!editable) return;
  activeEditable = editable;
  updateBadge();
}

function handleInput(event) {
  if (internalEdit) return;
  const editable = findEditable(event.target);
  if (!editable || !shouldProcessPage()) return;

  const current = getText(editable);
  const state = getElementState(editable);
  if (state.showingOriginal || !PLACEHOLDER_PATTERN.test(current) || (state.maskedText && current !== state.maskedText)) {
    resetElementState(editable, { preserveGeneration: true });
  }

  scheduleProcess(editable);
}

function handlePaste(event) {
  if (event.__piiMaskerHandled) return;

  const editable = findEditable(event.target);
  if (!editable || !shouldProcessPage()) return;

  const pastedText = event.clipboardData?.getData('text/plain');
  if (!pastedText) return;

  const deterministic = detectDeterministic(limitDetectionText(pastedText), settings);
  if (!deterministic.length) {
    scheduleProcess(editable, 0);
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  event.__piiMaskerHandled = true;

  const masked = applyMasks(pastedText, deterministic, settings);
  const preview = buildPastePreview(editable, pastedText, masked.text);
  if (isContentEditable(editable)) {
    setText(editable, preview.maskedText, { inputType: 'insertFromPaste', data: masked.text });
  } else {
    insertText(editable, masked.text);
  }

  const state = getElementState(editable);
  state.originalText = preview.originalText;
  state.maskedText = preview.maskedText;
  state.counts = masked.counts;
  state.replacements = masked.replacements;
  state.showingOriginal = false;
  activeEditable = editable;
  updateBadge();

  if (isContentEditable(editable)) return;

  scheduleProcess(editable, 0);
}

async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !shouldProcessPage()) return;
  if (submittingForms.has(form)) {
    submittingForms.delete(form);
    return;
  }

  const editables = getEditablesWithin(form);
  if (!editables.length) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  await Promise.all(editables.map((editable) => processElement(editable, { force: true, reason: 'submit' })));

  submittingForms.add(form);
  if (typeof form.requestSubmit === 'function') {
    form.requestSubmit(event.submitter || undefined);
  } else {
    HTMLFormElement.prototype.submit.call(form);
  }
}

function handlePointerDown(event) {
  const button = event.target?.closest?.('button,input[type="submit"],input[type="button"],[role="button"]');
  if (!button || !activeEditable || !shouldProcessPage()) return;
  if (!looksLikeSubmitAction(button)) return;

  processElement(activeEditable, { syncOnly: true, reason: 'pointerdown' });
  scheduleProcess(activeEditable, 0);
}

function handleKeyDown(event) {
  if (!activeEditable || !shouldProcessPage()) return;
  const isSendKey = event.key === 'Enter' && (event.metaKey || event.ctrlKey || isContentEditable(activeEditable));
  if (!isSendKey) return;

  processElement(activeEditable, { syncOnly: true, reason: 'keydown' });
  scheduleProcess(activeEditable, 0);
}

function scheduleProcess(editable, delay = settings.debounceMs) {
  clearTimeout(timers.get(editable));
  timers.set(editable, setTimeout(() => {
    processElement(editable, { reason: 'debounced' });
  }, delay));
}

async function processElement(editable, options = {}) {
  if (!shouldProcessPage() || !isEditable(editable)) return null;

  const visibleText = getText(editable);
  const currentState = getElementState(editable);
  const text = currentState.originalText && PLACEHOLDER_PATTERN.test(visibleText) && !currentState.showingOriginal
    ? currentState.originalText
    : visibleText;
  if (!text || text.length < 3) {
    resetElementState(editable);
    updateBadge();
    return null;
  }

  const state = currentState;
  const generation = state.generation + 1;
  state.generation = generation;

  const deterministic = detectDeterministic(limitDetectionText(text), settings);
  let nerEntities = [];

  if (!options.syncOnly && settings.ner && text.length <= MAX_SYNC_DETECTION_CHARS) {
    nerEntities = await requestNer(text.slice(0, MAX_NER_CHARS), settings);
    if (getElementState(editable).generation !== generation) return null;
  }

  const detections = mergeDetections(deterministic, nerEntities);
  const masked = applyMasks(text, detections, settings);

  if (!detections.length || masked.text === text) {
    if (PLACEHOLDER_PATTERN.test(visibleText) && Object.keys(state.counts || {}).length) {
      state.maskedText = visibleText;
      state.showingOriginal = false;
      updateBadge();
      return masked;
    }

    state.counts = {};
    state.replacements = [];
    state.maskedText = text;
    state.showingOriginal = false;
    updateBadge();
    return masked;
  }

  state.originalText = text;
  state.maskedText = masked.text;
  state.counts = masked.counts;
  state.replacements = masked.replacements;
  state.showingOriginal = false;

  if (!isContentEditable(editable) || options.force || deterministic.length > 0) {
    setText(editable, masked.text);
  }
  activeEditable = editable;
  updateBadge();
  return masked;
}

function limitDetectionText(text) {
  return String(text || '').slice(0, MAX_SYNC_DETECTION_CHARS);
}

async function requestNer(text, currentSettings) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'PII_MASKER_NER_REQUEST',
      text,
      settings: currentSettings
    });
    return response?.entities || [];
  } catch {
    return [];
  }
}

function shouldProcessPage() {
  return settings.enabled && !isDomainAllowed(location.hostname, settings.allowlistDomains);
}

function findEditable(target) {
  if (!target || target === document || target === window) return null;
  if (isEditable(target)) return target;
  return target.closest?.('textarea,input,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]') || null;
}

function getEditablesWithin(root) {
  return [...root.querySelectorAll('textarea,input,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]')]
    .filter(isEditable);
}

function isEditable(element) {
  if (!element || element.disabled || element.readOnly) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return isSupportedInput(element);
  return isContentEditable(element);
}

function isSupportedInput(input) {
  const type = (input.type || 'text').toLowerCase();
  const textTypes = new Set(['text', 'search', 'email', 'tel', 'url', 'number']);
  if (textTypes.has(type)) return true;
  if (type !== 'password') return false;

  const hint = `${input.name} ${input.id} ${input.autocomplete} ${input.placeholder}`.toLowerCase();
  return /\b(api|token|key|secret|credential|bearer|jwt|github|openai|aws)\b/.test(hint);
}

function isContentEditable(element) {
  return element instanceof HTMLElement && element.isContentEditable;
}

function getText(editable) {
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) return editable.value;
  return editable.innerText || editable.textContent || '';
}

function setText(editable, value, options = {}) {
  internalEdit = true;
  try {
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
      const previousLength = editable.value.length;
      const selectionStart = editable.selectionStart ?? previousLength;
      editable.value = value;
      const nextPosition = Math.min(value.length, selectionStart);
      editable.setSelectionRange?.(nextPosition, nextPosition);
    } else {
      editable.replaceChildren(createPlainTextFragment(value));
      placeCaretAtEnd(editable);
    }
    if (options.dispatchInput !== false) {
      dispatchEditableInput(editable, options.inputType || 'insertReplacementText', options.data ?? value);
    }
  } finally {
    queueMicrotask(() => {
      internalEdit = false;
    });
  }
}

function dispatchEditableInput(editable, inputType, data) {
  editable.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    composed: true,
    inputType,
    data
  }));
}

function insertText(editable, value) {
  internalEdit = true;
  try {
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
      const start = editable.selectionStart ?? editable.value.length;
      const end = editable.selectionEnd ?? start;
      editable.setRangeText(value, start, end, 'end');
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return;
    }

    editable.focus();
    if (document.queryCommandSupported?.('insertText')) {
      document.execCommand('insertText', false, value);
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    } else {
      const selection = getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(createPlainTextFragment(value));
      range.collapse(false);
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
  } finally {
    queueMicrotask(() => {
      internalEdit = false;
    });
  }
}

function createPlainTextFragment(value) {
  const fragment = document.createDocumentFragment();
  const lines = String(value).split(/\r\n|\r|\n/);
  lines.forEach((line, index) => {
    if (index > 0) fragment.append(document.createElement('br'));
    fragment.append(document.createTextNode(line));
  });
  return fragment;
}

function buildPastePreview(editable, originalInsert, maskedInsert) {
  const current = getText(editable);
  const offsets = getSelectionOffsets(editable);
  if (!offsets) {
    return {
      originalText: originalInsert,
      maskedText: maskedInsert
    };
  }

  return {
    originalText: `${current.slice(0, offsets.start)}${originalInsert}${current.slice(offsets.end)}`,
    maskedText: `${current.slice(0, offsets.start)}${maskedInsert}${current.slice(offsets.end)}`
  };
}

function getSelectionOffsets(editable) {
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    const start = editable.selectionStart ?? editable.value.length;
    const end = editable.selectionEnd ?? start;
    return { start, end };
  }

  const selection = getSelection();
  if (!selection?.rangeCount || !editable.contains(selection.anchorNode) || !editable.contains(selection.focusNode)) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const beforeStart = range.cloneRange();
  beforeStart.selectNodeContents(editable);
  beforeStart.setEnd(range.startContainer, range.startOffset);

  const beforeEnd = range.cloneRange();
  beforeEnd.selectNodeContents(editable);
  beforeEnd.setEnd(range.endContainer, range.endOffset);

  return {
    start: beforeStart.toString().length,
    end: beforeEnd.toString().length
  };
}

function placeCaretAtEnd(element) {
  if (!element.isConnected) return;

  element.focus();
  const selection = element.ownerDocument?.getSelection?.();
  if (!selection) return;

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);

  try {
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // Rich editors can replace the active contenteditable node while we mask it.
  }
}

function injectBadge() {
  if (badge) return;

  badge = document.createElement('div');
  badge.id = 'pii-masker-badge';
  badge.innerHTML = `
    <span class="pii-masker-dot"></span>
    <span data-role="count">0 redacted</span>
    <button type="button" data-action="toggle">View Original</button>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #pii-masker-badge {
      all: initial;
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      display: none;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border: 1px solid rgba(19, 27, 43, 0.14);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 8px 28px rgba(19, 27, 43, 0.18);
      color: #172033;
      font: 500 12px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #pii-masker-badge[data-visible="true"] { display: flex; }
    #pii-masker-badge .pii-masker-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #0f9f6e;
      box-shadow: 0 0 0 3px rgba(15, 159, 110, 0.14);
    }
    #pii-masker-badge button {
      all: unset;
      cursor: pointer;
      border-radius: 6px;
      padding: 4px 7px;
      background: #172033;
      color: #fff;
      font: 600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #pii-masker-badge button:focus-visible {
      outline: 2px solid #3b82f6;
      outline-offset: 2px;
    }
  `;

  document.documentElement.append(style, badge);
  const toggle = badge.querySelector('[data-action="toggle"]');
  toggle.addEventListener('pointerdown', (event) => event.preventDefault());
  toggle.addEventListener('click', toggleOriginal);
}

function updateBadge() {
  if (!badge) return;
  const state = activeEditable ? stateByElement.get(activeEditable) : null;
  const count = state ? Object.values(state.counts || {}).reduce((sum, value) => sum + value, 0) : 0;
  const visible = shouldProcessPage() && count > 0;

  badge.dataset.visible = String(visible);
  badge.querySelector('[data-role="count"]').textContent = `${count} redacted`;
  badge.querySelector('[data-action="toggle"]').textContent = state?.showingOriginal ? 'Masked' : 'View Original';
}

function toggleOriginal() {
  if (!activeEditable) return;
  const state = stateByElement.get(activeEditable);
  if (!state?.originalText || !state.maskedText) return;

  if (state.showingOriginal) {
    setText(activeEditable, state.maskedText, { dispatchInput: false });
    state.showingOriginal = false;
  } else {
    setText(activeEditable, state.originalText, { dispatchInput: false });
    state.showingOriginal = true;
  }
  updateBadge();
}

function looksLikeSubmitAction(element) {
  const text = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.textContent || ''} ${element.value || ''}`.toLowerCase();
  return /\b(send|submit|post|save|continue|next|reply|comment|share)\b/.test(text)
    || element.type === 'submit';
}

function getElementState(editable) {
  let state = stateByElement.get(editable);
  if (!state) {
    state = {
      originalText: '',
      maskedText: '',
      counts: {},
      replacements: [],
      showingOriginal: false,
      generation: 0
    };
    stateByElement.set(editable, state);
  }
  return state;
}

function resetElementState(editable, options = {}) {
  const current = getElementState(editable);
  stateByElement.set(editable, {
    originalText: '',
    maskedText: '',
    counts: {},
    replacements: [],
    showingOriginal: false,
    generation: options.preserveGeneration ? current.generation : 0
  });
}
