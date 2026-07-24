/**
 * BangCommandService runs `!!command` composer submissions as local shell
 * commands in a session's project directory, entirely outside provider
 * context. Each run persists as a `bang-command` transcript display object
 * (bounded previews in session metadata); full output lands in per-session
 * files under {dataDir}/bang-commands/ and is fetched on demand.
 *
 * Contract: topics/bang-commands.md.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Writable } from "node:stream";
import type {
  BangCommandTranscriptDisplayObject,
  TranscriptDisplayObject,
} from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";

const STDOUT_PREVIEW_MAX_CHARS = 4096;
const STDERR_PREVIEW_MAX_CHARS = 2048;
const OUTPUT_FILE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_FLUSH_INTERVAL_MS = 750;
const SIGKILL_GRACE_MS = 2000;
const MAX_BANG_OBJECTS_PER_SESSION = 100;
const MAX_ACTIVE_BANG_COMMANDS_PER_SESSION = 4;
export const BANG_OUTPUT_READ_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Agent-session identity markers scrubbed from the child environment so a
 * bang-run tool (e.g. agentctl) never adopts an agent session's identity.
 * BASH_ENV is scrubbed too: an agent launcher's bridge script would
 * otherwise be re-sourced by the child bash and re-inject the identity
 * vars this list just removed.
 */
const SCRUBBED_ENV_VARS = [
  "AGENTCTL_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDECODE",
  "BASH_ENV",
];

interface BangEventSink {
  emit(event: {
    type: "session-metadata-changed";
    sessionId: string;
    transcriptDisplayObjects: TranscriptDisplayObject[];
    timestamp: string;
  }): void;
}

export interface BangCommandServiceOptions {
  dataDir: string;
  sessionMetadataService: SessionMetadataService;
  eventBus?: BangEventSink;
  /** Wall-clock cap per command; the run is killed past it. */
  timeoutMs?: number;
  /** Coalescing interval for streaming preview updates. */
  flushIntervalMs?: number;
  /** Concurrent command cap per session. */
  maxActivePerSession?: number;
  /** Persisted display-object cap per session. */
  maxObjectsPerSession?: number;
  /** Stored byte cap for each stdout/stderr file. */
  outputFileMaxBytes?: number;
  /** Test seam for output-storage failures. */
  createOutputStream?: (filePath: string) => Writable;
}

export interface BangRunRequest {
  sessionId: string;
  projectPath: string;
  command: string;
  placementAfterMessageId: string;
}

export interface BangRunHandle {
  object: BangCommandTranscriptDisplayObject;
  /** Resolves with the final object state; never rejects. */
  completion: Promise<BangCommandTranscriptDisplayObject>;
}

interface RunningEntry {
  sessionId: string;
  child: ReturnType<typeof spawn>;
  killedReason?: string;
  completion?: Promise<BangCommandTranscriptDisplayObject>;
}

interface OutputCapture {
  bytes: number;
  tail: string;
  truncated: boolean;
  sinkError?: string;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function appendTail(tail: string, chunk: string, maxChars: number): string {
  return (tail + chunk).slice(-maxChars);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finishWritable(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once("finish", settle);
    stream.once("close", settle);
    if (stream.destroyed) {
      settle();
      return;
    }
    try {
      stream.end();
    } catch {
      settle();
    }
  });
}

export class BangCommandService {
  private readonly dataDir: string;
  private readonly metadata: SessionMetadataService;
  private readonly eventBus?: BangEventSink;
  private readonly timeoutMs: number;
  private readonly flushIntervalMs: number;
  private readonly maxActivePerSession: number;
  private readonly maxObjectsPerSession: number;
  private readonly outputFileMaxBytes: number;
  private readonly createOutputStream: (filePath: string) => Writable;
  private readonly running = new Map<string, RunningEntry>();
  private readonly startingBySession = new Map<string, number>();
  private disposed = false;

  constructor(options: BangCommandServiceOptions) {
    this.dataDir = options.dataDir;
    this.metadata = options.sessionMetadataService;
    this.eventBus = options.eventBus;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxActivePerSession =
      options.maxActivePerSession ?? MAX_ACTIVE_BANG_COMMANDS_PER_SESSION;
    this.maxObjectsPerSession =
      options.maxObjectsPerSession ?? MAX_BANG_OBJECTS_PER_SESSION;
    this.outputFileMaxBytes =
      options.outputFileMaxBytes ?? OUTPUT_FILE_MAX_BYTES;
    this.createOutputStream =
      options.createOutputStream ??
      ((filePath) => fs.createWriteStream(filePath));
  }

  isRunning(objectId: string): boolean {
    return this.running.has(objectId);
  }

  outputPath(sessionId: string, objectId: string, stream: "stdout" | "stderr") {
    return path.join(
      this.dataDir,
      "bang-commands",
      safePathSegment(sessionId),
      `${safePathSegment(objectId)}.${stream}`,
    );
  }

  async run(request: BangRunRequest): Promise<BangRunHandle> {
    const { sessionId, projectPath, command } = request;
    if (this.disposed) {
      throw new Error("Bang command service is shutting down");
    }
    const runningForSession = [...this.running.values()].filter(
      (entry) => entry.sessionId === sessionId,
    ).length;
    const startingForSession = this.startingBySession.get(sessionId) ?? 0;
    if (runningForSession + startingForSession >= this.maxActivePerSession) {
      throw new Error(
        `Too many concurrent bang commands for this session (maximum ${this.maxActivePerSession})`,
      );
    }
    this.startingBySession.set(sessionId, startingForSession + 1);

    const id = randomUUID();
    const startedAtMs = Date.now();
    const object: BangCommandTranscriptDisplayObject = {
      id,
      kind: "bang-command",
      createdAt: new Date(startedAtMs).toISOString(),
      placementAfterMessageId: request.placementAfterMessageId,
      command,
      cwd: projectPath,
      status: "running",
    };

    let objectAdded = false;
    try {
      await this.pruneOldObjects(sessionId);
      await this.metadata.addTranscriptDisplayObject(sessionId, object);
      objectAdded = true;
      this.emitObjects(sessionId);

      const outDir = path.dirname(this.outputPath(sessionId, id, "stdout"));
      await fsp.mkdir(outDir, { recursive: true });
      if (this.disposed) {
        const patch: Partial<BangCommandTranscriptDisplayObject> = {
          status: "killed",
          durationMs: Date.now() - startedAtMs,
          error: "Interrupted by server shutdown",
        };
        await this.updateObject(sessionId, id, patch).catch(() => {});
        throw new Error("Bang command service is shutting down");
      }
    } catch (error) {
      if (objectAdded) {
        await this.updateObject(sessionId, id, {
          status: this.disposed ? "killed" : "error",
          durationMs: Date.now() - startedAtMs,
          error: this.disposed
            ? "Interrupted by server shutdown"
            : `Failed to start command: ${errorMessage(error)}`,
        }).catch(() => {});
      }
      this.decrementStarting(sessionId);
      throw error;
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of SCRUBBED_ENV_VARS) {
      delete env[name];
    }
    env.PATH = env.PATH
      ? `${env.PATH}${path.delimiter}${projectPath}`
      : projectPath;

    let stdoutFile: Writable;
    let stderrFile: Writable;
    let child: ReturnType<typeof spawn>;
    try {
      stdoutFile = this.createOutputStream(
        this.outputPath(sessionId, id, "stdout"),
      );
      try {
        stderrFile = this.createOutputStream(
          this.outputPath(sessionId, id, "stderr"),
        );
      } catch (error) {
        stdoutFile.destroy();
        throw error;
      }
      try {
        // detached: the child leads its own process group so kill() can signal
        // the whole pipeline, not just the bash wrapper.
        child = spawn("bash", ["-c", command], {
          cwd: projectPath,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        stdoutFile.destroy();
        stderrFile.destroy();
        throw error;
      }
    } catch (error) {
      await this.updateObject(sessionId, id, {
        status: "error",
        durationMs: Date.now() - startedAtMs,
        error: `Failed to start command: ${errorMessage(error)}`,
      }).catch(() => {});
      this.decrementStarting(sessionId);
      throw error;
    }

    const entry: RunningEntry = { sessionId, child };
    this.running.set(id, entry);
    this.decrementStarting(sessionId);

    const stdoutCapture: OutputCapture = {
      bytes: 0,
      tail: "",
      truncated: false,
    };
    const stderrCapture: OutputCapture = {
      bytes: 0,
      tail: "",
      truncated: false,
    };
    let spawnError: string | undefined;
    let metadataUpdateError: string | undefined;
    let dirty = false;

    const captureOutput = (
      capture: OutputCapture,
      stream: Writable,
      chunk: Buffer,
      previewMaxChars: number,
    ) => {
      const remaining = Math.max(
        0,
        this.outputFileMaxBytes -
          Math.min(capture.bytes, this.outputFileMaxBytes),
      );
      if (chunk.length > remaining) {
        capture.truncated = true;
      }
      if (remaining > 0 && !capture.sinkError && !stream.destroyed) {
        try {
          stream.write(chunk.subarray(0, remaining));
        } catch (error) {
          capture.sinkError = errorMessage(error);
          capture.truncated = true;
        }
      }
      capture.bytes += chunk.length;
      capture.tail = appendTail(
        capture.tail,
        chunk.toString("utf8"),
        previewMaxChars,
      );
      dirty = true;
    };

    stdoutFile.on("error", (error) => {
      stdoutCapture.sinkError = errorMessage(error);
      stdoutCapture.truncated = true;
    });
    stderrFile.on("error", (error) => {
      stderrCapture.sinkError = errorMessage(error);
      stderrCapture.truncated = true;
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      captureOutput(stdoutCapture, stdoutFile, chunk, STDOUT_PREVIEW_MAX_CHARS);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      captureOutput(stderrCapture, stderrFile, chunk, STDERR_PREVIEW_MAX_CHARS);
    });
    child.on("error", (error) => {
      spawnError = error.message;
    });

    const previewPatch = (): Partial<BangCommandTranscriptDisplayObject> => ({
      stdoutPreview: stdoutCapture.tail || undefined,
      stderrPreview: stderrCapture.tail || undefined,
      stdoutBytes: stdoutCapture.bytes,
      stderrBytes: stderrCapture.bytes,
      stdoutTruncated: stdoutCapture.truncated || undefined,
      stderrTruncated: stderrCapture.truncated || undefined,
    });

    const flushTimer = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      void this.updateObject(sessionId, id, previewPatch()).catch((error) => {
        metadataUpdateError = errorMessage(error);
      });
    }, this.flushIntervalMs);
    const timeoutTimer = setTimeout(() => {
      this.killEntry(
        id,
        `Timed out after ${Math.round(this.timeoutMs / 1000)}s`,
      );
    }, this.timeoutMs);

    const completion = new Promise<BangCommandTranscriptDisplayObject>(
      (resolve) => {
        child.once("close", (code, signal) => {
          clearInterval(flushTimer);
          clearTimeout(timeoutTimer);
          this.running.delete(id);
          void (async () => {
            await Promise.all([
              finishWritable(stdoutFile),
              finishWritable(stderrFile),
            ]);
            const killedReason = entry.killedReason;
            const storageError = [
              stdoutCapture.sinkError
                ? `stdout storage failed: ${stdoutCapture.sinkError}`
                : null,
              stderrCapture.sinkError
                ? `stderr storage failed: ${stderrCapture.sinkError}`
                : null,
            ]
              .filter(Boolean)
              .join("; ");
            const commandError =
              killedReason ??
              spawnError ??
              (storageError ||
                (code === null && signal
                  ? `Terminated by signal ${signal}`
                  : undefined));
            const patch: Partial<BangCommandTranscriptDisplayObject> = {
              ...previewPatch(),
              durationMs: Date.now() - startedAtMs,
              status: killedReason ? "killed" : commandError ? "error" : "done",
              exitCode: code ?? undefined,
              error: commandError,
            };
            try {
              const updated = await this.updateObject(sessionId, id, patch);
              resolve(updated ?? { ...object, ...patch });
            } catch (error) {
              const persistenceError = `Failed to persist command status: ${errorMessage(error)}`;
              resolve({
                ...object,
                ...patch,
                status: "error",
                error: [patch.error, metadataUpdateError, persistenceError]
                  .filter(Boolean)
                  .join("; "),
              });
            }
          })();
        });
      },
    );
    entry.completion = completion;

    return { object, completion };
  }

  async dispose(reason = "Interrupted by server shutdown"): Promise<void> {
    this.disposed = true;
    const entries = [...this.running.entries()];
    for (const [objectId] of entries) {
      this.killEntry(objectId, reason);
    }
    await Promise.allSettled(
      entries.flatMap(([, entry]) =>
        entry.completion ? [entry.completion] : [],
      ),
    );
  }

  /** Request termination of a running command's process group. */
  kill(objectId: string, reason = "Cancelled"): boolean {
    return this.killEntry(objectId, reason);
  }

  private killEntry(objectId: string, reason: string): boolean {
    const entry = this.running.get(objectId);
    if (!entry) {
      return false;
    }
    entry.killedReason = reason;
    this.signalEntry(entry, "SIGTERM");
    setTimeout(() => {
      if (this.running.has(objectId)) {
        this.signalEntry(entry, "SIGKILL");
      }
    }, SIGKILL_GRACE_MS).unref();
    return true;
  }

  private signalEntry(entry: RunningEntry, signal: NodeJS.Signals): void {
    const pid = entry.child.pid;
    try {
      if (pid) {
        process.kill(-pid, signal);
      } else {
        entry.child.kill(signal);
      }
    } catch {
      try {
        entry.child.kill(signal);
      } catch {
        // Process already gone.
      }
    }
  }

  async readOutput(
    sessionId: string,
    objectId: string,
  ): Promise<{ stdout: string; stderr: string; responseTruncated: boolean }> {
    const read = async (stream: "stdout" | "stderr") => {
      try {
        const handle = await fsp.open(
          this.outputPath(sessionId, objectId, stream),
          "r",
        );
        try {
          const stat = await handle.stat();
          const length = Math.min(stat.size, BANG_OUTPUT_READ_MAX_BYTES);
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, 0);
          return {
            text: buffer.toString("utf8"),
            truncated: stat.size > length,
          };
        } finally {
          await handle.close();
        }
      } catch {
        return { text: "", truncated: false };
      }
    };
    const [stdout, stderr] = await Promise.all([
      read("stdout"),
      read("stderr"),
    ]);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      responseTruncated: stdout.truncated || stderr.truncated,
    };
  }

  /** Remove a finished command's display object and stored output. */
  async remove(sessionId: string, objectId: string): Promise<boolean> {
    if (this.running.has(objectId)) {
      return false;
    }
    const removed = await this.metadata.removeTranscriptDisplayObject(
      sessionId,
      objectId,
    );
    if (removed) {
      await this.deleteOutputs(sessionId, objectId);
      this.emitObjects(sessionId);
    }
    return removed;
  }

  private async deleteOutputs(
    sessionId: string,
    objectId: string,
  ): Promise<void> {
    for (const stream of ["stdout", "stderr"] as const) {
      await fsp
        .unlink(this.outputPath(sessionId, objectId, stream))
        .catch(() => {});
    }
  }

  private async pruneOldObjects(sessionId: string): Promise<void> {
    const bangObjects = this.metadata
      .getTranscriptDisplayObjects(sessionId)
      .filter((object) => object.kind === "bang-command");
    const excess = bangObjects.length - (this.maxObjectsPerSession - 1);
    if (excess <= 0) {
      return;
    }
    const oldest = [...bangObjects]
      .filter(
        (object) => object.status !== "running" && !this.running.has(object.id),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, excess);
    for (const object of oldest) {
      await this.metadata.removeTranscriptDisplayObject(sessionId, object.id);
      await this.deleteOutputs(sessionId, object.id);
    }
  }

  private async updateObject(
    sessionId: string,
    objectId: string,
    patch: Partial<BangCommandTranscriptDisplayObject>,
  ): Promise<BangCommandTranscriptDisplayObject | undefined> {
    const updated = await this.metadata.updateTranscriptDisplayObject(
      sessionId,
      objectId,
      (object) =>
        object.kind === "bang-command" ? { ...object, ...patch } : object,
    );
    this.emitObjects(sessionId);
    return updated?.kind === "bang-command" ? updated : undefined;
  }

  private emitObjects(sessionId: string): void {
    this.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId,
      transcriptDisplayObjects:
        this.metadata.getTranscriptDisplayObjects(sessionId),
      timestamp: new Date().toISOString(),
    });
  }

  private decrementStarting(sessionId: string): void {
    const count = this.startingBySession.get(sessionId) ?? 0;
    if (count <= 1) {
      this.startingBySession.delete(sessionId);
    } else {
      this.startingBySession.set(sessionId, count - 1);
    }
  }
}
