import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ManagedCodexAuthError,
  ManagedCodexAuthOwner,
} from "../../../src/sdk/providers/managed-codex-auth.js";

const fixtureCommand = new URL(
  "./fixtures/fake-codex-auth-owner.mjs",
  import.meta.url,
).pathname;
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ManagedCodexAuthOwner", () => {
  it("projects only file-backed ChatGPT access auth and serializes refresh", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "managed-codex-auth-"));
    temporaryPaths.push(codexHome);
    const refreshLog = join(codexHome, "refresh.log");
    const initialToken = jwt("account-one", "plus", "initial");
    const refreshedToken = jwt("account-one", "plus", "refreshed");
    await writeAuth(codexHome, initialToken, "account-one");
    const owner = new ManagedCodexAuthOwner({
      codexHome,
      codexCommand: process.execPath,
      codexArguments: [fixtureCommand],
      expectedCodexVersion: "0.149.0",
      requestTimeoutMs: 1_000,
      spawnEnvironment: {
        ...process.env,
        YA_FAKE_CODEX_REFRESH_ACCESS_TOKEN: refreshedToken,
        YA_FAKE_CODEX_REFRESH_DELAY_MS: "30",
        YA_FAKE_CODEX_REFRESH_LOG: refreshLog,
      },
    });

    const initial = await owner.preflight();
    expect(initial).toEqual({
      accessToken: initialToken,
      chatgptAccountId: "account-one",
      chatgptPlanType: "plus",
    });
    const [first, second] = await Promise.all([
      owner.refresh("account-one"),
      owner.refresh("account-one"),
    ]);
    expect(first.accessToken).toBe(refreshedToken);
    expect(second.accessToken).toBe(refreshedToken);
    const markers = (await readFile(refreshLog, "utf8")).trim().split("\n");
    expect(markers.map((line) => line.split(":")[0])).toEqual([
      "start",
      "end",
      "start",
      "end",
    ]);
    expect((await readAuth(codexHome)).tokens.refresh_token).toBe(
      "controller-refresh-secret",
    );
  });

  it("reports distinct store, login, version, account, and timeout failures", async () => {
    const codexHome = await mkdtemp(
      join(tmpdir(), "managed-codex-auth-failures-"),
    );
    temporaryPaths.push(codexHome);
    const token = jwt("account-one", "plus", "initial");
    await writeAuth(codexHome, token, "account-one");

    await expect(
      owner(codexHome, {
        YA_FAKE_CODEX_CREDENTIAL_STORE: "keyring",
      }).preflight(),
    ).rejects.toMatchObject({ code: "credential-store-unsupported" });
    await expect(
      owner(codexHome, { YA_FAKE_CODEX_ACCOUNT_TYPE: "none" }).preflight(),
    ).rejects.toMatchObject({ code: "chatgpt-login-missing" });
    await expect(
      owner(codexHome, { YA_FAKE_CODEX_VERSION: "0.148.0" }).preflight(),
    ).rejects.toMatchObject({ code: "codex-version-incompatible" });

    const active = owner(codexHome);
    await active.preflight();
    await expect(active.refresh("different-account")).rejects.toMatchObject({
      code: "auth-account-mismatch",
    });

    const hanging = owner(
      codexHome,
      { YA_FAKE_CODEX_REFRESH_HANG: "1" },
      1_000,
    );
    await hanging.preflight();
    await expect(hanging.refresh("account-one")).rejects.toMatchObject({
      code: "auth-refresh-timeout",
    });

    await rm(join(codexHome, "auth.json"));
    await expect(owner(codexHome).preflight()).rejects.toBeInstanceOf(
      ManagedCodexAuthError,
    );
    await expect(owner(codexHome).preflight()).rejects.toMatchObject({
      code: "chatgpt-login-missing",
    });
  });
});

function owner(
  codexHome: string,
  environment: NodeJS.ProcessEnv = {},
  requestTimeoutMs = 1_000,
): ManagedCodexAuthOwner {
  return new ManagedCodexAuthOwner({
    codexHome,
    codexCommand: process.execPath,
    codexArguments: [fixtureCommand],
    expectedCodexVersion: "0.149.0",
    requestTimeoutMs,
    spawnEnvironment: { ...process.env, ...environment },
  });
}

async function writeAuth(
  codexHome: string,
  accessToken: string,
  accountId: string,
): Promise<void> {
  await writeFile(
    join(codexHome, "auth.json"),
    `${JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: accessToken,
        refresh_token: "controller-refresh-secret",
        account_id: accountId,
      },
    })}\n`,
    { mode: 0o600 },
  );
}

async function readAuth(codexHome: string): Promise<{
  tokens: { refresh_token: string };
}> {
  return JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
}

function jwt(accountId: string, planType: string, signature: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: planType,
    },
  })}.${signature}`;
}
