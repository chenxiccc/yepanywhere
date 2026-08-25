interface BrowserTabLockManager {
  request(
    name: string,
    options: { ifAvailable: true; mode: "exclusive" },
    callback: (lock: unknown | null) => Promise<void> | void,
  ): Promise<unknown>;
}

function getBrowserTabLockManager(): BrowserTabLockManager | null {
  const locks = (navigator as Navigator & { locks?: BrowserTabLockManager })
    .locks;
  return locks ?? null;
}

/** Owns at most one exclusive Web Lock for the lifetime of a browser page. */
export class ExclusiveBrowserPageLock {
  private ownedKey: string | null = null;
  private pendingKey: string | null = null;
  private pendingAcquisition: Promise<boolean> | null = null;
  private releaseOwnership: (() => void) | null = null;

  constructor(private readonly namePrefix: string) {}

  async acquire(
    key: string,
    options: { handoffWaitMs?: number; retryIntervalMs?: number } = {},
  ): Promise<boolean> {
    if (this.ownedKey === key) return true;
    if (this.ownedKey) return false;
    if (this.pendingAcquisition) {
      return this.pendingKey === key ? this.pendingAcquisition : false;
    }

    const pendingAcquisition = this.acquireUnowned(key, options);
    this.pendingKey = key;
    this.pendingAcquisition = pendingAcquisition;
    try {
      return await pendingAcquisition;
    } finally {
      if (this.pendingAcquisition === pendingAcquisition) {
        this.pendingKey = null;
        this.pendingAcquisition = null;
      }
    }
  }

  private async acquireUnowned(
    key: string,
    options: { handoffWaitMs?: number; retryIntervalMs?: number },
  ): Promise<boolean> {
    const locks = getBrowserTabLockManager();
    if (!locks) return false;

    const deadline = Date.now() + (options.handoffWaitMs ?? 0);
    const retryIntervalMs = options.retryIntervalMs ?? 20;
    while (true) {
      const result = await this.tryAcquire(locks, key);
      if (result === "acquired") return true;
      if (result === "error" || Date.now() >= deadline) return false;
      await delay(Math.min(retryIntervalMs, deadline - Date.now()));
    }
  }

  private async tryAcquire(
    locks: BrowserTabLockManager,
    key: string,
  ): Promise<"acquired" | "error" | "unavailable"> {
    let settleAcquired: (result: "acquired" | "error" | "unavailable") => void =
      () => undefined;
    const acquired = new Promise<"acquired" | "error" | "unavailable">(
      (resolve) => {
        settleAcquired = resolve;
      },
    );

    let releaseLock: () => void = () => undefined;
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let settled = false;
    const settle = (value: "acquired" | "error" | "unavailable") => {
      if (settled) return;
      settled = true;
      settleAcquired(value);
    };

    void locks
      .request(
        `${this.namePrefix}${key}`,
        { ifAvailable: true, mode: "exclusive" },
        async (lock) => {
          if (!lock) {
            settle("unavailable");
            return;
          }
          this.ownedKey = key;
          this.releaseOwnership = releaseLock;
          settle("acquired");
          await holdLock;
        },
      )
      .catch(() => settle("error"));
    return acquired;
  }

  release(): void {
    const release = this.releaseOwnership;
    this.releaseOwnership = null;
    this.ownedKey = null;
    release?.();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
