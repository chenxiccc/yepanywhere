import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { getLogger } from "../logging/logger.js";

const MAX_CACHED_NODES = 50_000;
const MAX_WARM_DEPTH = 12;
const LOOKUP_CONCURRENCY = 8;
const COARSE_MTIME_WINDOW_MS = 2_000;
const STABLE_READ_ATTEMPTS = 2;

type IoPhase = "lookup" | "warm";

interface MutablePathIndexStats {
  lookupBatches: number;
  lookupCandidates: number;
  lookupReaddirCalls: number;
  lookupStatCalls: number;
  unstableDirectoryReads: number;
  warmDirectories: number;
  warmReaddirCalls: number;
  warmStatCalls: number;
}

export interface ProjectPathIndexStats extends MutablePathIndexStats {
  cachedNodes: number;
  cacheLimitHit: boolean;
}

interface PathNode {
  cacheResident: boolean;
  children: Map<string, PathNode>;
  isDirectory: boolean;
  mtimeMs: number | undefined;
  needsSettledRefresh: boolean;
  populated: boolean;
  refreshing: Promise<DirectorySnapshot> | undefined;
}

interface DirectorySnapshot {
  cached: boolean;
  directories: ReadonlyArray<readonly [string, PathNode]>;
  get(name: string): PathNode | undefined;
}

interface ParsedCandidate {
  components: string[];
  original: string;
}

interface PathIndexOptions {
  maxCachedNodes?: number;
  maxWarmDepth?: number;
  startWarm?: boolean;
}

interface CrawlExclusions {
  paths: ReadonlySet<string>;
  useDefaults: boolean;
}

const DEFAULT_CRAWL_EXCLUSIONS: CrawlExclusions = {
  paths: new Set<string>(),
  useDefaults: true,
};

const indexes = new Map<string, Promise<LazyProjectPathIndex>>();
const warnedYepignoreProjects = new Set<string>();

function createNode(isDirectory: boolean, cacheResident = false): PathNode {
  return {
    cacheResident,
    children: new Map(),
    isDirectory,
    mtimeMs: undefined,
    needsSettledRefresh: false,
    populated: false,
    refreshing: undefined,
  };
}

function isPortableAbsolute(path: string): boolean {
  return (
    isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^[/\\]{2}/.test(path)
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

function isUnavailablePathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EACCES" ||
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EPERM"
  );
}

function cachedSnapshot(node: PathNode): DirectorySnapshot {
  return {
    cached: true,
    directories: Array.from(node.children).filter(
      (entry): entry is [string, PathNode] => entry[1].isDirectory,
    ),
    get: (name) => node.children.get(name),
  };
}

function ephemeralSnapshot(entries: readonly Dirent[]): DirectorySnapshot {
  const kinds = new Map(entries.map((entry) => [entry.name, entry.isDirectory()]));
  const requestedNodes = new Map<string, PathNode>();
  return {
    cached: false,
    directories: [],
    get(name) {
      if (!kinds.has(name)) return undefined;
      let node = requestedNodes.get(name);
      if (!node) {
        node = createNode(kinds.get(name) === true);
        requestedNodes.set(name, node);
      }
      return node;
    },
  };
}

const MISSING_DIRECTORY: DirectorySnapshot = {
  cached: false,
  directories: [],
  get: () => undefined,
};

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

function parseYepignore(content: string): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const sourceLine of content.split("\n")) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const components = parseRelativeComponents(line);
    if (!components) {
      throw new Error(`invalid project-relative directory: ${line}`);
    }
    paths.add(components.join("/"));
  }
  return paths;
}

function warnYepignoreOnce(projectPath: string, error: unknown): void {
  if (warnedYepignoreProjects.has(projectPath)) return;
  warnedYepignoreProjects.add(projectPath);
  getLogger().warn(
    { err: error, projectPath },
    "PROJECT_PATH_INDEX: invalid .yepignore; using default crawl exclusions",
  );
}

async function readCrawlExclusions(
  projectPath: string,
): Promise<CrawlExclusions> {
  try {
    const content = await readFile(join(projectPath, ".yepignore"), "utf8");
    return { paths: parseYepignore(content), useDefaults: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnYepignoreOnce(projectPath, error);
    }
    return DEFAULT_CRAWL_EXCLUSIONS;
  }
}

class LazyProjectPathIndex implements ProjectPathIndex {
  private readonly maxCachedNodes: number;
  private readonly maxWarmDepth: number;
  private readonly root = createNode(true, true);
  private readonly stats: MutablePathIndexStats = {
    lookupBatches: 0,
    lookupCandidates: 0,
    lookupReaddirCalls: 0,
    lookupStatCalls: 0,
    unstableDirectoryReads: 0,
    warmDirectories: 0,
    warmReaddirCalls: 0,
    warmStatCalls: 0,
  };
  private cacheLimitHit = false;
  private cachedNodes = 1;
  private disposed = false;
  private readonly warmPromise: Promise<void>;

  constructor(
    private readonly projectPath: string,
    private readonly crawlExclusions: CrawlExclusions,
    options: PathIndexOptions,
  ) {
    this.maxCachedNodes = Math.max(1, options.maxCachedNodes ?? MAX_CACHED_NODES);
    this.maxWarmDepth = options.maxWarmDepth ?? MAX_WARM_DEPTH;
    this.warmPromise =
      options.startWarm === false
        ? Promise.resolve()
        : this.warm().catch((error) => {
            getLogger().warn(
              { err: error, projectPath: this.projectPath },
              "PROJECT_PATH_INDEX: bounded warm stopped after an error",
            );
          });
  }

  get size(): number {
    return Math.max(0, this.cachedNodes - 1);
  }

  get truncated(): boolean {
    return this.cacheLimitHit;
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
    const batchDirectories = new Map<string, Promise<DirectorySnapshot>>();
    await forEachConcurrent(
      Array.from(groups.values()),
      LOOKUP_CONCURRENCY,
      async (group) => {
        const first = group[0];
        if (!first) return;
        const parent = await this.resolveDirectory(
          first.components.slice(0, -1),
          batchDirectories,
        );
        if (!parent) return;
        const snapshot = await this.validateOnce(
          parent.node,
          parent.absolutePath,
          "lookup",
          batchDirectories,
        );
        for (const candidate of group) {
          const name = candidate.components.at(-1);
          if (!name) continue;
          const node = snapshot.get(name);
          if (node && !node.isDirectory) found.add(candidate.original);
        }
      },
    );
    return found;
  }

  diagnostics(): ProjectPathIndexStats {
    return {
      ...this.stats,
      cachedNodes: this.cachedNodes,
      cacheLimitHit: this.cacheLimitHit,
    };
  }

  resetDiagnostics(): void {
    for (const key of Object.keys(this.stats) as Array<keyof MutablePathIndexStats>) {
      this.stats[key] = 0;
    }
  }

  async waitForWarm(): Promise<void> {
    await this.warmPromise;
  }

  dispose(): void {
    this.disposed = true;
  }

  private async resolveDirectory(
    components: readonly string[],
    batchDirectories: Map<string, Promise<DirectorySnapshot>>,
  ): Promise<{ absolutePath: string; node: PathNode } | null> {
    let absolutePath = this.projectPath;
    let node = this.root;
    for (const component of components) {
      let child = node.children.get(component);
      if (!child?.isDirectory) {
        const snapshot = await this.validateOnce(
          node,
          absolutePath,
          "lookup",
          batchDirectories,
        );
        child = snapshot.get(component);
      }
      if (!child?.isDirectory) return null;
      absolutePath = join(absolutePath, component);
      node = child;
    }
    return { absolutePath, node };
  }

  private validateOnce(
    node: PathNode,
    absolutePath: string,
    phase: IoPhase,
    batchDirectories: Map<string, Promise<DirectorySnapshot>>,
  ): Promise<DirectorySnapshot> {
    const existing = batchDirectories.get(absolutePath);
    if (existing) return existing;
    const pending = this.validateDirectory(node, absolutePath, phase);
    batchDirectories.set(absolutePath, pending);
    return pending;
  }

  private async validateDirectory(
    node: PathNode,
    absolutePath: string,
    phase: IoPhase,
  ): Promise<DirectorySnapshot> {
    if (node.refreshing) return node.refreshing;
    const pending = this.readDirectory(node, absolutePath, phase);
    node.refreshing = pending;
    try {
      return await pending;
    } finally {
      if (node.refreshing === pending) node.refreshing = undefined;
    }
  }

  private async readDirectory(
    node: PathNode,
    absolutePath: string,
    phase: IoPhase,
  ): Promise<DirectorySnapshot> {
    let before: Stats;
    try {
      before = await this.statDirectory(absolutePath, phase);
    } catch (error) {
      if (!isUnavailablePathError(error)) throw error;
      this.clearListing(node);
      return MISSING_DIRECTORY;
    }
    if (!before.isDirectory()) {
      this.clearListing(node);
      return MISSING_DIRECTORY;
    }

    if (
      node.populated &&
      node.mtimeMs === before.mtimeMs &&
      !node.needsSettledRefresh
    ) {
      return cachedSnapshot(node);
    }

    let entries: Dirent[] = [];
    for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
      try {
        entries = await this.readEntries(absolutePath, phase);
      } catch (error) {
        if (!isUnavailablePathError(error)) throw error;
        this.clearListing(node);
        return MISSING_DIRECTORY;
      }

      let after: Stats;
      try {
        after = await this.statDirectory(absolutePath, phase);
      } catch (error) {
        if (!isUnavailablePathError(error)) throw error;
        this.clearListing(node);
        return MISSING_DIRECTORY;
      }
      if (!after.isDirectory()) {
        this.clearListing(node);
        return MISSING_DIRECTORY;
      }
      if (before.mtimeMs === after.mtimeMs) {
        return this.cacheListing(node, entries, after.mtimeMs);
      }
      before = after;
    }

    this.stats.unstableDirectoryReads += 1;
    this.clearListing(node);
    return ephemeralSnapshot(entries);
  }

  private async statDirectory(absolutePath: string, phase: IoPhase) {
    if (phase === "lookup") this.stats.lookupStatCalls += 1;
    else this.stats.warmStatCalls += 1;
    return stat(absolutePath);
  }

  private async readEntries(
    absolutePath: string,
    phase: IoPhase,
  ): Promise<Dirent[]> {
    if (phase === "lookup") this.stats.lookupReaddirCalls += 1;
    else this.stats.warmReaddirCalls += 1;
    return readdir(absolutePath, { withFileTypes: true });
  }

  private cacheListing(
    node: PathNode,
    entries: readonly Dirent[],
    mtimeMs: number,
  ): DirectorySnapshot {
    if (!node.cacheResident) return ephemeralSnapshot(entries);
    const oldDescendants = this.countDescendants(node);
    const remaining =
      this.maxCachedNodes - (this.cachedNodes - oldDescendants);
    if (entries.length > remaining) {
      this.cacheLimitHit = true;
      this.clearListing(node);
      return ephemeralSnapshot(entries);
    }

    this.clearListing(node);
    for (const entry of entries) {
      node.children.set(entry.name, createNode(entry.isDirectory(), true));
    }
    this.cachedNodes += entries.length;
    node.mtimeMs = mtimeMs;
    node.needsSettledRefresh =
      Date.now() - mtimeMs <= COARSE_MTIME_WINDOW_MS;
    node.populated = true;
    return cachedSnapshot(node);
  }

  private countDescendants(node: PathNode): number {
    let count = 0;
    for (const child of node.children.values()) {
      count += 1 + this.countDescendants(child);
    }
    return count;
  }

  private detachDescendants(node: PathNode): number {
    let count = 0;
    for (const child of node.children.values()) {
      count += 1 + this.detachDescendants(child);
      child.cacheResident = false;
      child.children.clear();
    }
    return count;
  }

  private clearListing(node: PathNode): void {
    this.cachedNodes -= this.detachDescendants(node);
    node.children.clear();
    node.mtimeMs = undefined;
    node.needsSettledRefresh = false;
    node.populated = false;
  }

  private async warm(): Promise<void> {
    const queue: Array<{
      absolutePath: string;
      depth: number;
      node: PathNode;
      relativeParts: string[];
    }> = [
      {
        absolutePath: this.projectPath,
        depth: 0,
        node: this.root,
        relativeParts: [],
      },
    ];

    for (let cursor = 0; cursor < queue.length && !this.disposed; cursor += 1) {
      if (this.cacheLimitHit) break;
      const current = queue[cursor];
      if (!current) continue;
      const snapshot = await this.validateDirectory(
        current.node,
        current.absolutePath,
        "warm",
      );
      if (!snapshot.cached) continue;
      this.stats.warmDirectories += 1;
      if (current.depth >= this.maxWarmDepth) continue;

      for (const [name, child] of snapshot.directories) {
        const relativeParts = [...current.relativeParts, name];
        if (this.isCrawlExcluded(relativeParts, name)) continue;
        queue.push({
          absolutePath: join(current.absolutePath, name),
          depth: current.depth + 1,
          node: child,
          relativeParts,
        });
      }
    }
  }

  private isCrawlExcluded(relativeParts: readonly string[], name: string): boolean {
    if (name === ".git") return true;
    if (this.crawlExclusions.useDefaults && name === "node_modules") return true;
    return this.crawlExclusions.paths.has(relativeParts.join("/"));
  }
}

async function createIndex(
  projectPath: string,
  options: PathIndexOptions = {},
): Promise<LazyProjectPathIndex> {
  const resolvedPath = resolve(projectPath);
  const exclusions = await readCrawlExclusions(resolvedPath);
  return new LazyProjectPathIndex(resolvedPath, exclusions, options);
}

export interface ProjectPathIndex {
  /** Existing files from one content-resolution batch. */
  findExisting(paths: readonly string[]): Promise<ReadonlySet<string>>;
  /** Whether this exact project-relative path is a file in the project. */
  has(path: string): Promise<boolean>;
  /** Cached path-component count, for diagnostics. */
  readonly size: number;
  /** Whether the cache bound has prevented a directory listing from sticking. */
  readonly truncated: boolean;
}

/**
 * Return the project's lazy filesystem index. Starting an index reads its
 * crawl-only `.yepignore` and launches one bounded warm pass; lookups never
 * wait for that warm pass and remain unrestricted by crawl exclusions.
 */
export async function getProjectPathIndex(
  projectPath: string,
): Promise<ProjectPathIndex> {
  const resolvedPath = resolve(projectPath);
  let pending = indexes.get(resolvedPath);
  if (!pending) {
    pending = createIndex(resolvedPath).catch((error) => {
      indexes.delete(resolvedPath);
      throw error;
    });
    indexes.set(resolvedPath, pending);
  }
  return pending;
}

/** Drop a project's cached trie and stop its bounded warm after current I/O. */
export function invalidateProjectPathIndex(projectPath: string): void {
  const resolvedPath = resolve(projectPath);
  const pending = indexes.get(resolvedPath);
  indexes.delete(resolvedPath);
  void pending?.then((index) => index.dispose(), () => undefined);
}

function requireTestIndex(index: ProjectPathIndex): LazyProjectPathIndex {
  if (!(index instanceof LazyProjectPathIndex)) {
    throw new Error("Expected a project path index created by this module");
  }
  return index;
}

export const __test__ = {
  COARSE_MTIME_WINDOW_MS,
  LOOKUP_CONCURRENCY,
  MAX_CACHED_NODES,
  MAX_WARM_DEPTH,
  createIndex,
  diagnostics: (index: ProjectPathIndex) => requireTestIndex(index).diagnostics(),
  reset: () => {
    for (const pending of indexes.values()) {
      void pending.then((index) => index.dispose(), () => undefined);
    }
    indexes.clear();
    warnedYepignoreProjects.clear();
  },
  resetDiagnostics: (index: ProjectPathIndex) =>
    requireTestIndex(index).resetDiagnostics(),
  waitForWarm: (index: ProjectPathIndex) => requireTestIndex(index).waitForWarm(),
};
