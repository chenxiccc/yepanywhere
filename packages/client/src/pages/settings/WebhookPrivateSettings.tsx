import { useCallback, useEffect, useMemo, useState } from "react";
import { useWebhookPrivateConfig } from "../../hooks/useWebhookPrivateConfig";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";
import type { WebhookPrivateConfig } from "../../api/client";

const MAX_URL_LENGTH = 2000;
const MAX_SECRET_LENGTH = 5000;

// 文案写死（仅自用，不走 i18n 以减少与上游的冲突面）
// Hardcoded labels (self-use only; skip i18n to avoid upstream merge conflicts).
const L = {
  paneTitle: "群机器人通知",
  loading: "加载中...",
  description:
    "向钉钉或飞书群机器人推送会话事件，平台按 webhook URL 域名自动识别。",
  enableTitle: "启用群机器人通知",
  enableDescription: "开启或关闭群机器人消息推送。",
  urlTitle: "Webhook 地址",
  urlDescription: "钉钉/飞书群机器人 webhook 地址，平台按域名自动识别。",
  secretTitle: "加签密钥",
  secretDescription: "可选。机器人启用加签验证时必填。",
  platformTitle: "平台",
  platformAuto: "自动识别",
  eventsTitle: "事件",
  eventIdle: "会话空闲",
  eventError: "进程异常",
  eventToolApproval: "权限审批",
  eventUserQuestion: "用户提问",
  dryRunTitle: "试运行",
  dryRunDescription: "仍发送消息，但 payload 标记为试运行。",
  saveFailed: "保存失败",
  testButton: "测试",
  testingButton: "测试中...",
  saveButton: "保存",
  savingButton: "保存中...",
  testSuccess: "测试消息发送成功。",
  testFailed: "测试失败",
} as const;

/**
 * 钉钉/飞书群机器人 webhook 设置页 / DingTalk/Feishu group-bot webhook settings page
 *
 * 仿 LifecycleWebhooksSettings 结构，但走独立的 useWebhookPrivateConfig 与
 * /api/webhook-private 端点。新增平台选择、事件开关、测试按钮。
 * Modeled after LifecycleWebhooksSettings but talks to the standalone
 * useWebhookPrivateConfig / /api/webhook-private endpoint. Adds platform
 * selection, per-event toggles, and a test button.
 */
export function WebhookPrivateSettings() {
  useSettingsPaneTitle(L.paneTitle);
  const { config, isLoading, error, updateConfig, testWebhook } =
    useWebhookPrivateConfig();

  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [platform, setPlatform] =
    useState<WebhookPrivateConfig["platform"]>("auto");
  const [events, setEvents] = useState<WebhookPrivateConfig["events"]>({
    idle: true,
    error: true,
    toolApproval: true,
    userQuestion: true,
  });
  const [dryRun, setDryRun] = useState(true);

  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [hasDraftEdits, setHasDraftEdits] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  // 表单与已加载配置同步后置真，用于 undo baseline 只快照打开时的值
  // True once the form mirrors loaded config; gates the undo baseline so it
  // snapshots open-time values, not the pre-load defaults.
  const [formSynced, setFormSynced] = useState(false);

  const serverValues = useMemo(
    () => ({
      enabled: config?.enabled ?? false,
      url: config?.url ?? "",
      secret: config?.secret ?? "",
      platform: config?.platform ?? "auto",
      events: config?.events ?? {
        idle: true,
        error: true,
        toolApproval: true,
        userQuestion: true,
      },
      dryRun: config?.dryRun ?? true,
    }),
    [config],
  );

  const normalizedUrl = url.trim();
  const hasChanges =
    enabled !== serverValues.enabled ||
    normalizedUrl !== serverValues.url ||
    secret !== serverValues.secret ||
    platform !== serverValues.platform ||
    dryRun !== serverValues.dryRun ||
    events.idle !== serverValues.events.idle ||
    events.error !== serverValues.events.error ||
    events.toolApproval !== serverValues.events.toolApproval ||
    events.userQuestion !== serverValues.events.userQuestion;

  useEffect(() => {
    if (!config) return;
    if (hasDraftEdits || isSaving) return;
    setEnabled(serverValues.enabled);
    setUrl(serverValues.url);
    setSecret(serverValues.secret);
    setPlatform(serverValues.platform);
    setEvents(serverValues.events);
    setDryRun(serverValues.dryRun);
    setFormSynced(true);
  }, [config, hasDraftEdits, isSaving, serverValues]);

  // 头部 undo 覆盖当前显示的表单值（已保存或未保存），回退到打开时
  // Header undo covers shown form values (saved or not), back to open-time.
  const undoState = useMemo(
    () =>
      formSynced
        ? { enabled, url, secret, platform, events, dryRun }
        : null,
    [formSynced, enabled, url, secret, platform, events, dryRun],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      setEnabled(snapshot.enabled);
      setUrl(snapshot.url);
      setSecret(snapshot.secret);
      setPlatform(snapshot.platform);
      setEvents(snapshot.events);
      setDryRun(snapshot.dryRun);
      setHasDraftEdits(false);
      setSaveError(null);
      void updateConfig({
        enabled: snapshot.enabled,
        url: snapshot.url.trim() || "",
        secret: snapshot.secret,
        platform: snapshot.platform,
        events: snapshot.events,
        dryRun: snapshot.dryRun,
      }).catch(() => {
        // surfaced via the hook's error state
      });
    },
    [updateConfig],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  const markDraft = useCallback(() => {
    setHasDraftEdits(true);
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateConfig({
        enabled,
        url: normalizedUrl,
        secret,
        platform,
        events,
        dryRun,
      });
      setHasDraftEdits(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : L.saveFailed);
    } finally {
      setIsSaving(false);
    }
  }, [dryRun, enabled, events, normalizedUrl, platform, secret, updateConfig]);

  const handleTest = useCallback(async () => {
    // 测试前先把当前草稿保存，避免用旧配置测试
    // Persist the current draft before testing so the test uses live values
    if (hasChanges) {
      setIsSaving(true);
      setSaveError(null);
      try {
        await updateConfig({
          enabled,
          url: normalizedUrl,
          secret,
          platform,
          events,
          dryRun,
        });
        setHasDraftEdits(false);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : L.saveFailed);
        setIsSaving(false);
        return;
      }
      setIsSaving(false);
    }

    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await testWebhook();
      setTestResult(
        result.success
          ? L.testSuccess
          : `${L.testFailed}${result.error ? `: ${result.error}` : ""}`,
      );
    } finally {
      setIsTesting(false);
    }
  }, [
    dryRun,
    enabled,
    events,
    hasChanges,
    normalizedUrl,
    platform,
    secret,
    testWebhook,
    updateConfig,
  ]);

  if (isLoading) {
    return (
      <section className="settings-section">
        <p className="settings-section-description">{L.loading}</p>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <p className="settings-section-description">{L.description}</p>

      <div className="settings-group">
        <label className="settings-item">
          <div className="settings-item-info">
            <strong>{L.enableTitle}</strong>
            <p>{L.enableDescription}</p>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              markDraft();
            }}
          />
        </label>

        <div
          className="settings-item"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div className="settings-item-info">
            <strong>{L.urlTitle}</strong>
            <p>{L.urlDescription}</p>
          </div>
          <input
            aria-label={L.urlTitle}
            autoComplete="off"
            type="url"
            className="settings-input"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value.slice(0, MAX_URL_LENGTH));
              markDraft();
            }}
            placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
            spellCheck={false}
          />
        </div>

        <div
          className="settings-item"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div className="settings-item-info">
            <strong>{L.secretTitle}</strong>
            <p>{L.secretDescription}</p>
          </div>
          <input
            aria-label={L.secretTitle}
            autoComplete="new-password"
            type="password"
            className="settings-input"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value.slice(0, MAX_SECRET_LENGTH));
              markDraft();
            }}
            placeholder="SEC..."
            spellCheck={false}
          />
        </div>

        <label className="settings-item">
          <div className="settings-item-info">
            <strong>{L.platformTitle}</strong>
            <p>{L.urlDescription}</p>
          </div>
          <select
            aria-label={L.platformTitle}
            className="settings-input"
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value as WebhookPrivateConfig["platform"]);
              markDraft();
            }}
          >
            <option value="auto">{L.platformAuto}</option>
            <option value="dingtalk">DingTalk</option>
            <option value="feishu">Feishu</option>
          </select>
        </label>

        <div
          className="settings-item"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div className="settings-item-info">
            <strong>{L.eventsTitle}</strong>
          </div>
          {(
            [
              ["idle", L.eventIdle],
              ["error", L.eventError],
              ["toolApproval", L.eventToolApproval],
              ["userQuestion", L.eventUserQuestion],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              className="settings-item"
              style={{ paddingInline: 0 }}
            >
              <div className="settings-item-info">
                <span>{label}</span>
              </div>
              <input
                type="checkbox"
                checked={events[key]}
                onChange={(e) => {
                  setEvents({ ...events, [key]: e.target.checked });
                  markDraft();
                }}
              />
            </label>
          ))}
        </div>

        <label className="settings-item">
          <div className="settings-item-info">
            <strong>{L.dryRunTitle}</strong>
            <p>{L.dryRunDescription}</p>
          </div>
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => {
              setDryRun(e.target.checked);
              markDraft();
            }}
          />
        </label>

        <div
          className="settings-item"
          style={{ justifyContent: "flex-end", gap: "var(--space-2)" }}
        >
          <button
            type="button"
            className="settings-button"
            disabled={isTesting || !normalizedUrl}
            onClick={handleTest}
          >
            {isTesting ? L.testingButton : L.testButton}
          </button>
          <button
            type="button"
            className="settings-button"
            disabled={!hasChanges || isSaving}
            onClick={handleSave}
          >
            {isSaving ? L.savingButton : L.saveButton}
          </button>
        </div>

        {(saveError || error) && (
          <p className="settings-warning">{saveError || error}</p>
        )}
        {testResult && <p className="settings-warning">{testResult}</p>}
      </div>
    </section>
  );
}
