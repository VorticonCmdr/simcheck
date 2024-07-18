import "/js/umap-js.min.js";
import { cos_sim } from "/js/transformers.min.js";
const invertedCosineSimilarity = (vecA, vecB) => {
  return 1 - cos_sim(vecA, vecB);
};

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
        status: "clustering",
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

import { getSettings, setSettings } from "/js/settings.js";
let settings;

let config = {
  fields: {
    disabled: new Set(["embeddings", "clusterNumber", "order", "coordinates"]),
  },
  umap: {
    nComponents: 2,
    minDist: 0.1,
    spread: 1.0,
    nNeighbors: 15,
    distanceFn: invertedCosineSimilarity,
  },
  hclust: {
    isEnabled: true,
  },
};

const $progress = $("#progress");

/*
change progress bar based on message
string message.status
string message.name
float message.progress between 0 and 100
*/
async function setProgressbar(message) {
  if (message.status && message.name && message.progress) {
    $progress
      .css("width", `${message.progress}%`)
      .text(
        `${message?.status} ${message?.name} ${message?.progress.toFixed(1)}%`,
      );
  } else if (message.status && message.name) {
    $progress.css("width", `100%`);
    $progress.text(`${message?.status} ${message?.name}`);
  } else if (message.status && message.task) {
    $progress.css("width", `100%`);
    $progress.text(`${message?.status} ${message?.task}`);
  } else {
    $progress.css("width", `100%`);
    $progress.text(`${message?.status}`);
  }
}

function openDatabase(nextVersion, tableName, keyPath) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      settings.indexedDB.databaseName,
      nextVersion,
    );

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
      settings.indexedDB.version = db.version;
      resolve(db);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

async function getAllData(db, tableName) {
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

function getAllKeys(db, storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const request = store.getAllKeys();

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}
async function saveData(db, dataArray, keySet, tableName, keyPath) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([tableName], "readwrite");
    let store = transaction.objectStore(tableName);

    transaction.oncomplete = () => {
      setProgressbar({
        status: "storing",
        name: "complete",
      });
      resolve();
    };

    transaction.onerror = (event) => {
      reject(event.target.error);
    };

    let dataArrayLength = 0;
    dataArray
      .filter((item) => {
        if (!keySet.has(item[keyPath])) {
          dataArrayLength++;
          return true;
        }
      })
      .forEach((data, index) => {
        const request = store.put(data);
        request.onerror = (event) => {
          errorMessage(`Error saving data: ${event.target.error}`);
        };
        request.onsuccess = (event) => {
          setProgressbar({
            status: "storing",
            name: tableName,
            progress: ((index + 1) / dataArrayLength) * 100,
          });
        };
      });
  });
}

function isNumber(value) {
  return !isNaN(value) && typeof value === "number";
}

async function generateTable(dataArray) {
  if (dataArray.length == 0) {
    return;
  }
  setProgressbar({
    status: "loading",
    name: "table",
  });

  let columns = [];
  Object.keys(dataArray[0])
    .filter((key) => !config.fields.disabled.has(key))
    .forEach((key, i) => {
      columns.push({
        field: key,
        title: key,
        sortable: true,
        searchable: false,
        align: isNumber(dataArray[0][key]) ? "right" : "left",
      });
    });

  $("#dataTable")
    .bootstrapTable("destroy")
    .bootstrapTable({
      showExport: true,
      exportTypes: ["csv"],
      exportDataType: "all",
      pageSize: 100,
      pageList: [10, 100, 1000, "All"],
      pagination: true,
      sortOrder: "desc",
      sortName: "clusterNumber",
      showColumns: true,
      columns: columns,
      data: dataArray,
    });
}

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
    let db = await openDatabase();
    settings.indexedDB.version = db.version;
    let tableData = await getAllData(db, d.tableName);
    await db.close();
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

  let tableName = response.request.map((r) => r.tableName).join("");
  let keyPath = response.request[0].keyPath;

  setProgressbar({
    status: "generating table",
    name: tableName,
  });
  generateTable(tableData);
  let reducedDimension = await reduceDimension(tableData);
  if (tableData.length == reducedDimension.length) {
    reducedDimension.forEach((coordinates, index) => {
      tableData[index]["coordinates"] = coordinates;
    });
  }

  setProgressbar({
    status: "open database objectStore",
    name: tableName,
  });
  let db = await openDatabase(
    settings.indexedDB.version + 1,
    tableName,
    keyPath,
  );
  await db.close();
  db = await openDatabase(settings.indexedDB.version + 1, tableName, keyPath);

  setProgressbar({
    status: "save database object store",
    name: tableName,
  });

  // empty keySet because we want to save all
  let keysSet = new Set();
  let result = await saveData(db, tableData, keysSet, tableName, keyPath);
  db.close();
}

async function reduceDimension(tableData) {
  let umap = new UMAP(config.umap);
  let data = tableData.map((d) => d.embeddings[settings.pipeline.model]);
  let labels = tableData.map((d) => d.order);
  if (config.hclust.isEnabled) {
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
  settings = await getSettings();

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
