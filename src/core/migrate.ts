import { putDataset, putEmbeddings, putRows } from "./db";
import type { Dataset, EmbeddingRecord, Row } from "./types";

const LEGACY_DB = "simcheck";
const BATCH = 500;

// The old version didn't record which text was embedded. Rows with this hash
// count as up to date, so migrating doesn't trigger a costly re-embed.
export const LEGACY_TEXT_HASH = -1;

// Columns the old version added to rows; everything else is the user's data.
export const DERIVED_FIELDS = new Set([
  "embeddings",
  "hnsw",
  "clusterNumber",
  "dbscanCluster",
  "coordinates",
  "center",
  "order",
  "clicked",
]);

function openLegacy(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let created = false;
    const open = indexedDB.open(LEGACY_DB);
    open.onupgradeneeded = () => {
      // Nothing there. Abort so that looking doesn't leave an empty database.
      created = true;
      open.transaction!.abort();
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = (event) => {
      event.preventDefault();
      if (created) resolve(null);
      else reject(open.error);
    };
  });
}

function readPage(
  db: IDBDatabase,
  store: string,
  after: IDBValidKey | null,
): Promise<{ values: Row[]; keys: IDBValidKey[] }> {
  return new Promise((resolve, reject) => {
    const objectStore = db.transaction(store).objectStore(store);
    const range = after === null ? undefined : IDBKeyRange.lowerBound(after, true);
    const values = objectStore.getAll(range, BATCH);
    const keys = objectStore.getAllKeys(range, BATCH);
    keys.onsuccess = () => resolve({ values: values.result, keys: keys.result });
    keys.onerror = () => reject(keys.error);
  });
}

export interface MigrationReport {
  datasets: number;
  rows: number;
  embeddings: number;
}

/**
 * Copies the old database (one object store per dataset, embeddings and index
 * nodes inside each row) into the new stores. The old database isn't changed.
 * `modelKeyFor` says which model key vectors of a given model belong under.
 */
export async function migrateLegacyData(
  modelKeyFor: (model: string) => string,
  onProgress: (phase: string) => void = () => {},
): Promise<MigrationReport> {
  const report: MigrationReport = { datasets: 0, rows: 0, embeddings: 0 };
  const legacy = await openLegacy();
  if (!legacy) return report;

  try {
    for (const store of Array.from(legacy.objectStoreNames)) {
      onProgress(`copying ${store}`);
      const keyPath = legacy.transaction(store).objectStore(store).keyPath as string;
      // Deterministic, so a migration interrupted halfway can simply run again.
      const id = `legacy:${store}`;
      const columns = new Set<string>();
      let rowCount = 0;
      let after: IDBValidKey | null = null;

      for (;;) {
        const { values, keys } = await readPage(legacy, store, after);
        if (!values.length) break;
        after = keys[keys.length - 1];

        const rows: { key: string; data: Row }[] = [];
        const embeddings: EmbeddingRecord[] = [];
        values.forEach((value, index) => {
          const key = String(keys[index]);
          const data: Row = {};
          for (const [field, cell] of Object.entries(value)) {
            if (!DERIVED_FIELDS.has(field)) {
              data[field] = cell;
              columns.add(field);
            }
          }
          rows.push({ key, data });

          const vectors = (value.embeddings ?? {}) as Record<string, Float32Array>;
          for (const [model, vector] of Object.entries(vectors)) {
            if (vector?.length) {
              embeddings.push({
                datasetId: id,
                modelKey: modelKeyFor(model),
                key,
                vector,
                textHash: LEGACY_TEXT_HASH,
              });
            }
          }
        });

        await putRows(id, rows);
        await putEmbeddings(embeddings);
        rowCount += rows.length;
        report.rows += rows.length;
        report.embeddings += embeddings.length;
      }

      const dataset: Dataset = {
        id,
        name: store,
        keyColumn: keyPath,
        columns: [...columns],
        textFields: [],
        rowCount,
        createdAt: Date.now(),
      };
      await putDataset(dataset);
      report.datasets++;
    }
  } finally {
    legacy.close();
  }
  return report;
}

type ImportedRow = Record<string, unknown>;

const isVectorMap = (value: unknown): value is Record<string, number[]> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(Array.isArray);

/**
 * The columns of an imported JSON file. Only exports of the old version carry derived
 * fields, recognisable by their vectors and missing `__key`: in any other file a column
 * called `order` or `center` is the user's.
 */
export function importedColumns(rows: ImportedRow[]): string[] {
  const hasVectors = rows.some((row) => isVectorMap(row.embeddings));
  const oldExport = hasVectors && !rows.some((row) => "__key" in row);
  const all = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return all.filter((column) => {
    if (column === "__key" || column === "__embeddings") return false;
    if (oldExport) return !DERIVED_FIELDS.has(column);
    return !(hasVectors && column === "embeddings");
  });
}

export function importedVectors(row: ImportedRow): Record<string, number[]> {
  const vectors = row.__embeddings ?? row.embeddings;
  return isVectorMap(vectors) ? vectors : {};
}
