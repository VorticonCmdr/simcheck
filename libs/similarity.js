const cosineSimilarity = (a, b) => {
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

const euclideanSimilarity = (a, b) => {
  let sum = 0.0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return 1 / (1 + Math.sqrt(sum));
};

export { cosineSimilarity, euclideanSimilarity };
