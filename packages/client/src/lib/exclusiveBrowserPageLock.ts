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
  private acquisitionGeneration = 0;

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

    const generation = this.acquisitionGeneration;
    const pendingAcquisition = this.acquireUnowned(key, options, generation);
    this.pendingKey = key;
    this.pendingAcquisition = pendingAcquisition;
    try {
      const acquired = await pendingAcquisition;
      return (
        acquired &&
        this.acquisitionGeneration === generation &&
        this.ownedKey === key
      );
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
    generation: number,
  ): Promise<boolean> {
    const locks = getBrowserTabLockManager();
    if (!locks) return false;

    const deadline = Date.now() + (options.handoffWaitMs ?? 0);
    const retryIntervalMs = options.retryIntervalMs ?? 20;
    while (true) {
      if (this.acquisitionGeneration !== generation) return false;
      const result = await this.tryAcquire(locks, key, generation);
      if (result === "acquired") return true;
      if (
        result === "cancelled" ||
        result === "error" ||
        Date.now() >= deadline
      ) {
        return false;
      }
      await delay(Math.min(retryIntervalMs, deadline - Date.now()));
    }
  }

  private async tryAcquire(
    locks: BrowserTabLockManager,
    key: string,
    generation: number,
  ): Promise<"acquired" | "cancelled" | "error" | "unavailable"> {
    type AcquisitionResult = "acquired" | "cancelled" | "error" | "unavailable";
    let settleAcquired: (result: AcquisitionResult) => void = () => undefined;
    const acquired = new Promise<AcquisitionResult>((resolve) => {
      settleAcquired = resolve;
    });

    let releaseLock: () => void = () => undefined;
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let settled = false;
    const settle = (value: AcquisitionResult) => {
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
          if (this.acquisitionGeneration !== generation) {
            settle("cancelled");
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
    this.acquisitionGeneration += 1;
    this.pendingKey = null;
    this.pendingAcquisition = null;
    const release = this.releaseOwnership;
    this.releaseOwnership = null;
    this.ownedKey = null;
    release?.();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
