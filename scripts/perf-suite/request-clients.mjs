import { requestJson } from "./process-fixture.mjs";
import { requestProfile } from "./telemetry.mjs";

export function requestTarget(target) {
  return typeof target === "string" ? { url: target } : target;
}

export async function runClientBatch(agents, targets, timeoutMs) {
  const latencies = [];
  const firstByteLatencies = [];
  const readableTextLatencies = [];
  const bytes = [];
  const profiles = [];
  const bodies = Array.from({ length: targets.length });
  let next = 0;
  await Promise.all(
    agents.map(async (agent) => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= targets.length) return;
        const target = requestTarget(targets[index]);
        const response = await requestJson(target.url, {
          agent,
          needle: target.needle,
          timeoutMs,
        });
        bodies[index] = response.body;
        latencies.push(response.ms);
        firstByteLatencies.push(response.firstByteMs);
        if (target.needle) {
          if (response.needleMs === null) {
            throw new Error(`Readable-text marker absent from ${target.url}`);
          }
          readableTextLatencies.push(response.needleMs);
        }
        bytes.push(response.bytes);
        profiles.push(requestProfile(response));
      }
    }),
  );
  return {
    bodies,
    bytes,
    firstByteLatencies,
    latencies,
    profiles,
    readableTextLatencies,
  };
}

export async function runHerd(agents, targets, timeoutMs) {
  const latencies = [];
  const firstByteLatencies = [];
  const readableTextLatencies = [];
  const bytes = [];
  const bodies = [];
  const profiles = [];
  await Promise.all(
    agents.map(async (agent) => {
      for (const rawTarget of targets) {
        const target = requestTarget(rawTarget);
        const response = await requestJson(target.url, {
          agent,
          needle: target.needle,
          timeoutMs,
        });
        latencies.push(response.ms);
        firstByteLatencies.push(response.firstByteMs);
        if (target.needle) {
          if (response.needleMs === null) {
            throw new Error(`Readable-text marker absent from ${target.url}`);
          }
          readableTextLatencies.push(response.needleMs);
        }
        bytes.push(response.bytes);
        bodies.push(response.body);
        profiles.push(requestProfile(response));
      }
    }),
  );
  return {
    bodies,
    bytes,
    firstByteLatencies,
    latencies,
    profiles,
    readableTextLatencies,
  };
}
