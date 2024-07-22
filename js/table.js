let config = {
  fields: {
    disabled: new Set([
      "embeddings",
      "clusterNumber",
      "order",
      "coordinates",
      "embeddings2",
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
  showExport: true,
  exportTypes: ["csv"],
  exportDataType: "all",
  pageSize: 100,
  pageList: [10, 100, 1000, "All"],
  pagination: true,
  sortOrder: "desc",
  sortName: "clusterNumber",
  showColumns: true,
  buttons: buttons,
});

// Function to dispatch a custom event with data
function pushCustomEvent(eventName, data) {
  const event = new CustomEvent(eventName, { detail: data });
  window.dispatchEvent(event);
}
function buttons() {
  return {
    btnAdd: {
      text: "compare rows",
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
        title: "Add a new row to the table",
      },
    },
  };
}

function isNumber(value) {
  return !isNaN(value) && typeof value === "number";
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

export { generateTable };
