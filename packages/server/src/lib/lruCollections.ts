/** Native collection whose insertion order is intentionally used as LRU order. */
export type LruSet<T> = Set<T>;
export type LruMap<K, V> = Map<K, V>;

/**
 * Create an LRU order index backed by a native collection. Callers refresh an
 * existing entry by deleting and reinserting it, iterate oldest to newest, and
 * remove from the oldest end for expiry or capacity. The ordinary Set/Map API
 * remains available; this factory is only the documented implementation seam.
 */
export function createLruSet<T>(): LruSet<T> {
  return new Set<T>();
}

export function createLruMap<K, V>(): LruMap<K, V> {
  return new Map<K, V>();
}

export function refreshLruSet<T>(values: LruSet<T>, value: T): void {
  values.delete(value);
  values.add(value);
}

export function refreshLruMap<K, V>(
  values: LruMap<K, V>,
  key: K,
  value: V,
): void {
  values.delete(key);
  values.set(key, value);
}
