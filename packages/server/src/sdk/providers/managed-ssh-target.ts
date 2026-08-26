import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { isValidSshHostAlias } from "../../utils/sshHostAlias.js";
import { quoteShellWord } from "../../utils/posixShell.js";

const DEFAULT_OPERATION_TIMEOUT_MS = 15_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MANAGED_CODEX_TRANSCRIPT_CHUNK_BYTES = 512 * 1024;
const MAX_CODEX_TRANSCRIPT_OUTPUT_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_EXECUTABLE_PATTERN = /^(?:[A-Za-z0-9._-]+|\/[A-Za-z0-9._/-]+)$/;
const SAFE_REMOTE_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;
const SSH_ENVIRONMENT_ALLOWLIST = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_RUNTIME_DIR",
  "YA_FAKE_SSH_DROP_AFTER_MS",
  "YA_FAKE_SSH_PRECONNECT_FAILURE",
  "YA_FAKE_SSH_RECORD",
  "YA_FAKE_SSH_TRUNCATE_INPUT_AFTER_BYTES",
]);

export interface ManagedRunnerArtifactManifest {
  artifactFormatVersion: 1;
  runnerProtocolVersion: 2;
  providerSessionProtocolVersion: 1;
  entrypoint: "runner.mjs";
  target: {
    os: "linux";
    architecture: "x64" | "arm64";
  };
  node: {
    range: ">=20.12";
  };
  artifact: {
    byteSize: number;
    sha256: string;
  };
}

export interface ManagedSshTargetOptions {
  hostAlias: string;
  remoteRoot: string;
  sshCommand?: string;
  nodeCommand?: string;
  connectTimeoutSeconds?: number;
  operationTimeoutMs?: number;
  terminationGraceMs?: number;
  spawnEnvironment?: NodeJS.ProcessEnv;
}

export interface ManagedSshInspection {
  platform: string;
  architecture: string;
  node: {
    available: boolean;
    version?: string;
    compatible: boolean;
  };
  git: {
    available: boolean;
    version?: string;
  };
  codex: {
    available: boolean;
    version?: string;
  };
  managedRootState:
    | "private-writable"
    | "writable"
    | "creatable"
    | "missing-parent"
    | "not-directory"
    | "not-writable";
  runnerCacheState: "absent" | "private-writable" | "not-private-writable";
}

export interface ManagedSshCommandResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ManagedSshCommandOptions {
  input?: Buffer | Readable;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
}

export interface ManagedCodexTranscriptCheckpoint {
  providerSessionId: string;
  relativePath: string;
  fileIdentity: string;
  metadataSha256: string;
  completeBytes: number;
  totalBytes: number;
  mtimeMs: number;
}

export interface ManagedCodexTranscriptChunk {
  offset: number;
  byteLength: number;
  sha256: string;
  bytes: Buffer;
}

export interface ManagedRunnerInstallResult {
  cacheHit: boolean;
  remotePath: string;
  byteSize: number;
  sha256: string;
  durationMs: number;
}

export type ManagedRunnerTerminal =
  | {
      classification: "clean";
      code: 0;
      signal: null;
      stderr: string;
    }
  | {
      classification: "pre-launch-failure" | "uncertain-after-acceptance";
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
      error?: string;
    };

export interface LaunchManagedRunnerOptions {
  manifest: ManagedRunnerArtifactManifest;
  cwd: string;
  allowFakeProvider?: boolean;
  workspaceLease?: {
    workspaceDirectory: string;
    leaseId: string;
  };
}

export class ManagedSshOperationError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(message);
    this.name = "ManagedSshOperationError";
  }
}

export class ManagedSshRunnerLaunch {
  readonly input: Writable;
  readonly output: Readable;
  readonly terminal: Promise<ManagedRunnerTerminal>;

  private accepted = false;
  private cooperativeCompletion = false;
  private terminalState = false;
  private stderr = "";
  private stderrBytes = 0;
  private shutdownTimers: NodeJS.Timeout[] = [];
  private terminalResolve!: (terminal: ManagedRunnerTerminal) => void;
  private launchError: Error | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly terminationGraceMs: number,
    private readonly maxStderrBytes: number,
  ) {
    this.input = child.stdin;
    this.output = child.stdout;
    this.terminal = new Promise((resolve) => {
      this.terminalResolve = resolve;
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.from(chunk);
      const remaining = this.maxStderrBytes - this.stderrBytes;
      if (remaining > 0) {
        const bounded = bytes.subarray(0, remaining);
        this.stderr += bounded.toString("utf8");
        this.stderrBytes += bounded.byteLength;
      }
      if (bytes.byteLength > remaining) {
        this.launchError = new Error(
          "Managed SSH runner stderr exceeded its bound",
        );
        this.beginEscalation();
      }
    });
    child.once("error", (error) => {
      this.launchError = error;
      this.finish(null, null);
    });
    child.once("close", (code, signal) => this.finish(code, signal));
  }

  markLaunchAccepted(): void {
    this.accepted = true;
  }

  markCooperativeCompletion(): void {
    this.cooperativeCompletion = true;
  }

  async terminate(): Promise<ManagedRunnerTerminal> {
    if (!this.terminalState && !this.child.stdin.destroyed) {
      this.child.stdin.end();
    }
    this.beginEscalation();
    return await this.terminal;
  }

  signalControllerLoss(signal: "SIGTERM" | "SIGHUP"): void {
    if (this.terminalState) return;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    this.child.kill(signal);
    this.beginEscalation();
  }

  private beginEscalation(): void {
    if (this.terminalState || this.shutdownTimers.length > 0) return;
    const terminateTimer = setTimeout(() => {
      if (!this.terminalState) this.child.kill("SIGTERM");
    }, this.terminationGraceMs);
    const killTimer = setTimeout(() => {
      if (!this.terminalState) this.child.kill("SIGKILL");
    }, this.terminationGraceMs * 2);
    terminateTimer.unref();
    killTimer.unref();
    this.shutdownTimers.push(terminateTimer, killTimer);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.terminalState) return;
    this.terminalState = true;
    for (const timer of this.shutdownTimers) clearTimeout(timer);
    this.shutdownTimers = [];

    if (
      this.accepted &&
      this.cooperativeCompletion &&
      code === 0 &&
      signal === null &&
      !this.launchError
    ) {
      this.terminalResolve({
        classification: "clean",
        code: 0,
        signal: null,
        stderr: this.stderr,
      });
      return;
    }
    this.terminalResolve({
      classification: this.accepted
        ? "uncertain-after-acceptance"
        : "pre-launch-failure",
      code,
      signal,
      stderr: this.stderr,
      ...(this.launchError ? { error: this.launchError.message } : {}),
    });
  }
}

export class ManagedSshTarget {
  readonly hostAlias: string;
  readonly remoteRoot: string;
  readonly sshCommand: string;
  readonly nodeCommand: string;
  readonly connectTimeoutSeconds: number;

  private readonly operationTimeoutMs: number;
  private readonly terminationGraceMs: number;
  private readonly spawnEnvironment: NodeJS.ProcessEnv;

  constructor(options: ManagedSshTargetOptions) {
    if (!isValidSshHostAlias(options.hostAlias)) {
      throw new Error("Managed SSH target requires a configured host alias");
    }
    assertSafeRemotePath(options.remoteRoot, "managed remote root");
    assertSafeExecutable(options.sshCommand ?? "ssh", "SSH executable");
    assertSafeExecutable(options.nodeCommand ?? "node", "Node executable");
    const connectTimeoutSeconds = options.connectTimeoutSeconds ?? 10;
    if (
      !Number.isSafeInteger(connectTimeoutSeconds) ||
      connectTimeoutSeconds < 1 ||
      connectTimeoutSeconds > 120
    ) {
      throw new Error(
        "Managed SSH connect timeout must be from 1 to 120 seconds",
      );
    }
    this.hostAlias = options.hostAlias;
    this.remoteRoot = options.remoteRoot;
    this.sshCommand = options.sshCommand ?? "ssh";
    this.nodeCommand = options.nodeCommand ?? "node";
    this.connectTimeoutSeconds = connectTimeoutSeconds;
    this.operationTimeoutMs =
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.spawnEnvironment = managedSshProcessEnvironment(
      options.spawnEnvironment ?? process.env,
    );
  }

  sshArguments(remoteCommand: string): string[] {
    if (!remoteCommand || remoteCommand.includes("\0")) {
      throw new Error("Managed SSH remote command is invalid");
    }
    return [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${this.connectTimeoutSeconds}`,
      "--",
      this.hostAlias,
      remoteCommand,
    ];
  }

  gitSshCommand(): string {
    // Git may append transport options such as `-o SendEnv=GIT_PROTOCOL`
    // before its validated host. A terminating `--` here would turn that
    // appended option into the hostname and make current OpenSSH reject it.
    return [
      quoteShellWord(this.sshCommand),
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${this.connectTimeoutSeconds}`,
    ].join(" ");
  }

  gitRemoteUrl(remotePath: string): string {
    assertContainedRemotePath(this.remoteRoot, remotePath, "Git remote path");
    return `ssh://${this.hostAlias}${remotePath}`;
  }

  sshProcessEnvironment(): NodeJS.ProcessEnv {
    return { ...this.spawnEnvironment };
  }

  async inspect(
    options: { signal?: AbortSignal } = {},
  ): Promise<ManagedSshInspection> {
    const node = quoteShellWord(this.nodeCommand);
    const root = quoteShellWord(this.remoteRoot);
    const cache = quoteShellWord(`${this.remoteRoot}/runner-cache`);
    const command = [
      "set -eu",
      "platform=$(uname -s 2>/dev/null || printf unknown)",
      "architecture=$(uname -m 2>/dev/null || printf unknown)",
      `if ${node} --version >/dev/null 2>&1; then node_available=yes; node_version=$(${node} --version 2>&1 | sed -n '1p'); else node_available=no; node_version=; fi`,
      "if git --version >/dev/null 2>&1; then git_available=yes; git_version=$(git --version 2>&1 | sed -n '1p'); else git_available=no; git_version=; fi",
      "if codex --version >/dev/null 2>&1; then codex_available=yes; codex_version=$(codex --version 2>&1 | sed -n '1p'); else codex_available=no; codex_version=; fi",
      `if [ -e ${root} ]; then if [ ! -d ${root} ]; then root_state=not-directory; elif [ ! -w ${root} ] || [ ! -x ${root} ]; then root_state=not-writable; else root_mode=$(stat -c '%a' ${root} 2>/dev/null || printf unknown); case "$root_mode" in 700) root_state=private-writable ;; *) root_state=writable ;; esac; fi; else root_parent=$(dirname ${root}); if [ -d "$root_parent" ] && [ -w "$root_parent" ] && [ -x "$root_parent" ]; then root_state=creatable; else root_state=missing-parent; fi; fi`,
      `if [ ! -e ${cache} ]; then cache_state=absent; elif [ -d ${cache} ] && [ -w ${cache} ] && [ -x ${cache} ] && [ "$(stat -c '%a' ${cache} 2>/dev/null || printf unknown)" = 700 ]; then cache_state=private-writable; else cache_state=not-private-writable; fi`,
      'printf \'platform=%s\\narchitecture=%s\\nnode_available=%s\\nnode_version=%s\\ngit_available=%s\\ngit_version=%s\\ncodex_available=%s\\ncodex_version=%s\\nroot_state=%s\\ncache_state=%s\\n\' "$platform" "$architecture" "$node_available" "$node_version" "$git_available" "$git_version" "$codex_available" "$codex_version" "$root_state" "$cache_state"',
    ].join("; ");
    const result = await this.runCommand(command, { signal: options.signal });
    const values = parseInspectionLines(result.stdout);
    const nodeVersion = optionalSanitizedValue(values, "node_version");
    const nodeAvailable = values.node_available === "yes";
    return {
      platform: requiredSanitizedValue(values, "platform"),
      architecture: requiredSanitizedValue(values, "architecture"),
      node: {
        available: nodeAvailable,
        ...(nodeVersion ? { version: nodeVersion } : {}),
        compatible: nodeAvailable && isCompatibleNodeVersion(nodeVersion),
      },
      git: availability(values, "git"),
      codex: availability(values, "codex"),
      managedRootState: parseRootState(values.root_state),
      runnerCacheState: parseCacheState(values.cache_state),
    };
  }

  async installRunnerArtifact(
    artifactPath: string,
    manifest: ManagedRunnerArtifactManifest,
    options: { inspection: ManagedSshInspection; signal?: AbortSignal },
  ): Promise<ManagedRunnerInstallResult> {
    validateManagedRunnerManifest(manifest);
    assertArtifactTargetCompatibility(options.inspection, manifest);
    await verifyLocalArtifact(artifactPath, manifest);
    const startedAt = Date.now();
    const cacheProbeCommand = [
      "exec",
      quoteShellWord(this.nodeCommand),
      "-e",
      quoteShellWord(REMOTE_ARTIFACT_CACHE_PROBE),
      quoteShellWord(this.remoteRoot),
      quoteShellWord(manifest.artifact.sha256),
      String(manifest.artifact.byteSize),
      quoteShellWord(manifest.entrypoint),
    ].join(" ");
    const cacheProbe = await this.runCommand(cacheProbeCommand, {
      signal: options.signal,
    });
    let cacheState: unknown;
    try {
      cacheState = JSON.parse(cacheProbe.stdout.trim());
    } catch {
      throw new Error(
        "Managed SSH artifact cache probe returned invalid output",
      );
    }
    if (!isCacheProbeOutput(cacheState, manifest)) {
      throw new Error(
        "Managed SSH artifact cache probe returned an invalid result",
      );
    }
    if (cacheState.cacheHit) {
      return {
        cacheHit: true,
        remotePath: `${this.remoteRoot}/runner-cache/${manifest.artifact.sha256}/${manifest.entrypoint}`,
        byteSize: manifest.artifact.byteSize,
        sha256: manifest.artifact.sha256,
        durationMs: Date.now() - startedAt,
      };
    }
    const command = [
      "exec",
      quoteShellWord(this.nodeCommand),
      "-e",
      quoteShellWord(REMOTE_ARTIFACT_INSTALLER),
      quoteShellWord(this.remoteRoot),
      quoteShellWord(manifest.artifact.sha256),
      String(manifest.artifact.byteSize),
      quoteShellWord(manifest.entrypoint),
    ].join(" ");
    const result = await this.runCommand(command, {
      input: createReadStream(artifactPath),
      timeoutMs: Math.max(this.operationTimeoutMs, 60_000),
      signal: options.signal,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error("Managed SSH artifact installer returned invalid output");
    }
    if (!isInstallOutput(parsed, manifest)) {
      throw new Error(
        "Managed SSH artifact installer returned an invalid result",
      );
    }
    return {
      cacheHit: parsed.cacheHit,
      remotePath: `${this.remoteRoot}/runner-cache/${manifest.artifact.sha256}/${manifest.entrypoint}`,
      byteSize: manifest.artifact.byteSize,
      sha256: manifest.artifact.sha256,
      durationMs: Date.now() - startedAt,
    };
  }

  async getCodexTranscriptCheckpoint(
    workspaceDirectory: string,
    providerSessionId: string,
    options: { knownRelativePath?: string; signal?: AbortSignal } = {},
  ): Promise<ManagedCodexTranscriptCheckpoint> {
    assertContainedRemotePath(
      this.remoteRoot,
      workspaceDirectory,
      "managed Codex transcript workspace",
    );
    assertManagedCodexSessionId(providerSessionId);
    if (options.knownRelativePath) {
      assertManagedCodexTranscriptRelativePath(options.knownRelativePath);
    }
    const command = [
      "exec",
      quoteShellWord(this.nodeCommand),
      "-e",
      quoteShellWord(REMOTE_CODEX_TRANSCRIPT_CHECKPOINT),
      quoteShellWord(workspaceDirectory),
      quoteShellWord(providerSessionId),
      quoteShellWord(options.knownRelativePath ?? "-"),
    ].join(" ");
    const result = await this.runCommand(command, {
      maxStdoutBytes: MAX_CODEX_TRANSCRIPT_OUTPUT_BYTES,
      signal: options.signal,
    });
    let value: unknown;
    try {
      value = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error("Managed Codex transcript checkpoint was invalid");
    }
    return parseManagedCodexTranscriptCheckpoint(value, providerSessionId);
  }

  async readCodexTranscriptChunk(
    workspaceDirectory: string,
    checkpoint: ManagedCodexTranscriptCheckpoint,
    offset: number,
    byteLength: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<ManagedCodexTranscriptChunk> {
    assertContainedRemotePath(
      this.remoteRoot,
      workspaceDirectory,
      "managed Codex transcript workspace",
    );
    assertManagedCodexSessionId(checkpoint.providerSessionId);
    assertManagedCodexTranscriptRelativePath(checkpoint.relativePath);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > MANAGED_CODEX_TRANSCRIPT_CHUNK_BYTES ||
      offset + byteLength > checkpoint.completeBytes
    ) {
      throw new Error("Managed Codex transcript chunk range is invalid");
    }
    const command = [
      "exec",
      quoteShellWord(this.nodeCommand),
      "-e",
      quoteShellWord(REMOTE_CODEX_TRANSCRIPT_CHUNK),
      quoteShellWord(workspaceDirectory),
      quoteShellWord(checkpoint.providerSessionId),
      quoteShellWord(checkpoint.relativePath),
      quoteShellWord(checkpoint.fileIdentity),
      String(checkpoint.completeBytes),
      String(offset),
      String(byteLength),
    ].join(" ");
    const result = await this.runCommand(command, {
      maxStdoutBytes: MAX_CODEX_TRANSCRIPT_OUTPUT_BYTES,
      signal: options.signal,
    });
    let value: unknown;
    try {
      value = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error("Managed Codex transcript chunk was invalid");
    }
    return parseManagedCodexTranscriptChunk(value, offset, byteLength);
  }

  launchRunner(options: LaunchManagedRunnerOptions): ManagedSshRunnerLaunch {
    assertManagedSshController();
    validateManagedRunnerManifest(options.manifest);
    assertContainedRemotePath(
      this.remoteRoot,
      options.cwd,
      "managed runner cwd",
    );
    const remotePath = `${this.remoteRoot}/runner-cache/${options.manifest.artifact.sha256}/${options.manifest.entrypoint}`;
    const runner = options.allowFakeProvider
      ? `exec env YEP_MANAGED_RUNNER_ALLOW_FAKE=1 ${quoteShellWord(this.nodeCommand)} ${quoteShellWord(remotePath)}`
      : `exec ${quoteShellWord(this.nodeCommand)} ${quoteShellWord(remotePath)}`;
    const command = options.workspaceLease
      ? managedRunnerLeaseCommand(
          this.remoteRoot,
          options.cwd,
          options.workspaceLease,
          runner.replace(/^exec /, ""),
        )
      : `set -eu; cd ${quoteShellWord(options.cwd)}; ${runner}`;
    const child = spawn(this.sshCommand, this.sshArguments(command), {
      env: this.spawnEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return new ManagedSshRunnerLaunch(
      child,
      this.terminationGraceMs,
      DEFAULT_MAX_OUTPUT_BYTES,
    );
  }

  async runCommand(
    remoteCommand: string,
    options: ManagedSshCommandOptions = {},
  ): Promise<ManagedSshCommandResult> {
    assertManagedSshController();
    const timeoutMs = options.timeoutMs ?? this.operationTimeoutMs;
    const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("Managed SSH operation timeout must be positive");
    }
    return await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(this.sshCommand, this.sshArguments(remoteCommand), {
        env: this.spawnEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let operationError: Error | undefined;
      let completed = false;
      let killTimer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
      };
      const stop = (error: Error): void => {
        if (operationError) return;
        operationError = error;
        child.kill("SIGTERM");
        killTimer = setTimeout(
          () => child.kill("SIGKILL"),
          this.terminationGraceMs,
        );
        killTimer.unref();
      };
      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer | string,
        bound: number,
        label: string,
      ): Buffer<ArrayBufferLike> => {
        const next = Buffer.from(chunk);
        if (current.byteLength + next.byteLength > bound) {
          stop(
            new Error(`Managed SSH ${label} exceeded its ${bound}-byte bound`),
          );
          const remaining = Math.max(0, bound - current.byteLength);
          return Buffer.concat([current, next.subarray(0, remaining)]);
        }
        return Buffer.concat([current, next]);
      };
      const abort = (): void =>
        stop(new Error("Managed SSH operation was aborted"));
      const timeout = setTimeout(
        () =>
          stop(
            new Error(`Managed SSH operation timed out after ${timeoutMs}ms`),
          ),
        timeoutMs,
      );
      timeout.unref();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();

      child.stdout.on("data", (chunk) => {
        stdout = append(stdout, chunk, maxStdoutBytes, "stdout");
      });
      child.stderr.on("data", (chunk) => {
        stderr = append(stderr, chunk, maxStderrBytes, "stderr");
      });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") stop(error);
      });
      child.once("error", (error) => {
        if (completed) return;
        completed = true;
        cleanup();
        reject(error);
      });
      child.once("close", (code, signal) => {
        if (completed) return;
        completed = true;
        cleanup();
        const stderrText = stderr.toString("utf8");
        if (operationError) {
          reject(
            new ManagedSshOperationError(
              operationError.message,
              stderrText,
              code,
              signal,
            ),
          );
          return;
        }
        if (code !== 0) {
          reject(
            new ManagedSshOperationError(
              `Managed SSH operation exited with code ${String(code)}${signal ? ` (${signal})` : ""}`,
              stderrText,
              code,
              signal,
            ),
          );
          return;
        }
        resolve({
          stdout: stdout.toString("utf8"),
          stderr: stderrText,
          durationMs: Date.now() - startedAt,
        });
      });

      if (!options.input) {
        child.stdin.end();
      } else if (Buffer.isBuffer(options.input)) {
        child.stdin.end(options.input);
      } else {
        options.input.once("error", stop);
        options.input.pipe(child.stdin);
      }
    });
  }
}

function managedRunnerLeaseCommand(
  remoteRoot: string,
  cwd: string,
  lease: NonNullable<LaunchManagedRunnerOptions["workspaceLease"]>,
  runnerCommand: string,
): string {
  assertContainedRemotePath(
    remoteRoot,
    lease.workspaceDirectory,
    "managed runner workspace lease",
  );
  if (cwd !== `${lease.workspaceDirectory}/worktree`) {
    throw new Error("Managed runner lease does not own the requested cwd");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(lease.leaseId)) {
    throw new Error("Managed runner lease identity is invalid");
  }
  const leaseDirectory = `${lease.workspaceDirectory}/active-runner-lease`;
  assertContainedRemotePath(
    remoteRoot,
    leaseDirectory,
    "managed runner active lease",
  );
  const leaseDirectoryWord = quoteShellWord(leaseDirectory);
  const ownerPathWord = quoteShellWord(`${leaseDirectory}/owner`);
  const leaseIdWord = quoteShellWord(lease.leaseId);
  return [
    "set -eu",
    "umask 077",
    `if ! mkdir ${leaseDirectoryWord}; then printf 'managed workspace already has an active runner\\n' >&2; exit 73; fi`,
    `printf '%s\\n' ${leaseIdWord} > ${ownerPathWord}`,
    `cd ${quoteShellWord(cwd)}`,
    `exec env YEP_MANAGED_RUNNER_LEASE_DIRECTORY=${leaseDirectoryWord} YEP_MANAGED_RUNNER_LEASE_ID=${leaseIdWord} ${runnerCommand}`,
  ].join("; ");
}

function assertManagedSshController(): void {
  if (process.platform === "win32") {
    throw new Error(
      "Managed SSH targets do not yet support Windows controllers",
    );
  }
}

function managedSshProcessEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      (SSH_ENVIRONMENT_ALLOWLIST.has(name) || name.startsWith("LC_"))
    ) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

export async function readManagedRunnerManifest(
  manifestPath: string,
): Promise<ManagedRunnerArtifactManifest> {
  const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManagedRunnerManifest(value);
  return value;
}

export function validateManagedRunnerManifest(
  value: unknown,
): asserts value is ManagedRunnerArtifactManifest {
  const manifest = value as Partial<ManagedRunnerArtifactManifest> | null;
  if (
    manifest?.artifactFormatVersion !== 1 ||
    manifest.runnerProtocolVersion !== 2 ||
    manifest.providerSessionProtocolVersion !== 1 ||
    manifest.entrypoint !== "runner.mjs" ||
    manifest.target?.os !== "linux" ||
    !new Set(["x64", "arm64"]).has(manifest.target?.architecture ?? "") ||
    manifest.node?.range !== ">=20.12" ||
    !Number.isSafeInteger(manifest.artifact?.byteSize) ||
    (manifest.artifact?.byteSize ?? 0) < 1 ||
    (manifest.artifact?.byteSize ?? 0) > MAX_ARTIFACT_BYTES ||
    !SHA256_PATTERN.test(manifest.artifact?.sha256 ?? "")
  ) {
    throw new Error("Managed runner manifest is invalid or incompatible");
  }
}

async function verifyLocalArtifact(
  artifactPath: string,
  manifest: ManagedRunnerArtifactManifest,
): Promise<void> {
  const metadata = await lstat(artifactPath);
  if (!metadata.isFile() || metadata.size !== manifest.artifact.byteSize) {
    throw new Error("Managed runner artifact size does not match its manifest");
  }
  const digest = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(artifactPath)) {
    const bytes = Buffer.from(chunk);
    byteSize += bytes.byteLength;
    if (byteSize > MAX_ARTIFACT_BYTES) {
      throw new Error("Managed runner artifact exceeded its controller bound");
    }
    digest.update(bytes);
  }
  if (
    byteSize !== manifest.artifact.byteSize ||
    digest.digest("hex") !== manifest.artifact.sha256
  ) {
    throw new Error(
      "Managed runner artifact digest does not match its manifest",
    );
  }
}

function assertSafeExecutable(value: string, label: string): void {
  if (
    !SAFE_EXECUTABLE_PATTERN.test(value) ||
    value.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(
      `${label} must be a literal executable name or absolute path`,
    );
  }
}

export function assertSafeRemotePath(value: string, label: string): void {
  if (
    value === "/" ||
    !SAFE_REMOTE_PATH_PATTERN.test(value) ||
    value.includes("//") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a contained absolute POSIX path`);
  }
}

export function assertContainedRemotePath(
  root: string,
  value: string,
  label: string,
): void {
  assertSafeRemotePath(root, "managed remote root");
  assertSafeRemotePath(value, label);
  if (value !== root && !value.startsWith(`${root}/`)) {
    throw new Error(`${label} must stay below the managed remote root`);
  }
}

function assertManagedCodexSessionId(value: string): void {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(value)) {
    throw new Error("Managed Codex provider session identity is invalid");
  }
}

function assertManagedCodexTranscriptRelativePath(value: string): void {
  if (
    value.length > 512 ||
    !/^[A-Za-z0-9._/-]+\.jsonl$/.test(value) ||
    value.startsWith("/") ||
    value.includes("//") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Managed Codex transcript path is invalid");
  }
}

function parseManagedCodexTranscriptCheckpoint(
  value: unknown,
  providerSessionId: string,
): ManagedCodexTranscriptCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed Codex transcript checkpoint was invalid");
  }
  const checkpoint = value as Record<string, unknown>;
  const relativePath = String(checkpoint.relativePath ?? "");
  assertManagedCodexTranscriptRelativePath(relativePath);
  const parsed: ManagedCodexTranscriptCheckpoint = {
    providerSessionId: String(checkpoint.providerSessionId ?? ""),
    relativePath,
    fileIdentity: String(checkpoint.fileIdentity ?? ""),
    metadataSha256: String(checkpoint.metadataSha256 ?? ""),
    completeBytes: Number(checkpoint.completeBytes),
    totalBytes: Number(checkpoint.totalBytes),
    mtimeMs: Number(checkpoint.mtimeMs),
  };
  if (
    parsed.providerSessionId !== providerSessionId ||
    !/^[0-9]+:[0-9]+:[0-9]+$/.test(parsed.fileIdentity) ||
    !SHA256_PATTERN.test(parsed.metadataSha256) ||
    !Number.isSafeInteger(parsed.completeBytes) ||
    parsed.completeBytes < 1 ||
    !Number.isSafeInteger(parsed.totalBytes) ||
    parsed.totalBytes < parsed.completeBytes ||
    !Number.isFinite(parsed.mtimeMs) ||
    parsed.mtimeMs < 0
  ) {
    throw new Error("Managed Codex transcript checkpoint was invalid");
  }
  return parsed;
}

function parseManagedCodexTranscriptChunk(
  value: unknown,
  offset: number,
  byteLength: number,
): ManagedCodexTranscriptChunk {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed Codex transcript chunk was invalid");
  }
  const chunk = value as Record<string, unknown>;
  const encoded = typeof chunk.base64 === "string" ? chunk.base64 : "";
  const bytes = Buffer.from(encoded, "base64");
  const sha256 = String(chunk.sha256 ?? "");
  if (
    Number(chunk.offset) !== offset ||
    Number(chunk.byteLength) !== byteLength ||
    bytes.byteLength !== byteLength ||
    !SHA256_PATTERN.test(sha256) ||
    createHash("sha256").update(bytes).digest("hex") !== sha256
  ) {
    throw new Error("Managed Codex transcript chunk was invalid");
  }
  return { offset, byteLength, sha256, bytes };
}

function parseInspectionLines(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator < 1)
      throw new Error("Managed SSH inspection returned malformed output");
    const key = line.slice(0, separator);
    if (!/^[a-z_]+$/.test(key) || key in values) {
      throw new Error("Managed SSH inspection returned malformed keys");
    }
    values[key] = line.slice(separator + 1);
  }
  return values;
}

function sanitizeInspectionValue(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, 256);
}

function requiredSanitizedValue(
  values: Record<string, string>,
  key: string,
): string {
  const value = optionalSanitizedValue(values, key);
  if (!value) throw new Error(`Managed SSH inspection omitted ${key}`);
  return value;
}

function optionalSanitizedValue(
  values: Record<string, string>,
  key: string,
): string | undefined {
  const value = values[key];
  if (value === undefined || value.length === 0) return undefined;
  return sanitizeInspectionValue(value);
}

function availability(
  values: Record<string, string>,
  name: "git" | "codex",
): { available: boolean; version?: string } {
  const available = values[`${name}_available`] === "yes";
  const version = optionalSanitizedValue(values, `${name}_version`);
  return { available, ...(version ? { version } : {}) };
}

function isCompatibleNodeVersion(version: string | undefined): boolean {
  const match = /^v(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 20 || (major === 20 && minor >= 12);
}

function assertArtifactTargetCompatibility(
  inspection: ManagedSshInspection,
  manifest: ManagedRunnerArtifactManifest,
): void {
  if (inspection.platform !== "Linux") {
    throw new Error(
      "Managed runner artifacts currently require a Linux target",
    );
  }
  const architecture =
    inspection.architecture === "x86_64" || inspection.architecture === "amd64"
      ? "x64"
      : inspection.architecture === "aarch64" ||
          inspection.architecture === "arm64"
        ? "arm64"
        : undefined;
  if (architecture !== manifest.target.architecture) {
    throw new Error(
      "Managed runner artifact does not match target architecture",
    );
  }
  if (!inspection.node.compatible) {
    throw new Error("Managed runner target requires Node.js 20.12 or newer");
  }
  if (
    inspection.managedRootState !== "creatable" &&
    inspection.managedRootState !== "private-writable"
  ) {
    throw new Error("Managed runner target root is not private and writable");
  }
  if (inspection.runnerCacheState === "not-private-writable") {
    throw new Error("Managed runner cache is not private and writable");
  }
}

function parseRootState(
  value: string | undefined,
): ManagedSshInspection["managedRootState"] {
  if (
    value === "private-writable" ||
    value === "writable" ||
    value === "creatable" ||
    value === "missing-parent" ||
    value === "not-directory" ||
    value === "not-writable"
  ) {
    return value;
  }
  throw new Error("Managed SSH inspection returned an invalid root state");
}

function parseCacheState(
  value: string | undefined,
): ManagedSshInspection["runnerCacheState"] {
  if (
    value === "absent" ||
    value === "private-writable" ||
    value === "not-private-writable"
  ) {
    return value;
  }
  throw new Error("Managed SSH inspection returned an invalid cache state");
}

function isInstallOutput(
  value: unknown,
  manifest: ManagedRunnerArtifactManifest,
): value is { cacheHit: boolean; byteSize: number; sha256: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  return (
    typeof output.cacheHit === "boolean" &&
    output.byteSize === manifest.artifact.byteSize &&
    output.sha256 === manifest.artifact.sha256
  );
}

function isCacheProbeOutput(
  value: unknown,
  manifest: ManagedRunnerArtifactManifest,
): value is { cacheHit: boolean; byteSize: number; sha256: string } {
  return isInstallOutput(value, manifest);
}

const REMOTE_ARTIFACT_CACHE_PROBE = String.raw`
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { lstat, realpath } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const [root, digest, sizeText, entrypoint] = process.argv.slice(1);
const size = Number(sizeText);
function safeRoot(value) {
  return typeof value === "string" && value !== "/" && /^\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("//") && !value.split("/").some((part) => part === "." || part === "..");
}
async function main() {
  if (!safeRoot(root) || resolve(root) !== root || !/^[0-9a-f]{64}$/.test(digest || "") || !Number.isSafeInteger(size) || size < 1 || size > ${MAX_ARTIFACT_BYTES} || entrypoint !== "runner.mjs") throw new Error("invalid artifact cache probe");
  const path = join(root, "runner-cache", digest, entrypoint);
  let metadata;
  try {
    if (await realpath(root) !== root) throw new Error("managed root must not traverse symlinks");
    if (await realpath(path) !== path) throw new Error("cached artifact must not be a symlink");
    metadata = await lstat(path);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      process.stdout.write(JSON.stringify({ cacheHit: false, byteSize: size, sha256: digest }) + "\n");
      return;
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.size !== size) throw new Error("cached artifact size mismatch");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== digest) throw new Error("cached artifact digest mismatch");
  process.stdout.write(JSON.stringify({ cacheHit: true, byteSize: size, sha256: digest }) + "\n");
}
main().catch((error) => {
  process.stderr.write("managed artifact cache probe failed: " + (error && error.message ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
`;

const REMOTE_ARTIFACT_INSTALLER = String.raw`
const { createHash, randomUUID } = require("node:crypto");
const { createWriteStream } = require("node:fs");
const { chmod, lstat, mkdir, realpath, rename, rm } = require("node:fs/promises");
const { join, resolve } = require("node:path");
process.umask(0o077);
const [rootArg, digest, sizeText, entrypoint] = process.argv.slice(1);
const size = Number(sizeText);
let stagingDirectory;
function fail(message) { throw new Error(message); }
function safeRoot(value) {
  return typeof value === "string" && value !== "/" && /^\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("//") && !value.split("/").some((part) => part === "." || part === "..");
}
async function verify(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size !== size) fail("cached artifact size mismatch");
  const hash = createHash("sha256");
  const stream = require("node:fs").createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  if (hash.digest("hex") !== digest) fail("cached artifact digest mismatch");
}
async function main() {
  if (Number(process.versions.node.split(".")[0]) < 20) fail("Node.js 20.12 or newer is required");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major === 20 && minor < 12) fail("Node.js 20.12 or newer is required");
  if (!safeRoot(rootArg) || resolve(rootArg) !== rootArg) fail("invalid managed root");
  if (!/^[0-9a-f]{64}$/.test(digest || "")) fail("invalid artifact digest");
  if (!Number.isSafeInteger(size) || size < 1 || size > ${MAX_ARTIFACT_BYTES}) fail("invalid artifact size");
  if (entrypoint !== "runner.mjs") fail("invalid artifact entrypoint");
  await mkdir(rootArg, { recursive: true, mode: 0o700 });
  if (await realpath(rootArg) !== rootArg) fail("managed root must not traverse symlinks");
  await chmod(rootArg, 0o700);
  const cacheDirectory = join(rootArg, "runner-cache");
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await chmod(cacheDirectory, 0o700);
  const finalDirectory = join(cacheDirectory, digest);
  const finalPath = join(finalDirectory, entrypoint);
  try {
    await verify(finalPath);
    await chmod(finalDirectory, 0o700);
    await chmod(finalPath, 0o700);
    process.stdin.resume();
    for await (const _chunk of process.stdin) {}
    process.stdout.write(JSON.stringify({ cacheHit: true, byteSize: size, sha256: digest }) + "\n");
    return;
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  stagingDirectory = join(cacheDirectory, ".incoming-" + process.pid + "-" + randomUUID());
  const stagingPath = join(stagingDirectory, entrypoint);
  await mkdir(stagingDirectory, { mode: 0o700 });
  const output = createWriteStream(stagingPath, { flags: "wx", mode: 0o600 });
  const hash = createHash("sha256");
  let received = 0;
  try {
    for await (const chunk of process.stdin) {
      received += chunk.length;
      if (received > size) fail("artifact transfer exceeded announced size");
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise((resolveDrain) => output.once("drain", resolveDrain));
    }
    await new Promise((resolveEnd, rejectEnd) => {
      output.once("error", rejectEnd);
      output.end(resolveEnd);
    });
    if (received !== size) fail("artifact transfer was incomplete");
    if (hash.digest("hex") !== digest) fail("artifact transfer digest mismatch");
    await chmod(stagingPath, 0o700);
    try {
      await rename(stagingDirectory, finalDirectory);
      stagingDirectory = undefined;
    } catch (error) {
      if (!error || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")) throw error;
      await verify(finalPath);
    }
    await verify(finalPath);
    process.stdout.write(JSON.stringify({ cacheHit: false, byteSize: size, sha256: digest }) + "\n");
  } finally {
    output.destroy();
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  if (stagingDirectory) rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
  process.stderr.write("managed artifact install failed: " + (error && error.message ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
`;

const REMOTE_CODEX_TRANSCRIPT_CHECKPOINT = String.raw`
const { createHash } = require("node:crypto");
const { lstat, open, readdir, realpath } = require("node:fs/promises");
const { join, relative, resolve, sep } = require("node:path");
const [workspace, providerSessionId, knownRelativePath] = process.argv.slice(1);
const MAX_FILES = 4096;
const MAX_METADATA_BYTES = 256 * 1024;
const BACKWARD_READ_BYTES = 64 * 1024;
function fail(message) { throw new Error(message); }
function safeAbsolute(value) {
  return typeof value === "string" && value !== "/" && /^\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("//") && !value.split("/").some((part) => part === "." || part === "..");
}
function safeRelative(value) {
  return typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9._/-]+\.jsonl$/.test(value) && !value.startsWith("/") && !value.includes("//") && !value.split("/").some((part) => part === "." || part === "..");
}
function contained(root, path) { return path.startsWith(root + sep); }
async function readMetadata(handle, size) {
  const length = Math.min(size, MAX_METADATA_BYTES);
  const buffer = Buffer.alloc(length);
  const result = await handle.read(buffer, 0, length, 0);
  const newline = buffer.subarray(0, result.bytesRead).indexOf(0x0a);
  if (newline < 0) fail("rollout metadata line is incomplete or oversized");
  const line = buffer.subarray(0, newline);
  let value;
  try { value = JSON.parse(line.toString("utf8")); } catch { fail("rollout metadata is invalid"); }
  if (value?.type !== "session_meta" || value?.payload?.id !== providerSessionId) return null;
  return createHash("sha256").update(line).digest("hex");
}
async function completeBytes(handle, size) {
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - BACKWARD_READ_BYTES);
    const length = end - start;
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, start);
    const newline = buffer.subarray(0, result.bytesRead).lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    end = start;
  }
  return 0;
}
async function inspect(path, root) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
  const actual = await realpath(path);
  if (!contained(root, actual)) fail("rollout escaped its sessions root");
  const handle = await open(actual, "r");
  try {
    const stats = await handle.stat();
    if (!Number.isSafeInteger(stats.size) || stats.size < 1) return null;
    const metadataSha256 = await readMetadata(handle, stats.size);
    if (!metadataSha256) return null;
    const complete = await completeBytes(handle, stats.size);
    if (complete < 1) fail("rollout has no complete JSONL record");
    return {
      providerSessionId,
      relativePath: relative(root, actual).split(sep).join("/"),
      fileIdentity: String(stats.dev) + ":" + String(stats.ino) + ":" + String(Math.max(0, Math.trunc(stats.birthtimeMs))),
      metadataSha256,
      completeBytes: complete,
      totalBytes: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}
async function walk(root) {
  const files = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_FILES) fail("rollout discovery exceeded its file bound");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  return files;
}
async function main() {
  if (!safeAbsolute(workspace) || resolve(workspace) !== workspace) fail("invalid managed workspace");
  if (!/^[A-Za-z0-9-]{8,128}$/.test(providerSessionId || "")) fail("invalid provider session id");
  if (knownRelativePath !== "-" && !safeRelative(knownRelativePath)) fail("invalid known rollout path");
  if (await realpath(workspace) !== workspace) fail("managed workspace must not traverse symlinks");
  const root = join(workspace, "codex-home", "sessions");
  if (await realpath(root) !== root) fail("rollout sessions root must not traverse symlinks");
  const matches = [];
  if (knownRelativePath !== "-") {
    const knownPath = resolve(root, knownRelativePath);
    if (!contained(root, knownPath)) fail("known rollout path escaped its root");
    try {
      const known = await inspect(knownPath, root);
      if (known) matches.push(known);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
  for (const path of await walk(root)) {
    if (knownRelativePath !== "-" && relative(root, path).split(sep).join("/") === knownRelativePath) continue;
    try {
      const candidate = await inspect(path, root);
      if (candidate) matches.push(candidate);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
  if (matches.length === 0) fail("provider rollout was not found");
  matches.sort((left, right) => right.mtimeMs - left.mtimeMs || right.relativePath.localeCompare(left.relativePath));
  process.stdout.write(JSON.stringify(matches[0]) + "\n");
}
main().catch((error) => {
  process.stderr.write("managed Codex transcript checkpoint failed: " + (error?.message || String(error)) + "\n");
  process.exitCode = 1;
});
`;

const REMOTE_CODEX_TRANSCRIPT_CHUNK = String.raw`
const { createHash } = require("node:crypto");
const { open, realpath } = require("node:fs/promises");
const { join, resolve, sep } = require("node:path");
const [workspace, providerSessionId, relativePath, expectedIdentity, completeText, offsetText, lengthText] = process.argv.slice(1);
const complete = Number(completeText);
const offset = Number(offsetText);
const length = Number(lengthText);
function fail(message) { throw new Error(message); }
function safeAbsolute(value) {
  return typeof value === "string" && value !== "/" && /^\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("//") && !value.split("/").some((part) => part === "." || part === "..");
}
function safeRelative(value) {
  return typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9._/-]+\.jsonl$/.test(value) && !value.startsWith("/") && !value.includes("//") && !value.split("/").some((part) => part === "." || part === "..");
}
function contained(root, path) { return path.startsWith(root + sep); }
async function main() {
  if (!safeAbsolute(workspace) || resolve(workspace) !== workspace) fail("invalid managed workspace");
  if (!/^[A-Za-z0-9-]{8,128}$/.test(providerSessionId || "")) fail("invalid provider session id");
  if (!safeRelative(relativePath)) fail("invalid rollout path");
  if (!/^[0-9]+:[0-9]+:[0-9]+$/.test(expectedIdentity || "")) fail("invalid rollout identity");
  if (!Number.isSafeInteger(complete) || complete < 1 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > ${MANAGED_CODEX_TRANSCRIPT_CHUNK_BYTES} || offset + length > complete) fail("invalid transcript chunk range");
  if (await realpath(workspace) !== workspace) fail("managed workspace must not traverse symlinks");
  const root = join(workspace, "codex-home", "sessions");
  if (await realpath(root) !== root) fail("rollout sessions root must not traverse symlinks");
  const path = resolve(root, relativePath);
  if (!contained(root, path) || await realpath(path) !== path) fail("rollout path escaped its root");
  const handle = await open(path, "r");
  try {
    const stats = await handle.stat();
    const identity = String(stats.dev) + ":" + String(stats.ino) + ":" + String(Math.max(0, Math.trunc(stats.birthtimeMs)));
    if (identity !== expectedIdentity) fail("rollout generation changed");
    if (stats.size < complete) fail("rollout was truncated");
    const buffer = Buffer.alloc(length);
    let received = 0;
    while (received < length) {
      const result = await handle.read(buffer, received, length - received, offset + received);
      if (result.bytesRead < 1) fail("rollout chunk ended early");
      received += result.bytesRead;
    }
    process.stdout.write(JSON.stringify({
      offset,
      byteLength: length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      base64: buffer.toString("base64"),
    }) + "\n");
  } finally {
    await handle.close();
  }
}
main().catch((error) => {
  process.stderr.write("managed Codex transcript chunk failed: " + (error?.message || String(error)) + "\n");
  process.exitCode = 1;
});
`;
