// Everything long-running lives here: this document stays up while tabs come and
// go and while the service worker sleeps. chrome.storage isn't available in it,
// so all configuration arrives in messages.
import { hashText, rowText } from "../core/csv";
import {
  countRows,
  embeddingCoverage,
  getDataset,
  getEmbeddingHashes,
  listDatasets,
  putDataset,
  putEmbeddings,
  putRows,
  readEmbeddings,
  readRows,
} from "../core/db";
import { throttle, type JobUpdate } from "../core/jobs";
import { LEGACY_TEXT_HASH, migrateLegacyData } from "../core/migrate";
import type {
  ClusterPayload,
  ComparePayload,
  DownloadPayload,
  EmbedPayload,
  MergePayload,
  MigratePayload,
  ReclusterPayload,
} from "../core/protocol";
import { isOpenAi, type ModelConfig } from "../core/settings";
import type { EmbeddingRecord } from "../core/types";
import { normalizeInPlace } from "../core/vector";
import {
  acquireModel,
  countTokens,
  embedTexts,
  embedWithModel,
  releaseModel,
  type LoadedModel,
} from "./models";

const ROW_PAGE = 256;
const LOCAL_BATCH = 32;
const OPENAI_BATCH = 256;

function report(jobId: string, update: JobUpdate) {
  chrome.runtime
    .sendMessage({ source: "offscreen", type: "job-update", jobId, update })
    .catch(() => {});
}

function progressReporter(jobId: string) {
  return throttle<JobUpdate>(250, (update) => report(jobId, update));
}

class Cancelled extends Error {}

const cancelHandlers = new Map<string, () => void>();

interface EmbedResult {
  embedded: number;
  unchanged: number;
  emptyText: number;
  msPerRow: number | null;
  modelId: string;
}

async function runEmbed(jobId: string, payload: EmbedPayload): Promise<EmbedResult> {
  const { datasetId, fields, model, modelKey, force } = payload;
  const dataset = await getDataset(datasetId);
  if (!dataset) throw new Error("dataset not found");
  await putDataset({ ...dataset, textFields: fields });

  let cancelled = false;
  cancelHandlers.set(jobId, () => (cancelled = true));

  const progress = progressReporter(jobId);
  const local = !isOpenAi(model.id);
  let entry: LoadedModel | null = null;

  try {
    if (local) {
      progress({ type: "progress", phase: "loading model", progress: null });
      entry = acquireModel(model, (info) => {
        if (info.status === "progress" && info.progress !== undefined) {
          progress({ type: "progress", phase: "downloading model", progress: info.progress / 100 });
        }
      });
      await entry.pipeline;
    }

    const total = await countRows(datasetId);
    const batchSize = local ? LOCAL_BATCH : OPENAI_BATCH;
    const result: EmbedResult = { embedded: 0, unchanged: 0, emptyText: 0, msPerRow: null, modelId: model.id };
    let processed = 0;
    let embedMs = 0;
    let after: string | null = null;

    for (;;) {
      const page = await readRows(datasetId, after, ROW_PAGE);
      if (!page.length) break;
      after = page[page.length - 1].key;

      const hashes = force
        ? new Map<string, number>()
        : await getEmbeddingHashes(datasetId, modelKey, page.map((row) => row.key));

      const todo: { key: string; text: string; textHash: number }[] = [];
      for (const row of page) {
        const text = rowText(row.data, fields);
        const textHash = hashText(text);
        const stored = hashes.get(row.key);
        if (!text) result.emptyText++;
        else if (stored === textHash || stored === LEGACY_TEXT_HASH) result.unchanged++;
        else todo.push({ key: row.key, text, textHash });
      }

      for (let i = 0; i < todo.length; i += batchSize) {
        if (cancelled) throw new Cancelled();
        const batch = todo.slice(i, i + batchSize);
        const started = performance.now();
        const vectors = entry
          ? await embedWithModel(entry, batch.map((item) => item.text))
          : await embedTexts(model, batch.map((item) => item.text));
        embedMs += performance.now() - started;

        // Written batch by batch: anything that stops the job only loses this batch,
        // and running it again picks up from here through the text hashes.
        const records: EmbeddingRecord[] = batch.map(({ key, textHash }, index) => ({
          datasetId,
          modelKey,
          key,
          textHash,
          vector: vectors[index],
        }));
        await putEmbeddings(records);
        result.embedded += batch.length;
        progress({
          type: "progress",
          phase: "embedding",
          progress: (processed + i + batch.length) / total,
        });
      }
      processed += page.length;
      progress({ type: "progress", phase: "embedding", progress: processed / total });
    }

    if (result.embedded) result.msPerRow = embedMs / result.embedded;
    progress.flush();
    vectorWorker().postMessage({ op: "clear" });
    return result;
  } finally {
    if (entry) releaseModel(entry);
    cancelHandlers.delete(jobId);
  }
}

async function runDownload(jobId: string, { model }: DownloadPayload) {
  const progress = progressReporter(jobId);
  const entry = acquireModel(model, (info) => {
    if (info.status === "progress" && info.progress !== undefined) {
      progress({
        type: "progress",
        phase: info.file ? `downloading ${info.file}` : "downloading",
        progress: info.progress / 100,
      });
    }
  });
  try {
    await entry.pipeline;
    progress.flush();
  } finally {
    releaseModel(entry);
  }
}

// ── workers ──────────────────────────────────────────────────────────────────

let searchWorker: Worker | null = null;
let searchCalls = 0;
const pendingSearches = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

const newVectorWorker = () =>
  new Worker(new URL("./vector.worker.ts", import.meta.url), { type: "module" });

function vectorWorker(): Worker {
  if (searchWorker) return searchWorker;
  searchWorker = newVectorWorker();
  searchWorker.onmessage = ({ data }) => {
    const pending = pendingSearches.get(data.callId);
    if (!pending) return;
    pendingSearches.delete(data.callId);
    if (data.error) pending.reject(new Error(data.error));
    else pending.resolve(data.hits);
  };
  return searchWorker;
}

function searchVectors(datasetId: string, modelKey: string, query: Float32Array, k: number) {
  return new Promise((resolve, reject) => {
    const callId = ++searchCalls;
    pendingSearches.set(callId, { resolve, reject });
    vectorWorker().postMessage({ op: "search", callId, datasetId, modelKey, query, k });
  });
}

/** Runs a worker for one job. Terminating it is what makes heavy work cancellable. */
function runInWorker(jobId: string, worker: Worker, message: unknown): Promise<unknown> {
  const progress = progressReporter(jobId);
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void) => {
      worker.terminate();
      cancelHandlers.delete(jobId);
      progress.flush();
      settle();
    };
    cancelHandlers.set(jobId, () => finish(() => reject(new Cancelled())));
    worker.onerror = (event) => finish(() => reject(new Error(event.message || "worker failed")));
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        progress({ type: "progress", phase: data.phase, progress: data.progress ?? null });
      } else if (data.type === "done") {
        finish(() => resolve(data.result));
      } else if (data.type === "error") {
        finish(() => reject(new Error(data.error)));
      }
    };
    worker.postMessage(message);
  });
}

const clusterWorker = () =>
  new Worker(new URL("./cluster.worker.ts", import.meta.url), { type: "module" });

// ── other jobs ───────────────────────────────────────────────────────────────

async function runMerge(jobId: string, { name, datasetIds }: MergePayload) {
  const progress = progressReporter(jobId);
  const sources = (await listDatasets()).filter((d) => datasetIds.includes(d.id));
  const id = crypto.randomUUID();
  const totalRows = sources.reduce((sum, d) => sum + d.rowCount, 0);
  const columns = new Set<string>(["dataset"]);
  const textFields = new Set<string>();
  let copied = 0;

  for (const source of sources) {
    source.columns.forEach((column) => columns.add(column));
    source.textFields.forEach((field) => textFields.add(field));
    // Same key in two sources is two rows here, so the source is part of the key.
    const mergedKey = (key: string) => `${source.name}:${key}`;

    let after: string | null = null;
    for (;;) {
      const page = await readRows(source.id, after, ROW_PAGE);
      if (!page.length) break;
      after = page[page.length - 1].key;
      await putRows(
        id,
        page.map((row) => ({
          key: mergedKey(row.key),
          data: { ...row.data, dataset: source.name },
        })),
      );
      copied += page.length;
      progress({ type: "progress", phase: "copying rows", progress: copied / totalRows });
    }

    for (const { modelKey } of await embeddingCoverage(source.id)) {
      let afterVector: string | null = null;
      for (;;) {
        const page = await readEmbeddings(source.id, modelKey, afterVector, ROW_PAGE);
        if (!page.length) break;
        afterVector = page[page.length - 1].key;
        await putEmbeddings(
          page.map((record) => ({ ...record, datasetId: id, key: mergedKey(record.key) })),
        );
      }
    }
  }

  await putDataset({
    id,
    name,
    keyColumn: null,
    columns: [...columns],
    textFields: [...textFields],
    rowCount: totalRows,
    createdAt: Date.now(),
  });
  progress.flush();
  return { datasetId: id };
}

async function runJob(jobId: string, kind: string, payload: any): Promise<unknown> {
  switch (kind) {
    case "embed":
      return runEmbed(jobId, payload as EmbedPayload);
    case "download":
      return runDownload(jobId, payload as DownloadPayload);
    case "cluster":
      return runInWorker(jobId, clusterWorker(), { op: "cluster", ...(payload as ClusterPayload) });
    case "recluster":
      return runInWorker(jobId, clusterWorker(), { op: "recluster", ...(payload as ReclusterPayload) });
    case "compare":
      return runInWorker(jobId, newVectorWorker(), { op: "compare", ...(payload as ComparePayload) });
    case "merge":
      return runMerge(jobId, payload as MergePayload);
    case "migrate": {
      const { pooling } = payload as MigratePayload;
      const progress = progressReporter(jobId);
      const result = await migrateLegacyData(
        (model) => (isOpenAi(model) ? model : `${model}|${pooling}|fp32`),
        (phase) => progress({ type: "progress", phase }),
      );
      progress.flush();
      return result;
    }
    default:
      throw new Error(`unknown job kind ${kind}`);
  }
}

// What's really running here, as opposed to what the service worker's registry says.
const activeJobs = new Set<string>();

function startJob(jobId: string, kind: string, payload: unknown) {
  activeJobs.add(jobId);
  runJob(jobId, kind, payload)
    .then((result) => report(jobId, { type: "done", result }))
    .catch((error) => {
      if (error instanceof Cancelled) report(jobId, { type: "cancelled" });
      else {
        console.error(`[offscreen] ${kind} failed`, error);
        report(jobId, { type: "error", error: error?.message ?? String(error) });
      }
    })
    .finally(() => activeJobs.delete(jobId));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  (async () => {
    switch (message.action) {
      case "startJob":
        startJob(message.jobId, message.kind, message.payload);
        return { started: true };
      case "activeJobs":
        return { jobIds: [...activeJobs] };
      case "cancelJob": {
        const cancel = cancelHandlers.get(message.jobId);
        if (!cancel) return { cancelled: false };
        cancel();
        return { cancelled: true };
      }
      case "search": {
        const { datasetId, modelKey, model, query, k } = message as {
          datasetId: string;
          modelKey: string;
          model: ModelConfig;
          query: string;
          k: number;
        };
        const [vector] = await embedTexts(model, [query]);
        const hits = await searchVectors(datasetId, modelKey, normalizeInPlace(vector), k);
        return { hits };
      }
      case "tokens":
        return { count: await countTokens(message.model, message.text) };
      case "testModel": {
        const started = performance.now();
        const [vector] = await embedTexts(message.model, [
          "The quick brown fox jumps over the lazy dog.",
        ]);
        return { dims: vector.length, ms: Math.round(performance.now() - started) };
      }
      default:
        throw new Error(`unknown action ${message.action}`);
    }
  })()
    .then(sendResponse)
    .catch((error) => {
      console.error("[offscreen]", message.action, error);
      sendResponse({ error: error?.message ?? String(error) });
    });

  return true; // the response is sent asynchronously
});
