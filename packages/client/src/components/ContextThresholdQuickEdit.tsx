import {
  getModelContextWindow,
  getMostUsedSubscriptionUsageWindow,
  type ProviderName,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useProviderSubscriptionUsage } from "../hooks/useProviderSubscriptionUsage";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import type { ContextUsage } from "../types";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { SubscriptionUsageDetails } from "./SubscriptionUsageDetails";
import { CommittedRangeInput } from "./ui/CommittedRangeInput";

interface ContextThresholdQuickEditProps {
  usage?: ContextUsage;
  /**
   * YA model id (launch alias, e.g. "opus") — the key the Settings slider and
   * migration use. The toolbar resolves this from the session's requested model,
   * not the reported one. See topics/provider-abstraction.md.
   */
  model?: string;
  /** Provider account whose subscription windows apply to this model. */
  provider?: ProviderName;
  /** Model context window, for the token preview. */
  contextWindow?: number;
  size?: number;
}

const LONG_PRESS_MS = 450;

/**
 * Effective window for the token preview: prefer the model's reported window,
 * then the static heuristic for the id, then the live usage window. Context
 * windows are observation-driven (the server learns the real window from the
 * SDK's modelUsage), so this no longer hardcodes any always-1M model.
 */
function effectiveContextWindow(
  model: string | undefined,
  passed: number | undefined,
  usageWindow: number | undefined,
): number | undefined {
  if (passed && passed > 0) return passed;
  if (model) {
    const resolved = getModelContextWindow(model);
    if (resolved > 0) return resolved;
  }
  return usageWindow && usageWindow > 0 ? usageWindow : undefined;
}

/**
 * Wraps the context-usage indicator with a long-press (touch) / right-click
 * (desktop) affordance that opens a one-control popover for *this model's*
 * "compact context early" threshold — a quick way to dial in (or off) the
 * preemptive-compaction point without opening Settings. It edits the SAME
 * `clientDefaults.compactAtContextPercent` map the Model Settings slider does
 * (a second access point, not a second mechanism). See task 029 /
 * topics/resume-compaction.md.
 */
export function ContextThresholdQuickEdit({
  usage,
  model,
  provider,
  contextWindow,
  size = 16,
}: ContextThresholdQuickEditProps) {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const {
    usage: subscriptionUsage,
    loading: subscriptionUsageLoading,
    refresh: refreshSubscriptionUsage,
  } = useProviderSubscriptionUsage(provider);
  const [open, setOpen] = useState<"usage" | "threshold" | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);

  const canEdit = !!usage && !!model && model !== "default";
  const bindingUsageWindow = getMostUsedSubscriptionUsageWindow(
    subscriptionUsage,
    model,
  );
  const canInspectUsage = bindingUsageWindow !== null;
  const stored =
    (model
      ? settings?.clientDefaults?.compactAtContextPercent?.[model]
      : undefined) ?? 0;
  const [draft, setDraft] = useState(stored);
  useEffect(() => {
    setDraft(stored);
  }, [stored]);

  const commit = useCallback(
    (pct: number) => {
      if (!model) return;
      const next: Record<string, number> = {
        ...settings?.clientDefaults?.compactAtContextPercent,
      };
      if (pct > 0 && pct < 100) next[model] = Math.round(pct);
      else delete next[model];
      void updateSetting("clientDefaults", {
        compactAtContextPercent: next,
      }).catch(() => {
        // surfaced via the hook's error state
      });
    },
    [model, settings?.clientDefaults?.compactAtContextPercent, updateSetting],
  );

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!usage) return null;

  const effWindow = effectiveContextWindow(
    model,
    contextWindow,
    usage.contextWindow,
  );
  const tokenPreview =
    effWindow && draft > 0
      ? `${Math.round((effWindow * draft) / 100 / 1024)}K`
      : null;

  // No quota detail or editable model → preserve the passive indicator.
  if (!canEdit && !canInspectUsage) {
    return <ContextUsageIndicator usage={usage} size={size} />;
  }

  const ariaLabel =
    canInspectUsage && bindingUsageWindow
      ? t("subscriptionUsageContextAria", {
          contextPercent: Math.round(usage.percentage),
          usagePercent: Math.round(bindingUsageWindow.usedPercent),
        })
      : t("compactThresholdQuickTitle");

  return (
    <span
      ref={wrapRef}
      className="context-threshold-quickedit"
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-expanded={open !== null}
      aria-label={ariaLabel}
      onClick={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest(
            ".context-threshold-popover, .context-subscription-popover",
          )
        ) {
          return;
        }
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        if (canInspectUsage) {
          setOpen((current) => (current === "usage" ? null : "usage"));
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (canInspectUsage) {
            setOpen((current) => (current === "usage" ? null : "usage"));
          } else if (canEdit) {
            setOpen((current) =>
              current === "threshold" ? null : "threshold",
            );
          }
        }
      }}
      onContextMenu={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setOpen((current) =>
          current === "threshold" ? null : "threshold",
        );
      }}
      onTouchStart={() => {
        if (!canEdit) return;
        clearLongPress();
        longPressTimer.current = setTimeout(() => {
          longPressTimer.current = null;
          suppressClickRef.current = true;
          setOpen("threshold");
        }, LONG_PRESS_MS);
      }}
      onTouchEnd={clearLongPress}
      onTouchMove={clearLongPress}
    >
      <ContextUsageIndicator usage={usage} size={size} />
      {open === "usage" && subscriptionUsage && (
        <SubscriptionUsageDetails
          usage={subscriptionUsage}
          modelId={model}
          refreshing={subscriptionUsageLoading}
          onRefresh={() => void refreshSubscriptionUsage()}
          onEditCompactThreshold={
            canEdit ? () => setOpen("threshold") : undefined
          }
        />
      )}
      {open === "threshold" && (
        <div className="context-threshold-popover" role="dialog">
          <div className="context-threshold-popover-title">
            {t("compactThresholdQuickTitle")}
          </div>
          <CommittedRangeInput
            min={0}
            max={99}
            step={1}
            value={draft}
            aria-label={t("compactThresholdQuickTitle")}
            onDraftChange={setDraft}
            onCommit={commit}
          />
          <div className="context-threshold-popover-hint">
            {draft > 0
              ? t("compactThresholdQuickOn", {
                  percent: String(draft),
                  tokens: tokenPreview ?? "—",
                })
              : t("compactThresholdQuickOff")}
          </div>
        </div>
      )}
    </span>
  );
}
