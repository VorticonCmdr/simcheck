import { NOISE } from "./dbscan";
import { TopK } from "./vector";

type Progress = (fraction: number) => void;

function distance(points: Float32Array, a: number, b: number, dims: number): number {
  let sum = 0;
  for (let c = 0; c < dims; c++) {
    const delta = points[a * dims + c] - points[b * dims + c];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

/** Distance to the k-th nearest point, counting the point itself. */
function coreDistances(points: Float32Array, n: number, dims: number, k: number, onProgress?: Progress) {
  const core = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const nearest = new TopK(k);
    for (let j = 0; j < n; j++) nearest.offer(j, -distance(points, i, j, dims));
    const found = nearest.sorted();
    core[i] = -found[found.length - 1].score;
    if (i % 256 === 0) onProgress?.(i / n);
  }
  return core;
}

/** Prim's algorithm over mutual reachability distances, which spread out sparse points. */
function spanningTree(points: Float32Array, n: number, dims: number, core: Float64Array, onProgress?: Progress) {
  const a = new Int32Array(n - 1);
  const b = new Int32Array(n - 1);
  const height = new Float64Array(n - 1);
  const best = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n);
  const done = new Uint8Array(n);
  let current = 0;
  done[0] = 1;
  for (let edge = 0; edge < n - 1; edge++) {
    let next = -1;
    let nextDistance = Infinity;
    for (let j = 0; j < n; j++) {
      if (done[j]) continue;
      const reach = Math.max(distance(points, current, j, dims), core[current], core[j]);
      if (reach < best[j]) {
        best[j] = reach;
        from[j] = current;
      }
      if (best[j] < nextDistance) {
        nextDistance = best[j];
        next = j;
      }
    }
    a[edge] = from[next];
    b[edge] = next;
    height[edge] = nextDistance;
    done[next] = 1;
    current = next;
    if (edge % 256 === 0) onProgress?.(edge / n);
  }
  return { a, b, height };
}

/** Merges from nearest to farthest. Leaves are 0..n-1, merge i is node n + i. */
function linkage(n: number, tree: ReturnType<typeof spanningTree>) {
  const order = Array.from(tree.height.keys()).sort((x, y) => tree.height[x] - tree.height[y]);
  const left = new Int32Array(n - 1);
  const right = new Int32Array(n - 1);
  const height = new Float64Array(n - 1);
  const size = new Int32Array(2 * n - 1).fill(1);
  const parent = Int32Array.from({ length: 2 * n - 1 }, (_, i) => i);
  const find = (x: number) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  order.forEach((edge, merge) => {
    const a = find(tree.a[edge]);
    const b = find(tree.b[edge]);
    const node = n + merge;
    left[merge] = a;
    right[merge] = b;
    height[merge] = tree.height[edge];
    size[node] = size[a] + size[b];
    parent[a] = node;
    parent[b] = node;
  });
  return { left, right, height, size };
}

/**
 * Density-based clustering that needs no radius, so it copes with clusters of
 * different densities. Follows the HDBSCAN paper with excess-of-mass selection,
 * and like scikit-learn's default never makes all the data one cluster.
 *
 * O(n²) in time and O(n) in memory. `points` is [p0x, p0y, ..., p1x, ...].
 * Labels are cluster ids from 0, or NOISE.
 */
export function hdbscan(
  points: Float32Array,
  n: number,
  dims: number,
  minClusterSize: number,
  onProgress?: Progress,
  maxClusterSize = n / 2,
): Int32Array {
  const labels = new Int32Array(n).fill(NOISE);
  const minSize = Math.max(2, Math.round(minClusterSize));
  if (n < 2 * minSize) return labels;

  const core = coreDistances(points, n, dims, minSize, (f) => onProgress?.(f * 0.5));
  const tree = spanningTree(points, n, dims, core, (f) => onProgress?.(0.5 + f * 0.5));
  const { left, right, height, size } = linkage(n, tree);

  // Condense the tree: following it from the root, a split only counts when both
  // sides are big enough. Otherwise the smaller side's points just leave the cluster.
  const clusterParent = [-1];
  const birth = [0];
  const stability = [0];
  const clusterSize = [n];
  const clusterOf = new Int32Array(n);
  const leave = (start: number, cluster: number, density: number) => {
    const pending = [start];
    while (pending.length) {
      const node = pending.pop()!;
      if (node < n) {
        clusterOf[node] = cluster;
        stability[cluster] += density - birth[cluster];
      } else {
        pending.push(left[node - n], right[node - n]);
      }
    }
  };
  const stack: [number, number][] = [[2 * n - 2, 0]];
  while (stack.length) {
    const [node, cluster] = stack.pop()!;
    const merge = node - n;
    const density = 1 / Math.max(height[merge], 1e-12); // identical points are at distance 0
    const children = [left[merge], right[merge]];
    if (children.every((child) => size[child] >= minSize)) {
      for (const child of children) {
        stability[cluster] += (density - birth[cluster]) * size[child];
        stack.push([child, clusterParent.length]);
        clusterParent.push(cluster);
        birth.push(density);
        stability.push(0);
        clusterSize.push(size[child]);
      }
    } else {
      for (const child of children) {
        if (size[child] >= minSize) stack.push([child, cluster]);
        else leave(child, cluster, density);
      }
    }
  }

  // Excess of mass, bottom up: children come after their parent in these arrays.
  // A cluster stays unless its descendants hold more stability than it does, or it's
  // too big to say anything: a small, distinct group of rows can make "those and
  // everything else" the most stable split there is.
  const count = clusterParent.length;
  const fromChildren = new Float64Array(count);
  const selected = new Uint8Array(count);
  for (let c = count - 1; c > 0; c--) {
    const tooBig = clusterSize[c] > maxClusterSize && fromChildren[c] > 0;
    selected[c] = !tooBig && stability[c] >= fromChildren[c] ? 1 : 0;
    fromChildren[clusterParent[c]] += selected[c] ? stability[c] : fromChildren[c];
  }

  // Top down, the highest selected cluster claims everything below it.
  const owner = new Int32Array(count).fill(-1);
  const ids = new Map<number, number>();
  for (let c = 1; c < count; c++) {
    const above = owner[clusterParent[c]];
    if (above >= 0) {
      owner[c] = above;
    } else if (selected[c]) {
      owner[c] = c;
      ids.set(c, ids.size);
    }
  }
  for (let i = 0; i < n; i++) {
    const cluster = owner[clusterOf[i]];
    if (cluster >= 0) labels[i] = ids.get(cluster)!;
  }
  return labels;
}

/** Small datasets can't have clusters of the size that suits larger ones. */
export const defaultMinClusterSize = (n: number) => Math.min(15, Math.max(3, Math.round(n / 20)));
