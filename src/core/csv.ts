import type { Dataset, Row } from "./types";

/** The encoding a file's first bytes declare, if they do. */
export function bomEncoding(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  return null;
}

/** FNV-1a. Only has to tell changed text from unchanged, not resist anyone. */
export function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function rowText(row: Row, fields: string[]): string {
  return fields
    .map((field) => row[field])
    .filter((value) => value !== undefined && value !== null && value !== "")
    .join(" ");
}

/** Migrated datasets don't know which fields were embedded: use all of them. */
export function embeddedColumns(dataset: Dataset): string[] {
  return dataset.textFields.length ? dataset.textFields : dataset.columns;
}

/** Falls back to the embedded columns when none of the chosen ones exist any more. */
export function termColumns(dataset: Dataset): string[] {
  const chosen = dataset.termFields?.filter((field) => dataset.columns.includes(field)) ?? [];
  return chosen.length ? chosen : embeddedColumns(dataset);
}

export interface KeyCheck {
  column: string;
  empty: number;
  duplicates: number;
  usable: boolean;
}

export function checkKeyColumn(rows: Row[], column: string): KeyCheck {
  const seen = new Set<string>();
  let empty = 0;
  let duplicates = 0;
  for (const row of rows) {
    const value = row[column];
    if (value === undefined || value === null || value === "") empty++;
    else if (seen.has(String(value))) duplicates++;
    else seen.add(String(value));
  }
  return { column, empty, duplicates, usable: empty === 0 && duplicates === 0 };
}

/** The first column that can identify every row, preferring id-like names. */
export function suggestKeyColumn(rows: Row[], columns: string[]): string | null {
  const ranked = [...columns].sort(
    (a, b) => Number(/^(id|key|uuid|url)$/i.test(b)) - Number(/^(id|key|uuid|url)$/i.test(a)),
  );
  return ranked.find((column) => checkKeyColumn(rows, column).usable) ?? null;
}

export function isBinaryLookingColumn(rows: Row[], column: string): boolean {
  return rows.slice(0, 50).every((row) => {
    const value = String(row[column] ?? "");
    return value === "" || /^[-+.\d\s:/]+$/.test(value);
  });
}

/** Text columns are the ones that aren't just numbers and dates. */
export function suggestTextFields(rows: Row[], columns: string[], key: string | null): string[] {
  const candidates = columns.filter(
    (column) => column !== key && !isBinaryLookingColumn(rows, column),
  );
  const averageLength = (column: string) =>
    rows.slice(0, 50).reduce((sum, row) => sum + String(row[column] ?? "").length, 0);
  return candidates.sort((a, b) => averageLength(b) - averageLength(a)).slice(0, 1);
}

/** Rows from JSON or JSONL text, as an array of objects. */
export function parseJsonRows(text: string): Row[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("expected an array of objects");
    return parsed;
  }
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function toCsv(rows: Row[], columns: string[]): string {
  const cell = (value: unknown) => {
    const text = value === undefined || value === null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns, ...rows.map((row) => columns.map((column) => row[column]))]
    .map((line) => line.map(cell).join(","))
    .join("\r\n");
}

export function toJsonl(rows: Row[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}
