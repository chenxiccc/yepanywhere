import type {
  GitWorkingTreeFile,
  GitWorktreeCoverage,
  GitWorktreeDeltaEvent,
  GitWorktreeGeneration,
  GitWorktreeSnapshotEvent,
  GitWorktreeSubscriptionEvent,
} from "@yep-anywhere/shared";
import type { ClientSummarySourceKey } from "./clientSummaryStore";
import {
  createManagedStream,
  type ManagedStream,
  type SourceTransport,
} from "./transport";

export interface ProjectWorktreeSnapshot {
  loading: boolean;
  error: Error | null;
  generation: GitWorktreeGeneration | null;
  headSha: string | null;
  baseSha: string | null;
  files: readonly GitWorkingTreeFile[];
  truncated: boolean;
}

interface Lease {
  coverage: GitWorktreeCoverage;
}

const EMPTY_SNAPSHOT: ProjectWorktreeSnapshot = {
  loading: true,
  error: null,
  generation: null,
  headSha: null,
  baseSha: null,
  files: [],
  truncated: false,
};

function sameCoverage(
  left: GitWorktreeCoverage | null,
  right: GitWorktreeCoverage,
): boolean {
  return (
    left !== null &&
    left.tracked === right.tracked &&
    left.untracked === right.untracked &&
    left.ignored === right.ignored
  );
}

function unionCoverage(leases: Iterable<Lease>): GitWorktreeCoverage {
  const coverage = { tracked: false, untracked: false, ignored: false };
  for (const lease of leases) {
    coverage.tracked ||= lease.coverage.tracked;
    coverage.untracked ||= lease.coverage.untracked;
    coverage.ignored ||= lease.coverage.ignored;
  }
  return coverage;
}

function isWorktreeEvent(
  value: unknown,
): value is GitWorktreeSubscriptionEvent {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === "git-worktree-snapshot" || type === "git-worktree-delta";
}

function isNextGeneration(
  current: GitWorktreeGeneration | null,
  next: GitWorktreeGeneration,
): boolean {
  return (
    current !== null &&
    current.epoch === next.epoch &&
    next.sequence === current.sequence + 1
  );
}

class ProjectWorktreeStore {
  private readonly listeners = new Set<() => void>();
  private readonly leases = new Map<number, Lease>();
  private readonly files = new Map<string, GitWorkingTreeFile>();
  private snapshot = EMPTY_SNAPSHOT;
  private stream: ManagedStream | null = null;
  private activeCoverage: GitWorktreeCoverage | null = null;
  private nextLeaseId = 1;

  constructor(
    private readonly projectId: string,
    private readonly transport: SourceTransport,
    private readonly onEmpty: () => void,
  ) {}

  getSnapshot = (): ProjectWorktreeSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  retain(coverage: GitWorktreeCoverage): () => void {
    const leaseId = this.nextLeaseId++;
    this.leases.set(leaseId, { coverage: { ...coverage } });
    this.syncStream();
    return () => {
      if (!this.leases.delete(leaseId)) return;
      if (this.leases.size === 0) {
        this.stream?.close();
        this.stream = null;
        this.activeCoverage = null;
        this.onEmpty();
        return;
      }
      this.syncStream();
    };
  }

  private syncStream(): void {
    const coverage = unionCoverage(this.leases.values());
    if (sameCoverage(this.activeCoverage, coverage) && this.stream) return;
    this.stream?.close();
    this.activeCoverage = coverage;
    const stream = createManagedStream(
      this.transport,
      {
        subscribe: ({ transport, handlers }) =>
          transport.subscribeWorktree(this.projectId, coverage, handlers),
        onEvent: (event) => {
          if (this.stream !== stream || !isWorktreeEvent(event.data)) return;
          this.applyEvent(event.data);
        },
        onError: (error) => {
          if (this.stream !== stream) return;
          this.publish({
            ...this.snapshot,
            loading: this.snapshot.generation === null,
            error,
          });
        },
      },
      { autoStart: false },
    );
    this.stream = stream;
    if (this.snapshot.generation === null) {
      this.publish({ ...this.snapshot, loading: true, error: null });
    }
    stream.start();
  }

  private applyEvent(event: GitWorktreeSubscriptionEvent): void {
    if (event.type === "git-worktree-snapshot") {
      this.applySnapshot(event);
      return;
    }
    this.applyDelta(event);
  }

  private applySnapshot(event: GitWorktreeSnapshotEvent): void {
    this.files.clear();
    for (const file of event.files) this.files.set(file.path, file);
    this.publish({
      loading: false,
      error: null,
      generation: event.generation,
      headSha: event.headSha,
      baseSha: event.baseSha,
      files: [...this.files.values()],
      truncated: event.truncated,
    });
  }

  private applyDelta(event: GitWorktreeDeltaEvent): void {
    if (!isNextGeneration(this.snapshot.generation, event.generation)) {
      if (
        this.snapshot.generation?.epoch === event.generation.epoch &&
        event.generation.sequence <= this.snapshot.generation.sequence
      ) {
        return;
      }
      this.stream?.restart();
      return;
    }

    for (const change of event.changes) {
      if (change.changeType === "delete") {
        this.files.delete(change.path);
      } else if (change.file) {
        this.files.set(change.path, change.file);
      }
    }
    this.publish({
      loading: false,
      error: null,
      generation: event.generation,
      headSha: event.headSha,
      baseSha: event.baseSha,
      files: [...this.files.values()],
      truncated: this.snapshot.truncated,
    });
  }

  private publish(snapshot: ProjectWorktreeSnapshot): void {
    if (this.snapshot === snapshot) return;
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}

const stores = new Map<string, ProjectWorktreeStore>();

function storeKey(
  sourceKey: ClientSummarySourceKey,
  projectId: string,
): string {
  return `${sourceKey}\0${projectId}`;
}

export function getProjectWorktreeStore(
  sourceKey: ClientSummarySourceKey,
  projectId: string,
  transport: SourceTransport,
): ProjectWorktreeStore {
  const key = storeKey(sourceKey, projectId);
  const existing = stores.get(key);
  if (existing) return existing;
  let store: ProjectWorktreeStore;
  store = new ProjectWorktreeStore(projectId, transport, () => {
    if (stores.get(key) === store) stores.delete(key);
  });
  stores.set(key, store);
  return store;
}
