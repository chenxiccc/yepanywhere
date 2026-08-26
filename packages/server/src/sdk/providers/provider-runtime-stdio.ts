import type { Readable, Writable } from "node:stream";
import type {
  ProviderSessionStartHooks,
  ProviderSessionStartResult,
} from "./provider-session-owner.js";
import {
  ProviderSessionOwner,
  PROVIDER_SESSION_PROTOCOL_VERSION,
  providerSessionErrorMessage,
} from "./provider-session-owner.js";
import type { StartSessionOptions } from "./types.js";

export const MANAGED_RUNNER_PROTOCOL_VERSION = 1;
export const MANAGED_RUNNER_MAX_INPUT_FRAME_BYTES = 1024 * 1024;
export const MANAGED_RUNNER_MAX_OUTPUT_FRAME_BYTES = 4 * 1024 * 1024;
export const MANAGED_RUNNER_MAX_QUEUED_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_CONTROL_IDS = 2048;
const OUTPUT_DRAIN_TIMEOUT_MS = 1_000;

export interface ManagedRunnerLaunchRequest {
  type: "launch";
  leaseId: string;
  controlId?: string;
  provider: string;
  options: StartSessionOptions & {
    browserDebugEnvironment?: Record<string, string>;
  };
  runtimeConfig?: Record<string, unknown>;
}

export type ManagedRunnerSessionFactory = (
  request: ManagedRunnerLaunchRequest,
  hooks: ProviderSessionStartHooks,
) => Promise<ProviderSessionStartResult>;

export interface RunManagedStdioRunnerOptions {
  input: Readable;
  output: Writable;
  stderr: Writable;
  runtimeId: string;
  createSession: ManagedRunnerSessionFactory;
  maxInputFrameBytes?: number;
  maxOutputFrameBytes?: number;
  maxQueuedOutputBytes?: number;
}

export class BoundedFrameWriter {
  private queued: string[] = [];
  private queuedBytes = 0;
  private blocked = false;
  private closed = false;
  private drainPromise: Promise<void> | null = null;
  private resolveDrain: (() => void) | null = null;
  private failure: Error | null = null;

  constructor(
    private readonly output: Writable,
    private readonly maxFrameBytes: number,
    private readonly maxQueuedBytes: number,
  ) {
    output.on("drain", () => this.flush());
    output.on("error", (error) => {
      this.failure = error;
      this.resolveDrain?.();
      this.resolveDrain = null;
      this.drainPromise = null;
    });
  }

  write(message: unknown): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("Managed runner output is closed");
    const serialized = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(serialized);
    if (bytes > this.maxFrameBytes) {
      this.fail("Managed runner output frame exceeded its bound");
    }
    if (this.blocked || this.queued.length > 0) {
      if (this.queuedBytes + bytes > this.maxQueuedBytes) {
        this.fail("Managed runner output backpressure bound exceeded");
      }
      this.queued.push(serialized);
      this.queuedBytes += bytes;
      return;
    }
    this.blocked = !this.output.write(serialized);
    if (this.blocked && !this.drainPromise) {
      this.drainPromise = new Promise((resolve) => {
        this.resolveDrain = resolve;
      });
    }
  }

  private flush(): void {
    if (this.closed || this.failure) return;
    this.blocked = false;
    while (this.queued.length > 0 && !this.blocked) {
      const next = this.queued.shift();
      if (!next) break;
      this.queuedBytes -= Buffer.byteLength(next);
      this.blocked = !this.output.write(next);
    }
    if (!this.blocked && this.queued.length === 0) {
      this.resolveDrain?.();
      this.resolveDrain = null;
      this.drainPromise = null;
    }
  }

  async close(): Promise<void> {
    if (this.failure) {
      this.closed = true;
      return;
    }
    if (this.blocked || this.queued.length > 0) {
      if (!this.drainPromise) {
        this.drainPromise = new Promise((resolve) => {
          this.resolveDrain = resolve;
        });
      }
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        this.drainPromise,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, OUTPUT_DRAIN_TIMEOUT_MS);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    }
    this.closed = true;
  }

  private fail(message: string): never {
    this.failure = new Error(message);
    this.queued = [];
    this.queuedBytes = 0;
    this.resolveDrain?.();
    this.resolveDrain = null;
    this.drainPromise = null;
    throw this.failure;
  }
}

async function* readBoundedLines(
  input: Readable,
  maxFrameBytes: number,
): AsyncGenerator<string> {
  let pieces: Buffer[] = [];
  let bufferedBytes = 0;
  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(String(rawChunk));
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const length = end - offset;
      if (bufferedBytes + length > maxFrameBytes) {
        throw new Error("Managed runner input frame exceeded its bound");
      }
      if (length > 0) {
        pieces.push(chunk.subarray(offset, end));
        bufferedBytes += length;
      }
      if (newline === -1) break;
      const line = Buffer.concat(pieces, bufferedBytes).toString("utf8");
      pieces = [];
      bufferedBytes = 0;
      yield line;
      offset = newline + 1;
    }
  }
  if (bufferedBytes > 0) {
    yield Buffer.concat(pieces, bufferedBytes).toString("utf8");
  }
}

function parseFrame(line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Managed runner received malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Managed runner frame must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function validLeaseId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

export async function runManagedStdioRunner(
  options: RunManagedStdioRunnerOptions,
): Promise<number> {
  const writer = new BoundedFrameWriter(
    options.output,
    options.maxOutputFrameBytes ?? MANAGED_RUNNER_MAX_OUTPUT_FRAME_BYTES,
    options.maxQueuedOutputBytes ?? MANAGED_RUNNER_MAX_QUEUED_OUTPUT_BYTES,
  );
  let diagnosticBytes = 0;
  const diagnostic = (message: string): void => {
    if (diagnosticBytes >= MAX_DIAGNOSTIC_BYTES) return;
    const remaining = MAX_DIAGNOSTIC_BYTES - diagnosticBytes;
    const bounded = Buffer.from(message)
      .subarray(0, remaining)
      .toString("utf8");
    diagnosticBytes += Buffer.byteLength(bounded);
    options.stderr.write(`[ManagedRunner] ${bounded}\n`);
  };
  let leaseId: string | null = null;
  let controllerId: string | null = null;
  let launched = false;
  let cooperativeShutdown = false;
  const terminalResult: {
    current: { reason: string; exitCode: number } | null;
  } = { current: null };
  const seenControlIds = new Set<string>();
  const controlIdOrder: string[] = [];
  const owner = new ProviderSessionOwner({
    runtimeId: options.runtimeId,
    onTerminal: (reason, exitCode) => {
      terminalResult.current = { reason, exitCode };
      try {
        writer.write({ type: "runnerTerminal", leaseId, reason, exitCode });
      } finally {
        options.input.destroy();
      }
    },
  });

  const rememberControl = (frame: Record<string, unknown>): boolean => {
    if (typeof frame.controlId !== "string" || !frame.controlId) return true;
    if (seenControlIds.has(frame.controlId)) {
      writer.write({
        type: "controlDuplicate",
        leaseId,
        controlId: frame.controlId,
      });
      return false;
    }
    seenControlIds.add(frame.controlId);
    controlIdOrder.push(frame.controlId);
    if (controlIdOrder.length > MAX_CONTROL_IDS) {
      const oldest = controlIdOrder.shift();
      if (oldest) seenControlIds.delete(oldest);
    }
    return true;
  };

  try {
    for await (const line of readBoundedLines(
      options.input,
      options.maxInputFrameBytes ?? MANAGED_RUNNER_MAX_INPUT_FRAME_BYTES,
    )) {
      if (!line.trim()) continue;
      let frame: Record<string, unknown>;
      try {
        frame = parseFrame(line);
      } catch (error) {
        writer.write({
          type: "protocolError",
          phase: launched ? "active" : "pre-start",
          leaseId,
          error: providerSessionErrorMessage(error),
        });
        continue;
      }

      if (!leaseId) {
        if (frame.type !== "hello") {
          writer.write({
            type: "protocolError",
            phase: "pre-start",
            error: "Managed runner requires hello as the first frame",
          });
          await owner.shutdown("missing hello");
          await writer.close();
          return 2;
        }
        if (frame.protocolVersion !== MANAGED_RUNNER_PROTOCOL_VERSION) {
          writer.write({
            type: "protocolError",
            phase: "pre-start",
            error: "Incompatible managed runner protocol",
            supportedProtocolVersion: MANAGED_RUNNER_PROTOCOL_VERSION,
          });
          await owner.shutdown("incompatible protocol");
          await writer.close();
          return 2;
        }
        if (!validLeaseId(frame.leaseId)) {
          writer.write({
            type: "protocolError",
            phase: "pre-start",
            error: "Invalid managed runner lease id",
          });
          await owner.shutdown("invalid lease");
          await writer.close();
          return 2;
        }
        leaseId = frame.leaseId;
        writer.write({
          type: "helloAck",
          protocolVersion: MANAGED_RUNNER_PROTOCOL_VERSION,
          providerSessionProtocolVersion: PROVIDER_SESSION_PROTOCOL_VERSION,
          leaseId,
          capabilities: [
            "queue-control",
            "sequenced-events",
            "approvals",
            "interrupt",
            "liveness",
            "activity",
            "retention",
            "cooperative-shutdown",
          ],
          limits: {
            maxInputFrameBytes:
              options.maxInputFrameBytes ??
              MANAGED_RUNNER_MAX_INPUT_FRAME_BYTES,
            maxOutputFrameBytes:
              options.maxOutputFrameBytes ??
              MANAGED_RUNNER_MAX_OUTPUT_FRAME_BYTES,
          },
        });
        continue;
      }

      if (frame.leaseId !== leaseId) {
        writer.write({
          type: "protocolError",
          phase: launched ? "active" : "pre-start",
          leaseId,
          error: "Stale managed runner lease id",
        });
        continue;
      }
      if (!rememberControl(frame)) continue;

      if (!launched) {
        if (frame.type !== "launch") {
          writer.write({
            type: "protocolError",
            phase: "pre-start",
            leaseId,
            error: "Managed runner requires launch after hello",
          });
          continue;
        }
        const launch = frame as unknown as ManagedRunnerLaunchRequest;
        if (
          typeof launch.provider !== "string" ||
          !launch.options ||
          typeof launch.options !== "object"
        ) {
          writer.write({
            type: "launchFailed",
            phase: "pre-start",
            leaseId,
            error: "Invalid managed runner launch request",
          });
          await owner.shutdown("invalid launch");
          await writer.close();
          return 1;
        }
        try {
          const metadata = await owner.start(
            (hooks) => options.createSession(launch, hooks),
            launch.options.browserDebugEnvironment,
          );
          controllerId = `stdio:${leaseId}`;
          const state = owner.attach(
            controllerId,
            leaseId,
            (message) => writer.write({ ...asRecord(message), leaseId }),
            { emitAttached: false },
          );
          launched = true;
          writer.write({
            type: "launchAccepted",
            protocolVersion: MANAGED_RUNNER_PROTOCOL_VERSION,
            leaseId,
            provider: launch.provider,
            metadata,
            state,
          });
          owner.begin();
        } catch (error) {
          writer.write({
            type: "launchFailed",
            phase: "pre-start",
            leaseId,
            error: providerSessionErrorMessage(error),
          });
          await owner.shutdown("provider launch failed");
          await writer.close();
          return 1;
        }
        continue;
      }

      if (frame.type === "shutdown") {
        cooperativeShutdown = true;
        await owner.shutdown("controller requested shutdown");
        writer.write({ type: "shutdownComplete", leaseId });
        await writer.close();
        return 0;
      }
      if (!controllerId)
        throw new Error("Managed runner controller is missing");
      try {
        await owner.handleControllerRequest(controllerId, frame);
      } catch (error) {
        writer.write({
          type: "controlError",
          leaseId,
          controlId: frame.controlId,
          id: frame.id,
          error: providerSessionErrorMessage(error),
        });
      }
    }

    if (terminalResult.current) {
      await writer.close();
      return terminalResult.current.exitCode;
    }
    if (!cooperativeShutdown) {
      await owner.shutdown("controller stdin EOF");
      writer.write({
        type: launched ? "controllerLost" : "launchFailed",
        phase: launched ? "active" : "pre-start",
        leaseId,
        outcome: launched ? "terminated" : undefined,
        error: launched
          ? "Managed runner controller stream closed"
          : "Managed runner controller closed before launch",
      });
    }
    await writer.close();
    return launched ? 0 : 1;
  } catch (error) {
    diagnostic(providerSessionErrorMessage(error));
    await owner.shutdown("managed runner protocol failure").catch(() => {});
    try {
      writer.write({
        type: "runnerFailed",
        phase: launched ? "active" : "pre-start",
        leaseId,
        error: providerSessionErrorMessage(error),
      });
      await writer.close();
    } catch (writeError) {
      diagnostic(providerSessionErrorMessage(writeError));
    }
    return 1;
  }
}

function asRecord(message: unknown): Record<string, unknown> {
  return message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : { type: "message", value: message };
}
