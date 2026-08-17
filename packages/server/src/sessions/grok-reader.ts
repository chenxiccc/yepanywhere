/**
 * GrokSessionReader - Reads Grok Build sessions from ~/.grok/sessions.
 *
 * Grok stores sessions at:
 *   ~/.grok/sessions/<encodeURIComponent(cwd)>/<uuid>/
 *     - summary.json
 *     - chat_history.jsonl
 *     - events.jsonl
 *     - updates.jsonl
 *     - ...
 *
 * YA is deliberately agnostic about the exact string used as a session ID in
 * URLs and internal references. Per guidance: for Grok we use whatever
 * identifier is most easily locatable directly in Grok Build's own records.
 *
 * The most locatable identifier is the subdirectory name under
 * ~/.grok/sessions/<encoded-cwd>/. This is the value that appears on disk
 * and is also present as `info.id` inside summary.json (and is the sessionId
 * returned by the ACP `newSession` / `resumeSession` calls).
 *
 * We therefore treat the directory basename (and `summary.info.id` when
 * present) as the canonical durable ID for Grok sessions. No synthetic
 * YA-level UUID is layered on top.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ProviderChildSessionSummary,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { attachToolResultMediaCandidates } from "../media/inlineImageData.js";
import {
  type NormalizedGrokToolState,
  buildGrokStructuredToolResult,
  formatGrokToolResultContent,
  grokToolResultMediaCandidate,
  hasGrokToolUseMetadata,
  isTerminalGrokToolUpdate,
  normalizeGrokToolUpdate,
} from "../sdk/providers/grok-tool-normalization.js";
import type { Message, SessionSummary } from "../supervisor/types.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";
import { sortProviderChildSessions } from "./types.js";
import {
  GROK_SESSIONS_DIR,
  canonicalizeProjectPath,
  getProjectIdentityKey,
} from "../projects/paths.js";

export interface GrokSessionReaderOptions {
  /** Override for testing (defaults to ~/.grok/sessions) */
  sessionsDir?: string;
  /** Filter to sessions belonging to this exact cwd */
  projectPath?: string;
}

type GrokToolState = NormalizedGrokToolState & {
  message: Message;
  resultEmitted: boolean;
};

type GrokTextBuffer = {
  content: string;
  kind: "text" | "thinking";
  role: "assistant" | "user";
  timestamp?: string;
};

interface GrokSessionInfo {
  /**
   * The canonical durable ID for this Grok session.
   *
   * This is the identifier most easily locatable in Grok's own records:
   * the basename of the session directory under ~/.grok/sessions/<encoded-cwd>/.
   * It matches `summary.json:info.id` and the sessionId returned by the
   * ACP protocol from `grok agent stdio`.
   */
  id: string;

  /** The actual directory name on disk (the most direct locatable key). */
  dirBasename: string;

  dirPath: string;
  cwd: string;
  summaryPath: string;
  mtime: number;
  size: number;
}

export class GrokSessionReader implements ISessionReader {
  private sessionsDir: string;
  private projectPath?: string;
  private projectIdentityKey?: string;

  private sessionCache: Map<string, GrokSessionInfo> = new Map();
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 5000;

  constructor(options: GrokSessionReaderOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? GROK_SESSIONS_DIR;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
    this.projectIdentityKey = this.projectPath
      ? getProjectIdentityKey(this.projectPath)
      : undefined;
  }

  private async scanSessions(): Promise<GrokSessionInfo[]> {
    const now = Date.now();
    if (
      now - this.cacheTimestamp < this.CACHE_TTL_MS &&
      this.sessionCache.size > 0
    ) {
      return Array.from(this.sessionCache.values());
    }

    this.sessionCache.clear();

    let cwdDirs: string[];
    try {
      cwdDirs = await readdir(this.sessionsDir);
    } catch {
      return [];
    }

    const targetCwd = this.projectIdentityKey;

    for (const encoded of cwdDirs) {
      if (encoded === "session_search.sqlite") continue;

      let decodedCwd: string;
      try {
        decodedCwd = decodeURIComponent(encoded);
      } catch {
        continue;
      }

      const normalized = canonicalizeProjectPath(decodedCwd);
      if (targetCwd && getProjectIdentityKey(normalized) !== targetCwd) {
        continue;
      }

      const cwdDir = join(this.sessionsDir, encoded);
      let uuids: string[];
      try {
        uuids = await readdir(cwdDir);
      } catch {
        continue;
      }

      for (const uuid of uuids) {
        const sessionDir = join(cwdDir, uuid);
        const summaryPath = join(sessionDir, "summary.json");

        try {
          const st = await stat(summaryPath);
          const raw = await readFile(summaryPath, "utf-8");
          const summary = JSON.parse(raw);

          // Prefer the on-disk directory name as the primary locatable ID.
          // Fall back to (or cross-check against) the ID inside summary.json.
          const nativeId = summary.info?.id ?? uuid;

          const info: GrokSessionInfo = {
            id: nativeId,
            dirBasename: uuid,
            dirPath: sessionDir,
            cwd: summary.info?.cwd ?? decodedCwd,
            summaryPath,
            mtime: st.mtimeMs,
            size: st.size,
          };
          this.sessionCache.set(info.id, info);
        } catch {
          // Not a valid Grok session dir (missing or bad summary.json)
        }
      }
    }

    this.cacheTimestamp = now;
    return Array.from(this.sessionCache.values());
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const sessions = await this.scanSessions();
    const childIds = await this.collectProviderChildIds(sessions);
    const out: SessionSummary[] = [];

    for (const s of sessions) {
      if (childIds.has(s.id) || childIds.has(s.dirBasename)) {
        continue;
      }
      try {
        const raw = await readFile(s.summaryPath, "utf-8");
        const data = JSON.parse(raw);
        const summaryId = data.info?.id ?? s.id;
        if (childIds.has(summaryId)) {
          continue;
        }

        const summary: SessionSummary = {
          id: summaryId,
          projectId,
          ownership: { owner: "none" as const },
          createdAt: data.created_at ?? new Date(s.mtime).toISOString(),
          updatedAt:
            data.updated_at ??
            data.last_active_at ??
            new Date(s.mtime).toISOString(),
          title: data.generated_title ?? data.session_summary ?? null,
          fullTitle: data.session_summary ?? data.generated_title ?? null,
          messageCount: data.num_messages ?? data.num_chat_messages ?? 0,
          provider: "grok",
          model: data.current_model_id ?? "grok-build",
        };
        out.push(summary);
      } catch {
        // skip bad summary
      }
    }

    return out;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const sessions = await this.scanSessions();
    // Look up by the canonical ID first (the one from info.id / ACP protocol).
    // Fall back to the raw directory basename on disk — this is the identifier
    // that is most easily locatable directly in Grok Build's own records.
    let info = sessions.find((s) => s.id === sessionId);
    if (!info) {
      info = sessions.find((s) => s.dirBasename === sessionId);
    }
    if (!info) return null;

    try {
      const raw = await readFile(info.summaryPath, "utf-8");
      const data = JSON.parse(raw);

      return {
        id: data.info?.id ?? sessionId,
        projectId,
        ownership: { owner: "none" as const },
        createdAt: data.created_at ?? new Date(info.mtime).toISOString(),
        updatedAt:
          data.updated_at ??
          data.last_active_at ??
          new Date(info.mtime).toISOString(),
        title: data.generated_title ?? data.session_summary ?? null,
        fullTitle: data.session_summary ?? data.generated_title ?? null,
        messageCount: data.num_messages ?? data.num_chat_messages ?? 0,
        provider: "grok",
        model: data.current_model_id ?? "grok-build",
      };
    } catch {
      return null;
    }
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    _projectId: UrlProjectId,
    cachedMtime: number,
    _cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const sessions = await this.scanSessions();
    let info = sessions.find((s) => s.id === sessionId);
    if (!info) {
      info = sessions.find((s) => s.dirBasename === sessionId);
    }
    if (!info) return null;

    if (info.mtime <= cachedMtime) {
      return null;
    }

    const summary = await this.getSessionSummary(sessionId, "" as UrlProjectId);
    if (!summary) return null;

    return {
      summary,
      mtime: info.mtime,
      size: info.size,
    };
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const sessions = await this.scanSessions();
    const info = this.findSessionInfo(sessions, sessionId);
    if (!info) return null;

    const summary = await this.getSessionSummary(sessionId, projectId);
    if (!summary) return null;

    const messages = await this.loadUpdatesMessages(info);
    const filteredMessages = afterMessageId
      ? this.messagesAfter(messages, afterMessageId)
      : messages;

    return {
      summary: {
        ...summary,
        messageCount: messages.length || summary.messageCount,
      },
      data: {
        provider: "grok",
        session: { messages: filteredMessages },
      },
    };
  }

  private findSessionInfo(
    sessions: GrokSessionInfo[],
    sessionId: string,
  ): GrokSessionInfo | undefined {
    return (
      sessions.find((s) => s.id === sessionId) ??
      sessions.find((s) => s.dirBasename === sessionId)
    );
  }

  private async loadUpdatesMessages(info: GrokSessionInfo): Promise<Message[]> {
    let raw: string;
    try {
      raw = await readFile(join(info.dirPath, "updates.jsonl"), "utf-8");
    } catch {
      return [];
    }

    const messages: Message[] = [];
    const tools = new Map<string, GrokToolState>();
    let textBuffer: GrokTextBuffer | null = null;

    const flushText = () => {
      textBuffer = this.flushTextBuffer(messages, textBuffer);
    };

    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const record = this.asRecord(parsed);
      const update = this.asRecord(this.asRecord(record?.params)?.update);
      const updateType = this.stringField(update, "sessionUpdate");
      if (!record || !update || !updateType) continue;

      const timestamp = this.timestampFromRecord(record);
      if (updateType === "user_message_chunk") {
        const text = this.textFromUpdate(update);
        if (!text) continue;
        textBuffer = this.appendTextChunk(
          messages,
          textBuffer,
          "user",
          "text",
          text,
          timestamp,
        );
        continue;
      }

      if (updateType === "agent_message_chunk") {
        const text = this.textFromUpdate(update);
        if (!text) continue;
        textBuffer = this.appendTextChunk(
          messages,
          textBuffer,
          "assistant",
          "text",
          text,
          timestamp,
        );
        continue;
      }

      if (updateType === "agent_thought_chunk") {
        const text = this.textFromUpdate(update);
        if (!text) continue;
        textBuffer = this.appendTextChunk(
          messages,
          textBuffer,
          "assistant",
          "thinking",
          text,
          timestamp,
        );
        continue;
      }

      flushText();

      if (updateType === "tool_call") {
        this.upsertToolUseMessage(update, messages, tools, timestamp);
        continue;
      }

      if (updateType === "tool_call_update") {
        const toolState = hasGrokToolUseMetadata(update)
          ? this.upsertToolUseMessage(update, messages, tools, timestamp)
          : this.findToolState(update, tools);
        if (isTerminalGrokToolUpdate(update)) {
          this.appendToolResultMessage(update, messages, toolState, timestamp);
        }
        continue;
      }

      if (updateType === "plan") {
        const entries = this.planEntries(update);
        if (entries.length > 0) {
          messages.push({
            type: "assistant",
            uuid: `grok-plan-${index}`,
            timestamp,
            role: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: entries
                    .map((entry) => `${entry.status}: ${entry.content}`)
                    .join("\n"),
                  grokPlan: { entries },
                },
              ],
            },
          });
        }
      }
    }

    flushText();
    return messages;
  }

  private messagesAfter(
    messages: Message[],
    afterMessageId: string,
  ): Message[] {
    const afterIndex = messages.findIndex((message) => {
      const nestedId = this.stringField(this.asRecord(message.message), "id");
      return (
        message.uuid === afterMessageId ||
        message.id === afterMessageId ||
        nestedId === afterMessageId
      );
    });
    return afterIndex === -1 ? messages : messages.slice(afterIndex + 1);
  }

  private appendTextChunk(
    messages: Message[],
    buffer: GrokTextBuffer | null,
    role: "assistant" | "user",
    kind: "text" | "thinking",
    text: string,
    timestamp?: string,
  ): GrokTextBuffer {
    const sameBuffer = buffer?.role === role && buffer.kind === kind;
    if (!sameBuffer) {
      this.flushTextBuffer(messages, buffer);
    }
    return {
      content: (sameBuffer ? buffer.content : "") + text,
      kind,
      role,
      timestamp: (sameBuffer ? buffer.timestamp : undefined) ?? timestamp,
    };
  }

  private flushTextBuffer(
    messages: Message[],
    buffer: GrokTextBuffer | null,
  ): null {
    if (!buffer?.content.trim()) return null;

    const uuid = `grok-${messages.length}-${buffer.role}-${buffer.kind}`;
    const content =
      buffer.kind === "thinking"
        ? [{ type: "thinking", thinking: buffer.content }]
        : buffer.content;
    messages.push({
      type: buffer.role,
      uuid,
      timestamp: buffer.timestamp,
      role: buffer.role,
      message: {
        role: buffer.role,
        content,
      },
    });
    return null;
  }

  private upsertToolUseMessage(
    update: Record<string, unknown>,
    messages: Message[],
    tools: Map<string, GrokToolState>,
    timestamp?: string,
  ): GrokToolState | undefined {
    const toolCallId = this.stringField(update, "toolCallId");
    if (!toolCallId) return undefined;

    const previous = tools.get(toolCallId);
    const normalized = normalizeGrokToolUpdate(update, previous);
    if (previous) {
      previous.name = normalized.name;
      previous.input = normalized.input;
      previous.meta = normalized.meta;
      previous.nativeName = normalized.nativeName;
      previous.message.toolUse = {
        id: toolCallId,
        name: normalized.name,
        input: normalized.input,
      };
      const content = previous.message.message?.content;
      const block = Array.isArray(content)
        ? this.asRecord(content[0])
        : undefined;
      if (block) {
        block.name = normalized.name;
        block.input = normalized.input;
      }
      return previous;
    }

    const message: Message = {
      type: "assistant",
      uuid: toolCallId,
      timestamp,
      role: "assistant",
      toolUse: {
        id: toolCallId,
        name: normalized.name,
        input: normalized.input,
      },
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolCallId,
            name: normalized.name,
            input: normalized.input,
          },
        ],
      },
    };
    const state: GrokToolState = {
      ...normalized,
      message,
      resultEmitted: false,
    };
    tools.set(toolCallId, state);
    messages.push(message);
    return state;
  }

  private findToolState(
    update: Record<string, unknown>,
    tools: Map<string, GrokToolState>,
  ): GrokToolState | undefined {
    const toolCallId = this.stringField(update, "toolCallId");
    return toolCallId ? tools.get(toolCallId) : undefined;
  }

  private appendToolResultMessage(
    update: Record<string, unknown>,
    messages: Message[],
    state: GrokToolState | undefined,
    timestamp?: string,
  ): void {
    const toolCallId = this.stringField(update, "toolCallId");
    if (!toolCallId || state?.resultEmitted) return;

    const isError =
      this.stringField(update, "status") === "failed" ||
      this.stringField(update, "error") !== undefined;
    const message: Message = {
      type: "user",
      uuid: `${toolCallId}:result`,
      timestamp,
      role: "user",
      toolUseResult: buildGrokStructuredToolResult(update, state),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            is_error: isError,
            content: formatGrokToolResultContent(update, state),
          },
        ],
      },
    };
    const mediaCandidate = grokToolResultMediaCandidate(update);
    if (mediaCandidate) {
      attachToolResultMediaCandidates(message, [mediaCandidate]);
    }
    messages.push(message);
    if (state) state.resultEmitted = true;
  }

  private timestampFromRecord(
    record: Record<string, unknown>,
  ): string | undefined {
    const timestamp = record.timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      return new Date(timestamp * 1000).toISOString();
    }
    if (typeof timestamp === "string") {
      const parsed = new Date(timestamp);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
    }
    return undefined;
  }

  private textFromUpdate(update: Record<string, unknown>): string | undefined {
    const content = this.asRecord(update.content);
    if (content?.type === "text" && typeof content.text === "string") {
      return content.text;
    }
    if (typeof update.content === "string") return update.content;
    return this.stringField(update, "text");
  }

  private planEntries(
    update: Record<string, unknown>,
  ): Array<Record<string, string>> {
    const entries = update.entries;
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      const record = this.asRecord(entry);
      const content = this.stringField(record, "content");
      const status = this.stringField(record, "status") ?? "unknown";
      return content ? [{ content, status }] : [];
    });
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private stringField(
    record: Record<string, unknown> | undefined,
    field: string,
  ): string | undefined {
    const value = record?.[field];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  async getAgentSession(
    agentId: string,
    parentSessionId?: string,
  ): Promise<{
    messages: Message[];
    status: string;
    agentType?: string;
    description?: string;
  } | null> {
    const sessions = await this.scanSessions();
    const child = this.findSessionInfo(sessions, agentId);
    if (!child) {
      return null;
    }
    const meta = parentSessionId
      ? await this.readSubagentMeta(
          this.findSessionInfo(sessions, parentSessionId)?.dirPath,
          agentId,
        )
      : await this.findSubagentMeta(sessions, agentId);
    const messages = (await this.loadUpdatesMessages(child)).map((message) => ({
      ...message,
      isSubagent: true,
    }));
    return {
      messages,
      status: mapGrokSubagentStatus(meta?.status, messages.length),
      ...(meta?.subagent_type ? { agentType: meta.subagent_type } : {}),
      ...(meta?.description ? { description: meta.description } : {}),
    };
  }

  async listProviderChildSessions(
    parentSessionId: string,
  ): Promise<ProviderChildSessionSummary[]> {
    const sessions = await this.scanSessions();
    const parent = this.findSessionInfo(sessions, parentSessionId);
    if (!parent) {
      return [];
    }
    const metas = await this.readParentSubagentMetas(parent.dirPath);
    return sortProviderChildSessions(
      metas.map((meta) => toGrokProviderChildSummary(parentSessionId, meta)),
    );
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const sessions = await this.scanSessions();
    let info = sessions.find((s) => s.id === sessionId);
    if (!info) {
      info = sessions.find((s) => s.dirBasename === sessionId);
    }
    return info ? info.summaryPath : null;
  }

  async listSessionFiles(
    _sessionDir: string,
    _options?: { activeAfterMs?: number },
  ): Promise<{ sessionId: string; filePath: string }[]> {
    const sessions = await this.scanSessions();
    const childIds = await this.collectProviderChildIds(sessions);
    return sessions
      .filter(
        (session) =>
          !childIds.has(session.id) && !childIds.has(session.dirBasename),
      )
      .map((session) => ({
        sessionId: session.id,
        filePath: session.summaryPath,
      }));
  }

  async getSessionProjectPath(sessionId: string): Promise<string | null> {
    const sessions = await this.scanSessions();
    let info = sessions.find((s) => s.id === sessionId);
    if (!info) {
      info = sessions.find((s) => s.dirBasename === sessionId);
    }
    return info ? canonicalizeProjectPath(info.cwd) : null;
  }

  getIndexScopeKey(sessionDir: string): string {
    return `grok::${sessionDir}::${this.projectIdentityKey ?? "*"}`;
  }

  private async collectProviderChildIds(
    sessions: GrokSessionInfo[],
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const session of sessions) {
      for (const meta of await this.readParentSubagentMetas(session.dirPath)) {
        if (meta.subagent_id) ids.add(meta.subagent_id);
        if (meta.child_session_id) ids.add(meta.child_session_id);
      }
    }
    return ids;
  }

  private async findSubagentMeta(
    sessions: GrokSessionInfo[],
    agentId: string,
  ): Promise<GrokSubagentMeta | undefined> {
    for (const session of sessions) {
      const meta = await this.readSubagentMeta(session.dirPath, agentId);
      if (meta) {
        return meta;
      }
    }
    return undefined;
  }

  private async readSubagentMeta(
    parentDir: string | undefined,
    agentId: string,
  ): Promise<GrokSubagentMeta | undefined> {
    if (!parentDir) {
      return undefined;
    }
    return readGrokSubagentMetaFile(
      join(parentDir, "subagents", agentId, "meta.json"),
    );
  }

  private async readParentSubagentMetas(
    parentDir: string,
  ): Promise<GrokSubagentMeta[]> {
    const subagentsDir = join(parentDir, "subagents");
    let names: string[];
    try {
      names = await readdir(subagentsDir);
    } catch {
      return [];
    }
    const metas: GrokSubagentMeta[] = [];
    for (const name of names) {
      const meta = await readGrokSubagentMetaFile(
        join(subagentsDir, name, "meta.json"),
      );
      if (meta) {
        metas.push(meta);
      }
    }
    return metas;
  }
}

interface GrokSubagentMeta {
  subagent_id?: string;
  child_session_id?: string;
  parent_session_id?: string;
  subagent_type?: string;
  description?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
}

async function readGrokSubagentMetaFile(
  path: string,
): Promise<GrokSubagentMeta | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.subagent_id === "string" && {
        subagent_id: record.subagent_id,
      }),
      ...(typeof record.child_session_id === "string" && {
        child_session_id: record.child_session_id,
      }),
      ...(typeof record.parent_session_id === "string" && {
        parent_session_id: record.parent_session_id,
      }),
      ...(typeof record.subagent_type === "string" && {
        subagent_type: record.subagent_type,
      }),
      ...(typeof record.description === "string" && {
        description: record.description,
      }),
      ...(typeof record.status === "string" && { status: record.status }),
      ...(typeof record.started_at === "string" && {
        started_at: record.started_at,
      }),
      ...(typeof record.completed_at === "string" && {
        completed_at: record.completed_at,
      }),
    };
  } catch {
    return undefined;
  }
}

function toGrokProviderChildSummary(
  parentSessionId: string,
  meta: GrokSubagentMeta,
): ProviderChildSessionSummary {
  const id = meta.child_session_id || meta.subagent_id || parentSessionId;
  return {
    id,
    parentSessionId,
    ...(meta.description ? { title: meta.description } : {}),
    ...(meta.subagent_type ? { agentType: meta.subagent_type } : {}),
    updatedAt:
      meta.completed_at || meta.started_at || new Date(0).toISOString(),
  };
}

function mapGrokSubagentStatus(
  status: string | undefined,
  messageCount: number,
): string {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "running" || status === "pending") return "running";
  return messageCount > 0 ? "running" : "pending";
}
