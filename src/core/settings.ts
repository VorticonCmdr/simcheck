export type Pooling = "mean" | "cls";
export type Dtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";
export type Device = "wasm" | "webgpu";

export interface ModelConfig {
  id: string;
  pooling: Pooling;
  dtype: Dtype;
  device: Device;
}

export interface Settings {
  activeDatasetId: string | null;
  model: ModelConfig;
  /** Measured embedding speed per model id, for estimates before a run. */
  msPerRow: Record<string, number>;
}

export const DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2";

/** Quantized, because the full model is a 470 MB download. */
export const MULTILINGUAL_MODEL = {
  id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  pooling: "mean",
  dtype: "q8",
  downloadMb: 118,
} as const;

export const defaultSettings = (): Settings => ({
  activeDatasetId: null,
  model: { id: DEFAULT_MODEL, pooling: "mean", dtype: "fp32", device: "wasm" },
  msPerRow: {},
});

export const isOpenAi = (modelId: string) => modelId.startsWith("openai/");

/**
 * Identifies a set of comparable vectors. Pooling and dtype change the vectors,
 * so embeddings from different configurations must never be mixed in one index.
 */
export function modelKey({ id, pooling, dtype }: ModelConfig): string {
  return isOpenAi(id) ? id : `${id}|${pooling}|${dtype}`;
}

export function describeModelKey(key: string): string {
  const [id, pooling, dtype] = key.split("|");
  const name = id.split("/").pop();
  return pooling ? `${name} (${pooling}, ${dtype})` : `${name}`;
}

export function recommendedPooling(modelId: string): Pooling {
  return /(^|\/)(bge-|BAAI\/)/i.test(modelId) ? "cls" : "mean";
}

/** Stored values over current defaults, so settings gain new keys when added. */
export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const defaults = defaultSettings();
  return {
    ...defaults,
    ...stored,
    model: { ...defaults.model, ...stored?.model },
    msPerRow: { ...defaults.msPerRow, ...stored?.msPerRow },
  };
}

/** The settings object of the old pages, as far as it matters here. */
export interface LegacySettings {
  pipeline?: { model?: string; pooling?: string };
  openai?: { key?: string };
}

/**
 * Keeps what the old version embedded with. Its pooling default was cls, and
 * keeping that makes migrated vectors match the active model right away.
 */
export function fromLegacySettings(legacy: LegacySettings): Partial<Settings> {
  const pooling = legacy.pipeline?.pooling;
  return {
    model: {
      id: legacy.pipeline?.model ?? DEFAULT_MODEL,
      pooling: pooling === "mean" ? "mean" : "cls",
      dtype: "fp32",
      device: "wasm",
    },
  };
}

export async function loadSettings(): Promise<Settings> {
  const { settingsV2 } = await chrome.storage.local.get("settingsV2");
  return mergeSettings(settingsV2 as Partial<Settings> | undefined);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settingsV2: settings });
}

// Kept apart from the settings object, which travels between contexts.
export async function loadOpenAiKey(): Promise<string> {
  const { openaiKey } = await chrome.storage.local.get("openaiKey");
  return (openaiKey as string) ?? "";
}

export async function saveOpenAiKey(key: string): Promise<void> {
  await chrome.storage.local.set({ openaiKey: key });
}
