import { mkdir, copyFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, '..');
const distDir = path.join(projectRoot, 'dist');

async function copyDir(src, dest, { optional = false } = {}) {
  try {
    const srcStat = await stat(src);
    if (!srcStat.isDirectory()) return;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return;
    throw error;
  }

  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else {
      await copyFileIfChanged(from, to);
    }
  }
}

async function copyFileIfChanged(src, dest) {
  const srcStat = await stat(src);
  let destStat;

  try {
    destStat = await stat(dest);
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return;
    if (error.code !== 'ENOENT') throw error;
  }

  if (destStat && srcStat.size === destStat.size && Math.trunc(srcStat.mtimeMs) <= Math.trunc(destStat.mtimeMs)) {
    return;
  }

  await copyFile(src, dest);
}

async function copyWasms() {
  const vendorDir = path.join(distDir, 'vendor');
  await mkdir(vendorDir, { recursive: true });
  const candidates = [
    path.join(projectRoot, 'node_modules', '@xenova', 'transformers', 'dist'),
    path.join(projectRoot, 'node_modules', '@huggingface', 'transformers', 'node_modules', 'onnxruntime-web', 'dist'),
    path.join(projectRoot, 'node_modules', 'onnxruntime-web', 'dist')
  ];

  for (const dir of candidates) {
    try {
      for (const file of await readdir(dir)) {
        if (file.endsWith('.wasm') || file.endsWith('.mjs')) {
          await copyFileIfChanged(path.join(dir, file), path.join(vendorDir, file));
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

await mkdir(distDir, { recursive: true });

await copyFile(path.join(projectRoot, 'manifest.json'), path.join(distDir, 'manifest.json'));
await copyDir(path.join(projectRoot, 'src', 'popup'), path.join(distDir, 'popup'));
await copyDir(path.join(projectRoot, 'src', 'offscreen'), path.join(distDir, 'offscreen'));
await copyDir(path.join(projectRoot, 'models'), path.join(distDir, 'models'), { optional: true });
await copyWasms();

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': '"production"'
  }
};

await Promise.all([
  esbuild.build({
    ...shared,
    entryPoints: [path.join(projectRoot, 'src', 'content', 'content-script.js')],
    outfile: path.join(distDir, 'content', 'content-script.js'),
    format: 'iife',
    target: ['chrome109']
  }),
  esbuild.build({
    ...shared,
    entryPoints: [path.join(projectRoot, 'src', 'popup', 'popup.js')],
    outfile: path.join(distDir, 'popup', 'popup.js'),
    format: 'esm',
    target: ['chrome109']
  }),
  esbuild.build({
    ...shared,
    entryPoints: [path.join(projectRoot, 'src', 'background', 'service-worker.js')],
    outfile: path.join(distDir, 'background', 'service-worker.js'),
    format: 'esm',
    target: ['chrome109']
  }),
  esbuild.build({
    ...shared,
    entryPoints: [path.join(projectRoot, 'src', 'offscreen', 'offscreen.js')],
    outfile: path.join(distDir, 'offscreen', 'offscreen.js'),
    format: 'esm',
    target: ['chrome109']
  }),
  esbuild.build({
    ...shared,
    entryPoints: [path.join(projectRoot, 'src', 'workers', 'ner-worker.js')],
    outfile: path.join(distDir, 'workers', 'ner-worker.js'),
    format: 'esm',
    target: ['chrome109']
  })
]);

console.log('Built extension in dist/. Load dist/ as an unpacked Chrome extension.');
