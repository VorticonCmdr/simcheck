# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**simcheck** is a Chrome extension (Manifest V3) for generating, comparing, and visualizing vector embeddings. It's a single-page workspace built with Vite, Preact and TypeScript.

## Commands

```bash
npm install
npm run build      # outputs dist/
npm run watch      # rebuilds dist/ on change
npm test           # Vitest, covers src/core
npm run typecheck
```

Load `dist/` (not the repo root) at `chrome://extensions/` with "Load unpacked". After rebuilding, click the refresh icon on the extension card and reload open extension tabs.

## Architecture

### Contexts

| Context | Entry | Role |
|---------|-------|------|
| Workspace page | `index.html`, `src/ui/main.tsx` | All UI. Reads IndexedDB directly; writes imported rows |
| Service worker | `src/background/index.ts` | Job registry, broadcasts to every open tab, OpenAI calls, migration trigger. Stops when idle, so it keeps no state that isn't also in `chrome.storage.session` |
| Offscreen document | `offscreen.html`, `src/offscreen/index.ts` | Runs all long work: model inference (`models.ts`), plus workers. Outlives tabs and the service worker. Has no `chrome.storage`, so configuration arrives in messages |
| Workers | `src/offscreen/vector.worker.ts`, `compareShard.worker.ts`, `cluster.worker.ts` | Flat search; dataset comparison split across cores over shared memory; UMAP, clustering. One-off job workers are cancelled by terminating them |

### Jobs

Every long operation is a `Job` (`src/core/types.ts`, reducer in `src/core/jobs.ts`). The page sends a request over a port, the service worker creates the job and starts it in the offscreen document, and the offscreen document reports `JobUpdate`s back; the service worker broadcasts each to all tabs. To add one: a kind in `JobKind`, a case in `handleRequest` (background) and in `runJob` (offscreen).

### Storage

`src/core/db.ts` owns the `simcheck-v2` database. It has a fixed set of stores, so a new dataset never needs a version bump:

- `datasets`: metadata, including which columns were embedded (`textFields`) and which name the clusters (`termFields`, unset means the embedded ones)
- `rows`: `[datasetId, key]`
- `embeddings`: `[datasetId, modelKey, key]`, with a hash of the embedded text so unchanged rows are skipped and interrupted runs resume
- `projections`: `[datasetId, modelKey]`, one record with the map coordinates, the 5D clustering layout, labels and cluster summaries
- `results`: dataset comparisons

`modelKey` (`src/core/settings.ts`) includes pooling and dtype, because those change the vectors: embeddings from different configurations must never be mixed.

`src/core/migrate.ts` copies the old `simcheck` database (one object store per dataset) once, and leaves it in place.

### Models

- **Local:** transformers.js and its ONNX Runtime files are vendored in `public/libs/` and imported at runtime, because they load their WASM relative to themselves. Threads rely on the COOP/COEP headers in `public/manifest.json`.
- **OpenAI:** model ids start with `openai/`. Requests run in the service worker, so the key stays out of the other contexts.

### Testing with puppeteer

Don't trust a stall that only shows up during puppeteer's startup: a document created in that window, as the migration on first start does, can stay frozen until CDP attaches to it. To test the first start, launch Chrome without a debugging port and inspect the result afterwards.

### Content Security Policy

`script-src 'self' 'wasm-unsafe-eval'`: no `eval`, inline or remote scripts, and no `blob:` scripts either, which is why PapaParse runs with `chunk` rather than `worker`.
