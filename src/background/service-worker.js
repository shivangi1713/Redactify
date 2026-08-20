import { DEFAULT_SETTINGS } from '../utils/regex-rules.js';

const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';
let creatingOffscreenDocument;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get('settings');
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'PII_MASKER_NER_REQUEST') return false;

  handleNerRequest(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ entities: [], error: readableError(error) }));

  return true;
});

async function handleNerRequest(message) {
  await ensureOffscreenDocument();
  try {
    return await sendToOffscreen(message);
  } catch (error) {
    await closeOffscreenDocument();
    await ensureOffscreenDocument();
    return sendToOffscreen(message);
  }
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['WORKERS'],
      justification: 'Run local PII NER inference in a dedicated worker without blocking page input.'
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }

  try {
    await creatingOffscreenDocument;
  } catch (error) {
    if (!String(error?.message || error).includes('Only a single offscreen document')) {
      throw error;
    }
  }
}

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  }

  try {
    const matchedClients = await clients.matchAll();
    return matchedClients.some((client) => client.url === offscreenUrl);
  } catch {
    return false;
  }
}

async function closeOffscreenDocument() {
  if (!(await hasOffscreenDocument())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // The document may already have been closed by Chrome.
  }
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'NER_ANALYZE',
    text: message.text,
    settings: message.settings
  });
}

function readableError(error) {
  return error?.message || String(error || 'Unknown background error');
}
