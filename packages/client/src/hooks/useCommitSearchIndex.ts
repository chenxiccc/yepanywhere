import type { GitRecentCommit } from "@yep-anywhere/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { CommitSearchIndex } from "../lib/commitSearchIndex";

const SEARCH_RECORD_BATCH_SIZE = 20;

interface CommitSearchCacheEntry {
  head: string | null;
  index: CommitSearchIndex;
  indexedCount: number;
  totalCount: number;
  complete: boolean;
}

/** Retain built/partial indexes while the browser is open and tabs remount. */
const commitSearchCache = new Map<string, CommitSearchCacheEntry>();

export interface CommitSearchIndexState {
  results: GitRecentCommit[];
  indexing: boolean;
  indexedCount: number;
  totalCount: number;
  error: string | null;
}

/**
 * Builds the complete commit-delta search corpus once, on demand. The server
 * only supplies bounded source-record batches; every query and query update is
 * evaluated by the browser-owned index.
 */
export function useCommitSearchIndex(
  projectId: string,
  query: string,
  enabled: boolean,
): CommitSearchIndexState {
  const indexRef = useRef(new CommitSearchIndex());
  const [version, setVersion] = useState(0);
  const [indexing, setIndexing] = useState(false);
  const [indexedCount, setIndexedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    setIndexing(true);
    setIndexedCount(0);
    setTotalCount(0);
    setError(null);

    void (async () => {
      try {
        const manifest = await api.getGitCommitSearchManifest(projectId);
        if (cancelled) return;
        let cache = commitSearchCache.get(projectId);
        if (!cache || cache.head !== manifest.head) {
          const index = new CommitSearchIndex();
          index.reset(manifest.commits);
          cache = {
            head: manifest.head,
            index,
            indexedCount: 0,
            totalCount: manifest.commits.length,
            complete: manifest.commits.length === 0,
          };
          commitSearchCache.set(projectId, cache);
        }

        indexRef.current = cache.index;
        setIndexedCount(cache.indexedCount);
        setTotalCount(cache.totalCount);
        setVersion((current) => current + 1);

        for (
          let offset = cache.indexedCount;
          offset < manifest.commits.length;
          offset += SEARCH_RECORD_BATCH_SIZE
        ) {
          const batch = manifest.commits.slice(
            offset,
            offset + SEARCH_RECORD_BATCH_SIZE,
          );
          const response = await api.getGitCommitSearchRecords(
            projectId,
            batch.map((commit) => commit.hash),
          );
          if (cancelled) return;
          if (response.records.length !== batch.length) {
            throw new Error("Commit search index returned an incomplete batch");
          }
          cache.index.update(response.records);
          cache.indexedCount = offset + batch.length;
          setIndexedCount(cache.indexedCount);
          setVersion((current) => current + 1);
        }
        cache.complete = true;
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Failed to build commit search index",
          );
        }
      } finally {
        if (!cancelled) setIndexing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, projectId]);

  const results = useMemo(
    () => indexRef.current.search(query),
    [query, version],
  );

  return { results, indexing, indexedCount, totalCount, error };
}
