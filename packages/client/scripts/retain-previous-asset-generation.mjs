#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
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
    bootstrap: false,
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
      case "--bootstrap":
        options.bootstrap = true;
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
  --bootstrap                Confirm the origin has no prior manifest
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
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2)
  ) {
    throw new Error("Asset manifest must have schemaVersion 1 or 2");
  }
  if (!Array.isArray(value.assets)) {
    throw new Error("Asset manifest assets must be an array");
  }
  if (value.assets.length > MAX_MANIFEST_ASSETS) {
    throw new Error(`Asset manifest exceeds ${MAX_MANIFEST_ASSETS} entries`);
  }

  const assets = value.assets.map((asset, index) => {
    if (value.schemaVersion === 1) return validateAssetPath(asset, index);
    if (!isRecord(asset)) {
      throw new Error(`assets[${index}] must contain asset metadata`);
    }
    const path = validateAssetPath(asset.path, index);
    if (!Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new Error(`assets[${index}].size must be a non-negative integer`);
    }
    if (
      typeof asset.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(asset.sha256)
    ) {
      throw new Error(`assets[${index}].sha256 must be a SHA-256 digest`);
    }
    if (
      typeof asset.contentType !== "string" ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(asset.contentType)
    ) {
      throw new Error(`assets[${index}].contentType must be a media type`);
    }
    return {
      path,
      size: asset.size,
      sha256: asset.sha256,
      contentType: asset.contentType,
    };
  });
  const paths = assets.map((asset) =>
    typeof asset === "string" ? asset : asset.path,
  );
  if (new Set(paths).size !== paths.length) {
    throw new Error("Asset manifest contains duplicate paths");
  }
  return { schemaVersion: value.schemaVersion, assets };
}

const ASSET_CONTENT_TYPES = new Map([
  [".avif", "image/avif"],
  [".css", "text/css"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "application/javascript"],
  [".json", "application/json"],
  [".mjs", "application/javascript"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".otf", "font/otf"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function assetContentType(assetPath) {
  const contentType = ASSET_CONTENT_TYPES.get(extname(assetPath).toLowerCase());
  if (!contentType) {
    throw new Error(`Asset has no declared media type: ${assetPath}`);
  }
  return contentType;
}

function canonicalContentType(value) {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    mediaType === "text/javascript" ||
    mediaType === "application/x-javascript"
  ) {
    return "application/javascript";
  }
  return mediaType;
}

async function describeAsset(filePath, assetPath) {
  const bytes = await readFile(filePath);
  return {
    path: assetPath,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: assetContentType(assetPath),
  };
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
    const assetPath = relative(distPath, entryPath).split(sep).join("/");
    assets.push(await describeAsset(entryPath, assetPath));
  }
}

export async function collectCurrentAssetGeneration(distPath) {
  const assets = [];
  await collectAssetFiles(join(distPath, "assets"), distPath, assets);
  assets.sort((left, right) => left.path.localeCompare(right.path));
  return validateAssetGenerationManifest({ schemaVersion: 2, assets });
}

async function readPreviousManifest(previousOrigin, fetchImpl, bootstrap) {
  const manifestUrl = new URL(MANIFEST_FILE, previousOrigin);
  const response = await fetchImpl(manifestUrl, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  if (response.status === 404) {
    if (bootstrap) return null;
    throw new Error(
      "Previous asset manifest is missing; --bootstrap is required only for a verified first rollout",
    );
  }
  if (!response.ok) {
    throw new Error(
      `Previous asset manifest request failed: ${response.status} ${response.statusText}`,
    );
  }
  const contentType = canonicalContentType(
    response.headers.get("content-type"),
  );
  if (contentType !== "application/json") {
    if (bootstrap && contentType === "text/html") return null;
    throw new Error(
      `Previous asset manifest returned ${contentType || "no content type"}`,
    );
  }

  return validateAssetGenerationManifest(await response.json());
}

async function copyPreviousAsset({
  asset,
  distPath,
  previousOrigin,
  fetchImpl,
}) {
  const assetPath = typeof asset === "string" ? asset : asset.path;
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

  const expectedContentType =
    typeof asset === "string" ? assetContentType(assetPath) : asset.contentType;
  const responseContentType = canonicalContentType(
    response.headers.get("content-type"),
  );
  if (responseContentType !== expectedContentType) {
    throw new Error(
      `Previous asset type mismatch for ${assetPath}: expected ${expectedContentType}, received ${responseContentType || "none"}`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (typeof asset !== "string") {
    if (bytes.byteLength !== asset.size) {
      throw new Error(
        `Previous asset size mismatch for ${assetPath}: expected ${asset.size}, received ${bytes.byteLength}`,
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) {
      throw new Error(`Previous asset SHA-256 mismatch for ${assetPath}`);
    }
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, bytes);
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
  bootstrap = false,
  fetchImpl = fetch,
}) {
  const resolvedDistPath = resolve(distPath);
  const current = await collectCurrentAssetGeneration(resolvedDistPath);
  const previous = await readPreviousManifest(
    previousOrigin,
    fetchImpl,
    bootstrap,
  );
  if (bootstrap && previous) {
    throw new Error(
      "--bootstrap was supplied but a previous asset manifest exists; remove the one-time flag",
    );
  }
  const currentPaths = new Set(current.assets.map((asset) => asset.path));
  const retainedPaths = previous
    ? previous.assets.filter(
        (asset) =>
          !currentPaths.has(typeof asset === "string" ? asset : asset.path),
      )
    : [];

  await copyWithConcurrency(retainedPaths, (asset) =>
    copyPreviousAsset({
      asset,
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
