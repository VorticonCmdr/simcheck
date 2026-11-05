import { NOISE } from "./dbscan";
import { topTerms } from "./terms";
import type { ClusterSummary } from "./types";

export interface Vectors {
  matrix: Float32Array;
  d: number;
}

export const sameKeys = (a: string[], b: string[]) =>
  a.length === b.length && a.every((key, i) => key === b[i]);

/** Vectors in the order of `keys`. A row without one gets zeros, which match nothing. */
export function alignVectors(
  keys: string[],
  loaded: Vectors & { keys: string[] },
): Vectors {
  if (sameKeys(keys, loaded.keys)) return loaded;
  const { d } = loaded;
  const position = new Map(loaded.keys.map((key, i) => [key, i]));
  const matrix = new Float32Array(keys.length * d);
  keys.forEach((key, i) => {
    const from = position.get(key);
    if (from !== undefined) matrix.set(loaded.matrix.subarray(from * d, (from + 1) * d), i * d);
  });
  return { matrix, d };
}

/** The sum of each cluster's vectors: one row of d values per cluster. */
function clusterSums(labels: Int32Array, { matrix, d }: Vectors, count: number): Float64Array {
  const sums = new Float64Array(count * d);
  labels.forEach((label, i) => {
    if (label === NOISE) return;
    for (let c = 0; c < d; c++) sums[label * d + c] += matrix[i * d + c];
  });
  return sums;
}

function dotWith(matrix: Float32Array, row: number, sums: Float64Array, cluster: number, d: number) {
  let dot = 0;
  for (let c = 0; c < d; c++) dot += matrix[row * d + c] * sums[cluster * d + c];
  return dot;
}

/**
 * Moves unclustered rows into the cluster whose centre they're most similar to,
 * if that reaches `minSimilarity`. Expects normalized vectors.
 */
export function assignNoise(labels: Int32Array, vectors: Vectors, minSimilarity: number): Int32Array {
  const { matrix, d } = vectors;
  const count = labels.reduce((max, label) => Math.max(max, label), -1) + 1;
  const centres = clusterSums(labels, vectors, count);
  for (let id = 0; id < count; id++) {
    const centre = centres.subarray(id * d, (id + 1) * d);
    const length = Math.hypot(...centre) || 1;
    for (let c = 0; c < d; c++) centre[c] /= length;
  }
  const assigned = labels.slice();
  labels.forEach((label, i) => {
    if (label !== NOISE) return;
    let best = NOISE;
    let bestSimilarity = 0;
    for (let id = 0; id < count; id++) {
      const similarity = dotWith(matrix, i, centres, id, d);
      if (similarity > bestSimilarity && similarity >= minSimilarity) {
        best = id;
        bestSimilarity = similarity;
      }
    }
    assigned[i] = best;
  });
  return assigned;
}

export function mergeLabels(labels: Int32Array, ids: number[]): Int32Array {
  const joined = new Set(ids);
  return labels.map((label) => (joined.has(label) ? ids[0] : label));
}

export interface ColumnBreakdown {
  /** The most common values, in the order of their colours. */
  values: string[];
  distinct: number;
  /** Per cluster id: rows for each of `values`, then the rest. */
  clusters: { counts: number[]; other: number }[];
}

/** How each cluster divides over the most common values of a column. */
export function columnBreakdown(
  labels: Int32Array,
  values: string[],
  clusterCount: number,
  limit: number,
): ColumnBreakdown {
  const totals = new Map<string, number>();
  labels.forEach((label, i) => {
    if (label !== NOISE) totals.set(values[i], (totals.get(values[i]) ?? 0) + 1);
  });
  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
  const slot = new Map(top.map((value, i) => [value, i]));
  const clusters = Array.from({ length: clusterCount }, () => ({
    counts: new Array<number>(top.length).fill(0),
    other: 0,
  }));
  labels.forEach((label, i) => {
    if (label === NOISE) return;
    const at = slot.get(values[i]);
    if (at === undefined) clusters[label].other++;
    else clusters[label].counts[at]++;
  });
  return { values: top, distinct: totals.size, clusters };
}

/** Renumbers clusters so that 0 is the largest, which keeps colours stable-ish. */
export function relabelBySize(labels: Int32Array): Int32Array {
  const sizes = new Map<number, number>();
  for (const label of labels) {
    if (label !== NOISE) sizes.set(label, (sizes.get(label) ?? 0) + 1);
  }
  const order = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const renumber = new Map(order.map(([label], index) => [label, index]));
  return labels.map((label) => (label === NOISE ? NOISE : renumber.get(label)!));
}

/**
 * The row closest to each centre on the map, which anchors its label, and the few
 * closest in the full vectors, since the map distorts distances.
 * Expects labels numbered from 0 without gaps.
 */
export function summarizeClusters(
  labels: Int32Array,
  coords: Float32Array,
  keys: string[],
  texts: string[],
  vectors: Vectors,
  representatives = 3,
): ClusterSummary[] {
  const count = labels.reduce((max, label) => Math.max(max, label), -1) + 1;
  const size = new Int32Array(count);
  const sumX = new Float64Array(count);
  const sumY = new Float64Array(count);
  labels.forEach((label, i) => {
    if (label === NOISE) return;
    size[label]++;
    sumX[label] += coords[2 * i];
    sumY[label] += coords[2 * i + 1];
  });

  const best = new Int32Array(count).fill(-1);
  const bestDistance = new Float64Array(count).fill(Infinity);
  labels.forEach((label, i) => {
    if (label === NOISE) return;
    const distance = Math.hypot(
      coords[2 * i] - sumX[label] / size[label],
      coords[2 * i + 1] - sumY[label] / size[label],
    );
    if (distance < bestDistance[label]) {
      bestDistance[label] = distance;
      best[label] = i;
    }
  });

  const { matrix, d } = vectors;
  const sums = clusterSums(labels, vectors, count);
  const closest = Array.from({ length: count }, () => [] as { i: number; score: number }[]);
  labels.forEach((label, i) => {
    if (label === NOISE) return;
    const score = dotWith(matrix, i, sums, label, d);
    if (score <= 0) return; // no vector
    const list = closest[label];
    list.push({ i, score });
    list.sort((a, b) => b.score - a.score);
    list.length = Math.min(list.length, representatives);
  });

  const terms = topTerms(texts, labels, count);
  return Array.from({ length: count }, (_, id) => ({
    id,
    size: size[id],
    terms: terms[id],
    representativeKey: keys[best[id]],
    representativeKeys: closest[id].length ? closest[id].map(({ i }) => keys[i]) : [keys[best[id]]],
  }));
}

/**
 * Mean silhouette over a sample of clustered points: near 1 means clusters are
 * tight and well apart, near 0 that they blur into each other. Null with fewer
 * than two clusters, where it isn't defined. Sampled because it's O(n²).
 */
export function silhouette(labels: Int32Array, coords: Float32Array, maxSample = 1000): number | null {
  const clustered: number[] = [];
  labels.forEach((label, i) => {
    if (label !== NOISE) clustered.push(i);
  });
  const stride = Math.max(1, Math.floor(clustered.length / maxSample));
  const sample = clustered.filter((_, i) => i % stride === 0);
  const groups = new Set(sample.map((i) => labels[i]));
  if (groups.size < 2) return null;

  let total = 0;
  let counted = 0;
  for (const i of sample) {
    const sums = new Map<number, { sum: number; count: number }>();
    for (const j of sample) {
      if (i === j) continue;
      const entry = sums.get(labels[j]) ?? { sum: 0, count: 0 };
      entry.sum += Math.hypot(coords[2 * i] - coords[2 * j], coords[2 * i + 1] - coords[2 * j + 1]);
      entry.count++;
      sums.set(labels[j], entry);
    }
    const own = sums.get(labels[i]);
    if (!own) continue; // alone in the sample, which says nothing either way
    const a = own.sum / own.count;
    let b = Infinity;
    for (const [label, { sum, count }] of sums) {
      if (label !== labels[i]) b = Math.min(b, sum / count);
    }
    total += (b - a) / Math.max(a, b);
    counted++;
  }
  return counted ? total / counted : null;
}
