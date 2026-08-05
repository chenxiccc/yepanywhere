/**
 * Session reader interface for provider-agnostic session reading.
 *
 * Each provider (Claude, Codex, Gemini) has different JSONL formats,
 * but all readers implement this interface to provide a common API.
 */

import type {
  ProviderChildSessionSummary,
  UnifiedSession,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { Message, SessionSummary } from "../supervisor/types.js";

/**
 * Bounded session facts for collection routes that only need identity, title,
 * and recency. Transcript-tail fields intentionally do not belong here.
 */
export interface SessionListSummary {
  id: SessionSummary["id"];
  projectId: SessionSummary["projectId"];
  title: SessionSummary["title"];
  fullTitle: SessionSummary["fullTitle"];
  updatedAt: SessionSummary["updatedAt"];
  provider: SessionSummary["provider"];
  customTitle?: SessionSummary["customTitle"];
  isArchived?: SessionSummary["isArchived"];
  isStarred?: SessionSummary["isStarred"];
}

export function toSessionListSummary(
  summary: Pick<
    SessionSummary,
    | "id"
    | "projectId"
    | "title"
    | "fullTitle"
    | "updatedAt"
    | "provider"
    | "customTitle"
    | "isArchived"
    | "isStarred"
  >,
): SessionListSummary {
  return {
    id: summary.id,
    projectId: summary.projectId,
    title: summary.title,
    fullTitle: summary.fullTitle,
    updatedAt: summary.updatedAt,
    provider: summary.provider,
    ...(summary.customTitle !== undefined
      ? { customTitle: summary.customTitle }
      : {}),
    ...(summary.isArchived !== undefined
      ? { isArchived: summary.isArchived }
      : {}),
    ...(summary.isStarred !== undefined
      ? { isStarred: summary.isStarred }
      : {}),
  };
}

/**
 * Options for reading a session.
 */
export interface GetSessionOptions {
  /** Include orphaned tool use detection (default: true, only applicable for Claude) */
  includeOrphans?: boolean;
}

export type SessionSummaryReadMode = "full" | "head";

/**
 * Options for reading summary metadata.
 */
export interface GetSessionSummaryOptions {
  /**
   * `head` permits a provider to stop after stable head metadata. It preserves
   * the SessionSummary wire shape but may omit tail-derived optional fields
   * such as contextUsage and may use a minimal compatible messageCount.
   */
  readMode?: SessionSummaryReadMode;
}

// Return type that includes both the computed summary and the raw provider data
export interface LoadedSession {
  summary: SessionSummary;
  data: UnifiedSession;
}

/**
 * Common interface for session readers across providers.
 *
 * Provider-specific readers may have additional methods beyond this interface.
 * For example, ClaudeSessionReader has getAgentSession() for subagent support.
 */
export interface ISessionReader {
  /**
   * Release any reader-owned resources such as parser child processes.
   */
  close?(): void | Promise<void>;

  /**
   * List all sessions in this reader's session directory.
   */
  listSessions(projectId: UrlProjectId): Promise<SessionSummary[]>;

  /**
   * Fast, on-demand recompute of the hover-card recent-activity excerpt
   * (last regular agent turn) for one session, without a full parse. Optional:
   * providers that do not populate `SessionSummary.lastAgentText` omit it.
   * See topics/session-hovercard-recent-activity.md.
   */
  getLastAgentExcerpt?(sessionId: string): Promise<string | undefined>;

  /**
   * Get summary metadata for a single session.
   */
  getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
    options?: GetSessionSummaryOptions,
  ): Promise<SessionSummary | null>;

  /**
   * Read only the bounded facts needed by lightweight collection routes.
   *
   * Providers should implement this only when they can bound the work
   * independently of transcript-tail size.
   */
  getSessionListSummary?(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionListSummary | null>;

  /**
   * Get full session with messages.
   * @param sessionId - The session ID
   * @param projectId - The project ID
   * @param afterMessageId - Only return messages after this ID (for incremental fetching)
   * @param options - Additional options
   */
  getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    options?: GetSessionOptions,
  ): Promise<LoadedSession | null>;

  /**
   * Get session summary only if the file has changed since cached values.
   * Used for cache invalidation.
   *
   * @param sessionId - The session ID
   * @param projectId - The project ID
   * @param cachedMtime - The mtime (ms since epoch) from the cache
   * @param cachedSize - The file size (bytes) from the cache
   * @returns Summary with file stats if changed, null if unchanged
   */
  getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null>;

  /**
   * Get mappings from tool use IDs to agent session IDs.
   * Used for Claude's Task tool to link tool_use to subagent sessions.
   * Non-Claude providers should return an empty array.
   */
  getAgentMappings(
    parentSessionId?: string,
  ): Promise<{ toolUseId: string; agentId: string }[]>;

  /**
   * Get an agent (subagent) session by ID.
   * Used for Claude's Task tool subagent sessions (agent-*.jsonl files).
   * Non-Claude providers should return null.
   */
  getAgentSession(
    agentId: string,
    parentSessionId?: string,
  ): Promise<{ messages: Message[]; status: string } | null>;

  /**
   * List provider-native child work attached to one canonical YA session.
   * Readers without provider child sessions omit this method.
   */
  listProviderChildSessions?(
    parentSessionId: string,
  ): Promise<ProviderChildSessionSummary[]>;

  /**
   * Return the latest accepted child projection and start any needed refresh
   * in the background. Implementations must not wait for provider storage.
   * `undefined` means this freshness tier is unsupported; an empty array is a
   * supported cold or child-free projection.
   */
  listAcceptedProviderChildSessions?(
    parentSessionId: string,
  ): ProviderChildSessionSummary[] | undefined;

  /**
   * Get the file path for a session by ID.
   * Used for operations that need direct file access (e.g., cloning).
   * Returns null if the session is not found.
   */
  getSessionFilePath?(sessionId: string): Promise<string | null>;

  /**
   * Enumerate session files in a directory with their IDs.
   * Used by SessionIndexService for providers where the session ID
   * can't be derived from the filename (e.g., Gemini JSON files).
   *
   * When not implemented, the index service falls back to JSONL
   * filename-based enumeration.
   *
   * `sharedFilePath: true` marks an entry whose filePath is a container
   * shared by many sessions (e.g. a provider database). Its stat mtime/size
   * say nothing about this session, so the index must validate it through
   * getSessionSummaryIfChanged instead of comparing file stats.
   */
  listSessionFiles?(
    sessionDir: string,
    options?: { activeAfterMs?: number },
  ): Promise<
    { sessionId: string; filePath: string; sharedFilePath?: boolean }[]
  >;

  /**
   * Return a stable cache/index scope key for this reader.
   *
   * Most providers can use the physical sessionDir directly, but providers like
   * Codex/Gemini share a single root session directory across many projects and
   * rely on reader-level filtering. Those readers should return a key that also
   * includes the logical project scope to avoid cache/index contamination.
   */
  getIndexScopeKey?(sessionDir: string): string;
}
