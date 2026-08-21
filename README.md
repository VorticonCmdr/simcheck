# simcheck

a chrome extension to generate, compare and visualize vector embeddings

## download

[chrome web store](https://chromewebstore.google.com/detail/simcheck/eoefampiceefbaiejeialndangdcbbgb)

## goal

this is not meant as an production ready product but rather an accessible entrypoint into to using embeddings for other things than RAG only

## development

built with Vite + npm, via `@crxjs/vite-plugin` (MV3-aware bundling).

1. `npm install`
2. `npm run dev` starts the Vite dev server, or `npm run build` does a one-shot production build -- either way, output goes to `dist/`
3. load it as an unpacked extension: `chrome://extensions` -> enable **Developer mode** -> **Load unpacked** -> select `dist/`

there's no automated lint/test command yet, so `npm run build` + load-unpacked is the closest thing to a CI check this repo has -- verify changes manually in the browser. (`npm run lint` / `npm run format` are available for local use but aren't wired into `build`/`dev`.)

## versions

v0.0.3 – bug fixes for model changing bug
v0.0.2 – csv export bug fix
v0.0.1 – initial release

## help page

[google doc](https://docs.google.com/document/d/1wnIekRglMEkagw6dsucxNRkHclpQE_ptwkIyXzNvQ1s/)

## used libraries

### [transformers.js](https://github.com/xenova/transformers.js)

for sentence feature extraction and cosine similarity

### [PapaParse](https://github.com/mholt/PapaParse)

for CSV import/parsing

### [Bootstrap](https://github.com/twbs/bootstrap)

for nice layouts

### [Bootstrap Icons](https://github.com/twbs/icons)

nice svg icons

### [Bootstrap Table](https://github.com/wenzhixin/bootstrap-table)

for nice tables

### [jQuery](https://github.com/jquery/jquery)

for ease of Javascript use

### [handlebarsJS](https://handlebarsjs.com/)

for easy templating

### [sortable](https://sortablejs.github.io/Sortable/)

usability

### [select2](https://github.com/select2/select2)

better selects

### [umap-js](https://github.com/PAIR-code/umap-js)

vector projections

### [density-clustering](https://github.com/uhho/density-clustering)

fast clustering of 2d projected data

### [d3](https://github.com/d3/d3)

bring data to life with SVG
