import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ProjectDirectoryStorage } from "../services/ServerSettingsService.js";
import { ensureManagedProjectDir } from "./managedProjectDir.js";

const execFileAsync = promisify(execFile);

export interface ProjectStoragePolicyOptions {
  dataDir: string;
  getMode: () => ProjectDirectoryStorage;
}

/** Resolve all YA-owned project state through one explicit storage policy. */
export class ProjectStoragePolicy {
  readonly dataDir: string;
  private readonly getModeValue: () => ProjectDirectoryStorage;

  constructor(options: ProjectStoragePolicyOptions) {
    this.dataDir = resolve(options.dataDir);
    this.getModeValue = options.getMode;
  }

  get mode(): ProjectDirectoryStorage {
    return this.getModeValue() === "project" ? "project" : "app-data";
  }

  projectRoot(projectPath: string): string {
    return join(projectPath, ".yep");
  }

  appDataRoot(projectPath: string): string {
    return join(this.dataDir, "projects", projectStorageKey(projectPath));
  }

  writePath(projectPath: string, ...segments: string[]): string {
    return containedPath(
      this.mode === "project"
        ? this.projectRoot(projectPath)
        : this.appDataRoot(projectPath),
      segments,
    );
  }

  /** Create only the selected write location. Reads never call this method. */
  async ensureWriteDirectory(
    projectPath: string,
    ...segments: string[]
  ): Promise<string> {
    if (this.mode === "project") {
      const root = this.projectRoot(projectPath);
      const directory = containedPath(root, segments);
      await assertNoSymlinkComponents(resolve(projectPath), directory);
      await assertProjectRootUntracked(projectPath);
      await ensureManagedProjectDir(projectPath, ".yep", ...segments);
      await assertContainedDirectory(projectPath, directory);
      return directory;
    }
    const directory = containedPath(this.appDataRoot(projectPath), segments);
    await assertNoSymlinkComponents(this.dataDir, directory);
    await mkdir(directory, { recursive: true });
    await assertContainedDirectory(this.dataDir, directory);
    return directory;
  }

  async ensureParentForWrite(
    projectPath: string,
    ...segments: string[]
  ): Promise<string> {
    const filePath = this.writePath(projectPath, ...segments);
    await this.ensureWriteDirectory(
      projectPath,
      ...segments.slice(0, Math.max(0, segments.length - 1)),
    );
    await mkdir(dirname(filePath), { recursive: true });
    return filePath;
  }

  /** Selected location first, then the other location for read compatibility. */
  readPaths(projectPath: string, ...segments: string[]): string[] {
    const selected = this.writePath(projectPath, ...segments);
    const alternate = containedPath(
      this.mode === "project"
        ? this.appDataRoot(projectPath)
        : this.projectRoot(projectPath),
      segments,
    );
    return selected === alternate ? [selected] : [selected, alternate];
  }
}

export function projectStorageKey(projectPath: string): string {
  return createHash("sha256")
    .update(resolve(projectPath))
    .digest("hex")
    .slice(0, 32);
}

function containedPath(root: string, segments: readonly string[]): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ...segments);
  const relativePath = relative(resolvedRoot, target);
  if (
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Project storage path escaped its managed root");
  }
  return target;
}

async function assertNoSymlinkComponents(
  containingDirectory: string,
  target: string,
): Promise<void> {
  const relativePath = relative(resolve(containingDirectory), resolve(target));
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Project storage path escaped its containing directory");
  }
  let current = resolve(containingDirectory);
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stats) return;
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing symlinked project storage path: ${current}`);
    }
  }
}

async function assertContainedDirectory(
  containingDirectory: string,
  directory: string,
): Promise<void> {
  await assertNoSymlinkComponents(containingDirectory, directory);
  const [resolvedContaining, resolvedDirectory] = await Promise.all([
    realpath(containingDirectory),
    realpath(directory),
  ]);
  const relativePath = relative(resolvedContaining, resolvedDirectory);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Project storage directory escaped its containing root");
  }
}

async function assertProjectRootUntracked(projectPath: string): Promise<void> {
  try {
    const { stdout: inside } = await execFileAsync(
      "git",
      ["-C", projectPath, "rev-parse", "--is-inside-work-tree"],
      { timeout: 5000 },
    );
    if (inside.trim() !== "true") return;
    const { stdout: tracked } = await execFileAsync(
      "git",
      ["-C", projectPath, "ls-files", "-z", "--", ".yep"],
      { timeout: 5000, encoding: "buffer" },
    );
    if (tracked.length > 0) {
      throw new Error("Refusing YA-managed writes into a tracked .yep root");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Refusing YA-managed writes into a tracked .yep root"
    ) {
      throw error;
    }
    // A non-Git project has no tracked-path constraint.
  }
}
