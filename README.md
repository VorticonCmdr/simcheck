# simcheck
a chrome extension to generate, compare and visualize vector embeddings

## download
[chrome web store](https://chromewebstore.google.com/detail/simcheck/eoefampiceefbaiejeialndangdcbbgb)

## goal
this is not meant as an production ready product but rather an accessible entrypoint into to using embeddings for other things than RAG only

## development
```bash
npm install
npm run build
```
then load the `dist` folder at `chrome://extensions/` with "Load unpacked". `npm test` runs the tests.

data from earlier versions is copied to the new format on first start.

## versions
v0.1.0 – single-page workspace, background jobs, new storage, reworked clustering and map
v0.0.3 – bug fixes for model changing bug
v0.0.2 – csv export bug fix
v0.0.1 – initial release

## help page
[google doc](https://docs.google.com/document/d/1wnIekRglMEkagw6dsucxNRkHclpQE_ptwkIyXzNvQ1s/)

## used libraries

### [transformers.js](https://github.com/xenova/transformers.js)
for sentence feature extraction

### [Preact](https://github.com/preactjs/preact)
for the interface

### [PapaParse](https://github.com/mholt/PapaParse)
for CSV import/parsing

### [Bootstrap](https://github.com/twbs/bootstrap)
for nice layouts

### [umap-js](https://github.com/PAIR-code/umap-js)
vector projections

### [Flatbush](https://github.com/mourner/flatbush)
spatial index for clustering and the map
