import { settings, initializeSettings } from "/js/settings.js";
import { addData } from "/js/indexeddb.js";
import { setProgressbar } from "/js/progress.js";

let dataToImport = null;

async function init() {
  await initializeSettings();

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
    readActivities(fileList);
  });

  fileInput.addEventListener("change", (event) => {
    const fileList = event.target.files;
    readActivities(fileList);
  });

  $(document).on("change", "#idFields", function () {
    let value = $(this).val();
    if (!value) {
      return;
    }
    settings.indexedDB.keyPath = value;
  });

  $("#importButton").on("click", function () {
    if (!dataToImport) {
      return;
    }
    console.log(settings.indexedDB);
    saveImportToStore(dataToImport);
  });
}
init();

async function readActivities(fileList) {
  if (!fileList) {
    return;
  }

  [...fileList].forEach(async (file, index) => {
    let objectStoreName = file.name?.split(".")?.[0];
    if (!objectStoreName) {
      return;
    }
    settings.indexedDB.tableName = objectStoreName;

    let data = await processFile(file);
    if (!data) {
      return;
    }

    dataToImport = parseAndConvertString(data);
    if (!dataToImport || !dataToImport[0]) {
      return;
    }

    let keys = Object.keys(dataToImport[0]);
    if (!keys.length) {
      return;
    }

    let idFieldsHtml = keys.reduce(
      (accumulator, currentValue) => {
        return `${accumulator}\n<option value="${currentValue}">${currentValue}</option>`;
      },
      "<option selected disabled>please select id field</option>",
    );
    $("#idFields").html(idFieldsHtml);
  });
}

async function saveImportToStore(dataToImport) {
  let keysSet = new Set();
  setProgressbar({
    status: "save table",
    name: settings.indexedDB.tableName,
  });
  await addData(
    settings.indexedDB,
    dataToImport,
    keysSet,
    setProgressbar,
  );
  location.reload();
}

async function processFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // Check if the file is gzipped by looking at the magic number
    const isGzipped = uint8Array[0] === 0x1f && uint8Array[1] === 0x8b;

    if (isGzipped) {
        // If gzipped, decompress using the DecompressionStream API
        const ds = new DecompressionStream('gzip');

        // Create a readable stream from the Uint8Array
        const readableStream = new ReadableStream({
            start(controller) {
                controller.enqueue(uint8Array);
                controller.close();
            }
        });

        const decompressedStream = readableStream.pipeThrough(ds);
        const decompressedArrayBuffer = await new Response(decompressedStream).arrayBuffer();
        const decompressedText = new TextDecoder().decode(decompressedArrayBuffer);
        return decompressedText;
    } else {
        // If not gzipped, convert the array buffer directly to string
        const text = new TextDecoder().decode(arrayBuffer);
        return text;
    }
}

function parseAndConvertString(jsonString) {
    const parsedArray = JSON.parse(jsonString);

    function convertToFloat32Arrays(obj) {
        if (Array.isArray(obj)) {
            return new Float32Array(obj);
        } else if (typeof obj === 'object' && obj !== null) {
            return Object.fromEntries(Object.entries(obj).map(
                ([key, value]) => [key, convertToFloat32Arrays(value)]
            ));
        } else {
            return obj;
        }
    }

    return parsedArray.map(obj => {
        if (obj.embeddings && typeof obj.embeddings === 'object') {
            obj.embeddings = convertToFloat32Arrays(obj.embeddings);
        }
        return obj;
    });
}
