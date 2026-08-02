import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GitFileEditor, GitStatusInfo } from "@yep-anywhere/shared";
import { extractRawPatchFilePaths } from "../augments/edit-raw-patch.js";
import { runGit } from "../git/gitExec.js";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";
import { getLogger } from "../logging/logger.js";
import type { ContentBlock, SDKMessage } from "../sdk/types.js";

const CURRENT_VERSION = 1;
const MAX_PENDING_TOOLS_PER_PROCESS = 512;

interface DirtyFileEditorState {
  version: number;
  projects: Record<string, Record<string, GitFileEditor>>;
}

export interface DirtyFileSnapshot {
  fingerprints: Map<string, string>;
}

interface PendingFileMutation {
  directPaths?: string[];
  beforeShell?: Promise<DirtyFileSnapshot | null>;
}

export interface DirtyFileEditorProcessContext {
  id: string;
  projectPath: string;
  sessionId: string;
}

export interface DirtyFileEditorServiceOptions {
  dataDir?: string;
  captureDirtyFiles?: (projectPath: string) => Promise<DirtyFileSnapshot>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentBlocks(message: SDKMessage): ContentBlock[] {
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];
  return content;
}

function stringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function rawShellCommand(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!isRecord(input)) return undefined;
  return stringField(input, "command", "cmd");
}

/**
 * Shell edits are intentionally best-effort. Structured Edit/Write events are
 * authoritative; this predicate only pays for before/after Git snapshots when
 * a command has a recognizable write shape.
 */
export function isPotentiallyMutatingShell(input: unknown): boolean {
  const command = rawShellCommand(input);
  if (!command) return false;

  return (
    /(^|[;&|]\s*|\s)(?:apply_patch|patch|mv|cp|rm|touch|truncate|install|tee|rsync)(?:\s|$)/i.test(
      command,
    ) ||
    /\bgit\s+(?:apply|checkout|restore|mv|rm)\b/i.test(command) ||
    /\b(?:sed\b[^\n]*\s-i(?:\s|$)|perl\b[^\n]*\s-pi(?:\s|$))/i.test(
      command,
    ) ||
    /\b(?:prettier|biome|eslint)\b[^\n]*(?:--write|--fix)\b/i.test(
      command,
    ) ||
    /\b(?:cargo\s+fmt|gofmt\s+-w|rustfmt\b|clang-format\b[^\n]*\s-i)\b/i.test(
      command,
    ) ||
    /\b(?:npm|pnpm|yarn)\s+(?:add|remove|install|update|uninstall|format|fix|generate)\b/i.test(
      command,
    ) ||
    /(^|[^<])>>?\s*[^&|]/.test(command)
  );
}

function collectChangePaths(input: Record<string, unknown>): string[] {
  if (!Array.isArray(input.changes)) return [];
  const paths: string[] = [];
  for (const change of input.changes) {
    if (!isRecord(change)) continue;
    const candidate = stringField(change, "path", "file_path", "filePath");
    if (candidate) paths.push(candidate);
  }
  return paths;
}

export function extractFileMutationPaths(
  toolName: string,
  input: unknown,
): string[] {
  if (!["Edit", "Write", "NotebookEdit"].includes(toolName)) return [];
  if (!isRecord(input)) return [];

  const paths = new Set<string>();
  const directPath = stringField(
    input,
    "file_path",
    "filePath",
    "notebook_path",
    "path",
  );
  if (directPath) paths.add(directPath);
  for (const changedPath of collectChangePaths(input)) paths.add(changedPath);

  const rawPatch = stringField(
    input,
    "_rawPatch",
    "rawPatch",
    "raw_patch",
    "patch",
  );
  if (rawPatch) {
    for (const patchPath of extractRawPatchFilePaths(rawPatch)) {
      paths.add(patchPath);
    }
  }

  return [...paths];
}

function normalizeRelativePath(
  projectPath: string,
  candidate: string,
): string | null {
  const projectRoot = path.resolve(projectPath);
  const absoluteCandidate = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(projectRoot, candidate);
  const relative = path.relative(projectRoot, absoluteCandidate);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

function validEditor(value: unknown): value is GitFileEditor {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.observedAt === "string" &&
    Number.isFinite(Date.parse(value.observedAt))
  );
}

function normalizeState(value: unknown): DirtyFileEditorState {
  const state: DirtyFileEditorState = { version: CURRENT_VERSION, projects: {} };
  if (!isRecord(value) || !isRecord(value.projects)) return state;

  for (const [projectPath, rawFiles] of Object.entries(value.projects)) {
    if (!isRecord(rawFiles)) continue;
    const files: Record<string, GitFileEditor> = {};
    for (const [filePath, editor] of Object.entries(rawFiles)) {
      if (validEditor(editor)) files[filePath] = { ...editor };
    }
    if (Object.keys(files).length > 0) state.projects[projectPath] = files;
  }
  return state;
}

function parsePorcelainPaths(output: string): string[] {
  const fields = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (filePath) paths.push(filePath);
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return paths;
}

async function fileFingerprint(absolutePath: string): Promise<string> {
  try {
    const stat = await fs.lstat(absolutePath, { bigint: true });
    return `${stat.mode}:${stat.size}:${stat.mtimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function captureDirtyFiles(
  projectPath: string,
): Promise<DirtyFileSnapshot> {
  const result = await runGit(projectPath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=normal",
  ]);
  const fingerprints = new Map<string, string>();
  await Promise.all(
    parsePorcelainPaths(result.stdout).map(async (filePath) => {
      fingerprints.set(
        filePath,
        await fileFingerprint(path.resolve(projectPath, filePath)),
      );
    }),
  );
  return { fingerprints };
}

function changedDirtyPaths(
  before: DirtyFileSnapshot,
  after: DirtyFileSnapshot,
): string[] {
  const changed: string[] = [];
  for (const [filePath, fingerprint] of after.fingerprints) {
    if (before.fingerprints.get(filePath) !== fingerprint) {
      changed.push(filePath);
    }
  }
  return changed;
}

function observedAt(message: SDKMessage): string {
  if (
    typeof message.timestamp === "string" &&
    Number.isFinite(Date.parse(message.timestamp))
  ) {
    return new Date(message.timestamp).toISOString();
  }
  return new Date().toISOString();
}

export class DirtyFileEditorService {
  private readonly filePath: string;
  private readonly captureDirtyFiles: (
    projectPath: string,
  ) => Promise<DirtyFileSnapshot>;
  private state: DirtyFileEditorState = {
    version: CURRENT_VERSION,
    projects: {},
  };
  private pendingByProcess = new Map<
    string,
    Map<string, PendingFileMutation>
  >();
  private shellTasks = new Set<Promise<void>>();
  private saver = createCoalescingSaver(() => this.doSave());

  constructor(options: DirtyFileEditorServiceOptions = {}) {
    const dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(dataDir, "dirty-file-editors.json");
    this.captureDirtyFiles = options.captureDirtyFiles ?? captureDirtyFiles;
  }

  async initialize(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      this.state = normalizeState(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        getLogger().warn(
          { event: "dirty_file_editors_load_failed", error },
          "Failed to load dirty-file editor attribution; starting empty",
        );
      }
      this.state = { version: CURRENT_VERSION, projects: {} };
    }
  }

  observeMessage(
    process: DirtyFileEditorProcessContext,
    message: SDKMessage,
  ): void {
    for (const block of contentBlocks(message)) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        this.observeToolUse(process, block.id, block.name, block.input);
      } else if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        this.observeToolResult(
          process,
          block.tool_use_id,
          block.is_error === true,
          observedAt(message),
        );
      }
    }
  }

  forgetProcess(processId: string): void {
    this.pendingByProcess.delete(processId);
  }

  reconcileGitStatus(
    projectPath: string,
    status: GitStatusInfo,
  ): GitStatusInfo {
    const projectKey = path.resolve(projectPath);
    const records = this.state.projects[projectKey];
    if (!records) return status;

    const exactDirtyPaths = new Set(status.files.map((file) => file.path));
    const compactFolders = status.files
      .filter((file) => file.status === "?" && file.path.endsWith("/"))
      .map((file) => file.path);
    let changed = false;
    for (const filePath of Object.keys(records)) {
      const stillDirty =
        status.isGitRepo &&
        (exactDirtyPaths.has(filePath) ||
          compactFolders.some((folder) => filePath.startsWith(folder)));
      if (!stillDirty) {
        delete records[filePath];
        changed = true;
      }
    }

    if (Object.keys(records).length === 0) {
      delete this.state.projects[projectKey];
    }
    if (changed) this.queueSave();

    return {
      ...status,
      files: status.files.map((file) => {
        const editor = records[file.path];
        return editor ? { ...file, lastEditor: { ...editor } } : file;
      }),
    };
  }

  editorsForPaths(
    projectPath: string,
    paths: readonly string[],
  ): Record<string, GitFileEditor> {
    const records = this.state.projects[path.resolve(projectPath)];
    if (!records) return {};

    const editors: Record<string, GitFileEditor> = {};
    for (const filePath of paths) {
      const editor = records[filePath];
      if (editor) editors[filePath] = { ...editor };
    }
    return editors;
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.shellTasks]);
    await this.saver.idle();
  }

  private observeToolUse(
    process: DirtyFileEditorProcessContext,
    toolUseId: string,
    toolName: string,
    input: unknown,
  ): void {
    const directPaths = extractFileMutationPaths(toolName, input);
    const shellCandidate =
      toolName === "Bash" && isPotentiallyMutatingShell(input);
    if (directPaths.length === 0 && !shellCandidate) return;

    let pending = this.pendingByProcess.get(process.id);
    if (!pending) {
      pending = new Map();
      this.pendingByProcess.set(process.id, pending);
    }
    // Some providers repeat the tool_use at completion. The first observation
    // is the only useful pre-command snapshot, so never replace it.
    if (pending.has(toolUseId)) return;
    if (pending.size >= MAX_PENDING_TOOLS_PER_PROCESS) {
      const oldest = pending.keys().next().value;
      if (typeof oldest === "string") pending.delete(oldest);
    }

    pending.set(toolUseId, {
      ...(directPaths.length > 0 ? { directPaths } : {}),
      ...(shellCandidate
        ? {
            beforeShell: this.captureDirtyFiles(process.projectPath).catch(
              (error) => {
                this.logShellSnapshotFailure(process, error);
                return null;
              },
            ),
          }
        : {}),
    });
  }

  private observeToolResult(
    process: DirtyFileEditorProcessContext,
    toolUseId: string,
    isError: boolean,
    timestamp: string,
  ): void {
    const pending = this.pendingByProcess.get(process.id);
    const mutation = pending?.get(toolUseId);
    if (!mutation) return;
    pending?.delete(toolUseId);
    if (pending?.size === 0) this.pendingByProcess.delete(process.id);
    if (isError) return;

    if (mutation.directPaths) {
      this.recordTouches(
        process.projectPath,
        process.sessionId,
        mutation.directPaths,
        timestamp,
      );
    }
    if (mutation.beforeShell) {
      const task = this.completeShellMutation(
        process,
        mutation.beforeShell,
        timestamp,
      );
      this.shellTasks.add(task);
      void task.finally(() => this.shellTasks.delete(task));
    }
  }

  private async completeShellMutation(
    process: DirtyFileEditorProcessContext,
    beforePromise: Promise<DirtyFileSnapshot | null>,
    timestamp: string,
  ): Promise<void> {
    try {
      const before = await beforePromise;
      if (!before) return;
      const after = await this.captureDirtyFiles(process.projectPath);
      this.recordTouches(
        process.projectPath,
        process.sessionId,
        changedDirtyPaths(before, after),
        timestamp,
      );
    } catch (error) {
      this.logShellSnapshotFailure(process, error);
    }
  }

  private recordTouches(
    projectPath: string,
    sessionId: string,
    candidates: string[],
    timestamp: string,
  ): void {
    const projectKey = path.resolve(projectPath);
    const normalizedPaths = [
      ...new Set(
        candidates
          .map((candidate) => normalizeRelativePath(projectKey, candidate))
          .filter((candidate): candidate is string => candidate !== null),
      ),
    ];
    if (normalizedPaths.length === 0) return;

    const records = (this.state.projects[projectKey] ??= {});
    let changed = false;
    for (const filePath of normalizedPaths) {
      const current = records[filePath];
      if (
        current &&
        Date.parse(current.observedAt) > Date.parse(timestamp)
      ) {
        continue;
      }
      records[filePath] = { sessionId, observedAt: timestamp };
      changed = true;
    }
    if (changed) this.queueSave();
  }

  private queueSave(): void {
    void this.saver.save().catch((error) => {
      getLogger().error(
        { event: "dirty_file_editors_save_failed", error },
        "Failed to persist dirty-file editor attribution",
      );
    });
  }

  private async doSave(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(this.state, null, 2)}\n`,
      "utf8",
    );
    await fs.rename(temporaryPath, this.filePath);
  }

  private logShellSnapshotFailure(
    process: DirtyFileEditorProcessContext,
    error: unknown,
  ): void {
    getLogger().debug(
      {
        event: "dirty_file_shell_snapshot_failed",
        processId: process.id,
        projectPath: process.projectPath,
        sessionId: process.sessionId,
        error,
      },
      "Could not infer scripted file mutations",
    );
  }
}
