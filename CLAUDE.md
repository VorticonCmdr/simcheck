# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

simcheck is a Chrome extension (Manifest V3) that generates, compares, and visualizes vector embeddings — an accessible entry point into embeddings for uses beyond RAG, not a production-ready product. It runs entirely client-side: embeddings are generated locally via [transformers.js](https://github.com/xenova/transformers.js) (ONNX/WASM), stored in IndexedDB, and explored through clustering (UMAP + hierarchical/DBSCAN) and a 2D map view (d3 + a custom HNSW index).

Builds with **Vite + npm**, via `@crxjs/vite-plugin` (MV3-aware bundling). There's still no test suite or linter — verification is manual, in the browser. Not every dependency is npm-managed, though: see [Conventions](#conventions) for which libraries are real npm packages vs. still hand-vendored, and why.

## Development workflow

1. `npm install`.
2. `npm run dev` — starts the Vite/crxjs dev server. Load `dist/` as an unpacked extension: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`. Page-level changes hot-reload; a `js/background.js` edit triggers a full extension reload (MV3 service workers can't be hot-patched).
3. `npm run build` — one-shot production build to `dist/` (also regenerates `templates/*.precompiled.js` first, via `build:templates`). Load the same way for a production-like smoke test.
4. Debugging: inspect the background service worker via the "service worker" link on `chrome://extensions`; debug page scripts via normal DevTools on the open extension tab.
5. There is no automated lint/test command — verify changes manually in the browser (`npm run build` + load-unpacked is the closest thing to a CI check this repo has).

## Architecture

### Page map and entry points

The manifest declares no `default_popup`. The **only** programmatic navigation is `js/background.js`'s `chrome.action.onClicked` handler, which opens `html/import.html` in a new tab when the toolbar icon is clicked — that's the landing page. The other pages are reached only via in-page `<nav>`/offcanvas links between already-open tabs:

| Page                | JS module       | Purpose                                                                        |
| ------------------- | --------------- | ------------------------------------------------------------------------------ |
| `html/import.html`  | `js/import.js`  | Landing page: CSV import, field mapping, embedding/HNSW generation, search box |
| `html/cluster.html` | `js/cluster.js` | UMAP projection + DBSCAN + hierarchical clustering controls                    |
| `html/map.html`     | `js/map.js`     | Full-screen SVG map of the 2D-projected, clustered embeddings                  |
| `html/options.html` | `js/options.js` | Model management, IndexedDB store admin, OpenAI key entry                      |

`options.html` is additionally reachable through Chrome's native extension-options entry point (declared as `options_page` in `manifest.json`).

### Background service worker & message protocol (`js/background.js`, `js/messages.js`)

Every page talks to the background script over a **single long-lived `Port` named `"simcheck"`** (`chrome.runtime.connect`/`onConnect`) — there is no `chrome.runtime.onMessage` listener anywhere. `js/messages.js` exports `PortConnector`, the client-side wrapper: pages do `new PortConnector({customMessageHandler})` and `.postMessage({action: "..."})`; it lazily reconnects on disconnect.

On the background side, `port.onMessage` is a big `switch (message.action)`. Key actions:

| action                          | does                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `init`                          | re-runs startup `init()` (loads settings + transformers.js pipeline)                                         |
| `data-stored`                   | main trigger after CSV import: pulls rows from IndexedDB, generates embeddings (local HF pipeline or OpenAI) |
| `generateHNSW` / `restoreHNSW`  | builds or rehydrates the in-memory HNSW index from IndexedDB-persisted node metadata                         |
| `searchHNSW`                    | embeds a query and runs `hnsw.searchKNN`                                                                     |
| `search`                        | brute-force cosine search over all rows (`searchDataHF`/`searchDataOpenAi`)                                  |
| `compare` / `compareEmbeddings` | HNSW-based comparison between two stores/objects                                                             |
| `processClusterData`            | delegates to `processClusterData` in `js/clustering.js`                                                      |
| `getNumberOfTokens`             | tokenizes text via `AutoTokenizer`                                                                           |
| `getObjectStoreNames`           | lists IndexedDB object stores                                                                                |
| `download`                      | downloads/caches a transformers.js model, streaming progress                                                 |
| `createNotification`            | `chrome.notifications.create`                                                                                |

Unhandled actions fall through to a `404` reply. A `chrome.alarms` entry (`"keepAlive"`, every 0.5 min) pings the runtime purely to keep the MV3 service worker alive — unrelated to the message protocol itself.

Module-level state held by the worker: `embeddingsExtractor` (the loaded transformers.js pipeline, or `null` in OpenAI mode), `hnsw` (in-memory index), the `settings` singleton from `js/settings.js`, and a `ports` map. No IndexedDB connection is cached — `js/indexeddb.js` helpers open/close per call. `chrome.storage.local["lastMessage"]` caches the last broadcast so a page that connects late (e.g. after a reload mid-import) can recover current status.

transformers.js is loaded from `/libs/transformers.min.js` (vendored, but bundled by Vite like regular source — see [Build system](#build-system-vite--npm)) with `env.allowRemoteModels = true`, `env.allowLocalModels = false`, WASM multithreading disabled (`numThreads = 1`, an onnxruntime-web workaround), and `env.backends.onnx.wasm.wasmPaths = "/libs/"` pinning the `.wasm` binary lookup to their `public/libs/` passthrough location (decoupled from wherever Vite places the bundled `transformers.min.js` chunk itself). The active model/task comes from `settings.pipeline` (default: `feature-extraction` / `sentence-transformers/all-MiniLM-L6-v2`).

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

`map.js` is a pure _consumer_ — it does **not** run UMAP or clustering itself. It reads rows straight from IndexedDB expecting them to already carry `coordinates: [x, y]` and `dbscanCluster` (written upstream by the clustering pages), builds d3 linear scales from `d3.extent()`, and renders labels/circles with standard d3 `.data().join()`. Pan/zoom uses `d3.zoom()`, rectangle multi-select uses `d3.brush()`.

For fast viewport queries and label-overlap avoidance it builds **two [Flatbush](https://github.com/mourner/flatbush) R-tree indices** (`libs/flatbush.js`) — one over circle positions, one over label bounding boxes. This is easy to confuse with the HNSW index used elsewhere: **map.js uses Flatbush, not HNSW**; HNSW (`libs/hnsw.js`) is only used by `js/background.js` for embedding similarity search. Coupling between `map.js` and the clustering pages is entirely implicit, through shared IndexedDB fields (`coordinates`, `dbscanCluster`, `center`) — there are no direct imports between them. Handlebars precompiled templates (`public/templates/*.precompiled.js`, auto-regenerated from `templates/*.handlebars` — see [Build system](#build-system-vite--npm)) render the color-rule list and the related-items accordion.

### Clustering — several similarly named files, not all of them live

This area has accumulated parallel/experimental implementations. Check this table before assuming a file is wired in:

| File                                    | Status              | How it's invoked                                                      | What it does                                                                                                                                                                    |
| --------------------------------------- | ------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `js/cluster.js`                         | **Live**            | loaded by `html/cluster.html`                                         | Full page controller: UMAP projection + DBSCAN + spawns `hclust-worker.js` for hierarchical clustering                                                                          |
| `js/clusterNew.js`                      | **Dead / orphaned** | nothing references it (no HTML, no imports)                           | Same UI as `cluster.js` but routes hierarchical clustering through the background port instead of a Worker — looks like an abandoned migration attempt, not currently reachable |
| `js/clustering.js`                      | **Live**            | imported by `js/background.js` (`processClusterData` action)          | Pure hierarchical-clustering engine (no UMAP/DBSCAN), runs in the background service worker                                                                                     |
| `public/js/hclust-worker.js`            | **Live**            | `new Worker("/js/hclust-worker.js")`, spawned only by `js/cluster.js` | Web Worker running a hand-rolled agglomerative clustering algorithm (near-duplicate logic of `js/clustering.js`)                                                                |
| `libs/hclust.js` / `libs/hclust.min.js` | **Dead**            | unreferenced anywhere                                                 | Vendored hierarchical-clustering library that the hand-rolled implementations in `clustering.js`/`hclust-worker.js` replaced but never removed                                  |

If you're asked to change hierarchical clustering behavior, the two places that matter are `js/clustering.js` (background-routed) and `public/js/hclust-worker.js` (Worker-routed, used by the live `cluster.js` page) — they currently duplicate logic rather than sharing it. `hclust-worker.js` lives under `public/` rather than `js/` because it's instantiated via a runtime string (`new Worker("/js/hclust-worker.js")`), which the Vite build can't statically discover the way it discovers `import`ed modules — see [Build system](#build-system-vite--npm) below.

### Vendored algorithm libraries (`libs/`)

| File                                    | What it is                                                   | Provenance                                                                                     | Used by                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `hnsw.js`                               | HNSW approximate-nearest-neighbor index                      | project-authored (see `git log -- libs/hnsw.js`)                                               | `js/background.js` only, for embedding search                                                                |
| `flatbush.js` / `flatqueue.js`          | Static R-tree spatial index + its priority queue             | vendored (mourner/flatbush, mourner/flatqueue)                                                 | `js/map.js` only, for viewport/label queries                                                                 |
| `dbscan.js`                             | DBSCAN density clustering                                    | genuine third-party MIT drop (Lukasz Krawczyk), lightly extended with a cluster-centers helper | `js/cluster.js`                                                                                              |
| `similarity.js`, `pqueue.js`, `node.js` | cosine/euclidean distance, priority queue, graph node struct | small hand-written helpers                                                                     | `libs/hnsw.js` only                                                                                          |
| `sbq.js`                                | scalar binary quantization for approximate distance          | project-authored                                                                               | **dead code** — unreferenced; `js/background.js` has its own duplicate `SBQ` class that's also commented out |

Don't assume every file in `libs/` is active — `sbq.js` and `hclust.js`/`hclust.min.js` above are vendored-but-unused.

### Build system (Vite + npm)

`vite.config.js` uses `@crxjs/vite-plugin`'s `crx({ manifest })` (fed `manifest.json` directly — crxjs never touches its CSP, in dev or build) plus `vite-plugin-static-copy` for the two libraries that need npm version tracking but must stay classic global-namespace `<script>` tags (see the jQuery/select2 row in the [Conventions](#conventions) table below). Two things aren't auto-discoverable by Vite's static analysis and need explicit `build.rollupOptions.input` entries in `vite.config.js`: `html/import.html`, `html/cluster.html`, and `html/map.html` (none are referenced by any manifest key — `options.html` _is_, via `options_page`, so it's auto-discovered). `resolve.alias` maps `/js/`, `/libs/`, `/css/`, `/templates/` to their source directories so the codebase's existing absolute-path `import` convention keeps working unchanged.

**`public/` holds everything that must ship byte-identical and untouched** by Vite's module graph: the `ort-wasm*.wasm` binaries (fetched at runtime by transformers.js itself, never `import`ed — see above), the `bootstrap-table`/`tableExport` family (classic scripts depending on a pre-existing `window.jQuery` global), the Handlebars runtime + precompiled templates (same classic-script/global constraint), the manifest's `icons/`, and `public/js/hclust-worker.js` (see the clustering table above for why). Anything placed there is copied straight through to the matching path under `dist/`.

`scripts/build-templates.js` (run via `npm run build:templates`, wired as a `predev`/pre-`build` step) shells out to the `handlebars` npm package's CLI to regenerate `public/templates/*.precompiled.js` from `templates/*.handlebars` — this replaced a manual "run the handlebars CLI yourself" step.

### UI helper modules

- `js/table.js`: wires up `bootstrap-table`, building columns dynamically from whatever data array is handed to `generateTable()` (not an internal fetch); exposes CSV/JSONL export and "compare selected rows" as custom DOM events other pages listen for, not direct function calls.
- `js/progress.js`: one function, `setProgressbar(message)`, driving a single shared Bootstrap progress bar — the common sink for progress messages relayed from the background port across pages.
- `js/options.js`: model cache management (via the Cache Storage API), IndexedDB store admin, and the OpenAI key field; coordinates with `settings.js`, `indexeddb.js`, `download.js`, and `messages.js` directly rather than embedding the other pages' views.

## Conventions

- **Absolute-path ES module imports.** Code imports other project files by absolute path (e.g. `import { HNSW } from "/libs/hnsw.js"`, `import { getAllData } from "/js/indexeddb.js"`). Under Vite this is resolved via explicit `resolve.alias` entries in `vite.config.js` (not Vite's native root-relative resolution, to sidestep known Rollup edge cases) — keep new same-project imports absolute in this same style.
- **Not every dependency is npm-managed — three tiers, by why:**

  | Tier                                                         | Libraries                                                                                      | How it's loaded                                                                                                                                                                           | Why                                                                                                                                                                                                                                                                                                                     |
  | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Real npm import                                              | `d3`, `umap-js`, `papaparse`, `sortablejs`, `bootstrap` (+`@popperjs/core`), `bootstrap-icons` | `import` in the relevant `js/*.js` page module                                                                                                                                            | No classic script depends on them as a global — clean module-graph migration. Upgrading is `npm update`.                                                                                                                                                                                                                |
  | npm-managed, classic-script delivery                         | `jquery`, `select2`                                                                            | `vite-plugin-static-copy` copies `node_modules/.../dist/*.min.js` to `public`-equivalent build output at the same `/libs/` path the HTML `<script>` tags reference (see `vite.config.js`) | `bootstrap-table` (next tier) needs `window.jQuery` present _before_ it runs, and `<script type="module">` execution is always deferred until after classic scripts — so these can't be ES-imported into the module graph. Still real `package.json` dependencies; only the delivery mechanism is a copy, not a bundle. |
  | Fully vendored (hand-downloaded, version-suffixed filenames) | `bootstrap-table`/`tableExport` family, `handlebars.runtime`                                   | classic `<script>`, source lives in `public/` (byte-identical passthrough)                                                                                                                | Genuinely third-party, no npm migration attempted (specific export-plugin wiring / precompiled-template coupling not worth the risk). Upgrading means downloading the new version and replacing the file in `public/libs/`, `public/css/`, or `public/templates/`.                                                      |

  `transformers.min.js` and the small project-authored `libs/` algorithm files (`hnsw.js`, `dbscan.js`, `similarity.js`, `pqueue.js`, `node.js`, `flatbush.js`, `flatqueue.js`) are also vendored, but live in `libs/` (not `public/`) and get bundled by Vite like normal source, since they're consumed via genuine `import` statements rather than classic `<script>` tags.

- **Handlebars templates are build-precompiled, not hand-precompiled.** `templates/*.handlebars` source files are compiled to `public/templates/*.precompiled.js` by `npm run build:templates` (`scripts/build-templates.js`), wired into both `npm run dev` and `npm run build` — see [Build system](#build-system-vite--npm). Editing a `.handlebars` file no longer requires a manual CLI step.
- **CSP requires `wasm-unsafe-eval`** (`manifest.json`, for onnxruntime-web WASM used by transformers.js) — keep this in mind if adding new script sources or inline scripts, which the CSP (`script-src 'self' 'wasm-unsafe-eval'`) would otherwise block. `@crxjs/vite-plugin` doesn't modify this CSP in either dev or build.
