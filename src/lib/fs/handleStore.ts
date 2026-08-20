import type { AnyDirectoryHandle } from "./handles";

/** IndexedDB name kept for existing browser folder handles. */
const DB_NAME = "knowledgegraph";
const STORE_NAME = "handles";
const KEY = "bundle";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
  });
}

export async function hasReadWritePermission(handle: AnyDirectoryHandle): Promise<boolean> {
  if (!handle.queryPermission) {
    return true;
  }
  return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
}

export async function requestReadWritePermission(handle: AnyDirectoryHandle): Promise<boolean> {
  if (await hasReadWritePermission(handle)) {
    return true;
  }
  if (!handle.requestPermission) {
    return true;
  }
  return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}

export async function saveDirectoryHandle(handle: AnyDirectoryHandle): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const request = tx.objectStore(STORE_NAME).put(handle, KEY);
      request.onerror = () => reject(request.error ?? new Error("indexedDB put failed"));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
    });
  } finally {
    db.close();
  }
}

export async function readStoredDirectoryHandle(): Promise<AnyDirectoryHandle | null> {
  if (typeof indexedDB === "undefined") {
    return null;
  }
  const db = await openDb();
  try {
    return await new Promise<AnyDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(KEY);
      request.onsuccess = () => resolve((request.result as AnyDirectoryHandle | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("indexedDB get failed"));
    });
  } finally {
    db.close();
  }
}

/** Restore only if permission is already granted. Do not call requestPermission from useEffect. */
export async function loadDirectoryHandle(): Promise<AnyDirectoryHandle | null> {
  const handle = await readStoredDirectoryHandle();
  if (!handle) {
    return null;
  }
  return (await hasReadWritePermission(handle)) ? handle : null;
}
