import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkstreamId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";

describe("SessionMetadataService", () => {
  let testDir: string;
  let service: SessionMetadataService;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-metadata-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    service = new SessionMetadataService({ dataDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    it("starts with empty state when file doesn't exist", async () => {
      await service.initialize();

      expect(service.getAllMetadata()).toEqual({});
    });

    it("creates file on first update when file doesn't exist", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Custom Title");

      const content = await readFile(
        join(testDir, "session-metadata.json"),
        "utf-8",
      );
      const state = JSON.parse(content);
      expect(state.version).toBe(3);
      expect(state.sessions["session-1"]).toBeDefined();
      expect(state.sessions["session-1"].customTitle).toBe("My Custom Title");
    });

    it("loads existing state from JSON file", async () => {
      const existingState = {
        version: 1,
        sessions: {
          "session-1": { customTitle: "Test Title" },
          "session-2": { isArchived: true },
          "session-3": { customTitle: "Archived One", isArchived: true },
        },
      };
      await writeFile(
        join(testDir, "session-metadata.json"),
        JSON.stringify(existingState),
      );

      await service.initialize();

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "Test Title",
      });
      expect(service.getMetadata("session-2")).toEqual({ isArchived: true });
      expect(service.getMetadata("session-3")).toEqual({
        customTitle: "Archived One",
        isArchived: true,
      });
    });

    it("migrates legacy parent links into /btw or fork lineage", async () => {
      await writeFile(
        join(testDir, "session-metadata.json"),
        JSON.stringify({
          version: 2,
          sessions: {
            aside: {
              customTitle: "/btw check the side path",
              parentSessionId: "mother-session",
            },
            clone: {
              customTitle: "Clone: main session",
              parentSessionId: "source-session",
            },
          },
        }),
      );

      await service.initialize();

      expect(service.getMetadata("aside")).toEqual({
        customTitle: "/btw check the side path",
        parentSessionId: "mother-session",
        parentSessionKind: "btw-aside",
      });
      expect(service.getMetadata("clone")).toEqual({
        customTitle: "Clone: main session",
        forkedFromSessionId: "source-session",
      });
      const persisted = JSON.parse(
        await readFile(join(testDir, "session-metadata.json"), "utf-8"),
      );
      expect(persisted.version).toBe(3);
    });

    it("migrates display objects and marks interrupted jobs as errors", async () => {
      const existingState = {
        version: 1,
        sessions: {
          "session-1": {
            transcriptDisplayObjects: [
              {
                id: "display-1",
                kind: "fork-summary",
                createdAt: "2026-06-23T00:00:00.000Z",
                placementAfterMessageId: "assistant-1",
                sourceMessageId: "user-1",
                retainedThroughMessageId: "assistant-1",
                status: "generating",
              },
            ],
          },
        },
      };
      await writeFile(
        join(testDir, "session-metadata.json"),
        JSON.stringify(existingState),
      );

      await service.initialize();

      expect(service.getTranscriptDisplayObjects("session-1")).toEqual([
        expect.objectContaining({
          id: "display-1",
          status: "error",
          error: "Fork summary interrupted by server restart",
        }),
      ]);
      const persisted = JSON.parse(
        await readFile(join(testDir, "session-metadata.json"), "utf-8"),
      );
      expect(persisted.version).toBe(3);
    });

    it("handles corrupted JSON gracefully", async () => {
      await writeFile(
        join(testDir, "session-metadata.json"),
        "not valid json{{{",
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Should not throw
      try {
        await service.initialize();
        expect(warnSpy).toHaveBeenCalledWith(
          "[SessionMetadataService] Failed to load state, starting fresh:",
          expect.any(SyntaxError),
        );
      } finally {
        warnSpy.mockRestore();
      }

      // Should start fresh
      expect(service.getAllMetadata()).toEqual({});
    });
  });

  describe("session ID remapping", () => {
    it("moves provisional metadata and redirects late writes", async () => {
      await service.initialize();
      await service.setProvider("temporary-session", "claude-gateway");

      await service.remapSessionId("temporary-session", "canonical-session");
      await service.setRequestedModel("temporary-session", "gpt-5.6-terra");

      expect(service.getMetadata("canonical-session")).toEqual({
        provider: "claude-gateway",
        requestedModel: "gpt-5.6-terra",
      });
      expect(service.getMetadata("temporary-session")).toEqual({
        provider: "claude-gateway",
        requestedModel: "gpt-5.6-terra",
      });
      expect(service.getAllMetadata()).toEqual({
        "canonical-session": {
          provider: "claude-gateway",
          requestedModel: "gpt-5.6-terra",
        },
      });
    });
  });

  describe("setTitle", () => {
    it("sets custom title for a session", async () => {
      await service.initialize();

      await service.setTitle("session-1", "My Project Work");

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Project Work",
      });
    });

    it("trims whitespace from title", async () => {
      await service.initialize();

      await service.setTitle("session-1", "  Padded Title  ");

      expect(service.getMetadata("session-1")?.customTitle).toBe(
        "Padded Title",
      );
    });

    it("clears title when empty string provided", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Initial Title");

      await service.setTitle("session-1", "");

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("clears title when undefined provided", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Initial Title");

      await service.setTitle("session-1", undefined);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves archived status when updating title", async () => {
      await service.initialize();
      await service.setArchived("session-1", true);

      await service.setTitle("session-1", "New Title");

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "New Title",
        isArchived: true,
      });
    });

    it("persists title to disk", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Persistent Title");

      // Create new instance and verify it loads the persisted data
      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.customTitle).toBe(
        "Persistent Title",
      );
    });
  });

  describe("setArchived", () => {
    it("sets archived status for a session", async () => {
      await service.initialize();

      await service.setArchived("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({ isArchived: true });
    });

    it("clears archived status when set to false", async () => {
      await service.initialize();
      await service.setArchived("session-1", true);

      await service.setArchived("session-1", false);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves custom title when updating archived status", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Title");

      await service.setArchived("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Title",
        isArchived: true,
      });
    });

    it("persists archived status to disk", async () => {
      await service.initialize();
      await service.setArchived("session-1", true);

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.isArchived).toBe(true);
    });
  });

  describe("setStarred", () => {
    it("sets starred status for a session", async () => {
      await service.initialize();

      await service.setStarred("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({ isStarred: true });
    });

    it("clears starred status when set to false", async () => {
      await service.initialize();
      await service.setStarred("session-1", true);

      await service.setStarred("session-1", false);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves other fields when updating starred status", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Title");
      await service.setArchived("session-1", true);

      await service.setStarred("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Title",
        isArchived: true,
        isStarred: true,
      });
    });

    it("persists starred status to disk", async () => {
      await service.initialize();
      await service.setStarred("session-1", true);

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.isStarred).toBe(true);
    });
  });

  describe("updateMetadata", () => {
    it("updates title, archived, and starred at once", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", {
        title: "New Title",
        archived: true,
        starred: true,
      });

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "New Title",
        isArchived: true,
        isStarred: true,
      });
    });

    it("updates only title when others not provided", async () => {
      await service.initialize();
      await service.setArchived("session-1", true);
      await service.setStarred("session-1", true);

      await service.updateMetadata("session-1", { title: "Just Title" });

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "Just Title",
        isArchived: true,
        isStarred: true,
      });
    });

    it("updates only starred when others not provided", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Existing Title");
      await service.setArchived("session-1", true);

      await service.updateMetadata("session-1", { starred: false });

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "Existing Title",
        isArchived: true,
      });
    });

    it("clears title with empty string while setting archived", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Old Title");

      await service.updateMetadata("session-1", { title: "", archived: true });

      expect(service.getMetadata("session-1")).toEqual({ isArchived: true });
    });

    it("stores per-session heartbeat settings and preserves other metadata", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Heartbeat Session");

      await service.updateMetadata("session-1", {
        heartbeatTurnsEnabled: true,
        heartbeatTurnsAfterMinutes: 7,
        heartbeatTurnText: "session heartbeat override",
      });

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "Heartbeat Session",
        heartbeatTurnsEnabled: true,
        heartbeatTurnsAfterMinutes: 7,
        heartbeatTurnText: "session heartbeat override",
      });
    });

    it("clears heartbeat overrides while keeping the session opt-in flag", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", {
        heartbeatTurnsEnabled: true,
        heartbeatTurnsAfterMinutes: 9,
        heartbeatTurnText: "override",
      });
      await service.updateMetadata("session-1", {
        heartbeatTurnsAfterMinutes: null,
        heartbeatTurnText: null,
      });

      expect(service.getMetadata("session-1")).toEqual({
        heartbeatTurnsEnabled: true,
      });
    });

    it("persists an automatic-resume block until heartbeat is re-enabled", async () => {
      await service.initialize();
      await service.updateMetadata("session-1", {
        heartbeatTurnsEnabled: false,
        autoResumeDisabled: true,
      });

      const reloaded = new SessionMetadataService({ dataDir: testDir });
      await reloaded.initialize();
      expect(reloaded.getMetadata("session-1")).toEqual({
        autoResumeDisabled: true,
      });

      await reloaded.updateMetadata("session-1", {
        heartbeatTurnsEnabled: true,
      });
      expect(reloaded.getMetadata("session-1")).toEqual({
        heartbeatTurnsEnabled: true,
      });
    });

    it("stores and clears a /btw parent session link", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", {
        parentSessionId: "  parent-session  ",
      });

      expect(service.getMetadata("session-1")).toEqual({
        parentSessionId: "parent-session",
        parentSessionKind: "btw-aside",
      });

      await service.updateMetadata("session-1", {
        parentSessionId: null,
      });

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("stores ordinary fork provenance separately from /btw parentage", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", {
        forkedFromSessionId: "  source-session  ",
      });

      expect(service.getMetadata("session-1")).toEqual({
        forkedFromSessionId: "source-session",
      });
    });

    it("stores an explicit 'off' prompt-suggestion preference", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", {
        promptSuggestionMode: "off",
      });

      // "off" is a meaningful stored value; it must survive the prune block
      // even when it is the only field.
      expect(service.getMetadata("session-1")).toEqual({
        promptSuggestionMode: "off",
      });
      expect(service.getPromptSuggestionMode("session-1")).toBe("off");
    });

    it("clears the prompt-suggestion preference when set to null", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", {
        promptSuggestionMode: "native",
      });
      expect(service.getPromptSuggestionMode("session-1")).toBe("native");

      await service.updateMetadata("session-1", {
        promptSuggestionMode: null,
      });

      expect(service.getMetadata("session-1")).toBeUndefined();
      expect(service.getPromptSuggestionMode("session-1")).toBeUndefined();
    });

    it("persists the prompt-suggestion preference across restarts", async () => {
      await service.initialize();
      await service.updateMetadata("session-1", {
        promptSuggestionMode: "off",
      });

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getPromptSuggestionMode("session-1")).toBe("off");
    });

    it("stores an explicit recap mode, including 'off'", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", { recapMode: "fork" });
      expect(service.getRecapMode("session-1")).toBe("fork");

      // "off" is meaningful-stored: it must override the default on resume, so
      // it survives the prune block even as the only field.
      await service.updateMetadata("session-2", { recapMode: "off" });
      expect(service.getMetadata("session-2")).toEqual({ recapMode: "off" });
      expect(service.getRecapMode("session-2")).toBe("off");
    });

    it("clears the recap mode when set to null", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", { recapMode: "fork" });
      expect(service.getRecapMode("session-1")).toBe("fork");

      await service.updateMetadata("session-1", { recapMode: null });
      expect(service.getMetadata("session-1")).toBeUndefined();
      expect(service.getRecapMode("session-1")).toBeUndefined();
    });

    it("persists the recap mode across restarts", async () => {
      await service.initialize();
      await service.updateMetadata("session-1", { recapMode: "fork" });

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getRecapMode("session-1")).toBe("fork");
    });
  });

  describe("recapMessages", () => {
    it("persists durable recap overlay rows across restarts", async () => {
      await service.initialize();

      await service.addRecapMessage("session-1", {
        type: "system",
        subtype: "away_summary",
        content: "Finished the smoke test.",
        timestamp: "2026-06-24T00:00:00.000Z",
        uuid: "recap-1",
        id: "recap-1",
        isSynthetic: true,
        yaRecapSource: "ya-synthetic",
      });

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getRecapMessages("session-1")).toEqual([
        expect.objectContaining({
          content: "Finished the smoke test.",
          uuid: "recap-1",
          yaRecapSource: "ya-synthetic",
        }),
      ]);
    });

    it("dedupes durable recap overlay rows by uuid", async () => {
      await service.initialize();

      await service.addRecapMessage("session-1", {
        type: "system",
        subtype: "away_summary",
        content: "First text.",
        timestamp: "2026-06-24T00:00:00.000Z",
        uuid: "recap-1",
        id: "recap-1",
        yaRecapSource: "provider-native",
      });
      await service.addRecapMessage("session-1", {
        type: "system",
        subtype: "away_summary",
        content: "Updated text.",
        timestamp: "2026-06-24T00:00:01.000Z",
        uuid: "recap-1",
        id: "recap-1",
        yaRecapSource: "provider-native",
      });

      expect(service.getRecapMessages("session-1")).toEqual([
        expect.objectContaining({
          content: "Updated text.",
          uuid: "recap-1",
        }),
      ]);
    });
  });

  describe("clearSession", () => {
    it("removes all metadata for a session", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Title");
      await service.setArchived("session-1", true);

      await service.clearSession("session-1");

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("persists removal to disk", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Title");
      await service.clearSession("session-1");

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")).toBeUndefined();
    });

    it("does nothing if session not tracked", async () => {
      await service.initialize();

      // Should not throw
      await service.clearSession("nonexistent-session");

      expect(service.getMetadata("nonexistent-session")).toBeUndefined();
    });
  });

  describe("setWorkstream", () => {
    it("sets and clears workstream identity", async () => {
      await service.initialize();

      await service.setWorkstream("session-1", "ws-feature" as WorkstreamId);

      expect(service.getMetadata("session-1")).toEqual({
        workstreamId: "ws-feature",
      });

      await service.setWorkstream("session-1", undefined);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves other metadata when updating workstream identity", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Title");

      await service.setWorkstream("session-1", "ws-feature" as WorkstreamId);

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Title",
        workstreamId: "ws-feature",
      });
    });
  });

  describe("getAllMetadata", () => {
    it("returns copy of all entries", async () => {
      await service.initialize();

      await service.setTitle("session-1", "Title One");
      await service.setArchived("session-2", true);
      await service.updateMetadata("session-3", {
        title: "Title Three",
        archived: true,
      });

      const all = service.getAllMetadata();

      expect(all).toEqual({
        "session-1": { customTitle: "Title One" },
        "session-2": { isArchived: true },
        "session-3": { customTitle: "Title Three", isArchived: true },
      });

      // Verify it's a copy (modifying shouldn't affect internal state)
      all["session-4"] = { customTitle: "Injected" };
      expect(service.getMetadata("session-4")).toBeUndefined();
    });
  });

  describe("concurrent operations", () => {
    it("handles concurrent updates gracefully", async () => {
      await service.initialize();

      // Fire off multiple concurrent updates
      await Promise.all([
        service.setTitle("session-1", "Title 1"),
        service.setArchived("session-2", true),
        service.updateMetadata("session-3", {
          title: "Title 3",
          archived: true,
        }),
        service.setTitle("session-1", "Updated Title 1"), // Update session-1 again
      ]);

      // All should be persisted
      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.customTitle).toBe(
        "Updated Title 1",
      );
      expect(newService.getMetadata("session-2")?.isArchived).toBe(true);
      expect(newService.getMetadata("session-3")).toEqual({
        customTitle: "Title 3",
        isArchived: true,
      });
    });
  });

  describe("file path", () => {
    it("returns the correct file path", async () => {
      expect(service.getFilePath()).toBe(
        join(testDir, "session-metadata.json"),
      );
    });
  });

  describe("setExecutor", () => {
    it("sets executor for a session", async () => {
      await service.initialize();

      await service.setExecutor("session-1", "my-remote-server");

      expect(service.getMetadata("session-1")).toEqual({
        executor: "my-remote-server",
      });
    });

    it("clears executor when undefined provided", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "my-remote-server");

      await service.setExecutor("session-1", undefined);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("clears executor when empty string provided", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "my-remote-server");

      await service.setExecutor("session-1", "");

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves other fields when updating executor", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Title");
      await service.setArchived("session-1", true);

      await service.setExecutor("session-1", "remote-host");

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Title",
        isArchived: true,
        executor: "remote-host",
      });
    });

    it("persists executor to disk", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "persistent-executor");

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.executor).toBe(
        "persistent-executor",
      );
    });
  });

  describe("getExecutor", () => {
    it("returns executor for a session", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "my-server");

      expect(service.getExecutor("session-1")).toBe("my-server");
    });

    it("returns undefined for session without executor", async () => {
      await service.initialize();
      await service.setTitle("session-1", "No Executor");

      expect(service.getExecutor("session-1")).toBeUndefined();
    });

    it("returns undefined for unknown session", async () => {
      await service.initialize();

      expect(service.getExecutor("nonexistent")).toBeUndefined();
    });
  });

  describe("executor with other metadata", () => {
    it("loads executor from existing state", async () => {
      const existingState = {
        version: 1,
        sessions: {
          "session-1": { executor: "saved-host" },
          "session-2": { customTitle: "Title", executor: "another-host" },
        },
      };
      await writeFile(
        join(testDir, "session-metadata.json"),
        JSON.stringify(existingState),
      );

      await service.initialize();

      expect(service.getExecutor("session-1")).toBe("saved-host");
      expect(service.getExecutor("session-2")).toBe("another-host");
      expect(service.getMetadata("session-2")).toEqual({
        customTitle: "Title",
        executor: "another-host",
      });
    });

    it("preserves executor when updating other fields", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "my-executor");

      await service.setTitle("session-1", "New Title");
      await service.setArchived("session-1", true);
      await service.setStarred("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "New Title",
        isArchived: true,
        isStarred: true,
        executor: "my-executor",
      });
    });

    it("clears executor when session is cleared", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "to-clear");
      await service.setTitle("session-1", "Title");

      await service.clearSession("session-1");

      expect(service.getExecutor("session-1")).toBeUndefined();
      expect(service.getMetadata("session-1")).toBeUndefined();
    });
  });
});
