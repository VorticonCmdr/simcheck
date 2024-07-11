import "/js/umap-js.min.js";
import * as hclust from "/js/hclust.js";

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
  chrome.storage.local.get("settings", async (result) => {
    if (result.settings !== undefined) {
      settings = result.settings;
    } else {
      setSettings();
    }
  });
}

async function setSettings() {
  chrome.storage.local.set({ ["settings"]: settings }, async () => {
    if (chrome.runtime.lastError) {
      console.error("Error storing data:", chrome.runtime.lastError);
    }
  });
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

async function init() {
  await getSettings();
}
init();
