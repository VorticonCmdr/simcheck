# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

simcheck is a Chrome extension (Manifest V3) that generates, compares, and visualizes vector embeddings — an accessible entry point into embeddings for uses beyond RAG, not a production-ready product. It runs entirely client-side: embeddings are generated locally via [transformers.js](https://github.com/xenova/transformers.js) (ONNX/WASM), stored in IndexedDB, and explored through clustering (UMAP + hierarchical/DBSCAN) and a 2D map view (d3 + a custom HNSW index).

There is **no build system**: no `package.json`, no bundler, no linter/formatter config, and no test suite. All source is plain ES modules loaded directly by the browser, and every third-party library is vendored (checked into `libs/`/`css/` with version-suffixed filenames, e.g. `bootstrap-table.min.v1.22.4.js`) rather than installed via npm.

## Development workflow

Since there's no build step, development is edit-and-reload against an unpacked extension:

1. Load it: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the repo root (where `manifest.json` lives).
2. After editing any file, click the reload icon for the extension on `chrome://extensions`. Background service worker changes need this too — MV3 workers can go idle/stale, so a full reload (not just refreshing a page) ensures `js/background.js` re-runs `init()`.
3. Already-open extension tabs (`import.html`, `map.html`, etc.) need a manual page refresh after a reload to pick up JS/HTML/CSS changes.
4. Debugging: inspect `js/background.js` via the "service worker" link on `chrome://extensions`; debug page scripts (`import.js`, `map.js`, ...) via normal DevTools on the open extension tab.
5. There is no automated lint/test/build command to run — verify changes manually in the browser.

## Architecture

### Page map and entry points

The manifest declares no `default_popup`. The **only** programmatic navigation is `js/background.js`'s `chrome.action.onClicked` handler, which opens `html/import.html` in a new tab when the toolbar icon is clicked — that's the landing page. The other pages are reached only via in-page `<nav>`/offcanvas links between already-open tabs:

| Page | JS module | Purpose |
|---|---|---|
| `html/import.html` | `js/import.js` | Landing page: CSV import, field mapping, embedding/HNSW generation, search box |
| `html/cluster.html` | `js/cluster.js` | UMAP projection + DBSCAN + hierarchical clustering controls |
| `html/map.html` | `js/map.js` | Full-screen SVG map of the 2D-projected, clustered embeddings |
| `html/options.html` | `js/options.js` | Model management, IndexedDB store admin, OpenAI key entry |

`options.html` is additionally reachable through Chrome's native extension-options entry point (declared as `options_page` in `manifest.json`).

### Background service worker & message protocol (`js/background.js`, `js/messages.js`)

Every page talks to the background script over a **single long-lived `Port` named `"simcheck"`** (`chrome.runtime.connect`/`onConnect`) — there is no `chrome.runtime.onMessage` listener anywhere. `js/messages.js` exports `PortConnector`, the client-side wrapper: pages do `new PortConnector({customMessageHandler})` and `.postMessage({action: "..."})`; it lazily reconnects on disconnect.

On the background side, `port.onMessage` is a big `switch (message.action)`. Key actions:

| action | does |
|---|---|
| `init` | re-runs startup `init()` (loads settings + transformers.js pipeline) |
| `data-stored` | main trigger after CSV import: pulls rows from IndexedDB, generates embeddings (local HF pipeline or OpenAI) |
| `generateHNSW` / `restoreHNSW` | builds or rehydrates the in-memory HNSW index from IndexedDB-persisted node metadata |
| `searchHNSW` | embeds a query and runs `hnsw.searchKNN` |
| `search` | brute-force cosine search over all rows (`searchDataHF`/`searchDataOpenAi`) |
| `compare` / `compareEmbeddings` | HNSW-based comparison between two stores/objects |
| `processClusterData` | delegates to `processClusterData` in `js/clustering.js` |
| `getNumberOfTokens` | tokenizes text via `AutoTokenizer` |
| `getObjectStoreNames` | lists IndexedDB object stores |
| `download` | downloads/caches a transformers.js model, streaming progress |
| `createNotification` | `chrome.notifications.create` |

Unhandled actions fall through to a `404` reply. A `chrome.alarms` entry (`"keepAlive"`, every 0.5 min) pings the runtime purely to keep the MV3 service worker alive — unrelated to the message protocol itself.

Module-level state held by the worker: `embeddingsExtractor` (the loaded transformers.js pipeline, or `null` in OpenAI mode), `hnsw` (in-memory index), the `settings` singleton from `js/settings.js`, and a `ports` map. No IndexedDB connection is cached — `js/indexeddb.js` helpers open/close per call. `chrome.storage.local["lastMessage"]` caches the last broadcast so a page that connects late (e.g. after a reload mid-import) can recover current status.

transformers.js is loaded from `/libs/transformers.min.js` with `env.allowRemoteModels = true`, `env.allowLocalModels = false`, and WASM multithreading disabled (`numThreads = 1`, an onnxruntime-web workaround). The active model/task comes from `settings.pipeline` (default: `feature-extraction` / `sentence-transformers/all-MiniLM-L6-v2`).

### Storage layer (`js/indexeddb.js`, `js/settings.js`)

IndexedDB database/table names and `keyPath` are **not fixed** — they're read from `settings.indexedDB` (defaults: db `"simcheck"`, table/keyPath empty until a store is created/selected). `js/indexeddb.js` exports `openDatabase`, `getAllData`, `getFilteredData`, `saveData`/`addData` (put vs add, both dedupe against a caller-supplied key set + report progress), `deleteObjectStore`, `getObjectStoreNamesAndSizes`/`...AndMeta`, `getAllKeys`, `firstEntry`. There's no explicit schema migration: any write-mode `openDatabase` call bumps `version` and creates the store if missing.

`js/settings.js` persists the whole settings object as one blob under the `"settings"` key in `chrome.storage.local` (not `sync`), seeding defaults on first read and staying in sync across contexts via `chrome.storage.onChanged`.

### Import / export pipeline

Two independent import paths feed the same IndexedDB store:

- **CSV import** (`js/import.js`): drop/select a file → `Papa.parse` → user picks which columns to embed (Select2 + Sortable) → `saveData` to IndexedDB → posts `data-stored` on the `"simcheck"` port, which is where embeddings actually get generated (background side).
- **Re-import of previously exported data** (`js/filedrop.js`): accepts `.json`/`.json.gz` (gzip auto-detected by magic bytes, decompressed with `DecompressionStream`), reconstitutes `Float32Array` embedding fields, and calls `addData` directly (no re-embedding needed).

Export is split too: `js/download.js`'s `handleDownload` gzips full records (with typed arrays flattened) to `.json.gz`; `js/import.js` separately offers CSV/JSONL export via `Papa.unparse` + `saveDataAsFile` (from `js/table.js`).

Progress during import is shown via `js/progress.js`'s `setProgressbar`, fed both directly (local steps) and via `"loading"`/`"storing"`/`"embeddings-stored"` messages relayed from the background port.

### Map visualization (`js/map.js`)

`map.js` is a pure *consumer* — it does **not** run UMAP or clustering itself. It reads rows straight from IndexedDB expecting them to already carry `coordinates: [x, y]` and `dbscanCluster` (written upstream by the clustering pages), builds d3 linear scales from `d3.extent()`, and renders labels/circles with standard d3 `.data().join()`. Pan/zoom uses `d3.zoom()`, rectangle multi-select uses `d3.brush()`.

For fast viewport queries and label-overlap avoidance it builds **two [Flatbush](https://github.com/mourner/flatbush) R-tree indices** (`libs/flatbush.js`) — one over circle positions, one over label bounding boxes. This is easy to confuse with the HNSW index used elsewhere: **map.js uses Flatbush, not HNSW**; HNSW (`libs/hnsw.js`) is only used by `js/background.js` for embedding similarity search. Coupling between `map.js` and the clustering pages is entirely implicit, through shared IndexedDB fields (`coordinates`, `dbscanCluster`, `center`) — there are no direct imports between them. Handlebars precompiled templates (`templates/*.precompiled.js`) render the color-rule list and the related-items accordion.

### Clustering — several similarly named files, not all of them live

This area has accumulated parallel/experimental implementations. Check this table before assuming a file is wired in:

| File | Status | How it's invoked | What it does |
|---|---|---|---|
| `js/cluster.js` | **Live** | loaded by `html/cluster.html` | Full page controller: UMAP projection + DBSCAN + spawns `hclust-worker.js` for hierarchical clustering |
| `js/clusterNew.js` | **Dead / orphaned** | nothing references it (no HTML, no imports) | Same UI as `cluster.js` but routes hierarchical clustering through the background port instead of a Worker — looks like an abandoned migration attempt, not currently reachable |
| `js/clustering.js` | **Live** | imported by `js/background.js` (`processClusterData` action) | Pure hierarchical-clustering engine (no UMAP/DBSCAN), runs in the background service worker |
| `js/hclust-worker.js` | **Live** | `new Worker(...)`, spawned only by `js/cluster.js` | Web Worker running a hand-rolled agglomerative clustering algorithm (near-duplicate logic of `js/clustering.js`) |
| `libs/hclust.js` / `libs/hclust.min.js` | **Dead** | unreferenced anywhere | Vendored hierarchical-clustering library that the hand-rolled implementations in `clustering.js`/`hclust-worker.js` replaced but never removed |

If you're asked to change hierarchical clustering behavior, the two places that matter are `js/clustering.js` (background-routed) and `js/hclust-worker.js` (Worker-routed, used by the live `cluster.js` page) — they currently duplicate logic rather than sharing it.

### Vendored algorithm libraries (`libs/`)

| File | What it is | Provenance | Used by |
|---|---|---|---|
| `hnsw.js` | HNSW approximate-nearest-neighbor index | project-authored (see `git log -- libs/hnsw.js`) | `js/background.js` only, for embedding search |
| `flatbush.js` / `flatqueue.js` | Static R-tree spatial index + its priority queue | vendored (mourner/flatbush, mourner/flatqueue) | `js/map.js` only, for viewport/label queries |
| `dbscan.js` | DBSCAN density clustering | genuine third-party MIT drop (Lukasz Krawczyk), lightly extended with a cluster-centers helper | `js/cluster.js` |
| `similarity.js`, `pqueue.js`, `node.js` | cosine/euclidean distance, priority queue, graph node struct | small hand-written helpers | `libs/hnsw.js` only |
| `sbq.js` | scalar binary quantization for approximate distance | project-authored | **dead code** — unreferenced; `js/background.js` has its own duplicate `SBQ` class that's also commented out |

Don't assume every file in `libs/` is active — `sbq.js` and `hclust.js`/`hclust.min.js` above are vendored-but-unused.

### UI helper modules

- `js/table.js`: wires up `bootstrap-table`, building columns dynamically from whatever data array is handed to `generateTable()` (not an internal fetch); exposes CSV/JSONL export and "compare selected rows" as custom DOM events other pages listen for, not direct function calls.
- `js/progress.js`: one function, `setProgressbar(message)`, driving a single shared Bootstrap progress bar — the common sink for progress messages relayed from the background port across pages.
- `js/options.js`: model cache management (via the Cache Storage API), IndexedDB store admin, and the OpenAI key field; coordinates with `settings.js`, `indexeddb.js`, `download.js`, and `messages.js` directly rather than embedding the other pages' views.

## Conventions

- **Absolute-path ES module imports.** Code imports other project files by absolute path (e.g. `import { HNSW } from "/libs/hnsw.js"`, `import { getAllData } from "/js/indexeddb.js"`), which resolves against the extension root at `chrome-extension://<id>/`. Keep new imports absolute in this same style.
- **Handlebars templates are hand-precompiled.** `templates/*.handlebars` source files are not fetched or compiled at runtime — only `templates/*.precompiled.js` is loaded (by `map.js`, via `Handlebars.templates.<name>`). If you edit a `.handlebars` file, you must regenerate the matching `.precompiled.js` yourself (e.g. via the `handlebars` CLI) since no build tool does this automatically.
- **Vendoring, not npm.** Upgrading a third-party library means downloading the new version and replacing the version-suffixed file in `libs/`/`css/`, then updating the `<script>`/`<link>` reference(s) in the relevant `html/*.html` file(s).
- **CSP requires `wasm-unsafe-eval`** (`manifest.json`, for onnxruntime-web WASM used by transformers.js) — keep this in mind if adding new script sources or inline scripts, which the CSP (`script-src 'self' 'wasm-unsafe-eval'`) would otherwise block.
