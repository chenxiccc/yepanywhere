/**
 * Shared external store for one primitive browser-local preference.
 *
 * The first successful client read initializes an in-memory snapshot.
 * Subsequent React snapshot checks are memory-only. Same-tab application code
 * must use `set` or explicitly invalidate after a raw storage migration;
 * arbitrary same-tab DevTools writes are intentionally not discovered by an
 * unrelated render. Cross-tab storage events reconcile the cache while
 * subscribers exist.
 */
export interface LocalStorageValueStore<T> {
  read(): T;
  set(value: T): void;
  reset(): void;
  invalidate(): void;
  subscribe(listener: () => void): () => void;
}

export interface LocalStorageValueOptions<T> {
  /** Other keys whose changes can alter the effective fallback value. */
  relatedKeys?: readonly string[];
  /** Read a legacy/fallback value when the primary key is absent. */
  readFallback?: (storage: Storage) => T | undefined;
}

const invalidatorsByKey = new Map<string, Set<() => void>>();
const storageObserversByKey = new Map<
  string,
  Set<(event: StorageEvent) => void>
>();
const allStorageObservers = new Set<(event: StorageEvent) => void>();
let storageEventWindow: Window | null = null;

function handleStorageEvent(event: StorageEvent): void {
  const observers =
    event.key === null
      ? allStorageObservers
      : (storageObserversByKey.get(event.key) ?? []);
  for (const observer of new Set(observers)) {
    observer(event);
  }
}

function ensureStorageEventListener(): void {
  if (typeof window === "undefined" || storageEventWindow === window) {
    return;
  }
  storageEventWindow?.removeEventListener("storage", handleStorageEvent);
  storageEventWindow = window;
  storageEventWindow.addEventListener("storage", handleStorageEvent);
}

function getStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    return storage && typeof storage.getItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

function registerInvalidator(key: string, invalidator: () => void): void {
  let invalidators = invalidatorsByKey.get(key);
  if (!invalidators) {
    invalidators = new Set();
    invalidatorsByKey.set(key, invalidators);
  }
  invalidators.add(invalidator);
}

function registerStorageObserver(
  keys: Iterable<string>,
  observer: (event: StorageEvent) => void,
): void {
  allStorageObservers.add(observer);
  for (const key of keys) {
    let observers = storageObserversByKey.get(key);
    if (!observers) {
      observers = new Set();
      storageObserversByKey.set(key, observers);
    }
    observers.add(observer);
  }
  ensureStorageEventListener();
}

/**
 * Invalidate one preference key, or every registered preference when omitted.
 * This is the supported seam for migrations, imports, and tests that must write
 * browser storage directly.
 */
export function invalidateLocalStorageValues(key?: string): void {
  if (key !== undefined) {
    for (const invalidate of invalidatorsByKey.get(key) ?? []) {
      invalidate();
    }
    return;
  }
  const invalidators = new Set<() => void>();
  for (const registered of invalidatorsByKey.values()) {
    for (const invalidate of registered) {
      invalidators.add(invalidate);
    }
  }
  for (const invalidate of invalidators) {
    invalidate();
  }
}

export function createLocalStorageValue<T extends string | number | boolean>(
  key: string,
  defaultValue: T,
  parse: (raw: string) => T | undefined,
  serialize: (value: T) => string = String,
  options: LocalStorageValueOptions<T> = {},
): LocalStorageValueStore<T> {
  const listeners = new Set<() => void>();
  const observedKeys = new Set([key, ...(options.relatedKeys ?? [])]);
  let snapshot = defaultValue;
  let initialized = false;

  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const readFromStorage = (storage: Storage): T => {
    const stored = storage.getItem(key);
    if (stored !== null) {
      return parse(stored) ?? defaultValue;
    }
    return options.readFallback?.(storage) ?? defaultValue;
  };

  const read = (): T => {
    ensureStorageEventListener();
    if (initialized) {
      return snapshot;
    }
    const storage = getStorage();
    if (!storage) {
      return snapshot;
    }
    try {
      snapshot = readFromStorage(storage);
      initialized = true;
    } catch {
      // Storage is unavailable. Keep the current in-memory value and allow a
      // later read to retry rather than poisoning client initialization.
    }
    return snapshot;
  };

  const updateSnapshot = (next: T): void => {
    const changed = next !== snapshot;
    snapshot = next;
    initialized = true;
    if (changed) {
      emit();
    }
  };

  const invalidate = (): void => {
    initialized = false;
    emit();
  };

  const subscribe = (listener: () => void): (() => void) => {
    ensureStorageEventListener();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const set = (value: T): void => {
    try {
      getStorage()?.setItem(key, serialize(value));
    } catch {
      // Persistence failed; the coherent in-memory preference still applies.
    }
    updateSnapshot(value);
  };

  const reset = (): void => {
    let next = defaultValue;
    const storage = getStorage();
    if (storage) {
      try {
        storage.removeItem(key);
        next = options.readFallback?.(storage) ?? defaultValue;
      } catch {
        // Removal failed; the coherent in-memory default still applies.
      }
    }
    updateSnapshot(next);
  };

  registerInvalidator(key, invalidate);
  for (const relatedKey of options.relatedKeys ?? []) {
    registerInvalidator(relatedKey, invalidate);
  }
  registerStorageObserver(observedKeys, (event) => {
    if (event.key === key && event.newValue !== null) {
      updateSnapshot(parse(event.newValue) ?? defaultValue);
      return;
    }
    invalidate();
  });

  return { read, set, reset, invalidate, subscribe };
}

/**
 * Boolean instantiation preserving the original boolean-store contract:
 * absent key reads as `defaultValue`, but any present value other than
 * "true" reads as false (not as the default).
 */
export function createLocalStorageBoolean(
  key: string,
  defaultValue: boolean,
): LocalStorageValueStore<boolean> {
  return createLocalStorageValue(key, defaultValue, (raw) => raw === "true");
}
