import type { GitFileChange } from "@yep-anywhere/shared";
import { useMemo } from "react";
import { FileSearchIndex } from "../lib/fileSearchIndex";

export function sourceFileDisplayPath(file: GitFileChange): string {
  return file.origPath ? `${file.origPath} → ${file.path}` : file.path;
}

/**
 * Reuse the Files browser's cached substring index for a bounded changeset.
 * Rename rows match both their old and new path through their display text.
 */
export function useChangesetFileFilter<T extends GitFileChange>(
  files: T[],
  query: string,
): T[] {
  const searchablePaths = useMemo(
    () => files.map(sourceFileDisplayPath),
    [files],
  );
  const index = useMemo(
    () => new FileSearchIndex(searchablePaths),
    [searchablePaths],
  );
  const matches = useMemo(() => new Set(index.search(query)), [index, query]);
  return useMemo(
    () => files.filter((file) => matches.has(sourceFileDisplayPath(file))),
    [files, matches],
  );
}
