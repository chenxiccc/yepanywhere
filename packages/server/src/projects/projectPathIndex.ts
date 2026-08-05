import type { Dirent, FSWatcher } from "node:fs";
import { watch } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { getLogger } from "../logging/logger.js";

/**
 * Demand-driven project path cache.
 *
 * Consumers ask whether a handful of explicitly displayed paths are files in
 * one project. The cache therefore hydrates only the directory components those
 * candidates use: a project holding 50,000 unrelated run artifacts pays nothing
 * because one displayed turn mentions `src/server.ts`.
 *
 * Cached facts are trusted only while their directory carries a live watcher,
 * so a hit costs no `stat`. Losing or never obtaining that watcher does not
 * make an answer wrong; it only makes it re-probe.
 */

/** One listing is cheaper than this many exact probes in the same directory. */
const DIRECTORY_LISTING_THRESHOLD = 4;
/** A wider listing answers its batch but is never retained. */
const MAX_RETAINED_DIRECTORY_ENTRIES = 20_000;
const PROBE_CONCURRENCY = 8;
/** Estimated retained bytes per cached path component. */
const NODE_BASE_BYTES = 96;
/** Per-project ceiling before the least recently used subtrees are dropped. */
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
/** Process-wide ceiling before the least recently used projects are dropped. */
const MAX_PROCESS_BYTES = 32 * 1024 * 1024;
/** Fraction of a ceiling that eviction returns below, so it runs in batches. */
const EVICTION_LOW_WATERMARK = 0.75;
const RECONCILE_DELAY_MS = 100;

/** What one directory-component edge is known to be. */
type NodeState = "absent" | "directory" | "file" | "unknown";

interface PathNode {
  children: Map<string, PathNode> | undefined;
  /** Whether `children` names every entry, so an unlisted name is absent. */
  complete: boolean;
  name: string;
  state: NodeState;
  watcher: FSWatcher | undefined;
  /** Whether one listing proved this directory too wide to retain whole. */
  wide: boolean;
}

interface MutablePathIndexStats {
  /** Candidates answered from cache with no filesystem call. */
  cachedAnswers: number;
  directoryListings: number;
  /** Subtrees dropped to stay within the per-project byte ceiling. */
  evictedDirectories: number;
  exactProbes: number;
  lookupBatches: number;
  lookupCandidates: number;
  /** Listings too wide to retain, used for their batch only. */
  oversizedListings: number;
  /** Watch errors that discarded a directory's cached generation. */
  uncertainGenerations: number;
  /** Cached edges invalidated by a filesystem event. */
  watcherInvalidations: number;
}

export interface ProjectPathIndexStats extends MutablePathIndexStats {
  completeDirectories: number;
  hydratedDirectories: number;
  retainedBytes: number;
  watchers: number;
}

export interface ProjectPathCacheStats {
  evictedProjects: number;
  projects: number;
  retainedBytes: number;
}

interface ParsedCandidate {
  components: string[];
  original: string;
}

type WatchListener = (event: string, filename: string | Buffer | null) => void;

/** Filesystem access, injectable so tests can count and fault-inject I/O. */
export interface PathIndexIo {
  lstat(path: string): Promise<{ isDirectory(): boolean }>;
  readdir(path: string): Promise<Dirent[]>;
  watch(path: string, listener: WatchListener): FSWatcher;
}

const DEFAULT_IO: PathIndexIo = {
  lstat: (path) => lstat(path),
  readdir: (path) => readdir(path, { withFileTypes: true }),
  watch: (path, listener) =>
    watch(path, { persistent: false }, (event, filename) =>
      listener(event, filename),
    ),
};

interface PathIndexOptions {
  io?: PathIndexIo;
  maxIndexBytes?: number;
  maxRetainedEntries?: number;
}

function createNode(name: string, state: NodeState): PathNode {
  return {
    children: undefined,
    complete: false,
    name,
    state,
    watcher: undefined,
    wide: false,
  };
}

function nodeBytes(name: string): number {
  return NODE_BASE_BYTES + name.length * 2;
}

function isPortableAbsolute(path: string): boolean {
  return (
    isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || /^[/\\]{2}/.test(path)
  );
}

function parseRelativeComponents(path: string): string[] | null {
  if (!path || path.includes("\0") || isPortableAbsolute(path)) return null;
  const rawComponents = path.split(/[\\/]+/);
  if (rawComponents.includes("..")) return null;

  const normalized = normalize(path);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`)
  ) {
    return null;
  }
  const components = normalized.split(sep).filter(Boolean);
  return components.length > 0 ? components : null;
}

/** Whether this error proves the queried path is not there. */
function provesAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isUnavailablePathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EACCES" ||
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EPERM"
  );
}

async function forEachConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        const value = values[index];
        if (value !== undefined) await visit(value);
      }
    },
  );
  await Promise.all(workers);
}

class SparseProjectPathIndex implements ProjectPathIndex {
  private readonly io: PathIndexIo;
  private readonly maxIndexBytes: number;
  private readonly maxRetainedEntries: number;
  private readonly root = createNode("", "directory");
  /** Watched directory nodes, in least-recently-used order. */
  private readonly hydrated = new Map<PathNode, string>();
  private readonly listings = new Map<
    string,
    Promise<Map<string, NodeState> | null>
  >();
  private readonly probes = new Map<string, Promise<NodeState>>();
  private readonly reconciling = new Map<PathNode, NodeJS.Timeout>();
  private readonly stats: MutablePathIndexStats = {
    cachedAnswers: 0,
    directoryListings: 0,
    evictedDirectories: 0,
    exactProbes: 0,
    lookupBatches: 0,
    lookupCandidates: 0,
    oversizedListings: 0,
    uncertainGenerations: 0,
    watcherInvalidations: 0,
  };
  private activeBatches = 0;
  private completeDirectories = 0;
  private disposed = false;
  private retainedBytes = 0;
  private watchers = 0;

  constructor(
    private readonly projectPath: string,
    options: PathIndexOptions = {},
  ) {
    this.io = options.io ?? DEFAULT_IO;
    this.maxIndexBytes = options.maxIndexBytes ?? MAX_INDEX_BYTES;
    this.maxRetainedEntries =
      options.maxRetainedEntries ?? MAX_RETAINED_DIRECTORY_ENTRIES;
  }

  get bytes(): number {
    return this.retainedBytes;
  }

  async has(path: string): Promise<boolean> {
    return (await this.findExisting([path])).has(path);
  }

  async findExisting(paths: readonly string[]): Promise<ReadonlySet<string>> {
    const candidates: ParsedCandidate[] = [];
    for (const path of paths) {
      const components = parseRelativeComponents(path);
      if (components) candidates.push({ components, original: path });
    }
    if (candidates.length === 0) return new Set();

    this.stats.lookupBatches += 1;
    this.stats.lookupCandidates += candidates.length;
    const groups = new Map<string, ParsedCandidate[]>();
    for (const candidate of candidates) {
      const parentKey = candidate.components.slice(0, -1).join("\0");
      const group = groups.get(parentKey);
      if (group) group.push(candidate);
      else groups.set(parentKey, [candidate]);
    }

    const found = new Set<string>();
    this.activeBatches += 1;
    try {
      await forEachConcurrent(
        Array.from(groups.values()),
        PROBE_CONCURRENCY,
        async (group) => {
          const first = group[0];
          if (!first) return;
          const parent = await this.resolveDirectory(
            first.components.slice(0, -1),
          );
          if (!parent) return;
          const names = group.flatMap((candidate) => {
            const name = candidate.components.at(-1);
            return name ? [name] : [];
          });
          const states = await this.resolveChildren(
            parent.node,
            parent.absolutePath,
            names,
          );
          for (const candidate of group) {
            const name = candidate.components.at(-1);
            if (name && states.get(name) === "file")
              found.add(candidate.original);
          }
        },
      );
    } finally {
      this.activeBatches -= 1;
      // Only evict between batches, so a probe in flight keeps its ancestors.
      if (this.activeBatches === 0) this.enforceIndexBudget();
    }
    return found;
  }

  release(): void {
    this.dispose();
  }

  diagnostics(): ProjectPathIndexStats {
    return {
      ...this.stats,
      completeDirectories: this.completeDirectories,
      hydratedDirectories: this.hydrated.size,
      retainedBytes: this.retainedBytes,
      watchers: this.watchers,
    };
  }

  resetDiagnostics(): void {
    for (const key of Object.keys(this.stats) as Array<
      keyof MutablePathIndexStats
    >) {
      this.stats[key] = 0;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.reconciling.values()) clearTimeout(timer);
    this.reconciling.clear();
    for (const node of Array.from(this.hydrated.keys())) this.evict(node);
    this.hydrated.clear();
  }

  /** Walk to the directory node named by `components`, hydrating on demand. */
  private async resolveDirectory(
    components: readonly string[],
  ): Promise<{ absolutePath: string; node: PathNode } | null> {
    let absolutePath = this.projectPath;
    let node = this.root;
    for (const component of components) {
      const states = await this.resolveChildren(node, absolutePath, [
        component,
      ]);
      if (states.get(component) !== "directory") return null;
      absolutePath = join(absolutePath, component);
      node =
        node.children?.get(component) ?? createNode(component, "directory");
    }
    return { absolutePath, node };
  }

  /**
   * Resolve several names in one directory. A cached fact costs nothing; a
   * sparse set of unknowns is probed exactly; a wide set is worth one listing,
   * which also answers every later name in that directory.
   */
  private async resolveChildren(
    parent: PathNode,
    parentAbsolutePath: string,
    names: readonly string[],
  ): Promise<Map<string, NodeState>> {
    const states = new Map<string, NodeState>();
    const unresolved: string[] = [];
    for (const name of new Set(names)) {
      const cached = this.cachedChildState(parent, name);
      if (cached) {
        this.stats.cachedAnswers += 1;
        states.set(name, cached);
      } else {
        unresolved.push(name);
      }
    }
    if (unresolved.length === 0) return states;

    if (
      unresolved.length >= DIRECTORY_LISTING_THRESHOLD &&
      !parent.complete &&
      !parent.wide
    ) {
      const listing = await this.listDirectory(parent, parentAbsolutePath);
      // A listing too wide to retain whole still proved these exact names, and
      // its watch was attached before the read that covered them. Keeping the
      // queried edges costs the batch's size rather than the directory's, so
      // asking again needs no second full read.
      const keepQueried = listing !== null && parent.wide;
      for (const name of unresolved) {
        const state = listing?.get(name) ?? "absent";
        states.set(name, state);
        if (keepQueried) {
          this.cacheChildState(parent, parentAbsolutePath, name, state);
        }
      }
      return states;
    }

    await forEachConcurrent(unresolved, PROBE_CONCURRENCY, async (name) => {
      states.set(name, await this.probeChild(parent, parentAbsolutePath, name));
    });
    return states;
  }

  private cachedChildState(
    parent: PathNode,
    name: string,
  ): NodeState | undefined {
    // Without a live watcher nothing keeps these facts true.
    if (!parent.watcher) return undefined;
    const child = parent.children?.get(name);
    if (child && child.state !== "unknown") {
      this.touch(parent);
      return child.state;
    }
    if (!child && parent.complete) {
      this.touch(parent);
      return "absent";
    }
    return undefined;
  }

  private probeChild(
    parent: PathNode,
    parentAbsolutePath: string,
    name: string,
  ): Promise<NodeState> {
    const absolutePath = join(parentAbsolutePath, name);
    const inFlight = this.probes.get(absolutePath);
    if (inFlight) return inFlight;
    const pending = this.runProbe(
      parent,
      parentAbsolutePath,
      absolutePath,
      name,
    ).finally(() => {
      if (this.probes.get(absolutePath) === pending) {
        this.probes.delete(absolutePath);
      }
    });
    this.probes.set(absolutePath, pending);
    return pending;
  }

  private async runProbe(
    parent: PathNode,
    parentAbsolutePath: string,
    absolutePath: string,
    name: string,
  ): Promise<NodeState> {
    this.stats.exactProbes += 1;
    let state: NodeState;
    let proven = true;
    try {
      // `lstat`, not `stat`: a symlink is a leaf here, so a link cannot make
      // the walk leave the project.
      const entry = await this.io.lstat(absolutePath);
      state = entry.isDirectory() ? "directory" : "file";
    } catch (error) {
      if (!isUnavailablePathError(error)) throw error;
      // A permission error answers this lookup but proves nothing to cache.
      proven = provesAbsence(error);
      state = "absent";
    }
    if (proven) this.cacheChildState(parent, parentAbsolutePath, name, state);
    return state;
  }

  private cacheChildState(
    parent: PathNode,
    parentAbsolutePath: string,
    name: string,
    state: NodeState,
  ): void {
    if (!this.hydrate(parent, parentAbsolutePath)) return;
    const existing = parent.children?.get(name);
    if (existing) {
      if (existing.state !== state) this.dropChildren(existing);
      existing.state = state;
      return;
    }
    this.addChild(parent, name, state);
  }

  /** Insert one new child edge, allocating the child map on first use. */
  private addChild(parent: PathNode, name: string, state: NodeState): void {
    if (!parent.children) parent.children = new Map();
    parent.children.set(name, createNode(name, state));
    this.addBytes(nodeBytes(name));
  }

  /** Read one directory completely, coalescing concurrent requests. */
  private listDirectory(
    node: PathNode,
    absolutePath: string,
  ): Promise<Map<string, NodeState> | null> {
    const inFlight = this.listings.get(absolutePath);
    if (inFlight) return inFlight;
    const pending = this.runListing(node, absolutePath).finally(() => {
      if (this.listings.get(absolutePath) === pending) {
        this.listings.delete(absolutePath);
      }
    });
    this.listings.set(absolutePath, pending);
    return pending;
  }

  private async runListing(
    node: PathNode,
    absolutePath: string,
  ): Promise<Map<string, NodeState> | null> {
    this.stats.directoryListings += 1;
    // Watch before reading: a change during the read then invalidates the
    // listing instead of being missed by it.
    const watched = this.hydrate(node, absolutePath);
    let entries: Dirent[];
    try {
      entries = await this.io.readdir(absolutePath);
    } catch (error) {
      if (!isUnavailablePathError(error)) throw error;
      this.evict(node);
      return null;
    }

    const kinds = new Map<string, NodeState>();
    for (const entry of entries) {
      kinds.set(entry.name, entry.isDirectory() ? "directory" : "file");
    }
    if (entries.length > this.maxRetainedEntries) {
      this.stats.oversizedListings += 1;
      // Retaining every name here would spend a large share of the project's
      // whole budget on one directory. Recording the width instead keeps later
      // batches on exact probes rather than re-reading it every time.
      node.wide = true;
    } else if (watched) {
      this.replaceChildren(node, kinds);
    }
    return kinds;
  }

  private replaceChildren(node: PathNode, kinds: Map<string, NodeState>): void {
    this.dropChildren(node);
    const children = new Map<string, PathNode>();
    let bytes = 0;
    for (const [name, state] of kinds) {
      children.set(name, createNode(name, state));
      bytes += nodeBytes(name);
    }
    node.children = children;
    node.complete = true;
    this.completeDirectories += 1;
    this.addBytes(bytes);
  }

  /**
   * Attach this directory's watcher, which is what makes its cached facts
   * trustworthy. Facts gathered before the watch existed are not covered by it,
   * so a first attachment starts a clean generation.
   */
  private hydrate(node: PathNode, absolutePath: string): boolean {
    if (node.watcher) {
      this.touch(node);
      return true;
    }
    if (this.disposed) return false;
    let watcher: FSWatcher;
    try {
      watcher = this.io.watch(absolutePath, (_event, filename) => {
        this.onWatchEvent(node, absolutePath, watcher, filename);
      });
    } catch (error) {
      getLogger().debug(
        { err: error, path: absolutePath },
        "PROJECT_PATH_INDEX: directory watch unavailable; answers stay uncached",
      );
      return false;
    }
    watcher.on("error", (error) => {
      this.onWatchFailure(node, absolutePath, watcher, error);
    });
    this.dropChildren(node);
    node.watcher = watcher;
    this.watchers += 1;
    this.hydrated.set(node, absolutePath);
    return true;
  }

  private onWatchEvent(
    node: PathNode,
    absolutePath: string,
    watcher: FSWatcher,
    filename: string | Buffer | null,
  ): void {
    if (node.watcher !== watcher) return;
    if (!filename) {
      // An event that does not name its entry cannot invalidate one edge.
      this.onWatchFailure(node, absolutePath, watcher, undefined);
      return;
    }
    const name =
      typeof filename === "string" ? filename : filename.toString("utf8");
    this.stats.watcherInvalidations += 1;
    const child = node.children?.get(name);
    if (child) {
      this.dropChildren(child);
      child.state = "unknown";
      return;
    }
    if (!node.complete) return;
    // A name this listing called absent may now exist.
    this.addChild(node, name, "unknown");
  }

  /**
   * A watch error or overflow leaves this directory's generation uncertain.
   * Every cached fact under it is discarded rather than trusted, and one
   * bounded listing re-establishes the truth.
   */
  private onWatchFailure(
    node: PathNode,
    absolutePath: string,
    watcher: FSWatcher,
    error: unknown,
  ): void {
    if (node.watcher !== watcher) return;
    this.stats.uncertainGenerations += 1;
    getLogger().debug(
      { err: error, path: absolutePath },
      "PROJECT_PATH_INDEX: watch generation uncertain; reconciling",
    );
    this.evict(node);
    this.scheduleReconcile(node, absolutePath);
  }

  private scheduleReconcile(node: PathNode, absolutePath: string): void {
    if (this.disposed || this.reconciling.has(node)) return;
    const timer = setTimeout(() => {
      this.reconciling.delete(node);
      if (this.disposed) return;
      void this.listDirectory(node, absolutePath).catch(() => undefined);
    }, RECONCILE_DELAY_MS);
    timer.unref?.();
    this.reconciling.set(node, timer);
  }

  private touch(node: PathNode): void {
    const absolutePath = this.hydrated.get(node);
    if (absolutePath === undefined) return;
    this.hydrated.delete(node);
    this.hydrated.set(node, absolutePath);
  }

  private addBytes(bytes: number): void {
    this.retainedBytes += bytes;
  }

  private dropChildren(node: PathNode): void {
    const children = node.children;
    if (children) {
      for (const child of children.values()) {
        this.dropChildren(child);
        this.closeWatcher(child);
        this.hydrated.delete(child);
        this.retainedBytes -= nodeBytes(child.name);
      }
      node.children = undefined;
    }
    if (node.complete) {
      node.complete = false;
      this.completeDirectories -= 1;
    }
    // A new generation re-learns the width along with everything else, so a
    // directory that has since shrunk is listed again rather than probed
    // forever.
    node.wide = false;
  }

  private closeWatcher(node: PathNode): void {
    if (!node.watcher) return;
    const watcher = node.watcher;
    node.watcher = undefined;
    this.watchers -= 1;
    try {
      watcher.close();
    } catch {
      // A watcher already closed by the platform needs nothing here.
    }
  }

  private evict(node: PathNode): void {
    this.dropChildren(node);
    this.closeWatcher(node);
    this.hydrated.delete(node);
  }

  /** Drop least-recently-used subtrees until this project fits its ceiling. */
  private enforceIndexBudget(): void {
    if (this.retainedBytes <= this.maxIndexBytes) return;
    const target = this.maxIndexBytes * EVICTION_LOW_WATERMARK;
    for (const node of Array.from(this.hydrated.keys())) {
      if (this.retainedBytes <= target) break;
      if (!this.hydrated.has(node)) continue;
      this.evict(node);
      this.stats.evictedDirectories += 1;
    }
  }
}

export interface ProjectPathIndex {
  /** Existing files from one content-resolution batch. */
  findExisting(paths: readonly string[]): Promise<ReadonlySet<string>>;
  /** Whether this exact project-relative path is a file in the project. */
  has(path: string): Promise<boolean>;
  /** Give up this caller's claim on the project's cache. */
  release(): void;
}

interface RegistryEntry {
  index: SparseProjectPathIndex;
  lastAccess: number;
  refs: number;
}

const registry = new Map<string, RegistryEntry>();
let evictedProjects = 0;

/** One caller's claim on a shared project cache. */
class ProjectPathIndexHandle implements ProjectPathIndex {
  private released = false;

  constructor(private readonly entry: RegistryEntry) {}

  findExisting(paths: readonly string[]): Promise<ReadonlySet<string>> {
    this.entry.lastAccess = Date.now();
    return this.entry.index.findExisting(paths);
  }

  has(path: string): Promise<boolean> {
    this.entry.lastAccess = Date.now();
    return this.entry.index.has(path);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.entry.refs -= 1;
    this.entry.lastAccess = Date.now();
    enforceProcessBudget();
  }
}

/**
 * Claim the project's path cache. Creating one reads nothing: the first lookup
 * hydrates only the components it needs. Release the claim when the caller is
 * done, so a cold project becomes evictable.
 */
export async function getProjectPathIndex(
  projectPath: string,
): Promise<ProjectPathIndex> {
  const resolvedPath = resolve(projectPath);
  let entry = registry.get(resolvedPath);
  if (!entry) {
    entry = {
      index: new SparseProjectPathIndex(resolvedPath),
      lastAccess: Date.now(),
      refs: 0,
    };
    registry.set(resolvedPath, entry);
  }
  entry.refs += 1;
  entry.lastAccess = Date.now();
  return new ProjectPathIndexHandle(entry);
}

/** Drop a project's cached paths and watchers; a later lookup rebuilds them. */
export function invalidateProjectPathIndex(projectPath: string): void {
  const resolvedPath = resolve(projectPath);
  const entry = registry.get(resolvedPath);
  if (!entry) return;
  registry.delete(resolvedPath);
  entry.index.dispose();
}

/** Cache effectiveness and pressure, without walking any cached tree. */
export function projectPathCacheDiagnostics(): ProjectPathCacheStats {
  let retainedBytes = 0;
  for (const entry of registry.values()) retainedBytes += entry.index.bytes;
  return { evictedProjects, projects: registry.size, retainedBytes };
}

/** Discard least-recently-used unclaimed projects until the process fits. */
function enforceProcessBudget(maxBytes = MAX_PROCESS_BYTES): void {
  let total = 0;
  for (const entry of registry.values()) total += entry.index.bytes;
  if (total <= maxBytes) return;

  const target = maxBytes * EVICTION_LOW_WATERMARK;
  const byAge = Array.from(registry.entries()).sort(
    ([, left], [, right]) => left.lastAccess - right.lastAccess,
  );
  for (const [path, entry] of byAge) {
    if (total <= target) break;
    if (entry.refs > 0) continue;
    total -= entry.index.bytes;
    registry.delete(path);
    entry.index.dispose();
    evictedProjects += 1;
  }
}

export const __test__ = {
  DIRECTORY_LISTING_THRESHOLD,
  MAX_PROCESS_BYTES,
  MAX_RETAINED_DIRECTORY_ENTRIES,
  RECONCILE_DELAY_MS,
  createIndex: (projectPath: string, options?: PathIndexOptions) =>
    new SparseProjectPathIndex(resolve(projectPath), options),
  diagnostics: (index: SparseProjectPathIndex) => index.diagnostics(),
  enforceProcessBudget,
  registryEntry: (projectPath: string) => registry.get(resolve(projectPath)),
  reset: () => {
    for (const entry of registry.values()) entry.index.dispose();
    registry.clear();
    evictedProjects = 0;
  },
  resetDiagnostics: (index: SparseProjectPathIndex) => index.resetDiagnostics(),
};
