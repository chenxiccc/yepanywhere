import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppOptions,
  type AppResult,
  createApp as createProductionApp,
} from "../../src/app.js";

const EMPTY_PROVIDER_ROOT = join(
  tmpdir(),
  `yep-server-test-providers-${process.pid}-${randomUUID()}`,
);

/**
 * Build the full server app without inheriting a developer's provider history.
 * Tests that exercise provider discovery opt into their fixture directories by
 * passing the corresponding AppOptions override.
 */
export function createApp(options: AppOptions): AppResult {
  return createProductionApp({
    codexSessionsDir: join(EMPTY_PROVIDER_ROOT, "codex"),
    geminiSessionsDir: join(EMPTY_PROVIDER_ROOT, "gemini"),
    grokSessionsDir: join(EMPTY_PROVIDER_ROOT, "grok"),
    piSessionsDir: join(EMPTY_PROVIDER_ROOT, "pi"),
    ...options,
  });
}
