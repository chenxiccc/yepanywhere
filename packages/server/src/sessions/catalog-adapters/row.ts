import type { UrlProjectId } from "@yep-anywhere/shared";
import {
  canonicalizeProjectPath,
  encodeProjectId,
  getProjectIdentityKey,
} from "../../projects/paths.js";
import type {
  SessionCatalogFidelity,
  SessionCatalogLocation,
  SessionCatalogRow,
  SessionCatalogScanMode,
} from "../catalog-types.js";
import type { ProviderCatalogFamily } from "../provider-catalog-family.js";

/**
 * The project identity every adapter must derive the same way. A catalog row's
 * membership is a canonical host path, never the provider's own encoding of it:
 * Grok percent-encodes a cwd, pi flattens separators, and OpenCode hides the
 * worktree behind an opaque id, so only the decoded path joins across families.
 */
export interface CatalogProjectIdentity {
  projectId: UrlProjectId;
  projectPath: string;
  projectIdentityKey: string;
}

export function catalogProjectIdentity(
  projectPath: string,
): CatalogProjectIdentity {
  const canonical = canonicalizeProjectPath(projectPath);
  return {
    projectId: encodeProjectId(canonical),
    projectPath: canonical,
    projectIdentityKey: getProjectIdentityKey(canonical),
  };
}

export interface BuildCatalogRowInput {
  catalogFamily: ProviderCatalogFamily;
  storeKey: string;
  sessionId: string;
  projectPath: string;
  updatedAtMs: number;
  createdAtMs?: number | undefined;
  title?: string | null | undefined;
  fidelity: SessionCatalogFidelity;
  sourceVersion: string;
  location: SessionCatalogLocation;
}

export function buildCatalogRow(
  input: BuildCatalogRowInput,
): SessionCatalogRow {
  const identity = catalogProjectIdentity(input.projectPath);
  return {
    catalogFamily: input.catalogFamily,
    storeKey: input.storeKey,
    sessionId: input.sessionId,
    ...identity,
    updatedAt: new Date(input.updatedAtMs).toISOString(),
    ...(input.createdAtMs === undefined
      ? {}
      : { createdAt: new Date(input.createdAtMs).toISOString() }),
    ...(input.title === undefined ? {} : { title: input.title }),
    fidelity: input.fidelity,
    sourceVersion: input.sourceVersion,
    location: input.location,
  };
}

/**
 * Recent mode is a cheap mtime gate, applied before an adapter opens anything.
 * It is a filter on rows, not a cache key: the same store scanned in complete
 * mode yields a superset, so a later complete pass repairs whatever it skipped.
 */
export function isWithinScanMode(
  mode: SessionCatalogScanMode,
  updatedAtMs: number,
): boolean {
  return mode.kind === "complete" || updatedAtMs >= mode.activeAfterMs;
}

/** File identity that changes on every append, truncation, or replacement. */
export function fileSourceVersion(mtimeMs: number, size: number): string {
  return `${Math.trunc(mtimeMs)}:${size}`;
}
