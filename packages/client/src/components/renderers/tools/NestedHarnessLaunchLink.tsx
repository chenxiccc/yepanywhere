import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useRemoteBasePath } from "../../../hooks/useRemoteBasePath";
import { useI18n } from "../../../i18n";
import { nestedHarnessLaunchTarget } from "../../../lib/nestedHarnessLaunch";
import styles from "./NestedHarnessLaunchLink.module.css";

/**
 * Link from a shell command that starts a second harness process to the
 * session that process writes. Without it the launched work is reachable from
 * neither side: no subagent exists, and the background task id names a
 * harness-local output file rather than a session.
 *
 * Contract: topics/nested-harness-launch.md
 */
export function NestedHarnessLaunchLink({ command }: { command: string }) {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const metadata = useOptionalSessionMetadata();
  const target = useMemo(
    () =>
      metadata
        ? nestedHarnessLaunchTarget(command, {
            basePath,
            projectId: metadata.projectId,
            projectPath: metadata.projectPath,
            sessionId: metadata.sessionId,
          })
        : undefined,
    [command, basePath, metadata],
  );

  if (!target) return null;

  return (
    <Link
      className={styles.link}
      to={target.href}
      title={t("nestedHarnessLaunchTitle")}
    >
      <span>{t("nestedHarnessLaunchLabel")}</span>
      <span className={styles.id}>{target.sessionId.slice(0, 8)}</span>
    </Link>
  );
}
