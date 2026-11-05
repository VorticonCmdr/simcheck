import { countEmbeddings, loadMatrix, putResult, type VectorMatrix } from "../core/db";
import type { CompareRow } from "../core/types";
import { bestMatches, searchMatrix } from "../core/vector";

// One dataset stays in memory, so repeated searches don't touch IndexedDB.
let cached: { id: string; data: VectorMatrix } | null = null;

async function matrixFor(datasetId: string, modelKey: string): Promise<VectorMatrix> {
  const id = `${datasetId}|${modelKey}`;
  const count = await countEmbeddings(datasetId, modelKey);
  if (cached?.id === id && cached.data.n === count) return cached.data;
  const data = await loadMatrix(datasetId, modelKey);
  cached = { id, data };
  return data;
}

async function search({ datasetId, modelKey, query, k }: any) {
  const { matrix, n, d, keys } = await matrixFor(datasetId, modelKey);
  if (n === 0) return [];
  if (d !== query.length) {
    throw new Error(`this dataset has ${d}-dimensional vectors, the query has ${query.length}`);
  }
  return searchMatrix(matrix, n, d, query, k).map(({ index, score }) => ({
    key: keys[index],
    score,
  }));
}

const shared = (source: Float32Array) => {
  const copy = new Float32Array(new SharedArrayBuffer(source.byteLength));
  copy.set(source);
  return copy;
};

/** Splits the rows of A over the cores. Threads need the page to be cross-origin isolated. */
async function compareInParallel(a: VectorMatrix, b: VectorMatrix) {
  const threads = self.crossOriginIsolated ? Math.max(1, navigator.hardwareConcurrency - 1) : 1;
  const bestIndex = new Int32Array(new SharedArrayBuffer(a.n * 4));
  const bestScore = new Float32Array(new SharedArrayBuffer(a.n * 4));

  if (threads === 1) {
    let finished = 0;
    bestMatches(a.matrix, b.matrix, a.d, b.n, 0, a.n, bestIndex, bestScore, (rows) => {
      finished += rows;
      postMessage({ type: "progress", phase: "comparing", progress: finished / a.n });
    });
    return { bestIndex, bestScore };
  }

  const matrixA = shared(a.matrix);
  const matrixB = shared(b.matrix);
  let finished = 0;
  let lastReport = 0;
  await Promise.all(
    Array.from({ length: threads }, (_, shard) => {
      const start = Math.floor((shard * a.n) / threads);
      const end = Math.floor(((shard + 1) * a.n) / threads);
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL("./compareShard.worker.ts", import.meta.url), { type: "module" });
        worker.onerror = (event) => reject(new Error(event.message || "compare worker failed"));
        worker.onmessage = ({ data }) => {
          if (data.done) {
            worker.terminate();
            resolve();
            return;
          }
          finished += data.rows;
          if (performance.now() - lastReport > 250) {
            lastReport = performance.now();
            postMessage({ type: "progress", phase: "comparing", progress: finished / a.n });
          }
        };
        worker.postMessage({ a: matrixA, b: matrixB, d: a.d, nB: b.n, start, end, bestIndex, bestScore });
      });
    }),
  );
  return { bestIndex, bestScore };
}

async function compare({ datasetA, datasetB, modelKey }: any) {
  const a = await loadMatrix(datasetA, modelKey);
  const b = await loadMatrix(datasetB, modelKey);
  if (!a.n || !b.n) throw new Error("both datasets need embeddings for this model");
  if (a.d !== b.d) throw new Error(`can't compare ${a.d} with ${b.d} dimensions`);

  const { bestIndex, bestScore } = await compareInParallel(a, b);
  const rows: CompareRow[] = a.keys.map((key, i) => ({
    key,
    bestKey: b.keys[bestIndex[i]],
    score: bestScore[i],
  }));

  const id = `${datasetA}|${datasetB}|${modelKey}`;
  await putResult({ id, datasetA, datasetB, modelKey, rows, createdAt: Date.now() });
  return { resultId: id, rows: rows.length };
}

self.onmessage = async ({ data }) => {
  switch (data.op) {
    case "clear":
      cached = null;
      break;
    case "search":
      try {
        postMessage({ callId: data.callId, hits: await search(data) });
      } catch (error: any) {
        postMessage({ callId: data.callId, error: error.message });
      }
      break;
    case "compare":
      try {
        postMessage({ type: "done", result: await compare(data) });
      } catch (error: any) {
        postMessage({ type: "error", error: error.message });
      }
      break;
  }
};
