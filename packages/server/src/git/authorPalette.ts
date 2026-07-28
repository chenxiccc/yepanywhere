import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureManagedProjectDir } from "../projects/managedProjectDir.js";
import { runGit } from "./gitExec.js";

const PALETTE_VERSION = 1;
const GIT_AUTHOR_PALETTE_FILE = "git-author-palette.json";
const AUTHOR_LOG_FORMAT = "%x1e%aN%x1f%aE";
const AUTHOR_LOG_MAX_BUFFER = 64 * 1024 * 1024;
const AUTHOR_LOG_TIMEOUT_MS = 20_000;

interface PersistedAuthorColor {
  seed: number;
}

interface PersistedGitAuthorPalette {
  version: typeof PALETTE_VERSION;
  head: string;
  authors: Record<string, PersistedAuthorColor>;
}

export interface GitAuthorPalette {
  head: string;
  seeds: ReadonlyMap<string, number>;
}

const loaded = new Map<string, PersistedGitAuthorPalette>();
const inFlight = new Map<string, Promise<GitAuthorPalette | null>>();

/**
 * Refresh the durable project palette. A failed incremental/load attempt
 * discards its state and gets exactly one full-history regeneration attempt.
 */
export function getGitAuthorPalette(
  projectPath: string,
): Promise<GitAuthorPalette | null> {
  const pending = inFlight.get(projectPath);
  if (pending) return pending;

  const refresh = refreshPalette(projectPath).finally(() => {
    if (inFlight.get(projectPath) === refresh) inFlight.delete(projectPath);
  });
  inFlight.set(projectPath, refresh);
  return refresh;
}

export async function warmGitAuthorPalette(projectPath: string): Promise<void> {
  await getGitAuthorPalette(projectPath);
}

export function getGitAuthorIdentity(name: string, email: string): string {
  return `${name.trim()}\0${email.trim().replace(/^<|>$/g, "")}`;
}

async function refreshPalette(
  projectPath: string,
): Promise<GitAuthorPalette | null> {
  let filePath: string | undefined;
  try {
    filePath = await paletteFilePath(projectPath);
    const existing = await loadPalette(filePath, projectPath);
    return existing
      ? await updatePalette(projectPath, filePath, existing)
      : await regeneratePalette(projectPath, filePath);
  } catch {
    loaded.delete(projectPath);
  }

  try {
    filePath ??= await paletteFilePath(projectPath);
    return await regeneratePalette(projectPath, filePath);
  } catch {
    loaded.delete(projectPath);
    if (filePath) await unlink(filePath).catch(() => undefined);
    return null;
  }
}

async function paletteFilePath(projectPath: string): Promise<string> {
  const directory = await ensureManagedProjectDir(projectPath, ".yep");
  return join(directory, GIT_AUTHOR_PALETTE_FILE);
}

async function loadPalette(
  filePath: string,
  projectPath: string,
): Promise<PersistedGitAuthorPalette | null> {
  const cached = loaded.get(projectPath);
  if (cached) return cached;
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<PersistedGitAuthorPalette>;
  if (
    parsed.version !== PALETTE_VERSION ||
    typeof parsed.head !== "string" ||
    !parsed.authors ||
    typeof parsed.authors !== "object" ||
    Object.values(parsed.authors).some(
      (entry) =>
        !entry ||
        typeof entry.seed !== "number" ||
        !Number.isFinite(entry.seed),
    )
  ) {
    throw new Error("Invalid Git author palette");
  }
  const palette = parsed as PersistedGitAuthorPalette;
  loaded.set(projectPath, palette);
  return palette;
}

async function updatePalette(
  projectPath: string,
  filePath: string,
  existing: PersistedGitAuthorPalette,
): Promise<GitAuthorPalette> {
  const head = await getHead(projectPath);
  if (existing.head === head) return publicPalette(existing);
  const identities = await listAuthorIdentities(
    projectPath,
    `${existing.head}..${head}`,
  );
  const next: PersistedGitAuthorPalette = {
    version: PALETTE_VERSION,
    head,
    authors: { ...existing.authors },
  };
  addAuthors(next.authors, identities);
  await savePalette(filePath, next);
  loaded.set(projectPath, next);
  return publicPalette(next);
}

async function regeneratePalette(
  projectPath: string,
  filePath: string,
): Promise<GitAuthorPalette> {
  const head = await getHead(projectPath);
  const identities = await listAuthorIdentities(projectPath, head);
  const next: PersistedGitAuthorPalette = {
    version: PALETTE_VERSION,
    head,
    authors: {},
  };
  addAuthors(next.authors, identities);
  await savePalette(filePath, next);
  loaded.set(projectPath, next);
  return publicPalette(next);
}

function addAuthors(
  authors: Record<string, PersistedAuthorColor>,
  identities: readonly string[],
): void {
  const used = Object.values(authors).map((entry) => entry.seed);
  for (const identity of identities) {
    if (authors[identity]) continue;
    const seed = chooseAuthorColorSeed(identity, used);
    authors[identity] = {
      seed,
    };
    used.push(seed);
  }
}

export function chooseAuthorColorSeed(
  identity: string,
  usedSeeds: readonly number[],
): number {
  const preferred = stableHash(identity) % 360;
  if (usedSeeds.length === 0) return preferred;
  const occupied = new Set(
    usedSeeds.map((seed) => positiveModulo(Math.round(seed), 360)),
  );
  // Every available degree already has an author. Reusing the stable
  // preference is then optimal and avoids an unbounded all-authors scan.
  if (occupied.size === 360) return preferred;

  let best = preferred;
  let bestDistance = -1;
  let bestPreferenceDistance = Number.POSITIVE_INFINITY;
  for (let candidate = 0; candidate < 360; candidate += 1) {
    let distance = 180;
    for (const used of occupied) {
      distance = Math.min(distance, circularHueDistance(candidate, used));
    }
    const preferenceDistance = circularHueDistance(candidate, preferred);
    if (
      distance > bestDistance ||
      (distance === bestDistance && preferenceDistance < bestPreferenceDistance)
    ) {
      best = candidate;
      bestDistance = distance;
      bestPreferenceDistance = preferenceDistance;
    }
  }
  return best;
}

async function getHead(projectPath: string): Promise<string> {
  const { stdout } = await runGit(
    projectPath,
    ["rev-parse", "--verify", "HEAD"],
    { timeout: AUTHOR_LOG_TIMEOUT_MS },
  );
  const head = stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head)) {
    throw new Error("Git HEAD did not resolve to a full commit id");
  }
  return head;
}

async function listAuthorIdentities(
  projectPath: string,
  revision: string,
): Promise<string[]> {
  const { stdout } = await runGit(
    projectPath,
    ["log", "--reverse", `--format=${AUTHOR_LOG_FORMAT}`, revision],
    {
      maxBuffer: AUTHOR_LOG_MAX_BUFFER,
      timeout: AUTHOR_LOG_TIMEOUT_MS,
    },
  );
  const identities: string[] = [];
  for (const record of stdout.split("\x1e")) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [name = "", email = ""] = trimmed.split("\x1f");
    const identity = getGitAuthorIdentity(name, email);
    if (identity !== "\0") identities.push(identity);
  }
  return identities;
}

async function savePalette(
  filePath: string,
  palette: PersistedGitAuthorPalette,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(palette, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function publicPalette(palette: PersistedGitAuthorPalette): GitAuthorPalette {
  return {
    head: palette.head,
    seeds: new Map(
      Object.entries(palette.authors).map(([identity, color]) => [
        identity,
        color.seed,
      ]),
    ),
  };
}

function circularHueDistance(left: number, right: number): number {
  const distance = Math.abs(left - right) % 360;
  return Math.min(distance, 360 - distance);
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function resetGitAuthorPaletteForTests(): void {
  loaded.clear();
  inFlight.clear();
}
