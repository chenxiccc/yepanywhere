import type { UrlProjectId } from "@yep-anywhere/shared";
import type { ProviderCatalogFamily } from "./provider-catalog-family.js";

export type SessionCatalogFidelity = "identity" | "head" | "tail";

export type SessionCatalogLocation =
  | { kind: "file"; path: string }
  | { kind: "database"; path: string; recordId: string }
  | { kind: "provider"; recordId: string };

/**
 * Compact provider-native facts retained independently of transcript detail.
 * Adapters must yield at most one row per (family, store, native session id).
 */
export interface SessionCatalogRow {
  catalogFamily: ProviderCatalogFamily;
  storeKey: string;
  sessionId: string;
  projectId: UrlProjectId;
  /** Canonical host path for explicit detail resolution. */
  projectPath: string;
  /** Case/platform-normalized project membership key. */
  projectIdentityKey: string;
  updatedAt: string;
  createdAt?: string;
  title?: string | null;
  fidelity: SessionCatalogFidelity;
  /** Exact provider source identity that established this row. */
  sourceVersion: string;
  location: SessionCatalogLocation;
}

export interface SessionCatalogRowKey {
  catalogFamily: ProviderCatalogFamily;
  storeKey: string;
  sessionId: string;
}

export type SessionCatalogScanMode =
  | { kind: "complete" }
  | { kind: "recent"; activeAfterMs: number };

export interface SessionCatalogScanContext {
  catalogEpoch: string;
  targetGeneration: number;
  mode: SessionCatalogScanMode;
  signal: AbortSignal;
}

export interface SessionCatalogAdapterScan {
  /** Provider-wide source version for diagnostics and reconciliation. */
  sourceVersion: string;
  rows: Iterable<SessionCatalogRow> | AsyncIterable<SessionCatalogRow>;
  metrics?: Readonly<Record<string, number>>;
}

/** One install-wide scan adapter per eligible native provider store. */
export interface NativeSessionCatalogAdapter {
  catalogFamily: ProviderCatalogFamily;
  storeKey: string;
  scan(context: SessionCatalogScanContext): Promise<SessionCatalogAdapterScan>;
}

export function sessionCatalogRowKey(
  row: SessionCatalogRow | SessionCatalogRowKey,
): string {
  return JSON.stringify([row.catalogFamily, row.storeKey, row.sessionId]);
}
