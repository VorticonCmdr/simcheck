// open the interface when clicking on icon
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create(
    { url: chrome.runtime.getURL("/html/import.html") },
    function (tab) {},
  );
});

import {
  AutoTokenizer,
  AutoConfig,
  pipeline,
  layer_norm,
  env,
  cos_sim,
} from "/js/transformers.min.js";

env.allowRemoteModels = true;
env.allowLocalModels = false;

// Due to a bug in onnxruntime-web, we must disable multithreading for now.
// See https://github.com/microsoft/onnxruntime/issues/14445 for more information.
env.backends.onnx.wasm.numThreads = 1;

import { getSettings, setSettings } from "/js/settings.js";
let settings;

function handleStorageChange(changes, namespace) {
  for (let [key, { oldValue, newValue }] of Object.entries(changes)) {
    switch (key) {
      case "settings":
        settings = newValue;
        break;
    }
  }
}
chrome.storage.onChanged.addListener(handleStorageChange);

async function init() {
  settings = await getSettings();
  chrome.alarms.onAlarm.addListener((alarm) => {
    console.log(`alarm: ${alarm.name}`);
  });
}
init();

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
    ports["simcheck"].postMessage({
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
      ports["simcheck"].postMessage(x);
    },
    "feature-extraction",
    name,
    settings.pipeline.options,
  );
  ports["simcheck"].postMessage({
    type: "loading",
    status: "download",
    task: "done",
  });
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

async function createEmbeddings(data) {
  let docsLength = data.docs.length;
  let embeddingsExtractor = await EmbeddingsPipeline.getInstance(
    (x) => {
      x["type"] = "loading";
      ports["simcheck"].postMessage(x);
    },
    settings.pipeline.task,
    settings.pipeline.model,
    settings.pipeline.options,
  );
  await chrome.alarms.create("createEmbeddings", {
    periodInMinutes: 0.5,
  });
  for (let index in data.docs) {
    let text = data.selectedFields.reduce((accumulator, currentValue) => {
      return `${accumulator}${data.docs[index][currentValue]} `;
    }, "");
    let embedding = await embeddingsExtractor(text, {
      normalize: true,
      pooling: "cls",
    });

    if (!data.docs[index]["embeddings"]) {
      data.docs[index]["embeddings"] = {};
    }
    data.docs[index]["embeddings"][settings.pipeline.model] = embedding.data;

    let num = parseInt(index);
    let progress = ((num + 1) / docsLength) * 100;
    ports["simcheck"].postMessage({
      type: "loading",
      status: "extracting embeddings",
      name: "rows",
      progress: progress,
    });
  }
  chrome.alarms.clear("createEmbeddings", function () {
    console.log("alarm cleared");
  });

  const db = await openDatabase();
  await saveData(db, data.docs);

  ports["simcheck"].postMessage({
    type: "embeddings-stored",
    status: "embeddings stored",
    task: "done",
  });
}

async function getEmbeddingsBatch(texts) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.openai.key}`,
    },
    body: JSON.stringify({
      model: settings.pipeline.model.replace("openai/", ""),
      input: texts,
    }),
  });

  if (!response.ok) {
    ports["simcheck"].postMessage({
      status: 500,
      statusText: "error calling the openAI embeddings api",
      error: response.statusText,
    });
    return [];
    //throw new Error(`Error: ${response.statusText}`);
  }

  const data = await response.json();
  return data;
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

  ports["simcheck"].postMessage({
    type: "loading",
    status: "data from openAI api",
  });

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const embeddingsResponse = await getEmbeddingsBatch(batch);
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
        embeddingsResponse.data[embeddingsResponseIndex].embedding;
    }
  }

  const db = await openDatabase();
  await saveData(db, data.docs);

  ports["simcheck"].postMessage({
    type: "embeddings-stored",
    status: "embeddings stored",
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

  const db = await openDatabase();
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
          //scoreList.push(doc);
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

async function searchDataHF(text) {
  // Create a feature extraction pipeline
  let searchExtractor = await EmbeddingsPipeline.getInstance(
    (x) => {
      // We also add a progress callback to the pipeline so that we can
      // track model loading.
      //self.postMessage(x);
      x["type"] = "loading";
    },
    settings.pipeline.task,
    settings.pipeline.model,
    settings.pipeline.options,
  );

  let embedding = await searchExtractor(text, {
    pooling: "cls",
  });
  const queryVector = embedding.data;
  const queryVectorLength = queryVector.length;

  const db = await openDatabase();
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

async function getModelData(model) {
  let data = await AutoConfig.from_pretrained(model);
  return data;
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

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      settings.indexedDB.databaseName,
      settings.indexedDB.version,
    );

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(settings.indexedDB.tableName)) {
        db.createObjectStore(settings.indexedDB.tableName, {
          keyPath: settings.indexedDB.keyPath,
        });
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      ports["simcheck"].postMessage({
        status: 500,
        statusText: "error opening db",
        error: event.target.error,
      });
      reject(event.target.error);
    };
  });
}

async function getAllData(db, tableName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([tableName], "readonly");
    const objectStore = transaction.objectStore(tableName);
    //const request = objectStore.getAll();
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
      ports["simcheck"].postMessage({
        status: 500,
        statusText: "error getting data",
        error: event.target.error,
      });
      reject(event.target.error);
    };
  });
}

async function saveData(db, docs) {
  return new Promise((resolve, reject) => {
    const store = db
      .transaction([settings.indexedDB.tableName], "readwrite")
      .objectStore(settings.indexedDB.tableName);

    ports["simcheck"].postMessage({
      type: "loading",
      status: "adding data",
    });

    /*
    docs.forEach((data) => {
      store.put(data);
    });
    */

    let pending = docs.length;
    docs.forEach((doc) => {
      const request = store.put(doc);
      request.onsuccess = () => {
        pending -= 1;
        if (pending === 0) {
          db.close();
          resolve();
        }
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });

    ports["simcheck"].postMessage({
      type: "loading",
      status: "save complete",
    });

    /*
    store.oncomplete = () => {
      db.close();
      resolve();
    };
     */

    store.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

function compareArrays(array1, array2, key) {
  const result = [];
  let array1Length = array1.length;
  let pos1 = 1;

  for (let obj1 of array1) {
    let maxSimilarity = -1;
    let bestMatch = null;

    let progress = (pos1 / array1Length) * 100;
    ports["simcheck"].postMessage({
      type: "loading",
      status: "comparing embeddings",
      name: "rows",
      progress: progress,
    });
    pos1++;

    for (let obj2 of array2) {
      const vec1 = obj1?.["embeddings"]?.[key];
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

    let res = obj1;

    res["score"] = parseFloat(maxSimilarity.toFixed(3));
    Object.keys(bestMatch).forEach((key) => {
      if (key == "embeddings") {
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

  const db = await openDatabase();
  const array1 = await getAllData(db, message.store1);
  const array2 = await getAllData(db, message.store2);

  if (!array1?.length || !array2.length) {
    console.log("datastore empty");
    return [];
  }
  resultData = compareArrays(array1, array2, settings.pipeline.model);
  db.close();
  return resultData;
}

// runtime.connect ports
let ports = {};
// listen for messages, process it, and send the result back.
chrome.runtime.onConnect.addListener(function (port) {
  ports[port.name] = port;
  if (port.name == "simcheck") {
    port.onMessage.addListener(async function (message) {
      switch (message.action) {
        case "ping":
          port.postMessage({
            type: "pong",
          });
          break;
        case "pong":
          // do nothing
          break;
        case "compare":
          let tableDate = await compareStores(message);
          port.postMessage({
            type: "serp",
            result: tableDate,
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
            let result = await searchDataOpenAi(message.text);
            port.postMessage({
              type: "serp",
              result: result,
            });
          } else {
            let result = await searchDataHF(message.text);
            port.postMessage({
              type: "serp",
              result: result,
            });
          }
          break;
        case "data-stored":
          settings.indexedDB = message.indexedDB;
          const db = await openDatabase();
          const tableData = (
            await getAllData(db, settings.indexedDB.tableName)
          ).filter((item) => !item?.embeddings?.[settings.pipeline.model]);
          db.close();
          if (!tableData.length) {
            port.postMessage({
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
              docs: tableData,
            });
          } else {
            await createEmbeddings({
              selectedFields: message.selectedFields,
              key: settings.indexedDB.keyPath,
              docs: tableData,
            });
          }
          break;
        default:
          // not found
          port.postMessage({
            status: 404,
            statusText: "Not Found",
          });
      }
    });
    return;
  }
  port.onDisconnect.addListener(function () {
    console.warn("Port disconnected");
  });
});
