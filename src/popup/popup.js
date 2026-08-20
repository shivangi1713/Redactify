import { DEFAULT_SETTINGS, ENTITY_META, normalizeSettings } from '../utils/regex-rules.js';

const ENTITY_ORDER = [
  'apiKey',
  'awsKey',
  'jwt',
  'privateKey',
  'creditCard',
  'ssn',
  'aadhaar',
  'email',
  'phone',
  'name',
  'location',
  'organization'
];

let settings = normalizeSettings(DEFAULT_SETTINGS);
let currentDomain = '';

const enabledInput = document.querySelector('#enabled');
const togglesRoot = document.querySelector('#entity-toggles');
const domainInput = document.querySelector('#domain-input');
const domainList = document.querySelector('#domain-list');
const domainLabel = document.querySelector('#domain-label');
const saveStatus = document.querySelector('#save-status');
const modelStatus = document.querySelector('#model-status');

init();

async function init() {
  const [stored, tab] = await Promise.all([
    chrome.storage.local.get({ settings: DEFAULT_SETTINGS }),
    getActiveTab()
  ]);

  settings = normalizeSettings(stored.settings);
  currentDomain = hostnameFromUrl(tab?.url);
  domainLabel.textContent = currentDomain || 'Local redaction controls';

  render();
  bindEvents();
}

function bindEvents() {
  enabledInput.addEventListener('change', () => {
    settings.enabled = enabledInput.checked;
    save();
  });

  document.querySelector('#add-domain').addEventListener('click', () => addDomain(domainInput.value));
  document.querySelector('#allow-current').addEventListener('click', () => addDomain(currentDomain));
  document.querySelector('#reset').addEventListener('click', async () => {
    settings = normalizeSettings(DEFAULT_SETTINGS);
    await save();
    render();
  });

  domainInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addDomain(domainInput.value);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'NER_STATUS') return;
    modelStatus.textContent = message.status === 'ready' ? 'NER ready' : 'Loading NER';
  });
}

function render() {
  enabledInput.checked = settings.enabled;
  togglesRoot.replaceChildren(...ENTITY_ORDER.map(renderEntityToggle));
  renderDomains();
}

function renderEntityToggle(type) {
  const label = document.createElement('label');
  label.className = 'toggle-item';
  label.dataset.on = String(Boolean(settings.entityTypes[type]));

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(settings.entityTypes[type]);
  input.addEventListener('change', () => {
    settings.entityTypes[type] = input.checked;
    label.dataset.on = String(input.checked);
    save();
  });

  const text = document.createElement('span');
  text.textContent = ENTITY_META[type]?.label || type;

  label.append(input, text);
  return label;
}

function renderDomains() {
  domainList.replaceChildren();
  if (!settings.allowlistDomains.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No allowlisted domains';
    domainList.append(empty);
    return;
  }

  for (const domain of settings.allowlistDomains) {
    const item = document.createElement('li');
    const label = document.createElement('code');
    const remove = document.createElement('button');

    label.textContent = domain;
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeDomain(domain));

    item.append(label, remove);
    domainList.append(item);
  }
}

function addDomain(value) {
  const domain = sanitizeDomain(value);
  if (!domain) return;
  settings.allowlistDomains = [...new Set([...settings.allowlistDomains, domain])].sort();
  domainInput.value = '';
  renderDomains();
  save();
}

function removeDomain(domain) {
  settings.allowlistDomains = settings.allowlistDomains.filter((item) => item !== domain);
  renderDomains();
  save();
}

async function save() {
  settings = normalizeSettings(settings);
  await chrome.storage.local.set({ settings });
  saveStatus.textContent = 'Saved';
  clearTimeout(saveStatus._timer);
  saveStatus._timer = setTimeout(() => {
    saveStatus.textContent = '';
  }, 1200);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostnameFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return '';
  }
}

function sanitizeDomain(value) {
  const trimmed = String(value || '').trim().toLowerCase();
  if (!trimmed) return '';

  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.replace(/^www\./, '');
  } catch {
    return trimmed
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .replace(/[^a-z0-9.-]/g, '');
  }
}
