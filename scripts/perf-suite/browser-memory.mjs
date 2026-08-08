import { readFile } from "node:fs/promises";
import process from "node:process";

const KIB = 1024;

function parseKiBField(text, field) {
  if (!text) return null;
  const match = text.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m"));
  return match ? Number.parseInt(match[1], 10) * KIB : null;
}

export function parseLinuxProcessMemory(status, smapsRollup) {
  const privateCleanBytes = parseKiBField(smapsRollup, "Private_Clean");
  const privateDirtyBytes = parseKiBField(smapsRollup, "Private_Dirty");
  return {
    rssBytes: parseKiBField(status, "VmRSS"),
    pssBytes: parseKiBField(smapsRollup, "Pss"),
    privateBytes:
      privateCleanBytes === null || privateDirtyBytes === null
        ? null
        : privateCleanBytes + privateDirtyBytes,
  };
}

async function readOptional(file, readFileImpl) {
  try {
    return await readFileImpl(file, "utf8");
  } catch {
    return null;
  }
}

async function readLinuxProcessMemory(pid, readFileImpl) {
  const [status, smapsRollup] = await Promise.all([
    readOptional(`/proc/${pid}/status`, readFileImpl),
    readOptional(`/proc/${pid}/smaps_rollup`, readFileImpl),
  ]);
  return parseLinuxProcessMemory(status, smapsRollup);
}

function sumComplete(processes, field) {
  const values = processes.map((entry) => entry[field]);
  return values.every((value) => typeof value === "number")
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

function summarizeProcesses(processes) {
  return {
    processCount: processes.length,
    rssBytes: sumComplete(processes, "rssBytes"),
    pssBytes: sumComplete(processes, "pssBytes"),
    privateBytes: sumComplete(processes, "privateBytes"),
  };
}

export async function sampleChromiumProcessMemory(
  browserCdp,
  { platform = process.platform, readFileImpl = readFile } = {},
) {
  const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
  const processes = await Promise.all(
    processInfo.map(async (entry) => ({
      cpuTimeSeconds: entry.cpuTime,
      pid: entry.id,
      type: entry.type,
      ...(platform === "linux"
        ? await readLinuxProcessMemory(entry.id, readFileImpl)
        : { rssBytes: null, pssBytes: null, privateBytes: null }),
    })),
  );
  const types = [...new Set(processes.map((entry) => entry.type))].sort();

  return {
    source:
      platform === "linux" ? "cdp-system-info+linux-proc" : "cdp-system-info",
    platform,
    totals: summarizeProcesses(processes),
    byType: Object.fromEntries(
      types.map((type) => [
        type,
        summarizeProcesses(processes.filter((entry) => entry.type === type)),
      ]),
    ),
    processes,
  };
}
