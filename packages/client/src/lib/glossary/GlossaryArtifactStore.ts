import type {
  GlossaryArtifactResponse,
  GlossaryPathChangedEvent,
  GlossaryPathsSnapshotEvent,
  GlossaryProjectGeneration,
  GlossarySubscriptionEvent,
  UrlProjectId,
} from "@yep-anywhere/shared";
import {
  createManagedStream,
  type ManagedStream,
  SERVER_PUSH_INACTIVITY_TIMEOUT_MS,
  type SourceTransport,
} from "../transport";

const ROOT_CONTEXT_KEY = "";
const DEFAULT_MAX_INACTIVE_ARTIFACTS = 32;
const DEFAULT_MAX_INACTIVE_BYTES = 32 * 1024 * 1024;

export interface GlossaryArtifactStoreOptions {
  maxInactiveArtifacts?: number;
  maxInactiveBytes?: number;
}

export type GlossaryArtifactState =
  | "idle"
  | "loading"
  | "ready"
  | "none"
  | "disabled"
  | "error";

export interface GlossaryArtifactSnapshot {
  state: GlossaryArtifactState;
  result?: GlossaryArtifactResponse;
  error?: Error;
}

interface ArtifactEntry {
  sourcePath?: string;
  snapshot: GlossaryArtifactSnapshot;
  requested: boolean;
  requestSerial: number;
  lastUsedSerial: number;
  estimatedBytes: number;
}

interface ActiveProject {
  projectId: UrlProjectId;
  transport: SourceTransport;
  activationSerial: number;
}

const IDLE_SNAPSHOT: GlossaryArtifactSnapshot = { state: "idle" };

function sameGeneration(
  left: GlossaryProjectGeneration | null,
  right: GlossaryProjectGeneration | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.epoch === right.epoch &&
    left.sequence === right.sequence
  );
}

function normalizeSourcePath(sourcePath: string | undefined): string | null {
  if (sourcePath === undefined) return ROOT_CONTEXT_KEY;
  const normalized = sourcePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    return null;
  }
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.join("/") || null;
}

function glossaryDirectory(glossaryPath: string): string {
  const suffix = "/GLOSSARY.md";
  return glossaryPath.endsWith(suffix)
    ? glossaryPath.slice(0, -suffix.length)
    : "";
}

function sourceIsBelowDirectory(
  sourcePath: string | undefined,
  directory: string,
): boolean {
  if (!directory) return true;
  return (
    sourcePath === directory || sourcePath?.startsWith(`${directory}/`) === true
  );
}

function isGlossarySubscriptionEvent(
  value: unknown,
): value is GlossarySubscriptionEvent {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === "glossary-paths-snapshot" || type === "glossary-path-changed";
}

function estimateResponseBytes(
  result: GlossaryArtifactResponse | undefined,
): number {
  return result === undefined
    ? 0
    : new TextEncoder().encode(JSON.stringify(result)).byteLength;
}

/** Tab-local cache for the one project currently rendered by the tab. */
export class GlossaryArtifactStore {
  private active: ActiveProject | null = null;
  private stream: ManagedStream | null = null;
  private paths = new Set<string>();
  private pathsReady = false;
  private generation: GlossaryProjectGeneration | null = null;
  private entries = new Map<string, ArtifactEntry>();
  private listeners = new Map<string, Set<() => void>>();
  private activationSerial = 0;
  private accessSerial = 0;
  private readonly maxInactiveArtifacts: number;
  private readonly maxInactiveBytes: number;

  constructor(options: GlossaryArtifactStoreOptions = {}) {
    this.maxInactiveArtifacts = Math.max(
      0,
      Math.floor(
        options.maxInactiveArtifacts ?? DEFAULT_MAX_INACTIVE_ARTIFACTS,
      ),
    );
    this.maxInactiveBytes = Math.max(
      0,
      Math.floor(options.maxInactiveBytes ?? DEFAULT_MAX_INACTIVE_BYTES),
    );
  }

  activate(projectId: UrlProjectId, transport: SourceTransport): void {
    if (
      this.active?.projectId === projectId &&
      this.active.transport === transport
    ) {
      return;
    }
    if (this.active) this.deactivate();
    const activationSerial = ++this.activationSerial;
    this.active = { projectId, transport, activationSerial };
    this.stream = createManagedStream(
      transport,
      {
        subscribe: ({ transport: activeTransport, handlers }) =>
          activeTransport.subscribeGlossary(projectId, handlers),
        onEvent: (event) => {
          if (this.active?.activationSerial !== activationSerial) return;
          if (!isGlossarySubscriptionEvent(event.data)) return;
          this.handleSubscriptionEvent(event.data);
        },
      },
      { inactivityTimeoutMs: SERVER_PUSH_INACTIVITY_TIMEOUT_MS },
    );
  }

  deactivate(): void {
    this.stream?.close();
    this.stream = null;
    this.active = null;
    this.paths.clear();
    this.pathsReady = false;
    this.generation = null;
    for (const entry of this.entries.values()) entry.requestSerial += 1;
    this.entries.clear();
    this.emitAll();
  }

  getSnapshot(sourcePath?: string): GlossaryArtifactSnapshot {
    const key = normalizeSourcePath(sourcePath);
    if (key === null) return IDLE_SNAPSHOT;
    const entry = this.entries.get(key);
    if (!entry) return IDLE_SNAPSHOT;
    this.touch(entry);
    return entry.snapshot;
  }

  subscribe(sourcePath: string | undefined, listener: () => void): () => void {
    const key = normalizeSourcePath(sourcePath);
    if (key === null) return () => {};
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    const entry = this.entries.get(key);
    if (entry) this.touch(entry);
    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(key);
        const currentEntry = this.entries.get(key);
        if (currentEntry) {
          currentEntry.requested = false;
          this.touch(currentEntry);
        }
        this.pruneInactiveEntries();
      }
    };
  }

  ensure(sourcePath?: string): void {
    const key = normalizeSourcePath(sourcePath);
    if (key === null) return;
    const entry = this.getOrCreateEntry(key);
    entry.requested = true;
    this.touch(entry);
    this.ensureEntry(key, entry);
  }

  diagnostics(): {
    activeProjectId: UrlProjectId | null;
    artifacts: number;
    glossaryPaths: number;
    inactiveArtifacts: number;
    inactiveBytes: number;
    pathsReady: boolean;
  } {
    let inactiveArtifacts = 0;
    let inactiveBytes = 0;
    for (const [key, entry] of this.entries) {
      if (this.isPinned(key, entry)) continue;
      inactiveArtifacts += 1;
      inactiveBytes += entry.estimatedBytes;
    }
    return {
      activeProjectId: this.active?.projectId ?? null,
      artifacts: this.entries.size,
      glossaryPaths: this.paths.size,
      inactiveArtifacts,
      inactiveBytes,
      pathsReady: this.pathsReady,
    };
  }

  private handleSubscriptionEvent(event: GlossarySubscriptionEvent): void {
    if (event.type === "glossary-paths-snapshot") {
      this.handleSnapshot(event);
    } else {
      this.handlePathChange(event);
    }
  }

  private handleSnapshot(event: GlossaryPathsSnapshotEvent): void {
    const hadSnapshot = this.pathsReady;
    const generationChanged =
      hadSnapshot && !sameGeneration(this.generation, event.generation);
    this.paths = new Set(event.paths);
    this.pathsReady = true;
    this.generation = event.generation;
    if (!hadSnapshot) {
      this.invalidateEntries((entry) => entry.snapshot.state === "loading");
    } else if (generationChanged) {
      this.invalidateEntries(() => true);
    }
    this.ensureRequestedEntries();
    this.pruneInactiveEntries();
  }

  private handlePathChange(event: GlossaryPathChangedEvent): void {
    const expectedNextSequence = (this.generation?.sequence ?? -1) + 1;
    const missedChange =
      !this.generation ||
      this.generation.epoch !== event.generation.epoch ||
      event.generation.sequence !== expectedNextSequence;

    if (event.changeType === "delete") this.paths.delete(event.path);
    else this.paths.add(event.path);
    this.pathsReady = true;
    this.generation = event.generation;

    if (missedChange || event.changeType === "create") {
      // A newly created glossary may satisfy an include that was previously
      // unresolved anywhere in the project.
      this.invalidateEntries(() => true);
    } else {
      const directory = glossaryDirectory(event.path);
      this.invalidateEntries((entry) => {
        const dependencies =
          entry.snapshot.result && "dependencies" in entry.snapshot.result
            ? entry.snapshot.result.dependencies
            : [];
        const dependencyChanged = dependencies.some(
          (dependency) => dependency.path === event.path,
        );
        return (
          dependencyChanged ||
          (event.changeType === "delete" &&
            sourceIsBelowDirectory(entry.sourcePath, directory))
        );
      });
    }
    this.ensureRequestedEntries();
    this.pruneInactiveEntries();
  }

  private invalidateEntries(
    predicate: (entry: ArtifactEntry) => boolean,
  ): void {
    for (const [key, entry] of this.entries) {
      if (!predicate(entry)) continue;
      entry.requestSerial += 1;
      entry.snapshot = IDLE_SNAPSHOT;
      entry.estimatedBytes = 0;
      this.emit(key);
    }
  }

  private ensureRequestedEntries(): void {
    for (const [key, entry] of this.entries) {
      if (entry.requested) this.ensureEntry(key, entry);
    }
  }

  private ensureEntry(key: string, entry: ArtifactEntry): void {
    if (!this.active || entry.snapshot.state === "loading") {
      return;
    }
    if (
      entry.snapshot.state === "ready" ||
      entry.snapshot.state === "none" ||
      entry.snapshot.state === "disabled"
    ) {
      return;
    }

    const reusableRootEntry = this.findReusableRootEntry(entry);
    if (reusableRootEntry) {
      entry.snapshot = reusableRootEntry.snapshot;
      entry.estimatedBytes = reusableRootEntry.estimatedBytes;
      this.touch(entry);
      this.emit(key);
      return;
    }

    const active = this.active;
    const generation = this.generation;
    const requestSerial = ++entry.requestSerial;
    entry.snapshot = { state: "loading" };
    entry.estimatedBytes = 0;
    this.emit(key);
    const params = new URLSearchParams();
    if (entry.sourcePath !== undefined) {
      params.set("sourcePath", entry.sourcePath);
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    void active.transport
      .fetch<GlossaryArtifactResponse>(
        `/projects/${encodeURIComponent(active.projectId)}/glossary-artifact${suffix}`,
      )
      .then((result) => {
        if (
          this.active !== active ||
          entry.requestSerial !== requestSerial ||
          (generation !== null && !sameGeneration(generation, this.generation))
        ) {
          return;
        }
        entry.snapshot = {
          state: result.status,
          result,
        };
        entry.estimatedBytes = estimateResponseBytes(result);
        this.touch(entry);
        this.emit(key);
        this.pruneInactiveEntries();
      })
      .catch((error) => {
        if (this.active !== active || entry.requestSerial !== requestSerial) {
          return;
        }
        entry.snapshot = {
          state: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
        entry.estimatedBytes = 0;
        this.touch(entry);
        this.emit(key);
        this.pruneInactiveEntries();
      });
  }

  private findReusableRootEntry(entry: ArtifactEntry): ArtifactEntry | null {
    if (entry.sourcePath !== undefined || !this.pathsReady) return null;
    for (const candidate of this.entries.values()) {
      if (candidate === entry) continue;
      const result = candidate.snapshot.result;
      if (
        (candidate.snapshot.state === "ready" ||
          candidate.snapshot.state === "disabled") &&
        result &&
        "governingPath" in result &&
        result.governingPath === "GLOSSARY.md"
      ) {
        return candidate;
      }
    }
    return null;
  }

  private getOrCreateEntry(key: string): ArtifactEntry {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: ArtifactEntry = {
      sourcePath: key || undefined,
      snapshot: IDLE_SNAPSHOT,
      requested: false,
      requestSerial: 0,
      lastUsedSerial: ++this.accessSerial,
      estimatedBytes: 0,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private touch(entry: ArtifactEntry): void {
    entry.lastUsedSerial = ++this.accessSerial;
  }

  private isPinned(key: string, entry: ArtifactEntry): boolean {
    return (
      entry.requested ||
      entry.snapshot.state === "loading" ||
      this.listeners.has(key)
    );
  }

  private pruneInactiveEntries(): void {
    const inactive = Array.from(this.entries.entries())
      .filter(([key, entry]) => !this.isPinned(key, entry))
      .sort(
        ([, left], [, right]) => left.lastUsedSerial - right.lastUsedSerial,
      );
    let inactiveArtifacts = inactive.length;
    let inactiveBytes = inactive.reduce(
      (total, [, entry]) => total + entry.estimatedBytes,
      0,
    );

    for (const [key, entry] of inactive) {
      if (
        inactiveArtifacts <= this.maxInactiveArtifacts &&
        inactiveBytes <= this.maxInactiveBytes
      ) {
        break;
      }
      this.entries.delete(key);
      inactiveArtifacts -= 1;
      inactiveBytes -= entry.estimatedBytes;
    }
  }

  private emit(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  private emitAll(): void {
    for (const listeners of this.listeners.values()) {
      for (const listener of listeners) listener();
    }
  }
}
