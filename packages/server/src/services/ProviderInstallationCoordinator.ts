import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { getLogger } from "../logging/logger.js";
import { enforceOwnerOnlyPathPermissionsStrict } from "../utils/filePermissions.js";
import {
  defaultOwnerProbe,
  type InstallationOwnerProbe,
} from "./installationOwnerProbe.js";

export {
  createDefaultOwnerProbe,
  defaultOwnerProbe,
  type InstallationOwnerProbe,
} from "./installationOwnerProbe.js";

export const CODEX_INSTALLATION_FAMILY = "codex-cli";

const DEFAULT_LEASE_STALE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_GATE_STALE_MS = 30_000;
const DEFAULT_GATE_WAIT_MS = 10_000;
const DEFAULT_READ_WAIT_MS = 6 * 60_000;
const DEFAULT_READER_DRAIN_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 100;

const log = getLogger().child({
  component: "provider-installation-coordinator",
});

type InstallationLeaseKind = "read" | "runtime";

interface InstallationContext {
  family: string;
  mode: "read" | "writer";
}

interface LeaseRecord {
  id: string;
  family: string;
  kind: InstallationLeaseKind;
  pid: number;
  ownerStartId: string | null;
  createdAt: number;
}

interface WriterRecord {
  operationId: string;
  family: string;
  pid: number;
  ownerStartId: string | null;
  createdAt: number;
}

interface GateRecord {
  id: string;
  pid: number;
  ownerStartId: string | null;
  createdAt: number;
}

interface FamilyState {
  generation: number;
  updatePromise: Promise<unknown> | null;
  listeners: Set<() => void>;
}

export interface ProviderInstallationLease {
  readonly family: string;
  readonly kind: InstallationLeaseKind;
  release(): Promise<void>;
}

export interface ProviderInstallationUpdateContext {
  readonly family: string;
  readonly operationId: string;
}

export interface ProviderInstallationSnapshot {
  family: string;
  sourceVersion: string;
  updating: boolean;
  readers: number;
  runtimes: number;
}

export interface ProviderInstallationCoordinatorOptions {
  rootDir?: string;
  leaseStaleMs?: number;
  heartbeatMs?: number;
  gateStaleMs?: number;
  gateWaitMs?: number;
  readWaitMs?: number;
  readerDrainWaitMs?: number;
  pollMs?: number;
  /** Owner-process verification for stale cleanup (injectable for tests). */
  ownerProbe?: InstallationOwnerProbe;
}

export class ProviderInstallationBusyError extends Error {
  readonly family: string;
  readonly updating: boolean;
  readonly readers: number;
  readonly runtimes: number;

  constructor(
    family: string,
    blockers: { updating: boolean; readers: number; runtimes: number },
  ) {
    const count = blockers.readers + blockers.runtimes;
    const detail = blockers.updating
      ? "another update is already running"
      : `${count} active provider operation${count === 1 ? "" : "s"}`;
    super(`Provider installation ${family} is busy: ${detail}`);
    this.name = "ProviderInstallationBusyError";
    this.family = family;
    this.updating = blockers.updating;
    this.readers = blockers.readers;
    this.runtimes = blockers.runtimes;
  }
}

export class ProviderInstallationUpdatingError extends Error {
  readonly family: string;

  constructor(family: string) {
    super(`Provider installation ${family} is still updating`);
    this.name = "ProviderInstallationUpdatingError";
    this.family = family;
  }
}

export class ProviderInstallationOwnershipLostError extends Error {
  readonly family: string;

  constructor(family: string) {
    super(`Provider installation update ownership was lost for ${family}`);
    this.name = "ProviderInstallationOwnershipLostError";
    this.family = family;
  }
}

/**
 * Coordinates provider installation readers, live runtimes, and mutations.
 *
 * The filesystem lease protocol is shared by every YA process for the current
 * OS user. A short atomic gate closes reader/writer admission races; heartbeat
 * files make crashed owners recoverable without project-local state.
 */
export class ProviderInstallationCoordinator {
  private readonly rootDir: string;
  private readonly leaseStaleMs: number;
  private readonly heartbeatMs: number;
  private readonly gateStaleMs: number;
  private readonly gateWaitMs: number;
  private readonly readWaitMs: number;
  private readonly readerDrainWaitMs: number;
  private readonly pollMs: number;
  private readonly familyStates = new Map<string, FamilyState>();
  private readonly context = new AsyncLocalStorage<InstallationContext>();
  private readonly preparedDirectories = new Map<string, Promise<string>>();
  private readonly ownerProbe: InstallationOwnerProbe;
  private readonly ownerStartIdRequired: boolean;
  private ownStartId: Promise<string | null> | null = null;

  constructor(options: ProviderInstallationCoordinatorOptions = {}) {
    this.rootDir =
      options.rootDir ??
      join(homedir(), ".yep-anywhere", "provider-installations");
    this.leaseStaleMs = options.leaseStaleMs ?? DEFAULT_LEASE_STALE_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.gateStaleMs = options.gateStaleMs ?? DEFAULT_GATE_STALE_MS;
    this.gateWaitMs = options.gateWaitMs ?? DEFAULT_GATE_WAIT_MS;
    this.readWaitMs = options.readWaitMs ?? DEFAULT_READ_WAIT_MS;
    this.readerDrainWaitMs =
      options.readerDrainWaitMs ?? DEFAULT_READER_DRAIN_WAIT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.ownerProbe = options.ownerProbe ?? defaultOwnerProbe;
    this.ownerStartIdRequired =
      options.ownerProbe === undefined && process.platform === "win32";
  }

  private getOwnStartId(): Promise<string | null> {
    if (!this.ownStartId) {
      this.ownStartId = this.ownerProbe
        .startId(process.pid)
        .catch(() => null)
        .then((startId) => {
          if (this.ownerStartIdRequired && !startId) {
            throw new Error(
              "Cannot coordinate provider installation without Windows process start identity",
            );
          }
          return startId;
        });
    }
    return this.ownStartId;
  }

  getSourceVersion(family: string): string {
    this.assertFamily(family);
    let persistedGeneration = "initial";
    try {
      persistedGeneration = readFileSync(
        join(this.rootDir, family, "generation.json"),
        "utf8",
      ).trim();
    } catch {
      // The first successful or failed mutation creates the shared marker.
    }
    return `${this.getFamilyState(family).generation}\0${persistedGeneration}`;
  }

  onGenerationChange(family: string, listener: () => void): () => void {
    const state = this.getFamilyState(family);
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  async withReadLease<T>(
    family: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const current = this.context.getStore();
    if (current?.family === family) return operation();

    const lease = await this.acquireLease(family, "read");
    try {
      return await this.context.run({ family, mode: "read" }, operation);
    } finally {
      await lease.release();
    }
  }

  async acquireRuntimeLease(
    family: string,
  ): Promise<ProviderInstallationLease> {
    return this.acquireLease(family, "runtime");
  }

  async runExclusiveUpdate<T>(
    family: string,
    operation: (context: ProviderInstallationUpdateContext) => Promise<T>,
  ): Promise<T> {
    this.assertFamily(family);
    const state = this.getFamilyState(family);
    if (state.updatePromise) {
      return state.updatePromise as Promise<T>;
    }

    const updatePromise = this.doRunExclusiveUpdate(family, operation).finally(
      () => {
        if (state.updatePromise === updatePromise) {
          state.updatePromise = null;
        }
      },
    );
    state.updatePromise = updatePromise;
    return updatePromise;
  }

  /**
   * Wait up to timeoutMs for update transactions owned by this process to
   * finish, returning the families still updating at the deadline (empty
   * means drained). Reload and shutdown must not interrupt an admitted
   * package mutation mid-replacement, so callers hold process replacement
   * on this drain and report any remainder as an explicit recovery
   * diagnostic instead of silently orphaning the package-manager child.
   */
  async waitForLocalUpdates(timeoutMs: number): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const active = [...this.familyStates.entries()].filter(
        ([, state]) => state.updatePromise !== null,
      );
      if (active.length === 0) return [];
      const remaining = deadline - Date.now();
      if (remaining <= 0) return active.map(([family]) => family);
      await Promise.race([
        Promise.all(
          active.map(([, state]) =>
            (state.updatePromise as Promise<unknown>).catch(() => undefined),
          ),
        ),
        delay(Math.min(remaining, 250)),
      ]);
    }
  }

  async getSnapshot(family: string): Promise<ProviderInstallationSnapshot> {
    const familyDir = await this.prepareFamilyDirectory(family);
    return this.withGate(familyDir, async () => {
      const updating = await this.hasActiveWriter(familyDir);
      const blockers = await this.collectActiveLeases(familyDir);
      return {
        family,
        sourceVersion: this.getSourceVersion(family),
        updating,
        readers: blockers.readers,
        runtimes: blockers.runtimes,
      };
    });
  }

  private async doRunExclusiveUpdate<T>(
    family: string,
    operation: (context: ProviderInstallationUpdateContext) => Promise<T>,
  ): Promise<T> {
    const familyDir = await this.prepareFamilyDirectory(family);
    const operationId = randomUUID();
    const writerPath = join(familyDir, "writer.json");
    const startedAt = Date.now();
    const readerDrainDeadline = startedAt + this.readerDrainWaitMs;

    for (;;) {
      const blockers = await this.withGate(familyDir, async () => {
        const updating = await this.hasActiveWriter(familyDir);
        const activeLeases = await this.collectActiveLeases(familyDir);
        if (
          !updating &&
          activeLeases.readers === 0 &&
          activeLeases.runtimes === 0
        ) {
          await this.writeExclusiveJson(writerPath, {
            operationId,
            family,
            pid: process.pid,
            ownerStartId: await this.getOwnStartId(),
            createdAt: startedAt,
          } satisfies WriterRecord);
          return null;
        }
        return { updating, ...activeLeases };
      });
      if (!blockers) break;
      const canWaitForReaders =
        !blockers.updating &&
        blockers.runtimes === 0 &&
        blockers.readers > 0 &&
        Date.now() < readerDrainDeadline;
      if (!canWaitForReaders) {
        throw new ProviderInstallationBusyError(family, blockers);
      }
      await delay(this.pollMs);
    }

    const stopHeartbeat = this.startHeartbeat(writerPath);
    let outcome = "succeeded";
    log.info({ family, operationId }, "Provider installation update started");
    try {
      const result = await this.context.run({ family, mode: "writer" }, () =>
        operation({ family, operationId }),
      );
      if (!(await this.isOwnedWriter(writerPath, operationId))) {
        throw new ProviderInstallationOwnershipLostError(family);
      }
      return result;
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      await this.publishGeneration(familyDir, family, operationId, outcome);
      stopHeartbeat();
      await unlink(writerPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          log.warn(
            { error, family, operationId },
            "Failed to release provider installation writer",
          );
        }
      });
      const state = this.getFamilyState(family);
      state.generation++;
      for (const listener of state.listeners) {
        try {
          listener();
        } catch (error) {
          log.warn(
            { error, family, operationId },
            "Provider installation generation listener failed",
          );
        }
      }
      log.info(
        {
          family,
          operationId,
          outcome,
          durationMs: Date.now() - startedAt,
          generation: state.generation,
        },
        "Provider installation update finished",
      );
    }
  }

  private async acquireLease(
    family: string,
    kind: InstallationLeaseKind,
  ): Promise<ProviderInstallationLease> {
    this.assertFamily(family);
    const familyDir = await this.prepareFamilyDirectory(family);
    const deadline = Date.now() + this.readWaitMs;

    for (;;) {
      const id = randomUUID();
      const leasePath = join(familyDir, `${kind}-${id}.json`);
      const admitted = await this.withGate(familyDir, async () => {
        if (await this.hasActiveWriter(familyDir)) return false;
        await this.writeExclusiveJson(leasePath, {
          id,
          family,
          kind,
          pid: process.pid,
          ownerStartId: await this.getOwnStartId(),
          createdAt: Date.now(),
        } satisfies LeaseRecord);
        return true;
      });

      if (admitted) {
        const stopHeartbeat = this.startHeartbeat(leasePath);
        let released = false;
        return {
          family,
          kind,
          release: async () => {
            if (released) return;
            released = true;
            stopHeartbeat();
            await unlink(leasePath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
          },
        };
      }

      if (Date.now() >= deadline) {
        throw new ProviderInstallationUpdatingError(family);
      }
      await delay(this.pollMs);
    }
  }

  private async prepareFamilyDirectory(family: string): Promise<string> {
    this.assertFamily(family);
    const existing = this.preparedDirectories.get(family);
    if (existing) return existing;

    const preparation = (async () => {
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      await enforceOwnerOnlyPathPermissionsStrict(this.rootDir, "directory");
      const familyDir = join(this.rootDir, family);
      await mkdir(familyDir, { recursive: true, mode: 0o700 });
      await enforceOwnerOnlyPathPermissionsStrict(familyDir, "directory");
      return familyDir;
    })();
    this.preparedDirectories.set(family, preparation);
    try {
      return await preparation;
    } catch (error) {
      this.preparedDirectories.delete(family);
      throw error;
    }
  }

  private async withGate<T>(
    familyDir: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const gatePath = join(familyDir, "gate.lock");
    const gateOwnerPath = join(gatePath, "owner.json");
    const gateId = randomUUID();
    const deadline = Date.now() + this.gateWaitMs;
    for (;;) {
      try {
        await mkdir(gatePath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.clearStaleGate(gatePath)) {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out acquiring provider installation gate: ${familyDir} ${await this.describeGateHolder(gatePath)}`,
          );
        }
        await delay(this.pollMs);
        continue;
      }
      try {
        await this.writeExclusiveJson(gateOwnerPath, {
          id: gateId,
          pid: process.pid,
          ownerStartId: await this.getOwnStartId(),
          createdAt: Date.now(),
        } satisfies GateRecord);
        break;
      } catch (error) {
        // A gate directory left behind without its owner record is only
        // recoverable on the stale-gate timer, so give the claim back now.
        await unlink(gateOwnerPath).catch(() => undefined);
        await this.removeGateDirectory(gatePath);
        throw error;
      }
    }

    const stopHeartbeat = this.startHeartbeat(gateOwnerPath);
    try {
      return await operation();
    } finally {
      stopHeartbeat();
      await this.releaseGate(gatePath, gateId);
    }
  }

  /**
   * Recover a gate whose owner is gone, returning true when the directory is
   * free for another `mkdir` attempt.
   *
   * Two abandoned shapes exist. An owner record whose recorded process is
   * verifiably dead is the ordinary one. The second is a gate directory with
   * no owner record at all, left by a process that died between claiming the
   * directory and writing the record — nothing heartbeats it, so the
   * directory's own mtime is the only age evidence available. A live claimant
   * crosses that window in adjacent statements, far inside the stale
   * threshold, so an owner-less directory older than the threshold is
   * abandoned. Without this branch it is unrecoverable and permanently wedges
   * the family for every YA process owned by this user.
   */
  private async clearStaleGate(gatePath: string): Promise<boolean> {
    const ownerPath = join(gatePath, "owner.json");
    try {
      if (!(await this.pathExists(ownerPath))) {
        if (!(await this.isStale(gatePath, this.gateStaleMs))) return false;
        return this.removeGateDirectory(gatePath);
      }
      if (!(await this.isStale(ownerPath, this.gateStaleMs))) return false;
      if (!(await this.staleRecordOwnerGone(ownerPath))) return false;
      await unlink(ownerPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return this.removeGateDirectory(gatePath);
    } catch {
      // Recovery is a probe: anything that stops us proving the gate is
      // abandoned means keep waiting, and the admission deadline reports it.
      return false;
    }
  }

  private async releaseGate(gatePath: string, gateId: string): Promise<void> {
    const ownerPath = join(gatePath, "owner.json");
    try {
      const record = JSON.parse(await readFile(ownerPath, "utf8")) as {
        id?: unknown;
      };
      if (record.id !== gateId) {
        log.warn(
          { gatePath, gateId },
          "Provider installation gate ownership changed before release",
        );
        return;
      }
      await unlink(ownerPath);
    } catch (error) {
      log.warn(
        { error, gatePath, gateId },
        "Failed to release provider installation gate owner record",
      );
    }
    // Drop the directory even when its owner record had already vanished:
    // leaving it behind is what blocks every later admission attempt.
    await this.removeGateDirectory(gatePath);
  }

  /** True once the gate directory is gone, whichever process removed it. */
  private async removeGateDirectory(gatePath: string): Promise<boolean> {
    try {
      await rmdir(gatePath);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  /** Names the current gate holder for an admission-timeout diagnostic. */
  private async describeGateHolder(gatePath: string): Promise<string> {
    const ownerPath = join(gatePath, "owner.json");
    try {
      const info = await stat(ownerPath);
      const record = JSON.parse(await readFile(ownerPath, "utf8")) as {
        pid?: unknown;
      };
      const heartbeatAgeMs = Date.now() - info.mtimeMs;
      return `(held by pid ${String(record.pid)}, last heartbeat ${Math.round(heartbeatAgeMs / 1000)}s ago)`;
    } catch {
      return "(gate directory has no owner record; it clears itself once stale)";
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async hasActiveWriter(familyDir: string): Promise<boolean> {
    const writerPath = join(familyDir, "writer.json");
    try {
      if (await this.isStale(writerPath, this.leaseStaleMs)) {
        if (await this.staleRecordOwnerGone(writerPath)) {
          await unlink(writerPath).catch(() => undefined);
          return false;
        }
        // Delayed heartbeat with a live owner (sleep, event-loop stall):
        // the writer still owns the mutation.
        return true;
      }
      await stat(writerPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /**
   * A stale mtime alone does not prove a dead owner: laptop sleep or an
   * event-loop stall delays heartbeats while the recorded process is still
   * alive and may still be mutating or using the installation. Only remove
   * a record whose owner is verifiably gone — the PID is unoccupied, the
   * PID now belongs to another user's process, or the same-user PID has a
   * different process start identity (PID reuse).
   */
  private async staleRecordOwnerGone(recordPath: string): Promise<boolean> {
    let record: { pid?: unknown; ownerStartId?: unknown };
    try {
      record = JSON.parse(await readFile(recordPath, "utf8")) as {
        pid?: unknown;
        ownerStartId?: unknown;
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true;
    }
    const pid = typeof record.pid === "number" ? record.pid : null;
    if (pid === null || !Number.isInteger(pid) || pid <= 0) return true;

    switch (this.ownerProbe.aliveState(pid)) {
      case "missing":
        return true;
      case "other-user":
        // Records are written by same-user YA processes; a PID we may not
        // signal belongs to another user, so the original owner is gone.
        return true;
      case "alive":
        break;
    }

    const recordedStartId =
      typeof record.ownerStartId === "string" ? record.ownerStartId : null;
    if (recordedStartId) {
      const currentStartId = await this.ownerProbe
        .startId(pid)
        .catch(() => null);
      if (currentStartId && currentStartId !== recordedStartId) {
        return true;
      }
    }
    return false;
  }

  private async collectActiveLeases(
    familyDir: string,
  ): Promise<{ readers: number; runtimes: number }> {
    const blockers = { readers: 0, runtimes: 0 };
    const entries = await readdir(familyDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const kind = entry.name.startsWith("read-")
        ? "read"
        : entry.name.startsWith("runtime-")
          ? "runtime"
          : null;
      if (!kind) continue;
      const leasePath = join(familyDir, entry.name);
      if (
        (await this.isStale(leasePath, this.leaseStaleMs)) &&
        (await this.staleRecordOwnerGone(leasePath))
      ) {
        await unlink(leasePath).catch(() => undefined);
        continue;
      }
      if (kind === "read") blockers.readers++;
      else blockers.runtimes++;
    }
    return blockers;
  }

  private async isStale(path: string, staleMs: number): Promise<boolean> {
    try {
      const info = await stat(path);
      return Date.now() - info.mtimeMs > staleMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private startHeartbeat(path: string): () => void {
    const timer = setInterval(() => {
      const now = new Date();
      void utimes(path, now, now).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          log.warn({ error, path }, "Provider installation heartbeat failed");
        }
      });
    }, this.heartbeatMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async isOwnedWriter(
    writerPath: string,
    operationId: string,
  ): Promise<boolean> {
    try {
      const record = JSON.parse(await readFile(writerPath, "utf8")) as {
        operationId?: unknown;
      };
      return record.operationId === operationId;
    } catch {
      return false;
    }
  }

  private async publishGeneration(
    familyDir: string,
    family: string,
    operationId: string,
    outcome: string,
  ): Promise<void> {
    const generationPath = join(familyDir, "generation.json");
    const body = `${JSON.stringify({ family, operationId, outcome, at: Date.now() })}\n`;
    try {
      await writeFile(generationPath, body, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      log.warn(
        { error, family, operationId },
        "Failed to publish provider installation generation",
      );
    }
  }

  private async writeExclusiveJson(
    path: string,
    value: unknown,
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  }

  private getFamilyState(family: string): FamilyState {
    this.assertFamily(family);
    let state = this.familyStates.get(family);
    if (!state) {
      state = { generation: 0, updatePromise: null, listeners: new Set() };
      this.familyStates.set(family, state);
    }
    return state;
  }

  private assertFamily(family: string): void {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(family)) {
      throw new Error(`Invalid provider installation family: ${family}`);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const providerInstallationCoordinator =
  new ProviderInstallationCoordinator();
