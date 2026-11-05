/** A merge of two clusters: `a` and `b` are point indices that represent them. */
export interface Merge {
  a: number;
  b: number;
  height: number;
}

// Above this the condensed matrix alone passes 800 MB.
export const MAX_AHC_POINTS = 20000;

const condensedIndex = (n: number, i: number, j: number) => {
  if (i > j) [i, j] = [j, i];
  return n * i - (i * (i + 1)) / 2 + j - i - 1;
};

/** Cosine distances between rows of a unit-normalised n×d matrix. */
export function cosineDistances(
  matrix: Float32Array,
  n: number,
  d: number,
  onProgress?: (fraction: number) => void,
): Float32Array {
  const distances = new Float32Array((n * (n - 1)) / 2);
  let at = 0;
  for (let i = 0; i < n; i++) {
    if (onProgress && i % 64 === 0) onProgress(i / n);
    const offsetI = i * d;
    for (let j = i + 1; j < n; j++) {
      const offsetJ = j * d;
      let dot = 0;
      for (let k = 0; k < d; k++) dot += matrix[offsetI + k] * matrix[offsetJ + k];
      distances[at++] = 1 - dot;
    }
  }
  return distances;
}

/**
 * Average-linkage clustering by nearest-neighbour chain, O(n²) in time. Takes
 * ownership of `distances`, which is overwritten by the Lance-Williams updates:
 * anything needing the original distances must keep its own copy.
 * Returns the n-1 merges sorted by height.
 */
export function averageLinkage(
  distances: Float32Array,
  n: number,
  onProgress?: (fraction: number) => void,
): Merge[] {
  const size = new Int32Array(n).fill(1);
  const active = new Uint8Array(n).fill(1);
  const chain: number[] = [];
  const merges: Merge[] = [];

  let next = 0;
  while (merges.length < n - 1) {
    if (chain.length === 0) {
      while (!active[next]) next++;
      chain.push(next);
    }
    const top = chain[chain.length - 1];
    const previous = chain.length > 1 ? chain[chain.length - 2] : -1;

    let nearest = previous;
    let best = previous >= 0 ? distances[condensedIndex(n, top, previous)] : Infinity;
    for (let c = 0; c < n; c++) {
      if (!active[c] || c === top) continue;
      const d = distances[condensedIndex(n, top, c)];
      if (d < best) {
        best = d;
        nearest = c;
      }
    }

    if (nearest !== previous) {
      chain.push(nearest);
      continue;
    }

    // top and previous are reciprocal nearest neighbours: merge into previous
    chain.length -= 2;
    merges.push({ a: previous, b: top, height: best });
    if (onProgress && merges.length % 64 === 0) onProgress(merges.length / (n - 1));

    const sizeA = size[previous];
    const sizeB = size[top];
    for (let c = 0; c < n; c++) {
      if (!active[c] || c === top || c === previous) continue;
      const ia = condensedIndex(n, previous, c);
      distances[ia] =
        (sizeA * distances[ia] + sizeB * distances[condensedIndex(n, top, c)]) /
        (sizeA + sizeB);
    }
    active[top] = 0;
    size[previous] = sizeA + sizeB;
  }
  return merges.sort((x, y) => x.height - y.height);
}

/** Labels for the partition into k clusters, numbered from 0 in point order. */
export function cutTree(merges: Merge[], n: number, k: number): Int32Array {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };

  const steps = Math.max(0, n - Math.max(1, k));
  for (let i = 0; i < steps; i++) parent[find(merges[i].b)] = find(merges[i].a);

  const ids = new Map<number, number>();
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!ids.has(root)) ids.set(root, ids.size);
    labels[i] = ids.get(root)!;
  }
  return labels;
}

/** Height at which each k comes about: curve[k] is the merge leaving k clusters. */
export function heightCurve(merges: Merge[], maxK: number): { k: number; height: number }[] {
  const n = merges.length + 1;
  const curve = [];
  for (let k = 2; k <= Math.min(maxK, n - 1); k++) {
    curve.push({ k, height: merges[n - 1 - k].height });
  }
  return curve;
}

/**
 * The knee of the height curve: the k furthest below the straight line between
 * the ends of the curve, which is where further splitting stops paying off.
 */
export function chooseK(merges: Merge[], maxK = 60): number {
  const n = merges.length + 1;
  if (n < 3) return 1;
  const curve = heightCurve(merges, maxK);
  if (curve.length < 2) return curve[0]?.k ?? 1;

  const first = curve[0];
  const last = curve[curve.length - 1];
  const spanK = last.k - first.k;
  const spanH = first.height - last.height;
  if (spanH <= 0) return first.k;

  let bestK = first.k;
  let bestDrop = -Infinity;
  for (const { k, height } of curve) {
    const onLine = 1 - (k - first.k) / spanK;
    const drop = onLine - (height - last.height) / spanH;
    if (drop > bestDrop) {
      bestDrop = drop;
      bestK = k;
    }
  }
  return bestK;
}
