import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InstallationOwnerProbe,
  type ProviderInstallationBusyError,
  ProviderInstallationCoordinator,
  defaultOwnerProbe,
} from "../../src/services/ProviderInstallationCoordinator.js";

const FAMILY = "codex-cli";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve = (_value: T) => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("ProviderInstallationCoordinator", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "ya-provider-installation-test-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function createCoordinator(
    ownerProbe?: InstallationOwnerProbe,
  ): ProviderInstallationCoordinator {
    return new ProviderInstallationCoordinator({
      rootDir,
      heartbeatMs: 10,
      leaseStaleMs: 100,
      pollMs: 5,
      readWaitMs: 500,
      readerDrainWaitMs: 500,
      ...(ownerProbe ? { ownerProbe } : {}),
    });
  }

  /** Write a lease/writer record whose heartbeat mtime is long past stale. */
  async function writeStaleRecord(
    name: string,
    record: Record<string, unknown>,
  ): Promise<string> {
    const familyDir = join(rootDir, FAMILY);
    await mkdir(familyDir, { recursive: true, mode: 0o700 });
    const recordPath = join(familyDir, name);
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const past = new Date(Date.now() - 60_000);
    await utimes(recordPath, past, past);
    return recordPath;
  }

  function probe(
    aliveState: "alive" | "missing" | "other-user",
    startId: string | null,
  ): InstallationOwnerProbe {
    return {
      aliveState: () => aliveState,
      startId: async () => startId,
    };
  }

  it("refuses an update while a runtime lease is active", async () => {
    const coordinator = createCoordinator();
    const lease = await coordinator.acquireRuntimeLease(FAMILY);
    const operation = vi.fn(async () => "updated");

    await expect(
      coordinator.runExclusiveUpdate(FAMILY, operation),
    ).rejects.toMatchObject({
      name: "ProviderInstallationBusyError",
      readers: 0,
      runtimes: 1,
      updating: false,
    } satisfies Partial<ProviderInstallationBusyError>);
    expect(operation).not.toHaveBeenCalled();

    await lease.release();
    await expect(
      coordinator.runExclusiveUpdate(FAMILY, operation),
    ).resolves.toBe("updated");
  });

  it("makes readers wait for an admitted update to finish", async () => {
    const coordinator = createCoordinator();
    const updateEntered = deferred();
    const finishUpdate = deferred();
    const update = coordinator.runExclusiveUpdate(FAMILY, async () => {
      updateEntered.resolve();
      await finishUpdate.promise;
      return "updated";
    });
    await updateEntered.promise;

    const read = vi.fn(async () => "read");
    const readResult = coordinator.withReadLease(FAMILY, read);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(read).not.toHaveBeenCalled();

    finishUpdate.resolve();
    await expect(update).resolves.toBe("updated");
    await expect(readResult).resolves.toBe("read");
  });

  it("waits for a bounded reader before admitting an update", async () => {
    const coordinator = createCoordinator();
    const finishRead = deferred();
    const readEntered = deferred();
    const read = coordinator.withReadLease(FAMILY, async () => {
      readEntered.resolve();
      await finishRead.promise;
    });
    await readEntered.promise;

    const operation = vi.fn(async () => "updated");
    const update = coordinator.runExclusiveUpdate(FAMILY, operation);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(operation).not.toHaveBeenCalled();

    finishRead.resolve();
    await read;
    await expect(update).resolves.toBe("updated");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent in-process update requests", async () => {
    const coordinator = createCoordinator();
    const updateEntered = deferred();
    const finishUpdate = deferred();
    const operation = vi.fn(async () => {
      updateEntered.resolve();
      await finishUpdate.promise;
      return "updated";
    });

    const first = coordinator.runExclusiveUpdate(FAMILY, operation);
    await updateEntered.promise;
    const second = coordinator.runExclusiveUpdate(FAMILY, operation);
    finishUpdate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "updated",
      "updated",
    ]);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("shares runtime and writer admission across coordinator instances", async () => {
    const first = createCoordinator();
    const second = createCoordinator();
    const lease = await first.acquireRuntimeLease(FAMILY);

    await expect(
      second.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).rejects.toMatchObject({
      name: "ProviderInstallationBusyError",
      runtimes: 1,
    });

    await lease.release();
    await expect(
      second.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).resolves.toBe("updated");
  });

  it("keeps a delayed-heartbeat runtime lease while its owner is alive", async () => {
    await writeStaleRecord("runtime-sleeping.json", {
      id: "sleeping",
      family: FAMILY,
      kind: "runtime",
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    const coordinator = createCoordinator(probe("alive", "boot-100"));

    await expect(
      coordinator.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).rejects.toMatchObject({
      name: "ProviderInstallationBusyError",
      runtimes: 1,
    });
  });

  it("removes a stale runtime lease whose owner PID is gone", async () => {
    await writeStaleRecord("runtime-dead.json", {
      id: "dead",
      family: FAMILY,
      kind: "runtime",
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    const coordinator = createCoordinator(probe("missing", null));

    await expect(
      coordinator.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).resolves.toBe("updated");
  });

  it("removes a stale runtime lease whose PID was reused", async () => {
    await writeStaleRecord("runtime-reused.json", {
      id: "reused",
      family: FAMILY,
      kind: "runtime",
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    // The PID is occupied again, but by a process started at another time.
    const coordinator = createCoordinator(probe("alive", "boot-999"));

    await expect(
      coordinator.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).resolves.toBe("updated");
  });

  it("removes a stale runtime lease reoccupied by another user's process", async () => {
    await writeStaleRecord("runtime-other.json", {
      id: "other",
      family: FAMILY,
      kind: "runtime",
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    const coordinator = createCoordinator(probe("other-user", null));

    await expect(
      coordinator.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).resolves.toBe("updated");
  });

  it("honors a delayed-heartbeat writer while its owner is alive", async () => {
    await writeStaleRecord("writer.json", {
      operationId: "sleeping-writer",
      family: FAMILY,
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    const coordinator = createCoordinator(probe("alive", "boot-100"));

    await expect(
      coordinator.withReadLease(FAMILY, async () => "read"),
    ).rejects.toMatchObject({ name: "ProviderInstallationUpdatingError" });
  });

  it("recovers from a stale writer whose owner PID is gone", async () => {
    await writeStaleRecord("writer.json", {
      operationId: "dead-writer",
      family: FAMILY,
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    const coordinator = createCoordinator(probe("missing", null));

    await expect(
      coordinator.withReadLease(FAMILY, async () => "read"),
    ).resolves.toBe("read");
  });

  it("probes real process liveness and start identity", async () => {
    expect(defaultOwnerProbe.aliveState(process.pid)).toBe("alive");
    // Far beyond any realistic pid_max, so nothing occupies it.
    expect(defaultOwnerProbe.aliveState(0x7fffffff)).toBe("missing");
    if (process.platform !== "win32") {
      await expect(
        defaultOwnerProbe.startId(process.pid),
      ).resolves.toBeTruthy();
    }
  });

  it("publishes a cross-process source generation after failure", async () => {
    const first = createCoordinator();
    const second = createCoordinator();
    const before = second.getSourceVersion(FAMILY);
    const listener = vi.fn();
    first.onGenerationChange(FAMILY, listener);

    await expect(
      first.runExclusiveUpdate(FAMILY, async () => {
        throw new Error("replacement failed");
      }),
    ).rejects.toThrow("replacement failed");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(first.getSourceVersion(FAMILY)).not.toBe(before);
    expect(second.getSourceVersion(FAMILY)).not.toBe(before);
  });
});
