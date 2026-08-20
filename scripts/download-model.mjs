import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelId = process.env.PII_MASKER_MODEL || 'Xenova/bert-base-NER';
const files = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'onnx/model_quantized.onnx'
];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

for (const file of files) {
  const output = path.join(root, 'models', modelId, file);
  if (await exists(output)) {
    console.log(`Already present: ${file}`);
    continue;
  }

  const url = `https://huggingface.co/${modelId}/resolve/main/${file}`;
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${file}: ${response.status} ${response.statusText}`);
  }

  await mkdir(path.dirname(output), { recursive: true });
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(output, bytes);
}

console.log(`Model ready under models/${modelId}`);
