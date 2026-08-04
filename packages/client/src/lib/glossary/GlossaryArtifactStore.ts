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
  type SourceTransport,
} from "../transport";

const ROOT_CONTEXT_KEY = "";
const MAX_ARTIFACTS = 64;

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
  lastUsedAt: number;
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

function findGoverningGlossary(
  paths: Set<string>,
  sourcePath: string | undefined,
): string | null {
  if (sourcePath === undefined) {
    return paths.has("GLOSSARY.md") ? "GLOSSARY.md" : null;
  }
  const parts = sourcePath.split("/");
  if (parts.at(-1) === "GLOSSARY.md") return null;
  parts.pop();
  while (true) {
    const candidate =
      parts.length > 0 ? `${parts.join("/")}/GLOSSARY.md` : "GLOSSARY.md";
    if (paths.has(candidate)) return candidate;
    if (parts.length === 0) return null;
    parts.pop();
  }
}

function isGlossarySubscriptionEvent(
  value: unknown,
): value is GlossarySubscriptionEvent {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === "glossary-paths-snapshot" || type === "glossary-path-changed";
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
    this.stream = createManagedStream(transport, {
      subscribe: ({ transport: activeTransport, handlers }) =>
        activeTransport.subscribeGlossary(projectId, handlers),
      onEvent: (event) => {
        if (this.active?.activationSerial !== activationSerial) return;
        if (!isGlossarySubscriptionEvent(event.data)) return;
        this.handleSubscriptionEvent(event.data);
      },
    });
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
    return this.entries.get(key)?.snapshot ?? IDLE_SNAPSHOT;
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
    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(key);
        const entry = this.entries.get(key);
        if (entry) entry.requested = false;
      }
    };
  }

  ensure(sourcePath?: string): void {
    const key = normalizeSourcePath(sourcePath);
    if (key === null) return;
    const entry = this.getOrCreateEntry(key);
    entry.requested = true;
    entry.lastUsedAt = Date.now();
    this.ensureEntry(key, entry);
    this.evictEntries();
  }

  diagnostics(): {
    activeProjectId: UrlProjectId | null;
    artifacts: number;
    glossaryPaths: number;
    pathsReady: boolean;
  } {
    return {
      activeProjectId: this.active?.projectId ?? null,
      artifacts: this.entries.size,
      glossaryPaths: this.paths.size,
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
    if (generationChanged) {
      this.invalidateEntries(() => true);
    }
    this.ensureRequestedEntries();
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
  }

  private invalidateEntries(
    predicate: (entry: ArtifactEntry) => boolean,
  ): void {
    for (const [key, entry] of this.entries) {
      if (!predicate(entry)) continue;
      entry.requestSerial += 1;
      entry.snapshot = IDLE_SNAPSHOT;
      this.emit(key);
    }
  }

  private ensureRequestedEntries(): void {
    for (const [key, entry] of this.entries) {
      if (entry.requested) this.ensureEntry(key, entry);
    }
  }

  private ensureEntry(key: string, entry: ArtifactEntry): void {
    if (
      !this.active ||
      !this.pathsReady ||
      entry.snapshot.state === "loading"
    ) {
      return;
    }
    if (
      entry.snapshot.state === "ready" ||
      entry.snapshot.state === "none" ||
      entry.snapshot.state === "disabled"
    ) {
      return;
    }

    const governingPath = findGoverningGlossary(this.paths, entry.sourcePath);
    if (!governingPath) {
      entry.snapshot = {
        state: "none",
        result: {
          reason:
            entry.sourcePath?.endsWith("/GLOSSARY.md") ||
            entry.sourcePath === "GLOSSARY.md"
              ? "governing-glossary-is-source"
              : "no-governing-glossary",
          status: "none",
        },
      };
      this.emit(key);
      return;
    }

    const active = this.active;
    const generation = this.generation;
    const requestSerial = ++entry.requestSerial;
    entry.snapshot = { state: "loading" };
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
          !sameGeneration(generation, this.generation)
        ) {
          return;
        }
        entry.snapshot = {
          state: result.status,
          result,
        };
        this.emit(key);
      })
      .catch((error) => {
        if (this.active !== active || entry.requestSerial !== requestSerial) {
          return;
        }
        entry.snapshot = {
          state: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
        this.emit(key);
      });
  }

  private getOrCreateEntry(key: string): ArtifactEntry {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: ArtifactEntry = {
      sourcePath: key || undefined,
      snapshot: IDLE_SNAPSHOT,
      requested: false,
      requestSerial: 0,
      lastUsedAt: Date.now(),
    };
    this.entries.set(key, entry);
    return entry;
  }

  private evictEntries(): void {
    if (this.entries.size <= MAX_ARTIFACTS) return;
    const candidates = [...this.entries.entries()]
      .filter(
        ([key, entry]) =>
          (this.listeners.get(key)?.size ?? 0) === 0 &&
          entry.snapshot.state !== "loading",
      )
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    while (this.entries.size > MAX_ARTIFACTS && candidates.length > 0) {
      this.entries.delete(candidates.shift()![0]);
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
