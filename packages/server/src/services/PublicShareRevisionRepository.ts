import {
  PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
  PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES,
  PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES,
  isPublicShareSessionTransferSizeWithinLimits,
  type AppSession,
  type ProviderName,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  type Dirent,
  type Stats,
} from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { enforceOwnerOnlyPathPermissionsStrict } from "../utils/filePermissions.js";
import { collectLegacyAuthorizedPaths } from "./LegacyPublicShareReader.js";
import {
  atomicWritePublicShareJson,
  ensurePrivateDirectory,
  preparePrivateFile,
  syncDirectory,
  type PublicShareAtomicWriteHooks,
} from "./PublicSharePrivateStorage.js";

export type PublicShareLinkedFileMode = "cow" | "live";

export interface PublicShareSource {
  projectId: UrlProjectId;
  sessionId: string;
  projectName?: string;
  provider?: ProviderName;
}

export interface PublicSharePresentation {
  version: 1;
  authorizedPaths: string[];
}

export interface PublicShareRevision {
  revisionId: string;
  capturedAt: string;
  linkedFileMode: PublicShareLinkedFileMode;
  snapshotBytes: number;
  compressedBytes: number;
  integrityWitness?: string;
}

export interface PublicShareRevisionDescriptor
  extends Omit<PublicShareRevision, "integrityWitness"> {
  integrityWitness: string;
}

export interface PublicShareCompressedChunk {
  bytes: Buffer;
  descriptor: PublicShareRevisionDescriptor;
  offset: number;
  nextOffset: number;
  final: boolean;
}

interface PublicShareStateFile {
  version: 2;
  shareStateId: string;
  source: PublicShareSource;
  createdAt: string;
  updatedAt: string;
  revisions: Record<string, PublicShareRevision>;
}

export interface PublicShareRevisionReference {
  shareStateId: string;
  source: PublicShareSource;
}

export interface PublicShareRevisionRepositoryHooks
  extends PublicShareAtomicWriteHooks {
  beforeCowEntryOpen?: (sourcePath: string) => Promise<void> | void;
}

export interface CommitPublicShareRevisionOptions {
  shareStateId: string;
  source: PublicShareSource;
  snapshot: AppSession;
  sourceRevision: string;
  presentation?: PublicSharePresentation;
  projectRoot?: string;
  derivePresentationFromProjectRoot?: (
    projectRoot: string,
  ) => Promise<PublicSharePresentation>;
  capturedAt: string;
}

export interface CommitLegacyPublicShareRevisionOptions {
  shareStateId: string;
  source: PublicShareSource;
  bodyPath: string;
  capturedAt: string;
}

export const PUBLIC_SHARE_REVISION_STREAM_CHUNK_MAX_BYTES = 64 * 1024;

const REVISION_ID_REGEX = /^[A-Za-z0-9_-]{43}$/;
const UNSUPPORTED_COW_CODES = new Set([
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EXDEV",
]);

export class PublicShareRevisionLimitError extends Error {
  constructor() {
    super("Public share session exceeds frozen transfer limit");
    this.name = "PublicShareRevisionLimitError";
  }
}

function sourceMatches(a: PublicShareSource, b: PublicShareSource): boolean {
  return a.projectId === b.projectId && a.sessionId === b.sessionId;
}

async function* serializeJson(value: unknown): AsyncGenerator<string> {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    yield serialized === undefined ? "null" : serialized;
    return;
  }
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) yield ",";
      yield* serializeJson(value[index]);
    }
    yield "]";
    return;
  }

  yield "{";
  let emitted = false;
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined || typeof child === "function") continue;
    if (emitted) yield ",";
    emitted = true;
    yield `${JSON.stringify(key)}:`;
    yield* serializeJson(child);
  }
  yield "}";
}

export async function digestStoredSessionProjection(
  session: AppSession,
): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of serializeJson(session)) {
    digest.update(chunk);
  }
  return digest.digest("base64url");
}

function serializePublicSharePresentation(
  presentation: PublicSharePresentation,
): string {
  return JSON.stringify({
    version: 1,
    authorizedPaths: presentation.authorizedPaths,
  } satisfies PublicSharePresentation);
}

export function cowDescriptorRoot(
  platform: NodeJS.Platform = process.platform,
): string | null {
  return platform === "linux" ? "/proc/self/fd" : null;
}

function sameEntryVersion(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function cloneTreeCopyOnWrite(
  sourceRoot: string,
  destinationRoot: string,
  excludedRoot: string,
  hooks: PublicShareRevisionRepositoryHooks,
): Promise<PublicShareLinkedFileMode> {
  const descriptorRoot = cowDescriptorRoot();
  if (
    !descriptorRoot ||
    typeof fsConstants.O_NOFOLLOW !== "number" ||
    typeof fsConstants.O_DIRECTORY !== "number"
  ) {
    return "live";
  }

  const canonicalSourceRoot = await fs.realpath(sourceRoot);
  const canonicalExcludedRoot = await fs.realpath(excludedRoot);
  const excludedRelative = path.relative(
    canonicalSourceRoot,
    canonicalExcludedRoot,
  );
  if (excludedRelative === "") return "live";
  const excludedPath =
    !excludedRelative.startsWith(`..${path.sep}`) &&
    excludedRelative !== ".." &&
    !path.isAbsolute(excludedRelative)
      ? canonicalExcludedRoot
      : null;
  const sourceRootBefore = await fs.lstat(canonicalSourceRoot);
  await ensurePrivateDirectory(destinationRoot);
  let rootHandle: fs.FileHandle | undefined;
  try {
    const entryOpenFlags =
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
    rootHandle = await fs.open(
      canonicalSourceRoot,
      entryOpenFlags | fsConstants.O_DIRECTORY,
    );
    const rootHandleStats = await rootHandle.stat();
    if (
      !rootHandleStats.isDirectory() ||
      !sameEntryVersion(sourceRootBefore, rootHandleStats)
    ) {
      throw new Error("Public share project changed during capture");
    }

    const visit = async (
      sourceDirectory: fs.FileHandle,
      relativeDirectory: readonly string[],
      destination: string,
    ): Promise<void> => {
      const directoryBefore = await sourceDirectory.stat();
      if (!directoryBefore.isDirectory()) {
        throw new Error("Public share project changed during capture");
      }
      const sourceDirectoryPath = path.join(
        descriptorRoot,
        String(sourceDirectory.fd),
      );
      const entries = await fs.readdir(sourceDirectoryPath, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.name === ".git" || entry.isSymbolicLink()) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        const relativePath = [...relativeDirectory, entry.name];
        const sourcePath = path.join(canonicalSourceRoot, ...relativePath);
        if (excludedPath && path.resolve(sourcePath) === excludedPath) continue;
        await hooks.beforeCowEntryOpen?.(sourcePath);

        const descriptorPath = path.join(sourceDirectoryPath, entry.name);
        const entryHandle = await fs.open(descriptorPath, entryOpenFlags);
        try {
          const entryBefore = await entryHandle.stat();
          const destinationPath = path.join(destination, entry.name);
          if (entryBefore.isDirectory()) {
            await ensurePrivateDirectory(destinationPath);
            await visit(entryHandle, relativePath, destinationPath);
          } else if (entryBefore.isFile()) {
            await fs.copyFile(
              path.join(descriptorRoot, String(entryHandle.fd)),
              destinationPath,
              fsConstants.COPYFILE_FICLONE_FORCE,
            );
            const entryAfter = await entryHandle.stat();
            if (!sameEntryVersion(entryBefore, entryAfter)) {
              throw new Error("Public share project changed during capture");
            }
            await enforceOwnerOnlyPathPermissionsStrict(
              destinationPath,
              "file",
            );
          }
        } finally {
          await entryHandle.close();
        }
      }
      const directoryAfter = await sourceDirectory.stat();
      if (!sameEntryVersion(directoryBefore, directoryAfter)) {
        throw new Error("Public share project changed during capture");
      }
    };
    await visit(rootHandle, [], destinationRoot);
    const sourceRootAfter = await fs.lstat(canonicalSourceRoot);
    const rootHandleAfter = await rootHandle.stat();
    if (
      !sameEntryVersion(sourceRootBefore, sourceRootAfter) ||
      !sameEntryVersion(sourceRootBefore, rootHandleAfter)
    ) {
      throw new Error("Public share project changed during capture");
    }
    return "cow";
  } catch (error) {
    if (
      UNSUPPORTED_COW_CODES.has((error as NodeJS.ErrnoException).code ?? "")
    ) {
      await fs.rm(destinationRoot, { recursive: true });
      return "live";
    }
    throw error;
  } finally {
    await rootHandle?.close();
  }
}

export class PublicShareRevisionRepository {
  private readonly root: string;
  private readonly sharesPath: string;

  constructor(
    dataDir: string,
    private readonly hooks: PublicShareRevisionRepositoryHooks = {},
  ) {
    this.root = path.join(dataDir, "public-shares");
    this.sharesPath = path.join(this.root, "shares");
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.sharesPath);
  }

  async ensureState(
    shareStateId: string,
    source: PublicShareSource,
    now: string,
  ): Promise<void> {
    await this.loadOrCreateState(shareStateId, source, now);
  }

  getRevisionDirectory(
    reference: PublicShareRevisionReference,
    revisionId: string,
  ): string {
    return path.join(
      this.sharesPath,
      reference.shareStateId,
      "frozen",
      revisionId,
    );
  }

  async getRevisionDescriptor(
    reference: PublicShareRevisionReference,
    revisionId: string,
  ): Promise<PublicShareRevisionDescriptor | null> {
    if (!REVISION_ID_REGEX.test(revisionId)) {
      throw new Error("Invalid public share revision");
    }
    const stateDirectory = path.join(this.sharesPath, reference.shareStateId);
    const statePath = this.statePath(reference.shareStateId);
    await enforceOwnerOnlyPathPermissionsStrict(stateDirectory, "directory");
    await enforceOwnerOnlyPathPermissionsStrict(statePath, "file");
    const state = JSON.parse(
      await fs.readFile(statePath, "utf8"),
    ) as Partial<PublicShareStateFile>;
    const revision = state.revisions?.[revisionId];
    if (
      state.version !== 2 ||
      state.shareStateId !== reference.shareStateId ||
      !state.source ||
      !sourceMatches(state.source, reference.source) ||
      !revision ||
      revision.revisionId !== revisionId ||
      typeof revision.capturedAt !== "string" ||
      (revision.linkedFileMode !== "cow" &&
        revision.linkedFileMode !== "live") ||
      !Number.isSafeInteger(revision.snapshotBytes) ||
      revision.snapshotBytes < 0 ||
      !Number.isSafeInteger(revision.compressedBytes) ||
      revision.compressedBytes <= 0 ||
      (revision.integrityWitness !== undefined &&
        (typeof revision.integrityWitness !== "string" ||
          !REVISION_ID_REGEX.test(revision.integrityWitness)))
    ) {
      throw new Error("Invalid public share revision metadata");
    }
    if (revision.integrityWitness === undefined) return null;

    const revisionDirectory = this.getRevisionDirectory(reference, revisionId);
    const sessionPath = path.join(revisionDirectory, "session.json.gz");
    await enforceOwnerOnlyPathPermissionsStrict(revisionDirectory, "directory");
    await enforceOwnerOnlyPathPermissionsStrict(sessionPath, "file");
    const sessionStats = await fs.lstat(sessionPath);
    if (
      !sessionStats.isFile() ||
      sessionStats.size !== revision.compressedBytes
    ) {
      throw new Error("Public share revision size mismatch");
    }
    return revision as PublicShareRevisionDescriptor;
  }

  async readRevisionCompressedChunk(
    reference: PublicShareRevisionReference,
    revisionId: string,
    offset: number,
    maxBytes: number,
  ): Promise<PublicShareCompressedChunk> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("Invalid public share chunk offset");
    }
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES
    ) {
      throw new Error("Invalid public share chunk bound");
    }
    const descriptor = await this.getRevisionDescriptor(reference, revisionId);
    if (
      !descriptor ||
      !isPublicShareSessionTransferSizeWithinLimits(
        descriptor.compressedBytes,
        descriptor.snapshotBytes,
      )
    ) {
      throw new Error("Public share revision lacks bounded-transfer metadata");
    }
    if (offset > descriptor.compressedBytes) {
      throw new Error("Public share chunk offset is past the revision end");
    }

    const length = Math.min(maxBytes, descriptor.compressedBytes - offset);
    const bytes = Buffer.alloc(length);
    const sessionPath = path.join(
      this.getRevisionDirectory(reference, revisionId),
      "session.json.gz",
    );
    const handle = await fs.open(sessionPath, "r");
    try {
      const result = await handle.read(bytes, 0, length, offset);
      if (result.bytesRead !== length) {
        throw new Error("Public share revision changed during chunk read");
      }
    } finally {
      await handle.close();
    }
    const nextOffset = offset + length;
    return {
      bytes,
      descriptor,
      offset,
      nextOffset,
      final: nextOffset === descriptor.compressedBytes,
    };
  }

  async getRevisionSessionStream(
    reference: PublicShareRevisionReference,
    revisionId: string,
  ): Promise<Readable> {
    const revisionDirectory = this.getRevisionDirectory(reference, revisionId);
    const sessionPath = path.join(revisionDirectory, "session.json.gz");
    await enforceOwnerOnlyPathPermissionsStrict(revisionDirectory, "directory");
    await enforceOwnerOnlyPathPermissionsStrict(sessionPath, "file");
    const compressedStats = await fs.lstat(sessionPath);
    if (
      !compressedStats.isFile() ||
      compressedStats.size > PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES
    ) {
      throw new PublicShareRevisionLimitError();
    }
    let snapshotBytes = 0;
    const decompressedMeter = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        snapshotBytes += bytes.length;
        if (snapshotBytes > PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES) {
          callback(new PublicShareRevisionLimitError());
          return;
        }
        callback(null, bytes);
      },
    });
    return createReadStream(sessionPath, {
      highWaterMark: PUBLIC_SHARE_REVISION_STREAM_CHUNK_MAX_BYTES,
    })
      .pipe(
        createGunzip({
          chunkSize: PUBLIC_SHARE_REVISION_STREAM_CHUNK_MAX_BYTES,
        }),
      )
      .pipe(decompressedMeter);
  }

  async getRevisionSessionChunks(
    reference: PublicShareRevisionReference,
    revisionId: string,
  ): Promise<AsyncIterable<Uint8Array>> {
    const stream = await this.getRevisionSessionStream(reference, revisionId);
    return (async function* () {
      try {
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          for (
            let offset = 0;
            offset < bytes.byteLength;
            offset += PUBLIC_SHARE_REVISION_STREAM_CHUNK_MAX_BYTES
          ) {
            yield bytes.subarray(
              offset,
              Math.min(
                offset + PUBLIC_SHARE_REVISION_STREAM_CHUNK_MAX_BYTES,
                bytes.byteLength,
              ),
            );
          }
        }
      } finally {
        stream.destroy();
      }
    })();
  }

  async readRevisionSession(
    reference: PublicShareRevisionReference,
    revisionId: string,
  ): Promise<AppSession> {
    const descriptor = await this.getRevisionDescriptor(reference, revisionId);
    if (
      !descriptor ||
      !isPublicShareSessionTransferSizeWithinLimits(
        descriptor.compressedBytes,
        descriptor.snapshotBytes,
      )
    ) {
      throw new PublicShareRevisionLimitError();
    }
    const stream = await this.getRevisionSessionStream(reference, revisionId);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let json = "";
    let snapshotBytes = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        snapshotBytes += bytes.length;
        if (snapshotBytes > descriptor.snapshotBytes) {
          throw new Error("Public share revision size mismatch");
        }
        json += decoder.decode(bytes, { stream: true });
      }
      if (snapshotBytes !== descriptor.snapshotBytes) {
        throw new Error("Public share revision size mismatch");
      }
      json += decoder.decode();
    } finally {
      stream.destroy();
    }
    return JSON.parse(json) as AppSession;
  }

  async readPresentation(
    reference: PublicShareRevisionReference,
    revisionId: string,
  ): Promise<PublicSharePresentation> {
    const revisionDirectory = this.getRevisionDirectory(reference, revisionId);
    const presentationPath = path.join(revisionDirectory, "presentation.json");
    await enforceOwnerOnlyPathPermissionsStrict(revisionDirectory, "directory");
    await enforceOwnerOnlyPathPermissionsStrict(presentationPath, "file");
    return JSON.parse(
      await fs.readFile(presentationPath, "utf8"),
    ) as PublicSharePresentation;
  }

  async getRevisionProjectRoot(
    reference: PublicShareRevisionReference,
    revisionId: string,
  ): Promise<string> {
    const projectRoot = path.join(
      this.getRevisionDirectory(reference, revisionId),
      "project",
    );
    await enforceOwnerOnlyPathPermissionsStrict(projectRoot, "directory");
    return projectRoot;
  }

  async collectUnreferenced(
    shareStateId: string,
    referencedRevisionIds: ReadonlySet<string> | null,
  ): Promise<void> {
    const stateDirectory = path.join(this.sharesPath, shareStateId);
    if (referencedRevisionIds === null) {
      await fs.rm(stateDirectory, { recursive: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      return;
    }

    let state: PublicShareStateFile;
    try {
      const statePath = this.statePath(shareStateId);
      await enforceOwnerOnlyPathPermissionsStrict(stateDirectory, "directory");
      await enforceOwnerOnlyPathPermissionsStrict(statePath, "file");
      state = JSON.parse(
        await fs.readFile(statePath, "utf8"),
      ) as PublicShareStateFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const frozenDirectory = path.join(stateDirectory, "frozen");
    let children: Dirent[] = [];
    try {
      await enforceOwnerOnlyPathPermissionsStrict(frozenDirectory, "directory");
      children = await fs.readdir(frozenDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const child of children) {
      const isTemporary = child.name.startsWith(".tmp-");
      const isRevision = REVISION_ID_REGEX.test(child.name);
      if (!isTemporary && !isRevision) {
        throw new Error(
          `Invalid public share frozen entry ${shareStateId}/${child.name}`,
        );
      }
      if (!isTemporary && referencedRevisionIds.has(child.name)) continue;
      await fs.rm(path.join(frozenDirectory, child.name), { recursive: true });
    }

    const revisions = Object.fromEntries(
      Object.entries(state.revisions).filter(([revisionId]) =>
        referencedRevisionIds.has(revisionId),
      ),
    );
    if (Object.keys(revisions).length !== Object.keys(state.revisions).length) {
      await this.writeState({
        ...state,
        updatedAt: new Date().toISOString(),
        revisions,
      });
    }
  }

  async commitLegacyRevision(
    options: CommitLegacyPublicShareRevisionOptions,
  ): Promise<PublicShareRevision> {
    const state = await this.loadOrCreateState(
      options.shareStateId,
      options.source,
      options.capturedAt,
    );
    const frozenRoot = path.join(
      this.sharesPath,
      options.shareStateId,
      "frozen",
    );
    await ensurePrivateDirectory(frozenRoot);
    const temporaryDirectory = path.join(
      frozenRoot,
      `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    await ensurePrivateDirectory(temporaryDirectory);
    const temporarySessionPath = path.join(
      temporaryDirectory,
      "session.json.gz",
    );
    const contentHash = createHash("sha256");
    let snapshotBytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        snapshotBytes += bytes.length;
        if (snapshotBytes > PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES) {
          callback(new PublicShareRevisionLimitError());
          return;
        }
        contentHash.update(bytes);
        callback(null, bytes);
      },
    });
    let compressedBytes = 0;
    const compressedMeter = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        compressedBytes += bytes.length;
        if (compressedBytes > PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES) {
          callback(new PublicShareRevisionLimitError());
          return;
        }
        callback(null, bytes);
      },
    });
    try {
      await preparePrivateFile(temporarySessionPath);
      await pipeline(
        createReadStream(options.bodyPath),
        meter,
        createGzip(),
        compressedMeter,
        createWriteStream(temporarySessionPath, { mode: 0o600 }),
      );
      const projectRoot = Buffer.from(
        options.source.projectId,
        "base64url",
      ).toString("utf8");
      const authorizedPaths = await collectLegacyAuthorizedPaths(
        options.bodyPath,
        projectRoot,
        options.source.projectId,
      );
      contentHash.update("\0presentation\0");
      contentHash.update(
        serializePublicSharePresentation({ version: 1, authorizedPaths }),
      );
      const integrityWitness = contentHash.digest("base64url");
      const revisionId = integrityWitness;
      const finalDirectory = path.join(frozenRoot, revisionId);
      const existing = state.revisions[revisionId];
      if (existing) {
        const validated = await this.validateRevisionDirectory({
          revisionId,
          finalDirectory,
          linkedFileMode: existing.linkedFileMode,
          expectedSnapshotBytes: snapshotBytes,
          expectedIntegrityWitness: integrityWitness,
        });
        if (
          validated.compressedBytes !== existing.compressedBytes ||
          existing.snapshotBytes !== validated.snapshotBytes ||
          (existing.integrityWitness !== undefined &&
            existing.integrityWitness !== validated.integrityWitness)
        ) {
          throw new Error(
            `Public share revision ${revisionId} has conflicting metadata`,
          );
        }
        const verified = existing.integrityWitness
          ? existing
          : { ...existing, integrityWitness: validated.integrityWitness };
        if (verified !== existing) {
          await this.writeState({
            ...state,
            revisions: { ...state.revisions, [revisionId]: verified },
          });
        }
        await fs.rm(temporaryDirectory, { recursive: true });
        return verified;
      }
      const orphaned = await this.adoptOrphanedRevision({
        state,
        revisionId,
        finalDirectory,
        capturedAt: options.capturedAt,
        snapshotBytes,
        integrityWitness,
        linkedFileMode: "live",
      });
      if (orphaned) {
        await fs.rm(temporaryDirectory, { recursive: true });
        return orphaned;
      }
      await this.writeJson(path.join(temporaryDirectory, "presentation.json"), {
        version: 1,
        authorizedPaths,
      } satisfies PublicSharePresentation);
      if ((await fs.stat(temporarySessionPath)).size !== compressedBytes) {
        throw new Error("Public share compressed revision size changed");
      }
      await fs.rename(temporaryDirectory, finalDirectory);
      await syncDirectory(frozenRoot);
      const revision: PublicShareRevision = {
        revisionId,
        capturedAt: options.capturedAt,
        linkedFileMode: "live",
        snapshotBytes,
        compressedBytes,
        integrityWitness,
      };
      await this.writeState({
        ...state,
        updatedAt: options.capturedAt,
        revisions: { ...state.revisions, [revisionId]: revision },
      });
      return revision;
    } catch (error) {
      await fs
        .rm(temporaryDirectory, { recursive: true })
        .catch(() => undefined);
      throw error;
    }
  }

  async commitRevision(
    options: CommitPublicShareRevisionOptions,
  ): Promise<PublicShareRevision> {
    const state = await this.loadOrCreateState(
      options.shareStateId,
      options.source,
      options.capturedAt,
    );
    const frozenRoot = path.join(
      this.sharesPath,
      options.shareStateId,
      "frozen",
    );
    await ensurePrivateDirectory(frozenRoot);
    const temporaryDirectory = path.join(
      frozenRoot,
      `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    await ensurePrivateDirectory(temporaryDirectory);
    const temporarySessionPath = path.join(
      temporaryDirectory,
      "session.json.gz",
    );
    const contentHash = createHash("sha256");
    let snapshotBytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        snapshotBytes += bytes.length;
        if (snapshotBytes > PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES) {
          callback(new PublicShareRevisionLimitError());
          return;
        }
        contentHash.update(bytes);
        callback(null, bytes);
      },
    });
    let compressedBytes = 0;
    const compressedMeter = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        compressedBytes += bytes.length;
        if (compressedBytes > PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES) {
          callback(new PublicShareRevisionLimitError());
          return;
        }
        callback(null, bytes);
      },
    });
    try {
      await preparePrivateFile(temporarySessionPath);
      await pipeline(
        Readable.from(serializeJson(options.snapshot)),
        meter,
        createGzip(),
        compressedMeter,
        createWriteStream(temporarySessionPath, { mode: 0o600 }),
      );
      if (
        (await fs.stat(temporarySessionPath)).size !== compressedBytes ||
        !isPublicShareSessionTransferSizeWithinLimits(
          compressedBytes,
          snapshotBytes,
        )
      ) {
        throw new PublicShareRevisionLimitError();
      }
      const persistedSourceRevision = contentHash.copy().digest("base64url");
      if (persistedSourceRevision !== options.sourceRevision) {
        throw new Error(
          "Public share session changed after its source revision was captured",
        );
      }
      let linkedFileMode: PublicShareLinkedFileMode = "live";
      let presentation = options.presentation ?? {
        version: 1 as const,
        authorizedPaths: [],
      };
      if (options.projectRoot) {
        const capturedProjectRoot = path.join(temporaryDirectory, "project");
        linkedFileMode = await cloneTreeCopyOnWrite(
          options.projectRoot,
          capturedProjectRoot,
          this.root,
          this.hooks,
        );
        if (
          linkedFileMode === "cow" &&
          options.derivePresentationFromProjectRoot
        ) {
          presentation =
            await options.derivePresentationFromProjectRoot(
              capturedProjectRoot,
            );
        }
      }
      contentHash.update("\0presentation\0");
      contentHash.update(serializePublicSharePresentation(presentation));
      const integrityWitness = contentHash.copy().digest("base64url");
      if (options.projectRoot) {
        // The revision identity must distinguish as-of worktree snapshots even
        // when the transcript and presentation bytes remain unchanged.
        contentHash.update("\0project-capture\0");
        contentHash.update(randomBytes(32));
      }
      const revisionId = contentHash.digest("base64url");
      const finalDirectory = path.join(frozenRoot, revisionId);
      const existing = state.revisions[revisionId];
      if (existing) {
        const validated = await this.validateRevisionDirectory({
          revisionId,
          finalDirectory,
          linkedFileMode: existing.linkedFileMode,
          expectedSnapshotBytes: snapshotBytes,
          expectedIntegrityWitness: integrityWitness,
        });
        if (
          validated.compressedBytes !== existing.compressedBytes ||
          existing.snapshotBytes !== validated.snapshotBytes ||
          (existing.integrityWitness !== undefined &&
            existing.integrityWitness !== validated.integrityWitness)
        ) {
          throw new Error(
            `Public share revision ${revisionId} has conflicting metadata`,
          );
        }
        const verified = existing.integrityWitness
          ? existing
          : { ...existing, integrityWitness: validated.integrityWitness };
        if (verified !== existing) {
          await this.writeState({
            ...state,
            revisions: { ...state.revisions, [revisionId]: verified },
          });
        }
        await fs.rm(temporaryDirectory, { recursive: true });
        return verified;
      }
      const orphaned = options.projectRoot
        ? null
        : await this.adoptOrphanedRevision({
            state,
            revisionId,
            finalDirectory,
            capturedAt: options.capturedAt,
            snapshotBytes,
            integrityWitness,
            linkedFileMode: "live",
          });
      if (orphaned) {
        await fs.rm(temporaryDirectory, { recursive: true });
        return orphaned;
      }

      await this.writeJson(
        path.join(temporaryDirectory, "presentation.json"),
        presentation,
      );
      await fs.rename(temporaryDirectory, finalDirectory);
      await syncDirectory(frozenRoot);
      const revision: PublicShareRevision = {
        revisionId,
        capturedAt: options.capturedAt,
        linkedFileMode,
        snapshotBytes,
        compressedBytes,
        integrityWitness,
      };
      await this.writeState({
        ...state,
        updatedAt: options.capturedAt,
        revisions: { ...state.revisions, [revisionId]: revision },
      });
      return revision;
    } catch (error) {
      await fs
        .rm(temporaryDirectory, { recursive: true })
        .catch(() => undefined);
      throw error;
    }
  }

  private async validateRevisionDirectory(options: {
    revisionId: string;
    finalDirectory: string;
    linkedFileMode?: PublicShareLinkedFileMode;
    expectedSnapshotBytes: number;
    expectedIntegrityWitness: string;
  }): Promise<{
    compressedBytes: number;
    snapshotBytes: number;
    integrityWitness: string;
    linkedFileMode: PublicShareLinkedFileMode;
  }> {
    await enforceOwnerOnlyPathPermissionsStrict(
      options.finalDirectory,
      "directory",
    );
    const sessionPath = path.join(options.finalDirectory, "session.json.gz");
    const presentationPath = path.join(
      options.finalDirectory,
      "presentation.json",
    );
    await enforceOwnerOnlyPathPermissionsStrict(sessionPath, "file");
    await enforceOwnerOnlyPathPermissionsStrict(presentationPath, "file");
    const sessionStats = await fs.lstat(sessionPath);
    if (
      !sessionStats.isFile() ||
      sessionStats.size > PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES ||
      options.expectedSnapshotBytes >
        PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES
    ) {
      throw new PublicShareRevisionLimitError();
    }
    const presentation = JSON.parse(
      await fs.readFile(presentationPath, "utf8"),
    ) as Partial<PublicSharePresentation>;
    if (
      presentation.version !== 1 ||
      !Array.isArray(presentation.authorizedPaths) ||
      !presentation.authorizedPaths.every((entry) => typeof entry === "string")
    ) {
      throw new Error(
        `Invalid public share presentation ${options.revisionId}`,
      );
    }

    const integrityHash = createHash("sha256");
    let snapshotBytes = 0;
    for await (const chunk of createReadStream(sessionPath).pipe(
      createGunzip(),
    )) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      snapshotBytes += bytes.length;
      if (snapshotBytes > PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES) {
        throw new PublicShareRevisionLimitError();
      }
      if (snapshotBytes > options.expectedSnapshotBytes) {
        throw new Error(
          `Public share revision ${options.revisionId} failed content verification`,
        );
      }
      integrityHash.update(bytes);
    }
    integrityHash.update("\0presentation\0");
    integrityHash.update(
      serializePublicSharePresentation(presentation as PublicSharePresentation),
    );
    const integrityWitness = integrityHash.digest("base64url");
    if (
      snapshotBytes !== options.expectedSnapshotBytes ||
      integrityWitness !== options.expectedIntegrityWitness
    ) {
      throw new Error(
        `Public share revision ${options.revisionId} failed content verification`,
      );
    }

    const projectPath = path.join(options.finalDirectory, "project");
    const projectExists = await enforceOwnerOnlyPathPermissionsStrict(
      projectPath,
      "directory",
    )
      .then(() => true)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
    if (options.linkedFileMode === "cow" && !projectExists) {
      throw new Error(
        `Public share revision ${options.revisionId} is missing its project clone`,
      );
    }
    if (options.linkedFileMode === "live" && projectExists) {
      throw new Error(
        `Public share revision ${options.revisionId} has an unexpected project clone`,
      );
    }
    return {
      compressedBytes: sessionStats.size,
      snapshotBytes,
      integrityWitness,
      linkedFileMode:
        options.linkedFileMode ?? (projectExists ? "cow" : "live"),
    };
  }

  private async adoptOrphanedRevision(options: {
    state: PublicShareStateFile;
    revisionId: string;
    finalDirectory: string;
    capturedAt: string;
    snapshotBytes: number;
    integrityWitness: string;
    linkedFileMode?: PublicShareLinkedFileMode;
  }): Promise<PublicShareRevision | null> {
    try {
      await enforceOwnerOnlyPathPermissionsStrict(
        options.finalDirectory,
        "directory",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const validated = await this.validateRevisionDirectory({
      revisionId: options.revisionId,
      finalDirectory: options.finalDirectory,
      linkedFileMode: options.linkedFileMode,
      expectedSnapshotBytes: options.snapshotBytes,
      expectedIntegrityWitness: options.integrityWitness,
    });
    const revision: PublicShareRevision = {
      revisionId: options.revisionId,
      capturedAt: options.capturedAt,
      linkedFileMode: validated.linkedFileMode,
      snapshotBytes: validated.snapshotBytes,
      compressedBytes: validated.compressedBytes,
      integrityWitness: validated.integrityWitness,
    };
    await this.writeState({
      ...options.state,
      updatedAt: options.capturedAt,
      revisions: {
        ...options.state.revisions,
        [options.revisionId]: revision,
      },
    });
    return revision;
  }

  private async loadOrCreateState(
    shareStateId: string,
    source: PublicShareSource,
    now: string,
  ): Promise<PublicShareStateFile> {
    const statePath = this.statePath(shareStateId);
    try {
      await enforceOwnerOnlyPathPermissionsStrict(
        path.dirname(statePath),
        "directory",
      );
      await enforceOwnerOnlyPathPermissionsStrict(statePath, "file");
      const state = JSON.parse(
        await fs.readFile(statePath, "utf8"),
      ) as PublicShareStateFile;
      if (
        state.version !== 2 ||
        state.shareStateId !== shareStateId ||
        !sourceMatches(state.source, source) ||
        !state.revisions ||
        typeof state.revisions !== "object" ||
        Array.isArray(state.revisions) ||
        !Object.entries(state.revisions).every(
          ([revisionId, revision]) =>
            REVISION_ID_REGEX.test(revisionId) &&
            revision.revisionId === revisionId &&
            typeof revision.capturedAt === "string" &&
            (revision.linkedFileMode === "cow" ||
              revision.linkedFileMode === "live") &&
            Number.isSafeInteger(revision.snapshotBytes) &&
            revision.snapshotBytes >= 0 &&
            Number.isSafeInteger(revision.compressedBytes) &&
            revision.compressedBytes >= 0 &&
            (revision.integrityWitness === undefined ||
              (typeof revision.integrityWitness === "string" &&
                REVISION_ID_REGEX.test(revision.integrityWitness))),
        )
      ) {
        throw new Error(`Conflicting public share state ${shareStateId}`);
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const state: PublicShareStateFile = {
        version: 2,
        shareStateId,
        source,
        createdAt: now,
        updatedAt: now,
        revisions: {},
      };
      await this.writeState(state);
      return state;
    }
  }

  private statePath(shareStateId: string): string {
    return path.join(this.sharesPath, shareStateId, "state.json");
  }

  private async writeState(state: PublicShareStateFile): Promise<void> {
    await this.writeJson(this.statePath(state.shareStateId), state);
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await atomicWritePublicShareJson(filePath, value, this.hooks);
  }
}
