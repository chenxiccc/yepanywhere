#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const rootDir = resolve(desktopDir, "../..");
const resourceDir = join(desktopDir, "src-tauri", "resources", "server");
const resourceParent = dirname(resourceDir);
const serverDir = join(rootDir, "packages", "server");
const deployTarget = "../desktop/src-tauri/resources/server";
const modulesDir = join(resourceDir, "node_modules");

if (
  resourceDir !==
  join(rootDir, "packages", "desktop", "src-tauri", "resources", "server")
) {
  throw new Error(`Refusing unexpected desktop resource path: ${resourceDir}`);
}

function runPnpm(args, cwd = rootDir) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) {
    throw new Error("npm_execpath is unavailable; run through pnpm");
  }
  const result = spawnSync(process.execPath, [pnpmCli, ...args], {
    cwd,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args.join(" ")} failed with ${result.status}: ${result.error ?? "unknown error"}`,
    );
  }
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.status !== 0) return "unknown";
  return result.stdout.trim();
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packageRoots(directory) {
  if (!existsSync(directory)) return [];
  const roots = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      for (const child of readdirSync(entryPath, { withFileTypes: true })) {
        roots.push(join(entryPath, child.name));
      }
    } else {
      roots.push(entryPath);
    }
  }
  return roots;
}

function packageIdentity(packageRoot) {
  const packagePath = join(packageRoot, "package.json");
  if (!existsSync(packagePath)) return null;
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  return manifest.name && manifest.version
    ? { name: manifest.name, version: manifest.version }
    : null;
}

function collectDeployedPackages(storeDir) {
  const packages = new Map();
  for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const packageRoot of packageRoots(
      join(storeDir, entry.name, "node_modules"),
    )) {
      const identity = packageIdentity(packageRoot);
      if (!identity) continue;
      const versions = packages.get(identity.name) ?? new Set();
      versions.add(identity.version);
      packages.set(identity.name, versions);
    }
  }
  return packages;
}

function prunePhysicalModules(directory, deployedPackages) {
  if (!existsSync(directory)) return;
  for (const packageRoot of packageRoots(directory)) {
    const identity = packageIdentity(packageRoot);
    if (
      !identity ||
      !deployedPackages.get(identity.name)?.has(identity.version)
    ) {
      rmSync(packageRoot, { recursive: true, force: true });
      continue;
    }
    prunePhysicalModules(join(packageRoot, "node_modules"), deployedPackages);
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith("@")) {
      const scopeDir = join(directory, entry.name);
      if (readdirSync(scopeDir).length === 0) {
        rmSync(scopeDir, { recursive: true, force: true });
      }
    }
  }
}

function assertPhysicalTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (lstatSync(entryPath).isSymbolicLink()) {
      throw new Error(`Desktop resource contains a filesystem link: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      assertPhysicalTree(entryPath);
    }
  }
}

runPnpm(["--filter", "@yep-anywhere/shared", "build"]);
runPnpm(["--filter", "@yep-anywhere/client", "build"]);
runPnpm(["--filter", "@yep-anywhere/server", "build"]);

if (existsSync(resourceDir)) {
  rmSync(resourceDir, { recursive: true, force: true });
}
mkdirSync(resourceParent, { recursive: true });

runPnpm([
  "--offline",
  "--config.virtual-store-dir-max-length=32",
  "--config.ignore-scripts=true",
  "--filter",
  ".",
  "deploy",
  "--prod",
  deployTarget,
], serverDir);

// pnpm 10 on Windows currently mirrors attempted .bin links beneath the
// filtered package when the deploy target is elsewhere in the workspace.
// They are not part of the deployment and can otherwise dirty the checkout.
const shadowResourceDir = join(serverDir, relative(rootDir, resourceDir));
if (existsSync(shadowResourceDir)) {
  rmSync(shadowResourceDir, { recursive: true, force: true });
}

const deployedPackages = collectDeployedPackages(join(modulesDir, ".pnpm"));
rmSync(modulesDir, { recursive: true, force: true });

// NSIS does not preserve pnpm's junction-based isolated layout. Materialize a
// hoisted tree from the workspace lock, then prune it back to the exact package
// name/version closure recorded by the isolated deployment above.
const moduleWorkspace = mkdtempSync(join(tmpdir(), "yep-desktop-modules-"));
try {
  mkdirSync(join(moduleWorkspace, "packages", "server"), { recursive: true });
  mkdirSync(join(moduleWorkspace, "packages", "shared"), { recursive: true });
  cpSync(
    join(rootDir, "packages", "server", "package.json"),
    join(moduleWorkspace, "packages", "server", "package.json"),
  );
  cpSync(
    join(rootDir, "packages", "shared", "package.json"),
    join(moduleWorkspace, "packages", "shared", "package.json"),
  );
  cpSync(
    join(rootDir, "pnpm-lock.yaml"),
    join(moduleWorkspace, "pnpm-lock.yaml"),
  );
  cpSync(
    join(rootDir, "package.json"),
    join(moduleWorkspace, "package.json"),
  );
  writeFileSync(
    join(moduleWorkspace, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );
  runPnpm(
    [
      "--offline",
      "--config.ignore-scripts=true",
      "--config.node-linker=hoisted",
      "--filter",
      "@yep-anywhere/server",
      "install",
      "--prod",
      "--frozen-lockfile",
    ],
    moduleWorkspace,
  );
  cpSync(join(moduleWorkspace, "node_modules"), modulesDir, {
    recursive: true,
  });
} finally {
  rmSync(moduleWorkspace, { recursive: true, force: true });
}
rmSync(join(modulesDir, ".pnpm"), { recursive: true, force: true });
rmSync(join(modulesDir, ".bin"), { recursive: true, force: true });
rmSync(join(modulesDir, ".modules.yaml"), { force: true });
prunePhysicalModules(modulesDir, deployedPackages);

const sharedTarget = join(modulesDir, "@yep-anywhere", "shared");
mkdirSync(sharedTarget, { recursive: true });
cpSync(join(rootDir, "packages", "shared", "dist"), join(sharedTarget, "dist"), {
  recursive: true,
});
cpSync(
  join(rootDir, "packages", "shared", "package.json"),
  join(sharedTarget, "package.json"),
);
assertPhysicalTree(modulesDir);

cpSync(join(rootDir, "packages", "client", "dist"), join(resourceDir, "client-dist"), {
  recursive: true,
});

for (const name of [
  "src",
  "test",
  "tsconfig.json",
  "vitest.config.ts",
]) {
  const candidate = join(resourceDir, name);
  if (existsSync(candidate)) {
    rmSync(candidate, { recursive: true, force: true });
  }
}

const rootPackage = JSON.parse(
  readFileSync(join(rootDir, "package.json"), "utf8"),
);
const desktopPackage = JSON.parse(
  readFileSync(join(desktopDir, "package.json"), "utf8"),
);
const serverPackage = JSON.parse(
  readFileSync(join(rootDir, "packages", "server", "package.json"), "utf8"),
);
const runtimeVersions = JSON.parse(
  readFileSync(join(desktopDir, "runtime-versions.json"), "utf8"),
);
const manifest = {
  schemaVersion: 1,
  desktopVersion: desktopPackage.version,
  yepVersion:
    rootPackage.version ||
    runGit(["describe", "--tags", "--always", "--match", "v[0-9]*"]),
  serverPackageVersion: serverPackage.version,
  commit: runGit(["rev-parse", "HEAD"]),
  bunVersion: runtimeVersions.bun.version,
  lockfileSha256: hashFile(join(rootDir, "pnpm-lock.yaml")),
  serverEntrySha256: hashFile(join(resourceDir, "dist", "index.js")),
  clientIndexSha256: hashFile(join(resourceDir, "client-dist", "index.html")),
};
writeFileSync(
  join(resourceDir, "desktop-runtime-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(
  `Desktop server resource ready at ${relative(rootDir, resourceDir)}`,
);
