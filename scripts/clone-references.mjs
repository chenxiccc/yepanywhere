#!/usr/bin/env node
/**
 * Clone upstream source repos into ./references for local reading.
 *
 * `references/` is gitignored and absent on a fresh checkout. It holds upstream
 * source that agents/devs grep when working on a related YA surface — currently
 * the Codex Rust source (codex-rs), which is invaluable for the Codex provider,
 * schema, scanner, normalization, and app-server protocol work.
 *
 * Clones are shallow (read-only reading material) and version-aligned with the
 * provider target declared in package.json. Existing clean checkouts are moved
 * to the matching tag; dirty checkouts are never modified.
 *
 * Usage:
 *   pnpm clone-references
 *   pnpm references:sync
 *   pnpm references:check
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const REFERENCES_DIR = join(REPO_ROOT, "references");
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");

const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
const codexVersion = packageJson.yepAnywhere?.codexCli?.expectedVersion;
if (typeof codexVersion !== "string" || !codexVersion.trim()) {
  throw new Error(
    "package.json yepAnywhere.codexCli.expectedVersion must be a non-empty string",
  );
}

const args = process.argv.slice(2);
const unknownArgs = args.filter((arg) => arg !== "--check" && arg !== "--sync");
if (
  unknownArgs.length > 0 ||
  (args.includes("--check") && args.includes("--sync"))
) {
  console.error("Usage: clone-references.mjs [--check | --sync]");
  process.exit(2);
}
const checkOnly = args.includes("--check");

// Upstream repos worth reading locally. The Codex CLI lives at openai/codex;
// its Rust workspace is the `codex-rs/` subdir. Add { name, url, note } entries
// here to grow the set. `ref` should identify the upstream source version YA
// actually targets, not a floating default branch.
const REFERENCES = [
  {
    name: "codex",
    url: "https://github.com/openai/codex.git",
    ref: `rust-v${codexVersion}`,
    note: "Codex CLI source; Rust workspace in codex-rs/",
  },
];

function runGit(dest, args, inherit = false) {
  return spawnSync("git", args, {
    cwd: dest,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
}

function gitOutput(dest, args) {
  const result = runGit(dest, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function expectedCommit(dest, ref) {
  return gitOutput(dest, ["rev-list", "-n", "1", `refs/tags/${ref}`]);
}

function checkoutMatches(dest, ref) {
  const head = gitOutput(dest, ["rev-parse", "HEAD"]);
  const expected = expectedCommit(dest, ref);
  return head !== null && expected !== null && head === expected;
}

function describeCheckout(dest) {
  return (
    gitOutput(dest, ["describe", "--tags", "--exact-match", "HEAD"]) ??
    gitOutput(dest, ["rev-parse", "--short", "HEAD"]) ??
    "unknown revision"
  );
}

function clone({ name, url, ref, note }) {
  const dest = join(REFERENCES_DIR, name);
  if (existsSync(dest)) {
    return syncExisting({ name, ref, note }, dest);
  }

  if (checkOnly) {
    console.error(
      `✗ ${name} is missing; run pnpm references:sync to clone ${ref}`,
    );
    return false;
  }

  console.log(`↓ cloning ${name} ${ref} from ${url} …`);
  const result = spawnSync(
    "git",
    ["clone", "--depth", "1", "--branch", ref, "--single-branch", url, dest],
    { stdio: "inherit" },
  );

  if (result.status !== 0) {
    console.error(`✗ failed to clone ${name} (git exited ${result.status})`);
    return false;
  }

  if (!checkoutMatches(dest, ref)) {
    console.error(`✗ ${name} cloned, but HEAD does not match ${ref}`);
    return false;
  }

  console.log(`✓ ${name} at ${ref} (${note})`);
  return true;
}

function syncExisting({ name, ref, note }, dest) {
  if (gitOutput(dest, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    console.error(`✗ references/${name} exists but is not a git checkout`);
    return false;
  }

  const dirty = gitOutput(dest, ["status", "--porcelain"]);
  if (dirty === null) {
    console.error(`✗ could not inspect references/${name}`);
    return false;
  }
  if (dirty) {
    console.error(
      `✗ references/${name} has local changes; cannot verify or move it to ${ref}`,
    );
    return false;
  }

  if (checkoutMatches(dest, ref)) {
    console.log(`✓ ${name} at ${ref} (${note})`);
    return true;
  }

  const current = describeCheckout(dest);
  if (checkOnly) {
    console.error(
      `✗ ${name} is at ${current}; expected ${ref}. Run pnpm references:sync.`,
    );
    return false;
  }

  if (expectedCommit(dest, ref) === null) {
    console.log(`↓ fetching ${name} ${ref} …`);
    const fetchResult = runGit(
      dest,
      ["fetch", "--depth", "1", "origin", `tag`, ref],
      true,
    );
    if (fetchResult.status !== 0) {
      console.error(`✗ failed to fetch ${name} ${ref}`);
      return false;
    }
  }

  const checkoutResult = runGit(
    dest,
    ["checkout", "--detach", `refs/tags/${ref}`],
    true,
  );
  if (checkoutResult.status !== 0 || !checkoutMatches(dest, ref)) {
    console.error(`✗ failed to align ${name} with ${ref}`);
    return false;
  }

  console.log(`✓ ${name} moved from ${current} to ${ref} (${note})`);
  return true;
}

function main() {
  mkdirSync(REFERENCES_DIR, { recursive: true });

  let ok = true;
  for (const ref of REFERENCES) {
    ok = clone(ref) && ok;
  }

  if (!ok) {
    process.exitCode = 1;
  }
}

main();
