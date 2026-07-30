#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appBundle = process.env.YEP_DESKTOP_APP_BUNDLE?.trim();
const triple =
  process.env.TARGET_TRIPLE?.trim() ||
  (process.platform === "win32"
    ? "x86_64-pc-windows-msvc"
    : process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-apple-darwin");
const bun = appBundle
  ? join(resolve(appBundle), "Contents", "MacOS", "bun")
  : join(
      desktopDir,
      "src-tauri",
      "binaries",
      `bun-${triple}${triple.includes("windows") ? ".exe" : ""}`,
    );
const serverDir = appBundle
  ? join(
      resolve(appBundle),
      "Contents",
      "Resources",
      "resources",
      "server",
    )
  : join(desktopDir, "src-tauri", "resources", "server");
const entry = join(serverDir, "dist", "index.js");

for (const [label, path] of [
  ["Bun runtime", bun],
  ["server entry", entry],
]) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found at ${path}`);
  }
}

if (
  appBundle &&
  process.platform === "darwin" &&
  process.env.YEP_DESKTOP_REQUIRE_ALLOW_JIT === "1"
) {
  const verification = spawnSync(
    "codesign",
    ["--verify", "--strict", "--verbose=2", bun],
    { encoding: "utf8" },
  );
  if (verification.status !== 0) {
    throw new Error(
      `Packaged Bun signature verification failed: ${verification.stderr || verification.stdout}`,
    );
  }

  const display = spawnSync(
    "codesign",
    ["--display", "--entitlements", "-", "--xml", bun],
    { encoding: "utf8" },
  );
  if (display.status !== 0) {
    throw new Error(
      `Could not inspect packaged Bun entitlements: ${display.stderr || display.stdout}`,
    );
  }
  if (
    !/<key>\s*com\.apple\.security\.cs\.allow-jit\s*<\/key>\s*<true\s*\/>/u.test(
      display.stdout,
    )
  ) {
    throw new Error(
      "Packaged Bun is missing com.apple.security.cs.allow-jit=true",
    );
  }
  for (const forbidden of [
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-executable-page-protection",
    "com.apple.security.cs.disable-library-validation",
  ]) {
    if (display.stdout.includes(`<key>${forbidden}</key>`)) {
      throw new Error(`Packaged Bun has forbidden entitlement ${forbidden}`);
    }
  }
}

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
    HTTPS_SELF_SIGNED: "false",
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
    `${appBundle ? "Signed desktop app" : "Packaged desktop runtime"} smoke passed (protocol ${ready.protocol}, dynamic port).`,
  );
} finally {
  stopTree();
  rmSync(dataDir, { recursive: true, force: true });
}
