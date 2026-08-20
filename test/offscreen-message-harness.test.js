import test from 'node:test';
import assert from 'node:assert/strict';

test('synthetic offscreen harness resolves matching NER responses by id', async () => {
  const worker = new FakeWorker();
  const bridge = new OffscreenHarness(worker);

  const responsePromise = bridge.analyze('John Smith works at Acme Corp.', {});
  const request = worker.sent.at(-1);

  worker.emit({
    id: request.id,
    type: 'NER_RESULT',
    entities: [{ type: 'name', start: 0, end: 10, source: 'ner' }]
  });

  assert.deepEqual(await responsePromise, {
    entities: [{ type: 'name', start: 0, end: 10, source: 'ner' }],
    error: undefined
  });
  assert.equal(bridge.pending.size, 0);
});

test('synthetic offscreen harness ignores stale or unknown responses', async () => {
  const worker = new FakeWorker();
  const bridge = new OffscreenHarness(worker);

  const responsePromise = bridge.analyze('London', {});
  worker.emit({ id: 'stale-id', type: 'NER_RESULT', entities: [{ type: 'location' }] });
  assert.equal(bridge.pending.size, 1);

  const request = worker.sent.at(-1);
  worker.emit({ id: request.id, type: 'NER_RESULT', entities: [] });
  assert.deepEqual(await responsePromise, { entities: [], error: undefined });
});

class OffscreenHarness {
  constructor(worker) {
    this.worker = worker;
    this.pending = new Map();
    this.sequence = 0;
    this.worker.addEventListener('message', (event) => this.handleMessage(event));
  }

  analyze(text, settings) {
    const id = `ner-test-${this.sequence += 1}`;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.worker.postMessage({ id, type: 'NER_ANALYZE', text, settings });
    });
  }

  handleMessage(event) {
    const data = event.data || {};
    if (data.type !== 'NER_RESULT') return;
    const request = this.pending.get(data.id);
    if (!request) return;
    this.pending.delete(data.id);
    request.resolve({ entities: data.entities || [], error: data.error });
  }
}

class FakeWorker {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  postMessage(message) {
    this.sent.push(message);
  }

  emit(data) {
    this.listeners.get('message')?.({ data });
  }
}
