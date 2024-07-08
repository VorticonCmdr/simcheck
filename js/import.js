let selectedFields = new Set();
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

function connect() {
  let port = chrome.runtime.connect({ name: "simcheck" });
  // handle incoming messages
  port.onMessage.addListener(messageHandler);

  // Handle disconnections
  port.onDisconnect.addListener(function () {
    console.log("Disconnected");
    setTimeout(connect, 1000); // Attempt to reconnect after 1 second
  });

  return port;
}

// Establish initial connection
let port = connect();

function messageHandler(message) {
  switch (message.type) {
    case "loading":
      setProgressbar(message);
      break;
    case "embeddings-stored":
      $("#search").prop("disabled", false);
      break;
    case "serp":
      generateTable(message.result);
      break;
    case "numberOfTokens":
      $("#numberOfTokens").text(message.size);
      break;
    case "status":
      $("#warning-text").text(message.statusText);
      $("#warning").removeClass("d-none");
      break;
    default:
      console.log(message);
  }
}

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

  selectedFields.clear();
  let fieldsHtml = result?.meta?.fields.map((field) => {
    let checkbox = `<div class="form-check">
      <input class="form-check-input embedText" type="checkbox" value="${field}" id="flexCheck${field}">
        <label class="form-check-label w-100" for="flexCheck${field}">
          ${field}
        </label>
      </div>`;
    return checkbox;
  });
  $("#fields").html(fieldsHtml);

  let idFieldsHtml = result?.meta?.fields.map((field) => {
    let checkbox = `<div class="form-check">
      <input class="form-check-input" type="radio" name="idField" id="flexRadio${field}" value="${field}">
      <label class="form-check-label w-100" for="flexRadio${field}">
        ${field}
      </label>
    </div>`;
    return checkbox;
  });
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
      pageSize: 100,
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
      const objectStoreNames = Array.from(db.objectStoreNames);
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

    let tableSelectHtml = `<option value="" selected>select table...</option>`;
    objectStores.forEach((objectStoreName) => {
      tableSelectHtml += `<option value="${objectStoreName}">${objectStoreName}</option>`;
    });
    $("#tableSelect").html(tableSelectHtml);
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

async function init() {
  await handleIndexedDB();

  $(document).on("change", ".embedText", function () {
    let value = $(this).val();
    if (!value) {
      return;
    }
    if ($(this).is(":checked")) {
      selectedFields.add(value);
    } else {
      selectedFields.delete(value);
    }
    let exampleText = [...selectedFields].reduce(
      (accumulator, currentValue) => {
        return `${accumulator}${row1[currentValue]} `;
      },
      "",
    );
    $("#exampleText").text(exampleText);
    port.postMessage({
      action: "getNumberOfTokens",
      text: exampleText,
    });
  });

  $(document).on("change", "input[name='idField']", function () {
    let value = $(this).val();
    if (!value) {
      return;
    }
    settings.indexedDB.keyPath = value;
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

    performance.mark("db-started");
    let db = await openDatabase();
    performance.mark("db-ended");
    const dbMeasure = performance.measure(
      "db-duration",
      "db-started",
      "db-ended",
    );
    console.log(dbMeasure.duration);

    setProgressbar({
      status: "save table",
      name: settings.indexedDB.tableName,
    });
    await saveData(db, csvData);

    port.postMessage({
      action: "data-stored",
      indexedDB: settings.indexedDB,
      selectedFields: [...selectedFields],
    });
  });

  $("#search").on("click", function () {
    let query = $("#query").val().trim();
    if (!query) {
      return;
    }
    port.postMessage({ action: "search", text: query });
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
