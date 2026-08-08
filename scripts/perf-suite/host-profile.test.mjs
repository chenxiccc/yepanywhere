import assert from "node:assert/strict";
import test from "node:test";
import {
  assessHostEligibility,
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

test("grades host eligibility from baseline capacity and headroom", () => {
  const policy = {
    maximumBaselineCpuBusyFraction: 0.8,
    maximumBaselineLoadPerEffectiveCpu: 1,
    maximumBaselineSwapGrowthMiB: 0,
    minimumEffectiveAvailableMemoryMiB: 1024,
    minimumEffectiveLogicalCpuCount: 2,
    minimumIdleLogicalCpuCount: 1,
  };
  const capacity = {
    cpu: { effectiveLogicalCpuCount: 4 },
  };
  const baseline = {
    cpuBusyFraction: 0.25,
    maximumLoadPerEffectiveCpu: 0.5,
    minimumEffectiveAvailableMemoryBytes: 2 * 1024 * 1024 * 1024,
    swapUsedBytesAtStart: 0,
    swapUsedBytesAtEnd: 0,
  };

  assert.deepEqual(assessHostEligibility(capacity, baseline, policy), {
    checks: [
      {
        metric: "effectiveLogicalCpuCount",
        actual: 4,
        minimum: 2,
        pass: true,
      },
      {
        metric: "baselineCpuBusyFraction",
        actual: 0.25,
        maximum: 0.8,
        pass: true,
      },
      {
        metric: "baselineIdleLogicalCpuCount",
        actual: 3,
        minimum: 1,
        pass: true,
      },
      {
        metric: "baselineLoadPerEffectiveCpu",
        actual: 0.5,
        maximum: 1,
        pass: true,
      },
      {
        metric: "minimumEffectiveAvailableMemoryBytes",
        actual: 2 * 1024 * 1024 * 1024,
        minimum: 1024 * 1024 * 1024,
        pass: true,
      },
      {
        metric: "baselineSwapGrowthBytes",
        actual: 0,
        maximum: 0,
        pass: true,
      },
    ],
    pass: true,
    grade: "ratchet",
  });

  baseline.cpuBusyFraction = 0.9;
  const contended = assessHostEligibility(capacity, baseline, policy);
  assert.equal(contended.pass, false);
  assert.equal(contended.grade, "diagnostic");

  baseline.cpuBusyFraction = null;
  baseline.swapUsedBytesAtStart = null;
  baseline.swapUsedBytesAtEnd = null;
  const incomplete = assessHostEligibility(capacity, baseline, policy);
  assert.equal(incomplete.pass, false);
  assert.equal(incomplete.grade, "diagnostic");
});
