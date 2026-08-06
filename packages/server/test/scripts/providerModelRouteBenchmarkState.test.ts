import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  persistedMetadataIncludesProvider,
  readOptionalBooleanSetting,
  readOptionalStringSetting,
  readPersistedServerSettings,
} from "../../scripts/benchmark-provider-model-route.js";
import type { ServerSettings } from "../../src/services/ServerSettingsService.js";

describe("provider model route benchmark state", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ya-provider-benchmark-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true });
  });

  it("uses defaults only when persisted files are absent", async () => {
    await expect(readPersistedServerSettings(dataDir)).resolves.toEqual({});
    await expect(
      persistedMetadataIncludesProvider(dataDir, "claude-ollama"),
    ).resolves.toBe(false);
  });

  it("rejects unsupported settings versions and malformed provider fields", async () => {
    await writeFile(
      join(dataDir, "server-settings.json"),
      JSON.stringify({ version: 3, settings: {} }),
    );
    await expect(readPersistedServerSettings(dataDir)).rejects.toThrow(
      "settings are unreadable",
    );

    const malformed = {
      claudeGatewayUrl: 42,
      ollamaUseFullSystemPrompt: "yes",
    } as unknown as Partial<ServerSettings>;
    expect(() =>
      readOptionalStringSetting(malformed, "claudeGatewayUrl"),
    ).toThrow("settings are invalid");
    expect(() =>
      readOptionalBooleanSetting(malformed, "ollamaUseFullSystemPrompt"),
    ).toThrow("settings are invalid");
  });

  it("rejects missing or malformed metadata records", async () => {
    const metadataPath = join(dataDir, "session-metadata.json");
    await writeFile(metadataPath, JSON.stringify({ version: 3 }));
    await expect(
      persistedMetadataIncludesProvider(dataDir, "claude-ollama"),
    ).rejects.toThrow("metadata is unreadable");

    await writeFile(
      metadataPath,
      JSON.stringify({ version: 3, sessions: { broken: 42 } }),
    );
    await expect(
      persistedMetadataIncludesProvider(dataDir, "claude-ollama"),
    ).rejects.toThrow("metadata is unreadable");
  });

  it("recognizes a provider only from valid metadata", async () => {
    const metadataPath = join(dataDir, "session-metadata.json");
    await writeFile(
      metadataPath,
      JSON.stringify({
        version: 3,
        sessions: {
          claude: { provider: "claude" },
          ollama: { provider: "claude-ollama" },
        },
      }),
    );

    await expect(
      persistedMetadataIncludesProvider(dataDir, "claude-ollama"),
    ).resolves.toBe(true);
    await expect(
      persistedMetadataIncludesProvider(dataDir, "codex"),
    ).resolves.toBe(false);
  });
});
