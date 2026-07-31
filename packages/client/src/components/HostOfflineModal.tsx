/**
 * HostOfflineModal - Shows when auto-resume fails because host is unreachable.
 *
 * Displays a user-friendly error when the remote host cannot be reached during
 * session resumption, with options to retry or go to the login page.
 */

import type {
  AutoResumeError,
  AutoResumeErrorReason,
} from "../contexts/RemoteConnectionContext";
import { useI18n } from "../i18n";
import styles from "./HostOfflineModal.module.css";
import { Modal } from "./ui/Modal";

type Translate = ReturnType<typeof useI18n>["t"];

interface HostOfflineModalProps {
  error: AutoResumeError;
  onDismiss: () => void;
  onRetry: () => void;
  onGoToLogin: () => void;
}

function getErrorTitle(reason: AutoResumeErrorReason, t: Translate): string {
  switch (reason) {
    case "server_offline":
      return t("hostOfflineTitleServerOffline");
    case "unknown_username":
      return t("hostOfflineTitleUnknownUsername");
    case "relay_timeout":
      return t("hostOfflineTitleRelayTimeout");
    case "relay_unreachable":
      return t("hostOfflineTitleRelayUnreachable");
    case "direct_unreachable":
      return t("hostOfflineTitleDirectUnreachable");
    case "resume_incompatible":
      return t("hostOfflineTitleResumeIncompatible");
    default:
      return t("hostOfflineTitleDefault");
  }
}

function getErrorMessage(error: AutoResumeError, t: Translate): string {
  const { reason, mode, relayUsername } = error;

  switch (reason) {
    case "server_offline":
      return relayUsername
        ? t("hostOfflineMessageServerOfflineNamed", { relayUsername })
        : t("hostOfflineMessageServerOffline");

    case "unknown_username":
      return relayUsername
        ? t("hostOfflineMessageUnknownUsernameNamed", { relayUsername })
        : t("hostOfflineMessageUnknownUsername");

    case "relay_timeout":
      return relayUsername
        ? t("hostOfflineMessageRelayTimeoutNamed", { relayUsername })
        : t("hostOfflineMessageRelayTimeout");

    case "relay_unreachable":
      return t("hostOfflineMessageRelayUnreachable");

    case "direct_unreachable":
      return mode === "direct"
        ? t("hostOfflineMessageDirectUnreachableDirect")
        : t("hostOfflineMessageDirectUnreachable");

    case "resume_incompatible":
      return t("hostOfflineMessageResumeIncompatible");

    default:
      return t("hostOfflineMessageDefault");
  }
}

export function HostOfflineModal({
  error,
  onDismiss,
  onRetry,
  onGoToLogin,
}: HostOfflineModalProps) {
  const { t } = useI18n();
  const title = getErrorTitle(error.reason, t);
  const message = getErrorMessage(error, t);

  return (
    <Modal title={title} onClose={onDismiss}>
      <div className={styles.content}>
        <p className={styles.message}>{message}</p>

        {error.relayUsername && (
          <p className={styles.detail}>
            <strong>{t("relayLoginUsername")}:</strong> {error.relayUsername}
          </p>
        )}

        {error.serverUrl && (
          <p className={styles.detail}>
            <strong>{t("relayLoginCustomRelayUrl")}:</strong> {error.serverUrl}
          </p>
        )}

        <p className={styles.hint}>
          {error.reason === "resume_incompatible"
            ? t("hostOfflineHintResumeIncompatible")
            : error.mode === "relay"
              ? t("hostOfflineHintRelay")
              : t("hostOfflineHintDirect")}
        </p>

        <div className={styles.actions}>
          <button type="button" className="btn-secondary" onClick={onGoToLogin}>
            {t("hostOfflineGoToLogin")}
          </button>
          <button type="button" className="btn-primary" onClick={onRetry}>
            {t("hostOfflineRetry")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
