import type {
  GitWorkingTreeChange,
  GitWorkingTreeFile,
  GitWorktreeCoverage,
  GitWorktreeDirectory,
  GitWorktreeDirectoryChange,
  GitWorktreePathChange,
} from "@yep-anywhere/shared";
import {
  compareWorktreePaths,
  directoryForCoverage,
  directoryVisibleToCoverage,
  includesWorktreeKind,
  pathCoveredByExpandedPrefixes,
} from "./projectWorktreeCoverage.js";
import type { ProjectWorktreeScan } from "./projectWorktreeScan.js";

type InventoryMode = "unknown" | "git" | "filesystem";

/** The retained scan corpora from which subscriber-specific views are derived. */
export interface ProjectWorktreeInventory {
  mode: InventoryMode;
  /** Git or omitted-prefix filesystem compatibility scan. */
  compatibility: ProjectWorktreeScan | null;
  /** Opened-directory filesystem scan. */
  expanded: ProjectWorktreeScan | null;
}

export interface ProjectWorktreeProjectionLimits {
  fileLimit: number;
  filesystemFileLimit: number;
}

export interface ProjectWorktreeProjection {
  files: Map<string, GitWorkingTreeFile>;
  directories: Map<string, GitWorktreeDirectory> | null;
  totalFiles: number | null;
  truncated: boolean;
}

export function createProjectWorktreeInventory(): ProjectWorktreeInventory {
  return { mode: "unknown", compatibility: null, expanded: null };
}

export function reconcileProjectWorktreeInventory(
  previous: ProjectWorktreeInventory,
  primaryScan: ProjectWorktreeScan,
  secondaryExpandedScan: ProjectWorktreeScan | null,
  isGitRepository: boolean,
  pendingPaths: ReadonlySet<string>,
): { inventory: ProjectWorktreeInventory; changed: boolean } {
  const primaryIsExpanded = primaryScan.directoryRows !== undefined;
  const nextCompatibility = primaryIsExpanded ? null : primaryScan;
  const nextExpanded =
    secondaryExpandedScan ?? (primaryIsExpanded ? primaryScan : null);
  const compatibility = nextCompatibility
    ? stabilizeScan(
        previous.compatibility ?? previous.expanded,
        nextCompatibility,
        pendingPaths,
      )
    : null;
  const expanded = nextExpanded
    ? stabilizeScan(
        previous.expanded ?? previous.compatibility,
        nextExpanded,
        pendingPaths,
      )
    : null;
  const mode: InventoryMode = isGitRepository ? "git" : "filesystem";
  return {
    inventory: {
      mode,
      compatibility: compatibility?.scan ?? null,
      expanded: expanded?.scan ?? null,
    },
    changed:
      previous.mode !== mode ||
      Boolean(previous.compatibility) !== Boolean(compatibility) ||
      Boolean(previous.expanded) !== Boolean(expanded) ||
      compatibility?.changed === true ||
      expanded?.changed === true,
  };
}

export function projectWorktreeEndpoints(inventory: ProjectWorktreeInventory): {
  headSha: string | null;
  baseSha: string | null;
} {
  const source = inventory.compatibility ?? inventory.expanded;
  return {
    headSha: source?.headSha ?? null,
    baseSha: source?.baseSha ?? null,
  };
}

export function projectWorktreeWatchScope(
  inventory: ProjectWorktreeInventory,
): { directories: Set<string>; complete: boolean } | null {
  if (inventory.mode !== "filesystem") return null;
  const scans = [inventory.compatibility, inventory.expanded].filter(
    (scan): scan is ProjectWorktreeScan => scan !== null,
  );
  if (!scans.some((scan) => scan.directories !== undefined)) return null;
  return {
    directories: new Set(
      scans.flatMap((scan) => [...(scan.directories ?? [])]),
    ),
    complete: scans.every((scan) => scan.truncated !== true),
  };
}

export function hasExpandedProjectWorktreeCorpus(
  inventory: ProjectWorktreeInventory,
): boolean {
  return inventory.expanded !== null;
}

export function projectWorktreeProjection(
  inventory: ProjectWorktreeInventory,
  coverage: GitWorktreeCoverage,
  limits: ProjectWorktreeProjectionLimits,
): ProjectWorktreeProjection {
  const expandedFilesystemProjection =
    inventory.mode === "filesystem" && coverage.expandedPrefixes !== undefined;
  const source = expandedFilesystemProjection
    ? (inventory.expanded ?? inventory.compatibility)
    : (inventory.compatibility ?? inventory.expanded);
  const matchingFiles = [...(source?.files.values() ?? [])]
    .filter(
      (file) =>
        includesWorktreeKind(
          coverage,
          file.kind ?? (file.tracked ? "tracked" : "untracked"),
        ) &&
        (!expandedFilesystemProjection ||
          pathCoveredByExpandedPrefixes(file.path, coverage)),
    )
    .sort((left, right) => compareWorktreePaths(left.path, right.path));
  const files = boundFiles(
    matchingFiles,
    expandedFilesystemProjection,
    coverage,
    source?.directories !== undefined
      ? limits.filesystemFileLimit
      : limits.fileLimit,
  );
  const directoryRows = inventory.expanded?.directoryRows;
  const directories = directoriesForCoverage(
    directoryRows,
    coverage,
    limits.filesystemFileLimit,
  );
  return {
    files,
    directories,
    totalFiles: totalFilesForCoverage(
      inventory,
      source,
      directoryRows,
      coverage,
    ),
    truncated: truncatedForCoverage(
      inventory,
      source,
      directoryRows,
      matchingFiles.length,
      coverage,
      limits,
    ),
  };
}

function stabilizeScan(
  previous: ProjectWorktreeScan | null,
  current: ProjectWorktreeScan,
  pendingPaths: ReadonlySet<string>,
): { scan: ProjectWorktreeScan; changed: boolean } {
  const { files, changes } = diffFiles(
    previous?.files ?? new Map(),
    current.files,
    pendingPaths,
  );
  const { directoryRows, directoryChanges } = diffDirectories(
    previous?.directoryRows ?? null,
    current.directoryRows,
  );
  return {
    scan: {
      ...current,
      files,
      ...(directoryRows ? { directoryRows } : {}),
    },
    changed:
      changes.length > 0 ||
      directoryChanges.length > 0 ||
      previous?.headSha !== current.headSha ||
      previous?.baseSha !== current.baseSha ||
      previous?.truncated !== current.truncated ||
      previous?.totalFiles !== current.totalFiles ||
      !sameOptionalSet(previous?.directories, current.directories),
  };
}

function boundFiles(
  files: GitWorkingTreeFile[],
  expandedFilesystemProjection: boolean,
  coverage: GitWorktreeCoverage,
  limit: number,
): Map<string, GitWorkingTreeFile> {
  if (!expandedFilesystemProjection) {
    return new Map(files.slice(0, limit).map((file) => [file.path, file]));
  }
  if (coverage.filesystemScan === "complete") {
    return new Map(files.map((file) => [file.path, file]));
  }
  const counts = new Map<string, number>();
  return new Map(
    files
      .filter((file) => {
        const parent = parentDirectory(file.path);
        const count = counts.get(parent) ?? 0;
        counts.set(parent, count + 1);
        return count < limit;
      })
      .map((file) => [file.path, file]),
  );
}

function directoriesForCoverage(
  directoryRows: Map<string, GitWorktreeDirectory> | undefined,
  coverage: GitWorktreeCoverage,
  filesystemFileLimit: number,
): Map<string, GitWorktreeDirectory> | null {
  if (!directoryRows || coverage.expandedPrefixes === undefined) return null;
  const directories = [...directoryRows.values()]
    .filter(
      (directory) =>
        directory.path !== "" &&
        directoryVisibleToCoverage(directory.path, coverage),
    )
    .map((directory) =>
      directoryForCoverage(directory, coverage, filesystemFileLimit),
    )
    .sort((left, right) => compareWorktreePaths(left.path, right.path));
  return new Map(directories.map((directory) => [directory.path, directory]));
}

function totalFilesForCoverage(
  inventory: ProjectWorktreeInventory,
  source: ProjectWorktreeScan | null,
  directoryRows: Map<string, GitWorktreeDirectory> | undefined,
  coverage: GitWorktreeCoverage,
): number | null {
  if (inventory.mode === "filesystem" && !coverage.untracked) return 0;
  if (coverage.expandedPrefixes === undefined || !directoryRows) {
    return source?.totalFiles ?? null;
  }
  const opened = new Set(["", ...coverage.expandedPrefixes]);
  let total = 0;
  for (const path of opened) {
    const directory = directoryRows.get(path);
    if (!directory) continue;
    if (directory.totalFiles === undefined) return null;
    total += directory.totalFiles;
  }
  return total;
}

function truncatedForCoverage(
  inventory: ProjectWorktreeInventory,
  source: ProjectWorktreeScan | null,
  directoryRows: Map<string, GitWorktreeDirectory> | undefined,
  matchingFileCount: number,
  coverage: GitWorktreeCoverage,
  limits: ProjectWorktreeProjectionLimits,
): boolean {
  if (inventory.mode !== "filesystem" || source?.directories === undefined) {
    return source?.truncated === true || matchingFileCount > limits.fileLimit;
  }
  if (!coverage.untracked) return false;
  if (coverage.expandedPrefixes === undefined || !directoryRows) {
    return source?.truncated === true;
  }
  const opened = new Set(["", ...coverage.expandedPrefixes]);
  for (const path of opened) {
    const directory = directoryRows.get(path);
    if (!directory) continue;
    if (
      directory.truncated ||
      (coverage.filesystemScan !== "complete" &&
        directory.totalFiles !== undefined &&
        directory.totalFiles > limits.filesystemFileLimit)
    ) {
      return true;
    }
  }
  return false;
}

function sameOptionalSet(
  left: ReadonlySet<string> | undefined,
  right: ReadonlySet<string> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

export function diffFiles(
  previous: Map<string, GitWorkingTreeFile>,
  current: Map<string, GitWorkingTreeFile>,
  pendingPaths: ReadonlySet<string>,
): {
  files: Map<string, GitWorkingTreeFile>;
  changes: GitWorktreePathChange[];
} {
  const files = new Map<string, GitWorkingTreeFile>();
  const changes: GitWorktreePathChange[] = [];
  for (const [path, next] of current) {
    const prior = previous.get(path);
    if (!prior) {
      files.set(path, next);
      changes.push({ changeType: "create", path, file: next });
      continue;
    }
    if (sameFile(prior, next) && !pathWasObserved(path, pendingPaths)) {
      files.set(path, prior);
      continue;
    }
    files.set(path, next);
    changes.push({ changeType: "modify", path, file: next });
  }
  for (const [path, file] of previous) {
    if (!current.has(path)) {
      changes.push({ changeType: "delete", path, file });
    }
  }
  changes.sort((left, right) => compareWorktreePaths(left.path, right.path));
  return { files, changes };
}

export function diffDirectories(
  previous: Map<string, GitWorktreeDirectory> | null,
  current: Map<string, GitWorktreeDirectory> | undefined,
): {
  directoryRows: Map<string, GitWorktreeDirectory> | null;
  directoryChanges: GitWorktreeDirectoryChange[];
} {
  if (!current) {
    return {
      directoryRows: null,
      directoryChanges: previous
        ? [...previous.values()]
            .map((directory) => ({
              changeType: "delete" as const,
              path: directory.path,
              directory,
            }))
            .sort((left, right) => compareWorktreePaths(left.path, right.path))
        : [],
    };
  }

  const directoryRows = new Map<string, GitWorktreeDirectory>();
  const directoryChanges: GitWorktreeDirectoryChange[] = [];
  for (const [path, next] of current) {
    const prior = previous?.get(path);
    if (!prior) {
      directoryRows.set(path, next);
      directoryChanges.push({ changeType: "create", path, directory: next });
    } else if (sameDirectory(prior, next)) {
      directoryRows.set(path, prior);
    } else {
      directoryRows.set(path, next);
      directoryChanges.push({ changeType: "modify", path, directory: next });
    }
  }
  for (const [path, directory] of previous ?? []) {
    if (!current.has(path)) {
      directoryChanges.push({ changeType: "delete", path, directory });
    }
  }
  directoryChanges.sort((left, right) =>
    compareWorktreePaths(left.path, right.path),
  );
  return { directoryRows, directoryChanges };
}

function sameDirectory(
  left: GitWorktreeDirectory,
  right: GitWorktreeDirectory,
): boolean {
  return (
    left.path === right.path &&
    left.pending === right.pending &&
    left.truncated === right.truncated &&
    left.totalFiles === right.totalFiles
  );
}

function pathWasObserved(
  path: string,
  pendingPaths: ReadonlySet<string>,
): boolean {
  for (const pending of pendingPaths) {
    if (pending === "" || path === pending || path.startsWith(`${pending}/`)) {
      return true;
    }
  }
  return false;
}

function sameFile(
  left: GitWorkingTreeFile,
  right: GitWorkingTreeFile,
): boolean {
  return (
    left.path === right.path &&
    left.tracked === right.tracked &&
    left.kind === right.kind &&
    left.present === right.present &&
    sameChanges(left.worktreeChanges, right.worktreeChanges) &&
    sameChange(left.cumulativeChange, right.cumulativeChange)
  );
}

function sameChanges(
  left: readonly GitWorkingTreeChange[] | undefined,
  right: readonly GitWorkingTreeChange[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((change, index) => sameChange(change, right[index]));
}

function sameChange(
  left: GitWorkingTreeChange | undefined,
  right: GitWorkingTreeChange | undefined,
): boolean {
  if (left === right) return true;
  return Boolean(
    left &&
      right &&
      left.status === right.status &&
      left.staged === right.staged &&
      left.linesAdded === right.linesAdded &&
      left.linesDeleted === right.linesDeleted &&
      left.origPath === right.origPath &&
      left.lastEditor?.sessionId === right.lastEditor?.sessionId &&
      left.lastEditor?.observedAt === right.lastEditor?.observedAt,
  );
}
