import { bytesToMiB, getMetric, percentile, round } from "./core.mjs";

export function aggregateRuns(runs) {
  const paths = [
    "runtime.serverStartupMs",
    "runtime.ownedProviderServerStartupMs",
    "runtime.publicShareServerStartupMs",
    "runtime.serverStartupToSelectedSessionReadableMs",
    "runtime.builtClientServerStartupMs",
    "latency.serverSelectedSessionRequest.p95Ms",
    "latency.builtClientColdTail.p95Ms",
    "latency.builtClientColdGlossaryHighlight.p95Ms",
    "latency.builtClientColdProjectPathHighlight.p95Ms",
    "latency.builtClientColdFinalHighlight.p95Ms",
    "latency.providerFirstTextDelta.p95Ms",
    "latency.providerFinalRaw.p95Ms",
    "latency.providerFinalEnriched.p95Ms",
    "latency.idleOwnershipRelease.p95Ms",
    "latency.publicShareMetadata.p95Ms",
    "latency.publicShareHerd.p95Ms",
    "latency.publicShareHerdFirstByte.p95Ms",
    "latency.publicShareHerdReadableText.p95Ms",
    "throughput.providerTextMiBPerSecond",
    "responseMiB.serverSelectedSession",
    "responseMiB.publicShareHerd",
    "latency.glossaryArtifacts.p95Ms",
    "latency.projectSessions.p95Ms",
    "latency.projectSessionsWarm.p95Ms",
    "latency.collectionHerd.p95Ms",
    "latency.detailCold.p95Ms",
    "latency.detailColdFirstByte.p95Ms",
    "latency.detailColdTailText.p95Ms",
    "latency.detailWarmHerd.p95Ms",
    "latency.detailWarmHerdFirstByte.p95Ms",
    "latency.detailWarmHerdTailText.p95Ms",
    "latency.detailAppendedHerd.p95Ms",
    "latency.detailAppendedHerdFirstByte.p95Ms",
    "latency.detailAppendedHerdTailText.p95Ms",
    "responseMiB.detailCold",
    "responseMiB.detailWarmHerd",
    "responseMiB.detailAppendedHerd",
    "memory.settled.heapUsedMiB",
    "memory.settled.rssMiB",
    "memory.retainedHeapMiB",
    "memory.retainedRssMiB",
    "memory.retainedHeapKiBPerProject",
    "memory.retainedHeapKiBPerSession",
    "memory.retainedHeapKiBPerTurn",
    "memory.retainedHeapKiBPerClient",
    "memory.settled.knownCaches.claudeTranscript.retainedSourceBytes",
    "memory.settled.knownCaches.claudeTranscript.retainedFiles",
    "memory.settled.knownCaches.markdownAugments.retainedBytes",
    "memory.settled.knownCaches.markdownAugments.retainedEntries",
    "memory.settled.knownCaches.markdownAugments.cacheHits",
    "memory.settled.knownCaches.markdownAugments.joinedCalls",
    "memory.settled.knownCaches.markdownAugments.workStarts",
    "memory.settled.knownCaches.markdownAugments.staleCompletions",
    "memory.settled.knownCaches.markdownAugments.unretainedCompletions",
    "memory.settled.knownCaches.markdownAugments.evictions",
    "memory.settled.knownCaches.markdownAugments.failures",
    "memory.settled.knownCaches.markdownAugments.inFlight",
    "memory.settled.knownCaches.projectPaths.retainedBytes",
    "memory.settled.knownCaches.projectPaths.projects",
    "memory.settled.knownCaches.projectPaths.watchers",
    "memory.settled.relay.responseSerialization.eligibleJsonResponses",
    "memory.settled.relay.responseSerialization.rawFastPathHits",
    "memory.settled.relay.responseSerialization.rawBodyBytes",
    "memory.settled.relay.responseSerialization.fallbackResponses",
    "memory.settled.relay.responseSerialization.invalidJsonFallbacks",
    "memory.settled.relay.responseSerialization.unsupportedSenderFallbacks",
    "memory.settled.relay.responseSerialization.rawSendFailures",
    "memory.settled.residuals.heapUsedLessKnownCacheSourceMiB",
    "memory.settled.v8.heapSpaces.old_space.usedBytes",
    "memory.settled.v8.heapSpaces.large_object_space.usedBytes",
    "profiles.background.externalSessionSummaryAppend.counters.enqueuedTasks",
    "profiles.background.externalSessionSummaryAppend.counters.deduplicatedTasks",
    "profiles.background.externalSessionSummaryAppend.counters.batchesStarted",
    "profiles.background.externalSessionSummaryAppend.counters.batchesCompleted",
    "profiles.background.externalSessionSummaryAppend.counters.tasksStarted",
    "profiles.background.externalSessionSummaryAppend.counters.tasksSucceeded",
    "profiles.background.externalSessionSummaryAppend.counters.tasksFailed",
    "profiles.background.externalSessionSummaryAppend.counters.totalTaskDurationMs",
    "profiles.background.externalSessionSummaryAppend.counters.totalBatchDurationMs",
    "profiles.background.externalSessionSummaryAppend.queueDelay.p95Ms",
    "profiles.background.externalSessionSummaryAppend.batchDuration.p95Ms",
    "profiles.background.externalSessionSummaryAppend.maxTaskDuration.p95Ms",
    ...["cold", "warm", "appended"].flatMap((kind) => [
      `profiles.serverDetail.${kind}.server.project.p95Ms`,
      `profiles.serverDetail.${kind}.server.read.p95Ms`,
      `profiles.serverDetail.${kind}.server.normalize.p95Ms`,
      `profiles.serverDetail.${kind}.server.route.p95Ms`,
      `profiles.serverDetail.${kind}.server.augment.p95Ms`,
      `profiles.serverDetail.${kind}.server.total.p95Ms`,
      `profiles.serverDetail.${kind}.server.residual.p95Ms`,
      `profiles.serverDetail.${kind}.frameworkSerializeLoopback.p95Ms`,
      `profiles.serverDetail.${kind}.bodyTransfer.p95Ms`,
      `profiles.serverDetail.${kind}.jsonParse.p95Ms`,
    ]),
  ];
  return Object.fromEntries(
    paths.flatMap((metricPath) => {
      const profileKind = metricPath.match(
        /^profiles\.serverDetail\.(cold|warm|appended)\./,
      )?.[1];
      if (
        profileKind &&
        runs.every(
          (run) =>
            getMetric(
              run,
              `profiles.serverDetail.${profileKind}.availableCount`,
            ) === 0,
        )
      ) {
        return [];
      }
      const values = runs
        .map((run) => getMetric(run, metricPath))
        .filter((value) => typeof value === "number" && Number.isFinite(value));
      return values.length > 0
        ? [[metricPath, round(percentile(values, 0.5))]]
        : [];
    }),
  );
}

export function aggregateBrowserProcessMemory(runs) {
  const samples = runs.flatMap(
    (run) => run.browser?.processMemory?.samples ?? [],
  );
  const maximumMiB = (metricPath, eligible = () => true) => {
    const eligibleSamples = samples.filter(eligible);
    const values = eligibleSamples.map((sample) =>
      getMetric(sample, metricPath),
    );
    return values.length > 0 &&
      values.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
      ? bytesToMiB(Math.max(...values))
      : null;
  };
  const maximumCount = (metricPath) => {
    const values = samples
      .map((sample) => getMetric(sample, metricPath))
      .filter((value) => typeof value === "number" && Number.isFinite(value));
    return values.length > 0 ? Math.max(...values) : null;
  };
  const retainedMiB = (metricPath) => {
    const values = runs.map((run) => {
      const runSamples = run.browser?.processMemory?.samples ?? [];
      const startup = runSamples.find((sample) => sample.phase === "startup");
      const appended = runSamples.find((sample) => sample.phase === "appended");
      const startValue = getMetric(startup, metricPath);
      const appendedValue = getMetric(appended, metricPath);
      return typeof startValue === "number" &&
        Number.isFinite(startValue) &&
        typeof appendedValue === "number" &&
        Number.isFinite(appendedValue)
        ? appendedValue - startValue
        : null;
    });
    return values.length > 0 && values.every((value) => value !== null)
      ? bytesToMiB(percentile(values, 0.5))
      : null;
  };
  return Object.fromEntries(
    [
      ["processMemory.maxProcessCount", maximumCount("totals.processCount")],
      ["processMemory.maxTotalRssMiB", maximumMiB("totals.rssBytes")],
      ["processMemory.maxTotalPssMiB", maximumMiB("totals.pssBytes")],
      ["processMemory.maxTotalPrivateMiB", maximumMiB("totals.privateBytes")],
      [
        "processMemory.maxRendererRssMiB",
        maximumMiB(
          "byType.renderer.rssBytes",
          (sample) => sample.byType.renderer !== undefined,
        ),
      ],
      [
        "processMemory.maxRendererPssMiB",
        maximumMiB(
          "byType.renderer.pssBytes",
          (sample) => sample.byType.renderer !== undefined,
        ),
      ],
      ["processMemory.retainedRssMiB", retainedMiB("totals.rssBytes")],
      ["processMemory.retainedPssMiB", retainedMiB("totals.pssBytes")],
    ].filter(([, value]) => typeof value === "number"),
  );
}

export function aggregateBrowserRuns(runs) {
  const budgets = [
    ...new Set(
      runs.flatMap((run) =>
        (run.browser?.modes ?? []).map((mode) => mode.cacheBudgetMiB),
      ),
    ),
  ].sort((left, right) => left - right);
  return Object.fromEntries(
    budgets.map((cacheBudgetMiB) => {
      const modes = runs.map((run) =>
        run.browser?.modes.find(
          (mode) => mode.cacheBudgetMiB === cacheBudgetMiB,
        ),
      );
      if (modes.some((mode) => !mode)) {
        throw new Error(`Missing browser cache mode ${cacheBudgetMiB} MiB`);
      }
      const pageTelemetry = modes.flatMap((mode) => mode.telemetry);
      const cacheTelemetry = modes.flatMap((mode) => mode.warmCacheTelemetry);
      const clientProfileMetrics = {};
      for (const kind of ["coldNavigation", "warmNavigation", "append"]) {
        for (const group of [
          "nonOverlappingPhases",
          "messageListWithinQueuedToCommit",
          ...(kind === "append" ? ["eventPath.nonOverlappingPhases"] : []),
        ]) {
          const names = [
            ...new Set(
              modes.flatMap((mode) =>
                Object.keys(getMetric(mode.profiles?.[kind], group) ?? {}),
              ),
            ),
          ];
          for (const name of names) {
            const values = modes
              .map((mode) =>
                getMetric(mode.profiles?.[kind], `${group}.${name}.p95Ms`),
              )
              .filter((value) => typeof value === "number");
            if (values.length === 0) continue;
            clientProfileMetrics[`profiles.${kind}.${group}.${name}.p95Ms`] =
              round(percentile(values, 0.5));
          }
        }
      }
      return [
        String(cacheBudgetMiB),
        {
          ...clientProfileMetrics,
          "latency.coldTail.p95Ms": round(
            percentile(
              modes.map((mode) => mode.latency.coldTail.p95Ms),
              0.5,
            ),
          ),
          "latency.warmTail.p95Ms": round(
            percentile(
              modes.map((mode) => mode.latency.warmTail.p95Ms),
              0.5,
            ),
          ),
          "latency.appendedLiveTail.p95Ms": round(
            percentile(
              modes.map((mode) => mode.latency.appendedLiveTail.p95Ms),
              0.5,
            ),
          ),
          "latency.coldFinalHighlight.p95Ms": round(
            percentile(
              modes.map((mode) => mode.latency.coldFinalHighlight.p95Ms),
              0.5,
            ),
          ),
          "latency.warmFinalHighlight.p95Ms": round(
            percentile(
              modes.map((mode) => mode.latency.warmFinalHighlight.p95Ms),
              0.5,
            ),
          ),
          "latency.appendedLiveFinalHighlight.p95Ms": round(
            percentile(
              modes.map(
                (mode) => mode.latency.appendedLiveFinalHighlight.p95Ms,
              ),
              0.5,
            ),
          ),
          "memory.maxUsedJSHeapMiB": round(
            Math.max(
              ...pageTelemetry.map((entry) => entry.memory?.usedJSHeapMiB ?? 0),
            ),
          ),
          "memory.maxJSHeapLessTranscriptApproxMiB": round(
            Math.max(
              ...pageTelemetry.map((entry) =>
                entry.memory
                  ? entry.memory.usedJSHeapMiB -
                    entry.transcriptMemory.totalBytes / (1024 * 1024)
                  : 0,
              ),
            ),
          ),
          "transcriptCache.maxWarmBytes": Math.max(
            ...cacheTelemetry.map(
              (entry) => entry.transcriptMemory.warmCacheBytes,
            ),
            0,
          ),
          "transcriptCache.maxWarmEntries": Math.max(
            ...cacheTelemetry.map(
              (entry) => entry.transcriptMemory.warmCacheEntryCount,
            ),
            0,
          ),
          "transcriptCache.maxLiveBytes": Math.max(
            ...pageTelemetry.map(
              (entry) => entry.transcriptMemory.liveRetainedBytes,
            ),
            0,
          ),
          "transcriptCache.maxLiveEntries": Math.max(
            ...pageTelemetry.map(
              (entry) => entry.transcriptMemory.liveRetainedEntryCount,
            ),
            0,
          ),
          "dom.maxNodes": Math.max(
            ...pageTelemetry.map((entry) => entry.dom.nodes),
          ),
          "dom.maxCdpNodes": Math.max(
            ...pageTelemetry.map((entry) => entry.browserNative.nodes),
          ),
          "dom.maxDocuments": Math.max(
            ...pageTelemetry.map((entry) => entry.browserNative.documents),
          ),
          "dom.maxEventListeners": Math.max(
            ...pageTelemetry.map((entry) => entry.browserNative.eventListeners),
          ),
          "dom.maxLayoutObjects": Math.max(
            ...pageTelemetry
              .map((entry) => entry.browserNative.layoutObjects)
              .filter((value) => typeof value === "number"),
            0,
          ),
          "dom.maxMessageRows": Math.max(
            ...pageTelemetry.map((entry) => entry.dom.messageRows),
          ),
        },
      ];
    }),
  );
}
