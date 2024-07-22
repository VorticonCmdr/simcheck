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
        if (cursor) {
          resolve(cursor.value); // Resolve with the first entry's value
        } else {
          resolve(null); // No entries in the object store
        }
      };

      cursorRequest.onerror = (event) => {
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
  return openDatabase(settings, true)
    .then((db) => {
      const currentVersion = db.version;
      db.close();

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
  let db = await openDatabase(settings, true);
  settings.version = db.version;
  db.close();
  return openDatabase(settings, false)
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
  return new Promise(async (resolve, reject) => {
    let db = await openDatabase(settings, true);
    settings.version = db.version;
    db.close();

    db = await openDatabase(settings, false);
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
        const request = store.put(data);
        request.onerror = (event) => {
          //errorMessage(`Error saving data: ${event.target.error}`);
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
    throw new Error(`Failed to open database: ${error.message}`);
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
    throw new Error(`Failed to open database: ${error.message}`);
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
  getAllData,
  getFilteredData,
};
