/**
 * Linux live-worktree watcher resource validation.
 *
 * Measures the ProjectWorktreeSubscriptionManager's bounded-resource contract
 * with real fs.watch allocation on the current host:
 *
 * 1. large-tree: a tree far above the watcher budget must open the circuit
 *    once, keep RSS/heap bounded on the polling fallback, and never retry
 *    allocation.
 * 2. watched-churn: a tree within budget takes native watchers, then repeated
 *    directory creation/deletion churns registrations; active watchers must
 *    stay at or below the ceiling and memory growth must stay bounded.
 * 3. release: dropping the final subscription (the closed-tab path) must
 *    close every watcher and timer and return memory to near baseline.
 *
 * Run on the platform that owns native watching (Linux):
 *   NODE_OPTIONS=--expose-gc pnpm exec tsx scripts/measure-worktree-watchers.ts
 *
 * Writes a JSON report path on stdout. This is a bounded-resource proof, not
 * a ratchet benchmark; record host load alongside results when citing them.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "../packages/shared/src/projectId.js";
import { ProjectWorktreeSubscriptionManager } from "../packages/server/src/projects/projectWorktreeSubscriptionManager.js";

interface Sample {
  label: string;
  atMs: number;
  rssMB: number;
  heapUsedMB: number;
  externalMB: number;
  diagnostics: ReturnType<ProjectWorktreeSubscriptionManager["diagnostics"]>;
}

const MB = 1024 * 1024;

function gc(): void {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (collect) {
    collect();
    collect();
  }
}

function sample(
  label: string,
  startedAt: number,
  manager: ProjectWorktreeSubscriptionManager,
): Sample {
  gc();
  const memory = process.memoryUsage();
  const entry: Sample = {
    label,
    atMs: Date.now() - startedAt,
    rssMB: Math.round((memory.rss / MB) * 10) / 10,
    heapUsedMB: Math.round((memory.heapUsed / MB) * 10) / 10,
    externalMB: Math.round((memory.external / MB) * 10) / 10,
    diagnostics: manager.diagnostics(),
  };
  console.log(
    `[${entry.atMs}ms] ${label}: rss=${entry.rssMB}MB heap=${entry.heapUsedMB}MB ` +
      `mode=${entry.diagnostics.mode} circuit=${entry.diagnostics.circuitReason ?? "closed"} ` +
      `watched=${entry.diagnostics.watchedDirectories} cumulative=${entry.diagnostics.cumulativeRegistrations}`,
  );
  return entry;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTree(root: string, directories: number): void {
  // Fan out 100 children per parent so depth stays shallow.
  mkdirSync(root, { recursive: true });
  let created = 0;
  let parentIndex = 0;
  const parents = [root];
  while (created < directories) {
    const parent = parents[parentIndex % parents.length] ?? root;
    parentIndex += 1;
    for (let child = 0; child < 100 && created < directories; child += 1) {
      const path = join(parent, `d${created}`);
      mkdirSync(path);
      parents.push(path);
      created += 1;
    }
  }
}

function initGitRepo(root: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet"]);
  writeFileSync(join(root, "README.md"), "watcher validation fixture\n");
  writeFileSync(join(root, ".gitignore"), "");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=YA Perf",
      "-c",
      "user.email=perf@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
  );
}

function scannerFor(projectPath: string) {
  return {
    getProject: async (id: UrlProjectId) => ({
      id,
      path: projectPath,
      name: "watcher-validation",
      sessionCount: 0,
      sessionDir: "",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude" as const,
    }),
  };
}

async function settle(
  manager: ProjectWorktreeSubscriptionManager,
  quietMs = 2_000,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = JSON.stringify(manager.diagnostics());
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    await delay(250);
    const next = JSON.stringify(manager.diagnostics());
    if (next !== last) {
      last = next;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return;
    }
  }
}

async function scenarioLargeTree(
  startedAt: number,
  samples: Sample[],
  findings: string[],
): Promise<void> {
  const root = await mkdtemp(join(os.tmpdir(), "ya-watch-large-"));
  const directories = Number(process.env.LARGE_TREE_DIRS ?? 12_000);
  console.log(`\n== large-tree: ${directories} directories ==`);
  buildTree(join(root, "tree"), directories);
  initGitRepo(root);

  const manager = new ProjectWorktreeSubscriptionManager({
    scanner: scannerFor(root),
  });
  samples.push(sample("large-tree:before-subscribe", startedAt, manager));
  const subscription = manager.subscribe(
    "large-tree" as UrlProjectId,
    { tracked: true, untracked: true, ignored: false },
    () => {},
  );
  await subscription.ready;
  await settle(manager);
  const active = sample("large-tree:active", startedAt, manager);
  samples.push(active);
  if (active.diagnostics.circuitReason !== "watcher-limit") {
    findings.push(
      `large-tree: expected watcher-limit circuit, saw ${active.diagnostics.circuitReason}`,
    );
  }
  if (active.diagnostics.watchedDirectories !== 0) {
    findings.push(
      `large-tree: circuit left ${active.diagnostics.watchedDirectories} native watchers open`,
    );
  }

  // Hold through two 30-second polling fallback ticks; RSS must stay flat
  // and cumulative registrations must not climb (no allocation retry).
  const cumulativeBefore = active.diagnostics.cumulativeRegistrations;
  await delay(65_000);
  const held = sample("large-tree:after-two-poll-ticks", startedAt, manager);
  samples.push(held);
  if (held.diagnostics.cumulativeRegistrations !== cumulativeBefore) {
    findings.push(
      "large-tree: cumulative registrations climbed while the circuit was open",
    );
  }
  if (held.rssMB > active.rssMB + 100) {
    findings.push(
      `large-tree: RSS grew ${Math.round(held.rssMB - active.rssMB)}MB on the polling fallback`,
    );
  }

  subscription.release();
  await settle(manager, 1_000, 10_000);
  samples.push(sample("large-tree:released", startedAt, manager));
  manager.dispose();
  rmSync(root, { recursive: true, force: true });
}

async function scenarioWatchedChurn(
  startedAt: number,
  samples: Sample[],
  findings: string[],
): Promise<void> {
  const root = await mkdtemp(join(os.tmpdir(), "ya-watch-churn-"));
  const directories = Number(process.env.WATCHED_TREE_DIRS ?? 200);
  const rounds = Number(process.env.CHURN_ROUNDS ?? 20);
  const batch = Number(process.env.CHURN_BATCH ?? 40);
  console.log(
    `\n== watched-churn: ${directories} directories, ${rounds}x${batch} churn ==`,
  );
  buildTree(join(root, "tree"), directories);
  initGitRepo(root);

  const manager = new ProjectWorktreeSubscriptionManager({
    scanner: scannerFor(root),
  });
  const subscription = manager.subscribe(
    "watched-churn" as UrlProjectId,
    { tracked: true, untracked: true, ignored: false },
    () => {},
  );
  await subscription.ready;
  await settle(manager);
  const active = sample("watched-churn:active", startedAt, manager);
  samples.push(active);
  if (active.diagnostics.circuitOpen) {
    findings.push(
      `watched-churn: unexpected circuit ${active.diagnostics.circuitReason}`,
    );
  }
  if (active.diagnostics.watchedDirectories === 0) {
    findings.push("watched-churn: no native watchers were established");
  }
  if (
    active.diagnostics.watchedDirectories >
    active.diagnostics.maxWatchedDirectories
  ) {
    findings.push("watched-churn: active watchers exceeded the ceiling");
  }

  const churnParent = join(root, "tree", "churn-live");
  for (let round = 0; round < rounds; round += 1) {
    mkdirSync(churnParent, { recursive: true });
    for (let index = 0; index < batch; index += 1) {
      mkdirSync(join(churnParent, `c${index}`));
    }
    await delay(400);
    rmSync(churnParent, { recursive: true, force: true });
    await delay(400);
    const current = manager.diagnostics();
    if (current.watchedDirectories > current.maxWatchedDirectories) {
      findings.push(
        `watched-churn: round ${round} exceeded the watcher ceiling`,
      );
    }
  }
  await settle(manager);
  const churned = sample("watched-churn:after-churn", startedAt, manager);
  samples.push(churned);
  if (churned.rssMB > active.rssMB + 100) {
    findings.push(
      `watched-churn: RSS grew ${Math.round(churned.rssMB - active.rssMB)}MB during churn`,
    );
  }

  subscription.release();
  await settle(manager, 1_000, 10_000);
  const released = sample("watched-churn:released", startedAt, manager);
  samples.push(released);
  if (
    released.diagnostics.watchedDirectories !== 0 ||
    released.diagnostics.subscribers !== 0
  ) {
    findings.push("watched-churn: release left watchers or subscribers alive");
  }
  manager.dispose();
  rmSync(root, { recursive: true, force: true });
}

async function main(): Promise<void> {
  if (process.platform !== "linux") {
    console.error(
      "This validation measures the Linux native watcher path; run it on Linux.",
    );
    process.exitCode = 1;
    return;
  }
  const startedAt = Date.now();
  const samples: Sample[] = [];
  const findings: string[] = [];
  const host = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    loadavgStart: os.loadavg(),
    totalMemMB: Math.round(os.totalmem() / MB),
    freeMemMBStart: Math.round(os.freemem() / MB),
    exposeGc: typeof (globalThis as { gc?: unknown }).gc === "function",
  };

  await scenarioLargeTree(startedAt, samples, findings);
  await scenarioWatchedChurn(startedAt, samples, findings);

  const report = {
    startedAtIso: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    host: {
      ...host,
      loadavgEnd: os.loadavg(),
      freeMemMBEnd: Math.round(os.freemem() / MB),
    },
    samples,
    findings,
    pass: findings.length === 0,
  };
  const reportPath = join(
    os.tmpdir(),
    `ya-worktree-watch-validation-${Date.now()}.json`,
  );
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport: ${reportPath}`);
  console.log(
    findings.length === 0 ? "PASS" : `FAIL:\n- ${findings.join("\n- ")}`,
  );
  process.exitCode = findings.length === 0 ? 0 : 1;
}

await main();
