import Papa from "papaparse";
import { useMemo, useRef, useState } from "preact/hooks";
import {
  bomEncoding, checkKeyColumn,
  parseJsonRows,
  rowText,
  suggestKeyColumn,
  suggestTextFields,
} from "../../core/csv";
import { countRows, putDataset, putEmbeddings, putRows } from "../../core/db";
import { importedColumns, importedVectors, LEGACY_TEXT_HASH } from "../../core/migrate";
import type { Dataset, EmbeddingRecord, Row } from "../../core/types";
import { EmbedAction, ExamplePreview, FieldPicker } from "../embedPanel";
import { datasets, go, refreshDatasets, selectDataset, showError, showSuccess } from "../state";
import { readText } from "../util";

const GENERATED = "__generated";
const WRITE_BATCH = 2000;

interface Parsed {
  fileName: string;
  rows: Row[];
  columns: string[];
  errors: string[];
  /** All of them, while `errors` keeps the first few to show. */
  problems: number;
}

/** Never occurs in text, so nothing counts as a quote. */
const NO_QUOTES = "\uFFFE";

function parseCsv(
  file: File,
  encoding: string,
  onProgress: (rows: number) => void,
  quoteChar = '"',
): Promise<Parsed> {
  return new Promise((resolve, reject) => {
    const rows: Row[] = [];
    const errors: string[] = [];
    let problems = 0;
    let columns: string[] = [];
    // Papa's worker option needs a blob: script, which the CSP rightly refuses.
    // Chunks keep the page responsive anyway.
    Papa.parse<Row>(file, {
      header: true,
      skipEmptyLines: "greedy",
      encoding,
      quoteChar,
      chunk: (result) => {
        columns = result.meta.fields ?? columns;
        for (const row of result.data) rows.push(row);
        for (const error of result.errors) {
          problems++;
          if (errors.length < 5) errors.push(`row ${error.row ?? "?"}: ${error.message}`);
        }
        onProgress(rows.length);
      },
      complete: () => resolve({ fileName: file.name, rows, columns, errors, problems }),
      error: (error) => reject(error),
    });
  });
}

async function parseFile(file: File, encoding: string, onProgress: (n: number) => void): Promise<Parsed> {
  if (/\.(jsonl?|ndjson)(\.gz)?$/i.test(file.name) || /\.gz$/i.test(file.name)) {
    const rows = parseJsonRows(await readText(file));
    return { fileName: file.name, rows, columns: importedColumns(rows), errors: [], problems: 0 };
  }
  const parsed = await parseCsv(file, encoding, onProgress);
  if (!parsed.problems) return parsed;
  // Exports that don't quote at all can have a title like "Quoted" start a field,
  // which swallows the rows after it. Such files parse cleanly taken literally.
  const literal = await parseCsv(file, encoding, onProgress, NO_QUOTES);
  return literal.problems < parsed.problems ? literal : parsed;
}

const baseName = (fileName: string) => fileName.replace(/(\.(csv|tsv|txt|jsonl?|ndjson|gz))+$/i, "");

function Preview({ parsed }: { parsed: Parsed }) {
  return (
    <div class="preview-table border rounded mt-3">
      <table class="table table-sm mb-0">
        <thead>
          <tr>{parsed.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr>
        </thead>
        <tbody>
          {parsed.rows.slice(0, 20).map((row, i) => (
            <tr key={i}>{parsed.columns.map((column) => <td key={column}>{String(row[column] ?? "")}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Vectors in a backup or an export of the old version.
function vectorsOf(row: Row, datasetId: string, key: string): EmbeddingRecord[] {
  return Object.entries(importedVectors(row))
    .filter(([, vector]) => vector?.length)
    .map(([model, vector]) => ({
      datasetId,
      key,
      // no pooling in the key means the old format, which defaulted to cls
      modelKey: model.includes("|") || model.startsWith("openai/") ? model : `${model}|cls|fp32`,
      vector: Float32Array.from(vector),
      textHash: LEGACY_TEXT_HASH,
    }));
}

export function ImportView() {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parsing, setParsing] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [encoding, setEncoding] = useState("utf-8");
  const file = useRef<File | null>(null);

  const [appendTo, setAppendTo] = useState("");
  const [name, setName] = useState("");
  const [keyColumn, setKeyColumn] = useState("");
  const [fields, setFields] = useState<string[]>([]);
  const [keepExisting, setKeepExisting] = useState(true);
  const [saved, setSaved] = useState<number | null>(null);

  const target = datasets.value.find((d) => d.id === appendTo) ?? null;
  const effectiveKey = target ? (target.keyColumn ?? GENERATED) : keyColumn;

  const load = async (next: File, chosenEncoding?: string) => {
    file.current = next;
    setParsing(0);
    try {
      const declared = bomEncoding(new Uint8Array(await next.slice(0, 3).arrayBuffer()));
      // UTF-16 without a mark of its own is rare, and only garbles any other file.
      const nextEncoding = chosenEncoding ?? declared ?? (encoding.startsWith("utf-16") ? "utf-8" : encoding);
      setEncoding(nextEncoding);
      const result = await parseFile(next, nextEncoding, setParsing);
      if (!result.rows.length) throw new Error(`no rows found in ${next.name}`);
      const key = result.rows[0].__key !== undefined ? GENERATED : suggestKeyColumn(result.rows, result.columns);
      setParsed(result);
      // A new file starts over: it mustn't quietly go where the last one went.
      setAppendTo("");
      setName(baseName(next.name));
      setKeyColumn(key ?? GENERATED);
      setFields(suggestTextFields(result.rows, result.columns, key));
    } catch (error) {
      showError(new Error(`could not read ${next.name}: ${(error as Error).message}`));
    } finally {
      setParsing(null);
    }
  };

  const check = useMemo(
    () =>
      parsed && effectiveKey && effectiveKey !== GENERATED
        ? checkKeyColumn(parsed.rows, effectiveKey)
        : null,
    [parsed, effectiveKey],
  );
  const nameTaken = !target && datasets.value.some((d) => d.name === name.trim());
  const keyProblem = check && !check.usable
    ? `"${check.column}" can't identify rows: ${[
        check.empty && `${check.empty} empty`,
        check.duplicates && `${check.duplicates} duplicates`,
      ].filter(Boolean).join(", ")}.`
    : null;
  const ready = !!parsed && !keyProblem && !!name.trim() && !nameTaken;

  const save = async (): Promise<Dataset | null> => {
    if (!parsed || !ready) return null;
    const id = target?.id ?? crypto.randomUUID();
    const offset = target?.rowCount ?? 0;
    let skipped = 0;
    setSaved(0);
    try {
      for (let i = 0; i < parsed.rows.length; i += WRITE_BATCH) {
        const batch = parsed.rows.slice(i, i + WRITE_BATCH).map((row, index) => {
          const { __key } = row;
          const embeddings = importedVectors(row);
          const data = Object.fromEntries(parsed.columns.map((column) => [column, row[column]]));
          const key =
            __key !== undefined
              ? String(__key)
              : effectiveKey === GENERATED
                ? String(offset + i + index).padStart(9, "0")
                : String(row[effectiveKey]);
          return { key, data, embeddings };
        });
        const result = await putRows(id, batch, { keepExisting: !!target && keepExisting });
        skipped += result.skipped;
        await putEmbeddings(batch.flatMap(({ key, embeddings }) => vectorsOf({ embeddings }, id, key)));
        setSaved(i + batch.length);
      }
      const dataset: Dataset = {
        id,
        name: target?.name ?? name.trim(),
        keyColumn: effectiveKey === GENERATED ? null : effectiveKey,
        columns: [...new Set([...(target?.columns ?? []), ...parsed.columns])],
        textFields: fields,
        termFields: target?.termFields,
        rowCount: 0,
        createdAt: target?.createdAt ?? Date.now(),
      };
      dataset.rowCount = await countRows(id);
      await putDataset(dataset);
      await refreshDatasets();
      await selectDataset(id);
      showSuccess(
        `${dataset.name}: ${(parsed.rows.length - skipped).toLocaleString()} rows saved${skipped ? `, ${skipped.toLocaleString()} existing rows kept` : ""}.`,
      );
      return dataset;
    } catch (error) {
      showError(error);
      return null;
    } finally {
      setSaved(null);
    }
  };

  return (
    <div class="page">
      <section class="panel">
        <h2><span class="step-number">1</span>Choose a file</h2>
        <label
          class={`dropzone ${over ? "over" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            const dropped = event.dataTransfer?.files[0];
            if (dropped) load(dropped);
          }}
        >
          Drop a CSV, TSV, JSON or JSONL file here, or click to browse. Gzipped files and simcheck backups work too.
          <input
            id="file-input"
            class="visually-hidden"
            type="file"
            accept=".csv,.tsv,.txt,.json,.jsonl,.ndjson,.gz"
            onChange={(event) => {
              const chosen = event.currentTarget.files?.[0];
              if (chosen) load(chosen);
            }}
          />
        </label>
        <div class="d-flex align-items-center gap-2 mt-2 small">
          <label for="encoding">Encoding</label>
          <select
            id="encoding"
            class="form-select form-select-sm w-auto"
            value={encoding}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setEncoding(value);
              if (file.current) load(file.current, value);
            }}
          >
            <option value="utf-8">UTF-8</option>
            <option value="windows-1252">Windows-1252 (Excel)</option>
            <option value="iso-8859-1">ISO-8859-1</option>
            <option value="utf-16le">UTF-16 LE</option>
            <option value="utf-16be">UTF-16 BE</option>
          </select>
        </div>
        {parsing !== null && <p class="small mt-2 mb-0">Reading… {parsing.toLocaleString()} rows</p>}
        {parsed && (
          <>
            <p class="small mt-2 mb-0" data-testid="parse-summary">
              {parsed.fileName}: {parsed.rows.length.toLocaleString()} rows, {parsed.columns.length} columns
              {parsed.errors.length ? `, ${parsed.errors.length}+ problems` : ""}
            </p>
            {parsed.errors.length > 0 && (
              <ul class="small text-danger mb-0">
                {parsed.errors.map((error) => <li key={error}>{error}</li>)}
              </ul>
            )}
            <Preview parsed={parsed} />
          </>
        )}
      </section>

      <section class={`panel ${parsed ? "" : "step-muted"}`}>
        <h2><span class="step-number">2</span>Where it goes</h2>
        {parsed && (
          <div class="row g-3">
            <div class="col-md-6">
              <label class="form-label" for="target">Dataset</label>
              <select id="target" class="form-select" value={appendTo} onChange={(e) => setAppendTo(e.currentTarget.value)}>
                <option value="">New dataset</option>
                {datasets.value.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>Add to {dataset.name}</option>
                ))}
              </select>
              {!target && (
                <>
                  <label class="form-label mt-2" for="dataset-name">Name</label>
                  <input id="dataset-name" class={`form-control ${nameTaken ? "is-invalid" : ""}`} value={name} onInput={(e) => setName(e.currentTarget.value)} />
                  {nameTaken && <div class="invalid-feedback">A dataset with this name exists. Pick another name, or add to it above.</div>}
                </>
              )}
              {target && (
                <div class="form-check mt-2">
                  <input class="form-check-input" type="checkbox" id="keep-existing" checked={keepExisting} onChange={(e) => setKeepExisting(e.currentTarget.checked)} />
                  <label class="form-check-label" for="keep-existing">Keep rows that already exist. Otherwise the file's version replaces them.</label>
                </div>
              )}
            </div>
            <div class="col-md-6">
              <label class="form-label" for="key-column">Row id</label>
              <select
                id="key-column"
                class={`form-select ${keyProblem ? "is-invalid" : ""}`}
                value={effectiveKey}
                disabled={!!target}
                onChange={(e) => setKeyColumn(e.currentTarget.value)}
              >
                {!target && parsed.columns.map((column) => <option key={column} value={column}>{column}</option>)}
                {target?.keyColumn && <option value={target.keyColumn}>{target.keyColumn}</option>}
                <option value={GENERATED}>Number the rows</option>
              </select>
              {keyProblem ? (
                <div class="invalid-feedback" data-testid="key-problem">{keyProblem}</div>
              ) : (
                <div class="field-help mt-1">Identifies a row, so importing again updates it instead of adding a copy.</div>
              )}
            </div>
          </div>
        )}
      </section>

      <section class={`panel ${parsed ? "" : "step-muted"}`}>
        <h2><span class="step-number">3</span>What to embed</h2>
        {parsed && (
          <>
            <FieldPicker columns={parsed.columns} selected={fields} onChange={setFields} />
            <ExamplePreview row={parsed.rows[0]} fields={fields} />
          </>
        )}
      </section>

      <section class={`panel ${ready ? "" : "step-muted"}`}>
        <h2><span class="step-number">4</span>Embed</h2>
        {parsed && (
          <>
            {saved !== null && <p class="small">Saving… {saved.toLocaleString()} rows</p>}
            <EmbedAction
              dataset={target}
              rowCount={parsed.rows.length}
              fields={ready ? fields : []}
              sampleText={rowText(parsed.rows[0], fields)}
              samples={parsed.rows.slice(0, 200).map((row) => rowText(row, fields))}
              beforeStart={save}
              onStarted={() => {
                setParsed(null);
                file.current = null;
                go("explore");
              }}
            />
          </>
        )}
      </section>
    </div>
  );
}
