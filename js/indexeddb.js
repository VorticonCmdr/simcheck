const getObjectStoreNamesAndMeta = ({ databaseName = "simcheck" }) => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);

    request.onsuccess = (event) => {
      const db = event.target.result;
      const objectStoreNames = Array.from(db.objectStoreNames);
      const sizesPromises = objectStoreNames.map((storeName) =>
        getObjectStoreMeta(db, storeName),
      );

      Promise.all(sizesPromises)
        .then((result) => {
          db.close();
          resolve(result);
        })
        .catch((error) => {
          db.close();
          reject(error);
        });
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
};
function getObjectStoreMeta(db, storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const request = store.count();

    request.onsuccess = (event) => {
      resolve({
        size: event.target.result,
        name: store.name,
        keyPath: store.keyPath,
      });
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

const firstEntry = async ({ databaseName = "simcheck" }, objectStoreName) => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);

    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction(objectStoreName, "readonly");
      const objectStore = transaction.objectStore(objectStoreName);

      const cursorRequest = objectStore.openCursor();

      cursorRequest.onsuccess = (event) => {
        const cursor = event.target.result;
        db.close();
        if (cursor) {
          resolve(cursor.value); // Resolve with the first entry's value
        } else {
          resolve(null); // No entries in the object store
        }
      };

      cursorRequest.onerror = (event) => {
        db.close();
        reject(event.target.error);
      };
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
};

function openDatabase(settings, readonly) {
  return new Promise((resolve, reject) => {
    // Write-mode opens always request settings.version + 1, even if nothing
    // about the schema actually changed: it's what makes onupgradeneeded fire
    // so we can lazily create the object store if it's still missing. Callers
    // that need a write-mode connection should go through openForWrite below
    // rather than reading settings.version themselves, since it's only ever
    // meaningful immediately after a fresh readonly probe.
    const request = indexedDB.open(
      settings.databaseName,
      readonly ? undefined : settings.version + 1,
    );

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // Create the object store if it doesn't exist
      if (!db.objectStoreNames.contains(settings.tableName)) {
        db.createObjectStore(settings.tableName, {
          keyPath: settings.keyPath,
        });
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      resolve(db);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

async function getCurrentDbVersion(settings) {
  const db = await openDatabase(settings, true);
  const version = db.version;
  db.close();
  return version;
}

// Refreshes settings.version from the live database immediately before
// opening write-mode, so the version+1 request in openDatabase is never
// based on a stale/never-persisted number. Use this instead of hand-rolling
// the read-then-reopen dance at each call site.
async function openForWrite(settings) {
  settings.version = await getCurrentDbVersion(settings);
  return openDatabase(settings, false);
}

function getDBkeypath(databaseName, tableName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, undefined);

    request.onsuccess = (event) => {
      const db = event.target.result;
      let transaction = db.transaction(tableName);
      let objectStore = transaction.objectStore(tableName);
      db.close();
      resolve(objectStore.keyPath);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

function getObjectStoreNamesAndSizes(settings) {
  return openDatabase(settings, true)
    .then((db) => {
      const objectStoreNames = Array.from(db.objectStoreNames);
      const sizesPromises = objectStoreNames.map((storeName) =>
        getObjectStoreSize(db, storeName),
      );

      return Promise.all(sizesPromises).then((sizes) => {
        const result = objectStoreNames.map((name, index) => ({
          name,
          size: sizes[index],
        }));
        db.close();
        return result;
      });
    })
    .catch((error) => {
      throw error;
    });
}
function getObjectStoreSize(db, storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const request = store.count();

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

function deleteObjectStore(settings) {
  return getCurrentDbVersion(settings)
    .then((currentVersion) => {
      settings.version = currentVersion + 1;
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(settings.databaseName, settings.version);

        request.onupgradeneeded = (event) => {
          const upgradeDb = event.target.result;
          if (upgradeDb.objectStoreNames.contains(settings.tableName)) {
            upgradeDb.deleteObjectStore(settings.tableName);
            console.log(`Object store '${settings.tableName}' deleted.`);
          }
        };

        request.onsuccess = (event) => {
          const upgradeDb = event.target.result;
          resolve(upgradeDb);
        };

        request.onerror = (event) => {
          reject(event.target.error);
        };
      });
    })
    .then((db) => {
      let version = db.version;
      db.close();
      return version;
    })
    .catch((error) => {
      throw error;
    });
}

async function getAllKeys(settings) {
  return openForWrite(settings)
    .then((db) => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(settings.tableName, "readonly");
        const store = transaction.objectStore(settings.tableName);
        const request = store.getAllKeys();

        request.onsuccess = (event) => {
          resolve(event.target.result);
          db.close();
        };

        request.onerror = (event) => {
          reject(event.target.error);
          db.close();
        };
      });
    })
    .catch((error) => {
      throw error;
    });
}

async function saveData(settings, dataArray, keySet, progressFunction) {
  const db = await openForWrite(settings);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([settings.tableName], "readwrite");
    let store = transaction.objectStore(settings.tableName);

    transaction.oncomplete = () => {
      progressFunction({
        type: "storing",
        status: "storing",
        name: "complete",
        finished: true,
      });
      db.close();
      resolve();
    };

    transaction.onerror = (event) => {
      db.close();
      reject(event.target.error);
    };

    let dataArrayLength = 0;
    dataArray
      .filter((item) => {
        if (!keySet.has(item[settings.keyPath])) {
          dataArrayLength++;
          return true;
        }
      })
      .forEach((data, index) => {
        const request = store.put(data);
        request.onerror = (event) => {
          // Without this, an unhandled per-request error aborts the whole
          // transaction (per the IndexedDB spec) instead of just skipping
          // this one record, which defeats the point of iterating row by row.
          event.preventDefault();
          console.log(`Error saving data: ${event.target.error}`);
        };
        request.onsuccess = (event) => {
          progressFunction({
            type: "storing",
            status: "storing",
            name: settings.tableName,
            progress: ((index + 1) / dataArrayLength) * 100,
          });
        };
      });
  });
}

async function addData(settings, dataArray, keySet, progressFunction) {
  const db = await openForWrite(settings);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([settings.tableName], "readwrite");
    let store = transaction.objectStore(settings.tableName);

    transaction.oncomplete = () => {
      progressFunction({
        type: "storing",
        status: "storing",
        name: "complete",
        finished: true,
      });
      resolve();
    };

    transaction.onerror = (event) => {
      reject(event.target.error);
    };

    let dataArrayLength = 0;
    dataArray
      .filter((item) => {
        if (!keySet.has(item[settings.keyPath])) {
          dataArrayLength++;
          return true;
        }
      })
      .forEach((data, index) => {
        const request = store.add(data);
        request.onerror = (event) => {
          // See saveData's identical handler: without preventDefault() this
          // aborts the whole transaction instead of skipping this one record.
          event.preventDefault();
          console.log(`Error saving data: ${event.target.error}`);
        };
        request.onsuccess = (event) => {
          progressFunction({
            type: "storing",
            status: "storing",
            name: settings.tableName,
            progress: ((index + 1) / dataArrayLength) * 100,
          });
        };
      });
    db.close();
  });
}

async function getFilteredData(settings, keyPathSet) {
  try {
    const db = await openDatabase(settings, true);
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([settings.tableName], "readonly");
      const objectStore = transaction.objectStore(settings.tableName);
      const request = objectStore.openCursor();

      let docs = [];
      request.onsuccess = (event) => {
        const cursor = event.target.result;

        function processCursor(cursor) {
          if (cursor) {
            if (keyPathSet.has(cursor.value[cursor?.source?.keyPath])) {
              docs.push(cursor.value);
            }
            cursor.continue();
          } else {
            db.close();
            resolve(docs);
          }
        }

        processCursor(cursor);
      };

      request.onerror = (event) => {
        db.close();
        reject(event.target.error);
      };
    });
  } catch (error) {
    throw new Error(`Failed to open database: ${error.message}`, {
      cause: error,
    });
  }
}

async function getAllData(settings) {
  try {
    const db = await openDatabase(settings, true);
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([settings.tableName], "readonly");
      const objectStore = transaction.objectStore(settings.tableName);
      const request = objectStore.openCursor();

      let docs = [];
      request.onsuccess = (event) => {
        const cursor = event.target.result;

        function processCursor(cursor) {
          if (cursor) {
            docs.push(cursor.value);
            cursor.continue();
          } else {
            db.close();
            resolve(docs);
          }
        }

        processCursor(cursor);
      };

      request.onerror = (event) => {
        db.close();
        reject(event.target.error);
      };
    });
  } catch (error) {
    throw new Error(`Failed to open database: ${error.message}`, {
      cause: error,
    });
  }
}

export {
  getObjectStoreNamesAndMeta,
  firstEntry,
  openDatabase,
  getObjectStoreNamesAndSizes,
  deleteObjectStore,
  getAllKeys,
  saveData,
  addData,
  getAllData,
  getFilteredData,
  getDBkeypath,
};
