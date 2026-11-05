import { UMAP } from "umap-js";
import { rowText, termColumns } from "../core/csv";
import { getDataset, getProjection, loadMatrix, putProjection, readRows } from "../core/db";
import { dbscan, dbscan2d, NOISE, suggestEps } from "../core/dbscan";
import { defaultMinClusterSize, hdbscan } from "../core/hdbscan";
import {
  MAX_AHC_POINTS,
  averageLinkage,
  chooseK,
  cosineDistances,
  cutTree,
  heightCurve,
} from "../core/hclust";
import type { ClusterPayload, ReclusterPayload } from "../core/protocol";
import {
  alignVectors,
  assignNoise,
  mergeLabels,
  relabelBySize,
  sameKeys,
  silhouette,
  summarizeClusters,
  type Vectors,
} from "../core/summary";
import type { ClusterSettings, Dataset, Projection, ProjectionParams } from "../core/types";

const CLUSTER_DIMS = 5;

const progress = (phase: string, fraction: number | null = null) =>
  postMessage({ type: "progress", phase, progress: fraction });

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function rowTexts(datasetId: string, fields: string[], keys: string[]): Promise<string[]> {
  const byKey = new Map<string, string>();
  let after: string | null = null;
  for (;;) {
    const page = await readRows(datasetId, after, 2000);
    if (!page.length) break;
    after = page[page.length - 1].key;
    for (const row of page) byKey.set(row.key, rowText(row.data, fields));
  }
  return keys.map((key) => byKey.get(key) ?? "");
}

interface Guide {
  labels: number[] | null;
  curve: { k: number; height: number }[] | null;
  k: number | null;
}

function computeGuide(matrix: Float32Array, n: number, d: number, params: ProjectionParams): Guide {
  if (params.guide === "ahc") {
    if (n > MAX_AHC_POINTS) {
      throw new Error(
        `hierarchical guiding handles up to ${MAX_AHC_POINTS.toLocaleString()} rows, this has ${n.toLocaleString()}: choose DBSCAN or no guide`,
      );
    }
    const distances = cosineDistances(matrix, n, d, (f) => progress("measuring distances", f));
    const merges = averageLinkage(distances, n, (f) => progress("merging clusters", f));
    const k = params.k > 0 ? Math.min(params.k, n) : chooseK(merges);
    return { labels: Array.from(cutTree(merges, n, k)), curve: heightCurve(merges, 60), k };
  }

  if (params.guide === "dbscan") {
    progress("finding dense groups");
    const labels = dbscan(n, params.guideMinPts, (i) => {
      const found: number[] = [];
      const offsetI = i * d;
      for (let j = 0; j < n; j++) {
        const offsetJ = j * d;
        let dot = 0;
        for (let c = 0; c < d; c++) dot += matrix[offsetI + c] * matrix[offsetJ + c];
        if (1 - dot <= params.guideEps) found.push(j);
      }
      return found;
    });
    return { labels: Array.from(labels), curve: null, k: null };
  }

  return { labels: null, curve: null, k: null };
}

function project(
  matrix: Float32Array,
  n: number,
  d: number,
  params: ProjectionParams,
  guide: number[] | null,
  components: number,
  phase: string,
): Float32Array {
  const rows = Array.from({ length: n }, (_, i) => matrix.subarray(i * d, (i + 1) * d));
  const umap = new UMAP({
    nComponents: components,
    nNeighbors: Math.min(params.nNeighbors, n - 1),
    minDist: params.minDist,
    spread: params.spread,
    random: mulberry32(params.seed),
    distanceFn: (a: number[], b: number[]) => {
      let dot = 0;
      for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
      return 1 - dot;
    },
  });
  if (guide) umap.setSupervisedProjection(guide);

  progress("building neighbour graph");
  const epochs = umap.initializeFit(rows as unknown as number[][]);
  for (let epoch = 0; epoch < epochs; epoch++) {
    umap.step();
    if (epoch % 5 === 0) progress(phase, epoch / epochs);
  }
  const embedding = umap.getEmbedding();
  const coords = new Float32Array(components * n);
  embedding.forEach((point, i) => coords.set(point, components * i));
  return coords;
}

const sameParams = (a: ProjectionParams, b: ProjectionParams) =>
  JSON.stringify(a) === JSON.stringify(b);
type Base = Omit<Projection, "labels" | "clusters" | "termFields" | "noise" | "silhouette" | "clustering" | "createdAt">;

async function describe(
  dataset: Dataset,
  base: Base,
  rawLabels: Int32Array,
  clustering: ClusterSettings,
  merges: number,
  vectors: Vectors,
): Promise<Projection> {
  const labels = relabelBySize(rawLabels);
  progress("naming clusters");
  const termFields = termColumns(dataset);
  const texts = await rowTexts(dataset.id, termFields, base.keys);
  const projection: Projection = {
    ...base,
    labels,
    clustering,
    clusters: summarizeClusters(labels, base.coords, base.keys, texts, vectors),
    termFields,
    merges,
    noise: labels.reduce((sum, label) => sum + (label === NOISE ? 1 : 0), 0),
    silhouette: silhouette(labels, base.coords),
    createdAt: Date.now(),
  };
  await putProjection(projection);
  return projection;
}

/** The clustering layout, added to a base that doesn't have one yet. */
function withClusterCoords(base: Base, vectors: Vectors, guide: number[] | null): Base {
  if (base.clusterCoords) return base;
  const { matrix, d } = vectors;
  const clusterCoords = project(matrix, base.keys.length, d, base.params, guide, CLUSTER_DIMS, "laying out for clusters");
  return { ...base, clusterCoords };
}

function findClusters(base: Base, config: ClusterSettings) {
  if (config.method === "hdbscan") {
    const n = base.keys.length;
    const minClusterSize = config.minClusterSize || defaultMinClusterSize(n);
    const labels = hdbscan(base.clusterCoords!, n, CLUSTER_DIMS, minClusterSize, (f) => progress("clustering", f));
    return { labels, settings: { ...config, minClusterSize } };
  }
  progress("clustering");
  const eps = config.eps > 0 ? config.eps : suggestEps(base.coords, config.minPts);
  return { labels: dbscan2d(base.coords, eps, config.minPts), settings: { ...config, eps } };
}

function finish(dataset: Dataset, base: Base, config: ClusterSettings, vectors: Vectors) {
  const { labels, settings } = findClusters(base, config);
  const { assignAbove = null } = config;
  const assigned = assignAbove === null ? labels : assignNoise(labels, vectors, assignAbove);
  return describe(dataset, base, assigned, { ...settings, assignAbove }, 0, vectors);
}

async function cluster({ datasetId, modelKey, params, clustering: config }: ClusterPayload) {
  const dataset = await getDataset(datasetId);
  if (!dataset) throw new Error("dataset not found");

  progress("loading vectors");
  const loaded = await loadMatrix(datasetId, modelKey);
  const { matrix, n, d, keys } = loaded;
  if (n < 4) throw new Error("clustering needs at least 4 embedded rows");

  // Only the clustering changed: the slow projection can be reused as it is.
  const previous = await getProjection(datasetId, modelKey);
  const reusable =
    previous && sameParams(previous.params, params) && sameKeys(previous.keys, keys);

  let base: Base;
  let guide: Guide | null = null;
  if (reusable) {
    base = previous;
  } else {
    guide = computeGuide(matrix, n, d, params);
    const coords = project(matrix, n, d, params, guide.labels, 2, "laying out the map");
    base = {
      datasetId,
      modelKey,
      params,
      keys,
      coords,
      clusterCoords: null,
      heightCurve: guide.curve,
      chosenK: guide.k,
    };
  }
  const vectors = alignVectors(base.keys, loaded);
  if (config.method === "hdbscan" && !base.clusterCoords) {
    guide ??= computeGuide(matrix, n, d, params);
    base = withClusterCoords(base, vectors, guide.labels);
  }
  const projection = await finish(dataset, base, config, vectors);
  return { clusters: projection.clusters.length, noise: projection.noise, reused: !!reusable };
}

const needsLayout = (config: ClusterSettings) => config.method === "hdbscan";

/** For clusters from before the clustering layout existed. */
function layOut(previous: Projection, { matrix, d }: Vectors) {
  if (previous.clusterCoords) return previous;
  const guide = computeGuide(matrix, previous.keys.length, d, previous.params);
  return withClusterCoords(previous, { matrix, d }, guide.labels);
}

async function recluster({ datasetId, modelKey, clustering: config, merge }: ReclusterPayload) {
  const dataset = await getDataset(datasetId);
  const previous = await getProjection(datasetId, modelKey);
  if (!dataset || !previous) throw new Error("nothing to recluster yet");
  progress("loading vectors");
  const vectors = alignVectors(previous.keys, await loadMatrix(datasetId, modelKey));
  const projection = config
    ? await finish(dataset, needsLayout(config) ? layOut(previous, vectors) : previous, config, vectors)
    : await describe(
        dataset,
        previous,
        mergeLabels(previous.labels, merge ?? []),
        previous.clustering,
        (previous.merges ?? 0) + (merge ? 1 : 0),
        vectors,
      );
  return { clusters: projection.clusters.length, noise: projection.noise, reused: true };
}

self.onmessage = async ({ data }) => {
  try {
    const result = await (data.op === "cluster" ? cluster(data) : recluster(data));
    postMessage({ type: "done", result });
  } catch (error: any) {
    postMessage({ type: "error", error: error.message });
  }
};
