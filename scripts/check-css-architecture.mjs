#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const clientSrcDir = path.join(repoRoot, "packages", "client", "src");
const baselinePath = path.join(
  repoRoot,
  "scripts",
  "css-architecture-baseline.json",
);

function usage() {
  console.log(`Usage: node scripts/check-css-architecture.mjs [options]

Options:
  --record     Lower legacy global CSS limits to the current line counts.
  -h, --help   Show help.

The check rejects:
  - growth above a legacy global stylesheet's recorded line limit; and
  - a new non-module client stylesheet without a reviewed baseline entry.

Read topics/css-architecture.md before changing the baseline.
`);
}

function parseArgs(argv) {
  const options = { record: false };
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--record") {
      options.record = true;
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }
  return options;
}

async function collectCssFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectCssFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      files.push(entryPath);
    }
  }
  return files;
}

function relativePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function lineCount(text) {
  if (text.length === 0) return 0;
  const newlines = text.match(/\n/g)?.length ?? 0;
  return newlines + (text.endsWith("\n") ? 0 : 1);
}

const options = parseArgs(process.argv.slice(2));
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const legacyGlobalStyles = baseline.legacyGlobalStyles ?? {};
const cssFiles = await collectCssFiles(clientSrcDir);
const moduleFiles = cssFiles.filter((file) => file.endsWith(".module.css"));
const globalFiles = cssFiles.filter((file) => !file.endsWith(".module.css"));
const currentGlobalPaths = new Set(globalFiles.map(relativePath));
const configuredGlobalPaths = new Set(Object.keys(legacyGlobalStyles));
const errors = [];
const belowBaseline = [];
const currentCounts = new Map();

for (const file of globalFiles) {
  const filePath = relativePath(file);
  if (!configuredGlobalPaths.has(filePath)) {
    errors.push(
      `${filePath}: new non-module stylesheet; use a co-located *.module.css or add a reviewed global exception with a reason`,
    );
  }
}

for (const filePath of configuredGlobalPaths) {
  if (!currentGlobalPaths.has(filePath)) {
    errors.push(
      `${filePath}: baseline entry has no matching file; remove the stale reviewed exception`,
    );
    continue;
  }

  const text = await readFile(path.join(repoRoot, filePath), "utf8");
  const actual = lineCount(text);
  const limit = legacyGlobalStyles[filePath].maxLines;
  currentCounts.set(filePath, actual);

  if (!Number.isInteger(limit) || limit < 0) {
    errors.push(`${filePath}: maxLines must be a non-negative integer`);
  } else if (actual > limit) {
    errors.push(
      `${filePath}: ${actual} lines exceeds the frozen limit of ${limit}`,
    );
  } else if (actual < limit) {
    belowBaseline.push({ filePath, actual, limit });
  }
}

console.log(
  `CSS architecture: ${globalFiles.length} authored global stylesheets, ${moduleFiles.length} CSS Modules.`,
);
for (const filePath of [...configuredGlobalPaths].sort()) {
  const actual = currentCounts.get(filePath);
  const limit = legacyGlobalStyles[filePath].maxLines;
  if (actual !== undefined) {
    console.log(`  ${actual}/${limit} lines  ${filePath}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`css-architecture: ${error}`);
  }
  console.error(
    "Legacy global CSS is frozen. Extract component-owned rules into CSS Modules; do not raise a limit without explicit architectural justification.",
  );
  process.exit(1);
}

if (options.record) {
  for (const { filePath, actual } of belowBaseline) {
    legacyGlobalStyles[filePath].maxLines = actual;
  }
  if (belowBaseline.length > 0) {
    baseline.updated = new Date().toISOString().slice(0, 10);
    await writeFile(
      baselinePath,
      `${JSON.stringify(baseline, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `css-architecture: ratcheted ${belowBaseline.length} limit${belowBaseline.length === 1 ? "" : "s"} downward.`,
    );
  } else {
    console.log("css-architecture: all limits already match current counts.");
  }
} else if (belowBaseline.length > 0) {
  console.log(
    `css-architecture: below baseline; run pnpm css:check --record to ratchet ${belowBaseline
      .map(({ filePath, actual, limit }) => `${filePath} ${limit}->${actual}`)
      .join(", ")}.`,
  );
}
