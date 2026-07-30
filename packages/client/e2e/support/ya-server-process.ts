import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..", "..", "..");
const serverRoot = join(repoRoot, "packages", "server");

export interface MockClaudeSession {
  content: string;
  projectPath: string;
  sessionId: string;
}

export interface StartYaServerProcessOptions {
  label: string;
  tempPrefix?: string;
  mockClaudeSession?: MockClaudeSession;
  env?: NodeJS.ProcessEnv;
}

export interface YaServerProcess {
  baseUrl: string;
  claudeSessionsDir: string;
  codexSessionsDir: string;
  dataDir: string;
  geminiSessionsDir: string;
  label: string;
  output: {
    stderr: string[];
    stdout: string[];
  };
  port: number;
  process: ChildProcess;
  tempDir: string;
  wsUrl: string;
}

async function waitForPortFile(
  portFile: string,
  label: string,
  timeoutMs = 30_000,
): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(portFile)) {
      const content = readFileSync(portFile, "utf-8").trim();
      const port = Number.parseInt(content, 10);
      if (port > 0) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for ${label} port file`);
}

async function waitForHealth(
  baseUrl: string,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const healthUrl = `${baseUrl}/health`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // The child process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} health check failed: ${healthUrl}`);
}

function writeServerSettings(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "server-settings.json"),
    JSON.stringify(
      {
        version: 1,
        settings: {
          codexUpdatePolicy: "off",
        },
      },
      null,
      2,
    ),
  );
}

function writeMockClaudeSession(
  claudeSessionsDir: string,
  fixture: MockClaudeSession,
): void {
  mkdirSync(fixture.projectPath, { recursive: true });
  const encodedPath = fixture.projectPath.replace(/\//g, "-");
  const sessionDir = join(claudeSessionsDir, hostname(), encodedPath);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, `${fixture.sessionId}.jsonl`),
    `${JSON.stringify({
      type: "user",
      cwd: fixture.projectPath,
      message: { role: "user", content: fixture.content },
      timestamp: "2026-01-01T00:00:00.000Z",
      uuid: "fixture-user-message",
    })}\n`,
  );
}

function captureOutput(
  stream: NodeJS.ReadableStream | null,
  target: string[],
): void {
  stream?.on("data", (data: Buffer | string) => {
    const text = data.toString();
    if (!text.includes("ExperimentalWarning")) {
      target.push(text);
    }
  });
}

function formatStartFailure(
  label: string,
  error: unknown,
  output: YaServerProcess["output"],
): Error {
  const detail = [...output.stderr, ...output.stdout].join("").trim();
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    detail
      ? `${label} failed to start: ${message}\n${detail}`
      : `${label} failed to start: ${message}`,
  );
}

export async function startYaServerProcess(
  options: StartYaServerProcessOptions,
): Promise<YaServerProcess> {
  const tempDir = mkdtempSync(
    join(tmpdir(), options.tempPrefix ?? "ya-e2e-server-"),
  );
  const profileDir = join(tempDir, "profile");
  const portFile = join(tempDir, "port");
  const claudeSessionsDir = join(profileDir, "claude", "projects");
  const codexSessionsDir = join(profileDir, "codex", "sessions");
  const geminiSessionsDir = join(profileDir, "gemini", "tmp");
  const dataDir = join(profileDir, "yep-anywhere");

  mkdirSync(claudeSessionsDir, { recursive: true });
  mkdirSync(codexSessionsDir, { recursive: true });
  mkdirSync(geminiSessionsDir, { recursive: true });
  writeServerSettings(dataDir);
  if (options.mockClaudeSession) {
    writeMockClaudeSession(claudeSessionsDir, options.mockClaudeSession);
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: "0",
    PORT_FILE: portFile,
    MAINTENANCE_PORT: "0",
    SERVE_FRONTEND: "false",
    LOG_LEVEL: "warn",
    LOG_FILE_LEVEL: "warn",
    LOG_TO_FILE: "false",
    AUTH_DISABLED: "true",
    HTTPS_SELF_SIGNED: "",
    NODE_ENV: "production",
    OPEN_BROWSER: "false",
    CLAUDE_SESSIONS_DIR: claudeSessionsDir,
    CODEX_SESSIONS_DIR: codexSessionsDir,
    GEMINI_SESSIONS_DIR: geminiSessionsDir,
    YEP_DATA_DIR: dataDir,
    ...options.env,
  };
  if (childEnv.FORCE_COLOR) {
    delete childEnv.NO_COLOR;
  }

  const child = spawn(
    "pnpm",
    ["exec", "tsx", "--conditions", "source", "src/index.ts"],
    {
      cwd: serverRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  const output = { stderr: [] as string[], stdout: [] as string[] };
  captureOutput(child.stdout, output.stdout);
  captureOutput(child.stderr, output.stderr);

  const pending: YaServerProcess = {
    baseUrl: "",
    claudeSessionsDir,
    codexSessionsDir,
    dataDir,
    geminiSessionsDir,
    label: options.label,
    output,
    port: 0,
    process: child,
    tempDir,
    wsUrl: "",
  };

  try {
    const port = await waitForPortFile(portFile, options.label);
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, options.label);
    child.unref();
    return {
      ...pending,
      baseUrl,
      port,
      wsUrl: `ws://127.0.0.1:${port}/api/ws`,
    };
  } catch (error) {
    stopYaServerProcess(pending);
    throw formatStartFailure(options.label, error, output);
  }
}

export function stopYaServerProcess(server: YaServerProcess | null): void {
  if (!server) return;
  const pid = server.process.pid;
  if (pid) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
  rmSync(server.tempDir, { recursive: true, force: true });
}
