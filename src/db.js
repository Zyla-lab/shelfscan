// Tiny IndexedDB wrapper. Records and image blobs live in separate stores so the
// library list can load quickly without pulling every full-size photo into memory.

const DB_NAME = 'chemscan';
const VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const result = fn(s);
        t.oncomplete = () => resolve(result?.result ?? result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const putItem = (item) => tx('items', 'readwrite', (s) => s.put(item));
export const getItem = (id) => tx('items', 'readonly', (s) => s.get(id));
export const allItems = () => tx('items', 'readonly', (s) => s.getAll());
export const putImages = (id, full, thumb) => tx('images', 'readwrite', (s) => s.put({ id, full, thumb }));
export const getImages = (id) => tx('images', 'readonly', (s) => s.get(id));

export async function deleteItem(id) {
  await tx('items', 'readwrite', (s) => s.delete(id));
  await tx('images', 'readwrite', (s) => s.delete(id));
}

export async function clearAll() {
  await tx('items', 'readwrite', (s) => s.clear());
  await tx('images', 'readwrite', (s) => s.clear());
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}

// ---------------------------------------------------------------- deletion records
// Kept so that merging another person's ZIP doesn't bring back a scan deleted here, and so a
// deletion made elsewhere is applied here. id -> ISO time of deletion. Small (one entry per delete).
const DELETED_KEY = 'chemscan.deleted.v1';

export function getDeleted() {
  try {
    return JSON.parse(localStorage.getItem(DELETED_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveDeleted(map) {
  try {
    localStorage.setItem(DELETED_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}

export function markDeleted(id) {
  saveDeleted({ ...getDeleted(), [id]: new Date().toISOString() });
}
