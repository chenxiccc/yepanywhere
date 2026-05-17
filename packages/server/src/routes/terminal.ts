import { constants, accessSync } from "node:fs";
import { env, platform } from "node:process";
import { isUrlProjectId } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { Context } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import * as pty from "node-pty";
import type { ProjectScanner } from "../projects/scanner.js";

// biome-ignore lint/suspicious/noExplicitAny: Complex third-party type from @hono/node-ws
type UpgradeWebSocketFn = (createEvents: (c: Context) => WSEvents) => any;

export interface TerminalDeps {
  scanner: ProjectScanner;
  upgradeWebSocket: UpgradeWebSocketFn;
}

type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

const MAX_PENDING_INPUT = 256;

interface PendingTerminalState {
  cols: number;
  rows: number;
  input: string[];
}

type TerminalServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string };

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

    try {
      accessSync(candidate, constants.X_OK);
      return { command: candidate, args: ["-i"] };
    } catch {}
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

function createNodePtyProcess(
  projectPath: string,
  pending: PendingTerminalState,
  onOutput: (data: string) => void,
  onExit: (exitCode: number | null) => void,
): pty.IPty {
  const shell = getShellCommand();
  const shellProcess = pty.spawn(shell.command, shell.args, {
    cwd: projectPath,
    env: {
      ...env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
    cols: pending.cols,
    rows: pending.rows,
    name: "xterm-256color",
  });

  shellProcess.onData((data) => {
    onOutput(data);
  });

  shellProcess.onExit(({ exitCode }) => {
    onExit(exitCode);
  });

  return shellProcess;
}

export function createTerminalRoutes(deps: TerminalDeps): Hono {
  const routes = new Hono();

  routes.get(
    "/projects/:projectId/terminal/ws",
    deps.upgradeWebSocket((c) => {
      const projectId = c.req.param("projectId") as string;
      let validatedProjectPath: string | null = null;
      let validationPromise: Promise<string | null> | null = null;
      let shellProcess: pty.IPty | null = null;
      const pending: PendingTerminalState = {
        cols: 80,
        rows: 24,
        input: [],
      };

      const validate = async (): Promise<string | null> => {
        if (!isUrlProjectId(projectId)) {
          return null;
        }

        const project = await deps.scanner.getOrCreateProject(projectId);
        return project?.path ?? null;
      };

      return {
        onOpen(_event, ws) {
          validationPromise = validate();
          void validationPromise
            .then((projectPath) => {
              validatedProjectPath = projectPath;
              if (!projectPath) {
                send(ws, { type: "error", message: "Project not found" });
                ws.close(1008, "Project not found");
                return;
              }

              const onOutput = (data: string) => {
                send(ws, { type: "output", data });
              };

              const onExit = (exitCode: number | null) => {
                send(ws, { type: "exit", exitCode });
                ws.close(1000, "Shell exited");
              };

              shellProcess = createNodePtyProcess(
                projectPath,
                pending,
                onOutput,
                onExit,
              );

              if (pending.input.length > 0) {
                for (const chunk of pending.input) {
                  shellProcess.write(chunk);
                }
                pending.input.length = 0;
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
              pending.cols = clampTerminalSize(message.cols, 80);
              pending.rows = clampTerminalSize(message.rows, 24);

              if (shellProcess) {
                shellProcess.resize(pending.cols, pending.rows);
              }
              return;
            }

            if (!validatedProjectPath && validationPromise) {
              validatedProjectPath = await validationPromise;
            }

            if (!validatedProjectPath) {
              send(ws, { type: "error", message: "Project not found" });
              return;
            }

            if (!shellProcess) {
              if (pending.input.length < MAX_PENDING_INPUT) {
                pending.input.push(message.data);
              }
              return;
            }

            shellProcess.write(message.data);
          } catch {
            send(ws, { type: "error", message: "Invalid terminal message" });
          }
        },
        onClose() {
          shellProcess?.kill();
          shellProcess = null;
        },
        onError() {
          shellProcess?.kill();
          shellProcess = null;
        },
      };
    }),
  );

  return routes;
}
