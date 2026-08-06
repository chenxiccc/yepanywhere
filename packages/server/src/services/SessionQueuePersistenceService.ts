import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ALL_PERMISSION_MODES,
  ALL_PROVIDERS,
  type PermissionMode,
  type ProviderName,
  type UrlProjectId,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import type { UserMessage } from "../sdk/types.js";
import type { EventBus } from "../watcher/EventBus.js";

const CURRENT_VERSION = 1;
const FILE_NAME = "session-queued-messages.json";

export type PersistedSessionQueueKind = "direct" | "deferred" | "patient";

export type PersistedSessionQueueStatus =
  | "queued"
  | "paused-after-restart"
  | "claimed";

export interface PersistedSessionQueuedMessage {
  id: string;
  sessionId: string;
  projectId: UrlProjectId;
  projectPath: string;
  provider: ProviderName;
  executor?: string;
  model?: string;
  serviceTier?: string;
  mode?: PermissionMode;
  kind: PersistedSessionQueueKind;
  message: UserMessage;
  createdAt: string;
  updatedAt: string;
  queuedAt: string;
  status: PersistedSessionQueueStatus;
  source?: {
    clientId?: string;
    tempId?: string;
    requestId?: string;
  };
}

interface SessionQueuedMessagesState {
  version: number;
  items: PersistedSessionQueuedMessage[];
}

export interface SessionQueuePersistenceServiceOptions {
  dataDir: string;
  eventBus?: EventBus;
}

export class SessionQueuePersistenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionQueuePersistenceValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SessionQueuePersistenceValidationError(
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new SessionQueuePersistenceValidationError(
      `${field} must be a string`,
    );
  }
  return value.trim() ? value : undefined;
}

function normalizeProvider(value: unknown): ProviderName {
  if (
    typeof value !== "string" ||
    !ALL_PROVIDERS.includes(value as ProviderName)
  ) {
    throw new SessionQueuePersistenceValidationError("provider is invalid");
  }
  return value as ProviderName;
}

function normalizePermissionMode(value: unknown): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !ALL_PERMISSION_MODES.includes(value as PermissionMode)
  ) {
    throw new SessionQueuePersistenceValidationError("mode is invalid");
  }
  return value as PermissionMode;
}

function normalizeKind(value: unknown): PersistedSessionQueueKind {
  if (value === "direct" || value === "deferred" || value === "patient") {
    return value;
  }
  throw new SessionQueuePersistenceValidationError("kind is invalid");
}

function normalizeStatus(
  value: unknown,
  options: { loadedFromDisk: boolean },
): PersistedSessionQueueStatus {
  if (
    value !== "queued" &&
    value !== "paused-after-restart" &&
    value !== "claimed"
  ) {
    throw new SessionQueuePersistenceValidationError("status is invalid");
  }
  if (options.loadedFromDisk && (value === "queued" || value === "claimed")) {
    return "paused-after-restart";
  }
  return value;
}

function normalizeMessage(value: unknown): UserMessage {
  if (!isRecord(value)) {
    throw new SessionQueuePersistenceValidationError(
      "message must be an object",
    );
  }
  if (typeof value.text !== "string") {
    throw new SessionQueuePersistenceValidationError(
      "message.text must be a string",
    );
  }
  return cloneJson(value) as unknown as UserMessage;
}

function normalizeSource(
  value: unknown,
): PersistedSessionQueuedMessage["source"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new SessionQueuePersistenceValidationError(
      "source must be an object",
    );
  }
  const source = {
    clientId: optionalString(value.clientId, "source.clientId"),
    tempId: optionalString(value.tempId, "source.tempId"),
    requestId: optionalString(value.requestId, "source.requestId"),
  };
  if (!source.clientId && !source.tempId && !source.requestId) {
    return undefined;
  }
  return {
    ...(source.clientId ? { clientId: source.clientId } : {}),
    ...(source.tempId ? { tempId: source.tempId } : {}),
    ...(source.requestId ? { requestId: source.requestId } : {}),
  };
}

function normalizeItem(
  raw: unknown,
  options: { loadedFromDisk: boolean },
): PersistedSessionQueuedMessage {
  if (!isRecord(raw)) {
    throw new SessionQueuePersistenceValidationError(
      "queue item must be an object",
    );
  }

  const projectId = requiredString(raw.projectId, "projectId");
  if (!isUrlProjectId(projectId)) {
    throw new SessionQueuePersistenceValidationError("projectId is invalid");
  }
  const executor = optionalString(raw.executor, "executor");
  const model = optionalString(raw.model, "model");
  const serviceTier = optionalString(raw.serviceTier, "serviceTier");
  const mode = normalizePermissionMode(raw.mode);
  const source = normalizeSource(raw.source);

  return {
    id: requiredString(raw.id, "id"),
    sessionId: requiredString(raw.sessionId, "sessionId"),
    projectId,
    projectPath: requiredString(raw.projectPath, "projectPath"),
    provider: normalizeProvider(raw.provider),
    ...(executor ? { executor } : {}),
    ...(model ? { model } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(mode ? { mode } : {}),
    kind: normalizeKind(raw.kind),
    message: normalizeMessage(raw.message),
    createdAt: requiredString(raw.createdAt, "createdAt"),
    updatedAt: requiredString(raw.updatedAt, "updatedAt"),
    queuedAt: requiredString(raw.queuedAt, "queuedAt"),
    status: normalizeStatus(raw.status, options),
    ...(source ? { source } : {}),
  };
}

function normalizeItems(
  rawItems: unknown[],
  options: { loadedFromDisk: boolean },
): {
  items: PersistedSessionQueuedMessage[];
  droppedCount: number;
} {
  const items: PersistedSessionQueuedMessage[] = [];
  let droppedCount = 0;
  for (const rawItem of rawItems) {
    try {
      items.push(normalizeItem(rawItem, options));
    } catch {
      droppedCount += 1;
    }
  }
  return { items, droppedCount };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function itemsEqual(a: PersistedSessionQueuedMessage[], b: unknown[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class SessionQueuePersistenceService {
  private dataDir: string;
  private filePath: string;
  private eventBus: EventBus | undefined;
  private state: SessionQueuedMessagesState = {
    version: CURRENT_VERSION,
    items: [],
  };
  private initialized = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: SessionQueuePersistenceServiceOptions) {
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, FILE_NAME);
    this.eventBus = options.eventBus;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as Partial<SessionQueuedMessagesState>;
      const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
      const { items, droppedCount } = normalizeItems(rawItems, {
        loadedFromDisk: true,
      });
      this.state = { version: CURRENT_VERSION, items };
      const needsSave =
        parsed.version !== CURRENT_VERSION ||
        !Array.isArray(parsed.items) ||
        droppedCount > 0 ||
        !itemsEqual(items, rawItems);
      if (needsSave) {
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[SessionQueuePersistenceService] Failed to load queued messages, starting fresh:",
          error,
        );
      }
      this.state = { version: CURRENT_VERSION, items: [] };
    }
    this.initialized = true;
  }

  list(): PersistedSessionQueuedMessage[] {
    this.ensureInitialized();
    return this.state.items.map((item) => cloneJson(item));
  }

  listSession(sessionId: string): PersistedSessionQueuedMessage[] {
    this.ensureInitialized();
    return this.state.items
      .filter((item) => item.sessionId === sessionId)
      .map((item) => cloneJson(item));
  }

  async replaceAll(
    items: PersistedSessionQueuedMessage[],
  ): Promise<PersistedSessionQueuedMessage[]> {
    return this.withMutation(async () => {
      this.state.items = items.map((item) =>
        normalizeItem(item, { loadedFromDisk: false }),
      );
      await this.save();
      this.emitChange();
      return this.list();
    });
  }

  async upsertItem(
    item: PersistedSessionQueuedMessage,
  ): Promise<PersistedSessionQueuedMessage> {
    return this.withMutation(async () => {
      const normalized = normalizeItem(item, { loadedFromDisk: false });
      const index = this.state.items.findIndex(
        (candidate) => candidate.id === normalized.id,
      );
      if (index === -1) {
        this.state.items.push(normalized);
      } else {
        this.state.items[index] = normalized;
      }
      await this.save();
      this.emitChange();
      return cloneJson(normalized);
    });
  }

  async deleteItem(id: string): Promise<boolean> {
    return this.withMutation(async () => {
      const index = this.state.items.findIndex((item) => item.id === id);
      if (index === -1) return false;
      this.state.items.splice(index, 1);
      await this.save();
      this.emitChange();
      return true;
    });
  }

  async clear(): Promise<void> {
    await this.withMutation(async () => {
      this.state.items = [];
      await this.save();
      this.emitChange();
    });
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "SessionQueuePersistenceService not initialized. Call initialize() first.",
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
    await fs.mkdir(this.dataDir, { recursive: true });
    if (this.state.items.length === 0) {
      await fs.rm(this.filePath, { force: true });
      return;
    }
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(this.state, null, 2));
    await fs.rename(tmpPath, this.filePath);
  }

  private emitChange(): void {
    this.eventBus?.emit({
      type: "session-queue-persistence-changed",
      timestamp: new Date().toISOString(),
    });
  }
}
