import type {
  CompareResult,
  Dataset,
  EmbeddingRecord,
  Projection,
  Row,
  RowRecord,
} from "./types";
import { normalizeInPlace } from "./vector";

// All data lives in a fixed set of stores, so nothing ever needs a version bump
// at runtime: a new dataset is rows, not a schema change. Bumping this is only
// for real schema migrations.
const DB_NAME = "simcheck-v2";
const DB_VERSION = 1;

let connection: Promise<IDBDatabase> | null = null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

export function openDb(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore("datasets", { keyPath: "id" });
      db.createObjectStore("rows", { keyPath: ["datasetId", "key"] });
      db.createObjectStore("embeddings", {
        keyPath: ["datasetId", "modelKey", "key"],
      });
      db.createObjectStore("projections", { keyPath: ["datasetId", "modelKey"] });
      db.createObjectStore("results", { keyPath: "id" });
    };
    open.onsuccess = () => {
      const db = open.result;
      // Let a future schema upgrade through, and reopen on next use.
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      resolve(db);
    };
    open.onerror = () => {
      connection = null;
      reject(open.error);
    };
  });
  return connection;
}

/** For tests, which swap in a fresh IDBFactory. */
export function resetConnection() {
  connection = null;
}

// Arrays sort after every string, so [id, []] is above any key that starts with id.
const rowRange = (datasetId: string) =>
  IDBKeyRange.bound([datasetId], [datasetId, []]);
const embeddingRange = (datasetId: string, modelKey: string) =>
  IDBKeyRange.bound([datasetId, modelKey], [datasetId, modelKey, []]);
const allModelsRange = (datasetId: string) =>
  IDBKeyRange.bound([datasetId], [datasetId, []]);

export async function listDatasets(): Promise<Dataset[]> {
  const db = await openDb();
  const all = await request<Dataset[]>(db.transaction("datasets").objectStore("datasets").getAll());
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getDataset(id: string): Promise<Dataset | undefined> {
  const db = await openDb();
  return request<Dataset | undefined>(db.transaction("datasets").objectStore("datasets").get(id));
}

export async function putDataset(dataset: Dataset): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("datasets", "readwrite");
  tx.objectStore("datasets").put(dataset);
  await done(tx);
}

export async function deleteDataset(id: string): Promise<void> {
  const db = await openDb();
  const stores = ["datasets", "rows", "embeddings", "projections"];
  const tx = db.transaction(stores, "readwrite");
  tx.objectStore("datasets").delete(id);
  tx.objectStore("rows").delete(rowRange(id));
  tx.objectStore("embeddings").delete(allModelsRange(id));
  tx.objectStore("projections").delete(allModelsRange(id));
  await done(tx);
}

export interface PutRowsResult {
  written: number;
  skipped: number;
}

/**
 * Writes rows in one transaction, so a failed batch leaves nothing behind. With
 * keepExisting, keys already in the dataset stay as they are.
 */
export async function putRows(
  datasetId: string,
  rows: { key: string; data: Row }[],
  { keepExisting = false } = {},
): Promise<PutRowsResult> {
  const db = await openDb();
  const tx = db.transaction("rows", "readwrite");
  const store = tx.objectStore("rows");
  let skipped = 0;
  for (const { key, data } of rows) {
    const record: RowRecord = { datasetId, key, data };
    if (keepExisting) {
      const add = store.add(record);
      add.onerror = (event) => {
        if (add.error?.name === "ConstraintError") {
          event.preventDefault();
          event.stopPropagation();
          skipped++;
        }
      };
    } else {
      store.put(record);
    }
  }
  await done(tx);
  return { written: rows.length - skipped, skipped };
}

export async function countRows(datasetId: string): Promise<number> {
  const db = await openDb();
  return request(db.transaction("rows").objectStore("rows").count(rowRange(datasetId)));
}

/** One page of rows after `afterKey`, in key order. */
export async function readRows(
  datasetId: string,
  afterKey: string | null,
  limit: number,
): Promise<RowRecord[]> {
  const db = await openDb();
  const range =
    afterKey === null
      ? rowRange(datasetId)
      : IDBKeyRange.bound([datasetId, afterKey], [datasetId, []], true);
  return request<RowRecord[]>(db.transaction("rows").objectStore("rows").getAll(range, limit));
}

export async function getRows(
  datasetId: string,
  keys: string[],
): Promise<Map<string, Row>> {
  const db = await openDb();
  const store = db.transaction("rows").objectStore("rows");
  const records = await Promise.all(
    keys.map((key) => request<RowRecord | undefined>(store.get([datasetId, key]))),
  );
  const found = new Map<string, Row>();
  records.forEach((record) => record && found.set(record.key, record.data));
  return found;
}

export async function putEmbeddings(records: EmbeddingRecord[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("embeddings", "readwrite");
  const store = tx.objectStore("embeddings");
  records.forEach((record) => store.put(record));
  await done(tx);
}

/** The stored text hash per key; keys without an embedding are left out. */
export async function getEmbeddingHashes(
  datasetId: string,
  modelKey: string,
  keys: string[],
): Promise<Map<string, number>> {
  const db = await openDb();
  const store = db.transaction("embeddings").objectStore("embeddings");
  const records = await Promise.all(
    keys.map((key) =>
      request<EmbeddingRecord | undefined>(store.get([datasetId, modelKey, key])),
    ),
  );
  const hashes = new Map<string, number>();
  records.forEach((record) => record && hashes.set(record.key, record.textHash));
  return hashes;
}

/** One page of a model's embeddings after `afterKey`, in key order. */
export async function readEmbeddings(
  datasetId: string,
  modelKey: string,
  afterKey: string | null,
  limit: number,
): Promise<EmbeddingRecord[]> {
  const db = await openDb();
  const range =
    afterKey === null
      ? embeddingRange(datasetId, modelKey)
      : IDBKeyRange.bound([datasetId, modelKey, afterKey], [datasetId, modelKey, []], true);
  return request<EmbeddingRecord[]>(
    db.transaction("embeddings").objectStore("embeddings").getAll(range, limit),
  );
}

export async function getEmbedding(
  datasetId: string,
  modelKey: string,
  key: string,
): Promise<Float32Array | undefined> {
  const db = await openDb();
  const record = await request<EmbeddingRecord | undefined>(
    db.transaction("embeddings").objectStore("embeddings").get([datasetId, modelKey, key]),
  );
  return record?.vector;
}

export async function countEmbeddings(datasetId: string, modelKey: string): Promise<number> {
  const db = await openDb();
  return request(
    db.transaction("embeddings").objectStore("embeddings").count(embeddingRange(datasetId, modelKey)),
  );
}

export interface EmbeddingCoverage {
  modelKey: string;
  count: number;
  dims: number;
}

/** Which models have embeddings for a dataset, without reading the vectors of all. */
export async function embeddingCoverage(datasetId: string): Promise<EmbeddingCoverage[]> {
  const db = await openDb();
  const store = db.transaction("embeddings").objectStore("embeddings");
  const firsts: EmbeddingRecord[] = await new Promise((resolve, reject) => {
    const found: EmbeddingRecord[] = [];
    const cursor = store.openCursor(allModelsRange(datasetId));
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) return resolve(found);
      const record = current.value as EmbeddingRecord;
      found.push(record);
      current.continue([datasetId, record.modelKey, []]);
    };
  });
  return Promise.all(
    firsts.map(async ({ modelKey, vector }) => ({
      modelKey,
      dims: vector.length,
      count: await countEmbeddings(datasetId, modelKey),
    })),
  );
}

export interface VectorMatrix {
  keys: string[];
  n: number;
  d: number;
  /** n×d, every row unit length, so a dot product is a cosine. */
  matrix: Float32Array;
}

/** Loads a dataset's vectors into one contiguous matrix, a batch at a time. */
export async function loadMatrix(datasetId: string, modelKey: string): Promise<VectorMatrix> {
  const db = await openDb();
  const total = await countEmbeddings(datasetId, modelKey);
  if (total === 0) return { keys: [], n: 0, d: 0, matrix: new Float32Array(0) };

  const keys: string[] = [];
  let matrix: Float32Array | null = null;
  let d = 0;
  let after: string | null = null;
  while (keys.length < total) {
    const range: IDBKeyRange =
      after === null
        ? embeddingRange(datasetId, modelKey)
        : IDBKeyRange.bound([datasetId, modelKey, after], [datasetId, modelKey, []], true);
    const page: EmbeddingRecord[] = await request(
      db.transaction("embeddings").objectStore("embeddings").getAll(range, 2000),
    );
    if (!page.length) break;
    for (const { key, vector } of page) {
      matrix ??= new Float32Array(total * (d = vector.length));
      if (vector.length !== d) continue; // can't be compared with the others
      const row = matrix.subarray(keys.length * d, (keys.length + 1) * d);
      row.set(vector);
      normalizeInPlace(row);
      keys.push(key);
    }
    after = page[page.length - 1].key;
  }
  return {
    keys,
    n: keys.length,
    d,
    matrix: matrix!.subarray(0, keys.length * d),
  };
}

export async function putProjection(projection: Projection): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("projections", "readwrite");
  tx.objectStore("projections").put(projection);
  await done(tx);
}

export async function getProjection(
  datasetId: string,
  modelKey: string,
): Promise<Projection | undefined> {
  const db = await openDb();
  const stored = await request<(Projection & { dbscan?: { eps: number; minPts: number } }) | undefined>(
    db.transaction("projections").objectStore("projections").get([datasetId, modelKey]),
  );
  if (!stored?.dbscan) return stored;
  // Stored before there was a choice of method.
  const { dbscan, ...rest } = stored;
  return { ...rest, clustering: { method: "dbscan", minClusterSize: 0, ...dbscan } };
}

export async function putResult(result: CompareResult): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("results", "readwrite");
  tx.objectStore("results").put(result);
  await done(tx);
}

export async function getResult(id: string): Promise<CompareResult | undefined> {
  const db = await openDb();
  return request<CompareResult | undefined>(db.transaction("results").objectStore("results").get(id));
}

export async function datasetExists(name: string): Promise<Dataset | undefined> {
  return (await listDatasets()).find((dataset) => dataset.name === name);
}
