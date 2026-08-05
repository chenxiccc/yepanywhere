import { performance } from "node:perf_hooks";
import {
  HeartbeatCandidateRegistry,
  type HeartbeatCandidateProject,
  type HeartbeatCandidateResolution,
} from "../src/services/HeartbeatCandidateRegistry.js";

const PROJECTS = 10_000;
const TICKS = 20;
const TRANSCRIPT_MESSAGES = 20_000;
const SESSION_ID = "heartbeat-session";
const HOME_PROJECT = "p6000";
const UPDATED_AT = "2026-08-01T00:00:00.000Z";

const projects: HeartbeatCandidateProject[] = Array.from(
  { length: PROJECTS },
  (_, index) => ({ id: `p${index}`, path: `/projects/p${index}` }),
);

/**
 * Stand-in for loading and normalizing a transcript to inspect its tail. The
 * point is that the current path pays this on every 30-second tick.
 */
function readTranscriptTail(): boolean {
  let checksum = 0;
  for (let index = 0; index < TRANSCRIPT_MESSAGES; index += 1) {
    const text = `message-${index}-tool_use-${index % 7}`;
    for (let position = 0; position < text.length; position += 1) {
      checksum = (Math.imul(checksum, 31) + text.charCodeAt(position)) | 0;
    }
  }
  return checksum !== Number.MIN_SAFE_INTEGER;
}

function resolveIn(
  project: HeartbeatCandidateProject,
  onTailRead: () => void = () => {},
): HeartbeatCandidateResolution | null {
  // Every project probe costs work; only the home project matches.
  if (project.id !== HOME_PROJECT) return null;
  return {
    projectId: project.id,
    projectPath: project.path,
    provider: "codex",
    updatedAt: UPDATED_AT,
    sourceVersion: `codex\0${UPDATED_AT}`,
    readPendingToolCall: async () => {
      onTailRead();
      return readTranscriptTail();
    },
  };
}

interface Measurement {
  durationMs: number;
  projectListings: number;
  projectProbes: number;
  transcriptReads: number;
  /** Cost of every tick after the first, which is what recurs forever. */
  steadyDurationMs: number;
  steadyProjectProbes: number;
}

/** Today's shape: list every project, search it, reload the transcript. */
async function measureFleetSearch(): Promise<Measurement> {
  let projectListings = 0;
  let projectProbes = 0;
  let transcriptReads = 0;
  const startedAt = performance.now();
  let steadyStartedAt = startedAt;
  let steadyProbesFrom = 0;
  for (let tick = 0; tick < TICKS; tick += 1) {
    if (tick === 1) {
      steadyStartedAt = performance.now();
      steadyProbesFrom = projectProbes;
    }
    projectListings += 1;
    for (const project of projects) {
      projectProbes += 1;
      if (!resolveIn(project)) continue;
      transcriptReads += 1;
      readTranscriptTail();
      break;
    }
  }
  return {
    durationMs: performance.now() - startedAt,
    steadyDurationMs: performance.now() - steadyStartedAt,
    steadyProjectProbes: projectProbes - steadyProbesFrom,
    projectListings,
    projectProbes,
    transcriptReads,
  };
}

async function measureRegistry(): Promise<Measurement> {
  let projectListings = 0;
  let projectProbes = 0;
  let transcriptReads = 0;
  const registry = new HeartbeatCandidateRegistry({
    listEligible: () => [[SESSION_ID, {}]],
    isOwned: () => false,
    listProjects: async () => {
      projectListings += 1;
      return projects;
    },
    getProject: async (projectId) =>
      projects.find((project) => project.id === projectId),
    resolve: async (project) => {
      projectProbes += 1;
      return resolveIn(project, () => {
        transcriptReads += 1;
      });
    },
  });
  const startedAt = performance.now();
  let steadyStartedAt = startedAt;
  let steadyProbesFrom = 0;
  for (let tick = 0; tick < TICKS; tick += 1) {
    if (tick === 1) {
      steadyStartedAt = performance.now();
      steadyProbesFrom = projectProbes;
    }
    const rows = await registry.getCandidates();
    if (rows.length !== 1) {
      throw new Error(`Registry produced ${rows.length} candidates`);
    }
  }
  return {
    durationMs: performance.now() - startedAt,
    steadyDurationMs: performance.now() - steadyStartedAt,
    steadyProjectProbes: projectProbes - steadyProbesFrom,
    projectListings,
    projectProbes,
    transcriptReads,
  };
}

/** The fully owned fleet must cost nothing at all. */
async function measureOwnedFleet(): Promise<Measurement> {
  let projectListings = 0;
  let projectProbes = 0;
  const registry = new HeartbeatCandidateRegistry({
    listEligible: () => [[SESSION_ID, {}]],
    isOwned: () => true,
    listProjects: async () => {
      projectListings += 1;
      return projects;
    },
    getProject: async (projectId) =>
      projects.find((project) => project.id === projectId),
    resolve: async (project) => {
      projectProbes += 1;
      return resolveIn(project);
    },
  });
  const startedAt = performance.now();
  for (let tick = 0; tick < TICKS; tick += 1) await registry.getCandidates();
  const durationMs = performance.now() - startedAt;
  return {
    durationMs,
    steadyDurationMs: durationMs,
    steadyProjectProbes: projectProbes,
    projectListings,
    projectProbes,
    transcriptReads: 0,
  };
}

readTranscriptTail();
const fleet = await measureFleetSearch();
const registry = await measureRegistry();
const owned = await measureOwnedFleet();

if (owned.projectListings !== 0 || owned.projectProbes !== 0) {
  throw new Error("An owned fleet still touched project storage");
}

console.log(
  [
    "HEARTBEAT_CANDIDATES:",
    `projects=${PROJECTS}`,
    `ticks=${TICKS}`,
    `fleet_project_probes=${fleet.projectProbes}`,
    `registry_project_probes=${registry.projectProbes}`,
    `avoided_project_probes_percent=${(
      100 * (1 - registry.projectProbes / fleet.projectProbes)
    ).toFixed(2)}`,
    `fleet_project_listings=${fleet.projectListings}`,
    `registry_project_listings=${registry.projectListings}`,
    `fleet_transcript_reads=${fleet.transcriptReads}`,
    `registry_transcript_reads=${registry.transcriptReads}`,
    `fleet_ms=${fleet.durationMs.toFixed(2)}`,
    `registry_ms=${registry.durationMs.toFixed(2)}`,
    `speedup=${(fleet.durationMs / registry.durationMs).toFixed(2)}x`,
    `steady_fleet_probes=${fleet.steadyProjectProbes}`,
    `steady_registry_probes=${registry.steadyProjectProbes}`,
    `steady_avoided_probes_percent=${(
      100 * (1 - registry.steadyProjectProbes / fleet.steadyProjectProbes)
    ).toFixed(2)}`,
    `steady_fleet_ms=${fleet.steadyDurationMs.toFixed(2)}`,
    `steady_registry_ms=${registry.steadyDurationMs.toFixed(2)}`,
    `steady_speedup=${(
      fleet.steadyDurationMs / registry.steadyDurationMs
    ).toFixed(2)}x`,
    `owned_fleet_project_probes=${owned.projectProbes}`,
    `owned_fleet_ms=${owned.durationMs.toFixed(2)}`,
  ].join(" "),
);
