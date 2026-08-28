import { appendFile, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
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

async function installVisibleProviderTurnObserver(page, key) {
  await page.evaluate((probeKey) => {
    const countProviderMarkers = () =>
      document.body?.innerText.match(/\[perf-assistant-[^\]]+\]/g)?.length ?? 0;
    const probe = {
      atMs: null,
      baselineCount: countProviderMarkers(),
      currentCount: 0,
      observer: null,
    };
    const inspect = () => {
      probe.currentCount = countProviderMarkers();
      if (probe.currentCount <= probe.baselineCount) return;
      probe.atMs ??= performance.now();
      probe.observer?.disconnect();
    };
    probe.observer = new MutationObserver(inspect);
    probe.observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    window[probeKey] = probe;
    inspect();
  }, key);
}

async function waitForVisibleMarker(page, key, timeoutMs) {
  try {
    await page.waitForFunction(
      (probeKey) => typeof window[probeKey]?.atMs === "number",
      key,
      { timeout: timeoutMs },
    );
  } catch (error) {
    const diagnostic = await page.evaluate((probeKey) => {
      const harness = window.__YA_SEMANTIC_UI_ACTIONS__;
      return {
        bodyTextTail: document.body?.innerText.slice(-4_000),
        harness:
          harness?.kind === "semantic-ui-action-harness"
            ? harness.snapshot()
            : harness,
        probe: window[probeKey],
        renderIds: [...document.querySelectorAll("[data-render-id]")]
          .slice(-20)
          .map((element) => element.getAttribute("data-render-id")),
      };
    }, key);
    throw new Error(
      `visible marker ${key} timed out: ${JSON.stringify(diagnostic)}\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return page.evaluate((probeKey) => window[probeKey].atMs, key);
}

async function waitForObservedProviderTurn(page, startIndex, timeoutMs) {
  await page.waitForFunction(
    (start) => {
      const harness = window.__YA_SEMANTIC_UI_ACTIONS__;
      if (harness?.kind !== "semantic-ui-action-harness") return false;
      const events = harness.snapshot().observedEvents.slice(start);
      return (
        events.some((event) => event.dataType === "assistant") &&
        events.some((event) => event.dataType === "result")
      );
    },
    startIndex,
    { timeout: timeoutMs },
  );
  return page.evaluate(
    (start) =>
      window.__YA_SEMANTIC_UI_ACTIONS__.snapshot().observedEvents.slice(start),
    startIndex,
  );
}

async function measureSemanticActionReplay({
  checkout,
  config,
  events,
  initialAssistantId,
  projectId,
  runMarker,
  server,
  sessionId,
}) {
  const playwrightPath = path.join(
    checkout,
    "packages/client/node_modules/@playwright/test/index.mjs",
  );
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const browser = await chromium.launch({
    args: ["--enable-precise-memory-info"],
    env: { ...process.env, PERF_RUN_ID: runMarker },
    headless: true,
  });
  await appendFile(
    server.processManifestPath,
    `${JSON.stringify({
      recordedAt: new Date().toISOString(),
      role: "semantic action Playwright Chromium process tree",
      pid: null,
      pgid: null,
      marker: runMarker,
      tracking: "PERF_RUN_ID environment; perf-sweep is authoritative",
    })}\n`,
  );
  let context = null;
  try {
    context = await browser.newContext({
      viewport: { width: 1000, height: 600 },
    });
    await context.addInitScript(() => {
      window.__YA_SEMANTIC_UI_ACTIONS__ = {
        schemaVersion: 1,
        gather: true,
        replay: true,
      };
    });
    const page = await context.newPage();
    const browserDiagnostics = [];
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error") {
        browserDiagnostics.push({
          kind: `console-${message.type()}`,
          text: message.text(),
        });
      }
    });
    page.on("requestfailed", (request) => {
      browserDiagnostics.push({
        error: request.failure()?.errorText,
        kind: "request-failed",
        method: request.method(),
        url: request.url(),
      });
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        browserDiagnostics.push({
          kind: "response-error",
          method: response.request().method(),
          status: response.status(),
          url: response.url(),
        });
      }
    });
    const sessionUrl =
      `${server.baseUrl}/projects/${encodeURIComponent(projectId)}` +
      `/sessions/${encodeURIComponent(sessionId)}`;
    await page.goto(sessionUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => {
        const harness = window.__YA_SEMANTIC_UI_ACTIONS__;
        return (
          harness?.kind === "semantic-ui-action-harness" &&
          document.querySelector("[data-composer-input]") !== null
        );
      },
      undefined,
      { timeout: config.server.requestTimeoutMs },
    );

    const anchorEventStart = events.length;
    await requestJson(
      `${server.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        json: {
          message: "Seed the semantic action stream anchor.",
          provider: "claude",
          tempId: `perf-semantic-anchor-${sessionId}`,
        },
        method: "POST",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );
    const anchorAssistant = await waitForRecordedEvent(
      events,
      (record) =>
        events.indexOf(record) >= anchorEventStart &&
        record.message.eventType === "message" &&
        record.message.data?.type === "assistant",
      {
        description: "semantic action anchor provider completion",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );
    await waitForRecordedEvent(
      events,
      (record) =>
        events.indexOf(record) >= anchorEventStart &&
        record.message.eventType === "message" &&
        record.message.data?.type === "result",
      {
        description: "semantic action anchor provider result",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );
    await waitForJson(
      `${server.baseUrl}/api/sessions/${sessionId}/process`,
      (body) => body?.process?.state === "idle",
      {
        description: "semantic action anchor idle state",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );
    await page.waitForFunction(
      () =>
        window.__YA_SEMANTIC_UI_ACTIONS__?.kind ===
          "semantic-ui-action-harness" &&
        window.__YA_SEMANTIC_UI_ACTIONS__.snapshot().observedAnchorCount > 0,
      undefined,
      { timeout: config.server.requestTimeoutMs },
    );
    await page.waitForFunction(
      (marker) => document.body?.innerText.includes(marker),
      `[${anchorAssistant.message.data.uuid}]`,
      { timeout: config.server.requestTimeoutMs },
    );

    const humanText = "Semantic action gather and replay fixture.";
    await installVisibleProviderTurnObserver(page, "__yaSemanticHumanVisible");
    const composer = page.locator("[data-composer-input]");
    await composer.fill(humanText);
    const humanStartedAtMs = await page.evaluate(() => performance.now());
    const humanObservedEventStart = await page.evaluate(
      () => window.__YA_SEMANTIC_UI_ACTIONS__.snapshot().observedEvents.length,
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(
      () =>
        window.__YA_SEMANTIC_UI_ACTIONS__?.kind ===
          "semantic-ui-action-harness" &&
        window.__YA_SEMANTIC_UI_ACTIONS__.snapshot().actions.length === 1,
      undefined,
      { timeout: config.server.requestTimeoutMs },
    );
    let humanObservedEvents;
    try {
      humanObservedEvents = await waitForObservedProviderTurn(
        page,
        humanObservedEventStart,
        config.server.requestTimeoutMs,
      );
    } catch (error) {
      const pageState = await page.evaluate(() => {
        const harness = window.__YA_SEMANTIC_UI_ACTIONS__;
        return {
          bodyTextTail: document.body?.innerText.slice(-4_000),
          harness:
            harness?.kind === "semantic-ui-action-harness"
              ? harness.snapshot()
              : harness,
          modalText: document.querySelector(".modal-overlay")?.textContent,
        };
      });
      throw new Error(
        `human semantic action did not reach provider: ${JSON.stringify({
          browserDiagnostics,
          pageState,
        })}\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await waitForJson(
      `${server.baseUrl}/api/sessions/${sessionId}/process`,
      (body) => body?.process?.state === "idle",
      {
        description: "human semantic action idle state",
        timeoutMs: config.server.requestTimeoutMs,
      },
    );
    const humanVisibleAtMs = await waitForVisibleMarker(
      page,
      "__yaSemanticHumanVisible",
      config.server.requestTimeoutMs,
    );
    const action = await page.evaluate(
      () => window.__YA_SEMANTIC_UI_ACTIONS__.snapshot().actions[0],
    );
    await page.evaluate(
      ({ actionId, valueMs }) =>
        window.__YA_SEMANTIC_UI_ACTIONS__.recordMeasurement({
          side: "client",
          name: "semantic-action.human-visible-outcome",
          valueMs,
          actionId,
        }),
      {
        actionId: action.actionId,
        valueMs: humanVisibleAtMs - humanStartedAtMs,
      },
    );

    await installVisibleProviderTurnObserver(page, "__yaSemanticReplayVisible");
    const messagePath = `/api/sessions/${encodeURIComponent(sessionId)}/messages`;
    let requestStartedAtMs = null;
    let responseReceivedAtMs = null;
    const onRequest = (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === messagePath
      ) {
        requestStartedAtMs ??= performance.now();
      }
    };
    const onResponse = (response) => {
      if (
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === messagePath
      ) {
        responseReceivedAtMs ??= performance.now();
      }
    };
    page.on("request", onRequest);
    page.on("response", onResponse);
    const replayObservedEventStart = await page.evaluate(
      () => window.__YA_SEMANTIC_UI_ACTIONS__.snapshot().observedEvents.length,
    );
    const replay = await page.evaluate(
      (record) => window.__YA_SEMANTIC_UI_ACTIONS__.replay(record),
      action,
    );
    const replayObservedEvents = await waitForObservedProviderTurn(
      page,
      replayObservedEventStart,
      config.server.requestTimeoutMs,
    );
    const replayVisibleAtMs = await waitForVisibleMarker(
      page,
      "__yaSemanticReplayVisible",
      config.server.requestTimeoutMs,
    );
    const replayFirstTextDelta = replayObservedEvents.find(
      (event) => event.deltaType === "text_delta",
    );
    if (!replayFirstTextDelta) {
      throw new Error("semantic action replay omitted its first text delta");
    }
    const humanAssistantId = humanObservedEvents.find(
      (event) => event.dataType === "assistant",
    )?.messageId;
    const replayAssistantId = replayObservedEvents.find(
      (event) => event.dataType === "assistant",
    )?.messageId;
    if (!humanAssistantId || !replayAssistantId) {
      throw new Error("semantic action replay omitted assistant identities");
    }
    const priorTurnsRemainOrderedAndVisible = await page.evaluate(
      (messageIds) => {
        const rows = [...document.querySelectorAll("[data-render-id]")];
        const matched = messageIds.map((messageId) => {
          const row = rows.find((element) =>
            element.getAttribute("data-render-id")?.startsWith(`${messageId}-`),
          );
          return {
            contentMatches:
              row?.textContent?.includes(`[${messageId}]`) ?? false,
            index: row ? rows.indexOf(row) : -1,
          };
        });
        return matched.every(
          (entry, index) =>
            entry.contentMatches &&
            entry.index >= 0 &&
            (index === 0 || entry.index > matched[index - 1].index),
        );
      },
      [
        initialAssistantId,
        anchorAssistant.message.data.uuid,
        humanAssistantId,
        replayAssistantId,
      ],
    );
    if (!priorTurnsRemainOrderedAndVisible) {
      throw new Error("semantic action replay changed prior rendered turns");
    }
    page.off("request", onRequest);
    page.off("response", onResponse);
    if (requestStartedAtMs === null || responseReceivedAtMs === null) {
      throw new Error("semantic action replay request timing was not observed");
    }
    const replayVisibleOutcomeMs =
      replayVisibleAtMs - replay.timing.startedAtMonotonicMs;
    const requestRoundTripMs = responseReceivedAtMs - requestStartedAtMs;
    const providerFirstTextDeltaMs =
      replayFirstTextDelta.observedAtMonotonicMs -
      replay.timing.startedAtMonotonicMs;
    await page.evaluate(
      ({
        actionId,
        providerFirstTextDeltaMs,
        replayVisibleOutcomeMs,
        requestRoundTripMs,
      }) => {
        const harness = window.__YA_SEMANTIC_UI_ACTIONS__;
        harness.recordMeasurement({
          side: "client",
          name: "semantic-action.replay-visible-outcome",
          valueMs: replayVisibleOutcomeMs,
          actionId,
        });
        harness.recordMeasurement({
          side: "server",
          name: "semantic-action.message-accept-round-trip",
          valueMs: requestRoundTripMs,
          actionId,
        });
        harness.recordMeasurement({
          side: "server",
          name: "semantic-action.provider-first-text-delta",
          valueMs: providerFirstTextDeltaMs,
          actionId,
        });
      },
      {
        actionId: action.actionId,
        providerFirstTextDeltaMs,
        replayVisibleOutcomeMs,
        requestRoundTripMs,
      },
    );

    const dispatchOverhead = await page.evaluate(
      ({ sessionId, sourceKey }) =>
        window.__YA_SEMANTIC_UI_ACTIONS__.measureDispatchOverhead({
          sourceKey,
          sessionId,
        }),
      { sessionId, sourceKey: action.sourceKey },
    );
    const unmatchedAction = structuredClone(action);
    unmatchedAction.anchor.eventId = "semantic-action-unmatched-event";
    unmatchedAction.anchor.messageId = "semantic-action-unmatched-message";
    const unmatched = await page.evaluate(
      (record) =>
        window.__YA_SEMANTIC_UI_ACTIONS__.replay(record, {
          anchorTimeoutMs: 10,
        }),
      unmatchedAction,
    );
    const snapshot = await page.evaluate(() =>
      window.__YA_SEMANTIC_UI_ACTIONS__.snapshot(),
    );
    if (replay.status !== "executed" || !replay.anchorMatched) {
      throw new Error(
        `semantic action replay diverged: ${JSON.stringify(replay)}`,
      );
    }
    if (
      unmatched.status !== "diverged" ||
      unmatched.divergence?.stage !== "anchor"
    ) {
      throw new Error(
        `unmatched semantic action lacked divergence: ${JSON.stringify(unmatched)}`,
      );
    }
    if (browserDiagnostics.length > 0) {
      throw new Error(
        `semantic action browser emitted diagnostics: ${JSON.stringify(browserDiagnostics)}`,
      );
    }

    return {
      action: {
        schemaVersion: action.schemaVersion,
        kind: action.kind,
        anchorKind: action.anchor.kind,
        anchorHasIdentity: Boolean(
          action.anchor.eventId || action.anchor.messageId,
        ),
      },
      correctness: {
        gatheredFromHumanControl: true,
        replayedWithoutDomInput: true,
        visibleHumanOutcome: true,
        visibleReplayOutcome: true,
        priorTurnsRemainOrderedAndVisible: true,
        unmatchedAnchorDiverged: true,
        measurementsRetainedAfterDivergence:
          snapshot.measurements.length >= 8 &&
          snapshot.firstDivergence?.stage === "anchor",
      },
      dispatchOverhead,
      measurements: snapshot.measurements,
      divergence: unmatched.divergence,
      latency: {
        humanVisibleOutcomeMs: round(humanVisibleAtMs - humanStartedAtMs),
        replayTotalMs: replay.timing.totalMs,
        replayVisibleOutcomeMs: round(replayVisibleOutcomeMs),
        requestRoundTripMs: round(requestRoundTripMs),
        providerFirstTextDeltaMs: round(providerFirstTextDeltaMs),
      },
    };
  } finally {
    await context?.close();
    await browser.close();
  }
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

    const semanticAction = await measureSemanticActionReplay({
      checkout,
      config,
      events,
      initialAssistantId: assistantId,
      projectId: target.detail.projectId,
      runMarker,
      server,
      sessionId,
    });

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
        semanticAction: semanticAction.correctness,
      },
      latency: {
        firstTextDeltaMs: round(firstTextDelta.receivedAtMs - turnStartedAtMs),
        finalRawMs: round(finalRawMs),
        finalEnrichedMs: round(
          enrichedAssistant.receivedAtMs - turnStartedAtMs,
        ),
        idleOwnershipReleaseMs: round(performance.now() - reapStartedAtMs),
        semanticAction: semanticAction.latency,
      },
      semanticAction: {
        action: semanticAction.action,
        dispatchOverhead: semanticAction.dispatchOverhead,
        divergence: semanticAction.divergence,
        measurements: semanticAction.measurements,
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
    await stopServer(server.child, server.providerHostRuntimeDir);
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
      await stopServer(server.child, server.providerHostRuntimeDir);
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
      semanticActionHumanVisible: summarize([
        ownedProvider.latency.semanticAction.humanVisibleOutcomeMs,
      ]),
      semanticActionReplayTotal: summarize([
        ownedProvider.latency.semanticAction.replayTotalMs,
      ]),
      semanticActionReplayVisible: summarize([
        ownedProvider.latency.semanticAction.replayVisibleOutcomeMs,
      ]),
      semanticActionMessageAcceptRoundTrip: summarize([
        ownedProvider.latency.semanticAction.requestRoundTripMs,
      ]),
      semanticActionProviderFirstTextDelta: summarize([
        ownedProvider.latency.semanticAction.providerFirstTextDeltaMs,
      ]),
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
    semanticAction: ownedProvider.semanticAction,
    responseMiB: {
      publicShareHerd: publicShare.responseMiB,
    },
    memory: publicShare.memory,
  };
}
