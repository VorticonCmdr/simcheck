import { useState } from "preact/hooks";
import { deleteDataset, putDataset } from "../core/db";
import { toCsv } from "../core/csv";
import { describeModelKey } from "../core/settings";
import type { Dataset } from "../core/types";
import { Dialog, JobTray, Notice } from "./components";
import {
  activeCoverage,
  activeDataset,
  activeModelKey,
  closeDrawer,
  coverage,
  datasets,
  go,
  hasProjection,
  loaded,
  refreshDatasets,
  selectDataset,
  settings,
  showError,
  sidebarVisible,
  toggleSidebar,
  view,
  type View,
} from "./state";
import { allRows, exportBackup, formatBytes, saveFile } from "./util";
import { ClusterView } from "./views/cluster";
import { ExploreView } from "./views/explore";
import { ImportView } from "./views/import";
import { MapView } from "./views/map";
import { ModelsView } from "./views/models";

const TABS: { id: View; label: string }[] = [
  { id: "import", label: "Import" },
  { id: "explore", label: "Explore" },
  { id: "cluster", label: "Cluster" },
  { id: "map", label: "Map" },
];

function DatasetCard({ dataset }: { dataset: Dataset }) {
  const [dialog, setDialog] = useState<null | "rename" | "delete">(null);
  const [name, setName] = useState(dataset.name);

  const exportCsv = async () => {
    const rows = await allRows(dataset.id);
    saveFile(`${dataset.name}.csv`, "text/csv", toCsv([...rows.values()], dataset.columns));
  };
  const exportAll = async () => {
    saveFile(`${dataset.name}.jsonl.gz`, "application/gzip", await exportBackup(dataset));
  };
  const rename = async () => {
    await putDataset({ ...dataset, name: name.trim() });
    setDialog(null);
    await refreshDatasets();
  };
  const remove = async () => {
    await deleteDataset(dataset.id);
    setDialog(null);
    await refreshDatasets();
  };
  const totalVectors = coverage.value.reduce((sum, c) => sum + c.count, 0);
  const vectorBytes = coverage.value.reduce((sum, c) => sum + c.count * c.dims * 4, 0);

  return (
    <div class="dataset-card">
      <dl class="mb-2 small">
        <div><dt>Rows</dt><dd>{dataset.rowCount.toLocaleString()}</dd></div>
        <div><dt>Map</dt><dd>{hasProjection.value ? "ready" : "not clustered"}</dd></div>
        <div><dt>Vectors</dt><dd>{formatBytes(vectorBytes)}</dd></div>
      </dl>
      {coverage.value.length > 0 && (
        <ul class="list-unstyled small mb-2">
          {coverage.value.map((c) => (
            <li key={c.modelKey} class="d-flex justify-content-between gap-2">
              <span class={`text-truncate ${c.modelKey === activeModelKey.value ? "fw-semibold" : ""}`} title={c.modelKey}>
                {describeModelKey(c.modelKey)}
              </span>
              <span>{Math.round((c.count / Math.max(1, dataset.rowCount)) * 100)}%</span>
            </li>
          ))}
        </ul>
      )}
      <div class="d-flex flex-wrap gap-1">
        <button type="button" class="btn btn-sm btn-outline-secondary" onClick={() => exportCsv().catch(showError)}>CSV</button>
        <button type="button" class="btn btn-sm btn-outline-secondary" title="Rows and embeddings, can be imported again" onClick={() => exportAll().catch(showError)}>Backup</button>
        <button type="button" class="btn btn-sm btn-outline-secondary" onClick={() => setDialog("rename")}>Rename</button>
        <button type="button" class="btn btn-sm btn-outline-danger" onClick={() => setDialog("delete")}>Delete</button>
      </div>

      <Dialog open={dialog === "rename"} title="Rename dataset" onClose={() => setDialog(null)}>
        <form onSubmit={(e) => { e.preventDefault(); rename().catch(showError); }}>
          <label class="form-label" for="rename-input">Name</label>
          <input id="rename-input" class="form-control mb-3" value={name} onInput={(e) => setName(e.currentTarget.value)} required />
          <button class="btn btn-primary" disabled={!name.trim()}>Rename</button>
        </form>
      </Dialog>
      <Dialog open={dialog === "delete"} title={`Delete ${dataset.name}?`} onClose={() => setDialog(null)}>
        <p>
          This removes {dataset.rowCount.toLocaleString()} rows and{" "}
          {totalVectors.toLocaleString()} embeddings, along with its clusters. It can't be undone.
        </p>
        <div class="d-flex gap-2">
          <button type="button" class="btn btn-danger" onClick={() => remove().catch(showError)}>Delete dataset</button>
          <button type="button" class="btn btn-outline-secondary" onClick={() => setDialog(null)}>Keep it</button>
        </div>
      </Dialog>
    </div>
  );
}

function Sidebar() {
  const active = activeDataset.value;
  return (
    <aside id="sidebar" class={`sidebar ${sidebarVisible.value ? "" : "closed"}`} aria-label="Datasets">
      <div class="brand">
        <img src="/icons/clusters.svg" alt="" width="22" height="22" />
        <span>simcheck</span>
      </div>
      <h2 class="side-heading">Datasets</h2>
      {datasets.value.length === 0 && (
        <p class="small text-body-secondary px-2">No datasets yet.</p>
      )}
      <ul class="dataset-list list-unstyled">
        {datasets.value.map((dataset) => (
          <li key={dataset.id}>
            <button
              type="button"
              class={`dataset-item ${dataset.id === active?.id ? "active" : ""}`}
              aria-current={dataset.id === active?.id ? "true" : undefined}
              onClick={() => { closeDrawer(); selectDataset(dataset.id).catch(showError); }}
            >
              <span class="text-truncate">{dataset.name}</span>
              <span class="count">{dataset.rowCount.toLocaleString()}</span>
            </button>
            {dataset.id === active?.id && <DatasetCard key={dataset.id} dataset={dataset} />}
          </li>
        ))}
      </ul>
      <button type="button" class="btn btn-sm btn-primary mx-2" onClick={() => { closeDrawer(); go("import"); }}>
        Import data
      </button>
      <div class="mt-auto pt-3">
        <a class="dataset-item text-decoration-none" href="https://docs.google.com/document/d/1wnIekRglMEkagw6dsucxNRkHclpQE_ptwkIyXzNvQ1s/" target="_blank" rel="noreferrer">
          Help
        </a>
        <button type="button" class={`dataset-item ${view.value === "models" ? "active" : ""}`} onClick={() => { closeDrawer(); go("models"); }}>
          Models &amp; settings
        </button>
      </div>
    </aside>
  );
}

function Header() {
  const dataset = activeDataset.value;
  return (
    <header class="topbar">
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        aria-label="Datasets sidebar"
        aria-controls="sidebar"
        aria-expanded={sidebarVisible.value}
        title={sidebarVisible.value ? "Hide sidebar" : "Show sidebar"}
        onClick={toggleSidebar}
      >
        ☰
      </button>
      <nav aria-label="Views">
        <ul class="nav nav-underline flex-nowrap">
          {TABS.map((tab) => (
            <li class="nav-item" key={tab.id}>
              <a class={`nav-link ${view.value === tab.id ? "active" : ""}`} aria-current={view.value === tab.id ? "page" : undefined} href={`#${tab.id}`}>
                {tab.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div class="context small" data-testid="context">
        <span class="text-truncate" title="Active dataset">{dataset?.name ?? "no dataset"}</span>
        <span aria-hidden="true">·</span>
        <button type="button" class="link-button text-truncate" title="Change model" onClick={() => go("models")}>
          {describeModelKey(activeModelKey.value)}
        </button>
        {dataset && (
          <span class="text-body-secondary d-none d-xl-inline">
            {activeCoverage.value.toLocaleString()}/{dataset.rowCount.toLocaleString()} embedded
          </span>
        )}
      </div>
      <JobTray />
    </header>
  );
}

export function App() {
  if (!loaded.value) return <p class="p-4">Loading…</p>;
  void settings.value;
  const current = view.value;
  return (
    <div class="workspace">
      <Sidebar />
      <div class="main-column">
        <Header />
        <Notice />
        <main class={current === "map" ? "main-map" : "main-page"}>
          {current === "import" && <ImportView />}
          {current === "explore" && <ExploreView />}
          {current === "cluster" && <ClusterView />}
          {current === "map" && <MapView />}
          {current === "models" && <ModelsView />}
        </main>
      </div>
    </div>
  );
}
