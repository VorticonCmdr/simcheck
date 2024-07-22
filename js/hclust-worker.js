/**
 * Computes the cosine similarity between two arrays.
 *
 * @param {number[]} arr1 The first array.
 * @param {number[]} arr2 The second array.
 * @returns {number} The cosine similarity between the two arrays.
 */
function cos_sim(arr1, arr2) {
  // Calculate dot product of the two arrays
  const dotProduct = dot(arr1, arr2);

  // Calculate the magnitude of the first array
  const magnitudeA = magnitude(arr1);

  // Calculate the magnitude of the second array
  const magnitudeB = magnitude(arr2);

  // Calculate the cosine similarity
  const cosineSimilarity = dotProduct / (magnitudeA * magnitudeB);

  return cosineSimilarity;
}

/**
 * Calculates the dot product of two arrays.
 * @param {number[]} arr1 The first array.
 * @param {number[]} arr2 The second array.
 * @returns {number} The dot product of arr1 and arr2.
 */
function dot(arr1, arr2) {
  let result = 0;
  for (let i = 0; i < arr1.length; ++i) {
    result += arr1[i] * arr2[i];
  }
  return result;
}

/**
 * Calculates the magnitude of a given array.
 * @param {number[]} arr The array to calculate the magnitude of.
 * @returns {number} The magnitude of the array.
 */
function magnitude(arr) {
  return Math.sqrt(arr.reduce((acc, val) => acc + val * val, 0));
}

const invertedCosineSimilarity = (vecA, vecB) => {
  return 1 - cos_sim(vecA, vecB);
};

// get euclidean distance between two equal-dimension vectors
const euclideanDistance = (a, b) => {
  const size = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < size; index++)
    sum += (a[index] - b[index]) * (a[index] - b[index]);
  return Math.sqrt(sum);
};

// get average distance between sets of indexes, given distance matrix
const averageDistance = (setA, setB, distances) => {
  let distance = 0;
  for (const a of setA) {
    for (const b of setB) distance += distances[a][b];
  }

  return distance / setA.length / setB.length;
};

// update progress by calling user onProgress and postMessage for web workers
const updateProgress = (stepNumber, stepProgress, onProgress, startTime) => {
  // currently only two distinct steps: computing distance matrix and clustering
  const progress = stepNumber / 2 + stepProgress / 2;

  // Function to estimate the remaining time
  const estimateTimeRemaining = (startTime, progress) => {
    const elapsedTime = Date.now() - startTime;
    const estimatedTotalTime = elapsedTime / progress;
    return estimatedTotalTime - elapsedTime;
  };

  // Estimate remaining time
  const timeRemaining = estimateTimeRemaining(startTime, progress);

  // Format time remaining as HH:MM:SS
  const formatTime = (milliseconds) => {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  };

  const formattedTimeRemaining = formatTime(timeRemaining);

  // if onProgress is defined and is a function, call onProgress
  if (typeof onProgress === "function") onProgress(progress);

  // if this script is being run as a web worker, call postMessage
  if (
    typeof WorkerGlobalScope !== "undefined" &&
    self instanceof WorkerGlobalScope
  )
    postMessage({
      type: "progress",
      progress,
      name: `${formattedTimeRemaining} remaining`,
    });
};

// default onProgress function. console logs progress
const logProgress = (progress) =>
  console.log("Clustering: ", (progress * 100).toFixed(1) + "%");

// the main clustering function
const clusterData = ({
  data = [],
  key = "",
  distance = euclideanDistance,
  linkage = averageDistance,
  onProgress = logProgress,
}) => {
  // extract values from specified key
  if (key) data = data.map((datum) => datum[key]);

  // Capture the start time at the beginning
  let startTime = Date.now();

  // compute distance between each data point and every other data point
  // N x N matrix where N = data.length
  const distances = data.map((datum, index) => {
    updateProgress(0, index / (data.length - 1), onProgress, startTime);

    // get distance between datum and other datum
    return data.map((otherDatum) => distance(datum, otherDatum));
  });

  // initialize clusters to match data
  const clusters = data.map((datum, index) => ({
    height: 0,
    indexes: [Number(index)],
  }));

  // keep track of all tree slices
  let clustersGivenK = [];

  // iterate through data
  for (let iteration = 0; iteration < data.length; iteration++) {
    updateProgress(1, (iteration + 1) / data.length, onProgress, startTime);

    // add current tree slice
    clustersGivenK.push(clusters.map((cluster) => cluster.indexes));

    // dont find clusters to merge when only one cluster left
    if (iteration >= data.length - 1) break;

    // initialize smallest distance
    let nearestDistance = Infinity;
    let nearestRow = 0;
    let nearestCol = 0;

    // upper triangular matrix of clusters
    for (let row = 0; row < clusters.length; row++) {
      for (let col = row + 1; col < clusters.length; col++) {
        // calculate distance between clusters
        const distance = linkage(
          clusters[row].indexes,
          clusters[col].indexes,
          distances,
        );
        // update smallest distance
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestRow = row;
          nearestCol = col;
        }
      }
    }

    // merge nearestRow and nearestCol clusters together
    const newCluster = {
      indexes: [
        ...clusters[nearestRow].indexes,
        ...clusters[nearestCol].indexes,
      ],
      height: nearestDistance,
      children: [clusters[nearestRow], clusters[nearestCol]],
    };

    // remove nearestRow and nearestCol clusters
    // splice higher index first so it doesn't affect second splice
    clusters.splice(Math.max(nearestRow, nearestCol), 1);
    clusters.splice(Math.min(nearestRow, nearestCol), 1);

    // add new merged cluster
    clusters.push(newCluster);
  }

  // assemble full list of tree slices into array where index = k
  clustersGivenK = [[], ...clustersGivenK.reverse()];

  // return useful information
  return {
    clusters: clusters[0],
    distances: distances,
    order: clusters[0].indexes,
    clustersGivenK: clustersGivenK,
  };
};

function openDatabase(databaseName, tableName, keyPath) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // Create the object store if it doesn't exist
      if (!db.objectStoreNames.contains(tableName)) {
        db.createObjectStore(tableName, {
          keyPath: keyPath,
        });
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      resolve(db);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

function getAllData(db, tableName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([tableName], "readonly");
    const objectStore = transaction.objectStore(tableName);
    const request = objectStore.openCursor();

    let docs = [];
    request.onsuccess = (event) => {
      const cursor = event.target.result;

      function processCursor(cursor) {
        if (cursor) {
          docs.push(cursor.value);
          cursor.continue();
        } else {
          //resolve(event.target.result);
          resolve(docs);
        }
      }

      processCursor(cursor);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

function calculateEuclideanDistance(x1, y1, x2, y2) {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}

function findElbowPoint(variances) {
  const nPoints = variances.length;
  const firstPoint = [1, variances[0]];
  const lastPoint = [nPoints, variances[nPoints - 1]];

  let maxDistance = 0;
  let elbowPoint = 1;

  for (let i = 2; i <= nPoints; i++) {
    const currentPoint = [i, variances[i - 1]];
    console.log(firstPoint[0]);
    const distance =
      Math.abs(
        (lastPoint[1] - firstPoint[1]) * currentPoint[0] -
          (lastPoint[0] - firstPoint[0]) * currentPoint[1] +
          lastPoint[0] * firstPoint[1] -
          lastPoint[1] * firstPoint[0],
      ) /
      calculateEuclideanDistance(
        firstPoint[0],
        firstPoint[1],
        lastPoint[0],
        lastPoint[1],
      );

    if (distance > maxDistance) {
      maxDistance = distance;
      elbowPoint = i;
    }
  }

  return elbowPoint;
}

function calculateDistance(point1, point2, distances) {
  // Assuming point1 and point2 are indices in the distance matrix,
  // retrieve the distance between these points.
  return distances[point1][point2];
}

function calculateClusterVariance(cluster, distances) {
  if (cluster.length <= 1) return 0;

  let sumOfDistances = 0;
  let count = 0;

  // Calculate the sum of distances between all pairs of points in the cluster
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      sumOfDistances += calculateDistance(cluster[i], cluster[j], distances);
      count++;
    }
  }

  // The average distance in a cluster can be used as a measure of variance
  return sumOfDistances / count;
}

function calculateWithinClusterVariance(clustersGivenK, distances, K) {
  if (K <= 0 || K >= clustersGivenK.length) return null;

  let totalVariance = 0;
  const clustersAtK = clustersGivenK[K];

  // Calculate variance for each cluster at level K and sum them
  for (let cluster of clustersAtK) {
    totalVariance += calculateClusterVariance(cluster, distances);
  }

  return totalVariance;
}

function findOptimalClusters(variances) {
  if (variances.length < 2) {
    //throw new Error("Array must have at least two elements to find a peak.");
    console.log("Array must have at least two elements to find a peak.");
  }

  let peakIndex = 0;
  let maxVariance = variances[0];

  // Find the index of the peak variance
  for (let i = 1; i < variances.length; i++) {
    if (variances[i] > maxVariance) {
      maxVariance = variances[i];
      peakIndex = i;
    }
  }

  // The optimal number of clusters is just before the peak
  // Ensure there is at least one cluster before the peak
  const optimalClustersIndex = peakIndex > 0 ? peakIndex - 1 : 0;

  return optimalClustersIndex;
}

async function loopTables(data) {
  let resultData = [];

  for (d in data) {
    let db = await openDatabase(
      data[d].databaseName,
      data[d].tableName,
      data[d].keyPath,
    );
    let tableData = await getAllData(db, data[d].tableName);
    db.close();
    resultData = [...resultData, ...tableData];
  }

  return resultData;
}

async function processClusterData(data) {
  let tableData = await loopTables(data);

  // keyPath and model must be identical for both datasets
  let embeddings = tableData.map((row) => {
    return {
      id: row[data[0].keyPath],
      value: row.embeddings[data[0].model],
    };
  });

  let clusterResult = clusterData({
    data: embeddings,
    key: "value",
    distance: invertedCosineSimilarity,
    onProgress: null,
  });

  let variances = [];
  for (let r = 0; r < clusterResult.distances.length; r++) {
    var v = calculateWithinClusterVariance(
      clusterResult.clustersGivenK,
      clusterResult.distances,
      r,
    );
    variances.push(v);
  }
  let p0 = findOptimalClusters(variances);

  //let p1 = findElbowPoint(variances);
  //let p2 = findElbowPoint(variances.slice(0, p1));

  let ids = {};
  clusterResult.clustersGivenK[p0].forEach((cluster, clusterNumber) => {
    cluster.forEach((point) => {
      let id = embeddings[point]["id"];
      let order = clusterResult.order[point];
      ids[id] = {
        order,
        clusterNumber,
      };
      //ids[id] = clusterNumber;
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
