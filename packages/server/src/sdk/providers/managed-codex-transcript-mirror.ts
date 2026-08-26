import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  truncate,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { CodexSessionReader } from "../../sessions/codex-reader.js";
import type { LoadedSession } from "../../sessions/types.js";
import {
  MANAGED_CODEX_TRANSCRIPT_CHUNK_BYTES,
  type ManagedCodexTranscriptCheckpoint,
  type ManagedSshTarget,
} from "./managed-ssh-target.js";
import type { ManagedSshWorkspace } from "./managed-ssh-workspace.js";

const REGISTRY_VERSION = 1;
const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;
const MAX_REGISTRY_RECORDS = 10_000;
const DEFAULT_MAX_SYNC_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SESSION_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

export type ManagedCodexTranscriptSyncState =
  | "current"
  | "behind"
  | "unavailable"
  | "error";

export interface ManagedCodexTranscriptRecord {
  yaSessionId: string;
  provider: "codex";
  providerSessionId: string;
  controllerProjectId: UrlProjectId;
  targetId: string;
  workspaceId: string;
  remoteWorkspaceDirectory: string;
  remoteWorktreePath: string;
  runnerGeneration?: string;
  mirrorSessionsRelativePath: string;
  targetRolloutRelativePath: string;
  rolloutGeneration: string;
  targetFileIdentity: string;
  targetMetadataSha256: string;
  transferredBytes: number;
  localCompleteBytes: number;
  remoteCompleteBytes: number;
  remoteTotalBytes: number;
  remoteMtimeMs: number;
  lastSyncedAt: string;
  syncState: ManagedCodexTranscriptSyncState;
  lastError?: string;
}

export interface ManagedCodexTranscriptSyncOptions {
  yaSessionId: string;
  controllerProjectId: UrlProjectId;
  targetId: string;
  target: ManagedSshTarget;
  workspace: ManagedSshWorkspace;
  providerSessionId: string;
  runnerGeneration?: string;
  signal?: AbortSignal;
}

export interface ManagedCodexTranscriptSyncResult {
  record: ManagedCodexTranscriptRecord;
  bytesTransferred: number;
  chunksTransferred: number;
}

interface ManagedCodexTranscriptRegistryFile {
  version: 1;
  records: ManagedCodexTranscriptRecord[];
}

interface ManagedCodexTranscriptSyncOwner {
  options: ManagedCodexTranscriptSyncOptions;
  promise: Promise<ManagedCodexTranscriptSyncResult>;
}

export interface ManagedCodexTranscriptMirrorServiceOptions {
  dataDir: string;
  maxSyncBytes?: number;
  maxSessionBytes?: number;
  maxTotalBytes?: number;
  now?: () => Date;
}

/**
 * One-way app-data mirror for target-authoritative Codex rollouts.
 *
 * The registry is the discovery source. Mirror roots are opened only after an
 * exact YA session lookup and are never joined to the ordinary Codex scanner.
 */
export class ManagedCodexTranscriptMirrorService {
  private readonly storageRoot: string;
  private readonly registryPath: string;
  private readonly maxSyncBytes: number;
  private readonly maxSessionBytes: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => Date;
  private readonly records = new Map<string, ManagedCodexTranscriptRecord>();
  private readonly syncOwners = new Map<
    string,
    ManagedCodexTranscriptSyncOwner
  >();
  private registryWrites: Promise<void> = Promise.resolve();

  private constructor(options: ManagedCodexTranscriptMirrorServiceOptions) {
    this.storageRoot = join(
      resolve(options.dataDir),
      "managed-remote-transcripts",
    );
    this.registryPath = join(this.storageRoot, "registry.json");
    this.maxSyncBytes = positiveBound(
      options.maxSyncBytes,
      DEFAULT_MAX_SYNC_BYTES,
      "managed transcript synchronization",
    );
    this.maxSessionBytes = positiveBound(
      options.maxSessionBytes,
      DEFAULT_MAX_SESSION_BYTES,
      "managed transcript session cache",
    );
    this.maxTotalBytes = positiveBound(
      options.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      "managed transcript total cache",
    );
    if (this.maxSyncBytes > this.maxSessionBytes) {
      throw new Error(
        "Managed transcript synchronization bound exceeds its session cache bound",
      );
    }
    if (this.maxSessionBytes > this.maxTotalBytes) {
      throw new Error(
        "Managed transcript session cache bound exceeds its total cache bound",
      );
    }
    this.now = options.now ?? (() => new Date());
  }

  static async open(
    options: ManagedCodexTranscriptMirrorServiceOptions,
  ): Promise<ManagedCodexTranscriptMirrorService> {
    const service = new ManagedCodexTranscriptMirrorService(options);
    await service.loadRegistry();
    return service;
  }

  listRecords(): ManagedCodexTranscriptRecord[] {
    return [...this.records.values()]
      .map(cloneRecord)
      .sort((left, right) =>
        right.lastSyncedAt.localeCompare(left.lastSyncedAt),
      );
  }

  getRecord(yaSessionId: string): ManagedCodexTranscriptRecord | undefined {
    const record = this.records.get(yaSessionId);
    return record ? cloneRecord(record) : undefined;
  }

  mirrorSessionsDirectory(yaSessionId: string): string | undefined {
    const record = this.records.get(yaSessionId);
    return record
      ? this.resolveStorageRelativePath(record.mirrorSessionsRelativePath)
      : undefined;
  }

  async loadSession(yaSessionId: string): Promise<LoadedSession | null> {
    const record = this.records.get(yaSessionId);
    if (!record || record.transferredBytes < 1) return null;
    const reader = new CodexSessionReader({
      sessionsDir: this.resolveStorageRelativePath(
        record.mirrorSessionsRelativePath,
      ),
      projectPath: record.remoteWorktreePath,
    });
    try {
      reader.invalidateCache();
      const loaded = await reader.getSession(
        record.providerSessionId,
        record.controllerProjectId,
      );
      if (!loaded) return null;
      return {
        ...loaded,
        summary: {
          ...loaded.summary,
          id: record.yaSessionId,
          projectId: record.controllerProjectId,
        },
      };
    } finally {
      await reader.close();
    }
  }

  syncSession(
    options: ManagedCodexTranscriptSyncOptions,
  ): Promise<ManagedCodexTranscriptSyncResult> {
    validateSyncOptions(options);
    const incumbent = this.syncOwners.get(options.yaSessionId);
    if (incumbent) {
      assertConcurrentSyncBinding(incumbent.options, options);
      return incumbent.promise;
    }
    const promise = this.runSync(options).finally(() => {
      if (this.syncOwners.get(options.yaSessionId)?.promise === promise) {
        this.syncOwners.delete(options.yaSessionId);
      }
    });
    this.syncOwners.set(options.yaSessionId, { options, promise });
    return promise;
  }

  private async runSync(
    options: ManagedCodexTranscriptSyncOptions,
  ): Promise<ManagedCodexTranscriptSyncResult> {
    const previous = this.records.get(options.yaSessionId);
    assertRecordBinding(previous, options);
    try {
      const checkpoint = await options.target.getCodexTranscriptCheckpoint(
        options.workspace.remoteDirectory,
        options.providerSessionId,
        {
          knownRelativePath: previous?.targetRolloutRelativePath,
          signal: options.signal,
        },
      );
      return await this.synchronizeCheckpoint(options, checkpoint, previous);
    } catch (error) {
      if (previous) {
        const failed: ManagedCodexTranscriptRecord = {
          ...previous,
          runnerGeneration:
            options.runnerGeneration ?? previous.runnerGeneration,
          lastSyncedAt: this.now().toISOString(),
          syncState: "error",
          lastError: boundedError(error),
        };
        this.setRecord(failed);
        await this.persistRegistry();
      }
      throw error;
    }
  }

  private async synchronizeCheckpoint(
    options: ManagedCodexTranscriptSyncOptions,
    checkpoint: ManagedCodexTranscriptCheckpoint,
    previous: ManagedCodexTranscriptRecord | undefined,
  ): Promise<ManagedCodexTranscriptSyncResult> {
    const rolloutGeneration = digestIdentity(
      checkpoint.relativePath,
      checkpoint.fileIdentity,
      checkpoint.metadataSha256,
    );
    const sameGeneration = previous?.rolloutGeneration === rolloutGeneration;
    if (
      sameGeneration &&
      previous &&
      checkpoint.completeBytes < previous.transferredBytes
    ) {
      throw new Error("Managed Codex target rollout was truncated");
    }

    const mirrorSessionsRelativePath = mirrorSessionsPath(
      options.controllerProjectId,
      options.targetId,
      options.yaSessionId,
      rolloutGeneration,
    );
    const sessionsDirectory = this.resolveStorageRelativePath(
      mirrorSessionsRelativePath,
    );
    const mirrorPath = resolve(
      sessionsDirectory,
      ...checkpoint.relativePath.split("/"),
    );
    if (!isContainedPath(sessionsDirectory, mirrorPath)) {
      throw new Error(
        "Managed transcript mirror path escaped its session root",
      );
    }

    let transferredBytes = sameGeneration
      ? (previous?.transferredBytes ?? 0)
      : 0;
    let localCompleteBytes = sameGeneration
      ? (previous?.localCompleteBytes ?? 0)
      : 0;
    await mkdir(dirname(mirrorPath), { recursive: true, mode: 0o700 });
    const localSize = await regularFileSize(mirrorPath);
    if (localSize === null) {
      if (transferredBytes > 0) {
        transferredBytes = 0;
        localCompleteBytes = 0;
      }
    } else if (localSize > transferredBytes) {
      await truncate(mirrorPath, transferredBytes);
    } else if (localSize < transferredBytes) {
      await truncate(mirrorPath, 0);
      transferredBytes = 0;
      localCompleteBytes = 0;
    }

    const otherBytes = [...this.records.values()].reduce(
      (total, record) =>
        record.yaSessionId === options.yaSessionId
          ? total
          : total + record.transferredBytes,
      0,
    );
    const sessionBudget = Math.max(0, this.maxSessionBytes - transferredBytes);
    const totalBudget = Math.max(
      0,
      this.maxTotalBytes - otherBytes - transferredBytes,
    );
    let remainingBudget = Math.min(
      this.maxSyncBytes,
      sessionBudget,
      totalBudget,
      checkpoint.completeBytes - transferredBytes,
    );
    let bytesTransferred = 0;
    let chunksTransferred = 0;
    let current = this.buildRecord(
      options,
      checkpoint,
      mirrorSessionsRelativePath,
      rolloutGeneration,
      transferredBytes,
      localCompleteBytes,
    );

    while (remainingBudget > 0) {
      const byteLength = Math.min(
        MANAGED_CODEX_TRANSCRIPT_CHUNK_BYTES,
        remainingBudget,
      );
      const chunk = await options.target.readCodexTranscriptChunk(
        options.workspace.remoteDirectory,
        checkpoint,
        transferredBytes,
        byteLength,
        { signal: options.signal },
      );
      await appendDurably(mirrorPath, transferredBytes, chunk.bytes);
      const lastNewline = chunk.bytes.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        localCompleteBytes = transferredBytes + lastNewline + 1;
      }
      transferredBytes += chunk.byteLength;
      bytesTransferred += chunk.byteLength;
      chunksTransferred += 1;
      remainingBudget -= chunk.byteLength;
      current = this.buildRecord(
        options,
        checkpoint,
        mirrorSessionsRelativePath,
        rolloutGeneration,
        transferredBytes,
        localCompleteBytes,
      );
      this.setRecord(current);
      await this.persistRegistry();
    }

    current = this.buildRecord(
      options,
      checkpoint,
      mirrorSessionsRelativePath,
      rolloutGeneration,
      transferredBytes,
      localCompleteBytes,
    );
    this.setRecord(current);
    await this.persistRegistry();

    if (
      previous &&
      previous.rolloutGeneration !== rolloutGeneration &&
      previous.mirrorSessionsRelativePath !== mirrorSessionsRelativePath
    ) {
      await this.removePreviousGeneration(previous).catch(() => {});
    }

    return {
      record: cloneRecord(current),
      bytesTransferred,
      chunksTransferred,
    };
  }

  private buildRecord(
    options: ManagedCodexTranscriptSyncOptions,
    checkpoint: ManagedCodexTranscriptCheckpoint,
    mirrorSessionsRelativePath: string,
    rolloutGeneration: string,
    transferredBytes: number,
    localCompleteBytes: number,
  ): ManagedCodexTranscriptRecord {
    return {
      yaSessionId: options.yaSessionId,
      provider: "codex",
      providerSessionId: options.providerSessionId,
      controllerProjectId: options.controllerProjectId,
      targetId: options.targetId,
      workspaceId: options.workspace.workspaceId,
      remoteWorkspaceDirectory: options.workspace.remoteDirectory,
      remoteWorktreePath: options.workspace.remoteWorktreePath,
      ...(options.runnerGeneration
        ? { runnerGeneration: options.runnerGeneration }
        : {}),
      mirrorSessionsRelativePath,
      targetRolloutRelativePath: checkpoint.relativePath,
      rolloutGeneration,
      targetFileIdentity: checkpoint.fileIdentity,
      targetMetadataSha256: checkpoint.metadataSha256,
      transferredBytes,
      localCompleteBytes,
      remoteCompleteBytes: checkpoint.completeBytes,
      remoteTotalBytes: checkpoint.totalBytes,
      remoteMtimeMs: checkpoint.mtimeMs,
      lastSyncedAt: this.now().toISOString(),
      syncState:
        transferredBytes === checkpoint.completeBytes ? "current" : "behind",
    };
  }

  private async removePreviousGeneration(
    previous: ManagedCodexTranscriptRecord,
  ): Promise<void> {
    const sessionsDirectory = this.resolveStorageRelativePath(
      previous.mirrorSessionsRelativePath,
    );
    const generationDirectory = dirname(sessionsDirectory);
    await rm(generationDirectory, { recursive: true, force: true });
  }

  private resolveStorageRelativePath(relativePath: string): string {
    if (!safeStorageRelativePath(relativePath)) {
      throw new Error("Managed transcript storage path is invalid");
    }
    const path = resolve(this.storageRoot, ...relativePath.split("/"));
    if (!isContainedPath(this.storageRoot, path)) {
      throw new Error("Managed transcript storage path escaped app data");
    }
    return path;
  }

  private setRecord(record: ManagedCodexTranscriptRecord): void {
    if (
      !this.records.has(record.yaSessionId) &&
      this.records.size >= MAX_REGISTRY_RECORDS
    ) {
      throw new Error("Managed transcript registry exceeded its record bound");
    }
    this.records.set(record.yaSessionId, record);
  }

  private async loadRegistry(): Promise<void> {
    let serialized: string;
    try {
      serialized = await readFile(this.registryPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (Buffer.byteLength(serialized) > MAX_REGISTRY_BYTES) {
      throw new Error("Managed transcript registry exceeded its size bound");
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new Error("Managed transcript registry is invalid JSON");
    }
    const registry = parseRegistry(value);
    for (const record of registry.records) {
      if (this.records.has(record.yaSessionId)) {
        throw new Error("Managed transcript registry has duplicate sessions");
      }
      this.records.set(record.yaSessionId, record);
    }
  }

  private persistRegistry(): Promise<void> {
    const write = this.registryWrites
      .catch(() => {})
      .then(async () => {
        const registry: ManagedCodexTranscriptRegistryFile = {
          version: REGISTRY_VERSION,
          records: this.listRecords(),
        };
        const serialized = `${JSON.stringify(registry, null, 2)}\n`;
        if (Buffer.byteLength(serialized) > MAX_REGISTRY_BYTES) {
          throw new Error(
            "Managed transcript registry exceeded its size bound",
          );
        }
        await mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
        const temporaryPath = `${this.registryPath}.tmp-${process.pid}-${randomUUID()}`;
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(serialized, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await rename(temporaryPath, this.registryPath);
        } catch (error) {
          await unlink(temporaryPath).catch(() => {});
          throw error;
        }
      });
    this.registryWrites = write;
    return write;
  }
}

async function appendDurably(
  path: string,
  expectedOffset: number,
  bytes: Buffer,
): Promise<void> {
  const handle = await open(path, expectedOffset === 0 ? "w" : "r+", 0o600);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== expectedOffset) {
      throw new Error("Managed transcript mirror offset changed during append");
    }
    let written = 0;
    while (written < bytes.byteLength) {
      const result = await handle.write(
        bytes,
        written,
        bytes.byteLength - written,
        expectedOffset + written,
      );
      if (result.bytesWritten < 1) {
        throw new Error("Managed transcript mirror append made no progress");
      }
      written += result.bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function regularFileSize(path: string): Promise<number | null> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Managed transcript mirror is not a regular file");
    }
    return stats.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function mirrorSessionsPath(
  controllerProjectId: string,
  targetId: string,
  yaSessionId: string,
  rolloutGeneration: string,
): string {
  return posix.join(
    "codex",
    `project-${digestIdentity(controllerProjectId).slice(0, 24)}`,
    `target-${digestIdentity(targetId).slice(0, 24)}`,
    `session-${digestIdentity(yaSessionId).slice(0, 24)}`,
    "generations",
    `rollout-${rolloutGeneration}`,
    "sessions",
  );
}

function digestIdentity(...values: string[]): string {
  return createHash("sha256").update(values.join("\0")).digest("hex");
}

function isContainedPath(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return (
    candidate.length > 0 &&
    candidate !== ".." &&
    !candidate.startsWith(`..${sep}`) &&
    !isAbsolute(candidate)
  );
}

function validateSyncOptions(options: ManagedCodexTranscriptSyncOptions): void {
  for (const [label, value] of [
    ["YA session", options.yaSessionId],
    ["controller project", options.controllerProjectId],
    ["target", options.targetId],
    ["provider session", options.providerSessionId],
  ] as const) {
    if (!value || value.length > 1024 || value.includes("\0")) {
      throw new Error(`Managed transcript ${label} identity is invalid`);
    }
  }
}

function assertRecordBinding(
  record: ManagedCodexTranscriptRecord | undefined,
  options: ManagedCodexTranscriptSyncOptions,
): void {
  if (!record) return;
  if (
    record.providerSessionId !== options.providerSessionId ||
    record.controllerProjectId !== options.controllerProjectId ||
    record.targetId !== options.targetId ||
    record.workspaceId !== options.workspace.workspaceId ||
    record.remoteWorkspaceDirectory !== options.workspace.remoteDirectory ||
    record.remoteWorktreePath !== options.workspace.remoteWorktreePath
  ) {
    throw new Error("Managed transcript session binding changed");
  }
}

function assertConcurrentSyncBinding(
  incumbent: ManagedCodexTranscriptSyncOptions,
  requested: ManagedCodexTranscriptSyncOptions,
): void {
  if (
    incumbent.controllerProjectId !== requested.controllerProjectId ||
    incumbent.targetId !== requested.targetId ||
    incumbent.target !== requested.target ||
    incumbent.workspace.workspaceId !== requested.workspace.workspaceId ||
    incumbent.workspace.remoteDirectory !==
      requested.workspace.remoteDirectory ||
    incumbent.workspace.remoteWorktreePath !==
      requested.workspace.remoteWorktreePath ||
    incumbent.providerSessionId !== requested.providerSessionId ||
    incumbent.runnerGeneration !== requested.runnerGeneration
  ) {
    throw new Error("Managed transcript concurrent session binding changed");
  }
}

function parseRegistry(value: unknown): ManagedCodexTranscriptRegistryFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed transcript registry is invalid");
  }
  const registry = value as Record<string, unknown>;
  if (
    registry.version !== REGISTRY_VERSION ||
    !Array.isArray(registry.records) ||
    registry.records.length > MAX_REGISTRY_RECORDS
  ) {
    throw new Error("Managed transcript registry is invalid");
  }
  return {
    version: REGISTRY_VERSION,
    records: registry.records.map(parseRecord),
  };
}

function parseRecord(value: unknown): ManagedCodexTranscriptRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed transcript registry record is invalid");
  }
  const record = value as Record<string, unknown>;
  const parsed = {
    yaSessionId: record.yaSessionId,
    provider: record.provider,
    providerSessionId: record.providerSessionId,
    controllerProjectId: record.controllerProjectId,
    targetId: record.targetId,
    workspaceId: record.workspaceId,
    remoteWorkspaceDirectory: record.remoteWorkspaceDirectory,
    remoteWorktreePath: record.remoteWorktreePath,
    runnerGeneration: record.runnerGeneration,
    mirrorSessionsRelativePath: record.mirrorSessionsRelativePath,
    targetRolloutRelativePath: record.targetRolloutRelativePath,
    rolloutGeneration: record.rolloutGeneration,
    targetFileIdentity: record.targetFileIdentity,
    targetMetadataSha256: record.targetMetadataSha256,
    transferredBytes: record.transferredBytes,
    localCompleteBytes: record.localCompleteBytes,
    remoteCompleteBytes: record.remoteCompleteBytes,
    remoteTotalBytes: record.remoteTotalBytes,
    remoteMtimeMs: record.remoteMtimeMs,
    lastSyncedAt: record.lastSyncedAt,
    syncState: record.syncState,
    lastError: record.lastError,
  };
  const stringFields = [
    parsed.yaSessionId,
    parsed.providerSessionId,
    parsed.controllerProjectId,
    parsed.targetId,
    parsed.workspaceId,
    parsed.remoteWorkspaceDirectory,
    parsed.remoteWorktreePath,
    parsed.targetRolloutRelativePath,
    parsed.targetFileIdentity,
    parsed.lastSyncedAt,
  ];
  if (
    parsed.provider !== "codex" ||
    stringFields.some(
      (item) => typeof item !== "string" || !item || item.length > 4096,
    ) ||
    (parsed.runnerGeneration !== undefined &&
      (typeof parsed.runnerGeneration !== "string" ||
        !parsed.runnerGeneration)) ||
    typeof parsed.mirrorSessionsRelativePath !== "string" ||
    !safeStorageRelativePath(parsed.mirrorSessionsRelativePath) ||
    typeof parsed.rolloutGeneration !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.rolloutGeneration) ||
    typeof parsed.targetMetadataSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.targetMetadataSha256) ||
    !validByteCount(parsed.transferredBytes) ||
    !validByteCount(parsed.localCompleteBytes) ||
    !validByteCount(parsed.remoteCompleteBytes) ||
    !validByteCount(parsed.remoteTotalBytes) ||
    Number(parsed.localCompleteBytes) > Number(parsed.transferredBytes) ||
    Number(parsed.transferredBytes) > Number(parsed.remoteCompleteBytes) ||
    Number(parsed.remoteCompleteBytes) > Number(parsed.remoteTotalBytes) ||
    typeof parsed.remoteMtimeMs !== "number" ||
    !Number.isFinite(parsed.remoteMtimeMs) ||
    !new Set(["current", "behind", "unavailable", "error"]).has(
      String(parsed.syncState),
    ) ||
    (parsed.lastError !== undefined && typeof parsed.lastError !== "string")
  ) {
    throw new Error("Managed transcript registry record is invalid");
  }
  return parsed as ManagedCodexTranscriptRecord;
}

function safeStorageRelativePath(value: string): boolean {
  return (
    value.length <= 1024 &&
    /^[A-Za-z0-9/_-]+$/.test(value) &&
    !value.startsWith("/") &&
    !value.includes("//") &&
    value.split("/").every((segment) => segment !== "." && segment !== "..")
  );
}

function validByteCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveBound(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${label} bound must be a positive safe integer`);
  }
  return resolved;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}

function cloneRecord(
  record: ManagedCodexTranscriptRecord,
): ManagedCodexTranscriptRecord {
  return { ...record };
}
