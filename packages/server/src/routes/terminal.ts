import { env, platform } from "node:process";
import { isUrlProjectId } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { Context } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import * as pty from "node-pty";
import type { ProjectScanner } from "../projects/scanner.js";
import { TerminalWorkspaceRegistry } from "../terminal/TerminalWorkspaceRegistry.js";
import type {
  PtyFactory,
  TerminalClientSink,
  TerminalServerMessage,
} from "../terminal/TerminalWorkspaceTypes.js";
import {
  ensureNodePtySpawnHelperExecutable,
  hasExecutableShell,
} from "./node-pty-helper.js";

// biome-ignore lint/suspicious/noExplicitAny: Complex third-party type from @hono/node-ws
type UpgradeWebSocketFn = (createEvents: (c: Context) => WSEvents) => any;

export interface TerminalDeps {
  scanner: ProjectScanner;
  upgradeWebSocket: UpgradeWebSocketFn;
  registry?: TerminalWorkspaceRegistry;
}

type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

function send(ws: WSContext, message: TerminalServerMessage) {
  ws.send(JSON.stringify(message));
}

function getShellCommand(): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: env.ComSpec || "cmd.exe", args: [] };
  }

  const candidates = [env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (hasExecutableShell(candidate)) {
      return { command: candidate, args: ["-i"] };
    }
  }

  return { command: "/bin/sh", args: ["-i"] };
}

function clampTerminalSize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

export function createNodePtyFactory(): PtyFactory {
  return (projectPath: string, cols: number, rows: number): pty.IPty => {
    ensureNodePtySpawnHelperExecutable();
    const shell = getShellCommand();
    // 通过 -c 先执行 stty -echo，再 exec 到交互式 shell
    // 确保 echo 在 shell 接受用户输入前已关闭，避免本地回显 + 服务端回显的双字符
    // Run stty -echo via -c before exec'ing interactive shell,
    // so echo is off before any user input reaches the shell
    const args = ["-c", `stty -echo 2>/dev/null; exec ${shell.command} -i`];
    const ptyProcess = pty.spawn(shell.command, args, {
      cwd: projectPath,
      env: {
        ...env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
      cols,
      rows,
      name: "xterm-256color",
    });
    return ptyProcess;
  };
}

async function validateProjectPath(
  scanner: ProjectScanner,
  projectId: string,
): Promise<string | null> {
  if (!isUrlProjectId(projectId)) {
    return null;
  }

  const project = await scanner.getOrCreateProject(projectId);
  return project?.path ?? null;
}

async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function createTerminalRoutes(deps: TerminalDeps): Hono {
  const routes = new Hono();
  const registry =
    deps.registry ??
    new TerminalWorkspaceRegistry({
      createPty: createNodePtyFactory(),
    });

  const requireProjectPath = async (
    c: Context,
  ): Promise<{ projectId: string; projectPath: string } | Response> => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      return c.json({ error: "Project not found" }, 404);
    }

    const projectPath = await validateProjectPath(deps.scanner, projectId);
    if (!projectPath) {
      return c.json({ error: "Project not found" }, 404);
    }

    return { projectId, projectPath };
  };

  const detachClient = (
    projectId: string,
    tabId: string,
    sink: TerminalClientSink | null,
  ): void => {
    if (!sink) {
      return;
    }

    try {
      registry.detachClient(projectId, tabId, sink);
    } catch {
      // Tab may already be gone.
    }
  };

  routes.get("/projects/:projectId/terminal-tabs", async (c) => {
    const project = await requireProjectPath(c);
    if (project instanceof Response) {
      return project;
    }

    return c.json({ tabs: registry.listTabs(project.projectId) });
  });

  routes.post("/projects/:projectId/terminal-tabs", async (c) => {
    const project = await requireProjectPath(c);
    if (project instanceof Response) {
      return project;
    }

    const body = await parseJsonBody<{
      title?: string;
      cwd?: string;
    }>(c.req.raw);
    const tab = registry.createTab({
      projectId: project.projectId,
      projectPath: project.projectPath,
      title: body?.title,
      cwd: body?.cwd,
    });
    return c.json({ tab });
  });

  routes.patch("/projects/:projectId/terminal-tabs/:tabId", async (c) => {
    const project = await requireProjectPath(c);
    if (project instanceof Response) {
      return project;
    }

    const body = await parseJsonBody<{ title?: string }>(c.req.raw);
    if (!body?.title?.trim()) {
      return c.json({ error: "Title is required" }, 400);
    }

    try {
      const tab = registry.renameTab(
        project.projectId,
        c.req.param("tabId"),
        body.title,
      );
      return c.json({ tab });
    } catch {
      return c.json({ error: "Terminal tab not found" }, 404);
    }
  });

  routes.delete("/projects/:projectId/terminal-tabs/:tabId", async (c) => {
    const project = await requireProjectPath(c);
    if (project instanceof Response) {
      return project;
    }

    try {
      registry.deleteTab(project.projectId, c.req.param("tabId"));
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Terminal tab not found" }, 404);
    }
  });

  routes.get(
    "/projects/:projectId/terminal-tabs/:tabId/ws",
    deps.upgradeWebSocket((c) => {
      const projectId = c.req.param("projectId") as string;
      const tabId = c.req.param("tabId") as string;
      let sink: TerminalClientSink | null = null;

      return {
        onOpen(_event, ws) {
          void validateProjectPath(deps.scanner, projectId)
            .then((projectPath) => {
              if (!projectPath) {
                send(ws, { type: "error", message: "Project not found" });
                ws.close(1008, "Project not found");
                return;
              }

              sink = {
                send(message: TerminalServerMessage) {
                  send(ws, message);
                },
              };
              try {
                const attachment = registry.attachClient(
                  projectId,
                  tabId,
                  sink,
                );
                send(ws, { type: "snapshot", data: attachment.snapshot });
              } catch {
                send(ws, { type: "error", message: "Terminal tab not found" });
                ws.close(1008, "Terminal tab not found");
              }
            })
            .catch((error: unknown) => {
              const message =
                error instanceof Error
                  ? error.message
                  : "Failed to open terminal";
              if (ws.readyState === 1) {
                send(ws, { type: "error", message });
              }
            });
        },
        async onMessage(event, ws) {
          try {
            const message = JSON.parse(
              String(event.data),
            ) as TerminalClientMessage;
            if (message.type === "resize") {
              registry.resizeTab(
                projectId,
                tabId,
                clampTerminalSize(message.cols, 80),
                clampTerminalSize(message.rows, 24),
              );
              return;
            }

            registry.writeInput(projectId, tabId, message.data);
          } catch {
            send(ws, { type: "error", message: "Invalid terminal message" });
          }
        },
        onClose() {
          detachClient(projectId, tabId, sink);
        },
        onError() {
          detachClient(projectId, tabId, sink);
        },
      };
    }),
  );

  return routes;
}
