import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import process from "node:process";

const MIB = 1024 * 1024;
const CAPACITY_MEMORY_BUCKET_BYTES = 256 * MIB;

async function readOptional(file) {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EACCES") return null;
    throw error;
  }
}

function round(value, digits = 3) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

export function parseCpuSet(value) {
  if (!value) return null;
  let count = 0;
  for (const segment of value.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(segment.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (end < start) return null;
    count += end - start + 1;
  }
  return count || null;
}

export function parseCpuMax(value) {
  if (!value) return null;
  const [quota, period] = value.split(/\s+/);
  if (quota === "max") return null;
  const quotaValue = Number(quota);
  const periodValue = Number(period);
  if (!(quotaValue > 0) || !(periodValue > 0)) return null;
  return round(quotaValue / periodValue);
}

function parseByteLimit(value) {
  if (!value || value === "max") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseByteCount(value) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseMeminfo(value) {
  const fields = {};
  for (const line of value?.split("\n") ?? []) {
    const match = /^([^:]+):\s+(\d+)\s+kB$/.exec(line);
    if (match) fields[match[1]] = Number(match[2]) * 1024;
  }
  return fields;
}

function parseCpuCounters(value) {
  const fields = value?.split("\n")[0]?.trim().split(/\s+/) ?? [];
  if (fields[0] !== "cpu") return null;
  const counters = fields.slice(1).map(Number);
  if (
    counters.length < 5 ||
    counters.some((counter) => !Number.isFinite(counter))
  ) {
    return null;
  }
  return {
    idle: counters[3] + (counters[4] ?? 0),
    total: counters.reduce((sum, counter) => sum + counter, 0),
  };
}

function parsePressure(value) {
  if (!value) return null;
  const result = {};
  for (const line of value.split("\n")) {
    const [kind, ...fields] = line.trim().split(/\s+/);
    if (!kind) continue;
    result[kind] = Object.fromEntries(
      fields.map((field) => {
        const [name, rawValue] = field.split("=");
        return [name, Number(rawValue)];
      }),
    );
  }
  return Object.keys(result).length > 0 ? result : null;
}

function capacityMemoryBucket(bytes) {
  return (
    Math.max(1, Math.round(bytes / CAPACITY_MEMORY_BUCKET_BYTES)) *
    CAPACITY_MEMORY_BUCKET_BYTES
  );
}

function minimum(values) {
  return Math.min(...values.filter((value) => value !== null));
}

function ciIdentity() {
  const provider =
    process.env.GITHUB_ACTIONS === "true"
      ? "github-actions"
      : process.env.CI
        ? "ci"
        : "local";
  return {
    provider,
    runnerOs: process.env.RUNNER_OS ?? null,
    runnerArch: process.env.RUNNER_ARCH ?? null,
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
  };
}

export async function readHostCapacity() {
  const cpus = os.cpus();
  const cpuModels = [...new Set(cpus.map((cpu) => cpu.model.trim()))].sort();
  const [cpuMax, cpuset, memoryMax] = await Promise.all([
    readOptional("/sys/fs/cgroup/cpu.max"),
    readOptional("/sys/fs/cgroup/cpuset.cpus.effective"),
    readOptional("/sys/fs/cgroup/memory.max"),
  ]);
  const hostLogicalCpuCount = cpus.length;
  const affinityLogicalCpuCount =
    os.availableParallelism?.() ?? hostLogicalCpuCount;
  const cgroupCpuQuota = parseCpuMax(cpuMax);
  const cpusetLogicalCpuCount = parseCpuSet(cpuset);
  const effectiveLogicalCpuCount = minimum([
    hostLogicalCpuCount,
    affinityLogicalCpuCount,
    cgroupCpuQuota,
    cpusetLogicalCpuCount,
  ]);
  const hostTotalMemoryBytes = os.totalmem();
  const cgroupMemoryLimitBytes = parseByteLimit(memoryMax);
  const effectiveMemoryLimitBytes = Math.min(
    hostTotalMemoryBytes,
    cgroupMemoryLimitBytes ?? hostTotalMemoryBytes,
  );
  const keyFields = {
    platform: os.platform(),
    architecture: os.arch(),
    cpuModels,
    hostLogicalCpuCount,
    affinityLogicalCpuCount,
    cgroupCpuQuota,
    cpusetLogicalCpuCount,
    effectiveLogicalCpuCount,
    hostMemoryBucketBytes: capacityMemoryBucket(hostTotalMemoryBytes),
    effectiveMemoryBucketBytes: capacityMemoryBucket(effectiveMemoryLimitBytes),
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(keyFields))
    .digest("hex")
    .slice(0, 16);
  const capacityKey =
    `host-v1-${keyFields.platform}-${keyFields.architecture}-` +
    `${effectiveLogicalCpuCount}cpu-` +
    `${Math.round(keyFields.effectiveMemoryBucketBytes / MIB)}mib-${digest}`;
  return {
    capacityKey,
    keyFields,
    cpu: {
      models: cpuModels,
      hostLogicalCpuCount,
      affinityLogicalCpuCount,
      cgroupQuota: cgroupCpuQuota,
      cpusetLogicalCpuCount,
      effectiveLogicalCpuCount,
    },
    memory: {
      hostTotalBytes: hostTotalMemoryBytes,
      cgroupLimitBytes: cgroupMemoryLimitBytes,
      effectiveLimitBytes: effectiveMemoryLimitBytes,
    },
    platform: {
      name: os.platform(),
      release: os.release(),
      architecture: os.arch(),
    },
    runtime: {
      node: process.version,
      v8: process.versions.v8,
    },
    ci: ciIdentity(),
  };
}

export async function readHostSample(capacity) {
  const [meminfoRaw, memoryCurrent, procStat, cpuPressure, memoryPressure] =
    await Promise.all([
      readOptional("/proc/meminfo"),
      readOptional("/sys/fs/cgroup/memory.current"),
      readOptional("/proc/stat"),
      readOptional("/proc/pressure/cpu"),
      readOptional("/proc/pressure/memory"),
    ]);
  const meminfo = parseMeminfo(meminfoRaw);
  const cgroupMemoryCurrentBytes = parseByteCount(memoryCurrent);
  const hostAvailableMemoryBytes = meminfo.MemAvailable ?? os.freemem();
  const cgroupAvailableMemoryBytes =
    capacity.memory.cgroupLimitBytes !== null &&
    cgroupMemoryCurrentBytes !== null
      ? Math.max(0, capacity.memory.cgroupLimitBytes - cgroupMemoryCurrentBytes)
      : null;
  return {
    observedAt: new Date().toISOString(),
    loadAverage: os.loadavg().map((value) => round(value)),
    cpuCounters: parseCpuCounters(procStat),
    memory: {
      hostAvailableBytes: hostAvailableMemoryBytes,
      cgroupCurrentBytes: cgroupMemoryCurrentBytes,
      cgroupAvailableBytes: cgroupAvailableMemoryBytes,
      effectiveAvailableBytes: Math.min(
        hostAvailableMemoryBytes,
        cgroupAvailableMemoryBytes ?? hostAvailableMemoryBytes,
      ),
      swapTotalBytes: meminfo.SwapTotal ?? null,
      swapFreeBytes: meminfo.SwapFree ?? null,
    },
    pressure: {
      cpu: parsePressure(cpuPressure),
      memory: parsePressure(memoryPressure),
    },
  };
}

export function summarizeHostWindow(capacity, start, end) {
  const totalDelta =
    start.cpuCounters && end.cpuCounters
      ? end.cpuCounters.total - start.cpuCounters.total
      : 0;
  const idleDelta =
    start.cpuCounters && end.cpuCounters
      ? end.cpuCounters.idle - start.cpuCounters.idle
      : 0;
  const cpuBusyFraction =
    totalDelta > 0 ? round((totalDelta - idleDelta) / totalDelta) : null;
  const effectiveCpuCount = capacity.cpu.effectiveLogicalCpuCount;
  return {
    durationMs: Math.max(
      0,
      Date.parse(end.observedAt) - Date.parse(start.observedAt),
    ),
    cpuBusyFraction,
    maximumLoadPerEffectiveCpu: round(
      Math.max(start.loadAverage[0], end.loadAverage[0]) / effectiveCpuCount,
    ),
    minimumEffectiveAvailableMemoryBytes: Math.min(
      start.memory.effectiveAvailableBytes,
      end.memory.effectiveAvailableBytes,
    ),
    swapUsedBytesAtStart:
      start.memory.swapTotalBytes === null ||
      start.memory.swapFreeBytes === null
        ? null
        : start.memory.swapTotalBytes - start.memory.swapFreeBytes,
    swapUsedBytesAtEnd:
      end.memory.swapTotalBytes === null || end.memory.swapFreeBytes === null
        ? null
        : end.memory.swapTotalBytes - end.memory.swapFreeBytes,
  };
}

export function assessHostEligibility(capacity, baseline, policy) {
  const minimumAvailableBytes = policy.minimumEffectiveAvailableMemoryMiB * MIB;
  const checks = [
    {
      metric: "effectiveLogicalCpuCount",
      actual: capacity.cpu.effectiveLogicalCpuCount,
      minimum: policy.minimumEffectiveLogicalCpuCount,
      pass:
        capacity.cpu.effectiveLogicalCpuCount >=
        policy.minimumEffectiveLogicalCpuCount,
    },
    {
      metric: "baselineCpuBusyFraction",
      actual: baseline.cpuBusyFraction,
      maximum: policy.maximumBaselineCpuBusyFraction,
      pass:
        baseline.cpuBusyFraction !== null &&
        baseline.cpuBusyFraction <= policy.maximumBaselineCpuBusyFraction,
    },
    {
      metric: "baselineIdleLogicalCpuCount",
      actual:
        baseline.cpuBusyFraction === null
          ? null
          : round(
              capacity.cpu.effectiveLogicalCpuCount *
                (1 - baseline.cpuBusyFraction),
            ),
      minimum: policy.minimumIdleLogicalCpuCount,
      pass:
        baseline.cpuBusyFraction !== null &&
        capacity.cpu.effectiveLogicalCpuCount *
          (1 - baseline.cpuBusyFraction) >=
          policy.minimumIdleLogicalCpuCount,
    },
    {
      metric: "baselineLoadPerEffectiveCpu",
      actual: baseline.maximumLoadPerEffectiveCpu,
      maximum: policy.maximumBaselineLoadPerEffectiveCpu,
      pass:
        baseline.maximumLoadPerEffectiveCpu <=
        policy.maximumBaselineLoadPerEffectiveCpu,
    },
    {
      metric: "minimumEffectiveAvailableMemoryBytes",
      actual: baseline.minimumEffectiveAvailableMemoryBytes,
      minimum: minimumAvailableBytes,
      pass:
        baseline.minimumEffectiveAvailableMemoryBytes >= minimumAvailableBytes,
    },
    {
      metric: "baselineSwapGrowthBytes",
      actual:
        baseline.swapUsedBytesAtStart === null ||
        baseline.swapUsedBytesAtEnd === null
          ? null
          : baseline.swapUsedBytesAtEnd - baseline.swapUsedBytesAtStart,
      maximum: policy.maximumBaselineSwapGrowthMiB * MIB,
      pass:
        baseline.swapUsedBytesAtStart !== null &&
        baseline.swapUsedBytesAtEnd !== null &&
        baseline.swapUsedBytesAtEnd - baseline.swapUsedBytesAtStart <=
          policy.maximumBaselineSwapGrowthMiB * MIB,
    },
  ];
  return {
    checks,
    pass: checks.every((check) => check.pass),
    grade: checks.every((check) => check.pass) ? "ratchet" : "diagnostic",
  };
}
