import type { StoreApi } from "zustand/vanilla";
import { api } from "../api/client";
import {
  clearClientSummarySource,
  getClientSummarySnapshotForSource,
  getClientSummaryStoreForSource,
  getCurrentClientSummarySourceKey,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY,
  reportGlobalSessionsCollectionSnapshot,
  reportInboxCollectionSnapshot,
  reportProjectCollectionSnapshot,
  reportProjectQueueCollectionSnapshot,
  reportProjectQueueGlobalCollectionSnapshot,
  reportProjectsCollectionSnapshot,
  reportProviderRuntimeStatusSnapshot,
  reportSessionCollectionCreated,
  reportSessionCollectionMetadataChanged,
  retainClientSummaryActivitySubscription,
  retainClientSummaryDraftDecorations,
  setCurrentClientSummarySourceKey,
  type ClientSummarySourceKey,
} from "./clientSummaryStore";
import type {
  SessionCreatedEvent,
  SessionMetadataChangedEvent,
} from "./activityBus";
import type {
  ClientSummaryState,
  GlobalSessionsCollectionSnapshot,
  InboxCollectionSnapshot,
  ProjectCollectionSnapshot,
  ProjectQueueCollectionSnapshot,
  ProjectQueueGlobalCollectionSnapshot,
  ProjectsCollectionSnapshot,
  ProviderRuntimeStatusSnapshot,
} from "./clientSummaryCollections";
import {
  defaultSessionDetailMemoryCache,
  type SessionDetailMemoryCache,
} from "./sessionDetail/sessionDetailStore";
import {
  LocalhostSourceTransport,
  type LocalhostSourceTransportOptions,
  SecureSourceTransport,
  type SecureSourceTransportOptions,
  type SourceTransport,
  WebSocketSourceTransport,
  type WebSocketSourceTransportOptions,
} from "./transport";

interface GetSessionBaseInput {
  projectId: string;
  sessionId: string;
}

interface GetSessionBounds {
  afterMessageId?: string;
  tailCompactions?: number;
  beforeMessageId?: string;
  tailTurns?: number;
  tailFrom?: string;
}

type RequireAtLeastOne<T> = {
  [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[keyof T];

type GetSessionBoundedInput = GetSessionBaseInput &
  RequireAtLeastOne<GetSessionBounds> & {
    fullHistory?: never;
    fullHistoryReason?: never;
  };

type GetSessionFullHistoryInput = GetSessionBaseInput & {
  fullHistory: true;
  fullHistoryReason: string;
  afterMessageId?: never;
  tailCompactions?: never;
  beforeMessageId?: never;
  /** Optional server-side selector within the explicitly authorized full scope. */
  tailTurns?: number;
  /** Optional server-side start selector within the authorized full scope. */
  tailFrom?: string;
};

export type GetSessionInput =
  | GetSessionBoundedInput
  | GetSessionFullHistoryInput;

export type GetSessionResult = Awaited<ReturnType<typeof api.getSession>>;

export interface GetSessionMetadataInput {
  projectId: string;
  sessionId: string;
}

export type GetSessionMetadataResult = Awaited<
  ReturnType<typeof api.getSessionMetadata>
>;

export interface SourceApiClient {
  getSession(input: GetSessionInput): Promise<GetSessionResult>;
  getSessionMetadata(
    input: GetSessionMetadataInput,
  ): Promise<GetSessionMetadataResult>;
}

export interface SessionDetailRuntime {
  cache: SessionDetailMemoryCache;
}

export interface SourceSummaryRuntime {
  sourceKey: ClientSummarySourceKey;
  getStore(): StoreApi<ClientSummaryState>;
  getSnapshot(): ClientSummaryState;
  clear(): void;
  retainActivitySubscription(): () => void;
  retainDraftDecorations(): () => void;
  reportGlobalSessionsCollectionSnapshot(
    input: GlobalSessionsCollectionSnapshot,
    requestStartedAt?: number,
  ): void;
  reportInboxCollectionSnapshot(
    input: InboxCollectionSnapshot,
    requestStartedAt?: number,
  ): void;
  reportProjectsCollectionSnapshot(
    input: ProjectsCollectionSnapshot,
    requestStartedAt?: number,
  ): void;
  reportProjectCollectionSnapshot(
    input: ProjectCollectionSnapshot,
    requestStartedAt?: number,
  ): void;
  reportProjectQueueCollectionSnapshot(
    input: ProjectQueueCollectionSnapshot,
    requestStartedAt?: number,
  ): void;
  reportProjectQueueGlobalCollectionSnapshot(
    input: ProjectQueueGlobalCollectionSnapshot,
    requestStartedAt?: number,
  ): void;
  reportProviderRuntimeStatusSnapshot(
    input: ProviderRuntimeStatusSnapshot,
    observedAt?: number,
  ): void;
  reportSessionCollectionCreated(
    event: SessionCreatedEvent,
    observedAt?: number,
  ): void;
  reportSessionCollectionMetadataChanged(
    event: SessionMetadataChangedEvent,
    observedAt?: number,
  ): void;
}

export interface YaSourceRuntime {
  sourceKey: ClientSummarySourceKey;
  transport: SourceTransport;
  api: SourceApiClient;
  summary: SourceSummaryRuntime;
  sessionDetails: SessionDetailRuntime;
}

export type SourceTransportRegistration =
  | {
      kind: "localhost";
      options?: LocalhostSourceTransportOptions;
    }
  | {
      kind: "websocket";
      options?: WebSocketSourceTransportOptions;
    }
  | {
      kind: "secure";
      options?: SecureSourceTransportOptions;
    }
  | {
      kind: "custom";
      createTransport: () => SourceTransport;
    };

export interface SourceRuntimeRegistry {
  registerSourceTransport(
    sourceKey: ClientSummarySourceKey,
    registration: SourceTransportRegistration,
  ): SourceTransport;
  getOrCreateSourceTransport(
    sourceKey: ClientSummarySourceKey,
  ): SourceTransport;
  getOrCreateSourceRuntime(sourceKey: ClientSummarySourceKey): YaSourceRuntime;
  getCurrentSourceRuntime(): YaSourceRuntime;
  setCurrentSourceKey(sourceKey: ClientSummarySourceKey): void;
  disposeSource(sourceKey: ClientSummarySourceKey): void;
}

export interface SourceRuntimeRegistryOptions {
  apiClient?: SourceApiClient;
  sessionDetails?: SessionDetailRuntime;
  defaultTransportRegistration?: SourceTransportRegistration;
  createSummaryRuntime?: (
    sourceKey: ClientSummarySourceKey,
    getTransport: () => SourceTransport,
  ) => SourceSummaryRuntime;
  getCurrentSourceKey?: () => ClientSummarySourceKey;
  setCurrentSourceKey?: (sourceKey: ClientSummarySourceKey) => void;
}

const LOCALHOST_TRANSPORT_REGISTRATION: SourceTransportRegistration = {
  kind: "localhost",
};
const SECURE_TRANSPORT_REGISTRATION: SourceTransportRegistration = {
  kind: "secure",
};

function createTransport(
  registration: SourceTransportRegistration,
): SourceTransport {
  switch (registration.kind) {
    case "localhost":
      return new LocalhostSourceTransport(registration.options);
    case "websocket":
      return new WebSocketSourceTransport(registration.options);
    case "secure":
      return new SecureSourceTransport(registration.options);
    case "custom":
      return registration.createTransport();
  }
}

function sameTransportRegistration(
  left: SourceTransportRegistration,
  right: SourceTransportRegistration,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "custom" && right.kind === "custom") {
    return left.createTransport === right.createTransport;
  }
  return true;
}

const currentSourceApiClient: SourceApiClient = {
  getSession: (input) => {
    const { projectId, sessionId } = input;
    if (input.fullHistory === true) {
      if (!input.fullHistoryReason.trim()) {
        throw new Error("Full-history session request requires a reason.");
      }
      return api.getSession(projectId, sessionId, undefined, {
        fullHistory: true,
        fullHistoryReason: input.fullHistoryReason,
        ...(input.tailTurns !== undefined
          ? { tailTurns: input.tailTurns }
          : {}),
        ...(input.tailFrom ? { tailFrom: input.tailFrom } : {}),
      });
    }

    const { afterMessageId, tailCompactions, beforeMessageId, tailTurns } =
      input;
    const { tailFrom } = input;
    let options:
      | {
          tailCompactions?: number;
          beforeMessageId?: string;
          tailTurns?: number;
          tailFrom?: string;
          fullHistory?: boolean;
          fullHistoryReason?: string;
        }
      | undefined;
    const hasAfterMessageId = Boolean(afterMessageId);
    const hasBounds =
      hasAfterMessageId ||
      tailCompactions !== undefined ||
      beforeMessageId !== undefined ||
      tailTurns !== undefined ||
      tailFrom !== undefined;
    if (!hasBounds) {
      throw new Error(
        "Session detail request requires bounds or explicit fullHistory.",
      );
    }
    if (
      tailCompactions !== undefined ||
      beforeMessageId !== undefined ||
      tailTurns !== undefined ||
      tailFrom !== undefined
    ) {
      options = {
        tailCompactions,
        beforeMessageId,
        tailTurns,
        tailFrom,
      };
    }
    if (!options) {
      return api.getSession(projectId, sessionId, afterMessageId);
    }
    return api.getSession(projectId, sessionId, afterMessageId, options);
  },
  getSessionMetadata: ({ projectId, sessionId }) =>
    api.getSessionMetadata(projectId, sessionId),
};

const currentSessionDetailRuntime: SessionDetailRuntime = {
  cache: defaultSessionDetailMemoryCache,
};

function createCurrentSourceSummaryRuntime(
  sourceKey: ClientSummarySourceKey,
  getTransport: () => SourceTransport,
): SourceSummaryRuntime {
  return {
    sourceKey,
    getStore: () => getClientSummaryStoreForSource(sourceKey),
    getSnapshot: () => getClientSummarySnapshotForSource(sourceKey),
    clear: () => clearClientSummarySource(sourceKey),
    retainActivitySubscription: () =>
      retainClientSummaryActivitySubscription(sourceKey, getTransport()),
    retainDraftDecorations: () =>
      retainClientSummaryDraftDecorations(sourceKey),
    reportGlobalSessionsCollectionSnapshot: (input, requestStartedAt) => {
      reportGlobalSessionsCollectionSnapshot(
        sourceKey,
        input,
        requestStartedAt,
      );
    },
    reportInboxCollectionSnapshot: (input, requestStartedAt) => {
      reportInboxCollectionSnapshot(sourceKey, input, requestStartedAt);
    },
    reportProjectsCollectionSnapshot: (input, requestStartedAt) => {
      reportProjectsCollectionSnapshot(sourceKey, input, requestStartedAt);
    },
    reportProjectCollectionSnapshot: (input, requestStartedAt) => {
      reportProjectCollectionSnapshot(sourceKey, input, requestStartedAt);
    },
    reportProjectQueueCollectionSnapshot: (input, requestStartedAt) => {
      reportProjectQueueCollectionSnapshot(sourceKey, input, requestStartedAt);
    },
    reportProjectQueueGlobalCollectionSnapshot: (input, requestStartedAt) => {
      reportProjectQueueGlobalCollectionSnapshot(
        sourceKey,
        input,
        requestStartedAt,
      );
    },
    reportProviderRuntimeStatusSnapshot: (input, observedAt) => {
      reportProviderRuntimeStatusSnapshot(sourceKey, input, observedAt);
    },
    reportSessionCollectionCreated: (event, observedAt) => {
      reportSessionCollectionCreated(sourceKey, event, observedAt);
    },
    reportSessionCollectionMetadataChanged: (event, observedAt) => {
      reportSessionCollectionMetadataChanged(sourceKey, event, observedAt);
    },
  };
}

class DefaultSourceRuntimeRegistry implements SourceRuntimeRegistry {
  private readonly runtimes = new Map<
    ClientSummarySourceKey,
    YaSourceRuntime
  >();
  private readonly transports = new Map<
    ClientSummarySourceKey,
    SourceTransport
  >();
  private readonly transportRegistrations = new Map<
    ClientSummarySourceKey,
    SourceTransportRegistration
  >();
  private readonly apiClient: SourceApiClient;
  private readonly sessionDetails: SessionDetailRuntime;
  private readonly defaultTransportRegistration: SourceTransportRegistration;
  private readonly createSummaryRuntime: (
    sourceKey: ClientSummarySourceKey,
    getTransport: () => SourceTransport,
  ) => SourceSummaryRuntime;
  private readonly readCurrentSourceKey: () => ClientSummarySourceKey;
  private readonly writeCurrentSourceKey: (
    sourceKey: ClientSummarySourceKey,
  ) => void;

  constructor(options: SourceRuntimeRegistryOptions = {}) {
    this.apiClient = options.apiClient ?? currentSourceApiClient;
    this.sessionDetails = options.sessionDetails ?? currentSessionDetailRuntime;
    this.defaultTransportRegistration =
      options.defaultTransportRegistration ?? LOCALHOST_TRANSPORT_REGISTRATION;
    this.createSummaryRuntime =
      options.createSummaryRuntime ?? createCurrentSourceSummaryRuntime;
    this.readCurrentSourceKey =
      options.getCurrentSourceKey ?? getCurrentClientSummarySourceKey;
    this.writeCurrentSourceKey =
      options.setCurrentSourceKey ?? setCurrentClientSummarySourceKey;
  }

  registerSourceTransport(
    sourceKey: ClientSummarySourceKey,
    registration: SourceTransportRegistration,
  ): SourceTransport {
    const previousRegistration = this.resolveTransportRegistration(sourceKey);
    this.transportRegistrations.set(sourceKey, registration);

    const existingTransport = this.transports.get(sourceKey);
    if (!existingTransport) {
      return this.createAndStoreTransport(sourceKey, registration);
    }
    if (sameTransportRegistration(previousRegistration, registration)) {
      return existingTransport;
    }

    existingTransport.dispose();
    const transport = this.createAndStoreTransport(sourceKey, registration);
    const runtime = this.runtimes.get(sourceKey);
    if (runtime) {
      runtime.transport = transport;
    }
    return transport;
  }

  getOrCreateSourceTransport(
    sourceKey: ClientSummarySourceKey,
  ): SourceTransport {
    const existingTransport = this.transports.get(sourceKey);
    if (existingTransport) return existingTransport;
    return this.createAndStoreTransport(
      sourceKey,
      this.resolveTransportRegistration(sourceKey),
    );
  }

  getOrCreateSourceRuntime(sourceKey: ClientSummarySourceKey): YaSourceRuntime {
    let runtime = this.runtimes.get(sourceKey);
    if (!runtime) {
      const transport = this.getOrCreateSourceTransport(sourceKey);
      const createdRuntime: YaSourceRuntime = {
        sourceKey,
        transport,
        api: this.apiClient,
        summary: null as unknown as SourceSummaryRuntime,
        sessionDetails: this.sessionDetails,
      };
      createdRuntime.summary = this.createSummaryRuntime(
        sourceKey,
        () => createdRuntime.transport,
      );
      runtime = createdRuntime;
      this.runtimes.set(sourceKey, runtime);
    }
    return runtime;
  }

  getCurrentSourceRuntime(): YaSourceRuntime {
    return this.getOrCreateSourceRuntime(this.readCurrentSourceKey());
  }

  setCurrentSourceKey(sourceKey: ClientSummarySourceKey): void {
    this.writeCurrentSourceKey(sourceKey);
  }

  disposeSource(sourceKey: ClientSummarySourceKey): void {
    this.runtimes.delete(sourceKey);
    this.transports.get(sourceKey)?.dispose();
    this.transports.delete(sourceKey);
    this.transportRegistrations.delete(sourceKey);
  }

  resetForTests(): void {
    for (const transport of this.transports.values()) {
      transport.dispose();
    }
    this.runtimes.clear();
    this.transports.clear();
    this.transportRegistrations.clear();
  }

  private resolveTransportRegistration(
    sourceKey: ClientSummarySourceKey,
  ): SourceTransportRegistration {
    const registration = this.transportRegistrations.get(sourceKey);
    if (registration) return registration;
    if (sourceKey === LOCAL_CLIENT_SUMMARY_SOURCE_KEY) {
      return LOCALHOST_TRANSPORT_REGISTRATION;
    }
    if (sourceKey === REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY) {
      return SECURE_TRANSPORT_REGISTRATION;
    }
    return this.defaultTransportRegistration;
  }

  private createAndStoreTransport(
    sourceKey: ClientSummarySourceKey,
    registration: SourceTransportRegistration,
  ): SourceTransport {
    const transport = createTransport(registration);
    this.transports.set(sourceKey, transport);
    return transport;
  }
}

export function createSourceRuntimeRegistry(
  options: SourceRuntimeRegistryOptions = {},
): SourceRuntimeRegistry {
  return new DefaultSourceRuntimeRegistry(options);
}

const defaultSourceRuntimeRegistry = new DefaultSourceRuntimeRegistry();

export function getSourceRuntimeRegistry(): SourceRuntimeRegistry {
  return defaultSourceRuntimeRegistry;
}

export function resetSourceRuntimeRegistryForTests(): void {
  defaultSourceRuntimeRegistry.resetForTests();
}

export function getOrCreateCurrentSourceRuntime(
  sourceKey: ClientSummarySourceKey,
): YaSourceRuntime {
  return defaultSourceRuntimeRegistry.getOrCreateSourceRuntime(sourceKey);
}
