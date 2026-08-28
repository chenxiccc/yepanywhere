import {
  PUBLIC_SHARE_TITLE_MAX_LENGTH,
  isUrlProjectId,
  type PublicFileShareManagementItem,
  type PublicShareStorageState,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { enforceOwnerOnlyPathPermissionsStrict } from "../utils/filePermissions.js";
import {
  atomicWritePublicShareJson,
  ensurePrivateDirectory,
  publicShareAtomicWriteCommitted,
  removeOwnedAtomicControlTemps,
  type PublicShareAtomicWriteHooks,
} from "./PublicSharePrivateStorage.js";

export interface PublicFileShareGrant extends PublicFileShareManagementItem {
  version: 1;
  secretHash: string;
  projectId: UrlProjectId;
  path: string;
}

interface PublicFileShareGrantFile {
  version: 1;
  grants: PublicFileShareGrant[];
}

export interface CreatePublicFileShareGrantOptions {
  secretHash: string;
  publicUrl: string;
  projectId: UrlProjectId;
  path: string;
  title: string | null;
}

const EMPTY_GRANT_FILE: PublicFileShareGrantFile = { version: 1, grants: [] };
const FILE_GRANTS_NAME = "file-grants.json";
const OPAQUE_ID_REGEX = /^[A-Za-z0-9_-]{16,128}$/;
const SECRET_HASH_REGEX = /^[A-Za-z0-9_-]{86}$/;
const MAX_PROJECT_FILE_PATH_LENGTH = 4_096;
const MAX_PUBLIC_URL_LENGTH = 4_096;

function isNormalizedProjectFilePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PROJECT_FILE_PATH_LENGTH ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return (
    normalized === value &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

function isPublicUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_PUBLIC_URL_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isOptionalGrantText(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length <= PUBLIC_SHARE_TITLE_MAX_LENGTH)
  );
}

function isPublicFileShareGrant(value: unknown): value is PublicFileShareGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  return (
    grant.version === 1 &&
    typeof grant.shareId === "string" &&
    OPAQUE_ID_REGEX.test(grant.shareId) &&
    typeof grant.secretHash === "string" &&
    SECRET_HASH_REGEX.test(grant.secretHash) &&
    isPublicUrl(grant.url) &&
    typeof grant.projectId === "string" &&
    isUrlProjectId(grant.projectId) &&
    isNormalizedProjectFilePath(grant.path) &&
    isOptionalGrantText(grant.title) &&
    typeof grant.createdAt === "string" &&
    typeof grant.updatedAt === "string"
  );
}

export class PublicFileShareStore {
  private readonly root: string;
  private readonly grantsPath: string;
  private readonly grants = new Map<string, PublicFileShareGrant>();
  private readiness: PublicShareStorageState = "opening";
  private readinessError: string | null = null;
  private desiredEnabled = true;
  private disableRequired = false;
  private lifecycleRequest = 0;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private openPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly hooks: PublicShareAtomicWriteHooks = {},
  ) {
    this.root = path.join(dataDir, "public-shares");
    this.grantsPath = path.join(this.root, FILE_GRANTS_NAME);
  }

  initialize(enabled = true): Promise<void> {
    return this.requestLifecycle(enabled, !enabled, async (request) => {
      await this.ensureOpened();
      if (enabled) {
        if (this.disableRequired) await this.reconcileDisabled(request);
        if (!this.isCurrentLifecycleRequest(request, true)) return;
        this.reconcileEnabled(request);
      } else {
        await this.reconcileDisabled(request);
      }
    });
  }

  getReadiness(): { state: PublicShareStorageState; error: string | null } {
    return { state: this.readiness, error: this.readinessError };
  }

  getAllGrants(): PublicFileShareGrant[] {
    return [...this.grants.values()];
  }

  getGrantBySecretHash(secretHash: string): PublicFileShareGrant | null {
    return this.grants.get(secretHash) ?? null;
  }

  async createGrant(
    options: CreatePublicFileShareGrantOptions,
  ): Promise<PublicFileShareGrant> {
    return await this.withMutation(async () => {
      this.assertReady();
      if (this.grants.has(options.secretHash)) {
        throw new Error("Public share secret hash is already in use");
      }
      if (
        !isNormalizedProjectFilePath(options.path) ||
        !isOptionalGrantText(options.title)
      ) {
        throw new Error("Public file share metadata is invalid");
      }
      const now = new Date().toISOString();
      const grant: PublicFileShareGrant = {
        version: 1,
        shareId: randomBytes(12).toString("base64url"),
        secretHash: options.secretHash,
        url: options.publicUrl,
        projectId: options.projectId,
        path: options.path,
        title: options.title,
        createdAt: now,
        updatedAt: now,
      };
      if (!isPublicFileShareGrant(grant)) {
        throw new Error("Public file share metadata is invalid");
      }
      const next = new Map(this.grants);
      next.set(grant.secretHash, grant);
      await this.replaceGrants(next);
      return grant;
    });
  }

  async revokeShare(shareId: string): Promise<boolean> {
    return await this.withMutation(async () => {
      this.assertReady();
      const next = new Map(this.grants);
      let revoked = false;
      for (const [secretHash, grant] of next) {
        if (grant.shareId !== shareId) continue;
        next.delete(secretHash);
        revoked = true;
      }
      if (revoked) await this.replaceGrants(next);
      return revoked;
    });
  }

  async revokeAll(): Promise<number> {
    return await this.withMutation(async () => {
      this.assertReady();
      const revokedCount = this.grants.size;
      if (revokedCount > 0) await this.replaceGrants(new Map());
      return revokedCount;
    });
  }

  disable(): Promise<number> {
    return this.requestLifecycle(false, true, async (request) => {
      await this.ensureOpened();
      return await this.reconcileDisabled(request);
    });
  }

  enable(): Promise<void> {
    return this.requestLifecycle(true, false, async (request) => {
      await this.ensureOpened();
      if (this.disableRequired) await this.reconcileDisabled(request);
      if (!this.isCurrentLifecycleRequest(request, true)) return;
      this.reconcileEnabled(request);
    });
  }

  private requestLifecycle<T>(
    enabled: boolean,
    mustApply: boolean,
    operation: (request: number) => Promise<T>,
  ): Promise<T> {
    this.desiredEnabled = enabled;
    if (!enabled) this.disableRequired = true;
    const request = ++this.lifecycleRequest;
    this.readiness = "opening";
    this.readinessError = null;
    const result = this.lifecycleTail
      .catch(() => undefined)
      .then(async () => {
        if (!mustApply && !this.isCurrentLifecycleRequest(request, enabled)) {
          return undefined as T;
        }
        try {
          return await operation(request);
        } catch (error) {
          this.readiness = "failed";
          this.readinessError =
            error instanceof Error
              ? error.message
              : "Failed to change public file share store state";
          throw error;
        }
      });
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isCurrentLifecycleRequest(
    request: number,
    enabled: boolean,
  ): boolean {
    return this.lifecycleRequest === request && this.desiredEnabled === enabled;
  }

  private async ensureOpened(): Promise<void> {
    this.openPromise ??= this.openControlState();
    await this.openPromise;
  }

  private async openControlState(): Promise<void> {
    await ensurePrivateDirectory(this.root);
    await removeOwnedAtomicControlTemps(this.root, [FILE_GRANTS_NAME]);
    const file = await this.readGrantFile();
    this.grants.clear();
    const shareIds = new Set<string>();
    for (const grant of file.grants) {
      if (this.grants.has(grant.secretHash)) {
        throw new Error("Duplicate public file share secret hash");
      }
      if (shareIds.has(grant.shareId)) {
        throw new Error("Duplicate public file share ID");
      }
      shareIds.add(grant.shareId);
      this.grants.set(grant.secretHash, grant);
    }
  }

  private async reconcileDisabled(request: number): Promise<number> {
    return await this.withMutation(async () => {
      const revokedCount = this.grants.size;
      await this.replaceGrants(new Map());
      this.disableRequired = false;
      if (this.isCurrentLifecycleRequest(request, false)) {
        this.readiness = "disabled";
        this.readinessError = null;
      }
      return revokedCount;
    });
  }

  private reconcileEnabled(request: number): void {
    if (!this.isCurrentLifecycleRequest(request, true)) return;
    this.readiness = "ready";
    this.readinessError = null;
  }

  private async readGrantFile(): Promise<PublicFileShareGrantFile> {
    try {
      await enforceOwnerOnlyPathPermissionsStrict(this.grantsPath, "file");
      const parsed: unknown = JSON.parse(
        await fs.readFile(this.grantsPath, "utf8"),
      );
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        (parsed as { version?: unknown }).version !== 1 ||
        !Array.isArray((parsed as { grants?: unknown }).grants) ||
        !(parsed as { grants: unknown[] }).grants.every(isPublicFileShareGrant)
      ) {
        throw new Error("Public file share grant file is invalid");
      }
      return parsed as PublicFileShareGrantFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWritePublicShareJson(
        this.grantsPath,
        EMPTY_GRANT_FILE,
        this.hooks,
      );
      return EMPTY_GRANT_FILE;
    }
  }

  private async replaceGrants(
    candidate: Map<string, PublicFileShareGrant>,
  ): Promise<void> {
    const previous = new Map(this.grants);
    this.grants.clear();
    for (const [secretHash, grant] of candidate) {
      this.grants.set(secretHash, grant);
    }
    try {
      await atomicWritePublicShareJson(
        this.grantsPath,
        { version: 1, grants: [...this.grants.values()] },
        this.hooks,
      );
    } catch (error) {
      if (!publicShareAtomicWriteCommitted(error)) {
        this.grants.clear();
        for (const [secretHash, grant] of previous) {
          this.grants.set(secretHash, grant);
        }
      }
      throw error;
    }
  }

  private assertReady(): void {
    if (this.readiness !== "ready") {
      throw new Error(`Public file share store is ${this.readiness}`);
    }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}
