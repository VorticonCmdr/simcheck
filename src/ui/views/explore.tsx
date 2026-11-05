import { useEffect, useMemo, useState } from "preact/hooks";
import { embeddedColumns, rowText, toCsv } from "../../core/csv";
import { countRows, getEmbedding, getResult, readRows } from "../../core/db";
import type { SearchHit } from "../../core/protocol";
import type { CompareResult, Dataset, Row } from "../../core/types";
import { cosine } from "../../core/vector";
import { call } from "../api";
import { Bars, Dialog, EmptyState } from "../components";
import { EmbedAction, ExamplePreview, FieldPicker } from "../embedPanel";
import {
  activeCoverage,
  activeDataset,
  activeModelKey,
  dataVersion,
  datasets,
  go,
  jobs,
  showError,
} from "../state";
import { getRows, saveFile } from "../util";

function Highlight({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(
    `(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  return (
    <>
      {text.split(pattern).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}
    </>
  );
}

function RowFields({ dataset, row, rowKey, words = [] }: { dataset: Dataset; row: Row; rowKey: string; words?: string[] }) {
  const primary = embeddedColumns(dataset);
  const others = dataset.columns.filter((column) => !primary.includes(column));
  const meta = others
    .filter((column) => row[column] !== "" && row[column] != null)
    .slice(0, 4)
    .map((column) => `${column}: ${row[column]}`)
    .join(" · ");
  return (
    <div class="hit-fields">
      {primary.map((field) => (
        <div key={field}><Highlight text={String(row[field] ?? "")} words={words} /></div>
      ))}
      <div class="meta">{meta || rowKey}</div>
    </div>
  );
}

function CompareTwo({ dataset, keys, onClear }: { dataset: Dataset; keys: string[]; onClear: () => void }) {
  const [score, setScore] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    Promise.all(keys.map((key) => getEmbedding(dataset.id, activeModelKey.value, key)))
      .then(([a, b]) => current && setScore(a && b ? cosine(a, b) : null))
      .catch(showError);
    return () => { current = false; };
  }, [keys.join("\u0000")]);

  return (
    <div class="alert alert-info d-flex justify-content-between align-items-center py-2" data-testid="row-similarity">
      <span>Similarity of the 2 selected rows: <strong>{score === null ? "–" : score.toFixed(3)}</strong></span>
      <button type="button" class="btn btn-sm btn-outline-secondary" onClick={onClear}>Clear</button>
    </div>
  );
}

function CompareDatasets({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [a, setA] = useState(activeDataset.value?.id ?? "");
  const [b, setB] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const job = jobs.value.find((j) => j.id === jobId);
  const nameOf = (id: string) => datasets.value.find((d) => d.id === id)?.name ?? "";

  useEffect(() => {
    if (job?.status !== "done") return;
    const { resultId } = job.result as { resultId: string };
    (async () => {
      const stored = await getResult(resultId);
      if (!stored) return;
      setResult(stored);
      const left = await getRows(stored.datasetA, stored.rows.map((r) => r.key));
      const right = await getRows(stored.datasetB, stored.rows.map((r) => r.bestKey));
      setRows(
        stored.rows.map(({ key, bestKey, score }) => ({
          score: score.toFixed(3),
          ...left.get(key),
          ...Object.fromEntries(
            Object.entries(right.get(bestKey) ?? {}).map(([k, v]) => [`match-${k}`, v]),
          ),
        })),
      );
    })().catch(showError);
  }, [job?.status]);

  const histogram = useMemo(() => {
    const bins = Array.from({ length: 10 }, (_, i) => ({ label: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`, value: 0 }));
    for (const { score } of result?.rows ?? []) {
      bins[Math.min(9, Math.max(0, Math.floor(score * 10)))].value++;
    }
    return bins.filter((bin) => bin.value);
  }, [result]);

  const start = () => {
    setResult(null);
    setRows([]);
    call("compare", {
      datasetA: a,
      datasetB: b,
      modelKey: activeModelKey.value,
      title: `${nameOf(a)} with ${nameOf(b)}`,
    }).then(setJobId).catch(showError);
  };

  const download = () => {
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    saveFile(`${nameOf(a)}-${nameOf(b)}.csv`, "text/csv", toCsv(rows, columns));
  };

  return (
    <Dialog open={open} title="Compare datasets" onClose={onClose}>
      <p class="small text-body-secondary">Finds the most similar row in the second dataset for every row in the first.</p>
      <div class="row g-2 mb-3">
        <div class="col">
          <label class="form-label" for="compare-a">For each row in</label>
          <select id="compare-a" class="form-select" value={a} onChange={(e) => setA(e.currentTarget.value)}>
            <option value="">Choose…</option>
            {datasets.value.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div class="col">
          <label class="form-label" for="compare-b">Find the best match in</label>
          <select id="compare-b" class="form-select" value={b} onChange={(e) => setB(e.currentTarget.value)}>
            <option value="">Choose…</option>
            {datasets.value.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      </div>
      <button type="button" class="btn btn-primary" data-testid="compare-start" disabled={!a || !b || job?.status === "running"} onClick={start}>
        {job?.status === "running" ? "Comparing…" : "Compare"}
      </button>
      {job?.status === "error" && <p class="text-danger small mt-2 mb-0">{job.error}</p>}
      {result && (
        <div class="mt-3" data-testid="compare-result">
          <h3 class="h6">Best match scores ({result.rows.length.toLocaleString()} rows)</h3>
          <Bars items={histogram} />
          <button type="button" class="btn btn-sm btn-outline-primary mt-2" onClick={download}>Download CSV</button>
        </div>
      )}
    </Dialog>
  );
}

const PAGE_SIZE = 50;

export function ExploreView() {
  const dataset = activeDataset.value;
  const covered = activeCoverage.value;
  const [query, setQuery] = useState("");
  const [k, setK] = useState(10);
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<(SearchHit & { row: Row })[] | null>(null);
  const [searchedFor, setSearchedFor] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState<{ key: string; data: Row }[]>([]);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [total, setTotal] = useState(0);
  const [comparing, setComparing] = useState(false);
  const [fields, setFields] = useState<string[]>([]);

  const toggle = (key: string) =>
    setSelected((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key].slice(-2),
    );

  useEffect(() => {
    setHits(null);
    setSelected([]);
    setCursors([null]);
    setFields(dataset?.textFields ?? []);
  }, [dataset?.id]);

  useEffect(() => {
    if (!dataset) return;
    let current = true;
    const after = cursors[cursors.length - 1];
    Promise.all([readRows(dataset.id, after, PAGE_SIZE), countRows(dataset.id)])
      .then(([rows, count]) => {
        if (!current) return;
        setPage(rows);
        setTotal(count);
      })
      .catch(showError);
    return () => { current = false; };
  }, [dataset?.id, cursors, dataVersion.value]);

  if (!dataset) {
    return (
      <EmptyState title="Nothing to explore yet">
        <p>Import a file to start searching and comparing its rows by meaning.</p>
        <button type="button" class="btn btn-primary" onClick={() => go("import")}>Import data</button>
      </EmptyState>
    );
  }

  const search = async (event: Event) => {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    setSearching(true);
    try {
      const found = await call<SearchHit[]>("search", {
        datasetId: dataset.id,
        modelKey: activeModelKey.value,
        query: text,
        k,
      });
      const rows = await getRows(dataset.id, found.map((hit) => hit.key));
      setHits(found.map((hit) => ({ ...hit, row: rows.get(hit.key) ?? {} })));
      setSearchedFor(text);
    } catch (error) {
      showError(error);
    } finally {
      setSearching(false);
    }
  };
  const words = searchedFor.split(/\s+/).filter((word) => word.length > 2);
  const pageNumber = cursors.length;

  return (
    <div class="page">
      {covered === 0 ? (
        <section class="panel">
          <h2>No embeddings for this model yet</h2>
          <p class="small text-body-secondary">
            {dataset.name} has none for the active model. Embed it to search it, or switch to a model it does have under Models.
          </p>
          <FieldPicker columns={dataset.columns} selected={fields} onChange={setFields} />
          <ExamplePreview row={page[0]?.data} fields={fields} />
          <div class="mt-3"><EmbedAction dataset={dataset} rowCount={dataset.rowCount} fields={fields} sampleText={page[0] ? rowText(page[0].data, fields) : ""} samples={page.map((row) => rowText(row.data, fields))} /></div>
        </section>
      ) : (
        <section class="panel">
          <form class="d-flex gap-2" role="search" onSubmit={search}>
            <input
              id="query"
              class="form-control"
              type="search"
              placeholder={`Search ${dataset.name} by meaning`}
              aria-label={`Search ${dataset.name}`}
              autoComplete="off"
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <select class="form-select w-auto" aria-label="Number of results" value={k} onChange={(e) => setK(Number(e.currentTarget.value))}>
              {[10, 25, 100].map((n) => <option key={n} value={n}>{n} results</option>)}
            </select>
            <button class="btn btn-primary" disabled={searching}>{searching ? "Searching…" : "Search"}</button>
          </form>
          {covered < dataset.rowCount && (
            <p class="small text-body-secondary mt-2 mb-0">
              {(dataset.rowCount - covered).toLocaleString()} rows have no embedding for this model and won't show up.
            </p>
          )}
        </section>
      )}

      <div class="d-flex justify-content-end mb-2">
        <button type="button" class="btn btn-sm btn-outline-secondary" onClick={() => setComparing(true)}>Compare datasets…</button>
      </div>

      {selected.length === 2 && <CompareTwo dataset={dataset} keys={selected} onClear={() => setSelected([])} />}

      {hits !== null ? (
        <section class="panel" data-testid="results">
          <div class="d-flex justify-content-between align-items-center">
            <h2 class="mb-0">{hits.length} results for “{searchedFor}”</h2>
            <button type="button" class="btn btn-sm btn-outline-secondary" onClick={() => setHits(null)}>Back to rows</button>
          </div>
          {hits.length === 0 && <p class="text-body-secondary mt-2 mb-0">Nothing to search: no rows have an embedding for this model.</p>}
          {hits.map((hit) => (
            <article class="hit" key={hit.key}>
              <input class="form-check-input" type="checkbox" aria-label={`Select ${hit.key}`} checked={selected.includes(hit.key)} onChange={() => toggle(hit.key)} />
              <div class="hit-score">
                {hit.score.toFixed(3)}
                <span class="track"><span class="fill" style={{ width: `${Math.max(0, hit.score) * 100}%` }} /></span>
              </div>
              <RowFields dataset={dataset} row={hit.row} rowKey={hit.key} words={words} />
            </article>
          ))}
        </section>
      ) : (
        <section class="panel">
          <h2>Rows</h2>
          {page.map(({ key, data }) => (
            <article class="hit" key={key}>
              <input class="form-check-input" type="checkbox" aria-label={`Select ${key}`} checked={selected.includes(key)} onChange={() => toggle(key)} />
              <RowFields dataset={dataset} row={data} rowKey={key} />
            </article>
          ))}
          <div class="d-flex justify-content-between align-items-center mt-2 small">
            <span>Page {pageNumber} of {Math.max(1, Math.ceil(total / PAGE_SIZE)).toLocaleString()}</span>
            <span class="d-flex gap-1">
              <button type="button" class="btn btn-sm btn-outline-secondary" disabled={pageNumber === 1} onClick={() => setCursors(cursors.slice(0, -1))}>Previous</button>
              <button
                type="button"
                class="btn btn-sm btn-outline-secondary"
                disabled={pageNumber * PAGE_SIZE >= total}
                onClick={() => setCursors([...cursors, page[page.length - 1].key])}
              >
                Next
              </button>
            </span>
          </div>
        </section>
      )}
      <CompareDatasets open={comparing} onClose={() => setComparing(false)} />
    </div>
  );
}
