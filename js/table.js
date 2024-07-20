let config = {
  fields: {
    disabled: new Set([
      "embeddings",
      "clusterNumber",
      "order",
      "coordinates",
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
});

function isNumber(value) {
  return !isNaN(value) && typeof value === "number";
}

async function generateTable(dataArray) {
  if (dataArray.length == 0) {
    return;
  }

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

  $dataTable.bootstrapTable("refreshOptions", {
    columns: columns,
    data: dataArray,
  });
}

export { generateTable };
