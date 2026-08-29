import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ALL_PERMISSION_MODES,
  ALL_PROVIDERS,
  type CreateProjectQueueItemRequest,
  type PermissionMode,
  type ProjectQueueChangedEvent,
  type ProjectQueueCreatedFrom,
  type ProjectQueueDispatchPauseReason,
  type ProjectQueueDispatchState,
  type ProjectQueueItem,
  type ProjectQueueItemSummary,
  type ProjectQueueMessage,
  type ProjectQueueResponse,
  type ProjectQueueStagedAttachments,
  type ProjectQueueTarget,
  type ProviderName,
  type ShowThinking,
  type StagedAttachmentRef,
  type ThinkingOption,
  type UpdateProjectQueueItemRequest,
  type UploadedFile,
  type UrlProjectId,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import type { AttachmentStagingService } from "../uploads/AttachmentStagingService.js";
import type { EventBus } from "../watcher/EventBus.js";

const CURRENT_VERSION = 3;
const MAX_MESSAGE_PREVIEW_LENGTH = 180;
const MAX_AUTOMATIC_STARTUP_FAILURES = 3;
const RUNNING_DISPATCH_STATE: ProjectQueueDispatchState = { status: "running" };

interface StoredProjectQueueItem extends ProjectQueueItem {
  /** Internal consecutive provider-startup failures for this exact item. */
  startupFailureCount?: number;
}

interface ProjectQueueState {
  version: number;
  items: StoredProjectQueueItem[];
  dispatchState: ProjectQueueDispatchState;
}

export interface ProjectQueueServiceOptions {
  dataDir: string;
  eventBus?: EventBus;
  attachmentStagingService?: AttachmentStagingService;
}

export class ProjectQueueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectQueueValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ProjectQueueValidationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dispatchStatesEqual(
  a: ProjectQueueDispatchState | undefined,
  b: ProjectQueueDispatchState | undefined,
): boolean {
  return JSON.stringify(a ?? RUNNING_DISPATCH_STATE) === JSON.stringify(b);
}

function normalizeDispatchState(
  raw: unknown,
  hasItems: boolean,
): ProjectQueueDispatchState {
  if (!hasItems) return RUNNING_DISPATCH_STATE;
  if (isRecord(raw) && raw.status === "paused") {
    const reason =
      raw.reason === "manual" || raw.reason === "restart"
        ? raw.reason
        : undefined;
    const pausedAt =
      typeof raw.pausedAt === "string" && raw.pausedAt.trim()
        ? raw.pausedAt
        : undefined;
    if (reason && pausedAt) {
      return { status: "paused", reason, pausedAt };
    }
  }
  return {
    status: "paused",
    reason: "restart",
    pausedAt: new Date().toISOString(),
  };
}

function optionalProvider(value: unknown): ProviderName | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !ALL_PROVIDERS.includes(value as ProviderName)
  ) {
    throw new ProjectQueueValidationError("target.provider is invalid");
  }
  return value as ProviderName;
}

function optionalPermissionMode(value: unknown): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !ALL_PERMISSION_MODES.includes(value as PermissionMode)
  ) {
    throw new ProjectQueueValidationError("mode is invalid");
  }
  return value as PermissionMode;
}

function optionalThinking(value: unknown): ThinkingOption | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new ProjectQueueValidationError("target.thinking is invalid");
  }
  return value.trim() as ThinkingOption;
}

function optionalShowThinking(value: unknown): ShowThinking | undefined {
  if (value === undefined) return undefined;
  if (value !== "default" && value !== "on" && value !== "off") {
    throw new ProjectQueueValidationError("target.showThinking is invalid");
  }
  return value;
}

function optionalSandboxLevel(
  value: unknown,
): "none" | "project-write" | undefined {
  if (value === undefined) return undefined;
  if (value !== "none" && value !== "project-write") {
    throw new ProjectQueueValidationError("target.sandboxLevel is invalid");
  }
  return value;
}

function optionalSandboxNetworkFirewall(
  value: unknown,
  sandboxLevel: "none" | "project-write" | undefined,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ProjectQueueValidationError(
      "target.sandboxNetworkFirewall is invalid",
    );
  }
  if (value && sandboxLevel !== "project-write") {
    throw new ProjectQueueValidationError(
      "target.sandboxNetworkFirewall requires project-write sandboxing",
    );
  }
  return sandboxLevel === "project-write" ? value : undefined;
}

function normalizeUploadedFile(value: unknown, index: number): UploadedFile {
  if (!isRecord(value)) {
    throw new ProjectQueueValidationError(
      `message.attachments[${index}] must be an object`,
    );
  }

  const id = optionalString(value.id, `message.attachments[${index}].id`);
  const originalName = optionalString(
    value.originalName,
    `message.attachments[${index}].originalName`,
  );
  const name = optionalString(value.name, `message.attachments[${index}].name`);
  const filePath = optionalString(
    value.path,
    `message.attachments[${index}].path`,
  );
  const mimeType = optionalString(
    value.mimeType,
    `message.attachments[${index}].mimeType`,
  );
  if (!id || !originalName || !name || !filePath || !mimeType) {
    throw new ProjectQueueValidationError(
      `message.attachments[${index}] is missing required fields`,
    );
  }
  if (typeof value.size !== "number" || !Number.isFinite(value.size)) {
    throw new ProjectQueueValidationError(
      `message.attachments[${index}].size must be a number`,
    );
  }

  const width =
    typeof value.width === "number" && Number.isFinite(value.width)
      ? value.width
      : undefined;
  const height =
    typeof value.height === "number" && Number.isFinite(value.height)
      ? value.height
      : undefined;

  return {
    id,
    originalName,
    name,
    path: filePath,
    size: value.size,
    mimeType,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

function normalizeStagedAttachmentRef(
  value: unknown,
  index: number,
  batchId: string,
): StagedAttachmentRef {
  if (!isRecord(value)) {
    throw new ProjectQueueValidationError(
      `message.stagedAttachments.refs[${index}] must be an object`,
    );
  }

  const id = optionalString(
    value.id,
    `message.stagedAttachments.refs[${index}].id`,
  );
  const refBatchId = optionalString(
    value.batchId,
    `message.stagedAttachments.refs[${index}].batchId`,
  );
  const originalName = optionalString(
    value.originalName,
    `message.stagedAttachments.refs[${index}].originalName`,
  );
  const name = optionalString(
    value.name,
    `message.stagedAttachments.refs[${index}].name`,
  );
  const mimeType = optionalString(
    value.mimeType,
    `message.stagedAttachments.refs[${index}].mimeType`,
  );
  const createdAt = optionalString(
    value.createdAt,
    `message.stagedAttachments.refs[${index}].createdAt`,
  );
  const updatedAt = optionalString(
    value.updatedAt,
    `message.stagedAttachments.refs[${index}].updatedAt`,
  );
  if (
    !id ||
    !refBatchId ||
    refBatchId !== batchId ||
    !originalName ||
    !name ||
    !mimeType ||
    !createdAt ||
    !updatedAt
  ) {
    throw new ProjectQueueValidationError(
      `message.stagedAttachments.refs[${index}] is missing required fields`,
    );
  }
  if (typeof value.size !== "number" || !Number.isFinite(value.size)) {
    throw new ProjectQueueValidationError(
      `message.stagedAttachments.refs[${index}].size must be a number`,
    );
  }

  const width =
    typeof value.width === "number" && Number.isFinite(value.width)
      ? value.width
      : undefined;
  const height =
    typeof value.height === "number" && Number.isFinite(value.height)
      ? value.height
      : undefined;

  return {
    id,
    batchId: refBatchId,
    originalName,
    name,
    size: value.size,
    mimeType,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    createdAt,
    updatedAt,
  };
}

function normalizeStagedAttachments(
  value: unknown,
): ProjectQueueStagedAttachments {
  if (!isRecord(value)) {
    throw new ProjectQueueValidationError(
      "message.stagedAttachments must be an object",
    );
  }
  const batchId = optionalString(
    value.batchId,
    "message.stagedAttachments.batchId",
  );
  const updatedAt = optionalString(
    value.updatedAt,
    "message.stagedAttachments.updatedAt",
  );
  if (!batchId || !updatedAt) {
    throw new ProjectQueueValidationError(
      "message.stagedAttachments is missing required fields",
    );
  }
  if (!Array.isArray(value.refs)) {
    throw new ProjectQueueValidationError(
      "message.stagedAttachments.refs must be an array",
    );
  }
  const refs = value.refs.map((ref, index) =>
    normalizeStagedAttachmentRef(ref, index, batchId),
  );
  if (refs.length === 0) {
    throw new ProjectQueueValidationError(
      "message.stagedAttachments.refs must not be empty",
    );
  }
  return { batchId, refs, updatedAt };
}

function normalizeMessage(raw: unknown): ProjectQueueMessage {
  if (!isRecord(raw)) {
    throw new ProjectQueueValidationError("message must be an object");
  }
  if (typeof raw.text !== "string") {
    throw new ProjectQueueValidationError("message.text is required");
  }
  const text = raw.text;
  const mode = optionalPermissionMode(raw.mode);
  const attachments =
    raw.attachments === undefined
      ? undefined
      : Array.isArray(raw.attachments)
        ? raw.attachments.map(normalizeUploadedFile)
        : (() => {
            throw new ProjectQueueValidationError(
              "message.attachments must be an array",
            );
          })();
  const stagedAttachments =
    raw.stagedAttachments === undefined
      ? undefined
      : normalizeStagedAttachments(raw.stagedAttachments);
  if (!text.trim() && !attachments?.length && !stagedAttachments?.refs.length) {
    throw new ProjectQueueValidationError(
      "message.text, message.attachments, or message.stagedAttachments is required",
    );
  }

  return {
    text,
    ...(attachments?.length ? { attachments } : {}),
    ...(stagedAttachments ? { stagedAttachments } : {}),
    ...(mode ? { mode } : {}),
    ...(isRecord(raw.metadata) ? { metadata: raw.metadata } : {}),
  };
}

function normalizeTarget(raw: unknown): ProjectQueueTarget {
  if (!isRecord(raw)) {
    throw new ProjectQueueValidationError("target must be an object");
  }

  const common = {
    provider: optionalProvider(raw.provider),
    mode: optionalPermissionMode(raw.mode),
    model: optionalString(raw.model, "target.model"),
    serviceTier: optionalString(raw.serviceTier, "target.serviceTier"),
    executor: optionalString(raw.executor, "target.executor"),
    thinking: optionalThinking(raw.thinking),
    showThinking: optionalShowThinking(raw.showThinking),
  };

  if (raw.type === "existing-session") {
    const sessionId = optionalString(raw.sessionId, "target.sessionId");
    if (!sessionId) {
      throw new ProjectQueueValidationError("target.sessionId is required");
    }
    return {
      type: "existing-session",
      sessionId,
      ...common,
    };
  }

  if (raw.type === "new-session") {
    const sandboxLevel = optionalSandboxLevel(raw.sandboxLevel);
    return {
      type: "new-session",
      title: optionalString(raw.title, "target.title"),
      sandboxLevel,
      sandboxNetworkFirewall: optionalSandboxNetworkFirewall(
        raw.sandboxNetworkFirewall,
        sandboxLevel,
      ),
      ...common,
    };
  }

  throw new ProjectQueueValidationError("target.type is invalid");
}

function normalizeCreatedFrom(
  raw: unknown,
): ProjectQueueCreatedFrom | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new ProjectQueueValidationError("createdFrom must be an object");
  }
  const sessionId = optionalString(raw.sessionId, "createdFrom.sessionId");
  const client = optionalString(raw.client, "createdFrom.client");
  if (
    client !== undefined &&
    client !== "toolbar" &&
    client !== "projects-page" &&
    client !== "new-session"
  ) {
    throw new ProjectQueueValidationError("createdFrom.client is invalid");
  }
  if (!sessionId && !client) return undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(client ? { client } : {}),
  };
}

function normalizeProjectQueueItem(
  raw: unknown,
): StoredProjectQueueItem | null {
  if (!isRecord(raw)) return null;
  try {
    const id = optionalString(raw.id, "id") ?? randomUUID();
    const projectId = optionalString(raw.projectId, "projectId");
    const projectPath = optionalString(raw.projectPath, "projectPath");
    if (!projectId || !isUrlProjectId(projectId) || !projectPath) {
      return null;
    }

    const createdAt =
      optionalString(raw.createdAt, "createdAt") ?? new Date().toISOString();
    const updatedAt = optionalString(raw.updatedAt, "updatedAt") ?? createdAt;
    const rawStatus = optionalString(raw.status, "status");
    const status =
      rawStatus === "failed"
        ? "failed"
        : // A restart means no dispatch is in progress anymore.
          "queued";

    return {
      id,
      projectId,
      projectPath,
      target: normalizeTarget(raw.target),
      message: normalizeMessage(raw.message),
      createdAt,
      updatedAt,
      createdFrom: normalizeCreatedFrom(raw.createdFrom),
      status,
      lastError: optionalString(raw.lastError, "lastError"),
      lastAttemptAt: optionalString(raw.lastAttemptAt, "lastAttemptAt"),
      startupFailureCount: optionalNonNegativeInteger(raw.startupFailureCount),
    };
  } catch {
    return null;
  }
}

function summarizeItem(item: ProjectQueueItem): ProjectQueueItemSummary {
  const attachmentCount =
    (item.message.attachments?.length ?? 0) +
    (item.message.stagedAttachments?.refs.length ?? 0);
  const previewText = item.message.text.trim();
  return {
    id: item.id,
    projectId: item.projectId,
    target: item.target,
    messagePreview:
      previewText.length > MAX_MESSAGE_PREVIEW_LENGTH
        ? `${previewText.slice(0, MAX_MESSAGE_PREVIEW_LENGTH - 3)}...`
        : previewText,
    message: item.message,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    createdFrom: item.createdFrom,
    status: item.status,
    attachmentCount,
    lastError: item.lastError,
    lastAttemptAt: item.lastAttemptAt,
  };
}

function cloneItem(item: ProjectQueueItem): ProjectQueueItem {
  return {
    ...item,
    target: { ...item.target },
    message: {
      ...item.message,
      ...(item.message.attachments
        ? { attachments: item.message.attachments.map((file) => ({ ...file })) }
        : {}),
      ...(item.message.stagedAttachments
        ? {
            stagedAttachments: {
              ...item.message.stagedAttachments,
              refs: item.message.stagedAttachments.refs.map((ref) => ({
                ...ref,
              })),
            },
          }
        : {}),
      ...(item.message.metadata
        ? { metadata: { ...item.message.metadata } }
        : {}),
    },
    ...(item.createdFrom ? { createdFrom: { ...item.createdFrom } } : {}),
  };
}

export class ProjectQueueService {
  private dataDir: string;
  private filePath: string;
  private state: ProjectQueueState = {
    version: CURRENT_VERSION,
    items: [],
    dispatchState: RUNNING_DISPATCH_STATE,
  };
  private initialized = false;
  private mutationQueue: Promise<void> = Promise.resolve();
  private attachmentStagingService?: AttachmentStagingService;

  constructor(private options: ProjectQueueServiceOptions) {
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, "project-queues.json");
    this.attachmentStagingService = options.attachmentStagingService;
  }

  setAttachmentStagingService(
    attachmentStagingService: AttachmentStagingService | undefined,
  ): void {
    this.attachmentStagingService = attachmentStagingService;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as Partial<ProjectQueueState>;
      const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
      const items = rawItems
        .map(normalizeProjectQueueItem)
        .filter((item): item is ProjectQueueItem => item !== null);
      const dispatchState = normalizeDispatchState(
        parsed.dispatchState,
        items.length > 0,
      );
      this.state = {
        version: CURRENT_VERSION,
        items,
        dispatchState,
      };
      const needsSave =
        parsed.version !== CURRENT_VERSION ||
        items.length !== rawItems.length ||
        !dispatchStatesEqual(
          dispatchState,
          parsed.dispatchState as ProjectQueueDispatchState | undefined,
        ) ||
        rawItems.some(
          (item) =>
            isRecord(item) &&
            item.status !== undefined &&
            item.status !== "queued" &&
            item.status !== "failed",
        );
      if (needsSave) {
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[ProjectQueueService] Failed to load project queues, starting fresh:",
          error,
        );
      }
      this.state = {
        version: CURRENT_VERSION,
        items: [],
        dispatchState: RUNNING_DISPATCH_STATE,
      };
    }
    this.initialized = true;
  }

  listProject(projectId: UrlProjectId): ProjectQueueResponse {
    this.ensureInitialized();
    return {
      projectId,
      items: this.state.items
        .filter((item) => item.projectId === projectId)
        .map(summarizeItem),
      dispatchState: this.state.dispatchState,
    };
  }

  listAll(): ProjectQueueItemSummary[] {
    this.ensureInitialized();
    return this.state.items.map(summarizeItem);
  }

  getDispatchState(): ProjectQueueDispatchState {
    this.ensureInitialized();
    return this.state.dispatchState;
  }

  isDispatchPaused(): boolean {
    this.ensureInitialized();
    return this.state.dispatchState.status === "paused";
  }

  getProjectIdsWithDispatchableItems(): UrlProjectId[] {
    this.ensureInitialized();
    if (this.isDispatchPaused()) return [];
    const projectIds = new Set<UrlProjectId>();
    for (const item of this.state.items) {
      if (projectIds.has(item.projectId)) continue;
      const first = this.state.items.find(
        (candidate) => candidate.projectId === item.projectId,
      );
      if (first?.status === "queued") {
        projectIds.add(item.projectId);
      }
    }
    return [...projectIds];
  }

  hasDispatchableItem(projectId: UrlProjectId): boolean {
    this.ensureInitialized();
    if (this.isDispatchPaused()) return false;
    return (
      this.state.items.find((item) => item.projectId === projectId)?.status ===
      "queued"
    );
  }

  async pauseDispatch(
    reason: ProjectQueueDispatchPauseReason = "manual",
  ): Promise<ProjectQueueDispatchState> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      if (this.state.items.length === 0) {
        throw new ProjectQueueValidationError(
          "Cannot pause an empty Project Queue",
        );
      }
      this.state.dispatchState = {
        status: "paused",
        reason,
        pausedAt: new Date().toISOString(),
      };
      await this.save();
      this.emitAllProjectChanges("paused");
      return this.state.dispatchState;
    });
  }

  async resumeDispatch(): Promise<ProjectQueueDispatchState> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      this.state.dispatchState = RUNNING_DISPATCH_STATE;
      await this.save();
      this.emitAllProjectChanges("resumed");
      return this.state.dispatchState;
    });
  }

  async createItem(params: {
    projectId: UrlProjectId;
    projectPath: string;
    request: CreateProjectQueueItemRequest;
  }): Promise<ProjectQueueItemSummary> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      const now = new Date().toISOString();
      const itemId = randomUUID();
      const message = await this.prepareMessageForItem(
        itemId,
        normalizeMessage(params.request.message),
      );
      const item: ProjectQueueItem = {
        id: itemId,
        projectId: params.projectId,
        projectPath: params.projectPath,
        target: normalizeTarget(params.request.target),
        message,
        createdAt: now,
        updatedAt: now,
        createdFrom: normalizeCreatedFrom(params.request.createdFrom),
        status: "queued",
      };
      this.state.items.push(item);
      await this.save();
      this.emitChange(params.projectId, "created", item.id);
      return summarizeItem(item);
    });
  }

  async updateItem(
    projectId: UrlProjectId,
    itemId: string,
    request: UpdateProjectQueueItemRequest,
  ): Promise<ProjectQueueItemSummary | null> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      const index = this.findProjectItemIndex(projectId, itemId);
      if (index === -1) return null;
      const existing = this.state.items[index]!;
      if (existing.status === "dispatching") {
        throw new ProjectQueueValidationError(
          "Cannot update an item while it is dispatching",
        );
      }
      const updated: StoredProjectQueueItem = {
        ...existing,
        ...(request.target !== undefined
          ? { target: normalizeTarget(request.target) }
          : {}),
        ...(request.message !== undefined
          ? {
              message: await this.prepareMessageForItem(
                existing.id,
                normalizeMessage(request.message),
                existing.message.stagedAttachments,
              ),
            }
          : {}),
        status: existing.status === "failed" ? "queued" : existing.status,
        lastError: undefined,
        startupFailureCount: undefined,
        updatedAt: new Date().toISOString(),
      };
      const resumedDispatch = this.resumeDispatchForItemAction();
      this.state.items[index] = updated;
      await this.save();
      if (request.message !== undefined) {
        await this.cleanupReplacedQueueAttachments(
          existing.id,
          existing.message.stagedAttachments,
          updated.message.stagedAttachments,
        );
      }
      this.emitItemActionChange(projectId, "updated", itemId, resumedDispatch);
      return summarizeItem(updated);
    });
  }

  async deleteItem(projectId: UrlProjectId, itemId: string): Promise<boolean> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      const index = this.findProjectItemIndex(projectId, itemId);
      if (index === -1) return false;
      if (this.state.items[index]?.status === "dispatching") {
        throw new ProjectQueueValidationError(
          "Cannot delete an item while it is dispatching",
        );
      }
      const resumedDispatch = this.resumeDispatchForItemAction();
      const [deleted] = this.state.items.splice(index, 1);
      this.clearDispatchPauseIfEmpty();
      await this.save();
      await this.cleanupQueueAttachments(deleted);
      this.emitItemActionChange(projectId, "deleted", itemId, resumedDispatch);
      return true;
    });
  }

  async retryItem(
    projectId: UrlProjectId,
    itemId: string,
  ): Promise<ProjectQueueItemSummary | null> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      const index = this.findProjectItemIndex(projectId, itemId);
      if (index === -1) return null;
      const existing = this.state.items[index]!;
      if (existing.status === "dispatching") {
        throw new ProjectQueueValidationError(
          "Cannot retry an item while it is dispatching",
        );
      }
      const updated: StoredProjectQueueItem = {
        ...existing,
        status: "queued",
        lastError: undefined,
        startupFailureCount: undefined,
        updatedAt: new Date().toISOString(),
      };
      const resumedDispatch = this.resumeDispatchForItemAction();
      this.state.items[index] = updated;
      await this.save();
      this.emitItemActionChange(projectId, "retry", itemId, resumedDispatch);
      return summarizeItem(updated);
    });
  }

  async moveItemToTop(
    projectId: UrlProjectId,
    itemId: string,
  ): Promise<ProjectQueueItemSummary | null> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      const index = this.findProjectItemIndex(projectId, itemId);
      if (index === -1) return null;
      const existing = this.state.items[index]!;
      if (existing.status === "dispatching") {
        throw new ProjectQueueValidationError(
          "Cannot reorder an item while it is dispatching",
        );
      }

      const projectIndexes = this.getProjectItemIndexes(projectId);
      const projectItems = projectIndexes.map(
        (projectIndex) => this.state.items[projectIndex]!,
      );
      const originalIds = projectItems.map((item) => item.id);
      const projectItemIndex = projectItems.findIndex(
        (item) => item.id === itemId,
      );
      if (projectItemIndex === -1) return null;

      const [removed] = projectItems.splice(projectItemIndex, 1);
      const moved: ProjectQueueItem = {
        ...removed!,
        updatedAt: new Date().toISOString(),
      };
      const firstMovableIndex = projectItems.findIndex(
        (item) => item.status !== "dispatching",
      );
      projectItems.splice(
        firstMovableIndex === -1 ? projectItems.length : firstMovableIndex,
        0,
        moved,
      );

      const reordered = projectItems.some(
        (item, position) => item.id !== originalIds[position],
      );
      const resumedDispatch = this.resumeDispatchForItemAction();
      if (!reordered) {
        if (resumedDispatch) {
          await this.save();
          this.emitAllProjectChanges("resumed");
        }
        return summarizeItem(existing);
      }

      for (const [position, projectIndex] of projectIndexes.entries()) {
        this.state.items[projectIndex] = projectItems[position]!;
      }
      await this.save();
      this.emitItemActionChange(
        projectId,
        "reordered",
        itemId,
        resumedDispatch,
      );
      return summarizeItem(moved);
    });
  }

  async claimNextDispatchableItem(
    projectId: UrlProjectId,
  ): Promise<ProjectQueueItem | null> {
    return this.claimDispatchableItem(projectId);
  }

  async claimDispatchableItem(
    projectId: UrlProjectId,
    itemId?: string,
  ): Promise<ProjectQueueItem | null> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      if (this.isDispatchPaused()) return null;
      const index = itemId
        ? this.findProjectItemIndex(projectId, itemId)
        : this.state.items.findIndex((item) => item.projectId === projectId);
      if (index === -1) return null;
      const existing = this.state.items[index]!;
      if (existing.status !== "queued") return null;
      const now = new Date().toISOString();
      const updated: StoredProjectQueueItem = {
        ...existing,
        status: "dispatching",
        lastError: undefined,
        lastAttemptAt: now,
        updatedAt: now,
      };
      this.state.items[index] = updated;
      await this.save();
      this.emitChange(projectId, "dispatching", updated.id);
      return cloneItem(updated);
    });
  }

  async releaseDispatchingItem(
    projectId: UrlProjectId,
    itemId: string,
  ): Promise<ProjectQueueItemSummary | null> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      const index = this.findProjectItemIndex(projectId, itemId);
      if (index === -1) return null;
      const existing = this.state.items[index]!;
      if (existing.status !== "dispatching") return null;
      const updated: StoredProjectQueueItem = {
        ...existing,
        status: "queued",
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      };
      this.state.items[index] = updated;
      await this.save();
      this.emitChange(projectId, "released", itemId);
      return summarizeItem(updated);
    });
  }

  async recordRetryableStartupFailure(
    projectId: UrlProjectId,
    itemId: string,
    error: string,
  ): Promise<ProjectQueueItemSummary | null> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      const index = this.findProjectItemIndex(projectId, itemId);
      if (index === -1) return null;
      const existing = this.state.items[index]!;
      if (existing.status !== "dispatching") return null;

      const now = new Date().toISOString();
      const startupFailureCount = (existing.startupFailureCount ?? 0) + 1;
      const status =
        startupFailureCount >= MAX_AUTOMATIC_STARTUP_FAILURES
          ? "failed"
          : "queued";
      const updated: StoredProjectQueueItem = {
        ...existing,
        status,
        lastError: error,
        lastAttemptAt: now,
        startupFailureCount,
        updatedAt: now,
      };

      const projectIndexes = this.getProjectItemIndexes(projectId);
      const projectItems = projectIndexes.map(
        (projectIndex) => this.state.items[projectIndex]!,
      );
      const projectItemIndex = projectItems.findIndex(
        (item) => item.id === itemId,
      );
      if (projectItemIndex === -1) return null;
      projectItems.splice(projectItemIndex, 1);
      projectItems.unshift(updated);
      for (const [position, projectIndex] of projectIndexes.entries()) {
        this.state.items[projectIndex] = projectItems[position]!;
      }

      await this.save();
      this.emitChange(
        projectId,
        status === "failed" ? "failed" : "released",
        itemId,
      );
      return summarizeItem(updated);
    });
  }

  async completeDispatch(
    projectId: UrlProjectId,
    itemId: string,
  ): Promise<boolean> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      const index = this.findProjectItemIndex(projectId, itemId);
      if (index === -1) return false;
      const [completed] = this.state.items.splice(index, 1);
      this.clearDispatchPauseIfEmpty();
      await this.save();
      await this.cleanupQueueAttachments(completed);
      this.emitChange(projectId, "promoted", itemId);
      return true;
    });
  }

  async failDispatch(
    projectId: UrlProjectId,
    itemId: string,
    error: string,
  ): Promise<ProjectQueueItemSummary | null> {
    return this.withMutation(async () => {
      this.ensureInitialized();
      const index = this.findProjectItemIndex(projectId, itemId);
      if (index === -1) return null;
      const existing = this.state.items[index]!;
      const now = new Date().toISOString();
      const updated: StoredProjectQueueItem = {
        ...existing,
        status: "failed",
        lastError: error,
        lastAttemptAt: now,
        updatedAt: now,
      };
      this.state.items[index] = updated;
      await this.save();
      this.emitChange(projectId, "failed", itemId);
      return summarizeItem(updated);
    });
  }

  getFilePath(): string {
    return this.filePath;
  }

  private findProjectItemIndex(
    projectId: UrlProjectId,
    itemId: string,
  ): number {
    return this.state.items.findIndex(
      (item) => item.projectId === projectId && item.id === itemId,
    );
  }

  private getProjectItemIndexes(projectId: UrlProjectId): number[] {
    const indexes: number[] = [];
    for (const [index, item] of this.state.items.entries()) {
      if (item.projectId === projectId) indexes.push(index);
    }
    return indexes;
  }

  private clearDispatchPauseIfEmpty(): void {
    if (this.state.items.length > 0) return;
    this.state.dispatchState = RUNNING_DISPATCH_STATE;
  }

  private resumeDispatchForItemAction(): boolean {
    if (this.state.dispatchState.status !== "paused") return false;
    this.state.dispatchState = RUNNING_DISPATCH_STATE;
    return true;
  }

  private getProjectIdsWithItems(): UrlProjectId[] {
    return [...new Set(this.state.items.map((item) => item.projectId))];
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "ProjectQueueService not initialized. Call initialize() first.",
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

  private async save(): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(this.state, null, 2));
    await fs.rename(tmpPath, this.filePath);
  }

  private async prepareMessageForItem(
    itemId: string,
    message: ProjectQueueMessage,
    existingStagedAttachments?: ProjectQueueStagedAttachments,
  ): Promise<ProjectQueueMessage> {
    if (!message.stagedAttachments) {
      return message;
    }
    const stagedAttachments = await this.prepareStagedAttachmentsForItem(
      itemId,
      message.stagedAttachments,
      existingStagedAttachments,
    );
    return {
      ...message,
      stagedAttachments,
    };
  }

  private async prepareStagedAttachmentsForItem(
    itemId: string,
    stagedAttachments: ProjectQueueStagedAttachments,
    existingStagedAttachments?: ProjectQueueStagedAttachments,
  ): Promise<ProjectQueueStagedAttachments> {
    const staging = this.attachmentStagingService;
    if (!staging) {
      throw new ProjectQueueValidationError(
        "message.stagedAttachments is not supported",
      );
    }

    const refsMatchExisting =
      existingStagedAttachments !== undefined &&
      existingStagedAttachments.batchId === stagedAttachments.batchId &&
      existingStagedAttachments.refs.length === stagedAttachments.refs.length &&
      existingStagedAttachments.refs.every(
        (ref, index) => ref.id === stagedAttachments.refs[index]?.id,
      );

    try {
      const refs = refsMatchExisting
        ? await staging.validateQueueRefs(itemId, stagedAttachments.refs)
        : await staging.transferDraftAttachmentsToQueue({
            batchId: stagedAttachments.batchId,
            queueItemId: itemId,
            refs: stagedAttachments.refs,
          });
      const batchId = refs[0]?.batchId ?? stagedAttachments.batchId;
      return {
        batchId,
        refs,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      throw new ProjectQueueValidationError(
        `message.stagedAttachments is invalid: ${errorMessage(error)}`,
      );
    }
  }

  private async cleanupQueueAttachments(
    item: ProjectQueueItem | undefined,
  ): Promise<void> {
    if (!item?.message.stagedAttachments || !this.attachmentStagingService) {
      return;
    }
    await this.attachmentStagingService.deleteQueueAttachments(item.id);
  }

  private async cleanupReplacedQueueAttachments(
    itemId: string,
    previous: ProjectQueueStagedAttachments | undefined,
    next: ProjectQueueStagedAttachments | undefined,
  ): Promise<void> {
    if (!previous || !this.attachmentStagingService) {
      return;
    }
    const keptIds = new Set(next?.refs.map((ref) => ref.id) ?? []);
    for (const ref of previous.refs) {
      if (keptIds.has(ref.id)) continue;
      const record = this.attachmentStagingService.getRecord(ref.id);
      if (
        record?.owner.type === "project-queue" &&
        record.owner.queueItemId === itemId
      ) {
        await this.attachmentStagingService.deleteAttachment(ref.id);
      }
    }
  }

  private emitChange(
    projectId: UrlProjectId,
    reason: ProjectQueueChangedEvent["reason"],
    itemId?: string,
  ): void {
    const event: ProjectQueueChangedEvent = {
      type: "project-queue-changed",
      projectId,
      items: this.listProject(projectId).items,
      reason,
      ...(itemId ? { itemId } : {}),
      dispatchState: this.state.dispatchState,
      timestamp: new Date().toISOString(),
    };
    this.options.eventBus?.emit(event);
  }

  private emitItemActionChange(
    projectId: UrlProjectId,
    reason: ProjectQueueChangedEvent["reason"],
    itemId: string,
    resumedDispatch: boolean,
  ): void {
    this.emitChange(projectId, reason, itemId);
    if (!resumedDispatch) return;
    for (const otherProjectId of this.getProjectIdsWithItems()) {
      if (otherProjectId !== projectId) {
        this.emitChange(otherProjectId, "resumed");
      }
    }
  }

  private emitAllProjectChanges(
    reason: ProjectQueueChangedEvent["reason"],
  ): void {
    for (const projectId of this.getProjectIdsWithItems()) {
      this.emitChange(projectId, reason);
    }
  }
}
