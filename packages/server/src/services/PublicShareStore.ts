import type {
  AppSession,
  ProviderName,
  PublicSessionShareMode,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
} from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import {
  collectLegacyAuthorizedPaths,
  inspectLegacySessionBody,
  type LegacyPublicShareRecord,
  readLegacyPublicShareRecords,
} from "./LegacyPublicShareReader.js";

export type PublicShareStoreReadiness =
  | "opening"
  | "migrating"
  | "ready"
  | "failed"
  | "disabled";

export type PublicShareLinkedFileMode = "cow" | "live";

export interface PublicShareSource {
  projectId: UrlProjectId;
  sessionId: string;
  projectName?: string;
  provider?: ProviderName;
}

export interface PublicShareGrant {
  version: 2;
  shareId: string;
  secretHash: string;
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
  repairRequired?: boolean;
  disconnectedViewerIds?: string[];
  viewerSnapshots?: Record<
    string,
    {
      capturedAt: string;
      revisionId: string;
      linkedFileMode: PublicShareLinkedFileMode;
      snapshotBytes: number;
    }
  >;
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

export interface CreateStoredGrantOptions {
  secretHash: string;
  mode: PublicSessionShareMode;
  title: string | null;
  initialPrompt: string | null;
  source: PublicShareSource;
  snapshot?: AppSession;
  presentation?: PublicSharePresentation;
  projectRoot?: string;
}

export interface StoredGrantResult {
  grant: PublicShareGrant;
  revision?: PublicShareRevision;
}

export interface FreezeStoredGrantsOptions {
  matches: (grant: PublicShareGrant) => boolean;
  snapshot: AppSession;
  presentation?: PublicSharePresentation;
  projectRoot?: string;
  viewerId?: string;
}

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

function sourceMatches(a: PublicShareSource, b: PublicShareSource): boolean {
  return a.projectId === b.projectId && a.sessionId === b.sessionId;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(directory, 0o700);
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

async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(temporaryPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await fs.rename(temporaryPath, filePath);
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600);
  }
  await syncDirectory(directory);
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

async function cloneTreeCopyOnWrite(
  sourceRoot: string,
  destinationRoot: string,
  excludedRoot: string,
): Promise<PublicShareLinkedFileMode> {
  await ensurePrivateDirectory(destinationRoot);
  try {
    const visit = async (
      source: string,
      destination: string,
    ): Promise<void> => {
      const entries = await fs.readdir(source, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        const sourcePath = path.join(source, entry.name);
        if (path.resolve(sourcePath) === path.resolve(excludedRoot)) continue;
        const destinationPath = path.join(destination, entry.name);
        if (entry.isDirectory()) {
          await ensurePrivateDirectory(destinationPath);
          await visit(sourcePath, destinationPath);
          continue;
        }
        if (entry.isSymbolicLink()) {
          // A preserved symlink could escape the immutable clone and serve
          // current bytes while the revision is labelled copy-on-write.
          continue;
        }
        if (!entry.isFile()) continue;
        await fs.copyFile(
          sourcePath,
          destinationPath,
          fsConstants.COPYFILE_FICLONE_FORCE,
        );
        if (process.platform !== "win32") {
          await fs.chmod(destinationPath, 0o600);
        }
      }
    };
    await visit(sourceRoot, destinationRoot);
    return "cow";
  } catch (error) {
    if (
      UNSUPPORTED_COW_CODES.has((error as NodeJS.ErrnoException).code ?? "")
    ) {
      await fs.rm(destinationRoot, { recursive: true });
      return "live";
    }
    throw error;
  }
}

export class PublicShareStore {
  private readonly root: string;
  private readonly legacyPath: string;
  private readonly legacyBackupPath: string;
  private readonly migrationPath: string;
  private readonly grantsPath: string;
  private readonly sharesPath: string;
  private grants = new Map<string, PublicShareGrant>();
  private readiness: PublicShareStoreReadiness = "opening";
  private readinessError: string | null = null;
  private cleanupPending = false;
  private disableRequested = false;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly controlOpened: Promise<void>;
  private resolveControlOpened!: () => void;
  private controlOpenedResolved = false;
  private migrationDone: Promise<void> | null = null;

  constructor(dataDir: string) {
    this.controlOpened = new Promise<void>((resolve) => {
      this.resolveControlOpened = resolve;
    });
    this.root = path.join(dataDir, "public-shares");
    this.legacyPath = path.join(dataDir, "public-shares.json");
    this.legacyBackupPath = path.join(
      dataDir,
      "public-shares.legacy-backup.json",
    );
    this.migrationPath = path.join(this.root, "migration.json");
    this.grantsPath = path.join(this.root, "grants.json");
    this.sharesPath = path.join(this.root, "shares");
  }

  getReadiness(): { state: PublicShareStoreReadiness; error: string | null } {
    return { state: this.readiness, error: this.readinessError };
  }

  isCleanupPending(): boolean {
    return this.cleanupPending;
  }

  async initialize(enabled = true): Promise<void> {
    this.readiness = "opening";
    this.readinessError = null;
    try {
      await ensurePrivateDirectory(this.root);
      await ensurePrivateDirectory(this.sharesPath);
      let grantFile = EMPTY_GRANT_FILE;
      try {
        grantFile = JSON.parse(
          await fs.readFile(this.grantsPath, "utf8"),
        ) as PublicShareGrantFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await atomicWriteJson(this.grantsPath, EMPTY_GRANT_FILE);
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
      const migration = await this.readMigrationMarker();
      const legacyExists = await fs
        .stat(this.legacyPath)
        .then((stats) => stats.isFile())
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        });
      const backupExists = await fs
        .stat(this.legacyBackupPath)
        .then((stats) => stats.isFile())
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        });
      this.markControlOpened();
      if (this.disableRequested) return;
      if (!enabled) {
        await this.disable();
        return;
      }
      if (migration?.status === "disabled") {
        await atomicWriteJson(this.migrationPath, {
          version: 1,
          status: "complete",
          completedAt: new Date().toISOString(),
          legacyBackup: backupExists
            ? path.basename(this.legacyBackupPath)
            : null,
        });
      } else if (migration?.status === "complete") {
        if (legacyExists) {
          throw new Error(
            "Legacy public share source remains after completed migration",
          );
        }
      } else if (legacyExists || backupExists) {
        this.readiness = "migrating";
        this.migrationDone = this.migrateLegacy(
          legacyExists ? this.legacyPath : this.legacyBackupPath,
        );
        try {
          await this.migrationDone;
        } finally {
          this.migrationDone = null;
        }
      } else {
        await atomicWriteJson(this.migrationPath, {
          version: 1,
          status: "complete",
          completedAt: new Date().toISOString(),
          legacyBackup: null,
        });
      }
      if (!this.disableRequested) this.readiness = "ready";
    } catch (error) {
      this.markControlOpened();
      this.readiness = "failed";
      this.readinessError =
        error instanceof Error ? error.message : "Failed to open share store";
      throw error;
    }
  }

  async disable(): Promise<number> {
    this.disableRequested = true;
    await this.controlOpened;
    await this.migrationDone?.catch(() => undefined);
    return await this.withMutation(async () => {
      const revoked = [...this.grants.values()];
      this.grants.clear();
      await this.writeGrants();
      try {
        await this.collectUnreferenced(
          revoked.map((grant) => grant.shareStateId),
        );
      } catch {
        this.cleanupPending = true;
      }
      const legacyExists = await fs
        .stat(this.legacyPath)
        .then(() => true)
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        });
      if (legacyExists) {
        const backupExists = await fs
          .stat(this.legacyBackupPath)
          .then(() => true)
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return false;
            throw error;
          });
        if (backupExists) {
          throw new Error(
            "Cannot disable public shares while both legacy source and backup exist",
          );
        }
        await fs.rename(this.legacyPath, this.legacyBackupPath);
        await syncDirectory(path.dirname(this.legacyPath));
      }
      await atomicWriteJson(this.migrationPath, {
        version: 1,
        status: "disabled",
        completedAt: new Date().toISOString(),
        legacyBackup: path.basename(this.legacyBackupPath),
      });
      this.readiness = "disabled";
      this.readinessError = null;
      return revoked.length;
    });
  }

  async enable(): Promise<void> {
    if (this.readiness !== "disabled") return;
    await this.withMutation(async () => {
      await atomicWriteJson(this.migrationPath, {
        version: 1,
        status: "complete",
        completedAt: new Date().toISOString(),
        legacyBackup: path.basename(this.legacyBackupPath),
      });
      this.disableRequested = false;
      this.readiness = "ready";
      this.readinessError = null;
    });
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
      const now = new Date().toISOString();
      const matchingGrant = [...this.grants.values()].find((grant) =>
        sourceMatches(grant.source, options.source),
      );
      const shareStateId =
        matchingGrant?.shareStateId ?? randomBytes(16).toString("base64url");
      let revision: PublicShareRevision | undefined;
      try {
        if (options.mode === "frozen") {
          if (!options.snapshot) {
            throw new Error("Frozen shares require a session snapshot");
          }
          revision = await this.writeRevision({
            shareStateId,
            source: options.source,
            snapshot: options.snapshot,
            presentation: options.presentation,
            projectRoot: options.projectRoot,
            capturedAt: now,
          });
        } else {
          await this.ensureState(shareStateId, options.source, now);
        }
      } catch (error) {
        await this.collectUnreferenced([shareStateId]).catch(() => {
          this.cleanupPending = true;
        });
        throw error;
      }

      const grant: PublicShareGrant = {
        version: 2,
        shareId: randomBytes(12).toString("base64url"),
        secretHash: options.secretHash,
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
            }
          : {}),
        source: options.source,
      };
      this.grants.set(grant.secretHash, grant);
      try {
        await this.writeGrants();
      } catch (error) {
        this.grants.delete(grant.secretHash);
        await this.collectUnreferenced([shareStateId]).catch(() => {
          this.cleanupPending = true;
        });
        throw error;
      }
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
      for (const grant of revoked) {
        this.grants.delete(grant.secretHash);
      }
      try {
        await this.writeGrants();
      } catch (error) {
        for (const grant of revoked) {
          this.grants.set(grant.secretHash, grant);
        }
        throw error;
      }
      try {
        await this.collectUnreferenced(
          revoked.map((grant) => grant.shareStateId),
        );
      } catch {
        this.cleanupPending = true;
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
      const revision = await this.writeRevision({
        shareStateId: first.shareStateId,
        source: first.source,
        snapshot: options.snapshot,
        presentation: options.presentation,
        projectRoot: options.projectRoot,
        capturedAt: now,
      });
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
              viewerSnapshots: undefined,
            };
        this.grants.set(updated.secretHash, updated);
      }
      try {
        await this.writeGrants();
      } catch (error) {
        for (const [secretHash, grant] of previous) {
          this.grants.set(secretHash, grant);
        }
        await this.collectUnreferenced([first.shareStateId]).catch(() => {
          this.cleanupPending = true;
        });
        throw error;
      }
      try {
        await this.collectUnreferenced([first.shareStateId]);
      } catch {
        this.cleanupPending = true;
      }
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
      const previous = new Map<string, PublicShareGrant>();
      let changed = false;
      for (const grant of matching) {
        const disconnectedViewerIds = new Set(
          grant.disconnectedViewerIds ?? [],
        );
        const hadViewer = disconnectedViewerIds.has(viewerId);
        disconnectedViewerIds.add(viewerId);
        const { [viewerId]: removed, ...remainingSnapshots } =
          grant.viewerSnapshots ?? {};
        if (!hadViewer || removed) changed = true;
        if (!hadViewer || removed) {
          previous.set(grant.secretHash, grant);
          this.grants.set(grant.secretHash, {
            ...grant,
            disconnectedViewerIds: [...disconnectedViewerIds],
            viewerSnapshots:
              Object.keys(remainingSnapshots).length > 0
                ? remainingSnapshots
                : undefined,
          });
        }
      }
      if (!changed) return false;
      try {
        await this.writeGrants();
      } catch (error) {
        for (const [secretHash, grant] of previous) {
          this.grants.set(secretHash, grant);
        }
        throw error;
      }
      try {
        await this.collectUnreferenced(
          matching.map((grant) => grant.shareStateId),
        );
      } catch {
        this.cleanupPending = true;
      }
      return true;
    });
  }

  getRevisionDirectory(grant: PublicShareGrant, revisionId: string): string {
    return path.join(this.sharesPath, grant.shareStateId, "frozen", revisionId);
  }

  getRevisionSessionStream(
    grant: PublicShareGrant,
    revisionId: string,
  ): Readable {
    return createReadStream(
      path.join(
        this.getRevisionDirectory(grant, revisionId),
        "session.json.gz",
      ),
    ).pipe(createGunzip());
  }

  async readRevisionSession(
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<AppSession> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.getRevisionSessionStream(
      grant,
      revisionId,
    )) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as AppSession;
  }

  async readPresentation(
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<PublicSharePresentation> {
    return JSON.parse(
      await fs.readFile(
        path.join(
          this.getRevisionDirectory(grant, revisionId),
          "presentation.json",
        ),
        "utf8",
      ),
    ) as PublicSharePresentation;
  }

  getRevisionProjectRoot(
    grant: PublicShareGrant,
    revisionId: string,
  ): string | null {
    return path.join(this.getRevisionDirectory(grant, revisionId), "project");
  }

  private async readMigrationMarker(): Promise<{
    status: "complete" | "disabled";
  } | null> {
    try {
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

  private async migrateLegacy(sourcePath: string): Promise<void> {
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
      )) {
        if (this.disableRequested) return;
        const result = await this.withMutation(
          async () => await this.importLegacyRecord(record),
        );
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
          if (body) await fs.rm(body.filePath).catch(() => undefined);
        }
      }
      if (this.disableRequested) return;
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
        if (process.platform !== "win32") {
          await fs.chmod(this.legacyBackupPath, 0o600);
        }
        await syncDirectory(path.dirname(this.legacyPath));
      }
      await atomicWriteJson(this.migrationPath, {
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
    let primaryRevision: PublicShareRevision | undefined;
    let repairRequired = false;
    let bodyBytes = 0;
    if (record.frozenSession) {
      const inspection = await inspectLegacySessionBody(
        record.frozenSession.filePath,
      );
      repairRequired = inspection.repairRequired;
      primaryRevision = await this.writeRawRevision({
        shareStateId,
        source: record.source,
        bodyPath: record.frozenSession.filePath,
        capturedAt: record.capturedAt ?? record.updatedAt,
      });
      bodyBytes += primaryRevision.snapshotBytes;
    } else {
      await this.ensureState(shareStateId, record.source, record.createdAt);
    }
    const viewerSnapshots: NonNullable<PublicShareGrant["viewerSnapshots"]> =
      {};
    for (const [viewerId, snapshot] of Object.entries(
      record.viewerSnapshots ?? {},
    )) {
      const inspection = await inspectLegacySessionBody(snapshot.body.filePath);
      repairRequired ||= inspection.repairRequired;
      const revision = await this.writeRawRevision({
        shareStateId,
        source: record.source,
        bodyPath: snapshot.body.filePath,
        capturedAt: snapshot.capturedAt,
      });
      bodyBytes += revision.snapshotBytes;
      viewerSnapshots[viewerId] = {
        capturedAt: snapshot.capturedAt,
        revisionId: revision.revisionId,
        linkedFileMode: "live",
        snapshotBytes: revision.snapshotBytes,
      };
    }
    const grant: PublicShareGrant = {
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
        : {}),
      ...(Object.keys(viewerSnapshots).length > 0 ? { viewerSnapshots } : {}),
      ...(repairRequired ? { repairRequired: true } : {}),
    };
    this.grants.set(grant.secretHash, grant);
    try {
      await this.writeGrants();
    } catch (error) {
      this.grants.delete(grant.secretHash);
      throw error;
    }
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
        contentHash.update(bytes);
        snapshotBytes += bytes.length;
        callback(null, bytes);
      },
    });
    try {
      const projectRoot = Buffer.from(
        options.source.projectId,
        "base64url",
      ).toString("utf8");
      const authorizedPaths = await collectLegacyAuthorizedPaths(
        options.bodyPath,
        projectRoot,
        options.source.projectId,
      );
      await pipeline(
        createReadStream(options.bodyPath),
        meter,
        createGzip(),
        createWriteStream(temporarySessionPath, { mode: 0o600 }),
      );
      contentHash.update("\0presentation\0");
      contentHash.update(JSON.stringify({ version: 1, authorizedPaths }));
      const revisionId = contentHash.digest("base64url");
      const existing = state.revisions[revisionId];
      if (existing) {
        await fs.rm(temporaryDirectory, { recursive: true });
        return existing;
      }
      const finalDirectory = path.join(frozenRoot, revisionId);
      const orphaned = await this.adoptOrphanedRevision({
        state,
        revisionId,
        finalDirectory,
        capturedAt: options.capturedAt,
        snapshotBytes,
        linkedFileMode: "live",
      });
      if (orphaned) {
        await fs.rm(temporaryDirectory, { recursive: true });
        return orphaned;
      }
      await atomicWriteJson(
        path.join(temporaryDirectory, "presentation.json"),
        {
          version: 1,
          authorizedPaths,
        } satisfies PublicSharePresentation,
      );
      const compressedBytes = (await fs.stat(temporarySessionPath)).size;
      await fs.rename(temporaryDirectory, finalDirectory);
      await syncDirectory(frozenRoot);
      const revision: PublicShareRevision = {
        revisionId,
        capturedAt: options.capturedAt,
        linkedFileMode: "live",
        snapshotBytes,
        compressedBytes,
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
          referenced.add(snapshot.revisionId);
        }
      }
      let state: PublicShareStateFile;
      try {
        state = JSON.parse(
          await fs.readFile(this.statePath(shareStateId), "utf8"),
        ) as PublicShareStateFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      let changed = false;
      const revisions = { ...state.revisions };
      for (const revisionId of Object.keys(revisions)) {
        if (referenced.has(revisionId)) continue;
        await fs
          .rm(path.join(stateDirectory, "frozen", revisionId), {
            recursive: true,
          })
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        delete revisions[revisionId];
        changed = true;
      }
      if (changed) {
        await this.writeState({
          ...state,
          updatedAt: new Date().toISOString(),
          revisions,
        });
      }
    }
  }

  private async adoptOrphanedRevision(options: {
    state: PublicShareStateFile;
    revisionId: string;
    finalDirectory: string;
    capturedAt: string;
    snapshotBytes: number;
    linkedFileMode?: PublicShareLinkedFileMode;
  }): Promise<PublicShareRevision | null> {
    let directoryStats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      directoryStats = await fs.stat(options.finalDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!directoryStats.isDirectory()) {
      throw new Error(
        `Invalid orphaned public share revision ${options.revisionId}`,
      );
    }

    const sessionStats = await fs.stat(
      path.join(options.finalDirectory, "session.json.gz"),
    );
    const presentationPath = path.join(
      options.finalDirectory,
      "presentation.json",
    );
    const presentationStats = await fs.stat(presentationPath);
    if (!sessionStats.isFile() || !presentationStats.isFile()) {
      throw new Error(
        `Incomplete orphaned public share revision ${options.revisionId}`,
      );
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
        `Invalid orphaned public share presentation ${options.revisionId}`,
      );
    }

    let linkedFileMode = options.linkedFileMode;
    if (!linkedFileMode) {
      const projectStats = await fs
        .stat(path.join(options.finalDirectory, "project"))
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
      if (projectStats && !projectStats.isDirectory()) {
        throw new Error(
          `Invalid orphaned public share project snapshot ${options.revisionId}`,
        );
      }
      linkedFileMode = projectStats ? "cow" : "live";
    }

    const revision: PublicShareRevision = {
      revisionId: options.revisionId,
      capturedAt: options.capturedAt,
      linkedFileMode,
      snapshotBytes: options.snapshotBytes,
      compressedBytes: sessionStats.size,
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
    presentation?: PublicSharePresentation;
    projectRoot?: string;
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
        contentHash.update(bytes);
        snapshotBytes += bytes.length;
        callback(null, bytes);
      },
    });
    try {
      await pipeline(
        Readable.from(serializeJson(options.snapshot)),
        meter,
        createGzip(),
        createWriteStream(temporarySessionPath, { mode: 0o600 }),
      );
      contentHash.update("\0presentation\0");
      contentHash.update(
        JSON.stringify(
          options.presentation ?? { version: 1, authorizedPaths: [] },
        ),
      );
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
        await fs.rm(temporaryDirectory, { recursive: true });
        return existing;
      }
      const orphaned = await this.adoptOrphanedRevision({
        state,
        revisionId,
        finalDirectory,
        capturedAt: options.capturedAt,
        snapshotBytes,
      });
      if (orphaned) {
        await fs.rm(temporaryDirectory, { recursive: true });
        return orphaned;
      }

      let linkedFileMode: PublicShareLinkedFileMode = "live";
      if (options.projectRoot) {
        linkedFileMode = await cloneTreeCopyOnWrite(
          options.projectRoot,
          path.join(temporaryDirectory, "project"),
          this.root,
        );
      }
      await atomicWriteJson(
        path.join(temporaryDirectory, "presentation.json"),
        options.presentation ?? { version: 1, authorizedPaths: [] },
      );
      const compressedBytes = (await fs.stat(temporarySessionPath)).size;
      await fs.rename(temporaryDirectory, finalDirectory);
      await syncDirectory(frozenRoot);
      const revision: PublicShareRevision = {
        revisionId,
        capturedAt: options.capturedAt,
        linkedFileMode,
        snapshotBytes,
        compressedBytes,
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
            Number.isFinite(revision.snapshotBytes) &&
            revision.snapshotBytes >= 0 &&
            Number.isFinite(revision.compressedBytes) &&
            revision.compressedBytes >= 0,
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
    await atomicWriteJson(this.statePath(state.shareStateId), state);
  }

  private async writeGrants(): Promise<void> {
    await atomicWriteJson(this.grantsPath, {
      version: 2,
      grants: [...this.grants.values()],
    } satisfies PublicShareGrantFile);
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

  private markControlOpened(): void {
    if (this.controlOpenedResolved) return;
    this.controlOpenedResolved = true;
    this.resolveControlOpened();
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
      typeof grant.shareStateId === "string" &&
      OPAQUE_ID_REGEX.test(grant.shareStateId) &&
      (grant.mode === "live" || grant.mode === "frozen") &&
      (grant.title === null || typeof grant.title === "string") &&
      (grant.initialPrompt === null ||
        typeof grant.initialPrompt === "string") &&
      typeof grant.createdAt === "string" &&
      typeof grant.updatedAt === "string" &&
      !!grant.source &&
      typeof grant.source.projectId === "string" &&
      typeof grant.source.sessionId === "string" &&
      (grant.revisionId === undefined ||
        (typeof grant.revisionId === "string" &&
          REVISION_ID_REGEX.test(grant.revisionId))) &&
      (grant.mode === "live" || typeof grant.revisionId === "string") &&
      (grant.linkedFileMode === undefined ||
        grant.linkedFileMode === "cow" ||
        grant.linkedFileMode === "live") &&
      (grant.snapshotBytes === undefined ||
        (Number.isFinite(grant.snapshotBytes) && grant.snapshotBytes >= 0)) &&
      (grant.disconnectedViewerIds === undefined ||
        (Array.isArray(grant.disconnectedViewerIds) &&
          grant.disconnectedViewerIds.every(
            (viewerId) =>
              typeof viewerId === "string" && VIEWER_ID_REGEX.test(viewerId),
          ))) &&
      (grant.viewerSnapshots === undefined ||
        Object.entries(grant.viewerSnapshots).every(
          ([viewerId, snapshot]) =>
            VIEWER_ID_REGEX.test(viewerId) &&
            !!snapshot &&
            typeof snapshot.capturedAt === "string" &&
            REVISION_ID_REGEX.test(snapshot.revisionId) &&
            (snapshot.linkedFileMode === "cow" ||
              snapshot.linkedFileMode === "live") &&
            Number.isFinite(snapshot.snapshotBytes) &&
            snapshot.snapshotBytes >= 0,
        ))
    );
  }
}
