export type Row = Record<string, unknown>;

export interface Dataset {
  id: string;
  name: string;
  /** The column rows are keyed by, or null when ids were generated. */
  keyColumn: string | null;
  columns: string[];
  /** Columns joined, in order, into the text that gets embedded. */
  textFields: string[];
  /** Columns the top terms come from, unset to use the embedded ones. */
  termFields?: string[];
  rowCount: number;
  createdAt: number;
}

export interface RowRecord {
  datasetId: string;
  key: string;
  data: Row;
}

export interface EmbeddingRecord {
  datasetId: string;
  modelKey: string;
  key: string;
  vector: Float32Array;
  /** Hash of the embedded text, so changed rows can be told from unchanged ones. */
  textHash: number;
}

export interface ClusterSummary {
  id: number;
  size: number;
  terms: string[];
  /** The row closest to the cluster's centre on the map, where its label goes. */
  representativeKey: string;
  /** The rows closest to its centre in the full vectors, best first. Absent on older records. */
  representativeKeys?: string[];
}

export interface ClusterSettings {
  /** hdbscan works on the separate clustering layout, dbscan on the map itself. */
  method: "hdbscan" | "dbscan";
  /** For hdbscan. 0 derives it from the number of rows. */
  minClusterSize: number;
  /** For dbscan, in map units. 0 derives it from the map. */
  eps: number;
  minPts: number;
  /** Move unclustered rows into the most similar cluster, at this cosine or above. */
  assignAbove?: number | null;
}

export interface Projection {
  datasetId: string;
  modelKey: string;
  params: ProjectionParams;
  clustering: ClusterSettings;
  keys: string[];
  /** The map: [x0, y0, x1, y1, ...] */
  coords: Float32Array;
  /**
   * The layout clusters are found in, 5 values per row. Two dimensions lose too much,
   * so clusters come from here and the map only draws them. Null until needed.
   */
  clusterCoords?: Float32Array | null;
  labels: Int32Array;
  clusters: ClusterSummary[];
  /** Columns the terms in `clusters` came from. Older records used the embedded columns. */
  termFields?: string[];
  /** Merges made by hand since the last clustering. */
  merges?: number;
  noise: number;
  /** Mean silhouette in the projection, null when undefined. */
  silhouette: number | null;
  /** Merge height per k when hierarchical guiding ran, for the knee chart. */
  heightCurve: { k: number; height: number }[] | null;
  chosenK: number | null;
  createdAt: number;
}

export interface ProjectionParams {
  nNeighbors: number;
  minDist: number;
  spread: number;
  guide: "none" | "ahc" | "dbscan";
  /** Manual cluster count for the hierarchical guide, 0 picks it from the data. */
  k: number;
  guideEps: number;
  guideMinPts: number;
  seed: number;
}

export interface CompareRow {
  key: string;
  bestKey: string;
  score: number;
}

export interface CompareResult {
  id: string;
  datasetA: string;
  datasetB: string;
  modelKey: string;
  rows: CompareRow[];
  createdAt: number;
}

export type JobKind =
  | "migrate"
  | "embed"
  | "download"
  | "cluster"
  | "recluster"
  | "compare"
  | "merge";

export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface Job {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  phase: string;
  /** 0..1, null while the amount of work is unknown. */
  progress: number | null;
  etaSeconds: number | null;
  error: string | null;
  result: unknown;
  startedAt: number;
  /** ETA is measured per phase, since a model download says nothing about embedding. */
  phaseStartedAt: number;
  finishedAt: number | null;
  datasetId: string | null;
}
