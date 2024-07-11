let selectedFields = [];
let sortable;
let row1 = {};
let csvData = [];
let filename;
let db;

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
  openai: {
    key: "",
  },
};

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

class PortConnector {
  constructor() {
    this.portName = "simcheck";
    this.port = null;
    this.reconnectDelay = 1000; // Initial reconnect delay in milliseconds
    this.maxReconnectDelay = 30000; // Maximum reconnect delay in milliseconds
    this.connect();
  }

  connect() {
    this.port = chrome.runtime.connect({ name: this.portName });

    // Handle incoming messages
    this.port.onMessage.addListener(this.messageHandler.bind(this));

    // Handle disconnections
    this.port.onDisconnect.addListener(this.handleDisconnect.bind(this));

    // Reset reconnect delay after a successful connection
    this.resetReconnectDelay();
  }

  async messageHandler(message) {
    switch (message.type) {
      case "loading":
        setProgressbar(message);
        break;
      case "storing":
        setProgressbar(message);
        break;
      case "embeddings-stored":
        $("#search").prop("disabled", false);
        break;
      case "serp":
        generateTable(message.result);
        break;
      case "numberOfTokens":
        $("#numberOfTokens").text(`${message.size} tokens`);
        break;
      case "status":
        $("#warning-text").text(message.statusText);
        $("#warning").removeClass("d-none");
        break;
      default:
        console.log(message);
    }
  }

  handleDisconnect() {
    console.log("Disconnected");
    this.port = null;

    // Reconnect with exponential backoff
    setTimeout(() => {
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        this.maxReconnectDelay,
      );
      this.connect();
    }, this.reconnectDelay);
  }

  resetReconnectDelay() {
    this.reconnectDelay = 1000; // Reset to initial delay
  }

  postMessage(message) {
    if (this.port) {
      this.port.postMessage(message);
    } else {
      console.warn("Unable to send message. Port is not connected.");
    }
  }
}
const simcheckPort = new PortConnector();

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

// handle CSV data
const dropArea = document.getElementById("drop-area");
const fileInput = document.getElementById("fileInput");
dropArea.addEventListener("dragover", (event) => {
  event.stopPropagation();
  event.preventDefault();
  // Style the drag-and-drop as a "copy file" operation.
  event.dataTransfer.dropEffect = "copy";
});

dropArea.addEventListener("drop", (event) => {
  event.stopPropagation();
  event.preventDefault();
  const fileList = event.dataTransfer.files;
  readActivities(fileList[0]);
});

fileInput.addEventListener("change", (event) => {
  const fileList = event.target.files;
  readActivities(fileList[0]);
});

function readActivities(file) {
  if (!file) {
    return;
  }

  // Check if the file is an image.
  if (file.type && file.type != "text/csv") {
    console.log("File is not a csv file.", file.type, file);
    return;
  }
  filename = file.name;

  const reader = new FileReader();
  reader.addEventListener("load", (event) => {
    parseCsvData(event.target.result);
  });
  reader.readAsText(file);
}

function parseCsvData(textData) {
  let result = Papa.parse(textData, {
    header: true,
    skipEmptyLines: "greedy",
  });
  //console.log(result);
  setProgressbar({
    status: `rows: ${result.data.length}`,
    name: `errors: ${result.errors.length}`,
  });

  if (result.data.length) {
    row1 = result.data[0];
  } else {
    return;
  }
  csvData = result.data;
  generateTable(csvData);

  let fieldsHtml = result?.meta?.fields.reduce((accumulator, currentValue) => {
    return `${accumulator}\n<option value="${currentValue}">${currentValue}</option>`;
  }, `<option class="fw-bold" selected disabled>select and add fields to combine and embed</option>`);
  $("#embeddingsFields").html(fieldsHtml);

  let idFieldsHtml = result?.meta?.fields.reduce(
    (accumulator, currentValue) => {
      return `${accumulator}\n<option value="${currentValue}">${currentValue}</option>`;
    },
    "<option selected disabled>please select id field</option>",
  );
  $("#idFields").html(idFieldsHtml);
}

function isNumber(value) {
  return !isNaN(value) && typeof value === "number";
}

async function generateTable(dataArray) {
  if (dataArray.length == 0) {
    return;
  }

  let columns = [];
  Object.keys(dataArray[0]).forEach((key, i) => {
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
      pageSize: 10,
      pageList: [10, 100, 1000, "All"],
      pagination: true,
      sortOrder: "desc",
      sortName: "score",
      showColumns: true,
      columns: columns,
      data: dataArray,
    });
}

async function errorMessage(error) {
  $("#warning-text").text(error);
  $("#warning").removeClass("d-none");
}

function getObjectStoreNames() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(settings.indexedDB.databaseName);

    request.onsuccess = (event) => {
      const db = event.target.result;
      settings.indexedDB.version = db.version;
      setSettings();
      const objectStoreNames = Array.from(db.objectStoreNames);
      db.close();
      resolve(objectStoreNames);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

async function handleIndexedDB() {
  let objectStoreNames = await getObjectStoreNames();
  try {
    let objectStores = Array.from(objectStoreNames);
    let html = objectStores
      .map((objectStoreName) => {
        return `<option value="${objectStoreName}"></option>`;
      })
      .join("\n");
    $("#saveTableList").html(html);

    let tableSelectHtml = objectStores
      .map((objectStoreName) => {
        return `<option value="${objectStoreName}">${objectStoreName}</option>`;
      })
      .join("\n");
    $("#tableSelect").html(
      `<option selected disabled>select table to search</option>\n${tableSelectHtml}`,
    );
    $("#compareTable1").html(
      `<option selected disabled>compare this table</option>\n${tableSelectHtml}`,
    );
    $("#compareTable2").html(
      `<option selected disabled>with that table</option>\n${tableSelectHtml}`,
    );
  } catch (error) {
    errorMessage(error);
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      settings.indexedDB.databaseName,
      settings.indexedDB.version + 1,
    );

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // Create the object store if it doesn't exist
      if (!db.objectStoreNames.contains(settings.indexedDB.tableName)) {
        db.createObjectStore(settings.indexedDB.tableName, {
          keyPath: settings.indexedDB.keyPath,
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

async function saveData(db, dataArray, keySet) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [settings.indexedDB.tableName],
      "readwrite",
    );
    let store = transaction.objectStore(settings.indexedDB.tableName);

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
        if (!keySet.has(item[settings.indexedDB.keyPath])) {
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
            name: settings.indexedDB.tableName,
            progress: ((index + 1) / dataArrayLength) * 100,
          });
        };
      });
  });
}

function processSelectedFields(evt) {
  selectedFields = sortable.toArray();
  let exampleText = selectedFields.reduce((accumulator, currentValue) => {
    return `${accumulator}${row1[currentValue]} `;
  }, "");
  $("#exampleText").val(exampleText);
  simcheckPort.postMessage({
    action: "getNumberOfTokens",
    text: exampleText,
  });
}

async function init() {
  await handleIndexedDB();

  sortable = new Sortable(document.getElementById("selectedFields"), {
    animation: 150,
    group: "sortable",
    onSort: processSelectedFields,
  });
  let trashHeap = new Sortable(document.getElementById("trashFields"), {
    animation: 150,
    group: "sortable",
    onAdd: function (/**Event*/ evt) {
      $(evt.item).remove();
    },
  });
  $("#addEmbeddingField").on("click", function () {
    let selectedField = $("#embeddingsFields").val();
    if (!selectedField) {
      return;
    }

    $("#selectedFields").append(
      `<li class="list-group-item d-flex justify-content-between align-items-center" data-id="${selectedField}">${selectedField}<i class="bi bi-grip-vertical text-end"></i></li>`,
    );
    processSelectedFields(null);
  });

  $(document).on("change", "#idFields", function () {
    let value = $(this).val();
    if (!value) {
      return;
    }
    settings.indexedDB.keyPath = value;
  });

  $("#saveTableInput").on("change", async function () {
    let name = $(this).val();
    if (!name) {
      return;
    }
    let db = await openDatabase();
    let result = await getAllData(db, name);
    db.close();
    result = result.map((item) => {
      delete item?.embeddings;
      return item;
    });
    generateTable(result);
  });

  $("#generateEmbeddings").on("click", async function () {
    if (!settings.indexedDB.keyPath) {
      return;
    }

    settings.indexedDB.tableName = $("#saveTableInput").val() || "all";
    await setSettings();

    setProgressbar({
      status: "open table",
      name: settings.indexedDB.tableName,
    });

    let db = await openDatabase();
    let keysSet = new Set(await getAllKeys(db, settings.indexedDB.tableName));

    setProgressbar({
      status: "save table",
      name: settings.indexedDB.tableName,
    });
    let result = await saveData(db, csvData, keysSet);

    simcheckPort.postMessage({
      action: "data-stored",
      indexedDB: settings.indexedDB,
      selectedFields: selectedFields,
    });
  });

  $("#search").on("click", function () {
    let query = $("#query").val().trim();
    if (!query) {
      return;
    }
    simcheckPort.postMessage({ action: "search", text: query });
  });

  $("#compare").on("click", function () {
    let store1 = $("#compareTable1").val();
    let store2 = $("#compareTable2").val();
    if (!store1 || !store2) {
      return;
    }
    simcheckPort.postMessage({
      action: "compare",
      store1: store1,
      store2: store2,
    });
  });

  $(document).on("change", "#tableSelect", async function () {
    let value = $(this).val();
    if (!value) {
      return;
    }
    let tableName = $("#tableSelect").val();
    if (!tableName) {
      return;
    }
    settings.indexedDB.tableName = tableName;
    await setSettings();
  });
}
