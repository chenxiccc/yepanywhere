#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write(
    `codex-cli ${process.env.YA_FAKE_CODEX_VERSION ?? "0.149.0"}\n`,
  );
  process.exit(0);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    void handle(JSON.parse(line));
  }
});

async function handle(message) {
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    respond(message.id, { userAgent: "fake-codex-auth-owner" });
    return;
  }
  if (message.method === "config/read") {
    respond(message.id, {
      config: {
        cli_auth_credentials_store:
          process.env.YA_FAKE_CODEX_CREDENTIAL_STORE ?? "file",
      },
      origins: {},
    });
    return;
  }
  if (message.method === "account/read") {
    if (message.params?.refreshToken === true) {
      const logPath = process.env.YA_FAKE_CODEX_REFRESH_LOG;
      if (logPath) appendFileSync(logPath, `start:${process.pid}\n`);
      if (process.env.YA_FAKE_CODEX_REFRESH_HANG === "1") return;
      const delay = Number(process.env.YA_FAKE_CODEX_REFRESH_DELAY_MS ?? 0);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const codexHome = process.env.CODEX_HOME;
      const replacement = process.env.YA_FAKE_CODEX_REFRESH_ACCESS_TOKEN;
      if (codexHome && replacement) {
        const authPath = join(codexHome, "auth.json");
        const auth = JSON.parse(readFileSync(authPath, "utf8"));
        auth.tokens.access_token = replacement;
        writeFileSync(authPath, `${JSON.stringify(auth)}\n`, { mode: 0o600 });
      }
      if (logPath) appendFileSync(logPath, `end:${process.pid}\n`);
    }
    respond(message.id, {
      account:
        process.env.YA_FAKE_CODEX_ACCOUNT_TYPE === "none"
          ? null
          : { type: "chatgpt", planType: "plus" },
      requiresOpenaiAuth: true,
    });
    return;
  }
  respondError(message.id, `unsupported method ${message.method}`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function respondError(id, message) {
  process.stdout.write(
    `${JSON.stringify({ id, error: { code: -32601, message } })}\n`,
  );
}
