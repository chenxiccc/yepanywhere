import { fork, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLogger } from "../logging/logger.js";
import type { SessionSummary } from "../supervisor/types.js";
import {
  type SummaryParserClientEvent,
  type SummaryParserClientStatus,
  type SummaryParserWorkerError,
  type SummaryParserWorkerLimits,
  type SummaryParserWorkerMode,
  type SummaryParserWorkerRequest,
  type SummaryParserWorkerResponse,
  isSummaryParserWorkerReady,
  isSummaryParserWorkerResponse,
  sanitizeSummaryParserError,
} from "./summary-parser-worker-protocol.js";

type RuntimeKind = "source" | "built";

export interface SupportedSummaryParserWorkerEntrypoint {
  supported: true;
  runtime: RuntimeKind;
  modulePath: string;
  execArgv: string[];
}

export interface UnsupportedSummaryParserWorkerEntrypoint {
  supported: false;
  runtime: RuntimeKind;
  reason: string;
}

export type SummaryParserWorkerEntrypoint =
  | SupportedSummaryParserWorkerEntrypoint
  | UnsupportedSummaryParserWorkerEntrypoint;

export interface ResolveSummaryParserWorkerEntrypointOptions {
  runtime?: RuntimeKind | "auto";
  baseDir?: string;
  nodeVersion?: string;
}

export type InProcessSummaryParser = (
  request: SummaryParserWorkerRequest,
) => Promise<SessionSummary | null>;

export interface SummaryParserClientResult {
  summary: SessionSummary | null;
  status: SummaryParserClientStatus;
  source: "worker" | "fallback";
  response?: SummaryParserWorkerResponse;
  fallbackReason?: string;
  error?: SummaryParserWorkerError;
}

export interface SummaryParserClientOptions {
  mode?: SummaryParserWorkerMode;
  timeoutMs?: number;
  launchTimeoutMs?: number;
  idleTimeoutMs?: number;
  recycleAfterBytes?: number;
  recycleAfterFiles?: number;
  recycleAfterLineBytes?: number;
  entrypoint?: SummaryParserWorkerEntrypoint;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: SummaryParserClientEvent) => void;
}

class SummaryParserWorkerSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryParserWorkerSetupError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_RECYCLE_AFTER_BYTES = 512 * 1024 * 1024;
const DEFAULT_RECYCLE_AFTER_LINE_BYTES = 16 * 1024 * 1024;

const thisDir = dirname(fileURLToPath(import.meta.url));

export function supportsTsxImportWorker(nodeVersion: string): boolean {
  const match = nodeVersion.match(/^v?(\d+)\.(\d+)\./);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 20 || (major === 20 && minor >= 6);
}

function defaultRuntime(): RuntimeKind {
  return thisDir.includes(`${join("dist", "sessions")}`) ? "built" : "source";
}

export function resolveSummaryParserWorkerEntrypoint(
  options: ResolveSummaryParserWorkerEntrypointOptions = {},
): SummaryParserWorkerEntrypoint {
  const runtime =
    options.runtime && options.runtime !== "auto"
      ? options.runtime
      : defaultRuntime();
  const baseDir = options.baseDir ?? thisDir;

  if (runtime === "built") {
    return {
      supported: true,
      runtime,
      modulePath: join(baseDir, "summary-parser-worker-entry.js"),
      execArgv: [],
    };
  }

  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (!supportsTsxImportWorker(nodeVersion)) {
    return {
      supported: false,
      runtime,
      reason: `source worker requires Node >=20.6 for --import tsx (current ${nodeVersion})`,
    };
  }

  return {
    supported: true,
    runtime,
    modulePath: join(baseDir, "summary-parser-worker-entry.ts"),
    execArgv: ["--conditions", "source", "--import", "tsx"],
  };
}

export class SummaryParserClient {
  private readonly mode: SummaryParserWorkerMode;
  private readonly timeoutMs: number;
  private readonly launchTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly recycleLimits: SummaryParserWorkerLimits;
  private readonly cwd?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly onEvent?: (event: SummaryParserClientEvent) => void;
  private child: ChildProcess | null = null;
  private childGeneration = 0;
  private childParsedFiles = 0;
  private childParsedBytes = 0;
  private activeRequestId: string | null = null;
  private workerParseQueue: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: SummaryParserClientOptions = {}) {
    this.mode = options.mode ?? "off";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.recycleLimits = {
      recycleAfterBytes: normalizePositiveLimit(
        options.recycleAfterBytes,
        DEFAULT_RECYCLE_AFTER_BYTES,
      ),
      recycleAfterFiles: normalizePositiveLimit(options.recycleAfterFiles),
      recycleAfterLineBytes: normalizePositiveLimit(
        options.recycleAfterLineBytes,
        DEFAULT_RECYCLE_AFTER_LINE_BYTES,
      ),
    };
    this.cwd = options.cwd;
    this.env = options.env;
    this.onEvent = options.onEvent;
  }

  async parse(
    request: SummaryParserWorkerRequest,
    inProcessParser?: InProcessSummaryParser,
  ): Promise<SummaryParserClientResult> {
    if (this.mode === "off") {
      return this.runFallback(request, "mode_off", inProcessParser);
    }

    const entrypoint =
      this.options.entrypoint ?? resolveSummaryParserWorkerEntrypoint();
    if (!entrypoint.supported) {
      return this.handleSetupFailure(
        request,
        entrypoint.reason,
        inProcessParser,
      );
    }

    return this.withWorkerParseSlot(async () => {
      try {
        const requestWithLimits = this.applyDefaultLimits(request);
        const response = await this.parseWithWorker(
          requestWithLimits,
          entrypoint,
        );
        const recycleReason = this.applyRecyclePolicy(
          requestWithLimits,
          response,
        );
        const status = clientStatusFromResponse(response);
        const event: SummaryParserClientEvent = {
          event: "summary_parser_worker_result",
          provider: requestWithLimits.provider,
          sessionId: requestWithLimits.sessionId,
          filePath: requestWithLimits.filePath,
          mode: this.mode,
          status,
          workerPid: response.metrics.workerPid,
          workerGeneration: response.metrics.workerGeneration,
          ...(response.error ? { error: response.error } : {}),
        };
        this.emitEvent(event);
        this.logResult(event, response);
        if (recycleReason) {
          await this.recycleChild(response, recycleReason);
        }
        return {
          summary: response.summary,
          status,
          source: "worker",
          response,
          ...(response.error ? { error: response.error } : {}),
        };
      } catch (error) {
        if (error instanceof SummaryParserWorkerSetupError) {
          return this.handleSetupFailure(
            request,
            error.message,
            inProcessParser,
          );
        }
        const sanitized = sanitizeSummaryParserError(error);
        await this.stopChild("crash");
        const event: SummaryParserClientEvent = {
          event: "summary_parser_worker_result",
          provider: request.provider,
          sessionId: request.sessionId,
          filePath: request.filePath,
          mode: this.mode,
          status: "crash",
          error: sanitized,
        };
        this.emitEvent(event);
        getLogger().warn(
          event,
          "SUMMARY_PARSER_WORKER: parse failed after worker crash",
        );
        return {
          summary: null,
          status: "crash",
          source: "worker",
          error: sanitized,
        };
      }
    });
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    await this.stopChild("client_close");
  }

  private async handleSetupFailure(
    request: SummaryParserWorkerRequest,
    reason: string,
    inProcessParser?: InProcessSummaryParser,
  ): Promise<SummaryParserClientResult> {
    if (this.mode === "on") {
      return this.runFallback(request, reason, inProcessParser);
    }
    throw new SummaryParserWorkerSetupError(reason);
  }

  private async runFallback(
    request: SummaryParserWorkerRequest,
    reason: string,
    inProcessParser?: InProcessSummaryParser,
  ): Promise<SummaryParserClientResult> {
    if (!inProcessParser) {
      throw new SummaryParserWorkerSetupError(
        `summary parser fallback unavailable: ${reason}`,
      );
    }
    const summary = await inProcessParser(request);
    this.emitEvent({
      event: "summary_parser_worker_fallback",
      provider: request.provider,
      sessionId: request.sessionId,
      filePath: request.filePath,
      mode: this.mode,
      status: "fallback",
      fallbackReason: reason,
    });
    getLogger().warn(
      {
        event: "summary_parser_worker_fallback",
        provider: request.provider,
        sessionId: request.sessionId,
        filePath: request.filePath,
        mode: this.mode,
        fallbackReason: reason,
      },
      "SUMMARY_PARSER_WORKER: using in-process fallback",
    );
    return {
      summary,
      status: "fallback",
      source: "fallback",
      fallbackReason: reason,
    };
  }

  private applyDefaultLimits(
    request: SummaryParserWorkerRequest,
  ): SummaryParserWorkerRequest {
    const limits = compactLimits({
      ...this.recycleLimits,
      ...request.limits,
    });
    if (Object.keys(limits).length > 0) {
      return { ...request, limits };
    }
    const { limits: _limits, ...requestWithoutLimits } = request;
    return requestWithoutLimits;
  }

  private applyRecyclePolicy(
    request: SummaryParserWorkerRequest,
    response: SummaryParserWorkerResponse,
  ): string | null {
    this.childParsedFiles += 1;
    this.childParsedBytes += Math.max(0, response.metrics.fileSize);
    response.metrics.workerGeneration ??= this.childGeneration;
    response.metrics.workerParsedFiles = this.childParsedFiles;
    response.metrics.workerParsedBytes = this.childParsedBytes;

    let recycleReason = response.metrics.recycleRecommended
      ? (response.metrics.recycleReason ?? "worker_recommended")
      : null;

    const lineLimit = request.limits?.recycleAfterLineBytes;
    if (
      !recycleReason &&
      lineLimit !== undefined &&
      response.metrics.maxLineLength !== undefined &&
      response.metrics.maxLineLength >= lineLimit
    ) {
      recycleReason = "large_line";
    }

    const byteLimit = request.limits?.recycleAfterBytes;
    if (
      !recycleReason &&
      byteLimit !== undefined &&
      this.childParsedBytes >= byteLimit
    ) {
      recycleReason = "byte_budget";
    }

    const fileLimit = request.limits?.recycleAfterFiles;
    if (
      !recycleReason &&
      fileLimit !== undefined &&
      this.childParsedFiles >= fileLimit
    ) {
      recycleReason = "file_budget";
    }

    if (recycleReason) {
      response.metrics.recycleRecommended = true;
      response.metrics.recycleReason = recycleReason;
    }

    return recycleReason;
  }

  private async recycleChild(
    response: SummaryParserWorkerResponse,
    reason: string,
  ): Promise<void> {
    const startedAt = Date.now();
    await this.stopChild(`recycle_${reason}`);
    getLogger().info(
      {
        event: "summary_parser_worker_recycle",
        provider: response.metrics.provider,
        sessionId: response.metrics.sessionId,
        filePath: response.metrics.filePath,
        reason,
        workerPid: response.metrics.workerPid,
        workerGeneration: response.metrics.workerGeneration,
        stopMs: Date.now() - startedAt,
        workerParsedFiles: response.metrics.workerParsedFiles,
        workerParsedBytes: response.metrics.workerParsedBytes,
        fileSize: response.metrics.fileSize,
        maxLineLength: response.metrics.maxLineLength,
      },
      "SUMMARY_PARSER_WORKER: recycled child",
    );
  }

  private emitEvent(event: SummaryParserClientEvent): void {
    this.onEvent?.(event);
  }

  private logResult(
    event: SummaryParserClientEvent,
    response: SummaryParserWorkerResponse,
  ): void {
    const payload = {
      ...event,
      metrics: response.metrics,
      ...(response.error ? { error: response.error } : {}),
    };
    if (event.status === "ok" || event.status === "empty") {
      getLogger().debug(payload, "SUMMARY_PARSER_WORKER: parse complete");
      return;
    }
    getLogger().warn(payload, "SUMMARY_PARSER_WORKER: parse failed");
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.activeRequestId) return;
      void this.stopChild("idle_timeout");
    }, this.idleTimeoutMs);
  }

  private async withWorkerParseSlot<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.workerParseQueue;
    let release!: () => void;
    this.workerParseQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async parseWithWorker(
    request: SummaryParserWorkerRequest,
    entrypoint: SupportedSummaryParserWorkerEntrypoint,
  ): Promise<SummaryParserWorkerResponse> {
    if (this.activeRequestId) {
      throw new Error(
        `summary parser worker already has active request ${this.activeRequestId}`,
      );
    }

    const child = await this.ensureChild(entrypoint);
    this.activeRequestId = request.requestId;

    return new Promise<SummaryParserWorkerResponse>((resolve, reject) => {
      let settled = false;
      let sendAccepted = false;
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("disconnect", onDisconnect);
        child.off("error", onError);
        this.activeRequestId = null;
        this.scheduleIdleStop();
      };
      const finish = (
        result:
          | { type: "resolve"; response: SummaryParserWorkerResponse }
          | { type: "reject"; error: unknown },
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (result.type === "resolve") {
          resolve(result.response);
        } else {
          reject(result.error);
        }
      };
      const onMessage = (message: unknown) => {
        if (!isSummaryParserWorkerResponse(message)) return;
        if (message.requestId !== request.requestId) return;
        finish({ type: "resolve", response: message });
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        this.child = null;
        const detail = `worker exited before response (code=${code ?? "null"}, signal=${signal ?? "null"})`;
        finish({
          type: "reject",
          error: sendAccepted
            ? new Error(detail)
            : new SummaryParserWorkerSetupError(detail),
        });
      };
      const onDisconnect = () => {
        this.child = null;
        const error = sendAccepted
          ? new Error("worker disconnected before response")
          : new SummaryParserWorkerSetupError(
              "worker disconnected before accepting request",
            );
        finish({ type: "reject", error });
      };
      const onError = (error: Error) => {
        finish({
          type: "reject",
          error: sendAccepted
            ? error
            : new SummaryParserWorkerSetupError(error.message),
        });
      };
      const requestTimeoutMs = request.limits?.timeoutMs ?? this.timeoutMs;
      const timeout = setTimeout(() => {
        const response = timeoutResponse(
          request,
          this.childGeneration,
          child.pid ?? 0,
          requestTimeoutMs,
        );
        finish({ type: "resolve", response });
        void this.stopChild("timeout");
      }, requestTimeoutMs);

      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("disconnect", onDisconnect);
      child.once("error", onError);
      child.send(request, (error) => {
        if (error) {
          finish({
            type: "reject",
            error: new SummaryParserWorkerSetupError(error.message),
          });
          return;
        }
        sendAccepted = true;
      });
    });
  }

  private async ensureChild(
    entrypoint: SupportedSummaryParserWorkerEntrypoint,
  ): Promise<ChildProcess> {
    this.clearIdleTimer();
    if (this.child?.connected) {
      return this.child;
    }

    const child = fork(entrypoint.modulePath, [], {
      cwd: this.cwd ?? defaultWorkerCwd(entrypoint.modulePath),
      env: this.env ? { ...process.env, ...this.env } : process.env,
      execArgv: entrypoint.execArgv,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child = child;
    this.childGeneration += 1;
    this.childParsedFiles = 0;
    this.childParsedBytes = 0;
    const startedAt = Date.now();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("disconnect", onDisconnect);
        child.off("error", onError);
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          this.child = null;
          reject(error);
          return;
        }
        resolve();
      };
      const onMessage = (message: unknown) => {
        if (isSummaryParserWorkerReady(message)) {
          finish();
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(
          new SummaryParserWorkerSetupError(
            `worker exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          ),
        );
      };
      const onDisconnect = () => {
        finish(
          new SummaryParserWorkerSetupError("worker disconnected before ready"),
        );
      };
      const onError = (error: Error) => {
        finish(new SummaryParserWorkerSetupError(error.message));
      };
      const timeout = setTimeout(() => {
        finish(new SummaryParserWorkerSetupError("worker ready timeout"));
        void this.stopChild("launch_timeout");
      }, this.launchTimeoutMs);

      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("disconnect", onDisconnect);
      child.once("error", onError);
    });

    getLogger().debug(
      {
        event: "summary_parser_worker_start",
        workerPid: child.pid,
        workerGeneration: this.childGeneration,
        runtime: entrypoint.runtime,
        modulePath: entrypoint.modulePath,
        launchMs: Date.now() - startedAt,
      },
      "SUMMARY_PARSER_WORKER: child ready",
    );

    return child;
  }

  private async stopChild(reason: string): Promise<void> {
    this.clearIdleTimer();
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill();
      getLogger().debug(
        { event: "summary_parser_worker_stop", reason },
        "SUMMARY_PARSER_WORKER: stopping child",
      );
    });
  }
}

function normalizePositiveLimit(
  value: number | undefined,
  fallback?: number,
): number | undefined {
  const candidate = value ?? fallback;
  if (
    candidate === undefined ||
    !Number.isFinite(candidate) ||
    candidate <= 0
  ) {
    return undefined;
  }
  return Math.floor(candidate);
}

function compactLimits(
  limits: SummaryParserWorkerLimits,
): SummaryParserWorkerLimits {
  const compacted: SummaryParserWorkerLimits = {};
  const timeoutMs = normalizePositiveLimit(limits.timeoutMs);
  if (timeoutMs !== undefined) {
    compacted.timeoutMs = timeoutMs;
  }
  const recycleAfterBytes = normalizePositiveLimit(limits.recycleAfterBytes);
  if (recycleAfterBytes !== undefined) {
    compacted.recycleAfterBytes = recycleAfterBytes;
  }
  const recycleAfterFiles = normalizePositiveLimit(limits.recycleAfterFiles);
  if (recycleAfterFiles !== undefined) {
    compacted.recycleAfterFiles = recycleAfterFiles;
  }
  const recycleAfterLineBytes = normalizePositiveLimit(
    limits.recycleAfterLineBytes,
  );
  if (recycleAfterLineBytes !== undefined) {
    compacted.recycleAfterLineBytes = recycleAfterLineBytes;
  }
  return compacted;
}

function defaultWorkerCwd(modulePath: string): string {
  return resolve(dirname(modulePath), "..", "..");
}

function timeoutResponse(
  request: SummaryParserWorkerRequest,
  workerGeneration: number,
  workerPid: number,
  timeoutMs: number,
): SummaryParserWorkerResponse {
  return {
    type: "result",
    requestId: request.requestId,
    status: "error",
    summary: null,
    metrics: {
      provider: request.provider,
      sessionId: request.sessionId,
      filePath: request.filePath,
      fileSize: request.stats.size,
      fileMtimeMs: request.stats.mtimeMs,
      workerPid,
      workerGeneration,
      nodeVersion: process.version,
      durationMs: timeoutMs,
      heapUsedBefore: 0,
      heapUsedAfter: 0,
      rssBefore: 0,
      rssAfter: 0,
      recycleRecommended: true,
      recycleReason: "timeout",
    },
    error: {
      name: "TimeoutError",
      message: "summary parser worker timed out",
    },
  };
}

function clientStatusFromResponse(
  response: SummaryParserWorkerResponse,
): SummaryParserClientStatus {
  if (response.error?.name === "TimeoutError") {
    return "timeout";
  }
  return response.status;
}
