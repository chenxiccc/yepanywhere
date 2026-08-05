import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { EventBus } from "../src/watcher/EventBus.js";
import { FileWatcher } from "../src/watcher/FileWatcher.js";
import { ProviderSessionWatcherRegistry } from "../src/watcher/ProviderSessionWatcherRegistry.js";

const FAMILIES = ["claude", "gemini", "codex", "pi"] as const;
const DIRECTORIES_PER_FAMILY = 40;
const FILES_PER_DIRECTORY = 50;
const WRITE_BATCH_SIZE = 256;
const SAMPLES = 5;

async function createFixture(root: string): Promise<Map<string, string>> {
  const roots = new Map<string, string>();
  const writes: Array<{ path: string; content: string }> = [];
  for (const family of FAMILIES) {
    const familyRoot = join(root, family);
    roots.set(family, familyRoot);
    for (
      let directory = 0;
      directory < DIRECTORIES_PER_FAMILY;
      directory += 1
    ) {
      const directoryPath = join(familyRoot, String(directory));
      await mkdir(directoryPath, { recursive: true });
      for (let file = 0; file < FILES_PER_DIRECTORY; file += 1) {
        writes.push({
          path: join(directoryPath, `session-${file}.jsonl`),
          content: "{}\n",
        });
      }
    }
  }
  for (let offset = 0; offset < writes.length; offset += WRITE_BATCH_SIZE) {
    await Promise.all(
      writes
        .slice(offset, offset + WRITE_BATCH_SIZE)
        .map(({ path, content }) => writeFile(path, content)),
    );
  }
  return roots;
}

function legacySynchronousBaseline(root: string): {
  directories: number;
  files: number;
} {
  let directories = 0;
  let files = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    directories += 1;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else {
        statSync(fullPath);
        files += 1;
      }
    }
  }
  return { directories, files };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for scheduled watcher activation");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const scratchDir = join(tmpdir(), `provider-watch-benchmark-${randomUUID()}`);
let registry: ProviderSessionWatcherRegistry | undefined;
await mkdir(scratchDir, { recursive: true });
try {
  const roots = await createFixture(scratchDir);
  for (const root of roots.values()) {
    await readdir(root);
    await stat(root);
  }

  const specs = FAMILIES.map((family) => {
    const watchDir = roots.get(family);
    if (!watchDir) throw new Error(`Missing fixture root for ${family}`);
    return {
      family,
      provider: family,
      watchDir,
      rescanSlowLogThresholdMs: 60_000,
    };
  });
  const legacyBlockingSamples: number[] = [];
  const unusedActivationSamples: number[] = [];
  const eligibleRequestSamples: number[] = [];
  const eligibleAttachedSamples: number[] = [];
  const eligibleBaselineSamples: number[] = [];
  let fixtureDirectories = 0;
  let fixtureFiles = 0;
  let unusedDirectoryProbes = -1;
  let unusedWatchersStarted = -1;
  let eligibleAsyncFiles = -1;

  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const legacyStartedAt = performance.now();
    const legacy = [...roots.values()].reduce(
      (total, root) => {
        const scanned = legacySynchronousBaseline(root);
        total.directories += scanned.directories;
        total.files += scanned.files;
        return total;
      },
      { directories: 0, files: 0 },
    );
    legacyBlockingSamples.push(performance.now() - legacyStartedAt);
    fixtureDirectories = legacy.directories;
    fixtureFiles = legacy.files;

    const createdWatchers: FileWatcher[] = [];
    registry = new ProviderSessionWatcherRegistry({
      eventBus: new EventBus(),
      specs,
      createWatcher: (options) => {
        const watcher = new FileWatcher(options);
        createdWatchers.push(watcher);
        return watcher;
      },
    });

    const unusedStartedAt = performance.now();
    registry.requestActivation([]);
    unusedActivationSamples.push(performance.now() - unusedStartedAt);
    const unusedMetrics = registry.getMetrics();
    unusedDirectoryProbes = unusedMetrics.directoryProbes;
    unusedWatchersStarted = unusedMetrics.watchersStarted;

    const eligibleStartedAt = performance.now();
    registry.requestActivation(["codex"]);
    eligibleRequestSamples.push(performance.now() - eligibleStartedAt);
    await waitFor(() => createdWatchers.length === 1);
    eligibleAttachedSamples.push(performance.now() - eligibleStartedAt);
    const baseline = await createdWatchers[0]?.waitForInitialBaseline();
    eligibleBaselineSamples.push(baseline?.durationMs ?? -1);
    eligibleAsyncFiles = baseline?.filesScanned ?? -1;
    registry.stop();
    registry = undefined;
  }

  const avoidedFilesPercent = 100 * (1 - unusedDirectoryProbes / 4);

  console.log(
    [
      "PROVIDER_WATCH_STARTUP:",
      `families=${FAMILIES.length}`,
      `fixture_directories=${fixtureDirectories}`,
      `fixture_files=${fixtureFiles}`,
      `samples=${SAMPLES}`,
      `legacy_sync_blocking_median_ms=${median(legacyBlockingSamples).toFixed(2)}`,
      `unused_request_median_ms=${median(unusedActivationSamples).toFixed(3)}`,
      `unused_directory_probes=${unusedDirectoryProbes}`,
      `unused_watchers_started=${unusedWatchersStarted}`,
      `unused_probe_avoidance_percent=${avoidedFilesPercent.toFixed(2)}`,
      `eligible_request_median_ms=${median(eligibleRequestSamples).toFixed(3)}`,
      `eligible_watch_attached_median_ms=${median(eligibleAttachedSamples).toFixed(2)}`,
      `eligible_async_baseline_median_ms=${median(eligibleBaselineSamples).toFixed(2)}`,
      `eligible_async_files=${eligibleAsyncFiles}`,
    ].join(" "),
  );
} finally {
  registry?.stop();
  await rm(scratchDir, { recursive: true, force: true });
}
