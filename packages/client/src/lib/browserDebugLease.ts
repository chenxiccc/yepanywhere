import { asClientSummarySourceKey } from "./clientSummaryStore";
import { executeBrowserDebugCode } from "./browserDebugEval";
import {
  getBrowserDebugPerformanceSummary,
  installBrowserDebugPerformanceInstrumentation,
  type BrowserDebugPerformanceSummary,
} from "./browserDebugPerformance";
import { ExclusiveBrowserPageLock } from "./exclusiveBrowserPageLock";
import {
  buildFrontendReloadUrl,
  FRONTEND_RELOAD_QUERY_PARAM,
} from "./frontendReload";
import { getSourceRuntimeRegistry } from "./sourceRuntime";
import { generateUUID } from "./uuid";

export const BROWSER_DEBUG_LEASE_TTL_MS = 30 * 60 * 1000;
export const BROWSER_DEBUG_PROMPT_LEAD =
  "Paste into a YA session to give full JS debugging access to this tab for 30m.";

interface BrowserDebugLeaseDescriptor {
  leaseId: string;
  controllerToken: string;
  grantUrl: string;
  sessionId: string;
  tabId: string;
  expiresAt: string;
}

interface BrowserDebugCommand {
  commandId: string;
  kind: "eval";
  code: string;
}

interface BrowserDebugEventInput {
  timestamp: number;
  kind: string;
  data?: unknown;
}

type SourceFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export interface BrowserDebugLeaseSnapshot {
  phase: "inactive" | "enabling" | "active";
  connected: boolean;
  sessionId: string | null;
  expiresAtMs: number | null;
  error: string | null;
}

type ConsoleMethod = "debug" | "error" | "info" | "log" | "warn";

const TAB_ID_STORAGE_KEY = "ya:browser-debug-tab-id";
const LEASE_STORAGE_KEY = "ya:browser-debug-active-lease-v1";
const RELOAD_INTENT_STORAGE_KEY = "ya:browser-debug-reload-intent-v1";
const LEASE_PAGE_LOCK_PREFIX = "ya:browser-debug-active-lease:";
const FLUSH_INTERVAL_MS = 1_000;
const EVENT_QUEUE_LIMIT = 500;
const SERIALIZE_DEPTH = 4;
const SERIALIZED_STRING_BUDGET = 50_000;
const SERIALIZED_ENTRY_BUDGET = 1_000;
const FLUSH_BODY_BUDGET = 220 * 1024;
const EVENT_KIND_LIMIT = 80;
const POLL_CONNECTED_GRACE_MS = 500;
const POLL_RECONNECT_RETRY_MS = 250;
const PAGE_LOCK_RELOAD_HANDOFF_MS = 500;

interface StoredBrowserDebugLease {
  version: 1;
  leaseId: string;
  controllerToken: string;
  sessionId: string;
  tabId: string;
  expiresAt: string;
  sourceKey: string;
}

interface StoredBrowserDebugReloadIntent {
  version: 1;
  leaseId: string;
  reloadToken: string;
}

function consumeBrowserDebugReloadIntent(
  persistedLease: StoredBrowserDebugLease,
): boolean {
  try {
    const rawIntent = sessionStorage.getItem(RELOAD_INTENT_STORAGE_KEY);
    sessionStorage.removeItem(RELOAD_INTENT_STORAGE_KEY);
    if (!rawIntent) return false;
    const intent = JSON.parse(
      rawIntent,
    ) as Partial<StoredBrowserDebugReloadIntent>;
    const reloadToken = new URL(window.location.href).searchParams.get(
      FRONTEND_RELOAD_QUERY_PARAM,
    );
    return (
      intent.version === 1 &&
      intent.leaseId === persistedLease.leaseId &&
      typeof intent.reloadToken === "string" &&
      intent.reloadToken.length > 0 &&
      intent.reloadToken === reloadToken
    );
  } catch {
    return false;
  }
}

function navigationAllowsLeaseRestore(
  persistedLease: StoredBrowserDebugLease,
): boolean {
  const hasReloadIntent = consumeBrowserDebugReloadIntent(persistedLease);
  const navigation = performance.getEntriesByType?.("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  return navigation?.type === "reload" || hasReloadIntent;
}

function clearStoredLease(expectedLeaseId?: string): void {
  try {
    if (expectedLeaseId) {
      const stored = readStoredLease();
      if (stored?.leaseId !== expectedLeaseId) return;
    }
    sessionStorage.removeItem(LEASE_STORAGE_KEY);
  } catch {
    // The server-side expiry still bounds a lease when storage is unavailable.
  }
}

function readStoredLease(): StoredBrowserDebugLease | null {
  try {
    const raw = sessionStorage.getItem(LEASE_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredBrowserDebugLease>;
    const strings = [
      value.leaseId,
      value.controllerToken,
      value.sessionId,
      value.tabId,
      value.expiresAt,
      value.sourceKey,
    ];
    if (
      value.version !== 1 ||
      strings.some(
        (entry) =>
          typeof entry !== "string" || entry.length === 0 || entry.length > 512,
      ) ||
      !/^[a-z0-9-]{1,128}$/iu.test(value.leaseId ?? "") ||
      !Number.isFinite(Date.parse(value.expiresAt ?? ""))
    ) {
      sessionStorage.removeItem(LEASE_STORAGE_KEY);
      return null;
    }
    if (Date.parse(value.expiresAt ?? "") <= Date.now()) {
      sessionStorage.removeItem(LEASE_STORAGE_KEY);
      return null;
    }
    return value as StoredBrowserDebugLease;
  } catch {
    try {
      sessionStorage.removeItem(LEASE_STORAGE_KEY);
    } catch {
      // Storage access itself is unavailable.
    }
    return null;
  }
}

function writeStoredLease(lease: StoredBrowserDebugLease): boolean {
  try {
    sessionStorage.setItem(LEASE_STORAGE_KEY, JSON.stringify(lease));
    return sessionStorage.getItem(LEASE_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function responseStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function leaseIsGone(error: unknown): boolean {
  const status = responseStatus(error);
  return status === 404 || status === 410;
}

interface SerializationBudget {
  remainingEntries: number;
  remainingStringChars: number;
}

function takeDiagnosticString(
  value: string,
  budget: SerializationBudget,
  localLimit = SERIALIZED_STRING_BUDGET,
): string {
  const limit = Math.max(0, Math.min(localLimit, budget.remainingStringChars));
  const taken = value.slice(0, limit);
  budget.remainingStringChars -= taken.length;
  return taken.length === value.length ? taken : `${taken}…[truncated]`;
}

function tabId(): string {
  try {
    const existing = sessionStorage.getItem(TAB_ID_STORAGE_KEY);
    if (existing) return existing;
    const created = generateUUID();
    sessionStorage.setItem(TAB_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return generateUUID();
  }
}

function serializeForDiagnostics(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  budget: SerializationBudget = {
    remainingEntries: SERIALIZED_ENTRY_BUDGET,
    remainingStringChars: SERIALIZED_STRING_BUDGET,
  },
): unknown {
  if (budget.remainingEntries <= 0) return "[entry limit]";
  budget.remainingEntries -= 1;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return takeDiagnosticString(value, budget);
  }
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "bigint") {
    return takeDiagnosticString(`${value}n`, budget);
  }
  if (typeof value === "symbol") {
    return takeDiagnosticString(String(value), budget);
  }
  if (typeof value === "function") {
    return takeDiagnosticString(
      `[Function ${value.name || "anonymous"}]`,
      budget,
    );
  }
  if (depth >= SERIALIZE_DEPTH) return "[depth limit]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) {
    return {
      name: takeDiagnosticString(value.name, budget),
      message: takeDiagnosticString(value.message, budget),
      stack:
        value.stack === undefined
          ? undefined
          : takeDiagnosticString(value.stack, budget),
      ...(value.cause === undefined
        ? {}
        : {
            cause: serializeForDiagnostics(
              value.cause,
              depth + 1,
              seen,
              budget,
            ),
          }),
    };
  }
  if (value instanceof Element) {
    return {
      element: value.tagName.toLowerCase(),
      id: value.id ? takeDiagnosticString(value.id, budget, 500) : undefined,
      classes:
        typeof value.className === "string" && value.className
          ? takeDiagnosticString(value.className, budget, 1_000)
          : undefined,
      text:
        value.textContent === null
          ? undefined
          : takeDiagnosticString(value.textContent, budget, 500),
    };
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((entry) => serializeForDiagnostics(entry, depth + 1, seen, budget));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    if (budget.remainingEntries <= 0) break;
    try {
      output[takeDiagnosticString(key, budget, 500)] = serializeForDiagnostics(
        entry,
        depth + 1,
        seen,
        budget,
      );
    } catch (error) {
      output[key] = takeDiagnosticString(
        `[unreadable: ${error instanceof Error ? error.message : String(error)}]`,
        budget,
      );
    }
  }
  return output;
}

function buildAgentPrompt(lease: BrowserDebugLeaseDescriptor): string {
  return `${BROWSER_DEBUG_PROMPT_LEAD}

Purpose: improve YA by remotely debugging this connected browser tab while it represents real user work.

Paste this instruction into any YA session launched by this YA server boot. The present session can use it only when the credential preflight below passes.

Access granted: full JavaScript evaluation in this tab, including DOM and application state inspection or mutation, console and performance events, browser storage, and same-origin requests. This access can change the tab. It is independently revocable and expires at ${lease.expiresAt}.

This grant works only from a YA-launched agent process with the current browser-debug environment. Before using it, verify eligibility without printing either value:

  test -n "\${YEP_BROWSER_DEBUG_AGENT_URL:-}" &&
    test -n "\${YEP_BROWSER_DEBUG_CALLER_TOKEN:-}"

If that preflight fails, do not inspect other processes or files to recover credentials. Report that this provider process lacks the current browser-debug handshake. A full YA wrapper/provider-host restart and a newly launched or resumed eligible session may be required; the user must then activate the tab again and paste its new grant.

Use a CLI from the same YA generation as the server. A compatible help response contains the literal usage lines \`yepanywhere browser-debug info <grant-url>\` and \`yepanywhere browser-debug snapshot <grant-url>\`. First try:

  yepanywhere browser-debug --help

Do not accept a zero exit status or generic yepanywhere help as proof of compatibility. If either required usage line is absent and the current working tree is the YA source checkout, try this source-checkout CLI and require both usage lines:

  pnpm --filter server exec tsx src/cli.ts browser-debug --help

Otherwise report a CLI/server version mismatch; do not treat it as rejection of the grant.

Grant URL (bearer secret; use it as <grant-url> below and do not print it separately):

  ${lease.grantUrl}

With the working CLI path substituted for <ya-cli>, start with YA's built-in bounded performance snapshot and event stream:

  <ya-cli> browser-debug info '<grant-url>'
  <ya-cli> browser-debug snapshot '<grant-url>'
  <ya-cli> browser-debug events '<grant-url>' --follow

The snapshot aggregates recent and lease-total main-thread delays, page size, stream cadence, and render/update phases without changing this tab. Use custom evaluation only to investigate a specific signal, for example:

  <ya-cli> browser-debug eval '<grant-url>' 'document.title'

Diagnose this particular tab and explain any code you evaluate when it could alter user-visible state.`;
}

export class BrowserDebugLeaseController {
  private persistedLease = readStoredLease();
  private snapshot: BrowserDebugLeaseSnapshot = this.persistedLease
    ? {
        phase: "active",
        connected: false,
        sessionId: this.persistedLease.sessionId,
        expiresAtMs: Date.parse(this.persistedLease.expiresAt),
        error: null,
      }
    : {
        phase: "inactive",
        connected: false,
        sessionId: null,
        expiresAtMs: null,
        error: null,
      };
  private readonly listeners = new Set<() => void>();
  private lease: BrowserDebugLeaseDescriptor | null = null;
  private sourceFetch: SourceFetch | null = null;
  private events: BrowserDebugEventInput[] = [];
  private stopped = true;
  private pollGeneration = 0;
  private pollAbortController: AbortController | null = null;
  private enableAttempt = 0;
  private cleanupInstrumentation: (() => void) | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pageOwnership = new ExclusiveBrowserPageLock(
    LEASE_PAGE_LOCK_PREFIX,
  );
  private pageHideHandler = () => {
    this.suspendLocalLease();
  };
  private pageShowHandler = () => {
    setTimeout(() => void this.reconcilePersistedLease(), 0);
  };

  constructor(options: { canRestorePersistedLease?: () => boolean } = {}) {
    if (this.persistedLease) {
      const canRestore =
        options.canRestorePersistedLease?.() ??
        navigationAllowsLeaseRestore(this.persistedLease);
      if (!canRestore) {
        this.finishPersistedLease(this.persistedLease);
        return;
      }
      this.schedulePersistedExpiry(this.persistedLease);
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): BrowserDebugLeaseSnapshot => this.snapshot;

  getPerformanceSummary = (): BrowserDebugPerformanceSummary | null =>
    getBrowserDebugPerformanceSummary();

  async reconcilePersistedLease(): Promise<void> {
    if (this.lease || !this.persistedLease) return;
    const persistedLease = this.persistedLease;
    const expiresAtMs = Date.parse(persistedLease.expiresAt);
    if (expiresAtMs <= Date.now()) {
      this.finishPersistedLease(persistedLease);
      return;
    }
    const ownsPage = await this.pageOwnership.acquire(persistedLease.leaseId, {
      handoffWaitMs: PAGE_LOCK_RELOAD_HANDOFF_MS,
    });
    if (!ownsPage || this.persistedLease?.leaseId !== persistedLease.leaseId) {
      this.pageOwnership.release();
      this.finishPersistedLease(persistedLease);
      return;
    }

    try {
      const runtime = getSourceRuntimeRegistry().getOrCreateSourceRuntime(
        asClientSummarySourceKey(persistedLease.sourceKey),
      );
      const sourceFetch = runtime.transport.fetch.bind(
        runtime.transport,
      ) as SourceFetch;
      this.lease = {
        leaseId: persistedLease.leaseId,
        controllerToken: persistedLease.controllerToken,
        grantUrl: "",
        sessionId: persistedLease.sessionId,
        tabId: persistedLease.tabId,
        expiresAt: persistedLease.expiresAt,
      };
      this.sourceFetch = sourceFetch;
      this.stopped = false;
      this.cleanupInstrumentation = this.installInstrumentation();
      window.addEventListener("pagehide", this.pageHideHandler);
      window.addEventListener("pageshow", this.pageShowHandler);
      if (this.expiryTimer) clearTimeout(this.expiryTimer);
      this.expiryTimer = setTimeout(
        () => {
          void this.disable({ notifyServer: true });
        },
        Math.max(0, expiresAtMs - Date.now()),
      );
      this.setSnapshot({
        phase: "active",
        connected: false,
        sessionId: persistedLease.sessionId,
        expiresAtMs,
        error: null,
      });
      const pollGeneration = ++this.pollGeneration;
      void this.pollLoop(pollGeneration);
    } catch (error) {
      this.showPersistedWarning(
        persistedLease,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  reactivate(): Promise<void> {
    if (this.lease && this.persistedLease) {
      this.pollAbortController?.abort();
      this.pollAbortController = null;
      this.stopped = false;
      this.setSnapshot({ ...this.snapshot, connected: false, error: null });
      const pollGeneration = ++this.pollGeneration;
      void this.pollLoop(pollGeneration);
      return Promise.resolve();
    }
    return this.reconcilePersistedLease();
  }

  prepareFrontendReload(currentUrl: string, reloadToken: string): string {
    const persistedLease = this.persistedLease;
    if (!persistedLease) {
      throw new Error("The browser debugging lease is no longer active");
    }
    const intent: StoredBrowserDebugReloadIntent = {
      version: 1,
      leaseId: persistedLease.leaseId,
      reloadToken,
    };
    try {
      sessionStorage.setItem(RELOAD_INTENT_STORAGE_KEY, JSON.stringify(intent));
    } catch {
      throw new Error("Browser session storage is unavailable");
    }
    return buildFrontendReloadUrl(currentUrl, reloadToken);
  }

  async enable(sessionId: string): Promise<string> {
    if (this.lease) return buildAgentPrompt(this.lease);
    if (this.persistedLease) {
      throw new Error(
        "A previous browser debugging lease must be revoked before enabling another",
      );
    }
    const enableAttempt = ++this.enableAttempt;
    this.setSnapshot({
      phase: "enabling",
      connected: false,
      sessionId,
      expiresAtMs: null,
      error: null,
    });
    const sourceRuntime = getSourceRuntimeRegistry().getCurrentSourceRuntime();
    const transport = sourceRuntime.transport;
    const sourceFetch = transport.fetch.bind(transport) as SourceFetch;
    try {
      const response = await sourceFetch<{
        lease: BrowserDebugLeaseDescriptor;
      }>("/browser-debug/leases", {
        method: "POST",
        body: JSON.stringify({ sessionId, tabId: tabId() }),
      });
      if (this.enableAttempt !== enableAttempt) {
        await sourceFetch(`/browser-debug/leases/${response.lease.leaseId}`, {
          method: "DELETE",
          headers: {
            "X-YA-Browser-Debug-Controller": response.lease.controllerToken,
          },
        }).catch(() => undefined);
        throw new Error("Browser debugging enable was cancelled");
      }
      const expiresAtMs = Date.parse(response.lease.expiresAt);
      if (!Number.isFinite(expiresAtMs)) {
        throw new Error("Server returned an invalid diagnostic lease expiry");
      }
      const persistedLease: StoredBrowserDebugLease = {
        version: 1,
        leaseId: response.lease.leaseId,
        controllerToken: response.lease.controllerToken,
        sessionId: response.lease.sessionId,
        tabId: response.lease.tabId,
        expiresAt: response.lease.expiresAt,
        sourceKey: sourceRuntime.sourceKey,
      };
      if (!(await this.pageOwnership.acquire(persistedLease.leaseId))) {
        await sourceFetch(`/browser-debug/leases/${response.lease.leaseId}`, {
          method: "DELETE",
          headers: {
            "X-YA-Browser-Debug-Controller": response.lease.controllerToken,
          },
        }).catch(() => undefined);
        throw new Error(
          "Exclusive browser-tab ownership is unavailable; the diagnostic lease was not enabled",
        );
      }
      if (!writeStoredLease(persistedLease)) {
        await sourceFetch(`/browser-debug/leases/${response.lease.leaseId}`, {
          method: "DELETE",
          headers: {
            "X-YA-Browser-Debug-Controller": response.lease.controllerToken,
          },
        }).catch(() => undefined);
        throw new Error(
          "Browser session storage is unavailable; the diagnostic lease was not enabled",
        );
      }
      this.persistedLease = persistedLease;
      this.lease = response.lease;
      this.sourceFetch = sourceFetch;
      this.stopped = false;
      this.cleanupInstrumentation = this.installInstrumentation();
      window.addEventListener("pagehide", this.pageHideHandler);
      window.addEventListener("pageshow", this.pageShowHandler);
      this.expiryTimer = setTimeout(
        () => {
          void this.disable({ notifyServer: true });
        },
        Math.max(0, expiresAtMs - Date.now()),
      );
      this.setSnapshot({
        phase: "active",
        connected: true,
        sessionId,
        expiresAtMs,
        error: null,
      });
      const pollGeneration = ++this.pollGeneration;
      void this.pollLoop(pollGeneration);
      return buildAgentPrompt(response.lease);
    } catch (error) {
      if (this.enableAttempt !== enableAttempt) throw error;
      await this.disable({ notifyServer: false });
      const message = error instanceof Error ? error.message : String(error);
      this.setSnapshot({
        phase: "inactive",
        connected: false,
        sessionId: null,
        expiresAtMs: null,
        error: message,
      });
      throw error;
    }
  }

  async disable(
    options: {
      notifyServer?: boolean;
      keepalive?: boolean;
      unconfirmedError?: unknown;
    } = {},
  ): Promise<void> {
    const lease = this.lease;
    const persistedLease = this.persistedLease;
    let sourceFetch = this.sourceFetch;
    if (!lease && persistedLease && !sourceFetch) {
      try {
        const runtime = getSourceRuntimeRegistry().getOrCreateSourceRuntime(
          asClientSummarySourceKey(persistedLease.sourceKey),
        );
        sourceFetch = runtime.transport.fetch.bind(
          runtime.transport,
        ) as SourceFetch;
      } catch {
        sourceFetch = null;
      }
    }
    this.enableAttempt += 1;
    this.stopped = true;
    this.pollGeneration += 1;
    this.pollAbortController?.abort();
    this.pollAbortController = null;
    this.pageOwnership.release();
    this.lease = null;
    this.sourceFetch = null;
    this.cleanupInstrumentation?.();
    this.cleanupInstrumentation = null;
    window.removeEventListener("pagehide", this.pageHideHandler);
    window.removeEventListener("pageshow", this.pageShowHandler);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.events = [];
    const liveLocalClose =
      lease !== null &&
      !options.keepalive &&
      options.unconfirmedError === undefined;
    if (liveLocalClose) {
      this.finishPersistedLease(persistedLease);
      if (options.notifyServer !== false && persistedLease && sourceFetch) {
        void this.revokePersistedLease(persistedLease, sourceFetch);
      }
      return;
    }
    if (
      options.notifyServer === false &&
      persistedLease &&
      options.unconfirmedError !== undefined &&
      !leaseIsGone(options.unconfirmedError)
    ) {
      this.showPersistedWarning(
        persistedLease,
        options.unconfirmedError instanceof Error
          ? options.unconfirmedError.message
          : String(options.unconfirmedError),
      );
      return;
    }
    if (options.notifyServer === false || !persistedLease) {
      this.finishPersistedLease(persistedLease);
      return;
    }
    if (!sourceFetch) {
      this.showPersistedWarning(
        persistedLease,
        "The prior browser debugging lease could not yet be revoked",
      );
      return;
    }
    await this.revokePersistedLease(persistedLease, sourceFetch, {
      keepalive: options.keepalive,
    });
  }

  private setSnapshot(snapshot: BrowserDebugLeaseSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private suspendLocalLease(): void {
    const persistedLease = this.persistedLease;
    if (!persistedLease) return;
    this.enableAttempt += 1;
    this.stopped = true;
    this.pollGeneration += 1;
    this.pollAbortController?.abort();
    this.pollAbortController = null;
    this.pageOwnership.release();
    this.lease = null;
    this.sourceFetch = null;
    this.cleanupInstrumentation?.();
    this.cleanupInstrumentation = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.events = [];
    this.showPersistedWarning(persistedLease, null);
  }

  private async revokePersistedLease(
    persistedLease: StoredBrowserDebugLease,
    sourceFetch?: SourceFetch,
    options: { keepalive?: boolean } = {},
  ): Promise<void> {
    let fetchLease = sourceFetch;
    if (!fetchLease) {
      try {
        const runtime = getSourceRuntimeRegistry().getOrCreateSourceRuntime(
          asClientSummarySourceKey(persistedLease.sourceKey),
        );
        fetchLease = runtime.transport.fetch.bind(
          runtime.transport,
        ) as SourceFetch;
      } catch {
        fetchLease = undefined;
      }
    }
    if (!fetchLease) {
      this.showPersistedWarning(
        persistedLease,
        "The prior browser debugging lease could not yet be revoked",
      );
      return;
    }
    try {
      await fetchLease(`/browser-debug/leases/${persistedLease.leaseId}`, {
        method: "DELETE",
        keepalive: options.keepalive,
        headers: {
          "X-YA-Browser-Debug-Controller": persistedLease.controllerToken,
        },
      });
      this.finishPersistedLease(persistedLease);
    } catch (error) {
      if (leaseIsGone(error)) {
        this.finishPersistedLease(persistedLease);
        return;
      }
      this.showPersistedWarning(
        persistedLease,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private showPersistedWarning(
    persistedLease: StoredBrowserDebugLease,
    error: string | null,
  ): void {
    if (this.persistedLease?.leaseId !== persistedLease.leaseId) return;
    const expiresAtMs = Date.parse(persistedLease.expiresAt);
    if (expiresAtMs <= Date.now()) {
      this.finishPersistedLease(persistedLease);
      return;
    }
    this.schedulePersistedExpiry(persistedLease);
    this.setSnapshot({
      phase: "active",
      connected: false,
      sessionId: persistedLease.sessionId,
      expiresAtMs,
      error,
    });
  }

  private schedulePersistedExpiry(
    persistedLease: StoredBrowserDebugLease,
  ): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(
      () => this.finishPersistedLease(persistedLease),
      Math.max(0, Date.parse(persistedLease.expiresAt) - Date.now()),
    );
  }

  private finishPersistedLease(
    persistedLease: StoredBrowserDebugLease | null,
  ): void {
    if (
      persistedLease &&
      this.persistedLease?.leaseId !== persistedLease.leaseId
    ) {
      return;
    }
    if (persistedLease) clearStoredLease(persistedLease.leaseId);
    else clearStoredLease();
    this.pageOwnership.release();
    this.persistedLease = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.setSnapshot({
      phase: "inactive",
      connected: false,
      sessionId: null,
      expiresAtMs: null,
      error: null,
    });
  }

  private headers(lease: BrowserDebugLeaseDescriptor): HeadersInit {
    return { "X-YA-Browser-Debug-Controller": lease.controllerToken };
  }

  private async pollLoop(generation: number): Promise<void> {
    while (!this.stopped && generation === this.pollGeneration) {
      const lease = this.lease;
      const sourceFetch = this.sourceFetch;
      if (!lease || !sourceFetch) return;
      const pollAbortController = new AbortController();
      this.pollAbortController = pollAbortController;
      const connectedTimer = setTimeout(() => {
        if (
          !this.stopped &&
          generation === this.pollGeneration &&
          this.lease?.leaseId === lease.leaseId &&
          !this.snapshot.connected
        ) {
          this.setSnapshot({ ...this.snapshot, connected: true, error: null });
        }
      }, POLL_CONNECTED_GRACE_MS);
      try {
        const response = await sourceFetch<{
          command: BrowserDebugCommand | null;
        }>(`/browser-debug/leases/${lease.leaseId}/poll`, {
          method: "POST",
          headers: this.headers(lease),
          signal: pollAbortController.signal,
        });
        if (
          this.stopped ||
          generation !== this.pollGeneration ||
          this.lease?.leaseId !== lease.leaseId
        )
          return;
        if (!this.snapshot.connected || this.snapshot.error) {
          this.setSnapshot({ ...this.snapshot, connected: true, error: null });
        }
        if (response.command)
          await this.execute(response.command, lease, sourceFetch);
      } catch (error) {
        if (
          responseStatus(error) === 409 &&
          !this.stopped &&
          generation === this.pollGeneration
        ) {
          this.setSnapshot({
            ...this.snapshot,
            connected: false,
            error: error instanceof Error ? error.message : String(error),
          });
          await new Promise((resolve) =>
            setTimeout(resolve, POLL_RECONNECT_RETRY_MS),
          );
          continue;
        }
        if (!this.stopped && generation === this.pollGeneration) {
          await this.disable({ notifyServer: false, unconfirmedError: error });
        }
        return;
      } finally {
        clearTimeout(connectedTimer);
        if (this.pollAbortController === pollAbortController) {
          this.pollAbortController = null;
        }
      }
    }
  }

  private async execute(
    command: BrowserDebugCommand,
    lease: BrowserDebugLeaseDescriptor,
    sourceFetch: SourceFetch,
  ): Promise<void> {
    let result: { ok: boolean; value?: unknown; error?: string };
    try {
      const value = await executeBrowserDebugCode(command.code);
      result = { ok: true, value: serializeForDiagnostics(value) };
    } catch (error) {
      const serializedError = serializeForDiagnostics(error);
      result = {
        ok: false,
        error:
          typeof serializedError === "string"
            ? serializedError
            : JSON.stringify(serializedError),
      };
    }
    await sourceFetch(`/browser-debug/leases/${lease.leaseId}/results`, {
      method: "POST",
      headers: this.headers(lease),
      body: JSON.stringify({ commandId: command.commandId, result }),
    });
  }

  private enqueue(kind: string, data?: unknown): void {
    if (this.stopped) return;
    if (this.events.length >= EVENT_QUEUE_LIMIT) this.events.shift();
    this.events.push({
      timestamp: Date.now(),
      kind: kind.slice(0, EVENT_KIND_LIMIT),
      ...(data === undefined ? {} : { data: serializeForDiagnostics(data) }),
    });
  }

  private async flushEvents(): Promise<void> {
    if (this.events.length === 0) return;
    const lease = this.lease;
    const sourceFetch = this.sourceFetch;
    if (!lease || !sourceFetch) return;
    const events: BrowserDebugEventInput[] = [];
    let estimatedBytes = 16;
    while (events.length < 100 && this.events.length > 0) {
      const next = this.events[0];
      if (!next) break;
      // Three bytes per UTF-16 code unit is a conservative UTF-8 bound for
      // JSON source, including non-ASCII BMP characters.
      const nextBytes = JSON.stringify(next).length * 3 + 1;
      if (events.length > 0 && estimatedBytes + nextBytes > FLUSH_BODY_BUDGET) {
        break;
      }
      this.events.shift();
      events.push(
        nextBytes <= FLUSH_BODY_BUDGET
          ? next
          : { ...next, data: "[event exceeded upload size limit]" },
      );
      estimatedBytes += Math.min(nextBytes, FLUSH_BODY_BUDGET);
    }
    try {
      await sourceFetch(`/browser-debug/leases/${lease.leaseId}/events`, {
        method: "POST",
        headers: this.headers(lease),
        body: JSON.stringify({ events }),
      });
    } catch {
      this.events.unshift(...events);
      if (this.events.length > EVENT_QUEUE_LIMIT) {
        this.events.length = EVENT_QUEUE_LIMIT;
      }
    }
  }

  private installInstrumentation(): () => void {
    const consoleMethods: ConsoleMethod[] = [
      "debug",
      "error",
      "info",
      "log",
      "warn",
    ];
    const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
    for (const method of consoleMethods) {
      const original = console[method].bind(console) as (
        ...args: unknown[]
      ) => void;
      originals.set(method, original);
      console[method] = (...args: unknown[]) => {
        original(...args);
        this.enqueue(`console.${method}`, args);
      };
    }

    const onError = (event: ErrorEvent) => {
      this.enqueue("window.error", {
        message: event.message,
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        error: event.error,
      });
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      this.enqueue("unhandledrejection", event.reason);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    const cleanupPerformanceInstrumentation =
      installBrowserDebugPerformanceInstrumentation(
        this.lease?.sessionId ?? "unknown",
        (kind, data) => this.enqueue(kind, data),
      );
    const flushInterval = setInterval(
      () => void this.flushEvents(),
      FLUSH_INTERVAL_MS,
    );
    this.enqueue("lease.enabled", {
      url: location.href,
      userAgent: navigator.userAgent,
    });

    return () => {
      for (const [method, original] of originals) console[method] = original;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      cleanupPerformanceInstrumentation();
      clearInterval(flushInterval);
    };
  }
}

export const browserDebugLeaseController = new BrowserDebugLeaseController();
