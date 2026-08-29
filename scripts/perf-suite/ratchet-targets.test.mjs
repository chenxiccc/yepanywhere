import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { selectRatchetTargets } from "./ratchet-targets.mjs";

const productionRatchets = JSON.parse(
  readFileSync(new URL("./ratchets.json", import.meta.url), "utf8"),
);

const ratchets = {
  drivers: {
    server: {
      scenarios: {
        fleet: {
          server: {
            latency: { max: 100 },
            memory: { max: 200 },
          },
          browserProcess: { pss: { max: 300 } },
          browser: {},
        },
      },
    },
  },
  capacityOverrides: {
    "host-v1-test": {
      drivers: {
        server: {
          scenarios: {
            fleet: {
              server: { latency: { max: 75 } },
              browserProcess: { pss: { max: 250 } },
            },
          },
        },
      },
    },
  },
};

test("uses portable targets for an unseen capacity class", () => {
  const selected = selectRatchetTargets(ratchets, {
    capacityKey: "host-v1-new",
    driver: "server",
    scenario: "fleet",
  });

  assert.equal(selected.selection.targetKey, "portable-default");
  assert.equal(selected.selection.capacityOverrideApplied, false);
  assert.equal(selected.selection.capacityRegistered, false);
  assert.equal(selected.targets.server.latency.max, 100);
});

test("overlays exact-capacity targets without dropping portable checks", () => {
  const selected = selectRatchetTargets(ratchets, {
    capacityKey: "host-v1-test",
    driver: "server",
    scenario: "fleet",
  });

  assert.equal(selected.selection.targetKey, "capacity:host-v1-test");
  assert.equal(selected.selection.capacityOverrideApplied, true);
  assert.equal(selected.selection.capacityRegistered, true);
  assert.equal(selected.targets.server.latency.max, 75);
  assert.equal(selected.targets.server.memory.max, 200);
  assert.equal(selected.targets.browserProcess.pss.max, 250);
});

test("keys inherited portable targets to a registered capacity", () => {
  const registered = structuredClone(ratchets);
  registered.capacityOverrides["host-v1-registered"] = {
    rationale: "registration populated from a CI result",
  };
  const selected = selectRatchetTargets(registered, {
    capacityKey: "host-v1-registered",
    driver: "server",
    scenario: "fleet",
  });

  assert.equal(selected.selection.targetKey, "capacity:host-v1-registered");
  assert.equal(selected.selection.capacityRegistered, true);
  assert.equal(selected.selection.capacityOverrideApplied, false);
  assert.equal(selected.targets.server.latency.max, 100);
});

test("keeps small append owner phases independently ratcheted", () => {
  for (const driver of ["server", "browser"]) {
    for (const [scenario, routeMaximum] of [
      ["fleet-small", 5],
      ["large-session-cache", 10],
    ]) {
      const selected = selectRatchetTargets(productionRatchets, {
        capacityKey: "host-v1-unregistered-test",
        driver,
        scenario,
      });

      assert.equal(
        selected.targets.server[
          "profiles.serverDetail.appended.server.normalize.p95Ms"
        ].max,
        2,
      );
      assert.equal(
        selected.targets.server[
          "profiles.serverDetail.appended.server.route.p95Ms"
        ].max,
        routeMaximum,
      );
      if (driver === "browser") {
        for (const budget of ["0", "24"]) {
          assert.equal(
            selected.targets.browser[budget][
              "profiles.append.nonOverlappingPhases.preprocessMs.p95Ms"
            ].max,
            5,
          );
        }
      }
    }
  }
});

test("ratchets production selected-session readiness by scale", () => {
  for (const [scenario, serverMaximum, clientMaximum] of [
    ["fleet-small", 2500, 1500],
    ["large-session-cache", 3000, 2500],
  ]) {
    const selected = selectRatchetTargets(productionRatchets, {
      capacityKey: "host-v1-unregistered-test",
      driver: "built-client",
      scenario,
    });

    assert.equal(
      selected.targets.server[
        "runtime.serverStartupToSelectedSessionReadableMs"
      ].max,
      serverMaximum,
    );
    assert.equal(
      selected.targets.server["latency.builtClientColdTail.p95Ms"].max,
      clientMaximum,
    );
    assert.deepEqual(selected.targets.browser, {});
  }
});

test("ratchets specialized provider and public-share contracts", () => {
  const selected = selectRatchetTargets(productionRatchets, {
    capacityKey: "host-v1-unregistered-test",
    driver: "specialized",
    scenario: "specialized-contracts",
  });

  assert.equal(
    selected.targets.server["latency.providerFinalEnriched.p95Ms"].max,
    1500,
  );
  assert.equal(
    selected.targets.server["latency.idleOwnershipRelease.p95Ms"].max,
    4000,
  );
  assert.equal(
    selected.targets.server["latency.publicShareHerdReadableText.p95Ms"].max,
    1500,
  );
  assert.equal(selected.targets.server["responseMiB.publicShareHerd"].max, 16);
});

test("ratchets one-target append separately from fleet contention", () => {
  const selected = selectRatchetTargets(productionRatchets, {
    capacityKey: "host-v1-unregistered-test",
    driver: "browser",
    scenario: "focused-append",
  });

  assert.equal(
    selected.targets.server["latency.detailAppendedHerdTailText.p95Ms"].max,
    50,
  );
  assert.deepEqual(Object.keys(selected.targets.browser), ["0"]);
  assert.equal(
    selected.targets.browser["0"]["latency.appendedLiveFinalHighlight.p95Ms"]
      .max,
    200,
  );
  assert.equal(
    selected.targets.browser["0"][
      "profiles.append.nonOverlappingPhases.appendStartToPreprocessMs.p95Ms"
    ].max,
    100,
  );
});

test("ratchets routine retained sidebar switches at 200 ms", () => {
  const selected = selectRatchetTargets(productionRatchets, {
    capacityKey: "host-v1-unregistered-test",
    driver: "browser",
    scenario: "cached-sidebar-switch-routine",
  });

  assert.equal(
    selected.targets.browser["256"][
      "interaction.sidebarSwitchRetainedNextPaint.p95Ms"
    ].max,
    200,
  );
});

test("keeps native process memory capacity-specific", () => {
  const capacityKey = "host-v1-linux-x64-16cpu-126720mib-ecfa1407f7322835";
  const local = selectRatchetTargets(productionRatchets, {
    capacityKey,
    driver: "browser",
    scenario: "fleet-small",
  });
  const portable = selectRatchetTargets(productionRatchets, {
    capacityKey: "host-v1-unregistered-test",
    driver: "browser",
    scenario: "fleet-small",
  });

  assert.equal(
    local.targets.browserProcess["processMemory.maxTotalPssMiB"].max,
    3600,
  );
  assert.deepEqual(portable.targets.browserProcess, {});
  for (const budget of ["0", "24"]) {
    assert.equal(local.targets.browser[budget]["dom.maxCdpNodes"].max, 12000);
    assert.equal(
      portable.targets.browser[budget]["dom.maxCdpNodes"].max,
      12000,
    );
  }
});
