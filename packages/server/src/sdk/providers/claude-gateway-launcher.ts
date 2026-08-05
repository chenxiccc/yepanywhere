/**
 * Optional process owner for a locally configured Claude Gateway.
 *
 * The configured shell command is powerful by design, so this boundary is
 * deliberately narrow: YA runs it only for a recognized loopback URL and only
 * after proving that the URL's TCP port has no listener. Catalog reads are the
 * only launch trigger; there is no recurring retry loop.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { isIP, createConnection } from "node:net";
import { getLogger } from "../../logging/logger.js";

const DEFAULT_PROBE_TIMEOUT_MS = 500;
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_POLL_MS = 100;
const DEFAULT_STOP_GRACE_MS = 2_000;

export interface ClaudeGatewayLaunchConfig {
  url?: string;
  startCommand?: string;
}

export interface ClaudeGatewayLauncherOptions {
  /** Resolves a gateway URL to a base URL pinned to the address that answered. */
  probe?: (url: string) => Promise<string | null>;
  spawnCommand?: (command: string) => ChildProcess;
  signalChild?: (child: ChildProcess, signal: NodeJS.Signals) => void;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  stopGraceMs?: number;
}

interface OwnedChild {
  child: ChildProcess;
  generation: number;
  closed: boolean;
  closedPromise: Promise<void>;
}

interface LaunchAttempt {
  generation: number;
  promise: Promise<string | null>;
}

/**
 * Loopback addresses to probe for a `localhost` URL, in resolution preference
 * order. Probing is concurrent; the preference only decides which answering
 * address is returned, so a dual-stack gateway is pinned consistently.
 */
const LOOPBACK_PROBE_HOSTS = ["127.0.0.1", "::1"];

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function normalizedLoopbackHostname(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
    if (hostname === "localhost" || hostname === "localhost.") {
      return hostname;
    }
    if (isIP(hostname) === 4 && hostname.split(".")[0] === "127") {
      return hostname;
    }
    if (isIP(hostname) === 6 && hostname === "::1") {
      return hostname;
    }
    return null;
  } catch {
    return null;
  }
}

export function isClaudeGatewayLoopbackUrl(rawUrl: string): boolean {
  return normalizedLoopbackHostname(rawUrl) !== null;
}

function connectToHost(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const settle = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(timeoutMs, () => settle(false));
  });
}

/** Rewrite a gateway URL onto a specific address, preserving port and path. */
function pinnedBaseUrl(rawUrl: string, host: string): string {
  const url = new URL(rawUrl);
  url.hostname = host.includes(":") ? `[${host}]` : host;
  const pinned = url.toString();
  return pinned.endsWith("/") ? pinned.slice(0, -1) : pinned;
}

/**
 * Resolve which loopback address is actually serving a gateway URL.
 *
 * Returns a base URL pinned to the address that answered, so the caller's
 * request lands on the listener the probe just proved. A server that binds one
 * address family leaves the other family's socket free on the same port, so
 * `localhost` can front two unrelated gateways at once — one stale — and an
 * unpinned client picks between them per request. Null means nothing answered
 * (or the URL is not loopback, which this launcher does not own).
 */
export async function resolveClaudeGatewayEndpoint(
  rawUrl: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const loopbackHostname = normalizedLoopbackHostname(rawUrl);
  if (!loopbackHostname) return null;

  const url = new URL(rawUrl);
  const port = url.port
    ? Number.parseInt(url.port, 10)
    : url.protocol === "https:"
      ? 443
      : 80;
  const hosts =
    loopbackHostname === "localhost" || loopbackHostname === "localhost."
      ? LOOPBACK_PROBE_HOSTS
      : [loopbackHostname];
  const reachable = await Promise.all(
    hosts.map((host) => connectToHost(host, port, timeoutMs)),
  );
  for (const [index, host] of hosts.entries()) {
    if (reachable[index]) return pinnedBaseUrl(rawUrl, host);
  }
  return null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function spawnGatewayCommand(command: string): ChildProcess {
  return spawn("bash", ["-c", command], {
    cwd: process.cwd(),
    env: { ...process.env },
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function signalGatewayChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process has already exited.
    }
  }
}

function configKey(config: ClaudeGatewayLaunchConfig): string {
  return `${config.url ?? ""}\n${config.startCommand ?? ""}`;
}

function normalizeConfig(
  config: ClaudeGatewayLaunchConfig,
): ClaudeGatewayLaunchConfig {
  const startCommand = config.startCommand?.trim();
  return {
    url: config.url,
    startCommand: startCommand || undefined,
  };
}

export class ClaudeGatewayLauncher {
  private readonly probe: (url: string) => Promise<string | null>;
  private readonly spawnCommand: (command: string) => ChildProcess;
  private readonly signalChild: (
    child: ChildProcess,
    signal: NodeJS.Signals,
  ) => void;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollMs: number;
  private readonly stopGraceMs: number;

  private config: ClaudeGatewayLaunchConfig = {};
  private currentConfigKey = configKey(this.config);
  private generation = 0;
  private ownedChild: OwnedChild | undefined;
  private launchAttempt: LaunchAttempt | undefined;
  private configurationReady: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: ClaudeGatewayLauncherOptions = {}) {
    this.probe = options.probe ?? resolveClaudeGatewayEndpoint;
    this.spawnCommand = options.spawnCommand ?? spawnGatewayCommand;
    this.signalChild = options.signalChild ?? signalGatewayChild;
    this.wait = options.delay ?? delay;
    this.now = options.now ?? Date.now;
    this.readinessTimeoutMs =
      options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.readinessPollMs =
      options.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  async configure(config: ClaudeGatewayLaunchConfig): Promise<void> {
    const normalized = normalizeConfig(config);
    const nextKey = configKey(normalized);
    if (nextKey === this.currentConfigKey) {
      await this.configurationReady;
      return;
    }

    this.generation += 1;
    this.config = normalized;
    this.currentConfigKey = nextKey;
    const previousTransition = this.configurationReady;
    const transition = (async () => {
      await previousTransition;
      await this.stopOwnedChild();
    })();
    this.configurationReady = transition;
    await transition;
  }

  /**
   * Ensure a configured local endpoint has a listener.
   *
   * Returns the base URL pinned to the address that answered — callers must
   * send their request there rather than to the configured URL, so it reaches
   * the listener readiness was proven against. Null means the endpoint is not
   * a loopback endpoint this launcher owns, or nothing answered and no bounded
   * launch attempt made it ready; the caller then uses the configured URL.
   */
  async ensureReady(config: ClaudeGatewayLaunchConfig): Promise<string | null> {
    if (this.disposed) return null;
    await this.configure(config);

    const { url, startCommand } = this.config;
    const generation = this.generation;
    if (!url || !isClaudeGatewayLoopbackUrl(url)) return null;
    const listening = await this.probe(url);
    if (listening) return listening;
    if (!startCommand) return null;
    if (generation !== this.generation || this.disposed) return null;

    if (this.launchAttempt?.generation === generation) {
      return this.launchAttempt.promise;
    }

    const promise = this.launchAndWait(url, startCommand, generation);
    const attempt = { generation, promise };
    this.launchAttempt = attempt;
    try {
      return await promise;
    } finally {
      if (this.launchAttempt === attempt) {
        this.launchAttempt = undefined;
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.config = {};
    this.currentConfigKey = configKey(this.config);
    await this.configurationReady;
    await this.stopOwnedChild();
  }

  getOwnedProcessGroupId(): number | undefined {
    return this.ownedChild?.child.pid;
  }

  relinquishOwnedProcessGroup(processGroupId: number): boolean {
    const entry = this.ownedChild;
    if (!entry || entry.child.pid !== processGroupId) return false;
    this.ownedChild = undefined;
    return true;
  }

  private async launchAndWait(
    url: string,
    startCommand: string,
    generation: number,
  ): Promise<string | null> {
    await this.stopOwnedChild();
    if (generation !== this.generation || this.disposed) return null;

    let child: ChildProcess;
    try {
      child = this.spawnCommand(startCommand);
    } catch (error) {
      getLogger().warn(
        { error, gatewayUrl: url },
        "Failed to start configured Claude gateway command",
      );
      return null;
    }

    const entry = this.trackChild(child, generation);
    this.ownedChild = entry;
    getLogger().info(
      { gatewayUrl: url, pid: child.pid },
      "Started configured Claude gateway command",
    );

    const deadline = this.now() + this.readinessTimeoutMs;
    while (
      generation === this.generation &&
      !this.disposed &&
      this.now() <= deadline
    ) {
      const listening = await this.probe(url);
      if (listening) {
        getLogger().info(
          { gatewayUrl: url, listeningUrl: listening, pid: child.pid },
          "Configured Claude gateway became ready",
        );
        return listening;
      }
      if (entry.closed) {
        getLogger().warn(
          { gatewayUrl: url },
          "Configured Claude gateway command exited before readiness",
        );
        return null;
      }
      await this.wait(this.readinessPollMs);
    }

    if (generation === this.generation && !this.disposed) {
      getLogger().warn(
        { gatewayUrl: url, timeoutMs: this.readinessTimeoutMs },
        "Configured Claude gateway did not become ready in time",
      );
    }
    if (this.ownedChild === entry) {
      await this.stopOwnedChild();
    }
    return null;
  }

  private trackChild(child: ChildProcess, generation: number): OwnedChild {
    let closeEntry: (() => void) | undefined;
    const entry: OwnedChild = {
      child,
      generation,
      closed: false,
      closedPromise: new Promise((resolve) => {
        closeEntry = resolve;
      }),
    };
    const close = () => {
      if (entry.closed) return;
      entry.closed = true;
      closeEntry?.();
      if (this.ownedChild === entry) {
        this.ownedChild = undefined;
      }
    };
    child.once("close", close);
    child.once("error", close);
    return entry;
  }

  private async stopOwnedChild(): Promise<void> {
    const entry = this.ownedChild;
    if (!entry) return;
    this.ownedChild = undefined;

    this.signalChild(entry.child, "SIGTERM");
    if (await this.waitForClose(entry, this.stopGraceMs)) return;

    this.signalChild(entry.child, "SIGKILL");
    await this.waitForClose(entry, this.stopGraceMs);
  }

  private waitForClose(entry: OwnedChild, timeoutMs: number): Promise<boolean> {
    if (entry.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(entry.closed);
      }, timeoutMs);
      timeout.unref();
      void entry.closedPromise.then(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }
}

export const claudeGatewayLauncher = new ClaudeGatewayLauncher();
