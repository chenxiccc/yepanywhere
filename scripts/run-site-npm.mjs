#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const script = process.argv[2];

if (!script) {
  console.error("Usage: run-site-npm.mjs <script>");
  process.exit(1);
}

const env = { ...process.env };
const pnpmOnlyConfigKeys = new Set([
  "npm_config__jsr_registry",
  "npm_config_npm_globalconfig",
  "npm_config_recursive",
  "npm_config_verify_deps_before_run",
  "pnpm_config_verify_deps_before_run",
]);
for (const key of Object.keys(env)) {
  if (pnpmOnlyConfigKeys.has(key.toLowerCase())) delete env[key];
}

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmBin, ["run", script], {
  cwd: new URL("../site/", import.meta.url),
  env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
