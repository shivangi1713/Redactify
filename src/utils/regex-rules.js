export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  deterministic: true,
  ner: true,
  debounceMs: 300,
  maskStyle: 'typed',
  entityTypes: {
    email: true,
    phone: true,
    creditCard: true,
    ssn: true,
    aadhaar: true,
    jwt: true,
    apiKey: true,
    awsKey: true,
    privateKey: true,
    name: true,
    location: true,
    organization: true
  },
  allowlistDomains: []
});

export const ENTITY_META = Object.freeze({
  email: { label: 'Email', replacement: '[REDACTED_EMAIL]', priority: 90 },
  phone: { label: 'Phone', replacement: '[REDACTED_PHONE]', priority: 45 },
  creditCard: { label: 'Credit Card', replacement: '[REDACTED_CREDIT_CARD]', priority: 95 },
  ssn: { label: 'SSN', replacement: '[REDACTED_SSN]', priority: 95 },
  aadhaar: { label: 'Aadhaar', replacement: '[REDACTED_AADHAAR]', priority: 95 },
  jwt: { label: 'JWT', replacement: '[REDACTED_JWT]', priority: 100 },
  apiKey: { label: 'API Key', replacement: '[REDACTED_API_KEY]', priority: 100 },
  awsKey: { label: 'AWS Key', replacement: '[REDACTED_AWS_KEY]', priority: 100 },
  privateKey: { label: 'Private Key', replacement: '[REDACTED_PRIVATE_KEY]', priority: 100 },
  name: { label: 'Name', replacement: '[REDACTED_NAME]', priority: 35 },
  location: { label: 'Location', replacement: '[REDACTED_LOCATION]', priority: 30 },
  organization: { label: 'Organization', replacement: '[REDACTED_ORG]', priority: 30 },
  misc: { label: 'Entity', replacement: '[REDACTED_ENTITY]', priority: 20 }
});

const RULES = [
  {
    type: 'privateKey',
    regex: /-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|PGP) )?PRIVATE KEY-----[\s\S]{0,10000}?-----END (?:(?:RSA|DSA|EC|OPENSSH|PGP) )?PRIVATE KEY-----/g,
    validator: (value) => value.length >= 80
  },
  {
    type: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\b/g,
    validator: looksLikeJwt
  },
  {
    type: 'apiKey',
    regex: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,200}|github_pat_[A-Za-z0-9_]{40,255}|gh[pousr]_[A-Za-z0-9_]{36,255})\b/g
  },
  {
    type: 'awsKey',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
  },
  {
    type: 'email',
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi
  },
  {
    type: 'creditCard',
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    validator: (value) => {
      const digits = value.replace(/[^\d]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnCheck(digits);
    }
  },
  {
    type: 'ssn',
    regex: /\b(?!000|666|9\d\d)\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/g
  },
  {
    type: 'aadhaar',
    regex: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
    validator: (value) => verhoeffCheck(value.replace(/[^\d]/g, ''))
  },
  {
    type: 'phone',
    regex: /(?<![\w+])(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}(?![\w])/g,
    validator: (value) => {
      const digits = value.replace(/[^\d]/g, '');
      return digits.length >= 10 && digits.length <= 15 && !/^(\d)\1+$/.test(digits);
    }
  }
];

export function normalizeSettings(settings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    entityTypes: {
      ...DEFAULT_SETTINGS.entityTypes,
      ...(settings.entityTypes || {})
    },
    allowlistDomains: Array.isArray(settings.allowlistDomains)
      ? settings.allowlistDomains
      : DEFAULT_SETTINGS.allowlistDomains
  };
}

export function isDomainAllowed(hostname, allowlistDomains = []) {
  const host = String(hostname || '').toLowerCase();
  return allowlistDomains
    .map((domain) => String(domain || '').trim().toLowerCase())
    .filter(Boolean)
    .some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function detectDeterministic(text, settings = DEFAULT_SETTINGS) {
  const normalized = normalizeSettings(settings);
  if (!text || !normalized.enabled || !normalized.deterministic) return [];

  const detections = [];
  for (const rule of RULES) {
    if (!normalized.entityTypes[rule.type]) continue;

    rule.regex.lastIndex = 0;
    for (const match of text.matchAll(rule.regex)) {
      const value = match[0];
      const start = match.index;
      const end = start + value.length;
      if (start == null || value.length < 3) continue;
      if (rule.validator && !rule.validator(value)) continue;

      detections.push(toDetection({
        type: rule.type,
        start,
        end,
        text: value,
        source: 'regex',
        score: 1
      }));
    }
  }

  return dedupeOverlaps(detections);
}

export function mergeDetections(...groups) {
  return dedupeOverlaps(groups.flat().filter(Boolean));
}

export function applyMasks(text, detections, settings = DEFAULT_SETTINGS) {
  const normalized = normalizeSettings(settings);
  const cleanDetections = dedupeOverlaps(detections || []);
  if (!cleanDetections.length) {
    return { text, counts: {}, replacements: [] };
  }

  let output = '';
  let cursor = 0;
  const counts = {};
  const replacements = [];

  for (const detection of cleanDetections.sort((a, b) => a.start - b.start)) {
    if (detection.start < cursor) continue;
    const replacement = replacementFor(detection, normalized);
    output += text.slice(cursor, detection.start);
    output += replacement;
    cursor = detection.end;
    counts[detection.type] = (counts[detection.type] || 0) + 1;
    replacements.push({ ...detection, replacement });
  }

  output += text.slice(cursor);
  return { text: output, counts, replacements };
}

export function toDetection(partial) {
  const meta = ENTITY_META[partial.type] || ENTITY_META.misc;
  return {
    priority: meta.priority,
    replacement: meta.replacement,
    ...partial
  };
}

function replacementFor(detection, settings) {
  if (settings.maskStyle === 'fixed') return '[REDACTED]';
  return detection.replacement || ENTITY_META[detection.type]?.replacement || ENTITY_META.misc.replacement;
}

function dedupeOverlaps(detections) {
  const sorted = detections
    .filter((item) => Number.isInteger(item.start) && Number.isInteger(item.end) && item.end > item.start)
    .sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      if (a.end !== b.end) return b.end - a.end;
      return (b.priority || 0) - (a.priority || 0);
    });

  const selected = [];
  for (const candidate of sorted) {
    const overlapIndex = selected.findIndex((item) => overlaps(item, candidate));
    if (overlapIndex === -1) {
      selected.push(candidate);
      continue;
    }

    const current = selected[overlapIndex];
    const candidateScore = overlapScore(candidate);
    const currentScore = overlapScore(current);
    if (candidateScore > currentScore) {
      selected.splice(overlapIndex, 1, candidate);
    }
  }

  return selected.sort((a, b) => a.start - b.start);
}

function overlapScore(item) {
  return (item.priority || 0) * 100000 + (item.end - item.start);
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

function luhnCheck(digits) {
  let sum = 0;
  let doubleIt = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleIt) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleIt = !doubleIt;
  }
  return sum % 10 === 0;
}

function looksLikeJwt(value) {
  const [header] = value.split('.');
  try {
    const decoded = JSON.parse(base64UrlDecode(header));
    return decoded && typeof decoded === 'object' && decoded.alg;
  } catch {
    return false;
  }
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  if (typeof atob === 'function') return atob(padded);
  return Buffer.from(padded, 'base64').toString('utf8');
}

const VERHOEFF_D = [
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

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];

function verhoeffCheck(digits) {
  if (!/^\d{12}$/.test(digits)) return false;

  let checksum = 0;
  const reversed = digits.split('').reverse().map(Number);
  for (let index = 0; index < reversed.length; index += 1) {
    checksum = VERHOEFF_D[checksum][VERHOEFF_P[index % 8][reversed[index]]];
  }
  return checksum === 0;
}
