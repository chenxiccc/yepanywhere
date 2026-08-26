import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedCodexTranscriptMirrorService } from "../../../src/sdk/providers/managed-codex-transcript-mirror.js";
import { ManagedSshTarget } from "../../../src/sdk/providers/managed-ssh-target.js";
import type { ManagedSshWorkspace } from "../../../src/sdk/providers/managed-ssh-workspace.js";

const fakeSshPath = new URL("./fixtures/fake-managed-ssh.mjs", import.meta.url)
  .pathname;
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "managed Codex transcript mirror",
  () => {
    it("discovers from metadata, syncs suffixes, and cold-loads an isolated mirror", async () => {
      const fixture = await createFixture("managed-codex-mirror-");
      const providerSessionId = "019c1234-5678-7abc-8def-0123456789ab";
      const yaSessionId = "ya-session-canonical";
      const rolloutPath = await writeRollout(
        fixture.workspace,
        providerSessionId,
        "rollout-first",
        [userEntry("first remote prompt")],
      );
      const initialBytes = (await stat(rolloutPath)).size;
      const ordinaryCodexDirectory = join(
        fixture.directory,
        "ordinary-codex",
        "sessions",
      );
      await mkdir(ordinaryCodexDirectory, { recursive: true });
      await writeFile(join(ordinaryCodexDirectory, "sentinel"), "unchanged\n");

      const service = await ManagedCodexTranscriptMirrorService.open({
        dataDir: fixture.dataDir,
      });
      const first = await service.syncSession({
        yaSessionId,
        controllerProjectId: fixture.projectId,
        targetId: "fixture-linux",
        target: fixture.target,
        workspace: fixture.workspace,
        providerSessionId,
        runnerGeneration: "runner-one",
      });
      expect(first.bytesTransferred).toBe(initialBytes);
      expect(first.record).toMatchObject({
        yaSessionId,
        providerSessionId,
        syncState: "current",
        transferredBytes: initialBytes,
        localCompleteBytes: initialBytes,
      });

      const suffix = `${JSON.stringify(assistantEntry("visible remote response"))}\n`;
      await appendFile(rolloutPath, suffix);
      const second = await service.syncSession({
        yaSessionId,
        controllerProjectId: fixture.projectId,
        targetId: "fixture-linux",
        target: fixture.target,
        workspace: fixture.workspace,
        providerSessionId,
        runnerGeneration: "runner-one",
      });
      expect(second.bytesTransferred).toBe(Buffer.byteLength(suffix));
      expect(second.record.transferredBytes).toBe(
        initialBytes + Buffer.byteLength(suffix),
      );

      const restarted = await ManagedCodexTranscriptMirrorService.open({
        dataDir: fixture.dataDir,
      });
      expect(
        restarted.listRecords().map((record) => record.yaSessionId),
      ).toEqual([yaSessionId]);
      const loaded = await restarted.loadSession(yaSessionId);
      expect(loaded?.summary.id).toBe(yaSessionId);
      expect(loaded?.summary.projectId).toBe(fixture.projectId);
      expect(JSON.stringify(loaded?.data)).toContain("visible remote response");
      await expect(
        readFile(join(ordinaryCodexDirectory, "sentinel"), "utf8"),
      ).resolves.toBe("unchanged\n");

      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      const replacementPath = await writeRollout(
        fixture.workspace,
        providerSessionId,
        "rollout-replacement",
        [
          userEntry("replacement prompt"),
          assistantEntry("replacement generation response"),
        ],
      );
      const priorGeneration = second.record.rolloutGeneration;
      const replaced = await restarted.syncSession({
        yaSessionId,
        controllerProjectId: fixture.projectId,
        targetId: "fixture-linux",
        target: fixture.target,
        workspace: fixture.workspace,
        providerSessionId,
        runnerGeneration: "runner-two",
      });
      expect(replaced.record.rolloutGeneration).not.toBe(priorGeneration);
      expect(replaced.bytesTransferred).toBe(
        (await stat(replacementPath)).size,
      );
      expect(replaced.record.runnerGeneration).toBe("runner-two");
      const replacement = await restarted.loadSession(yaSessionId);
      expect(JSON.stringify(replacement?.data)).toContain(
        "replacement generation response",
      );
    });

    it("retains a bounded partial line and joins concurrent synchronization", async () => {
      const fixture = await createFixture("managed-codex-mirror-bounded-");
      const providerSessionId = "019c2234-5678-7abc-8def-0123456789ab";
      const yaSessionId = "ya-session-bounded";
      const rolloutPath = await writeRollout(
        fixture.workspace,
        providerSessionId,
        "rollout-bounded",
        [assistantEntry("x".repeat(1200))],
      );
      const rolloutBytes = (await stat(rolloutPath)).size;
      const service = await ManagedCodexTranscriptMirrorService.open({
        dataDir: fixture.dataDir,
        maxSyncBytes: 128,
        maxSessionBytes: 4096,
        maxTotalBytes: 8192,
      });
      const options = {
        yaSessionId,
        controllerProjectId: fixture.projectId,
        targetId: "fixture-linux",
        target: fixture.target,
        workspace: fixture.workspace,
        providerSessionId,
      };
      const firstOwner = service.syncSession(options);
      const joinedOwner = service.syncSession(options);
      expect(joinedOwner).toBe(firstOwner);
      expect(() =>
        service.syncSession({
          ...options,
          providerSessionId: "019c3234-5678-7abc-8def-0123456789ab",
        }),
      ).toThrow("concurrent session binding changed");
      const first = await firstOwner;
      expect(first.record).toMatchObject({
        syncState: "behind",
        transferredBytes: 128,
      });
      expect(first.record.localCompleteBytes).toBeLessThanOrEqual(128);

      let totalTransferred = first.bytesTransferred;
      let latest = first;
      while (latest.record.syncState === "behind") {
        latest = await service.syncSession(options);
        totalTransferred += latest.bytesTransferred;
      }
      expect(totalTransferred).toBe(rolloutBytes);
      expect(latest.record.localCompleteBytes).toBe(rolloutBytes);
      expect(await service.loadSession(yaSessionId)).not.toBeNull();
    });
  },
);

async function createFixture(prefix: string): Promise<{
  directory: string;
  dataDir: string;
  target: ManagedSshTarget;
  workspace: ManagedSshWorkspace;
  projectId: ReturnType<typeof toUrlProjectId>;
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  const remoteRoot = join(directory, "remote");
  const remoteDirectory = join(remoteRoot, "workspaces", "workspace-one");
  const remoteWorktreePath = join(remoteDirectory, "worktree");
  await mkdir(remoteWorktreePath, { recursive: true, mode: 0o700 });
  return {
    directory,
    dataDir: join(directory, "app-data"),
    target: new ManagedSshTarget({
      hostAlias: "fixture-linux",
      remoteRoot,
      sshCommand: fakeSshPath,
      nodeCommand: process.execPath,
    }),
    workspace: {
      workspaceId: "workspace-one",
      repositoryIdentity: "repository-one",
      baseCommit: "a".repeat(40),
      branchRef: "refs/heads/ya-managed/workspace-one",
      remoteDirectory,
      remoteAnchorPath: join(remoteDirectory, "anchor.git"),
      remoteWorktreePath,
      source: {
        baseCommit: "a".repeat(40),
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        branch: "refs/heads/main",
      },
    },
    projectId: toUrlProjectId(join(directory, "controller-project")),
  };
}

async function writeRollout(
  workspace: ManagedSshWorkspace,
  providerSessionId: string,
  name: string,
  entries: unknown[],
): Promise<string> {
  const dateDirectory = join(
    workspace.remoteDirectory,
    "codex-home",
    "sessions",
    "2026",
    "08",
    "26",
  );
  await mkdir(dateDirectory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString();
  const lines = [
    {
      type: "session_meta",
      timestamp,
      payload: {
        id: providerSessionId,
        cwd: workspace.remoteWorktreePath,
        timestamp,
        model_provider: "openai",
        originator: "yep-anywhere",
        source: "exec",
      },
    },
    ...entries,
  ];
  const path = join(dateDirectory, `${name}-${providerSessionId}.jsonl`);
  await writeFile(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    { mode: 0o600 },
  );
  return path;
}

function userEntry(message: string): unknown {
  return {
    type: "event_msg",
    timestamp: new Date().toISOString(),
    payload: { type: "user_message", message },
  };
}

function assistantEntry(text: string): unknown {
  return {
    type: "response_item",
    timestamp: new Date().toISOString(),
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  };
}
