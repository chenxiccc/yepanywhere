import type {
  GitCommitSearchRecord,
  GitRecentCommit,
} from "@yep-anywhere/shared";

interface SearchDocument {
  commit: GitRecentCommit;
  metadataLower: string;
  deltaLower: string;
}

/**
 * In-memory commit-delta index. Query prefixes are cached as candidate sets,
 * so ordinary typing narrows the preceding result instead of rescanning the
 * whole corpus. As changed-line batches arrive, only those updated documents
 * are tested against cached queries.
 */
export class CommitSearchIndex {
  private order: string[] = [];
  private documents = new Map<string, SearchDocument>();
  private queryCache = new Map<string, Set<string>>();

  reset(commits: GitRecentCommit[]): void {
    this.order = commits.map((commit) => commit.hash);
    this.documents = new Map(
      commits.map((commit) => [
        commit.hash,
        {
          commit,
          metadataLower: [
            commit.hash,
            commit.shortHash,
            commit.subject,
            commit.authorName,
            commit.authorDate,
          ]
            .join("\n")
            .toLowerCase(),
          deltaLower: "",
        },
      ]),
    );
    this.queryCache.clear();
  }

  update(records: GitCommitSearchRecord[]): void {
    for (const record of records) {
      const document = this.documents.get(record.hash);
      if (!document) continue;
      document.deltaLower = record.deltaText.toLowerCase();
      for (const [query, matches] of this.queryCache) {
        if (matchesDocument(document, query)) matches.add(record.hash);
        else matches.delete(record.hash);
      }
    }
  }

  search(rawQuery: string): GitRecentCommit[] {
    const query = rawQuery.trim().toLowerCase();
    if (!query) return [];

    let matches = this.queryCache.get(query);
    if (!matches) {
      const prefixMatches = this.longestCachedPrefix(query);
      matches = new Set<string>();
      for (const hash of this.order) {
        if (prefixMatches && !prefixMatches.has(hash)) continue;
        const document = this.documents.get(hash);
        if (document && matchesDocument(document, query)) matches.add(hash);
      }
      this.queryCache.set(query, matches);
    }

    const results: GitRecentCommit[] = [];
    for (const hash of this.order) {
      if (!matches.has(hash)) continue;
      const commit = this.documents.get(hash)?.commit;
      if (commit) results.push(commit);
    }
    return results;
  }

  private longestCachedPrefix(query: string): Set<string> | null {
    for (let length = query.length - 1; length > 0; length--) {
      const cached = this.queryCache.get(query.slice(0, length));
      if (cached) return cached;
    }
    return null;
  }
}

function matchesDocument(document: SearchDocument, query: string): boolean {
  return (
    document.metadataLower.includes(query) ||
    document.deltaLower.includes(query)
  );
}
