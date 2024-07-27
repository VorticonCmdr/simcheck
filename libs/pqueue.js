class PriorityQueue {
  constructor(compare) {
    this.compare = compare;
    this.items = [];
  }

  push(item) {
    let i = 0;
    while (i < this.items.length && this.compare(item, this.items[i]) > 0) {
      i++;
    }
    this.items.splice(i, 0, item);
  }

  pop() {
    return this.items.shift();
  }

  isEmpty() {
    return this.items.length === 0;
  }
}

export { PriorityQueue };
