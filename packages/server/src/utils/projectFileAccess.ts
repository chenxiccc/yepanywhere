import { constants as fsConstants, type Stats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

export interface OpenedProjectFile {
  filePath: string;
  handle: FileHandle;
  stats: Stats;
}

export interface ProjectFileOpenHooks {
  beforeComponentOpen?: (
    relativePath: string,
    final: boolean,
  ) => Promise<void> | void;
}

function descriptorRoot(
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "linux") return "/proc/self/fd";
  if (platform === "darwin") return "/dev/fd";
  return null;
}

function sameEntryIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function normalizeRelativeComponents(relativePath: string): string[] | null {
  const normalized = path.normalize(relativePath);
  if (
    normalized === "." ||
    path.isAbsolute(normalized) ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized === ".."
  ) {
    return null;
  }
  const components = normalized.split(path.sep);
  return components.every(
    (component) => component !== "" && component !== "." && component !== "..",
  )
    ? components
    : null;
}

export async function openProjectRelativeFile(
  projectRoot: string,
  relativePath: string,
  hooks: ProjectFileOpenHooks = {},
): Promise<OpenedProjectFile | null> {
  const root = descriptorRoot();
  const components = normalizeRelativeComponents(relativePath);
  if (
    !root ||
    !components ||
    typeof fsConstants.O_DIRECTORY !== "number" ||
    typeof fsConstants.O_NOFOLLOW !== "number"
  ) {
    return null;
  }

  const openFlags =
    fsConstants.O_RDONLY |
    fsConstants.O_NOFOLLOW |
    (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0);
  let current: FileHandle | undefined;
  try {
    const canonicalRoot = await realpath(projectRoot);
    current = await open(canonicalRoot, openFlags | fsConstants.O_DIRECTORY);
    const rootStats = await current.stat();
    const descriptorStats = await stat(path.join(root, String(current.fd)));
    if (
      !rootStats.isDirectory() ||
      !sameEntryIdentity(rootStats, descriptorStats)
    ) {
      return null;
    }

    for (let index = 0; index < components.length; index += 1) {
      const component = components[index]!;
      const final = index === components.length - 1;
      const traversed = components.slice(0, index + 1).join("/");
      await hooks.beforeComponentOpen?.(traversed, final);
      const next = await open(
        path.join(root, String(current.fd), component),
        openFlags | (final ? 0 : fsConstants.O_DIRECTORY),
      );
      const nextStats = await next.stat();
      if (final ? !nextStats.isFile() : !nextStats.isDirectory()) {
        await next.close();
        return null;
      }
      await current.close();
      current = next;
    }

    const handle = current;
    current = undefined;
    return {
      filePath: path.join(canonicalRoot, ...components),
      handle,
      stats: await handle.stat(),
    };
  } catch {
    return null;
  } finally {
    await current?.close();
  }
}

export async function readFileHandleBounded(
  handle: FileHandle,
  maxBytes: number,
): Promise<Buffer | null> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset <= maxBytes ? buffer.subarray(0, offset) : null;
}
