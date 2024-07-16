export const getObjectStoreNamesAndMeta = ({ databaseName = "simcheck" }) => {
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
