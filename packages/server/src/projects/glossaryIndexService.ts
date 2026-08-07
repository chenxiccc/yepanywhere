import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import {
  GLOSSARY_LIMITS,
  compileGlossaryArtifact,
  parseFirstGlossaryTable,
  type GlossaryArtifactResponse,
  type GlossaryDependencyIdentity,
  type GlossaryLimits,
  type GlossaryResolutionDiagnostic,
  type GlossaryResolutionDiagnosticCode,
  type GlossaryRowInput,
  type ParsedGlossaryTable,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import { readFileHandleBounded } from "../utils/projectFileAccess.js";
import {
  getProjectPathIndex,
  type ProjectPathIndex,
} from "./projectPathIndex.js";

const MAX_DIAGNOSTICS = 16;
const MAX_PARSED_FILES = 512;
const MAX_COMPILED_GRAPHS = 128;
const STABLE_READ_ATTEMPTS = 3;

export type GlossaryResolutionResult = GlossaryArtifactResponse;

interface FileStatsIdentity {
  ctimeMs: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

export interface GlossaryPathObservation {
  identity: FileStatsIdentity | null;
  path: string;
}

/** Called with a canonical project root whose observation set just grew. */
export type GlossaryObservationListener = (projectRoot: string) => void;

interface GlossarySnapshot {
  canonicalPath: string;
  content: string;
  contentHash: string;
  identity: FileStatsIdentity;
  projectRelativePath: string;
}

type GlossarySnapshotRead =
  | {
      snapshot: GlossarySnapshot;
      status: "ready";
    }
  | {
      canonicalPath: string;
      projectRelativePath: string;
      status: "too-large";
    };

interface ParsedGlossaryCacheEntry {
  contentHash: string;
  includes: string[];
  table: ParsedGlossaryTable | null;
}

interface CompiledGraphCacheEntry {
  dependencyVersion: string;
  result: Exclude<GlossaryResolutionResult, { status: "none" }>;
}

interface ClosureResult {
  dependencies: GlossaryDependencyIdentity[];
  dependencyVersion: string;
  diagnostics: GlossaryResolutionDiagnostic[];
  fatal: GlossaryResolutionDiagnostic | null;
  rows: GlossaryRowInput[];
}

interface GlossaryIndexIo {
  getPathIndex(projectPath: string): Promise<ProjectPathIndex>;
  readFileBounded(path: string, maxBytes: number): Promise<Buffer | null>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileStatsIdentity & { isFile(): boolean }>;
}

export interface GlossaryIndexServiceOptions {
  compile?: typeof compileGlossaryArtifact;
  io?: Partial<GlossaryIndexIo>;
  limits?: GlossaryLimits;
  maxCompiledGraphs?: number;
  maxParsedFiles?: number;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

function toProjectRelative(root: string, candidate: string): string | null {
  if (!isContained(root, candidate)) return null;
  const rel = relative(root, candidate);
  return rel ? rel.split(sep).join("/") : "";
}

function normalizeSourcePath(
  sourcePath: string | null | undefined,
): string | null {
  if (!sourcePath) return null;
  const normalized = sourcePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    win32.isAbsolute(normalized)
  ) {
    return null;
  }
  const relativePath = posix.normalize(normalized);
  return relativePath.startsWith("../") || relativePath === ".."
    ? null
    : relativePath;
}

function governingCandidates(sourcePath: string | null): string[] {
  if (!sourcePath) return ["GLOSSARY.md"];
  let directory = dirname(sourcePath).replaceAll("\\", "/");
  if (directory === ".") directory = "";
  const candidates: string[] = [];
  while (true) {
    candidates.push(directory ? `${directory}/GLOSSARY.md` : "GLOSSARY.md");
    if (!directory) break;
    const parent = dirname(directory).replaceAll("\\", "/");
    directory = parent === "." ? "" : parent;
  }
  return candidates;
}

function stableIdentity(stats: FileStatsIdentity): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(
    ":",
  );
}

function boundedMention(mention: string): string {
  return mention.length <= 160 ? mention : `${mention.slice(0, 157)}...`;
}

/** Find authored paths whose basename is exactly GLOSSARY.md, in source order. */
export function extractGlossaryIncludeMentions(markdown: string): string[] {
  const matches: Array<{ index: number; path: string }> = [];
  const angleSpans: Array<{ end: number; start: number }> = [];
  const anglePattern = /<([^<>\r\n]*GLOSSARY\.md)>/g;
  for (const match of markdown.matchAll(anglePattern)) {
    const path = match[1]?.trim();
    if (
      path &&
      path.replaceAll("\\", "/").split("/").at(-1) === "GLOSSARY.md"
    ) {
      matches.push({ index: match.index, path });
      angleSpans.push({
        end: match.index + match[0].length,
        start: match.index,
      });
    }
  }

  const barePattern =
    /(?:^|[\s("'`[\]|])((?:(?:[A-Za-z]:)?[\\/]|\.{1,2}[\\/])?(?:[\p{L}\p{N}._@+-]+[\\/])*GLOSSARY\.md)(?=$|[\s)"'`>\],;:#|]|\.(?=$|\s))/gmu;
  for (const match of markdown.matchAll(barePattern)) {
    const path = match[1];
    if (!path) continue;
    const offset = match[0].lastIndexOf(path);
    const index = match.index + Math.max(0, offset);
    if (angleSpans.some((span) => index >= span.start && index < span.end)) {
      continue;
    }
    matches.push({ index, path });
  }

  matches.sort((left, right) => left.index - right.index);
  const seenOccurrences = new Set<string>();
  return matches
    .filter((match) => {
      const key = `${match.index}\0${match.path}`;
      if (seenOccurrences.has(key)) return false;
      seenOccurrences.add(key);
      return true;
    })
    .map((match) => match.path);
}

function makeDiagnostic(
  code: GlossaryResolutionDiagnosticCode,
  glossaryPath: string,
  message: string,
): GlossaryResolutionDiagnostic {
  return { code, glossaryPath, message };
}

function touchBoundedMap<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
  value: Value,
  maximum: number,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

async function readPathBounded(
  path: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const handle = await open(path, "r");
  try {
    return await readFileHandleBounded(handle, maxBytes);
  } finally {
    await handle.close();
  }
}

export class GlossaryIndexService {
  private readonly compile: typeof compileGlossaryArtifact;
  private readonly limits: GlossaryLimits;
  private readonly maxCompiledGraphs: number;
  private readonly maxParsedFiles: number;
  private readonly io: GlossaryIndexIo;
  private readonly inFlight = new Map<
    string,
    Promise<GlossaryResolutionResult>
  >();
  private readonly canonicalInFlight = new Map<
    string,
    Promise<GlossaryResolutionResult>
  >();
  private readonly parsedFiles = new Map<string, ParsedGlossaryCacheEntry>();
  private readonly compiledGraphs = new Map<string, CompiledGraphCacheEntry>();
  private readonly observedPaths = new Map<
    string,
    Map<string, FileStatsIdentity | null>
  >();
  private readonly observationListeners =
    new Set<GlossaryObservationListener>();

  constructor(options: GlossaryIndexServiceOptions = {}) {
    this.compile = options.compile ?? compileGlossaryArtifact;
    this.limits = options.limits ?? GLOSSARY_LIMITS;
    this.maxCompiledGraphs = Math.max(
      1,
      options.maxCompiledGraphs ?? MAX_COMPILED_GRAPHS,
    );
    this.maxParsedFiles = Math.max(
      1,
      options.maxParsedFiles ?? MAX_PARSED_FILES,
    );
    this.io = {
      getPathIndex: options.io?.getPathIndex ?? getProjectPathIndex,
      readFileBounded: options.io?.readFileBounded ?? readPathBounded,
      realpath: options.io?.realpath ?? ((path) => realpath(path)),
      stat: options.io?.stat ?? ((path) => stat(path)),
    };
  }

  resolve(
    projectPath: string,
    sourcePath?: string | null,
  ): Promise<GlossaryResolutionResult> {
    const projectKey = resolve(projectPath);
    const normalizedSource = normalizeSourcePath(sourcePath);
    if (sourcePath && !normalizedSource) {
      return Promise.resolve({ reason: "invalid-source-path", status: "none" });
    }
    const requestKey = `${projectKey}\0${normalizedSource ?? ""}`;
    const existing = this.inFlight.get(requestKey);
    if (existing) return existing;

    const pending = this.resolveUncached(projectKey, normalizedSource).finally(
      () => {
        if (this.inFlight.get(requestKey) === pending)
          this.inFlight.delete(requestKey);
      },
    );
    this.inFlight.set(requestKey, pending);
    return pending;
  }

  clear(): void {
    this.parsedFiles.clear();
    this.compiledGraphs.clear();
    this.observedPaths.clear();
  }

  /**
   * Return glossary candidates learned while resolving source contexts.
   * Missing candidates are retained so a later file creation is observable.
   */
  getObservedGlossaryPaths(projectPath: string): GlossaryPathObservation[] {
    const observations = this.observedPaths.get(resolve(projectPath));
    if (!observations) return [];
    return [...observations.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, identity]) => ({
        identity: identity ? { ...identity } : null,
        path,
      }));
  }

  /**
   * Watch the observation set grow. Resolution learns candidate and include
   * paths on demand, so a subscriber registers here to attach a watch to a
   * newly observed directory instead of waiting for its next poll.
   */
  onObservationsChanged(listener: GlossaryObservationListener): () => void {
    this.observationListeners.add(listener);
    return () => {
      this.observationListeners.delete(listener);
    };
  }

  invalidateProject(projectPath: string): void {
    const projectRoot = resolve(projectPath);
    for (const glossaryPath of this.parsedFiles.keys()) {
      if (isContained(projectRoot, glossaryPath)) {
        this.parsedFiles.delete(glossaryPath);
      }
    }
    for (const governingPath of this.compiledGraphs.keys()) {
      if (isContained(projectRoot, governingPath)) {
        this.compiledGraphs.delete(governingPath);
      }
    }
    const requestPrefix = `${projectRoot}\0`;
    for (const requestKey of this.inFlight.keys()) {
      if (requestKey.startsWith(requestPrefix))
        this.inFlight.delete(requestKey);
    }
    for (const requestKey of this.canonicalInFlight.keys()) {
      if (requestKey.startsWith(requestPrefix)) {
        this.canonicalInFlight.delete(requestKey);
      }
    }
  }

  diagnostics(): {
    compiledGraphs: number;
    inFlight: number;
    parsedFiles: number;
  } {
    return {
      compiledGraphs: this.compiledGraphs.size,
      inFlight: this.canonicalInFlight.size,
      parsedFiles: this.parsedFiles.size,
    };
  }

  private async resolveUncached(
    projectPath: string,
    sourcePath: string | null,
  ): Promise<GlossaryResolutionResult> {
    if (sourcePath && basename(sourcePath) === "GLOSSARY.md") {
      return { reason: "governing-glossary-is-source", status: "none" };
    }
    let canonicalProject: string;
    try {
      canonicalProject = await this.io.realpath(projectPath);
    } catch {
      return { reason: "no-governing-glossary", status: "none" };
    }
    const requestKey = `${canonicalProject}\0${sourcePath ?? ""}`;
    const existing = this.canonicalInFlight.get(requestKey);
    if (existing) return existing;
    const pending = this.resolveCanonical(canonicalProject, sourcePath).finally(
      () => {
        if (this.canonicalInFlight.get(requestKey) === pending) {
          this.canonicalInFlight.delete(requestKey);
        }
      },
    );
    this.canonicalInFlight.set(requestKey, pending);
    return pending;
  }

  private async resolveCanonical(
    canonicalProject: string,
    sourcePath: string | null,
  ): Promise<GlossaryResolutionResult> {
    const pathIndex = await this.io.getPathIndex(canonicalProject);
    try {
      return await this.resolveGoverning(
        canonicalProject,
        sourcePath,
        pathIndex,
      );
    } finally {
      pathIndex.release();
    }
  }

  private async resolveGoverning(
    canonicalProject: string,
    sourcePath: string | null,
    pathIndex: ProjectPathIndex,
  ): Promise<GlossaryResolutionResult> {
    const candidates = governingCandidates(sourcePath);
    this.observePaths(canonicalProject, candidates);
    const existing = await pathIndex.findExisting(candidates);
    const governingRelative = candidates.find((candidate) =>
      existing.has(candidate),
    );
    if (!governingRelative) {
      return { reason: "no-governing-glossary", status: "none" };
    }

    const governingRead = await this.readSnapshot(
      canonicalProject,
      resolve(canonicalProject, governingRelative),
      this.limits.maxGlossaryBytes,
    );
    if (!governingRead) {
      const diagnostic = makeDiagnostic(
        "invalid-governing-glossary",
        governingRelative,
        "The governing glossary is not a contained readable regular file",
      );
      return {
        dependencies: [],
        diagnostic,
        diagnostics: [diagnostic],
        governingPath: governingRelative,
        sourceVersion: null,
        status: "disabled",
      };
    }
    if (governingRead.status === "too-large") {
      const diagnostic = makeDiagnostic(
        "total-byte-limit",
        governingRead.projectRelativePath,
        `Glossary graph exceeds ${this.limits.maxGlossaryBytes} bytes`,
      );
      return {
        dependencies: [],
        diagnostic,
        diagnostics: [diagnostic],
        governingPath: governingRead.projectRelativePath,
        sourceVersion: null,
        status: "disabled",
      };
    }
    const governing = governingRead.snapshot;

    const closure = await this.buildClosure(
      canonicalProject,
      pathIndex,
      governing,
    );
    const cached = this.compiledGraphs.get(governing.canonicalPath);
    if (cached?.dependencyVersion === closure.dependencyVersion) {
      touchBoundedMap(
        this.compiledGraphs,
        governing.canonicalPath,
        cached,
        this.maxCompiledGraphs,
      );
      return cached.result;
    }

    let result: Exclude<GlossaryResolutionResult, { status: "none" }>;
    if (closure.fatal) {
      result = {
        dependencies: closure.dependencies,
        diagnostic: closure.fatal,
        diagnostics: closure.diagnostics,
        governingPath: governing.projectRelativePath,
        sourceVersion: closure.dependencyVersion,
        status: "disabled",
      };
    } else {
      const compiled = this.compile(
        closure.rows,
        closure.dependencyVersion,
        this.limits,
      );
      result = compiled.ok
        ? {
            artifact: compiled.artifact,
            dependencies: closure.dependencies,
            diagnostics: closure.diagnostics,
            governingPath: governing.projectRelativePath,
            sourceVersion: compiled.artifact.sourceVersion,
            status: "ready",
          }
        : {
            dependencies: closure.dependencies,
            diagnostic: compiled.diagnostic,
            diagnostics: closure.diagnostics,
            governingPath: governing.projectRelativePath,
            sourceVersion: closure.dependencyVersion,
            status: "disabled",
          };
    }
    touchBoundedMap(
      this.compiledGraphs,
      governing.canonicalPath,
      { dependencyVersion: closure.dependencyVersion, result },
      this.maxCompiledGraphs,
    );
    return result;
  }

  private async buildClosure(
    projectRoot: string,
    pathIndex: ProjectPathIndex,
    governing: GlossarySnapshot,
  ): Promise<ClosureResult> {
    const dependencies: GlossaryDependencyIdentity[] = [];
    const diagnostics: GlossaryResolutionDiagnostic[] = [];
    const rows: GlossaryRowInput[] = [];
    const visited = new Set<string>();
    let totalBytes = 0;
    let fatal: GlossaryResolutionDiagnostic | null = null;

    const addDiagnostic = (diagnostic: GlossaryResolutionDiagnostic) => {
      if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic);
    };

    const visit = async (
      snapshot: GlossarySnapshot,
      depth: number,
    ): Promise<void> => {
      if (fatal || visited.has(snapshot.canonicalPath)) return;
      if (depth > this.limits.maxIncludeDepth) {
        fatal = makeDiagnostic(
          "include-depth-limit",
          snapshot.projectRelativePath,
          `Glossary includes exceed depth ${this.limits.maxIncludeDepth}`,
        );
        addDiagnostic(fatal);
        return;
      }
      if (visited.size >= this.limits.maxIncludedFiles) {
        fatal = makeDiagnostic(
          "included-file-limit",
          snapshot.projectRelativePath,
          `Glossary graph exceeds ${this.limits.maxIncludedFiles} files`,
        );
        addDiagnostic(fatal);
        return;
      }
      visited.add(snapshot.canonicalPath);
      totalBytes += snapshot.identity.size;
      dependencies.push({
        contentHash: snapshot.contentHash,
        path: snapshot.projectRelativePath,
        size: snapshot.identity.size,
      });

      const parsed = this.parseSnapshot(snapshot);
      const glossaryOrder = dependencies.length - 1;
      for (const parsedRow of parsed.table?.rows ?? []) {
        rows.push({
          definitionMarkdown: parsedRow.definitionMarkdown,
          glossaryDirectory:
            dirname(snapshot.projectRelativePath) === "."
              ? ""
              : dirname(snapshot.projectRelativePath).replaceAll("\\", "/"),
          glossaryOrder,
          rowOrder: parsedRow.rowOrder,
          termMarkdown: parsedRow.termMarkdown,
        });
      }

      await this.walkIncludes(
        projectRoot,
        pathIndex,
        snapshot,
        parsed.includes,
        () => Math.max(0, this.limits.maxGlossaryBytes - totalBytes),
        async (included) => {
          if (included.status === "too-large") {
            fatal = makeDiagnostic(
              "total-byte-limit",
              included.projectRelativePath,
              `Glossary graph exceeds ${this.limits.maxGlossaryBytes} bytes`,
            );
            addDiagnostic(fatal);
            return false;
          }
          await visit(included.snapshot, depth + 1);
          return !fatal;
        },
        addDiagnostic,
      );
    };

    await visit(governing, 0);
    const dependencyVersion = createHash("sha256")
      .update(
        dependencies
          .map(
            (dependency) =>
              `${dependency.path}\0${dependency.contentHash}\0${dependency.size}`,
          )
          .join("\n"),
      )
      .digest("hex");
    return { dependencies, dependencyVersion, diagnostics, fatal, rows };
  }

  private parseSnapshot(snapshot: GlossarySnapshot): ParsedGlossaryCacheEntry {
    const cached = this.parsedFiles.get(snapshot.canonicalPath);
    if (cached?.contentHash === snapshot.contentHash) {
      touchBoundedMap(
        this.parsedFiles,
        snapshot.canonicalPath,
        cached,
        this.maxParsedFiles,
      );
      return cached;
    }
    const parsed = {
      contentHash: snapshot.contentHash,
      includes: extractGlossaryIncludeMentions(snapshot.content),
      table: parseFirstGlossaryTable(snapshot.content),
    };
    touchBoundedMap(
      this.parsedFiles,
      snapshot.canonicalPath,
      parsed,
      this.maxParsedFiles,
    );
    return parsed;
  }

  private async walkIncludes(
    projectRoot: string,
    pathIndex: ProjectPathIndex,
    referring: GlossarySnapshot,
    mentions: readonly string[],
    remainingBytes: () => number,
    visit: (snapshot: GlossarySnapshotRead) => Promise<boolean>,
    addDiagnostic: (diagnostic: GlossaryResolutionDiagnostic) => void,
  ): Promise<void> {
    const mentionCandidates: Array<{
      escaped: boolean;
      mention: string;
      relativePaths: string[];
    }> = [];
    const allRelativePaths: string[] = [];

    for (const mention of mentions) {
      const normalizedMention = mention.replaceAll("\\", sep);
      const relativePaths: string[] = [];
      let escaped = isAbsolute(normalizedMention) || win32.isAbsolute(mention);
      if (!escaped) {
        for (const base of [dirname(referring.canonicalPath), projectRoot]) {
          const absoluteCandidate = resolve(base, normalizedMention);
          const projectRelative = toProjectRelative(
            projectRoot,
            absoluteCandidate,
          );
          if (projectRelative === null) {
            escaped = true;
            continue;
          }
          if (!relativePaths.includes(projectRelative)) {
            relativePaths.push(projectRelative);
            allRelativePaths.push(projectRelative);
          }
        }
      }
      mentionCandidates.push({ escaped, mention, relativePaths });
    }

    const existing = await pathIndex.findExisting(allRelativePaths);
    this.observePaths(projectRoot, allRelativePaths);
    const includedCanonical = new Set<string>();
    for (const entry of mentionCandidates) {
      let retained = 0;
      for (const relativePath of entry.relativePaths) {
        if (!existing.has(relativePath)) continue;
        const snapshot = await this.readSnapshot(
          projectRoot,
          resolve(projectRoot, relativePath),
          remainingBytes(),
        );
        if (!snapshot) continue;
        retained += 1;
        const canonicalPath =
          snapshot.status === "ready"
            ? snapshot.snapshot.canonicalPath
            : snapshot.canonicalPath;
        if (canonicalPath === referring.canonicalPath) continue;
        if (includedCanonical.has(canonicalPath)) continue;
        includedCanonical.add(canonicalPath);
        if (!(await visit(snapshot))) return;
      }
      if (retained === 0) {
        addDiagnostic(
          makeDiagnostic(
            entry.escaped ? "escaped-include" : "unresolved-include",
            referring.projectRelativePath,
            entry.escaped
              ? `Rejected glossary include outside the project: ${boundedMention(entry.mention)}`
              : `Glossary include did not resolve: ${boundedMention(entry.mention)}`,
          ),
        );
      }
    }
  }

  private async readSnapshot(
    projectRoot: string,
    candidatePath: string,
    maxBytes: number,
  ): Promise<GlossarySnapshotRead | null> {
    let canonicalPath: string;
    try {
      canonicalPath = await this.io.realpath(candidatePath);
    } catch {
      return null;
    }
    if (!isContained(projectRoot, canonicalPath)) return null;
    const projectRelativePath = toProjectRelative(projectRoot, canonicalPath);
    if (projectRelativePath === null) return null;
    const byteLimit = Math.max(0, Math.floor(maxBytes));
    const tooLarge = (): GlossarySnapshotRead => ({
      canonicalPath,
      projectRelativePath,
      status: "too-large",
    });

    for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
      try {
        const before = await this.io.stat(canonicalPath);
        if (!before.isFile()) return null;
        if (before.size > byteLimit) return tooLarge();
        const bytes = await this.io.readFileBounded(canonicalPath, byteLimit);
        if (!bytes || bytes.byteLength > byteLimit) return tooLarge();
        const after = await this.io.stat(canonicalPath);
        if (after.size > byteLimit) return tooLarge();
        if (
          stableIdentity(before) !== stableIdentity(after) ||
          bytes.byteLength !== after.size
        ) {
          continue;
        }
        const identity: FileStatsIdentity = {
          ctimeMs: after.ctimeMs,
          dev: after.dev,
          ino: after.ino,
          mtimeMs: after.mtimeMs,
          size: after.size,
        };
        this.observeIdentity(projectRoot, projectRelativePath, identity);
        return {
          snapshot: {
            canonicalPath,
            content: bytes.toString("utf-8"),
            contentHash: createHash("sha256").update(bytes).digest("hex"),
            identity,
            projectRelativePath,
          },
          status: "ready",
        };
      } catch {
        return null;
      }
    }
    return null;
  }

  private observePaths(
    projectRoot: string,
    glossaryPaths: readonly string[],
  ): void {
    let observations = this.observedPaths.get(projectRoot);
    if (!observations) {
      observations = new Map();
      this.observedPaths.set(projectRoot, observations);
    }
    let learned = false;
    for (const glossaryPath of glossaryPaths) {
      if (observations.has(glossaryPath)) continue;
      observations.set(glossaryPath, null);
      learned = true;
    }
    if (!learned) return;
    for (const listener of this.observationListeners) {
      try {
        listener(projectRoot);
      } catch (error) {
        getLogger().warn(
          { error, projectRoot },
          "GLOSSARY_OBSERVE: observation listener failed",
        );
      }
    }
  }

  private observeIdentity(
    projectRoot: string,
    glossaryPath: string,
    identity: FileStatsIdentity,
  ): void {
    this.observePaths(projectRoot, [glossaryPath]);
    this.observedPaths.get(projectRoot)!.set(glossaryPath, identity);
  }
}
