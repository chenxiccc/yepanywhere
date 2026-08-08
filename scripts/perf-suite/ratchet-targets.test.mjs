import assert from "node:assert/strict";
import test from "node:test";
import { selectRatchetTargets } from "./ratchet-targets.mjs";

const ratchets = {
  drivers: {
    server: {
      scenarios: {
        fleet: {
          server: {
            latency: { max: 100 },
            memory: { max: 200 },
          },
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
