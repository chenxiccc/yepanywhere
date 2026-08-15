import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { aggregateRuns } from "./aggregation.mjs";
import { waitWithTimeout } from "./browser-driver.mjs";
import { measureServerUsefulReadiness } from "./built-client-driver.mjs";
import { deterministicPayload, validateScenario } from "./core.mjs";
import { harnessSourceFiles } from "./process-fixture.mjs";
import {
  evaluateMetricTargets,
  evaluateRatchets,
} from "./ratchet-evaluation.mjs";
import { repetitionOwner } from "./server-driver.mjs";
import { renderedAssistantHtml } from "./specialized-driver.mjs";
import { requestProfile } from "./telemetry.mjs";

test("core validates scenario shape and creates exact-size fixture text", () => {
  const scenario = {
    projects: 1,
    sessionsPerProject: 1,
    initialTurns: 1,
    newTurns: 1,
    concurrentClients: 1,
    payloadBytes: 512,
    repetitions: 1,
    settleMs: 1,
  };
  assert.doesNotThrow(() => validateScenario(scenario, "unit"));
  assert.equal(deterministicPayload(512, "fixture").length, 512);
  assert.throws(
    () => validateScenario({ ...scenario, repetitions: 0 }, "unit"),
    /positive integer/,
  );
});

test("telemetry preserves one non-overlapping request profile", () => {
  const profile = requestProfile({
    bodyTransferMs: 5,
    firstByteMs: 20,
    headers: {
      "server-timing": [
        "ya-project;dur=1",
        "ya-read;dur=2",
        "ya-normalize;dur=1",
        "ya-route;dur=1",
        "ya-augment;dur=3",
        "ya-total;dur=10",
      ].join(","),
    },
    jsonParseMs: 1,
    ms: 30,
  });

  assert.equal(profile.available, true);
  assert.equal(profile.frameworkSerializeLoopbackMs, 10);
  assert.equal(profile.serverPhaseResidualMs, 2);
  assert.equal(profile.coverage.fraction, 1);
});

test("browser driver deadlines settle and reject independently", async () => {
  assert.equal(await waitWithTimeout(Promise.resolve("ok"), 50, "unit"), "ok");
  await assert.rejects(
    waitWithTimeout(new Promise(() => {}), 5, "unit browser wait"),
    /unit browser wait timed out/,
  );
});

test("built-client server readiness uses the selected response marker", async () => {
  const marker = "selected-tail-marker";
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ messages: [{ text: marker }, { text: "b" }] }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await measureServerUsefulReadiness({
      config: { server: { requestTimeoutMs: 1_000 } },
      expectedMessages: 2,
      server: { processStartedAtMs: performance.now() - 10 },
      target: {
        apiUrl: `http://127.0.0.1:${address.port}/detail`,
        marker,
      },
    });
    assert.equal(result.responseBytes > 0, true);
    assert.equal(result.responseNeedleMs >= 0, true);
    assert.equal(result.startupToReadableMs >= 10, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("specialized driver reads top-level and block-level enriched HTML", () => {
  assert.equal(
    renderedAssistantHtml({ message: { _html: "<p>top</p>" } }),
    "<p>top</p>",
  );
  assert.equal(
    renderedAssistantHtml({
      message: { content: [{ type: "text", _html: "<p>block</p>" }] },
    }),
    "<p>block</p>",
  );
  assert.equal(renderedAssistantHtml({ message: { content: [] } }), null);
});

test("server orchestrator selects one explicit repetition owner", () => {
  assert.equal(repetitionOwner("server"), "server-browser");
  assert.equal(repetitionOwner("browser"), "server-browser");
  assert.equal(repetitionOwner("built-client"), "built-client");
  assert.equal(repetitionOwner("specialized"), "specialized");
});

test("aggregation and ratchet evaluation keep separate universes", () => {
  const aggregate = aggregateRuns([
    { runtime: { serverStartupMs: 12 } },
    { runtime: { serverStartupMs: 18 } },
  ]);
  assert.equal(aggregate["runtime.serverStartupMs"], 12);
  assert.deepEqual(
    evaluateMetricTargets(
      aggregate,
      { "runtime.serverStartupMs": { max: 15 } },
      "server",
    ),
    [
      {
        actual: 12,
        max: 15,
        metric: "runtime.serverStartupMs",
        pass: true,
        rationale: null,
        universe: "server",
      },
    ],
  );
  assert.equal(
    evaluateRatchets(aggregate, null, null, {
      server: { "runtime.serverStartupMs": { max: 10 } },
    }).pass,
    false,
  );
});

test("harness identity covers every extracted implementation module", () => {
  const names = harnessSourceFiles().map((file) => path.basename(file));
  assert.equal(new Set(names).size, names.length);
  for (const name of [
    "aggregation.mjs",
    "browser-driver.mjs",
    "built-client-driver.mjs",
    "core.mjs",
    "process-fixture.mjs",
    "ratchet-evaluation.mjs",
    "request-clients.mjs",
    "run.mjs",
    "server-driver.mjs",
    "specialized-driver.mjs",
    "telemetry.mjs",
  ]) {
    assert.equal(names.includes(name), true, `${name} must affect identity`);
  }
});
