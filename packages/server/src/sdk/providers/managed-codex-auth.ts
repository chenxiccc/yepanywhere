import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const MAX_STDERR_BYTES = 64 * 1024;
const CODEX_VERSION_PATTERN = /^codex-cli\s+(\d+\.\d+\.\d+)$/;

export interface ManagedCodexAuthProjection {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
}

export type ManagedCodexAuthFailureCode =
  | "codex-version-incompatible"
  | "credential-store-unsupported"
  | "chatgpt-login-missing"
  | "auth-refresh-failed"
  | "auth-refresh-timeout"
  | "auth-account-mismatch";

export class ManagedCodexAuthError extends Error {
  constructor(
    readonly code: ManagedCodexAuthFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ManagedCodexAuthError";
  }
}

export interface ManagedCodexAuthOwnerOptions {
  codexHome?: string;
  codexCommand?: string;
  codexArguments?: string[];
  expectedCodexVersion: string;
  requestTimeoutMs?: number;
  spawnEnvironment?: NodeJS.ProcessEnv;
}

export interface ManagedCodexAuthBroker {
  preflight(): Promise<ManagedCodexAuthProjection>;
  refresh(expectedAccountId: string): Promise<ManagedCodexAuthProjection>;
}

interface CodexAuthFile {
  auth_mode?: unknown;
  tokens?: {
    access_token?: unknown;
    account_id?: unknown;
  };
}

/**
 * Owns the controller side of managed Codex subscription authentication.
 *
 * The owner reads only the file-backed access-token projection. Forced
 * refreshes are serialized through a controller-local Codex app-server; the
 * refresh credential and complete auth store never become return values.
 */
export class ManagedCodexAuthOwner implements ManagedCodexAuthBroker {
  private readonly codexHome: string;
  private readonly codexCommand: string;
  private readonly codexArguments: string[];
  private readonly expectedCodexVersion: string;
  private readonly requestTimeoutMs: number;
  private readonly spawnEnvironment: NodeJS.ProcessEnv;
  private refreshTail: Promise<void> = Promise.resolve();
  private accountId: string | null = null;

  constructor(options: ManagedCodexAuthOwnerOptions) {
    if (!/^\d+\.\d+\.\d+$/.test(options.expectedCodexVersion)) {
      throw new Error("Managed Codex auth requires an exact CLI version");
    }
    this.codexHome = options.codexHome ?? join(homedir(), ".codex");
    this.codexCommand = options.codexCommand ?? "codex";
    this.codexArguments = [...(options.codexArguments ?? [])];
    this.expectedCodexVersion = options.expectedCodexVersion;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.spawnEnvironment = {
      ...(options.spawnEnvironment ?? process.env),
      CODEX_HOME: this.codexHome,
    };
  }

  async preflight(): Promise<ManagedCodexAuthProjection> {
    const client = await ControllerCodexClient.start({
      command: this.codexCommand,
      commandArguments: this.codexArguments,
      codexHome: this.codexHome,
      environment: this.spawnEnvironment,
      requestTimeoutMs: this.requestTimeoutMs,
      expectedVersion: this.expectedCodexVersion,
    });
    try {
      await client.initialize();
      const config = await client.request<Record<string, unknown>>(
        "config/read",
        { includeLayers: false },
      );
      assertFileCredentialStore(config);
      const account = await client.request<Record<string, unknown>>(
        "account/read",
        { refreshToken: false },
      );
      assertChatgptAccount(account);
      const projection = await readAuthProjection(this.codexHome);
      this.bindAccount(projection.chatgptAccountId);
      return projection;
    } finally {
      await client.close();
    }
  }

  async refresh(
    expectedAccountId: string,
  ): Promise<ManagedCodexAuthProjection> {
    const work = this.refreshTail.then(() =>
      this.refreshOnce(expectedAccountId),
    );
    this.refreshTail = work.then(
      () => undefined,
      () => undefined,
    );
    return await work;
  }

  private async refreshOnce(
    expectedAccountId: string,
  ): Promise<ManagedCodexAuthProjection> {
    if (!expectedAccountId || this.accountId !== expectedAccountId) {
      throw new ManagedCodexAuthError(
        "auth-account-mismatch",
        "Managed Codex refresh account does not match the preflight account",
      );
    }
    let client: ControllerCodexClient | null = null;
    try {
      client = await ControllerCodexClient.start({
        command: this.codexCommand,
        commandArguments: this.codexArguments,
        codexHome: this.codexHome,
        environment: this.spawnEnvironment,
        requestTimeoutMs: this.requestTimeoutMs,
        expectedVersion: this.expectedCodexVersion,
      });
      await client.initialize();
      const config = await client.request<Record<string, unknown>>(
        "config/read",
        { includeLayers: false },
      );
      assertFileCredentialStore(config);
      const account = await client.request<Record<string, unknown>>(
        "account/read",
        { refreshToken: true },
      );
      assertChatgptAccount(account);
      const projection = await readAuthProjection(this.codexHome);
      if (projection.chatgptAccountId !== expectedAccountId) {
        throw new ManagedCodexAuthError(
          "auth-account-mismatch",
          "Controller Codex account changed during managed refresh",
        );
      }
      return projection;
    } catch (error) {
      if (error instanceof ManagedCodexAuthError) throw error;
      if (isTimeoutError(error)) {
        throw new ManagedCodexAuthError(
          "auth-refresh-timeout",
          "Controller Codex authentication refresh timed out",
        );
      }
      throw new ManagedCodexAuthError(
        "auth-refresh-failed",
        `Controller Codex authentication refresh failed: ${errorMessage(error)}`,
      );
    } finally {
      await client?.close();
    }
  }

  private bindAccount(accountId: string): void {
    if (this.accountId && this.accountId !== accountId) {
      throw new ManagedCodexAuthError(
        "auth-account-mismatch",
        "Controller Codex account changed after managed auth preflight",
      );
    }
    this.accountId = accountId;
  }
}

interface ControllerCodexClientOptions {
  command: string;
  commandArguments: string[];
  codexHome: string;
  environment: NodeJS.ProcessEnv;
  requestTimeoutMs: number;
  expectedVersion: string;
}

class ControllerCodexClient {
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  private constructor(
    private readonly child: ReturnType<typeof spawn>,
    private readonly requestTimeoutMs: number,
  ) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.handleData(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const remaining = MAX_STDERR_BYTES - Buffer.byteLength(this.stderr);
      if (remaining > 0) {
        this.stderr += Buffer.from(chunk).subarray(0, remaining).toString();
      }
    });
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => {
      if (!this.closed) {
        this.fail(
          new Error(
            `Controller Codex app-server exited code=${String(code)} signal=${String(signal)}`,
          ),
        );
      }
    });
  }

  static async start(
    options: ControllerCodexClientOptions,
  ): Promise<ControllerCodexClient> {
    const version = await readCodexVersion(options);
    if (version !== options.expectedVersion) {
      throw new ManagedCodexAuthError(
        "codex-version-incompatible",
        `Controller Codex CLI ${version} is incompatible; expected ${options.expectedVersion}`,
      );
    }
    const child = spawn(
      options.command,
      [...options.commandArguments, "app-server", "--listen", "stdio://"],
      {
        cwd: homedir(),
        env: options.environment,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      },
    );
    await waitForSpawn(child, options.requestTimeoutMs);
    return new ControllerCodexClient(child, options.requestTimeoutMs);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "yep_anywhere_managed_codex_auth",
        title: null,
        version: "dev",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Controller Codex app-server is closed"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Controller Codex ${method} timed out`);
        error.name = "TimeoutError";
        reject(error);
      }, this.requestTimeoutMs);
      timeout.unref?.();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Controller Codex app-server closed"));
    }
    this.pending.clear();
    this.child.stdin?.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        timeout.unref?.();
      }),
    ]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
    }
  }

  private write(message: unknown): void {
    if (!this.child.stdin?.writable) {
      throw new Error("Controller Codex app-server stdin is unavailable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof message.id !== "number" || message.method) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error && typeof message.error === "object") {
        const rpcError = message.error as { message?: unknown };
        pending.reject(
          new Error(
            typeof rpcError.message === "string"
              ? rpcError.message
              : "Controller Codex JSON-RPC request failed",
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const detail = this.stderr.trim();
    const failure = new Error(
      detail ? `${error.message}: ${detail}` : error.message,
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(failure);
    }
    this.pending.clear();
  }
}

async function readCodexVersion(
  options: ControllerCodexClientOptions,
): Promise<string> {
  const child = spawn(
    options.command,
    [...options.commandArguments, "--version"],
    {
      cwd: homedir(),
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    if (Buffer.byteLength(stdout) < 1024) stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    if (Buffer.byteLength(stderr) < 4096) stderr += String(chunk);
  });
  await waitForExit(child, options.requestTimeoutMs, "Codex version probe");
  const match = CODEX_VERSION_PATTERN.exec(stdout.trim());
  if (!match?.[1]) {
    throw new ManagedCodexAuthError(
      "codex-version-incompatible",
      `Controller Codex version output is incompatible${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  return match[1];
}

async function readAuthProjection(
  codexHome: string,
): Promise<ManagedCodexAuthProjection> {
  let parsed: CodexAuthFile;
  try {
    parsed = JSON.parse(
      await readFile(join(codexHome, "auth.json"), "utf8"),
    ) as CodexAuthFile;
  } catch {
    throw new ManagedCodexAuthError(
      "chatgpt-login-missing",
      "Managed Codex requires a file-backed ChatGPT login",
    );
  }
  if (parsed.auth_mode !== undefined && parsed.auth_mode !== "chatgpt") {
    throw new ManagedCodexAuthError(
      "chatgpt-login-missing",
      "Managed Codex requires ChatGPT subscription authentication",
    );
  }
  const accessToken = requiredSecretString(
    parsed.tokens?.access_token,
    "access token",
  );
  const claims = decodeJwtClaims(accessToken);
  const openAiClaims = asRecord(claims["https://api.openai.com/auth"]);
  const chatgptAccountId = requiredPublicString(
    parsed.tokens?.account_id ?? openAiClaims?.chatgpt_account_id,
    "ChatGPT account id",
  );
  const chatgptPlanType = optionalPublicString(openAiClaims?.chatgpt_plan_type);
  return { accessToken, chatgptAccountId, chatgptPlanType };
}

function assertFileCredentialStore(response: Record<string, unknown>): void {
  const config = asRecord(response.config);
  const mode = config?.cli_auth_credentials_store ?? "file";
  if (mode !== "file") {
    throw new ManagedCodexAuthError(
      "credential-store-unsupported",
      `Managed Codex does not support the configured ${String(mode)} credential store`,
    );
  }
}

function assertChatgptAccount(response: Record<string, unknown>): void {
  const account = asRecord(response.account);
  if (account?.type !== "chatgpt") {
    throw new ManagedCodexAuthError(
      "chatgpt-login-missing",
      "Managed Codex requires an active ChatGPT subscription login",
    );
  }
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1];
    if (!payload) throw new Error("missing payload");
    return JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    throw new ManagedCodexAuthError(
      "chatgpt-login-missing",
      "Managed Codex ChatGPT access token is invalid",
    );
  }
}

function requiredSecretString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ManagedCodexAuthError(
      "chatgpt-login-missing",
      `Managed Codex ${label} is missing`,
    );
  }
  return value;
}

function requiredPublicString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ManagedCodexAuthError(
      "chatgpt-login-missing",
      `Managed Codex ${label} is missing`,
    );
  }
  return value;
}

function optionalPublicString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function waitForSpawn(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      const error = new Error("Controller Codex app-server spawn timed out");
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
    const cleanup = () => clearTimeout(timeout);
    child.once("spawn", () => {
      cleanup();
      resolve();
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      const error = new Error(`${label} timed out`);
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`${label} exited with code ${String(code)}`));
    });
  });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
