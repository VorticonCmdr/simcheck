import { describe, expect, it, vi } from "vitest";
import { looksNonEnglish } from "../src/core/language";
import type { Dataset } from "../src/core/types";
import { applyUpdate, createJob, pruneJobs, throttle } from "../src/core/jobs";
import {
  fromLegacySettings,
  mergeSettings,
  modelKey,
  recommendedPooling,
} from "../src/core/settings";
import {
  bomEncoding,
  checkKeyColumn,
  hashText,
  parseJsonRows,
  rowText,
  suggestKeyColumn,
  suggestTextFields,
  termColumns,
  toCsv,
} from "../src/core/csv";

describe("settings", () => {
  it("adds new defaults to stored settings without losing stored values", () => {
    const merged = mergeSettings({
      activeDatasetId: "x",
      model: { id: "a/b" } as never,
    });
    expect(merged.activeDatasetId).toBe("x");
    expect(merged.model).toEqual({ id: "a/b", pooling: "mean", dtype: "fp32", device: "wasm" });
    expect(merged.msPerRow).toEqual({});
  });

  it("keeps pooling and dtype apart in the model key, but not for openai", () => {
    const base = { id: "a/b", pooling: "mean", dtype: "fp32", device: "wasm" } as const;
    expect(modelKey(base)).not.toBe(modelKey({ ...base, pooling: "cls" }));
    expect(modelKey(base)).toBe(modelKey({ ...base, device: "webgpu" }));
    expect(modelKey({ ...base, id: "openai/text-embedding-3-small" })).toBe(
      "openai/text-embedding-3-small",
    );
  });

  it("keeps what the old version embedded with", () => {
    expect(fromLegacySettings({ pipeline: { model: "a/b" } }).model).toMatchObject({
      id: "a/b",
      pooling: "cls",
    });
  });

  it("recommends mean pooling, and cls for BGE models", () => {
    expect(recommendedPooling("sentence-transformers/all-MiniLM-L6-v2")).toBe("mean");
    expect(recommendedPooling("Xenova/bge-small-en-v1.5")).toBe("cls");
  });
});

describe("jobs", () => {
  const job = () => createJob("1", "embed", "embed", null, 0);

  it("estimates time left from progress", () => {
    const started = applyUpdate(job(), { type: "progress", phase: "embedding", progress: 0 }, 5000);
    const next = applyUpdate(started, { type: "progress", progress: 0.25 }, 15000);
    expect(next.etaSeconds).toBe(30);
  });

  it("ignores updates after a job has ended", () => {
    const failed = applyUpdate(job(), { type: "error", error: "boom" }, 5);
    expect(applyUpdate(failed, { type: "progress", progress: 0.5 }, 6)).toBe(failed);
    expect(applyUpdate(failed, { type: "done" }, 6)).toBe(failed);
  });

  it("keeps running jobs and only the latest finished ones", () => {
    const finished = Array.from({ length: 5 }, (_, i) => ({
      ...createJob(String(i), "embed", "", null, 0),
      status: "done" as const,
      finishedAt: i,
    }));
    const running = createJob("r", "embed", "", null, 0);
    const kept = pruneJobs([running, ...finished], 2);
    expect(kept.map((j) => j.id).sort()).toEqual(["3", "4", "r"]);
  });

  it("throttles but always delivers the last value", () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const call = throttle<number>(100, (v) => seen.push(v));
    call(1);
    call(2);
    call(3);
    expect(seen).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([1, 3]);
    vi.useRealTimers();
  });
});

describe("csv helpers", () => {
  it("joins fields in the chosen order and leaves out empty ones", () => {
    expect(rowText({ a: "x", b: "", c: "z" }, ["c", "b", "a"])).toBe("z x");
  });

  it("takes top terms from the embedded columns unless others were chosen", () => {
    const dataset = {
      columns: ["id", "title", "body"],
      textFields: ["title", "body"],
    } as Dataset;
    expect(termColumns(dataset)).toEqual(["title", "body"]);
    expect(termColumns({ ...dataset, termFields: ["title"] })).toEqual(["title"]);
  });

  it("uses every column when a migrated dataset doesn't know what was embedded", () => {
    const dataset = { columns: ["id", "title"], textFields: [] } as unknown as Dataset;
    expect(termColumns(dataset)).toEqual(["id", "title"]);
  });

  it("ignores chosen term columns that no longer exist", () => {
    const dataset = { columns: ["title"], textFields: ["title"], termFields: ["gone"] } as Dataset;
    expect(termColumns(dataset)).toEqual(["title"]);
  });

  it("reads an encoding from a byte order mark", () => {
    expect(bomEncoding(new Uint8Array([0xff, 0xfe, 0x75]))).toBe("utf-16le");
    expect(bomEncoding(new Uint8Array([0xfe, 0xff, 0x00]))).toBe("utf-16be");
    expect(bomEncoding(new Uint8Array([0xef, 0xbb, 0xbf]))).toBe("utf-8");
    expect(bomEncoding(new Uint8Array([0x75, 0x72, 0x6c]))).toBeNull();
  });

  it("finds empty and duplicate keys", () => {
    const rows = [{ id: "1" }, { id: "1" }, { id: "" }, {}];
    expect(checkKeyColumn(rows, "id")).toEqual({ column: "id", empty: 2, duplicates: 1, usable: false });
  });

  it("suggests a usable key, preferring id-like names, and text fields", () => {
    const rows = [
      { views: "1", id: "a", body: "a long text about cats" },
      { views: "2", id: "b", body: "a long text about dogs" },
    ];
    expect(suggestKeyColumn(rows, ["views", "id", "body"])).toBe("id");
    expect(suggestKeyColumn([{ a: "1" }, { a: "1" }], ["a"])).toBeNull();
    expect(suggestTextFields(rows, ["views", "id", "body"], "id")).toEqual(["body"]);
  });

  it("detects changed text", () => {
    expect(hashText("a")).toBe(hashText("a"));
    expect(hashText("a")).not.toBe(hashText("b"));
    expect(hashText("a")).toBeGreaterThanOrEqual(0);
  });

  it("parses JSON arrays and JSONL", () => {
    expect(parseJsonRows('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(parseJsonRows('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("quotes CSV cells that need it", () => {
    expect(toCsv([{ a: 'x,"y"', b: null }], ["a", "b"])).toBe('a,b\r\n"x,""y""",');
  });
});

describe("language", () => {
  const repeat = (text: string) => Array.from({ length: 12 }, () => text);

  it("notices text that isn't English", () => {
    expect(looksNonEnglish(repeat("Ein spanisches Dorf benötigt eine neue Leitung für seinen einzigen Gasthof"))).toBe(true);
    expect(looksNonEnglish(repeat("Un village espagnol cherche quelqu'un pour reprendre son unique auberge"))).toBe(true);
  });

  it("leaves English alone, and anything too short to tell", () => {
    expect(looksNonEnglish(repeat("A Spanish village is looking for someone to run the only pub in town"))).toBe(false);
    expect(looksNonEnglish(["Ein Dorf"])).toBe(false);
    expect(looksNonEnglish(repeat("12345 67890"))).toBe(false);
  });
});
