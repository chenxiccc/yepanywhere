import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";

const MARKER_VERSION = "1";
const MARKER_VERSION_ENV = "YEP_DEV_INSTANCE_VERSION";
const INSTANCE_ID_ENV = "YEP_DEV_INSTANCE_ID";
const BIND_KEY_ENV = "YEP_DEV_BIND_KEY";
const SOURCE_ROOT_ENV = "YEP_DEV_SOURCE_ROOT";

function normalizeBindHost(host) {
  const normalized = host?.trim().toLowerCase();
  if (
    !normalized ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  ) {
    return "loopback";
  }
  if (normalized === "0.0.0.0" || normalized === "::") {
    return "wildcard";
  }
  return normalized;
}

export function devBindKey(host, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid YA dev server port: ${port}`);
  }
  return `${normalizeBindHost(host)}:${port}`;
}

export function createDevInstanceProvenance({
  host,
  port,
  sourceRoot,
  instanceId,
} = {}) {
  const resolvedInstanceId = instanceId ?? randomBytes(16).toString("hex");
  if (!resolvedInstanceId || resolvedInstanceId.includes("\0")) {
    throw new Error("YA dev instance ID must be a non-empty environment value");
  }
  if (!sourceRoot || sourceRoot.includes("\0")) {
    throw new Error("YA dev source root must be a non-empty environment value");
  }
  const bindKey = devBindKey(host, port);
  return {
    bindKey,
    instanceId: resolvedInstanceId,
    env: {
      [MARKER_VERSION_ENV]: MARKER_VERSION,
      [INSTANCE_ID_ENV]: resolvedInstanceId,
      [BIND_KEY_ENV]: bindKey,
      [SOURCE_ROOT_ENV]: sourceRoot,
    },
  };
}

function parseEnvironment(buffer) {
  const environment = new Map();
  for (const entry of buffer.toString("utf8").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    environment.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return environment;
}

function readStartTime(procRoot, pid) {
  const stat = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  return fields[19] ?? null;
}

function numericProcessIds(procRoot) {
  try {
    return readdirSync(procRoot)
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function readMarkedProcess(procRoot, pid, expectedUid) {
  try {
    if (
      expectedUid !== undefined &&
      statSync(`${procRoot}/${pid}`).uid !== expectedUid
    ) {
      return null;
    }
    const environment = parseEnvironment(
      readFileSync(`${procRoot}/${pid}/environ`),
    );
    if (environment.get(MARKER_VERSION_ENV) !== MARKER_VERSION) return null;
    const instanceId = environment.get(INSTANCE_ID_ENV);
    const bindKey = environment.get(BIND_KEY_ENV);
    if (!instanceId || !bindKey) return null;
    const startTime = readStartTime(procRoot, pid);
    if (!startTime) return null;
    return {
      pid,
      startTime,
      instanceId,
      bindKey,
      sourceRoot: environment.get(SOURCE_ROOT_ENV) ?? null,
    };
  } catch (error) {
    if (
      error?.code === "ENOENT" ||
      error?.code === "ESRCH" ||
      error?.code === "EACCES" ||
      error?.code === "EPERM"
    ) {
      return null;
    }
    throw error;
  }
}

export function findDevInstanceProcesses({
  bindKey,
  excludeInstanceId,
  procRoot = "/proc",
  expectedUid = process.getuid?.(),
}) {
  const matches = [];
  for (const pid of numericProcessIds(procRoot)) {
    const processInfo = readMarkedProcess(procRoot, pid, expectedUid);
    if (!processInfo || processInfo.bindKey !== bindKey) continue;
    if (processInfo.instanceId === excludeInstanceId) continue;
    matches.push(processInfo);
  }
  return matches;
}

function stillMatches(procRoot, expected, expectedUid) {
  const current = readMarkedProcess(procRoot, expected.pid, expectedUid);
  return (
    current?.startTime === expected.startTime &&
    current.instanceId === expected.instanceId &&
    current.bindKey === expected.bindKey
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForNoMatches(
  options,
  timeoutMs,
  pollIntervalMs,
  sleep,
  now,
) {
  const deadline = now() + timeoutMs;
  while (true) {
    const matches = findDevInstanceProcesses(options);
    if (matches.length === 0) return [];
    const remaining = deadline - now();
    if (remaining <= 0) return matches;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

function signalMatches(
  matches,
  { procRoot, expectedUid, signalProcess, signal },
) {
  let signaled = 0;
  for (const processInfo of matches) {
    if (!stillMatches(procRoot, processInfo, expectedUid)) continue;
    try {
      signalProcess(processInfo.pid, signal);
      signaled += 1;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  return signaled;
}

export async function reapObsoleteDevInstances({
  bindKey,
  currentInstanceId,
  currentSourceRoot,
  procRoot = "/proc",
  expectedUid = process.getuid?.(),
  signalProcess = process.kill,
  logger = console,
  gracePeriodMs = 10_000,
  differentSourceGracePeriodMs = 60_000,
  forcePeriodMs = 2_000,
  pollIntervalMs = 50,
  sleep = delay,
  now = Date.now,
}) {
  const findOptions = {
    bindKey,
    excludeInstanceId: currentInstanceId,
    procRoot,
    expectedUid,
  };
  const initial = findDevInstanceProcesses(findOptions);
  if (initial.length === 0) {
    return { instances: 0, processes: 0, forced: 0 };
  }

  const instanceCount = new Set(initial.map((entry) => entry.instanceId)).size;
  const differentSourceProcesses = initial.filter(
    (entry) => entry.sourceRoot !== currentSourceRoot,
  ).length;
  logger.warn(
    `[Startup] Reaping ${initial.length} process(es) from ` +
      `${instanceCount} prior YA dev instance(s) for ${bindKey}`,
  );
  if (differentSourceProcesses > 0) {
    logger.warn(
      `[Startup] Allowing ${differentSourceProcesses} process(es) from ` +
        `different source state up to ${differentSourceGracePeriodMs}ms ` +
        "after SIGTERM before forcing them",
    );
  }
  signalMatches(initial, {
    procRoot,
    expectedUid,
    signalProcess,
    signal: "SIGTERM",
  });

  let survivors = await waitForNoMatches(
    findOptions,
    gracePeriodMs,
    pollIntervalMs,
    sleep,
    now,
  );
  if (survivors.length === 0) {
    return {
      instances: instanceCount,
      processes: initial.length,
      forced: 0,
    };
  }

  let forced = 0;
  const sameSourceSurvivors = survivors.filter(
    (entry) => entry.sourceRoot === currentSourceRoot,
  );
  if (sameSourceSurvivors.length > 0) {
    logger.warn(
      `[Startup] ${sameSourceSurvivors.length} same-source YA dev ` +
        `process(es) survived SIGTERM for ${bindKey}; forcing them`,
    );
    forced += signalMatches(sameSourceSurvivors, {
      procRoot,
      expectedUid,
      signalProcess,
      signal: "SIGKILL",
    });
  }

  const differentSourceWaitMs = Math.max(
    0,
    differentSourceGracePeriodMs - gracePeriodMs,
  );
  survivors = await waitForNoMatches(
    findOptions,
    differentSourceWaitMs,
    pollIntervalMs,
    sleep,
    now,
  );
  if (survivors.length > 0) {
    logger.warn(
      `[Startup] ${survivors.length} prior YA dev process(es) exhausted ` +
        `their shutdown grace for ${bindKey}; forcing them`,
    );
    forced += signalMatches(survivors, {
      procRoot,
      expectedUid,
      signalProcess,
      signal: "SIGKILL",
    });
  }
  const forcedSurvivors = await waitForNoMatches(
    findOptions,
    forcePeriodMs,
    pollIntervalMs,
    sleep,
    now,
  );
  if (forcedSurvivors.length > 0) {
    throw new Error(
      `${forcedSurvivors.length} prior YA dev process(es) for ` +
        `${bindKey} survived SIGKILL`,
    );
  }

  return {
    instances: instanceCount,
    processes: initial.length,
    forced,
  };
}
