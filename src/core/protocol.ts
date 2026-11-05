import type { ModelConfig } from "./settings";
import type { ClusterSettings, ProjectionParams } from "./types";

export interface EmbedPayload {
  datasetId: string;
  fields: string[];
  model: ModelConfig;
  modelKey: string;
  /** Embed every row, rather than only new and changed ones. */
  force: boolean;
}
export interface ClusterPayload {
  datasetId: string;
  modelKey: string;
  params: ProjectionParams;
  clustering: ClusterSettings;
}
export interface ReclusterPayload {
  datasetId: string;
  modelKey: string;
  /** Null keeps the current clusters, and only redoes what's derived from them. */
  clustering: ClusterSettings | null;
  /** Cluster ids to join into one. */
  merge: number[] | null;
}
export interface ComparePayload {
  datasetA: string;
  datasetB: string;
  modelKey: string;
}
export interface MergePayload {
  name: string;
  datasetIds: string[];
}
export interface DownloadPayload {
  model: ModelConfig;
}
export interface MigratePayload {
  pooling: string;
}

export interface SearchHit {
  key: string;
  score: number;
}
