import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MAX_REVIEW_PATH_LENGTH } from "@yep-anywhere/shared";
import { HttpError } from "../middleware/error-handler.js";

/** Validate and normalize the repository-relative path accepted by git APIs. */
export function repositoryRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_REVIEW_PATH_LENGTH ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new HttpError(400, "Review paths must be repository-relative");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new HttpError(400, "Review paths must not traverse the repository");
  }
  return value;
}

/** Resolve a worktree path and reject symlinks that escape the project root. */
export async function repositoryFilePath(
  projectPath: string,
  relativePath: string,
): Promise<string> {
  const candidate = await repositoryFilePathIfExists(projectPath, relativePath);
  if (!candidate) {
    throw new HttpError(400, `Review source does not exist: ${relativePath}`);
  }
  return candidate;
}

/** The same boundary for relocation, where an ordinary missing file is gone. */
export async function repositoryFilePathIfExists(
  projectPath: string,
  relativePath: string,
): Promise<string | null> {
  const safePath = repositoryRelativePath(relativePath);
  const root = await fs.realpath(projectPath);
  let candidate: string;
  try {
    candidate = await fs.realpath(path.resolve(root, safePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const fromRoot = path.relative(root, candidate);
  if (
    fromRoot.startsWith(`..${path.sep}`) ||
    fromRoot === ".." ||
    path.isAbsolute(fromRoot)
  ) {
    throw new HttpError(400, "Review source escapes the project root");
  }
  const stat = await fs.stat(candidate);
  if (!stat.isFile()) {
    throw new HttpError(400, `Review source is not a file: ${safePath}`);
  }
  return candidate;
}
