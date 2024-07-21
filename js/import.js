import { settings, getSettings, setSettings } from "/js/settings.js";
import { openDatabase, getAllKeys, saveData } from "/js/indexeddb.js";
import { setProgressbar } from "/js/progress.js";

let selectedFields = [];
let sortable;
let row1 = {};
let csvData = [];
let db;
let textPrefix = "";

const $embeddingsFields = $("#embeddingsFields");
const $generateEmbeddings = $("#generateEmbeddings");

import { generateTable } from "/js/table.js";

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
      console.log(result.lastMessage);
      messageHandler(result.lastMessage);
      chrome.storage.local.remove("lastMessage", () => {
        if (chrome.runtime.lastError) {
          console.error('Error deleting message:', chrome.runtime.lastError.message);
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

async function errorMessage(error) {
  $("#warning-text").text(error);
  $("#warning").removeClass("d-none");
}

async function handleIndexedDB() {
  let db = await openDatabase(settings.indexedDB, true);
  let objectStoreNames = [...db.objectStoreNames];
  db.close();

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
        return `<option value="${objectStoreName}" ${settings.indexedDB.tableName == objectStoreName ? "selected" : ""}>${objectStoreName}</option>`;
      })
      .join("\n");
    $("#tableSelect").html(
      `<option selected disabled>select table to search</option>\n${tableSelectHtml}`,
    );

    let compareTableSelectHtml = objectStores
      .map((objectStoreName) => {
        return `<option value="${objectStoreName}">${objectStoreName}</option>`;
      })
      .join("\n");
    $("#compareTable1").html(
      `<option selected disabled>compare this table</option>\n${compareTableSelectHtml}`,
    );
    $("#compareTable2").html(
      `<option selected disabled>with that table</option>\n${compareTableSelectHtml}`,
    );
  } catch (error) {
    errorMessage(error);
  }
}

async function getAllData(db, tableName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([tableName], "readonly");
    const objectStore = transaction.objectStore(tableName);
    settings.indexedDB.keyPath = objectStore.keyPath;
    $("#idFields").html(
      `<option selected disabled value="${settings.indexedDB.keyPath}">${settings.indexedDB.keyPath}</option>`,
    );
    const request = objectStore.openCursor();

    let docs = [];
    request.onsuccess = (event) => {
      const cursor = event.target.result;

      function processCursor(cursor) {
        if (cursor) {
          docs.push(cursor.value);
          cursor.continue();
        } else {
          if (docs?.length) {
            row1 = docs[0];
            let fieldsHtml = Object.keys(row1)
              .filter((name) => name != "embeddings")
              .reduce((accumulator, currentValue) => {
                return `${accumulator}\n<option data-id="${currentValue}" value="${currentValue}">${currentValue}</option>`;
              }, ``);
            $embeddingsFields.html(fieldsHtml);
          }
          //resolve(event.target.result);
          resolve(docs);
        }
      }

      processCursor(cursor);
    };

    request.onerror = (event) => {
      simcheckPort.postMessage({
        status: 500,
        statusText: "error getting data",
        error: event.target.error,
      });
      reject(event.target.error);
    };
  });
}

function processSelectedFields(evt) {
  textPrefix = $("#textPrefix").val()?.trim();

  selectedFields = sortable.toArray();
  let exampleText = selectedFields.reduce((accumulator, currentValue) => {
    return `${accumulator}${row1[currentValue]} `;
  }, `${textPrefix} `);
  $("#exampleText").val(exampleText?.trim());
  simcheckPort.postMessage({
    action: "getNumberOfTokens",
    text: exampleText,
  });
}

async function init() {
  await handleIndexedDB();

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
    let db = await openDatabase(settings.indexedDB, true);
    try {
      let result = await getAllData(db, name);
      db.close();
      result = result.map((item) => {
        delete item?.embeddings;
        return item;
      });
      generateTable(result);
    } catch (error) {
      db.close();
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
