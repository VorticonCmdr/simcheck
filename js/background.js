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
} from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

env.allowRemoteModels = true;
env.allowLocalModels = false;

// Due to a bug in onnxruntime-web, we must disable multithreading for now.
// See https://github.com/microsoft/onnxruntime/issues/14445 for more information.
env.backends.onnx.wasm.numThreads = 1;

let settings = {
  pipeline: {
    task: "feature-extraction",
    model: "nomic-ai/nomic-embed-text-v1.5",
    options: {
      quantized: false,
    },
  },
  indexedDB: {
    databaseName: "simcheck",
    tableName: "all",
    keyPath: "id",
    version: 1,
  },
};

let dataset = {
  key: "",
  docs: {},
  selectedFields: [],
};
async function getSettings() {
  chrome.storage.local.get("settings", async (result) => {
    if (result.settings !== undefined) {
      settings = result.settings;
    } else {
      setSettings();
    }
  });
}
getSettings();

async function setSettings() {
  chrome.storage.local.set({ ["settings"]: settings }, async () => {
    if (chrome.runtime.lastError) {
      console.error("Error storing data:", chrome.runtime.lastError);
    }
  });
}

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

function getObjectStoreNames(databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);

    request.onsuccess = (event) => {
      const db = event.target.result;
      const objectStoreNames = Array.from(db.objectStoreNames);
      resolve(objectStoreNames);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

async function downloadModel(port, name) {
  let instance = await EmbeddingsPipeline.getInstance(
    (x) => {
      // We also add a progress callback to the pipeline so that we can
      // track model downloading.
      x["type"] = "loading";
      port.postMessage(x);
    },
    "feature-extraction",
    name,
    settings.pipeline.options,
  );
  port.postMessage({
    type: "loading",
    status: "download",
    task: "done",
  });
  return true;
}

class EmbeddingsPipeline {
  static instance = null;

  static async getInstance(
    progress_callback = null,
    task = "feature-extraction",
    model = settings.model,
    options = {},
  ) {
    if (this.instance === null) {
      this.instance = pipeline(task, model, {
        progress_callback,
        ...options,
      });
    }

    return this.instance;
  }
}
async function createEmbeddings(data, port) {
  // Create a feature extraction pipeline
  let extractor = await EmbeddingsPipeline.getInstance(
    (x) => {
      // We also add a progress callback to the pipeline so that we can
      // track model loading.
      //self.postMessage(x);
      x["type"] = "loading";
      port.postMessage(x);
    },
    settings.pipeline.task,
    settings.pipeline.model,
    settings.pipeline.options,
  );

  let docsLength = data.docs.length;
  for (let index in data.docs) {
    let text = data.selectedFields.reduce((accumulator, currentValue) => {
      return `${accumulator}${data.docs[index][currentValue]} `;
    }, "");
    let embedding = await extractor(text, {
      pooling: "cls",
    });
    if (!data.docs[index]["embeddings"]) {
      data.docs[index]["embeddings"] = {};
      data.docs[index]["embeddings"][settings.pipeline.model] = embedding.data;
    } else {
      data.docs[index][settings.pipeline.model] = embedding.data;
    }
    let num = parseInt(index);
    let progress = ((num + 1) / docsLength) * 100;
    port.postMessage({
      type: "loading",
      status: "extracting embeddings",
      name: "rows",
      progress: progress,
    });
  }

  const db = await openDatabase();
  await saveData(db, data.docs);

  port.postMessage({
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

async function searchData(text) {
  // Create a feature extraction pipeline
  let extractor = await EmbeddingsPipeline.getInstance(
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

  let embedding = await extractor(text, {
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

async function getModelData(model) {
  let data = await AutoConfig.from_pretrained(model);
  return data;
}

async function getNumberOfTokens(text) {
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
      port.postMessage({
        status: 500,
        statusText: "error opening db",
        error: event.target.error,
      });
      reject(event.target.error);
    };
  });
}

function getAllData(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [settings.indexedDB.tableName],
      "readonly",
    );
    const store = transaction.objectStore(settings.indexedDB.tableName);
    const request = store.getAll();

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      port.postMessage({
        status: 500,
        statusText: "error getting data",
        error: event.target.error,
      });
      reject(event.target.error);
    };
  });
}

async function saveData(db, dataArray) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [settings.indexedDB.tableName],
      "readwrite",
    );
    let store = transaction.objectStore(settings.indexedDB.tableName);

    transaction.oncomplete = () => {
      console.log("save complete");
      resolve();
    };

    transaction.onerror = (event) => {
      reject(event.target.error);
    };

    let dataArrayLength = dataArray.length;
    dataArray.forEach((data, index) => {
      const request = store.put(data);
      request.onerror = (event) => {
        //errorMessage(`Error saving data: ${event.target.error}`);
      };
      request.onsuccess = (event) => {
        /*
        port.postMessage({
          status: "storing",
          name: settings.indexedDB.tableName,
          progress: ((index + 1) / dataArrayLength) * 100,
        });
         */
      };
    });
  });
}

// listen for messages, process it, and send the result back.
chrome.runtime.onConnect.addListener(function (port) {
  if (port.name == "simcheck") {
    port.onMessage.addListener(async function (message) {
      switch (message.action) {
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
          let result = await searchData(message.text);
          port.postMessage({
            type: "serp",
            result: result,
          });
          break;
        case "data-stored":
          settings.indexedDB = message.indexedDB;
          const db = await openDatabase();
          const tableData = await getAllData(db);
          if (!tableData.length) {
            port.postMessage({
              status: 404,
              statusText: "no data to embed",
            });
            break;
          }
          port.postMessage({
            status: 202,
            statusText: "Accepted",
          });
          await createEmbeddings(
            {
              selectedFields: message.selectedFields,
              key: settings.indexedDB.keyPath,
              docs: tableData,
            },
            port,
          );
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
});
