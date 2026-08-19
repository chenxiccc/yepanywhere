import { describe, expect, it } from "vitest";
import { sessionQueueSummaries } from "../../src/routes/session-queue-summaries.js";

describe("sessionQueueSummaries", () => {
  it("projects a durable pending boundary without a live process", () => {
    const deferred = sessionQueueSummaries(
      {
        sessionMetadataService: {
          getMetadata: () => ({
            pendingSyntheticDone: {
              message: {
                type: "user",
                content: "/archive",
                message: { role: "user", content: "/archive" },
                timestamp: "2026-08-16T10:00:00.000Z",
                uuid: "durable-boundary-1",
                id: "durable-boundary-1",
                isSynthetic: true,
                yaSyntheticSource: "done",
              },
              userTurnVersion: 4,
            },
          }),
        },
      },
      "session-1",
      undefined,
    );

    expect(deferred).toEqual([
      {
        tempId: "durable-boundary-1",
        content: "/archive",
        timestamp: "2026-08-16T10:00:00.000Z",
        kind: "ya-command",
        yaCommand: "done",
        status: "queued",
      },
    ]);
  });
});
