import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  ProviderName,
  RecapMode,
  SessionSandboxEnforcement,
  SessionSandboxLevel,
} from "@yep-anywhere/shared";
import { getDefaultCodexHomeDir } from "./projects/codex-scanner.js";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"] as const;
const SUPPORTED_PROVIDERS = new Set<ProviderName>([
  "claude",
  "claude-gateway",
  "claude-ollama",
  "codex",
]);
const SANDBOX_STATE_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MINIMUM_BWRAP_VERSION = [0, 4, 0] as const;

export interface SessionSandboxSpawn {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SessionSandboxRuntime {
  readonly enforcement: SessionSandboxEnforcement;
  readonly stateKey: string;
  /** Canonical project path whose writable bind defines this sandbox. */
  readonly projectPath: string;
  /** Provider transcript directory inside the project-scoped private state. */
  readonly transcriptDir: string;
  /**
   * Open the transcript directory through no-follow directory handles.
   * Host-side fork helpers must not resolve agent-controlled symlinks.
   */
  openTranscriptDirectory(): Promise<FileHandle>;
  wrapSpawn(
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): SessionSandboxSpawn;
}

export interface PrepareSessionSandboxOptions {
  level: SessionSandboxLevel | undefined;
  provider: ProviderName;
  projectPath: string;
  executor?: string;
  /** Restores the project-private state selected by persisted metadata. */
  stateKey?: string;
  resumeSessionId?: string;
  /** Test-only override; production intentionally uses trusted system paths. */
  bwrapPath?: string;
  /** Test-only override for keeping fixtures out of the real YA state root. */
  stateRoot?: string;
}

export function getSessionSandboxSettingsError(
  level: SessionSandboxLevel | undefined,
  recapMode: RecapMode | undefined,
): string | undefined {
  if (level === "project-write" && recapMode === "side-session") {
    return (
      "Project-write sandboxed sessions currently support Off, Native, or " +
      "fork recaps; YA side-session helpers are unavailable in v1."
    );
  }
  return undefined;
}

function sandboxInstallError(detail?: string): Error {
  const suffix = detail ? ` (${detail})` : "";
  return new Error(
    `Sandboxed sessions require Bubblewrap (bwrap)${suffix}. ` +
      "Install it with `sudo dnf install bubblewrap` on Rocky/RHEL/Fedora " +
      "or `sudo apt install bubblewrap` on Debian/Ubuntu.",
  );
}

function sandboxRuntimeError(detail: string): Error {
  return new Error(
    `Bubblewrap is installed but could not enforce the session sandbox (${detail}). ` +
      "Check that this host permits unprivileged user and mount namespaces.",
  );
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

async function resolveTrustedBwrap(explicit?: string): Promise<string> {
  const candidates = explicit ? [explicit] : BWRAP_CANDIDATES;
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        continue;
      }
      return resolved;
    } catch {
      // Try the next trusted system location.
    }
  }
  throw sandboxInstallError();
}

async function runBwrapProbe(
  bwrapPath: string,
  args: readonly string[],
): Promise<void> {
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const child = spawn(bwrapPath, [...args, "--", "/bin/true"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      rejectProbe(sandboxRuntimeError(error.message));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveProbe();
        return;
      }
      const detail =
        stderr.trim() ||
        `probe exited with ${signal ? `signal ${signal}` : `status ${code}`}`;
      rejectProbe(sandboxRuntimeError(detail));
    });
  });
}

async function requireSupportedBwrapVersion(bwrapPath: string): Promise<void> {
  const output = await new Promise<string>((resolveVersion, rejectVersion) => {
    const child = spawn(bwrapPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 1000) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 1000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      rejectVersion(sandboxRuntimeError(error.message));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveVersion(stdout.trim());
        return;
      }
      const detail =
        stderr.trim() ||
        `version check exited with ${signal ? `signal ${signal}` : `status ${code}`}`;
      rejectVersion(sandboxRuntimeError(detail));
    });
  });
  const match = /\b(?:bubblewrap|bwrap)\s+(\d+)\.(\d+)(?:\.(\d+))?\b/i.exec(
    output,
  );
  if (!match) {
    throw sandboxRuntimeError(`unrecognized bwrap --version output: ${output}`);
  }
  const found = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3] ?? 0),
  ] as const;
  const supported =
    found[0] > MINIMUM_BWRAP_VERSION[0] ||
    (found[0] === MINIMUM_BWRAP_VERSION[0] &&
      (found[1] > MINIMUM_BWRAP_VERSION[1] ||
        (found[1] === MINIMUM_BWRAP_VERSION[1] &&
          found[2] >= MINIMUM_BWRAP_VERSION[2])));
  if (!supported) {
    throw new Error(
      `Sandboxed sessions require Bubblewrap 0.4.0 or newer (found ${found.join(".")}). ` +
        "Upgrade Bubblewrap before starting this session.",
    );
  }
}

async function copyBootstrapEntry(
  sourceRoot: string,
  destinationRoot: string,
  entry: string,
): Promise<void> {
  const source = join(sourceRoot, entry);
  const destination = join(destinationRoot, entry);
  try {
    await lstat(source);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: false,
    preserveTimestamps: true,
    dereference: false,
    mode: fsConstants.COPYFILE_FICLONE,
  });
}

async function bootstrapProviderState(options: {
  provider: ProviderName;
  providerStateDir: string;
  privateClaudeJson: string;
}): Promise<void> {
  const marker = join(
    dirname(options.providerStateDir),
    `.ya-${options.provider === "codex" ? "codex" : "claude"}-sandbox-initialized`,
  );
  try {
    await stat(marker);
    return;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }

  if (options.provider === "codex") {
    const source = getDefaultCodexHomeDir();
    for (const entry of [
      "auth.json",
      "config.toml",
      "models_cache.json",
      "plugins",
      "rules",
      "skills",
    ]) {
      await copyBootstrapEntry(source, options.providerStateDir, entry);
    }
  } else {
    const source = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    for (const entry of [
      ".credentials.json",
      "settings.json",
      "plugins",
      "skills",
    ]) {
      await copyBootstrapEntry(source, options.providerStateDir, entry);
    }
    const hostClaudeJson = join(homedir(), ".claude.json");
    try {
      await copyFile(
        hostClaudeJson,
        options.privateClaudeJson,
        fsConstants.COPYFILE_FICLONE,
      );
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      await writeEmptyFile(options.privateClaudeJson);
    }
    await chmod(options.privateClaudeJson, 0o600);
  }

  await writeEmptyFile(marker);
  await chmod(marker, 0o600);
}

async function writeEmptyFile(destination: string): Promise<void> {
  await copyFile("/dev/null", destination);
}

async function hasClaudeJsonMountPoint(): Promise<boolean> {
  const destination = join(homedir(), ".claude.json");
  try {
    const info = await stat(destination);
    if (!info.isFile()) {
      throw new Error(
        `Cannot sandbox Claude because ${destination} is not a regular file`,
      );
    }
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function claudeProjectDirectory(projectPath: string): string {
  return projectPath.replace(/[/\\:]/g, "-");
}

export function getClaudeSandboxProjectDir(options: {
  dataDir: string;
  stateKey: string;
  projectPath: string;
}): string {
  return join(
    options.dataDir,
    "session-sandboxes",
    options.stateKey,
    "claude",
    "projects",
    claudeProjectDirectory(options.projectPath),
  );
}

export function getCodexSandboxSessionsDir(options: {
  dataDir: string;
  stateKey: string;
}): string {
  return join(
    options.dataDir,
    "session-sandboxes",
    options.stateKey,
    "codex",
    "sessions",
  );
}

function buildBwrapBaseArgs(options: {
  projectPath: string;
  providerStateDir: string;
  cacheDir: string;
  tempDir: string;
  varTempDir: string;
  privateClaudeJson?: string;
}): string[] {
  const args = [
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/run",
    "--bind",
    options.tempDir,
    "/tmp",
    "--bind",
    options.varTempDir,
    "/var/tmp",
    "--bind",
    options.projectPath,
    options.projectPath,
    "--bind",
    options.providerStateDir,
    options.providerStateDir,
    "--bind",
    options.cacheDir,
    options.cacheDir,
  ];
  if (options.privateClaudeJson) {
    args.push(
      "--bind-try",
      options.privateClaudeJson,
      join(homedir(), ".claude.json"),
    );
  }
  args.push(
    "--chdir",
    options.projectPath,
    "--unsetenv",
    "SSH_AUTH_SOCK",
    "--unsetenv",
    "GPG_AGENT_INFO",
    "--unsetenv",
    "DOCKER_HOST",
    "--unsetenv",
    "CONTAINER_HOST",
    "--unsetenv",
    "KUBECONFIG",
  );
  return args;
}

async function openAnchoredDirectory(
  root: string,
  relativePath: string,
): Promise<FileHandle> {
  const flags =
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
  let current = await open(root, flags);
  try {
    for (const component of relativePath.split(sep).filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${current.fd}/${component}`,
        flags,
      );
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

export async function prepareSessionSandbox(
  options: PrepareSessionSandboxOptions,
): Promise<SessionSandboxRuntime | undefined> {
  const level = options.level ?? "none";
  if (level === "none") return undefined;
  if (level !== "project-write") {
    throw new Error(`Invalid session sandbox level: ${String(level)}`);
  }
  if (options.executor) {
    throw new Error(
      "Project-write session sandboxing is not supported for remote executors.",
    );
  }
  if (process.platform !== "linux") {
    throw new Error(
      "Project-write session sandboxing currently requires Linux and Bubblewrap.",
    );
  }
  if (!SUPPORTED_PROVIDERS.has(options.provider)) {
    throw new Error(
      `Project-write session sandboxing is not yet supported for provider ${options.provider}.`,
    );
  }
  const projectPath = await realpath(options.projectPath);
  if (projectPath === "/") {
    throw new Error(
      "Project-write session sandboxing cannot use the filesystem root as its project.",
    );
  }
  const stateKey =
    options.stateKey ??
    `project-${createHash("sha256").update(projectPath).digest("hex").slice(0, 32)}`;
  if (!SANDBOX_STATE_KEY_PATTERN.test(stateKey)) {
    throw new Error("Invalid session sandbox state key");
  }

  const root = resolve(
    options.stateRoot ?? join(homedir(), ".yep-anywhere", "session-sandboxes"),
  );
  const stateDir = resolve(root, stateKey);
  if (!isWithin(root, stateDir)) {
    throw new Error("Session sandbox state escaped its configured root");
  }
  const bwrapPath = await resolveTrustedBwrap(options.bwrapPath);
  await requireSupportedBwrapVersion(bwrapPath);
  const providerStateDir = join(
    stateDir,
    options.provider === "codex" ? "codex" : "claude",
  );
  const cacheDir = join(stateDir, "cache");
  const tempDir = join(stateDir, "tmp");
  const varTempDir = join(stateDir, "var-tmp");
  const privateClaudeJson = join(stateDir, "claude.json");
  const transcriptDir =
    options.provider === "codex"
      ? join(providerStateDir, "sessions")
      : join(providerStateDir, "projects", claudeProjectDirectory(projectPath));
  await Promise.all(
    [root, stateDir, providerStateDir, cacheDir, tempDir, varTempDir].map(
      async (directory) => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
      },
    ),
  );
  await bootstrapProviderState({
    provider: options.provider,
    providerStateDir,
    privateClaudeJson,
  });
  const mountPrivateClaudeJson =
    options.provider !== "codex" && (await hasClaudeJsonMountPoint());

  const baseArgs = buildBwrapBaseArgs({
    projectPath,
    providerStateDir,
    cacheDir,
    tempDir,
    varTempDir,
    privateClaudeJson: mountPrivateClaudeJson
      ? privateClaudeJson
      : undefined,
  });
  await runBwrapProbe(bwrapPath, baseArgs);

  const sandboxEnv: NodeJS.ProcessEnv = {
    TMPDIR: "/tmp",
    TMP: "/tmp",
    TEMP: "/tmp",
    XDG_CACHE_HOME: cacheDir,
    HF_HOME: join(cacheDir, "huggingface"),
    PIP_CACHE_DIR: join(cacheDir, "pip"),
    UV_CACHE_DIR: join(cacheDir, "uv"),
    NPM_CONFIG_CACHE: join(cacheDir, "npm"),
    YARN_CACHE_FOLDER: join(cacheDir, "yarn"),
  };
  if (options.provider === "codex") {
    sandboxEnv.CODEX_HOME = providerStateDir;
  } else {
    sandboxEnv.CLAUDE_CONFIG_DIR = providerStateDir;
    sandboxEnv.CLAUDE_SESSIONS_DIR = join(providerStateDir, "projects");
  }

  return {
    stateKey,
    projectPath,
    transcriptDir,
    openTranscriptDirectory: () =>
      openAnchoredDirectory(stateDir, relative(stateDir, transcriptDir)),
    enforcement: {
      requested: "project-write",
      effective: "project-write",
      state: "enforced",
      hostBackend: `bubblewrap:${basename(bwrapPath)}`,
    },
    wrapSpawn(command, args, env) {
      return {
        command: bwrapPath,
        args: [...baseArgs, "--", command, ...args],
        cwd: projectPath,
        env: { ...env, ...sandboxEnv },
      };
    },
  };
}
