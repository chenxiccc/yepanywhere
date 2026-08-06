import {
  asClientSummarySourceKey,
  createClientSummaryDirectSourceKey,
} from "../clientSummaryStore";
import type {
  ConnectionManagerConfig,
  VisibilityInterface,
} from "../connection/ConnectionManager";
import {
  WebSocketConnection,
  type WebSocketConnectionSocket,
} from "../connection/WebSocketConnection";
import {
  createSourceRuntimeRegistry,
  type YaSourceRuntime,
} from "../sourceRuntime";
import {
  LocalhostSourceTransport,
  type SourceTransport,
  type SourceTransportStatusSnapshot,
  type StreamHandlers,
  type Subscription,
  WebSocketSourceTransport,
} from "../transport";

type SourceLabel = "local" | "secondary";

export interface SourceTransportCoexistenceSmokeInput {
  secondaryWsUrl: string;
  projectId: string;
  sessionId: string;
}

export interface SourceTransportCoexistenceSmokeResult {
  versions: Record<SourceLabel, string>;
  sessionMessageText: Record<SourceLabel, string[]>;
  connectedEvents: {
    activity: Record<SourceLabel, string | undefined>;
    sessionWatch: Record<SourceLabel, string | undefined>;
  };
  sessionFailures: Record<
    SourceLabel,
    { status: number | null; message: string }
  >;
  statusBeforeStreams: Record<SourceLabel, SourceTransportStatusSnapshot>;
  statusWithStreams: Record<SourceLabel, SourceTransportStatusSnapshot>;
  statusAfterSecondaryDispose: {
    local: SourceTransportStatusSnapshot;
    secondary: SourceTransportStatusSnapshot;
  };
  visibilityRestored: Record<SourceLabel, number>;
  pingCounts: Record<SourceLabel, number>;
  localVersionAfterSecondaryDispose: string;
}

declare global {
  interface Window {
    __YA_SOURCE_TRANSPORT_COEXISTENCE_SMOKE__?: (
      input: SourceTransportCoexistenceSmokeInput,
    ) => Promise<SourceTransportCoexistenceSmokeResult>;
  }
}

class SmokeVisibilityController implements VisibilityInterface {
  private visible = true;
  private readonly listeners = new Set<(visible: boolean) => void>();

  isVisible(): boolean {
    return this.visible;
  }

  onVisibilityChange(cb: (visible: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    for (const listener of [...this.listeners]) {
      listener(visible);
    }
  }
}

interface VersionResponse {
  current: string;
}

interface SessionDetailResponse {
  messages: unknown[];
}

interface OpenedSubscription {
  close(): void;
  eventId: string | undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

function decodeOutboundMessage(
  data: string | ArrayBuffer | Uint8Array,
): { type?: unknown } | null {
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as { type?: unknown };
    } catch {
      return null;
    }
  }

  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes[0] !== 0x01) return null;
  try {
    const json = new TextDecoder().decode(bytes.slice(1));
    return JSON.parse(json) as { type?: unknown };
  } catch {
    return null;
  }
}

function createTrackedWebSocket(
  label: SourceLabel,
  url: string,
  pingCounts: Record<SourceLabel, number>,
): WebSocketConnectionSocket {
  const socket = new WebSocket(url);

  return {
    get readyState() {
      return socket.readyState;
    },
    get binaryType() {
      return socket.binaryType;
    },
    set binaryType(value: BinaryType) {
      socket.binaryType = value;
    },
    get onerror() {
      return socket.onerror as ((event: Event) => void) | null;
    },
    set onerror(handler: ((event: Event) => void) | null) {
      socket.onerror = handler as
        | ((this: WebSocket, event: Event) => void)
        | null;
    },
    get onclose() {
      return socket.onclose as ((event: CloseEvent) => void) | null;
    },
    set onclose(handler: ((event: CloseEvent) => void) | null) {
      socket.onclose = handler as
        | ((this: WebSocket, event: CloseEvent) => void)
        | null;
    },
    get onmessage() {
      return socket.onmessage as ((event: MessageEvent) => void) | null;
    },
    set onmessage(handler: ((event: MessageEvent) => void) | null) {
      socket.onmessage = handler as
        | ((this: WebSocket, event: MessageEvent) => void)
        | null;
    },
    get onopen() {
      return socket.onopen as ((event: Event) => void) | null;
    },
    set onopen(handler: ((event: Event) => void) | null) {
      socket.onopen = handler as
        | ((this: WebSocket, event: Event) => void)
        | null;
    },
    send(data: string | ArrayBuffer | Uint8Array) {
      const message = decodeOutboundMessage(data);
      if (message?.type === "ping") {
        pingCounts[label] += 1;
      }
      socket.send(data);
    },
    close(code?: number, reason?: string) {
      socket.close(code, reason);
    },
  };
}

function waitForEvent(
  label: string,
  subscribe: (handlers: StreamHandlers) => Subscription,
  expectedEventType: string,
): Promise<OpenedSubscription> {
  let subscription: Subscription | null = null;
  let settled = false;

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      return true;
    };

    timeout = setTimeout(() => {
      subscription?.close();
      if (settle()) reject(new Error(`Timed out waiting for ${label}`));
    }, 10_000);

    subscription = subscribe({
      onEvent: (eventType, eventId) => {
        if (eventType === expectedEventType) {
          if (settle()) {
            resolve({
              close: () => subscription?.close(),
              eventId,
            });
          }
        }
      },
      onError: (error) => {
        if (settle()) reject(error);
      },
      onClose: (error) => {
        if (error && settle()) reject(error);
      },
    });
  });
}

function waitForSubscriptionError(
  label: string,
  subscribe: (handlers: StreamHandlers) => Subscription,
): Promise<{ status: number | null; message: string }> {
  let subscription: Subscription | null = null;
  let settled = false;

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      subscription?.close();
      return true;
    };

    timeout = setTimeout(() => {
      if (settle()) reject(new Error(`Timed out waiting for ${label}`));
    }, 10_000);

    subscription = subscribe({
      onEvent: () => {},
      onError: (error) => {
        const maybeStatus = (error as { status?: unknown }).status;
        const status = typeof maybeStatus === "number" ? maybeStatus : null;
        if (settle()) resolve({ status, message: error.message });
      },
      onClose: (error) => {
        if (error && settle()) reject(error);
      },
    });
  });
}

function trackVisibilityRestored(transport: SourceTransport): {
  count(): number;
  unsubscribe(): void;
} {
  let count = 0;
  const unsubscribe = transport.status.subscribeVisibilityRestored?.(() => {
    count += 1;
  });
  if (!unsubscribe) {
    throw new Error(`${transport.kind} transport does not expose wake events`);
  }
  return { count: () => count, unsubscribe };
}

function assertStreamStatus(
  snapshot: SourceTransportStatusSnapshot,
  channelName: "stream-websocket" | "multiplex-websocket",
  minimumSubscriptions: number,
): void {
  if (snapshot.state !== "ready") {
    throw new Error(`${snapshot.kind} source is not ready: ${snapshot.state}`);
  }
  const channel = snapshot.channels.find((entry) => entry.name === channelName);
  if (!channel) {
    throw new Error(`${snapshot.kind} missing ${channelName} channel`);
  }
  if (channel.state !== "connected") {
    throw new Error(
      `${snapshot.kind} ${channelName} channel is not connected: ${channel.state}`,
    );
  }
  if ((channel.activeSubscriptions ?? 0) < minimumSubscriptions) {
    throw new Error(
      `${snapshot.kind} ${channelName} has ${channel.activeSubscriptions ?? 0} subscriptions`,
    );
  }
}

async function fetchVersion(runtime: YaSourceRuntime): Promise<string> {
  const response = await runtime.transport.fetch<VersionResponse>("/version");
  if (!response.current) {
    throw new Error(`Missing version response for ${runtime.sourceKey}`);
  }
  return response.current;
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, output);
    }
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStrings(item, output);
    }
  }
  return output;
}

async function fetchSessionMessageText(
  runtime: YaSourceRuntime,
  input: SourceTransportCoexistenceSmokeInput,
): Promise<string[]> {
  const response = await runtime.transport.fetch<SessionDetailResponse>(
    `/projects/${input.projectId}/sessions/${input.sessionId}?tailTurns=1`,
  );
  if (!Array.isArray(response.messages) || response.messages.length === 0) {
    throw new Error(`Missing session messages for ${runtime.sourceKey}`);
  }
  return collectStrings(response.messages);
}

async function runSourceTransportCoexistenceSmoke(
  input: SourceTransportCoexistenceSmokeInput,
): Promise<SourceTransportCoexistenceSmokeResult> {
  const visibility = new SmokeVisibilityController();
  const pingCounts: Record<SourceLabel, number> = { local: 0, secondary: 0 };
  const managerConfig: ConnectionManagerConfig = {
    visibility,
    pongTimeoutMs: 1_000,
    staleCheckIntervalMs: 60_000,
    staleThresholdMs: 60_000,
  };

  const localKey = asClientSummarySourceKey("t10:local");
  const secondaryKey = createClientSummaryDirectSourceKey(input.secondaryWsUrl);
  const registry = createSourceRuntimeRegistry();
  const subscriptions: OpenedSubscription[] = [];
  const visibilityListeners: Array<() => void> = [];

  const localTransport = new LocalhostSourceTransport({
    connectionManagerConfig: managerConfig,
    streamWebSocketFactory: (url) =>
      createTrackedWebSocket("local", url, pingCounts),
  });
  const secondaryTransport = new WebSocketSourceTransport({
    sameOriginUrls: false,
    connectionManagerConfig: managerConfig,
  });
  const secondaryConnection = new WebSocketConnection({
    createWebSocket: () =>
      createTrackedWebSocket("secondary", input.secondaryWsUrl, pingCounts),
  });

  try {
    await secondaryConnection.ensureConnected();
    secondaryTransport.attach(secondaryConnection);

    registry.registerSourceTransport(localKey, {
      kind: "custom",
      createTransport: () => localTransport,
    });
    registry.registerSourceTransport(secondaryKey, {
      kind: "custom",
      createTransport: () => secondaryTransport,
    });

    const localRuntime = registry.getOrCreateSourceRuntime(localKey);
    const secondaryRuntime = registry.getOrCreateSourceRuntime(secondaryKey);

    const statusBeforeStreams = {
      local: localTransport.status.getSnapshot(),
      secondary: secondaryTransport.status.getSnapshot(),
    };
    const versions = {
      local: await fetchVersion(localRuntime),
      secondary: await fetchVersion(secondaryRuntime),
    };
    const sessionMessageText = {
      local: await fetchSessionMessageText(localRuntime, input),
      secondary: await fetchSessionMessageText(secondaryRuntime, input),
    };

    const [
      localActivity,
      secondaryActivity,
      localSessionWatch,
      secondarySessionWatch,
    ] = await Promise.all([
      waitForEvent(
        "local activity connected",
        (handlers) => localTransport.subscribeActivity(handlers),
        "connected",
      ),
      waitForEvent(
        "secondary activity connected",
        (handlers) => secondaryTransport.subscribeActivity(handlers),
        "connected",
      ),
      waitForEvent(
        "local session-watch connected",
        (handlers) =>
          localTransport.subscribeSessionWatch(input.sessionId, handlers, {
            projectId: input.projectId,
          }),
        "connected",
      ),
      waitForEvent(
        "secondary session-watch connected",
        (handlers) =>
          secondaryTransport.subscribeSessionWatch(input.sessionId, handlers, {
            projectId: input.projectId,
          }),
        "connected",
      ),
    ]);
    subscriptions.push(
      localActivity,
      secondaryActivity,
      localSessionWatch,
      secondarySessionWatch,
    );

    const statusWithStreams = {
      local: localTransport.status.getSnapshot(),
      secondary: secondaryTransport.status.getSnapshot(),
    };
    assertStreamStatus(statusWithStreams.local, "stream-websocket", 2);
    assertStreamStatus(statusWithStreams.secondary, "multiplex-websocket", 2);

    const localWake = trackVisibilityRestored(localTransport);
    const secondaryWake = trackVisibilityRestored(secondaryTransport);
    visibilityListeners.push(localWake.unsubscribe, secondaryWake.unsubscribe);

    visibility.setVisible(false);
    await delay(0);
    visibility.setVisible(true);
    await waitFor(
      () =>
        localWake.count() >= 1 &&
        secondaryWake.count() >= 1 &&
        pingCounts.local >= 1 &&
        pingCounts.secondary >= 1,
      "Both transports did not run wake ping handling",
    );

    const secondarySessionFailure = await waitForSubscriptionError(
      "secondary session stream failure",
      (handlers) =>
        secondaryTransport.subscribeSession(input.sessionId, handlers),
    );

    const localPingsBeforeDispose = pingCounts.local;
    const secondaryPingsBeforeDispose = pingCounts.secondary;
    registry.disposeSource(secondaryKey);

    const localVersionAfterSecondaryDispose = await fetchVersion(localRuntime);

    visibility.setVisible(false);
    await delay(0);
    visibility.setVisible(true);
    await waitFor(
      () =>
        localWake.count() >= 2 && pingCounts.local > localPingsBeforeDispose,
      "Local transport did not stay live after secondary dispose",
    );
    if (pingCounts.secondary !== secondaryPingsBeforeDispose) {
      throw new Error("Disposed secondary transport still received wake pings");
    }

    const statusAfterSecondaryDispose = {
      local: localTransport.status.getSnapshot(),
      secondary: secondaryTransport.status.getSnapshot(),
    };
    const localSessionFailure = await waitForSubscriptionError(
      "local session stream failure",
      (handlers) => localTransport.subscribeSession(input.sessionId, handlers),
    );

    return {
      versions,
      sessionMessageText,
      connectedEvents: {
        activity: {
          local: localActivity.eventId,
          secondary: secondaryActivity.eventId,
        },
        sessionWatch: {
          local: localSessionWatch.eventId,
          secondary: secondarySessionWatch.eventId,
        },
      },
      sessionFailures: {
        local: localSessionFailure,
        secondary: secondarySessionFailure,
      },
      statusBeforeStreams,
      statusWithStreams,
      statusAfterSecondaryDispose,
      visibilityRestored: {
        local: localWake.count(),
        secondary: secondaryWake.count(),
      },
      pingCounts,
      localVersionAfterSecondaryDispose,
    };
  } finally {
    for (const unsubscribe of visibilityListeners.splice(0)) {
      unsubscribe();
    }
    for (const subscription of subscriptions.splice(0)) {
      try {
        subscription.close();
      } catch {
        // Best-effort cleanup for a smoke helper.
      }
    }
    registry.disposeSource(localKey);
    registry.disposeSource(secondaryKey);
  }
}

export function installSourceTransportCoexistenceSmoke(): void {
  window.__YA_SOURCE_TRANSPORT_COEXISTENCE_SMOKE__ =
    runSourceTransportCoexistenceSmoke;
}
