import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { enforceOwnerOnlyPathPermissionsStrict } from "../utils/filePermissions.js";

export interface PublicShareAtomicWriteHooks {
  beforeAtomicRename?: (filePath: string) => Promise<void> | void;
  afterAtomicRename?: (filePath: string) => Promise<void> | void;
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await enforceOwnerOnlyPathPermissionsStrict(directory, "directory");
}

export async function preparePrivateFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o600);
  await handle.close();
  await enforceOwnerOnlyPathPermissionsStrict(filePath, "file");
}

export async function removeOwnedAtomicControlTemps(
  directory: string,
  controlNames: readonly string[],
): Promise<void> {
  const names = new Set(controlNames);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const match = /^\.([A-Za-z0-9_-]+\.json)\.(\d+)\.([0-9a-f]{16})\.tmp$/.exec(
      entry.name,
    );
    if (!entry.isFile() || !match?.[1] || !names.has(match[1])) continue;
    await fs.rm(path.join(directory, entry.name));
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== "win32" ||
      !["EISDIR", "EINVAL", "EPERM"].includes(code ?? "")
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export class PublicShareAtomicWriteError extends Error {
  constructor(
    message: string,
    readonly committed: boolean,
    options: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function publicShareAtomicWriteCommitted(error: unknown): boolean {
  return error instanceof PublicShareAtomicWriteError && error.committed;
}

export async function atomicWritePublicShareJson(
  filePath: string,
  value: unknown,
  hooks: PublicShareAtomicWriteHooks,
): Promise<void> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await enforceOwnerOnlyPathPermissionsStrict(temporaryPath, "file");
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(temporaryPath).catch(() => undefined);
    throw new PublicShareAtomicWriteError(
      "Failed to write private JSON",
      false,
      { cause: error },
    );
  }
  await handle.close();
  try {
    await hooks.beforeAtomicRename?.(filePath);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath).catch(() => undefined);
    throw new PublicShareAtomicWriteError(
      "Failed to commit private JSON",
      false,
      { cause: error },
    );
  }
  try {
    await hooks.afterAtomicRename?.(filePath);
    await syncDirectory(directory);
  } catch (error) {
    throw new PublicShareAtomicWriteError(
      "Failed to sync committed private JSON",
      true,
      { cause: error },
    );
  }
}
