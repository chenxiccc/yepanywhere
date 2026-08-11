import { describe, expect, it } from "vitest";
import {
  buildEnvSettings,
  captureStartupEnvSettings,
  getStartupEnvSettings,
  isSecretName,
  redactSecretValue,
} from "../src/envSettings.js";

function entry(env: NodeJS.ProcessEnv, name: string) {
  const found = buildEnvSettings(env).entries.find((e) => e.name === name);
  if (!found) throw new Error(`registry missing ${name}`);
  return found;
}

describe("isSecretName", () => {
  it("treats KEY/SECRET/TOKEN/PASSWORD names as secret", () => {
    expect(isSecretName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSecretName("AUTH_COOKIE_SECRET")).toBe(true);
    expect(isSecretName("DESKTOP_AUTH_TOKEN")).toBe(true);
    expect(isSecretName("DB_PASSWORD")).toBe(true);
  });

  it("honors the explicit declared flag even without a matching name", () => {
    expect(isSecretName("YEP_STT_OPAQUE", true)).toBe(true);
    expect(isSecretName("PORT")).toBe(false);
  });

  it("never lets credential-suffixed variables opt out of redaction", () => {
    expect(isSecretName("NEW_PROVIDER_API_KEY", false)).toBe(true);
    expect(isSecretName("DESKTOP_AUTH_TOKEN", false)).toBe(true);
    expect(isSecretName("AUTH_COOKIE_SECRET", false)).toBe(true);
    expect(isSecretName("DATABASE_PASSWORD", false)).toBe(true);
  });

  it("lets an explicit false opt a KEY-named var out of redaction", () => {
    expect(isSecretName("YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS", false)).toBe(
      false,
    );
  });
});

describe("registry", () => {
  it("shows SHARE_XAI_KEY_WITH_CLIENTS as a non-secret boolean", () => {
    const e = entry(
      { YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS: "true" },
      "YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS",
    );
    expect(e.secret).toBe(false);
    expect(e.value).toBe("true");
  });

  it("includes operator inputs read outside the central config loader", () => {
    for (const name of [
      "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
      "GROK_HOME",
      "YA_BANG_ACLI_COMPLETERS",
      "YEP_CLAUDE_PARSE_CACHE_MB",
      "YEP_TURN_TIMESTAMPS",
    ]) {
      expect(() => entry({}, name)).not.toThrow();
    }
  });
});

describe("redactSecretValue", () => {
  it("reveals only the last four chars of a long-enough value", () => {
    expect(redactSecretValue("sk-abcdef123wxyz")).toBe("⋯wxyz");
  });

  it("reveals nothing for a short value", () => {
    expect(redactSecretValue("short")).toBe("⋯");
    expect(redactSecretValue("1234567")).toBe("⋯");
  });
});

describe("buildEnvSettings", () => {
  it("redacts a set secret and never includes the raw value", () => {
    const env = { ANTHROPIC_API_KEY: "sk-supersecret-1234tail" };
    const e = entry(env, "ANTHROPIC_API_KEY");
    expect(e.secret).toBe(true);
    expect(e.set).toBe(true);
    expect(e.value).toBe("⋯tail");
    // The serialized report (what the route sends) must not leak the raw value.
    expect(JSON.stringify(buildEnvSettings(env))).not.toContain("supersecret");
  });

  it("shows non-secret values verbatim", () => {
    const e = entry({ PORT: "4000" }, "PORT");
    expect(e.secret).toBe(false);
    expect(e.value).toBe("4000");
  });

  it("reports unset vars with no value", () => {
    const e = entry({}, "PORT");
    expect(e.set).toBe(false);
    expect(e.value).toBeUndefined();
  });

  it("distinguishes an explicitly empty value from unset", () => {
    const e = entry({ ALLOWED_IMAGE_PATHS: "" }, "ALLOWED_IMAGE_PATHS");
    expect(e.set).toBe(true);
    expect(e.value).toBe("");
  });

  it("does not fabricate a redacted preview for an empty secret", () => {
    const e = entry({ XAI_API_KEY: "" }, "XAI_API_KEY");
    expect(e.set).toBe(true);
    expect(e.value).toBe("");
  });
});

describe("startup snapshot", () => {
  it("captures a snapshot the getter then returns", () => {
    captureStartupEnvSettings({ PORT: "5555" });
    const port = getStartupEnvSettings().entries.find((e) => e.name === "PORT");
    expect(port?.value).toBe("5555");
  });
});
