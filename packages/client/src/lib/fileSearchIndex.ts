/**
 * Small browser-owned filename index. Normalization happens once when the
 * tracked-file corpus arrives, and extending a query narrows the preceding
 * candidate list instead of rescanning every path.
 */
export class FileSearchIndex {
  private readonly normalized: string[];
  private readonly queryCache = new Map<string, number[]>();

  constructor(private readonly files: string[]) {
    this.normalized = files.map((file) => file.toLowerCase());
  }

  search(rawQuery: string): string[] {
    const query = rawQuery.trim().toLowerCase();
    if (!query) return this.files;

    let matches = this.queryCache.get(query);
    if (!matches) {
      const candidates =
        this.longestCachedPrefix(query) ??
        Array.from({ length: this.files.length }, (_, index) => index);
      matches = candidates.filter((index) =>
        this.normalized[index]?.includes(query),
      );
      this.queryCache.set(query, matches);
    }
    return matches.map((index) => this.files[index] as string);
  }

  private longestCachedPrefix(query: string): number[] | null {
    for (let length = query.length - 1; length > 0; length--) {
      const cached = this.queryCache.get(query.slice(0, length));
      if (cached) return cached;
    }
    return null;
  }
}
