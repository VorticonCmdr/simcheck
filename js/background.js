// open the interface when clicking on icon
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create(
    { url: chrome.runtime.getURL("/html/import.html") },
    function (tab) {},
  );
});

import {
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

async function getCacheStorageSize() {
  const cacheNames = await caches.keys();
  let totalSize = 0;

  for (const cacheName of cacheNames) {
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();

    for (const request of requests) {
      const response = await cache.match(request);
      if (response) {
        const blob = await response.blob();
        totalSize += blob.size;
      }
    }
  }

  return totalSize;
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
async function createEmbeddings(data) {
  // Create a feature extraction pipeline
  let extractor = await EmbeddingsPipeline.getInstance(
    (x) => {
      // We also add a progress callback to the pipeline so that we can
      // track model loading.
      //self.postMessage(x);
      x["type"] = "loading";
      chrome.tabs.sendMessage(data.tabId, x, function (response) {
        //console.log('Response from the tab:', response);
      });
    },
    settings.pipeline.task,
    settings.pipeline.model,
    settings.pipeline.options,
  );

  let docIds = Object.keys(data.docs);
  let docsLength = docIds.length;
  for (let index in docIds) {
    let id = docIds[index];

    let text = data.selectedFields.reduce((accumulator, currentValue) => {
      return `${accumulator}${data.docs[id][currentValue]} `;
    }, "");

    let embedding = await extractor(text, {
      pooling: "cls",
    });
    data.docs[id][settings.pipeline.model] = Array.from(embedding.data);
    chrome.tabs.sendMessage(
      data.tabId,
      {
        type: "loading",
        status: "extracting embeddings",
        name: "rows",
        progress: (index / docsLength) * 100,
      },
      function (response) {
        //console.log('Response from the tab:', response);
      },
    );
  }

  chrome.storage.local.set({ [dataset.key]: data.docs }, () => {
    if (chrome.runtime.lastError) {
      console.error("Error storing data:", chrome.runtime.lastError);
    } else {
      dataset.docs = data.docs;
      chrome.runtime.sendMessage(
        { type: "embeddings-stored", key: dataset.key },
        (response) => {
          console.log(response);
        },
      );
    }
  });

  chrome.tabs.sendMessage(
    data.tabId,
    {
      type: "loading",
      status: "embedding",
      task: "done",
    },
    function (response) {
      //console.log('Response from the tab:', response);
    },
  );

  /*
  const matryoshka_dim = 768;
  embeddings = layer_norm(embeddings, [embeddings.dims[1]])
    .slice(null, [0, matryoshka_dim])
    .normalize(2, -1);
  */

  /*
  console.log(embeddings.tolist());

  // Compute similarity scores
  const [source_embeddings, ...document_embeddings] = embeddings.tolist();
  const similarities = document_embeddings.map((x) =>
    cos_sim(source_embeddings, x),
  );
  console.log(similarities);
  */
}

async function searchData(sendResponse, text) {
  // Create a feature extraction pipeline
  let extractor = await EmbeddingsPipeline.getInstance(
    (x) => {
      // We also add a progress callback to the pipeline so that we can
      // track model loading.
      //self.postMessage(x);
      x["type"] = "loading";
      chrome.tabs.sendMessage(data.tabId, x, function (response) {
        //console.log('Response from the tab:', response);
      });
    },
    settings.pipeline.task,
    settings.pipeline.model,
    settings.pipeline.options,
  );

  let embedding = await extractor(text, {
    pooling: "cls",
  });
  let searchVector = Array.from(embedding.data);

  let scoreList = [];
  Object.keys(dataset.docs).forEach((key) => {
    let datasetVector = dataset.docs[key][settings.pipeline.model];
    let score = cos_sim(datasetVector, searchVector);
    let result = dataset.docs[key];
    result["score"] = score;
    scoreList.push(result);
  });

  sendResponse({
    status: 200,
    statusText: "OK",
    result: scoreList,
  });
}

async function getModelData(model) {
  let data = await AutoConfig.from_pretrained(model);
  return data;
}

// listen for messages, process it, and send the result back.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(message);

  switch (message.action) {
    case "search":
      let result = searchData(sendResponse, message.text);
      break;
    case "data-stored":
      dataset.key = message.key;
      dataset.selectedFields = message.selectedFields;

      chrome.storage.local.get(dataset.key, async (result) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            status: 500,
            statusText: "Internal Server Error",
            error: chrome.runtime.lastError,
          });
        } else {
          sendResponse({
            status: 202,
            statusText: "Accepted",
            error: null,
          });

          // Process data
          await createEmbeddings({
            selectedFields: dataset.selectedFields,
            key: dataset.key,
            docs: result[dataset.key],
            tabId: sender.tab.id,
          });

          // clean up storage
          //chrome.storage.local.remove(key);
        }
      });
      break;
    default:
      //
      sendResponse({
        status: 404,
        statusText: "Not Found",
      });
  }

  // return true to indicate we will send a response asynchronously
  // see https://stackoverflow.com/a/46628145 for more information
  return true;
});
