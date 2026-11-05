import Flatbush from "flatbush";

export const NOISE = -1;

/**
 * DBSCAN over any neighbourhood. `regionQuery(i)` returns the points within eps
 * of i, including i. Labels are cluster ids from 0, or NOISE.
 */
export function dbscan(
  n: number,
  minPts: number,
  regionQuery: (i: number) => ArrayLike<number>,
): Int32Array {
  const UNVISITED = -2;
  const labels = new Int32Array(n).fill(UNVISITED);
  let cluster = 0;

  for (let i = 0; i < n; i++) {
    if (labels[i] !== UNVISITED) continue;
    const seeds = regionQuery(i);
    if (seeds.length < minPts) {
      labels[i] = NOISE;
      continue;
    }

    labels[i] = cluster;
    const frontier: number[] = Array.from(seeds);
    // frontier grows while we walk it: that growth is what lets a cluster reach
    // past the first ring of neighbours, so its length can't be cached.
    for (let f = 0; f < frontier.length; f++) {
      const p = frontier[f];
      if (labels[p] === NOISE) labels[p] = cluster; // border point
      if (labels[p] !== UNVISITED) continue;
      labels[p] = cluster;
      const neighbours = regionQuery(p);
      if (neighbours.length >= minPts) {
        for (let j = 0; j < neighbours.length; j++) frontier.push(neighbours[j]);
      }
    }
    cluster++;
  }
  return labels;
}

/** DBSCAN on 2D coordinates stored as [x0, y0, x1, y1, ...]. */
export function dbscan2d(coords: Float32Array, eps: number, minPts: number): Int32Array {
  const n = coords.length / 2;
  if (n === 0) return new Int32Array(0);
  const index = new Flatbush(n);
  for (let i = 0; i < n; i++) {
    index.add(coords[2 * i], coords[2 * i + 1]);
  }
  index.finish();

  const eps2 = eps * eps;
  return dbscan(n, minPts, (i) => {
    const x = coords[2 * i];
    const y = coords[2 * i + 1];
    return index.search(x - eps, y - eps, x + eps, y + eps, (j) => {
      const dx = coords[2 * j] - x;
      const dy = coords[2 * j + 1] - y;
      return dx * dx + dy * dy <= eps2;
    });
  });
}

/**
 * A starting eps in projection units, from the distance to the minPts-th nearest
 * neighbour. Within a dense cluster that distance varies a lot, so the median
 * splits clusters into pieces; twice the 90th percentile spans them, while still
 * ignoring the outliers a higher percentile would chain clusters together with.
 * Sampled, since it only needs to be roughly right.
 */
export function suggestEps(coords: Float32Array, minPts: number): number {
  const n = coords.length / 2;
  if (n < 2) return 0.5;
  const index = new Flatbush(n);
  for (let i = 0; i < n; i++) index.add(coords[2 * i], coords[2 * i + 1]);
  index.finish();

  const stride = Math.max(1, Math.floor(n / 500));
  const distances: number[] = [];
  for (let i = 0; i < n; i += stride) {
    const x = coords[2 * i];
    const y = coords[2 * i + 1];
    // DBSCAN counts a point as its own neighbour, so this includes the point itself.
    // One further would reach into the next group whenever groups are about minPts big.
    const near = index.neighbors(x, y, minPts);
    const far = near[near.length - 1];
    distances.push(Math.hypot(coords[2 * far] - x, coords[2 * far + 1] - y));
  }
  distances.sort((a, b) => a - b);
  return Math.max(distances[Math.floor(distances.length * 0.9)] * 2, 1e-3);
}

export interface ClusterStats {
  clusters: number;
  noise: number;
  noiseRatio: number;
}

export function clusterStats(labels: Int32Array): ClusterStats {
  let noise = 0;
  let max = -1;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === NOISE) noise++;
    else if (labels[i] > max) max = labels[i];
  }
  return {
    clusters: max + 1,
    noise,
    noiseRatio: labels.length ? noise / labels.length : 0,
  };
}
