class Node {
  constructor(id, vector, level, M) {
    this.id = id;
    this.vector = vector;
    this.level = level;
    this.neighbors = Array.from({ length: level + 1 }, () => []);
  }
}

export { Node };
