import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
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
  type GlossaryArtifact,
  type GlossaryCompileDiagnostic,
  type GlossaryLimits,
  type GlossaryRowInput,
  type ParsedGlossaryTable,
} from "@yep-anywhere/shared";
import {
  getProjectPathIndex,
  type ProjectPathIndex,
} from "./projectPathIndex.js";

const MAX_DIAGNOSTICS = 16;
const MAX_PARSED_FILES = 512;
const MAX_COMPILED_GRAPHS = 128;
const STABLE_READ_ATTEMPTS = 3;

export type GlossaryResolutionDiagnosticCode =
  | "escaped-include"
  | "include-depth-limit"
  | "included-file-limit"
  | "invalid-governing-glossary"
  | "total-byte-limit"
  | "unresolved-include";

export interface GlossaryResolutionDiagnostic {
  code: GlossaryResolutionDiagnosticCode;
  glossaryPath: string;
  message: string;
}

export interface GlossaryDependencyIdentity {
  contentHash: string;
  path: string;
  size: number;
}

export type GlossaryResolutionResult =
  | {
      reason:
        | "governing-glossary-is-source"
        | "invalid-source-path"
        | "no-governing-glossary";
      status: "none";
    }
  | {
      artifact: GlossaryArtifact;
      dependencies: GlossaryDependencyIdentity[];
      diagnostics: GlossaryResolutionDiagnostic[];
      governingPath: string;
      status: "ready";
    }
  | {
      dependencies: GlossaryDependencyIdentity[];
      diagnostic: GlossaryCompileDiagnostic | GlossaryResolutionDiagnostic;
      diagnostics: GlossaryResolutionDiagnostic[];
      governingPath: string;
      status: "disabled";
    };

interface FileStatsIdentity {
  ctimeMs: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

interface GlossarySnapshot {
  canonicalPath: string;
  content: string;
  contentHash: string;
  identity: FileStatsIdentity;
  projectRelativePath: string;
}

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
  readFile(path: string): Promise<Buffer>;
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
      readFile: options.io?.readFile ?? ((path) => readFile(path)),
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
    const candidates = governingCandidates(sourcePath);
    const existing = await pathIndex.findExisting(candidates);
    const governingRelative = candidates.find((candidate) =>
      existing.has(candidate),
    );
    if (!governingRelative) {
      return { reason: "no-governing-glossary", status: "none" };
    }

    const governing = await this.readSnapshot(
      canonicalProject,
      resolve(canonicalProject, governingRelative),
    );
    if (!governing) {
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
        status: "disabled",
      };
    }

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
            status: "ready",
          }
        : {
            dependencies: closure.dependencies,
            diagnostic: compiled.diagnostic,
            diagnostics: closure.diagnostics,
            governingPath: governing.projectRelativePath,
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
      if (totalBytes > this.limits.maxGlossaryBytes) {
        fatal = makeDiagnostic(
          "total-byte-limit",
          snapshot.projectRelativePath,
          `Glossary graph exceeds ${this.limits.maxGlossaryBytes} bytes`,
        );
        addDiagnostic(fatal);
        return;
      }

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

      const included = await this.resolveIncludes(
        projectRoot,
        pathIndex,
        snapshot,
        parsed.includes,
        addDiagnostic,
      );
      for (const child of included) {
        await visit(child, depth + 1);
        if (fatal) return;
      }
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

  private async resolveIncludes(
    projectRoot: string,
    pathIndex: ProjectPathIndex,
    referring: GlossarySnapshot,
    mentions: readonly string[],
    addDiagnostic: (diagnostic: GlossaryResolutionDiagnostic) => void,
  ): Promise<GlossarySnapshot[]> {
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
    const included: GlossarySnapshot[] = [];
    const includedCanonical = new Set<string>();
    for (const entry of mentionCandidates) {
      let retained = 0;
      for (const relativePath of entry.relativePaths) {
        if (!existing.has(relativePath)) continue;
        const snapshot = await this.readSnapshot(
          projectRoot,
          resolve(projectRoot, relativePath),
        );
        if (!snapshot) continue;
        retained += 1;
        if (snapshot.canonicalPath === referring.canonicalPath) continue;
        if (includedCanonical.has(snapshot.canonicalPath)) continue;
        includedCanonical.add(snapshot.canonicalPath);
        included.push(snapshot);
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
    return included;
  }

  private async readSnapshot(
    projectRoot: string,
    candidatePath: string,
  ): Promise<GlossarySnapshot | null> {
    let canonicalPath: string;
    try {
      canonicalPath = await this.io.realpath(candidatePath);
    } catch {
      return null;
    }
    if (!isContained(projectRoot, canonicalPath)) return null;
    const projectRelativePath = toProjectRelative(projectRoot, canonicalPath);
    if (projectRelativePath === null) return null;

    for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
      try {
        const before = await this.io.stat(canonicalPath);
        if (!before.isFile()) return null;
        const bytes = await this.io.readFile(canonicalPath);
        const after = await this.io.stat(canonicalPath);
        if (
          stableIdentity(before) !== stableIdentity(after) ||
          bytes.byteLength !== after.size
        ) {
          continue;
        }
        return {
          canonicalPath,
          content: bytes.toString("utf-8"),
          contentHash: createHash("sha256").update(bytes).digest("hex"),
          identity: after,
          projectRelativePath,
        };
      } catch {
        return null;
      }
    }
    return null;
  }
}
