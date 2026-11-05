import { isOpenAi, modelKey, type ModelConfig } from "../core/settings";

// Loaded at runtime from the extension package: transformers.js finds its WASM
// next to it, and bundling would hide those files from it.
let transformers: Promise<any> | null = null;

function loadTransformers() {
  transformers ??= (async () => {
    const url = chrome.runtime.getURL("libs/transformers.min.js");
    const module = await import(/* @vite-ignore */ url);
    const { env } = module;
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("libs/");
    // Threads need SharedArrayBuffer, which the manifest's COOP/COEP headers enable.
    env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
      ? Math.min(navigator.hardwareConcurrency || 1, 8)
      : 1;
    return module;
  })();
  return transformers;
}

export interface LoadedModel {
  key: string;
  config: ModelConfig;
  pipeline: Promise<any>;
  users: number;
}

let current: LoadedModel | null = null;

type ProgressInfo = { status: string; file?: string; progress?: number };

/**
 * Hands out the pipeline for a configuration, loading it if needed. A pipeline
 * in use stays alive until released even after another model replaced it, so a
 * model switch can't dispose it under a running job. Every acquire must be
 * paired with a release.
 */
export function acquireModel(
  config: ModelConfig,
  onProgress?: (info: ProgressInfo) => void,
): LoadedModel {
  const key = `${modelKey(config)}|${config.device}`;
  if (current?.key === key) {
    current.users++;
    return current;
  }

  const previous = current;
  const entry: LoadedModel = {
    key,
    config,
    users: 1,
    pipeline: (async () => {
      const { pipeline } = await loadTransformers();
      return pipeline("feature-extraction", config.id, {
        dtype: config.dtype,
        device: config.device,
        progress_callback: onProgress,
      });
    })(),
  };
  current = entry;
  // A failed load mustn't stick around: the next acquire should retry.
  entry.pipeline.catch(() => {
    if (current === entry) current = null;
  });
  if (previous && previous.users === 0) dispose(previous);
  return entry;
}

function dispose(entry: LoadedModel) {
  entry.pipeline.then((pipeline) => pipeline.dispose()).catch(() => {});
}

export function releaseModel(entry: LoadedModel) {
  entry.users--;
  if (entry.users === 0 && entry !== current) dispose(entry);
}

/** Runs one batch and returns the vectors, normalised, as one Float32Array each. */
export async function embedWithModel(entry: LoadedModel, texts: string[]): Promise<Float32Array[]> {
  const pipeline = await entry.pipeline;
  const output = await pipeline(texts, {
    pooling: entry.config.pooling,
    normalize: true,
  });
  const [n, d] = output.dims;
  const data = output.data as Float32Array;
  return Array.from({ length: n }, (_, i) => data.slice(i * d, (i + 1) * d));
}

function askBackgroundForOpenAi(texts: string[], model: string): Promise<Float32Array[]> {
  return chrome.runtime
    .sendMessage({ source: "offscreen", type: "openai-embed", texts, model })
    .then((response) => {
      if (response?.error) throw new Error(response.error);
      return (response.vectors as number[][]).map((vector) => Float32Array.from(vector));
    });
}

/** Embeds texts with a configuration, wherever that model runs. */
export async function embedTexts(config: ModelConfig, texts: string[]): Promise<Float32Array[]> {
  if (isOpenAi(config.id)) return askBackgroundForOpenAi(texts, config.id);
  const entry = acquireModel(config);
  try {
    return await embedWithModel(entry, texts);
  } finally {
    releaseModel(entry);
  }
}

export async function countTokens(config: ModelConfig, text: string): Promise<number | null> {
  if (isOpenAi(config.id)) return Math.ceil(text.length / 4);
  const entry = acquireModel(config);
  try {
    const pipeline = await entry.pipeline;
    const { input_ids } = await pipeline.tokenizer(text);
    return input_ids.size;
  } finally {
    releaseModel(entry);
  }
}
