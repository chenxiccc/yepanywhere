#!/usr/bin/env node

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST_PATH = resolve(SCRIPT_DIR, "../dist-remote");
const MANIFEST_FILE = "asset-generation.json";
const MAX_MANIFEST_ASSETS = 5_000;
const COPY_CONCURRENCY = 8;

function resolveFromCwd(value) {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function valueAfter(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    distPath: DEFAULT_DIST_PATH,
    previousOrigin: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--dist":
        options.distPath = resolveFromCwd(valueAfter(argv, index, arg));
        index += 1;
        break;
      case "--previous-origin":
        options.previousOrigin = valueAfter(argv, index, arg);
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && !options.previousOrigin) {
    throw new Error("--previous-origin is required");
  }
  if (options.previousOrigin) {
    const url = new URL(options.previousOrigin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("--previous-origin must use http or https");
    }
    options.previousOrigin = url.toString();
  }

  return options;
}

function printUsage() {
  console.log(`Usage: node retain-previous-asset-generation.mjs [options]

Copy the prior hosted build's content-addressed runtime assets into a new
remote build, then publish a manifest describing only the new generation.

Options:
  --dist <path>              Remote build output (default: dist-remote)
  --previous-origin <url>    Currently deployed site to retain
  --help                     Show this help
`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateAssetPath(assetPath, index) {
  if (
    typeof assetPath !== "string" ||
    !assetPath.startsWith("assets/") ||
    assetPath.includes("\\") ||
    assetPath.includes("?") ||
    assetPath.includes("#")
  ) {
    throw new Error(`assets[${index}] is not a safe assets/ path`);
  }

  const segments = assetPath.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`assets[${index}] is not a normalized asset path`);
  }
  return assetPath;
}

export function validateAssetGenerationManifest(value) {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Asset manifest must have schemaVersion: 1");
  }
  if (!Array.isArray(value.assets)) {
    throw new Error("Asset manifest assets must be an array");
  }
  if (value.assets.length > MAX_MANIFEST_ASSETS) {
    throw new Error(`Asset manifest exceeds ${MAX_MANIFEST_ASSETS} entries`);
  }

  const assets = value.assets.map(validateAssetPath);
  if (new Set(assets).size !== assets.length) {
    throw new Error("Asset manifest contains duplicate paths");
  }
  return { schemaVersion: 1, assets };
}

async function collectAssetFiles(directory, distPath, assets) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectAssetFiles(entryPath, distPath, assets);
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith(".map")) continue;
    assets.push(relative(distPath, entryPath).split(sep).join("/"));
  }
}

export async function collectCurrentAssetGeneration(distPath) {
  const assets = [];
  await collectAssetFiles(join(distPath, "assets"), distPath, assets);
  assets.sort();
  return validateAssetGenerationManifest({ schemaVersion: 1, assets });
}

async function readPreviousManifest(previousOrigin, fetchImpl) {
  const manifestUrl = new URL(MANIFEST_FILE, previousOrigin);
  const response = await fetchImpl(manifestUrl, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Previous asset manifest request failed: ${response.status} ${response.statusText}`,
    );
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    // Before the first manifest-aware deploy, the Pages SPA fallback returns
    // index.html for this path. Treat that one-time state as no prior manifest.
    return null;
  }

  return validateAssetGenerationManifest(await response.json());
}

async function copyPreviousAsset({
  assetPath,
  distPath,
  previousOrigin,
  fetchImpl,
}) {
  const targetPath = resolve(distPath, assetPath);
  const relativeTarget = relative(resolve(distPath), targetPath);
  if (
    !relativeTarget ||
    relativeTarget.startsWith("..") ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(`Refusing asset path outside build output: ${assetPath}`);
  }

  const response = await fetchImpl(new URL(assetPath, previousOrigin), {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `Previous asset request failed for ${assetPath}: ${response.status} ${response.statusText}`,
    );
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
}

async function copyWithConcurrency(items, copy) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await copy(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(COPY_CONCURRENCY, items.length) }, worker),
  );
}

export async function retainPreviousAssetGeneration({
  distPath,
  previousOrigin,
  fetchImpl = fetch,
}) {
  const resolvedDistPath = resolve(distPath);
  const current = await collectCurrentAssetGeneration(resolvedDistPath);
  const previous = await readPreviousManifest(previousOrigin, fetchImpl);
  const currentPaths = new Set(current.assets);
  const retainedPaths = previous
    ? previous.assets.filter((assetPath) => !currentPaths.has(assetPath))
    : [];

  await copyWithConcurrency(retainedPaths, (assetPath) =>
    copyPreviousAsset({
      assetPath,
      distPath: resolvedDistPath,
      previousOrigin,
      fetchImpl,
    }),
  );

  const manifestPath = join(resolvedDistPath, MANIFEST_FILE);
  await writeFile(manifestPath, `${JSON.stringify(current, null, 2)}\n`);
  return {
    currentAssetCount: current.assets.length,
    retainedAssetCount: retainedPaths.length,
    previousManifestFound: previous !== null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const result = await retainPreviousAssetGeneration(options);
  console.log(
    `[asset-generation] current=${result.currentAssetCount} retained=${result.retainedAssetCount} previous=${result.previousManifestFound ? "found" : "not-found"}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
