import { appendFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { sampleChromiumProcessMemory } from "./browser-memory.mjs";
import { assertCount, summarize } from "./core.mjs";
import { wait } from "./process-fixture.mjs";
import {
  clientTelemetry,
  collectClientAppendProfile,
  collectClientNavigationProfile,
  navigateProfiledSpa,
  navigateSpa,
  prepareClientAppendProfile,
  sessionBrowserTarget,
  summarizeClientAppendProfiles,
  summarizeClientNavigationProfiles,
  waitForFinalDisplay,
} from "./telemetry.mjs";

export function waitWithTimeout(promise, timeoutMs, description) {
  return Promise.race([
    promise,
    wait(timeoutMs).then(() => {
      throw new Error(`${description} timed out after ${timeoutMs} ms`);
    }),
  ]);
}

export async function runCacheRefreshProof({
  cacheBudgetMiB,
  config,
  page,
  target,
  glossarySupported,
  projectPathsSupported,
}) {
  const expectedPath =
    `/api/projects/${encodeURIComponent(target.detail.projectId)}` +
    `/sessions/${encodeURIComponent(target.detail.sessionId)}`;
  let interceptedUrl = null;
  let releaseRequest;
  let requestSeen;
  let requestContinued;
  const releasePromise = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  const requestSeenPromise = new Promise((resolve) => {
    requestSeen = resolve;
  });
  const requestContinuedPromise = new Promise((resolve) => {
    requestContinued = resolve;
  });
  const routePattern = "**/api/projects/**/sessions/**";
  const handler = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== expectedPath || interceptedUrl) {
      await route.continue();
      return;
    }
    interceptedUrl = url;
    requestSeen();
    await releasePromise;
    await route.continue();
    requestContinued();
  };
  await page.route(routePattern, handler);
  try {
    const started = performance.now();
    let milestones = null;
    let visibleBeforeRelease = false;
    await navigateSpa(page, target.url);
    await waitWithTimeout(
      requestSeenPromise,
      config.fixture.cacheProofTimeoutMs,
      "cache proof detail request",
    );
    if (cacheBudgetMiB > 0) {
      milestones = await waitForFinalDisplay(page, target, {
        glossarySupported,
        projectPathsSupported,
        started,
        timeoutMs: config.fixture.cacheProofTimeoutMs,
      });
      visibleBeforeRelease = true;
    } else {
      await wait(config.fixture.cacheDisabledObservationMs);
      visibleBeforeRelease = await page.evaluate(
        (marker) => document.body?.innerText.includes(marker) ?? false,
        target.marker,
      );
      if (visibleBeforeRelease) {
        throw new Error(
          "cache-disabled revisit rendered transcript before refresh release",
        );
      }
    }
    releaseRequest();
    await waitWithTimeout(
      requestContinuedPromise,
      config.server.requestTimeoutMs,
      "cache proof request release",
    );
    if (!milestones) {
      milestones = await waitForFinalDisplay(page, target, {
        glossarySupported,
        projectPathsSupported,
        started,
        timeoutMs: config.server.requestTimeoutMs,
      });
    }
    const requestHadCursor = interceptedUrl.searchParams.has("afterMessageId");
    if (cacheBudgetMiB > 0 && !requestHadCursor) {
      throw new Error(
        "cache-enabled revisit made a cursorless refresh request",
      );
    }
    if (cacheBudgetMiB === 0 && requestHadCursor) {
      throw new Error(
        "cache-disabled revisit unexpectedly sent a cache cursor",
      );
    }
    return {
      milestones,
      readableBeforeRefresh: visibleBeforeRelease,
      requestHadCursor,
      requestWasHeld: true,
    };
  } finally {
    releaseRequest();
    await page.unroute(routePattern, handler);
  }
}

export async function measureBrowserMode({
  checkout,
  config,
  details,
  generalizedProjectPathsSupported,
  glossarySupported,
  repetition,
  runMarker,
  scenario,
  server,
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
  const browserCdp = await browser.newBrowserCDPSession();
  const processMemory = { samples: [] };
  const captureProcessMemory = async (phase) => {
    processMemory.samples.push({
      phase,
      sampledAt: new Date().toISOString(),
      ...(await sampleChromiumProcessMemory(browserCdp)),
    });
  };
  await captureProcessMemory("startup");
  await appendFile(
    server.processManifestPath,
    `${JSON.stringify({
      recordedAt: new Date().toISOString(),
      role: "Playwright Chromium process tree",
      pid: null,
      pgid: null,
      marker: runMarker,
      tracking: "PERF_RUN_ID environment; perf-sweep is authoritative",
    })}\n`,
  );
  const budgets = scenario.browserCacheBudgetsMiB ?? [0, 24];
  const orderedBudgets = budgets.map(
    (_, index) => budgets[(index + repetition) % budgets.length],
  );
  const modes = [];
  const livePages = [];
  const workingSetSessionCount =
    scenario.browserWorkingSetSessions ?? config.fixture.workingSetSessions;
  const detailsByProjectMap = new Map();
  for (const detail of details) {
    const projectDetails = detailsByProjectMap.get(detail.projectId) ?? [];
    projectDetails.push(detail);
    detailsByProjectMap.set(detail.projectId, projectDetails);
  }
  const detailsByProject = [...detailsByProjectMap.values()];
  if (
    detailsByProject.some(
      (projectDetails) => projectDetails.length < workingSetSessionCount,
    )
  ) {
    throw new Error(
      `browser working set requires ${workingSetSessionCount} sessions per project`,
    );
  }
  const workingSets = Array.from(
    { length: scenario.concurrentClients },
    (_, pageIndex) => {
      const projectDetails =
        detailsByProject[pageIndex % detailsByProject.length];
      return Array.from(
        { length: workingSetSessionCount },
        (_, offset) =>
          projectDetails[(pageIndex + offset) % projectDetails.length],
      ).map((detail) =>
        sessionBrowserTarget(server, detail, scenario.initialTurns - 1),
      );
    },
  );

  try {
    for (const cacheBudgetMiB of orderedBudgets) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      await context.addInitScript(
        ({ budget }) => {
          localStorage.setItem("yep-anywhere-glossary-hints-enabled", "true");
          localStorage.setItem(
            "yep-anywhere-session-transcript-cache-enabled",
            String(budget > 0),
          );
          localStorage.setItem(
            "yep-anywhere-session-transcript-cache-budget-mb",
            String(budget),
          );
          localStorage.setItem(
            "yep-anywhere-developer-mode",
            JSON.stringify({ remoteLogCollectionEnabled: true }),
          );
          window.__yaPerfTelemetry = [];
          window.__yaPerfMarks = [];
          window.__yaPerfNavigationStartMs = 0;
          performance.setResourceTimingBufferSize(5000);
          window.__YA_RELOAD_PERF_PROBE__ = {
            mark(name, detail) {
              window.__yaPerfMarks.push({
                atMs: performance.now(),
                detail,
                name,
              });
            },
          };
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const url = typeof input === "string" ? input : input.url;
            if (
              url.includes("/client-logs") &&
              typeof init?.body === "string"
            ) {
              try {
                const payload = JSON.parse(init.body);
                for (const entry of payload.entries ?? []) {
                  if (entry.prefix !== "[ClientTelemetry]") continue;
                  const marker = "[ClientTelemetry] ";
                  const offset = entry.message.indexOf(marker);
                  if (offset >= 0) {
                    window.__yaPerfTelemetry.push(
                      JSON.parse(entry.message.slice(offset + marker.length)),
                    );
                  }
                }
              } catch {
                // The real request remains authoritative.
              }
            }
            return originalFetch(input, init);
          };
        },
        { budget: cacheBudgetMiB },
      );

      const pages = [];
      const coldMilestones = [];
      const coldProfiles = [];
      const warmMilestones = [];
      const warmProfiles = [];
      const warmCacheTelemetry = [];
      const cacheProofs = [];
      const appendTargets = [];
      for (let index = 0; index < scenario.concurrentClients; index += 1) {
        pages.push(await context.newPage());
      }

      await Promise.all(
        pages.map(async (page, index) => {
          const workingSet = workingSets[index];
          for (
            let targetIndex = 0;
            targetIndex < workingSet.length;
            targetIndex += 1
          ) {
            const target = workingSet[targetIndex];
            const started = performance.now();
            if (targetIndex === 0) {
              await page.goto(target.url, { waitUntil: "domcontentloaded" });
            } else {
              await navigateProfiledSpa(page, target.url);
            }
            const milestones = await waitForFinalDisplay(page, target, {
              glossarySupported,
              projectPathsSupported: generalizedProjectPathsSupported,
              started,
              timeoutMs: config.server.requestTimeoutMs,
            });
            coldMilestones.push(milestones);
            coldProfiles.push(
              await collectClientNavigationProfile(
                page,
                target,
                milestones,
                config.server.requestTimeoutMs,
              ),
            );
          }

          await navigateSpa(page, `${server.baseUrl}/projects`);
          await page.waitForFunction(
            () => !document.querySelector(".message-list"),
            undefined,
            { timeout: config.server.requestTimeoutMs },
          );
          const cacheTelemetry = await clientTelemetry(page);
          warmCacheTelemetry.push(cacheTelemetry);
          const expectedWarmEntries =
            cacheBudgetMiB === 0 ? 0 : workingSet.length;
          assertCount(
            cacheTelemetry.transcriptMemory.warmCacheEntryCount,
            expectedWarmEntries,
            `${cacheBudgetMiB} MiB browser working-set cache entries`,
          );
          if (cacheBudgetMiB === 0) {
            assertCount(
              cacheTelemetry.transcriptMemory.warmCacheBytes,
              0,
              "disabled browser transcript-cache warm bytes",
            );
          } else {
            if (cacheTelemetry.transcriptMemory.warmCacheBytes < 1) {
              throw new Error(
                `browser transcript cache ${cacheBudgetMiB} MiB retained no bytes`,
              );
            }
            if (
              cacheTelemetry.transcriptMemory.warmCacheBytes >
              cacheBudgetMiB * 1024 * 1024
            ) {
              throw new Error(
                `browser transcript cache exceeded ${cacheBudgetMiB} MiB budget`,
              );
            }
          }

          for (const target of workingSet) {
            const started = performance.now();
            await navigateProfiledSpa(page, target.url);
            const milestones = await waitForFinalDisplay(page, target, {
              glossarySupported,
              projectPathsSupported: generalizedProjectPathsSupported,
              started,
              timeoutMs: config.server.requestTimeoutMs,
            });
            warmMilestones.push(milestones);
            warmProfiles.push(
              await collectClientNavigationProfile(
                page,
                target,
                milestones,
                config.server.requestTimeoutMs,
              ),
            );
          }

          const proofTarget = workingSet[0];
          await navigateSpa(page, `${server.baseUrl}/projects`);
          await page.waitForFunction(
            () => !document.querySelector(".message-list"),
            undefined,
            { timeout: config.server.requestTimeoutMs },
          );
          cacheProofs.push(
            await runCacheRefreshProof({
              cacheBudgetMiB,
              config,
              glossarySupported,
              page,
              projectPathsSupported: generalizedProjectPathsSupported,
              target: proofTarget,
            }),
          );
          appendTargets[index] = proofTarget;
        }),
      );

      const telemetryDeadline = performance.now() + 17_000;
      let yaTelemetry = [];
      while (performance.now() < telemetryDeadline) {
        yaTelemetry = (
          await Promise.all(
            pages.map((page) =>
              page.evaluate(() => window.__yaPerfTelemetry ?? []),
            ),
          )
        )
          .flat()
          .filter((entry) => entry.path?.includes("/sessions/"));
        if (yaTelemetry.length >= pages.length) break;
        await wait(250);
      }
      const directTelemetry = await Promise.all(pages.map(clientTelemetry));
      await captureProcessMemory(`cache-${cacheBudgetMiB}-loaded`);
      const milestoneSummary = (samples, field) =>
        summarize(
          samples
            .map((sample) => sample[field])
            .filter((value) => typeof value === "number"),
        );
      modes.push({
        cacheBudgetMiB,
        correctness: {
          cacheProofs,
          glossaryHintsRendered: glossarySupported,
          projectPathsRendered: generalizedProjectPathsSupported,
          workingSetSessions: workingSetSessionCount,
        },
        latency: {
          coldTail: milestoneSummary(coldMilestones, "readableTailMs"),
          coldGlossaryHighlight: milestoneSummary(
            coldMilestones,
            "glossaryHighlightMs",
          ),
          coldProjectPathHighlight: milestoneSummary(
            coldMilestones,
            "projectPathHighlightMs",
          ),
          coldFinalHighlight: milestoneSummary(
            coldMilestones,
            "finalHighlightMs",
          ),
          warmTail: milestoneSummary(warmMilestones, "readableTailMs"),
          warmGlossaryHighlight: milestoneSummary(
            warmMilestones,
            "glossaryHighlightMs",
          ),
          warmProjectPathHighlight: milestoneSummary(
            warmMilestones,
            "projectPathHighlightMs",
          ),
          warmFinalHighlight: milestoneSummary(
            warmMilestones,
            "finalHighlightMs",
          ),
        },
        profiles: {
          coldNavigation: summarizeClientNavigationProfiles(coldProfiles),
          warmNavigation: summarizeClientNavigationProfiles(warmProfiles),
        },
        telemetry: directTelemetry,
        warmCacheTelemetry,
        yaTelemetry,
        liveMilestones: [],
        liveProfiles: [],
      });
      livePages.push({
        appendTargets,
        context,
        mode: modes.at(-1),
        pages,
      });
    }

    return {
      modes,
      livePages,
      processMemory,
      async prepareAppend() {
        await Promise.all(
          livePages.flatMap(({ appendTargets, pages }) =>
            pages.map((page, index) =>
              prepareClientAppendProfile(
                page,
                sessionBrowserTarget(
                  server,
                  appendTargets[index].detail,
                  scenario.initialTurns + scenario.newTurns - 1,
                ),
                {
                  glossarySupported,
                  projectPathsSupported: generalizedProjectPathsSupported,
                },
              ),
            ),
          ),
        );
      },
      async observeAppend() {
        const started = performance.now();
        await Promise.all(
          livePages.flatMap(({ appendTargets, mode, pages }) =>
            pages.map(async (page, index) => {
              const target = sessionBrowserTarget(
                server,
                appendTargets[index].detail,
                scenario.initialTurns + scenario.newTurns - 1,
              );
              const milestones = await waitForFinalDisplay(page, target, {
                glossarySupported,
                preparedAppendObservation: true,
                projectPathsSupported: generalizedProjectPathsSupported,
                started,
                timeoutMs: config.server.requestTimeoutMs,
              });
              mode.liveMilestones.push(milestones);
              mode.liveProfiles.push(
                await collectClientAppendProfile(page, milestones),
              );
            }),
          ),
        );
        const milestoneSummary = (samples, field) =>
          summarize(
            samples
              .map((sample) => sample[field])
              .filter((value) => typeof value === "number"),
          );
        for (const mode of modes) {
          mode.latency.appendedLiveTail = milestoneSummary(
            mode.liveMilestones,
            "readableTailMs",
          );
          mode.latency.appendedLiveGlossaryHighlight = milestoneSummary(
            mode.liveMilestones,
            "glossaryHighlightMs",
          );
          mode.latency.appendedLiveProjectPathHighlight = milestoneSummary(
            mode.liveMilestones,
            "projectPathHighlightMs",
          );
          mode.latency.appendedLiveFinalHighlight = milestoneSummary(
            mode.liveMilestones,
            "finalHighlightMs",
          );
          mode.profiles.append = summarizeClientAppendProfiles(
            mode.liveProfiles,
          );
          delete mode.liveMilestones;
          delete mode.liveProfiles;
        }
        await captureProcessMemory("appended");
      },
      async close() {
        await Promise.all(livePages.map(({ context }) => context.close()));
        await browserCdp.detach();
        await browser.close();
      },
    };
  } catch (error) {
    await Promise.all(livePages.map(({ context }) => context.close()));
    await browserCdp.detach();
    await browser.close();
    throw error;
  }
}
