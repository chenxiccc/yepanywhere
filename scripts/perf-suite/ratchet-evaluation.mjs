import { requirePositiveInteger } from "./core.mjs";

export function evaluateMetricTargets(aggregate, targets, universe) {
  const checks = [];
  for (const [metricPath, target] of Object.entries(targets ?? {})) {
    const actual = aggregate?.[metricPath];
    if (typeof actual !== "number") {
      throw new Error(
        `Ratchet metric is not aggregated in ${universe}: ${metricPath}`,
      );
    }
    if (typeof target.max !== "number") {
      throw new Error(`Ratchet ${universe}.${metricPath} requires numeric max`);
    }
    checks.push({
      universe,
      metric: metricPath,
      actual,
      max: target.max,
      pass: actual <= target.max,
      rationale: target.rationale ?? null,
    });
  }
  return checks;
}

export function evaluateRatchets(
  serverAggregate,
  browserAggregate,
  browserProcessAggregate,
  targets,
) {
  const checks = evaluateMetricTargets(
    serverAggregate,
    targets?.server,
    "server",
  );
  checks.push(
    ...evaluateMetricTargets(
      browserProcessAggregate,
      targets?.browserProcess,
      "browser.processes",
    ),
  );
  for (const [cacheBudgetMiB, browserTargets] of Object.entries(
    targets?.browser ?? {},
  )) {
    checks.push(
      ...evaluateMetricTargets(
        browserAggregate?.[cacheBudgetMiB],
        browserTargets,
        `browser.cache-${cacheBudgetMiB}-MiB`,
      ),
    );
  }
  return { checks, pass: checks.every((check) => check.pass) };
}

export function resolveHostEligibilityPolicy(config, driver) {
  const policy = config.hostEligibility;
  if (!policy || typeof policy !== "object") {
    throw new Error("config.hostEligibility is required");
  }
  requirePositiveInteger(
    policy.baselineSampleMs,
    "hostEligibility.baselineSampleMs",
  );
  requirePositiveInteger(
    policy.minimumEffectiveLogicalCpuCount,
    "hostEligibility.minimumEffectiveLogicalCpuCount",
  );
  const minimumIdleLogicalCpuCount =
    policy.minimumIdleLogicalCpuCount?.[driver];
  requirePositiveInteger(
    minimumIdleLogicalCpuCount,
    `hostEligibility.minimumIdleLogicalCpuCount.${driver}`,
  );
  for (const field of [
    "maximumBaselineCpuBusyFraction",
    "maximumBaselineLoadPerEffectiveCpu",
    "maximumBaselineSwapGrowthMiB",
  ]) {
    if (typeof policy[field] !== "number" || policy[field] < 0) {
      throw new Error(`hostEligibility.${field} must be nonnegative`);
    }
  }
  const minimumEffectiveAvailableMemoryMiB =
    policy.minimumEffectiveAvailableMemoryMiB?.[driver];
  requirePositiveInteger(
    minimumEffectiveAvailableMemoryMiB,
    `hostEligibility.minimumEffectiveAvailableMemoryMiB.${driver}`,
  );
  return {
    ...policy,
    minimumEffectiveAvailableMemoryMiB,
    minimumIdleLogicalCpuCount,
  };
}
