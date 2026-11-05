import { describe, expect, it } from "vitest";
import { clusterStats, dbscan2d, NOISE, suggestEps } from "../src/core/dbscan";
import {
  averageLinkage,
  chooseK,
  cosineDistances,
  cutTree,
} from "../src/core/hclust";
import { TopK, cosine, normalizeInPlace, searchMatrix } from "../src/core/vector";
import { topTerms } from "../src/core/terms";
import { defaultMinClusterSize, hdbscan } from "../src/core/hdbscan";

const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

describe("dbscan2d", () => {
  it("reaches past the first ring of neighbours", () => {
    // A chain: every point only touches its direct neighbours, so the whole line
    // is one cluster only if expansion follows newly found points.
    const coords = new Float32Array(40);
    for (let i = 0; i < 20; i++) coords[2 * i] = i;
    const labels = dbscan2d(coords, 1.1, 3);
    expect(new Set(labels)).toEqual(new Set([0]));
  });

  it("separates clusters and marks outliers as noise", () => {
    const coords = new Float32Array([0, 0, 0.1, 0, 0, 0.1, 10, 10, 10.1, 10, 10, 10.1, 50, 50]);
    const labels = dbscan2d(coords, 0.5, 3);
    expect(labels[0]).toBe(labels[1]);
    expect(labels[3]).toBe(labels[4]);
    expect(labels[0]).not.toBe(labels[3]);
    expect(labels[6]).toBe(NOISE);
    expect(clusterStats(labels)).toEqual({ clusters: 2, noise: 1, noiseRatio: 1 / 7 });
  });

  it("suggests an eps that follows the scale of the projection", () => {
    const random = seeded(1);
    const make = (scale: number) => {
      const c = new Float32Array(400);
      for (let i = 0; i < 400; i++) c[i] = random() * scale;
      return c;
    };
    const small = suggestEps(make(1), 3);
    const large = suggestEps(make(100), 3);
    expect(large / small).toBeGreaterThan(50);
    expect(large / small).toBeLessThan(200);
  });
});

function blobs(centers: number[][], perBlob: number) {
  const random = seeded(7);
  const d = centers[0].length;
  const n = centers.length * perBlob;
  const matrix = new Float32Array(n * d);
  centers.forEach((center, c) => {
    for (let p = 0; p < perBlob; p++) {
      const row = matrix.subarray((c * perBlob + p) * d, (c * perBlob + p + 1) * d);
      center.forEach((value, i) => (row[i] = value + (random() - 0.5) * 0.05));
      normalizeInPlace(row);
    }
  });
  return { matrix, n, d };
}

describe("hierarchical clustering", () => {
  const axes = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ];

  it("recovers well separated groups and picks their number", () => {
    const { matrix, n, d } = blobs(axes, 8);
    const merges = averageLinkage(cosineDistances(matrix, n, d), n);
    expect(merges).toHaveLength(n - 1);
    expect(chooseK(merges)).toBe(3);

    const labels = cutTree(merges, n, 3);
    for (let c = 0; c < 3; c++) {
      const group = new Set(labels.subarray(c * 8, (c + 1) * 8));
      expect(group.size).toBe(1);
    }
    expect(new Set(labels).size).toBe(3);
  });

  it("matches a brute force average linkage", () => {
    const random = seeded(3);
    const n = 30;
    const d = 5;
    const matrix = new Float32Array(n * d);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < d; j++) matrix[i * d + j] = random() - 0.5;
      normalizeInPlace(matrix.subarray(i * d, (i + 1) * d));
    }
    const original = cosineDistances(matrix, n, d);
    const heights = averageLinkage(original.slice(), n, undefined).map((m) => m.height);

    // naive reference: recompute the mean pairwise distance on every step
    const at = (i: number, j: number) => {
      if (i > j) [i, j] = [j, i];
      return original[n * i - (i * (i + 1)) / 2 + j - i - 1];
    };
    let clusters = Array.from({ length: n }, (_, i) => [i]);
    const expected: number[] = [];
    while (clusters.length > 1) {
      let best = Infinity;
      let pair = [0, 1];
      for (let a = 0; a < clusters.length; a++) {
        for (let b = a + 1; b < clusters.length; b++) {
          let sum = 0;
          for (const i of clusters[a]) for (const j of clusters[b]) sum += at(i, j);
          const mean = sum / (clusters[a].length * clusters[b].length);
          if (mean < best) {
            best = mean;
            pair = [a, b];
          }
        }
      }
      expected.push(best);
      clusters[pair[0]] = [...clusters[pair[0]], ...clusters[pair[1]]];
      clusters = clusters.filter((_, i) => i !== pair[1]);
    }
    heights.forEach((h, i) => expect(h).toBeCloseTo(expected[i], 4));
  });

  it("handles the smallest inputs", () => {
    expect(chooseK([])).toBe(1);
    expect(chooseK([{ a: 0, b: 1, height: 0.1 }])).toBe(1);
    expect(Array.from(cutTree([{ a: 0, b: 1, height: 0.1 }], 2, 1))).toEqual([0, 0]);
    expect(Array.from(cutTree([{ a: 0, b: 1, height: 0.1 }], 2, 2))).toEqual([0, 1]);
  });
});

describe("flat search", () => {
  it("returns the same top k as sorting every score", () => {
    const random = seeded(11);
    const n = 500;
    const d = 16;
    const matrix = new Float32Array(n * d);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < d; j++) matrix[i * d + j] = random() - 0.5;
      normalizeInPlace(matrix.subarray(i * d, (i + 1) * d));
    }
    const query = normalizeInPlace(Float32Array.from({ length: d }, () => random() - 0.5));
    const brute = Array.from({ length: n }, (_, i) => ({
      index: i,
      score: cosine(matrix.subarray(i * d, (i + 1) * d), query),
    })).sort((a, b) => b.score - a.score);

    const hits = searchMatrix(matrix, n, d, query, 10);
    expect(hits.map((h) => h.index)).toEqual(brute.slice(0, 10).map((h) => h.index));
  });

  it("TopK copes with k above the number of offers, and k of 0", () => {
    const top = new TopK(5);
    top.offer(1, 0.5);
    top.offer(2, 0.9);
    expect(top.sorted().map((h) => h.index)).toEqual([2, 1]);
    const none = new TopK(0);
    none.offer(1, 1);
    expect(none.sorted()).toEqual([]);
  });
});

describe("topTerms", () => {
  it("prefers words that set a cluster apart", () => {
    const texts = [
      "the cat chased the shared mouse",
      "a cat sat with shared whiskers",
      "the bank raised shared rates",
      "central bank rates shared news",
      "ignored noise words",
    ];
    const [cats, banks] = topTerms(texts, [0, 0, 1, 1, -1], 2, 1);
    expect(cats).toEqual(["cat"]);
    expect(["bank", "rates"]).toContain(banks[0]);
  });

  it("puts a rarer, distinctive word above a more frequent one found everywhere", () => {
    const texts = ["common common common common alpha alpha", "common common common common beta beta"];
    expect(topTerms(texts, [0, 1], 2, 1)).toEqual([["alpha"], ["beta"]]);
  });
});

import {
  alignVectors,
  assignNoise,
  columnBreakdown,
  mergeLabels,
  relabelBySize,
  summarizeClusters,
} from "../src/core/summary";

describe("suggestEps", () => {
  it("doesn't reach into the next group when groups are about minPts big", () => {
    const random = seeded(5);
    const groups = 18;
    const size = 5;
    const coords = new Float32Array(2 * groups * size);
    for (let g = 0; g < groups; g++) {
      for (let p = 0; p < size; p++) {
        coords[2 * (g * size + p)] = g * 10 + random() * 0.2;
        coords[2 * (g * size + p) + 1] = (g % 3) * 10 + random() * 0.2;
      }
    }
    const eps = suggestEps(coords, size);
    expect(clusterStats(dbscan2d(coords, eps, size)).clusters).toBe(groups);
  });
});

describe("hdbscan", () => {
  const blob = (random: () => number, x: number, y: number, count: number, spread: number) =>
    Array.from({ length: count }, () => [x + (random() - 0.5) * spread, y + (random() - 0.5) * spread]);
  const run = (rows: number[][], size: number) =>
    Array.from(hdbscan(new Float32Array(rows.flat()), rows.length, rows[0].length, size));

  it("finds clusters of very different density, which no single radius could", () => {
    const random = seeded(3);
    const rows = [...blob(random, 0, 0, 40, 0.2), ...blob(random, 20, 0, 40, 6), ...blob(random, 0, 30, 40, 0.5)];
    const labels = run(rows, 10);
    const groups = [labels.slice(0, 40), labels.slice(40, 80), labels.slice(80)];
    const majority = groups.map((group) => {
      const counts = new Map<number, number>();
      for (const label of group) if (label >= 0) counts.set(label, (counts.get(label) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    });
    expect(new Set(majority.map(([label]) => label)).size).toBe(3);
    expect(majority.every(([, count]) => count >= 30)).toBe(true);
  });

  it("splits what would be one giant cluster next to a small, distinct group", () => {
    const random = seeded(6);
    const near = Array.from({ length: 5 }, (_, i) => blob(random, i * 0.8, 0, 40, 1)).flat();
    const rows = [...near, ...blob(random, 1000, 1000, 20, 0.1)];
    const points = new Float32Array(rows.flat());
    const largest = (labels: Int32Array) => {
      const sizes = new Map<number, number>();
      for (const label of labels) if (label >= 0) sizes.set(label, (sizes.get(label) ?? 0) + 1);
      return Math.max(...sizes.values());
    };
    const unlimited = hdbscan(points, rows.length, 2, 8, undefined, rows.length);
    expect(largest(unlimited)).toBe(200);
    expect(largest(hdbscan(points, rows.length, 2, 8))).toBeLessThanOrEqual(rows.length / 2);
  });

  it("leaves far away points unclustered", () => {
    const random = seeded(4);
    const rows = [...blob(random, 0, 0, 30, 1), ...blob(random, 50, 0, 30, 1), [500, 500], [-500, 300]];
    const labels = run(rows, 5);
    expect(labels.slice(-2)).toEqual([-1, -1]);
  });

  it("doesn't call a single blob a cluster, or crash on too few or identical points", () => {
    expect(new Set(run(blob(seeded(5), 0, 0, 3, 1), 5))).toEqual(new Set([-1]));
    const same = run(Array.from({ length: 30 }, () => [1, 1]), 5);
    expect(same).toHaveLength(30);
  });

  it("suits the smallest cluster to the data", () => {
    expect(defaultMinClusterSize(6)).toBe(3);
    expect(defaultMinClusterSize(5000)).toBe(15);
  });
});

describe("cluster summaries", () => {
  it("numbers clusters by size and leaves noise alone", () => {
    const labels = relabelBySize(new Int32Array([5, 2, 2, 2, -1, 5]));
    expect(Array.from(labels)).toEqual([1, 0, 0, 0, -1, 1]);
  });

  const vectors = (rows: number[][]) => ({ matrix: new Float32Array(rows.flat()), d: rows[0].length });

  it("anchors a cluster on the map, but represents it by its full vectors", () => {
    const labels = new Int32Array([0, 0, 0]);
    const coords = new Float32Array([0, 0, 5, 0, 10, 0]);
    const keys = ["a", "b", "c"];
    // b is central on the map, while a and c agree in the full vectors
    const [cluster] = summarizeClusters(labels, coords, keys, keys, vectors([[1, 0], [0, 1], [1, 0]]), 2);
    expect(cluster.representativeKey).toBe("b");
    expect(cluster.representativeKeys).toEqual(["a", "c"]);
  });

  it("assigns noise to the most similar cluster, unless too little alike", () => {
    const labels = new Int32Array([0, 0, 1, 1, -1, -1]);
    const rows = (row: number[]) => vectors([[1, 0], [1, 0], [0, 1], [0, 1], row, [-1, 0]]);
    expect(Array.from(assignNoise(labels, rows([0.1, 0.995]), 0.5))).toEqual([0, 0, 1, 1, 1, -1]);
    expect(Array.from(assignNoise(labels, rows([Math.SQRT1_2, Math.SQRT1_2]), 0.9))).toEqual([0, 0, 1, 1, -1, -1]);
  });

  it("merges cluster ids and leaves noise alone", () => {
    const merged = relabelBySize(mergeLabels(new Int32Array([0, 1, 1, 2, 3, -1]), [3, 0]));
    expect(Array.from(merged)).toEqual([1, 0, 0, 2, 1, -1]);
  });

  it("lines vectors up with the projection's keys", () => {
    const loaded = { keys: ["b", "a"], matrix: new Float32Array([2, 2, 1, 1]), d: 2 };
    const { matrix } = alignVectors(["a", "gone", "b"], loaded);
    expect(Array.from(matrix)).toEqual([1, 1, 0, 0, 2, 2]);
  });

  it("splits clusters over a column's most common values", () => {
    const labels = new Int32Array([0, 0, 0, 1, 1, -1]);
    const { values, distinct, clusters } = columnBreakdown(labels, ["x", "x", "y", "x", "z", "noise"], 2, 2);
    expect(values).toEqual(["x", "y"]);
    expect(distinct).toBe(3);
    expect(clusters).toEqual([{ counts: [2, 1], other: 0 }, { counts: [1, 0], other: 1 }]);
  });

  it("picks exactly one representative per cluster, nearest the centroid", () => {
    const labels = new Int32Array([0, 0, 0, 1, 1, 1, -1]);
    // walking towards the centre used to flag every improvement as a centre
    const coords = new Float32Array([0, 0, 5, 0, 10, 0, 100, 0, 101, 0, 102, 0, 50, 50]);
    const keys = ["a", "b", "c", "d", "e", "f", "g"];
    const summary = summarizeClusters(labels, coords, keys, keys, vectors(keys.map(() => [1, 0])));
    expect(summary.map((c) => c.representativeKey)).toEqual(["b", "e"]);
    expect(summary.map((c) => c.size)).toEqual([3, 3]);
  });
});

import { pointInPolygon } from "../src/core/geometry";
import { silhouette } from "../src/core/summary";

describe("silhouette", () => {
  it("is high for tight far apart clusters, low when they overlap, null for one", () => {
    const apart = new Float32Array([0, 0, 0.1, 0, 0, 0.1, 100, 0, 100.1, 0, 100, 0.1]);
    const overlapping = new Float32Array([0, 0, 2, 0, 4, 0, 1, 0, 3, 0, 5, 0]);
    const labels = new Int32Array([0, 0, 0, 1, 1, 1]);
    expect(silhouette(labels, apart)!).toBeGreaterThan(0.95);
    expect(silhouette(labels, overlapping)!).toBeLessThan(0.1);
    expect(silhouette(new Int32Array(6), apart)).toBeNull();
  });

  it("leaves noise out", () => {
    const coords = new Float32Array([0, 0, 0.1, 0, 100, 0, 100.1, 0, 50, 50]);
    expect(silhouette(new Int32Array([0, 0, 1, 1, -1]), coords)!).toBeGreaterThan(0.95);
  });
});

describe("pointInPolygon", () => {
  it("handles a concave shape", () => {
    const shape: [number, number][] = [[0, 0], [10, 0], [10, 10], [5, 3], [0, 10]];
    expect(pointInPolygon(1, 1, shape)).toBe(true);
    expect(pointInPolygon(5, 8, shape)).toBe(false); // in the notch
    expect(pointInPolygon(20, 5, shape)).toBe(false);
  });
});

import { bestMatches } from "../src/core/vector";

describe("bestMatches", () => {
  it("finds exactly what searching row by row finds, also in a slice", () => {
    const random = seeded(21);
    const d = 12;
    const make = (n: number) => {
      const m = new Float32Array(n * d);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < d; j++) m[i * d + j] = random() - 0.5;
        normalizeInPlace(m.subarray(i * d, (i + 1) * d));
      }
      return m;
    };
    const nA = 100;
    const nB = 300;
    const a = make(nA);
    const b = make(nB);
    const bestIndex = new Int32Array(nA);
    const bestScore = new Float32Array(nA);
    // two slices over the same output, the way the shards share it
    bestMatches(a, b, d, nB, 0, 41, bestIndex, bestScore);
    bestMatches(a, b, d, nB, 41, nA, bestIndex, bestScore);
    for (let i = 0; i < nA; i++) {
      const [hit] = searchMatrix(b, nB, d, a.subarray(i * d, (i + 1) * d), 1);
      expect(bestIndex[i]).toBe(hit.index);
      expect(bestScore[i]).toBeCloseTo(hit.score, 5);
    }
  });
});
