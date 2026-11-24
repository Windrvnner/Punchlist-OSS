import type { KeptImportChange, KeptImportPart, KeptImportRead, KeptImports } from '../ports';

const DATABASE = 'dil-kept-imports';
const STORE = 'parts';
const VERSION = 1;

/** The browser demo and desktop renderer share the original IndexedDB format. */
export class IndexedKeptImports implements KeptImports {
  private database: IDBDatabase | null = null;

  read(onLateOpen: () => void): Promise<KeptImportRead> {
    return new Promise((resolve) => {
      const factory = databaseFactory();
      if (!factory) {
        resolve('memory');
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(DATABASE, VERSION);
      } catch {
        resolve('unavailable');
        return;
      }
      let blocked = false;
      request.onupgradeneeded = () => createStore(request.result);
      request.onerror = () => resolve('unavailable');
      request.onblocked = () => {
        blocked = true;
        resolve('unavailable');
      };
      request.onsuccess = () => {
        this.database = request.result;
        if (blocked) onLateOpen();
        else void readParts(request.result).then(resolve);
      };
    });
  }

  write(changes: readonly KeptImportChange[], replace = false): Promise<boolean> {
    return new Promise((resolve) => {
      let transaction: IDBTransaction | undefined;
      try {
        if (!this.database) {
          resolve(false);
          return;
        }
        transaction = this.database.transaction(STORE, 'readwrite');
        transaction.oncomplete = () => resolve(true);
        transaction.onabort = () => resolve(false);
        const entries = transaction.objectStore(STORE);
        if (replace) entries.clear();
        for (const change of changes) {
          // Arrays sort after strings, so this range covers every part of one import.
          if ('drop' in change) entries.delete(IDBKeyRange.bound([change.key], [change.key, []]));
          else entries.put(change.value, [change.key, change.part]);
        }
        transaction.commit?.();
      } catch {
        try { transaction?.abort(); } catch { /* The transaction already ended. */ }
        resolve(false);
      }
    });
  }
}

function databaseFactory() {
  try { return globalThis.indexedDB; } catch { return undefined; }
}

function createStore(database: IDBDatabase) {
  for (const name of [...database.objectStoreNames]) database.deleteObjectStore(name);
  database.createObjectStore(STORE);
}

function readParts(database: IDBDatabase): Promise<KeptImportPart[]> {
  return new Promise((resolve) => {
    const parts: KeptImportPart[] = [];
    try {
      const all = database.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      all.onsuccess = () => {
        const cursor = all.result;
        if (!cursor) {
          resolve(parts);
          return;
        }
        const key = cursor.key as unknown;
        if (Array.isArray(key) && typeof key[0] === 'string' && typeof key[1] === 'string') {
          parts.push({ key: key[0], part: key[1], value: cursor.value });
        }
        cursor.continue();
      };
      all.onerror = () => resolve(parts);
    } catch {
      resolve(parts);
    }
  });
}

/** The headless stand-in snapshots values and applies each batch atomically like IndexedDB. */
export class MemoryKeptImports implements KeptImports {
  private imports = new Map<string, Map<string, unknown>>();

  async read(): Promise<KeptImportPart[]> {
    return [...this.imports].flatMap(([key, parts]) =>
      [...parts].map(([part, value]) => ({ key, part, value: structuredClone(value) })));
  }

  async write(changes: readonly KeptImportChange[], replace = false): Promise<boolean> {
    let copied: KeptImportChange[];
    try {
      copied = structuredClone([...changes]);
    } catch {
      return false;
    }
    if (replace) this.imports.clear();
    for (const change of copied) {
      if ('drop' in change) {
        this.imports.delete(change.key);
      } else {
        const parts = this.imports.get(change.key) ?? new Map<string, unknown>();
        parts.set(change.part, change.value);
        this.imports.set(change.key, parts);
      }
    }
    return true;
  }
}
