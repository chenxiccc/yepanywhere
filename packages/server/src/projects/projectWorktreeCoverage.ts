import type {
  GitWorkingTreePathKind,
  GitWorktreeCoverage,
  GitWorktreeDirectory,
} from "@yep-anywhere/shared";

interface CoverageSource {
  coverage: GitWorktreeCoverage;
}

export function compareWorktreePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function includesWorktreeKind(
  coverage: GitWorktreeCoverage,
  kind: GitWorkingTreePathKind,
): boolean {
  return coverage[kind];
}

export function unionWorktreeCoverage(
  sources: Iterable<CoverageSource>,
): GitWorktreeCoverage {
  const result = { tracked: false, untracked: false, ignored: false };
  const expandedPrefixes = new Set<string>();
  let compatibilityInventory = false;
  let completeFilesystemScan = false;
  for (const source of sources) {
    result.tracked ||= source.coverage.tracked;
    result.untracked ||= source.coverage.untracked;
    result.ignored ||= source.coverage.ignored;
    completeFilesystemScan ||= source.coverage.filesystemScan === "complete";
    if (source.coverage.expandedPrefixes === undefined) {
      compatibilityInventory = true;
    } else {
      for (const prefix of source.coverage.expandedPrefixes) {
        expandedPrefixes.add(prefix);
      }
    }
  }
  return {
    ...result,
    ...(compatibilityInventory
      ? {}
      : {
          expandedPrefixes: [...expandedPrefixes].sort(compareWorktreePaths),
        }),
    ...(completeFilesystemScan ? { filesystemScan: "complete" as const } : {}),
  };
}

export function unionExpandedWorktreeCoverage(
  sources: Iterable<CoverageSource>,
): GitWorktreeCoverage | null {
  const expandedSources: CoverageSource[] = [];
  for (const source of sources) {
    if (source.coverage.expandedPrefixes !== undefined) {
      expandedSources.push(source);
    }
  }
  if (expandedSources.length === 0) return null;
  return unionWorktreeCoverage(expandedSources);
}

export function sameWorktreeCoverage(
  left: GitWorktreeCoverage,
  right: GitWorktreeCoverage,
): boolean {
  return (
    left.tracked === right.tracked &&
    left.untracked === right.untracked &&
    left.ignored === right.ignored &&
    sameStrings(left.expandedPrefixes, right.expandedPrefixes) &&
    (left.filesystemScan ?? "bounded") === (right.filesystemScan ?? "bounded")
  );
}

export function directoryVisibleToCoverage(
  path: string,
  coverage: GitWorktreeCoverage,
): boolean {
  const parent = parentDirectory(path);
  return parent === "" || coverage.expandedPrefixes?.includes(parent) === true;
}

export function pathCoveredByExpandedPrefixes(
  path: string,
  coverage: GitWorktreeCoverage,
): boolean {
  const parent = parentDirectory(path);
  return parent === "" || coverage.expandedPrefixes?.includes(parent) === true;
}

export function directoryForCoverage(
  directory: GitWorktreeDirectory,
  coverage: GitWorktreeCoverage,
  boundedFileLimit: number,
): GitWorktreeDirectory {
  const expanded = coverage.expandedPrefixes?.includes(directory.path) === true;
  const truncated =
    expanded &&
    (directory.truncated ||
      (coverage.filesystemScan !== "complete" &&
        directory.totalFiles !== undefined &&
        directory.totalFiles > boundedFileLimit));
  if (
    directory.pending === !expanded &&
    directory.truncated === truncated &&
    (expanded || directory.totalFiles === undefined)
  ) {
    return directory;
  }
  return {
    path: directory.path,
    pending: !expanded,
    truncated,
    ...(expanded && directory.totalFiles !== undefined
      ? { totalFiles: directory.totalFiles }
      : {}),
  };
}

function sameStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((value, index) => value === right[index]))
  );
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}
