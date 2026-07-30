#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const triple =
  process.env.TARGET_TRIPLE?.trim() ||
  (process.platform === "win32"
    ? "x86_64-pc-windows-msvc"
    : process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-apple-darwin");
const bun = join(
  desktopDir,
  "src-tauri",
  "binaries",
  `bun-${triple}${triple.includes("windows") ? ".exe" : ""}`,
);
const serverDir = join(
  desktopDir,
  "src-tauri",
  "resources",
  "server",
);
const entry = join(serverDir, "dist", "index.js");
const dataDir = mkdtempSync(join(tmpdir(), "yep-desktop-smoke-"));
const secret = randomBytes(32).toString("hex");
const child = spawn(bun, ["run", entry], {
  cwd: serverDir,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: "0",
    YEP_DATA_DIR: dataDir,
    YEP_DESKTOP: "1",
    YEP_DESKTOP_BOOTSTRAP: "stdin-v1",
  },
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-8000);
});

function stopTree() {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
}

try {
  child.stdin.end(
    `${JSON.stringify({ protocol: 1, masterSecret: secret })}\n`,
  );
  const ready = await new Promise((resolveReady, rejectReady) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      lines.close();
      rejectReady(new Error(`Timed out waiting for readiness\n${stderr}`));
    }, 60_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectReady(
        new Error(`Bundled server exited before readiness (${code})\n${stderr}`),
      );
    });
    lines.on("line", (line) => {
      if (!line.startsWith("YEP_DESKTOP_READY ")) return;
      clearTimeout(timer);
      lines.close();
      resolveReady(JSON.parse(line.slice("YEP_DESKTOP_READY ".length)));
    });
  });

  if (ready.protocol !== 1 || !Number.isInteger(ready.port)) {
    throw new Error(`Invalid readiness record: ${JSON.stringify(ready)}`);
  }
  const baseUrl = `http://127.0.0.1:${ready.port}`;
  const health = await fetch(`${baseUrl}/health`);
  if (!health.ok) {
    throw new Error(`Health check failed with ${health.status}`);
  }
  const mint = await fetch(`${baseUrl}/desktop-bootstrap/mint`, {
    method: "POST",
    headers: { "x-yep-desktop-bootstrap-secret": secret },
  });
  if (!mint.ok) {
    throw new Error(`Desktop bootstrap mint failed with ${mint.status}`);
  }
  const { code } = await mint.json();
  const exchange = await fetch(`${baseUrl}/desktop-bootstrap/${code}`, {
    redirect: "manual",
  });
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
  if (exchange.status !== 303 || !cookie) {
    throw new Error(`Desktop bootstrap exchange failed with ${exchange.status}`);
  }
  const status = await fetch(`${baseUrl}/api/auth/status`, {
    headers: { cookie, "X-Yep-Anywhere": "true" },
  });
  if (!status.ok || !(await status.json()).authenticated) {
    throw new Error(`Desktop session auth failed with ${status.status}`);
  }
  console.log(
    `Packaged desktop runtime smoke passed (protocol ${ready.protocol}, dynamic port).`,
  );
} finally {
  stopTree();
  rmSync(dataDir, { recursive: true, force: true });
}
