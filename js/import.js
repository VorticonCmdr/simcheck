import { settings, getSettings, setSettings } from "/js/settings.js";
import {
  getAllKeys,
  getObjectStoreNamesAndMeta,
  getAllData,
  saveData,
  getFilteredData,
  firstEntry,
} from "/js/indexeddb.js";
import { setProgressbar } from "/js/progress.js";

let selectedFields = [];
let sortable;
let row1 = {};
let csvData = [];
let db;
let textPrefix = "";

const $embeddingsFields = $("#embeddingsFields");
const $generateEmbeddings = $("#generateEmbeddings");

import {
  generateTable,
  saveDataAsFile,
  convertTypedArrays,
  getTableData,
} from "/js/table.js";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message === "keepalive") {
    //console.log("Keep-alive message received");
  }
});

import { PortConnector } from "/js/messages.js";
const simcheckPort = new PortConnector({
  customMessageHandler: messageHandler,
});

chrome.storage.local.get("lastMessage", (result) => {
  if (!chrome.runtime.lastError) {
    if (result.lastMessage !== undefined) {
      messageHandler(result.lastMessage);
      chrome.storage.local.remove("lastMessage", () => {
        if (chrome.runtime.lastError) {
          console.error(
            "Error deleting message:",
            chrome.runtime.lastError.message,
          );
        }
      });
    }
  }
});

async function messageHandler(message) {
  if (message.old) {
    switch (message.type) {
      case "loading":
        setProgressbar(message);
        simcheckPort.postMessage({ action: "pong" });
        break;
      case "storing":
        setProgressbar(message);
        break;
    }
    return;
  }
  switch (message.type) {
    case "pong":
      //console.log("pong");
      break;
    case "loading":
      setProgressbar(message);
      simcheckPort.postMessage({ action: "pong" });
      break;
    case "storing":
      setProgressbar(message);
      break;
    case "embeddings-stored":
      setProgressbar(message);
      break;
    case "serp":
      //let serpData = await getSerpData(message.result);
      generateTable(message.result);
      break;
    case "numberOfTokens":
      $("#numberOfTokens").text(`${message.size} tokens`);
      break;
    case "status":
      errorMessage(message.statusText);
      break;
    default:
      console.log(message);
  }
}

async function getSerpData(data) {
  let keyPaths = data.map((d) => d.id);
  if (!keyPaths.length) {
    return;
  }
  let keyPathSet = new Set(keyPaths);
  let results = await getFilteredData(settings.indexedDB, keyPathSet);
  if (!results.length) {
    return;
  }
  return results;
}

// Function to handle the custom event
async function handleGetSelections(event) {
  const data = event.detail;
  let keyPaths = data.map((d) => d[settings.indexedDB.keyPath]);
  if (!keyPaths.length) {
    return;
  }
  let keyPathSet = new Set(keyPaths);
  let results = await getFilteredData(settings.indexedDB, keyPathSet);
  if (!results.length || results.length !== 2) {
    return;
  }

  if (!results[0]?.["embeddings"]?.[settings.pipeline.model]) {
    return;
  }
  if (!results[1]?.["embeddings"]?.[settings.pipeline.model]) {
    return;
  }
  results[0]["embeddings"][settings.pipeline.model] = Array.from(
    results[0]["embeddings"][settings.pipeline.model],
  );
  results[1]["embeddings"][settings.pipeline.model] = Array.from(
    results[1]["embeddings"][settings.pipeline.model],
  );

  simcheckPort.postMessage({
    action: "compareEmbeddings",
    obj1: results[0],
    obj2: results[1],
    modelName: settings.pipeline.model,
  });
}
function handleSaveCSV(event) {
  csvData = getTableData();
  let csv = Papa.unparse(csvData);
  let filename = `${settings.indexedDB.tableName || "data"}.csv`;
  saveDataAsFile(filename, "text/csv", csv);
}
function arrayToJsonl(array) {
  return array.reduce((jsonl, item) => {
    return jsonl + JSON.stringify(item) + "\n";
  }, "");
}
function handleSaveJSONL(event) {
  csvData = getTableData();
  const convertedDataArray = convertTypedArrays(csvData);
  const jsonlString = arrayToJsonl(convertedDataArray);
  let filename = `${settings.indexedDB.tableName || "data"}.jsonl`;
  saveDataAsFile(filename, "text/jsonl", jsonlString);
}
// Listen for the custom event
window.addEventListener("getSelections", handleGetSelections);
window.addEventListener("saveCSV", handleSaveCSV);
window.addEventListener("saveJSONL", handleSaveJSONL);

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
  //let filename = file.name;

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
    return `${accumulator}\n<option data-id="${currentValue}" value="${currentValue}">${currentValue}</option>`;
  }, ``);
  $embeddingsFields.html(fieldsHtml);

  let idFieldsHtml = result?.meta?.fields.reduce(
    (accumulator, currentValue) => {
      return `${accumulator}\n<option value="${currentValue}">${currentValue}</option>`;
    },
    "<option selected disabled>please select id field</option>",
  );
  $("#idFields").html(idFieldsHtml);
}

const warningToast = document.getElementById("warningToast");
async function errorMessage(error) {
  const warningToastBootstrap =
    bootstrap.Toast.getOrCreateInstance(warningToast);
  $("#warning-text").text(error);
  warningToastBootstrap.show();
}

async function handleIndexedDB() {
  let objectStores = await getObjectStoreNamesAndMeta(settings.indexedDB);

  let html = objectStores
    .map((objectStore) => {
      return `<option value="${objectStore.name}" data-keypath="${objectStore.keyPath}"></option>`;
    })
    .join("\n");
  $("#saveTableList").html(html);

  let tableSelectHtml = objectStores
    .map((objectStore) => {
      return `<option value="${objectStore.name}" ${settings.indexedDB.tableName == objectStore.name ? "selected" : ""}>${objectStore.name}</option>`;
    })
    .join("\n");
  $("#tableSelect").html(
    `<option selected disabled>select table to search</option>\n${tableSelectHtml}`,
  );

  let compareTableSelectHtml = objectStores
    .map((objectStore) => {
      return `<option value="${objectStore.name}">${objectStore.name}</option>`;
    })
    .join("\n");
  $("#compareTable1").html(
    `<option selected disabled>compare this table</option>\n${compareTableSelectHtml}`,
  );
  $("#compareTable2").html(
    `<option selected disabled>with that table</option>\n${compareTableSelectHtml}`,
  );
}

function processSelectedFields(evt) {
  //textPrefix = $("#textPrefix").val()?.trim();

  selectedFields = sortable.toArray();
  let exampleText = selectedFields.reduce((accumulator, currentValue) => {
    return `${accumulator}${row1[currentValue]} `;
  }, "");
  $("#exampleText").val(exampleText?.trim());
  simcheckPort.postMessage({
    action: "getNumberOfTokens",
    text: exampleText,
  });
}

async function init() {
  await handleIndexedDB();

  $("#generateHNSW").on("click", function () {
    simcheckPort.postMessage({
      action: "generateHNSW",
      indexedDB: settings.indexedDB,
      pipeline: settings.pipeline,
    });
  });

  $(document).on("change", "#idFields", function () {
    let value = $(this).val();
    if (!value) {
      return;
    }
    settings.indexedDB.keyPath = value;
  });

  $("#saveTableInput").on("input", async function () {
    const input = $(this);
    const listId = input.attr("list");
    const inputValue = input.val();
    const option = $(`#${listId} option[value="${inputValue}"]`);

    if (option.length > 0) {
      let keypath = option.data("keypath");
      settings.indexedDB.keyPath = keypath;
      let idFieldsHtml = `<option value="${keypath}">${keypath}</option>`;
      $("#idFields").html(idFieldsHtml);

      row1 = await firstEntry(settings.indexedDB.databaseName, inputValue);

      let fieldsHtml = Object.keys(row1).reduce((accumulator, currentValue) => {
        return `${accumulator}\n<option data-id="${currentValue}" value="${currentValue}">${currentValue}</option>`;
      }, ``);
      $embeddingsFields.html(fieldsHtml);
    }
  });
  $("#saveTableInput").on("change", async function () {
    let name = $(this).val();
    if (!name) {
      return;
    }

    settings.indexedDB.tableName = name;
    let objectStores = await getObjectStoreNamesAndMeta(settings.indexedDB);
    if (objectStores.some((store) => store.name === name)) {
      let result = await getAllData(settings.indexedDB);
      if (result[0]?.hnsw?.[settings.pipeline.model]) {
        simcheckPort.postMessage({
          action: "restoreHNSW",
          indexedDB: settings.indexedDB,
          pipeline: settings.pipeline,
        });
        $("#generateHNSW")
          .removeClass("btn-primary")
          .addClass("btn-outline-success");
      } else {
        $("#generateHNSW")
          .removeClass("btn-outline-success")
          .addClass("btn-primary");
      }
      generateTable(result);
    }
  });

  $generateEmbeddings.text(`start embedding ${settings.pipeline.model}`);

  $generateEmbeddings.on("click", async function () {
    if (!settings.indexedDB.keyPath) {
      errorMessage("object store id not set");
      return;
    }

    let tableName = $("#saveTableInput").val()?.trim();
    if (!tableName) {
      errorMessage("object store name not set");
      return;
    }
    settings.indexedDB.tableName = tableName;
    await setSettings(settings);

    setProgressbar({
      status: "open table",
      name: settings.indexedDB.tableName,
    });

    let keysSet = new Set(await getAllKeys(settings.indexedDB));

    setProgressbar({
      status: "save table",
      name: settings.indexedDB.tableName,
    });
    let result = await saveData(
      settings.indexedDB,
      csvData,
      keysSet,
      setProgressbar,
    );

    let isChecked = $("#keepEmbeddings").is(":checked");
    simcheckPort.postMessage({
      action: "data-stored",
      indexedDB: settings.indexedDB,
      selectedFields: selectedFields,
      keepEmbeddings: isChecked,
    });
  });

  $("#search").on("click", function () {
    let query = $("#query").val().trim();
    if (!query) {
      return;
    }
    simcheckPort.postMessage({ action: "search", query, settings });
    //simcheckPort.postMessage({ action: "searchHNSW", settings, query });
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
    await setSettings(settings);
  });

  $embeddingsFields
    .select2({
      tags: true,
      allowClear: true,
      placeholder: "select text fields for embedding",
      templateSelection: function (data, container) {
        $(data.element).attr("data-id", data.id);
        return data.text;
      },
    })
    .on("change", function (evt) {
      processSelectedFields(evt);
    });

  let sortableEl = $(".select2-selection__rendered")[0];
  if (sortableEl) {
    sortable = new Sortable(sortableEl, {
      filter: ".select2-search",
      draggable: ".select2-selection__choice",
      dataIdAttr: "title",
      onSort: function (evt) {
        processSelectedFields(evt);
      },
    });
  }
}
init();
