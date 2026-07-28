import { beforeEach } from "vitest";
import { invalidateLocalStorageValues } from "./src/lib/localStorageValue";

function createTestStorage(): Storage {
  const storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(storage.keys())[index] ?? null;
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
  };
}

// Do not probe window.localStorage first: Node 25's webstorage getter warns
// unless --localstorage-file has a valid path.
if (typeof window !== "undefined") {
  const storage = createTestStorage();

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
}

beforeEach(() => {
  invalidateLocalStorageValues();
});
