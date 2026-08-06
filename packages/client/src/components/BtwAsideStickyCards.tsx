import { useI18n } from "../i18n";
import { BtwAsideTranscript, type BtwAsidePaneItem } from "./BtwAsidePane";

export interface BtwAsideStickyCardItem extends BtwAsidePaneItem {
  preview?: string;
  expanded?: boolean;
}

interface BtwAsideStickyCardsProps {
  asides: BtwAsideStickyCardItem[];
  focusedAsideId: string | null;
  onFocusAside: (asideId: string) => void;
  onToggleAsideExpanded: (asideId: string) => void;
  onDoneAside: (asideId: string) => void;
  onHideAside: (asideId: string) => void;
  onStopAside: (asideId: string) => void;
  onTransferToComposer: (text: string) => void;
}

function canExpandBtwAside(aside: BtwAsideStickyCardItem): boolean {
  return Boolean(
    aside.request ||
      aside.followUps.length > 0 ||
      aside.responses.length > 0 ||
      (aside.turns?.length ?? 0) > 0,
  );
}

export function BtwAsideStickyCards({
  asides,
  focusedAsideId,
  onFocusAside,
  onToggleAsideExpanded,
  onDoneAside,
  onHideAside,
  onStopAside,
  onTransferToComposer,
}: BtwAsideStickyCardsProps) {
  const { t } = useI18n();

  if (asides.length === 0) {
    return null;
  }

  return (
    <div className="btw-aside-stack" role="region" aria-label="/btw asides">
      {asides.map((aside) => {
        const isFocused = focusedAsideId === aside.id;
        const canExpand = canExpandBtwAside(aside);
        return (
          <div
            key={aside.id}
            className={`btw-aside-card is-${aside.status} ${
              isFocused ? "is-focused" : ""
            }`}
          >
            <button
              type="button"
              className="btw-aside-main"
              onClick={() => onFocusAside(aside.id)}
            >
              <span className="btw-aside-meta">/btw {aside.status}</span>
              <span className="btw-aside-request">
                {aside.request || "New aside"}
              </span>
              {aside.followUps.length > 0 && (
                <span className="btw-aside-followups">
                  +{aside.followUps.length} follow-up
                  {aside.followUps.length === 1 ? "" : "s"}
                </span>
              )}
              {aside.preview && (
                <span className="btw-aside-preview">{aside.preview}</span>
              )}
              {aside.error && (
                <span className="btw-aside-error">{aside.error}</span>
              )}
            </button>
            {aside.expanded && canExpand && (
              <BtwAsideTranscript
                aside={aside}
                autoScrollLatest
                onTransferToComposer={onTransferToComposer}
              />
            )}
            <div className="btw-aside-actions">
              {canExpand && (
                <button
                  type="button"
                  className="btw-aside-action"
                  onClick={() => onToggleAsideExpanded(aside.id)}
                >
                  {aside.expanded ? "Less" : "Show"}
                </button>
              )}
              {isFocused && (
                <button
                  type="button"
                  className="btw-aside-action"
                  onClick={() => onDoneAside(aside.id)}
                  title={t("btwAsideReturnComposerTitle")}
                >
                  Done
                </button>
              )}
              {(aside.status === "starting" || aside.status === "running") && (
                <button
                  type="button"
                  className="btw-aside-action btw-aside-action-stop"
                  onClick={() => onStopAside(aside.id)}
                  title={
                    isFocused
                      ? "Stop this /btw aside and return to the main session"
                      : "Stop this /btw aside"
                  }
                >
                  Stop
                </button>
              )}
              <button
                type="button"
                className="btw-aside-action"
                onClick={() => onHideAside(aside.id)}
                title={t("btwAsideMoveToHistoryTitle")}
              >
                Hide
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
