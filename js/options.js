import { settings, setSettings, initializeSettings } from "/js/settings.js";
import {
  getAllData,
  getObjectStoreNamesAndSizes,
  deleteObjectStore,
  firstEntry,
} from "/js/indexeddb.js";
import { setProgressbar } from "/js/progress.js";
import { handleDownload } from "/js/download.js";

import "/js/filedrop.js";

import { PortConnector } from "/js/messages.js";
const simcheckPort = new PortConnector({
  customMessageHandler: messageHandler,
});

async function messageHandler(message) {
  switch (message.type) {
    case "loading":
      if (message.task == "done") {
        window.location.reload();
      }
      setProgressbar(message);
      break;
    default:
    //console.log(message);
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
      let classes = "";
      if (model.name == settings.pipeline.model) {
        classes = "table-primary";
      }
      return `<tr data-model="${model.name}" class="${classes}">
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

async function generateObjectStoresTable() {
  let objectStoreNamesAndSizes = await getObjectStoreNamesAndSizes(
    settings.indexedDB,
  );

  let html = objectStoreNamesAndSizes
    .map((objectStore, i) => {
      let classes = "";
      if (objectStore.name == settings.indexedDB.tableName) {
        classes = "table-primary";
      }
      return `<tr data-name="${objectStore.name}" class="${classes}">
      <td class="d-flex justify-content-between p-2">
        <details class="flex-fill">
          <summary>${objectStore.name}</summary>
          <ul id="${sanitizeForQuerySelector(objectStore.name)}List" class="list-group list-group-flush"></ul>
        </details>
        <div class="">${objectStore.size.toLocaleString()}</div>
        <div class="w-25 text-end"><i class="bi bi-database-down text-primary me-2"></i><i class="bi bi-trash text-danger"></i></div>
      </td>
    </tr>`;
    })
    .join("\n");
  $("#objectStores").html(html);

  objectStoreNamesAndSizes.forEach(async (objectStore, i) => {
    let entry = await firstEntry(settings.indexedDB.databaseName, objectStore.name);
    if (!entry.embeddings) {
      return;
    }
    let html = Object.entries(entry.embeddings)
      .map(([modelName, value]) => {
        return `<li class="list-group-item bg-transparent d-flex justify-content-between p-2"><div>${modelName}</div><div>${value?.length} dims</div></li>`;
      }).join("\n");
    $(`#${sanitizeForQuerySelector(objectStore.name)}List`).html(html);
  });
}

function sanitizeForQuerySelector(url) {
  // Define a regex to match valid characters for querySelector
  let validChars = /[a-zA-Z0-9_-]/g;

  // Filter the characters
  let sanitizedString = url.match(validChars).join("");

  return sanitizedString;
}

async function init() {
  await initializeSettings();

  $("#openaiKey").val(settings.openai.key);
  $("#openaiKeyBtn").on("click", async function () {
    settings.openai.key = $("#openaiKey").val().trim();
    if (!settings.openai.key) {
      $("#openaiKey").addClass("border-danger border-2");
      return;
    }

    await setSettings(settings);
    $("#openaiKey").addClass("border-success border-2");
  });

  generateModelsTable();

  generateObjectStoresTable();

  /*
  $("#model-name").on("change", async function () {
    let modelName = $(this).val()?.trim();
    if (!modelName?.length) {
      return;
    }
    let response = await fetch(
      `https://huggingface.co/api/models/${modelName}`,
    );
    if (response.status != 200) {
      return;
    }
    let result = await response.json();
    let siblings = result?.siblings?.filter((sibling) =>
      sibling.rfilename.match("onnx"),
    );
    if (!siblings) {
      return;
    }
  });
  */
  $("#download").on("click", function () {
    let name = $("#model-name").val();
    if (!name) {
      return;
    }
    simcheckPort.postMessage({ action: "download", name: name });
  });

  $(document).on("click", "#modelsTable .bi-plugin", async function () {
    let trElement = $(this).closest("tr");
    let dataModelValue = trElement.data("model");

    settings.pipeline.model = dataModelValue;
    await setSettings(settings);
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
  $("#reallyDeleteModel").on("click", function () {
    let model = $("#reallyDeleteModel").data("model");
    deleteCachedRequestsWithPrefix(`https://huggingface.co/${model}`);
    deleteModelQuestionModal.hide();
    location.reload();
  });

  const deleteObjectStoreQuestionModal = new bootstrap.Modal(
    document.getElementById("deleteObjectStoreQuestion"),
    {},
  );
  $(document).on("click", "#objectStoresTable .bi-database-down", async function () {
    let trElement = $(this).closest("tr");
    let objectStoreName = trElement.data("name");
    let objectStoreData = await getAllData({
      databaseName: settings.indexedDB.databaseName,
      tableName: objectStoreName,
      keyPath: settings.indexedDB.keyPath,
      version: settings.indexedDB.version,
    });
    await handleDownload(objectStoreData, objectStoreName);
  });
  $(document).on("click", "#objectStoresTable .bi-trash", async function () {
    let trElement = $(this).closest("tr");
    let dataObjectStoreName = trElement.data("name");
    $("#objectStoreNameForDeletetion").text(dataObjectStoreName);
    $("#reallyDeleteObjectStore").data("name", dataObjectStoreName);
    deleteObjectStoreQuestionModal.show();
  });
  $(document).on("click", "#reallyDeleteObjectStore", async function () {
    let objectStoreName = $("#reallyDeleteObjectStore").data("name");
    settings.indexedDB.version = await deleteObjectStore({
      databaseName: settings.indexedDB.databaseName,
      tableName: objectStoreName,
      keyPath: settings.indexedDB.keyPath,
      version: settings.indexedDB.version,
    });
    await setSettings();
    console.log(settings);
    deleteObjectStoreQuestionModal.hide();
    location.reload();
  });

  $.fn.toggleAttribute = function (attr, val1, val2) {
    return this.each(function () {
      var $this = $(this);
      if ($this.attr(attr) === val1) {
        $this.attr(attr, val2);
      } else {
        $this.attr(attr, val1);
      }
    });
  };
  $("#eye").on("click", function () {
    $(this).toggleClass(["bi-eye-slash", "bi-eye"]);
    $("#openaiKey").toggleAttribute("type", "password", "text");
  });

  chrome.notifications.getPermissionLevel((level) => {
    $("#permissionCheckDisabled").val(level == "granted" ? "on" : "off");
    $("#permissionText").text(level);
  });
}
init();
