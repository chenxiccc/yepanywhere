/**
 * Unit tests for GeminiProvider.
 *
 * Tests provider detection, authentication checking, and message normalization
 * without requiring actual Gemini CLI installation.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  GeminiProvider,
  type GeminiProviderConfig,
} from "../../../src/sdk/providers/gemini.js";

describe("GeminiProvider", () => {
  let provider: GeminiProvider;

  beforeAll(() => {
    provider = new GeminiProvider();
  });

  describe("isInstalled", () => {
    it("should return boolean indicating CLI availability", async () => {
      const isInstalled = await provider.isInstalled();
      expect(typeof isInstalled).toBe("boolean");
    });

    it("should use custom geminiPath if provided and exists", async () => {
      // Custom path is used IF it exists, otherwise falls back to PATH detection
      const customProvider = new GeminiProvider({
        geminiPath: "/nonexistent/path/to/gemini",
      });
      // isInstalled will still check PATH if custom path doesn't exist
      const isInstalled = await customProvider.isInstalled();
      // We just verify it returns a boolean - actual value depends on system
      expect(typeof isInstalled).toBe("boolean");
    });
  });

  describe("getAuthStatus", () => {
    it("should return auth status object with required fields", async () => {
      const status = await provider.getAuthStatus();

      expect(typeof status.installed).toBe("boolean");
      expect(typeof status.authenticated).toBe("boolean");
      expect(typeof status.enabled).toBe("boolean");
    });

    it("should defer auth validation to the installed CLI", async () => {
      const installed = await provider.isInstalled();

      await expect(provider.getAuthStatus()).resolves.toEqual({
        installed,
        authenticated: installed,
        enabled: installed,
      });
    });
  });

  describe("isAuthenticated", () => {
    it("should return boolean", async () => {
      const isAuth = await provider.isAuthenticated();
      expect(typeof isAuth).toBe("boolean");
    });
  });

  describe("provider properties", () => {
    it("should have correct name", () => {
      expect(provider.name).toBe("gemini");
    });

    it("should have correct displayName", () => {
      expect(provider.displayName).toBe("Gemini");
    });
  });

  describe("startSession", () => {
    it("should return session object with required methods", async () => {
      const session = await provider.startSession({
        cwd: "/tmp",
        initialMessage: { text: "test" },
      });

      expect(session.iterator).toBeDefined();
      expect(typeof session.abort).toBe("function");
      expect(session.queue).toBeDefined();
    });

    it("should emit error if Gemini CLI is not found", async () => {
      const noCliProvider = new GeminiProvider({
        geminiPath: "/nonexistent/gemini",
      });

      // Skip this test if gemini CLI is actually installed somewhere
      const isGeminiInstalled = await noCliProvider.isInstalled();
      if (isGeminiInstalled) {
        // Can't test "not found" error if CLI is installed
        return;
      }

      const session = await noCliProvider.startSession({
        cwd: "/tmp",
        initialMessage: { text: "test" },
      });

      const messages: unknown[] = [];
      const timeout = setTimeout(() => {
        session.abort();
      }, 3000);

      try {
        for await (const msg of session.iterator) {
          messages.push(msg);
          if (msg.type === "result" || msg.type === "error") break;
        }
      } finally {
        clearTimeout(timeout);
      }

      // Should get an error message about CLI not found
      expect(
        messages.some(
          (m: unknown) =>
            (m as { type?: string; error?: string }).type === "error" ||
            (m as { type?: string }).type === "result",
        ),
      ).toBe(true);
    });
  });
});

describe("GeminiProvider Event Normalization", () => {
  // Test helper to create a provider and access internal methods
  function createTestProvider(): GeminiProvider {
    return new GeminiProvider();
  }

  it("should have correct provider interface", () => {
    const provider = createTestProvider();

    expect(provider.name).toBe("gemini");
    expect(provider.displayName).toBe("Gemini");
    expect(typeof provider.isInstalled).toBe("function");
    expect(typeof provider.isAuthenticated).toBe("function");
    expect(typeof provider.getAuthStatus).toBe("function");
    expect(typeof provider.startSession).toBe("function");
  });

  it("marks failed tool results as errors", () => {
    const provider = createTestProvider() as unknown as {
      convertEventToSDKMessage: (
        event: unknown,
        sessionId: string,
      ) => { message?: { content?: unknown[] } };
    };

    const message = provider.convertEventToSDKMessage(
      {
        type: "tool_result",
        tool_id: "edit-1",
        status: "error",
        error: "edit failed",
      },
      "session-1",
    );

    expect(message.message?.content?.[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "edit-1",
      is_error: true,
    });
  });
});

describe("GeminiProvider Configuration", () => {
  it("should accept custom timeout", () => {
    const config: GeminiProviderConfig = {
      timeout: 60000,
    };
    const provider = new GeminiProvider(config);

    expect(provider.name).toBe("gemini");
    // Can't directly verify timeout since it's private,
    // but we can verify the provider was created
  });

  it("should accept custom gemini path", () => {
    const config: GeminiProviderConfig = {
      geminiPath: "/custom/path/to/gemini",
    };
    const provider = new GeminiProvider(config);

    expect(provider.name).toBe("gemini");
  });

  it("should use defaults when no config provided", () => {
    const provider = new GeminiProvider();

    expect(provider.name).toBe("gemini");
    expect(provider.displayName).toBe("Gemini");
  });
});
