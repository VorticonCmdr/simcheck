export function normalizeInPlace(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  if (sum > 0) {
    const scale = 1 / Math.sqrt(sum);
    for (let i = 0; i < vector.length; i++) vector[i] *= scale;
  }
  return vector;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

export interface Hit {
  index: number;
  score: number;
}

/** Keeps the k highest scores in a min-heap, O(log k) per offer. */
export class TopK {
  private heap: Hit[] = [];
  constructor(private k: number) {}

  offer(index: number, score: number) {
    const heap = this.heap;
    if (heap.length < this.k) {
      heap.push({ index, score });
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent].score <= heap[i].score) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
    } else if (this.k > 0 && score > heap[0].score) {
      heap[0] = { index, score };
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heap.length && heap[left].score < heap[smallest].score) smallest = left;
        if (right < heap.length && heap[right].score < heap[smallest].score) smallest = right;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
        i = smallest;
      }
    }
  }

  sorted(): Hit[] {
    return [...this.heap].sort((a, b) => b.score - a.score);
  }
}

/** Flat search over a unit-normalised n×d matrix, with a unit-normalised query. */
export function searchMatrix(
  matrix: Float32Array,
  n: number,
  d: number,
  query: ArrayLike<number>,
  k: number,
): Hit[] {
  const top = new TopK(k);
  for (let i = 0; i < n; i++) {
    const offset = i * d;
    let dot = 0;
    for (let j = 0; j < d; j++) dot += matrix[offset + j] * query[j];
    top.offer(i, dot);
  }
  return top.sorted();
}

/**
 * For rows start..end of A, the best match among all rows of B (both unit length).
 * Walks B once per block of A rows, not once per A row, which keeps the current B
 * row in cache and is far faster than repeated searchMatrix calls.
 */
export function bestMatches(
  a: Float32Array,
  b: Float32Array,
  d: number,
  nB: number,
  start: number,
  end: number,
  bestIndex: Int32Array,
  bestScore: Float32Array,
  onBlock?: (rows: number) => void,
  blockSize = 32,
): void {
  for (let block = start; block < end; block += blockSize) {
    const blockEnd = Math.min(end, block + blockSize);
    bestScore.fill(-Infinity, block, blockEnd);
    for (let j = 0; j < nB; j++) {
      const offsetB = j * d;
      for (let i = block; i < blockEnd; i++) {
        const offsetA = i * d;
        let dot = 0;
        for (let k = 0; k < d; k++) dot += a[offsetA + k] * b[offsetB + k];
        if (dot > bestScore[i]) {
          bestScore[i] = dot;
          bestIndex[i] = j;
        }
      }
    }
    onBlock?.(blockEnd - block);
  }
}
