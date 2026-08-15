import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  type StoredWorkstream,
  type UrlProjectId,
  type Workstream,
  type WorkstreamId,
  type WorkstreamsChangedReason,
  isUrlProjectId,
  isWorkstreamId,
  mainWorkstreamId,
} from "@yep-anywhere/shared";
import type { EventBus } from "../watcher/EventBus.js";
import { buildGitProcessArgs } from "../git/gitExec.js";

const CURRENT_VERSION = 1;
const FILE_NAME = "workstreams.json";
const DEFAULT_BASE_BRANCH = "main";
const IMPLICIT_MAIN_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const CHECKOUTS_DIR_NAME = "checkouts";
const DEFAULT_PROJECT_SLUG = "project";
const DEFAULT_LANE_SLUG = "lane";
const MAX_PROJECT_SLUG_LENGTH = 42;
const MAX_LANE_SLUG_LENGTH = 48;
const PROJECT_ID_HASH_LENGTH = 10;
const MAX_DESTINATION_ATTEMPTS = 100;
const GIT_DEFAULT_TIMEOUT_MS = 30_000;
const GIT_CLONE_TIMEOUT_MS = 5 * 60_000;

const execFileAsync = promisify(execFile);

interface WorkstreamsState {
  version: number;
  workstreams: StoredWorkstream[];
}

export interface WorkstreamServiceOptions {
  dataDir: string;
  eventBus?: EventBus;
  now?: () => Date;
}

export interface ListProjectWorkstreamsOptions {
  projectId: UrlProjectId;
  projectPath: string;
  mainBranch?: string | null;
  baseBranch?: string;
}

export interface CreateWorkstreamInput {
  projectId: UrlProjectId;
  label: string;
  path: string;
  branch?: string | null;
  baseBranch?: string;
  baseCommit?: string | null;
  managedByYa?: boolean;
}

export interface CheckoutWorkstreamInput {
  projectId: UrlProjectId;
  projectPath: string;
  projectName?: string;
  label: string;
}

export interface WorkstreamCheckoutDestination {
  label: string;
  slug: string;
  checkoutRootPath: string;
  checkoutPath: string;
}

export interface CreateCheckoutWorkstreamResult {
  workstream: StoredWorkstream;
  destination: WorkstreamCheckoutDestination;
}

export interface WorkstreamPathResolution {
  projectId: UrlProjectId;
  workstreamId: WorkstreamId;
  workstream: StoredWorkstream;
}

export class WorkstreamValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkstreamValidationError";
  }
}

export class WorkstreamOperationInProgressError extends Error {
  readonly code = "operation_in_progress";

  constructor(projectId: UrlProjectId) {
    super(`A workstream operation is already running for project ${projectId}`);
    this.name = "WorkstreamOperationInProgressError";
  }
}

export class WorkstreamCheckoutError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string | undefined;

  constructor(
    code: string,
    message: string,
    options: { status?: number; detail?: string } = {},
  ) {
    super(message);
    this.name = "WorkstreamCheckoutError";
    this.code = code;
    this.status = options.status ?? 500;
    this.detail = options.detail;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkstreamValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalStringOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new WorkstreamValidationError(`${field} must be a string or null`);
  }
  return value.trim() || null;
}

function normalizeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new WorkstreamValidationError(`${field} must be a boolean`);
  }
  return value;
}

function normalizeProjectId(value: unknown): UrlProjectId {
  const projectId = requiredString(value, "projectId");
  if (!isUrlProjectId(projectId)) {
    throw new WorkstreamValidationError("projectId is invalid");
  }
  return projectId;
}

function normalizeWorkstreamId(value: unknown): WorkstreamId {
  const id = requiredString(value, "id");
  if (!isWorkstreamId(id)) {
    throw new WorkstreamValidationError("id is invalid");
  }
  return id;
}

function normalizeStatus(value: unknown): StoredWorkstream["status"] {
  if (value === "active" || value === "archived" || value === "landed") {
    return value;
  }
  throw new WorkstreamValidationError("status is invalid");
}

function normalizeStoredWorkstream(raw: unknown): StoredWorkstream {
  if (!isRecord(raw)) {
    throw new WorkstreamValidationError("workstream must be an object");
  }
  if (raw.kind !== "checkout") {
    throw new WorkstreamValidationError("kind must be checkout");
  }
  const projectId = normalizeProjectId(raw.projectId);
  const id = normalizeWorkstreamId(raw.id);
  if (id === mainWorkstreamId(projectId)) {
    throw new WorkstreamValidationError("main workstream is implicit");
  }
  return {
    id,
    projectId,
    label: requiredString(raw.label, "label"),
    kind: "checkout",
    path: requiredString(raw.path, "path"),
    branch: optionalStringOrNull(raw.branch, "branch"),
    baseBranch: requiredString(raw.baseBranch, "baseBranch"),
    baseCommit: optionalStringOrNull(raw.baseCommit, "baseCommit"),
    managedByYa: normalizeBoolean(raw.managedByYa, "managedByYa"),
    queuePaused: normalizeBoolean(raw.queuePaused, "queuePaused"),
    status: normalizeStatus(raw.status),
    createdAt: requiredString(raw.createdAt, "createdAt"),
    updatedAt: requiredString(raw.updatedAt, "updatedAt"),
  };
}

function normalizeStoredWorkstreams(rawWorkstreams: unknown[]): {
  workstreams: StoredWorkstream[];
  droppedCount: number;
} {
  const workstreams: StoredWorkstream[] = [];
  const seenIds = new Set<WorkstreamId>();
  let droppedCount = 0;
  for (const raw of rawWorkstreams) {
    try {
      const workstream = normalizeStoredWorkstream(raw);
      if (seenIds.has(workstream.id)) {
        droppedCount += 1;
        continue;
      }
      seenIds.add(workstream.id);
      workstreams.push(workstream);
    } catch {
      droppedCount += 1;
    }
  }
  return { workstreams, droppedCount };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function workstreamsEqual(a: StoredWorkstream[], b: unknown[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function slugifyPathSegment(
  value: string | undefined,
  fallback: string,
  maxLength: number,
): string {
  const slug = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || fallback;
}

function getProjectCheckoutSegment(
  projectId: UrlProjectId,
  projectName: string | undefined,
  projectPath: string,
): string {
  const projectSlug = slugifyPathSegment(
    projectName ?? path.basename(projectPath),
    DEFAULT_PROJECT_SLUG,
    MAX_PROJECT_SLUG_LENGTH,
  );
  const projectHash = createHash("sha256")
    .update(projectId)
    .digest("hex")
    .slice(0, PROJECT_ID_HASH_LENGTH);
  return `${projectSlug}-${projectHash}`;
}

function getGitErrorDetail(error: unknown): string {
  const gitError = error as {
    stderr?: string;
    stdout?: string;
    message?: string;
  };
  return (
    gitError.stderr?.trim() ||
    gitError.stdout?.trim() ||
    gitError.message?.trim() ||
    "Unknown git error"
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function runGit(
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", buildGitProcessArgs(args), {
    timeout: options.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      GCM_INTERACTIVE: "Never",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return String(stdout).trim();
}

async function getGitTopLevel(projectPath: string): Promise<string> {
  try {
    const topLevel = path.resolve(
      await runGit(["-C", projectPath, "rev-parse", "--show-toplevel"]),
    );
    return await fs.realpath(topLevel);
  } catch (error) {
    throw new WorkstreamCheckoutError(
      "not_git_repository",
      "Project is not a Git repository",
      { status: 400, detail: getGitErrorDetail(error) },
    );
  }
}

async function gitRefExists(
  projectPath: string,
  refName: string,
): Promise<boolean> {
  try {
    await runGit([
      "-C",
      projectPath,
      "show-ref",
      "--verify",
      "--quiet",
      refName,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function getCurrentBranch(projectPath: string): Promise<string | null> {
  try {
    const branch = await runGit([
      "-C",
      projectPath,
      "branch",
      "--show-current",
    ]);
    return branch || null;
  } catch {
    return null;
  }
}

async function getHeadCommit(projectPath: string): Promise<string | null> {
  try {
    return await runGit(["-C", projectPath, "rev-parse", "--verify", "HEAD"]);
  } catch {
    return null;
  }
}

async function getRemoteOriginUrl(projectPath: string): Promise<string | null> {
  try {
    return await runGit(["-C", projectPath, "remote", "get-url", "origin"]);
  } catch {
    return null;
  }
}

function synthesizeMainWorkstream(
  options: ListProjectWorkstreamsOptions,
): Workstream {
  const branch =
    options.mainBranch?.trim() ||
    options.baseBranch?.trim() ||
    DEFAULT_BASE_BRANCH;
  return {
    id: mainWorkstreamId(options.projectId),
    projectId: options.projectId,
    label: "main",
    kind: "main",
    path: options.projectPath,
    branch,
    baseBranch: options.baseBranch?.trim() || branch,
    baseCommit: null,
    managedByYa: false,
    queuePaused: false,
    status: "active",
    createdAt: IMPLICIT_MAIN_TIMESTAMP,
    updatedAt: IMPLICIT_MAIN_TIMESTAMP,
  };
}

export class WorkstreamService {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly eventBus: EventBus | undefined;
  private readonly now: () => Date;
  private state: WorkstreamsState = {
    version: CURRENT_VERSION,
    workstreams: [],
  };
  private initialized = false;
  private mutationQueue: Promise<void> = Promise.resolve();
  private projectOperations = new Set<UrlProjectId>();

  constructor(options: WorkstreamServiceOptions) {
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, FILE_NAME);
    this.eventBus = options.eventBus;
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as Partial<WorkstreamsState>;
      const rawWorkstreams = Array.isArray(parsed.workstreams)
        ? parsed.workstreams
        : [];
      const { workstreams, droppedCount } =
        normalizeStoredWorkstreams(rawWorkstreams);
      this.state = { version: CURRENT_VERSION, workstreams };
      const needsSave =
        parsed.version !== CURRENT_VERSION ||
        !Array.isArray(parsed.workstreams) ||
        droppedCount > 0 ||
        !workstreamsEqual(workstreams, rawWorkstreams);
      if (needsSave) {
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[WorkstreamService] Failed to load workstreams, starting fresh:",
          error,
        );
      }
      this.state = { version: CURRENT_VERSION, workstreams: [] };
    }
    this.initialized = true;
  }

  listProject(options: ListProjectWorkstreamsOptions): Workstream[] {
    this.ensureInitialized();
    return [
      synthesizeMainWorkstream(options),
      ...this.state.workstreams
        .filter((workstream) => workstream.projectId === options.projectId)
        .map((workstream) => cloneJson(workstream)),
    ];
  }

  listStoredProject(projectId: UrlProjectId): StoredWorkstream[] {
    this.ensureInitialized();
    return this.state.workstreams
      .filter((workstream) => workstream.projectId === projectId)
      .map((workstream) => cloneJson(workstream));
  }

  listStored(): StoredWorkstream[] {
    this.ensureInitialized();
    return this.state.workstreams.map((workstream) => cloneJson(workstream));
  }

  getWorkstream(
    projectId: UrlProjectId,
    workstreamId: WorkstreamId,
    projectPath?: string,
  ): Workstream | null {
    this.ensureInitialized();
    if (workstreamId === mainWorkstreamId(projectId)) {
      if (!projectPath) return null;
      return synthesizeMainWorkstream({ projectId, projectPath });
    }
    const found = this.state.workstreams.find(
      (workstream) =>
        workstream.projectId === projectId && workstream.id === workstreamId,
    );
    return found ? cloneJson(found) : null;
  }

  resolvePath(candidatePath: string): WorkstreamPathResolution | null {
    this.ensureInitialized();
    const resolvedCandidate = path.resolve(candidatePath);
    let best: StoredWorkstream | null = null;
    let bestLength = -1;

    for (const workstream of this.state.workstreams) {
      const workstreamPath = path.resolve(workstream.path);
      if (!isPathInside(workstreamPath, resolvedCandidate)) {
        continue;
      }
      if (workstreamPath.length <= bestLength) {
        continue;
      }
      best = workstream;
      bestLength = workstreamPath.length;
    }

    if (!best) return null;
    return {
      projectId: best.projectId,
      workstreamId: best.id,
      workstream: cloneJson(best),
    };
  }

  async createWorkstream(
    input: CreateWorkstreamInput,
  ): Promise<StoredWorkstream> {
    const now = this.now().toISOString();
    const branch = input.branch?.trim() || null;
    const workstream: StoredWorkstream = {
      id: randomUUID() as WorkstreamId,
      projectId: input.projectId,
      label: input.label,
      kind: "checkout",
      path: input.path,
      branch,
      baseBranch: input.baseBranch?.trim() || DEFAULT_BASE_BRANCH,
      baseCommit: input.baseCommit?.trim() || null,
      managedByYa: input.managedByYa ?? false,
      queuePaused: false,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    return this.upsertWorkstream(workstream);
  }

  async previewCheckoutWorkstream(
    input: CheckoutWorkstreamInput,
  ): Promise<WorkstreamCheckoutDestination> {
    this.ensureInitialized();
    return this.resolveCheckoutDestination(input);
  }

  async createCheckoutWorkstream(
    input: CheckoutWorkstreamInput,
  ): Promise<CreateCheckoutWorkstreamResult> {
    return this.withProjectOperation(input.projectId, async () => {
      const destination = await this.resolveCheckoutDestination(input);
      const sourceRoot = await getGitTopLevel(input.projectPath);
      const cloneBranch = (await gitRefExists(sourceRoot, "refs/heads/main"))
        ? DEFAULT_BASE_BRANCH
        : null;
      const originUrl = await getRemoteOriginUrl(sourceRoot);
      const cloneArgs = ["clone", "--local"];
      if (cloneBranch) {
        cloneArgs.push("--branch", cloneBranch);
      }
      cloneArgs.push(sourceRoot, destination.checkoutRootPath);

      try {
        await fs.mkdir(path.dirname(destination.checkoutRootPath), {
          recursive: true,
        });
        await runGit(cloneArgs, { timeoutMs: GIT_CLONE_TIMEOUT_MS });
      } catch (error) {
        await fs.rm(destination.checkoutRootPath, {
          recursive: true,
          force: true,
        });
        throw new WorkstreamCheckoutError(
          "clone_failed",
          "Failed to create checkout",
          { detail: getGitErrorDetail(error) },
        );
      }

      try {
        if (originUrl) {
          await runGit([
            "-C",
            destination.checkoutRootPath,
            "remote",
            "set-url",
            "origin",
            originUrl,
          ]);
        }
        await this.copyWorktreeInclude(
          sourceRoot,
          destination.checkoutRootPath,
        );

        const branch =
          (await getCurrentBranch(destination.checkoutPath)) ??
          cloneBranch ??
          (await getCurrentBranch(sourceRoot)) ??
          DEFAULT_BASE_BRANCH;
        const baseCommit = await getHeadCommit(destination.checkoutPath);
        const workstream = await this.createWorkstream({
          projectId: input.projectId,
          label: destination.label,
          path: destination.checkoutPath,
          branch,
          baseBranch: branch,
          baseCommit,
          managedByYa: true,
        });
        return { workstream, destination };
      } catch (error) {
        await fs.rm(destination.checkoutRootPath, {
          recursive: true,
          force: true,
        });
        if (error instanceof WorkstreamCheckoutError) {
          throw error;
        }
        throw new WorkstreamCheckoutError(
          "checkout_seed_failed",
          "Failed to finish checkout setup",
          { detail: getGitErrorDetail(error) },
        );
      }
    });
  }

  async upsertWorkstream(
    workstream: StoredWorkstream,
  ): Promise<StoredWorkstream> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      const normalized = normalizeStoredWorkstream(workstream);
      const index = this.state.workstreams.findIndex(
        (candidate) => candidate.id === normalized.id,
      );
      const reason: WorkstreamsChangedReason =
        index === -1 ? "created" : "updated";
      if (index === -1) {
        this.state.workstreams.push(normalized);
      } else {
        const existing = this.state.workstreams[index]!;
        if (existing.projectId !== normalized.projectId) {
          throw new WorkstreamValidationError(
            "workstream projectId cannot change",
          );
        }
        this.state.workstreams[index] = normalized;
      }
      await this.save();
      this.emitChange(normalized.projectId, reason, normalized.id);
      return cloneJson(normalized);
    });
  }

  async replaceAll(
    workstreams: StoredWorkstream[],
  ): Promise<StoredWorkstream[]> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      const { workstreams: normalized, droppedCount } =
        normalizeStoredWorkstreams(workstreams);
      if (droppedCount > 0) {
        throw new WorkstreamValidationError("workstreams contain duplicates");
      }
      const previousProjectIds = this.state.workstreams.map(
        (workstream) => workstream.projectId,
      );
      this.state.workstreams = normalized;
      await this.save();
      this.emitAllProjectChanges("replaced", previousProjectIds);
      return this.listStored();
    });
  }

  async deleteWorkstream(id: WorkstreamId): Promise<boolean> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      const index = this.state.workstreams.findIndex(
        (workstream) => workstream.id === id,
      );
      if (index === -1) return false;
      const [deleted] = this.state.workstreams.splice(index, 1);
      await this.save();
      this.emitChange(deleted!.projectId, "deleted", id);
      return true;
    });
  }

  getFilePath(): string {
    return this.filePath;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "WorkstreamService not initialized. Call initialize() first.",
      );
    }
  }

  private async withMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(fn, fn);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withProjectOperation<T>(
    projectId: UrlProjectId,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.ensureInitialized();
    if (this.projectOperations.has(projectId)) {
      throw new WorkstreamOperationInProgressError(projectId);
    }

    this.projectOperations.add(projectId);
    try {
      return await fn();
    } catch (error) {
      this.emitChange(projectId, "operation-failed");
      throw error;
    } finally {
      this.projectOperations.delete(projectId);
    }
  }

  private async resolveCheckoutDestination(
    input: CheckoutWorkstreamInput,
  ): Promise<WorkstreamCheckoutDestination> {
    this.ensureInitialized();
    const label = requiredString(input.label, "label");
    const projectPath = await fs.realpath(path.resolve(input.projectPath));
    const sourceRoot = await getGitTopLevel(projectPath);
    if (!isPathInside(sourceRoot, projectPath)) {
      throw new WorkstreamCheckoutError(
        "project_outside_repository",
        "Project path is outside the Git repository",
        { status: 400 },
      );
    }

    const projectRelativePath = path.relative(sourceRoot, projectPath);
    const checkoutBasePath = path.join(
      this.dataDir,
      CHECKOUTS_DIR_NAME,
      getProjectCheckoutSegment(
        input.projectId,
        input.projectName,
        projectPath,
      ),
    );
    const baseSlug = slugifyPathSegment(
      label,
      DEFAULT_LANE_SLUG,
      MAX_LANE_SLUG_LENGTH,
    );
    const storedPaths = new Set(
      this.state.workstreams
        .filter((workstream) => workstream.projectId === input.projectId)
        .map((workstream) => path.resolve(workstream.path)),
    );

    for (let attempt = 0; attempt < MAX_DESTINATION_ATTEMPTS; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      const checkoutRootPath = path.join(checkoutBasePath, slug);
      const checkoutPath = projectRelativePath
        ? path.join(checkoutRootPath, projectRelativePath)
        : checkoutRootPath;
      if (storedPaths.has(path.resolve(checkoutPath))) {
        continue;
      }
      if (!(await pathExists(checkoutRootPath))) {
        return {
          label,
          slug,
          checkoutRootPath,
          checkoutPath,
        };
      }
    }

    throw new WorkstreamCheckoutError(
      "checkout_destination_unavailable",
      "No available checkout destination found for this label",
      { status: 409 },
    );
  }

  private async copyWorktreeInclude(
    sourceRoot: string,
    checkoutRootPath: string,
  ): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(
        path.join(sourceRoot, ".worktreeinclude"),
        "utf-8",
      );
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }

    for (const rawLine of content.split(/\r?\n/)) {
      const entry = rawLine.trim();
      if (!entry || entry.startsWith("#")) continue;

      const sourcePath = path.resolve(sourceRoot, entry);
      const targetPath = path.resolve(checkoutRootPath, entry);
      if (
        !isPathInside(sourceRoot, sourcePath) ||
        !isPathInside(checkoutRootPath, targetPath)
      ) {
        throw new WorkstreamCheckoutError(
          "worktreeinclude_invalid_path",
          ".worktreeinclude contains a path outside the checkout",
          { status: 400, detail: entry },
        );
      }

      try {
        await fs.lstat(sourcePath);
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.cp(sourcePath, targetPath, {
        recursive: true,
        force: true,
        preserveTimestamps: true,
      });
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    if (this.state.workstreams.length === 0) {
      await fs.rm(this.filePath, { force: true });
      return;
    }
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(this.state, null, 2));
    await fs.rename(tmpPath, this.filePath);
  }

  private emitChange(
    projectId: UrlProjectId,
    reason: WorkstreamsChangedReason,
    workstreamId?: WorkstreamId,
  ): void {
    this.eventBus?.emit({
      type: "workstreams-changed",
      projectId,
      reason,
      ...(workstreamId ? { workstreamId } : {}),
      timestamp: this.now().toISOString(),
    });
  }

  // Include pre-mutation project ids so a project whose last workstream was
  // removed still hears about the change.
  private emitAllProjectChanges(
    reason: WorkstreamsChangedReason,
    previousProjectIds: UrlProjectId[] = [],
  ): void {
    for (const projectId of new Set([
      ...this.state.workstreams.map((workstream) => workstream.projectId),
      ...previousProjectIds,
    ])) {
      this.emitChange(projectId, reason);
    }
  }
}
