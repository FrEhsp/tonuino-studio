/**
 * A tiny key-value store on IndexedDB. Works in the browser and in the
 * desktop app's web view; used for remembered SD card handles and the local
 * copy of catalogs and covers.
 */

const DB_NAME = 'tonuino-studio';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? req.error);
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      }),
  );
}

export const kv = {
  get<T = unknown>(key: string): Promise<T | undefined> {
    return run('readonly', (s) => s.get(key) as IDBRequest<T | undefined>).catch(() => undefined);
  },
  set(key: string, value: unknown): Promise<void> {
    return run('readwrite', (s) => s.put(value, key)).then(() => undefined);
  },
  /** Several entries in one transaction: much quicker than one by one. */
  setMany(entries: readonly (readonly [string, unknown])[]): Promise<void> {
    if (!entries.length) return Promise.resolve();
    return open().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          const s = tx.objectStore(STORE);
          for (const [key, value] of entries) s.put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        }),
    );
  },
  delete(key: string): Promise<void> {
    return run('readwrite', (s) => s.delete(key)).then(() => undefined);
  },
  keys(prefix = ''): Promise<string[]> {
    const range = prefix ? IDBKeyRange.bound(prefix, prefix + '￿') : undefined;
    return run('readonly', (s) => s.getAllKeys(range) as IDBRequest<IDBValidKey[]>)
      .then((keys) => keys.map(String))
      .catch(() => []);
  },
};
