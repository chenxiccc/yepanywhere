import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

export const GEMINI_TMP_DIR =
  process.env.GEMINI_SESSIONS_DIR ?? join(homedir(), ".gemini", "tmp");
export const GEMINI_DIR = GEMINI_TMP_DIR.replace(
  new RegExp(`\\${sep}tmp$`),
  "",
);
export const PROJECT_MAP_FILE = join(GEMINI_TMP_DIR, "project-map.json");

/**
 * Compute SHA-256 hash of a path (how Gemini creates projectHash).
 */
export function hashProjectPath(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

export interface ProjectMapData {
  // hash -> cwd
  [hash: string]: string;
}

export class GeminiProjectMap {
  private map: Map<string, string> = new Map();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private mapFile: string = PROJECT_MAP_FILE) {}

  /**
   * Load the map from disk.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;

    const loadPromise = this.loadFromDisk();
    this.loadPromise = loadPromise;
    try {
      await loadPromise;
    } finally {
      if (this.loadPromise === loadPromise) {
        this.loadPromise = null;
      }
    }
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const content = await readFile(this.mapFile, "utf-8");
      const data = JSON.parse(content) as ProjectMapData;
      this.map = new Map(Object.entries(data));
    } catch {
      // File doesn't exist or is invalid, start with empty map
      this.map = new Map();
    }
    this.loaded = true;
  }

  private async persist(candidate: Map<string, string>): Promise<void> {
    const data: ProjectMapData = Object.fromEntries(candidate.entries());
    const tempPath = `${this.mapFile}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

    await mkdir(dirname(this.mapFile), { recursive: true });
    try {
      await writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
      await rename(tempPath, this.mapFile);
    } catch (error) {
      await unlink(tempPath).catch(() => {
        // Best-effort cleanup for failed atomic writes.
      });
      console.error("Failed to save Gemini project map:", error);
      throw error;
    }
  }

  private enqueueMutation(
    mutate: (candidate: Map<string, string>) => boolean | Promise<boolean>,
  ): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      await this.load();
      const candidate = new Map(this.map);
      if (!(await mutate(candidate))) return;
      await this.persist(candidate);
      this.map = candidate;
    });
    this.mutationTail = operation.catch(() => {
      // Keep later mutations runnable while the originating caller observes
      // the persistence failure.
    });
    return operation;
  }

  /**
   * Save the current map through the same serialized atomic writer used by
   * mutations.
   */
  async save(): Promise<void> {
    await this.enqueueMutation(() => true);
  }

  /**
   * Get CWD for a project hash.
   */
  async get(hash: string): Promise<string | undefined> {
    await this.load();
    await this.mutationTail;
    return this.map.get(hash);
  }

  /**
   * Set CWD for a project hash and save.
   */
  async set(hash: string, cwd: string): Promise<void> {
    await this.enqueueMutation((candidate) => {
      if (candidate.get(hash) === cwd) return false;
      candidate.set(hash, cwd);
      return true;
    });
  }

  /**
   * Alias for set, used in tests/logic sometimes
   */
  async add(hash: string, cwd: string): Promise<void> {
    return this.set(hash, cwd);
  }

  /**
   * Remove an entry.
   */
  async remove(hash: string): Promise<void> {
    await this.enqueueMutation((candidate) => candidate.delete(hash));
  }

  /**
   * Get all entries.
   */
  async getAll(): Promise<Map<string, string>> {
    await this.load();
    await this.mutationTail;
    return new Map(this.map);
  }

  /**
   * Clean invalid entries using a validator function.
   */
  async clean(validator: (cwd: string) => Promise<boolean>): Promise<void> {
    await this.enqueueMutation(async (candidate) => {
      const initialSize = candidate.size;
      for (const [hash, cwd] of candidate.entries()) {
        if (!(await validator(cwd))) {
          candidate.delete(hash);
        }
      }
      return candidate.size !== initialSize;
    });
  }

  /**
   * Register a project path (computes hash and saves).
   */
  async register(cwd: string): Promise<string> {
    const hash = hashProjectPath(cwd);
    await this.set(hash, cwd);
    return hash;
  }
}

export const geminiProjectMap = new GeminiProjectMap();
