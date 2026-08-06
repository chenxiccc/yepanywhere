import {
  PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH,
  PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
  PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES,
  PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES,
  PUBLIC_SHARE_TITLE_MAX_LENGTH,
  isPublicShareSessionTransferSizeWithinLimits,
  type AppSession,
  type ProviderName,
  type PublicSessionShareMode,
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
import {
  collectLegacyAuthorizedPaths,
  inspectLegacySessionBody,
  type LegacyPublicShareRecord,
  type LegacySessionBody,
  readLegacyPublicShareRecords,
} from "./LegacyPublicShareReader.js";

export type PublicShareStoreReadiness =
  | "opening"
  | "migrating"
  | "ready"
  | "failed"
  | "disabled";

export type PublicShareLinkedFileMode = "cow" | "live";
export type PublicShareRepresentationAvailability =
  | "available"
  | "repair-required";

export interface PublicShareSource {
  projectId: UrlProjectId;
  sessionId: string;
  projectName?: string;
  provider?: ProviderName;
}

export interface PublicShareViewerSnapshot {
  capturedAt: string;
  revisionId?: string;
  linkedFileMode?: PublicShareLinkedFileMode;
  snapshotBytes: number;
  availability?: PublicShareRepresentationAvailability;
}

export interface PublicShareGrant {
  version: 2;
  shareId: string;
  secretHash: string;
  publicUrl?: string;
  shareStateId: string;
  mode: PublicSessionShareMode;
  title: string | null;
  initialPrompt: string | null;
  createdAt: string;
  updatedAt: string;
  capturedAt?: string;
  source: PublicShareSource;
  revisionId?: string;
  linkedFileMode?: PublicShareLinkedFileMode;
  snapshotBytes?: number;
  primaryAvailability?: PublicShareRepresentationAvailability;
  repairRequired?: boolean;
  disconnectedViewerIds?: string[];
  viewerSnapshots?: Record<string, PublicShareViewerSnapshot>;
}

export interface PublicSharePresentation {
  version: 1;
  authorizedPaths: string[];
}

export interface PublicShareStoredCapture {
  snapshot: AppSession;
  sourceRevision: string;
  presentation?: PublicSharePresentation;
  projectRoot?: string;
  derivePresentationFromProjectRoot?: (
    projectRoot: string,
  ) => Promise<PublicSharePresentation>;
  validateBeforeAuthority: () => Promise<void>;
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

interface PublicShareGrantFile {
  version: 2;
  grants: PublicShareGrant[];
}

interface PublicShareCleanupJournal {
  version: 1;
  shareStateIds: string[];
}

export interface PublicShareStoreTestHooks {
  beforeAtomicRename?: (filePath: string) => Promise<void> | void;
  afterAtomicRename?: (filePath: string) => Promise<void> | void;
  beforeCowEntryOpen?: (sourcePath: string) => Promise<void> | void;
  legacySessionMaxBytes?: number;
}

export interface CreateStoredGrantOptions {
  secretHash: string;
  publicUrl?: string;
  mode: PublicSessionShareMode;
  title: string | null;
  initialPrompt: string | null;
  source: PublicShareSource;
  capture?: PublicShareStoredCapture;
}

export interface StoredGrantResult {
  grant: PublicShareGrant;
  revision?: PublicShareRevision;
}

export interface FreezeStoredGrantsOptions {
  matches: (grant: PublicShareGrant) => boolean;
  capture: PublicShareStoredCapture;
  viewerId?: string;
}

export const PUBLIC_SHARE_REVISION_STREAM_CHUNK_MAX_BYTES = 64 * 1024;

const EMPTY_GRANT_FILE: PublicShareGrantFile = { version: 2, grants: [] };
const OPAQUE_ID_REGEX = /^[A-Za-z0-9_-]{16,128}$/;
const REVISION_ID_REGEX = /^[A-Za-z0-9_-]{43}$/;
const SECRET_HASH_REGEX = /^[A-Za-z0-9_-]{86}$/;
const VIEWER_ID_REGEX = /^[A-Za-z0-9_-]{8,128}$/;
const UNSUPPORTED_COW_CODES = new Set([
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EXDEV",
]);

class PublicShareRevisionLimitError extends Error {
  constructor() {
    super("Public share session exceeds frozen transfer limit");
    this.name = "PublicShareRevisionLimitError";
  }
}

function sourceMatches(a: PublicShareSource, b: PublicShareSource): boolean {
  return a.projectId === b.projectId && a.sessionId === b.sessionId;
}

export function getPublicShareViewerSnapshot(
  grant: Pick<PublicShareGrant, "viewerSnapshots">,
  viewerId: string | undefined,
): PublicShareViewerSnapshot | undefined {
  const snapshots = grant.viewerSnapshots;
  if (!viewerId || !snapshots) return undefined;
  return Object.getOwnPropertyDescriptor(snapshots, viewerId)?.value;
}

function copyViewerSnapshots(
  snapshots: PublicShareGrant["viewerSnapshots"],
): NonNullable<PublicShareGrant["viewerSnapshots"]> {
  return Object.assign(Object.create(null), snapshots);
}

function isValidGrantText(value: unknown, maxLength: number): boolean {
  return (
    value === null || (typeof value === "string" && value.length <= maxLength)
  );
}

function withDowngradeRepairMarker(grant: PublicShareGrant): PublicShareGrant {
  const repairRequired =
    grant.primaryAvailability === "repair-required" ||
    Object.values(grant.viewerSnapshots ?? {}).some(
      (snapshot) => snapshot.availability === "repair-required",
    );
  if (repairRequired) {
    return grant.repairRequired ? grant : { ...grant, repairRequired: true };
  }
  if (grant.repairRequired === undefined) return grant;
  const { repairRequired: _repairRequired, ...withoutRepairMarker } = grant;
  return withoutRepairMarker;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await enforceOwnerOnlyPathPermissionsStrict(directory, "directory");
}

async function preparePrivateFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o600);
  await handle.close();
  await enforceOwnerOnlyPathPermissionsStrict(filePath, "file");
}

async function removeOwnedAtomicControlTemps(
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

async function syncDirectory(directory: string): Promise<void> {
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

class AtomicWriteError extends Error {
  constructor(
    message: string,
    readonly committed: boolean,
    options: ErrorOptions,
  ) {
    super(message, options);
  }
}

function atomicWriteCommitted(error: unknown): boolean {
  return error instanceof AtomicWriteError && error.committed;
}

async function atomicWriteJson(
  filePath: string,
  value: unknown,
  hooks: PublicShareStoreTestHooks,
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
    throw new AtomicWriteError("Failed to write private JSON", false, {
      cause: error,
    });
  }
  await handle.close();
  try {
    await hooks.beforeAtomicRename?.(filePath);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath).catch(() => undefined);
    throw new AtomicWriteError("Failed to commit private JSON", false, {
      cause: error,
    });
  }
  try {
    await hooks.afterAtomicRename?.(filePath);
    await syncDirectory(directory);
  } catch (error) {
    throw new AtomicWriteError("Failed to sync committed private JSON", true, {
      cause: error,
    });
  }
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
  hooks: PublicShareStoreTestHooks,
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

export class PublicShareStore {
  private readonly root: string;
  private readonly legacyPath: string;
  private readonly legacyBackupPath: string;
  private readonly migrationPath: string;
  private readonly grantsPath: string;
  private readonly cleanupPath: string;
  private readonly sharesPath: string;
  private readonly testHooks: PublicShareStoreTestHooks;
  private grants = new Map<string, PublicShareGrant>();
  private cleanupJournal = new Set<string>();
  private readiness: PublicShareStoreReadiness = "opening";
  private readinessError: string | null = null;
  private desiredEnabled = true;
  private disableRequired = false;
  private lifecycleRequest = 0;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private openPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(dataDir: string, testHooks: PublicShareStoreTestHooks = {}) {
    this.testHooks = testHooks;
    this.root = path.join(dataDir, "public-shares");
    this.legacyPath = path.join(dataDir, "public-shares.json");
    this.legacyBackupPath = path.join(
      dataDir,
      "public-shares.legacy-backup.json",
    );
    this.migrationPath = path.join(this.root, "migration.json");
    this.grantsPath = path.join(this.root, "grants.json");
    this.cleanupPath = path.join(this.root, "cleanup.json");
    this.sharesPath = path.join(this.root, "shares");
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await atomicWriteJson(filePath, value, this.testHooks);
  }

  getReadiness(): { state: PublicShareStoreReadiness; error: string | null } {
    return { state: this.readiness, error: this.readinessError };
  }

  isCleanupPending(): boolean {
    return this.cleanupJournal.size > 0;
  }

  initialize(enabled = true): Promise<void> {
    return this.requestLifecycle(enabled, !enabled, async (request) => {
      await this.ensureOpened();
      if (enabled) {
        if (this.disableRequired) await this.reconcileDisabled(request);
        if (!this.isCurrentLifecycleRequest(request, true)) return;
        await this.reconcileEnabled(request);
      } else {
        await this.reconcileDisabled(request);
      }
    });
  }

  disable(): Promise<number> {
    return this.requestLifecycle(false, true, async (request) => {
      await this.ensureOpened();
      return await this.reconcileDisabled(request);
    });
  }

  enable(): Promise<void> {
    return this.requestLifecycle(true, false, async (request) => {
      await this.ensureOpened();
      if (this.disableRequired) await this.reconcileDisabled(request);
      if (!this.isCurrentLifecycleRequest(request, true)) return;
      await this.reconcileEnabled(request);
    });
  }

  private requestLifecycle<T>(
    enabled: boolean,
    mustApply: boolean,
    operation: (request: number) => Promise<T>,
  ): Promise<T> {
    this.desiredEnabled = enabled;
    if (!enabled) this.disableRequired = true;
    const request = ++this.lifecycleRequest;
    this.readiness = "opening";
    this.readinessError = null;
    const previous = this.lifecycleTail;
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        if (!mustApply && !this.isCurrentLifecycleRequest(request, enabled)) {
          return undefined as T;
        }
        try {
          return await operation(request);
        } catch (error) {
          this.readiness = "failed";
          this.readinessError =
            error instanceof Error
              ? error.message
              : "Failed to change public share store state";
          throw error;
        }
      });
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isCurrentLifecycleRequest(
    request: number,
    enabled: boolean,
  ): boolean {
    return this.lifecycleRequest === request && this.desiredEnabled === enabled;
  }

  private async ensureOpened(): Promise<void> {
    this.openPromise ??= this.openControlState();
    await this.openPromise;
  }

  private async openControlState(): Promise<void> {
    await ensurePrivateDirectory(this.root);
    await removeOwnedAtomicControlTemps(this.root, [
      "grants.json",
      "cleanup.json",
      "migration.json",
    ]);
    await ensurePrivateDirectory(this.sharesPath);
    let grantFile = EMPTY_GRANT_FILE;
    try {
      await enforceOwnerOnlyPathPermissionsStrict(this.grantsPath, "file");
      grantFile = JSON.parse(
        await fs.readFile(this.grantsPath, "utf8"),
      ) as PublicShareGrantFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.writeJson(this.grantsPath, EMPTY_GRANT_FILE);
    }
    if (
      grantFile.version !== 2 ||
      !Array.isArray(grantFile.grants) ||
      !grantFile.grants.every((grant) => this.isGrant(grant))
    ) {
      throw new Error("Invalid public share grant store");
    }
    const secretHashes = new Set(
      grantFile.grants.map((grant) => grant.secretHash),
    );
    const shareIds = new Set(grantFile.grants.map((grant) => grant.shareId));
    const sourceStates = new Map<string, string>();
    for (const grant of grantFile.grants) {
      const sourceKey = JSON.stringify([
        grant.source.projectId,
        grant.source.sessionId,
      ]);
      const existingState = sourceStates.get(sourceKey);
      if (existingState && existingState !== grant.shareStateId) {
        throw new Error(
          "Public share grants assign one source session to multiple states",
        );
      }
      sourceStates.set(sourceKey, grant.shareStateId);
    }
    if (
      secretHashes.size !== grantFile.grants.length ||
      shareIds.size !== grantFile.grants.length
    ) {
      throw new Error("Duplicate public share grant identifier");
    }
    this.grants = new Map(
      grantFile.grants.map((grant) => [grant.secretHash, grant]),
    );
    await this.loadCleanupJournal();
  }

  private async reconcileDisabled(request: number): Promise<number> {
    return await this.withMutation(async () => {
      await this.writeJson(this.migrationPath, {
        version: 1,
        status: "disabled",
        completedAt: new Date().toISOString(),
        legacyBackup: path.basename(this.legacyBackupPath),
      });
      const revoked = [...this.grants.values()];
      await this.enqueueCleanup(revoked.map((grant) => grant.shareStateId));
      this.grants.clear();
      if (revoked.length > 0) {
        try {
          await this.writeGrants();
        } catch (error) {
          if (!atomicWriteCommitted(error)) {
            for (const grant of revoked) {
              this.grants.set(grant.secretHash, grant);
            }
          }
          throw error;
        }
      }
      await this.moveLegacySourceToBackup();
      await this.drainCleanupJournal(false);
      this.disableRequired = false;
      if (this.isCurrentLifecycleRequest(request, false)) {
        this.readiness = "disabled";
        this.readinessError = null;
      }
      return revoked.length;
    });
  }

  private async reconcileEnabled(request: number): Promise<void> {
    await this.withMutation(async () => {
      const migration = await this.readMigrationMarker();
      if (migration?.status === "disabled") {
        await this.finishInterruptedDisable();
        if (!this.isCurrentLifecycleRequest(request, true)) return;
        await this.writeJson(this.migrationPath, {
          version: 1,
          status: "complete",
          completedAt: new Date().toISOString(),
          legacyBackup: (await this.privateFileExists(this.legacyBackupPath))
            ? path.basename(this.legacyBackupPath)
            : null,
        });
      } else {
        await this.drainCleanupJournal(false);
        await this.upgradeGrantAvailability();
        if (!this.isCurrentLifecycleRequest(request, true)) return;
        const legacyExists = await this.privateFileExists(this.legacyPath);
        const backupExists = await this.privateFileExists(
          this.legacyBackupPath,
        );
        if (migration?.status === "complete") {
          if (legacyExists) {
            throw new Error(
              "Legacy public share source remains after completed migration",
            );
          }
        } else if (legacyExists || backupExists) {
          this.readiness = "migrating";
          const completed = await this.migrateLegacy(
            legacyExists ? this.legacyPath : this.legacyBackupPath,
            () => this.isCurrentLifecycleRequest(request, true),
          );
          if (!completed) return;
        } else {
          await this.writeJson(this.migrationPath, {
            version: 1,
            status: "complete",
            completedAt: new Date().toISOString(),
            legacyBackup: null,
          });
        }
      }
      await this.drainCleanupJournal(false);
      if (this.isCurrentLifecycleRequest(request, true)) {
        this.readiness = "ready";
        this.readinessError = null;
      }
    });
  }

  private async finishInterruptedDisable(): Promise<void> {
    const revoked = [...this.grants.values()];
    await this.enqueueCleanup(revoked.map((grant) => grant.shareStateId));
    this.grants.clear();
    if (revoked.length > 0) {
      try {
        await this.writeGrants();
      } catch (error) {
        if (!atomicWriteCommitted(error)) {
          for (const grant of revoked) {
            this.grants.set(grant.secretHash, grant);
          }
        }
        throw error;
      }
    }
    await this.moveLegacySourceToBackup();
    await this.drainCleanupJournal(true);
  }

  private async moveLegacySourceToBackup(): Promise<void> {
    const legacyExists = await this.privateFileExists(this.legacyPath);
    const backupExists = await this.privateFileExists(this.legacyBackupPath);
    if (!legacyExists) return;
    if (backupExists) {
      throw new Error(
        "Cannot disable public shares while both legacy source and backup exist",
      );
    }
    await fs.rename(this.legacyPath, this.legacyBackupPath);
    await syncDirectory(path.dirname(this.legacyPath));
  }

  private async privateFileExists(filePath: string): Promise<boolean> {
    try {
      await enforceOwnerOnlyPathPermissionsStrict(filePath, "file");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  getAllGrants(): PublicShareGrant[] {
    return [...this.grants.values()];
  }

  getGrantBySecretHash(secretHash: string): PublicShareGrant | null {
    return this.grants.get(secretHash) ?? null;
  }

  async createGrant(
    options: CreateStoredGrantOptions,
  ): Promise<StoredGrantResult> {
    return await this.withMutation(async () => {
      this.assertReady();
      if (this.grants.has(options.secretHash)) {
        throw new Error("Public share secret hash is already in use");
      }
      if (
        !isValidGrantText(options.title, PUBLIC_SHARE_TITLE_MAX_LENGTH) ||
        !isValidGrantText(
          options.initialPrompt,
          PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH,
        )
      ) {
        throw new Error("Public share grant text is invalid");
      }
      const now = new Date().toISOString();
      const matchingGrant = [...this.grants.values()].find((grant) =>
        sourceMatches(grant.source, options.source),
      );
      const shareStateId =
        matchingGrant?.shareStateId ?? randomBytes(16).toString("base64url");
      let revision: PublicShareRevision | undefined;
      await this.enqueueCleanup([shareStateId]);
      try {
        if (options.mode === "frozen") {
          if (!options.capture) {
            throw new Error("Frozen shares require a complete session capture");
          }
          revision = await this.writeRevision({
            shareStateId,
            source: options.source,
            snapshot: options.capture.snapshot,
            sourceRevision: options.capture.sourceRevision,
            presentation: options.capture.presentation,
            projectRoot: options.capture.projectRoot,
            derivePresentationFromProjectRoot:
              options.capture.derivePresentationFromProjectRoot,
            capturedAt: now,
          });
          await options.capture.validateBeforeAuthority();
        } else {
          await this.ensureState(shareStateId, options.source, now);
        }
      } catch (error) {
        await this.drainCleanupJournal(false);
        throw error;
      }

      const grant: PublicShareGrant = {
        version: 2,
        shareId: randomBytes(12).toString("base64url"),
        secretHash: options.secretHash,
        ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
        shareStateId,
        mode: options.mode,
        title: options.title,
        initialPrompt: options.initialPrompt,
        createdAt: now,
        updatedAt: now,
        ...(revision
          ? {
              capturedAt: revision.capturedAt,
              revisionId: revision.revisionId,
              linkedFileMode: revision.linkedFileMode,
              snapshotBytes: revision.snapshotBytes,
              primaryAvailability: "available" as const,
            }
          : {}),
        source: options.source,
      };
      this.grants.set(grant.secretHash, grant);
      try {
        await this.writeGrants();
      } catch (error) {
        if (!atomicWriteCommitted(error)) {
          this.grants.delete(grant.secretHash);
        }
        await this.drainCleanupJournal(false);
        throw error;
      }
      await this.drainCleanupJournal(false);
      return { grant, revision };
    });
  }

  async revokeMatching(
    matches: (grant: PublicShareGrant) => boolean,
  ): Promise<PublicShareGrant[]> {
    return await this.withMutation(async () => {
      this.assertReady();
      const revoked = [...this.grants.values()].filter(matches);
      if (revoked.length === 0) return [];
      await this.enqueueCleanup(revoked.map((grant) => grant.shareStateId));
      for (const grant of revoked) {
        this.grants.delete(grant.secretHash);
      }
      try {
        await this.writeGrants();
      } catch (error) {
        if (!atomicWriteCommitted(error)) {
          for (const grant of revoked) {
            this.grants.set(grant.secretHash, grant);
          }
        }
        throw error;
      } finally {
        await this.drainCleanupJournal(false);
      }
      return revoked;
    });
  }

  async freezeMatching(
    options: FreezeStoredGrantsOptions,
  ): Promise<PublicShareGrant[]> {
    return await this.withMutation(async () => {
      this.assertReady();
      const matching = [...this.grants.values()].filter(
        (grant) => grant.mode === "live" && options.matches(grant),
      );
      if (matching.length === 0) return [];
      const first = matching[0]!;
      const now = new Date().toISOString();
      await this.enqueueCleanup([first.shareStateId]);
      let revision: PublicShareRevision;
      try {
        revision = await this.writeRevision({
          shareStateId: first.shareStateId,
          source: first.source,
          snapshot: options.capture.snapshot,
          sourceRevision: options.capture.sourceRevision,
          presentation: options.capture.presentation,
          projectRoot: options.capture.projectRoot,
          derivePresentationFromProjectRoot:
            options.capture.derivePresentationFromProjectRoot,
          capturedAt: now,
        });
        await options.capture.validateBeforeAuthority();
      } catch (error) {
        await this.drainCleanupJournal(false);
        throw error;
      }
      const previous = new Map(
        matching.map((grant) => [grant.secretHash, grant]),
      );
      for (const grant of matching) {
        const updated: PublicShareGrant = options.viewerId
          ? {
              ...grant,
              updatedAt: now,
              viewerSnapshots: {
                ...grant.viewerSnapshots,
                [options.viewerId]: {
                  capturedAt: now,
                  revisionId: revision.revisionId,
                  linkedFileMode: revision.linkedFileMode,
                  snapshotBytes: revision.snapshotBytes,
                  availability: "available",
                },
              },
            }
          : {
              ...grant,
              mode: "frozen",
              updatedAt: now,
              capturedAt: now,
              revisionId: revision.revisionId,
              linkedFileMode: revision.linkedFileMode,
              snapshotBytes: revision.snapshotBytes,
              primaryAvailability: "available",
              repairRequired: undefined,
              viewerSnapshots: undefined,
            };
        this.grants.set(updated.secretHash, updated);
      }
      try {
        await this.writeGrants();
      } catch (error) {
        if (!atomicWriteCommitted(error)) {
          for (const [secretHash, grant] of previous) {
            this.grants.set(secretHash, grant);
          }
        }
        await this.drainCleanupJournal(false);
        throw error;
      }
      await this.drainCleanupJournal(false);
      return matching.map((grant) => this.grants.get(grant.secretHash)!);
    });
  }

  async disconnectViewer(
    matches: (grant: PublicShareGrant) => boolean,
    viewerId: string,
  ): Promise<boolean> {
    return await this.withMutation(async () => {
      this.assertReady();
      const matching = [...this.grants.values()].filter(matches);
      const updates = new Map<string, PublicShareGrant>();
      for (const grant of matching) {
        const disconnectedViewerIds = new Set(
          grant.disconnectedViewerIds ?? [],
        );
        const hadViewer = disconnectedViewerIds.has(viewerId);
        disconnectedViewerIds.add(viewerId);
        const remainingSnapshots = copyViewerSnapshots(grant.viewerSnapshots);
        const removed =
          Object.getOwnPropertyDescriptor(remainingSnapshots, viewerId) !==
          undefined;
        delete remainingSnapshots[viewerId];
        if (!hadViewer || removed) {
          updates.set(grant.secretHash, {
            ...grant,
            disconnectedViewerIds: [...disconnectedViewerIds],
            viewerSnapshots:
              Object.keys(remainingSnapshots).length > 0
                ? remainingSnapshots
                : undefined,
          });
        }
      }
      if (updates.size === 0) return false;
      await this.enqueueCleanup(matching.map((grant) => grant.shareStateId));
      for (const [secretHash, grant] of updates) {
        this.grants.set(secretHash, grant);
      }
      try {
        await this.writeGrants();
      } catch (error) {
        if (!atomicWriteCommitted(error)) {
          for (const grant of matching) {
            this.grants.set(grant.secretHash, grant);
          }
        }
        throw error;
      } finally {
        await this.drainCleanupJournal(false);
      }
      return true;
    });
  }

  getRevisionDirectory(grant: PublicShareGrant, revisionId: string): string {
    return path.join(this.sharesPath, grant.shareStateId, "frozen", revisionId);
  }

  async getRevisionDescriptor(
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<PublicShareRevisionDescriptor | null> {
    if (!REVISION_ID_REGEX.test(revisionId)) {
      throw new Error("Invalid public share revision");
    }
    const stateDirectory = path.join(this.sharesPath, grant.shareStateId);
    const statePath = this.statePath(grant.shareStateId);
    await enforceOwnerOnlyPathPermissionsStrict(stateDirectory, "directory");
    await enforceOwnerOnlyPathPermissionsStrict(statePath, "file");
    const state = JSON.parse(
      await fs.readFile(statePath, "utf8"),
    ) as Partial<PublicShareStateFile>;
    const revision = state.revisions?.[revisionId];
    if (
      state.version !== 2 ||
      state.shareStateId !== grant.shareStateId ||
      !state.source ||
      !sourceMatches(state.source, grant.source) ||
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
    if (revision.integrityWitness === undefined) {
      return null;
    }

    const revisionDirectory = this.getRevisionDirectory(grant, revisionId);
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
    grant: PublicShareGrant,
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
    const descriptor = await this.getRevisionDescriptor(grant, revisionId);
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
      this.getRevisionDirectory(grant, revisionId),
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
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<Readable> {
    const revisionDirectory = this.getRevisionDirectory(grant, revisionId);
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
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<AsyncIterable<Uint8Array>> {
    const stream = await this.getRevisionSessionStream(grant, revisionId);
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
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<AppSession> {
    const descriptor = await this.getRevisionDescriptor(grant, revisionId);
    if (
      !descriptor ||
      !isPublicShareSessionTransferSizeWithinLimits(
        descriptor.compressedBytes,
        descriptor.snapshotBytes,
      )
    ) {
      throw new PublicShareRevisionLimitError();
    }
    const stream = await this.getRevisionSessionStream(grant, revisionId);
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
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<PublicSharePresentation> {
    const revisionDirectory = this.getRevisionDirectory(grant, revisionId);
    const presentationPath = path.join(revisionDirectory, "presentation.json");
    await enforceOwnerOnlyPathPermissionsStrict(revisionDirectory, "directory");
    await enforceOwnerOnlyPathPermissionsStrict(presentationPath, "file");
    return JSON.parse(
      await fs.readFile(presentationPath, "utf8"),
    ) as PublicSharePresentation;
  }

  async getRevisionProjectRoot(
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<string> {
    const projectRoot = path.join(
      this.getRevisionDirectory(grant, revisionId),
      "project",
    );
    await enforceOwnerOnlyPathPermissionsStrict(projectRoot, "directory");
    return projectRoot;
  }

  private async loadCleanupJournal(): Promise<void> {
    let journal: PublicShareCleanupJournal;
    try {
      await enforceOwnerOnlyPathPermissionsStrict(this.cleanupPath, "file");
      journal = JSON.parse(
        await fs.readFile(this.cleanupPath, "utf8"),
      ) as PublicShareCleanupJournal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journal = { version: 1, shareStateIds: [] };
      await this.writeJson(this.cleanupPath, journal);
    }
    if (
      journal.version !== 1 ||
      !Array.isArray(journal.shareStateIds) ||
      !journal.shareStateIds.every(
        (shareStateId) =>
          typeof shareStateId === "string" &&
          OPAQUE_ID_REGEX.test(shareStateId),
      )
    ) {
      throw new Error("Invalid public share cleanup journal");
    }
    this.cleanupJournal = new Set(journal.shareStateIds);
  }

  private async replaceCleanupJournal(candidate: Set<string>): Promise<void> {
    try {
      await this.writeJson(this.cleanupPath, {
        version: 1,
        shareStateIds: [...candidate].sort(),
      } satisfies PublicShareCleanupJournal);
      this.cleanupJournal = candidate;
    } catch (error) {
      if (atomicWriteCommitted(error)) this.cleanupJournal = candidate;
      throw error;
    }
  }

  private async enqueueCleanup(shareStateIds: string[]): Promise<void> {
    const candidate = new Set(this.cleanupJournal);
    for (const shareStateId of shareStateIds) candidate.add(shareStateId);
    if (candidate.size !== this.cleanupJournal.size) {
      await this.replaceCleanupJournal(candidate);
    }
  }

  private async drainCleanupJournal(required: boolean): Promise<void> {
    const pendingShareStateIds = Array.from(this.cleanupJournal);
    for (const shareStateId of pendingShareStateIds) {
      try {
        await this.collectUnreferenced([shareStateId]);
        const candidate = new Set(this.cleanupJournal);
        candidate.delete(shareStateId);
        await this.replaceCleanupJournal(candidate);
      } catch (error) {
        if (required) throw error;
      }
    }
    if (required && this.cleanupJournal.size > 0) {
      throw new Error("Public share cleanup remains pending");
    }
  }

  private async upgradeGrantAvailability(): Promise<void> {
    let changed = false;
    for (const grant of this.grants.values()) {
      let primaryAvailability = grant.primaryAvailability;
      if (grant.revisionId && primaryAvailability === undefined) {
        primaryAvailability = await this.inspectRevisionAvailability(
          grant,
          grant.revisionId,
        );
      }
      const viewerSnapshots = Object.fromEntries(
        await Promise.all(
          Object.entries(grant.viewerSnapshots ?? {}).map(
            async ([viewerId, snapshot]) => [
              viewerId,
              snapshot.availability === undefined
                ? {
                    ...snapshot,
                    availability: snapshot.revisionId
                      ? await this.inspectRevisionAvailability(
                          grant,
                          snapshot.revisionId,
                        )
                      : "repair-required",
                  }
                : snapshot,
            ],
          ),
        ),
      );
      const upgraded = withDowngradeRepairMarker({
        ...grant,
        ...(primaryAvailability ? { primaryAvailability } : {}),
        ...(Object.keys(viewerSnapshots).length > 0 ? { viewerSnapshots } : {}),
      });
      if (JSON.stringify(upgraded) !== JSON.stringify(grant)) {
        this.grants.set(upgraded.secretHash, upgraded);
        changed = true;
      }
    }
    if (changed) await this.writeGrants();
  }

  private async inspectRevisionAvailability(
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<PublicShareRepresentationAvailability> {
    const inspection = await inspectLegacySessionBody(
      await this.getRevisionSessionStream(grant, revisionId),
    );
    return inspection.repairRequired ? "repair-required" : "available";
  }

  private async readMigrationMarker(): Promise<{
    status: "complete" | "disabled";
  } | null> {
    try {
      await enforceOwnerOnlyPathPermissionsStrict(this.migrationPath, "file");
      const value = JSON.parse(
        await fs.readFile(this.migrationPath, "utf8"),
      ) as { version?: unknown; status?: unknown };
      if (
        value.version !== 1 ||
        (value.status !== "complete" && value.status !== "disabled")
      ) {
        throw new Error("Invalid public share migration marker");
      }
      return { status: value.status };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async migrateLegacy(
    sourcePath: string,
    shouldContinue: () => boolean,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const sourceBytes = (await fs.stat(sourcePath)).size;
    let peakHeapUsedBytes = process.memoryUsage().heapUsed;
    const temporaryDirectory = path.join(this.root, ".migration-work");
    await fs.rm(temporaryDirectory, { recursive: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await ensurePrivateDirectory(temporaryDirectory);
    let recordCount = 0;
    let migratedBodyBytes = 0;
    try {
      for await (const record of readLegacyPublicShareRecords(
        sourcePath,
        temporaryDirectory,
        this.testHooks.legacySessionMaxBytes,
      )) {
        if (!shouldContinue()) return false;
        const result = await this.importLegacyRecord(record);
        recordCount += 1;
        migratedBodyBytes += result.bodyBytes;
        peakHeapUsedBytes = Math.max(
          peakHeapUsedBytes,
          process.memoryUsage().heapUsed,
        );
        for (const body of [
          record.frozenSession,
          ...Object.values(record.viewerSnapshots ?? {}).map(
            (snapshot) => snapshot.body,
          ),
        ]) {
          if (body?.filePath) {
            await fs.rm(body.filePath).catch(() => undefined);
          }
        }
      }
      if (!shouldContinue()) return false;
      if (sourcePath === this.legacyPath) {
        const backupAlreadyExists = await fs
          .stat(this.legacyBackupPath)
          .then(() => true)
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return false;
            throw error;
          });
        if (backupAlreadyExists) {
          throw new Error(
            "Legacy public share backup already exists before migration rename",
          );
        }
        await fs.rename(this.legacyPath, this.legacyBackupPath);
        await enforceOwnerOnlyPathPermissionsStrict(
          this.legacyBackupPath,
          "file",
        );
        await syncDirectory(path.dirname(this.legacyPath));
      }
      await this.writeJson(this.migrationPath, {
        version: 1,
        status: "complete",
        completedAt: new Date().toISOString(),
        legacyBackup: path.basename(this.legacyBackupPath),
        recordCount,
        sourceByteOffset: sourceBytes,
        sourceBytes,
        migratedBodyBytes,
        elapsedMs: Date.now() - startedAt,
        peakHeapUsedBytes,
      });
      console.log(
        `[public-shares] Migrated ${recordCount} legacy grant(s), ${sourceBytes}/${sourceBytes} source byte(s), ${migratedBodyBytes} body byte(s), peak heap ${peakHeapUsedBytes} byte(s) in ${Date.now() - startedAt}ms`,
      );
      return true;
    } finally {
      await fs
        .rm(temporaryDirectory, { recursive: true })
        .catch(() => undefined);
    }
  }

  private async importLegacyRecord(
    record: LegacyPublicShareRecord,
  ): Promise<{ bodyBytes: number }> {
    const existing = this.grants.get(record.secretHash);
    if (existing) {
      if (
        existing.mode !== record.mode ||
        !sourceMatches(existing.source, record.source)
      ) {
        throw new Error(
          "Conflicting migrated public share grant for an existing secret hash",
        );
      }
      return { bodyBytes: 0 };
    }
    const matchingGrant = [...this.grants.values()].find((grant) =>
      sourceMatches(grant.source, record.source),
    );
    const shareStateId =
      matchingGrant?.shareStateId ?? randomBytes(16).toString("base64url");
    await this.enqueueCleanup([shareStateId]);
    let bodyBytes = 0;
    const importBody = async (
      body: LegacySessionBody,
      capturedAt: string,
    ): Promise<{
      revision?: PublicShareRevision;
      availability: PublicShareRepresentationAvailability;
    }> => {
      bodyBytes += body.snapshotBytes;
      if (body.oversized || !body.filePath) {
        await this.ensureState(shareStateId, record.source, capturedAt);
        return { availability: "repair-required" };
      }
      const inspection = await inspectLegacySessionBody(body.filePath);
      try {
        return {
          revision: await this.writeRawRevision({
            shareStateId,
            source: record.source,
            bodyPath: body.filePath,
            capturedAt,
          }),
          availability: inspection.repairRequired
            ? "repair-required"
            : "available",
        };
      } catch (error) {
        if (error instanceof PublicShareRevisionLimitError) {
          return { availability: "repair-required" };
        }
        throw error;
      }
    };

    let primaryRevision: PublicShareRevision | undefined;
    let primaryAvailability: PublicShareRepresentationAvailability | undefined;
    if (record.frozenSession) {
      const imported = await importBody(
        record.frozenSession,
        record.capturedAt ?? record.updatedAt,
      );
      primaryRevision = imported.revision;
      primaryAvailability = imported.availability;
    } else {
      await this.ensureState(shareStateId, record.source, record.createdAt);
    }
    const viewerSnapshots = copyViewerSnapshots(undefined);
    for (const [viewerId, snapshot] of Object.entries(
      record.viewerSnapshots ?? {},
    )) {
      const imported = await importBody(snapshot.body, snapshot.capturedAt);
      viewerSnapshots[viewerId] = {
        capturedAt: snapshot.capturedAt,
        snapshotBytes: snapshot.body.snapshotBytes,
        availability: imported.availability,
        ...(imported.revision
          ? {
              revisionId: imported.revision.revisionId,
              linkedFileMode: "live" as const,
            }
          : {}),
      };
    }
    const grant: PublicShareGrant = withDowngradeRepairMarker({
      version: 2,
      shareId: randomBytes(12).toString("base64url"),
      secretHash: record.secretHash,
      shareStateId,
      mode: record.mode,
      title: record.title ?? null,
      initialPrompt: null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      capturedAt: record.capturedAt,
      source: record.source,
      disconnectedViewerIds: record.disconnectedViewerIds,
      ...(primaryRevision
        ? {
            revisionId: primaryRevision.revisionId,
            linkedFileMode: "live" as const,
            snapshotBytes: primaryRevision.snapshotBytes,
          }
        : record.frozenSession && primaryAvailability === "repair-required"
          ? { snapshotBytes: record.frozenSession.snapshotBytes }
          : {}),
      ...(primaryAvailability ? { primaryAvailability } : {}),
      ...(Object.keys(viewerSnapshots).length > 0 ? { viewerSnapshots } : {}),
    });
    this.grants.set(grant.secretHash, grant);
    try {
      await this.writeGrants();
    } catch (error) {
      if (!atomicWriteCommitted(error)) {
        this.grants.delete(grant.secretHash);
      }
      await this.drainCleanupJournal(false);
      throw error;
    }
    await this.drainCleanupJournal(false);
    return { bodyBytes };
  }

  private async writeRawRevision(options: {
    shareStateId: string;
    source: PublicShareSource;
    bodyPath: string;
    capturedAt: string;
  }): Promise<PublicShareRevision> {
    const state = await this.ensureState(
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

  private async collectUnreferenced(shareStateIds: string[]): Promise<void> {
    for (const shareStateId of new Set(shareStateIds)) {
      const remaining = [...this.grants.values()].filter(
        (grant) => grant.shareStateId === shareStateId,
      );
      const stateDirectory = path.join(this.sharesPath, shareStateId);
      if (remaining.length === 0) {
        await fs.rm(stateDirectory, { recursive: true }).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        continue;
      }
      const referenced = new Set<string>();
      for (const grant of remaining) {
        if (grant.revisionId) referenced.add(grant.revisionId);
        for (const snapshot of Object.values(grant.viewerSnapshots ?? {})) {
          if (snapshot.revisionId) referenced.add(snapshot.revisionId);
        }
      }
      let state: PublicShareStateFile;
      try {
        const statePath = this.statePath(shareStateId);
        await enforceOwnerOnlyPathPermissionsStrict(
          stateDirectory,
          "directory",
        );
        await enforceOwnerOnlyPathPermissionsStrict(statePath, "file");
        state = JSON.parse(
          await fs.readFile(statePath, "utf8"),
        ) as PublicShareStateFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const frozenDirectory = path.join(stateDirectory, "frozen");
      let children: Dirent[] = [];
      try {
        await enforceOwnerOnlyPathPermissionsStrict(
          frozenDirectory,
          "directory",
        );
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
        if (!isTemporary && referenced.has(child.name)) continue;
        await fs.rm(path.join(frozenDirectory, child.name), {
          recursive: true,
        });
      }

      const revisions = Object.fromEntries(
        Object.entries(state.revisions).filter(([revisionId]) =>
          referenced.has(revisionId),
        ),
      );
      if (
        Object.keys(revisions).length !== Object.keys(state.revisions).length
      ) {
        await this.writeState({
          ...state,
          updatedAt: new Date().toISOString(),
          revisions,
        });
      }
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

  private async writeRevision(options: {
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
  }): Promise<PublicShareRevision> {
    const state = await this.ensureState(
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
          this.testHooks,
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
        // A transcript can remain unchanged while project files change. Give
        // each attempted project capture its own revision identity so a later
        // freeze can never alias an older as-of worktree snapshot.
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
      const nextState: PublicShareStateFile = {
        ...state,
        updatedAt: options.capturedAt,
        revisions: { ...state.revisions, [revisionId]: revision },
      };
      await this.writeState(nextState);
      return revision;
    } catch (error) {
      await fs
        .rm(temporaryDirectory, { recursive: true })
        .catch(() => undefined);
      throw error;
    }
  }

  private async ensureState(
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

  private async writeGrants(): Promise<void> {
    const grants = [...this.grants.values()].map(withDowngradeRepairMarker);
    const candidate = new Map(grants.map((grant) => [grant.secretHash, grant]));
    try {
      await this.writeJson(this.grantsPath, {
        version: 2,
        grants,
      } satisfies PublicShareGrantFile);
      this.grants = candidate;
    } catch (error) {
      if (atomicWriteCommitted(error)) this.grants = candidate;
      throw error;
    }
  }

  private assertReady(): void {
    if (this.readiness !== "ready") {
      throw new Error(`Public share store is ${this.readiness}`);
    }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private isGrant(value: unknown): value is PublicShareGrant {
    if (!value || typeof value !== "object") return false;
    const grant = value as Partial<PublicShareGrant>;
    return (
      grant.version === 2 &&
      typeof grant.shareId === "string" &&
      OPAQUE_ID_REGEX.test(grant.shareId) &&
      typeof grant.secretHash === "string" &&
      SECRET_HASH_REGEX.test(grant.secretHash) &&
      (grant.publicUrl === undefined ||
        (typeof grant.publicUrl === "string" &&
          grant.publicUrl.length <= 4096 &&
          URL.canParse(grant.publicUrl))) &&
      typeof grant.shareStateId === "string" &&
      OPAQUE_ID_REGEX.test(grant.shareStateId) &&
      (grant.mode === "live" || grant.mode === "frozen") &&
      isValidGrantText(grant.title, PUBLIC_SHARE_TITLE_MAX_LENGTH) &&
      isValidGrantText(
        grant.initialPrompt,
        PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH,
      ) &&
      typeof grant.createdAt === "string" &&
      typeof grant.updatedAt === "string" &&
      !!grant.source &&
      typeof grant.source.projectId === "string" &&
      typeof grant.source.sessionId === "string" &&
      (grant.revisionId === undefined ||
        (typeof grant.revisionId === "string" &&
          REVISION_ID_REGEX.test(grant.revisionId))) &&
      (grant.mode === "live" ||
        typeof grant.revisionId === "string" ||
        (grant.primaryAvailability === "repair-required" &&
          grant.revisionId === undefined &&
          grant.linkedFileMode === undefined &&
          Number.isSafeInteger(grant.snapshotBytes) &&
          grant.snapshotBytes! >= 0)) &&
      (grant.linkedFileMode === undefined ||
        grant.linkedFileMode === "cow" ||
        grant.linkedFileMode === "live") &&
      (grant.snapshotBytes === undefined ||
        (Number.isSafeInteger(grant.snapshotBytes) &&
          grant.snapshotBytes >= 0)) &&
      (grant.primaryAvailability === undefined ||
        grant.primaryAvailability === "available" ||
        grant.primaryAvailability === "repair-required") &&
      (grant.repairRequired === undefined || grant.repairRequired === true) &&
      (grant.disconnectedViewerIds === undefined ||
        (Array.isArray(grant.disconnectedViewerIds) &&
          grant.disconnectedViewerIds.every(
            (viewerId) =>
              typeof viewerId === "string" && VIEWER_ID_REGEX.test(viewerId),
          ))) &&
      (grant.viewerSnapshots === undefined ||
        (!!grant.viewerSnapshots &&
          typeof grant.viewerSnapshots === "object" &&
          !Array.isArray(grant.viewerSnapshots) &&
          Object.entries(grant.viewerSnapshots).every(
            ([viewerId, snapshot]) =>
              VIEWER_ID_REGEX.test(viewerId) &&
              !!snapshot &&
              typeof snapshot.capturedAt === "string" &&
              Number.isSafeInteger(snapshot.snapshotBytes) &&
              snapshot.snapshotBytes >= 0 &&
              (snapshot.availability === undefined ||
                snapshot.availability === "available" ||
                snapshot.availability === "repair-required") &&
              ((typeof snapshot.revisionId === "string" &&
                REVISION_ID_REGEX.test(snapshot.revisionId) &&
                (snapshot.linkedFileMode === "cow" ||
                  snapshot.linkedFileMode === "live")) ||
                (snapshot.availability === "repair-required" &&
                  snapshot.revisionId === undefined &&
                  snapshot.linkedFileMode === undefined)),
          )))
    );
  }
}
