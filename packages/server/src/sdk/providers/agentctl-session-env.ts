import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENTCTL_SESSION_ID_ENV = "AGENTCTL_SESSION_ID";
const ORIGINAL_BASH_ENV_ENV = "YEP_ORIGINAL_BASH_ENV";
const SESSION_CHILD_ENV_NAMES = [
  "YEP_SESSION_WAKE_URL",
  "YEP_SESSION_WAKE_TOKEN",
  "YEP_BROWSER_DEBUG_AGENT_URL",
  "YEP_BROWSER_DEBUG_CALLER_TOKEN",
] as const;
const BROWSER_DEBUG_ENV_NAMES = [
  "YEP_BROWSER_DEBUG_AGENT_URL",
  "YEP_BROWSER_DEBUG_CALLER_TOKEN",
] as const;

export interface AgentctlSessionEnvBridge {
  readonly bashEnvPath: string;
  extendEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  publishSessionId(
    sessionId: string,
    browserDebugEnvironment?: Record<string, string>,
  ): void;
  cleanup(): void;
}

export function pickBrowserDebugAgentEnvironment(
  environment: Record<string, string> | NodeJS.ProcessEnv | undefined,
): Record<string, string> {
  return Object.fromEntries(
    BROWSER_DEBUG_ENV_NAMES.flatMap((name) => {
      const value = environment?.[name];
      return typeof value === "string" && value ? [[name, value]] : [];
    }),
  );
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function createAgentctlSessionEnvBridge(
  initialSessionId?: string,
  getSessionEnv?: (sessionId: string) => Record<string, string>,
): AgentctlSessionEnvBridge {
  const dir = mkdtempSync(join(tmpdir(), "ya-agentctl-session-"));
  const bashEnvPath = join(dir, "bash-env.sh");
  const sessionEnvPath = join(dir, "agentctl-session.env");

  writeFileSync(
    bashEnvPath,
    [
      "# yep-anywhere agentctl session bridge",
      `if [ -n "\${${ORIGINAL_BASH_ENV_ENV}:-}" ] && [ -r "\${${ORIGINAL_BASH_ENV_ENV}}" ]; then`,
      `  . "\${${ORIGINAL_BASH_ENV_ENV}}"`,
      "fi",
      `if [ -r ${shellSingleQuote(sessionEnvPath)} ]; then`,
      `  . ${shellSingleQuote(sessionEnvPath)}`,
      "fi",
      "",
    ].join("\n"),
    { encoding: "utf-8", mode: 0o600 },
  );

  const publishSessionId = (
    sessionId: string,
    browserDebugEnvironment?: Record<string, string>,
  ): void => {
    const tempPath = join(dir, "agentctl-session.env.tmp");
    const sessionEnv = {
      [AGENTCTL_SESSION_ID_ENV]: sessionId,
      ...getSessionEnv?.(sessionId),
      ...pickBrowserDebugAgentEnvironment(browserDebugEnvironment),
    };
    writeFileSync(
      tempPath,
      [
        ...Object.entries(sessionEnv).flatMap(([name, value]) => {
          if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
            throw new Error(`Invalid child environment variable name: ${name}`);
          }
          return [`${name}=${shellSingleQuote(value)}`, `export ${name}`];
        }),
        "",
      ].join("\n"),
      { encoding: "utf-8", mode: 0o600 },
    );
    renameSync(tempPath, sessionEnvPath);
  };

  if (initialSessionId) {
    publishSessionId(initialSessionId);
  }

  return {
    bashEnvPath,
    extendEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
      const extended: NodeJS.ProcessEnv = {
        ...env,
        ...(env.BASH_ENV
          ? { [ORIGINAL_BASH_ENV_ENV]: env.BASH_ENV }
          : undefined),
        BASH_ENV: bashEnvPath,
      };
      for (const name of SESSION_CHILD_ENV_NAMES) delete extended[name];
      return extended;
    },
    publishSessionId,
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
