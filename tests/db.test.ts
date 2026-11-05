import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  countEmbeddings,
  countRows,
  deleteDataset,
  embeddingCoverage,
  getProjection,
  getRows,
  listDatasets,
  loadMatrix,
  putDataset,
  putEmbeddings,
  putProjection,
  putRows,
  readRows,
  resetConnection,
} from "../src/core/db";
import { importedColumns, importedVectors, migrateLegacyData } from "../src/core/migrate";
import type { Dataset, EmbeddingRecord, Projection } from "../src/core/types";

const dataset = (id: string): Dataset => ({
  id,
  name: id,
  keyColumn: "id",
  columns: ["id"],
  textFields: [],
  rowCount: 0,
  createdAt: 0,
});
const embedding = (datasetId: string, modelKey: string, key: string, v: number[]): EmbeddingRecord => ({
  datasetId,
  modelKey,
  key,
  vector: new Float32Array(v),
  textHash: 1,
});

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetConnection();
});

describe("rows", () => {
  it("keeps datasets apart, including keys that are prefixes of each other", async () => {
    await putRows("a", [{ key: "1", data: { t: "a1" } }]);
    await putRows("ab", [{ key: "1", data: { t: "ab1" } }, { key: "2", data: {} }]);
    expect(await countRows("a")).toBe(1);
    expect(await countRows("ab")).toBe(2);
    expect((await getRows("a", ["1"])).get("1")).toEqual({ t: "a1" });
  });

  it("accepts any key, including ones IndexedDB key paths couldn't name", async () => {
    await putRows("a", [{ key: "http://x/?a=1 b", data: {} }]);
    expect((await getRows("a", ["http://x/?a=1 b"])).size).toBe(1);
  });

  it("replaces rows by default and keeps them with keepExisting", async () => {
    await putRows("a", [{ key: "1", data: { v: 1 } }]);
    const kept = await putRows("a", [{ key: "1", data: { v: 2 } }, { key: "2", data: { v: 2 } }], {
      keepExisting: true,
    });
    expect(kept).toEqual({ written: 1, skipped: 1 });
    expect((await getRows("a", ["1"])).get("1")).toEqual({ v: 1 });

    await putRows("a", [{ key: "1", data: { v: 3 } }]);
    expect((await getRows("a", ["1"])).get("1")).toEqual({ v: 3 });
  });

  it("pages through rows in key order", async () => {
    await putRows("a", ["c", "a", "b"].map((key) => ({ key, data: {} })));
    const first = await readRows("a", null, 2);
    expect(first.map((r) => r.key)).toEqual(["a", "b"]);
    const second = await readRows("a", "b", 2);
    expect(second.map((r) => r.key)).toEqual(["c"]);
  });
});

describe("embeddings", () => {
  it("reports coverage per model", async () => {
    await putEmbeddings([
      embedding("a", "m1", "1", [1, 0]),
      embedding("a", "m1", "2", [0, 1]),
      embedding("a", "m2", "1", [1, 0, 0]),
      embedding("ab", "m1", "1", [1, 0]),
    ]);
    const coverage = await embeddingCoverage("a");
    expect(coverage).toEqual([
      { modelKey: "m1", dims: 2, count: 2 },
      { modelKey: "m2", dims: 3, count: 1 },
    ]);
  });

  it("loads a normalised matrix, also across batches", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) =>
      embedding("a", "m", String(i).padStart(4, "0"), [3, 4]),
    );
    await putEmbeddings(rows);
    const { n, d, matrix, keys } = await loadMatrix("a", "m");
    expect([n, d, keys.length]).toEqual([2500, 2, 2500]);
    expect(matrix[0]).toBeCloseTo(0.6);
    expect(matrix[2 * 2499 + 1]).toBeCloseTo(0.8);
  });

  it("gives an empty matrix when a model has no embeddings", async () => {
    expect((await loadMatrix("a", "m")).n).toBe(0);
  });
});

describe("deleteDataset", () => {
  it("removes everything of that dataset and nothing else", async () => {
    await putDataset(dataset("a"));
    await putDataset(dataset("ab"));
    await putRows("a", [{ key: "1", data: {} }]);
    await putRows("ab", [{ key: "1", data: {} }]);
    await putEmbeddings([embedding("a", "m", "1", [1]), embedding("ab", "m", "1", [1])]);
    const projection = { datasetId: "a", modelKey: "m" } as Projection;
    await putProjection(projection);

    await deleteDataset("a");

    expect((await listDatasets()).map((d) => d.id)).toEqual(["ab"]);
    expect(await countRows("a")).toBe(0);
    expect(await countEmbeddings("a", "m")).toBe(0);
    expect(await getProjection("a", "m")).toBeUndefined();
    expect(await countRows("ab")).toBe(1);
    expect(await countEmbeddings("ab", "m")).toBe(1);
  });
});

describe("migrateLegacyData", () => {
  function seedLegacy(store: string, keyPath: string, rows: object[]) {
    return new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("simcheck", 4);
      open.onupgradeneeded = () => open.result.createObjectStore(store, { keyPath });
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction(store, "readwrite");
        rows.forEach((row) => tx.objectStore(store).put(row));
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
      };
    });
  }

  it("does nothing, and creates nothing, without an old database", async () => {
    const report = await migrateLegacyData((m) => m);
    expect(report).toEqual({ datasets: 0, rows: 0, embeddings: 0 });
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain("simcheck");
  });

  it("splits rows from their embeddings and drops derived fields", async () => {
    await seedLegacy(
      "reviews",
      "url",
      Array.from({ length: 1200 }, (_, i) => ({
        url: `u${i}`,
        text: `row ${i}`,
        clusterNumber: 3,
        coordinates: [1, 2],
        hnsw: { m: { neighbors: [] } },
        embeddings: { m1: new Float32Array([1, 2]), m2: new Float32Array([3]) },
      })),
    );

    const report = await migrateLegacyData((model) => `${model}|cls|fp32`);
    expect(report).toEqual({ datasets: 1, rows: 1200, embeddings: 2400 });

    const [migrated] = await listDatasets();
    expect(migrated).toMatchObject({ name: "reviews", keyColumn: "url", rowCount: 1200 });
    expect(migrated.columns.sort()).toEqual(["text", "url"]);
    expect((await getRows(migrated.id, ["u7"])).get("u7")).toEqual({ url: "u7", text: "row 7" });
    expect(await countEmbeddings(migrated.id, "m1|cls|fp32")).toBe(1200);
  });
});

describe("importing JSON rows", () => {
  it("keeps a user's columns that share a name with old derived fields", () => {
    const rows = [{ id: "a", order: 3, center: true, state: "open", embeddings: "text" }];
    expect(importedColumns(rows)).toEqual(["id", "order", "center", "state", "embeddings"]);
    expect(importedVectors(rows[0])).toEqual({});
  });

  it("removes derived fields from an export of the old version", () => {
    const rows = [{ id: "a", text: "t", order: 1, hnsw: {}, embeddings: { m: [1, 2] } }];
    expect(importedColumns(rows)).toEqual(["id", "text"]);
    expect(importedVectors(rows[0])).toEqual({ m: [1, 2] });
  });

  it("keeps every column of a backup, even one called embeddings", () => {
    const rows = [{ embeddings: "mine", order: 1, __key: "a", __embeddings: { m: [1] } }];
    expect(importedColumns(rows)).toEqual(["embeddings", "order"]);
    expect(importedVectors(rows[0])).toEqual({ m: [1] });
  });
});
