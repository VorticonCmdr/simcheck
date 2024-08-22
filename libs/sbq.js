class SBQ {
  constructor(vectors) {
    this.vectors = vectors;
    this.means = this.calculateMeans(vectors);
    this.stdevs = this.calculateStdevs(vectors, this.means);
    this.quantizedBlobs = this.quantizeAllVectorsToBlob(vectors);
  }

  // Calculate means for each dimension
  calculateMeans(vectors) {
    const numDimensions = vectors[0].vector.length;
    const means = Array(numDimensions).fill(0);
    vectors.forEach(({ vector }) => {
      vector.forEach((value, index) => {
        means[index] += value;
      });
    });
    return means.map((mean) => mean / vectors.length);
  }

  // Calculate standard deviations for each dimension
  calculateStdevs(vectors, means) {
    const numDimensions = vectors[0].vector.length;
    const stdevs = Array(numDimensions).fill(0);
    vectors.forEach(({ vector }) => {
      vector.forEach((value, index) => {
        stdevs[index] += (value - means[index]) ** 2;
      });
    });
    return stdevs.map((stdev) => Math.sqrt(stdev / vectors.length));
  }

  // Quantize a single vector into a bitmap and store as a blob
  quantize(vector) {
    return vector.map((value, index) => {
      const zScore = (value - this.means[index]) / this.stdevs[index];
      if (zScore > 1) {
        return 0b11; // Bitmap representation of '11'
      } else if (zScore > 0) {
        return 0b01; // Bitmap representation of '01'
      } else {
        return 0b00; // Bitmap representation of '00'
      }
    });
  }

  // Quantize all vectors in the dataset and store as blobs
  quantizeAllVectorsToBlob(vectors) {
    return vectors.map(({ id, vector }) => ({
      id,
      quantizedBlob: this.vectorToBlob(this.quantize(vector)),
    }));
  }

  // Convert the quantized bitmap array to a blob (integer representation)
  vectorToBlob(bitmap) {
    return bitmap.reduce((blob, bits) => (blob << 2) | bits, 0);
  }

  // Calculate XOR distance between two blobs (quantized data)
  static xorDistance(blob1, blob2) {
    let xorResult = blob1 ^ blob2;
    let distance = 0;
    while (xorResult) {
      distance += xorResult & 1;
      xorResult >>= 1;
    }
    return distance;
  }

  // KNN Search method
  knnSearch(queryVector, k) {
    const topK = new TopK(k);
    const quantizedQueryBlob = this.vectorToBlob(this.quantize(queryVector));

    this.quantizedBlobs.forEach(({ id, quantizedBlob }) => {
      const distance = SBQ.xorDistance(quantizedQueryBlob, quantizedBlob);
      topK.add({ id, score: -distance }); // Use negative distance to sort in ascending order
    });

    return topK.getTopK().map((entry) => entry.id);
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
