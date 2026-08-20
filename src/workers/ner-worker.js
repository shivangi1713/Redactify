import { env, pipeline } from '@huggingface/transformers';
import { DEFAULT_SETTINGS, ENTITY_META, normalizeSettings, toDetection } from '../utils/regex-rules.js';

const MODEL_ID = 'Xenova/bert-base-NER';
const MAX_TEXT_CHARS = 4500;
const MIN_ENTITY_SCORE = 0.72;

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
env.useWasmCache = false;
env.logLevel = 40;
env.localModelPath = new URL('../models/', self.location.href).href;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/', self.location.href).href;
env.backends.onnx.wasm.numThreads = 1;

let nerPipelinePromise;

self.addEventListener('message', async (event) => {
  const { id, type, text, settings } = event.data || {};
  if (type !== 'NER_ANALYZE') return;

  try {
    const normalizedSettings = normalizeSettings(settings || DEFAULT_SETTINGS);
    if (!normalizedSettings.enabled || !normalizedSettings.ner || !text) {
      self.postMessage({ id, type: 'NER_RESULT', entities: [] });
      return;
    }

    const ner = await getPipeline();
    const limitedText = text.slice(0, MAX_TEXT_CHARS);
    const rawEntities = await ner(limitedText, {
      aggregation_strategy: 'simple',
      ignore_labels: ['O']
    });

    const entities = rawEntities
      .map((entity) => normalizeEntity(entity, normalizedSettings))
      .filter(Boolean);

    self.postMessage({ id, type: 'NER_RESULT', entities });
  } catch (error) {
    self.postMessage({
      id,
      type: 'NER_RESULT',
      entities: [],
      error: readableError(error)
    });
  }
});

async function getPipeline() {
  if (!nerPipelinePromise) {
    self.postMessage({ type: 'NER_STATUS', status: 'loading' });
    nerPipelinePromise = pipeline('token-classification', MODEL_ID, {
      quantized: true,
      progress_callback: (progress) => {
        self.postMessage({
          type: 'NER_STATUS',
          status: 'progress',
          file: progress.file,
          loaded: progress.loaded,
          total: progress.total
        });
      }
    }).then((instance) => {
      self.postMessage({ type: 'NER_STATUS', status: 'ready' });
      return instance;
    });
  }

  return nerPipelinePromise;
}

function normalizeEntity(entity, settings) {
  const mappedType = mapEntityType(entity.entity_group || entity.entity);
  if (!mappedType || !settings.entityTypes[mappedType]) return null;
  if (typeof entity.score === 'number' && entity.score < MIN_ENTITY_SCORE) return null;
  if (!Number.isInteger(entity.start) || !Number.isInteger(entity.end)) return null;

  return toDetection({
    type: mappedType,
    start: entity.start,
    end: entity.end,
    text: entity.word,
    source: 'ner',
    score: entity.score,
    replacement: ENTITY_META[mappedType]?.replacement
  });
}

function mapEntityType(label = '') {
  const normalized = String(label).replace(/^B-|^I-/, '').toUpperCase();
  if (normalized === 'PER' || normalized === 'PERSON') return 'name';
  if (normalized === 'LOC' || normalized === 'LOCATION') return 'location';
  if (normalized === 'ORG' || normalized === 'ORGANIZATION') return 'organization';
  return null;
}

function readableError(error) {
  if (!error) return 'Unknown NER worker error';
  return error.message || String(error);
}
