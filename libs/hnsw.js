import { Node } from "./node.js";
import { PriorityQueue } from "./pqueue.js";
import { cosineSimilarity, euclideanSimilarity } from "./similarity.js";

class HNSW {
  constructor(M = 16, efConstruction = 200, d = null, metric = "cosine") {
    this.d = null;
    this.metric = metric;
    this.d = d;
    this.M = M;
    this.efConstruction = efConstruction;
    this.entryPointId = -1;
    this.nodes = new Map();
    this.probs = this.set_probs(M, 1 / Math.log(M));
    this.levelMax = this.probs.length - 1;
    this.similarityFunction = this.getMetric(metric);
  }

  getMetric(metric) {
    if (metric === "cosine") {
      return cosineSimilarity;
    } else if (metric === "euclidean") {
      return euclideanSimilarity;
    } else {
      throw new Error("Invalid metric");
    }
  }

  set_probs(M, levelMult) {
    let level = 0;
    const probs = [];
    while (true) {
      const prob =
        Math.exp(-level / levelMult) * (1 - Math.exp(-1 / levelMult));
      if (prob < 1e-9) break;
      probs.push(prob);
      level++;
    }
    return probs;
  }

  selectLevel() {
    let r = Math.random();
    for (let i = 0; i < this.probs.length; i++) {
      if (r < this.probs[i]) {
        return i;
      }
      r -= this.probs[i];
    }
    return this.probs.length - 1;
  }

  async addNodeToGraph(node) {
    if (this.entryPointId === -1) {
      this.entryPointId = node.id;
      return;
    }

    let currentNode = this.nodes.get(this.entryPointId);
    let closestNode = currentNode;

    for (let level = this.levelMax; level >= 0; level--) {
      while (true) {
        let nextNode = null;
        let maxSimilarity = -Infinity;

        for (const neighborId of currentNode.neighbors[level] || []) {
          const neighborNode = this.nodes.get(neighborId);
          const similarity = this.similarityFunction(
            node.vector,
            neighborNode.vector,
          );
          if (similarity > maxSimilarity) {
            maxSimilarity = similarity;
            nextNode = neighborNode;
          }
        }

        if (
          nextNode &&
          maxSimilarity >
            this.similarityFunction(node.vector, closestNode.vector)
        ) {
          currentNode = nextNode;
          closestNode = currentNode;
        } else {
          break;
        }
      }
    }

    const closestLevel = Math.min(node.level, closestNode.level);
    for (let level = 0; level <= closestLevel; level++) {
      if (!closestNode.neighbors[level]) closestNode.neighbors[level] = [];
      if (!node.neighbors[level]) node.neighbors[level] = [];

      closestNode.neighbors[level].push(node.id);
      node.neighbors[level].push(closestNode.id);

      if (closestNode.neighbors[level].length > this.M) {
        closestNode.neighbors[level].pop();
      }
      if (node.neighbors[level].length > this.M) {
        node.neighbors[level].pop();
      }
    }
  }

  searchKNNoriginal(query, k) {
    if (this.entryPointId === -1) {
      return []; // Return empty array if the index is empty
    }

    const result = new PriorityQueue((a, b) => b.score - a.score);
    const visited = new Set();
    const candidates = new PriorityQueue((a, b) => b.score - a.score);

    // Start with the entry point
    const entryNode = this.nodes.get(this.entryPointId);
    const entryScore = this.similarityFunction(query, entryNode.vector);
    candidates.push({ id: this.entryPointId, score: entryScore });

    while (!candidates.isEmpty()) {
      const current = candidates.pop();

      if (visited.has(current.id)) continue;
      visited.add(current.id);

      // If we have k results and the current candidate is farther than the k-th result, we're done
      if (
        result.items.length >= k &&
        current.score < result.items[result.items.length - 1].score
      ) {
        break;
      }

      result.push(current);

      const currentNode = this.nodes.get(current.id);

      // Search through all levels
      for (let level = currentNode.neighbors.length - 1; level >= 0; level--) {
        for (const neighborId of currentNode.neighbors[level] || []) {
          if (visited.has(neighborId)) continue;

          const neighborNode = this.nodes.get(neighborId);
          const score = this.similarityFunction(query, neighborNode.vector);
          candidates.push({ id: neighborId, score: score });
        }
      }
    }

    // Return the top k results
    return result.items.slice(0, k);
  }

  searchKNN(query, k, efSearch = 100) {
    if (this.entryPointId === -1) {
      console.log("Index is empty");
      return [];
    }

    const visited = new Set();
    const candidates = new MaxHeap();
    const result = new TopK(efSearch);

    const entryNode = this.nodes.get(this.entryPointId);
    const entryScore = this.similarityFunction(query, entryNode.vector);
    candidates.push([entryScore, this.entryPointId]);

    while (!candidates.isEmpty()) {
      const [currDist, currId] = candidates.pop();

      if (
        result.getTopK().length < efSearch ||
        currDist > result.getTopK()[result.getTopK().length - 1].score
      ) {
        result.add({ id: currId, score: currDist });

        const currNode = this.nodes.get(currId);
        for (let level = currNode.neighbors.length - 1; level >= 0; level--) {
          for (const neighborId of currNode.neighbors[level] || []) {
            if (!visited.has(neighborId)) {
              visited.add(neighborId);
              const neighborNode = this.nodes.get(neighborId);
              const score = this.similarityFunction(query, neighborNode.vector);
              if (
                result.getTopK().length < efSearch ||
                score > result.getTopK()[result.getTopK().length - 1].score
              ) {
                candidates.push([score, neighborId]);
              }
            }
          }
        }
      }
    }

    return result.getTopK().slice(0, k);
  }

  async addPoint(id, vector) {
    if (this.d !== null && vector.length !== this.d) {
      throw new Error("All vectors must be of the same dimension");
    }
    this.d = vector.length;
    this.nodes.set(id, new Node(id, vector, this.selectLevel(), this.M));
    const node = this.nodes.get(id);
    this.levelMax = Math.max(this.levelMax, node.level);
    await this.addNodeToGraph(node);
  }

  async buildIndex(data) {
    this.nodes.clear();
    this.levelMax = 0;
    this.entryPointId = -1;

    for (const item of data) {
      await this.addPoint(item.id, item.vector);
    }
  }
}

class TopK {
  constructor(k) {
    this.k = k;
    this.topKElements = [];
  }

  add(element) {
    if (this.topKElements.length < this.k) {
      this.topKElements.push(element);
      this.topKElements.sort((a, b) => b.score - a.score); // Sort descending by score
    } else if (element.score > this.topKElements[this.k - 1].score) {
      this.topKElements[this.k - 1] = element;
      this.topKElements.sort((a, b) => b.score - a.score); // Sort descending by score
    }
  }

  getTopK() {
    return this.topKElements;
  }
}

class Heap {
  constructor(comparator) {
    this.heap = [];
    this.comparator = comparator;
  }

  size() {
    return this.heap.length;
  }

  isEmpty() {
    return this.size() === 0;
  }

  peek() {
    return this.heap[0];
  }

  push(value) {
    this.heap.push(value);
    this._siftUp();
  }

  pop() {
    const poppedValue = this.peek();
    const bottom = this.size() - 1;
    if (bottom > 0) {
      this._swap(0, bottom);
    }
    this.heap.pop();
    this._siftDown();
    return poppedValue;
  }

  _parent(i) {
    return ((i + 1) >>> 1) - 1;
  }

  _left(i) {
    return (i << 1) + 1;
  }

  _right(i) {
    return (i + 1) << 1;
  }

  _swap(i, j) {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
  }

  _compare(i, j) {
    return this.comparator(this.heap[i], this.heap[j]);
  }

  _siftUp() {
    let node = this.size() - 1;
    while (node > 0 && this._compare(node, this._parent(node)) > 0) {
      this._swap(node, this._parent(node));
      node = this._parent(node);
    }
  }

  _siftDown() {
    let node = 0;
    while (
      (this._left(node) < this.size() &&
        this._compare(this._left(node), node) > 0) ||
      (this._right(node) < this.size() &&
        this._compare(this._right(node), node) > 0)
    ) {
      let maxChild =
        this._right(node) < this.size() &&
        this._compare(this._right(node), this._left(node)) > 0
          ? this._right(node)
          : this._left(node);
      this._swap(node, maxChild);
      node = maxChild;
    }
  }

  items() {
    return this.heap;
  }
}

class MaxHeap extends Heap {
  constructor() {
    super((a, b) => a[0] - b[0]);
  }
}

class MinHeap extends Heap {
  constructor() {
    super((a, b) => b[0] - a[0]);
  }
}

export { HNSW };
