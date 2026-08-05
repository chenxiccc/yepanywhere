/**
 * Inbox reads with and without a shared collection walk.
 *
 * `GET /api/inbox` lists every project and every project's sessions. The Inbox
 * is app-shell mounted, so a herd of tabs reconnecting used to run a herd of
 * independent walks. Both arms drive the real route; retention is per route
 * instance, so arm A — a fresh instance per read — is exactly the previous
 * shape.
 *
 * Deliberately simple: fixed project, session, tab, and event counts, not a
 * model of any particular install.
 */
import type { UrlProjectId } from "@yep-anywhere/shared";
import { createInboxRoutes, type InboxDeps } from "../src/routes/inbox.js";
import type { ISessionReader } from "../src/sessions/types.js";
import type { Project, SessionSummary } from "../src/supervisor/types.js";
import { EventBus } from "../src/watcher/EventBus.js";

const PROJECTS = 50;
const SESSIONS_PER_PROJECT = 5;
const TABS = 10;
/** Reads per tab: the initial load plus one per bus event below. */
const ROW_EVENTS = 1;

interface Counters {
  projectListings: number;
  sessionListings: number;
}

function buildProjects(): Project[] {
  return Array.from({ length: PROJECTS }, (_, index) => ({
    id: `p${index}` as UrlProjectId,
    path: `/projects/p${index}`,
    name: `p${index}`,
    sessionCount: SESSIONS_PER_PROJECT,
    sessionDir: `/sessions/p${index}`,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude" as const,
  }));
}

function buildSessions(project: Project): SessionSummary[] {
  return Array.from({ length: SESSIONS_PER_PROJECT }, (_, index) => ({
    id: `${project.id}-s${index}`,
    projectId: project.id,
    title: `Session ${index}`,
    fullTitle: `Session ${index}`,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 3,
    ownership: { owner: "none" as const },
    provider: "claude" as const,
  }));
}

function buildDeps(counters: Counters, eventBus?: EventBus): InboxDeps {
  const projects = buildProjects();
  return {
    scanner: {
      listProjects: async () => {
        counters.projectListings += 1;
        return projects;
      },
    } as unknown as InboxDeps["scanner"],
    readerFactory: (project: Project) =>
      ({
        listSessions: async () => {
          counters.sessionListings += 1;
          return buildSessions(project);
        },
        getAgentMappings: async () => [],
        getAgentSession: async () => null,
      }) as unknown as ISessionReader,
    eventBus,
  };
}

/** Arm A — no retention, which is one fresh walk per read. */
async function measureIndependent(): Promise<Counters & { ms: number }> {
  const counters: Counters = { projectListings: 0, sessionListings: 0 };
  const started = performance.now();

  for (let round = 0; round <= ROW_EVENTS; round += 1) {
    await Promise.all(
      Array.from({ length: TABS }, () =>
        createInboxRoutes(buildDeps(counters)).request("/"),
      ),
    );
  }

  return { ...counters, ms: performance.now() - started };
}

/** Arm B — the real route, one instance, driven off the real event bus. */
async function measureShared(): Promise<Counters & { ms: number }> {
  const counters: Counters = { projectListings: 0, sessionListings: 0 };
  const bus = new EventBus();
  const routes = createInboxRoutes(buildDeps(counters, bus));
  const started = performance.now();

  for (let round = 0; round <= ROW_EVENTS; round += 1) {
    if (round > 0) {
      bus.emit({
        type: "session-metadata-changed",
        sessionId: "p0-s0",
        starred: true,
        timestamp: new Date().toISOString(),
      } as never);
    }
    await Promise.all(Array.from({ length: TABS }, () => routes.request("/")));
  }

  return { ...counters, ms: performance.now() - started };
}

function report(label: string, before: number, after: number): void {
  const percent = before === 0 ? 0 : ((before - after) / before) * 100;
  console.log(
    `${label}: ${before} -> ${after} ` +
      `(${percent.toFixed(2)}% avoided, ${(before / after).toFixed(2)}x)`,
  );
}

async function main(): Promise<void> {
  const reads = TABS * (ROW_EVENTS + 1);
  const independent = await measureIndependent();
  const shared = await measureShared();

  console.log(
    `${PROJECTS} projects x ${SESSIONS_PER_PROJECT} sessions, ` +
      `${TABS} tabs x ${ROW_EVENTS + 1} reads = ${reads}`,
  );
  report("project listings", independent.projectListings, shared.projectListings);
  report("session listings", independent.sessionListings, shared.sessionListings);
  console.log(
    `elapsed: ${independent.ms.toFixed(2)} ms -> ${shared.ms.toFixed(2)} ms ` +
      `(${(independent.ms / shared.ms).toFixed(2)}x)`,
  );

  // Every tab must still see every change: the gain has to come from sharing a
  // walk, never from serving a collection that moved on.
  const expected = ROW_EVENTS + 1;
  if (shared.projectListings !== expected) {
    throw new Error(
      `${shared.projectListings} walks, expected ${expected} — one per generation`,
    );
  }
  if (independent.projectListings !== reads) {
    throw new Error(
      `arm A walked ${independent.projectListings} of ${reads} reads`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
