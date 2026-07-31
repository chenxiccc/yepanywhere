import type Database from "better-sqlite3";
import {
  generateOpaqueId,
  generateSecret,
  hashSecret,
  verifySecret,
} from "./credentials.js";
import type { PushTarget } from "./types.js";

export interface InstallationCredentials {
  installationId: string;
  installationSecret: string;
}

export interface SubscriptionCredentials {
  subscriptionId: string;
  sendSecret: string;
}

export interface InstallationRecord {
  id: string;
  target: PushTarget;
  createdAt: number;
  updatedAt: number;
}

export interface AuthenticatedSubscription {
  id: string;
  installationId: string;
  target: PushTarget;
}

interface InstallationRow {
  id: string;
  auth_hash: Buffer;
  provider: string;
  target_kind: string;
  target_value: string;
  created_at: number;
  updated_at: number;
}

interface SubscriptionRow {
  id: string;
  installation_id: string;
  send_hash: Buffer;
  provider: string;
  target_kind: string;
  target_value: string;
}

export class SubscriptionLimitError extends Error {
  constructor() {
    super("Subscription limit reached");
    this.name = "SubscriptionLimitError";
  }
}

export interface PushRepositoryOptions {
  maxSubscriptionsPerInstallation?: number;
  now?: () => number;
}

export class PushRepository {
  private readonly maxSubscriptionsPerInstallation: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Database.Database,
    options: PushRepositoryOptions = {},
  ) {
    this.maxSubscriptionsPerInstallation =
      options.maxSubscriptionsPerInstallation ?? 20;
    this.now = options.now ?? Date.now;
  }

  createInstallation(target: PushTarget): InstallationCredentials {
    const installationId = generateOpaqueId();
    const installationSecret = generateSecret();
    const now = this.now();

    this.db
      .prepare(
        `INSERT INTO installations
          (id, auth_hash, provider, target_kind, target_value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        installationId,
        hashSecret(installationSecret),
        target.provider,
        target.kind,
        target.value,
        now,
        now,
      );

    return { installationId, installationSecret };
  }

  authenticateInstallation(
    installationId: string,
    installationSecret: string,
  ): InstallationRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM installations WHERE id = ?")
      .get(installationId) as InstallationRow | undefined;

    if (!verifySecret(installationSecret, row?.auth_hash) || !row) {
      return undefined;
    }

    return installationFromRow(row);
  }

  updateInstallationTarget(
    installationId: string,
    target: PushTarget,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE installations
         SET provider = ?, target_kind = ?, target_value = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        target.provider,
        target.kind,
        target.value,
        this.now(),
        installationId,
      );
    return result.changes === 1;
  }

  deleteInstallation(installationId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM installations WHERE id = ?")
      .run(installationId);
    return result.changes === 1;
  }

  createSubscription(installationId: string): SubscriptionCredentials {
    return this.db.transaction(() => {
      const count = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM subscriptions
           WHERE installation_id = ? AND revoked_at IS NULL`,
        )
        .get(installationId) as { count: number };
      if (count.count >= this.maxSubscriptionsPerInstallation) {
        throw new SubscriptionLimitError();
      }

      const subscriptionId = generateOpaqueId();
      const sendSecret = generateSecret();
      this.db
        .prepare(
          `INSERT INTO subscriptions
            (id, installation_id, send_hash, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          subscriptionId,
          installationId,
          hashSecret(sendSecret),
          this.now(),
        );

      return { subscriptionId, sendSecret };
    })();
  }

  authenticateSubscription(
    subscriptionId: string,
    sendSecret: string,
  ): AuthenticatedSubscription | undefined {
    const row = this.db
      .prepare(
        `SELECT
           subscriptions.id,
           subscriptions.installation_id,
           subscriptions.send_hash,
           installations.provider,
           installations.target_kind,
           installations.target_value
         FROM subscriptions
         JOIN installations
           ON installations.id = subscriptions.installation_id
         WHERE subscriptions.id = ? AND subscriptions.revoked_at IS NULL`,
      )
      .get(subscriptionId) as SubscriptionRow | undefined;

    if (!verifySecret(sendSecret, row?.send_hash) || !row) {
      return undefined;
    }

    return {
      id: row.id,
      installationId: row.installation_id,
      target: pushTargetFromRow(row),
    };
  }

  touchSubscription(subscriptionId: string): void {
    this.db
      .prepare("UPDATE subscriptions SET last_used_at = ? WHERE id = ?")
      .run(this.now(), subscriptionId);
  }

  revokeSubscription(
    installationId: string,
    subscriptionId: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE subscriptions
         SET revoked_at = ?
         WHERE id = ? AND installation_id = ? AND revoked_at IS NULL`,
      )
      .run(this.now(), subscriptionId, installationId);
    return result.changes === 1;
  }

  countInstallations(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM installations")
      .get() as { count: number };
    return row.count;
  }

  countActiveSubscriptions(installationId?: string): number {
    const row =
      installationId === undefined
        ? (this.db
            .prepare(
              "SELECT COUNT(*) AS count FROM subscriptions WHERE revoked_at IS NULL",
            )
            .get() as { count: number })
        : (this.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM subscriptions
               WHERE installation_id = ? AND revoked_at IS NULL`,
            )
            .get(installationId) as { count: number });
    return row.count;
  }
}

function installationFromRow(row: InstallationRow): InstallationRecord {
  return {
    id: row.id,
    target: pushTargetFromRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pushTargetFromRow(row: {
  provider: string;
  target_kind: string;
  target_value: string;
}): PushTarget {
  if (
    row.provider !== "fcm" ||
    (row.target_kind !== "fid" &&
      row.target_kind !== "registration_token")
  ) {
    throw new Error("Unsupported push target stored in database");
  }

  return {
    provider: row.provider,
    kind: row.target_kind,
    value: row.target_value,
  };
}
