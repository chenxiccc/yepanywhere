/**
 * BrowserProfileService - Tracks browser profiles and their connection origins
 *
 * Handles:
 * - Recording connection metadata (origin, scheme, hostname, port)
 * - Persisting browser profile history to disk
 * - Providing profile data for the Devices settings UI
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  BrowserProfileInfo,
  BrowserProfileOrigin,
} from "@yep-anywhere/shared";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";

const CURRENT_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_BROWSER_PROFILE_RETENTION_DAYS = 30;
export const DEFAULT_BROWSER_PROFILE_MAX_NON_SUBSCRIBED_PROFILES = 20;

/** Internal state structure for persistence */
interface BrowserProfileState {
  version: number;
  profiles: Record<string, StoredBrowserProfile>;
}

/** Stored profile without deviceName (added at query time from push service) */
interface StoredBrowserProfile {
  browserProfileId: string;
  origins: BrowserProfileOrigin[];
  createdAt: string;
  lastActiveAt: string;
}

/** Origin metadata received from client connection */
export interface OriginMetadata {
  origin: string;
  scheme: string;
  hostname: string;
  port: number | null;
  userAgent: string;
}

export interface BrowserProfileServiceOptions {
  /** Directory to store profile data (defaults to ~/.yep-anywhere) */
  dataDir?: string;
  /** Days to retain profiles with no push subscription. 0 disables age pruning. */
  retentionDays?: number;
  /** Maximum profiles with no push subscription. 0 disables count pruning. */
  maxNonSubscribedProfiles?: number;
  /** Browser profile ids that must not be pruned, such as push subscriptions. */
  getProtectedBrowserProfileIds?: () => Iterable<string>;
  /** Current time provider for tests. */
  now?: () => Date;
}

export class BrowserProfileService {
  private state: BrowserProfileState;
  private dataDir: string;
  private filePath: string;
  private initialized = false;
  private save = createCoalescingSaver(() => this.doSave()).save;
  private readonly retentionMs: number | null;
  private readonly maxNonSubscribedProfiles: number | null;
  private readonly getProtectedBrowserProfileIds: () => Iterable<string>;
  private readonly now: () => Date;

  constructor(options: BrowserProfileServiceOptions = {}) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(this.dataDir, "browser-profiles.json");
    this.state = { version: CURRENT_VERSION, profiles: {} };
    const retentionDays =
      options.retentionDays ?? DEFAULT_BROWSER_PROFILE_RETENTION_DAYS;
    const maxNonSubscribedProfiles =
      options.maxNonSubscribedProfiles ??
      DEFAULT_BROWSER_PROFILE_MAX_NON_SUBSCRIBED_PROFILES;
    this.retentionMs =
      retentionDays > 0 ? Math.floor(retentionDays) * DAY_MS : null;
    this.maxNonSubscribedProfiles =
      maxNonSubscribedProfiles > 0
        ? Math.floor(maxNonSubscribedProfiles)
        : null;
    this.getProtectedBrowserProfileIds =
      options.getProtectedBrowserProfileIds ?? (() => []);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Initialize the service by loading state from disk.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.dataDir, { recursive: true });

      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as BrowserProfileState;

      if (parsed.version === CURRENT_VERSION) {
        this.state = parsed;
      } else {
        // Future: handle migrations
        this.state = {
          version: CURRENT_VERSION,
          profiles: parsed.profiles ?? {},
        };
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[BrowserProfileService] Failed to load profiles, starting fresh:",
          error,
        );
      }
      this.state = { version: CURRENT_VERSION, profiles: {} };
    }

    this.initialized = true;
    await this.pruneProfiles();
  }

  /**
   * Record a connection from a browser profile.
   * Updates lastSeen if origin exists, or adds new origin.
   */
  async recordConnection(
    browserProfileId: string,
    metadata: OriginMetadata,
  ): Promise<void> {
    this.ensureInitialized();

    const now = this.now().toISOString();
    let profile = this.state.profiles[browserProfileId];

    if (!profile) {
      // New profile
      profile = {
        browserProfileId,
        origins: [],
        createdAt: now,
        lastActiveAt: now,
      };
      this.state.profiles[browserProfileId] = profile;
    }

    // Update lastActiveAt
    profile.lastActiveAt = now;

    // Find existing origin or add new one
    const existingOrigin = profile.origins.find(
      (o) => o.origin === metadata.origin,
    );

    if (existingOrigin) {
      // Update existing origin
      existingOrigin.lastSeen = now;
      existingOrigin.userAgent = metadata.userAgent;
    } else {
      // Add new origin
      profile.origins.push({
        origin: metadata.origin,
        scheme: metadata.scheme,
        hostname: metadata.hostname,
        port: metadata.port,
        userAgent: metadata.userAgent,
        firstSeen: now,
        lastSeen: now,
      });
    }

    this.pruneProfilesFromState();
    await this.save();
  }

  /**
   * Get all browser profiles.
   */
  getProfiles(): StoredBrowserProfile[] {
    this.ensureInitialized();
    return Object.values(this.state.profiles);
  }

  /**
   * Get profiles enriched with device names from push subscriptions.
   */
  getProfilesWithDeviceNames(
    pushSubscriptions: Record<string, { deviceName?: string }>,
  ): BrowserProfileInfo[] {
    this.ensureInitialized();

    return Object.values(this.state.profiles).map((profile) => ({
      ...profile,
      deviceName: pushSubscriptions[profile.browserProfileId]?.deviceName,
    }));
  }

  /**
   * Get a specific profile by ID.
   */
  getProfile(browserProfileId: string): StoredBrowserProfile | null {
    this.ensureInitialized();
    return this.state.profiles[browserProfileId] ?? null;
  }

  /**
   * Delete a profile (forget device).
   */
  async deleteProfile(browserProfileId: string): Promise<boolean> {
    this.ensureInitialized();

    if (!this.state.profiles[browserProfileId]) {
      return false;
    }

    delete this.state.profiles[browserProfileId];
    await this.save();
    return true;
  }

  /**
   * Prune stale or over-limit profiles that are not protected by push state.
   */
  async pruneProfiles(): Promise<number> {
    this.ensureInitialized();

    const removed = this.pruneProfilesFromState();
    if (removed > 0) {
      await this.save();
    }
    return removed;
  }

  /**
   * Get profile count.
   */
  getProfileCount(): number {
    return Object.keys(this.state.profiles).length;
  }

  /**
   * Ensure service is initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "BrowserProfileService not initialized. Call initialize() first.",
      );
    }
  }

  private pruneProfilesFromState(): number {
    const idsToPrune = this.getPrunableProfileIds();
    for (const id of idsToPrune) {
      delete this.state.profiles[id];
    }
    return idsToPrune.length;
  }

  private getPrunableProfileIds(): string[] {
    const protectedIds = new Set(this.getProtectedBrowserProfileIds());
    const candidates = Object.values(this.state.profiles).filter(
      (profile) => !protectedIds.has(profile.browserProfileId),
    );
    const idsToPrune = new Set<string>();

    if (this.retentionMs !== null) {
      const cutoff = this.now().getTime() - this.retentionMs;
      for (const profile of candidates) {
        if (this.profileLastActiveMs(profile) < cutoff) {
          idsToPrune.add(profile.browserProfileId);
        }
      }
    }

    if (this.maxNonSubscribedProfiles !== null) {
      const remainingCandidates = candidates.filter(
        (profile) => !idsToPrune.has(profile.browserProfileId),
      );
      const overage =
        remainingCandidates.length - this.maxNonSubscribedProfiles;
      if (overage > 0) {
        const excessProfiles = remainingCandidates
          .sort(
            (a, b) => this.profileLastActiveMs(a) - this.profileLastActiveMs(b),
          )
          .slice(0, overage);
        for (const profile of excessProfiles) {
          idsToPrune.add(profile.browserProfileId);
        }
      }
    }

    return Array.from(idsToPrune);
  }

  private profileLastActiveMs(profile: StoredBrowserProfile): number {
    const lastActiveMs = Date.parse(profile.lastActiveAt);
    if (!Number.isNaN(lastActiveMs)) {
      return lastActiveMs;
    }

    const createdMs = Date.parse(profile.createdAt);
    return Number.isNaN(createdMs) ? 0 : createdMs;
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[BrowserProfileService] Failed to save profiles:", error);
      throw error;
    }
  }

  /**
   * Get file path (for testing).
   */
  getFilePath(): string {
    return this.filePath;
  }
}
