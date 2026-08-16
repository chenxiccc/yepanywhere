import type { ProviderChildSessionSummary } from "@yep-anywhere/shared";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useProcesses } from "../hooks/useProcesses";
import { useI18n } from "../i18n";
import {
  countRecentlyActiveProviderChildren,
  firstDefinedProviderChildren,
  latestProviderChildUpdatedAt,
  providerChildSessionHref,
  providerChildTitle,
} from "../lib/providerChildSessions";
import styles from "./ProviderChildSessionStrip.module.css";

function formatRelativeTime(timestamp: string): string {
  const diffMs = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return timestamp;
  }
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function ProviderChildSessionStrip({
  projectId,
  sessionId,
  basePath,
  childrenFromSession,
  processState,
}: {
  projectId: string;
  sessionId: string;
  basePath: string;
  childrenFromSession?: ProviderChildSessionSummary[];
  processState?: string | null;
}) {
  const { t } = useI18n();
  const { processes, terminatedProcesses } = useProcesses();
  const processChildren = useMemo(
    () =>
      [...processes, ...terminatedProcesses].find(
        (process) => process.sessionId === sessionId,
      )?.providerChildren,
    [processes, sessionId, terminatedProcesses],
  );
  const children = firstDefinedProviderChildren(
    processChildren,
    childrenFromSession,
  );
  if (children.length === 0) {
    return null;
  }

  const countLabel = t(
    children.length === 1
      ? "providerChildrenCountOne"
      : "providerChildrenCountMany",
    { count: children.length },
  );
  const runningCount = countRecentlyActiveProviderChildren(
    children,
    processState,
  );
  const lastUpdatedAt = latestProviderChildUpdatedAt(children);
  const fallback = t("providerChildFallback");

  return (
    <nav className={styles.strip} aria-label={countLabel}>
      <div className={styles.summary}>
        <span className={styles.count}>{countLabel}</span>
        {runningCount > 0 && (
          <span className={styles.running}>
            {t("providerChildStripRunning", { count: runningCount })}
          </span>
        )}
        {lastUpdatedAt && (
          <span className={styles.activity}>
            {t("providerChildStripLastActivity", {
              time: formatRelativeTime(lastUpdatedAt),
            })}
          </span>
        )}
      </div>
      <ul className={styles.list}>
        {children.map((child) => (
          <li key={child.id}>
            <Link
              className={styles.item}
              to={providerChildSessionHref(
                basePath,
                projectId,
                sessionId,
                child.id,
              )}
            >
              <span className={styles.itemTitle}>
                {providerChildTitle(child, fallback)}
              </span>
              {child.agentType &&
                child.agentType !== providerChildTitle(child, fallback) && (
                  <span className={styles.itemType}>{child.agentType}</span>
                )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
