let settings = {
  pipeline: {
    task: "feature-extraction",
    model: "sentence-transformers/all-MiniLM-L6-v2",
    options: {
      normalize: true,
      quantized: false,
    },
  },
  indexedDB: {
    databaseName: "simcheck",
    tableName: "",
    keyPath: "",
    version: 1,
  },
  openai: {
    key: "",
  },
  hnsw: {
    M: 400,
    efConstruction: 64,
  },
};

async function setSettings(settings) {
  chrome.storage.local.set({ ["settings"]: settings }, async () => {
    if (chrome.runtime.lastError) {
      console.error("Error storing data:", chrome.runtime.lastError);
    }
  });
}

function getSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get("settings", (result) => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
        resolve(settings);
      } else if (result.settings !== undefined) {
        settings = result.settings;
        resolve(result.settings);
      } else {
        setSettings(settings);
        resolve(settings);
      }
    });
  });
}

async function initializeSettings() {
  settings = await getSettings();
}

function handleStorageChange(changes, namespace) {
  for (let [key, { oldValue, newValue }] of Object.entries(changes)) {
    switch (key) {
      case "settings":
        settings = newValue;
        break;
    }
  }
}
chrome.storage.onChanged.addListener(handleStorageChange);

// Initialize settings on load/import
initializeSettings();

export { settings, getSettings, setSettings, initializeSettings };
