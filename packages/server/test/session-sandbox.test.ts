import { spawn } from "node:child_process";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataService } from "../src/metadata/SessionMetadataService.js";
import { AuthService } from "../src/auth/AuthService.js";
import { SESSION_COOKIE_NAME } from "../src/auth/routes.js";
import { createAuthMiddleware } from "../src/middleware/auth.js";
import {
  applySessionSandboxAuthRequirement,
  getClaudeSandboxProjectDir,
  getCodexSandboxSessionsDir,
  getSessionSandboxSettingsError,
  prepareSessionSandbox as prepareSessionSandboxWithoutAuth,
  probeSessionSandboxAvailability,
  type SessionSandboxSpawn,
} from "../src/session-sandbox.js";
import { ClaudeSessionReader } from "../src/sessions/reader.js";
import { ClaudeProvider } from "../src/sdk/providers/claude.js";
import type { AgentProvider } from "../src/sdk/providers/types.js";
import { Supervisor } from "../src/supervisor/Supervisor.js";
import type { UrlProjectId } from "@yep-anywhere/shared";

const hostSandboxAvailable =
  (await probeSessionSandboxAvailability()).state === "available";
const trustedSystemFalseAvailable = await stat("/usr/bin/false")
  .then((info) => info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0)
  .catch(() => false);

function prepareSessionSandbox(
  options: Parameters<typeof prepareSessionSandboxWithoutAuth>[0],
) {
  return prepareSessionSandboxWithoutAuth({ ...options, authEnforced: true });
}

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
  const trustedFalseIt = trustedSystemFalseAvailable ? linuxIt : it.skip;
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

  it("reports and enforces the local authentication prerequisite", async () => {
    expect(
      applySessionSandboxAuthRequirement(
        {
          state: "available",
          platform: "linux",
          backend: "bubblewrap",
          version: "0.4.0",
        },
        false,
      ),
    ).toEqual({
      state: "auth-required",
      platform: "linux",
      backend: "bubblewrap",
      version: "0.4.0",
    });

    const root = await fixtureRoot();
    const projectPath = join(root, "project");
    await mkdir(projectPath);
    await expect(
      prepareSessionSandboxWithoutAuth({
        level: "project-write",
        provider: "codex",
        projectPath,
      }),
    ).rejects.toThrow(/requires password or desktop authentication/);
  });

  t("blocks auth relaxation throughout a pending sandbox launch", async () => {
    const root = await fixtureRoot();
    const projectPath = join(root, "project");
    await mkdir(projectPath);
    let rejectProviderStart!: (error: Error) => void;
    let markProviderStartEntered!: () => void;
    const providerStartEntered = new Promise<void>((resolve) => {
      markProviderStartEntered = resolve;
    });
    const provider = {
      name: "claude",
      displayName: "Claude",
      supportsPermissionMode: true,
      supportsThinkingToggle: true,
      supportsSlashCommands: true,
      supportsSteering: false,
      isInstalled: async () => true,
      isAuthenticated: async () => true,
      getAuthStatus: async () => ({
        installed: true,
        authenticated: true,
        enabled: true,
      }),
      getAvailableModels: async () => [],
      startSession: () => {
        markProviderStartEntered();
        return new Promise((_, reject) => {
          rejectProviderStart = reject;
        });
      },
    } as AgentProvider;
    const supervisor = new Supervisor({
      provider,
      isSessionSandboxAuthEnforced: () => true,
      sandboxStateRoot: join(root, "state"),
    });

    const launch = supervisor.startSession(
      projectPath,
      { text: "test" },
      undefined,
      { sandboxLevel: "project-write" },
    );
    await providerStartEntered;
    expect(supervisor.isAuthenticationRelaxationBlocked()).toBe(true);

    rejectProviderStart(new Error("test provider launch failure"));
    await expect(launch).rejects.toThrow("test provider launch failure");
    expect(supervisor.isAuthenticationRelaxationBlocked()).toBe(false);
  });

  it("distinguishes missing and untrusted Linux backends", async () => {
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
  });

  trustedFalseIt("reports a trusted but unusable Linux backend", async () => {
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

  t(
    "cannot authenticate with verifier material readable inside Bubblewrap",
    async () => {
      const root = await fixtureRoot();
      const projectPath = join(root, "project");
      const dataDir = join(projectPath, "readable-auth-state");
      await mkdir(projectPath);
      const authService = new AuthService({
        dataDir,
        cookieSecret: "sandbox-auth-test-secret",
      });
      await authService.initialize();
      await authService.enableAuth("sandbox-test-password");
      const sessionToken = await authService.createSession("sandbox-test");
      const authFilePath = authService.getFilePath();
      expect(await readFile(authFilePath, "utf8")).not.toContain(sessionToken);

      const authApp = new Hono();
      authApp.use("*", createAuthMiddleware({ authService }));
      authApp.post("/mutate", (c) => c.text("authorized"));
      let server!: ReturnType<typeof serve>;
      const port = await new Promise<number>((resolvePort) => {
        server = serve(
          { fetch: authApp.fetch, hostname: "127.0.0.1", port: 0 },
          (info) => resolvePort(info.port),
        );
      });
      const url = `http://127.0.0.1:${port}/mutate`;

      try {
        const authorized = await fetch(url, {
          method: "POST",
          headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
        });
        expect(authorized.status).toBe(200);

        const runtime = await prepareSessionSandbox({
          level: "project-write",
          networkFirewall: false,
          provider: "codex",
          projectPath,
          stateRoot: join(root, "state"),
        });
        if (!runtime) throw new Error("sandbox runtime was not prepared");
        const script = `
          const { readFile } = require("node:fs/promises");
          void (async () => {
            const [authPath, requestUrl] = process.argv.slice(1);
            const state = JSON.parse(await readFile(authPath, "utf8"));
            const verifier = Object.keys(state.sessions)[0];
            if (!verifier) throw new Error("missing persisted verifier");
            for (const name of ["AUTH_COOKIE_SECRET", "DESKTOP_AUTH_TOKEN", "YEP_PROVIDER_RUNTIME_TOKEN"]) {
              if (process.env[name] !== undefined) throw new Error(name + " leaked");
            }
            const response = await fetch(requestUrl, {
              method: "POST",
              headers: { Cookie: "${SESSION_COOKIE_NAME}=" + verifier },
            });
            if (response.status !== 401) throw new Error("verifier authorized status " + response.status);
          })();
        `;
        await runSandboxed(
          runtime.wrapSpawn(
            process.execPath,
            ["-e", script, authFilePath, url],
            {
              ...process.env,
              AUTH_COOKIE_SECRET: "must-not-reach-provider",
              DESKTOP_AUTH_TOKEN: "must-not-reach-provider",
              YEP_PROVIDER_RUNTIME_TOKEN: "must-not-reach-provider",
            },
          ),
        );
      } finally {
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => {
            if (error) rejectClose(error);
            else resolveClose();
          });
        });
      }
    },
  );

  t(
    "blocks host-local networking while retaining public IPv4 routing",
    async () => {
      const root = await fixtureRoot();
      const projectPath = join(root, "project");
      await mkdir(projectPath);
      const ipPath = [
        "/usr/sbin/ip",
        "/sbin/ip",
        "/usr/bin/ip",
        "/bin/ip",
      ].find(existsSync);
      if (!ipPath) throw new Error("sandbox probe found no route utility");

      const hostAddress = Object.values(networkInterfaces())
        .flatMap((addresses) => addresses ?? [])
        .find(
          (address) => address.family === "IPv4" && !address.internal,
        )?.address;
      const hostApp = new Hono();
      hostApp.get("/", (c) => c.text("host service"));
      let server!: ReturnType<typeof serve>;
      const port = await new Promise<number>((resolvePort) => {
        server = serve(
          { fetch: hostApp.fetch, hostname: "0.0.0.0", port: 0 },
          (info) => resolvePort(info.port),
        );
      });

      try {
        const runtime = await prepareSessionSandbox({
          level: "project-write",
          provider: "codex",
          projectPath,
          stateRoot: join(root, "state"),
        });
        if (!runtime) throw new Error("sandbox runtime was not prepared");
        expect(runtime.enforcement.networkFirewall).toBe(true);

        const script = `
        const { spawnSync } = require("node:child_process");
        const { readFileSync } = require("node:fs");
        void (async () => {
          const [ipPath, ...urls] = process.argv.slice(1);
          if (!readFileSync("/etc/resolv.conf", "utf8").includes("nameserver 10.0.2.3")) {
            throw new Error("sandbox DNS proxy is not configured");
          }
          if (spawnSync(ipPath, ["route", "get", "1.1.1.1"]).status !== 0) {
            throw new Error("public IPv4 route is unavailable");
          }
          if (spawnSync(ipPath, ["route", "get", "10.1.1.1"]).status === 0) {
            throw new Error("private IPv4 route is available");
          }
          if (spawnSync(ipPath, ["-6", "route", "get", "2606:4700:4700::1111"]).status === 0) {
            throw new Error("IPv6 route is available");
          }
          for (const url of urls) {
            try {
              await fetch(url, { signal: AbortSignal.timeout(2000) });
            } catch {
              continue;
            }
            throw new Error("host-local service was reachable at " + url);
          }
        })();
      `;
        const hostUrls = [
          `http://127.0.0.1:${port}/`,
          `http://10.0.2.2:${port}/`,
          ...(hostAddress ? [`http://${hostAddress}:${port}/`] : []),
        ];
        await runSandboxed(
          runtime.wrapSpawn(
            process.execPath,
            ["-e", script, ipPath, ...hostUrls],
            process.env,
          ),
        );
      } finally {
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => {
            if (error) rejectClose(error);
            else resolveClose();
          });
        });
      }
    },
  );

  t(
    "isolates abstract host sockets and masks provider control state",
    async () => {
      const root = await fixtureRoot();
      const projectPath = join(root, "project");
      const providerRuntimeDir = await mkdtemp(
        join(process.cwd(), ".ya-session-runtime-"),
      );
      roots.push(providerRuntimeDir);
      await mkdir(projectPath);
      await writeFile(join(providerRuntimeDir, "control-token"), "host-only\n");
      vi.stubEnv("YEP_PROVIDER_RUNTIME_DIR", "");
      vi.stubEnv("YEP_PROVIDER_HOST_RUNTIME_DIR", providerRuntimeDir);

      const abstractName = `ya-sandbox-${process.pid}-${Date.now()}`;
      const abstractServer = createNetServer();
      await new Promise<void>((resolveListen, rejectListen) => {
        abstractServer.once("error", rejectListen);
        abstractServer.listen(`\0${abstractName}`, resolveListen);
      });

      try {
        const runtime = await prepareSessionSandbox({
          level: "project-write",
          provider: "codex",
          projectPath,
          stateRoot: join(root, "state"),
        });
        if (!runtime) throw new Error("sandbox runtime was not prepared");
        const script = `
        const { createConnection } = require("node:net");
        const { existsSync } = require("node:fs");
        const [runtimeDir, abstractName] = process.argv.slice(1);
        if (existsSync(runtimeDir + "/control-token")) {
          throw new Error("provider runtime control state was visible");
        }
        for (const name of ["YEP_PROVIDER_RUNTIME_DIR", "YEP_PROVIDER_HOST_RUNTIME_DIR", "YEP_PROVIDER_RUNTIME_TOKEN"]) {
          if (process.env[name] !== undefined) throw new Error(name + " leaked");
        }
        const socket = createConnection({ path: "\\0" + abstractName });
        const timeout = setTimeout(() => socket.destroy(new Error("abstract socket probe timed out")), 2000);
        socket.once("connect", () => {
          clearTimeout(timeout);
          socket.destroy(new Error("host abstract socket was reachable"));
        });
        socket.once("error", (error) => {
          clearTimeout(timeout);
          if (error.message === "host abstract socket was reachable") throw error;
        });
      `;
        await runSandboxed(
          runtime.wrapSpawn(
            process.execPath,
            ["-e", script, providerRuntimeDir, abstractName],
            {
              ...process.env,
              YEP_PROVIDER_RUNTIME_TOKEN: "must-not-reach-provider",
            },
          ),
        );
        expect(
          await readFile(join(providerRuntimeDir, "control-token"), "utf8"),
        ).toBe("host-only\n");
      } finally {
        await new Promise<void>((resolveClose, rejectClose) => {
          abstractServer.close((error) => {
            if (error) rejectClose(error);
            else resolveClose();
          });
        });
      }
    },
  );

  trustedFalseIt(
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

  t(
    "refuses to follow a replaced project directory before launch",
    async () => {
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

      expect(() => runtime.wrapSpawn("/bin/true", [], process.env)).toThrow(
        /project boundary changed.*refusing to follow/i,
      );
    },
  );

  t(
    "keeps the anchored project when its path changes before spawn",
    async () => {
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
    },
  );

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
