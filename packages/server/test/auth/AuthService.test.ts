import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../../src/auth/AuthService.js";

describe("AuthService file permissions", () => {
  let service: AuthService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-service-test-"));
    service = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-secret",
    });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("writes auth.json with 0600 permissions", async () => {
    if (process.platform === "win32") {
      return;
    }

    await service.createSession("test-agent");

    const filePath = path.join(testDir, "auth.json");
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("persists only a one-way verifier for each browser session", async () => {
    const sessionToken = await service.createSession("test-agent");
    const filePath = path.join(testDir, "auth.json");
    const content = await fs.readFile(filePath, "utf8");
    const persisted = JSON.parse(content) as {
      version: number;
      sessions: Record<string, unknown>;
    };
    const [verifier] = Object.keys(persisted.sessions);

    expect(persisted.version).toBe(2);
    expect(content).not.toContain(sessionToken);
    expect(verifier).toMatch(/^[0-9a-f]{64}$/);
    await expect(service.validateSession(verifier ?? "")).resolves.toBe(false);
    await expect(service.validateSession(sessionToken)).resolves.toBe(true);
  });

  it("invalidates raw version-1 session tokens during migration", async () => {
    const rawSessionToken = "a".repeat(64);
    const filePath = path.join(testDir, "auth.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        enabled: true,
        account: {
          passwordHash: "preserved-password-hash",
          createdAt: "2026-08-28T00:00:00.000Z",
        },
        sessions: {
          [rawSessionToken]: {
            createdAt: "2026-08-28T00:00:00.000Z",
            lastActiveAt: "2026-08-28T00:00:00.000Z",
          },
        },
      }),
    );

    const migrated = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-secret",
    });
    await migrated.initialize();

    await expect(migrated.validateSession(rawSessionToken)).resolves.toBe(
      false,
    );
    expect(migrated.isEnabled()).toBe(true);
    const content = await fs.readFile(filePath, "utf8");
    expect(content).not.toContain(rawSessionToken);
    expect(JSON.parse(content)).toMatchObject({ version: 2, sessions: {} });
  });

  it("tightens permissions on existing auth.json files at startup", async () => {
    if (process.platform === "win32") {
      return;
    }

    const filePath = path.join(testDir, "auth.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 1, sessions: {} }, null, 2),
      "utf-8",
    );
    await fs.chmod(filePath, 0o644);

    const newService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-secret",
    });
    await newService.initialize();

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
