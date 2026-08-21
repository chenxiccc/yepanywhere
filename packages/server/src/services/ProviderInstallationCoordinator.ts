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

export const CODEX_INSTALLATION_FAMILY = "codex-cli";

const DEFAULT_LEASE_STALE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_GATE_STALE_MS = 30_000;
const DEFAULT_GATE_WAIT_MS = 10_000;
const DEFAULT_READ_WAIT_MS = 6 * 60_000;
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
  createdAt: number;
}

interface WriterRecord {
  operationId: string;
  family: string;
  pid: number;
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
  pollMs?: number;
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
  private readonly pollMs: number;
  private readonly familyStates = new Map<string, FamilyState>();
  private readonly context = new AsyncLocalStorage<InstallationContext>();
  private readonly preparedDirectories = new Map<string, Promise<string>>();

  constructor(options: ProviderInstallationCoordinatorOptions = {}) {
    this.rootDir =
      options.rootDir ??
      join(homedir(), ".yep-anywhere", "provider-installations");
    this.leaseStaleMs = options.leaseStaleMs ?? DEFAULT_LEASE_STALE_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.gateStaleMs = options.gateStaleMs ?? DEFAULT_GATE_STALE_MS;
    this.gateWaitMs = options.gateWaitMs ?? DEFAULT_GATE_WAIT_MS;
    this.readWaitMs = options.readWaitMs ?? DEFAULT_READ_WAIT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
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

    await this.withGate(familyDir, async () => {
      const updating = await this.hasActiveWriter(familyDir);
      const blockers = await this.collectActiveLeases(familyDir);
      if (updating || blockers.readers > 0 || blockers.runtimes > 0) {
        throw new ProviderInstallationBusyError(family, {
          updating,
          ...blockers,
        });
      }
      await this.writeExclusiveJson(writerPath, {
        operationId,
        family,
        pid: process.pid,
        createdAt: startedAt,
      } satisfies WriterRecord);
    });

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
      stopHeartbeat();
      await this.publishGeneration(familyDir, family, operationId, outcome);
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
    const deadline = Date.now() + this.gateWaitMs;
    for (;;) {
      try {
        await mkdir(gatePath, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.isStale(gatePath, this.gateStaleMs)) {
          await rmdir(gatePath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out acquiring provider installation gate: ${familyDir}`,
          );
        }
        await delay(this.pollMs);
      }
    }

    try {
      return await operation();
    } finally {
      await rmdir(gatePath).catch((error) => {
        log.warn(
          { error, gatePath },
          "Failed to release provider installation gate",
        );
      });
    }
  }

  private async hasActiveWriter(familyDir: string): Promise<boolean> {
    const writerPath = join(familyDir, "writer.json");
    try {
      if (await this.isStale(writerPath, this.leaseStaleMs)) {
        await unlink(writerPath).catch(() => undefined);
        return false;
      }
      await stat(writerPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
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
      if (await this.isStale(leasePath, this.leaseStaleMs)) {
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
