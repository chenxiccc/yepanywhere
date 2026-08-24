import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiProjectMap } from "../../src/projects/gemini-project-map.js";

const fsControl = vi.hoisted(() => ({
  mapFile: null as string | null,
  readCalls: 0,
  blockNextRead: false,
  readStarted: null as null | (() => void),
  readGate: null as Promise<void> | null,
  blockNextMkdir: false,
  mkdirStarted: null as null | (() => void),
  mkdirGate: null as Promise<void> | null,
  failNextRename: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === fsControl.mapFile) {
        fsControl.readCalls += 1;
        if (fsControl.blockNextRead) {
          fsControl.blockNextRead = false;
          const captured = await actual.readFile(...args).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          fsControl.readStarted?.();
          await fsControl.readGate;
          if (!captured.ok) throw captured.error;
          return captured.value;
        }
      }
      return actual.readFile(...args);
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (fsControl.blockNextMkdir) {
        fsControl.blockNextMkdir = false;
        fsControl.mkdirStarted?.();
        await fsControl.mkdirGate;
      }
      return actual.mkdir(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsControl.failNextRename) {
        fsControl.failNextRename = false;
        throw new Error("synthetic rename failure");
      }
      return actual.rename(...args);
    },
  };
});

describe("GeminiProjectMap concurrency", () => {
  let tempDir: string;
  let mapFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gemini-map-concurrency-"));
    mapFile = join(tempDir, "project-map.json");
    fsControl.mapFile = mapFile;
    fsControl.readCalls = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    fsControl.mapFile = null;
    fsControl.blockNextRead = false;
    fsControl.readStarted = null;
    fsControl.readGate = null;
    fsControl.blockNextMkdir = false;
    fsControl.mkdirStarted = null;
    fsControl.mkdirGate = null;
    fsControl.failNextRename = false;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("shares one initial disk load", async () => {
    await writeFile(mapFile, JSON.stringify({ existing: "/project" }));
    const projectMap = new GeminiProjectMap(mapFile);
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead: (() => void) | undefined;
    fsControl.readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    fsControl.readStarted = () => signalReadStarted?.();
    fsControl.blockNextRead = true;

    const firstRead = projectMap.get("existing");
    const secondRead = projectMap.getAll();
    await readStarted;

    expect(fsControl.readCalls).toBe(1);
    releaseRead?.();
    expect(await firstRead).toBe("/project");
    expect((await secondRead).get("existing")).toBe("/project");
  });

  it("serializes overlapping updates and atomically keeps the newest map", async () => {
    const projectMap = new GeminiProjectMap(mapFile);
    await projectMap.load();
    let signalMkdirStarted: (() => void) | undefined;
    const mkdirStarted = new Promise<void>((resolve) => {
      signalMkdirStarted = resolve;
    });
    let releaseMkdir: (() => void) | undefined;
    fsControl.mkdirGate = new Promise<void>((resolve) => {
      releaseMkdir = resolve;
    });
    fsControl.mkdirStarted = () => signalMkdirStarted?.();
    fsControl.blockNextMkdir = true;

    const firstUpdate = projectMap.set("hash-a", "/project/a");
    await mkdirStarted;
    let secondSettled = false;
    const secondUpdate = projectMap.set("hash-b", "/project/b").finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseMkdir?.();
    await Promise.all([firstUpdate, secondUpdate]);

    expect(JSON.parse(await readFile(mapFile, "utf-8"))).toEqual({
      "hash-a": "/project/a",
      "hash-b": "/project/b",
    });
    const reloaded = new GeminiProjectMap(mapFile);
    expect(Object.fromEntries(await reloaded.getAll())).toEqual({
      "hash-a": "/project/a",
      "hash-b": "/project/b",
    });
    expect(
      (await readdir(tempDir)).filter((name) => name.includes(".tmp-")),
    ).toEqual([]);
  });

  it("keeps the accepted map and mutation tail usable after write failure", async () => {
    const projectMap = new GeminiProjectMap(mapFile);
    await projectMap.set("hash-a", "/project/a");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fsControl.failNextRename = true;
    await expect(projectMap.set("hash-b", "/project/b")).rejects.toThrow(
      "synthetic rename failure",
    );
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(await projectMap.get("hash-b")).toBeUndefined();

    await projectMap.set("hash-c", "/project/c");
    const reloaded = new GeminiProjectMap(mapFile);
    expect(Object.fromEntries(await reloaded.getAll())).toEqual({
      "hash-a": "/project/a",
      "hash-c": "/project/c",
    });
    expect(
      (await readdir(tempDir)).filter((name) => name.includes(".tmp-")),
    ).toEqual([]);
  });
});
