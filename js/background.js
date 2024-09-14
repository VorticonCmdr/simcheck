// open the interface when clicking on icon
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create(
    { url: chrome.runtime.getURL("/html/import.html") },
    function (tab) {},
  );
});

import { HNSW } from "/libs/hnsw.js";

import { processClusterData } from "/js/clustering.js";

chrome.alarms.create("keepAlive", { periodInMinutes: 0.5 }); // Trigger every 30 seconds

function sendMessageAsync(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        //reject(new Error(chrome.runtime.lastError.message));
        resolve(true);
      } else {
        resolve(response);
      }
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    sendMessageAsync("keepalive");
  }
});

let portConnected = false;

import {
  AutoTokenizer,
  pipeline,
  env,
  cos_sim,
} from "/libs/transformers.min.js";
env.allowRemoteModels = true;
env.allowLocalModels = false;
// Due to a bug in onnxruntime-web, we must disable multithreading for now.
// See https://github.com/microsoft/onnxruntime/issues/14445 for more information.
env.backends.onnx.wasm.numThreads = 1;

let embeddingsExtractor = null;

import { settings, initializeSettings } from "/js/settings.js";
async function init() {
  await initializeSettings();
  if (settings.pipeline.model.startsWith("openai")) {
    return;
  }
  embeddingsExtractor = await EmbeddingsPipeline.getInstance(
    (x) => {
      // a progress callback to the pipeline so that we can
      // track model (down)loading.
      x["type"] = "loading";
      sendMessage(x);
    },
    "feature-extraction",
    settings.pipeline.model,
    settings.pipeline.options,
  );
}
init();

import {
  openDatabase,
  getAllData,
  saveData,
  getDBkeypath,
  getFilteredData,
} from "/js/indexeddb.js";

function getObjectStoreNames(databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);

    request.onsuccess = (event) => {
      const db = event.target.result;
      const objectStoreNames = Array.from(db.objectStoreNames);
      db.close();
      resolve(objectStoreNames);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

async function downloadModel(port, name) {
  if (name.startsWith("openai")) {
    sendMessage({
      type: "loading",
      status: "openai embedding",
      task: "done",
    });
    return true;
  }
  let instance = await EmbeddingsPipeline.getInstance(
    (x) => {
      // a progress callback to the pipeline so that we can
      // track model downloading.
      x["type"] = "loading";
      sendMessage(x);
    },
    "feature-extraction",
    name,
    settings.pipeline.options,
  );
  sendMessage({
    type: "loading",
    status: "download",
    task: "done",
    finished: true,
  });
  instance.dispose();
  return true;
}

class EmbeddingsPipeline {
  static async getInstance(
    progress_callback = null,
    task = "feature-extraction",
    model = settings.model,
    options = {},
  ) {
    //console.log("Creating new pipeline instance...");
    try {
      const instance = await pipeline(task, model, {
        progress_callback,
        ...options,
      });
      //console.log("Pipeline instance created successfully.");
      return instance;
    } catch (error) {
      console.error("Error creating pipeline instance:", error);
      throw error; // rethrow the error after logging it
    }
  }
}

function createNotification(message) {
  var options = {
    type: "basic",
    iconUrl: "/icons/clusters48.png", // Path to your notification icon
    title: "Simcheck",
    message: message,
    priority: 2,
  };

  chrome.notifications.create(
    settings.indexedDB.databaseName,
    options,
    function (notificationId) {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
      } else {
        console.log("Notification created with ID:", notificationId);
      }
    },
  );
}
chrome.notifications.onClicked.addListener((notificationId) => {
  console.log("Notification clicked:", notificationId);
});

async function sendMessage(message) {
  chrome.storage.local.set({ ["lastMessage"]: message }, () => {
    if (chrome.runtime.lastError) {
      console.error("Error saving message:", chrome.runtime.lastError.message);
    }
  });
  if (!portConnected) {
    return;
  }
  if (!simcheckInitialized) {
    await simcheckPromise;
  }
  try {
    ports["simcheck"].postMessage(message);
  } catch (e) {
    portConnected = false;
  }
}

async function createEmbeddings(data) {
  let docsLength = data.docs.length;

  const chunkSize = 10; // Adjust this size based on performance needs
  let processedDocs = [];
  let totalProcessed = 0;
  let totalStartTime = Date.now();

  for (let i = 0; i < docsLength; i += chunkSize) {
    const chunk = data.docs.slice(i, i + chunkSize);
    const chunkStartTime = Date.now();
    const processedChunk = await processChunk(
      chunk,
      data.selectedFields,
      totalProcessed,
      docsLength,
      totalStartTime,
      chunkStartTime,
    );
    processedDocs = processedDocs.concat(processedChunk);
    totalProcessed += chunk.length;
    await new Promise((resolve) => setTimeout(resolve, 0)); // Yield control back to the event loop
  }

  let keysSet = new Set();
  let result = await saveData(
    settings.indexedDB,
    processedDocs,
    keysSet,
    sendMessage,
  );

  sendMessage({
    type: "embeddings-stored",
    status: "done",
    task: "embeddings stored",
  });
  createNotification("embeddings created and stored");
}
async function processChunk(
  chunk,
  selectedFields,
  totalProcessed,
  docsLength,
  totalStartTime,
  chunkStartTime,
) {
  const promises = chunk.map(async (doc, index) => {
    let text = selectedFields.reduce((accumulator, currentValue) => {
      return `${accumulator}${doc[currentValue]} `;
    }, "");
    let embedding = await embeddingsExtractor(text, {
      normalize: true,
      pooling: "cls",
    });

    if (!doc["embeddings"]) {
      doc["embeddings"] = {};
    }
    doc["embeddings"][settings.pipeline.model] = embedding.data;

    // Calculate progress
    let currentProgress = totalProcessed + index + 1;
    let progress = Math.round((currentProgress / docsLength) * 100);

    // Calculate elapsed time and estimate remaining time
    let elapsedTime = (Date.now() - totalStartTime) / 1000; // in seconds
    let timePerDoc = elapsedTime / currentProgress;
    let remainingDocs = docsLength - currentProgress;
    let estimatedRemainingTime = timePerDoc * remainingDocs; // in seconds

    // Convert remaining time to a human-readable format
    let hours = Math.floor(estimatedRemainingTime / 3600);
    let minutes = Math.floor((estimatedRemainingTime % 3600) / 60);
    let seconds = Math.floor(estimatedRemainingTime % 60);
    let remainingTimeString = `${hours}h ${minutes}m ${seconds}s`;

    // Send progress update message
    sendMessage({
      type: "loading",
      status: "extracting embeddings",
      name: `${remainingTimeString} remaining`,
      progress: progress,
    });

    return doc;
  });

  return await Promise.all(promises);
}

async function getEmbeddingsBatch(texts, batchIndex, totalBatches) {
  return fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.openai.key}`,
    },
    body: JSON.stringify({
      model: settings.pipeline.model.replace("openai/", ""),
      input: texts,
    }),
  })
    .then((response) => {
      if (!response.ok) {
        sendMessage({
          status: 500,
          statusText: "error calling the openAI embeddings api",
          error: response.statusText,
        });
        return [];
      }
      const reader = response.body.getReader();
      const contentLength = +response.headers.get("Content-Length");
      let receivedLength = 0;
      let chunks = [];

      function read() {
        return reader.read().then(({ done, value }) => {
          if (done) {
            const chunksAll = new Uint8Array(receivedLength);
            let position = 0;
            for (let chunk of chunks) {
              chunksAll.set(chunk, position);
              position += chunk.length;
            }
            const data = new TextDecoder("utf-8").decode(chunksAll);
            return JSON.parse(data);
          }
          chunks.push(value);
          receivedLength += value.length;

          const progress =
            ((batchIndex + receivedLength / contentLength) / totalBatches) *
            100;
          sendMessage({
            type: "loading",
            status: "extracting embeddings",
            name: settings.pipeline.model,
            progress: progress,
          });

          return read();
        });
      }

      return read();
    })
    .catch((error) => {
      sendMessage({
        status: 500,
        statusText: "error calling the openAI embeddings api",
        error: error.message,
      });
      return [];
    });
}

async function createOpenAiEmbeddings(data) {
  const batchSize = 1000;
  const batches = [];

  let docsLength = data.docs.length;
  for (let index = 0; index < docsLength; index += batchSize) {
    const batch = data.docs.slice(index, index + batchSize).map((doc) => {
      return data.selectedFields.reduce((accumulator, currentValue) => {
        return `${accumulator}${doc[currentValue]} `;
      }, "");
    });
    batches.push(batch);
  }

  sendMessage({
    type: "loading",
    status: "data from openAI api",
  });

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const progress = ((batchIndex + 1) / batches.length) * 100;
    sendMessage({
      type: "loading",
      status: "extracting embeddings",
      name: settings.pipeline.model,
      progress: progress,
    });
    const embeddingsResponse = await getEmbeddingsBatch(
      batch,
      batchIndex,
      batches.length,
    );
    for (
      let embeddingsResponseIndex = 0;
      embeddingsResponseIndex < embeddingsResponse.data.length;
      embeddingsResponseIndex++
    ) {
      let batchDocIndex =
        embeddingsResponse.data[embeddingsResponseIndex].index;
      let docIndex = batchDocIndex + batchIndex * batchSize;

      if (!data.docs[docIndex]["embeddings"]) {
        data.docs[docIndex]["embeddings"] = {};
      }
      data.docs[docIndex]["embeddings"][settings.pipeline.model] =
        Float32Array.from(
          embeddingsResponse.data[embeddingsResponseIndex].embedding,
        );
    }
  }

  let keysSet = new Set();
  let result = await saveData(
    settings.indexedDB,
    data.docs,
    keysSet,
    sendMessage,
  );

  sendMessage({
    type: "embeddings-stored",
    status: "storing embeddings",
    task: "done",
  });
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

async function searchDataOpenAi(text) {
  const embeddingsResponse = await getEmbeddingsBatch(text);

  const queryVector = embeddingsResponse?.data[0]?.embedding;
  if (!queryVector) {
    return;
  }
  const queryVectorLength = queryVector.length;

  const db = await openDatabase(settings.indexedDB, true);
  const transaction = db.transaction(
    [settings.indexedDB.tableName],
    "readonly",
  );
  const objectStore = transaction.objectStore(settings.indexedDB.tableName);
  const request = objectStore.openCursor();

  return new Promise((resolve, reject) => {
    //let scoreList = [];
    const topK = new TopK(10);

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        let doc = cursor.value;
        const vectorValue = doc["embeddings"][settings.pipeline.model];

        if (vectorValue.length == queryVectorLength) {
          // Only add the vector to the results set if the vector is the same length as query.
          const similarity = cos_sim(vectorValue, queryVector);
          doc["score"] = parseFloat(similarity.toPrecision(2));
          delete doc["embeddings"];
          topK.add(doc);
        }
        cursor.continue();
      } else {
        resolve(topK.getTopK());
      }
    };

    request.onerror = (event) => {
      console.log(event.target.error);
      reject(scoreList);
    };
  });
}

function mergeObjects(obj1, obj2, suffix) {
  let result = { ...obj1 };

  for (let key in obj2) {
    if (obj2.hasOwnProperty(key)) {
      result[`${key}${suffix}`] = obj2[key];
    }
  }

  return result;
}
function compareEmbeddings(obj1, obj2, modelName) {
  let vector1 = obj1?.["embeddings"]?.[modelName];
  let vector2 = obj2?.["embeddings"]?.[modelName];
  if (!vector1 || !vector2) {
    return [];
  }
  const similarity = cos_sim(vector1, vector2);

  obj1 = mergeObjects({ score: similarity?.toFixed(3) }, obj1, "");
  let result = mergeObjects(obj1, obj2, "2");

  return [result];
}

async function searchDataHF(message) {
  let embedding = await embeddingsExtractor(message.query, {
    pooling: "cls",
  });
  const queryVector = embedding.data;
  const queryVectorLength = queryVector.length;

  const db = await openDatabase(settings.indexedDB, true);
  const transaction = db.transaction(
    [message.settings.indexedDB.tableName],
    "readonly",
  );
  const objectStore = transaction.objectStore(
    message.settings.indexedDB.tableName,
  );
  const request = objectStore.openCursor();

  return new Promise((resolve, reject) => {
    const topK = new TopK(10);

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        let doc = cursor.value;
        const vectorValue = doc["embeddings"][message.settings.pipeline.model];

        if (vectorValue.length == queryVectorLength) {
          const similarity = cos_sim(vectorValue, queryVector);
          doc["score"] = parseFloat(similarity.toPrecision(2));
          delete doc["embeddings"];
          topK.add(doc);
        }
        cursor.continue();
      } else {
        resolve(topK.getTopK());
      }
    };

    request.onerror = (event) => {
      console.log(event.target.error);
      reject(scoreList);
    };
  });
}

class SBQ {
  constructor(vectors) {
    this.vectors = vectors;
    this.means = this.calculateMeans(vectors);
    this.stdevs = this.calculateStdevs(vectors, this.means);
    this.quantizedBuffers = this.quantizeAllVectorsToBuffer(vectors);
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

  // Quantize a single vector into a bitmap
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

  // Quantize all vectors in the dataset and store as ArrayBuffers
  quantizeAllVectorsToBuffer(vectors) {
    return vectors.map(({ id, vector }) => ({
      id,
      quantizedBuffer: this.vectorToBuffer(this.quantize(vector)),
    }));
  }

  // Convert the quantized bitmap array to an ArrayBuffer
  vectorToBuffer(bitmap) {
    const buffer = new ArrayBuffer(Math.ceil(bitmap.length / 4)); // Each element is 2 bits, 4 elements per byte
    const view = new Uint8Array(buffer);

    bitmap.forEach((bits, index) => {
      const byteIndex = Math.floor(index / 4);
      const shiftAmount = (3 - (index % 4)) * 2;
      view[byteIndex] |= bits << shiftAmount;
    });

    return buffer;
  }

  // Calculate XOR distance between two ArrayBuffers
  static xorDistance(buffer1, buffer2) {
    const view1 = new Uint8Array(buffer1);
    const view2 = new Uint8Array(buffer2);
    let distance = 0;

    for (let i = 0; i < view1.length; i++) {
      let xorResult = view1[i] ^ view2[i];
      // Count set bits (Hamming weight)
      while (xorResult) {
        distance += xorResult & 1;
        xorResult >>= 1;
      }
    }

    return distance;
  }

  // KNN Search method
  knnSearch(queryVector, k) {
    const topK = new TopK(k);
    const quantizedQueryBuffer = this.vectorToBuffer(
      this.quantize(queryVector),
    );

    this.quantizedBuffers.forEach(({ id, quantizedBuffer }) => {
      const distance = SBQ.xorDistance(quantizedQueryBuffer, quantizedBuffer);
      topK.add({ id, score: -distance }); // Use negative distance to sort in ascending order
    });

    return topK.getTopK().slice(0, k);
  }
}

//let sbq = null;
let hnsw = null;
async function generateHNSW(message) {
  let tableData = await getAllData(message.indexedDB);

  let data = tableData.map((d) => {
    return {
      id: d[message.indexedDB.keyPath],
      vector: d.embeddings[message.pipeline.model],
    };
  });

  try {
    //sbq = new SBQ(data);
    hnsw = new HNSW(128, 512, data[0].vector.length, "cosine");
    await hnsw.buildIndex(data);
    tableData.forEach((row, rowIndex) => {
      let hnswNode = hnsw.nodes.get(row[message.indexedDB.keyPath]);
      hnswNode["M"] = hnsw.M;
      hnswNode["efConstruction"] = hnsw.efConstruction;
      hnswNode["levelMax"] = hnsw.levelMax;
      hnswNode["entryPointId"] = hnsw.entryPointId;
      delete hnswNode.id;
      delete hnswNode.vector;
      if (!hnswNode) {
        return;
      }
      if (!tableData[rowIndex]["hnsw"]) {
        tableData[rowIndex]["hnsw"] = {};
      }
      tableData[rowIndex]["hnsw"][message.pipeline.model] = hnswNode;
    });

    let keysSet = new Set();
    let result = await saveData(
      message.indexedDB,
      tableData,
      keysSet,
      sendMessage,
    );
    //console.log(hnsw);
    return true;
  } catch (e) {
    return false;
  }
}

async function restoreHNSWindex(pipeline, indexedDB, tableData) {
  if (!tableData[0]?.["hnsw"]?.[pipeline.model]) {
    await generateHNSW({
      pipeline: pipeline,
      indexedDB: indexedDB,
    });
    tableData = await getAllData(indexedDB);
  }
  hnsw = new HNSW(
    tableData[0]["hnsw"][pipeline.model].M,
    tableData[0]["hnsw"][pipeline.model].efConstruction,
  );
  hnsw.levelMax = tableData[0]["hnsw"][pipeline.model].levelMax;
  hnsw.entryPointId = tableData[0]["hnsw"][pipeline.model].entryPointId;
  hnsw.nodes = new Map(
    tableData.map((d) => {
      d["hnsw"][pipeline.model]["vector"] = d["embeddings"][pipeline.model];
      return [d[indexedDB.keyPath], d["hnsw"][pipeline.model]];
    }),
  );
}

async function restoreHNSW(message) {
  let tableData = await getAllData(message.indexedDB);

  if (!tableData[0]?.hnsw) {
    return false;
  }
  if (!tableData[0]?.["hnsw"]?.[message.pipeline.model]) {
    return false;
  }

  await restoreHNSWindex(message.pipeline, message.indexedDB, tableData);
  return true;
}

async function searchHNSW(message) {
  let embedding = await embeddingsExtractor(message.query, {
    pooling: "cls",
  });
  const queryVector = embedding.data;

  // Search for nearest neighbors
  const results = hnsw.searchKNN(queryVector, 10);

  return results;
}

async function getNumberOfTokens(text) {
  if (settings.pipeline.model.startsWith("openai")) {
    return "?";
  }
  const tokenizer = await AutoTokenizer.from_pretrained(
    settings.pipeline.model,
  );
  const { input_ids } = await tokenizer(text);

  return input_ids.size;
}

async function compareArrays(array1, array2, array2keyPath, key) {
  const result = [];
  let array1Length = array1.length;
  let pos1 = 1;

  let array2Dict = array2.reduce((acc, obj) => {
    acc[obj[array2keyPath]] = obj;
    return acc;
  }, {});

  for (let obj1 of array1) {
    let res = obj1;
    let maxSimilarity = -1;
    let bestMatch = null;

    let progress = (pos1 / array1Length) * 100;
    sendMessage({
      type: "loading",
      status: "comparing embeddings",
      name: "rows",
      progress: progress,
    });
    pos1++;

    const vec1 = obj1?.["embeddings"]?.[key];

    const results = hnsw.searchKNN(vec1, 1);
    //const results = sbq.knnSearch(vec1, 1);

    if (results.length != 1) {
      continue;
    }

    bestMatch = array2Dict[results[0]["id"]];
    res["score"] = parseFloat(results[0]["score"]?.toFixed(3));
    /*
    for (let obj2 of array2) {
      const vec2 = obj2?.["embeddings"]?.[key];
      if (!vec1?.length || !vec2?.length) {
        continue;
      }
      const similarity = cos_sim(vec1, vec2);

      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        bestMatch = obj2;
      }
    }
    */
    // Yield control back to the event loop
    await new Promise((resolve) => setTimeout(resolve, 0));

    //res["score"] = parseFloat(maxSimilarity.toFixed(3));
    Object.keys(bestMatch).forEach((key) => {
      if (key == "embeddings") {
        return;
      }
      if (key == "score") {
        return;
      }
      if (key == "hnsw") {
        return;
      }
      res[`bestMatch-${key}`] = bestMatch[key];
    });

    result.push(res);
  }

  result.map((item) => {
    delete item?.embeddings;
    return item;
  });

  return result;
}

async function compareStores(message) {
  let resultData = [];

  const array1 = await getAllData({
    databaseName: settings.indexedDB.databaseName,
    tableName: message.store1,
    keyPath: await getDBkeypath(
      settings.indexedDB.databaseName,
      message.store1,
    ),
    version: settings.indexedDB.version,
  });

  settings.indexedDB.keyPath = await getDBkeypath(
    settings.indexedDB.databaseName,
    message.store2,
  );
  const array2 = await getAllData({
    databaseName: settings.indexedDB.databaseName,
    tableName: message.store2,
    keyPath: settings.indexedDB.keyPath,
    version: settings.indexedDB.version,
  });
  await restoreHNSWindex(
    settings.pipeline,
    {
      databaseName: settings.indexedDB.databaseName,
      tableName: message.store2,
      keyPath: settings.indexedDB.keyPath,
      version: settings.indexedDB.version,
    },
    array2,
  );

  if (!array1?.length || !array2.length) {
    console.log("datastore empty");
    return [];
  }
  resultData = await compareArrays(
    array1,
    array2,
    settings.indexedDB.keyPath,
    settings.pipeline.model,
  );

  return resultData;
}

function findCentralItems(dataset, settings, similarityFunction) {
  // Group items by clusterNumber
  const clusters = {};
  dataset.forEach((item) => {
    const clusterNumber = item.clusterNumber;
    if (!clusters[clusterNumber]) {
      clusters[clusterNumber] = [];
    }
    clusters[clusterNumber].push(item);
  });

  // Find the central item in each cluster
  Object.keys(clusters).forEach((clusterNumber) => {
    const cluster = clusters[clusterNumber];
    let centralItem = null;
    let maxSimilaritySum = -Infinity;

    cluster.forEach((item) => {
      let similaritySum = 0;

      cluster.forEach((otherItem) => {
        if (item !== otherItem) {
          const itemEmbedding = item.embeddings[settings.pipeline.model];
          const otherItemEmbedding =
            otherItem.embeddings[settings.pipeline.model];
          similaritySum += similarityFunction(
            itemEmbedding,
            otherItemEmbedding,
          );
        }
      });

      if (similaritySum > maxSimilaritySum) {
        maxSimilaritySum = similaritySum;
        centralItem = item;
      }
    });

    if (centralItem) {
      centralItem.central = true;
    }
  });

  return dataset;
}

// runtime.connect ports
let ports = {};
let simcheckInitialized = false;
let simcheckPromiseResolve;
let simcheckPromise = new Promise((resolve) => {
  simcheckPromiseResolve = resolve;
});
// listen for messages, process it, and send the result back.
chrome.runtime.onConnect.addListener(function (port) {
  ports[port.name] = port;
  portConnected = true;
  if (port.name == "simcheck") {
    simcheckInitialized = true;
    simcheckPromiseResolve();
    port.onMessage.addListener(async function (message) {
      switch (message.action) {
        case "restoreHNSW":
          let restoreHNSWresult = await restoreHNSW(message);
          sendMessage({
            type: "loading",
            model: "hnsw restore",
            status: JSON.stringify(restoreHNSWresult),
          });
          break;
        case "generateHNSW":
          await generateHNSW(message);
          sendMessage({
            type: "loading",
            model: "hnsw",
            status: "ready",
          });
          break;
        case "searchHNSW":
          let hnswSerpData = await searchHNSW(message);
          port.postMessage({
            type: "serp",
            result: hnswSerpData,
          });
          break;
        case "processClusterData":
          let clusters = await processClusterData(message.data, sendMessage);
          break;
        case "createNotification":
          createNotification(message.text);
          break;
        case "compareEmbeddings":
          let compareTableData = compareEmbeddings(
            message.obj1,
            message.obj2,
            message.modelName,
          );
          sendMessage({
            type: "serp",
            result: compareTableData,
          });
          break;
        case "ping":
          port.postMessage({
            type: "pong",
          });
          break;
        case "pong":
          // do nothing
          break;
        case "compare":
          let tableData = await compareStores(message);
          sendMessage({
            type: "serp",
            result: tableData,
          });
          break;
        case "getNumberOfTokens":
          let size = await getNumberOfTokens(message.text);
          port.postMessage({
            type: "numberOfTokens",
            size: size,
          });
          break;
        case "getObjectStoreNames":
          try {
            let objectStores = await getObjectStoreNames(
              message.databaseName || settings.databaseName,
            );
            port.postMessage({
              type: "objectStoreNames",
              result: objectStores,
            });
          } catch (error) {
            port.postMessage({
              status: 500,
              statusText: "Internal Server Error",
              error: error,
            });
          }
          break;
        case "download":
          let status = downloadModel(port, message.name);
          break;
        case "search":
          if (settings.pipeline.model.startsWith("openai")) {
            let result = await searchDataOpenAi(message.query);
            port.postMessage({
              type: "serp",
              result: result,
            });
          } else {
            let result = await searchDataHF(message);
            port.postMessage({
              type: "serp",
              result: result,
            });
          }
          break;
        case "data-stored":
          let storedTableData = await getAllData(message.indexedDB);

          if (message.keepEmbeddings) {
            storedTableData = storedTableData.filter(
              (item) => !item?.embeddings?.[settings.pipeline.model],
            );
          }

          if (!storedTableData.length) {
            port.postMessage({
              type: "status",
              status: 404,
              statusText: "no data to embed",
            });
            break;
          }

          // eg "openai/text-embedding-3-small"
          if (settings.pipeline.model.startsWith("openai")) {
            await createOpenAiEmbeddings({
              selectedFields: message.selectedFields,
              key: settings.indexedDB.keyPath,
              docs: storedTableData,
            });
          } else {
            await createEmbeddings({
              selectedFields: message.selectedFields,
              key: settings.indexedDB.keyPath,
              docs: storedTableData,
            });
          }
          break;
        default:
          // not found
          port.postMessage({
            status: 404,
            statusText: "Not Found",
            request: message,
          });
      }
    });
    return;
  }
  port.onDisconnect.addListener(function () {
    portConnected = false;
    console.warn("Port disconnected");
    console.log(port.name);
  });
});
