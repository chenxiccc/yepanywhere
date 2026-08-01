import { useMemo } from "react";
import type { VersionInfo } from "../api/client";
import { useRemoteCompatibilityNoticeDismissals } from "../hooks/useRemoteCompatibilityNoticeDismissals";
import {
  type RemoteCompatibilityNotice,
  type RemoteNoticeSeverity,
  getRemoteCompatibilityNotices,
} from "../lib/remoteCompatibilityNotices";
import { CopyTextButton } from "./ui/CopyTextButton";
import styles from "./RemoteCompatibilityNotices.module.css";

const placementClassNames: Record<
  RemoteCompatibilityNoticeCardProps["placement"],
  string
> = {
  floating: styles.floating!,
  inline: styles.inline!,
};

const severityClassNames: Record<RemoteNoticeSeverity, string | undefined> = {
  info: undefined,
  recommended: undefined,
  security: styles.critical!,
  blocking: styles.critical!,
};

interface RemoteCompatibilityNoticesProps {
  versionInfo: VersionInfo | null;
  relayUsername: string | null;
  installId?: string | null;
}

export function RemoteCompatibilityNotices({
  versionInfo,
  relayUsername,
  installId,
}: RemoteCompatibilityNoticesProps) {
  const notices = useMemo(() => {
    if (!versionInfo) return [];

    return getRemoteCompatibilityNotices({
      currentVersion: versionInfo?.current ?? null,
      latestVersion: versionInfo?.latest ?? null,
      updateAvailable: versionInfo?.updateAvailable ?? false,
      installSource: versionInfo?.installSource,
      resumeProtocolVersion: versionInfo?.resumeProtocolVersion,
      remoteCompatibilityLevel: versionInfo?.remoteCompatibilityLevel,
      capabilities: versionInfo?.capabilities,
      relayUsername,
      installId,
    });
  }, [installId, relayUsername, versionInfo]);
  const { dismissNotice, snoozeNotice, visibleNotices } =
    useRemoteCompatibilityNoticeDismissals(notices);

  const notice = visibleNotices[0];
  if (!notice) return null;

  return (
    <RemoteCompatibilityNoticeCard
      notice={notice}
      noticeCount={visibleNotices.length}
      placement="floating"
      onDismiss={() => dismissNotice(notice)}
      onSnooze={() => snoozeNotice(notice)}
    />
  );
}

interface RemoteCompatibilityNoticeCardProps {
  notice: RemoteCompatibilityNotice;
  noticeCount?: number;
  placement: "floating" | "inline";
  onDismiss?: () => void;
  onRestore?: () => void;
  onSnooze?: () => void;
}

export function RemoteCompatibilityNoticeCard({
  notice,
  noticeCount = 1,
  placement,
  onDismiss,
  onRestore,
  onSnooze,
}: RemoteCompatibilityNoticeCardProps) {
  const action = notice.action;
  const commandField = action?.command
    ? {
        command: action.command,
        label: action.label,
        lines: action.command.split("\n").length,
      }
    : null;

  return (
    <section
      className={[
        styles.root!,
        placementClassNames[placement],
        severityClassNames[notice.severity],
      ]
        .filter(Boolean)
        .join(" ")}
      role={
        notice.severity === "security" || notice.severity === "blocking"
          ? "alert"
          : "status"
      }
      data-testid="remote-compatibility-notice"
    >
      <div className={styles.content!}>
        <div className={styles.headline!}>
          <strong className={styles.title!}>{notice.title}</strong>
          {notice.versionSummary && (
            <span className={styles.meta!}>{notice.versionSummary}</span>
          )}
          {noticeCount > 1 && (
            <span className={styles.count!}>{noticeCount} notices</span>
          )}
        </div>
        <span className={styles.body!}>{notice.body}</span>
        {notice.guidance && (
          <span className={styles.guidance!}>{notice.guidance}</span>
        )}
        {commandField && (
          <div className={styles.commandField!}>
            {commandField.lines > 1 ? (
              <textarea
                className={`${styles.commandInput!} ${styles.commandInputMulti!}`}
                value={commandField.command}
                readOnly
                rows={Math.min(commandField.lines, 4)}
                aria-label={`${commandField.label} text`}
                onFocus={(event) => event.currentTarget.select()}
              />
            ) : (
              <input
                className={styles.commandInput!}
                value={commandField.command}
                readOnly
                aria-label={`${commandField.label} text`}
                onFocus={(event) => event.currentTarget.select()}
              />
            )}
            <CopyTextButton
              text={commandField.command}
              label={commandField.label}
              copiedLabel="Copied"
              className={styles.copyButton!}
              copiedClassName={styles.copied!}
            />
          </div>
        )}
      </div>
      <div className={styles.actions!}>
        {notice.action?.href && (
          <a
            className={`${styles.button!} ${styles.buttonPrimary!}`}
            href={notice.action.href}
          >
            {notice.action.label}
          </a>
        )}
        {onRestore && (
          <button
            type="button"
            className={`${styles.button!} ${styles.buttonPrimary!}`}
            onClick={onRestore}
          >
            Show reminder
          </button>
        )}
        {onDismiss && (
          <button type="button" className={styles.button!} onClick={onDismiss}>
            Dismiss
          </button>
        )}
        {onSnooze && notice.severity !== "info" && (
          <button type="button" className={styles.button!} onClick={onSnooze}>
            Remind me later
          </button>
        )}
      </div>
    </section>
  );
}
