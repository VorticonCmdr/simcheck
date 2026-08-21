# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

simcheck is a Chrome extension (Manifest V3) that generates, compares, and visualizes vector embeddings — an accessible entry point into embeddings for uses beyond RAG, not a production-ready product. It runs entirely client-side: embeddings are generated locally via [transformers.js](https://github.com/xenova/transformers.js) (ONNX/WASM), stored in IndexedDB, and explored through clustering (UMAP + hierarchical/DBSCAN) and a 2D map view (d3 + a custom HNSW index).

Builds with **Vite + npm**, via `@crxjs/vite-plugin` (MV3-aware bundling). There's still no automated test suite — verification is manual, in the browser — but `eslint`/`prettier` are wired in now. Not every dependency is npm-managed, though: see [Conventions](#conventions) for which libraries are real npm packages vs. still hand-vendored, and why.

## Development workflow

1. `npm install`.
2. `npm run dev` — starts the Vite/crxjs dev server. Load `dist/` as an unpacked extension: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`. Page-level changes hot-reload; a `js/background.js` edit triggers a full extension reload (MV3 service workers can't be hot-patched).
3. `npm run build` — one-shot production build to `dist/` (also regenerates `templates/*.precompiled.js` first, via `build:templates`). Load the same way for a production-like smoke test.
4. `npm run lint` — flat-config ESLint (`eslint.config.js`) over `js/`, `libs/` (excluding vendored/generated paths — see its file for the exact globs), with per-context globals (service worker, browser+jQuery, Web Worker, Node scripts). `npm run format` runs Prettier (`.prettierignore` excludes vendored/generated files and `.handlebars` templates, which Prettier can't parse).
5. Debugging: inspect the background service worker via the "service worker" link on `chrome://extensions`; debug page scripts via normal DevTools on the open extension tab.
6. There is still no automated test suite — verify changes manually in the browser (`npm run build` + load-unpacked, plus `npm run lint`, is the closest thing to a CI check this repo has).

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

Every page talks to the background script over a **single long-lived `Port` named `"simcheck"`** (`chrome.runtime.connect`/`onConnect`) — there is no `chrome.runtime.onMessage` listener anywhere. `js/messages.js` exports `PortConnector`, the client-side wrapper: pages do `new PortConnector({customMessageHandler, replayLastMessage})` and `.postMessage({action: "..."})`; it lazily reconnects on disconnect. `replayLastMessage: true` (used by `js/options.js`) replays `chrome.storage.local["lastMessage"]` into the handler once at construction time, then clears it — for a page that connects _after_ the background already broadcast the status it needs (see below).

On the background side, `port.onMessage` dispatches through a plain `actionHandlers` object (`{action: handlerFn}`) instead of a `switch`: each handler is a small named async function (`handleInit`, `handleDataStored`, `handleSearchHNSW`, etc.), and the listener itself is just a lookup + a shared try/catch that turns any thrown/rejected error into a `{status: 500, statusText, error}` reply instead of an unhandled rejection. An unrecognized action gets `{status: 404, statusText: "Not Found", request: message}`. Key actions:

| action                          | does                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `init`                          | re-runs startup `init()` (loads settings + transformers.js pipeline)                                         |
| `data-stored`                   | main trigger after CSV import: pulls rows from IndexedDB, generates embeddings (local HF pipeline or OpenAI) |
| `generateHNSW` / `restoreHNSW`  | builds or rehydrates the in-memory HNSW index from IndexedDB-persisted node metadata                         |
| `searchHNSW`                    | embeds a query and runs `hnsw.searchKNN`                                                                     |
| `search`                        | brute-force cosine search over all rows (`searchDataHF`/`searchDataOpenAi`)                                  |
| `compare` / `compareEmbeddings` | HNSW-based comparison between two stores/objects                                                             |
| `getNumberOfTokens`             | tokenizes text via `AutoTokenizer`                                                                           |
| `getObjectStoreNames`           | lists IndexedDB object stores                                                                                |
| `download`                      | downloads/caches a transformers.js model, streaming progress                                                 |
| `createNotification`            | `chrome.notifications.create`                                                                                |
| `ping` / `pong`                 | direct-reply liveness check (distinct from the `keepAlive` alarm below)                                      |

Each handler keeps its own original response mechanism — some `port.postMessage` a direct reply, others broadcast via `sendMessage` (which also persists to `chrome.storage.local["lastMessage"]`) — this split is deliberate, not something to normalize away; callers already expect one or the other per action. A `chrome.alarms` entry (`"keepAlive"`, every 0.5 min) pings the runtime purely to keep the MV3 service worker alive — unrelated to the message protocol itself.

`js/notify.js` exports `notifyError(message)`, used by all four page controllers as the one shared way to surface an error to the user: it lazily builds its own Bootstrap toast (icon + `bg-danger-subtle` header) on first use, so no page's HTML needs to pre-declare the markup.

Module-level state held by the worker: `embeddingsExtractor` (the loaded transformers.js pipeline, or `null` in OpenAI mode), `hnsw` (in-memory index), the `settings` singleton from `js/settings.js`, and a `ports` map. No IndexedDB connection is cached — `js/indexeddb.js` helpers open/close per call. `chrome.storage.local["lastMessage"]` caches the last broadcast so a page that connects late (e.g. after a reload mid-import) can recover current status.

transformers.js is loaded from `/libs/transformers.min.js` (vendored, but bundled by Vite like regular source — see [Build system](#build-system-vite--npm)) with `env.allowRemoteModels = true`, `env.allowLocalModels = false`, WASM multithreading disabled (`numThreads = 1`, an onnxruntime-web workaround), and `env.backends.onnx.wasm.wasmPaths = "/libs/"` pinning the `.wasm` binary lookup to their `public/libs/` passthrough location (decoupled from wherever Vite places the bundled `transformers.min.js` chunk itself). The active model/task comes from `settings.pipeline` (default: `feature-extraction` / `sentence-transformers/all-MiniLM-L6-v2`).

### Storage layer (`js/indexeddb.js`, `js/settings.js`)

IndexedDB database/table names and `keyPath` are **not fixed** — they're read from `settings.indexedDB` (defaults: db `"simcheck"`, table/keyPath empty until a store is created/selected). `js/indexeddb.js` exports `openDatabase`, `getAllData`, `getFilteredData`, `saveData`/`addData` (put vs add, both dedupe against a caller-supplied key set + report progress, and call `event.preventDefault()` in each per-item `onerror` so one bad record doesn't abort the whole transaction), `deleteObjectStore`, `getObjectStoreNamesAndSizes`/`...AndMeta`, `getAllKeys`, `firstEntry`. There's no explicit schema migration: any write-mode `openDatabase` call bumps `version` and creates the store if missing — the "read current version, reopen at version+1" logic that every write path needs is centralized in two internal helpers, `getCurrentDbVersion(settings)` and `openForWrite(settings)`, rather than duplicated per call site.

`js/settings.js` persists the whole settings object as one blob under the `"settings"` key in `chrome.storage.local` (not `sync`), seeding defaults on first read and staying in sync across contexts via `chrome.storage.onChanged`. `setSettings()` also updates the in-memory singleton synchronously before the `chrome.storage.local.set` callback fires, so a caller that sets and immediately re-reads settings in the same context doesn't have to wait on the `storage.onChanged` round-trip.

### Import / export pipeline

Two independent import paths feed the same IndexedDB store:

- **CSV import** (`js/import.js`): drop/select a file → `Papa.parse` → user picks which columns to embed (Select2 + Sortable) → `saveData` to IndexedDB → posts `data-stored` on the `"simcheck"` port, which is where embeddings actually get generated (background side).
- **Re-import of previously exported data** (`js/filedrop.js`): accepts `.json`/`.json.gz` (gzip auto-detected by magic bytes, decompressed with `DecompressionStream`), reconstitutes `Float32Array` embedding fields, and calls `addData` directly (no re-embedding needed).

Export is split too: `js/download.js`'s `handleDownload` gzips full records (with typed arrays flattened) to `.json.gz`; `js/import.js` separately offers CSV/JSONL export via `Papa.unparse` + `saveDataAsFile` (from `js/table.js`).

Progress during import is shown via `js/progress.js`'s `setProgressbar`, fed both directly (local steps) and via `"loading"`/`"storing"`/`"embeddings-stored"` messages relayed from the background port.

### Map visualization (`js/map.js`)

`map.js` is a pure _consumer_ — it does **not** run UMAP or clustering itself. It reads rows straight from IndexedDB expecting them to already carry `coordinates: [x, y]` and `dbscanCluster` (written upstream by the clustering pages), builds d3 linear scales from `d3.extent()`, and renders labels/circles with standard d3 `.data().join()`. Pan/zoom uses `d3.zoom()`, rectangle multi-select uses `d3.brush()`.

For fast viewport queries and label-overlap avoidance it builds **two [Flatbush](https://github.com/mourner/flatbush) R-tree indices** (`libs/flatbush.js`) — one over circle positions, one over label bounding boxes. This is easy to confuse with the HNSW index used elsewhere: **map.js uses Flatbush, not HNSW**; HNSW (`libs/hnsw.js`) is only used by `js/background.js` for embedding similarity search. Coupling between `map.js` and the clustering pages is entirely implicit, through shared IndexedDB fields (`coordinates`, `dbscanCluster`, `center`) — there are no direct imports between them. Handlebars precompiled templates (`public/templates/*.precompiled.js`, auto-regenerated from `templates/*.handlebars` — see [Build system](#build-system-vite--npm)) render the color-rule list and the related-items accordion.

The module-level mutable state is split into two objects: `board` (per-render d3/Flatbush state — `svg`, `circles`, `labels`, `xScale`/`yScale`, `zoom`/`zoomer`, `brush`, `flatbushIndex`, `numberOfClusters`, ...) and `config` (user-configurable display settings — colors, opacity, which fields are selected as title/description, regex color rules). A separate module-level `mapDataById` object holds the raw IndexedDB rows keyed by `keyPath` (distinct from `board.mapsData`, the array of those same rows used for rendering — the two used to share the confusable name `mapData`/`mapsData`). `board.numberOfClusters` is recomputed by `setupClusterSelect()` as the count of rows flagged `center: true`, which is guaranteed to equal the number of distinct `dbscanCluster` values since each cluster gets exactly one center-flagged row.

`generateMap()` — the async function that (re)draws the whole SVG after data loads or the object store changes — is decomposed into named steps called in sequence: `renderLoadingState()`, `computeCoordinateScales()`, `renderLabels()`, `setupBrush()`, `buildFlatbush()`, `renderCircles()`, `setupZoomBehavior()`, `initializeTooltips()`, `wireMapInteractions()`, then `setupClusterSelect()`/`setupBoundingBoxes()`. A commented-out "blur map" feature and a handful of zero-call-site helpers (`throttle`, `debounce`, `getOverlapFromTwoExtents`, ...) that had accumulated in this file were removed as dead code. Given how many functions read/write `board`/`config` directly (80+ references), a full split into separate modules (spatial index, zoom/pan, color rules, accordion, render) was deliberately **not** done — the risk of a clean-boundary rewrite in the most interaction-heavy, hardest-to-fully-test page outweighed the benefit; the step-function decomposition above is the scoped-down alternative.

### Clustering

`js/cluster.js` (loaded by `html/cluster.html`) is the page controller: UMAP projection + DBSCAN, then hierarchical clustering via `js/hclust-worker.js`, a real Vite-bundled module Worker instantiated as:

```js
new Worker(new URL("./hclust-worker.js", import.meta.url), { type: "module" });
```

This used to be a classic non-module script (`public/js/hclust-worker.js`, `new Worker("/js/hclust-worker.js")`) because a runtime string passed to `new Worker(...)` isn't statically discoverable by Vite's bundler the way an `import`ed module is; it moved back to `js/` and became a real module once it needed genuine `import` statements (see below), converting the instantiation to the `new URL(..., import.meta.url)` form Vite _can_ trace.

The hierarchical-clustering math itself lives in `libs/hclustAlgorithm.js` — a shared engine (`clusterData`, `calculateWithinClusterVariance`, `findOptimalClusters`, `loopTables`, `euclideanDistance`/`averageDistance`, using `cosineSimilarity` from `libs/similarity.js`) extracted from what used to be **two independently hand-rolled, already-drifted copies**: a background-routed `js/clustering.js` (reachable only via `js/clusterNew.js`, an orphaned/dead alternate UI that never shipped) and the original `public/js/hclust-worker.js`. Both `js/clustering.js` and `js/clusterNew.js` were deleted once the duplication was resolved — `js/hclust-worker.js` is now the only hierarchical-clustering call path, and there is no `processClusterData` background action anymore. A vendored `libs/hclust.js`/`hclust.min.js` library that neither copy actually used was removed at the same time.

`hclustAlgorithm.js`'s `updateProgress` reports progress as a plain `{progress, name}` object; each caller adapts that into whatever shape its own transport needs (`js/hclust-worker.js`'s `postMessage`, vs. a background-routed caller's `sendMessage` broadcast) rather than the shared module assuming one or the other.

### Vendored algorithm libraries (`libs/`)

| File                                    | What it is                                                   | Provenance                                                                                     | Used by                                       |
| --------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `hnsw.js`                               | HNSW approximate-nearest-neighbor index                      | project-authored (see `git log -- libs/hnsw.js`)                                               | `js/background.js` only, for embedding search |
| `flatbush.js` / `flatqueue.js`          | Static R-tree spatial index + its priority queue             | vendored (mourner/flatbush, mourner/flatqueue)                                                 | `js/map.js` only, for viewport/label queries  |
| `dbscan.js`                             | DBSCAN density clustering                                    | genuine third-party MIT drop (Lukasz Krawczyk), lightly extended with a cluster-centers helper | `js/cluster.js`                               |
| `similarity.js`, `pqueue.js`, `node.js` | cosine/euclidean distance, priority queue, graph node struct | small hand-written helpers                                                                     | `libs/hnsw.js` only                           |
| `hclustAlgorithm.js`                    | shared hierarchical-clustering engine                        | project-authored (extracted from two drifted duplicates — see [Clustering](#clustering))       | `js/hclust-worker.js` only                    |

`npm run lint` currently reports 7 pre-existing `no-unused-vars` warnings (0 errors) scattered across the codebase — e.g. `js/background.js`'s commented-out `SBQ` (scalar binary quantization) class, `maxSimilarity` in `compareArrays`, and `findCentralItems`; `js/import.js`'s `getSerpData`; `js/options.js`'s `getCacheStorageSize`; `js/map.js`'s `tooltipList`; `libs/hnsw.js`'s `MinHeap`. These are left alone as pre-existing, out-of-scope dead code rather than folded into unrelated changes — don't be surprised they're still there.

### Build system (Vite + npm)

`vite.config.js` uses `@crxjs/vite-plugin`'s `crx({ manifest })` (fed `manifest.json` directly — crxjs never touches its CSP, in dev or build) plus `vite-plugin-static-copy` for the two libraries that need npm version tracking but must stay classic global-namespace `<script>` tags (see the jQuery/select2 row in the [Conventions](#conventions) table below). Two things aren't auto-discoverable by Vite's static analysis and need explicit `build.rollupOptions.input` entries in `vite.config.js`: `html/import.html`, `html/cluster.html`, and `html/map.html` (none are referenced by any manifest key — `options.html` _is_, via `options_page`, so it's auto-discovered). `resolve.alias` maps `/js/`, `/libs/`, `/css/`, `/templates/` to their source directories so the codebase's existing absolute-path `import` convention keeps working unchanged.

**`public/` holds everything that must ship byte-identical and untouched** by Vite's module graph: the `ort-wasm*.wasm` binaries (fetched at runtime by transformers.js itself, never `import`ed — see above), the `bootstrap-table`/`tableExport` family (classic scripts depending on a pre-existing `window.jQuery` global), the Handlebars runtime + precompiled templates (same classic-script/global constraint), and the manifest's `icons/`. Anything placed there is copied straight through to the matching path under `dist/`. (`js/hclust-worker.js` used to live here as a classic script for the same "Vite can't statically discover a runtime `new Worker(...)` string" reason — see [Clustering](#clustering) — but moved back to `js/` once it needed real `import` statements, becoming a proper bundled module Worker instead.)

`scripts/build-templates.js` (run via `npm run build:templates`, wired as a `predev`/pre-`build` step) shells out to the `handlebars` npm package's CLI to regenerate `public/templates/*.precompiled.js` from `templates/*.handlebars` — this replaced a manual "run the handlebars CLI yourself" step.

### UI helper modules

- `js/table.js`: wires up `bootstrap-table`, building columns dynamically from whatever data array is handed to `generateTable()` (not an internal fetch); exposes CSV/JSONL export and "compare selected rows" as custom DOM events other pages listen for, not direct function calls.
- `js/progress.js`: one function, `setProgressbar(message)`, driving a single shared Bootstrap progress bar — the common sink for progress messages relayed from the background port across pages.
- `js/notify.js`: one function, `notifyError(message)` — the shared error-toast helper described in [Background service worker & message protocol](#background-service-worker--message-protocol-jsbackgroundjs-jsmessagesjs) above, used by all four page controllers.
- `js/options.js`: model cache management (via the Cache Storage API), IndexedDB store admin, and the OpenAI key field; coordinates with `settings.js`, `indexeddb.js`, `download.js`, and `messages.js` directly rather than embedding the other pages' views.

## Conventions

- **Absolute-path ES module imports.** Code imports other project files by absolute path (e.g. `import { HNSW } from "/libs/hnsw.js"`, `import { getAllData } from "/js/indexeddb.js"`). Under Vite this is resolved via explicit `resolve.alias` entries in `vite.config.js` (not Vite's native root-relative resolution, to sidestep known Rollup edge cases) — keep new same-project imports absolute in this same style.
- **Not every dependency is npm-managed — three tiers, by why:**

  | Tier                                                         | Libraries                                                                                      | How it's loaded                                                                                                                                                                           | Why                                                                                                                                                                                                                                                                                                                     |
  | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Real npm import                                              | `d3`, `umap-js`, `papaparse`, `sortablejs`, `bootstrap` (+`@popperjs/core`), `bootstrap-icons` | `import` in the relevant `js/*.js` page module                                                                                                                                            | No classic script depends on them as a global — clean module-graph migration. Upgrading is `npm update`.                                                                                                                                                                                                                |
  | npm-managed, classic-script delivery                         | `jquery`, `select2`                                                                            | `vite-plugin-static-copy` copies `node_modules/.../dist/*.min.js` to `public`-equivalent build output at the same `/libs/` path the HTML `<script>` tags reference (see `vite.config.js`) | `bootstrap-table` (next tier) needs `window.jQuery` present _before_ it runs, and `<script type="module">` execution is always deferred until after classic scripts — so these can't be ES-imported into the module graph. Still real `package.json` dependencies; only the delivery mechanism is a copy, not a bundle. |
  | Fully vendored (hand-downloaded, version-suffixed filenames) | `bootstrap-table`/`tableExport` family, `handlebars.runtime`                                   | classic `<script>`, source lives in `public/` (byte-identical passthrough)                                                                                                                | Genuinely third-party, no npm migration attempted (specific export-plugin wiring / precompiled-template coupling not worth the risk). Upgrading means downloading the new version and replacing the file in `public/libs/`, `public/css/`, or `public/templates/`.                                                      |

  `transformers.min.js` and the small project-authored `libs/` algorithm files (`hnsw.js`, `dbscan.js`, `similarity.js`, `pqueue.js`, `node.js`, `flatbush.js`, `flatqueue.js`, `hclustAlgorithm.js`) are also vendored, but live in `libs/` (not `public/`) and get bundled by Vite like normal source, since they're consumed via genuine `import` statements rather than classic `<script>` tags.

- **Handlebars templates are build-precompiled, not hand-precompiled.** `templates/*.handlebars` source files are compiled to `public/templates/*.precompiled.js` by `npm run build:templates` (`scripts/build-templates.js`), wired into both `npm run dev` and `npm run build` — see [Build system](#build-system-vite--npm). Editing a `.handlebars` file no longer requires a manual CLI step.
- **CSP requires `wasm-unsafe-eval`** (`manifest.json`, for onnxruntime-web WASM used by transformers.js) — keep this in mind if adding new script sources or inline scripts, which the CSP (`script-src 'self' 'wasm-unsafe-eval'`) would otherwise block. `@crxjs/vite-plugin` doesn't modify this CSP in either dev or build.
