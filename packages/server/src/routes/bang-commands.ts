/**
 * Routes for `!!` bang commands: run/kill/delete a command, fetch full
 * output (rendered server-side), completion candidates, and the
 * cross-session history listing. Contract: topics/bang-commands.md.
 */

import {
  isUrlProjectId,
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
  listAcliArgCompletions,
  listBangCommandCompletions,
  listBangPathCompletions,
} from "../services/bangCompletions.js";

const COMMAND_MAX_CHARS = 8192;

export interface BangCommandsDeps {
  scanner: ProjectScanner;
  sessionMetadataService: SessionMetadataService;
  bangCommandService: BangCommandService;
  bangCommandsEnabled: () => boolean;
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

export function createBangCommandsRoutes(deps: BangCommandsDeps): Hono {
  const routes = new Hono();

  const requireBangCommandsEnabled: MiddlewareHandler = async (c, next) => {
    if (!deps.bangCommandsEnabled()) {
      return c.json({ error: "Bang commands are disabled" }, 404);
    }
    await next();
  };
  routes.use("/bang-commands", requireBangCommandsEnabled);
  routes.use(
    "/projects/:projectId/bang-completions",
    requireBangCommandsEnabled,
  );
  routes.use(
    "/projects/:projectId/sessions/:sessionId/bang-commands",
    requireBangCommandsEnabled,
  );
  routes.use(
    "/projects/:projectId/sessions/:sessionId/bang-commands/*",
    requireBangCommandsEnabled,
  );

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
    if (kind === "path" && line) {
      const acli = await listAcliArgCompletions({
        line,
        projectPath: project.path,
      });
      if (acli && acli.length > 0) {
        return c.json({ completions: acli });
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
    return c.json({ completions });
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
