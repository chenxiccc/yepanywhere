import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  SUITE_VERSION,
  assertCount,
  bodyArray,
  bytesToMiB,
  requirePositiveInteger,
  round,
  summarize,
} from "./core.mjs";
import {
  connectEventSocket,
  createFixture,
  findPortPair,
  readProcessManifest,
  requestJson,
  sampleMemory,
  startPerfRelay,
  startServer,
  stopServer,
  waitForJson,
  waitForRecordedEvent,
} from "./process-fixture.mjs";
import { runClientBatch } from "./request-clients.mjs";
import { memoryView, selectedFixtureTarget } from "./telemetry.mjs";

export function renderedAssistantHtml(message) {
  const inner = message?.message;
  if (typeof inner?._html === "string") return inner._html;
  if (!Array.isArray(inner?.content)) return null;
  const block = inner.content.find(
    (candidate) =>
      candidate?.type === "text" && typeof candidate._html === "string",
  );
  return block?._html ?? null;
}

export async function measureOwnedProviderLifecycle({
  checkout,
  config,
  fixture,
  repetitionRoot,
  runMarker,
  scenario,
}) {
  const root = path.join(repetitionRoot, "owned-provider");
  await mkdir(root, { recursive: true });
  const server = await startServer({
    checkout,
    driver: "specialized",
    envOverrides: {
      ENABLED_PROVIDERS: "claude",
      IDLE_TIMEOUT: String(scenario.idleReapSeconds),
      USE_MOCK_SDK: "false",
      YEP_PERF_SIM_STREAM_CHUNKS: String(scenario.streamChunks),
      YEP_PERF_SIM_STREAM_CHUNK_BYTES: String(scenario.streamChunkBytes),
      YEP_PERF_SIM_STREAM_DELAY_MS: String(scenario.streamDelayMs),
      YEP_PROVIDER_RUNTIME_WORKER_PATH: path.join(
        checkout,
        "scripts/perf-suite/simulated-provider-worker.mjs",
      ),
    },
    fixture,
    port: await findPortPair(config.server.portBase),
    root,
    config,
    runMarker,
  });
  let socket = null;
  try {
    const target = selectedFixtureTarget(server, fixture, scenario);
    const createResponse = await requestJson(
      `${server.baseUrl}/api/projects/${encodeURIComponent(
        target.detail.projectId,
      )}/sessions/create`,
      {
        json: {
          provider: "claude",
          model: "perf-simulated-thinking-model",
        },
        method: "POST",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );
    const sessionId = createResponse.body?.sessionId;
    if (typeof sessionId !== "string" || !sessionId.startsWith("perf-sim-")) {
      throw new Error(
        `simulated provider did not publish its session identity: ${JSON.stringify(createResponse.body)}`,
      );
    }

    socket = await connectEventSocket(
      server.baseUrl,
      config.server.requestTimeoutMs,
    );
    const subscriptionId = `perf-owned-${repetitionRoot.split(path.sep).at(-1)}`;
    const events = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (
        message.type === "event" &&
        message.subscriptionId === subscriptionId
      ) {
        events.push({ message, receivedAtMs: performance.now() });
      }
    });
    socket.send(
      JSON.stringify({
        type: "subscribe",
        subscriptionId,
        channel: "session",
        sessionId,
        wantsLiveDeltas: true,
      }),
    );
    await waitForRecordedEvent(
      events,
      (event) => event.message.eventType === "connected",
      {
        description: "owned provider subscription connection",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );

    const turnStartedAtMs = performance.now();
    await requestJson(`${server.baseUrl}/api/sessions/${sessionId}/messages`, {
      json: {
        message: "Exercise the simulated provider streaming boundary.",
        provider: "claude",
        tempId: `perf-turn-${sessionId}`,
      },
      method: "POST",
      timeoutMs: config.server.requestTimeoutMs,
    });
    const firstTextDelta = await waitForRecordedEvent(
      events,
      (record) =>
        record.message.eventType === "message" &&
        record.message.data?.type === "stream_event" &&
        record.message.data?.event?.delta?.type === "text_delta",
      {
        description: "first simulated provider text delta",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );
    const rawAssistant = await waitForRecordedEvent(
      events,
      (record) =>
        record.message.eventType === "message" &&
        record.message.data?.type === "assistant" &&
        renderedAssistantHtml(record.message.data) === null,
      {
        description: "raw simulated provider assistant message",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );
    const assistantId = rawAssistant.message.data.uuid;
    const enrichedAssistant = await waitForRecordedEvent(
      events,
      (record) =>
        record.message.eventType === "message" &&
        record.message.data?.uuid === assistantId &&
        renderedAssistantHtml(record.message.data) !== null,
      {
        description: "enriched simulated provider assistant replacement",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );
    await waitForRecordedEvent(
      events,
      (record) =>
        record.message.eventType === "message" &&
        record.message.data?.type === "result",
      {
        description: "simulated provider result",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );

    const textDeltas = events.filter(
      (record) =>
        record.message.eventType === "message" &&
        record.message.data?.type === "stream_event" &&
        record.message.data?.event?.delta?.type === "text_delta",
    );
    assertCount(
      textDeltas.length,
      scenario.streamChunks,
      "simulated provider text-delta count",
    );
    const textBytes = textDeltas.reduce(
      (sum, record) =>
        sum + Buffer.byteLength(record.message.data.event.delta.text),
      0,
    );
    const expectedTextBytes = scenario.streamChunks * scenario.streamChunkBytes;
    assertCount(textBytes, expectedTextBytes, "simulated provider text bytes");
    const rawIndex = events.indexOf(rawAssistant);
    const enrichedIndex = events.indexOf(enrichedAssistant);
    if (rawIndex < 0 || enrichedIndex <= rawIndex) {
      throw new Error("enriched assistant replacement preceded its raw event");
    }
    const thinkingBlock = rawAssistant.message.data.message?.content?.find(
      (block) => block?.type === "thinking",
    );
    if (typeof thinkingBlock?.thinking !== "string") {
      throw new Error("simulated provider omitted its thinking block");
    }

    await waitForJson(
      `${server.baseUrl}/api/sessions/${sessionId}/process`,
      (body) =>
        body?.process?.state === "idle" &&
        body.process.liveness?.derivedStatus === "verified-idle",
      {
        description: "owned provider verified-idle state",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );

    const reapStartedAtMs = performance.now();
    socket.send(JSON.stringify({ type: "unsubscribe", subscriptionId }));
    socket.close();
    socket = null;
    await waitForJson(
      `${server.baseUrl}/api/sessions/${sessionId}/process`,
      (body) => body?.process === null,
      {
        description: "idle ownership release",
        timeoutMs:
          config.server.requestTimeoutMs + scenario.idleReapSeconds * 1_000,
      },
    );

    const finalRawMs = rawAssistant.receivedAtMs - turnStartedAtMs;
    return {
      correctness: {
        provider: "claude",
        model: "perf-simulated-thinking-model",
        simulatedThinkingBlock: true,
        sessionId,
        textBytes,
        textDeltaCount: textDeltas.length,
        rawBeforeEnriched: true,
        ownershipReleasedAfterVerifiedIdle: true,
      },
      latency: {
        firstTextDeltaMs: round(firstTextDelta.receivedAtMs - turnStartedAtMs),
        finalRawMs: round(finalRawMs),
        finalEnrichedMs: round(
          enrichedAssistant.receivedAtMs - turnStartedAtMs,
        ),
        idleOwnershipReleaseMs: round(performance.now() - reapStartedAtMs),
      },
      throughput: {
        textMiBPerSecond: round(
          textBytes / (1024 * 1024) / Math.max(finalRawMs / 1_000, 0.001),
        ),
      },
      processManifest: await readProcessManifest(server.processManifestPath),
      serverLog: server.logPath,
      serverStartupMs: round(server.startupMs),
    };
  } finally {
    socket?.terminate();
    server.log.end();
    await stopServer(server.child);
  }
}

export async function measurePublicShareHerd({
  checkout,
  config,
  fixture,
  repetitionRoot,
  runMarker,
  scenario,
}) {
  const root = path.join(repetitionRoot, "public-share");
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const relay = await startPerfRelay();
  const port = await findPortPair(config.server.portBase + 3);
  await writeFile(
    path.join(dataDir, "remote-access.json"),
    `${JSON.stringify(
      {
        version: 1,
        enabled: true,
        credentials: {
          salt: "00",
          verifier: "00",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        relay: { url: relay.url, username: "perf-share" },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(dataDir, "server-settings.json"),
    `${JSON.stringify(
      {
        version: 2,
        settings: {
          publicSharesEnabled: true,
          yaClientBaseUrl: `http://127.0.0.1:${port}`,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  let server = null;
  const agents = Array.from(
    { length: scenario.concurrentClients },
    () => new http.Agent({ keepAlive: true, maxSockets: 1 }),
  );
  try {
    server = await startServer({
      checkout,
      driver: "specialized",
      fixture,
      port,
      root,
      config,
      runMarker,
    });
    await waitForJson(
      `${server.baseUrl}/api/public-shares/status`,
      (body) =>
        body?.canCreate === true &&
        body.storageState === "ready" &&
        body.relayStatus === "waiting",
      {
        description: "public-share storage and relay readiness",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );
    const target = selectedFixtureTarget(server, fixture, scenario);
    const startupMemory = await sampleMemory(
      server.inspectorUrl,
      server.maintenanceUrl,
      config.server.requestTimeoutMs,
    );
    const createResponse = await requestJson(
      `${server.baseUrl}/api/public-shares`,
      {
        json: {
          projectId: target.detail.projectId,
          sessionId: target.detail.sessionId,
          mode: "frozen",
        },
        method: "POST",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );
    const publicUrl = createResponse.body?.url;
    if (typeof publicUrl !== "string") {
      throw new Error("public-share creation response omitted its URL");
    }
    const secret = new URL(publicUrl).pathname
      .split("/")
      .filter(Boolean)
      .at(-1);
    if (!secret) throw new Error("public-share URL omitted its secret");

    const publicBase = `${server.baseUrl}/public-api/shares/${encodeURIComponent(
      secret,
    )}`;
    const metadata = await requestJson(`${publicBase}/metadata`, {
      timeoutMs: config.server.requestTimeoutMs,
    });
    if (
      !Array.isArray(metadata.body?.capabilities) ||
      !metadata.body.capabilities.includes("public-share-session-chunks-v1") ||
      !metadata.body.sessionChunks
    ) {
      throw new Error("frozen public share omitted bounded chunk metadata");
    }

    const marker = `[${target.detail.sessionId}:assistant:${
      scenario.initialTurns - 1
    }]`;
    const herd = await runClientBatch(
      agents,
      Array.from({ length: scenario.concurrentClients }, () => ({
        url: publicBase,
        needle: marker,
      })),
      config.server.requestTimeoutMs,
    );
    for (const [index, body] of herd.bodies.entries()) {
      assertCount(
        bodyArray(body?.session, "messages", `public share ${index}`).length,
        scenario.initialTurns * 2,
        `public share ${index} message count`,
      );
    }
    const settledMemory = await sampleMemory(
      server.inspectorUrl,
      server.maintenanceUrl,
      config.server.requestTimeoutMs,
    );
    return {
      correctness: {
        concurrentClients: scenario.concurrentClients,
        frozenShare: true,
        legacyResponses: herd.bodies.length,
        modernChunkMetadata: true,
        relayStatus: "waiting",
      },
      latency: {
        metadataMs: round(metadata.ms),
        herd: summarize(herd.latencies),
        herdFirstByte: summarize(herd.firstByteLatencies),
        herdReadableText: summarize(herd.readableTextLatencies),
      },
      memory: {
        startup: memoryView(startupMemory),
        settled: memoryView(settledMemory),
        retainedHeapMiB: bytesToMiB(
          settledMemory.heapUsedBytes - startupMemory.heapUsedBytes,
        ),
        retainedRssMiB: bytesToMiB(
          settledMemory.rssBytes - startupMemory.rssBytes,
        ),
      },
      processManifest: await readProcessManifest(server.processManifestPath),
      responseMiB: bytesToMiB(
        herd.bytes.reduce((sum, value) => sum + value, 0),
      ),
      serverLog: server.logPath,
      serverStartupMs: round(server.startupMs),
    };
  } finally {
    for (const agent of agents) agent.destroy();
    if (server) {
      server.log.end();
      await stopServer(server.child);
    }
    await relay.close();
  }
}

export async function measureSpecializedRepetition({
  checkout,
  config,
  executionRevision,
  fixtureConfig,
  label,
  repetition,
  runMarker,
  scenario,
  scenarioName,
  workRoot,
}) {
  for (const field of ["streamChunks", "streamChunkBytes", "idleReapSeconds"]) {
    requirePositiveInteger(
      scenario[field],
      `scenarios.${scenarioName}.${field}`,
    );
  }
  if (!Number.isInteger(scenario.streamDelayMs) || scenario.streamDelayMs < 0) {
    throw new Error(
      `scenarios.${scenarioName}.streamDelayMs must be a nonnegative integer`,
    );
  }
  const repetitionRoot = path.join(workRoot, `rep-${repetition}`);
  await mkdir(repetitionRoot, { recursive: true });
  const fixture = await createFixture(repetitionRoot, scenario, fixtureConfig);
  const ownedProvider = await measureOwnedProviderLifecycle({
    checkout,
    config,
    fixture,
    repetitionRoot,
    runMarker,
    scenario,
  });
  const publicShare = await measurePublicShareHerd({
    checkout,
    config,
    fixture,
    repetitionRoot,
    runMarker,
    scenario,
  });

  return {
    schemaVersion: 2,
    suiteVersion: SUITE_VERSION,
    identity: {
      executionRevision,
      fixtureRevision: fixture.fixtureRevision,
    },
    label,
    repetition,
    scenario: scenarioName,
    parameters: scenario,
    runtime: {
      driver: "specialized",
      node: process.version,
      providerExecutionBoundary: {
        discovery: "real-provider-catalog",
        liveProviderAllowed: false,
        sessionLaunch: "out-of-process-simulated-provider-runtime",
        omittedBoundary: "provider SDK and paid provider execution",
      },
      ownedProviderProcessManifest: ownedProvider.processManifest,
      ownedProviderServerLog: ownedProvider.serverLog,
      ownedProviderServerStartupMs: ownedProvider.serverStartupMs,
      publicShareProcessManifest: publicShare.processManifest,
      publicShareServerLog: publicShare.serverLog,
      publicShareServerStartupMs: publicShare.serverStartupMs,
    },
    correctness: {
      fixtureRevision: fixture.fixtureRevision,
      providerCatalogFamilies: fixtureConfig.providerCatalogFamilies,
      ownedProvider: ownedProvider.correctness,
      publicShare: publicShare.correctness,
    },
    latency: {
      providerFirstTextDelta: summarize([
        ownedProvider.latency.firstTextDeltaMs,
      ]),
      providerFinalRaw: summarize([ownedProvider.latency.finalRawMs]),
      providerFinalEnriched: summarize([ownedProvider.latency.finalEnrichedMs]),
      idleOwnershipRelease: summarize([
        ownedProvider.latency.idleOwnershipReleaseMs,
      ]),
      publicShareMetadata: summarize([publicShare.latency.metadataMs]),
      publicShareHerd: publicShare.latency.herd,
      publicShareHerdFirstByte: publicShare.latency.herdFirstByte,
      publicShareHerdReadableText: publicShare.latency.herdReadableText,
    },
    throughput: {
      providerTextMiBPerSecond: ownedProvider.throughput.textMiBPerSecond,
    },
    responseMiB: {
      publicShareHerd: publicShare.responseMiB,
    },
    memory: publicShare.memory,
  };
}
