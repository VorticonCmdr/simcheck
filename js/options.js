let port = chrome.runtime.connect({ name: "simcheck" });
// handle incoming messages
port.onMessage.addListener(function (message) {
  switch (message.type) {
    case "loading":
      if (message.task == "done") {
        window.location.reload();
      }
      setProgressbar(message);
      break;
    default:
      console.log(message);
  }
});

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
  },
  openai: {
    key: "",
  },
};

/*
change progress bar based on message
string message.status
string message.name
float message.progress between 0 and 100
*/
function setProgressbar(message) {
  if (message.status && message.name && message.progress) {
    $("#progress")
      .css("width", `${message.progress}%`)
      .text(
        `${message?.status} ${message?.name} ${message?.progress.toFixed(1)}%`,
      );
  } else if (message.status && message.name) {
    $("#progress").css("width", `100%`);
    $("#progress").text(`${message?.status} ${message?.name}`);
  } else if (message.status && message.task) {
    $("#progress").css("width", `100%`);
    $("#progress").text(`${message?.status} ${message?.task}`);
  } else {
    $("#progress").css("width", `100%`);
    $("#progress").text(`${message?.status}`);
  }
}

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

function extractFilename(url) {
  // Create a URL object
  const urlObj = new URL(url);
  // Extract the pathname and split by '/'
  const parts = urlObj.pathname.split("/");
  // Return the last part which is the filename
  return parts.pop();
}

async function deleteCachedRequestsWithPrefix(prefix) {
  const cache = await caches.open("transformers-cache");
  const requests = await cache.keys();

  // Loop through each request
  for (const request of requests) {
    // Check if the request URL starts with the specified prefix
    if (request.url.startsWith(prefix)) {
      // Delete the request if it matches the prefix
      await cache.delete(request);
    }
  }

  location.reload();
}

async function getCachedOnnx() {
  const cache = await caches.open("transformers-cache");
  const requests = await cache.keys();

  const extractKey = (url) => url.match(/huggingface\.co\/([^\/]+\/[^\/]+)/)[1];

  const aggregated = await requests.reduce(async (accPromise, request) => {
    const acc = await accPromise;
    const key = extractKey(request.url);
    if (!acc[key]) {
      acc[key] = { name: key, size: 0, quantized: "" };
    }

    let filename = extractFilename(request.url);
    switch (filename) {
      case "model.onnx":
        acc[key]["quantized"] = "false";
        break;
      case "model_quantized.onnx":
        acc[key]["quantized"] = "true";
        break;
      default:
        acc[key]["quantized"] = "";
    }

    const response = await cache.match(request);
    if (response) {
      const blob = await response.blob();
      acc[key].size += blob.size;
    }
    return acc;
  }, Promise.resolve({}));

  aggregated["openai/text-embedding-3-small"] = {
    name: "openai/text-embedding-3-small",
    size: 0,
    quantized: "false",
  };

  return aggregated;
}

function formatBytes(bytes) {
  if (!bytes) {
    return "-";
  }
  const KB = 1024;
  const MB = KB * 1024;

  if (bytes >= MB) {
    return (bytes / MB).toFixed(2) + " MBytes";
  } else if (bytes >= KB) {
    return (bytes / KB).toFixed(2) + " KBytes";
  } else {
    return bytes + " Bytes";
  }
}

function linkHuggingface(model) {
  if (model.startsWith("openai")) {
    return `<a href="https://platform.openai.com/docs/api-reference/embeddings" target="_blank">${model}</a>`;
  } else {
    return `<a href="https://huggingface.co/${model}" target="_blank">${model}</a>`;
  }
}

async function generateModelsTable() {
  let models = await getCachedOnnx();
  let html = Object.values(models)
    .map((model, i) => {
      return `<tr data-model="${model.name}">
      <td>${linkHuggingface(model.name)}</td>
      <td>${model.quantized}</td>
      <td class="text-end">${formatBytes(model.size)}</td>
      <td class="text-center"><i class="bi bi-plugin text-primary me-1"></i></td>
      <td class="text-center"><i class="bi bi-trash text-danger"></i></td>
    </tr>`;
    })
    .join("\n");
  $("#models").html(html);
}

function getObjectStoreNamesAndSizes(databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);

    request.onsuccess = (event) => {
      const db = event.target.result;
      const objectStoreNames = Array.from(db.objectStoreNames);
      const sizesPromises = objectStoreNames.map((storeName) =>
        getObjectStoreSize(db, storeName),
      );

      Promise.all(sizesPromises)
        .then((sizes) => {
          const result = objectStoreNames.map((name, index) => ({
            name,
            size: sizes[index],
          }));
          db.close();
          resolve(result);
        })
        .catch((error) => {
          db.close();
          reject(error);
        });
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}
function getObjectStoreSize(db, storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const request = store.count();

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}
async function generateObjectStoresTable() {
  let objectStoreNamesAndSizes = await getObjectStoreNamesAndSizes(
    settings.indexedDB.databaseName,
  );

  let html = objectStoreNamesAndSizes
    .map((objectStore, i) => {
      return `<tr data-name="${objectStore.name}">
      <td>${objectStore.name}</td>
      <td class="text-end">${objectStore.size.toLocaleString()}</td>
      <td class="text-end"><i class="bi bi-trash text-danger"></i></td>
    </tr>`;
    })
    .join("\n");
  $("#objectStores").html(html);
}
function deleteObjectStore(databaseName, storeName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);

    request.onsuccess = (event) => {
      const db = event.target.result;
      const version = db.version + 1; // Increment the version
      db.close();

      // Open the database with the new version
      const versionRequest = indexedDB.open(databaseName, version);

      versionRequest.onupgradeneeded = (event) => {
        const upgradeDb = event.target.result;
        if (upgradeDb.objectStoreNames.contains(storeName)) {
          upgradeDb.deleteObjectStore(storeName);
          console.log(`Object store '${storeName}' deleted.`);
        }
      };

      versionRequest.onsuccess = (event) => {
        event.target.result.close();
        resolve(`Object store '${storeName}' deleted.`);
      };

      versionRequest.onerror = (event) => {
        reject(event.target.error);
      };
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

async function getSettings() {
  chrome.storage.local.get("settings", (result) => {
    if (result.settings !== undefined) {
      settings = result.settings;
    }
    init();
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

async function init() {
  $("#selectedModel").html(linkHuggingface(settings.pipeline.model));
  $("#openaiKey").val(settings.openai.key);
  $("#openaiKeyBtn").on("click", async function () {
    settings.openai.key = $("#openaiKey").val().trim();
    console.log(settings.openai.key);
    if (!settings.openai.key) {
      $("#openaiKey").addClass("border-danger border-2");
      return;
    }
    await setSettings();
    $("#openaiKey").addClass("border-success border-2");
  });

  generateModelsTable();

  generateObjectStoresTable();

  $("#download").on("click", function () {
    let name = $("#model-name").val();
    if (!name) {
      return;
    }
    port.postMessage({ action: "download", name: name });
  });

  $(document).on("click", "#modelsTable .bi-plugin", async function () {
    let trElement = $(this).closest("tr");
    let dataModelValue = trElement.data("model");

    settings.pipeline.model = dataModelValue;
    await setSettings();
    location.reload();
  });

  const deleteModelQuestionModal = new bootstrap.Modal(
    document.getElementById("deleteModelQuestion"),
    {},
  );
  $(document).on("click", "#modelsTable .bi-trash", async function () {
    let trElement = $(this).closest("tr");
    let dataModelValue = trElement.data("model");
    $("#modelNameForDeletetion").text(dataModelValue);
    $("#reallyDeleteModel").data("model", dataModelValue);
    deleteModelQuestionModal.show();
  });
  $("#reallyDelete").on("click", function () {
    let model = $("#reallyDeleteModel").data("model");
    deleteCachedRequestsWithPrefix(`https://huggingface.co/${model}`);
    deleteModelQuestionModal.hide();
    location.reload();
  });

  const deleteObjectStoreQuestionModal = new bootstrap.Modal(
    document.getElementById("deleteObjectStoreQuestion"),
    {},
  );
  $(document).on("click", "#objectStoresTable .bi-trash", async function () {
    let trElement = $(this).closest("tr");
    let dataObjectStoreName = trElement.data("name");
    $("#objectStoreNameForDeletetion").text(dataObjectStoreName);
    $("#reallyDeleteObjectStore").data("name", dataObjectStoreName);
    deleteObjectStoreQuestionModal.show();
  });
  $("#reallyDeleteObjectStore").on("click", function () {
    let objectStoreName = $("#reallyDeleteObjectStore").data("name");
    deleteObjectStore(settings.indexedDB.databaseName, objectStoreName);
    deleteObjectStoreQuestionModal.hide();
    location.reload();
  });
}
