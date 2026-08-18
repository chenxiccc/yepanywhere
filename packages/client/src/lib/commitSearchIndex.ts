import type {
  GitCommitSearchRecord,
  GitRecentCommit,
} from "@yep-anywhere/shared";

export type CommitSearchMatchField =
  | "subject"
  | "author"
  | "shortHash"
  | "hash"
  | "date"
  | "change";

export interface CommitSearchMatch {
  field: CommitSearchMatchField;
  text: string;
}

export interface CommitSearchResult {
  commit: GitRecentCommit;
  match: CommitSearchMatch;
}

interface SearchValue {
  field: Exclude<CommitSearchMatchField, "change">;
  text: string;
  lower: string;
}

interface SearchDocument {
  commit: GitRecentCommit;
  metadata: SearchValue[];
  deltaText: string;
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
          metadata: [
            searchValue("subject", commit.subject),
            searchValue("author", commit.authorName),
            searchValue("shortHash", commit.shortHash),
            searchValue("hash", commit.hash),
            searchValue("date", commit.authorDate),
          ],
          deltaText: "",
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
      document.deltaText = record.deltaText;
      document.deltaLower = record.deltaText.toLowerCase();
      for (const [query, matches] of this.queryCache) {
        if (findDocumentMatch(document, query)) matches.add(record.hash);
        else matches.delete(record.hash);
      }
    }
  }

  search(rawQuery: string): CommitSearchResult[] {
    const query = rawQuery.trim().toLowerCase();
    if (!query) return [];

    let matches = this.queryCache.get(query);
    if (!matches) {
      const prefixMatches = this.longestCachedPrefix(query);
      matches = new Set<string>();
      for (const hash of this.order) {
        if (prefixMatches && !prefixMatches.has(hash)) continue;
        const document = this.documents.get(hash);
        if (document && findDocumentMatch(document, query)) matches.add(hash);
      }
      this.queryCache.set(query, matches);
    }

    const results: CommitSearchResult[] = [];
    for (const hash of this.order) {
      if (!matches.has(hash)) continue;
      const document = this.documents.get(hash);
      if (!document) continue;
      const match = findDocumentMatch(document, query);
      if (match) results.push({ commit: document.commit, match });
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

function searchValue(field: SearchValue["field"], text: string): SearchValue {
  return { field, text, lower: text.toLowerCase() };
}

function findDocumentMatch(
  document: SearchDocument,
  query: string,
): CommitSearchMatch | null {
  for (const value of document.metadata) {
    if (value.lower.includes(query)) {
      return { field: value.field, text: value.text };
    }
  }

  const start = document.deltaLower.indexOf(query);
  if (start < 0) return null;
  const lineStart = document.deltaText.lastIndexOf("\n", start - 1) + 1;
  const nextNewline = document.deltaText.indexOf("\n", start + query.length);
  const lineEnd = nextNewline < 0 ? document.deltaText.length : nextNewline;
  return {
    field: "change",
    text: document.deltaText.slice(lineStart, lineEnd),
  };
}
