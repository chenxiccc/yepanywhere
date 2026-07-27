import {
  ALL_PERMISSION_MODES,
  type ContextUsage,
  type DurableRecapMessage,
  type PermissionRules,
  type PromptSuggestionMode,
  type ProviderName,
  type RecapMode,
  type SessionMetadataResponse,
  type SessionOwnership,
  type ShowThinking,
  type ThinkingOption,
  type TranscriptDisplayObject,
  type UploadedFile,
  type UserQuestionAnswers,
  type UserMessageMetadata,
  type UrlProjectId,
  type WorkstreamId,
  buildEffectiveAgentContext,
  getModelContextWindow,
  isUrlProjectId,
  isWorkstreamId,
  mainWorkstreamId,
  truncateSessionTitle,
} from "@yep-anywhere/shared";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import { augmentTextBlocks } from "../augments/markdown-augments.js";
import type { ISessionIndexService } from "../indexes/types.js";
import { getLogger } from "../logging/logger.js";
import type { ToolResultMediaStore } from "../media/ToolResultMediaStore.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type { NotificationService } from "../notifications/index.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import { DETACHED_PROJECT_PATH, encodeProjectId } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { resolveCanonicalProjectRedirect } from "./session-project-routing.js";
import { ensureRemoteDirectory } from "../sdk/remote-spawn.js";
import { parseSlashCommandSubmission } from "../sdk/slashCommandEmulation.js";
import { getProjectDirFromCwd, syncSessions } from "../sdk/session-sync.js";
import type { PermissionMode, SDKMessage, UserMessage } from "../sdk/types.js";
import { appendApprovalAuditLog } from "../security/approvalAuditLog.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import type { SessionQueuePersistenceService } from "../services/SessionQueuePersistenceService.js";
import type { WorkstreamService } from "../services/WorkstreamService.js";
import { CodexSessionReader } from "../sessions/codex-reader.js";
import { cloneClaudeSession, cloneCodexSession } from "../sessions/fork.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { GrokSessionReader } from "../sessions/grok-reader.js";
import type { PiSessionReader } from "../sessions/pi-reader.js";
import { extractLastAgentExcerpt } from "../sessions/agent-excerpt.js";
import { normalizeSession } from "../sessions/normalization.js";
import {
  applyRecapOverlayToSession,
  applyRecapOverlayToSummary,
  hasEquivalentRecapMessage,
  hasUnreadProviderContent,
  latestRecapMessage,
  mergeRecapMessages,
} from "../sessions/recap-overlays.js";
import {
  type PaginationInfo,
  sliceAfterMessageIdWithMatch,
  sliceAtCompactAndUserTurnBoundaries,
  sliceAtCompactBoundaries,
  sliceAtUserTurnBoundary,
} from "../sessions/pagination.js";
import {
  augmentTaskListSnapshots,
  pruneTaskListSnapshotsToLatest,
} from "../augments/task-list-augments.js";
import {
  augmentEditToolUses,
  augmentPersistedSessionMessages,
} from "../sessions/persisted-augments.js";
import {
  findSessionListSummaryAcrossProviders,
  findSessionSummaryAcrossProviders,
  getSessionSources,
} from "../sessions/provider-resolution.js";
import type { ISessionReader, LoadedSession } from "../sessions/types.js";
import { getProvider } from "../sdk/providers/index.js";
import { getStaticSlashCommandsForProvider } from "../sdk/providers/staticSlashCommands.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Process } from "../supervisor/Process.js";
import type {
  QueueFullResponse,
  ResumeMode,
  Supervisor,
} from "../supervisor/Supervisor.js";
import { ResumeCompactionError } from "../supervisor/Supervisor.js";
import type { QueuedResponse } from "../supervisor/WorkerQueue.js";
import type {
  ContentBlock,
  Message,
  Project,
  Session,
} from "../supervisor/types.js";
import {
  buildUserMessageMetadata,
  normalizeOptionalServiceTier,
  parseHelperSettings,
  parseOptionalExecutor,
  parseOptionalResumeMode,
} from "./session-request-helpers.js";
import {
  resolveCompactPercent,
  resolveCompactWindow,
} from "./session-compact-thresholds.js";
import {
  type ClaudeResumeApiErrorBlocker,
  getClaudeResumeBlockerFromReader,
} from "./session-claude-resume-guard.js";
import {
  isClaudeSdkProviderName,
  isCodexProviderName,
  providerResolutionDeps,
} from "./session-provider-resolution.js";
import { parseSessionMetadataPatch } from "./session-metadata-patch.js";
import {
  recoveredPatientQueueSummaries,
  sessionQueueSummaries,
} from "./session-queue-summaries.js";
import {
  reportableProcessState,
  resolveRecoveredGroupForDelivery,
  resumeRecoveredGroup,
} from "./session-recovered-queue.js";
import { buildThinkingOptions } from "./session-thinking-options.js";
import type { EventBus } from "../watcher/index.js";

const SESSION_DETAIL_SLOW_LOG_MS = 250;
const DEFAULT_SESSION_DETAIL_TAIL_COMPACTIONS = 2;
const LARGE_FULL_HISTORY_MESSAGE_THRESHOLD = 1000;

async function getSessionSlashCommands(
  process: Process | undefined,
  provider: ProviderName | undefined,
) {
  if (process?.supportsDynamicCommands) {
    const commands = await process.supportedCommands();
    if (commands) return commands;
  }
  return getStaticSlashCommandsForProvider(provider);
}

function roundedMs(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Type guard to check if a result is a QueuedResponse
 */
function isQueuedResponse(
  result: Process | QueuedResponse | QueueFullResponse,
): result is QueuedResponse {
  return "queued" in result && result.queued === true;
}

/**
 * Type guard to check if a result is a QueueFullResponse
 */
function isQueueFullResponse(
  result: Process | QueuedResponse | QueueFullResponse,
): result is QueueFullResponse {
  return "error" in result && result.error === "queue_full";
}

const AUTO_COMPACT_CONTEXT_PERCENT_THRESHOLD = 85;
const AUTO_COMPACT_MODEL_PREFIXES = ["gpt-5.3-codex-spark"] as const;
const AUTO_COMPACT_TARGET_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  "codex",
  "codex-oss",
]);

type AutoCompactQueueResult =
  | { queued: false; reason: string; command?: undefined }
  | { queued: true; command: string };

export interface SessionsDeps {
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionIndexService?: ISessionIndexService;
  sessionMetadataService?: SessionMetadataService;
  eventBus?: EventBus;
  codexScanner?: CodexSessionScanner;
  codexSessionsDir?: string;
  /** Optional shared Codex reader factory for cross-provider session lookups */
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiScanner?: GeminiSessionScanner;
  geminiSessionsDir?: string;
  /** Optional shared Gemini reader factory for cross-provider session lookups */
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  /** Grok sessions directory (defaults to ~/.grok/sessions) */
  grokSessionsDir?: string;
  /** Optional shared Grok reader factory for cross-provider session lookups */
  grokReaderFactory?: (projectPath: string) => GrokSessionReader;
  /** pi sessions directory (defaults to ~/.pi/agent/sessions) */
  piSessionsDir?: string;
  /** Optional shared pi reader factory for cross-provider session lookups */
  piReaderFactory?: (projectPath: string) => PiSessionReader;
  /** ServerSettingsService for reading global instructions */
  serverSettingsService?: ServerSettingsService;
  /** WorkstreamService for resolving experimental checkout lanes */
  workstreamService?: WorkstreamService;
  /** ModelInfoService for context window lookups */
  modelInfoService?: ModelInfoService;
  /** Durable store for recovered patient queued messages */
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  /** Materializes image-bearing tool results for authenticated session reads. */
  toolResultMediaStore?: ToolResultMediaStore;
  /** Data directory for local security/audit logs */
  dataDir?: string;
}

function isApprovalAuditLogEnabled(deps: SessionsDeps): boolean {
  return (
    deps.serverSettingsService?.getSetting("approvalAuditLogEnabled") === true
  );
}

async function resolveSessionReaderForAgentContent({
  deps,
  project,
  sessionId,
  projectId,
}: {
  deps: SessionsDeps;
  project: Project;
  sessionId: string;
  projectId: UrlProjectId;
}): Promise<ISessionReader> {
  const metadataProvider = deps.sessionMetadataService?.getProvider(
    sessionId,
  ) as ProviderName | undefined;
  const resolved = await findSessionListSummaryAcrossProviders(
    project,
    sessionId,
    projectId,
    providerResolutionDeps(deps),
    metadataProvider,
  );

  return resolved?.source.reader ?? deps.readerFactory(project);
}

interface StartSessionBody {
  message: string;
  images?: string[];
  documents?: string[];
  attachments?: UploadedFile[];
  mode?: PermissionMode;
  model?: string;
  serviceTier?: string;
  thinking?: ThinkingOption;
  /** Display preference for thinking rows (default/on/off). */
  showThinking?: ShowThinking;
  provider?: ProviderName;
  /** Browser-side timestamp for request latency tracking (epoch ms) */
  clientTimestamp?: number;
  /** YA-internal submission timing and delivery-intent metadata. */
  messageMetadata?: UserMessageMetadata;
  /** Client-generated temp ID for optimistic UI tracking */
  tempId?: string;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
  /** Session recap behavior for future away-return triggers. */
  recapMode?: RecapMode;
  /** Browser-away duration before YA asks this session for a recap. */
  recapAfterSeconds?: number;
  /** Prompt suggestion behavior for this session. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
  /** Resume strategy for existing sessions. */
  resumeMode?: ResumeMode;
  /** Experimental workstream lane target for new project sessions. */
  workstreamId?: string;
}

interface CreateSessionBody {
  mode?: PermissionMode;
  model?: string;
  serviceTier?: string;
  thinking?: ThinkingOption;
  /** Display preference for thinking rows (default/on/off). */
  showThinking?: ShowThinking;
  provider?: ProviderName;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
  /** Session recap behavior for future away-return triggers. */
  recapMode?: RecapMode;
  /** Browser-away duration before YA asks this session for a recap. */
  recapAfterSeconds?: number;
  /** Prompt suggestion behavior for this session. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
  /** Experimental workstream lane target for new project sessions. */
  workstreamId?: string;
}

interface InputResponseBody {
  requestId: string;
  response: "approve" | "approve_accept_edits" | "deny" | string;
  answers?: UserQuestionAnswers;
  feedback?: string;
}

interface RestartSessionBody extends CreateSessionBody {
  reason?: string;
  /**
   * "handoff" (default): start a fresh session seeded with a bounded
   * transcript summary. "fork": copy the provider transcript into a new
   * session (real prefix fork; provider must support it — Claude today)
   * and continue there.
   */
  restartMode?: "handoff" | "fork";
  /**
   * Fork slice point: transcript message UUID (inclusive). Omit for a
   * full-transcript fork. Only meaningful with restartMode "fork".
   */
  forkUpToMessageId?: string;
}

const RESTART_HANDOFF_MAX_CHARS = 40_000;
const RESTART_HANDOFF_JSON_MAX_CHARS = 2_000;
const RESTART_HANDOFF_COMPACT_MAX_CHARS = 10_000;
const RESTART_HANDOFF_USER_TURNS_MAX_CHARS = 28_000;
const RESTART_HANDOFF_ACTIVITY_MAX_CHARS = 14_000;
const RESTART_HANDOFF_USER_TURN_MAX_CHARS = 4_000;
const RESTART_HANDOFF_ACTIVITY_ITEM_MAX_CHARS = 900;
const RESTART_HANDOFF_QUEUED_MAX_CHARS = 4_000;
const RESTART_HANDOFF_RECENT_USER_TURNS = 10;
const RESTART_HANDOFF_RECENT_ACTIVITY_ITEMS = 24;
const RESTART_COMPACT_WAIT_MS = 12_000;

function truncateForRestart(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars).trimEnd()}\n[truncated ${omitted} chars]`;
}

function formatRestartBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}\u202fb`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
  if (bytes < 1024 * 1024 * 1024)
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
  return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10}\u202fgb`;
}

function stringifyForRestart(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    return truncateForRestart(value, maxChars);
  }
  try {
    return truncateForRestart(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return "[unserializable content]";
  }
}

function renderRestartContent(content: unknown): string {
  if (content === undefined || content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return stringifyForRestart(content, RESTART_HANDOFF_JSON_MAX_CHARS);
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (!block || typeof block !== "object") {
        return "";
      }

      const typed = block as ContentBlock;
      switch (typed.type) {
        case "text":
          return typed.text ?? "";
        case "thinking":
          return typed.thinking
            ? `[thinking]\n${typed.thinking}`
            : "[thinking]";
        case "tool_use":
          return `[tool_use ${typed.name ?? "unknown"}]\n${stringifyForRestart(
            typed.input,
            RESTART_HANDOFF_JSON_MAX_CHARS,
          )}`;
        case "tool_result":
          return `[tool_result${typed.is_error ? " error" : ""} ${
            typed.tool_use_id ?? ""
          }]\n${renderRestartContent(typed.content)}`;
        case "image":
        case "input_image":
          return "[image]";
        case "document":
          return "[document]";
        default:
          return `[${typed.type}]\n${stringifyForRestart(
            typed,
            RESTART_HANDOFF_JSON_MAX_CHARS,
          )}`;
      }
    })
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function compactRestartLine(text: string, maxChars: number): string {
  return truncateForRestart(text.replace(/\s+/g, " ").trim(), maxChars);
}

function messageRole(message: Message): string {
  const nested = message.message as { role?: unknown } | undefined;
  return (
    (typeof nested?.role === "string" && nested.role) ||
    (typeof message.role === "string" && message.role) ||
    message.type ||
    "message"
  );
}

function messageTimestampSuffix(message: Message): string {
  return typeof message.timestamp === "string" && message.timestamp.trim()
    ? ` ${message.timestamp}`
    : "";
}

function messageContent(message: Message): unknown {
  const nested = message.message as { content?: unknown } | undefined;
  return nested?.content ?? (message as { content?: unknown }).content;
}

function messageId(message: Message | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  return (
    (typeof message.uuid === "string" && message.uuid) ||
    (typeof message.id === "string" && message.id) ||
    undefined
  );
}

function findDurableRecapCursor(
  afterMessageId: string | undefined,
  recaps: readonly DurableRecapMessage[],
): DurableRecapMessage | undefined {
  if (!afterMessageId) {
    return undefined;
  }
  return recaps.find(
    (recap) => recap.uuid === afterMessageId || recap.id === afterMessageId,
  );
}

function sliceAfterDurableRecapCursor(params: {
  messages: Message[];
  recap: DurableRecapMessage;
  cursorId: string;
}): { messages: Message[]; found: boolean } {
  const index = params.messages.findIndex((message) => {
    const id = messageId(message);
    return (
      id === params.cursorId ||
      id === params.recap.uuid ||
      id === params.recap.id ||
      hasEquivalentRecapMessage([message], params.recap)
    );
  });
  if (index < 0) {
    return { messages: params.messages, found: false };
  }
  return { messages: params.messages.slice(index + 1), found: true };
}

function messageHasToolResult(message: Message): boolean {
  if (message.toolUseResult !== undefined) {
    return true;
  }
  const content = messageContent(message);
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        !!block &&
        typeof block === "object" &&
        (block as ContentBlock).type === "tool_result",
    )
  );
}

function messageTextContent(message: Message): string | undefined {
  const content = messageContent(message);
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlocks = content
    .map((block) =>
      block &&
      typeof block === "object" &&
      (block as ContentBlock).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .filter(Boolean);
  return textBlocks.length > 0 ? textBlocks.join("\n") : undefined;
}

function isSlashCommandSkillBodyUserMessage(message: Message): boolean {
  if ((message as { isMeta?: unknown }).isMeta !== true) {
    return false;
  }
  return (
    messageTextContent(message)
      ?.trimStart()
      .startsWith("Base directory for this skill:") === true
  );
}

function isRestartInternalCompactCommand(message: Message): boolean {
  if (messageRole(message) !== "user" || messageHasToolResult(message)) {
    return false;
  }
  const content = renderRestartContent(messageContent(message)).trim();
  return /^\/(?:compact|compress)\b/i.test(content);
}

function isAutoCompactModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const normalized = model.toLowerCase().trim();
  return AUTO_COMPACT_MODEL_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

function isAutoCompactEligibleMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }

  // Avoid surprise when user explicitly invokes slash commands.
  if (trimmed.startsWith("/")) {
    return false;
  }

  return true;
}

async function tryQueueTargetedAutoCompact(params: {
  process: Process;
  model: string | undefined;
  message: string;
  resolveContextWindow: (
    model: string | undefined,
    provider?: ProviderName,
  ) => number;
}): Promise<AutoCompactQueueResult> {
  if (params.process.state.type !== "idle") {
    return { queued: false, reason: "process-not-idle" };
  }

  if (!AUTO_COMPACT_TARGET_PROVIDERS.has(params.process.provider)) {
    return { queued: false, reason: "provider-not-targeted" };
  }

  if (!isAutoCompactModel(params.model)) {
    return { queued: false, reason: "model-not-targeted" };
  }

  if (!isAutoCompactEligibleMessage(params.message)) {
    return { queued: false, reason: "non-user-turn" };
  }

  if (!params.process.supportsDynamicCommands) {
    return {
      queued: false,
      reason: "compact-command-advertising-unavailable",
    };
  }

  const contextUsage = extractContextUsageFromSDKMessages(
    params.process.getMessageHistory(),
    params.model,
    params.process.provider,
    params.resolveContextWindow,
  );
  if (!contextUsage?.contextWindow || contextUsage.contextWindow <= 0) {
    return { queued: false, reason: "context-window-unavailable" };
  }
  if (contextUsage.percentage < AUTO_COMPACT_CONTEXT_PERCENT_THRESHOLD) {
    return { queued: false, reason: "below-threshold" };
  }

  const commands = await params.process.supportedCommands();
  if (!commands) {
    return { queued: false, reason: "compact-command-list-unavailable" };
  }

  const command =
    commands.find((candidate) => candidate.name === "compact")?.name ??
    commands.find((candidate) => candidate.name === "compress")?.name;
  if (!command) {
    return { queued: false, reason: "compact-command-unavailable" };
  }

  const queued = params.process.queueMessage({ text: `/${command}` });
  if (!queued.success) {
    return {
      queued: false,
      reason: queued.error ?? "compact-not-queued",
    };
  }

  return { queued: true, command };
}

function toolInputSummary(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return compactRestartLine(stringifyForRestart(input, 400), 400);
  }

  const record = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of [
    "file_path",
    "path",
    "command",
    "query",
    "pattern",
    "old_string",
    "new_string",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      parts.push(`${key}=${compactRestartLine(value, 180)}`);
    }
  }

  return parts.length > 0
    ? parts.join("; ")
    : compactRestartLine(stringifyForRestart(input, 400), 400);
}

function summarizeToolUse(name: string | undefined, input: unknown): string {
  const toolName = name ?? "unknown";
  const summary = toolInputSummary(input);
  const lowerName = toolName.toLowerCase();
  const behavior = /read|grep|glob|search|ls|list/.test(lowerName)
    ? "read/search details omitted; rerun if needed"
    : /edit|write|patch|notebook/.test(lowerName)
      ? "edit/write details omitted; inspect the current repo diff"
      : "tool input summarized";
  return `[tool_use ${toolName}] ${summary} (${behavior})`;
}

function summarizeToolResult(content: unknown): string {
  const rendered = renderRestartContent(content);
  const charCount = rendered.length;
  return `[tool_result] output omitted (${charCount} chars; inspect live files or rerun reads if needed)`;
}

function renderRestartActivityContent(message: Message): string {
  if (message.toolUse) {
    return summarizeToolUse(message.toolUse.name, message.toolUse.input);
  }
  if (message.toolUseResult !== undefined) {
    return summarizeToolResult(message.toolUseResult);
  }

  const content = messageContent(message);
  if (!Array.isArray(content)) {
    return renderRestartContent(content);
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (!block || typeof block !== "object") {
        return "";
      }

      const typed = block as ContentBlock;
      switch (typed.type) {
        case "tool_use":
          return summarizeToolUse(typed.name, typed.input);
        case "tool_result":
          return summarizeToolResult(typed.content);
        case "thinking":
          return typed.thinking ? "[thinking summary omitted]" : "[thinking]";
        default:
          return renderRestartContent([typed]);
      }
    })
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function formatRestartMessage(message: Message): string | null {
  if (isRestartInternalCompactCommand(message)) {
    return null;
  }

  const role = messageRole(message);
  const timestamp = messageTimestampSuffix(message);
  const content = isHumanUserMessage(message)
    ? renderRestartContent(messageContent(message))
    : renderRestartActivityContent(message);
  const subtype =
    typeof message.subtype === "string" ? `:${message.subtype}` : "";
  const trimmed = content.trim();

  if (!trimmed && !subtype) {
    return null;
  }

  return `### ${role}${subtype}${timestamp}\n\n${truncateForRestart(
    trimmed || "[no textual content]",
    isHumanUserMessage(message)
      ? RESTART_HANDOFF_USER_TURN_MAX_CHARS
      : RESTART_HANDOFF_ACTIVITY_ITEM_MAX_CHARS,
  )}`;
}

function formatRestartQueuedMessage(
  message: {
    tempId?: string;
    content: string;
    timestamp: string;
    attachments?: UploadedFile[];
    attachmentCount?: number;
  },
  index: number,
): string {
  const attachmentLines =
    message.attachments?.length && message.attachments.length > 0
      ? `\n\nUser uploaded files in .attachments:\n${message.attachments
          .map(
            (file) =>
              `- [${file.originalName.replaceAll("[", "\\[").replaceAll("]", "\\]")}](<${file.path}>) (${formatRestartBytes(file.size)}, ${file.mimeType}${file.width && file.height ? `, ${file.width}x${file.height}` : ""})`,
          )
          .join("\n")}`
      : message.attachmentCount && message.attachmentCount > 0
        ? `\nAttachments queued: ${message.attachmentCount}`
        : "";
  const tempIdLine = message.tempId ? `\nTemp ID: ${message.tempId}` : "";
  return `### queued user ${index + 1} ${message.timestamp}\n\n${truncateForRestart(
    message.content.trim() || "[empty queued turn]",
    RESTART_HANDOFF_QUEUED_MAX_CHARS,
  )}${attachmentLines}${tempIdLine}`;
}

type RestartQueuedMessage = {
  tempId?: string;
  content: string;
  timestamp: string;
  attachments?: UploadedFile[];
  attachmentCount?: number;
};

function getRestartQueuedMessages(
  process: Process | undefined,
): RestartQueuedMessage[] {
  return process?.getDeferredQueueSummary?.() ?? [];
}

type RestartCompactAttempt =
  | { status: "unavailable"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "completed"; command: string }
  | { status: "timed-out"; command: string }
  | { status: "failed"; command?: string; reason: string };

function isCompactBoundaryMessage(message: SDKMessage | Message): boolean {
  return message.type === "system" && message.subtype === "compact_boundary";
}

function describeRestartCompactAttempt(attempt: RestartCompactAttempt): string {
  switch (attempt.status) {
    case "completed":
      return `completed with /${attempt.command}`;
    case "timed-out":
      return `tried /${attempt.command}; no compact boundary arrived before YA fallback`;
    case "failed":
      return attempt.command
        ? `tried /${attempt.command}; failed: ${attempt.reason}`
        : `failed: ${attempt.reason}`;
    case "skipped":
    case "unavailable":
      return `${attempt.status}: ${attempt.reason}`;
  }
}

async function waitForRestartCompactBoundary(
  process: Process,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (completed: boolean) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(completed);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);

    unsubscribe = process.subscribe((event) => {
      if (event.type === "message" && isCompactBoundaryMessage(event.message)) {
        finish(true);
        return;
      }
      if (event.type === "terminated" || event.type === "error") {
        finish(false);
      }
    });
  });
}

async function tryRestartCompact(
  process: Process | undefined,
): Promise<RestartCompactAttempt> {
  if (!process) {
    return { status: "unavailable", reason: "no active source process" };
  }
  if (process.state.type !== "idle") {
    return {
      status: "skipped",
      reason: `source process was ${process.state.type}`,
    };
  }
  if (!process.supportsDynamicCommands) {
    return {
      status: "unavailable",
      reason: "source process does not advertise slash commands",
    };
  }

  let command: string | undefined;
  try {
    const commands = await process.supportedCommands();
    command =
      commands?.find((candidate) => candidate.name === "compact")?.name ??
      commands?.find((candidate) => candidate.name === "compress")?.name;
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!command) {
    return {
      status: "unavailable",
      reason: "no compact/compress slash command advertised",
    };
  }

  const waitForCompact = waitForRestartCompactBoundary(
    process,
    RESTART_COMPACT_WAIT_MS,
  );
  const queued = process.queueMessage({ text: `/${command}` });
  if (!queued.success) {
    return {
      status: "failed",
      command,
      reason: queued.error ?? "compact command was not accepted",
    };
  }

  return (await waitForCompact)
    ? { status: "completed", command }
    : { status: "timed-out", command };
}

function latestCompactSummary(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.type !== "system" ||
      (message as { subtype?: unknown }).subtype !== "compact_boundary"
    ) {
      continue;
    }

    const summary = renderRestartContent(messageContent(message)).trim();
    if (summary && !/^context compacted\.?$/i.test(summary)) {
      return truncateForRestart(summary, RESTART_HANDOFF_COMPACT_MAX_CHARS);
    }
  }
  return null;
}

function selectRestartMessages(params: {
  messages: Message[];
  maxItems: number;
  maxChars: number;
  predicate: (message: Message) => boolean;
  selectedIndexes: Set<number>;
}): string[] {
  const selected: string[] = [];
  let used = 0;

  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const message = params.messages[index];
    if (!message || !params.predicate(message)) {
      continue;
    }
    const formatted = formatRestartMessage(message);
    if (!formatted) {
      continue;
    }
    const nextSize = formatted.length + 2;
    if (
      selected.length >= params.maxItems ||
      (selected.length > 0 && used + nextSize > params.maxChars)
    ) {
      break;
    }
    selected.push(formatted);
    params.selectedIndexes.add(index);
    used += nextSize;
  }

  return selected.reverse();
}

function buildRestartTranscript(messages: Message[]): {
  transcript: string;
  omittedCount: number;
} {
  const selectedIndexes = new Set<number>();
  const compactSummary = latestCompactSummary(messages);
  const userTurns = selectRestartMessages({
    messages,
    maxItems: RESTART_HANDOFF_RECENT_USER_TURNS,
    maxChars: RESTART_HANDOFF_USER_TURNS_MAX_CHARS,
    predicate: isHumanUserMessage,
    selectedIndexes,
  });
  const activity = selectRestartMessages({
    messages,
    maxItems: RESTART_HANDOFF_RECENT_ACTIVITY_ITEMS,
    maxChars: RESTART_HANDOFF_ACTIVITY_MAX_CHARS,
    predicate: (message) =>
      !isHumanUserMessage(message) &&
      !(
        message.type === "system" &&
        (message as { subtype?: unknown }).subtype === "compact_boundary" &&
        compactSummary
      ),
    selectedIndexes,
  });

  const sections = [
    compactSummary
      ? `## Provider-Native Compact Summary\n\n${compactSummary}`
      : undefined,
    userTurns.length > 0
      ? `## Recent User Turns\n\n${userTurns.join("\n\n")}`
      : undefined,
    activity.length > 0
      ? `## Recent Agent and Tool Activity\n\n${activity.join("\n\n")}`
      : undefined,
  ].filter((section): section is string => Boolean(section));

  return {
    transcript: truncateForRestart(
      sections.join("\n\n"),
      RESTART_HANDOFF_MAX_CHARS,
    ),
    omittedCount: Math.max(0, messages.length - selectedIndexes.size),
  };
}

function compactRestartTitleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripMarkdownHeading(text: string): string {
  return text.replace(/^#+\s*/, "");
}

function isGeneratedRestartHandoffTitle(text: string): boolean {
  const title = stripMarkdownHeading(compactRestartTitleText(text));
  return (
    /^Restart Handoff\b/i.test(title) ||
    /^Handoff:\s*Restart Handoff\b/i.test(title) ||
    /^Handoff:\s*Yep Anywhere is starting this as a fresh agent session\b/i.test(
      title,
    ) ||
    /^Yep Anywhere is starting this as a fresh agent session\b/i.test(title)
  );
}

function normalizeRestartTitleCandidate(
  title: string | null | undefined,
): string | undefined {
  if (!title) {
    return undefined;
  }
  const candidate = stripMarkdownHeading(compactRestartTitleText(title));
  if (!candidate || isGeneratedRestartHandoffTitle(candidate)) {
    return undefined;
  }
  return candidate;
}

function isHumanUserMessage(message: Message): boolean {
  const nested = message.message as { role?: unknown } | undefined;
  const role =
    (typeof nested?.role === "string" && nested.role) ||
    (typeof message.role === "string" && message.role) ||
    message.type;
  return role === "user" && !messageHasToolResult(message);
}

function isCompactSummaryUserMessage(message: Message): boolean {
  return (message as { isCompactSummary?: unknown }).isCompactSummary === true;
}

function isUserAuthoredRequest(message: Message): boolean {
  return (
    isHumanUserMessage(message) &&
    message.isSynthetic !== true &&
    !isCompactSummaryUserMessage(message) &&
    !isSlashCommandSkillBodyUserMessage(message)
  );
}

function resolveForkAfterBoundary(
  messages: Message[],
  sourceMessageId: string,
  sourceIsBusy: boolean,
):
  | {
      placementAfterMessageId: string;
      retainedThroughMessageId: string;
      retainedThroughContext?: string;
    }
  | { error: string; status: 400 | 404 | 409 } {
  const sourceIndex = messages.findIndex(
    (message) => messageId(message) === sourceMessageId,
  );
  const sourceMessage = messages[sourceIndex];
  if (sourceIndex < 0 || !sourceMessage) {
    return { error: "Selected source message was not found", status: 404 };
  }
  if (!isUserAuthoredRequest(sourceMessage)) {
    return {
      error: "sourceMessageId must identify a user-authored request",
      status: 400,
    };
  }

  let nextUserIndex = -1;
  for (let index = sourceIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (candidate && isUserAuthoredRequest(candidate)) {
      nextUserIndex = index;
      break;
    }
  }
  if (nextUserIndex < 0 && sourceIsBusy) {
    return {
      error: "The selected turn is still in progress",
      status: 409,
    };
  }

  const searchEnd =
    nextUserIndex >= 0 ? nextUserIndex - 1 : messages.length - 1;
  let hasAssistantResponse = false;
  for (let index = sourceIndex + 1; index <= searchEnd; index += 1) {
    const candidate = messages[index];
    if (candidate && messageRole(candidate) === "assistant") {
      hasAssistantResponse = true;
      break;
    }
  }
  if (!hasAssistantResponse) {
    return {
      error: "The selected request has no completed assistant response",
      status: 409,
    };
  }

  let boundary: Message | undefined;
  for (let index = searchEnd; index > sourceIndex; index -= 1) {
    const candidate = messages[index];
    const role = candidate ? messageRole(candidate) : undefined;
    if (
      candidate &&
      messageId(candidate) &&
      (role === "user" || role === "assistant")
    ) {
      boundary = candidate;
      break;
    }
  }
  const retainedThroughMessageId = messageId(boundary);
  if (!boundary || !retainedThroughMessageId) {
    return { error: "Completed turn boundary has no message id", status: 409 };
  }

  const placementAfterMessageId =
    [...messages].reverse().map(messageId).find(Boolean) ??
    retainedThroughMessageId;
  const rendered = renderRestartContent(messageContent(boundary)).trim();
  return {
    placementAfterMessageId,
    retainedThroughMessageId,
    retainedThroughContext: rendered
      ? truncateForRestart(rendered, 1200)
      : undefined,
  };
}

function forkSummaryTitle(
  summary: string,
  fallback: string | undefined,
): string {
  const firstLine = summary
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const candidate = firstLine
    ?.replace(/^#{1,6}\s*/u, "")
    .replace(/^title:\s*/iu, "")
    .trim()
    .replace(/[.!?]+$/u, "");
  return truncateSessionTitle(candidate || fallback || "Forked session");
}

function generatedRetitleCandidate(title: string): string | undefined {
  const firstLine = title
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return undefined;
  }
  const candidate = normalizeRestartTitleCandidate(
    firstLine
      .replace(/^title:\s*/iu, "")
      .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
      .replace(/[.!?]+$/u, "")
      .trim(),
  );
  return candidate ? truncateSessionTitle(candidate) : undefined;
}

function messageTitleCandidate(message: Message): string | undefined {
  if (
    !isHumanUserMessage(message) ||
    isRestartInternalCompactCommand(message)
  ) {
    return undefined;
  }

  const nested = message.message as { content?: unknown } | undefined;
  const content =
    renderRestartContent(nested?.content) ||
    renderRestartContent((message as { content?: unknown }).content);
  const candidate = normalizeRestartTitleCandidate(content);

  if (
    !candidate ||
    /^\[(tool_result|tool_use|thinking|image|document)\]/i.test(candidate)
  ) {
    return undefined;
  }
  return candidate;
}

function latestUserTitleCandidate(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const candidate = messageTitleCandidate(message);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function truncateRestartTitle(title: string): string {
  return truncateSessionTitle(title);
}

function deriveRestartTitle(params: {
  preferredTitle?: string | null;
  sourceSession: Session;
}): string {
  const candidates = [
    params.preferredTitle,
    params.sourceSession.customTitle,
    params.sourceSession.title,
    latestUserTitleCandidate(params.sourceSession.messages),
  ];
  const base =
    candidates.map(normalizeRestartTitleCandidate).find(Boolean) ??
    "restarted session";
  const title = /^Handoff:/i.test(base) ? base : `Handoff: ${base}`;
  return truncateRestartTitle(title);
}

function deriveForkTitle(params: {
  preferredTitle?: string | null;
  sourceSession: Session;
}): string {
  const candidates = [
    params.preferredTitle,
    params.sourceSession.customTitle,
    params.sourceSession.title,
    latestUserTitleCandidate(params.sourceSession.messages),
  ];
  const base =
    candidates.map(normalizeRestartTitleCandidate).find(Boolean) ??
    "forked session";
  const title = /^Fork:/i.test(base) ? base : `Fork: ${base}`;
  return truncateRestartTitle(title);
}

function buildRestartHandoff(params: {
  handoffTitle: string;
  sourceSession: Session;
  sourceProvider?: ProviderName;
  sourceModel?: string;
  sourceProcess?: Process;
  compactAttempt?: RestartCompactAttempt;
  projectPath: string;
  reason?: string;
  omittedCount: number;
  transcript: string;
}): string {
  const {
    handoffTitle,
    sourceSession,
    sourceProvider,
    sourceModel,
    sourceProcess,
    compactAttempt,
    projectPath,
    reason,
    omittedCount,
    transcript,
  } = params;
  const oldProcessLine = sourceProcess
    ? `- Previous YA process: ${sourceProcess.id} (${sourceProcess.state.type})`
    : "- Previous YA process: none active";
  const omittedLine =
    omittedCount > 0
      ? `\n${omittedCount} older rendered messages were omitted to keep this restart handoff bounded.`
      : "";
  const queuedMessages = getRestartQueuedMessages(sourceProcess);
  const queuedSection =
    queuedMessages.length > 0
      ? [
          "## Queued User Turns (Not Yet Processed)",
          "",
          "These user turns were accepted by YA's deferred queue after the source transcript. No agent response in the source session has processed them yet.",
          "",
          queuedMessages.map(formatRestartQueuedMessage).join("\n\n"),
        ].join("\n")
      : undefined;

  return [
    `# ${handoffTitle}`,
    "",
    "Yep Anywhere is starting this as a fresh agent session because the previous process became unhealthy or was manually restarted.",
    "Treat the transcript below as context, not as a new request to repeat. Prefer any provider-native compact summary when present, then use the recent user turns and summarized activity to continue the user's latest unresolved work after checking the live repository state.",
    "",
    "## Source Session",
    "",
    `- Session ID: ${sourceSession.id}`,
    `- Project path: ${projectPath}`,
    `- Provider: ${sourceProvider ?? sourceSession.provider}`,
    `- Model: ${sourceModel ?? sourceSession.model ?? "unknown"}`,
    oldProcessLine,
    compactAttempt
      ? `- Provider-native compact: ${describeRestartCompactAttempt(compactAttempt)}`
      : undefined,
    reason ? `- Restart reason: ${reason}` : undefined,
    "",
    "## Recent Transcript",
    omittedLine,
    transcript || "[No textual transcript was available.]",
    queuedSection,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function isRestartReplacementActivity(message: SDKMessage): boolean {
  return message.type === "assistant";
}

/**
 * Convert SDK messages to client Message format.
 * Used for mock SDK sessions where messages aren't persisted to disk.
 */
function sdkMessagesToClientMessages(sdkMessages: SDKMessage[]): Message[] {
  const messages: Message[] = [];
  for (const msg of sdkMessages) {
    const rawFields = msg as Record<string, unknown>;
    if (isCompactBoundaryMessage(msg)) {
      const content =
        (typeof msg.message?.content === "string"
          ? msg.message.content
          : undefined) ??
        (typeof msg.content === "string" ? msg.content : "Context compacted");
      messages.push({
        ...rawFields,
        id: msg.uuid ?? `msg-${Date.now()}-${messages.length}`,
        type: "system",
        role: "system",
        subtype: "compact_boundary",
        content,
        message: { role: "system", content },
        timestamp:
          typeof msg.timestamp === "string" && msg.timestamp.trim().length > 0
            ? msg.timestamp
            : new Date().toISOString(),
      });
      continue;
    }

    // Only include user and assistant messages with content
    if (
      (msg.type === "user" || msg.type === "assistant") &&
      msg.message?.content
    ) {
      const rawContent = msg.message.content;
      // Both user and assistant messages can have string or array content.
      // User messages with tool_result blocks have array content that must be preserved.
      // Assistant messages need ContentBlock[] for transcript projection.
      let content: string | ContentBlock[];
      if (typeof rawContent === "string") {
        // String content: keep as-is for user messages, wrap in text block for assistant
        content =
          msg.type === "user"
            ? rawContent
            : [{ type: "text" as const, text: rawContent }];
      } else if (Array.isArray(rawContent)) {
        // Array content: pass through as ContentBlock[] for both user and assistant
        content = rawContent as ContentBlock[];
      } else {
        // Unknown content type - skip this message
        continue;
      }

      messages.push({
        ...rawFields,
        id: msg.uuid ?? `msg-${Date.now()}-${messages.length}`,
        type: msg.type,
        role: msg.type as "user" | "assistant",
        content,
        timestamp:
          typeof msg.timestamp === "string" && msg.timestamp.trim().length > 0
            ? msg.timestamp
            : new Date().toISOString(),
      });
    }
  }
  return messages;
}

/**
 * Compute compaction overhead from SDK messages.
 * Same logic as computeCompactionOverhead in reader.ts but for SDKMessage type.
 */
function computeSDKCompactionOverhead(sdkMessages: SDKMessage[]): number {
  // Find the last compact_boundary with compactMetadata
  let lastCompactIdx = -1;
  let preTokens = 0;

  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg?.type === "system" && msg.subtype === "compact_boundary") {
      const metadata = (msg as { compactMetadata?: { preTokens?: number } })
        .compactMetadata;
      if (metadata?.preTokens) {
        lastCompactIdx = i;
        preTokens = metadata.preTokens;
        break;
      }
    }
  }

  if (lastCompactIdx === -1) return 0;

  // Find last assistant message before compaction with non-zero usage
  for (let i = lastCompactIdx - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg?.type === "assistant" && msg.usage) {
      const usage = msg.usage as {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      const total =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      if (total > 0) {
        const overhead = preTokens - total;
        return overhead > 0 ? overhead : 0;
      }
    }
  }

  return 0;
}

/**
 * Extract context usage from SDK messages.
 * Finds the last assistant message with usage data.
 *
 * @param sdkMessages - SDK messages to search
 * @param model - Model ID for determining context window size
 * @param provider - Provider for model-less context-window fallback
 */
function extractContextUsageFromSDKMessages(
  sdkMessages: SDKMessage[],
  model: string | undefined,
  provider?: ProviderName,
  resolveContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
  ) => number,
): ContextUsage | undefined {
  const contextWindowSize = resolveContextWindow
    ? resolveContextWindow(model, provider)
    : getModelContextWindow(model, provider);

  const isCodexProvider = provider === "codex" || provider === "codex-oss";

  // Compute compaction overhead for Claude sessions
  const overhead = isCodexProvider
    ? 0
    : computeSDKCompactionOverhead(sdkMessages);

  // Find the last assistant message with usage data (iterate backwards)
  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg && msg.type === "assistant" && msg.usage) {
      const usage = msg.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };

      // Codex context meter is based on fresh input tokens from the latest turn.
      // Claude/OpenCode/Gemini paths continue to include cached+creation tokens.
      const rawInputTokens = isCodexProvider
        ? (usage.input_tokens ?? 0)
        : (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);

      // Skip messages with zero input tokens (incomplete streaming messages)
      if (rawInputTokens === 0) {
        continue;
      }

      // Apply compaction overhead correction
      const inputTokens = rawInputTokens + overhead;

      const percentage = Math.round((inputTokens / contextWindowSize) * 100);

      const result: ContextUsage = {
        inputTokens,
        percentage,
        contextWindow: contextWindowSize,
      };

      // Add optional fields if available
      if (usage.output_tokens !== undefined && usage.output_tokens > 0) {
        result.outputTokens = usage.output_tokens;
      }
      if (isCodexProvider) {
        if (
          usage.cached_input_tokens !== undefined &&
          usage.cached_input_tokens > 0
        ) {
          result.cacheReadTokens = usage.cached_input_tokens;
        }
      } else if (
        usage.cache_read_input_tokens !== undefined &&
        usage.cache_read_input_tokens > 0
      ) {
        result.cacheReadTokens = usage.cache_read_input_tokens;
      }
      if (
        usage.cache_creation_input_tokens !== undefined &&
        usage.cache_creation_input_tokens > 0
      ) {
        result.cacheCreationTokens = usage.cache_creation_input_tokens;
      }

      return result;
    }
  }
  return undefined;
}

export function createSessionsRoutes(deps: SessionsDeps): Hono {
  const routes = new Hono();
  const activeForkSummaryJobs = new Map<
    string,
    { objectId: string; abortController: AbortController }
  >();
  const emitTranscriptDisplayObjects = (sessionId: string): void => {
    deps.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId,
      transcriptDisplayObjects:
        deps.sessionMetadataService?.getTranscriptDisplayObjects(sessionId) ??
        [],
      timestamp: new Date().toISOString(),
    });
  };
  const updateForkSummaryChildMetadata = async (
    childSessionId: string,
    parentSessionId: string,
    title: string,
    archived: boolean,
  ): Promise<void> => {
    await deps.sessionMetadataService?.updateMetadata(childSessionId, {
      title,
      archived,
      parentSessionId,
    });
    deps.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId: childSessionId,
      title,
      archived,
      parentSessionId,
      timestamp: new Date().toISOString(),
    });
  };
  const getCodexReader = (projectPath: string): CodexSessionReader | null =>
    deps.codexReaderFactory?.(projectPath) ??
    (deps.codexSessionsDir
      ? new CodexSessionReader({
          sessionsDir: deps.codexSessionsDir,
          projectPath,
        })
      : null);

  let unscopedGrokReader: GrokSessionReader | null | undefined;
  const getUnscopedGrokReader = (): GrokSessionReader | null => {
    if (unscopedGrokReader !== undefined) {
      return unscopedGrokReader;
    }
    unscopedGrokReader = deps.grokSessionsDir
      ? new GrokSessionReader({ sessionsDir: deps.grokSessionsDir })
      : null;
    return unscopedGrokReader;
  };

  const getGrokNativeProjectId = async (
    sessionId: string,
    currentProjectId: UrlProjectId,
  ): Promise<UrlProjectId | null> => {
    const reader = getUnscopedGrokReader();
    if (!reader) {
      return null;
    }
    const projectPath = await reader.getSessionProjectPath(sessionId);
    if (!projectPath) {
      return null;
    }
    const canonicalProjectId = encodeProjectId(projectPath);
    return canonicalProjectId === currentProjectId ? null : canonicalProjectId;
  };

  const buildGrokNativeRedirectPath = (
    canonicalProjectId: UrlProjectId,
    sessionId: string,
    suffix: "" | "/metadata",
    requestUrl: string,
  ): string => {
    const search = new URL(requestUrl).search;
    return `/api/projects/${canonicalProjectId}/sessions/${encodeURIComponent(
      sessionId,
    )}${suffix}${search}`;
  };

  const buildSessionProjectRedirectPath = (
    canonicalProjectId: UrlProjectId,
    sessionId: string,
    suffix: string,
    requestUrl: string,
  ): string => {
    const search = new URL(requestUrl).search;
    return `/api/projects/${canonicalProjectId}/sessions/${encodeURIComponent(
      sessionId,
    )}${suffix}${search}`;
  };

  const resolveSessionProjectRouting = async (
    requestProjectId: UrlProjectId,
    sessionId: string,
  ): Promise<
    | { error: string; status: 404 }
    | {
        redirectProjectId: UrlProjectId;
      }
    | {
        transcriptProject: Project;
        transcriptProjectId: UrlProjectId;
        workingProject: Project;
        workingProjectId: UrlProjectId;
      }
  > => {
    const workingProjectId =
      deps.sessionMetadataService?.getMetadata(sessionId)?.workingProjectId;
    const activeProcess = deps.supervisor.getProcessForSession(sessionId);
    const redirectProjectId = resolveCanonicalProjectRedirect({
      requestProjectId,
      workingProjectId,
      activeProcessProjectId:
        typeof activeProcess?.projectId === "string"
          ? activeProcess.projectId
          : undefined,
    });
    if (redirectProjectId) {
      return { redirectProjectId };
    }

    const workingProject =
      await deps.scanner.getOrCreateProject(requestProjectId);
    if (!workingProject) {
      return { error: "Project not found", status: 404 };
    }

    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
    const overlayTranscriptProjectId =
      metadata?.workingProjectId === requestProjectId &&
      metadata.transcriptProjectId &&
      metadata.transcriptProjectId !== requestProjectId
        ? metadata.transcriptProjectId
        : undefined;

    // Default: the transcript lives under the working (request) project.
    let transcriptProjectId: UrlProjectId = requestProjectId;
    let transcriptProject: Project = workingProject;

    // Overlay case (session "moved" to a different working project): the
    // transcript may live under a distinct project. Trust the recorded pointer
    // only if the transcript is actually findable there — a stale/wrong pointer
    // must not permanently brick viewing, so fall back to the working project.
    if (overlayTranscriptProjectId) {
      const overlayProject = await deps.scanner.getOrCreateProject(
        overlayTranscriptProjectId,
      );
      const overlayHasTranscript = overlayProject
        ? Boolean(
            await findSessionListSummaryAcrossProviders(
              overlayProject,
              sessionId,
              overlayTranscriptProjectId,
              providerResolutionDeps(deps),
              deps.sessionMetadataService?.getProvider(sessionId) as
                | ProviderName
                | undefined,
            ),
          )
        : false;
      if (overlayProject && overlayHasTranscript) {
        transcriptProjectId = overlayTranscriptProjectId;
        transcriptProject = overlayProject;
      }
    }

    return {
      transcriptProject,
      transcriptProjectId,
      workingProject,
      workingProjectId: requestProjectId,
    };
  };

  const getGlobalInstructions = (): string | undefined =>
    buildEffectiveAgentContext({
      globalInstructions:
        deps.serverSettingsService?.getSetting("globalInstructions"),
      hints: deps.serverSettingsService?.getSetting("agentContextHints"),
    });

  const resolveLaunchWorkstreamTarget = (
    project: Project,
    rawWorkstreamId: string | undefined,
  ):
    | { projectPath: string; workstreamId?: WorkstreamId }
    | { error: string; status: 400 | 404 | 409 | 503 } => {
    if (rawWorkstreamId === undefined) {
      return { projectPath: project.path };
    }
    if (!isWorkstreamId(rawWorkstreamId)) {
      return { error: "Invalid workstream ID format", status: 400 };
    }
    if (deps.serverSettingsService?.getSetting("workstreamsEnabled") !== true) {
      return { error: "Workstreams are disabled", status: 404 };
    }
    if (!deps.workstreamService) {
      return { error: "Workstreams unavailable", status: 503 };
    }

    const workstreamId = rawWorkstreamId;
    if (workstreamId === mainWorkstreamId(project.id)) {
      return { projectPath: project.path };
    }
    if (!deps.sessionMetadataService) {
      return { error: "Session metadata unavailable", status: 503 };
    }

    const workstream = deps.workstreamService.getWorkstream(
      project.id,
      workstreamId,
    );
    if (workstream?.kind !== "checkout") {
      return { error: "Workstream not found", status: 404 };
    }
    if (workstream.status !== "active") {
      return { error: "Workstream is not active", status: 409 };
    }
    return { projectPath: workstream.path, workstreamId };
  };

  const persistLaunchMetadata = async (
    sessionId: string,
    provider: ProviderName | undefined,
    executor: string | undefined,
    initialPrompt?: string,
    requestedModel?: string,
    promptSuggestionMode?: PromptSuggestionMode,
    recapAfterSeconds?: number,
    workstreamId?: WorkstreamId,
  ): Promise<void> => {
    if (!deps.sessionMetadataService) {
      return;
    }
    if (provider) {
      await deps.sessionMetadataService.setProvider(sessionId, provider);
    }
    if (executor) {
      await deps.sessionMetadataService.setExecutor(sessionId, executor);
    }
    if (initialPrompt?.trim()) {
      await deps.sessionMetadataService.setInitialPrompt(
        sessionId,
        initialPrompt,
      );
    }
    // Persist the requested YA model id (the launch alias, incl. "default") so
    // per-model settings still key by it after a server restart, instead of
    // falling back to the reported model. See topics/provider-abstraction.md.
    if (requestedModel) {
      await deps.sessionMetadataService.setRequestedModel(
        sessionId,
        requestedModel,
      );
    }
    // Persist the resolved prompt-suggestion mode so a later resume (which may
    // omit it from the request body) recovers the per-session preference
    // instead of falling back to the provider's native default.
    if (promptSuggestionMode !== undefined) {
      await deps.sessionMetadataService.updateMetadata(sessionId, {
        promptSuggestionMode,
      });
    }
    if (recapAfterSeconds !== undefined) {
      await deps.sessionMetadataService.updateMetadata(sessionId, {
        recapAfterSeconds,
      });
    }
    if (workstreamId !== undefined) {
      await deps.sessionMetadataService.setWorkstream(sessionId, workstreamId);
    }
  };

  const loadProviderSession = async (
    project: Project,
    sessionId: string,
    projectId: UrlProjectId,
    preferredProvider: ProviderName | undefined,
    afterMessageId?: string,
    options?: { includeOrphans?: boolean },
  ): Promise<LoadedSession | null> => {
    for (const source of getSessionSources(
      project,
      providerResolutionDeps(deps),
      preferredProvider,
    )) {
      const loaded = await source.reader.getSession(
        sessionId,
        projectId,
        afterMessageId,
        options,
      );
      if (loaded) {
        return loaded;
      }
    }

    return null;
  };

  const loadRestartSourceSession = async (
    project: Project,
    sessionId: string,
    projectId: UrlProjectId,
    preferredProvider?: ProviderName,
    process?: Process,
  ): Promise<Session | null> => {
    const resolved = await findSessionListSummaryAcrossProviders(
      project,
      sessionId,
      projectId,
      providerResolutionDeps(deps),
      preferredProvider,
    );

    if (resolved) {
      const loaded = await resolved.source.reader.getSession(
        sessionId,
        projectId,
        undefined,
        { includeOrphans: false },
      );
      if (loaded) {
        return normalizeSession(loaded);
      }
    }

    if (process) {
      const messages = sdkMessagesToClientMessages(process.getMessageHistory());
      return {
        id: sessionId,
        projectId,
        title: null,
        fullTitle: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: messages.length,
        ownership: {
          owner: "self",
          processId: process.id,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
          recapAfterSeconds: process.recapAfterSeconds,
        },
        provider: process.provider,
        model: process.resolvedModel ?? process.model,
        messages,
      };
    }

    return null;
  };

  const interruptOldProcessForHandoff = async (
    oldProcess: Process | undefined,
  ): Promise<boolean> => {
    if (!oldProcess) {
      return false;
    }
    try {
      const result = await deps.supervisor.interruptProcess(oldProcess.id);
      return result.success;
    } catch (error) {
      console.warn(
        `[restart] Failed to interrupt old process ${oldProcess.id}:`,
        error,
      );
      return false;
    }
  };

  const abortOldProcessAfterReplacementActivity = (
    oldProcess: Process | undefined,
    replacement: Process,
  ): boolean => {
    if (!oldProcess || oldProcess.id === replacement.id) {
      return false;
    }

    let unsubscribe: (() => void) | null = null;
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      unsubscribe = null;
    };

    unsubscribe = replacement.subscribe((event) => {
      if (
        event.type === "message" &&
        isRestartReplacementActivity(event.message)
      ) {
        cleanup();
        void deps.supervisor.abortProcess(oldProcess.id).catch((error) => {
          console.warn(
            `[restart] Failed to abort old process ${oldProcess.id}:`,
            error,
          );
        });
        return;
      }

      if (
        event.type === "terminated" ||
        event.type === "complete" ||
        event.type === "error"
      ) {
        cleanup();
      }
    });

    return true;
  };

  const ensureDetachedProjectPath = async (
    executor?: string,
  ): Promise<string> => {
    await mkdir(DETACHED_PROJECT_PATH, { recursive: true });
    if (executor) {
      await ensureRemoteDirectory(executor, DETACHED_PROJECT_PATH);
    }
    return DETACHED_PROJECT_PATH;
  };

  // GET /api/projects/:projectId/sessions/:sessionId/agents - Get agent mappings
  // Used to find agent sessions for pending Tasks on page reload
  routes.get("/projects/:projectId/sessions/:sessionId/agents", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const routing = await resolveSessionProjectRouting(
      projectId as UrlProjectId,
      c.req.param("sessionId"),
    );
    if ("redirectProjectId" in routing) {
      return c.redirect(
        buildSessionProjectRedirectPath(
          routing.redirectProjectId,
          c.req.param("sessionId"),
          "",
          c.req.url,
        ),
        307,
      );
    }
    if ("error" in routing) {
      return c.json({ error: routing.error }, routing.status);
    }

    const reader = await resolveSessionReaderForAgentContent({
      deps,
      project: routing.transcriptProject,
      sessionId: c.req.param("sessionId"),
      projectId: routing.transcriptProjectId,
    });
    const mappings = await reader.getAgentMappings(c.req.param("sessionId"));

    return c.json({ mappings });
  });

  // GET /api/projects/:projectId/sessions/:sessionId/agents/:agentId - Get agent session content
  // Used for lazy-loading completed Tasks
  routes.get(
    "/projects/:projectId/sessions/:sessionId/agents/:agentId",
    async (c) => {
      const projectId = c.req.param("projectId");
      const agentId = c.req.param("agentId");

      // Validate projectId format at API boundary
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }

      const routing = await resolveSessionProjectRouting(
        projectId as UrlProjectId,
        c.req.param("sessionId"),
      );
      if ("redirectProjectId" in routing) {
        return c.redirect(
          buildSessionProjectRedirectPath(
            routing.redirectProjectId,
            c.req.param("sessionId"),
            "",
            c.req.url,
          ),
          307,
        );
      }
      if ("error" in routing) {
        return c.json({ error: routing.error }, routing.status);
      }

      const reader = await resolveSessionReaderForAgentContent({
        deps,
        project: routing.transcriptProject,
        sessionId: c.req.param("sessionId"),
        projectId: routing.transcriptProjectId,
      });
      const agentSession = await reader.getAgentSession(
        agentId,
        c.req.param("sessionId"),
      );

      if (!agentSession) {
        return c.json({ error: "Agent session not found" }, 404);
      }

      // Add server-rendered HTML to text blocks for markdown display
      await augmentTextBlocks(agentSession.messages, {
        projectFileLinks: {
          projectId: routing.workingProjectId,
          projectPath: routing.workingProject.path,
        },
      });

      return c.json(agentSession);
    },
  );

  // GET /api/projects/:projectId/sessions/:sessionId/metadata - Get session metadata only (no messages)
  // Lightweight endpoint for refreshing title, status, etc. without re-fetching all messages
  routes.get("/projects/:projectId/sessions/:sessionId/metadata", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const routing = await resolveSessionProjectRouting(
      projectId as UrlProjectId,
      sessionId,
    );
    if ("redirectProjectId" in routing) {
      return c.redirect(
        buildSessionProjectRedirectPath(
          routing.redirectProjectId,
          sessionId,
          "/metadata",
          c.req.url,
        ),
        307,
      );
    }
    if ("error" in routing) {
      return c.json({ error: routing.error }, routing.status);
    }
    const project = routing.workingProject;
    const transcriptProject = routing.transcriptProject;
    const transcriptProjectId = routing.transcriptProjectId;

    // Check if session is actively owned by a process
    const process = deps.supervisor.getProcessForSession(sessionId);

    // Check if session is being controlled by an external program
    const isExternal = deps.externalTracker?.isExternal(sessionId) ?? false;

    // Determine the session ownership
    const ownership: SessionOwnership = process
      ? {
          owner: "self" as const,
          processId: process.id,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
          recapAfterSeconds: process.recapAfterSeconds,
        }
      : isExternal
        ? { owner: "external" as const }
        : { owner: "none" as const };

    // Get session metadata (custom title, archived, starred)
    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
    // Get notification data (lastSeenAt, hasUnread)
    const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
    const lastSeenAt = lastSeenEntry?.timestamp;

    // Get pending input request from active process
    const pendingInputRequest =
      process?.state.type === "waiting-input" ? process.state.request : null;
    const providerRuntimeStatus =
      deps.supervisor.getProviderRuntimeStatusForSession?.(sessionId) ??
      process?.getProviderRuntimeStatus() ??
      null;

    // Read minimal session info from disk (just for title/timestamps, no messages)
    const metadataProvider =
      (metadata?.provider as ProviderName | undefined) ??
      (deps.sessionMetadataService?.getProvider(sessionId) as
        | ProviderName
        | undefined);
    const slashCommands = await getSessionSlashCommands(
      process,
      process?.provider ?? metadataProvider ?? project.provider,
    );
    const deferredMessages = sessionQueueSummaries(deps, sessionId, process);
    const sessionSummaryResult = await findSessionSummaryAcrossProviders(
      transcriptProject,
      sessionId,
      transcriptProjectId,
      providerResolutionDeps(deps),
      metadataProvider ?? process?.provider,
    );
    const rawSessionSummary = sessionSummaryResult?.summary ?? null;
    const recapMessages =
      deps.sessionMetadataService?.getRecapMessages?.(sessionId) ?? [];
    const sessionSummary = rawSessionSummary
      ? applyRecapOverlayToSummary(rawSessionSummary, recapMessages)
      : null;

    if (!sessionSummary && !process) {
      const canonicalProjectId = await getGrokNativeProjectId(
        sessionId,
        projectId as UrlProjectId,
      );
      if (canonicalProjectId) {
        return c.redirect(
          buildGrokNativeRedirectPath(
            canonicalProjectId,
            sessionId,
            "/metadata",
            c.req.url,
          ),
          307,
        );
      }
      return c.json({ error: "Session not found" }, 404);
    }

    const hasUnread = rawSessionSummary
      ? hasUnreadProviderContent(
          deps.notificationService,
          sessionId,
          rawSessionSummary.updatedAt,
        )
      : undefined;

    const response = {
      session: {
        id: sessionId,
        projectId: routing.workingProjectId,
        title: sessionSummary?.title ?? null,
        fullTitle: sessionSummary?.fullTitle ?? null,
        createdAt: sessionSummary?.createdAt ?? new Date().toISOString(),
        updatedAt: sessionSummary?.updatedAt ?? new Date().toISOString(),
        messageCount: sessionSummary?.messageCount ?? 0,
        provider:
          metadataProvider ??
          process?.provider ??
          sessionSummary?.provider ??
          project.provider,
        model: sessionSummary?.model,
        originator: sessionSummary?.originator,
        cliVersion: sessionSummary?.cliVersion,
        source: sessionSummary?.source,
        approvalPolicy: sessionSummary?.approvalPolicy,
        sandboxPolicy: sessionSummary?.sandboxPolicy,
        contextUsage: sessionSummary?.contextUsage,
        customTitle: metadata?.customTitle,
        isArchived: metadata?.isArchived,
        isStarred: metadata?.isStarred,
        parentSessionId:
          metadata?.parentSessionId ?? sessionSummary?.parentSessionId,
        initialPrompt:
          metadata?.initialPrompt ?? sessionSummary?.fullTitle ?? undefined,
        heartbeatTurnsEnabled: metadata?.heartbeatTurnsEnabled,
        heartbeatTurnsAfterMinutes: metadata?.heartbeatTurnsAfterMinutes,
        heartbeatTurnText: metadata?.heartbeatTurnText,
        heartbeatForceAfterMinutes:
          metadata?.heartbeatForceAfterMinutes ?? undefined,
        promptSuggestionMode: metadata?.promptSuggestionMode,
        recapAfterSeconds: metadata?.recapAfterSeconds,
        workingProjectId: metadata?.workingProjectId,
        transcriptProjectId: metadata?.transcriptProjectId,
        workstreamId: metadata?.workstreamId,
        transcriptDisplayObjects: metadata?.transcriptDisplayObjects,
        lastSeenAt,
        hasUnread,
      },
      ownership,
      processState: process?.state.type ?? null,
      providerRuntimeStatus,
      pendingInputRequest,
      slashCommands,
      ...(deferredMessages.length > 0 ? { deferredMessages } : {}),
    } satisfies SessionMetadataResponse;

    return c.json(response);
  });

  // PUT /api/projects/:projectId/sessions/:sessionId/project
  // Reclassify a session under a different YA project without sending any
  // provider-visible turn. The provider transcript remains under
  // transcriptProjectId; relative file links and UI routing use projectId.
  routes.put("/projects/:projectId/sessions/:sessionId/project", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    if (!deps.sessionMetadataService) {
      return c.json({ error: "Session metadata service unavailable" }, 503);
    }

    let body: { projectId?: unknown };
    try {
      body = await c.req.json<{ projectId?: unknown }>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const targetProjectId = body.projectId;
    if (
      typeof targetProjectId !== "string" ||
      !isUrlProjectId(targetProjectId)
    ) {
      return c.json({ error: "Invalid target project ID format" }, 400);
    }

    const targetProject =
      await deps.scanner.getOrCreateProject(targetProjectId);
    if (!targetProject) {
      return c.json({ error: "Target project not found" }, 404);
    }

    const metadata = deps.sessionMetadataService.getMetadata(sessionId);
    const process = deps.supervisor.getProcessForSession(sessionId);
    const transcriptProjectId =
      metadata?.transcriptProjectId ??
      process?.projectId ??
      (projectId as UrlProjectId);
    const transcriptProject =
      transcriptProjectId === targetProjectId
        ? targetProject
        : await deps.scanner.getOrCreateProject(transcriptProjectId);
    if (!transcriptProject) {
      return c.json({ error: "Transcript project not found" }, 404);
    }

    if (!process) {
      const metadataProvider =
        (metadata?.provider as ProviderName | undefined) ??
        (deps.sessionMetadataService.getProvider(sessionId) as
          | ProviderName
          | undefined);
      const summary = await findSessionListSummaryAcrossProviders(
        transcriptProject,
        sessionId,
        transcriptProjectId,
        providerResolutionDeps(deps),
        metadataProvider,
      );
      if (!summary) {
        return c.json({ error: "Session not found" }, 404);
      }
    }

    const storedWorkingProjectId =
      targetProjectId === transcriptProjectId ? undefined : targetProjectId;
    const storedTranscriptProjectId =
      targetProjectId === transcriptProjectId ? undefined : transcriptProjectId;

    await deps.sessionMetadataService.setWorkingProject(
      sessionId,
      storedWorkingProjectId,
      storedTranscriptProjectId,
    );

    deps.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId,
      projectId: targetProjectId,
      transcriptProjectId: storedTranscriptProjectId ?? null,
      timestamp: new Date().toISOString(),
    });

    return c.json({
      updated: true,
      projectId: targetProjectId,
      transcriptProjectId: storedTranscriptProjectId ?? null,
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/refresh-preview
  // On-demand recompute of the hover-card recent-activity excerpt for a
  // non-running session (its live state is otherwise only refreshed when the
  // session is resumed). Fast reverse-scan of the JSONL, then push the result
  // to lists/hovers via a session-updated event so the preview updates in
  // place without flicker. See topics/session-hovercard-recent-activity.md.
  routes.post(
    "/projects/:projectId/sessions/:sessionId/refresh-preview",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }
      const routing = await resolveSessionProjectRouting(
        projectId as UrlProjectId,
        sessionId,
      );
      if ("redirectProjectId" in routing) {
        return c.redirect(
          buildSessionProjectRedirectPath(
            routing.redirectProjectId,
            sessionId,
            "/refresh-preview",
            c.req.url,
          ),
          307,
        );
      }
      if ("error" in routing) {
        return c.json({ error: routing.error }, routing.status);
      }
      const transcriptProject = routing.transcriptProject;
      const transcriptProjectId = routing.transcriptProjectId;
      const metadataProvider = deps.sessionMetadataService?.getProvider(
        sessionId,
      ) as ProviderName | undefined;
      const recapMessages =
        deps.sessionMetadataService?.getRecapMessages?.(sessionId) ?? [];
      let lastAgentText: string | undefined;
      if (recapMessages.length > 0) {
        const summaryResult = await findSessionSummaryAcrossProviders(
          transcriptProject,
          sessionId,
          transcriptProjectId,
          providerResolutionDeps(deps),
          metadataProvider,
        );
        if (summaryResult?.summary) {
          lastAgentText = applyRecapOverlayToSummary(
            summaryResult.summary,
            recapMessages,
          ).lastAgentText;
        }
      }

      // Claude uses the fast reverse-scan when there is no durable overlay to
      // compare; every other provider goes through the cross-provider load +
      // normalize, then a shared extractor on the uniform message form.
      const reader = deps.readerFactory(transcriptProject);
      lastAgentText ??= reader.getLastAgentExcerpt
        ? await reader.getLastAgentExcerpt(sessionId)
        : undefined;
      if (lastAgentText === undefined) {
        const normalized = await loadRestartSourceSession(
          transcriptProject,
          sessionId,
          transcriptProjectId,
          metadataProvider,
        );
        if (normalized) {
          lastAgentText = extractLastAgentExcerpt(normalized.messages);
        }
      }
      if (lastAgentText !== undefined) {
        deps.eventBus?.emit({
          type: "session-updated",
          sessionId,
          projectId: routing.workingProjectId,
          lastAgentText,
          timestamp: new Date().toISOString(),
        });
      }
      return c.json({ lastAgentText: lastAgentText ?? null });
    },
  );

  // GET /api/projects/:projectId/sessions/:sessionId - Get session detail
  // Optional query params:
  //   ?afterMessageId=<id> - incremental forward-fetch (append new messages)
  //   ?tailCompactions=<n> - return only last N compact boundaries worth of messages
  //   ?beforeMessageId=<id> - cursor for loading older chunks (used with tailCompactions)
  //   ?tailTurns=<n> - recent-turn selector within the authorized history scope
  //   ?tailFrom=<id> - start selector within the authorized history scope
  //   ?fullHistory=1 - explicitly authorize selectors to inspect full history
  routes.get("/projects/:projectId/sessions/:sessionId", async (c) => {
    const requestStartMs = performance.now();
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");
    const afterMessageId = c.req.query("afterMessageId");
    const publicShare = c.req.query("publicShare") === "1";
    const fullHistory = c.req.query("fullHistory") === "1";
    const fullHistoryReason = c.req.query("fullHistoryReason");
    const tailCompactionsParam = c.req.query("tailCompactions");
    const beforeMessageId = c.req.query("beforeMessageId");
    const tailTurnsParam = c.req.query("tailTurns");
    const tailFrom = c.req.query("tailFrom");
    const tailCompactions =
      tailCompactionsParam !== undefined
        ? Number.parseInt(tailCompactionsParam, 10)
        : undefined;
    const tailTurns =
      tailTurnsParam !== undefined
        ? Number.parseInt(tailTurnsParam, 10)
        : undefined;
    const requestedTailCompactions =
      tailCompactions !== undefined &&
      !Number.isNaN(tailCompactions) &&
      tailCompactions > 0
        ? tailCompactions
        : undefined;
    const requestedTailTurns =
      tailTurns !== undefined && !Number.isNaN(tailTurns) && tailTurns > 0
        ? tailTurns
        : undefined;
    const defaultedToCompactTail =
      !fullHistory && !afterMessageId && requestedTailCompactions === undefined;
    const unboundedRequestDefaultedToCompactTail =
      defaultedToCompactTail && !tailFrom && requestedTailTurns === undefined;
    const effectiveTailCompactions =
      requestedTailCompactions ??
      (defaultedToCompactTail
        ? DEFAULT_SESSION_DETAIL_TAIL_COMPACTIONS
        : undefined);

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const routing = await resolveSessionProjectRouting(
      projectId as UrlProjectId,
      sessionId,
    );
    if ("redirectProjectId" in routing) {
      return c.redirect(
        buildSessionProjectRedirectPath(
          routing.redirectProjectId,
          sessionId,
          "",
          c.req.url,
        ),
        307,
      );
    }
    if ("error" in routing) {
      return c.json({ error: routing.error }, routing.status);
    }
    const project = routing.workingProject;
    const effectiveProjectId = routing.workingProjectId;
    const transcriptProject = routing.transcriptProject;
    const transcriptProjectId = routing.transcriptProjectId;
    const projectResolvedMs = performance.now();

    // Check if session is actively owned by a process
    const process = deps.supervisor.getProcessForSession(sessionId);

    // Check if session is being controlled by an external program
    const isExternal = deps.externalTracker?.isExternal(sessionId) ?? false;

    // Check if we've ever owned this session (for orphan detection)
    // Only mark tools as "aborted" if we owned the session and know it terminated
    const wasEverOwned = deps.supervisor.wasEverOwned(sessionId);
    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const recapMessages =
      deps.sessionMetadataService?.getRecapMessages?.(sessionId) ?? [];
    const recapCursor = findDurableRecapCursor(afterMessageId, recapMessages);
    const providerAfterMessageId = recapCursor ? undefined : afterMessageId;
    const primaryReaderAfterMessageId =
      isClaudeSdkProviderName(project.provider) ||
      isClaudeSdkProviderName(metadataProvider)
        ? undefined
        : providerAfterMessageId;

    const loadedSession = await loadProviderSession(
      transcriptProject,
      sessionId,
      transcriptProjectId,
      metadataProvider ?? process?.provider,
      primaryReaderAfterMessageId,
      {
        // Only include orphaned tool info if:
        // 1. We previously owned this session (not external)
        // 2. No active process (tools aren't potentially in progress)
        // When we own the session, tools without results might be pending approval
        includeOrphans: wasEverOwned && !process,
      },
    );

    const readEndMs = performance.now();

    let session = loadedSession ? normalizeSession(loadedSession) : null;
    const explicitProvider = metadataProvider ?? process?.provider;
    if (session && explicitProvider) {
      session = { ...session, provider: explicitProvider };
    }
    const normalizedMessageCount = session?.messages.length ?? 0;
    const normalizeEndMs = performance.now();
    if (session && isClaudeSdkProviderName(session.provider)) {
      augmentTaskListSnapshots(session.messages);
    }
    let incrementalAnchorFound = false;
    if (session && providerAfterMessageId) {
      const sliced = sliceAfterMessageIdWithMatch(
        session.messages,
        providerAfterMessageId,
      );
      session = {
        ...session,
        messages: sliced.messages,
      };
      incrementalAnchorFound = sliced.found;
    }

    // Determine the session ownership
    const ownership = process
      ? {
          owner: "self" as const,
          processId: process.id,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
          recapAfterSeconds: process.recapAfterSeconds,
        }
      : isExternal
        ? { owner: "external" as const }
        : (session?.ownership ?? { owner: "none" as const });

    // Get pending input request from active process (for tool approval prompts)
    // This ensures clients get pending requests immediately without waiting for SSE
    const pendingInputRequest =
      process?.state.type === "waiting-input" ? process.state.request : null;
    const providerRuntimeStatus =
      deps.supervisor.getProviderRuntimeStatusForSession?.(sessionId) ??
      process?.getProviderRuntimeStatus() ??
      null;

    // Get available slash commands (for "/" button and typed slash menu)
    // The init message that normally carries these gets discarded from the SSE buffer
    // after ~30s, so we attach them to the REST response. Providers with known
    // native built-ins, such as Codex, can expose those while stopped.
    const slashCommands = await getSessionSlashCommands(
      process,
      process?.provider ??
        session?.provider ??
        metadataProvider ??
        project.provider,
    );
    const deferredMessages = sessionQueueSummaries(deps, sessionId, process);

    if (!session) {
      // Session file doesn't exist yet - only valid if we own the process
      if (process) {
        // Get raw messages from process memory
        const sdkMessages = process.getMessageHistory();
        // Convert to client format
        const processMessages = sdkMessagesToClientMessages(sdkMessages);
        // Extract context usage from raw SDK messages (has usage field)
        // Use process.contextWindow (captured from result messages) as primary source
        const mis = deps.modelInfoService;
        const sdkContextWindow = process.contextWindow;
        const contextUsage = extractContextUsageFromSDKMessages(
          sdkMessages,
          process.resolvedModel,
          process.provider,
          sdkContextWindow
            ? () => sdkContextWindow
            : mis
              ? (m, p) => mis.getContextWindow(m, p)
              : undefined,
        );
        // (Durable recording happens at the observation point in Process via
        // onContextWindowObserved, not as a side effect of this GET.)
        // Get metadata even for new sessions (in case it was set before file was written)
        const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
        const recapMessages =
          deps.sessionMetadataService?.getRecapMessages?.(sessionId) ?? [];
        const visibleProcessMessages = mergeRecapMessages(
          processMessages,
          recapMessages,
        );
        // Get notification data for new sessions too
        const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
        const latestRecap = latestRecapMessage(recapMessages);
        const newSessionUpdatedAt =
          latestRecap?.timestamp ?? new Date().toISOString();
        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(sessionId, newSessionUpdatedAt)
          : undefined;
        return c.json({
          session: {
            id: sessionId,
            projectId: effectiveProjectId,
            title: null,
            createdAt: new Date().toISOString(),
            updatedAt: newSessionUpdatedAt,
            messageCount: processMessages.length,
            ownership,
            customTitle: metadata?.customTitle,
            isArchived: metadata?.isArchived,
            isStarred: metadata?.isStarred,
            parentSessionId: metadata?.parentSessionId,
            initialPrompt: metadata?.initialPrompt,
            heartbeatTurnsEnabled: metadata?.heartbeatTurnsEnabled,
            heartbeatTurnsAfterMinutes: metadata?.heartbeatTurnsAfterMinutes,
            heartbeatTurnText: metadata?.heartbeatTurnText,
            heartbeatForceAfterMinutes: metadata?.heartbeatForceAfterMinutes,
            promptSuggestionMode: metadata?.promptSuggestionMode,
            recapAfterSeconds: metadata?.recapAfterSeconds,
            workingProjectId: metadata?.workingProjectId,
            transcriptProjectId: metadata?.transcriptProjectId,
            workstreamId: metadata?.workstreamId,
            transcriptDisplayObjects: metadata?.transcriptDisplayObjects,
            lastSeenAt: lastSeenEntry?.timestamp,
            hasUnread,
            provider: process.provider,
            model: process.resolvedModel,
            contextUsage,
          },
          messages: visibleProcessMessages,
          ownership,
          providerRuntimeStatus,
          pendingInputRequest,
          slashCommands,
          ...(deferredMessages.length > 0 ? { deferredMessages } : {}),
        });
      }
      const canonicalProjectId = await getGrokNativeProjectId(
        sessionId,
        projectId as UrlProjectId,
      );
      if (canonicalProjectId) {
        return c.redirect(
          buildGrokNativeRedirectPath(
            canonicalProjectId,
            sessionId,
            "",
            c.req.url,
          ),
          307,
        );
      }
      return c.json({ error: "Session not found" }, 404);
    }

    // Get session metadata (custom title, archived, starred)
    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);

    // Get notification data (lastSeenAt, hasUnread)
    const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
    const lastSeenAt = lastSeenEntry?.timestamp;

    // Apply pagination BEFORE expensive augmentation. Compact boundaries set
    // the authorized history scope by default; turn selectors may narrow that
    // scope but cannot broaden it unless fullHistory=1 removed the default.
    // Skip initial-window slicing for incremental forward fetches.
    let paginationInfo: PaginationInfo | undefined;
    if (
      !afterMessageId &&
      effectiveTailCompactions !== undefined &&
      !beforeMessageId &&
      (tailFrom || requestedTailTurns !== undefined)
    ) {
      const sliced = sliceAtCompactAndUserTurnBoundaries(
        session.messages,
        effectiveTailCompactions,
        requestedTailTurns ?? 20,
        tailFrom,
      );
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    } else if (
      !afterMessageId &&
      effectiveTailCompactions === undefined &&
      (tailFrom || requestedTailTurns !== undefined)
    ) {
      const sliced = sliceAtUserTurnBoundary(
        session.messages,
        requestedTailTurns ?? 20,
        tailFrom,
      );
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    } else if (effectiveTailCompactions !== undefined && !afterMessageId) {
      const sliced = sliceAtCompactBoundaries(
        session.messages,
        effectiveTailCompactions,
        beforeMessageId,
      );
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    }
    if (isClaudeSdkProviderName(session.provider)) {
      pruneTaskListSnapshotsToLatest(session.messages);
    }
    const sliceEndMs = performance.now();

    // Codex normalized IDs can drift between stream and JSONL. If an
    // incremental request misses its anchor, never return the full historical
    // session into a compact-tail client; bound the fallback to the same tail
    // window used for initial loads.
    if (providerAfterMessageId && !incrementalAnchorFound) {
      const sliced = sliceAtCompactBoundaries(session.messages, 2);
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    }

    if (!publicShare && deps.toolResultMediaStore) {
      session = {
        ...session,
        messages: await deps.toolResultMediaStore
          .createMaterializer({
            provider: session.provider,
            projectId: effectiveProjectId,
            projectPath: project.path,
            getSessionId: () => sessionId,
          })
          .materializeMessages(session.messages),
      };
    }

    // Keep persisted rendering in lockstep with stream augmentation behavior.
    if (publicShare) {
      await augmentEditToolUses(session.messages);
    } else {
      await augmentPersistedSessionMessages(session.messages, {
        projectFileLinks: {
          projectId: effectiveProjectId,
          projectPath: project.path,
        },
      });
    }
    // The overlay reassigns `session` below; hasUnreadProviderContent needs
    // the pre-overlay timestamp.
    const preRecapUpdatedAt = session.updatedAt;
    if (!beforeMessageId) {
      session = applyRecapOverlayToSession(session, recapMessages);
      if (recapCursor && afterMessageId) {
        const sliced = sliceAfterDurableRecapCursor({
          messages: session.messages,
          recap: recapCursor,
          cursorId: afterMessageId,
        });
        session = { ...session, messages: sliced.messages };
        incrementalAnchorFound = sliced.found;
      }
    } else {
      session = applyRecapOverlayToSummary(session, recapMessages);
    }
    const augmentEndMs = performance.now();

    const hasUnread = hasUnreadProviderContent(
      deps.notificationService,
      sessionId,
      preRecapUpdatedAt,
    );

    // Override context usage with SDK-reported context window from live process
    // The reader uses hardcoded defaults; the process captures the real value at runtime
    let { contextUsage } = session;
    if (process?.contextWindow && contextUsage) {
      const cw = process.contextWindow;
      contextUsage = {
        ...contextUsage,
        percentage: Math.round((contextUsage.inputTokens / cw) * 100),
        contextWindow: cw,
      };
      // Durable recording happens at the observation point in Process via
      // onContextWindowObserved; this block only overrides the displayed value.
    }

    const { messages: _messages, ...sessionMetadata } = session;
    const totalMs = performance.now() - requestStartMs;
    if (
      unboundedRequestDefaultedToCompactTail &&
      normalizedMessageCount >= LARGE_FULL_HISTORY_MESSAGE_THRESHOLD
    ) {
      getLogger().warn(
        {
          beforeMessageId: beforeMessageId ?? null,
          defaultTailCompactions: DEFAULT_SESSION_DETAIL_TAIL_COMPACTIONS,
          event: "session_detail_unbounded_defaulted_to_tail",
          normalizedMessageCount,
          projectId: effectiveProjectId,
          transcriptProjectId,
          provider: session.provider,
          publicShare,
          returnedMessageCount: session.messages.length,
          sessionId,
          timings: {
            augmentMs: roundedMs(augmentEndMs - sliceEndMs),
            normalizeMs: roundedMs(normalizeEndMs - readEndMs),
            projectMs: roundedMs(projectResolvedMs - requestStartMs),
            readMs: roundedMs(readEndMs - projectResolvedMs),
            routeMs: roundedMs(sliceEndMs - normalizeEndMs),
            totalMs: roundedMs(totalMs),
          },
          totalMessageCount: session.messageCount,
        },
        "SESSION_DETAIL: defaulted unbounded request to compact tail",
      );
    }
    if (
      fullHistory &&
      session.messages.length >= LARGE_FULL_HISTORY_MESSAGE_THRESHOLD
    ) {
      getLogger().warn(
        {
          event: "session_detail_full_history_large",
          fullHistoryReason: fullHistoryReason ?? null,
          normalizedMessageCount,
          projectId: effectiveProjectId,
          transcriptProjectId,
          provider: session.provider,
          publicShare,
          returnedMessageCount: session.messages.length,
          sessionId,
          timings: {
            augmentMs: roundedMs(augmentEndMs - sliceEndMs),
            normalizeMs: roundedMs(normalizeEndMs - readEndMs),
            projectMs: roundedMs(projectResolvedMs - requestStartMs),
            readMs: roundedMs(readEndMs - projectResolvedMs),
            routeMs: roundedMs(sliceEndMs - normalizeEndMs),
            totalMs: roundedMs(totalMs),
          },
          totalMessageCount: session.messageCount,
        },
        "SESSION_DETAIL: large explicit full-history request",
      );
    }
    if (totalMs >= SESSION_DETAIL_SLOW_LOG_MS) {
      getLogger().warn(
        {
          afterMessageId: afterMessageId ?? null,
          beforeMessageId: beforeMessageId ?? null,
          event: "session_detail_slow",
          defaultedToCompactTail,
          fullHistory,
          fullHistoryReason: fullHistoryReason ?? null,
          incrementalAnchorFound: afterMessageId
            ? incrementalAnchorFound
            : null,
          normalizedMessageCount,
          owned: Boolean(process),
          processState: process?.state.type ?? null,
          projectId: effectiveProjectId,
          transcriptProjectId,
          provider: session.provider,
          publicShare,
          returnedMessageCount: session.messages.length,
          sessionId,
          tailCompactions: effectiveTailCompactions ?? null,
          tailTurns: requestedTailTurns ?? null,
          timings: {
            augmentMs: roundedMs(augmentEndMs - sliceEndMs),
            normalizeMs: roundedMs(normalizeEndMs - readEndMs),
            projectMs: roundedMs(projectResolvedMs - requestStartMs),
            readMs: roundedMs(readEndMs - projectResolvedMs),
            routeMs: roundedMs(sliceEndMs - normalizeEndMs),
            totalMs: roundedMs(totalMs),
          },
          totalMessageCount: session.messageCount,
        },
        "SESSION_DETAIL: slow request",
      );
    }

    return c.json({
      session: {
        ...sessionMetadata,
        projectId: effectiveProjectId,
        ownership,
        contextUsage,
        customTitle: metadata?.customTitle,
        isArchived: metadata?.isArchived,
        isStarred: metadata?.isStarred,
        parentSessionId: metadata?.parentSessionId ?? session.parentSessionId,
        initialPrompt: metadata?.initialPrompt ?? session.fullTitle,
        heartbeatTurnsEnabled: metadata?.heartbeatTurnsEnabled,
        heartbeatTurnsAfterMinutes: metadata?.heartbeatTurnsAfterMinutes,
        heartbeatTurnText: metadata?.heartbeatTurnText,
        heartbeatForceAfterMinutes: metadata?.heartbeatForceAfterMinutes,
        promptSuggestionMode: metadata?.promptSuggestionMode,
        recapAfterSeconds: metadata?.recapAfterSeconds,
        workingProjectId: metadata?.workingProjectId,
        transcriptProjectId: metadata?.transcriptProjectId,
        workstreamId: metadata?.workstreamId,
        transcriptDisplayObjects: metadata?.transcriptDisplayObjects,
        // Model comes from the session reader (extracted from JSONL)
        model: session.model,
        lastSeenAt,
        hasUnread,
      },
      messages: session.messages,
      ownership,
      providerRuntimeStatus,
      pendingInputRequest,
      slashCommands,
      ...(paginationInfo && { pagination: paginationInfo }),
      ...(deferredMessages.length > 0 ? { deferredMessages } : {}),
    });
  });

  // POST /api/projects/:projectId/sessions - Start new session
  routes.post("/projects/:projectId/sessions", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to allow starting sessions in new directories
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }
    const workstreamTarget = resolveLaunchWorkstreamTarget(
      project,
      body.workstreamId,
    );
    if ("error" in workstreamTarget) {
      return c.json({ error: workstreamTarget.error }, workstreamTarget.status);
    }

    const serverTimestamp = Date.now();
    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
      metadata: buildUserMessageMetadata(body, serverTimestamp, "direct"),
    };

    const { thinking, effort } = buildThinkingOptions(body);

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    // Debug: log what we received
    console.log("[startSession] Request body:", {
      provider: body.provider,
      executor,
      model: body.model,
      serviceTier,
    });

    const result = await deps.supervisor.startSession(
      workstreamTarget.projectPath,
      userMessage,
      body.mode,
      {
        model,
        serviceTier,
        thinking,
        effort,
        providerName: body.provider,
        executor,
        globalInstructions: getGlobalInstructions(),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        recapAfterSeconds: helperSettings.recapAfterSeconds,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
      },
      {
        projectId: project.id,
        workstreamId: workstreamTarget.workstreamId,
      },
    );

    // Check if queue is full
    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json({ ...result, serverTimestamp }, 202); // 202 Accepted - queued for processing
    }

    await persistLaunchMetadata(
      result.sessionId,
      body.provider,
      executor,
      body.message,
      body.model,
      result.promptSuggestionMode,
      helperSettings.recapAfterSeconds,
      workstreamTarget.workstreamId,
    );

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      projectId: result.projectId,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
      recapAfterSeconds: result.recapAfterSeconds,
      serverTimestamp,
    });
  });

  // POST /api/projects/:projectId/sessions/create - Create session without starting agent
  // Used for two-phase flow: create session first, upload files, then send first message
  routes.post("/projects/:projectId/sessions/create", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to allow starting sessions in new directories
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: CreateSessionBody = {};
    try {
      body = await c.req.json<CreateSessionBody>();
    } catch {
      // Body is optional for this endpoint
    }

    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }
    const workstreamTarget = resolveLaunchWorkstreamTarget(
      project,
      body.workstreamId,
    );
    if ("error" in workstreamTarget) {
      return c.json({ error: workstreamTarget.error }, workstreamTarget.status);
    }

    const { thinking, effort } = buildThinkingOptions(body);

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    const result = await deps.supervisor.createSession(
      workstreamTarget.projectPath,
      body.mode,
      {
        model,
        serviceTier,
        thinking,
        effort,
        providerName: body.provider,
        executor,
        globalInstructions: getGlobalInstructions(),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        recapAfterSeconds: helperSettings.recapAfterSeconds,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
      },
      {
        projectId: project.id,
        workstreamId: workstreamTarget.workstreamId,
      },
    );

    // Check if queue is full
    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json({ ...result, serverTimestamp: Date.now() }, 202); // 202 Accepted - queued for processing
    }

    await persistLaunchMetadata(
      result.sessionId,
      body.provider,
      executor,
      undefined,
      body.model,
      result.promptSuggestionMode,
      helperSettings.recapAfterSeconds,
      workstreamTarget.workstreamId,
    );

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      projectId: result.projectId,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
      recapAfterSeconds: result.recapAfterSeconds,
      serverTimestamp: Date.now(),
    });
  });

  // POST /api/sessions - Start a detached new session under the hidden No Project workspace
  routes.post("/sessions", async (c) => {
    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }

    const projectPath = await ensureDetachedProjectPath(executor);
    const serverTimestamp = Date.now();
    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
      metadata: buildUserMessageMetadata(body, serverTimestamp, "direct"),
    };

    const { thinking, effort } = buildThinkingOptions(body);
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    const result = await deps.supervisor.startSession(
      projectPath,
      userMessage,
      body.mode,
      {
        model,
        serviceTier,
        thinking,
        effort,
        providerName: body.provider,
        executor,
        globalInstructions: getGlobalInstructions(),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        recapAfterSeconds: helperSettings.recapAfterSeconds,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
      },
    );

    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    if (isQueuedResponse(result)) {
      return c.json({ ...result, serverTimestamp: Date.now() }, 202);
    }

    await persistLaunchMetadata(
      result.sessionId,
      body.provider,
      executor,
      body.message,
      body.model,
      result.promptSuggestionMode,
      helperSettings.recapAfterSeconds,
    );

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      projectId: result.projectId,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
      recapAfterSeconds: result.recapAfterSeconds,
      serverTimestamp,
    });
  });

  // POST /api/sessions/create - Create a detached session without sending an initial message
  routes.post("/sessions/create", async (c) => {
    let body: CreateSessionBody = {};
    try {
      body = await c.req.json<CreateSessionBody>();
    } catch {
      // Body is optional for this endpoint
    }

    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }

    const projectPath = await ensureDetachedProjectPath(executor);
    const { thinking, effort } = buildThinkingOptions(body);
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    const result = await deps.supervisor.createSession(projectPath, body.mode, {
      model,
      serviceTier,
      thinking,
      effort,
      providerName: body.provider,
      executor,
      globalInstructions: getGlobalInstructions(),
      permissions: body.permissions,
      recapMode: helperSettings.recapMode,
      recapAfterSeconds: helperSettings.recapAfterSeconds,
      promptSuggestionMode: helperSettings.promptSuggestionMode,
      helperSideModel: helperSettings.helperSideModel,
    });

    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    if (isQueuedResponse(result)) {
      return c.json({ ...result, serverTimestamp: Date.now() }, 202);
    }

    await persistLaunchMetadata(
      result.sessionId,
      body.provider,
      executor,
      undefined,
      body.model,
      result.promptSuggestionMode,
      helperSettings.recapAfterSeconds,
    );

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      projectId: result.projectId,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
      recapAfterSeconds: result.recapAfterSeconds,
      serverTimestamp: Date.now(),
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/resume - Resume session
  routes.post("/projects/:projectId/sessions/:sessionId/resume", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to allow resuming in directories that may have been moved
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }
    const parsedBodyExecutor = parseOptionalExecutor(body.executor);
    if (parsedBodyExecutor.error) {
      return c.json({ error: parsedBodyExecutor.error }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }
    const parsedResumeMode = parseOptionalResumeMode(body.resumeMode);
    if (parsedResumeMode.error) {
      return c.json({ error: parsedResumeMode.error }, 400);
    }
    const resumeMode = parsedResumeMode.resumeMode ?? "full";

    const serverTimestamp = Date.now();
    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
      metadata: buildUserMessageMetadata(body, serverTimestamp, "direct"),
    };

    const { thinking, effort } = buildThinkingOptions(body);

    // Convert model option (undefined or "default" means use CLI default). When
    // the client sends no model (e.g. resume after a server restart), recover the
    // YA model id persisted at launch so the process keeps its requested alias
    // and per-model settings stay keyed by it. See topics/provider-abstraction.md.
    const requestedModel =
      body.model ?? deps.sessionMetadataService?.getRequestedModel(sessionId);
    const model =
      requestedModel && requestedModel !== "default"
        ? requestedModel
        : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    // Use client-provided executor, falling back to saved executor from metadata.
    let executor = parsedBodyExecutor.executor;
    if (!executor) {
      const parsedSavedExecutor = parseOptionalExecutor(
        deps.sessionMetadataService?.getExecutor(sessionId),
      );
      if (parsedSavedExecutor.error) {
        return c.json({ error: parsedSavedExecutor.error }, 400);
      }
      executor = parsedSavedExecutor.executor;
    }

    // For remote sessions, sync local files TO remote before resuming
    // This ensures the remote has the latest session state
    if (executor) {
      const projectDir = getProjectDirFromCwd(project.path);
      const syncResult = await syncSessions({
        host: executor,
        projectDir,
        direction: "to-remote",
      });
      if (!syncResult.success) {
        console.warn(
          `[resume] Failed to pre-sync session to ${executor}: ${syncResult.error}`,
        );
        // Continue anyway - remote may have the files from before
      }

      // Save executor to metadata if not already saved (e.g. client provided it)
      if (deps.sessionMetadataService) {
        await deps.sessionMetadataService.setExecutor(sessionId, executor);
      }
    }

    const globalInstructions = getGlobalInstructions();

    // Look up the session's original provider so we resume with the correct one
    // (e.g., claude-ollama sessions need the Ollama provider, not default Claude).
    // Check metadata first (explicitly saved on creation), then fall back to reader.
    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;

    let providerName = metadataProvider ?? body.provider;
    if (!providerName) {
      const sessionSummaryResult = await findSessionListSummaryAcrossProviders(
        project,
        sessionId,
        projectId as UrlProjectId,
        providerResolutionDeps(deps),
        metadataProvider ?? body.provider,
      );
      providerName =
        sessionSummaryResult?.source.provider ??
        metadataProvider ??
        body.provider ??
        project.provider;
    }
    const previousProcess = deps.supervisor.getProcessForSession?.(sessionId);
    const resumeDiagnostics = {
      requestedMode: resumeMode,
      provider: providerName,
      previousProcess: previousProcess
        ? {
            processId: previousProcess.id,
            state: previousProcess.state.type,
            provider: previousProcess.provider,
            supportsDynamicCommands: previousProcess.supportsDynamicCommands,
          }
        : null,
    };

    let resumeSessionAt: string | undefined;
    if (isClaudeSdkProviderName(providerName)) {
      let blocker: ClaudeResumeApiErrorBlocker | null = null;
      try {
        blocker = await getClaudeResumeBlockerFromReader(
          deps.readerFactory(project),
          sessionId,
          projectId,
        );
      } catch (error) {
        getLogger().warn(
          {
            event: "claude_resume_api_error_check_failed",
            sessionId,
            projectId,
            providerName,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to check Claude session for resume-blocking API error",
        );
      }

      if (blocker?.resumeAtMessageId) {
        // Recoverable: resume up to the last good assistant message,
        // dropping the API-error tail, instead of forcing a handoff.
        resumeSessionAt = blocker.resumeAtMessageId;
        getLogger().info(
          {
            event: "claude_resume_truncated_after_api_error",
            sessionId,
            projectId,
            providerName,
            messageId: blocker.messageId,
            apiErrorStatus: blocker.apiErrorStatus,
            resumeSessionAt,
          },
          "Resuming Claude session before SDK API-error tail",
        );
      } else if (blocker) {
        getLogger().warn(
          {
            event: "claude_resume_blocked_after_api_error",
            sessionId,
            projectId,
            providerName,
            messageId: blocker.messageId,
            apiErrorStatus: blocker.apiErrorStatus,
          },
          "Blocked Claude provider resume after SDK API-error message",
        );
        return c.json(
          {
            error: blocker.error,
            recovery: blocker.recovery,
            resume: {
              ...resumeDiagnostics,
              blockedReason: "claude-api-error-tail",
            },
          },
          409,
        );
      }
    }

    let result: Awaited<ReturnType<Supervisor["resumeSession"]>>;
    try {
      result = await deps.supervisor.resumeSession(
        sessionId,
        project.path,
        userMessage,
        body.mode,
        {
          model,
          serviceTier,
          thinking,
          effort,
          providerName,
          executor,
          globalInstructions,
          permissions: body.permissions,
          recapMode: helperSettings.recapMode,
          recapAfterSeconds:
            helperSettings.recapAfterSeconds ??
            deps.sessionMetadataService?.getRecapAfterSeconds?.(sessionId),
          // Body value wins; otherwise recover the per-session preference from
          // metadata so a body-less resume does not default back to native.
          promptSuggestionMode:
            helperSettings.promptSuggestionMode ??
            deps.sessionMetadataService?.getPromptSuggestionMode?.(sessionId),
          helperSideModel: helperSettings.helperSideModel,
          resumeMode,
          resumeSessionAt,
        },
      );
    } catch (error) {
      if (error instanceof ResumeCompactionError) {
        getLogger().warn(
          {
            event: "resume_compaction_failed",
            sessionId,
            projectId,
            providerName,
            attempt: error.attempt,
          },
          "Compact-first resume failed",
        );
        return c.json(
          {
            error: error.message,
            recovery: error.recovery,
            resume: {
              ...resumeDiagnostics,
              compaction: error.attempt,
            },
          },
          409,
        );
      }
      throw error;
    }

    // Check if queue is full
    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json(
        {
          ...result,
          serverTimestamp: Date.now(),
          resume: { ...resumeDiagnostics, outcome: "queued" },
        },
        202,
      ); // 202 Accepted - queued for processing
    }

    return c.json({
      processId: result.id,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
      recapAfterSeconds: result.recapAfterSeconds,
      serverTimestamp,
      resume: {
        ...resumeDiagnostics,
        outcome: "started",
        compaction:
          resumeMode === "compact-first" ? { status: "completed" } : undefined,
      },
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/reactivate
  // Spawn a live harness process bound to the session WITHOUT delivering a turn,
  // so the client can read live process state (model options) before messaging.
  // Idempotent: returns the existing process if the session is already owned.
  routes.post(
    "/projects/:projectId/sessions/:sessionId/reactivate",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");

      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }

      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json(
          { error: "Project not found or path does not exist" },
          404,
        );
      }

      // Already owned by a live process - return it (idempotent).
      const existing = deps.supervisor.getProcessForSession(sessionId);
      if (existing) {
        return c.json({
          processId: existing.id,
          permissionMode: existing.permissionMode,
          modeVersion: existing.modeVersion,
          recapAfterSeconds: existing.recapAfterSeconds,
          serverTimestamp: Date.now(),
        });
      }

      // Body is optional - allows overriding mode/model/executor.
      let body: StartSessionBody = {} as StartSessionBody;
      try {
        body = await c.req.json<StartSessionBody>();
      } catch {
        // No body - resume with the session's saved settings.
      }

      const parsedBodyExecutor = parseOptionalExecutor(body.executor);
      if (parsedBodyExecutor.error) {
        return c.json({ error: parsedBodyExecutor.error }, 400);
      }
      const helperSettings = parseHelperSettings(body);
      if (helperSettings.error) {
        return c.json({ error: helperSettings.error }, 400);
      }

      // Resolve provider/model/executor from the YA launch record (persisted on
      // launch) so reactivation resumes with the correct backend and model.
      const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
      const providerName =
        (metadata?.provider as ProviderName | undefined) ??
        body.provider ??
        project.provider;
      const executor = parsedBodyExecutor.executor ?? metadata?.executor;
      // Prefer an explicit override, else the YA id the session was launched
      // with; "default" means let the backend pick (pass undefined).
      const rawModel =
        body.model && body.model !== "default"
          ? body.model
          : metadata?.requestedModel;
      const model = rawModel && rawModel !== "default" ? rawModel : undefined;
      const { thinking, effort } = buildThinkingOptions(body);

      let process: Process;
      try {
        process = await deps.supervisor.reactivateSession(
          project.path,
          sessionId,
          body.mode,
          {
            model,
            thinking,
            effort,
            providerName,
            executor,
            globalInstructions: getGlobalInstructions(),
            recapAfterSeconds:
              helperSettings.recapAfterSeconds ?? metadata?.recapAfterSeconds,
            recapMode: helperSettings.recapMode ?? metadata?.recapMode,
          },
        );
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Failed to reactivate session",
          },
          503,
        );
      }

      // Keep the launch record current (provider/executor) for this session.
      await persistLaunchMetadata(sessionId, providerName, executor);

      return c.json({
        processId: process.id,
        permissionMode: process.permissionMode,
        modeVersion: process.modeVersion,
        recapAfterSeconds: process.recapAfterSeconds,
        serverTimestamp: Date.now(),
      });
    },
  );

  // POST /api/projects/:projectId/sessions/:sessionId/recap
  // Away-recap trigger, keyed by session (not process) so it survives a server
  // restart that killed the process. A live process recaps directly in its own
  // mode; a cold fork-mode session is revived — without ever preempting a live
  // worker — and recapped from its on-disk transcript. See topics/fork-recap.md.
  routes.post("/projects/:projectId/sessions/:sessionId/recap", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    let sinceMs: number | null = null;
    try {
      const body = await c.req.json<{ hiddenSinceMs?: unknown }>();
      if (
        typeof body.hiddenSinceMs === "number" &&
        Number.isFinite(body.hiddenSinceMs)
      ) {
        sinceMs = body.hiddenSinceMs;
      }
    } catch {
      // Empty body is accepted.
    }

    // Live process: recap directly in whatever mode it runs.
    const live = deps.supervisor.getProcessForSession(sessionId);
    if (live && !live.isTerminated) {
      const result = await deps.supervisor.requestRecap(live.id, { sinceMs });
      return c.json(result);
    }

    // Cold session: only fork mode can recap from the on-disk transcript —
    // side-session/native recaps need in-memory recent text a revived process
    // lacks. Other modes simply skip until the session is live again.
    const recapMode = deps.sessionMetadataService?.getRecapMode(sessionId);
    if (recapMode !== "fork") {
      return c.json({
        supported: true,
        emitted: false,
        reason: "recap requires a live process for this recap mode",
      });
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
    const providerName =
      (metadata?.provider as ProviderName | undefined) ?? project.provider;
    const rawModel = metadata?.requestedModel;
    const model = rawModel && rawModel !== "default" ? rawModel : undefined;

    let process: Process;
    try {
      process = await deps.supervisor.reactivateSession(
        project.path,
        sessionId,
        undefined,
        {
          model,
          providerName,
          executor: metadata?.executor,
          globalInstructions: getGlobalInstructions(),
          recapAfterSeconds: metadata?.recapAfterSeconds,
          recapMode: "fork",
        },
        { preempt: false },
      );
    } catch (error) {
      // At capacity with no idle worker to drop (background recaps never
      // preempt), or reactivation failed — skip the recap rather than error.
      const atCapacity =
        error instanceof Error && error.message.includes("worker capacity");
      return c.json({
        supported: true,
        emitted: false,
        reason: atCapacity
          ? "recap skipped: at worker capacity"
          : "recap skipped: session could not be revived",
      });
    }

    const result = await deps.supervisor.requestRecap(process.id, {
      sinceMs,
      revived: true,
    });
    return c.json(result);
  });

  // POST /api/projects/:projectId/sessions/:sessionId/restart
  // Start a fresh session from a bounded handoff, then terminate the old YA-owned process.
  routes.post("/projects/:projectId/sessions/:sessionId/restart", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: RestartSessionBody = {};
    try {
      body = await c.req.json<RestartSessionBody>();
    } catch {
      // Body is optional for this endpoint.
    }

    const parsedBodyExecutor = parseOptionalExecutor(body.executor);
    if (parsedBodyExecutor.error) {
      return c.json({ error: parsedBodyExecutor.error }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }

    let executor = parsedBodyExecutor.executor;
    if (!executor) {
      const parsedSavedExecutor = parseOptionalExecutor(
        deps.sessionMetadataService?.getExecutor(sessionId),
      );
      if (parsedSavedExecutor.error) {
        return c.json({ error: parsedSavedExecutor.error }, 400);
      }
      executor = parsedSavedExecutor.executor;
    }

    if (
      body.restartMode !== undefined &&
      body.restartMode !== "handoff" &&
      body.restartMode !== "fork"
    ) {
      return c.json({ error: 'restartMode must be "handoff" or "fork"' }, 400);
    }
    const restartMode = body.restartMode ?? "handoff";

    const oldProcess = deps.supervisor.getProcessForSession(sessionId);
    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const preferredSourceProvider =
      metadataProvider ?? oldProcess?.provider ?? project.provider;
    // Fork copies the transcript as-is; pre-restart compaction is a
    // handoff-only mitigation.
    const compactAttempt =
      restartMode === "fork" ? undefined : await tryRestartCompact(oldProcess);
    const oldProcessInterrupted =
      await interruptOldProcessForHandoff(oldProcess);
    const sourceSession = await loadRestartSourceSession(
      project,
      sessionId,
      projectId,
      preferredSourceProvider,
      oldProcess,
    );

    if (!sourceSession) {
      return c.json({ error: "Session not found" }, 404);
    }

    const sourceProvider = sourceSession.provider ?? preferredSourceProvider;
    const providerName = body.provider ?? sourceProvider;
    const originalMetadata =
      deps.sessionMetadataService?.getMetadata(sessionId);

    const { thinking, effort } = buildThinkingOptions(body);
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    if (restartMode === "fork") {
      if (body.provider && body.provider !== sourceProvider) {
        return c.json(
          {
            error:
              "Fork keeps the source provider; omit provider or match the source session",
          },
          400,
        );
      }
      if (!deps.supervisor.supportsForkSession(sourceProvider)) {
        return c.json(
          { error: `${sourceProvider} does not support transcript fork` },
          400,
        );
      }
      const forkTitle = deriveForkTitle({
        preferredTitle: originalMetadata?.customTitle,
        sourceSession,
      });
      let fork: { sessionId: string };
      try {
        fork = await deps.supervisor.forkSession({
          sessionId,
          projectPath: project.path,
          providerName: sourceProvider,
          upToMessageId: body.forkUpToMessageId,
          title: forkTitle,
        });
      } catch (error) {
        getLogger().warn(
          {
            event: "restart_fork_failed",
            sessionId,
            projectId,
            sourceProvider,
            upToMessageId: body.forkUpToMessageId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Transcript fork failed",
        );
        return c.json(
          {
            error:
              error instanceof Error ? error.message : "Transcript fork failed",
          },
          500,
        );
      }

      const forkMessage =
        body.reason?.trim() || "Continue from this fork point.";
      const result = await deps.supervisor.resumeSession(
        fork.sessionId,
        project.path,
        { text: forkMessage, mode: body.mode },
        body.mode,
        {
          model,
          serviceTier,
          thinking,
          effort,
          providerName: sourceProvider,
          executor,
          globalInstructions: getGlobalInstructions(),
          permissions: body.permissions,
          recapMode: helperSettings.recapMode,
          recapAfterSeconds:
            helperSettings.recapAfterSeconds ??
            originalMetadata?.recapAfterSeconds,
          // Inherit the source session's preference unless the body overrides.
          promptSuggestionMode:
            helperSettings.promptSuggestionMode ??
            originalMetadata?.promptSuggestionMode,
          helperSideModel: helperSettings.helperSideModel,
        },
      );

      if (isQueueFullResponse(result)) {
        return c.json(
          { error: "Queue is full", maxQueueSize: result.maxQueueSize },
          503,
        );
      }
      if (isQueuedResponse(result)) {
        deps.supervisor.cancelQueuedRequest(result.queueId);
        return c.json(
          {
            error:
              "Fork could not start immediately; old process was left running",
          },
          503,
        );
      }

      await persistLaunchMetadata(
        result.sessionId,
        sourceProvider,
        executor,
        undefined,
        body.model ?? deps.sessionMetadataService?.getRequestedModel(sessionId),
        result.promptSuggestionMode,
        result.recapAfterSeconds,
      );
      if (deps.sessionMetadataService) {
        await deps.sessionMetadataService.updateMetadata(result.sessionId, {
          title: forkTitle,
        });
        deps.eventBus?.emit({
          type: "session-metadata-changed",
          sessionId: result.sessionId,
          title: forkTitle,
          timestamp: new Date().toISOString(),
        });
      }

      const oldProcessAbortDeferred = abortOldProcessAfterReplacementActivity(
        oldProcess,
        result,
      );

      return c.json({
        sessionId: result.sessionId,
        processId: result.id,
        projectId: result.projectId,
        provider: result.provider,
        model: result.resolvedModel ?? result.model,
        title: forkTitle,
        permissionMode: result.permissionMode,
        modeVersion: result.modeVersion,
        recapAfterSeconds: result.recapAfterSeconds,
        restartedFrom: sessionId,
        forkUpToMessageId: body.forkUpToMessageId,
        oldProcessId: oldProcess?.id,
        oldProcessInterrupted,
        oldProcessAbortDeferred,
        oldProcessAborted: false,
      });
    }

    const handoffTitle = deriveRestartTitle({
      preferredTitle: originalMetadata?.customTitle,
      sourceSession,
    });
    const { transcript, omittedCount } = buildRestartTranscript(
      sourceSession.messages,
    );
    const handoff = buildRestartHandoff({
      handoffTitle,
      sourceSession,
      sourceProvider,
      sourceModel: oldProcess?.resolvedModel ?? sourceSession.model,
      sourceProcess: oldProcess,
      compactAttempt,
      projectPath: project.path,
      reason: body.reason,
      omittedCount,
      transcript,
    });

    const result = await deps.supervisor.startSession(
      project.path,
      {
        text: handoff,
        mode: body.mode,
      },
      body.mode,
      {
        model,
        serviceTier,
        thinking,
        effort,
        providerName,
        clientName: "yep-anywhere",
        executor,
        globalInstructions: getGlobalInstructions(),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        recapAfterSeconds:
          helperSettings.recapAfterSeconds ??
          originalMetadata?.recapAfterSeconds,
        // Inherit the source session's preference unless the body overrides.
        promptSuggestionMode:
          helperSettings.promptSuggestionMode ??
          originalMetadata?.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
      },
    );

    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    if (isQueuedResponse(result)) {
      deps.supervisor.cancelQueuedRequest(result.queueId);
      return c.json(
        {
          error:
            "Restart could not start immediately; old process was left running",
        },
        503,
      );
    }

    await persistLaunchMetadata(
      result.sessionId,
      providerName,
      executor,
      undefined,
      body.model ?? deps.sessionMetadataService?.getRequestedModel(sessionId),
      result.promptSuggestionMode,
      result.recapAfterSeconds,
    );
    if (deps.sessionMetadataService) {
      await deps.sessionMetadataService.updateMetadata(result.sessionId, {
        title: handoffTitle,
      });
      deps.eventBus?.emit({
        type: "session-metadata-changed",
        sessionId: result.sessionId,
        title: handoffTitle,
        timestamp: new Date().toISOString(),
      });
    }

    const oldProcessAbortDeferred = abortOldProcessAfterReplacementActivity(
      oldProcess,
      result,
    );

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      projectId: result.projectId,
      provider: result.provider,
      model: result.resolvedModel ?? result.model,
      title: handoffTitle,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
      recapAfterSeconds: result.recapAfterSeconds,
      restartedFrom: sessionId,
      oldProcessId: oldProcess?.id,
      oldProcessInterrupted,
      oldProcessAbortDeferred,
      oldProcessAborted: false,
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/fork
  // Fork the provider transcript into a new resumable session without
  // starting a process or sending any message ("fork from here" / rewind).
  // The forked session opens cold; the next user send resumes it normally.
  routes.post("/projects/:projectId/sessions/:sessionId/fork", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: { upToMessageId?: string } = {};
    try {
      body = await c.req.json<{ upToMessageId?: string }>();
    } catch {
      // Body is optional; full-transcript fork.
    }
    const upToMessageId =
      typeof body.upToMessageId === "string" && body.upToMessageId
        ? body.upToMessageId
        : undefined;

    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const sourceProcess = deps.supervisor.getProcessForSession(sessionId);
    const sessionSummaryResult = await findSessionListSummaryAcrossProviders(
      project,
      sessionId,
      projectId,
      providerResolutionDeps(deps),
      sourceProcess?.provider ?? metadataProvider,
    );
    const sessionSummary = sessionSummaryResult?.summary ?? null;
    const providerName =
      sourceProcess?.provider ??
      metadataProvider ??
      sessionSummaryResult?.source.provider ??
      project.provider;
    if (!deps.supervisor.supportsForkSession(providerName)) {
      return c.json(
        { error: `${providerName} does not support transcript fork` },
        400,
      );
    }

    const originalMetadata =
      deps.sessionMetadataService?.getMetadata(sessionId);
    let baseTitle = normalizeRestartTitleCandidate(
      originalMetadata?.customTitle,
    );
    if (!baseTitle) {
      baseTitle = normalizeRestartTitleCandidate(sessionSummary?.title);
    }
    const forkTitle = baseTitle
      ? truncateSessionTitle(
          /^Fork:/i.test(baseTitle) ? baseTitle : `Fork: ${baseTitle}`,
        )
      : undefined;

    let fork: { sessionId: string };
    try {
      fork = await deps.supervisor.forkSession({
        sessionId,
        projectPath: project.path,
        providerName,
        upToMessageId,
        title: forkTitle,
      });
    } catch (error) {
      getLogger().warn(
        {
          event: "session_fork_failed",
          sessionId,
          projectId,
          providerName,
          upToMessageId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Transcript fork failed",
      );
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Transcript fork failed",
        },
        500,
      );
    }

    const savedExecutor = parseOptionalExecutor(
      deps.sessionMetadataService?.getExecutor(sessionId),
    ).executor;
    await persistLaunchMetadata(
      fork.sessionId,
      providerName,
      savedExecutor,
      undefined,
      deps.sessionMetadataService?.getRequestedModel(sessionId),
      originalMetadata?.promptSuggestionMode,
      originalMetadata?.recapAfterSeconds,
    );
    if (deps.sessionMetadataService) {
      await deps.sessionMetadataService.updateMetadata(fork.sessionId, {
        title: forkTitle,
        parentSessionId: sessionId,
      });
      deps.eventBus?.emit({
        type: "session-metadata-changed",
        sessionId: fork.sessionId,
        title: forkTitle,
        parentSessionId: sessionId,
        timestamp: new Date().toISOString(),
      });
    }

    return c.json({
      sessionId: fork.sessionId,
      projectId,
      provider: providerName,
      title: forkTitle,
      forkedFrom: sessionId,
      upToMessageId,
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/retitle
  // Generate a proposed session title through an archived helper fork. This
  // never updates the source session title; the client must explicitly accept
  // the returned proposal through the ordinary metadata update route.
  routes.post("/projects/:projectId/sessions/:sessionId/retitle", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }
    if (!deps.sessionMetadataService) {
      return c.json({ error: "Session metadata service not available" }, 503);
    }

    let body: { currentTitle?: unknown; lengthTarget?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional.
    }

    const currentTitle =
      typeof body.currentTitle === "string"
        ? body.currentTitle.trim().slice(0, 200)
        : undefined;
    let lengthTarget: number | undefined;
    if (body.lengthTarget !== undefined) {
      if (
        typeof body.lengthTarget !== "number" ||
        !Number.isInteger(body.lengthTarget) ||
        body.lengthTarget < 20 ||
        body.lengthTarget > 132
      ) {
        return c.json(
          { error: "lengthTarget must be an integer between 20 and 132" },
          400,
        );
      }
      lengthTarget = body.lengthTarget;
    }

    const metadataProvider = deps.sessionMetadataService.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    let sourceProcess = deps.supervisor.getProcessForSession(sessionId);
    const liveSourceProcess =
      sourceProcess && !sourceProcess.isTerminated ? sourceProcess : undefined;
    const sessionSummaryResult = await findSessionListSummaryAcrossProviders(
      project,
      sessionId,
      projectId,
      providerResolutionDeps(deps),
      liveSourceProcess?.provider ?? metadataProvider,
    );
    const providerName =
      liveSourceProcess?.provider ??
      metadataProvider ??
      sessionSummaryResult?.source.provider ??
      sourceProcess?.provider ??
      project.provider;
    if (!deps.supervisor.supportsForkSession(providerName)) {
      return c.json(
        { error: `${providerName} does not support transcript fork` },
        400,
      );
    }

    const savedExecutor = parseOptionalExecutor(
      deps.sessionMetadataService.getExecutor(sessionId),
    ).executor;
    let requestedModel =
      deps.sessionMetadataService.getRequestedModel(sessionId) ??
      liveSourceProcess?.model;
    const sourceMetadata = deps.sessionMetadataService.getMetadata(sessionId);
    const promptSuggestionMode = sourceMetadata?.promptSuggestionMode;
    const recapAfterSeconds = sourceMetadata?.recapAfterSeconds;
    const abortController = new AbortController();
    const abortFromRequest = () => abortController.abort();
    if (c.req.raw.signal.aborted) {
      abortController.abort();
    } else {
      c.req.raw.signal.addEventListener("abort", abortFromRequest, {
        once: true,
      });
    }

    let generatorSessionId: string | undefined;
    try {
      if (!liveSourceProcess) {
        sourceProcess = await deps.supervisor.reactivateSession(
          project.path,
          sessionId,
          undefined,
          {
            model:
              requestedModel && requestedModel !== "default"
                ? requestedModel
                : undefined,
            providerName,
            executor: savedExecutor,
            globalInstructions: getGlobalInstructions(),
            promptSuggestionMode,
            recapAfterSeconds,
          },
        );
        requestedModel = requestedModel ?? sourceProcess.model;
      }

      const generator = await deps.supervisor.forkSession({
        sessionId,
        projectPath: project.path,
        providerName,
        title: "Retitle generator",
      });
      generatorSessionId = generator.sessionId;
      await updateForkSummaryChildMetadata(
        generator.sessionId,
        sessionId,
        "Retitle generator",
        true,
      );
      await persistLaunchMetadata(
        generator.sessionId,
        providerName,
        savedExecutor,
        undefined,
        requestedModel,
        promptSuggestionMode,
        recapAfterSeconds,
      );
      if (abortController.signal.aborted) {
        throw new DOMException("Retitle cancelled", "AbortError");
      }

      const generated = await deps.supervisor.generateSummary(providerName, {
        purpose: "session-retitle",
        strategy: "fork",
        generatorSessionId: generator.sessionId,
        cwd: project.path,
        currentTitle,
        lengthTarget,
        signal: abortController.signal,
      });
      const title = generatedRetitleCandidate(generated.text);
      if (!title) {
        throw new Error("Retitle generation returned empty title");
      }
      return c.json({ title, generatorSessionId: generator.sessionId });
    } catch (error) {
      const cancelled =
        abortController.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError");
      const message =
        error instanceof Error ? error.message : "Retitle generation failed";
      getLogger().warn(
        {
          event: cancelled
            ? "session_retitle_cancelled"
            : "session_retitle_failed",
          sessionId,
          projectId,
          providerName,
          generatorSessionId,
          error: message,
        },
        cancelled ? "Session retitle cancelled" : "Session retitle failed",
      );
      return c.json({ error: message }, cancelled ? 400 : 500);
    } finally {
      c.req.raw.signal.removeEventListener("abort", abortFromRequest);
      abortController.abort();
    }
  });

  // POST /api/projects/:projectId/sessions/:sessionId/fork-summary
  // Start a server-owned whole-context fork-after-summary job. The response
  // returns after durable job creation; generation continues independently of
  // the requesting client connection.
  routes.post(
    "/projects/:projectId/sessions/:sessionId/fork-summary",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");

      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }
      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json(
          { error: "Project not found or path does not exist" },
          404,
        );
      }

      let body: {
        sourceMessageId?: unknown;
        instructions?: unknown;
        mode?: unknown;
        autoOpenWhenReady?: unknown;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const sourceMessageId =
        typeof body.sourceMessageId === "string" && body.sourceMessageId.trim()
          ? body.sourceMessageId.trim()
          : undefined;
      if (!sourceMessageId) {
        return c.json({ error: "sourceMessageId is required" }, 400);
      }
      if (
        body.mode !== undefined &&
        (typeof body.mode !== "string" ||
          !ALL_PERMISSION_MODES.includes(body.mode as PermissionMode))
      ) {
        return c.json({ error: "Invalid permission mode" }, 400);
      }
      if (
        body.autoOpenWhenReady !== undefined &&
        typeof body.autoOpenWhenReady !== "boolean"
      ) {
        return c.json({ error: "autoOpenWhenReady must be a boolean" }, 400);
      }
      const mode = body.mode as PermissionMode | undefined;
      const instructions =
        typeof body.instructions === "string" ? body.instructions : undefined;
      const autoOpenWhenReady = body.autoOpenWhenReady === true;

      const metadataProvider = deps.sessionMetadataService?.getProvider(
        sessionId,
      ) as ProviderName | undefined;
      const sourceProcess = deps.supervisor.getProcessForSession(sessionId);
      const providerName =
        metadataProvider ?? sourceProcess?.provider ?? project.provider;
      if (!deps.supervisor.supportsForkSession(providerName)) {
        return c.json(
          { error: `${providerName} does not support transcript fork` },
          400,
        );
      }
      if (!deps.sessionMetadataService) {
        return c.json({ error: "Session metadata service not available" }, 503);
      }
      if (activeForkSummaryJobs.has(sessionId)) {
        return c.json(
          { error: "A fork summary is already generating for this session" },
          409,
        );
      }

      const sourceSession = sourceProcess
        ? ({
            messages: sdkMessagesToClientMessages(
              sourceProcess.getMessageHistory(),
            ),
          } as Session)
        : await loadRestartSourceSession(
            project,
            sessionId,
            projectId,
            providerName,
          );
      if (!sourceSession) {
        return c.json({ error: "Source session not found" }, 404);
      }
      const boundary = resolveForkAfterBoundary(
        sourceSession.messages,
        sourceMessageId,
        sourceProcess?.state.type === "in-turn" ||
          sourceProcess?.state.type === "waiting-input",
      );
      if ("error" in boundary) {
        return c.json({ error: boundary.error }, boundary.status);
      }

      const displayObject: TranscriptDisplayObject = {
        id: randomUUID(),
        kind: "fork-summary",
        createdAt: new Date().toISOString(),
        placementAfterMessageId: boundary.placementAfterMessageId,
        sourceMessageId,
        retainedThroughMessageId: boundary.retainedThroughMessageId,
        status: "generating",
        autoOpenWhenReady: autoOpenWhenReady || undefined,
      };
      const abortController = new AbortController();
      activeForkSummaryJobs.set(sessionId, {
        objectId: displayObject.id,
        abortController,
      });
      try {
        await deps.sessionMetadataService.addTranscriptDisplayObject(
          sessionId,
          displayObject,
        );
      } catch (error) {
        activeForkSummaryJobs.delete(sessionId);
        throw error;
      }
      emitTranscriptDisplayObjects(sessionId);

      const originalMetadata =
        deps.sessionMetadataService.getMetadata(sessionId);
      const baseTitle = normalizeRestartTitleCandidate(
        originalMetadata?.customTitle ?? sourceSession.title,
      );
      const fallbackTitle = baseTitle
        ? truncateSessionTitle(
            /^Fork:/i.test(baseTitle) ? baseTitle : `Fork: ${baseTitle}`,
          )
        : undefined;
      const savedExecutor = parseOptionalExecutor(
        deps.sessionMetadataService.getExecutor(sessionId),
      ).executor;
      const requestedModel =
        deps.sessionMetadataService.getRequestedModel(sessionId) ??
        sourceProcess?.model;

      void (async () => {
        let generatorSessionId: string | undefined;
        let targetSessionId: string | undefined;
        let targetTitle: string | undefined;
        let targetProcessId: string | undefined;
        let completed = false;
        try {
          const generator = await deps.supervisor.forkSession({
            sessionId,
            projectPath: project.path,
            providerName,
            title: "Fork summary generator",
          });
          generatorSessionId = generator.sessionId;
          await updateForkSummaryChildMetadata(
            generator.sessionId,
            sessionId,
            "Fork summary generator",
            true,
          );
          await persistLaunchMetadata(
            generator.sessionId,
            providerName,
            savedExecutor,
            undefined,
            requestedModel,
            originalMetadata?.promptSuggestionMode,
            originalMetadata?.recapAfterSeconds,
          );
          if (abortController.signal.aborted) {
            throw new DOMException("Fork summary cancelled", "AbortError");
          }

          const generated = await deps.supervisor.generateSummary(
            providerName,
            {
              purpose: "fork-after-summary",
              strategy: "fork",
              generatorSessionId: generator.sessionId,
              cwd: project.path,
              afterTurnMessageId: boundary.retainedThroughMessageId,
              afterTurnContext: boundary.retainedThroughContext,
              instructions,
              signal: abortController.signal,
            },
          );
          if (abortController.signal.aborted) {
            throw new DOMException("Fork summary cancelled", "AbortError");
          }

          const title = forkSummaryTitle(generated.text, fallbackTitle);
          targetTitle = title;
          const target = await deps.supervisor.forkSession({
            sessionId,
            projectPath: project.path,
            providerName,
            upToMessageId: boundary.retainedThroughMessageId,
            title,
          });
          targetSessionId = target.sessionId;
          await updateForkSummaryChildMetadata(
            target.sessionId,
            sessionId,
            title,
            true,
          );
          await persistLaunchMetadata(
            target.sessionId,
            providerName,
            savedExecutor,
            undefined,
            requestedModel,
            originalMetadata?.promptSuggestionMode,
            originalMetadata?.recapAfterSeconds,
          );
          if (abortController.signal.aborted) {
            throw new DOMException("Fork summary cancelled", "AbortError");
          }

          const result = await deps.supervisor.resumeSession(
            target.sessionId,
            project.path,
            { text: generated.text, mode },
            mode,
            {
              providerName,
              executor: savedExecutor,
              globalInstructions: getGlobalInstructions(),
              model: requestedModel,
              promptSuggestionMode: originalMetadata?.promptSuggestionMode,
              recapAfterSeconds: originalMetadata?.recapAfterSeconds,
            },
          );
          if (isQueueFullResponse(result)) {
            throw new Error("Queue is full");
          }
          if (isQueuedResponse(result)) {
            deps.supervisor.cancelQueuedRequest(result.queueId);
            throw new Error("Fork summary could not start immediately");
          }
          targetProcessId = result.id;
          if (abortController.signal.aborted) {
            await deps.supervisor.abortProcess(result.id);
            targetProcessId = undefined;
            throw new DOMException("Fork summary cancelled", "AbortError");
          }

          await persistLaunchMetadata(
            result.sessionId,
            providerName,
            savedExecutor,
            undefined,
            requestedModel,
            result.promptSuggestionMode,
            result.recapAfterSeconds,
          );
          await updateForkSummaryChildMetadata(
            result.sessionId,
            sessionId,
            title,
            false,
          );
          await deps.sessionMetadataService?.updateTranscriptDisplayObject(
            sessionId,
            displayObject.id,
            (object) =>
              object.kind !== "fork-summary"
                ? object
                : {
                    ...object,
                    status: "ready",
                    targetSessionId: result.sessionId,
                    title,
                    error: undefined,
                  },
          );
          emitTranscriptDisplayObjects(sessionId);
          completed = true;
        } catch (error) {
          const cancelled =
            abortController.signal.aborted ||
            (error instanceof DOMException && error.name === "AbortError");
          const logCleanupFailure = (
            stage: string,
            cleanupError: unknown,
          ): void => {
            getLogger().warn(
              {
                event: "fork_after_summary_cleanup_failed",
                sessionId,
                projectId,
                providerName,
                stage,
                error:
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : String(cleanupError),
              },
              "Fork-after-summary cleanup failed",
            );
          };
          if (generatorSessionId) {
            try {
              await updateForkSummaryChildMetadata(
                generatorSessionId,
                sessionId,
                "Fork summary generator",
                true,
              );
            } catch (cleanupError) {
              logCleanupFailure("archive-generator", cleanupError);
            }
          }
          if (targetSessionId && targetTitle) {
            try {
              await updateForkSummaryChildMetadata(
                targetSessionId,
                sessionId,
                targetTitle,
                true,
              );
            } catch (cleanupError) {
              logCleanupFailure("archive-target", cleanupError);
            }
          }
          if (!completed && targetProcessId) {
            try {
              await deps.supervisor.abortProcess(targetProcessId);
            } catch (cleanupError) {
              logCleanupFailure("abort-target-process", cleanupError);
            }
          }
          if (!cancelled) {
            const message =
              error instanceof Error
                ? error.message
                : "Summary generation failed";
            getLogger().warn(
              {
                event: "fork_after_summary_failed",
                sessionId,
                projectId,
                providerName,
                sourceMessageId,
                error: message,
              },
              "Fork-after-summary job failed",
            );
            try {
              await deps.sessionMetadataService?.updateTranscriptDisplayObject(
                sessionId,
                displayObject.id,
                (object) =>
                  object.kind !== "fork-summary"
                    ? object
                    : {
                        ...object,
                        status: "error",
                        error: message,
                      },
              );
              emitTranscriptDisplayObjects(sessionId);
            } catch (cleanupError) {
              logCleanupFailure("persist-error-state", cleanupError);
            }
          }
        } finally {
          const active = activeForkSummaryJobs.get(sessionId);
          if (active?.objectId === displayObject.id) {
            activeForkSummaryJobs.delete(sessionId);
          }
        }
      })().catch((error) => {
        getLogger().error(
          {
            event: "fork_after_summary_unhandled_failure",
            sessionId,
            projectId,
            providerName,
            sourceMessageId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Fork-after-summary job escaped its guarded workflow",
        );
      });

      return c.json({ displayObject }, 202);
    },
  );

  routes.post(
    "/projects/:projectId/sessions/:sessionId/fork-summary/:objectId/cancel",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");
      const objectId = c.req.param("objectId");
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }
      const active = activeForkSummaryJobs.get(sessionId);
      const object = deps.sessionMetadataService
        ?.getTranscriptDisplayObjects(sessionId)
        .find((candidate) => candidate.id === objectId);
      if (!object) {
        return c.json({ error: "Transcript display object not found" }, 404);
      }
      if (active?.objectId === objectId && object.status === "generating") {
        active.abortController.abort();
      } else if (object.status !== "error") {
        return c.json({ error: "Fork summary job is not active" }, 409);
      }
      await deps.sessionMetadataService?.removeTranscriptDisplayObject(
        sessionId,
        objectId,
      );
      emitTranscriptDisplayObjects(sessionId);
      return c.json({
        transcriptDisplayObjects:
          deps.sessionMetadataService?.getTranscriptDisplayObjects(sessionId) ??
          [],
      });
    },
  );

  routes.patch(
    "/projects/:projectId/sessions/:sessionId/fork-summary/:objectId",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");
      const objectId = c.req.param("objectId");
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }
      if (!deps.sessionMetadataService) {
        return c.json({ error: "Session metadata service not available" }, 503);
      }
      let body: { autoOpenWhenReady?: unknown; action?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const action =
        body.action === "opened" || body.action === "clicked"
          ? body.action
          : undefined;
      if (
        body.autoOpenWhenReady !== undefined &&
        typeof body.autoOpenWhenReady !== "boolean"
      ) {
        return c.json({ error: "autoOpenWhenReady must be a boolean" }, 400);
      }
      if (body.action !== undefined && !action) {
        return c.json({ error: "action must be opened or clicked" }, 400);
      }
      const now = new Date().toISOString();
      const updated =
        await deps.sessionMetadataService.updateTranscriptDisplayObject(
          sessionId,
          objectId,
          (object) =>
            object.kind !== "fork-summary"
              ? object
              : {
                  ...object,
                  ...(typeof body.autoOpenWhenReady === "boolean"
                    ? { autoOpenWhenReady: body.autoOpenWhenReady || undefined }
                    : {}),
                  ...(action === "opened" ? { openedAt: now } : {}),
                  ...(action === "clicked" ? { clickedAt: now } : {}),
                },
        );
      if (!updated) {
        return c.json({ error: "Transcript display object not found" }, 404);
      }
      emitTranscriptDisplayObjects(sessionId);
      return c.json({
        displayObject: updated,
        transcriptDisplayObjects:
          deps.sessionMetadataService.getTranscriptDisplayObjects(sessionId),
      });
    },
  );

  // POST /api/sessions/:sessionId/messages - Queue message
  routes.post("/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    let body: StartSessionBody & { deferred?: boolean };
    try {
      body = await c.req.json<StartSessionBody & { deferred?: boolean }>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }

    const serverTimestamp = Date.now();
    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
      metadata: buildUserMessageMetadata(
        body,
        serverTimestamp,
        body.deferred ? "deferred" : "direct",
      ),
    };

    // Check if process is terminated
    if (process.isTerminated) {
      return c.json(
        {
          error: "Process terminated",
          reason: process.terminationReason,
        },
        410,
      ); // 410 Gone
    }

    // Provider-native slash commands (e.g. Codex `/compact`) are dispatched
    // through the provider's own protocol rather than delivered as turn text the
    // model would never interpret. Claude's `/compact` reports handled:false and
    // falls through to normal delivery so the SDK handles it as a regular turn
    // (and any trailing focus instructions reach the SDK verbatim). A deferred
    // submission keeps normal queue semantics.
    if (!body.deferred) {
      const parsed = parseSlashCommandSubmission(body.message);
      if (parsed) {
        const providerResult = await process.runProviderCommand(
          parsed.name,
          parsed.argument,
        );
        if (providerResult.handled) {
          if (providerResult.error) {
            return c.json(
              { error: "Failed to run command", reason: providerResult.error },
              409,
            );
          }
          return c.json({ queued: true, serverTimestamp });
        }
      }
    }

    const resolvedModel =
      body.model && body.model !== "default"
        ? body.model
        : (process.resolvedModel ?? process.model);
    const modelInfoService = deps.modelInfoService;
    const resolveContextWindow = modelInfoService
      ? (model: string | undefined, provider?: ProviderName) =>
          modelInfoService.getContextWindow(model, provider)
      : getModelContextWindow;

    let compactQueued = false;
    if (!body.deferred && !body.thinking && body.model === undefined) {
      const compactAttempt = await tryQueueTargetedAutoCompact({
        process,
        model: resolvedModel,
        message: body.message,
        resolveContextWindow,
      });
      compactQueued = compactAttempt.queued;
    }

    // Deferred messages stay server-side until Process reaches a safe delivery
    // boundary. If the process is already idle, Process can accept them now.
    if (body.deferred) {
      if (body.mode) {
        process.setPermissionMode(body.mode);
      }
      await process.primeSupportedCommandsForMessage(userMessage);
      const deferredResult = process.deferMessage(userMessage, {
        promoteIfReady: true,
      });
      if (!deferredResult.success) {
        return c.json(
          {
            error: "Failed to queue message",
            reason: deferredResult.error,
          },
          410,
        );
      }
      await process.waitForPatientQueuePersistenceIdle();
      return c.json({
        queued: true,
        deferred: deferredResult.deferred,
        promoted: deferredResult.promoted,
        position: deferredResult.position,
        deferredMessages: process.getDeferredQueueSummary(),
        serverTimestamp,
      });
    }

    const { thinking, effort } = buildThinkingOptions(body);

    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const metadataExecutor = parseOptionalExecutor(
      deps.sessionMetadataService?.getExecutor(sessionId),
    );
    if (metadataExecutor.error) {
      return c.json({ error: metadataExecutor.error }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }

    const model =
      body.model && body.model !== "default"
        ? body.model
        : (process.resolvedModel ?? process.model);
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    // Per-model preemptive-compaction threshold (task 029). The route holds the
    // settings; the Supervisor stays settings-agnostic. Key strictly by the YA
    // model id: the alias the user picked this turn, else the live requested
    // alias, else the alias persisted at launch (survives restart), else the
    // provider's reported→YA-id helper for sessions YA didn't start. No family
    // fallback. See topics/provider-abstraction.md § Per-model settings keying.
    const yaModelId =
      body.model ??
      process.requestedModel ??
      deps.sessionMetadataService?.getRequestedModel(sessionId) ??
      getProvider(process.provider)?.yaModelIdForReported?.(
        process.resolvedModel,
      );
    const compactAtContextPercent = resolveCompactPercent(
      deps.serverSettingsService?.getSetting("clientDefaults")
        ?.compactAtContextPercent,
      yaModelId,
    );
    // Resolve the effective window here too — process.contextWindow is
    // unreliable (often undefined) and the base resolver ignores always-1M.
    const compactAtContextWindow =
      compactAtContextPercent === undefined
        ? undefined
        : resolveCompactWindow(
            process.provider,
            [yaModelId, process.resolvedModel, process.model],
            resolveContextWindow,
          );

    // Use queueMessageToSession which handles thinking mode changes
    // If thinking mode changed, it will restart the process automatically
    const queueGlobalInstructions = getGlobalInstructions();
    const result = await deps.supervisor.queueMessageToSession(
      sessionId,
      process.projectPath,
      userMessage,
      body.mode,
      {
        model,
        serviceTier,
        thinking,
        effort,
        providerName: metadataProvider ?? body.provider ?? process.provider,
        executor:
          executor ??
          metadataExecutor.executor ??
          process.executor ??
          undefined,
        globalInstructions: queueGlobalInstructions,
        permissions: body.permissions,
        compactAtContextPercent,
        compactAtContextWindow,
      },
    );

    if (!result.success) {
      return c.json(
        {
          error: "Failed to queue message",
          reason: result.error,
        },
        410,
      ); // 410 Gone - process is no longer available
    }

    return c.json({
      queued: true,
      compactQueued,
      restarted: result.restarted,
      processId: result.process.id,
      serverTimestamp,
    });
  });

  // DELETE /api/sessions/:sessionId/recovered-queue/:queueId - Delete a
  // restart-paused patient queue entry by durable queue id.
  routes.delete("/sessions/:sessionId/recovered-queue/:queueId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const queueId = c.req.param("queueId");
    const service = deps.sessionQueuePersistenceService;
    if (!service) {
      return c.json({ error: "Session queue persistence unavailable" }, 503);
    }

    const item = service
      .listSession(sessionId)
      .find((candidate) => candidate.id === queueId);
    if (item?.kind !== "patient" || item.status !== "paused-after-restart") {
      return c.json({ error: "Recovered queued message not found" }, 404);
    }

    await service.deleteItem(queueId);
    return c.json({
      deleted: true,
      deferredMessages: recoveredPatientQueueSummaries(deps, sessionId),
    });
  });

  const recoveredQueueDeps = {
    sessionQueuePersistenceService: deps.sessionQueuePersistenceService,
    sessionMetadataService: deps.sessionMetadataService,
    supervisor: deps.supervisor,
    getGlobalInstructions,
    persistLaunchMetadata,
  };

  // POST /api/sessions/:sessionId/recovered-queue/:queueId/resume - Move
  // restart-paused patient queue entries back into the live patient queue,
  // through the requested entry: resuming a non-head entry also resumes every
  // recovered entry before it, so compose order is preserved.
  routes.post(
    "/sessions/:sessionId/recovered-queue/:queueId/resume",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const queueId = c.req.param("queueId");
      const resolved = await resolveRecoveredGroupForDelivery(
        recoveredQueueDeps,
        sessionId,
        queueId,
        "Drain or cancel newer queued messages before resuming recovered work.",
      );
      if (!resolved.ok) {
        return c.json(resolved.body, resolved.status);
      }
      const { process, group } = resolved;

      const { last, error } = await resumeRecoveredGroup(process, group, {
        promoteIfReady: true,
      });
      if (error || !last) {
        return c.json(
          {
            error: "Failed to resume recovered queued message",
            reason: error,
            deferredMessages: sessionQueueSummaries(deps, sessionId, process),
          },
          409,
        );
      }

      await process.waitForPatientQueuePersistenceIdle();
      return c.json({
        resumed: true,
        resumedCount: group.length,
        deferred: last.deferred,
        promoted: last.promoted,
        position: last.position,
        processId: process.id,
        processState: reportableProcessState(process),
        permissionMode: process.permissionMode,
        modeVersion: process.modeVersion,
        recapAfterSeconds: process.recapAfterSeconds,
        deferredMessages: sessionQueueSummaries(deps, sessionId, process),
        serverTimestamp: Date.now(),
      });
    },
  );

  // POST /api/sessions/:sessionId/recovered-queue/:queueId/steer - Steer a
  // restart-paused patient queue entry into the session now, without waiting
  // for verified quiet: the entry and every recovered or live patient entry
  // composed before it rejoin the live queue and steer in compose order.
  routes.post(
    "/sessions/:sessionId/recovered-queue/:queueId/steer",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const queueId = c.req.param("queueId");
      const resolved = await resolveRecoveredGroupForDelivery(
        recoveredQueueDeps,
        sessionId,
        queueId,
        "Drain or cancel newer queued messages before steering recovered work.",
      );
      if (!resolved.ok) {
        return c.json(resolved.body, resolved.status);
      }
      const { process, group } = resolved;

      const { lastMessage, error } = await resumeRecoveredGroup(
        process,
        group,
        { promoteIfReady: false },
      );
      if (error || !lastMessage?.tempId) {
        return c.json(
          {
            error: "Failed to steer recovered queued message",
            reason: error,
            deferredMessages: sessionQueueSummaries(deps, sessionId, process),
          },
          409,
        );
      }

      const steerResult = process.steerPatientDeferredMessagesThrough(
        lastMessage.tempId,
      );
      if (!steerResult.success) {
        return c.json(
          {
            error:
              steerResult.error ?? "Failed to steer recovered queued message",
            deferredMessages: sessionQueueSummaries(deps, sessionId, process),
          },
          409,
        );
      }

      await process.waitForPatientQueuePersistenceIdle();
      return c.json({
        steered: true,
        count: steerResult.steered,
        processId: process.id,
        processState: reportableProcessState(process),
        permissionMode: process.permissionMode,
        modeVersion: process.modeVersion,
        recapAfterSeconds: process.recapAfterSeconds,
        deferredMessages: sessionQueueSummaries(deps, sessionId, process),
        serverTimestamp: Date.now(),
      });
    },
  );

  // DELETE /api/sessions/:sessionId/deferred/:tempId - Cancel a deferred message
  routes.delete("/sessions/:sessionId/deferred/:tempId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const tempId = c.req.param("tempId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    const cancelled = process.cancelDeferredMessage(tempId);
    if (!cancelled) {
      return c.json({ error: "Deferred message not found" }, 404);
    }

    await process.waitForPatientQueuePersistenceIdle();
    return c.json({ cancelled: true });
  });

  // DELETE /api/sessions/:sessionId/steering/:tempId - Cancel a sent steering
  // message that has not yet been consumed by the provider.
  routes.delete("/sessions/:sessionId/steering/:tempId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const tempId = c.req.param("tempId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    const cancelled = process.cancelUnconfirmedSteerMessage(tempId);
    if (!cancelled) {
      return c.json(
        { error: "Steering message already acted on or not found" },
        404,
      );
    }

    return c.json({ cancelled: true });
  });

  // POST /api/sessions/:sessionId/deferred/:tempId/steer - Steer a patient
  // queued message, and every patient entry ahead of it, into the session now.
  routes.post("/sessions/:sessionId/deferred/:tempId/steer", async (c) => {
    const sessionId = c.req.param("sessionId");
    const tempId = c.req.param("tempId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    const result = process.steerPatientDeferredMessagesThrough(tempId);
    if (!result.success) {
      const status = result.error === "Deferred message not found" ? 404 : 409;
      return c.json({ error: result.error }, status);
    }

    await process.waitForPatientQueuePersistenceIdle();
    return c.json({
      steered: true,
      count: result.steered,
      // Include any still-paused recovered entries so the client's list does
      // not lose their chips when a live entry is steered.
      deferredMessages: sessionQueueSummaries(deps, sessionId, process),
    });
  });

  // PUT /api/sessions/:sessionId/mode - Update permission mode without sending a message
  routes.put("/sessions/:sessionId/mode", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ mode: PermissionMode }>();

    if (!body.mode) {
      return c.json({ error: "mode is required" }, 400);
    }

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    process.setPermissionMode(body.mode);

    return c.json({
      permissionMode: process.permissionMode,
      modeVersion: process.modeVersion,
    });
  });

  // GET /api/sessions/:sessionId/pending-input - Get pending input request
  routes.get("/sessions/:sessionId/pending-input", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ request: null });
    }

    // Use getPendingInputRequest which works for both mock and real SDK
    const request = process.getPendingInputRequest();
    return c.json({ request });
  });

  // GET /api/sessions/:sessionId/process - Get process info for a session
  routes.get("/sessions/:sessionId/process", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ process: null });
    }

    return c.json({ process: process.getInfo() });
  });

  // POST /api/sessions/:sessionId/input - Respond to input request
  routes.post("/sessions/:sessionId/input", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    let body: InputResponseBody;
    try {
      body = await c.req.json<InputResponseBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.requestId || !body.response) {
      return c.json({ error: "requestId and response are required" }, 400);
    }

    // Handle approve_accept_edits: approve and switch permission mode
    const isApproveAcceptEdits = body.response === "approve_accept_edits";

    // Normalize response to approve/deny
    const normalizedResponse =
      body.response === "approve" ||
      body.response === "allow" ||
      body.response === "approve_accept_edits"
        ? "approve"
        : "deny";

    const requestBefore = process.getPendingInputRequest();
    const permissionModeBefore = process.permissionMode;

    if (process.state.type !== "waiting-input") {
      if (isApprovalAuditLogEnabled(deps)) {
        try {
          await appendApprovalAuditLog(deps.dataDir, {
            timestamp: new Date().toISOString(),
            sessionId,
            processId: process.id,
            provider: process.provider,
            requestId: body.requestId,
            request: requestBefore,
            response: body.response,
            normalizedResponse,
            answers: body.answers,
            feedback: body.feedback,
            accepted: false,
            failure: "No pending input request",
            permissionModeBefore,
            permissionModeAfter: process.permissionMode,
          });
        } catch (error) {
          console.warn("[approval-audit] Failed to append audit log:", error);
        }
      }
      return c.json({ error: "No pending input request" }, 400);
    }

    // Call respondToInput which resolves the SDK's canUseTool promise
    const accepted = process.respondToInput(
      body.requestId,
      normalizedResponse,
      body.answers,
      body.feedback,
    );

    if (!accepted) {
      if (isApprovalAuditLogEnabled(deps)) {
        try {
          await appendApprovalAuditLog(deps.dataDir, {
            timestamp: new Date().toISOString(),
            sessionId,
            processId: process.id,
            provider: process.provider,
            requestId: body.requestId,
            request: requestBefore,
            response: body.response,
            normalizedResponse,
            answers: body.answers,
            feedback: body.feedback,
            accepted: false,
            failure: "Invalid request ID or no pending request",
            permissionModeBefore,
            permissionModeAfter: process.permissionMode,
          });
        } catch (error) {
          console.warn("[approval-audit] Failed to append audit log:", error);
        }
      }
      return c.json({ error: "Invalid request ID or no pending request" }, 400);
    }

    // If approve_accept_edits, switch the permission mode
    if (isApproveAcceptEdits) {
      process.setPermissionMode("acceptEdits");
    }

    const pendingInputRequest = process.getPendingInputRequest();
    if (isApprovalAuditLogEnabled(deps)) {
      try {
        await appendApprovalAuditLog(deps.dataDir, {
          timestamp: new Date().toISOString(),
          sessionId,
          processId: process.id,
          provider: process.provider,
          requestId: body.requestId,
          request: requestBefore,
          response: body.response,
          normalizedResponse,
          answers: body.answers,
          feedback: body.feedback,
          accepted: true,
          permissionModeBefore,
          permissionModeAfter: process.permissionMode,
        });
      } catch (error) {
        console.warn("[approval-audit] Failed to append audit log:", error);
      }
    }

    return c.json({ accepted: true, pendingInputRequest });
  });

  // POST /api/sessions/:sessionId/mark-seen - Mark session as seen (read)
  routes.post("/sessions/:sessionId/mark-seen", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    let body: { timestamp?: string; messageId?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional
    }

    await deps.notificationService.markSeen(
      sessionId,
      body.timestamp,
      body.messageId,
    );

    return c.json({ marked: true });
  });

  // DELETE /api/sessions/:sessionId/mark-seen - Mark session as unread
  routes.delete("/sessions/:sessionId/mark-seen", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    await deps.notificationService.clearSession(sessionId);

    // Emit event so other tabs/clients can update
    if (deps.eventBus) {
      deps.eventBus.emit({
        type: "session-seen",
        sessionId,
        timestamp: "", // Empty timestamp signals "unread"
      });
    }

    return c.json({ marked: false });
  });

  // GET /api/notifications/last-seen - Get all last seen entries
  routes.get("/notifications/last-seen", async (c) => {
    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    return c.json({ lastSeen: deps.notificationService.getAllLastSeen() });
  });

  // GET /api/debug/metadata - Debug endpoint to inspect metadata service state
  routes.get("/debug/metadata", (c) => {
    if (!deps.sessionMetadataService) {
      return c.json(
        { error: "Session metadata service not available", available: false },
        503,
      );
    }

    const allMetadata = deps.sessionMetadataService.getAllMetadata();
    const sessionCount = Object.keys(allMetadata).length;
    const starredCount = Object.values(allMetadata).filter(
      (m) => m.isStarred,
    ).length;
    const archivedCount = Object.values(allMetadata).filter(
      (m) => m.isArchived,
    ).length;
    const filePath = deps.sessionMetadataService.getFilePath();

    return c.json({
      available: true,
      filePath,
      sessionCount,
      starredCount,
      archivedCount,
    });
  });

  // PUT /api/sessions/:sessionId/metadata - Update session metadata
  routes.put("/sessions/:sessionId/metadata", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.sessionMetadataService) {
      return c.json({ error: "Session metadata service not available" }, 503);
    }

    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = parseSessionMetadataPatch(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const { patch } = parsed;

    await deps.sessionMetadataService.updateMetadata(sessionId, patch);

    // Emit SSE event so sidebar and other clients can update
    if (deps.eventBus) {
      deps.eventBus.emit({
        type: "session-metadata-changed",
        sessionId,
        title: patch.title,
        archived: patch.archived,
        starred: patch.starred,
        parentSessionId: patch.parentSessionId,
        heartbeatTurnsEnabled: patch.heartbeatTurnsEnabled,
        heartbeatTurnsAfterMinutes: patch.heartbeatTurnsAfterMinutes,
        heartbeatTurnText: patch.heartbeatTurnText,
        heartbeatForceAfterMinutes: patch.heartbeatForceAfterMinutes,
        promptSuggestionMode: patch.promptSuggestionMode ?? undefined,
        recapAfterSeconds: patch.recapAfterSeconds ?? undefined,
        timestamp: new Date().toISOString(),
      });
    }

    return c.json({ updated: true });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/clone - Clone a session
  routes.post("/projects/:projectId/sessions/:sessionId/clone", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Check provider supports cloning
    const supportedProviders = ["claude", "codex", "codex-oss"];
    if (!supportedProviders.includes(project.provider)) {
      return c.json(
        { error: `Clone is not supported for ${project.provider} sessions` },
        400,
      );
    }

    let body: {
      title?: string;
      provider?: ProviderName;
      parentSessionId?: string | null;
    } = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional
    }

    if (
      body.parentSessionId !== undefined &&
      body.parentSessionId !== null &&
      typeof body.parentSessionId !== "string"
    ) {
      return c.json({ error: "parentSessionId must be a string or null" }, 400);
    }
    const parentSessionId =
      typeof body.parentSessionId === "string"
        ? body.parentSessionId.trim() || undefined
        : undefined;

    try {
      // Get session directory from project
      const sessionDir = project.sessionDir;
      if (!sessionDir) {
        return c.json({ error: "Session directory not found" }, 500);
      }

      // Resolve bounded source/title metadata without treating it as a
      // complete transcript summary.
      const originalResolution = await findSessionListSummaryAcrossProviders(
        project,
        sessionId,
        projectId,
        providerResolutionDeps(deps),
        body.provider,
      );
      const originalSession = originalResolution?.summary ?? null;
      let cloneProvider: ProviderName =
        originalResolution?.source.provider ?? project.provider;

      let result: { newSessionId: string; entries: number };

      const shouldCloneFromCodex =
        isCodexProviderName(body.provider) ||
        isCodexProviderName(originalResolution?.source.provider) ||
        isCodexProviderName(project.provider) ||
        (!originalSession && project.provider === "claude");

      if (shouldCloneFromCodex) {
        const codexReader = getCodexReader(project.path);
        if (!codexReader) {
          return c.json({ error: "Codex session reader not available" }, 500);
        }
        const filePath = await codexReader.getSessionFilePath(sessionId);
        if (!filePath) {
          return c.json({ error: "Session file not found" }, 404);
        }

        cloneProvider =
          originalResolution?.source.provider ??
          body.provider ??
          (isCodexProviderName(project.provider) ? project.provider : "codex");
        result = await cloneCodexSession(filePath);
        codexReader.invalidateCache();
        deps.codexScanner?.invalidateCache();
      } else {
        result = await cloneClaudeSession(sessionDir, sessionId);
      }

      // Build clone title: use provided title, or derive from original
      let cloneTitle = body.title;
      if (!cloneTitle && deps.sessionMetadataService) {
        // Check for custom title first, then fall back to auto-generated title
        const originalMetadata =
          deps.sessionMetadataService.getMetadata(sessionId);
        const originalTitle =
          originalMetadata?.customTitle ?? originalSession?.title;
        if (originalTitle) {
          cloneTitle = `${originalTitle} [cloned]`;
        }
      }

      // Set clone metadata. /btw asides pass parentSessionId so the child
      // can jump back into the parent viewport.
      if ((cloneTitle || parentSessionId) && deps.sessionMetadataService) {
        await deps.sessionMetadataService.updateMetadata(result.newSessionId, {
          title: cloneTitle,
          parentSessionId,
        });
      }

      return c.json({
        sessionId: result.newSessionId,
        messageCount: result.entries,
        clonedFrom: sessionId,
        provider: cloneProvider,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to clone session";
      return c.json({ error: message }, 500);
    }
  });

  return routes;
}
