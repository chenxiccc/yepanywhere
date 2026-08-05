import { describe, expect, it } from "vitest";
import {
  CONVERSATION_ACTIVITY_RESERVE_HOLD_MS,
  activityHeightReserveReleaseDelayMs,
  updateActivityHeightReserve,
} from "../activityHeightReserve";

const HOLD = CONVERSATION_ACTIVITY_RESERVE_HOLD_MS;

describe("conversation activity height reserve", () => {
  it("takes the first measurement and grows with the content", () => {
    const first = updateActivityHeightReserve(null, 120, 1_000);
    expect(first).toEqual({ heightPx: 120, shrankAtMs: null });

    const grown = updateActivityHeightReserve(first, 400, 2_000);
    expect(grown).toEqual({ heightPx: 400, shrankAtMs: null });
  });

  it("keeps the height when content shrinks, and starts the hold there", () => {
    const grown = updateActivityHeightReserve(null, 400, 1_000);

    const held = updateActivityHeightReserve(grown, 90, 5_000);
    expect(held).toEqual({ heightPx: 400, shrankAtMs: 5_000 });

    // Still inside the hold: the row keeps the space rather than dragging the
    // transcript above it down the viewport.
    const stillHeld = updateActivityHeightReserve(held, 90, 5_000 + HOLD - 1);
    expect(stillHeld.heightPx).toBe(400);
  });

  it("releases the space once the hold has fully elapsed", () => {
    const grown = updateActivityHeightReserve(null, 400, 1_000);
    const held = updateActivityHeightReserve(grown, 90, 5_000);

    const released = updateActivityHeightReserve(held, 90, 5_000 + HOLD);
    expect(released).toEqual({ heightPx: 90, shrankAtMs: null });
  });

  it("restarts the hold when content grows back into the reserve", () => {
    // The alternating thinking/activity case: each block that fills the row
    // again should buy another full hold, not spend the previous one.
    const grown = updateActivityHeightReserve(null, 400, 1_000);
    const held = updateActivityHeightReserve(grown, 90, 5_000);
    const refilled = updateActivityHeightReserve(held, 400, 20_000);
    expect(refilled.shrankAtMs).toBeNull();

    const heldAgain = updateActivityHeightReserve(refilled, 90, 21_000);
    expect(heldAgain.shrankAtMs).toBe(21_000);
    expect(
      updateActivityHeightReserve(heldAgain, 90, 5_000 + HOLD).heightPx,
      "the first shrink's clock must not release the second one",
    ).toBe(400);
  });

  it("reports when the held space may be released", () => {
    const grown = updateActivityHeightReserve(null, 400, 1_000);
    expect(activityHeightReserveReleaseDelayMs(grown, 1_000)).toBeNull();

    const held = updateActivityHeightReserve(grown, 90, 5_000);
    expect(activityHeightReserveReleaseDelayMs(held, 5_000)).toBe(HOLD);
    expect(activityHeightReserveReleaseDelayMs(held, 5_000 + HOLD + 10)).toBe(
      0,
    );
  });
});
