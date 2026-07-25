/**
 * Routes for `!!` bang commands: run/kill/delete a command, fetch full
 * output (rendered server-side), completion candidates, and the
 * cross-session history listing. Contract: topics/bang-commands.md.
 */

import {
  type BangCommandTranscriptDisplayObject,
  isUrlProjectId,
  jsonlTablesToMarkdown,
  looksLikeToon,
  parseToonDocument,
} from "@yep-anywhere/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { BangCommandService } from "../services/BangCommandService.js";
import type { Project } from "../supervisor/types.js";
import {
  BangHistoryIndex,
  listAcliArgCompletions,
  listBangCommandCompletions,
  listBangPathCompletions,
} from "../services/bangCompletions.js";

const COMMAND_MAX_CHARS = 8192;

export interface BangCommandsDeps {
  scanner: ProjectScanner;
  sessionMetadataService: SessionMetadataService;
  bangCommandService: BangCommandService;
  /** Gates only the discoverable top-level "!! Commands" history view. */
  bangHistoryViewEnabled: () => boolean;
  sessionBelongsToProject: (
    project: Project,
    sessionId: string,
  ) => Promise<boolean>;
}

export type BangOutputMode = "markdown" | "json" | "ansi" | "toon" | "raw";

// biome-ignore lint/complexity/useRegexLiterals: constructor form avoids noControlCharactersInRegex noise for the deliberate ANSI CSI probe (mirrors ANSI_ESCAPE_RE in FixedFontMathToggle)
const ANSI_CSI_PROBE = new RegExp(String.raw`\x1b\[`);

/**
 * Classify once, then fork to the standard render paths: markdown flows
 * through the assistant-text pipeline as-is; everything else gets fenced
 * with a tag the augment layer already understands — `json` (shiki),
 * `ansi` (colored HTML), `toon` (flat table → markdown table), or plain.
 * The per-block raw toggle covers heuristic misfires.
 */
export function classifyBangOutput(text: string): BangOutputMode {
  const trimmed = text.trim();
  if (!trimmed) {
    return "raw";
  }
  if (ANSI_CSI_PROBE.test(trimmed.slice(0, 4096))) {
    return "ansi";
  }
  if (looksLikeToon(trimmed)) {
    return parseToonDocument(trimmed) ? "toon" : "raw";
  }
  const first = trimmed[0];
  if (first === "{" || first === "[") {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not a single JSON document; try JSONL below.
    }
    const lines = trimmed
      .split("\n")
      .filter((line) => line.trim())
      .slice(0, 5);
    if (
      lines.length > 0 &&
      lines.every((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      })
    ) {
      return "json";
    }
  }
  return "markdown";
}

function fence(text: string, language: string): string {
  const longestRun = text
    .match(/`+/g)
    ?.reduce((max, run) => Math.max(max, run.length), 0);
  const marker = "`".repeat(Math.max(3, (longestRun ?? 0) + 1));
  return `${marker}${language}\n${text}\n${marker}`;
}

export function buildBangOutputMarkdown(text: string): {
  markdown: string;
  mode: BangOutputMode;
} {
  const mode = classifyBangOutput(text);
  if (mode === "json" || mode === "markdown") {
    // Any run of 2+ consecutive same-key-set JSONL lines (the acli default
    // for list-shaped output, e.g. almanac) renders as a real table, with
    // surrounding prose passed through verbatim — including prose-led output
    // the whole-document classifier calls markdown. The per-block Raw toggle
    // still shows the original lines. Output with no qualifying run falls
    // through to its classified path below.
    const { markdown, tableCount } = jsonlTablesToMarkdown(text);
    if (tableCount > 0) {
      return { markdown, mode: "markdown" };
    }
  }
  switch (mode) {
    case "markdown":
      return { markdown: text, mode };
    case "json":
      return { markdown: fence(text, "json"), mode };
    case "ansi":
      return { markdown: fence(text, "ansi"), mode };
    case "toon":
      return { markdown: fence(text, "toon"), mode };
    default:
      return { markdown: fence(text, ""), mode };
  }
}

/**
 * YA-global bang command lines, most-recent-first and deduped (first/newest
 * occurrence kept), across every session and all time — the same bounded
 * corpus the top-level history view lists. Source for the global
 * command-history completion axis.
 */
function collectGlobalBangCommands(
  sessionMetadataService: SessionMetadataService,
): string[] {
  const commands = sessionMetadataService
    .listTranscriptDisplayObjectSessions()
    .flatMap(({ objects }) =>
      objects.filter(
        (object): object is BangCommandTranscriptDisplayObject =>
          object.kind === "bang-command",
      ),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((object) => object.command);
  return [...new Set(commands)];
}

/** Corpus/index rebuild cadence for history completion (per-keystroke reads). */
const BANG_HISTORY_INDEX_TTL_MS = 5_000;

export function createBangCommandsRoutes(deps: BangCommandsDeps): Hono {
  const routes = new Hono();

  // Execution, per-session object routes, and completions are always-on
  // (vanilla-defaults.md § Known Exceptions: `!!` is an established,
  // deliberately invoked shell-escape). Only the discoverable "!! Commands"
  // history surface stays behind the explicit default-off setting.
  const requireBangHistoryViewEnabled: MiddlewareHandler = async (c, next) => {
    if (!deps.bangHistoryViewEnabled()) {
      return c.json({ error: "Bang command history view is disabled" }, 404);
    }
    await next();
  };
  routes.use("/bang-commands", requireBangHistoryViewEnabled);

  // Cached prefix index over the global command-history corpus: rebuilt at
  // most every BANG_HISTORY_INDEX_TTL_MS instead of rescanning and sorting
  // every session's display objects per completion keystroke. A brand-new run
  // appears in completions after at most one TTL.
  let bangHistoryIndexCache: {
    index: BangHistoryIndex;
    expiresAt: number;
  } | null = null;
  const getBangHistoryIndex = (): BangHistoryIndex => {
    const now = Date.now();
    if (!bangHistoryIndexCache || now >= bangHistoryIndexCache.expiresAt) {
      bangHistoryIndexCache = {
        index: new BangHistoryIndex(
          collectGlobalBangCommands(deps.sessionMetadataService),
        ),
        expiresAt: now + BANG_HISTORY_INDEX_TTL_MS,
      };
    }
    return bangHistoryIndexCache.index;
  };

  const resolveProject = async (projectId: string) => {
    if (!isUrlProjectId(projectId)) {
      return null;
    }
    return await deps.scanner.getOrCreateProject(projectId);
  };

  const findSessionObject = (sessionId: string, objectId: string) =>
    deps.sessionMetadataService
      .getTranscriptDisplayObjects(sessionId)
      .find(
        (object) => object.kind === "bang-command" && object.id === objectId,
      );

  const resolveOwnedSessionProject = async (
    projectId: string,
    sessionId: string,
  ) => {
    const project = await resolveProject(projectId);
    if (!project || !(await deps.sessionBelongsToProject(project, sessionId))) {
      return null;
    }
    return project;
  };

  routes.post(
    "/projects/:projectId/sessions/:sessionId/bang-commands",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const project = await resolveOwnedSessionProject(
        c.req.param("projectId"),
        sessionId,
      );
      if (!project) {
        return c.json({ error: "Session not found in project" }, 404);
      }
      let body: { command?: unknown; placementAfterMessageId?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const command =
        typeof body.command === "string" ? body.command.trim() : "";
      if (!command) {
        return c.json({ error: "command is required" }, 400);
      }
      if (command.length > COMMAND_MAX_CHARS) {
        return c.json({ error: "command is too long" }, 400);
      }
      const placementAfterMessageId =
        typeof body.placementAfterMessageId === "string"
          ? body.placementAfterMessageId
          : "";
      const { object } = await deps.bangCommandService.run({
        sessionId,
        projectPath: project.path,
        command,
        placementAfterMessageId,
      });
      return c.json({
        displayObject: object,
        transcriptDisplayObjects:
          deps.sessionMetadataService.getTranscriptDisplayObjects(sessionId),
      });
    },
  );

  routes.post(
    "/projects/:projectId/sessions/:sessionId/bang-commands/:objectId/kill",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const project = await resolveOwnedSessionProject(
        c.req.param("projectId"),
        sessionId,
      );
      if (!project) {
        return c.json({ error: "Session not found in project" }, 404);
      }
      const objectId = c.req.param("objectId");
      if (!findSessionObject(sessionId, objectId)) {
        return c.json({ error: "Bang command not found" }, 404);
      }
      const killed = deps.bangCommandService.kill(objectId);
      return c.json({ killed });
    },
  );

  routes.get(
    "/projects/:projectId/sessions/:sessionId/bang-commands/:objectId/output",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const project = await resolveOwnedSessionProject(
        c.req.param("projectId"),
        sessionId,
      );
      if (!project) {
        return c.json({ error: "Session not found in project" }, 404);
      }
      const objectId = c.req.param("objectId");
      const object = findSessionObject(sessionId, objectId);
      if (!object) {
        return c.json({ error: "Bang command not found" }, 404);
      }
      const output = await deps.bangCommandService.readOutput(
        sessionId,
        objectId,
      );
      const { markdown, mode } = buildBangOutputMarkdown(output.stdout);
      const stdoutHtml = output.stdout
        ? await renderMarkdownToHtml(markdown)
        : "";
      return c.json({
        stdout: output.stdout,
        stderr: output.stderr,
        stdoutHtml,
        mode,
        responseTruncated: output.responseTruncated,
      });
    },
  );

  routes.delete(
    "/projects/:projectId/sessions/:sessionId/bang-commands/:objectId",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const project = await resolveOwnedSessionProject(
        c.req.param("projectId"),
        sessionId,
      );
      if (!project) {
        return c.json({ error: "Session not found in project" }, 404);
      }
      const objectId = c.req.param("objectId");
      if (!findSessionObject(sessionId, objectId)) {
        return c.json({ error: "Bang command not found" }, 404);
      }
      const removed = await deps.bangCommandService.remove(sessionId, objectId);
      if (!removed) {
        return c.json({ error: "Bang command is still running" }, 409);
      }
      return c.json({
        removed,
        transcriptDisplayObjects:
          deps.sessionMetadataService.getTranscriptDisplayObjects(sessionId),
      });
    },
  );

  routes.get("/projects/:projectId/bang-completions", async (c) => {
    const project = await resolveProject(c.req.param("projectId"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const token = c.req.query("token") ?? "";
    const kind = c.req.query("kind") === "path" ? "path" : "command";
    const line = c.req.query("line") ?? "";
    // Global command history is a separate axis from the token candidates: it
    // prefix-matches the whole `!!` body regardless of command/path position,
    // and the client ranks it ahead of the PATH/project/path candidates.
    const history = line ? getBangHistoryIndex().match(line) : [];
    if (kind === "path" && line) {
      const acli = await listAcliArgCompletions({
        line,
        projectPath: project.path,
      });
      if (acli && acli.length > 0) {
        return c.json({ completions: acli, history });
      }
    }
    const completions =
      kind === "path"
        ? await listBangPathCompletions({
            tokenPrefix: token,
            projectPath: project.path,
          })
        : await listBangCommandCompletions({
            prefix: token,
            projectPath: project.path,
          });
    return c.json({ completions, history });
  });

  routes.get("/bang-commands", (c) => {
    const entries = deps.sessionMetadataService
      .listTranscriptDisplayObjectSessions()
      .flatMap(({ sessionId, workingProjectId, objects }) =>
        objects
          .filter((object) => object.kind === "bang-command")
          .map((object) => ({
            sessionId,
            projectId: workingProjectId,
            object,
          })),
      )
      .sort((a, b) => b.object.createdAt.localeCompare(a.object.createdAt))
      .slice(0, 500);
    return c.json({ entries });
  });

  return routes;
}
