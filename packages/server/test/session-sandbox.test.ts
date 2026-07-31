import { spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataService } from "../src/metadata/SessionMetadataService.js";
import {
  getClaudeSandboxProjectDir,
  getCodexSandboxSessionsDir,
  getSessionSandboxSettingsError,
  prepareSessionSandbox,
  probeSessionSandboxAvailability,
  type SessionSandboxSpawn,
} from "../src/session-sandbox.js";
import { ClaudeSessionReader } from "../src/sessions/reader.js";
import { ClaudeProvider } from "../src/sdk/providers/claude.js";
import type { UrlProjectId } from "@yep-anywhere/shared";

const hostSandboxAvailable =
  (await probeSessionSandboxAvailability()).state === "available";

async function runSandboxed(spawnOptions: SessionSandboxSpawn): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = (() => {
      try {
        return spawn(spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          stdio: spawnOptions.stdio,
        });
      } finally {
        spawnOptions.release();
      }
    })();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim() ||
            `sandbox child exited with ${signal ? `signal ${signal}` : `status ${code}`}`,
        ),
      );
    });
  });
}

describe("session sandbox", () => {
  const roots: string[] = [];
  const linuxIt = process.platform === "linux" ? it : it.skip;
  const t = hostSandboxAvailable ? it : it.skip;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true })),
    );
  });

  async function fixtureRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "ya-session-sandbox-"));
    roots.push(root);
    return root;
  }

  it("reports unsupported platforms without probing Bubblewrap", async () => {
    await expect(
      probeSessionSandboxAvailability({ platform: "darwin" }),
    ).resolves.toEqual({
      state: "unsupported-platform",
      platform: "darwin",
    });
    await expect(
      probeSessionSandboxAvailability({ platform: "win32" }),
    ).resolves.toEqual({
      state: "unsupported-platform",
      platform: "win32",
    });
  });

  it("distinguishes missing, untrusted, and unusable Linux backends", async () => {
    const root = await fixtureRoot();
    const missingPath = join(root, "missing-bwrap");
    const untrustedPath = join(root, "untrusted-bwrap");
    await writeFile(untrustedPath, "#!/bin/sh\nexit 0\n");

    await expect(
      probeSessionSandboxAvailability({
        platform: "linux",
        bwrapPath: missingPath,
      }),
    ).resolves.toMatchObject({
      state: "missing-bubblewrap",
      platform: "linux",
      backend: "bubblewrap",
    });
    await expect(
      probeSessionSandboxAvailability({
        platform: "linux",
        bwrapPath: untrustedPath,
      }),
    ).resolves.toMatchObject({
      state: "untrusted-bubblewrap",
      platform: "linux",
      backend: "bubblewrap",
    });
    await expect(
      probeSessionSandboxAvailability({
        platform: "linux",
        bwrapPath: "/usr/bin/false",
      }),
    ).resolves.toMatchObject({
      state: "probe-failed",
      platform: "linux",
      backend: "bubblewrap",
    });
  });

  t(
    "allows project and private writes while denying outside aliases",
    async () => {
      const root = await fixtureRoot();
      const projectPath = join(root, "project");
      const outsidePath = join(root, "outside");
      const stateRoot = join(root, "state");
      const sourceConfig = join(root, "claude-source");
      const linkedSkills = join(outsidePath, "skills");
      await Promise.all([
        mkdir(projectPath),
        mkdir(outsidePath),
        mkdir(sourceConfig),
      ]);
      await mkdir(linkedSkills);
      await writeFile(join(outsidePath, "sentinel.txt"), "unchanged\n");
      await writeFile(
        join(sourceConfig, "settings.json"),
        '{"theme":"dark"}\n',
      );
      await symlink(linkedSkills, join(sourceConfig, "skills"));
      await symlink(outsidePath, join(projectPath, "outside-link"));
      vi.stubEnv("CLAUDE_CONFIG_DIR", sourceConfig);

      const runtime = await prepareSessionSandbox({
        level: "project-write",
        provider: "claude",
        projectPath,
        stateKey: "test-session",
        stateRoot,
      });
      expect(runtime?.enforcement).toMatchObject({
        requested: "project-write",
        effective: "project-write",
        state: "enforced",
        hostBackend: "bubblewrap:bwrap",
      });
      const privateConfig = join(
        stateRoot,
        "test-session",
        "claude",
        "settings.json",
      );
      expect((await lstat(privateConfig)).ino).not.toBe(
        (await lstat(join(sourceConfig, "settings.json"))).ino,
      );
      expect(
        (
          await lstat(join(stateRoot, "test-session", "claude", "skills"))
        ).isSymbolicLink(),
      ).toBe(true);

      const script = `
      set -eu
      printf 'inside\\n' > "$PROJECT_PATH/inside.txt"
      printf 'private\\n' > "$CLAUDE_CONFIG_DIR/settings.json"
      printf 'temporary\\n' > "$TMPDIR/sandbox-test"
      grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status
      grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status
      grep -Eq '^CapPrm:[[:space:]]+0+$' /proc/self/status
      if printf 'escape\\n' > "$OUTSIDE_PATH/direct.txt" 2>/dev/null; then
        exit 10
      fi
      if printf 'escape\\n' > "$PROJECT_PATH/outside-link/linked.txt" 2>/dev/null; then
        exit 11
      fi
      if printf 'escape\\n' > "$CLAUDE_CONFIG_DIR/skills/linked.txt" 2>/dev/null; then
        exit 12
      fi
      if ln "$OUTSIDE_PATH/sentinel.txt" "$PROJECT_PATH/outside-hardlink" 2>/dev/null; then
        exit 13
      fi
    `;
      if (!runtime) throw new Error("sandbox runtime was not prepared");
      await runSandboxed(
        runtime.wrapSpawn("/bin/sh", ["-c", script], {
          ...process.env,
          PROJECT_PATH: projectPath,
          OUTSIDE_PATH: outsidePath,
        }),
      );

      expect(await readFile(join(projectPath, "inside.txt"), "utf8")).toBe(
        "inside\n",
      );
      expect(await readFile(join(outsidePath, "sentinel.txt"), "utf8")).toBe(
        "unchanged\n",
      );
      expect(await readFile(join(sourceConfig, "settings.json"), "utf8")).toBe(
        '{"theme":"dark"}\n',
      );
      await expect(
        lstat(join(outsidePath, "direct.txt")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        lstat(join(outsidePath, "linked.txt")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        lstat(join(projectPath, "outside-hardlink")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  linuxIt(
    "fails closed with install guidance when Bubblewrap is absent",
    async () => {
      const root = await fixtureRoot();
      const projectPath = join(root, "project");
      await mkdir(projectPath);

      await expect(
        prepareSessionSandbox({
          level: "project-write",
          provider: "codex",
          projectPath,
          stateKey: "missing-bwrap",
          stateRoot: join(root, "state"),
          bwrapPath: join(root, "not-installed", "bwrap"),
        }),
      ).rejects.toThrow(/sudo dnf install bubblewrap/);
    },
  );

  linuxIt(
    "distinguishes an unusable Bubblewrap runtime from a missing package",
    async () => {
      const root = await fixtureRoot();
      const projectPath = join(root, "project");
      await mkdir(projectPath);

      const preparation = prepareSessionSandbox({
        level: "project-write",
        provider: "codex",
        projectPath,
        stateKey: "broken-bwrap",
        stateRoot: join(root, "state"),
        bwrapPath: "/bin/false",
      });
      await expect(preparation).rejects.toThrow(
        /installed but could not enforce the session sandbox/,
      );
      await expect(preparation).rejects.not.toThrow(/dnf install/);
    },
  );

  it("rejects unsupported providers and remote executors before launch", async () => {
    const root = await fixtureRoot();
    const projectPath = join(root, "project");
    await mkdir(projectPath);

    await expect(
      prepareSessionSandbox({
        level: "project-write",
        provider: "gemini",
        projectPath,
        stateKey: "unsupported-provider",
        stateRoot: join(root, "state-provider"),
      }),
    ).rejects.toThrow(/not yet supported for provider gemini/);
    await expect(
      prepareSessionSandbox({
        level: "project-write",
        provider: "claude",
        projectPath,
        executor: "build-host",
        stateKey: "remote-provider",
        stateRoot: join(root, "state-remote"),
      }),
    ).rejects.toThrow(/not supported for remote executors/);
  });

  it("allows sandboxed fork helpers but rejects side-session helpers", () => {
    expect(
      getSessionSandboxSettingsError("project-write", "side-session"),
    ).toMatch(/side-session helpers are unavailable/);
    expect(getSessionSandboxSettingsError("project-write", "fork")).toBe(
      undefined,
    );
    expect(getSessionSandboxSettingsError("project-write", "native")).toBe(
      undefined,
    );
    expect(getSessionSandboxSettingsError("none", "side-session")).toBe(
      undefined,
    );
  });

  t("reuses one project state key across providers", async () => {
    const root = await fixtureRoot();
    const projectPath = join(root, "project");
    const projectLink = join(root, "project-link");
    const stateRoot = join(root, "state");
    await mkdir(projectPath);
    await symlink(projectPath, projectLink);

    const claude = await prepareSessionSandbox({
      level: "project-write",
      provider: "claude",
      projectPath,
      stateRoot,
    });
    const codex = await prepareSessionSandbox({
      level: "project-write",
      provider: "codex",
      projectPath: projectLink,
      stateRoot,
    });

    expect(claude?.stateKey).toMatch(/^project-[0-9a-f]{32}$/);
    expect(codex?.stateKey).toBe(claude?.stateKey);
    expect(codex?.projectPath).toBe(projectPath);
  });

  t("refuses to follow a replaced project directory before launch", async () => {
    const root = await fixtureRoot();
    const projectPath = join(root, "project");
    const originalPath = join(root, "project-original");
    await mkdir(projectPath);
    const runtime = await prepareSessionSandbox({
      level: "project-write",
      provider: "codex",
      projectPath,
      stateRoot: join(root, "state"),
    });
    if (!runtime) throw new Error("sandbox runtime was not prepared");

    await rename(projectPath, originalPath);
    await mkdir(projectPath);

    expect(() =>
      runtime.wrapSpawn("/bin/true", [], process.env),
    ).toThrow(/project boundary changed.*refusing to follow/i);
  });

  t("keeps the anchored project when its path changes before spawn", async () => {
    const root = await fixtureRoot();
    const projectPath = join(root, "project");
    const originalPath = join(root, "project-original");
    await mkdir(projectPath);
    const runtime = await prepareSessionSandbox({
      level: "project-write",
      provider: "codex",
      projectPath,
      stateRoot: join(root, "state"),
    });
    if (!runtime) throw new Error("sandbox runtime was not prepared");
    const spawnOptions = runtime.wrapSpawn(
      "/bin/sh",
      ["-c", "printf anchored > anchored.txt"],
      process.env,
    );

    await rename(projectPath, originalPath);
    await mkdir(projectPath);
    await runSandboxed(spawnOptions);

    await expect(
      readFile(join(originalPath, "anchored.txt"), "utf8"),
    ).resolves.toBe("anchored");
    await expect(
      readFile(join(projectPath, "anchored.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  t("forks Claude transcripts inside the inherited private state", async () => {
    const root = await fixtureRoot();
    const projectPath = join(root, "project");
    const stateRoot = join(root, "state");
    const sourceSessionId = "11111111-1111-4111-8111-111111111111";
    await mkdir(projectPath);
    const runtime = await prepareSessionSandbox({
      level: "project-write",
      provider: "claude",
      projectPath,
      stateRoot,
    });
    if (!runtime) throw new Error("sandbox runtime was not prepared");
    await mkdir(runtime.transcriptDir, { recursive: true });
    await writeFile(
      join(runtime.transcriptDir, `${sourceSessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "user",
          uuid: "22222222-2222-4222-8222-222222222222",
          parentUuid: null,
          sessionId: sourceSessionId,
          cwd: projectPath,
          timestamp: "2026-07-28T00:00:00.000Z",
          message: { role: "user", content: "Fork this privately" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "33333333-3333-4333-8333-333333333333",
          parentUuid: "22222222-2222-4222-8222-222222222222",
          sessionId: sourceSessionId,
          cwd: projectPath,
          timestamp: "2026-07-28T00:00:01.000Z",
          message: { role: "assistant", content: "Ready" },
        }),
      ].join("\n")}\n`,
    );

    const fork = await new ClaudeProvider().forkSession({
      sessionId: sourceSessionId,
      cwd: projectPath,
      title: "Private fork",
      sessionSandbox: runtime,
    });

    const files = await readdir(runtime.transcriptDir);
    expect(files).toContain(`${sourceSessionId}.jsonl`);
    expect(files).toContain(`${fork.sessionId}.jsonl`);
    const forked = await readFile(
      join(runtime.transcriptDir, `${fork.sessionId}.jsonl`),
      "utf8",
    );
    expect(forked).toContain(`"sessionId":"${fork.sessionId}"`);
    expect(forked).toContain('"customTitle":"Private fork"');
  });

  t("refuses agent-controlled transcript directory symlinks", async () => {
    const root = await fixtureRoot();
    const projectPath = join(root, "project");
    const stateRoot = join(root, "state");
    const outsidePath = join(root, "outside");
    await Promise.all([mkdir(projectPath), mkdir(outsidePath)]);
    const runtime = await prepareSessionSandbox({
      level: "project-write",
      provider: "claude",
      projectPath,
      stateRoot,
    });
    if (!runtime) throw new Error("sandbox runtime was not prepared");
    await mkdir(dirname(runtime.transcriptDir), { recursive: true });
    await symlink(outsidePath, runtime.transcriptDir);

    await expect(runtime.openTranscriptDirectory()).rejects.toBeInstanceOf(
      Error,
    );
  });

  it("derives stable private transcript roots from persisted metadata", () => {
    expect(
      getClaudeSandboxProjectDir({
        dataDir: "/var/lib/ya",
        stateKey: "session-key",
        projectPath: "/work/example",
      }),
    ).toBe(
      "/var/lib/ya/session-sandboxes/session-key/claude/projects/-work-example",
    );
    expect(
      getCodexSandboxSessionsDir({
        dataDir: "/var/lib/ya",
        stateKey: "session-key",
      }),
    ).toBe("/var/lib/ya/session-sandboxes/session-key/codex/sessions");
  });

  it("reconstructs a private transcript reader after metadata reload", async () => {
    const dataDir = await fixtureRoot();
    const projectPath = join(dataDir, "project");
    const projectId = "sandbox-project" as UrlProjectId;
    const stateKey = "restart-session";
    const privateSessionDir = getClaudeSandboxProjectDir({
      dataDir,
      stateKey,
      projectPath,
    });
    const globalSessionDir = join(dataDir, "global-sessions");
    await Promise.all([
      mkdir(projectPath),
      mkdir(privateSessionDir, { recursive: true }),
      mkdir(globalSessionDir),
    ]);
    await writeFile(
      join(privateSessionDir, "replayable-session.jsonl"),
      `${JSON.stringify({
        type: "user",
        uuid: "user-1",
        sessionId: "replayable-session",
        cwd: projectPath,
        timestamp: "2026-07-28T00:00:00.000Z",
        message: { role: "user", content: "Replay after restart" },
      })}\n`,
    );

    const writer = new SessionMetadataService({ dataDir });
    await writer.initialize();
    await writer.setSessionSandbox("replayable-session", {
      level: "project-write",
      stateKey,
      projectPath,
      projectId,
      provider: "claude",
    });

    const reloaded = new SessionMetadataService({ dataDir });
    await reloaded.initialize();
    const metadata = reloaded.getMetadata("replayable-session");
    expect(metadata).toMatchObject({
      sandboxLevel: "project-write",
      sandboxStateKey: stateKey,
      sandboxProjectPath: projectPath,
      workingProjectId: projectId,
      provider: "claude",
    });

    const reader = new ClaudeSessionReader({
      sessionDir: globalSessionDir,
      additionalDirs: [
        getClaudeSandboxProjectDir({
          dataDir,
          stateKey: metadata?.sandboxStateKey ?? "",
          projectPath: metadata?.sandboxProjectPath ?? "",
        }),
      ],
      summaryParserWorkerMode: "off",
    });
    const sessions = await reader.listSessions(projectId);
    expect(sessions).toEqual([
      expect.objectContaining({
        id: "replayable-session",
        title: "Replay after restart",
      }),
    ]);
    // getSessionFilePath probes every candidate dir (here, an additionalDir)
    // and returns null when no on-disk file matches.
    expect(await reader.getSessionFilePath("replayable-session")).toBe(
      join(privateSessionDir, "replayable-session.jsonl"),
    );
    expect(await reader.getSessionFilePath("missing-session")).toBeNull();
    await reader.close();
  });
});
