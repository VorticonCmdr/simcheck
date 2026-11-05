import { getRows, readRows, readEmbeddings, embeddingCoverage } from "../core/db";
import type { ClusterSummary, Dataset, Row } from "../core/types";

export function saveFile(filename: string, type: string, content: BlobPart) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/[/\\?%*:|"<>]/g, "_");
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function allRows(datasetId: string): Promise<Map<string, Row>> {
  const rows = new Map<string, Row>();
  let after: string | null = null;
  for (;;) {
    const page = await readRows(datasetId, after, 2000);
    if (!page.length) return rows;
    after = page[page.length - 1].key;
    for (const row of page) rows.set(row.key, row.data);
  }
}

/** Rows plus their vectors, gzipped, in a form the import step reads back. */
export async function exportBackup(dataset: Dataset): Promise<Blob> {
  const rows = await allRows(dataset.id);
  const vectors = new Map<string, Record<string, number[]>>();
  for (const { modelKey } of await embeddingCoverage(dataset.id)) {
    let after: string | null = null;
    for (;;) {
      const page = await readEmbeddings(dataset.id, modelKey, after, 2000);
      if (!page.length) break;
      after = page[page.length - 1].key;
      for (const { key, vector } of page) {
        const entry = vectors.get(key) ?? {};
        entry[modelKey] = Array.from(vector);
        vectors.set(key, entry);
      }
    }
  }
  const chunks: string[] = [];
  for (const [key, data] of rows) {
    chunks.push(JSON.stringify({ ...data, __key: key, __embeddings: vectors.get(key) ?? {} }) + "\n");
  }
  const stream = new Blob(chunks).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

export async function readText(file: File): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return file.text();
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "–";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export { getRows };

export const isDark = () => document.documentElement.dataset.bsTheme === "dark";

export const clusterName = (cluster: ClusterSummary) =>
  cluster.terms.slice(0, 3).join(", ") || `cluster ${cluster.id}`;
