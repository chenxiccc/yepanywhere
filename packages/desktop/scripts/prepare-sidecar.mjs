#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const downloadAttempts = 3;
const downloadTimeoutMs = 120_000;
const versions = JSON.parse(
  readFileSync(join(desktopDir, "runtime-versions.json"), "utf8"),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}
function detectTargetTriple() {
  return (
    process.env.TARGET_TRIPLE?.trim() ||
    run("rustc", ["--print", "host-tuple"])
  );
}

function downloadOnce(url, destination, redirectsRemaining = 10) {
  return new Promise((resolveDownload, rejectDownload) => {
    const request = get(
      url,
      {
        headers: {
          "User-Agent": "yep-anywhere-desktop-build",
        },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          if (redirectsRemaining === 0) {
            rejectDownload(new Error("Download exceeded 10 redirects"));
            return;
          }
          downloadOnce(
            new URL(response.headers.location, url),
            destination,
            redirectsRemaining - 1,
          ).then(
            resolveDownload,
            rejectDownload,
          );
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          rejectDownload(
            new Error(`Download failed with HTTP ${response.statusCode}`),
          );
          return;
        }
        const output = createWriteStream(destination, { flags: "wx" });
        pipeline(response, output).then(resolveDownload, rejectDownload);
      },
    );
    request.setTimeout(downloadTimeoutMs, () => {
      request.destroy(
        new Error(`Download made no progress for ${downloadTimeoutMs}ms`),
      );
    });
    request.on("error", rejectDownload);
  });
}

async function download(url, destination) {
  for (let attempt = 1; attempt <= downloadAttempts; attempt += 1) {
    rmSync(destination, { force: true });
    try {
      await downloadOnce(url, destination);
      return;
    } catch (error) {
      rmSync(destination, { force: true });
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === downloadAttempts) {
        throw new Error(
          `Download failed after ${downloadAttempts} attempts: ${message}`,
          { cause: error },
        );
      }
      const delayMs = attempt * 1_000;
      console.log(
        `Download attempt ${attempt}/${downloadAttempts} failed (${message}); retrying in ${delayMs}ms...`,
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
  }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const triple = detectTargetTriple();
const target = versions.bun.targets[triple];
if (!target) {
  throw new Error(`Unsupported desktop target triple: ${triple}`);
}

const binDir = join(desktopDir, "src-tauri", "binaries");
const extension = triple.includes("windows") ? ".exe" : "";
const bunOutput = join(binDir, `bun-${triple}${extension}`);
const versionMarker = `${bunOutput}.version`;
const expectedMarker = `${versions.bun.version}\n${target.sha256}\n`;

if (
  existsSync(bunOutput) &&
  existsSync(versionMarker) &&
  readFileSync(versionMarker, "utf8") === expectedMarker
) {
  console.log(`Bun ${versions.bun.version} already present for ${triple}`);
  process.exit(0);
}

mkdirSync(binDir, { recursive: true });
const tempRoot = mkdtempSync(join(tmpdir(), "yep-desktop-bun-"));
try {
  const archive = join(tempRoot, target.asset);
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${versions.bun.version}/${target.asset}`;
  console.log(`Downloading Bun ${versions.bun.version} for ${triple}...`);
  await download(url, archive);

  const actualHash = sha256(archive);
  if (actualHash !== target.sha256) {
    throw new Error(
      `Bun archive hash mismatch: expected ${target.sha256}, got ${actualHash}`,
    );
  }

  const extractDir = join(tempRoot, "extract");
  mkdirSync(extractDir);
  run("tar", ["-xf", archive, "-C", extractDir]);
  const extracted = join(
    extractDir,
    basename(target.asset, ".zip"),
    triple.includes("windows") ? "bun.exe" : "bun",
  );
  if (!existsSync(extracted)) {
    throw new Error(`Downloaded archive did not contain ${extracted}`);
  }

  copyFileSync(extracted, bunOutput);
  if (!triple.includes("windows")) {
    chmodSync(bunOutput, 0o755);
  }
  if (
    process.platform === "darwin" &&
    process.env.YEP_DESKTOP_SKIP_ADHOC_SIGN !== "1"
  ) {
    run("codesign", ["-fs", "-", bunOutput], { stdio: "inherit" });
  }
  writeFileSync(versionMarker, expectedMarker);
  console.log(`Bun ${versions.bun.version} ready at ${bunOutput}`);
} finally {
  rmSync(tempRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
