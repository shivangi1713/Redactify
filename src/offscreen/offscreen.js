const pending = new Map();
let worker;
let sequence = 0;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen' || message.type !== 'NER_ANALYZE') return false;

  analyze(message.text, message.settings)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ entities: [], error: readableError(error) }));

  return true;
});

function analyze(text, settings) {
  ensureWorker();

  const id = `ner-${Date.now()}-${sequence += 1}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      resolve({ entities: [], error: 'NER analysis timed out' });
    }, 30000);

    pending.set(id, { resolve, timeout });
    worker.postMessage({ id, type: 'NER_ANALYZE', text, settings });
  });
}

function ensureWorker() {
  if (worker) return worker;

  worker = new Worker(chrome.runtime.getURL('workers/ner-worker.js'), { type: 'module' });
  worker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'NER_STATUS') {
      chrome.runtime.sendMessage({ type: 'NER_STATUS', status: data.status }).catch(() => {});
      return;
    }

    if (data.type !== 'NER_RESULT') return;
    const request = pending.get(data.id);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(data.id);
    request.resolve({ entities: data.entities || [], error: data.error });
  });

  worker.addEventListener('error', (error) => {
    for (const [id, request] of pending) {
      clearTimeout(request.timeout);
      request.resolve({ entities: [], error: error.message || `Worker failed for ${id}` });
    }
    pending.clear();
    worker?.terminate();
    worker = null;
  });

  return worker;
}

function readableError(error) {
  return error?.message || String(error || 'Unknown offscreen error');
}
