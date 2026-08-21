import { cosineSimilarity } from "/libs/similarity.js";

// Shared hierarchical-clustering engine used by both js/clustering.js
// (background-routed) and js/hclust-worker.js (Worker-routed, spawned by
// js/cluster.js) -- previously two independently hand-rolled copies that had
// already drifted (only one of them filtered out rows missing an embedding).

const invertedCosineSimilarity = (vecA, vecB) =>
  1 - cosineSimilarity(vecA, vecB);

const euclideanDistance = (a, b) => {
  const size = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < size; index++)
    sum += (a[index] - b[index]) * (a[index] - b[index]);
  return Math.sqrt(sum);
};

const averageDistance = (setA, setB, distances) => {
  let distance = 0;
  for (const a of setA) {
    for (const b of setB) distance += distances[a][b];
  }
  return distance / setA.length / setB.length;
};

const estimateTimeRemaining = (startTime, progress) => {
  const elapsedTime = Date.now() - startTime;
  const estimatedTotalTime = elapsedTime / progress;
  return estimatedTotalTime - elapsedTime;
};

const formatTime = (milliseconds) => {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
};

// Reports progress as { progress, name } -- callers adapt that into whatever
// shape their own transport needs (sendMessage's broadcast vs. a Worker's
// postMessage), so this stays agnostic of who's consuming it.
const updateProgress = (stepNumber, stepProgress, onProgress, startTime) => {
  const progress = stepNumber / 2 + stepProgress / 2;
  const name = `${formatTime(estimateTimeRemaining(startTime, progress))} remaining`;
  onProgress({ progress, name });
};

const logProgress = ({ progress }) =>
  console.log("Clustering: ", (progress * 100).toFixed(1) + "%");

const clusterData = ({
  data = [],
  key = "",
  distance = euclideanDistance,
  linkage = averageDistance,
  onProgress = logProgress,
}) => {
  if (key) data = data.map((datum) => datum[key]);

  let startTime = Date.now();

  const distances = data.map((datum, index) => {
    updateProgress(0, index / (data.length - 1), onProgress, startTime);
    return data.map((otherDatum) => distance(datum, otherDatum));
  });

  const clusters = data.map((datum, index) => ({
    height: 0,
    indexes: [Number(index)],
  }));

  let clustersGivenK = [];

  for (let iteration = 0; iteration < data.length; iteration++) {
    updateProgress(1, (iteration + 1) / data.length, onProgress, startTime);
    clustersGivenK.push(clusters.map((cluster) => cluster.indexes));
    if (iteration >= data.length - 1) break;

    let nearestDistance = Infinity;
    let nearestRow = 0;
    let nearestCol = 0;

    for (let row = 0; row < clusters.length; row++) {
      for (let col = row + 1; col < clusters.length; col++) {
        const distance = linkage(
          clusters[row].indexes,
          clusters[col].indexes,
          distances,
        );
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestRow = row;
          nearestCol = col;
        }
      }
    }

    const newCluster = {
      indexes: [
        ...clusters[nearestRow].indexes,
        ...clusters[nearestCol].indexes,
      ],
      height: nearestDistance,
      children: [clusters[nearestRow], clusters[nearestCol]],
    };

    clusters.splice(Math.max(nearestRow, nearestCol), 1);
    clusters.splice(Math.min(nearestRow, nearestCol), 1);
    clusters.push(newCluster);
  }

  clustersGivenK = [[], ...clustersGivenK.reverse()];

  return {
    clusters: clusters[0],
    distances: distances,
    order: clusters[0].indexes,
    clustersGivenK: clustersGivenK,
  };
};

function calculateDistance(point1, point2, distances) {
  return distances[point1][point2];
}

function calculateClusterVariance(cluster, distances) {
  if (cluster.length <= 1) return 0;

  let sumOfDistances = 0;
  let count = 0;

  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      sumOfDistances += calculateDistance(cluster[i], cluster[j], distances);
      count++;
    }
  }

  return sumOfDistances / count;
}

function calculateWithinClusterVariance(clustersGivenK, distances, K) {
  if (K <= 0 || K >= clustersGivenK.length) return null;

  let totalVariance = 0;
  const clustersAtK = clustersGivenK[K];

  for (let cluster of clustersAtK) {
    totalVariance += calculateClusterVariance(cluster, distances);
  }

  return totalVariance;
}

function findOptimalClusters(variances) {
  if (variances.length < 2) {
    console.log("Array must have at least two elements to find a peak.");
  }

  let peakIndex = 0;
  let maxVariance = variances[0];

  for (let i = 1; i < variances.length; i++) {
    if (variances[i] > maxVariance) {
      maxVariance = variances[i];
      peakIndex = i;
    }
  }

  const optimalClustersIndex = peakIndex > 0 ? peakIndex - 1 : 0;

  return optimalClustersIndex;
}

// Loads the rows to cluster across one or more object stores. Both callers
// need identical shape: an array of {databaseName, tableName, keyPath} specs.
async function loopTables(data, getAllData) {
  let resultData = [];

  for (let d in data) {
    let tableData = await getAllData(data[d]);
    resultData = [...resultData, ...tableData];
  }

  return resultData;
}

export {
  invertedCosineSimilarity,
  euclideanDistance,
  averageDistance,
  clusterData,
  calculateWithinClusterVariance,
  findOptimalClusters,
  loopTables,
};
