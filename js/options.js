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
  return `<a href="https://huggingface.co/${model}" target="_blank">${model}</a>`;
}

async function generateModelsTable() {
  let models = await getCachedOnnx();
  let html = Object.values(models)
    .map((model, i) => {
      return `<tr data-model="${model.name}">
      <td>${linkHuggingface(model.name)}</td>
      <td>${model.quantized}</td>
      <td class="text-end">${formatBytes(model.size)}</td>
      <td class="text-center"><i class="bi bi-plugin text-primary me-1"></i><i class="bi bi-trash text-danger"></i></td>
    </tr>`;
    })
    .join("\n");
  $("#models").html(html);
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

  generateModelsTable();

  $("#download").on("click", function () {
    let name = $("#model-name").val();
    if (!name) {
      return;
    }
    port.postMessage({ action: "download", name: name });
  });

  $(document).on("click", ".bi-plugin", async function () {
    let trElement = $(this).closest("tr");
    let dataModelValue = trElement.data("model");

    settings.pipeline.model = dataModelValue;
    await setSettings();
    location.reload();
  });

  const deleteQuestionModal = new bootstrap.Modal(
    document.getElementById("deleteQuestion"),
    {},
  );
  $(document).on("click", ".bi-trash", async function () {
    let trElement = $(this).closest("tr");
    let dataModelValue = trElement.data("model");
    $("#modelNameForDeletetion").text(dataModelValue);
    $("#reallyDelete").data("model", dataModelValue);
    deleteQuestionModal.show();
  });
  $("#reallyDelete").on("click", function () {
    let model = $("#reallyDelete").data("model");
    deleteCachedRequestsWithPrefix(`https://huggingface.co/${model}`);
    deleteQuestionModal.hide();
  });
}
