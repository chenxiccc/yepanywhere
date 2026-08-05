import { SourceVersionedSingleFlight } from "../lib/sourceVersionedSingleFlight.js";
import type { ProviderName } from "@yep-anywhere/shared";

const DEFAULT_MAX_RETAINED_BYTES = 256 * 1024;
const DEFAULT_UNRESOLVED_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_MAX_UNRESOLVED_BACKOFF_MS = 60 * 60 * 1000;

/** Where a heartbeat candidate's transcript lives, once exactly located. */
export interface HeartbeatCandidateLocation {
  projectId: string;
  projectPath: string;
  provider: ProviderName;
}

/** Minimum a project must expose; callers keep their own richer project type. */
export interface HeartbeatCandidateProject {
  id: string;
  path: string;
}

export interface HeartbeatCandidateResolution
  extends HeartbeatCandidateLocation {
  updatedAt: string;
  /** Exact provider source identity that a retained tail fact is valid for. */
  sourceVersion: string;
  /**
   * Bounded read answering only "does this end in a pending tool call". It
   * belongs to the resolution so no reader outlives the lookup that made it.
   */
  readPendingToolCall(): Promise<boolean>;
}

export interface HeartbeatCandidateMetadata {
  provider?: ProviderName;
  requestedModel?: string;
  executor?: string;
}

export interface HeartbeatCandidateRow {
  sessionId: string;
  projectId: string;
  projectPath: string;
  provider: ProviderName;
  model?: string;
  executor?: string;
  updatedAt: string;
  hasPendingToolCall: true;
}

export interface HeartbeatCandidateRegistryDeps<
  TProject extends HeartbeatCandidateProject,
> {
  /** Eligible, non-archived, non-exempt metadata rows keyed by session id. */
  listEligible(): Iterable<readonly [string, HeartbeatCandidateMetadata]>;
  isOwned(sessionId: string): boolean;
  listProjects(): Promise<readonly TProject[]>;
  /** Look up one already-located project without listing the fleet. */
  getProject(projectId: string): Promise<TProject | undefined>;
  /** Locate one session inside one project without loading its transcript. */
  resolve(
    project: TProject,
    sessionId: string,
    provider: ProviderName | undefined,
  ): Promise<HeartbeatCandidateResolution | null>;
}

export interface HeartbeatCandidateRegistryOptions {
  maxRetainedBytes?: number;
  unresolvedBackoffMs?: number;
  maxUnresolvedBackoffMs?: number;
  now?: () => number;
}

export interface HeartbeatCandidateRegistryMetrics {
  generations: number;
  eligible: number;
  ownedSkipped: number;
  projectListings: number;
  projectResolutions: number;
  locationHits: number;
  locationMisses: number;
  tailReads: number;
  tailReuses: number;
  unresolvedDeferrals: number;
  unresolvedSearches: number;
  candidates: number;
  forgotten: number;
  retainedBytes: number;
}

interface TailFact {
  hasPendingToolCall: boolean;
  updatedAt: string;
}

interface UnresolvedState {
  nextAttemptAt: number;
  backoffMs: number;
}

/**
 * Answers "which unowned sessions want a heartbeat turn" from retained exact
 * locations and source-versioned tail facts. An unchanged transcript is never
 * reparsed on the interval, and a project listing happens only when some
 * candidate's location is genuinely unknown.
 */
export class HeartbeatCandidateRegistry<
  TProject extends HeartbeatCandidateProject = HeartbeatCandidateProject,
> {
  private readonly locations = new Map<string, HeartbeatCandidateLocation>();
  private readonly unresolved = new Map<string, UnresolvedState>();
  private waiting: string[] = [];
  private readonly tails: SourceVersionedSingleFlight<string, TailFact>;
  private readonly unresolvedBackoffMs: number;
  private readonly maxUnresolvedBackoffMs: number;
  private readonly now: () => number;
  private generations = 0;
  private eligible = 0;
  private ownedSkipped = 0;
  private projectListings = 0;
  private projectResolutions = 0;
  private locationHits = 0;
  private locationMisses = 0;
  private tailReads = 0;
  private tailReuses = 0;
  private unresolvedDeferrals = 0;
  private unresolvedSearches = 0;
  private candidates = 0;
  private forgotten = 0;

  constructor(
    private readonly deps: HeartbeatCandidateRegistryDeps<TProject>,
    options: HeartbeatCandidateRegistryOptions = {},
  ) {
    this.unresolvedBackoffMs = Math.max(
      0,
      options.unresolvedBackoffMs ?? DEFAULT_UNRESOLVED_BACKOFF_MS,
    );
    this.maxUnresolvedBackoffMs = Math.max(
      this.unresolvedBackoffMs,
      options.maxUnresolvedBackoffMs ?? DEFAULT_MAX_UNRESOLVED_BACKOFF_MS,
    );
    this.now = options.now ?? Date.now;
    this.tails = new SourceVersionedSingleFlight({
      maxRetainedBytes: options.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES,
      estimateBytes: (value) => 64 + value.updatedAt.length,
    });
  }

  async getCandidates(): Promise<HeartbeatCandidateRow[]> {
    this.generations += 1;
    const pending: Array<[string, HeartbeatCandidateMetadata]> = [];
    const eligibleNow = new Set<string>();
    const waiting: string[] = [];
    this.waiting = waiting;
    for (const [sessionId, metadata] of this.deps.listEligible()) {
      this.eligible += 1;
      eligibleNow.add(sessionId);
      // Ownership decides before any storage work, so a fully owned fleet
      // never lists projects.
      if (this.deps.isOwned(sessionId)) {
        this.ownedSkipped += 1;
        continue;
      }
      pending.push([sessionId, metadata]);
    }
    // Archiving, an exemption, or deletion drops a session from the eligible
    // set; its retained location and backoff must not outlive it.
    this.forgetIneligible(eligibleNow);
    if (pending.length === 0) return [];

    let projects: readonly TProject[] | null = null;
    const rows: HeartbeatCandidateRow[] = [];
    for (const [sessionId, metadata] of pending) {
      const resolution = await this.resolveCandidate(
        sessionId,
        metadata,
        async () => {
          if (!projects) {
            this.projectListings += 1;
            projects = await this.deps.listProjects();
          }
          return projects;
        },
      );
      if (!resolution) {
        waiting.push(sessionId);
        continue;
      }

      const tail = await this.readTail(sessionId, resolution);
      if (!tail.hasPendingToolCall) {
        waiting.push(sessionId);
        continue;
      }
      this.candidates += 1;
      rows.push({
        sessionId,
        projectId: resolution.projectId,
        projectPath: resolution.projectPath,
        provider: resolution.provider,
        ...(metadata.requestedModel === undefined
          ? {}
          : { model: metadata.requestedModel }),
        ...(metadata.executor === undefined
          ? {}
          : { executor: metadata.executor }),
        updatedAt: resolution.updatedAt,
        hasPendingToolCall: true,
      });
    }
    return rows;
  }

  /**
   * Eligible unowned sessions that produced no due row in the most recent
   * generation: a settled tail, an unlocated transcript, or a deferred retry.
   * The deadline scheduler still owes them a later look, because an external
   * append can make any of them due — but never sooner than one idle
   * threshold, since a pending tool call appearing now carries a transcript
   * timestamp of now.
   */
  getWaitingSessionIds(): readonly string[] {
    return this.waiting;
  }

  private forgetIneligible(eligibleNow: ReadonlySet<string>): void {
    for (const sessionId of this.locations.keys()) {
      if (eligibleNow.has(sessionId)) continue;
      this.locations.delete(sessionId);
      this.tails.invalidate(sessionId);
      this.forgotten += 1;
    }
    for (const sessionId of this.unresolved.keys()) {
      if (!eligibleNow.has(sessionId)) this.unresolved.delete(sessionId);
    }
  }

  getMetrics(): HeartbeatCandidateRegistryMetrics {
    return {
      generations: this.generations,
      eligible: this.eligible,
      ownedSkipped: this.ownedSkipped,
      projectListings: this.projectListings,
      projectResolutions: this.projectResolutions,
      locationHits: this.locationHits,
      locationMisses: this.locationMisses,
      tailReads: this.tailReads,
      tailReuses: this.tailReuses,
      unresolvedDeferrals: this.unresolvedDeferrals,
      unresolvedSearches: this.unresolvedSearches,
      candidates: this.candidates,
      forgotten: this.forgotten,
      retainedBytes: this.tails.getStats().retainedBytes,
    };
  }

  private async resolveCandidate(
    sessionId: string,
    metadata: HeartbeatCandidateMetadata,
    loadProjects: () => Promise<readonly TProject[]>,
  ): Promise<HeartbeatCandidateResolution | null> {
    const known = this.locations.get(sessionId);
    if (known) {
      const project = await this.deps.getProject(known.projectId);
      if (project) {
        this.locationHits += 1;
        this.projectResolutions += 1;
        const resolution = await this.deps.resolve(
          project,
          sessionId,
          metadata.provider ?? known.provider,
        );
        if (resolution) return resolution;
      }
      // The transcript moved or vanished; fall through to one exact search.
      this.locations.delete(sessionId);
      this.tails.invalidate(sessionId);
    } else {
      this.locationMisses += 1;
    }

    const deferred = this.unresolved.get(sessionId);
    if (deferred && this.now() < deferred.nextAttemptAt) {
      this.unresolvedDeferrals += 1;
      return null;
    }

    this.unresolvedSearches += 1;
    for (const project of await loadProjects()) {
      this.projectResolutions += 1;
      const resolution = await this.deps.resolve(
        project,
        sessionId,
        metadata.provider,
      );
      if (!resolution) continue;
      this.locations.set(sessionId, {
        projectId: resolution.projectId,
        projectPath: resolution.projectPath,
        provider: resolution.provider,
      });
      this.unresolved.delete(sessionId);
      return resolution;
    }

    // An unlocatable candidate must not re-search the fleet every tick.
    const backoffMs = deferred
      ? Math.min(deferred.backoffMs * 2, this.maxUnresolvedBackoffMs)
      : this.unresolvedBackoffMs;
    this.unresolved.set(sessionId, {
      backoffMs,
      nextAttemptAt: this.now() + backoffMs,
    });
    return null;
  }

  private async readTail(
    sessionId: string,
    resolution: HeartbeatCandidateResolution,
  ): Promise<TailFact> {
    const result = await this.tails.run({
      key: sessionId,
      sourceVersion: resolution.sourceVersion,
      compute: async () => {
        this.tailReads += 1;
        return {
          hasPendingToolCall: await resolution.readPendingToolCall(),
          updatedAt: resolution.updatedAt,
        };
      },
      isCurrent: (candidate) => candidate === resolution.sourceVersion,
    });
    if (result.status === "stale") {
      return (
        result.previous?.value ?? {
          hasPendingToolCall: false,
          updatedAt: resolution.updatedAt,
        }
      );
    }
    if (result.status !== "computed") this.tailReuses += 1;
    return result.value;
  }
}
