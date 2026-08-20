import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  applyMasks,
  detectDeterministic,
  isDomainAllowed,
  mergeDetections
} from '../src/utils/regex-rules.js';

test('redacts the canonical sample while preserving line breaks', () => {
  const original = [
    'My email is john@doe.com.',
    'Card: 4242 4242 4242 4242',
    'OpenAI key: sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
    'AWS key: AKIAIOSFODNN7EXAMPLE',
    'I met John Smith in London at Acme Corp.'
  ].join('\n');

  const masked = applyMasks(original, detectDeterministic(original, DEFAULT_SETTINGS), DEFAULT_SETTINGS);

  assert.equal(masked.text, [
    'My email is [REDACTED_EMAIL].',
    'Card: [REDACTED_CREDIT_CARD]',
    'OpenAI key: [REDACTED_API_KEY]',
    'AWS key: [REDACTED_AWS_KEY]',
    'I met John Smith in London at Acme Corp.'
  ].join('\n'));
  assert.deepEqual(masked.counts, {
    email: 1,
    creditCard: 1,
    apiKey: 1,
    awsKey: 1
  });
});

test('accepts valid Luhn cards and rejects invalid card-like numbers', () => {
  const valid = detectDeterministic('card 4111 1111 1111 1111', DEFAULT_SETTINGS);
  const invalid = detectDeterministic('card 4111 1111 1111 1112', DEFAULT_SETTINGS);

  assert.equal(valid.some((item) => item.type === 'creditCard'), true);
  assert.equal(invalid.some((item) => item.type === 'creditCard'), false);
});

test('accepts valid Verhoeff Aadhaar-like IDs and rejects invalid checksums', () => {
  const base = '23456789012';
  const valid = `${base}${verhoeffDigit(base)}`;
  const invalid = `${base}${(Number(valid.at(-1)) + 1) % 10}`;

  assert.equal(detectDeterministic(valid, DEFAULT_SETTINGS).some((item) => item.type === 'aadhaar'), true);
  assert.equal(detectDeterministic(invalid, DEFAULT_SETTINGS).some((item) => item.type === 'aadhaar'), false);
});

test('validates JWT header JSON before redaction', () => {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: '123' }));
  const token = `${header}.${payload}.signature123`;

  assert.equal(detectDeterministic(token, DEFAULT_SETTINGS).some((item) => item.type === 'jwt'), true);
  assert.equal(detectDeterministic('eyJnot-json.aaaaaaaa.bbbbbbbb', DEFAULT_SETTINGS).some((item) => item.type === 'jwt'), false);
});

test('deduplicates overlaps in favor of higher-priority secrets', () => {
  const detections = mergeDetections(
    [{ type: 'phone', start: 0, end: 12, priority: 45, replacement: '[REDACTED_PHONE]' }],
    [{ type: 'apiKey', start: 0, end: 30, priority: 100, replacement: '[REDACTED_API_KEY]' }]
  );

  assert.equal(detections.length, 1);
  assert.equal(detections[0].type, 'apiKey');
});

test('respects disabled entity types and domain allowlist matching', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    entityTypes: { ...DEFAULT_SETTINGS.entityTypes, email: false }
  };

  assert.equal(detectDeterministic('john@doe.com', settings).length, 0);
  assert.equal(isDomainAllowed('chat.example.com', ['example.com']), true);
  assert.equal(isDomainAllowed('badexample.com', ['example.com']), false);
});

test('malicious long input stays bounded enough for synchronous use', () => {
  const input = `${'-----BEGIN PRIVATE KEY-----'.repeat(2000)}${'A'.repeat(200000)}`;
  const started = performance.now();
  const detections = detectDeterministic(input, DEFAULT_SETTINGS);
  const elapsed = performance.now() - started;

  assert.deepEqual(detections, []);
  assert.ok(elapsed < 750, `regex scan took ${elapsed}ms`);
});

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function verhoeffDigit(value) {
  let checksum = 0;
  const reversed = value.split('').reverse().map(Number);
  for (let index = 0; index < reversed.length; index += 1) {
    checksum = D[checksum][P[(index + 1) % 8][reversed[index]]];
  }
  return INV[checksum];
}
