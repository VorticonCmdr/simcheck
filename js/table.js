let config = {
  fields: {
    disabled: new Set([
      "center",
      "embeddings",
      "hnsw",
      "clicked",
      "order",
      "coordinates",
      "embeddings2",
      "hnsw2",
      "clusterNumber2",
      "order2",
      "coordinates2",
      "bestMatch-clusterNumber",
      "bestMatch-order",
      "bestMatch-coordinates",
      "bestMatch-embeddings",
    ]),
  },
};

const $dataTable = $("#dataTable");
$dataTable.bootstrapTable({
  deferredRender: true,
  showExport: false,
  pageSize: 100,
  pageList: [10, 100, 1000, "All"],
  pagination: true,
  sortOrder: "desc",
  sortName: "clusterNumber",
  showColumns: true,
  buttons: buttons,
  buttonsClass: "outline-secondary",
});

// Function to dispatch a custom event with data
function pushCustomEvent(eventName, data) {
  const event = new CustomEvent(eventName, { detail: data });
  window.dispatchEvent(event);
}
function buttons() {
  return {
    btnSaveCSV: {
      text: "save csv",
      icon: "bi-filetype-csv text-primary",
      event: function () {
        pushCustomEvent("saveCSV", "");
      },
      attributes: {
        title: "save table data to csv",
      },
    },
    btnSaveJSONL: {
      text: "save jsonl",
      icon: "bi-filetype-raw text-success",
      event: function () {
        pushCustomEvent("saveJSONL", "");
      },
      attributes: {
        title: "save table data to jsonl",
      },
    },
    btnHideColumns: {
      text: "hide all columns",
      icon: "bi-eye-slash",
      event: function () {
        $dataTable.bootstrapTable("hideAllColumns");
      },
      attributes: {
        title: "hides all columns but score",
      },
    },
    btnCompare: {
      text: "compare 2 rows",
      icon: "bi-ui-checks",
      event: function () {
        let rows = $dataTable.bootstrapTable("getSelections");
        if (!rows.length) {
          return;
        }
        if (rows.length > 2) {
          return;
        }
        pushCustomEvent("getSelections", rows);
      },
      attributes: {
        title: "compare 2 rows of embeddings",
      },
    },
  };
}

function isNumber(value) {
  return !isNaN(value) && typeof value === "number";
}

function getTableData() {
  const removeAttributes = (arr, attrsToRemove) => {
    return arr.map((obj) => {
      const newObj = { ...obj };
      attrsToRemove.forEach((attr) => delete newObj[attr]);
      return newObj;
    });
  };

  let tableData = $dataTable.bootstrapTable("getData");

  return removeAttributes(tableData, ["hnsw", "embeddings", "state"]);
}

async function generateTable(dataArray) {
  if (dataArray.length == 0) {
    return;
  }

  let columns = [
    {
      field: "state",
      sortable: false,
      searchable: false,
      checkbox: true,
    },
  ];
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

  $dataTable.bootstrapTable("refreshOptions", {
    columns: columns,
    data: dataArray,
  });
}

// Convert Float32Array to a regular array recursively
function convertTypedArrays(obj) {
  if (obj instanceof Float32Array) {
    return Array.from(obj);
  } else if (Array.isArray(obj)) {
    return obj.map(convertTypedArrays);
  } else if (typeof obj === "object" && obj !== null) {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, convertTypedArrays(v)]),
    );
  } else {
    return obj;
  }
}

function sanitizeFilename(input) {
  // Replace any invalid characters for Windows or macOS with an underscore
  return input
    .replace(/[\/\\?%*:|"<>]/g, "_") // Windows forbidden characters
    .replace(/[\0-\x1F\x80-\x9F]/g, "_") // Control characters
    .replace(/^\.+$/, "_") // Avoid names that are just dots
    .trim(); // Remove any leading or trailing spaces
}

function saveDataAsFile(filename, type, data) {
  const blob = new Blob([data], { type: type });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download(
    {
      url: url,
      filename: sanitizeFilename(filename),
      saveAs: true,
    },
    function (downloadId) {
      if (chrome.runtime.lastError) {
        console.error(`Error: ${chrome.runtime.lastError}`);
      }
      // Revoke the object URL after the download starts
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
  );
}

function stashData(key, value, callback) {
  let data = {};

  data[key] = convertTypedArrays(value);

  chrome.storage.session.set(data, function () {
    if (chrome.runtime.lastError) {
      console.error(`Error: ${JSON.stringify(chrome.runtime.lastError)}`);
    } else {
      console.log("Data stashed successfully.");
      if (callback) callback();
    }
  });
}

export {
  generateTable,
  stashData,
  convertTypedArrays,
  saveDataAsFile,
  getTableData,
};
