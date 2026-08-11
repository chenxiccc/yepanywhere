import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import { createSessionWakeRoutes } from "../../src/routes/session-wake.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import type { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import {
  SessionWakeService,
  loadOrCreateSessionWakeSecret,
} from "../../src/services/SessionWakeService.js";
import { createApp } from "../setup/create-app.js";

function request(token: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

describe("session wake route", () => {
  it("is mounted outside cookie and custom-header API authentication", async () => {
    const secret = Buffer.alloc(32, 5);
    const token = new SessionWakeService({
      secret,
      isEnabled: () => true,
      deliver: async () => ({ accepted: true }),
    }).tokenForSession("missing-session");
    const serverSettingsService = {
      getSetting: (key: string) =>
        key === "wakeTurnsEnabled" ? true : undefined,
      onSettingsChanged: () => () => undefined,
    } as unknown as ServerSettingsService;
    const { app, supervisor } = createApp({
      sdk: new MockClaudeSDK(),
      sessionWakeSecret: secret,
      serverSettingsService,
    });

    const response = await app.request(
      "/session-wake/missing-session",
      request(token, { text: "job finished" }),
    );

    expect(response.status).toBe(404);

    const started = await supervisor.startSession(process.cwd(), {
      text: "initial turn",
    });
    expect("error" in started || "queued" in started).toBe(false);
    if ("error" in started || "queued" in started) return;
    try {
      const liveToken = new SessionWakeService({
        secret,
        isEnabled: () => true,
        deliver: async () => ({ accepted: true }),
      }).tokenForSession(started.sessionId);
      const liveResponse = await app.request(
        `/session-wake/${started.sessionId}`,
        request(liveToken, { text: "job finished" }),
      );

      expect(liveResponse.status).toBe(202);
    } finally {
      await started.abort();
    }
  });

  it("persists one owner-readable server secret", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ya-session-wake-test-"));
    try {
      const first = await loadOrCreateSessionWakeSecret(dataDir);
      const second = await loadOrCreateSessionWakeSecret(dataDir);
      const secretStat = await stat(join(dataDir, "session-wake-secret"));

      expect(second).toEqual(first);
      if (process.platform !== "win32") {
        expect(secretStat.mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(dataDir, { recursive: true });
    }
  });

  it("accepts a bounded authenticated wake for an enabled session", async () => {
    const deliver = vi.fn(async () => ({ accepted: true as const }));
    const service = new SessionWakeService({
      secret: Buffer.alloc(32, 7),
      isEnabled: () => true,
      deliver,
    });
    const token = service.tokenForSession("session-1");

    const response = await createSessionWakeRoutes(service).request(
      "/session-1",
      request(token, {
        text: "job finished",
        source: "agentctl",
        jobId: "run-1",
      }),
    );

    expect(response.status).toBe(202);
    expect(deliver).toHaveBeenCalledWith({
      sessionId: "session-1",
      text: "job finished",
      source: "agentctl",
      jobId: "run-1",
    });
  });

  it("resumes an eligible cold session and rejects an archived one", async () => {
    const root = await mkdtemp(join(tmpdir(), "ya-session-wake-cold-test-"));
    const secret = Buffer.alloc(32, 11);
    const sdk = new MockClaudeSDK();
    const startSession = vi.spyOn(sdk, "startSession");
    const metadata = new SessionMetadataService({
      dataDir: join(root, "data"),
    });
    await metadata.initialize();
    const projectId = encodeProjectId(homedir());
    await metadata.setWorkingProject("cold-session", projectId, projectId);
    await metadata.updateMetadata("cold-session", { wakeTurnsEnabled: true });
    await metadata.setWorkingProject("archived-session", projectId, projectId);
    await metadata.updateMetadata("archived-session", {
      archived: true,
      wakeTurnsEnabled: true,
    });
    const { app, supervisor } = createApp({
      sdk,
      dataDir: join(root, "app-data"),
      projectsDir: join(root, "projects"),
      sessionMetadataService: metadata,
      sessionWakeSecret: secret,
    });
    const resumeSession = vi.spyOn(supervisor, "resumeSession");
    const tokens = new SessionWakeService({
      secret,
      isEnabled: () => true,
      deliver: async () => ({ accepted: true }),
    });

    try {
      const accepted = await app.request(
        "/session-wake/cold-session",
        request(tokens.tokenForSession("cold-session"), {
          text: "cold job finished",
        }),
      );
      expect(accepted.status).toBe(202);
      expect(resumeSession).toHaveBeenCalledWith("cold-session", homedir(), {
        text: "cold job finished",
      });
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resume: "cold-session",
        }),
      );

      const callsAfterAccepted = resumeSession.mock.calls.length;
      const rejected = await app.request(
        "/session-wake/archived-session",
        request(tokens.tokenForSession("archived-session"), {
          text: "archived job finished",
        }),
      );
      expect(rejected.status).toBe(409);
      expect(resumeSession).toHaveBeenCalledTimes(callsAfterAccepted);
    } finally {
      await supervisor.getProcessForSession("cold-session")?.abort();
      await rm(root, { recursive: true });
    }
  });

  it("rejects invalid tokens before revealing whether wake is enabled", async () => {
    const isEnabled = vi.fn(() => true);
    const deliver = vi.fn();
    const service = new SessionWakeService({
      secret: Buffer.alloc(32, 3),
      isEnabled,
      deliver,
    });

    const response = await createSessionWakeRoutes(service).request(
      "/session-1",
      request("wrong", { text: "job finished" }),
    );

    expect(response.status).toBe(401);
    expect(isEnabled).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("enforces the feature gate, payload bound, and token-bucket rate limit", async () => {
    let now = 1_000;
    let enabled = false;
    const deliver = vi.fn(async () => ({ accepted: true as const }));
    const service = new SessionWakeService({
      secret: Buffer.alloc(32, 9),
      isEnabled: () => enabled,
      deliver,
      now: () => now,
      burst: 2,
      refillMs: 60_000,
    });
    const routes = createSessionWakeRoutes(service);
    const token = service.tokenForSession("session-1");

    expect(
      (
        await routes.request(
          "/session-1",
          request(token, { text: "job finished" }),
        )
      ).status,
    ).toBe(403);
    enabled = true;
    expect(
      (
        await routes.request(
          "/session-1",
          request(token, { text: "x".repeat(2_001) }),
        )
      ).status,
    ).toBe(413);
    expect(
      (await routes.request("/session-1", request(token, { text: "first" })))
        .status,
    ).toBe(202);
    expect(
      (await routes.request("/session-1", request(token, { text: "second" })))
        .status,
    ).toBe(202);
    expect(
      (await routes.request("/session-1", request(token, { text: "third" })))
        .status,
    ).toBe(429);
    now += 60_000;
    expect(
      (
        await routes.request(
          "/session-1",
          request(token, { text: "after refill" }),
        )
      ).status,
    ).toBe(202);
  });
});
