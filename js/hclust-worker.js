import { getAllData } from "/js/indexeddb.js";
import {
  invertedCosineSimilarity,
  clusterData,
  calculateWithinClusterVariance,
  findOptimalClusters,
  loopTables,
} from "/libs/hclustAlgorithm.js";

async function processClusterData(data) {
  let tableData = await loopTables(data, getAllData);

  // keyPath and model must be identical for both datasets
  let embeddings = tableData
    .filter((row) => row.embeddings?.[data[0].model])
    .map((row) => {
      return {
        id: row[data[0].keyPath],
        value: row.embeddings[data[0].model],
      };
    });

  let clusterResult = clusterData({
    data: embeddings,
    key: "value",
    distance: invertedCosineSimilarity,
    onProgress: (progress) =>
      postMessage({
        type: "progress",
        progress: progress.progress,
        name: progress.name,
      }),
  });

  let variances = [];
  for (let r = 0; r < clusterResult.distances.length; r++) {
    let v = calculateWithinClusterVariance(
      clusterResult.clustersGivenK,
      clusterResult.distances,
      r,
    );
    variances.push(v);
  }
  let p0 = findOptimalClusters(variances);

  let ids = {};
  clusterResult.clustersGivenK[p0].forEach((cluster, clusterNumber) => {
    cluster.forEach((point) => {
      let id = embeddings[point]["id"];
      let order = clusterResult.order[point];
      ids[id] = {
        order,
        clusterNumber,
      };
    });
  });

  return ids;
}

self.onmessage = async function (e) {
  const { method, data } = e.data;
  let result;

  switch (method) {
    case "clusterData":
      result = {
        clusters: await processClusterData(data),
        request: data,
      };
      break;
    default:
      result = null;
  }

  self.postMessage({ type: method, result });
};
