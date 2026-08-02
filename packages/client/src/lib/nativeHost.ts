export const NATIVE_HOST_PROTOCOL = 1 as const;
const MAX_MESSAGE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 1_500;

export interface NativeHostDescriptor {
  protocol: typeof NATIVE_HOST_PROTOCOL;
  platform: "android";
  appVersion: string;
  buildVersion: number;
  features: string[];
}

interface NativeHostRawMessageEvent {
  data: unknown;
}

export interface NativeHostRawChannel {
  postMessage(message: string): void;
  onmessage: ((event: NativeHostRawMessageEvent) => void) | null;
}

declare global {
  interface Window {
    yaNative?: NativeHostRawChannel;
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface NativeHostClientOptions {
  getChannel?: () => NativeHostRawChannel | undefined;
  timeoutMs?: number;
  lifecycleTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
}

export class NativeHostClient {
  private readonly getChannel: () => NativeHostRawChannel | undefined;
  private readonly timeoutMs: number;
  private readonly lifecycleTarget?: Pick<
    Window,
    "addEventListener" | "removeEventListener"
  >;
  private readonly pending = new Map<string, PendingRequest>();
  private activeChannel?: NativeHostRawChannel;
  private nextRequestId = 1;
  private descriptorPromise?: Promise<NativeHostDescriptor | null>;

  constructor(options: NativeHostClientOptions = {}) {
    this.getChannel =
      options.getChannel ?? (() => globalThis.window?.yaNative);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.lifecycleTarget = options.lifecycleTarget ?? globalThis.window;
    this.lifecycleTarget?.addEventListener("pagehide", this.handlePageHide);
  }

  describe(): Promise<NativeHostDescriptor | null> {
    if (!this.getChannel()) return Promise.resolve(null);
    if (!this.descriptorPromise) {
      this.descriptorPromise = this.request("host.describe")
        .then(parseDescriptor)
        .catch(() => null)
        .then((descriptor) => {
          if (descriptor === null) this.descriptorPromise = undefined;
          return descriptor;
        });
    }
    return this.descriptorPromise;
  }

  dispose(): void {
    this.lifecycleTarget?.removeEventListener("pagehide", this.handlePageHide);
    this.cancelPending("Native host document was destroyed");
    if (this.activeChannel?.onmessage === this.handleMessage) {
      this.activeChannel.onmessage = null;
    }
    this.activeChannel = undefined;
    this.descriptorPromise = undefined;
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const channel = this.getChannel();
    if (!channel) return Promise.reject(new Error("Native host is unavailable"));
    this.bindChannel(channel);

    const id = `web-${this.nextRequestId}`;
    this.nextRequestId += 1;
    const request = JSON.stringify({
      protocol: NATIVE_HOST_PROTOCOL,
      id,
      method,
      ...(params ? { params } : {}),
    });
    if (new TextEncoder().encode(request).byteLength > MAX_MESSAGE_BYTES) {
      return Promise.reject(new Error("Native host request exceeds 16 KiB"));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Native host request timed out"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        channel.postMessage(request);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Native host request failed"));
      }
    });
  }

  private bindChannel(channel: NativeHostRawChannel): void {
    if (this.activeChannel === channel) return;
    if (this.activeChannel?.onmessage === this.handleMessage) {
      this.activeChannel.onmessage = null;
    }
    this.cancelPending("Native host channel changed");
    this.activeChannel = channel;
    channel.onmessage = this.handleMessage;
  }

  private readonly handleMessage = (event: NativeHostRawMessageEvent): void => {
    if (typeof event.data !== "string") return;
    let response: unknown;
    try {
      response = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isRecord(response) || response.protocol !== NATIVE_HOST_PROTOCOL) return;
    if (typeof response.id !== "string") return;

    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);

    if (response.ok === true) {
      pending.resolve(response.result);
      return;
    }
    if (
      response.ok === false &&
      isRecord(response.error) &&
      typeof response.error.code === "string" &&
      typeof response.error.message === "string"
    ) {
      pending.reject(
        new Error(`${response.error.code}: ${response.error.message}`),
      );
      return;
    }
    pending.reject(new Error("Native host returned an invalid response"));
  };

  private readonly handlePageHide = (): void => {
    this.cancelPending("Native host document was hidden");
    this.descriptorPromise = undefined;
  };

  private cancelPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}

function parseDescriptor(value: unknown): NativeHostDescriptor {
  if (
    !isRecord(value) ||
    value.protocol !== NATIVE_HOST_PROTOCOL ||
    value.platform !== "android" ||
    typeof value.appVersion !== "string" ||
    typeof value.buildVersion !== "number" ||
    !Array.isArray(value.features) ||
    !value.features.every((feature) => typeof feature === "string")
  ) {
    throw new Error("Native host descriptor is invalid");
  }
  return {
    protocol: NATIVE_HOST_PROTOCOL,
    platform: "android",
    appVersion: value.appVersion,
    buildVersion: value.buildVersion,
    features: [...value.features],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const client = typeof window === "undefined" ? null : new NativeHostClient();

export const nativeHost = {
  describe(): Promise<NativeHostDescriptor | null> {
    return client?.describe() ?? Promise.resolve(null);
  },
};
