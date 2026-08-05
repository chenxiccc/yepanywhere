import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireClientQueryBootstrapSlot,
  getClientQueryBootstrapMetrics,
  resetClientQueryBootstrapForTests,
} from "../clientQueryBootstrap";
import { asClientSummarySourceKey } from "../clientSummaryStore";

const SOURCE = asClientSummarySourceKey("host:bootstrap-test");

afterEach(() => {
  resetClientQueryBootstrapForTests();
  vi.useRealTimers();
});

/** Let the coordinator's deferred advance run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("clientQueryBootstrap", () => {
  it("holds later tiers until the selected route's work settles", async () => {
    // Every hook in the mount commit registers before anything is evaluated,
    // which is the whole reason opening is deferred.
    const route = acquireClientQueryBootstrapSlot(SOURCE, "route");
    const navigation = acquireClientQueryBootstrapSlot(SOURCE, "navigation");
    const supplementary = acquireClientQueryBootstrapSlot(
      SOURCE,
      "supplementary",
    );

    let navigationStarted = false;
    let supplementaryStarted = false;
    void navigation.ready().then(() => {
      navigationStarted = true;
    });
    void supplementary.ready().then(() => {
      supplementaryStarted = true;
    });
    let routeStarted = false;
    void route.ready().then(() => {
      routeStarted = true;
    });

    await flush();
    expect(routeStarted).toBe(true);
    expect(navigationStarted).toBe(false);
    expect(supplementaryStarted).toBe(false);

    route.settle();
    await flush();
    expect(navigationStarted).toBe(true);
    expect(supplementaryStarted).toBe(false);

    navigation.settle();
    await flush();
    expect(supplementaryStarted).toBe(true);
  });

  it("opens a tier immediately when no earlier tier registered work", async () => {
    const supplementary = acquireClientQueryBootstrapSlot(
      SOURCE,
      "supplementary",
    );
    let started = false;
    void supplementary.ready().then(() => {
      started = true;
    });

    await flush();
    expect(started).toBe(true);
  });

  it("releases a blocked tier after the deadline rather than starving it", async () => {
    vi.useFakeTimers();
    const route = acquireClientQueryBootstrapSlot(SOURCE, "route");
    const navigation = acquireClientQueryBootstrapSlot(SOURCE, "navigation");
    let navigationStarted = false;
    void navigation.ready().then(() => {
      navigationStarted = true;
    });

    await flush();
    expect(navigationStarted).toBe(false);

    // The route request hangs; the shell must still load.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(navigationStarted).toBe(true);
    route.settle();
  });

  it("stops gating once every tier has opened", async () => {
    const route = acquireClientQueryBootstrapSlot(SOURCE, "route");
    await flush();
    route.settle();
    await flush();
    expect(getClientQueryBootstrapMetrics(SOURCE)?.complete).toBe(true);

    // A route that mounts later is past bootstrap: it must not re-gate the
    // shell that already loaded.
    const late = acquireClientQueryBootstrapSlot(SOURCE, "route");
    let lateSupplementaryStarted = false;
    void acquireClientQueryBootstrapSlot(SOURCE, "supplementary")
      .ready()
      .then(() => {
        lateSupplementaryStarted = true;
      });

    await flush();
    expect(lateSupplementaryStarted).toBe(true);
    late.settle();
  });

  it("keeps sources independent", async () => {
    const other = asClientSummarySourceKey("host:bootstrap-other");
    const route = acquireClientQueryBootstrapSlot(SOURCE, "route");
    let otherNavigationStarted = false;
    void acquireClientQueryBootstrapSlot(other, "navigation")
      .ready()
      .then(() => {
        otherNavigationStarted = true;
      });

    await flush();
    expect(otherNavigationStarted).toBe(true);
    expect(getClientQueryBootstrapMetrics(SOURCE)?.openTier).toBe("route");
    route.settle();
  });
});
