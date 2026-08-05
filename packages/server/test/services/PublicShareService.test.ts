import type { AppSession, UrlProjectId } from "@yep-anywhere/shared";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PUBLIC_SHARE_SECRET_BITS,
  PUBLIC_SHARE_SECRET_BYTES,
  PublicShareService,
} from "../../src/services/PublicShareService.js";

const projectId = "cHJvamVjdA" as UrlProjectId;

function makeSession(overrides: Partial<AppSession> = {}): AppSession {
  return {
    id: "session-1",
    projectId,
    title: "Test session",
    fullTitle: "Test session",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:01:00.000Z",
    messageCount: 0,
    ownership: { owner: "self", processId: "proc-1" },
    provider: "codex",
    messages: [],
    pendingInputType: "tool-approval",
    activity: "waiting-input",
    lastSeenAt: "2026-05-01T00:00:30.000Z",
    hasUnread: true,
    ...overrides,
  } as AppSession;
}

describe("PublicShareService", () => {
  let service: PublicShareService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "public-shares-test-"));
    service = new PublicShareService({ dataDir: testDir });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("stores a 128-bit grant separately from its frozen body", async () => {
    const { secret, secretBits } = await service.createShare({
      mode: "frozen",
      title: "Share me",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });

    expect(secretBits).toBe(PUBLIC_SHARE_SECRET_BITS);
    expect(Buffer.from(secret, "base64url")).toHaveLength(
      PUBLIC_SHARE_SECRET_BYTES,
    );

    const persisted = await fs.readFile(
      path.join(testDir, "public-shares", "grants.json"),
      "utf-8",
    );
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("secretHash");
    expect(persisted).not.toContain("Test session");

    const stateDirectories = await fs.readdir(
      path.join(testDir, "public-shares", "shares"),
    );
    expect(stateDirectories).toHaveLength(1);
    const frozenDirectories = await fs.readdir(
      path.join(
        testDir,
        "public-shares",
        "shares",
        stateDirectories[0]!,
        "frozen",
      ),
    );
    expect(frozenDirectories).toHaveLength(1);
    await expect(
      fs.stat(
        path.join(
          testDir,
          "public-shares",
          "shares",
          stateDirectories[0]!,
          "frozen",
          frozenDirectories[0]!,
          "session.json.gz",
        ),
      ),
    ).resolves.toMatchObject({});
  });

  it("rejects missing, short, and guessed secrets", async () => {
    await service.createShare({
      mode: "frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });

    expect(service.getRecordBySecret("")).toBeNull();
    expect(service.getRecordBySecret("short")).toBeNull();
    expect(
      service.getRecordBySecret(Buffer.alloc(64, 1).toString("base64url")),
    ).toBeNull();
  });

  it("streams legacy aggregate records into independent revisions", async () => {
    const migrationDir = path.join(testDir, "migration");
    await fs.mkdir(migrationDir);
    const legacySecret = Buffer.alloc(64, 7).toString("base64url");
    const secretHash = createHash("sha512")
      .update(legacySecret, "utf8")
      .digest("base64url");
    const frozenSession = makeSession({
      title: 'Legacy "quoted" session',
      messages: [
        {
          type: "user",
          uuid: "legacy-message",
          message: {
            role: "user",
            content: `legacy } ], escaped \\ text docs/guide.md ${"x".repeat(70_000)}`,
          },
          timestamp: "2026-05-01T00:00:00.000Z",
        },
      ] as AppSession["messages"],
    });
    await fs.writeFile(
      path.join(migrationDir, "public-shares.json"),
      JSON.stringify({
        before: { ignored: true },
        shares: [
          {
            version: 1,
            secretHash,
            mode: "frozen",
            title: "Legacy",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:01:00.000Z",
            capturedAt: "2026-05-01T00:01:00.000Z",
            source: {
              projectId,
              sessionId: "session-1",
              projectName: "project",
              provider: "codex",
            },
            frozenSession,
          },
        ],
        after: ["trailing-field"],
      }),
      "utf8",
    );

    const migrated = new PublicShareService({ dataDir: migrationDir });
    await migrated.initialize();

    expect(migrated.getReadiness()).toEqual({ state: "ready", error: null });
    const migratedRecord = migrated.getRecordBySecret(legacySecret);
    expect(migratedRecord).toMatchObject({
      mode: "frozen",
      linkedFileMode: "live",
    });
    expect(migratedRecord).not.toHaveProperty("repairRequired");
    await expect(
      migrated.getFrozenShareBySecret(legacySecret),
    ).resolves.toMatchObject({
      session: { title: 'Legacy "quoted" session' },
    });
    await expect(
      migrated.getFrozenPresentation(migratedRecord!),
    ).resolves.toEqual({
      version: 1,
      authorizedPaths: ["docs/guide.md"],
    });
    await expect(
      fs.stat(path.join(migrationDir, "public-shares.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(migrationDir, "public-shares.legacy-backup.json")),
    ).resolves.toMatchObject({});
  });

  it("fails a malformed legacy migration without discarding its source", async () => {
    const migrationDir = path.join(testDir, "malformed-migration");
    await fs.mkdir(migrationDir);
    const legacyPath = path.join(migrationDir, "public-shares.json");
    await fs.writeFile(
      legacyPath,
      '{"shares":[{"version":1,"secretHash":"truncated"}',
      "utf8",
    );
    const migrated = new PublicShareService({ dataDir: migrationDir });

    await expect(migrated.initialize()).rejects.toThrow(
      /legacy|truncated|Invalid/i,
    );
    expect(migrated.getReadiness().state).toBe("failed");
    await expect(fs.stat(legacyPath)).resolves.toMatchObject({});
  });

  it("resumes a partially durable legacy migration without duplicate grants", async () => {
    const migrationDir = path.join(testDir, "resumed-migration");
    await fs.mkdir(migrationDir);
    const firstSecret = Buffer.alloc(64, 8).toString("base64url");
    const secondSecret = Buffer.alloc(64, 9).toString("base64url");
    const legacyRecord = (secret: string, title: string) => ({
      version: 1,
      secretHash: createHash("sha512")
        .update(secret, "utf8")
        .digest("base64url"),
      mode: "live",
      title,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:01:00.000Z",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const legacyPath = path.join(migrationDir, "public-shares.json");
    await fs.writeFile(
      legacyPath,
      JSON.stringify({ shares: [legacyRecord(firstSecret, "first")] }),
      "utf8",
    );
    const firstPass = new PublicShareService({ dataDir: migrationDir });
    await firstPass.initialize();

    await fs.rm(path.join(migrationDir, "public-shares", "migration.json"));
    await fs.rename(
      path.join(migrationDir, "public-shares.legacy-backup.json"),
      legacyPath,
    );
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        shares: [
          legacyRecord(firstSecret, "first"),
          legacyRecord(secondSecret, "second"),
        ],
      }),
      "utf8",
    );

    const resumed = new PublicShareService({ dataDir: migrationDir });
    await resumed.initialize();
    expect(resumed.getValidShareCount()).toBe(2);
    expect(resumed.getRecordBySecret(firstSecret)?.title).toBe("first");
    expect(resumed.getRecordBySecret(secondSecret)?.title).toBe("second");
    const stateDirectories = await fs.readdir(
      path.join(migrationDir, "public-shares", "shares"),
    );
    expect(stateDirectories).toHaveLength(1);
  });

  it("keeps broken legacy frozen bodies explicitly unavailable", async () => {
    const migrationDir = path.join(testDir, "repair-migration");
    await fs.mkdir(migrationDir);
    const legacySecret = Buffer.alloc(64, 10).toString("base64url");
    await fs.writeFile(
      path.join(migrationDir, "public-shares.json"),
      JSON.stringify({
        shares: [
          {
            version: 1,
            secretHash: createHash("sha512")
              .update(legacySecret, "utf8")
              .digest("base64url"),
            mode: "frozen",
            title: "broken",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:01:00.000Z",
            capturedAt: "2026-05-01T00:01:00.000Z",
            source: { projectId, sessionId: "session-1" },
            frozenSession: makeSession({ messageCount: 1, messages: [] }),
          },
        ],
      }),
      "utf8",
    );
    const migrated = new PublicShareService({ dataDir: migrationDir });
    await migrated.initialize();
    expect(migrated.getRecordBySecret(legacySecret)).toMatchObject({
      repairRequired: true,
    });
  });

  it("lets the kill switch win while legacy control state is opening", async () => {
    const migrationDir = path.join(testDir, "disabled-opening-migration");
    await fs.mkdir(migrationDir);
    const legacySecret = Buffer.alloc(64, 11).toString("base64url");
    await fs.writeFile(
      path.join(migrationDir, "public-shares.json"),
      JSON.stringify({
        shares: [
          {
            version: 1,
            secretHash: createHash("sha512")
              .update(legacySecret, "utf8")
              .digest("base64url"),
            mode: "live",
            title: "must stay revoked",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:01:00.000Z",
            source: { projectId, sessionId: "session-1" },
          },
        ],
      }),
      "utf8",
    );
    const migrated = new PublicShareService({ dataDir: migrationDir });

    const opening = migrated.initialize();
    const disabling = migrated.disableAndRevoke();
    await Promise.all([opening, disabling]);

    expect(migrated.getReadiness().state).toBe("disabled");
    expect(migrated.getRecordBySecret(legacySecret)).toBeNull();
    await migrated.enable();
    expect(migrated.getRecordBySecret(legacySecret)).toBeNull();
    await expect(
      fs.stat(path.join(migrationDir, "public-shares.legacy-backup.json")),
    ).resolves.toMatchObject({});
  });

  it("reuses one state-local revision for identical frozen links", async () => {
    const source = {
      projectId,
      sessionId: "session-1",
      projectName: "project",
      provider: "codex" as const,
    };
    const first = await service.createShare({
      mode: "frozen",
      source,
      snapshot: makeSession(),
    });
    const second = await service.createShare({
      mode: "frozen",
      source,
      snapshot: makeSession(),
    });

    const stateDirectories = await fs.readdir(
      path.join(testDir, "public-shares", "shares"),
    );
    expect(stateDirectories).toHaveLength(1);
    const revisions = await fs.readdir(
      path.join(
        testDir,
        "public-shares",
        "shares",
        stateDirectories[0]!,
        "frozen",
      ),
    );
    expect(revisions).toHaveLength(1);
    const revisionPath = path.join(
      testDir,
      "public-shares",
      "shares",
      stateDirectories[0]!,
      "frozen",
      revisions[0]!,
      "session.json.gz",
    );

    await service.revokeShare(first.record.shareId);
    await expect(fs.stat(revisionPath)).resolves.toMatchObject({});
    await service.revokeShare(second.record.shareId);
    await expect(
      fs.stat(
        path.join(testDir, "public-shares", "shares", stateDirectories[0]!),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("freezes project files only when the filesystem supports CoW", async () => {
    const projectRoot = path.join(testDir, "project");
    const outsideRoot = path.join(testDir, "outside");
    await fs.mkdir(projectRoot);
    await fs.mkdir(outsideRoot);
    await fs.writeFile(path.join(projectRoot, "note.txt"), "before", "utf8");
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "outside", "utf8");
    await fs.symlink(
      path.join(outsideRoot, "secret.txt"),
      path.join(projectRoot, "external-link.txt"),
    );
    const { secret } = await service.createShare({
      mode: "frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
      projectRoot,
    });
    const record = service.getRecordBySecret(secret)!;

    if (record.linkedFileMode === "cow") {
      await fs.writeFile(path.join(projectRoot, "note.txt"), "after", "utf8");
      await expect(
        fs.readFile(
          path.join(service.getFrozenProjectRoot(record)!, "note.txt"),
          "utf8",
        ),
      ).resolves.toBe("before");
      await expect(
        fs.lstat(
          path.join(service.getFrozenProjectRoot(record)!, "external-link.txt"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(record.linkedFileMode).toBe("live");
    }
  });

  it("does not reuse an older project snapshot for an unchanged transcript", async () => {
    const projectRoot = path.join(testDir, "project-revisions");
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "note.txt"), "first", "utf8");
    const source = {
      projectId,
      sessionId: "session-1",
      projectName: "project",
      provider: "codex" as const,
    };
    const first = await service.createShare({
      mode: "frozen",
      source,
      snapshot: makeSession(),
      projectRoot,
    });

    await fs.writeFile(path.join(projectRoot, "note.txt"), "second", "utf8");
    const second = await service.createShare({
      mode: "frozen",
      source,
      snapshot: makeSession(),
      projectRoot,
    });

    expect(second.record.revisionId).not.toBe(first.record.revisionId);
    if (
      first.record.linkedFileMode === "cow" &&
      second.record.linkedFileMode === "cow"
    ) {
      await expect(
        fs.readFile(
          path.join(service.getFrozenProjectRoot(first.record)!, "note.txt"),
          "utf8",
        ),
      ).resolves.toBe("first");
      await expect(
        fs.readFile(
          path.join(service.getFrozenProjectRoot(second.record)!, "note.txt"),
          "utf8",
        ),
      ).resolves.toBe("second");
    }
  });

  it("adopts a complete revision left before its state commit", async () => {
    const source = {
      projectId,
      sessionId: "session-1",
      projectName: "project",
      provider: "codex" as const,
    };
    await service.createShare({ mode: "live", source });
    await service.createShare({
      mode: "frozen",
      source,
      snapshot: makeSession(),
    });

    const grantsPath = path.join(testDir, "public-shares", "grants.json");
    const grantFile = JSON.parse(await fs.readFile(grantsPath, "utf8")) as {
      version: number;
      grants: Array<{
        mode: string;
        shareStateId: string;
        revisionId?: string;
      }>;
    };
    const liveGrant = grantFile.grants.find((grant) => grant.mode === "live")!;
    const frozenGrant = grantFile.grants.find(
      (grant) => grant.mode === "frozen",
    )!;
    const statePath = path.join(
      testDir,
      "public-shares",
      "shares",
      liveGrant.shareStateId,
      "state.json",
    );
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      revisions: Record<string, unknown>;
    };
    await fs.writeFile(
      grantsPath,
      JSON.stringify({ version: 2, grants: [liveGrant] }),
      "utf8",
    );
    await fs.writeFile(
      statePath,
      JSON.stringify({ ...state, revisions: {} }),
      "utf8",
    );

    const recovered = new PublicShareService({ dataDir: testDir });
    await recovered.initialize();
    await expect(
      recovered.createShare({
        mode: "frozen",
        source,
        snapshot: makeSession(),
      }),
    ).resolves.toMatchObject({ secretBits: 128 });
    const recoveredState = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      revisions: Record<string, unknown>;
    };
    expect(Object.keys(recoveredState.revisions)).toEqual([
      frozenGrant.revisionId,
    ]);
  });

  it("aborts a frozen share when project capture fails unexpectedly", async () => {
    await expect(
      service.createShare({
        mode: "frozen",
        source: {
          projectId,
          sessionId: "session-1",
          projectName: "project",
          provider: "codex",
        },
        snapshot: makeSession(),
        projectRoot: path.join(testDir, "missing-project"),
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(service.getValidShareCount()).toBe(0);
    await expect(
      fs.readdir(path.join(testDir, "public-shares", "shares")),
    ).resolves.toEqual([]);
  });

  it("does not resurrect grants after disable and re-enable", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });

    await expect(service.disableAndRevoke()).resolves.toBe(1);
    expect(service.getReadiness().state).toBe("disabled");
    expect(service.getRecordBySecret(secret)).toBeNull();

    await service.enable();
    expect(service.getReadiness().state).toBe("ready");
    expect(service.getRecordBySecret(secret)).toBeNull();
  });

  it("stores frozen shares as sanitized read-only snapshots", async () => {
    const session = makeSession({
      messages: [
        {
          type: "user",
          uuid: "message-1",
          message: { role: "user", content: "hello" },
          timestamp: "2026-05-01T00:00:00.000Z",
        },
      ] as AppSession["messages"],
    }) as AppSession & {
      heartbeatTurnText?: string;
      heartbeatTurnsAfterMinutes?: number;
      heartbeatTurnsEnabled?: boolean;
    };
    session.heartbeatTurnsEnabled = true;
    session.heartbeatTurnsAfterMinutes = 5;
    session.heartbeatTurnText = "heartbeat";

    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: session,
    });

    const share = await service.getFrozenShareBySecret(secret);
    expect(share?.share.mode).toBe("frozen");
    expect(share?.session.ownership).toEqual({ owner: "none" });
    expect(share?.session.messages).toHaveLength(1);
    expect(share?.session.pendingInputType).toBeUndefined();
    expect(share?.session.activity).toBeUndefined();
    expect(share?.session.lastSeenAt).toBeUndefined();
    expect(share?.session.hasUnread).toBeUndefined();
    expect(
      (share?.session as typeof session | undefined)?.heartbeatTurnsEnabled,
    ).toBeUndefined();
  });

  it("strips transcript display objects from frozen and live shares", async () => {
    const session = makeSession({
      transcriptDisplayObjects: [
        {
          id: "bang-1",
          kind: "bang-command",
          createdAt: "2026-05-01T00:00:30.000Z",
          placementAfterMessageId: "",
          command: "cat .env",
          cwd: "/private/project",
          status: "done",
          exitCode: 0,
          stdoutPreview: "SECRET=value",
        },
      ],
    });
    const frozen = await service.createShare({
      mode: "frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: session,
    });
    const live = await service.createShare({
      mode: "live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });

    expect(
      (await service.getFrozenShareBySecret(frozen.secret))?.session
        .transcriptDisplayObjects,
    ).toBeUndefined();
    expect(
      service.buildLiveResponse(
        service.getRecordBySecret(live.secret)!,
        session,
      ).session.transcriptDisplayObjects,
    ).toBeUndefined();
  });

  it("builds live responses from the current session", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const record = service.getRecordBySecret(secret);

    expect(record?.frozenSession).toBeUndefined();
    const response = service.buildLiveResponse(
      record!,
      makeSession({ updatedAt: "2026-05-01T00:02:00.000Z" }),
    );

    expect(response.share.mode).toBe("live");
    expect(response.share.updatedAt).toBe("2026-05-01T00:02:00.000Z");
    expect(response.session.ownership).toEqual({ owner: "none" });
  });

  it("summarizes and revokes all shares for a source session", async () => {
    await service.createShare({
      mode: "frozen",
      title: "Frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });
    await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    await service.createShare({
      mode: "live",
      title: "Other",
      source: {
        projectId,
        sessionId: "session-2",
        projectName: "project",
        provider: "codex",
      },
    });

    expect(service.getSessionShareStatus(projectId, "session-1")).toEqual({
      activeCount: 2,
      frozenCount: 1,
      liveCount: 1,
      activeViewerCount: 0,
      viewers: [],
    });

    await expect(
      service.revokeSessionShares(projectId, "session-1"),
    ).resolves.toEqual({
      activeCount: 0,
      frozenCount: 0,
      liveCount: 0,
      activeViewerCount: 0,
      viewers: [],
      revokedCount: 2,
    });
    expect(service.getSessionShareStatus(projectId, "session-2")).toEqual({
      activeCount: 1,
      frozenCount: 0,
      liveCount: 1,
      activeViewerCount: 0,
      viewers: [],
    });
  });

  it("freezes live shares as snapshots without changing their secrets", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });

    await expect(
      service.freezeSessionLiveShares(
        projectId,
        "session-1",
        makeSession({ updatedAt: "2026-05-01T00:03:00.000Z" }),
      ),
    ).resolves.toMatchObject({
      activeCount: 1,
      frozenCount: 1,
      liveCount: 0,
      convertedCount: 1,
    });

    const response = await service.getFrozenShareBySecret(secret);
    expect(response?.share.mode).toBe("frozen");
    expect(response?.session.updatedAt).toBe("2026-05-01T00:03:00.000Z");
  });

  it("freezes and disconnects individual viewer tokens", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const record = service.getRecordBySecret(secret);
    expect(record).not.toBeNull();
    service.recordViewerHeartbeat(record!, "viewer-one");

    await service.freezeSessionViewerToken(
      projectId,
      "session-1",
      "viewer-one",
      makeSession({ updatedAt: "2026-05-01T00:04:00.000Z" }),
    );
    const frozenRecord = service.getRecordBySecret(secret);
    expect(
      (await service.getViewerSnapshotResponse(frozenRecord!, "viewer-one"))
        ?.session.updatedAt,
    ).toBe("2026-05-01T00:04:00.000Z");
    expect(
      service.getSessionShareStatus(projectId, "session-1").viewers,
    ).toEqual([]);

    const firstViewerRevision =
      frozenRecord?.viewerSnapshots?.["viewer-one"]?.revisionId;
    expect(firstViewerRevision).toBeTruthy();
    await service.freezeSessionViewerToken(
      projectId,
      "session-1",
      "viewer-one",
      makeSession({ updatedAt: "2026-05-01T00:05:00.000Z" }),
    );
    const refrozenRecord = service.getRecordBySecret(secret)!;
    expect(refrozenRecord.viewerSnapshots?.["viewer-one"]?.revisionId).not.toBe(
      firstViewerRevision,
    );
    await expect(
      fs.stat(
        path.join(
          testDir,
          "public-shares",
          "shares",
          refrozenRecord.shareStateId,
          "frozen",
          firstViewerRevision!,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await service.disconnectSessionViewerToken(
      projectId,
      "session-1",
      "viewer-one",
    );
    const disconnectedRecord = service.getRecordBySecret(secret);
    expect(
      service.isViewerDisconnected(disconnectedRecord!, "viewer-one"),
    ).toBe(true);
    expect(
      await service.getViewerSnapshotResponse(
        disconnectedRecord!,
        "viewer-one",
      ),
    ).toBeNull();
  });

  it("counts active viewers by share secret", async () => {
    const first = await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const second = await service.createShare({
      mode: "frozen",
      title: "Frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });

    const firstRecord = service.getRecordBySecret(first.secret);
    const secondRecord = service.getRecordBySecret(second.secret);
    expect(firstRecord).not.toBeNull();
    expect(secondRecord).not.toBeNull();

    expect(service.recordViewerHeartbeat(firstRecord!, "viewer-one")).toBe(1);
    expect(service.recordViewerHeartbeat(firstRecord!, "viewer-two")).toBe(2);
    expect(service.recordViewerHeartbeat(firstRecord!, "bad id")).toBe(2);
    expect(service.recordViewerHeartbeat(secondRecord!, "viewer-three")).toBe(
      1,
    );

    expect(
      service.buildLiveResponse(firstRecord!, makeSession()).share
        .activeViewerCount,
    ).toBe(2);
    expect(service.getSessionShareStatus(projectId, "session-1")).toMatchObject(
      {
        activeViewerCount: 3,
      },
    );
  });

  it("keeps viewers active until they miss a session update grace period", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
      const { secret } = await service.createShare({
        mode: "live",
        title: "Live",
        source: {
          projectId,
          sessionId: "session-1",
          projectName: "project",
          provider: "codex",
        },
      });
      const record = service.getRecordBySecret(secret);
      expect(record).not.toBeNull();
      service.recordViewerHeartbeat(record!, "viewer-one");

      vi.setSystemTime(new Date("2026-05-01T00:01:00.000Z"));
      expect(
        service.getSessionShareStatus(projectId, "session-1").activeViewerCount,
      ).toBe(1);
      expect(
        service.getSessionShareStatus(projectId, "session-1", {
          sessionUpdatedAt: "2026-05-01T00:00:40.000Z",
        }).activeViewerCount,
      ).toBe(1);
      expect(
        service.getSessionShareStatus(projectId, "session-1", {
          sessionUpdatedAt: "2026-05-01T00:00:20.000Z",
        }).activeViewerCount,
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
