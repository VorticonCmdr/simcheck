import { settings, initializeSettings } from "/js/settings.js";
import { openDatabase, saveData, getAllData } from "/js/indexeddb.js";
import { setProgressbar } from "/js/progress.js";

import "/libs/umap-js.min.js";
import { cos_sim } from "/libs/transformers.min.js";
const invertedCosineSimilarity = (vecA, vecB) => {
  return 1 - cos_sim(vecA, vecB);
};

import { generateTable } from "/js/table.js";

const hclustWorker = new Worker("/js/hclust-worker.js");

// Function to handle messages from the web worker
hclustWorker.onmessage = function (e) {
  const message = e.data;
  switch (message.type) {
    case "clusterData":
      processCluster(message.result);
      break;
    case "progress":
      setProgressbar({
        status: "agglomerative hierarchical clustering",
        name: "data",
        progress: message.progress * 100,
      });
      break;
    default:
      console.log(message);
  }
};

// Function to handle errors from the web worker
hclustWorker.onerror = function (error) {
  console.error("Error in worker:", error);
};

let sortable;
let objectStoresMeta = {};

const $clusterEmbeddings = $("#clusterEmbeddings");

let config = {
  umap: {
    nComponents: 2,
    minDist: 0.1,
    spread: 1.0,
    nNeighbors: 2,
    distanceFn: invertedCosineSimilarity,
  },
  hclust: {
    isEnabled: true,
  },
};

function clusterEmbeddings(objectStores) {
  let data = objectStores.map((objectStoreName) => {
    return {
      databaseName: settings.indexedDB.databaseName,
      tableName: objectStoresMeta[objectStoreName]?.name,
      keyPath: objectStoresMeta[objectStoreName]?.keyPath,
      model: settings.pipeline.model,
    };
  });
  if (config.hclust.isEnabled) {
    hclustWorker.postMessage({
      method: "clusterData",
      data: data,
    });
  } else {
    processCluster({
      request: data,
    });
  }
}

async function loopTables(data) {
  let resultData = [];

  let dataLength = data.length;

  while (dataLength--) {
    let d = data[dataLength];

    settings.indexedDB.tableName = d.tableName;
    let tableData = await getAllData(settings.indexedDB);

    resultData = [...resultData, ...tableData];
  }

  return resultData;
}

async function processCluster(response) {
  let tableData = await loopTables(response.request);
  if (config.hclust.isEnabled) {
    tableData.forEach((row, index) => {
      tableData[index]["clusterNumber"] =
        response?.clusters?.[row[response.request[0].keyPath]]?.[
          "clusterNumber"
        ];
      tableData[index]["order"] =
        response?.clusters?.[row[response.request[0].keyPath]]?.["order"];
    });
  }
  if (!tableData.length) {
    return;
  }

  settings.indexedDB.tableName = response?.request
    ?.map((r) => r.tableName)
    .join("");
  settings.indexedDB.keyPath = response.request[0].keyPath;

  let reducedDimension = await reduceDimension(tableData);
  if (tableData.length == reducedDimension.length) {
    reducedDimension.forEach((coordinates, index) => {
      tableData[index]["coordinates"] = coordinates;
    });
  }

  setProgressbar({
    status: "generating table",
    name: settings.indexedDB.tableName,
  });
  generateTable(tableData);

  setProgressbar({
    status: "save database object store",
    name: settings.indexedDB.tableName,
  });

  // empty keySet because we want to save all
  let keysSet = new Set();

  let result = await saveData(
    settings.indexedDB,
    tableData,
    keysSet,
    setProgressbar,
  );
}

function generateLabels(tableData) {
  // Step 1: Create a frequency map
  const frequencyMap = tableData.reduce((acc, d) => {
    const clusterNumber = d.clusterNumber;
    acc[clusterNumber] = (acc[clusterNumber] || 0) + 1;
    return acc;
  }, {});

  // Step 2: Generate labels and handle single occurrences
  let labels = tableData.map((d) => {
    const clusterNumber = d.clusterNumber;
    return frequencyMap[clusterNumber] === 1 ? -1 : clusterNumber;
  });

  return labels;
}

async function reduceDimension(tableData) {
  let umap = new UMAP(config.umap);
  let data = tableData.map((d) => d.embeddings[settings.pipeline.model]);

  if (config.hclust.isEnabled) {
    let labels = generateLabels(tableData);
    labels.forEach((label, index) => {
      tableData[index].clusterNumber = label;
      delete tableData[index]["order"];
    });
    umap.setSupervisedProjection(labels);
  }

  const nEpochs = umap.initializeFit(data);
  return umap.fitAsync(data, (epochNumber) => {
    // check progress and give user feedback, or return `false` to stop
    setProgressbar({
      status: "projecting data",
      name: `into ${config.umap.nComponents} dimensions`,
      progress: (epochNumber / nEpochs) * 100,
    });
  });
}

function getObjectStoreNamesAndMeta(databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);

    request.onsuccess = (event) => {
      const db = event.target.result;
      const objectStoreNames = Array.from(db.objectStoreNames);
      const sizesPromises = objectStoreNames.map((storeName) =>
        getObjectStoreMeta(db, storeName),
      );

      Promise.all(sizesPromises)
        .then((meta) => {
          const result = objectStoreNames.map((name, index) => ({
            name,
            size: meta[index]["size"],
            keyPath: meta[index]["keyPath"],
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
function getObjectStoreMeta(db, storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const request = store.count();

    request.onsuccess = (event) => {
      resolve({
        size: event.target.result,
        name: store.name,
        keyPath: store.keyPath,
      });
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}
async function generateObjectStoresTable() {
  let objectStoreNamesAndMeta = await getObjectStoreNamesAndMeta(
    settings.indexedDB.databaseName,
  );

  let html = objectStoreNamesAndMeta
    .map((objectStore, i) => {
      objectStoresMeta[objectStore.name] = objectStore;
      return `<option value="${objectStore.name}">${objectStore.name}</option>`;
    })
    .join("\n");
  $("#objectStores").html(html);
}

async function sliderSetup(id) {
  $(`#${id}`).on("change", function () {
    let value = $(this).val();
    if (!value) {
      return;
    }
    $(`#${id}Value`).text(value);
    config.umap[id] = value;
  });
}

async function init() {
  await initializeSettings();

  await generateObjectStoresTable();
  $("#objectStores").select2({
    tags: true,
    allowClear: true,
    placeholder: "select datasets to cluster",
    templateSelection: function (data, container) {
      $(data.element).attr("data-id", data.id);
      return data.text;
    },
  });
  let sortableEl = $(".select2-selection__rendered")[0];
  if (sortableEl) {
    sortable = new Sortable(sortableEl, {
      filter: ".select2-search",
      draggable: ".select2-selection__choice",
      dataIdAttr: "title",
    });
  }
  $clusterEmbeddings.text(`start clustering ${settings.pipeline.model}`);
  $clusterEmbeddings.on("click", function () {
    let objectStores = sortable.toArray();
    if (!objectStores.length) {
      return;
    }
    clusterEmbeddings(objectStores);
  });

  $("#hclustCheckEnabled").on("change", function () {
    let isChecked = $(this).is(":checked");
    config.hclust.isEnabled = isChecked;
  });

  sliderSetup("nNeighbors");
  sliderSetup("spread");
  sliderSetup("minDist");
}
init();
