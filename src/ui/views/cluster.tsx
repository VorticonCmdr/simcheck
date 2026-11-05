import { useEffect, useMemo, useState } from "preact/hooks";
import { embeddedColumns, rowText, termColumns } from "../../core/csv";
import { getProjection, getRows, putDataset } from "../../core/db";
import { clusterStats, dbscan2d, suggestEps } from "../../core/dbscan";
import { MAX_AHC_POINTS } from "../../core/hclust";
import { SERIES_LIMIT, otherColor, seriesColor } from "../../core/palette";
import { columnBreakdown } from "../../core/summary";
import type { ClusterSettings, ClusterSummary, Dataset, Projection, ProjectionParams, Row } from "../../core/types";
import { call } from "../api";
import { Bars, EmptyState } from "../components";
import {
  activeCoverage,
  activeDataset,
  activeModelKey,
  dataVersion,
  datasets,
  go,
  refreshDatasets,
  runningJobs,
  selectDataset,
  showError,
  jobs,
} from "../state";
import { allRows, clusterName, isDark } from "../util";

const SHOWN = 30;
const DEFAULT_ASSIGN = 0.3;

const DEFAULTS: ProjectionParams = {
  nNeighbors: 15,
  minDist: 0.1,
  spread: 1,
  guide: "none",
  k: 0,
  guideEps: 0.3,
  guideMinPts: 3,
  seed: 42,
};

function Slider({
  id, label, help, min, max, step, value, onChange,
}: {
  id: string; label: string; help: string; min: number; max: number; step: number; value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div class="mb-3">
      <label class="form-label d-flex justify-content-between mb-0" for={id}>
        <span>{label}</span><span class="text-body-secondary">{value}</span>
      </label>
      <input id={id} type="range" class="form-range" min={min} max={max} step={step} value={value} onInput={(e) => onChange(Number(e.currentTarget.value))} />
      <div class="field-help">{help}</div>
    </div>
  );
}

function HeightCurve({ curve, chosen }: { curve: { k: number; height: number }[]; chosen: number | null }) {
  const width = 480;
  const height = 120;
  const pad = 24;
  const maxK = curve[curve.length - 1].k;
  const minK = curve[0].k;
  const top = curve[0].height || 1;
  const x = (k: number) => pad + ((k - minK) / Math.max(1, maxK - minK)) * (width - 2 * pad);
  const y = (h: number) => height - pad - (h / top) * (height - 2 * pad);
  const marked = curve.find((point) => point.k === chosen);
  return (
    <figure class="mb-0">
      <figcaption class="small text-body-secondary">Distance at which clusters merge, by number of clusters</figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Merge distance falls as clusters increase. Chosen: ${chosen} clusters.`} style={{ width: "100%", maxWidth: `${width}px` }}>
        <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} stroke="currentColor" opacity=".25" />
        <polyline fill="none" stroke="#2a78d6" stroke-width="2" points={curve.map((p) => `${x(p.k)},${y(p.height)}`).join(" ")}>
        </polyline>
        {curve.map((p) => (
          <circle key={p.k} cx={x(p.k)} cy={y(p.height)} r="7" fill="transparent"><title>{`${p.k} clusters: ${p.height.toFixed(3)}`}</title></circle>
        ))}
        {marked && (
          <>
            <circle cx={x(marked.k)} cy={y(marked.height)} r="4" fill="#2a78d6" stroke="var(--bs-body-bg)" stroke-width="2" />
            <text x={x(marked.k) + 8} y={y(marked.height) - 6} font-size="12" fill="currentColor">k = {marked.k}</text>
          </>
        )}
        <text x={pad} y={height - 6} font-size="11" fill="currentColor" opacity=".7">{minK}</text>
        <text x={width - pad} y={height - 6} font-size="11" fill="currentColor" opacity=".7" text-anchor="end">{maxK}</text>
      </svg>
    </figure>
  );
}

function MergeSection() {
  const active = activeDataset.value;
  const [others, setOthers] = useState<string[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = jobs.value.find((j) => j.id === jobId);
  const candidates = datasets.value.filter((d) => d.id !== active?.id);

  useEffect(() => {
    if (job?.status === "done") {
      selectDataset((job.result as { datasetId: string }).datasetId).catch(showError);
      setOthers([]);
      setJobId(null);
    }
  }, [job?.status]);

  if (!active || !candidates.length) return null;
  const merge = () => {
    const names = [active, ...candidates.filter((d) => others.includes(d.id))].map((d) => d.name);
    call("merge", {
      name: `${names.join(" + ")}`,
      datasetIds: [active.id, ...others],
    }).then(setJobId).catch(showError);
  };
  return (
    <details class="panel">
      <summary>Cluster several datasets together</summary>
      <p class="field-help mt-2">Makes a new dataset out of this one and the ones you pick, keeping their embeddings. A row keeps track of where it came from.</p>
      {candidates.map((dataset) => (
        <div class="form-check" key={dataset.id}>
          <input
            class="form-check-input"
            type="checkbox"
            id={`merge-${dataset.id}`}
            checked={others.includes(dataset.id)}
            onChange={() => setOthers(others.includes(dataset.id) ? others.filter((o) => o !== dataset.id) : [...others, dataset.id])}
          />
          <label class="form-check-label" for={`merge-${dataset.id}`}>{dataset.name}</label>
        </div>
      ))}
      <button type="button" class="btn btn-sm btn-outline-primary mt-2" disabled={!others.length || job?.status === "running"} onClick={merge}>Merge into a new dataset</button>
    </details>
  );
}

const sameColumns = (a: string[], b: string[]) =>
  a.length === b.length && a.every((column) => b.includes(column));

function TermColumns({ dataset, projection, busy }: { dataset: Dataset; projection: Projection; busy: boolean }) {
  const saved = termColumns(dataset);
  const embedded = embeddedColumns(dataset);
  const [chosen, setChosen] = useState(saved);
  useEffect(() => setChosen(saved), [saved.join("\0")]);

  const toggle = (column: string) =>
    setChosen(chosen.includes(column) ? chosen.filter((c) => c !== column) : [...chosen, column]);

  // Keeps the clusters as they are: only the terms change.
  const apply = async () => {
    const termFields = dataset.columns.filter((column) => chosen.includes(column));
    await putDataset({ ...dataset, termFields: sameColumns(termFields, embedded) ? undefined : termFields });
    await refreshDatasets();
    await call("recluster", {
      datasetId: dataset.id,
      datasetName: dataset.name,
      modelKey: projection.modelKey,
      clustering: null,
      merge: null,
    });
  };

  return (
    <section class="panel" data-testid="term-columns">
      <h2>Top terms</h2>
      <p class="field-help">Clusters are named after the words that set them apart in these columns.</p>
      <div class="column-picks mb-2">
        {dataset.columns.map((column) => (
          <div class="form-check" key={column}>
            <input
              class="form-check-input"
              type="checkbox"
              id={`term-${column}`}
              checked={chosen.includes(column)}
              onChange={() => toggle(column)}
            />
            <label class="form-check-label text-break" for={`term-${column}`}>
              {column}
              {embedded.includes(column) && <span class="text-body-secondary"> (embedded)</span>}
            </label>
          </div>
        ))}
      </div>
      {chosen.length === 0 && <p class="field-help text-danger">Pick at least one column.</p>}
      <div class="d-flex gap-2">
        <button
          type="button"
          class="btn btn-outline-primary btn-sm"
          disabled={busy || !chosen.length || sameColumns(chosen, projection.termFields ?? embedded)}
          onClick={() => apply().catch(showError)}
        >
          Apply
        </button>
        <button type="button" class="btn btn-outline-secondary btn-sm" disabled={sameColumns(chosen, embedded)} onClick={() => setChosen(embedded)}>
          Use embedded columns
        </button>
      </div>
    </section>
  );
}

function ClusterMakeup({ dataset, projection }: { dataset: Dataset; projection: Projection }) {
  const [column, setColumn] = useState("");
  const [rows, setRows] = useState<Map<string, Row> | null>(null);

  useEffect(() => {
    if (!column) return;
    let current = true;
    allRows(dataset.id).then((all) => current && setRows(all)).catch(showError);
    return () => { current = false; };
  }, [column, dataset.id, dataVersion.value]);

  const breakdown = useMemo(() => {
    if (!column || !rows) return null;
    const values = projection.keys.map((key) => String(rows.get(key)?.[column] ?? "") || "(empty)");
    return columnBreakdown(projection.labels, values, projection.clusters.length, SERIES_LIMIT);
  }, [column, rows, projection]);

  const dark = isDark();
  const shown = projection.clusters.slice(0, SHOWN);
  const segments = (id: number) => {
    const { counts, other } = breakdown!.clusters[id];
    return [
      ...breakdown!.values.map((value, i) => ({ value, count: counts[i], color: seriesColor(i, dark) })),
      { value: "Other", count: other, color: otherColor(dark) },
    ];
  };
  const hasOther = breakdown ? breakdown.distinct > breakdown.values.length : false;

  return (
    <section class="panel" data-testid="cluster-makeup">
      <h2>What's in each cluster</h2>
      <label class="form-label" for="makeup-column">Split clusters by</label>
      <select id="makeup-column" class="form-select form-select-sm mb-2" value={column} onChange={(e) => setColumn(e.currentTarget.value)}>
        <option value="">Choose a column</option>
        {dataset.columns.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      {breakdown && (
        <>
          <ul class="stack-legend list-unstyled small">
            {breakdown.values.map((value, i) => (
              <li key={value}><span class="swatch" style={{ background: seriesColor(i, dark) }} />{value}</li>
            ))}
            {hasOther && (
              <li><span class="swatch" style={{ background: otherColor(dark) }} />Other ({(breakdown.distinct - breakdown.values.length).toLocaleString()} values)</li>
            )}
          </ul>
          <ul class="stacks list-unstyled mb-2">
            {shown.map((cluster) => (
              <li key={cluster.id}>
                <span class="text-truncate" title={clusterName(cluster)}>{clusterName(cluster)}</span>
                <span class="stack" role="img" aria-label={segments(cluster.id).filter((s) => s.count).map((s) => `${s.value}: ${s.count}`).join(", ")}>
                  {segments(cluster.id).filter((s) => s.count).map((s) => (
                    <span key={s.value} style={{ flexGrow: s.count, background: s.color }} title={`${s.value}: ${s.count.toLocaleString()} rows, ${Math.round((s.count / cluster.size) * 100)}%`} />
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <details>
            <summary class="small">As a table</summary>
            <div class="table-responsive mt-2">
              <table class="table table-sm small mb-0">
                <thead>
                  <tr>
                    <th scope="col">Cluster</th>
                    {breakdown.values.map((value) => <th scope="col" class="text-end" key={value}>{value}</th>)}
                    {hasOther && <th scope="col" class="text-end">Other</th>}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((cluster) => (
                    <tr key={cluster.id}>
                      <th scope="row" class="fw-normal">{clusterName(cluster)}</th>
                      {breakdown.clusters[cluster.id].counts.map((count, i) => <td class="text-end" key={i}>{count.toLocaleString()}</td>)}
                      {hasOther && <td class="text-end">{breakdown.clusters[cluster.id].other.toLocaleString()}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          {projection.clusters.length > SHOWN && (
            <p class="small text-body-secondary mt-2 mb-0">Showing the largest {SHOWN} of {projection.clusters.length}.</p>
          )}
        </>
      )}
    </section>
  );
}

const representativesOf = (cluster: ClusterSummary) =>
  cluster.representativeKeys ?? [cluster.representativeKey];

export function ClusterView() {
  const dataset = activeDataset.value;
  const modelKey = activeModelKey.value;
  const covered = activeCoverage.value;
  const [params, setParams] = useState(DEFAULTS);
  const [projection, setProjection] = useState<Projection | null>(null);
  const [eps, setEps] = useState(0);
  const [minPts, setMinPts] = useState(5);
  const [method, setMethod] = useState<ClusterSettings["method"]>("hdbscan");
  const [minClusterSize, setMinClusterSize] = useState(15);
  const [assignAbove, setAssignAbove] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [toMerge, setToMerge] = useState<number[]>([]);
  const [representatives, setRepresentatives] = useState<Map<string, string>>(new Map());
  const set = (change: Partial<ProjectionParams>) => setParams({ ...params, ...change });
  const visible = ({ clusters }: Projection) => (showAll ? clusters : clusters.slice(0, SHOWN));

  useEffect(() => {
    if (!dataset || !projection) return;
    let current = true;
    const keys = visible(projection).flatMap(representativesOf);
    const fields = embeddedColumns(dataset);
    getRows(dataset.id, keys)
      .then((rows) => {
        if (!current) return;
        setRepresentatives(new Map(keys.map((key) => [key, rowText(rows.get(key) ?? {}, fields)])));
      })
      .catch(showError);
    return () => { current = false; };
  }, [projection, showAll]);

  useEffect(() => setToMerge([]), [projection]);

  useEffect(() => {
    if (!dataset) return;
    let current = true;
    getProjection(dataset.id, modelKey)
      .then((stored) => {
        if (!current) return;
        setProjection(stored ?? null);
        if (stored) {
          setParams(stored.params);
          setMethod(stored.clustering.method);
          setMinClusterSize(stored.clustering.minClusterSize || 15);
          setEps(stored.clustering.eps);
          setMinPts(stored.clustering.minPts);
          setAssignAbove(stored.clustering.assignAbove ?? null);
        }
      })
      .catch(showError);
    return () => { current = false; };
  }, [dataset?.id, modelKey, dataVersion.value]);

  const running = runningJobs.value.find(
    (job) => job.datasetId === dataset?.id && (job.kind === "cluster" || job.kind === "recluster"),
  );

  // Cheap on the stored projection, so the slider can answer while it's moved.
  const preview = useMemo(
    () => (projection && method === "dbscan" && eps > 0 ? clusterStats(dbscan2d(projection.coords, eps, minPts)) : null),
    [projection, method, eps, minPts],
  );

  if (!dataset) {
    return (
      <EmptyState title="Nothing to cluster yet">
        <button type="button" class="btn btn-primary" onClick={() => go("import")}>Import data</button>
      </EmptyState>
    );
  }
  if (covered < 4) {
    return (
      <EmptyState title={`${dataset.name} needs embeddings for this model`}>
        <p>Clustering works on embeddings, and needs at least 4 rows of them.</p>
        <button type="button" class="btn btn-primary" onClick={() => go("explore")}>Embed it</button>
      </EmptyState>
    );
  }

  const run = () =>
    call("cluster", {
      datasetId: dataset.id,
      datasetName: dataset.name,
      modelKey,
      params,
      // Keep the chosen eps only while it still fits the projection it was picked for.
      clustering: {
        method,
        minClusterSize: projection ? minClusterSize : 0,
        eps: projection && JSON.stringify(projection.params) === JSON.stringify(params) ? eps : 0,
        minPts,
        assignAbove,
      },
    }).catch(showError);
  const recluster = () =>
    call("recluster", { datasetId: dataset.id, datasetName: dataset.name, modelKey, clustering: { method, minClusterSize, eps, minPts, assignAbove }, merge: null }).catch(showError);
  const merge = () =>
    call("recluster", { datasetId: dataset.id, datasetName: dataset.name, modelKey, clustering: null, merge: toMerge }).catch(showError);

  const chooseMethod = (next: ClusterSettings["method"]) => {
    setMethod(next);
    // HDBSCAN has no radius to carry over, and the slider needs one to preview.
    if (next === "dbscan" && eps <= 0 && projection) setEps(suggestEps(projection.coords, minPts));
  };

  const tooMany = params.guide === "ahc" && covered > MAX_AHC_POINTS;
  const stored = projection?.clustering;
  const settingsChanged = stored && (
    method !== stored.method ||
    assignAbove !== (stored.assignAbove ?? null) ||
    (method === "hdbscan" ? minClusterSize !== stored.minClusterSize : eps !== stored.eps || minPts !== stored.minPts)
  );
  const epsMax = Math.max((stored?.eps || eps) * 4, 1);

  return (
    <div class="cluster-layout">
      <div>
        <section class="panel">
          <h2>Layout</h2>
          <p class="field-help">Places similar rows near each other on a 2D map.</p>
          <Slider id="nNeighbors" label="Neighbours" help="Low shows local detail, high shows the overall structure." min={2} max={100} step={1} value={params.nNeighbors} onChange={(nNeighbors) => set({ nNeighbors })} />
          <Slider id="minDist" label="Minimum distance" help="Low packs points tightly." min={0} max={0.9} step={0.05} value={params.minDist} onChange={(minDist) => set({ minDist })} />
          <Slider id="spread" label="Spread" help="How far apart groups end up." min={0.5} max={2} step={0.1} value={params.spread} onChange={(spread) => set({ spread })} />
          <label class="form-label" for="guide">Guide the layout</label>
          <select id="guide" class="form-select form-select-sm" value={params.guide} onChange={(e) => set({ guide: e.currentTarget.value as ProjectionParams["guide"] })}>
            <option value="none">No, use similarity alone</option>
            <option value="ahc">With hierarchical clusters (precise, slower)</option>
            <option value="dbscan">With dense groups (DBSCAN)</option>
          </select>
          <div class="field-help mt-1 mb-2">Groups found on the full vectors pull the map's clusters further apart.</div>
          {params.guide === "ahc" && (
            <div class="mb-2">
              <label class="form-label" for="ahc-k">Number of clusters</label>
              <input id="ahc-k" class="form-control form-control-sm" type="number" min={0} value={params.k} onInput={(e) => set({ k: Number(e.currentTarget.value) })} />
              <div class={`field-help ${tooMany ? "text-danger" : ""}`}>
                {tooMany ? `Works up to ${MAX_AHC_POINTS.toLocaleString()} rows.` : "0 picks it from the data."}
              </div>
            </div>
          )}
          {params.guide === "dbscan" && (
            <>
              <Slider id="guideEps" label="Group radius" help="Cosine distance. Larger merges more." min={0.05} max={1} step={0.05} value={params.guideEps} onChange={(guideEps) => set({ guideEps })} />
              <Slider id="guideMinPts" label="Smallest group" help="Rows needed to form a group." min={2} max={20} step={1} value={params.guideMinPts} onChange={(guideMinPts) => set({ guideMinPts })} />
            </>
          )}
          <button type="button" class="btn btn-primary w-100" data-testid="cluster-run" disabled={!!running || tooMany} onClick={() => run()}>
            {running ? "Running…" : projection ? "Run again" : "Find clusters"}
          </button>
          {running && (
            <button type="button" class="btn btn-outline-secondary w-100 mt-2" onClick={() => call("cancelJob", { jobId: running.id }).catch(showError)}>Cancel</button>
          )}
        </section>
        <MergeSection />
      </div>

      <div>
        {!projection ? (
          <div class="panel"><EmptyState title="No clusters yet"><p>Set up the layout, then find clusters. The defaults suit most data.</p></EmptyState></div>
        ) : (
          <>
            <section class="panel" data-testid="cluster-summary">
              <div class="stat-row mb-3">
                <div class="stat"><strong>{projection.clusters.length}</strong><span>clusters</span></div>
                <div class="stat"><strong>{Math.round((projection.noise / projection.keys.length) * 100)}%</strong><span>unclustered rows</span></div>
                <div class="stat"><strong>{projection.keys.length.toLocaleString()}</strong><span>rows</span></div>
                {projection.silhouette !== null && (
                  <div class="stat" title="Silhouette, from -1 to 1: higher means tighter clusters that are further apart">
                    <strong>{projection.silhouette.toFixed(2)}</strong><span>separation</span>
                  </div>
                )}
              </div>
              <button type="button" class="btn btn-outline-primary btn-sm" onClick={() => go("map")}>Open in Map</button>
            </section>

            <section class="panel">
              <h2>Clustering</h2>
              <label class="form-label" for="cluster-method">Method</label>
              <select id="cluster-method" class="form-select form-select-sm mb-3" value={method} onChange={(e) => chooseMethod(e.currentTarget.value as ClusterSettings["method"])}>
                <option value="hdbscan">By density (HDBSCAN)</option>
                <option value="dbscan">By a fixed radius on the map (DBSCAN)</option>
              </select>
              {method === "hdbscan" ? (
                <Slider id="minClusterSize" label="Smallest cluster" help="Raise it for fewer, broader clusters. Rows that fit none stay unclustered." min={2} max={100} step={1} value={minClusterSize} onChange={setMinClusterSize} />
              ) : (
                <>
                  <p class="field-help">Simple and quick, but on data without clear gaps it can join nearly everything into one cluster.</p>
                  <Slider id="eps" label="Radius" help="In map units. Larger merges neighbouring clusters." min={0.01} max={Number(epsMax.toFixed(2))} step={0.01} value={Number(eps.toFixed(2))} onChange={setEps} />
                  <Slider id="minPts" label="Smallest cluster" help="Rows close together needed to start a cluster." min={2} max={50} step={1} value={minPts} onChange={setMinPts} />
                </>
              )}
              {preview && (
                <p class="small" data-testid="preview">
                  With these settings: <strong>{preview.clusters}</strong> clusters, {Math.round(preview.noiseRatio * 100)}% unclustered{assignAbove !== null && " before assigning"}.
                </p>
              )}
              <div class="form-check mb-2">
                <input
                  class="form-check-input"
                  type="checkbox"
                  id="assign-noise"
                  checked={assignAbove !== null}
                  onChange={() => setAssignAbove(assignAbove === null ? DEFAULT_ASSIGN : null)}
                />
                <label class="form-check-label" for="assign-noise">Assign unclustered rows to the most similar cluster</label>
              </div>
              {assignAbove !== null && (
                <Slider id="assign-above" label="Minimum similarity" help="Rows less similar than this to every cluster stay unclustered." min={0} max={1} step={0.05} value={assignAbove} onChange={setAssignAbove} />
              )}
              {!!projection.merges && (
                <p class="field-help text-warning-emphasis">Applying these settings or running again undoes your merges.</p>
              )}
              <button type="button" class="btn btn-outline-primary btn-sm" disabled={!settingsChanged || !!running} onClick={() => recluster()}>Apply</button>
            </section>

            <TermColumns key={dataset.id} dataset={dataset} projection={projection} busy={!!running} />

            {projection.heightCurve && projection.heightCurve.length > 1 && (
              <section class="panel"><HeightCurve curve={projection.heightCurve} chosen={projection.chosenK} /></section>
            )}

            <section class="panel">
              <h2>Clusters by size</h2>
              {projection.clusters.length === 0 ? (
                <p class="text-body-secondary mb-0">No clusters found. {method === "hdbscan" ? "Try a smaller minimum size." : "Try a larger radius."}</p>
              ) : (
                <Bars items={projection.clusters.slice(0, SHOWN).map((cluster) => ({
                  label: clusterName(cluster),
                  value: cluster.size,
                }))} />
              )}
              {projection.clusters.length > SHOWN && (
                <p class="small text-body-secondary mt-2 mb-0">Showing the largest {SHOWN} of {projection.clusters.length}.</p>
              )}
            </section>

            <ClusterMakeup key={dataset.id} dataset={dataset} projection={projection} />

            <section class="panel">
              <div class="d-flex justify-content-between align-items-center gap-2 mb-2">
                <h2 class="mb-0">Representative rows</h2>
                <button type="button" class="btn btn-outline-primary btn-sm" data-testid="merge-clusters" disabled={toMerge.length < 2 || !!running} onClick={() => merge()}>
                  Merge{toMerge.length > 1 ? ` ${toMerge.length} clusters` : " clusters"}
                </button>
              </div>
              <div class="table-responsive">
                <table class="table table-sm mb-0" data-testid="cluster-table">
                  <thead>
                    <tr><th scope="col"><span class="visually-hidden">Merge</span></th><th scope="col">Cluster</th><th scope="col" class="text-end">Rows</th><th scope="col">Top terms</th><th scope="col">Closest to its centre</th></tr>
                  </thead>
                  <tbody>
                    {visible(projection).map((cluster) => (
                      <tr key={cluster.id}>
                        <td>
                          <input
                            class="form-check-input"
                            type="checkbox"
                            aria-label={`Select ${clusterName(cluster)} to merge`}
                            checked={toMerge.includes(cluster.id)}
                            onChange={() => setToMerge(toMerge.includes(cluster.id) ? toMerge.filter((id) => id !== cluster.id) : [...toMerge, cluster.id])}
                          />
                        </td>
                        <td>{cluster.id}</td>
                        <td class="text-end">{cluster.size.toLocaleString()}</td>
                        <td>{cluster.terms.join(", ")}</td>
                        <td class="text-break">
                          {representativesOf(cluster).map((key, i) => (
                            <div key={key} class={i ? "small text-body-secondary" : ""}>{representatives.get(key) ?? key}</div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {projection.clusters.length > SHOWN && (
                <button type="button" class="btn btn-link btn-sm px-0 mt-2" onClick={() => setShowAll(!showAll)}>
                  {showAll ? `Show the largest ${SHOWN}` : `Show all ${projection.clusters.length}`}
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
