import { bestMatches } from "../core/vector";

// One slice of a dataset comparison, working on matrices shared with its siblings.
self.onmessage = ({ data }) => {
  const { a, b, d, nB, start, end, bestIndex, bestScore } = data;
  bestMatches(a, b, d, nB, start, end, bestIndex, bestScore, (rows) => postMessage({ rows }));
  postMessage({ done: true });
};
