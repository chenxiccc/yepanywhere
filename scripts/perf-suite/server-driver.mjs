import { mkdir } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { measureBrowserMode } from "./browser-driver.mjs";
import { measureBuiltClientRepetition } from "./built-client-driver.mjs";
import {
  SUITE_VERSION,
  assertCount,
  bodyArray,
  bytesToKiB,
  bytesToMiB,
  round,
  summarize,
} from "./core.mjs";
import {
  appendTurns,
  createFixture,
  findPortPair,
  prepareAppendedTurns,
  readProcessManifest,
  requestJson,
  sampleMemory,
  startServer,
  stopServer,
  wait,
} from "./process-fixture.mjs";
import { runClientBatch, runHerd } from "./request-clients.mjs";
import { measureSpecializedRepetition } from "./specialized-driver.mjs";
import {
  memoryView,
  summarizeExternalSessionSummaryWindow,
  summarizeRequestProfiles,
} from "./telemetry.mjs";

export function repetitionOwner(driver) {
  if (driver === "specialized") return "specialized";
  if (driver === "built-client") return "built-client";
  return "server-browser";
}

export async function measureRepetition({
  checkout,
  config,
  driver,
  executionRevision,
  fixtureConfig,
  generalizedProjectPathsSupported,
  label,
  repetition,
  runMarker,
  scenario,
  scenarioName,
  workRoot,
}) {
  if (repetitionOwner(driver) === "specialized") {
    return measureSpecializedRepetition({
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
    });
  }
  if (repetitionOwner(driver) === "built-client") {
    return measureBuiltClientRepetition({
      checkout,
      config,
      executionRevision,
      fixtureConfig,
      generalizedProjectPathsSupported,
      label,
      repetition,
      runMarker,
      scenario,
      scenarioName,
      workRoot,
    });
  }
  const repetitionRoot = path.join(workRoot, `rep-${repetition}`);
  await mkdir(repetitionRoot, { recursive: true });
  const fixture = await createFixture(repetitionRoot, scenario, fixtureConfig);
  const port = await findPortPair(config.server.portBase + repetition * 3);
  const server = await startServer({
    checkout,
    driver,
    fixture,
    port,
    root: repetitionRoot,
    config,
    runMarker,
  });
  let browserMeasurement = null;
  const agents = Array.from(
    { length: scenario.concurrentClients },
    () => new http.Agent({ keepAlive: true, maxSockets: 1 }),
  );
  const expectedSessions = scenario.projects * scenario.sessionsPerProject;
  const initialMessages = scenario.initialTurns * 2;
  const appendedMessages = (scenario.initialTurns + scenario.newTurns) * 2;

  try {
    await wait(scenario.settleMs);
    const startupMemory = await sampleMemory(
      server.inspectorUrl,
      server.maintenanceUrl,
      config.server.requestTimeoutMs,
    );

    const projectResponse = await requestJson(
      `${server.baseUrl}/api/projects`,
      {
        agent: agents[0],
        timeoutMs: config.server.requestTimeoutMs,
      },
    );
    const projects = bodyArray(
      projectResponse.body,
      "projects",
      "project list",
    );
    assertCount(projects.length, scenario.projects, "project count");

    const versionResponse = await requestJson(`${server.baseUrl}/api/version`, {
      agent: agents[0],
      timeoutMs: config.server.requestTimeoutMs,
    });
    const capabilities = Array.isArray(versionResponse.body?.capabilities)
      ? versionResponse.body.capabilities
      : [];
    const glossarySupported = capabilities.includes("glossary-tooltips");
    const glossaryBatch = glossarySupported
      ? await runClientBatch(
          agents,
          projects.map(
            (project) =>
              `${server.baseUrl}/api/projects/${encodeURIComponent(project.id)}/glossary-artifact`,
          ),
          config.server.requestTimeoutMs,
        )
      : {
          bodies: [],
          bytes: [],
          firstByteLatencies: [],
          latencies: [],
          readableTextLatencies: [],
        };
    glossaryBatch.bodies.forEach((body, index) => {
      if (
        body?.status !== "ready" ||
        !Array.isArray(body.artifact?.terminals)
      ) {
        throw new Error(`project ${projects[index].id} glossary was not ready`);
      }
      if (body.artifact.terminals.length === 0) {
        throw new Error(`project ${projects[index].id} glossary had no terms`);
      }
    });

    const sessionListUrls = projects.map(
      (project) =>
        `${server.baseUrl}/api/projects/${encodeURIComponent(project.id)}/sessions`,
    );
    const projectSessionBatch = await runClientBatch(
      agents,
      sessionListUrls,
      config.server.requestTimeoutMs,
    );
    const details = [];
    for (let index = 0; index < projects.length; index += 1) {
      const sessions = bodyArray(
        projectSessionBatch.bodies[index],
        "sessions",
        `project ${projects[index].id} session list`,
      );
      assertCount(
        sessions.length,
        scenario.sessionsPerProject,
        `project ${projects[index].id} session count`,
      );
      for (const session of sessions) {
        details.push({ projectId: projects[index].id, sessionId: session.id });
      }
    }
    assertCount(details.length, expectedSessions, "total session count");
    const warmProjectSessionBatch = await runClientBatch(
      agents,
      sessionListUrls,
      config.server.requestTimeoutMs,
    );
    warmProjectSessionBatch.bodies.forEach((body, index) => {
      assertCount(
        bodyArray(
          body,
          "sessions",
          `warm project ${projects[index].id} session list`,
        ).length,
        scenario.sessionsPerProject,
        `warm project ${projects[index].id} session count`,
      );
    });

    const collectionHerd = await runHerd(
      agents,
      [
        `${server.baseUrl}/api/sessions?limit=100`,
        `${server.baseUrl}/api/inbox`,
      ],
      config.server.requestTimeoutMs,
    );
    let globalCollectionResponses = 0;
    let inboxResponses = 0;
    for (const body of collectionHerd.bodies) {
      if (Array.isArray(body?.sessions)) {
        globalCollectionResponses += 1;
        assertCount(
          body.sessions.length,
          expectedSessions,
          "collection session count",
        );
        continue;
      }
      inboxResponses += 1;
      for (const tier of [
        "needsAttention",
        "active",
        "recentActivity",
        "unread8h",
        "unread24h",
      ]) {
        bodyArray(body, tier, "Inbox collection herd");
      }
    }
    assertCount(
      globalCollectionResponses,
      scenario.concurrentClients,
      "global collection response count",
    );
    assertCount(
      inboxResponses,
      scenario.concurrentClients,
      "Inbox response count",
    );
    const collectionMemory = await sampleMemory(
      server.inspectorUrl,
      server.maintenanceUrl,
      config.server.requestTimeoutMs,
    );

    if (driver === "browser") {
      browserMeasurement = await measureBrowserMode({
        checkout,
        config,
        details,
        generalizedProjectPathsSupported,
        glossarySupported,
        repetition,
        runMarker,
        scenario,
        server,
      });
    }
    const browserLoadedMemory = browserMeasurement
      ? await sampleMemory(
          server.inspectorUrl,
          server.maintenanceUrl,
          config.server.requestTimeoutMs,
        )
      : null;

    const detailTargets = details.map(({ projectId, sessionId }) => ({
      url:
        `${server.baseUrl}/api/projects/${encodeURIComponent(projectId)}` +
        `/sessions/${encodeURIComponent(sessionId)}?fullHistory=1&fullHistoryReason=performance-survey`,
      needle: `[${sessionId}:assistant:${scenario.initialTurns - 1}]`,
    }));
    const coldDetails = await runClientBatch(
      agents,
      detailTargets,
      config.server.requestTimeoutMs,
    );
    coldDetails.bodies.forEach((body, index) => {
      assertCount(
        bodyArray(body, "messages", `cold detail ${index}`).length,
        initialMessages,
        `cold detail ${index} message count`,
      );
    });
    if (
      !coldDetails.bodies.some((body) =>
        JSON.stringify(body).includes("README.md"),
      )
    ) {
      throw new Error("session detail omitted the project-file link fixture");
    }

    const warmDetails = await runHerd(
      agents,
      detailTargets,
      config.server.requestTimeoutMs,
    );
    for (let index = 0; index < warmDetails.bodies.length; index += 1) {
      assertCount(
        bodyArray(warmDetails.bodies[index], "messages", `warm detail ${index}`)
          .length,
        initialMessages,
        `warm detail ${index} message count`,
      );
    }
    const detailMemory = await sampleMemory(
      server.inspectorUrl,
      server.maintenanceUrl,
      config.server.requestTimeoutMs,
    );

    const preparedAppends = prepareAppendedTurns(fixture, scenario);
    const appendWindowStartedAt = new Date().toISOString();
    await browserMeasurement?.prepareAppend();
    const browserAppendObservation = browserMeasurement?.observeAppend();
    await appendTurns(preparedAppends);
    await browserAppendObservation;
    await wait(config.server.appendObservationMs);
    const appendedDetailTargets = detailTargets.map((target, index) => ({
      ...target,
      needle:
        `[${details[index].sessionId}:assistant:` +
        `${scenario.initialTurns + scenario.newTurns - 1}]`,
    }));
    const appendedDetails = await runHerd(
      agents,
      appendedDetailTargets,
      config.server.requestTimeoutMs,
    );
    for (let index = 0; index < appendedDetails.bodies.length; index += 1) {
      assertCount(
        bodyArray(
          appendedDetails.bodies[index],
          "messages",
          `appended detail ${index}`,
        ).length,
        appendedMessages,
        `appended detail ${index} message count`,
      );
    }
    const appendedMemory = await sampleMemory(
      server.inspectorUrl,
      server.maintenanceUrl,
      config.server.requestTimeoutMs,
    );
    const externalSessionSummaryAppend = summarizeExternalSessionSummaryWindow(
      detailMemory,
      appendedMemory,
      {
        startedAt: appendWindowStartedAt,
        endedAt: new Date().toISOString(),
      },
    );

    await wait(scenario.settleMs);
    const settledMemory = await sampleMemory(
      server.inspectorUrl,
      server.maintenanceUrl,
      config.server.requestTimeoutMs,
    );
    const retainedHeapBytes =
      settledMemory.heapUsedBytes - startupMemory.heapUsedBytes;
    const retainedRssBytes = settledMemory.rssBytes - startupMemory.rssBytes;
    const totalTurns =
      expectedSessions * (scenario.initialTurns + scenario.newTurns);

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
      host: {
        hostname: os.hostname(),
        loadAverage: os.loadavg().map((value) => round(value)),
        logicalCpus: os.cpus().length,
        platform: `${os.platform()} ${os.release()}`,
      },
      runtime: {
        driver,
        node: process.version,
        providerExecutionBoundary:
          driver === "browser"
            ? {
                discovery: "disabled-by-enabled-providers-filter",
                liveProviderAllowed: false,
                sessionLaunch: "in-process-mock",
              }
            : {
                discovery: "not-requested",
                liveProviderAllowed: false,
                sessionLaunch: "in-process-mock",
              },
        processManifest: await readProcessManifest(server.processManifestPath),
        serverStartupMs: round(server.startupMs),
        serverLog: server.logPath,
      },
      correctness: {
        projects: projects.length,
        sessions: details.length,
        initialMessagesPerSession: initialMessages,
        appendedMessagesPerSession: appendedMessages,
        glossarySupported,
        glossaryArtifacts: glossaryBatch.bodies.length,
        generalizedProjectPathsSupported,
        projectFileLinkNeedle: "README.md",
        fixtureRevision: fixture.fixtureRevision,
        providerCatalogFamilies: config.fixture.providerCatalogFamilies,
      },
      latency: {
        version: summarize([versionResponse.ms]),
        projectList: summarize([projectResponse.ms]),
        glossaryArtifacts: summarize(glossaryBatch.latencies),
        projectSessions: summarize(projectSessionBatch.latencies),
        projectSessionsWarm: summarize(warmProjectSessionBatch.latencies),
        collectionHerd: summarize(collectionHerd.latencies),
        detailCold: summarize(coldDetails.latencies),
        detailColdFirstByte: summarize(coldDetails.firstByteLatencies),
        detailColdTailText: summarize(coldDetails.readableTextLatencies),
        detailWarmHerd: summarize(warmDetails.latencies),
        detailWarmHerdFirstByte: summarize(warmDetails.firstByteLatencies),
        detailWarmHerdTailText: summarize(warmDetails.readableTextLatencies),
        detailAppendedHerd: summarize(appendedDetails.latencies),
        detailAppendedHerdFirstByte: summarize(
          appendedDetails.firstByteLatencies,
        ),
        detailAppendedHerdTailText: summarize(
          appendedDetails.readableTextLatencies,
        ),
      },
      profiles: {
        serverDetail: {
          cold: summarizeRequestProfiles(coldDetails.profiles),
          warm: summarizeRequestProfiles(warmDetails.profiles),
          appended: summarizeRequestProfiles(appendedDetails.profiles),
        },
        background: {
          externalSessionSummaryAppend,
        },
      },
      browser: browserMeasurement
        ? {
            modes: browserMeasurement.modes,
            processMemory: browserMeasurement.processMemory,
          }
        : null,
      responseMiB: {
        collectionHerd: bytesToMiB(
          collectionHerd.bytes.reduce((sum, value) => sum + value, 0),
        ),
        detailCold: bytesToMiB(
          coldDetails.bytes.reduce((sum, value) => sum + value, 0),
        ),
        detailWarmHerd: bytesToMiB(
          warmDetails.bytes.reduce((sum, value) => sum + value, 0),
        ),
        detailAppendedHerd: bytesToMiB(
          appendedDetails.bytes.reduce((sum, value) => sum + value, 0),
        ),
      },
      memory: {
        startup: memoryView(startupMemory),
        collection: memoryView(collectionMemory),
        browserLoaded: browserLoadedMemory
          ? memoryView(browserLoadedMemory)
          : null,
        detail: memoryView(detailMemory),
        appended: memoryView(appendedMemory),
        settled: memoryView(settledMemory),
        retainedHeapMiB: bytesToMiB(retainedHeapBytes),
        retainedRssMiB: bytesToMiB(retainedRssBytes),
        retainedHeapKiBPerProject: bytesToKiB(
          retainedHeapBytes / scenario.projects,
        ),
        retainedHeapKiBPerSession: bytesToKiB(
          retainedHeapBytes / expectedSessions,
        ),
        retainedHeapKiBPerTurn: bytesToKiB(retainedHeapBytes / totalTurns),
        retainedHeapKiBPerClient: bytesToKiB(
          retainedHeapBytes / scenario.concurrentClients,
        ),
      },
    };
  } finally {
    await browserMeasurement?.close();
    for (const agent of agents) agent.destroy();
    server.log.end();
    await stopServer(server.child, server.providerHostRuntimeDir);
  }
}
