import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanRoots = ['src', 'manifest.json'];
const forbidden = [
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bsendBeacon\b/,
  /\bEventSource\b/,
  /\bnew\s+Image\s*\(/,
  /\bfetch\s*\(/,
  /https?:\/\//
];
const allowed = [
  /src[\\/]workers[\\/]ner-worker\.js::.*allowRemoteModels/,
  /src[\\/]popup[\\/]popup\.js::.*new URL\(trimmed/,
  /manifest\.json::/,
  /https?:\/\/localhost/,
  /https?:\/\/127\.0\.0\.1/
];

const findings = [];

for (const entry of scanRoots) {
  await scan(path.join(root, entry));
}

if (findings.length) {
  console.error('Runtime network audit findings:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log('Runtime network audit passed: no unapproved fetch/XHR/WebSocket/beacon patterns in src/.');
}

async function scan(target) {
  const stats = await statSafe(target);
  if (!stats) return;

  if (stats.isDirectory()) {
    for (const child of await readdir(target)) await scan(path.join(target, child));
    return;
  }

  if (!/\.(js|json|html|css)$/.test(target)) return;
  const rel = path.relative(root, target);
  const text = await readFile(target, 'utf8');
  text.split(/\r?\n/).forEach((line, index) => {
    const key = `${rel}::${line}`;
    if (allowed.some((pattern) => pattern.test(key) || pattern.test(line))) return;
    if (forbidden.some((pattern) => pattern.test(line))) {
      findings.push(`${rel}:${index + 1}: ${line.trim()}`);
    }
  });
}

async function statSafe(target) {
  try {
    return await import('node:fs/promises').then((fs) => fs.stat(target));
  } catch {
    return null;
  }
}
