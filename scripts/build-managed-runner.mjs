#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDirectory = join(root, "dist", "managed-runner");
const outputDirectory = resolveArgument("--out-dir")
  ? resolve(root, resolveArgument("--out-dir"))
  : defaultOutputDirectory;
const targetOs = resolveArgument("--target-os") ?? "linux";
const targetArchitecture = resolveArgument("--target-arch") ?? process.arch;
const entrypoint = join(
  root,
  "packages/server/src/sdk/providers/managed-runner-entry.ts",
);
const artifactPath = join(outputDirectory, "runner.mjs");
const manifestPath = join(outputDirectory, "manifest.json");

if (targetOs !== "linux") {
  throw new Error("Gate A managed runner artifacts target Linux only");
}
if (!new Set(["x64", "arm64"]).has(targetArchitecture)) {
  throw new Error(
    `Unsupported managed runner architecture ${targetArchitecture}`,
  );
}
if (
  outputDirectory !== defaultOutputDirectory &&
  !outputDirectory.startsWith(`${join(root, "dist")}/`)
) {
  throw new Error(
    "Managed runner output must stay below the repository dist directory",
  );
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

const result = await build({
  entryPoints: [entrypoint],
  outfile: artifactPath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20.12",
  packages: "bundle",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  metafile: true,
  banner: {
    js: 'import { createRequire as __yaCreateRequire } from "node:module"; const require = __yaCreateRequire(import.meta.url);',
  },
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.LOG_LEVEL": '"silent"',
    "process.env.LOG_PRETTY": '"false"',
  },
  logLevel: "warning",
});
chmodSync(artifactPath, 0o755);

const artifactBytes = readFileSync(artifactPath);
const artifactSha256 = sha256(artifactBytes);
const packageJson = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const gitCommit = git(["rev-parse", "HEAD"]);
const dirty =
  git(["status", "--porcelain", "--untracked-files=normal"]).length > 0;
const inputPaths = Object.keys(result.metafile.inputs).sort();
const sourceHasher = createHash("sha256");
for (const inputPath of inputPaths) {
  const absolutePath = resolve(root, inputPath);
  sourceHasher.update(relative(root, absolutePath));
  sourceHasher.update("\0");
  sourceHasher.update(readFileSync(absolutePath));
  sourceHasher.update("\0");
}
const sourceSha256 = sourceHasher.digest("hex");
const manifest = {
  artifactFormatVersion: 1,
  runnerProtocolVersion: 2,
  providerSessionProtocolVersion: 1,
  yaVersion: packageJson.version,
  sourceIdentity: {
    gitCommit,
    dirty,
    sourceSha256,
  },
  buildIdentity: `${gitCommit}${dirty ? "+dirty" : ""}:${sourceSha256.slice(0, 16)}`,
  target: {
    os: targetOs,
    architecture: targetArchitecture,
  },
  entrypoint: "runner.mjs",
  node: {
    range: ">=20.12",
  },
  providers: ["codex"],
  testProviders: ["fake"],
  artifact: {
    byteSize: statSync(artifactPath).size,
    sha256: artifactSha256,
    bundledInputCount: inputPaths.length,
    externals: ["Node.js built-ins", "target Codex executable"],
  },
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(
  `${JSON.stringify({ artifactPath, manifestPath, manifest })}\n`,
);

function resolveArgument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
