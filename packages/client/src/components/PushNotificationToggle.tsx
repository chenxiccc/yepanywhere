import { useNotifyInApp } from "../hooks/useNotifyInApp";
import {
  PUSH_PERMISSION_REQUEST_TIMED_OUT,
  usePushNotifications,
} from "../hooks/usePushNotifications";
import { useI18n } from "../i18n";

/**
 * Toggle component for this browser's Web Push subscription and local
 * focused-window presentation preference.
 */
export function PushNotificationToggle() {
  const { t } = useI18n();
  const {
    isSupported,
    isSubscribed,
    isLoading,
    error,
    permission,
    subscribe,
    unsubscribe,
  } = usePushNotifications();
  const { notifyInApp, setNotifyInApp } = useNotifyInApp();
  const displayedError =
    error === PUSH_PERMISSION_REQUEST_TIMED_OUT
      ? t("pushTogglePermissionRequestTimedOut")
      : error;

  const handleToggle = async () => {
    if (isSubscribed) {
      await unsubscribe();
    } else {
      await subscribe();
    }
  };

  // Not supported - show message with reason and help link
  if (!isSupported) {
    // Check if this is specifically the dev mode SW disabled case
    const isDevModeDisabled = error?.includes(
      "Service worker disabled in dev mode",
    );

    return (
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>{t("pushToggleTitle")}</strong>
          <p>{error || t("pushToggleUnsupported")}</p>
          {isDevModeDisabled && (
            <div className="settings-info-box" style={{ marginTop: "0.5rem" }}>
              <p>{t("pushToggleThisDeviceOnly")}</p>
              <p>{t("pushToggleDevModeHint")}</p>
            </div>
          )}
          <p style={{ marginTop: "0.5rem" }}>
            <a
              href="https://github.com/kzahel/yepanywhere/blob/main/docs/push-notifications.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("pushToggleTroubleshooting")}
            </a>
          </p>
        </div>
      </div>
    );
  }

  // Permission denied - show how to fix
  if (permission === "denied") {
    return (
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>{t("pushToggleTitle")}</strong>
          <p className="settings-warning">{t("pushToggleBlocked")}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>{t("pushToggleTitle")}</strong>
          <p>{t("pushToggleDescription")}</p>
          {displayedError && <p className="settings-error">{displayedError}</p>}
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={isSubscribed}
            onChange={handleToggle}
            disabled={isLoading}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      {isSubscribed && (
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("pushToggleNotifyInAppTitle")}</strong>
            <p>{t("pushToggleNotifyInAppDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={notifyInApp}
              onChange={(e) => setNotifyInApp(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      )}
    </>
  );
}
