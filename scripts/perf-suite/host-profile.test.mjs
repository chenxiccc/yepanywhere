import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCpuMax,
  parseCpuSet,
  readHostCapacity,
  readHostSample,
  summarizeHostWindow,
} from "./host-profile.mjs";

test("parses Linux CPU-set lists and ranges", () => {
  assert.equal(parseCpuSet("0-3,8,10-11"), 7);
  assert.equal(parseCpuSet("4"), 1);
  assert.equal(parseCpuSet("3-1"), null);
  assert.equal(parseCpuSet("0-three"), null);
});

test("parses finite cgroup CPU quotas", () => {
  assert.equal(parseCpuMax("200000 100000"), 2);
  assert.equal(parseCpuMax("150000 100000"), 1.5);
  assert.equal(parseCpuMax("max 100000"), null);
  assert.equal(parseCpuMax("0 100000"), null);
});

test("profiles a stable capacity key and a bounded host window", async () => {
  const capacity = await readHostCapacity();
  const start = await readHostSample(capacity);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const end = await readHostSample(capacity);
  const window = summarizeHostWindow(capacity, start, end);

  assert.match(capacity.capacityKey, /^host-v1-[a-z0-9._-]+$/);
  assert.ok(capacity.cpu.effectiveLogicalCpuCount > 0);
  assert.ok(capacity.memory.effectiveLimitBytes > 0);
  assert.ok(start.memory.effectiveAvailableBytes >= 0);
  assert.ok(window.durationMs >= 0);
  assert.ok(window.minimumEffectiveAvailableMemoryBytes >= 0);
  assert.ok(window.maximumLoadPerEffectiveCpu >= 0);
  if (window.cpuBusyFraction !== null) {
    assert.ok(window.cpuBusyFraction >= 0 && window.cpuBusyFraction <= 1);
  }
});
