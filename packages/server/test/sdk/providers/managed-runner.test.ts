import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeProviderSession } from "../../../src/sdk/providers/provider-runtime-fake.js";
import { ProviderRuntimeSocketAdapter } from "../../../src/sdk/providers/provider-runtime-socket-adapter.js";
import {
  BoundedFrameWriter,
  runManagedStdioRunner,
} from "../../../src/sdk/providers/provider-runtime-stdio.js";
import {
  ProviderSessionOwner,
  PROVIDER_SESSION_PROTOCOL_VERSION,
} from "../../../src/sdk/providers/provider-session-owner.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function collectLines(stream: PassThrough): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  return messages;
}

function eventContent(message: Record<string, unknown>): unknown {
  const event = message.message as Record<string, unknown> | undefined;
  const providerMessage = event?.message as Record<string, unknown> | undefined;
  return providerMessage?.content;
}

function startFakeOwner(options?: {
  onTerminal?: (reason: string, exitCode: number) => void;
}): ProviderSessionOwner {
  return new ProviderSessionOwner({
    runtimeId: "fake-runtime",
    onTerminal: options?.onTerminal,
  });
}

describe("ProviderSessionOwner", () => {
  it("owns queue, replay, approvals, controls, and cleanup independent of transport", async () => {
    const owner = startFakeOwner();
    await owner.start(async (hooks) => ({
      session: await startFakeProviderSession({}, hooks),
    }));
    const first: Record<string, unknown>[] = [];
    owner.attach("controller-one", "generation-one", (message) =>
      first.push(message as Record<string, unknown>),
    );
    owner.begin();

    await owner.handleControllerRequest("controller-one", {
      type: "queuePush",
      message: { text: "hello", uuid: "hello-uuid", tempId: "hello-temp" },
    });
    await waitFor(() =>
      first.some((message) => eventContent(message) === "echo:hello"),
    );
    expect(first.some((message) => message.type === "queueYielded")).toBe(true);
    expect(first.some((message) => message.type === "queueDepth")).toBe(true);

    const lastSequence = Math.max(
      ...first
        .filter((message) => message.type === "event")
        .map((message) => Number(message.sequence)),
    );
    await owner.handleControllerRequest("controller-one", {
      type: "ack",
      sequence: lastSequence,
    });
    owner.detach("controller-one");
    const replayed: Record<string, unknown>[] = [];
    owner.attach("controller-two", "generation-two", (message) =>
      replayed.push(message as Record<string, unknown>),
    );
    expect(replayed).toEqual([
      expect.objectContaining({
        type: "attached",
        acknowledgedSequence: lastSequence,
      }),
    ]);

    await owner.handleControllerRequest("controller-two", {
      type: "queuePush",
      message: { text: "approval:write", uuid: "approval-uuid" },
    });
    await waitFor(() =>
      replayed.some((message) => message.type === "approval"),
    );
    const approval = replayed.find((message) => message.type === "approval");
    await owner.handleControllerRequest("controller-two", {
      type: "approvalResult",
      requestId: approval?.requestId,
      result: { behavior: "allow" },
    });
    await waitFor(() =>
      replayed.some((message) => eventContent(message) === "approval:allow"),
    );

    await owner.handleControllerRequest("controller-two", {
      type: "rpc",
      id: 1,
      method: "probeLiveness",
      args: [],
    });
    await waitFor(() =>
      replayed.some((message) => message.type === "rpcResult"),
    );
    expect(replayed.find((message) => message.type === "rpcResult")).toEqual(
      expect.objectContaining({ id: 1, ok: true }),
    );

    await owner.handleControllerRequest("controller-two", {
      type: "queuePush",
      message: { text: "hold", uuid: "hold-uuid" },
    });
    await waitFor(() =>
      replayed.some(
        (message) =>
          message.type === "providerRetention" &&
          (message.value as { retained?: boolean }).retained === true,
      ),
    );
    await owner.handleControllerRequest("controller-two", {
      type: "rpc",
      id: 2,
      method: "interrupt",
      args: [],
    });
    await waitFor(() =>
      replayed.some((message) => eventContent(message) === "interrupted"),
    );
    await owner.shutdown("test cleanup");
  });

  it("reports provider failure as a terminal outcome", async () => {
    let terminal: { reason: string; exitCode: number } | undefined;
    const owner = startFakeOwner({
      onTerminal: (reason, exitCode) => {
        terminal = { reason, exitCode };
      },
    });
    await owner.start(async (hooks) => ({
      session: await startFakeProviderSession({}, hooks),
    }));
    const messages: Record<string, unknown>[] = [];
    owner.attach("controller", "generation", (message) =>
      messages.push(message as Record<string, unknown>),
    );
    owner.begin();
    await owner.handleControllerRequest("controller", {
      type: "queuePush",
      message: { text: "fail" },
    });
    await waitFor(() => terminal !== undefined);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "failed",
        error: "Fake provider turn failed",
      }),
    );
    expect(terminal).toEqual({
      reason: "provider iterator failed",
      exitCode: 1,
    });
  });
});

describe.skipIf(process.platform === "win32")(
  "ProviderRuntimeSocketAdapter",
  () => {
    it("preserves the versioned Unix-socket attach contract on the shared owner", async () => {
      const directory = await mkdtemp(join(tmpdir(), "managed-runner-socket-"));
      temporaryPaths.push(directory);
      const socketPath = join(directory, "provider.sock");
      const owner = startFakeOwner();
      await owner.start(async (hooks) => ({
        session: await startFakeProviderSession({}, hooks),
      }));
      const adapter = new ProviderRuntimeSocketAdapter(
        socketPath,
        "secret",
        owner,
      );
      await adapter.listen();
      owner.begin();

      const socket = createConnection(socketPath);
      const output = new PassThrough();
      socket.pipe(output);
      const messages = collectLines(output);
      socket.write('{"type":"attach","token":"secret",');
      socket.write(
        `"protocolVersion":${PROVIDER_SESSION_PROTOCOL_VERSION},"generation":"socket-generation"}\n`,
      );
      await waitFor(() =>
        messages.some((message) => message.type === "attached"),
      );
      socket.write(
        `${JSON.stringify({ type: "queuePush", message: { text: "socket" } })}\n`,
      );
      await waitFor(() =>
        messages.some((message) => eventContent(message) === "echo:socket"),
      );

      const stale = createConnection(socketPath);
      const staleOutput = new PassThrough();
      stale.pipe(staleOutput);
      const staleMessages = collectLines(staleOutput);
      stale.write("not-json\n");
      stale.write(
        `${JSON.stringify({
          type: "attach",
          token: "secret",
          protocolVersion: PROVIDER_SESSION_PROTOCOL_VERSION,
          generation: "stale-generation",
        })}\n`,
      );
      await waitFor(
        () =>
          staleMessages.filter((message) => message.type === "error").length ===
          2,
      );
      expect(staleMessages.map((message) => message.error)).toEqual([
        "Invalid JSON request",
        "Provider worker is already attached to socket-generation",
      ]);

      socket.destroy();
      stale.destroy();
      await adapter.close();
      await owner.shutdown("test cleanup");
    });
  },
);

interface StdioHarness {
  input: PassThrough;
  messages: Record<string, unknown>[];
  stderr: string[];
  result: Promise<number>;
  send(message: unknown): void;
}

function stdioHarness(limits?: {
  maxInputFrameBytes?: number;
  maxOutputFrameBytes?: number;
  maxQueuedOutputBytes?: number;
}): StdioHarness {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const messages = collectLines(output);
  const diagnostic: string[] = [];
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => diagnostic.push(chunk));
  const result = runManagedStdioRunner({
    input,
    output,
    stderr,
    runtimeId: "stdio-runtime",
    createSession: async (request, hooks) => ({
      session: await startFakeProviderSession(
        { failOnStart: request.runtimeConfig?.failOnStart === true },
        hooks,
      ),
    }),
    ...limits,
  });
  return {
    input,
    messages,
    stderr: diagnostic,
    result,
    send(message) {
      input.write(`${JSON.stringify(message)}\n`);
    },
  };
}

async function launchHarness(harness: StdioHarness): Promise<void> {
  const hello = JSON.stringify({
    type: "hello",
    protocolVersion: 1,
    leaseId: "lease-test-123",
  });
  harness.input.write(hello.slice(0, 7));
  harness.input.write(`${hello.slice(7)}\n`);
  await waitFor(() =>
    harness.messages.some((message) => message.type === "helloAck"),
  );
  harness.send({
    type: "launch",
    leaseId: "lease-test-123",
    controlId: "launch-1",
    provider: "fake",
    options: { cwd: "/tmp" },
  });
  await waitFor(() =>
    harness.messages.some((message) => message.type === "launchAccepted"),
  );
}

describe("managed runner stdio protocol", () => {
  it("handles partial frames, leases, duplicate controls, approvals, RPC, interrupt, and shutdown", async () => {
    const harness = stdioHarness();
    await launchHarness(harness);
    harness.input.write("not-json\n");
    harness.send({
      type: "rpc",
      leaseId: "stale-lease",
      id: 99,
      method: "probeLiveness",
    });
    harness.send({
      type: "queuePush",
      leaseId: "lease-test-123",
      controlId: "same-control",
      message: { text: "once" },
    });
    harness.send({
      type: "queuePush",
      leaseId: "lease-test-123",
      controlId: "same-control",
      message: { text: "twice" },
    });
    await waitFor(() =>
      harness.messages.some((message) => eventContent(message) === "echo:once"),
    );
    expect(
      harness.messages.some(
        (message) => eventContent(message) === "echo:twice",
      ),
    ).toBe(false);
    expect(harness.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "protocolError",
          error: "Managed runner received malformed JSON",
        }),
        expect.objectContaining({
          type: "protocolError",
          error: "Stale managed runner lease id",
        }),
        expect.objectContaining({
          type: "controlDuplicate",
          controlId: "same-control",
        }),
      ]),
    );

    harness.send({
      type: "queuePush",
      leaseId: "lease-test-123",
      controlId: "approval-push",
      message: { text: "approval:network" },
    });
    await waitFor(() =>
      harness.messages.some((message) => message.type === "approval"),
    );
    const approval = harness.messages.find(
      (message) => message.type === "approval",
    );
    harness.send({
      type: "approvalResult",
      leaseId: "lease-test-123",
      controlId: "approval-result",
      requestId: approval?.requestId,
      result: { behavior: "allow" },
    });
    await waitFor(() =>
      harness.messages.some(
        (message) => eventContent(message) === "approval:allow",
      ),
    );

    harness.send({
      type: "queuePush",
      leaseId: "lease-test-123",
      controlId: "approval-cancel-push",
      message: { text: "approval:cancel_me" },
    });
    await waitFor(
      () =>
        harness.messages.filter((message) => message.type === "approval")
          .length === 2,
    );
    const cancelledApproval = harness.messages
      .filter((message) => message.type === "approval")
      .at(-1);
    harness.send({
      type: "rpc",
      leaseId: "lease-test-123",
      controlId: "cancel-approval",
      id: 2,
      method: "interrupt",
      args: [],
    });
    await waitFor(() =>
      harness.messages.some(
        (message) =>
          message.type === "approvalCancelled" &&
          message.requestId === cancelledApproval?.requestId,
      ),
    );

    harness.send({
      type: "rpc",
      leaseId: "lease-test-123",
      controlId: "liveness",
      id: 1,
      method: "probeLiveness",
      args: [],
    });
    await waitFor(() =>
      harness.messages.some(
        (message) => message.type === "rpcResult" && message.id === 1,
      ),
    );
    harness.send({
      type: "rpc",
      leaseId: "lease-test-123",
      controlId: "supported-models",
      id: 3,
      method: "supportedModels",
      args: [],
    });
    await waitFor(() =>
      harness.messages.some(
        (message) =>
          message.type === "rpcResult" &&
          message.id === 3 &&
          Array.isArray(message.result),
      ),
    );
    expect(
      harness.messages.find((message) => message.type === "event")
        ?.providerActivity,
    ).toEqual(
      expect.objectContaining({
        lastRawProviderEventSource: "fake-managed-runner",
      }),
    );
    harness.send({
      type: "queuePush",
      leaseId: "lease-test-123",
      controlId: "hold",
      message: { text: "hold" },
    });
    await waitFor(() =>
      harness.messages.some((message) => message.type === "providerRetention"),
    );
    harness.send({
      type: "queuePush",
      leaseId: "lease-test-123",
      controlId: "remove-push",
      message: {
        text: "remove-me",
        uuid: "remove-uuid",
        tempId: "remove-temp",
      },
    });
    await waitFor(() =>
      harness.messages.some(
        (message) => message.type === "queueDepth" && message.depth === 1,
      ),
    );
    harness.send({
      type: "removeQueued",
      leaseId: "lease-test-123",
      controlId: "remove",
      tempId: "remove-temp",
    });
    await waitFor(() =>
      harness.messages.some(
        (message) =>
          message.type === "queueRemoved" &&
          Array.isArray(message.uuids) &&
          message.uuids.includes("remove-uuid"),
      ),
    );
    harness.send({
      type: "rpc",
      leaseId: "lease-test-123",
      controlId: "interrupt",
      id: 4,
      method: "interrupt",
      args: [],
    });
    await waitFor(() =>
      harness.messages.some(
        (message) => eventContent(message) === "interrupted",
      ),
    );

    harness.send({
      type: "shutdown",
      leaseId: "lease-test-123",
      controlId: "shutdown",
    });
    harness.input.end();
    await expect(harness.result).resolves.toBe(0);
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "shutdownComplete",
        leaseId: "lease-test-123",
      }),
    );
    expect(harness.stderr.join("")).toBe("");
  });

  it("fails incompatible versions, oversized input, launch errors, provider errors, and controller EOF", async () => {
    const incompatible = stdioHarness();
    incompatible.send({
      type: "hello",
      protocolVersion: 2,
      leaseId: "lease-bad-version",
    });
    incompatible.input.end();
    await expect(incompatible.result).resolves.toBe(2);
    expect(incompatible.messages).toContainEqual(
      expect.objectContaining({
        type: "protocolError",
        error: "Incompatible managed runner protocol",
      }),
    );

    const oversized = stdioHarness({ maxInputFrameBytes: 32 });
    oversized.input.end(`${"x".repeat(33)}\n`);
    await expect(oversized.result).resolves.toBe(1);
    expect(oversized.messages).toContainEqual(
      expect.objectContaining({ type: "runnerFailed" }),
    );

    const launchFailure = stdioHarness();
    launchFailure.send({
      type: "hello",
      protocolVersion: 1,
      leaseId: "lease-launch-failure",
    });
    launchFailure.send({
      type: "launch",
      protocolVersion: 1,
      leaseId: "lease-launch-failure",
      provider: "fake",
      options: { cwd: "/tmp" },
      runtimeConfig: { failOnStart: true },
    });
    launchFailure.input.end();
    await expect(launchFailure.result).resolves.toBe(1);
    expect(launchFailure.messages).toContainEqual(
      expect.objectContaining({
        type: "launchFailed",
        error: "Fake provider rejected launch",
      }),
    );

    const providerFailure = stdioHarness();
    await launchHarness(providerFailure);
    providerFailure.send({
      type: "queuePush",
      leaseId: "lease-test-123",
      message: { text: "fail" },
    });
    await expect(providerFailure.result).resolves.toBe(1);
    expect(providerFailure.messages).toContainEqual(
      expect.objectContaining({
        type: "failed",
        error: "Fake provider turn failed",
      }),
    );

    const eof = stdioHarness();
    await launchHarness(eof);
    eof.input.end();
    await expect(eof.result).resolves.toBe(0);
    expect(eof.messages).toContainEqual(
      expect.objectContaining({
        type: "controllerLost",
        outcome: "terminated",
      }),
    );
  });

  it("enforces output frame and queued backpressure bounds", () => {
    const blockedOutput = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {},
    });
    const writer = new BoundedFrameWriter(blockedOutput, 128, 32);
    writer.write({ type: "a" });
    expect(() => writer.write({ type: "queued-message-too-large" })).toThrow(
      "Managed runner output backpressure bound exceeded",
    );
    expect(() =>
      new BoundedFrameWriter(new PassThrough(), 8, 32).write({ type: "large" }),
    ).toThrow("Managed runner output frame exceeded its bound");
    blockedOutput.destroy();
  });
});
