let selectedFields = new Set();
let row1 = {};
let csvData = [];
let filename;
let idField;

// handle incoming messages
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  //console.log(message);
  // Respond to the background script
  sendResponse({ response: "Message received" });

  switch (message.type) {
    case "loading":
      //console.log("loading");
      setProgressbar(message);
      break;
    case "embeddings-stored":
      $("#search").prop("disabled", false);
      break;
    default:
      console.log(message);
  }

  // return true to indicate we will send a response asynchronously
  // see https://stackoverflow.com/a/46628145 for more information
  return true;
});

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

function storeLargeData(data, callback) {
  const key = "largeData";
  chrome.storage.local.set({ [key]: data }, () => {
    if (chrome.runtime.lastError) {
      console.error("Error storing data:", chrome.runtime.lastError);
    } else {
      callback(key);
    }
  });
}

// Example usage
const largeData = "..."; // Replace with your large data
/*

*/

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

function init() {
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
  });

  $(document).on("change", "input[name='idField']", function () {
    let value = $(this).val();
    if (!value) {
      return;
    }
    idField = value;
  });

  $("#generateEmbeddings").on("click", function () {
    let key = filename;
    let data = {};
    if (!idField) {
      return;
    }
    csvData.forEach((row) => {
      data[row[idField]] = row;
    });
    chrome.storage.local.set({ [key]: data }, () => {
      if (chrome.runtime.lastError) {
        console.error("Error storing data:", chrome.runtime.lastError);
      } else {
        chrome.runtime.sendMessage(
          { action: "data-stored", key, selectedFields: [...selectedFields] },
          (response) => {
            console.log(response);
          },
        );
      }
    });

    $("#search").on("click", function () {
      let query = $("#query").val();
      chrome.runtime.sendMessage(
        { action: "search", text: query },
        (response) => {
          if (response.result) {
            console.log(response.result);
          }
        },
      );
    });

    /*
    //let embeddingTexts = createEmbeddingTexts(csvData);
    storeLargeData(csvData, (key) => {
      chrome.runtime.sendMessage({ action: "data-stored", key }, (response) => {
        console.log(response);
      });
    });
    */
  });
}
init();
