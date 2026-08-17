import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Expand a leading `~` the same way the project file APIs do. */
export function expandUserHomePath(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return resolve(homedir(), filePath.slice(2));
  }
  return filePath;
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  const relativePath = relative(resolve(directory), resolve(filePath));
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath)
  );
}

/**
 * Canonical absolute path of a YA-managed attachment, or null when the path
 * is not under the app-data attachments or legacy uploads tree.
 */
export function canonicalizeManagedAttachmentPath(
  filePath: string,
  dataDir: string,
): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return null;
  }
  const expanded = expandUserHomePath(trimmed);
  if (!isAbsolute(expanded) && !/^[A-Za-z]:[\\/]/.test(expanded)) {
    return null;
  }

  const resolved = resolve(expanded);
  const projectsRoot = resolve(dataDir, "projects");
  if (isInsideDirectory(resolved, projectsRoot)) {
    const parts = relative(projectsRoot, resolved).split(sep);
    if (parts.length >= 4 && parts[1] === "attachments") {
      return resolved;
    }
    return null;
  }

  const uploadsRoot = resolve(dataDir, "uploads");
  if (isInsideDirectory(resolved, uploadsRoot)) {
    const parts = relative(uploadsRoot, resolved).split(sep);
    if (parts.length >= 3) {
      return resolved;
    }
  }
  return null;
}
